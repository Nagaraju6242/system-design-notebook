# Distributed Transactions

A user books a flight, reserves a hotel, and rents a car. Three separate services. Three separate databases. The flight booking succeeds. The hotel reservation fails. The car rental never executes. The user has a flight but no hotel — an incomplete, inconsistent trip.

This is the distributed transaction problem. Multiple services must either all succeed or all fail. Without coordination, partial failures leave the system in a broken state that's hard to detect and harder to fix.

## When You Need Distributed Transactions

In a monolith with a single database, you wrap related operations in a transaction:

```sql
BEGIN TRANSACTION;
  UPDATE accounts SET balance = balance - 100 WHERE id = 1;
  UPDATE accounts SET balance = balance + 100 WHERE id = 2;
COMMIT;
```

Both updates succeed or both roll back. The database guarantees atomicity.

Microservices break this. The Order Service has its own database. The Payment Service has its own. The Inventory Service has its own. A single database transaction cannot span them.

```
Monolith:                          Microservices:
┌─────────────────────┐           ┌─────────┐ ┌─────────┐ ┌─────────┐
│  Order + Payment    │           │  Order   │ │ Payment │ │Inventory│
│  + Inventory        │           │ Service  │ │ Service │ │ Service │
│  ┌───────────────┐  │           │ ┌─────┐  │ │ ┌─────┐ │ │ ┌─────┐ │
│  │  One Database │  │           │ │ DB  │  │ │ │ DB  │ │ │ │ DB  │ │
│  └───────────────┘  │           │ └─────┘  │ │ └─────┘ │ │ └─────┘ │
└─────────────────────┘           └─────────┘ └─────────┘ └─────────┘
  Single transaction                Three databases, no shared transaction
```

When a checkout request arrives, you must: create the order, charge payment, and decrement inventory. All three must succeed or all must roll back. How?

## Two-Phase Commit (2PC)

Two-Phase Commit is a protocol for atomic commitment across multiple participants, coordinated by a single coordinator node.

### Phase 1: Prepare

The coordinator sends a `PREPARE` message to all participants. Each participant:
1. Executes the transaction locally (but doesn't commit)
2. Writes to its transaction log (WAL) so it can recover
3. Locks the affected resources
4. Responds `YES` (can commit) or `NO` (cannot)

### Phase 2: Commit or Abort

If **all** participants voted `YES`:
- Coordinator writes `COMMIT` to its own log (the commit point — irrevocable)
- Sends `COMMIT` to all participants
- Participants commit and release locks

If **any** participant voted `NO`:
- Coordinator sends `ABORT` to all participants
- Participants roll back and release locks

```
Coordinator          Participant A       Participant B
    │                     │                    │
    │──── PREPARE ───────►│                    │
    │──── PREPARE ────────┼───────────────────►│
    │                     │                    │
    │◄─── YES ────────────│                    │
    │◄─── YES ─────────────────────────────────│
    │                     │                    │
    │ (all YES → commit)  │                    │
    │                     │                    │
    │──── COMMIT ────────►│                    │
    │──── COMMIT ─────────┼───────────────────►│
    │                     │                    │
    │◄─── ACK ────────────│                    │
    │◄─── ACK ─────────────────────────────────│
```

### Problems with 2PC

**Blocking.** Once a participant votes `YES`, it holds locks and waits for the coordinator's decision. If the coordinator crashes after collecting votes but before sending the decision, participants are stuck. They can't commit (coordinator might have decided abort). They can't abort (coordinator might have decided commit). Resources stay locked until the coordinator recovers.

**Latency.** Two synchronous network round-trips: prepare + commit. Each round waits for the slowest participant. Participants hold locks during both phases, reducing concurrency for other transactions.

**Coordinator is a single point of failure.** You can replicate the coordinator with Raft/Paxos, but that adds another layer of latency and complexity.

**Limited ecosystem support.** Traditional RDBMS (MySQL, PostgreSQL) support 2PC via XA transactions. Most cloud-native databases (DynamoDB, Cassandra) don't. You can't use 2PC with third-party APIs or services you don't control.

### When 2PC Makes Sense

Despite its problems, 2PC is the right choice when:
- You need **perfect atomicity** — no temporary inconsistency is acceptable
- All participants are within the same datacenter (low latency)
- You control all participating services and they support the protocol
- The transaction rate is low enough that lock contention isn't a bottleneck

Financial systems transferring money between accounts within the same bank often use 2PC or its variants.

## The Saga Pattern

Sagas take a fundamentally different approach. Instead of preventing partial failures, they **accept and compensate** for them.

A saga is a sequence of local transactions. Each step commits immediately to its own database. If a later step fails, the saga executes **compensating transactions** in reverse order to undo previous steps.

```
Success Path:
  1. Create Order    → committed ✓
  2. Charge Payment  → committed ✓
  3. Reserve Stock   → committed ✓
  Done.

Failure Path:
  1. Create Order    → committed ✓
  2. Charge Payment  → committed ✓
  3. Reserve Stock   → FAILED ✗
  4. Refund Payment  → compensating ✓  (undo step 2)
  5. Cancel Order    → compensating ✓  (undo step 1)
```

Each service defines both a forward operation and a compensating operation:

| Service | Forward | Compensation |
|---------|---------|-------------|
| Order | Create order | Cancel order |
| Payment | Charge card | Refund card |
| Inventory | Reserve stock | Release stock |
| Shipping | Schedule pickup | Cancel pickup |

### Saga vs 2PC

**2PC prevents inconsistency.** All services commit or all abort atomically. The system is never in a partially-committed state.

**Sagas accept temporary inconsistency.** Between step 2 succeeding and step 3 failing, the system is inconsistent — payment is charged but the order will be cancelled. This inconsistency is resolved by compensation, but it exists briefly.

The tradeoff: sagas are more available, more performant, and work with any service (including third-party APIs). But they require careful design of compensating transactions and handling of the inconsistency window.

## Choreography vs Orchestration

Two implementation patterns for sagas:

### Choreography (Event-Driven)

No central coordinator. Services communicate through events.

```
Order Service ──publishes──► "OrderCreated"
                                    │
Payment Service ◄───listens─────────┘
    │
    ├──publishes──► "PaymentCharged"
    │                      │
    │   Inventory ◄────────┘
    │   Service
    │       │
    │       ├──publishes──► "StockReserved" → Done!
    │       │
    │       └──publishes──► "StockFailed"
    │                              │
    └──◄───────────────────────────┘
       Refund payment, publish "PaymentRefunded"
                                    │
Order Service ◄─────────────────────┘
    Cancel order
```

**Pros:** No single point of failure. Services are loosely coupled. Scales well.

**Cons:** Hard to understand the overall flow. Debugging requires tracing events across services. No central place to see saga state. Adding a new step means modifying multiple services' event handlers.

### Orchestration (Central Coordinator)

A saga orchestrator directs the flow.

```
Saga Orchestrator
    │
    ├──► Order Service: "Create order"
    │◄── OK
    │
    ├──► Payment Service: "Charge payment"
    │◄── OK
    │
    ├──► Inventory Service: "Reserve stock"
    │◄── FAILED
    │
    ├──► Payment Service: "Refund payment"  (compensate)
    │◄── OK
    │
    └──► Order Service: "Cancel order"      (compensate)
         OK
```

**Pros:** Clear, readable flow. Easy to monitor and debug. Saga state is centralized. Adding steps means modifying the orchestrator, not multiple services.

**Cons:** Orchestrator is a dependency (though it can be stateless and replicated). Risk of the orchestrator becoming a "god service" with too much logic.

**Recommendation:** Use orchestration for most systems. The clarity and debuggability outweigh the coupling. Use choreography only when you need maximum decoupling or are integrating services across organizational boundaries.

## Designing Compensating Transactions

Compensations are harder than they look. Key challenges:

**Not all operations are reversible.** You can refund a payment, but you can't un-send an email or un-deliver a package. For irreversible operations, use the saga to prevent them until all preceding steps are confirmed.

**Compensations can fail.** What if the refund API call fails? You need retry logic with idempotency. Each compensation must be idempotent — calling it twice produces the same result as calling it once.

**Semantic compensation vs. rollback.** A database rollback restores the exact previous state. A compensation is a new forward operation that semantically undoes the effect. Cancelling an order isn't the same as the order never existing — there's a record of the cancelled order.

```python
# Idempotent compensation example
def refund_payment(order_id: str, idempotency_key: str):
    existing = db.get_refund(idempotency_key)
    if existing:
        return existing  # Already processed, return same result
    
    refund = payment_gateway.refund(order_id, idempotency_key)
    db.save_refund(idempotency_key, refund)
    return refund
```

## Avoiding Distributed Transactions

The best distributed transaction is the one you don't need.

### Consolidate Related Data

If Order, Payment, and Inventory always change together, maybe they belong in the same service with one database. A single Checkout Service handles all three in one local transaction.

```
Instead of:                        Consider:
┌───────┐ ┌───────┐ ┌───────┐    ┌─────────────────────┐
│ Order │ │Payment│ │ Inv.  │    │  Checkout Service    │
│  DB   │ │  DB   │ │  DB   │    │  ┌───────────────┐   │
└───────┘ └───────┘ └───────┘    │  │  One Database  │   │
  3 databases, need saga          │  └───────────────┘   │
                                  └─────────────────────┘
                                    1 database, local txn
```

The industry over-corrected toward microservices. Many systems would be simpler as well-structured services with broader boundaries.

### Accept Eventual Consistency

Most operations don't need atomicity. Create the booking immediately. Process payment asynchronously. If payment fails, notify the user and cancel. Users understand "payment processing."

### Outbox Pattern

Solves the dual-write problem: you need to update a database AND publish an event atomically. Write both the entity change and an outbox record in one local transaction. A separate process tails the outbox table and publishes to the message broker.

```
Single local transaction:
  1. INSERT INTO orders (id, ...) VALUES (...)
  2. INSERT INTO outbox (event_type, payload) VALUES ('OrderCreated', {...})
  COMMIT;

Background process:
  Poll outbox table → publish to Kafka → mark as published
```

This guarantees the event is published if and only if the database write succeeded. No distributed transaction needed.

## Choosing an Approach

```
Do you need multi-service coordination?
├── No → Use local transactions. Done.
│
├── Can you consolidate into one service?
│   └── Yes → Do it. Local transactions. Done.
│
├── Can you accept eventual consistency?
│   └── Yes → Async processing with message queues. Done.
│
├── Need coordination but can tolerate brief inconsistency?
│   └── Yes → Saga pattern (orchestration preferred).
│
└── Need perfect atomicity across services?
    └── Yes → 2PC (accept the latency and availability cost).
```

## Interview Application

When discussing distributed transactions in an interview, start by questioning whether you need them:

"For e-commerce checkout, we could split into Order, Payment, and Inventory services. But that creates distributed transaction problems. If the team is small enough, a single Checkout Service with one database handles all three in a local transaction. Simpler and more reliable."

"If we must use separate services, I'd use the Saga pattern with orchestration. The Checkout Orchestrator calls Payment, then Inventory. If inventory fails after payment succeeds, we issue a refund. The system is briefly inconsistent — payment charged but order not fulfilled — but that resolves within seconds. We use idempotency keys on every operation so retries are safe."

"We could use 2PC for perfect atomicity, but it adds latency from two synchronous round-trips and blocks resources during coordinator failures. For an e-commerce checkout, saga's brief inconsistency is acceptable. For a bank transfer between accounts, 2PC's stronger guarantee might be worth the cost."

"We'd use the outbox pattern to reliably publish events. The order creation and the outbox event are written in one local transaction. A background process publishes to Kafka. This avoids the dual-write problem without a distributed transaction."

---

## Related Articles

**Next in series:** [Failure Handling Patterns](failure-handling-patterns.md)

**Previous in series:** [Consistency Models](consistency-models.md)

**See also:**
- [Database Transactions](../transactions/database-transactions.md) — single-node transaction fundamentals that distributed transactions extend
- [Flash Sale Inventory Patterns](../transactions/flash-sale-inventory-patterns.md) — practical patterns applying distributed transaction concepts
