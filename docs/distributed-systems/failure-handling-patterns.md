# Failure Handling Patterns

It's Black Friday. Your payment service is overwhelmed — response times spike from 50ms to 8 seconds. The order service keeps retrying failed payment calls. Each retry adds more load to the already-struggling payment service. The payment service collapses entirely. Now the order service's thread pool is exhausted waiting for payment responses. The order service stops responding. The API gateway times out. The entire checkout flow is dead.

One overloaded service took down the whole system. This is a **cascading failure**, and it's the most common way distributed systems die in production. Failure handling patterns exist to prevent exactly this.

## The Reality of Failure

In a distributed system, failure isn't exceptional — it's constant. At scale:

- A cluster of 1,000 servers will see multiple disk failures per week
- Network partitions happen regularly between availability zones
- Services deploy new versions and crash on startup
- Garbage collection pauses make healthy services appear dead
- DNS resolution fails intermittently
- TLS certificate renewals go wrong

You don't design for "if" failure happens. You design for "when" and "how often."

## Timeouts

The most basic failure handling pattern, and the one most often missing or misconfigured.

Without a timeout, a client waits indefinitely for a response. If the server is down, the client's thread is blocked forever. Multiply by hundreds of concurrent requests, and you've exhausted your thread pool.

### Choosing Timeout Values

**Too short:** You'll time out on requests that would have succeeded, causing unnecessary failures and retries.

**Too long:** You'll hold resources (threads, connections, memory) waiting for responses that will never come.

A good starting point: measure the p99 latency of the downstream service under normal load. Set the timeout to 2-3x that value.

```
Payment Service p99 latency: 200ms

Timeout = 200ms × 3 = 600ms

If a request takes longer than 600ms, something is wrong.
Cut the connection and fail fast.
```

### Timeout Layering

Every network call needs a timeout. But you also need timeouts at higher levels:

```
┌─────────────────────────────────────────────┐
│ API Gateway: 5s total request timeout       │
│  ┌────────────────────────────────────────┐ │
│  │ Order Service: 3s for checkout flow    │ │
│  │  ┌──────────────────────────────────┐  │ │
│  │  │ Payment call: 600ms timeout      │  │ │
│  │  └──────────────────────────────────┘  │ │
│  │  ┌──────────────────────────────────┐  │ │
│  │  │ Inventory call: 400ms timeout    │  │ │
│  │  └──────────────────────────────────┘  │ │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

The outer timeout must be larger than the sum of inner timeouts plus processing time. If the API gateway timeout is 5s but the order service makes two sequential calls of 600ms + 400ms each with retries, the math must work out.

## Retries

When a request fails, retry it. Simple concept, dangerous in practice.

### Retry Storms

If a service is overloaded and returning errors, retrying immediately makes it worse. 1,000 clients each retry 3 times = 3,000 additional requests hitting an already-struggling service.

```
Without backoff:
  T=0: 1000 requests → 800 fail
  T=1: 800 retries + 1000 new = 1800 requests → 1500 fail
  T=2: 1500 retries + 1000 new = 2500 requests → service dies
```

### Exponential Backoff with Jitter

Wait longer between each retry, and add randomness so clients don't all retry at the same time.

```
Retry 1: wait random(0, 100ms)
Retry 2: wait random(0, 200ms)
Retry 3: wait random(0, 400ms)
Retry 4: wait random(0, 800ms)
Max retries: 4, then give up
```

The jitter is critical. Without it, all clients that failed at T=0 retry at T=100ms, creating a thundering herd. With jitter, retries spread across the window.

```python
import random, time

def retry_with_backoff(fn, max_retries=4, base_delay=0.1):
    for attempt in range(max_retries):
        try:
            return fn()
        except TransientError:
            if attempt == max_retries - 1:
                raise
            delay = base_delay * (2 ** attempt)
            time.sleep(random.uniform(0, delay))
```

### Idempotency

Retries are only safe if the operation is **idempotent** — calling it multiple times produces the same result as calling it once.

`GET /user/123` is naturally idempotent. `POST /payments` is not — retrying could charge the user twice.

Make non-idempotent operations safe with **idempotency keys**:

```
POST /payments
Idempotency-Key: order-123-payment-attempt-1

Server checks: have I seen this key before?
  Yes → return the cached result
  No  → process the payment, cache the result with this key
```

## Circuit Breaker

A circuit breaker prevents a client from repeatedly calling a failing service. It's modeled after electrical circuit breakers — when too much current flows, the breaker trips and cuts the circuit.

### Three States

```
         success
    ┌──────────────┐
    │              │
    ▼              │
┌────────┐  failures exceed   ┌────────┐
│ CLOSED │  ──threshold──────►│  OPEN  │
│(normal)│                    │(reject)│
└────────┘                    └───┬────┘
    ▲                             │
    │         timeout expires     │
    │                             ▼
    │                        ┌──────────┐
    └────── success ─────────│HALF-OPEN │
                             │ (probe)  │
                             └──────────┘
```

**Closed (normal):** Requests pass through. The breaker counts failures. If failures exceed a threshold (e.g., 5 failures in 10 seconds), the breaker trips to Open.

**Open (rejecting):** All requests are immediately rejected without calling the downstream service. This gives the failing service time to recover. After a timeout (e.g., 30 seconds), the breaker moves to Half-Open.

**Half-Open (probing):** The breaker allows a single request through. If it succeeds, the breaker closes (service recovered). If it fails, the breaker opens again.

### What to Return When Open

When the circuit is open, you have options:

- **Return a cached response.** Serve the last known good value. Works for read operations.
- **Return a default/fallback.** Show a generic product recommendation instead of personalized ones.
- **Return an error immediately.** Fail fast so the caller can handle it. Better than waiting for a timeout.
- **Queue the request.** Process it later when the service recovers. Works for non-time-sensitive writes.

## Bulkhead

Named after ship bulkheads — watertight compartments that prevent a hull breach from sinking the entire ship. In software, bulkheads isolate failures so one failing component doesn't consume all shared resources.

### Thread Pool Isolation

Without bulkheads, all outgoing calls share one thread pool:

```
Shared thread pool (20 threads):
  Payment calls:   ████████████████  (16 threads stuck, timing out)
  Inventory calls: ██                (2 threads, working fine)
  Shipping calls:  ██                (2 threads, working fine)
  
  → Payment is slow, so it consumes most threads.
  → Inventory and Shipping are starved.
```

With bulkheads, each downstream service gets its own pool:

```
Payment pool (8 threads):    ████████  (all stuck, but contained)
Inventory pool (6 threads):  ██████    (working normally)
Shipping pool (6 threads):   ██████    (working normally)

→ Payment failure is isolated. Inventory and Shipping are unaffected.
```

### Connection Pool Isolation

Same principle for database connections, HTTP connections, or any shared resource. Give each consumer its own pool with a hard limit.

## Rate Limiting and Load Shedding

### Rate Limiting

Cap the number of requests a client can make in a time window. Protects the server from being overwhelmed by any single client.

```
Rate limit: 100 requests/second per client

Client A: 150 req/s → 100 accepted, 50 rejected (HTTP 429)
Client B:  80 req/s → 80 accepted
Client C:  30 req/s → 30 accepted
```

Common algorithms: token bucket, sliding window, fixed window.

### Load Shedding

When the server is overloaded, proactively reject requests before they consume resources. Better to reject 20% of requests quickly than to serve all requests slowly (and eventually fail all of them).

```
Server at 90% CPU:
  → Start rejecting lowest-priority requests
  → Health check requests: always accept
  → Paid tier requests: accept
  → Free tier requests: reject with 503

Server at 95% CPU:
  → Reject all new requests
  → Finish in-flight requests
  → Return 503 Service Unavailable
```

Load shedding is the server-side complement to circuit breakers on the client side.

## Fallback Patterns

When a dependency fails, what do you show the user?

### Graceful Degradation

Serve a reduced-functionality response instead of an error.

```
Product page with all services healthy:
  ✓ Product details (from catalog service)
  ✓ Personalized recommendations (from ML service)
  ✓ Real-time inventory count (from inventory service)
  ✓ User reviews (from review service)

Product page with ML service down:
  ✓ Product details
  ✗ Personalized recommendations → show "Popular items" (static fallback)
  ✓ Real-time inventory count
  ✓ User reviews
```

The page still works. The user gets a slightly worse experience, not an error page.

### Cache as Fallback

Serve stale cached data when the source of truth is unavailable.

```
Read path:
  1. Try primary database
  2. If unavailable → serve from Redis cache (might be stale)
  3. If cache miss → serve from local in-memory cache (even more stale)
  4. If all fail → return error
```

This works for data that changes slowly (product catalogs, user profiles). It's dangerous for data that must be current (account balances, inventory counts).

## Health Checks and Failure Detection

### Liveness vs Readiness

**Liveness:** "Is the process alive?" If no, restart it. A simple HTTP endpoint that returns 200.

**Readiness:** "Can this instance serve traffic?" If no, stop routing traffic to it. Checks database connectivity, cache availability, and downstream dependencies.

```
GET /health/live    → 200 (process is running)
GET /health/ready   → 503 (database connection lost, don't send traffic)
```

Kubernetes uses these to decide whether to restart a pod (liveness) or remove it from the load balancer (readiness).

### Failure Detection with Heartbeats

Nodes send periodic heartbeats. If a node misses N consecutive heartbeats, it's considered dead.

The challenge: distinguishing a dead node from a slow one. A GC pause can cause a healthy node to miss heartbeats. If you declare it dead and failover, then it comes back, you have two nodes thinking they're the primary.

**Phi accrual failure detector** (used by Cassandra and Akka) doesn't make a binary alive/dead decision. It computes a suspicion level based on heartbeat arrival patterns. This adapts to network conditions and reduces false positives.

## Putting It All Together

A well-designed service uses multiple patterns in combination:

```
Incoming Request
      │
      ▼
┌─────────────┐
│ Rate Limiter │ → reject if over limit (429)
└──────┬──────┘
       │
       ▼
┌──────────────┐
│ Load Shedder │ → reject if server overloaded (503)
└──────┬───────┘
       │
       ▼
┌──────────────────┐
│ Circuit Breaker   │ → reject if downstream is known-dead
│ (per dependency)  │
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│ Bulkhead          │ → isolated thread/connection pool
│ (per dependency)  │
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│ Timeout + Retry   │ → bounded wait, exponential backoff
│ (with idempotency)│
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│ Fallback          │ → cache, default, degraded response
└──────────────────┘
```

## Interview Application

When discussing failure handling in an interview, show the layered approach:

"For the checkout service calling the payment provider, I'd layer several patterns. First, a 600ms timeout on the HTTP call — the payment provider's p99 is 200ms, so 600ms catches genuine failures without false positives. If the call fails, I retry up to 3 times with exponential backoff and jitter, using an idempotency key so retries don't double-charge."

"I'd wrap the payment client in a circuit breaker. If we see 5 failures in 10 seconds, the breaker opens and we immediately return 'payment temporarily unavailable' instead of piling more requests onto a failing service. After 30 seconds, we probe with one request to check recovery."

"The payment call runs in its own thread pool — a bulkhead with 8 threads. Even if all 8 are stuck waiting on a slow payment provider, the inventory and shipping calls have their own pools and continue working."

"On the server side, if our checkout service is overloaded, we shed load by rejecting requests from free-tier users first while continuing to serve paid users. This is better than degrading performance for everyone."

"The key principle: fail fast, fail small, fail gracefully. Every failure is contained to the smallest possible blast radius."

---

## Related Articles

**Next in series:** [Consensus Algorithms](consensus-algorithms.md)

**Previous in series:** [Distributed Transactions](distributed-transactions.md)

**See also:**
- [Elasticsearch Architecture Essentials](../search/elasticsearch-architecture-essentials.md) — Elasticsearch uses circuit breakers and failure handling in practice
