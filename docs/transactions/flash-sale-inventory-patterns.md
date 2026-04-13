# Flash Sale Inventory Patterns

It's 12:00:00 PM. A limited-edition sneaker drops — 500 pairs, 200,000 users hitting "Buy" simultaneously. Within 3 seconds, your inventory service receives 200,000 requests to decrement the same counter from 500 to 0. A naive implementation either oversells (2,000 people get confirmations for 500 pairs) or collapses under lock contention (everyone gets timeouts).

This is the flash sale problem: **extreme write contention on a single hot resource, with zero tolerance for overselling.** It's one of the hardest concurrency problems in system design because you need both correctness and performance under a spike that lasts seconds.

## Why Naive Approaches Fail

### Approach 1: Simple UPDATE

```sql
UPDATE products SET quantity = quantity - 1 WHERE id = 42 AND quantity > 0;
```

This is correct — the database serializes writes and the `quantity > 0` check prevents overselling. But under 200,000 concurrent requests, every single one contends on the same row lock. Throughput collapses to ~200 TPS (one lock acquisition per ~5ms).

```
200,000 requests / 200 TPS = 1,000 seconds to process
Users experience: 30-second timeouts, 503 errors, rage
```

### Approach 2: SELECT FOR UPDATE

```sql
BEGIN;
SELECT quantity FROM products WHERE id = 42 FOR UPDATE;
-- check quantity > 0 in application
UPDATE products SET quantity = quantity - 1 WHERE id = 42;
COMMIT;
```

Same problem. The `FOR UPDATE` serializes all transactions on that row. You've added a round trip (SELECT + UPDATE instead of just UPDATE) and made it slower.

### Approach 3: Optimistic Locking

```sql
UPDATE products SET quantity = quantity - 1, version = version + 1
WHERE id = 42 AND quantity > 0 AND version = 3;
```

Under low contention, this works great. Under flash sale contention, 199,999 out of 200,000 requests fail on the first attempt. They all retry. Most fail again. Retry storms amplify load instead of reducing it.

## Pattern 1: Redis Atomic Decrement

Move the hot counter out of the database and into Redis. Redis is single-threaded — operations are naturally serialized without lock overhead.

```
Architecture:
  [Users] → [API Servers] → [Redis: inventory counter] → [Database: order records]
```

### Implementation

```python
# Pre-load inventory into Redis before the sale starts
redis.set("inventory:42", 500)

# On purchase request:
remaining = redis.decr("inventory:42")

if remaining >= 0:
    # Success — user got one
    queue_order_creation(user_id, product_id)
    return {"status": "confirmed"}
else:
    # Oversold — undo the decrement
    redis.incr("inventory:42")
    return {"status": "sold_out"}
```

### Why This Works

Redis `DECR` is atomic and executes in ~0.1ms. Single-threaded execution means no lock contention. Throughput: 100,000+ operations per second on a single Redis instance.

```
200,000 requests / 100,000 TPS = 2 seconds to process all requests
First 500 get confirmed, remaining 199,500 get "sold out" immediately
```

### The Catch

Redis is not durable by default. If Redis crashes after decrementing but before the order is persisted to the database, you've sold an item without recording it.

**Mitigation:** Treat Redis as the authoritative counter during the sale. After the sale, reconcile Redis count with actual orders in the database. Use Redis persistence (AOF with `appendfsync everysec`) for crash recovery.

### Handling the Race Below Zero

The `DECR` + check pattern has a subtle issue: if remaining is -1, you increment back, but between the DECR and INCR, another request might see -1 and also increment. Use a Lua script for atomicity:

```lua
-- Atomic decrement-if-positive in Redis
local current = redis.call('GET', KEYS[1])
if tonumber(current) > 0 then
    redis.call('DECR', KEYS[1])
    return 1  -- success
else
    return 0  -- sold out
end
```

```python
DECR_SCRIPT = """
local current = redis.call('GET', KEYS[1])
if tonumber(current) > 0 then
    redis.call('DECR', KEYS[1])
    return 1
else
    return 0
end
"""

result = redis.eval(DECR_SCRIPT, 1, "inventory:42")
if result == 1:
    queue_order_creation(user_id, product_id)
```

Lua scripts execute atomically in Redis — no interleaving possible.

## Pattern 2: Sharded Counters (Database)

If you must stay in the database, split the single inventory row into multiple shards.

```sql
-- Instead of one row with quantity=500:
CREATE TABLE inventory_shards (
    product_id BIGINT,
    shard_id INT,
    quantity INT,
    PRIMARY KEY (product_id, shard_id)
);

-- Split 500 units across 10 shards:
INSERT INTO inventory_shards VALUES (42, 0, 50);
INSERT INTO inventory_shards VALUES (42, 1, 50);
INSERT INTO inventory_shards VALUES (42, 2, 50);
-- ... through shard 9
```

### Purchase Logic

```python
# Pick a random shard to reduce contention
shard = random.randint(0, 9)

result = db.execute("""
    UPDATE inventory_shards
    SET quantity = quantity - 1
    WHERE product_id = 42 AND shard_id = %s AND quantity > 0
""", shard)

if result.rowcount == 0:
    # This shard is empty — try others
    for s in range(10):
        if s == shard:
            continue
        result = db.execute("""
            UPDATE inventory_shards
            SET quantity = quantity - 1
            WHERE product_id = %s AND shard_id = %s AND quantity > 0
        """, (42, s))
        if result.rowcount == 1:
            break
    else:
        return {"status": "sold_out"}
```

### Why This Works

10 shards means 10 independent row locks. Contention drops by 10x. With 10 shards, you go from 200 TPS to ~2,000 TPS on the database.

```
Single row:  200,000 requests / 200 TPS  = 1,000 seconds
10 shards:   200,000 requests / 2,000 TPS = 100 seconds
100 shards:  200,000 requests / 20,000 TPS = 10 seconds
```

**Tradeoff:** More complex queries. Checking total inventory requires summing across shards. Some shards empty before others, requiring fallback logic.

## Pattern 3: Queue-Based Rate Limiting

Don't let all 200,000 requests hit the inventory system. Funnel them through a queue.

```
[200K Users] → [API Gateway: rate limit] → [Queue: 1000 capacity] → [Workers: process sequentially]
                     ↓
              [Overflow: "sold out" or "in queue"]
```

### Implementation

```python
# API layer: try to enqueue the purchase request
enqueued = redis.lpush_if_length_under("purchase_queue:42", user_id, max_length=500)

if enqueued:
    return {"status": "queued", "position": redis.llen("purchase_queue:42")}
else:
    return {"status": "sold_out"}

# Worker: process queue sequentially
while True:
    user_id = redis.brpop("purchase_queue:42")
    if inventory_available(product_id=42):
        create_order(user_id, product_id=42)
        notify_user(user_id, "confirmed")
    else:
        notify_user(user_id, "sold_out")
```

### Why This Works

The queue acts as a buffer. Only N workers process purchases at a time, eliminating contention entirely. The database sees sequential writes, not 200,000 concurrent ones.

**Tradeoff:** Users don't get instant confirmation. They get "you're in the queue" and wait for async notification. This is acceptable for high-demand drops (sneakers, concert tickets) where users expect a waiting room experience.

## Pattern 4: Two-Phase Reservation

Separate "claiming" inventory from "confirming" the purchase. This handles payment failures gracefully.

```
Phase 1: Reserve (fast, in Redis or DB)
  → Decrement available count
  → Create reservation with TTL

Phase 2: Confirm (after payment)
  → Convert reservation to order
  → If payment fails or TTL expires, release reservation
```

```python
# Phase 1: Reserve
reservation_id = str(uuid4())
claimed = redis.eval(DECR_SCRIPT, 1, "inventory:42")

if claimed:
    # Store reservation with 10-minute TTL
    redis.setex(f"reservation:{reservation_id}", 600, json.dumps({
        "product_id": 42, "user_id": user_id
    }))
    return {"status": "reserved", "reservation_id": reservation_id, "expires_in": 600}

# Phase 2: Confirm (after payment succeeds)
reservation = redis.get(f"reservation:{reservation_id}")
if reservation:
    create_order(reservation)
    redis.delete(f"reservation:{reservation_id}")
else:
    return {"error": "Reservation expired"}

# TTL expiry handler (background job)
# When a reservation key expires, increment inventory back
```

### Why This Works

Users get instant feedback ("reserved for you for 10 minutes"). Payment processing happens outside the hot path. If payment fails, inventory is automatically released after TTL.

**Tradeoff:** You need a reliable TTL expiry mechanism. Redis keyspace notifications or a background sweeper job that checks for expired reservations.

## Pattern 5: Token Bucket Pre-allocation

Issue purchase tokens before the sale starts. Only token holders can buy.

```
Before sale:
  Generate 500 tokens → store in Redis set
  Distribute tokens via lottery/queue to first 500 users who enter the "waiting room"

During sale:
  User presents token → validate → process purchase → invalidate token
```

```python
# Pre-sale: user enters waiting room
position = redis.incr("waitroom:42")
if position <= 500:
    token = generate_secure_token()
    redis.sadd("valid_tokens:42", token)
    return {"status": "eligible", "token": token}
else:
    return {"status": "not_selected"}

# During sale: user with token purchases
if redis.srem("valid_tokens:42", user_token) == 1:
    # Token was valid and is now consumed
    create_order(user_id, product_id=42)
    return {"status": "confirmed"}
else:
    return {"status": "invalid_token"}
```

### Why This Works

The contention is moved to the waiting room phase (which is just incrementing a counter — trivial). The actual purchase phase has at most 500 requests, not 200,000. Zero contention on inventory.

**Tradeoff:** More complex user experience. Requires a "waiting room" UI. Users who get tokens but don't complete purchase waste inventory until tokens expire.

## Combining Patterns

Real flash sale systems combine multiple patterns:

```
┌─────────────────────────────────────────────────────┐
│  Layer 1: CDN + Rate Limiting                       │
│  → Absorb 90% of traffic at the edge               │
├─────────────────────────────────────────────────────┤
│  Layer 2: Waiting Room / Token Distribution         │
│  → Reduce eligible users to ~2x inventory           │
├─────────────────────────────────────────────────────┤
│  Layer 3: Redis Atomic Decrement                    │
│  → Fast inventory check, no DB contention           │
├─────────────────────────────────────────────────────┤
│  Layer 4: Reservation with TTL                      │
│  → Handle payment failures gracefully               │
├─────────────────────────────────────────────────────┤
│  Layer 5: Database Order Creation                   │
│  → Durable record, runs at manageable throughput    │
└─────────────────────────────────────────────────────┘
```

Each layer reduces the load on the next. By the time requests reach the database, they're a trickle — not a flood.

## Tradeoff Summary

| Pattern | Throughput | Correctness | Complexity | User Experience |
|---------|-----------|-------------|-----------|-----------------|
| Single row UPDATE | ~200 TPS | Perfect | Low | Timeouts |
| Redis atomic decrement | 100K+ TPS | Good (needs reconciliation) | Medium | Instant |
| Sharded counters | ~N × 200 TPS | Perfect | Medium | Acceptable |
| Queue-based | Controlled | Perfect | High | Async ("in queue") |
| Two-phase reservation | High | Good (TTL edge cases) | High | "Reserved for you" |
| Token bucket | Unlimited | Perfect | High | Waiting room |

## Interview Application

When discussing flash sale inventory in a system design interview:

"The core challenge is write contention on a single inventory counter. A naive `UPDATE ... WHERE quantity > 0` serializes all requests through one row lock — maybe 200 TPS. For a flash sale with 200K concurrent users, that's a 15-minute queue."

"My approach: use Redis as the fast inventory gate. Pre-load the count before the sale. Use a Lua script for atomic decrement-if-positive. Redis handles 100K+ ops/sec single-threaded, so all 200K requests resolve in 2 seconds. The first 500 get confirmed, the rest get instant 'sold out.'"

"For durability, I'd use a two-phase approach. Redis decrement gives instant reservation with a 10-minute TTL. The user proceeds to payment. On success, we write the order to the database. On failure or timeout, the reservation expires and inventory is released back."

"To handle the traffic spike at the infrastructure level, I'd add a waiting room. Users enter a queue before the sale starts. We issue purchase tokens to the first N users (where N is slightly above inventory count to account for drop-off). Only token holders can hit the purchase endpoint. This reduces peak load from 200K to ~600 concurrent requests."

"The key insight: you solve this in layers. Each layer — CDN rate limiting, waiting room, Redis counter, reservation TTL, database write — reduces the problem for the next layer. By the time we hit the database, it's handling 10 writes per second, not 200,000."

---

## Related Articles

**Previous in series:** [Optimistic Locking Patterns](optimistic-locking-patterns.md)

**See also:**
- [Bloom Filters](../probabilistic/bloom-filters-part-1.md) — used in inventory deduplication
- [Failure Handling Patterns](../distributed-systems/failure-handling-patterns.md) — handling partial failures in high-throughput systems
