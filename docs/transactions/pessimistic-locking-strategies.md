# Pessimistic Locking Strategies

A hospital scheduling system lets two nurses book the last ICU bed at the same time. Both read "1 bed available," both confirm the booking, and now two patients are assigned to the same bed. In healthcare, this isn't a minor inconvenience — it's a safety incident.

When the cost of a conflict is high and conflicts are likely, you don't gamble on detecting them after the fact. You **prevent** them upfront by locking the resource before anyone can touch it. That's pessimistic locking.

## The Core Idea

Pessimistic locking assumes the worst: if two transactions can conflict, they will. So you acquire a lock before reading or modifying data, hold it for the duration of your operation, and release it when done.

```
Pessimistic approach:
  1. LOCK the resource
  2. READ the data
  3. MODIFY the data
  4. COMMIT (releases lock)

  Other transactions trying to access the same resource WAIT at step 1.
```

Compare this to optimistic locking, which lets everyone proceed and checks for conflicts at write time. Pessimistic locking pays the cost upfront (waiting) to guarantee no conflicts.

## SELECT ... FOR UPDATE

The most common pessimistic lock in SQL databases. It acquires an exclusive row-level lock on the selected rows.

```sql
BEGIN;
-- Lock the inventory row — nobody else can modify it until we commit
SELECT quantity FROM products WHERE id = 42 FOR UPDATE;
-- Application checks: is quantity > 0?
UPDATE products SET quantity = quantity - 1 WHERE id = 42;
COMMIT;
```

Between the SELECT and the COMMIT, no other transaction can UPDATE or SELECT FOR UPDATE the same row. They block until this transaction finishes.

### What Happens to Concurrent Requests

```
Time    Transaction A                    Transaction B
────    ─────────────                    ─────────────
T1      BEGIN
T2      SELECT ... FOR UPDATE (row 42)
        → acquires lock, reads qty=5
T3                                       BEGIN
T4                                       SELECT ... FOR UPDATE (row 42)
                                         → BLOCKED (waiting for A's lock)
T5      UPDATE qty = 4
T6      COMMIT → lock released
T7                                       → lock acquired, reads qty=4
T8                                       UPDATE qty = 3
T9                                       COMMIT
```

Transaction B sees the correct value (4, not 5) because it waited for A to finish. No lost update.

## Locking Scope: Row vs. Range vs. Table

### Row Locks

Lock specific rows identified by the WHERE clause.

```sql
SELECT * FROM accounts WHERE id = 1 FOR UPDATE;
-- Only row with id=1 is locked
-- All other rows in the accounts table are freely accessible
```

This is the default behavior in PostgreSQL and MySQL InnoDB when the WHERE clause hits an indexed column.

### Range Locks (Gap Locks)

MySQL InnoDB uses **gap locks** and **next-key locks** to lock ranges of index values, preventing phantom inserts.

```sql
-- In MySQL with Repeatable Read or Serializable:
SELECT * FROM orders WHERE amount BETWEEN 100 AND 200 FOR UPDATE;
-- Locks existing rows AND the gaps between them
-- Another transaction cannot INSERT a row with amount=150
```

```
Index values: [50, 100, 150, 200, 300]

Gap lock covers:
  (100, 150) — gap between 100 and 150
  (150, 200) — gap between 150 and 200

Next-key lock covers:
  (100, 150] — gap + the record at 150
  (150, 200] — gap + the record at 200
```

PostgreSQL does not use gap locks. It relies on SSI (Serializable Snapshot Isolation) to detect conflicts instead of preventing them with physical locks.

### Table Locks

Lock the entire table. Nuclear option.

```sql
-- PostgreSQL
LOCK TABLE products IN EXCLUSIVE MODE;

-- MySQL
LOCK TABLES products WRITE;
```

Use only for bulk operations where row-level locking overhead is worse than blocking all access.

## Strategies for Common Problems

### Strategy 1: Lock-Then-Read-Then-Write

The standard pattern for any read-modify-write cycle.

```sql
BEGIN;
SELECT balance FROM accounts WHERE id = 1 FOR UPDATE;
-- balance = 1000
-- Application: new_balance = 1000 - 500 = 500
UPDATE accounts SET balance = 500 WHERE id = 1;
COMMIT;
```

**When to use:** Single-row updates where you need to read the current value, compute something, and write back.

**Pitfall:** Don't do expensive computation while holding the lock. Compute first, then lock-read-write-commit as fast as possible.

```python
# BAD: holding lock during slow computation
with db.transaction():
    row = db.query("SELECT * FROM orders WHERE id = %s FOR UPDATE", order_id)
    result = call_external_pricing_api(row)  # 200ms network call while lock is held
    db.execute("UPDATE orders SET price = %s WHERE id = %s", result, order_id)

# GOOD: compute first, lock briefly
result = call_external_pricing_api(get_order(order_id))
with db.transaction():
    row = db.query("SELECT * FROM orders WHERE id = %s FOR UPDATE", order_id)
    db.execute("UPDATE orders SET price = %s WHERE id = %s", result, order_id)
```

### Strategy 2: Ordered Locking for Multi-Row Operations

When a transaction needs to lock multiple rows, always lock in a deterministic order to prevent deadlocks.

```sql
-- Transfer $500 from account 7 to account 3
-- Always lock lower ID first
BEGIN;
SELECT * FROM accounts WHERE id = 3 FOR UPDATE;
SELECT * FROM accounts WHERE id = 7 FOR UPDATE;
UPDATE accounts SET balance = balance + 500 WHERE id = 3;
UPDATE accounts SET balance = balance - 500 WHERE id = 7;
COMMIT;
```

If every transaction follows this convention, deadlocks between account transfers are impossible.

```
Without ordered locking:
  T1: lock(7), lock(3)    T2: lock(3), lock(7)  → DEADLOCK

With ordered locking:
  T1: lock(3), lock(7)    T2: lock(3), lock(7)
  T2 waits for T1 to release lock(3) → no cycle → no deadlock
```

### Strategy 3: NOWAIT for Fail-Fast

When waiting is worse than failing — for example, in a user-facing API where you'd rather return "try again" than make the user wait 10 seconds.

```sql
BEGIN;
SELECT * FROM seats WHERE id = 42 FOR UPDATE NOWAIT;
-- If the row is already locked, this immediately throws:
-- ERROR: could not obtain lock on row in relation "seats"
```

Application code:

```python
try:
    with db.transaction():
        db.query("SELECT * FROM seats WHERE id = %s FOR UPDATE NOWAIT", seat_id)
        db.execute("UPDATE seats SET status = 'booked' WHERE id = %s", seat_id)
except LockNotAvailable:
    return {"error": "Seat is being booked by another user, please try again"}
```

### Strategy 4: SKIP LOCKED for Work Queues

Multiple workers process tasks from a shared table. Each worker grabs the next available (unlocked) task.

```sql
BEGIN;
SELECT id, payload FROM tasks
  WHERE status = 'pending'
  ORDER BY created_at
  LIMIT 1
  FOR UPDATE SKIP LOCKED;
-- Process the task...
UPDATE tasks SET status = 'processing' WHERE id = <selected_id>;
COMMIT;
```

```
Worker A: grabs task 1 (locks it)
Worker B: skips task 1, grabs task 2 (locks it)
Worker C: skips tasks 1 and 2, grabs task 3
-- All three workers proceed in parallel, no blocking
```

This turns a database table into a concurrent work queue. It's simpler than setting up RabbitMQ or SQS for small-scale task processing.

### Strategy 5: Advisory Locks for Application-Level Coordination

When the resource you're protecting isn't a single row — it's a logical concept like "the nightly report generation" or "processing customer 12345's webhook."

```sql
-- PostgreSQL advisory lock
-- Use a consistent integer key derived from the resource
SELECT pg_advisory_lock(hashtext('customer:12345:webhook'));
-- Only one connection can hold this lock at a time
-- Process the webhook...
SELECT pg_advisory_unlock(hashtext('customer:12345:webhook'));
```

Advisory locks don't lock any table rows. They're pure coordination primitives managed by the database's lock manager.

## The Cost of Pessimistic Locking

### Reduced Throughput

Every lock creates a serialization point. If 100 transactions want the same row, they execute one at a time.

```
Throughput with pessimistic locking on hot row:
  1 / (average_lock_hold_time) = max transactions per second

  If lock held for 5ms: max 200 TPS on that row
  If lock held for 50ms: max 20 TPS on that row
```

### Deadlock Risk

More locks = more deadlock potential. Every deadlock means one transaction is aborted and must be retried.

### Connection Pool Exhaustion

Blocked transactions hold database connections. Under high contention, your connection pool fills with waiting transactions, and new requests can't get a connection at all.

```
Connection pool: 20 connections
Hot row locked by slow transaction (2 seconds)
19 other transactions waiting for the same row
21st request: "Cannot acquire connection from pool" → 503 error
```

### Lock Starvation

A stream of short transactions can starve a long transaction that needs an exclusive lock. The long transaction keeps waiting as new shared locks are granted ahead of it.

## When to Use Pessimistic Locking

| Scenario | Use Pessimistic? | Why |
|----------|-----------------|-----|
| High contention (many writers, same rows) | Yes | Optimistic would have high retry rates |
| Low contention (rare conflicts) | No | Optimistic is cheaper |
| Cost of conflict is catastrophic | Yes | Can't afford even one conflict |
| Short-lived operations | Yes | Lock hold time is minimal |
| Long-lived operations | No | Holding locks for minutes kills concurrency |
| Work queue / task distribution | Yes (SKIP LOCKED) | Natural fit |

The decision framework: **if conflicts are frequent or expensive, lock upfront. If conflicts are rare, detect them after the fact (optimistic).**

## Interview Application

When discussing pessimistic locking in a system design interview:

"For the seat reservation system, I'd use `SELECT ... FOR UPDATE` on the seat row. When a user starts the booking flow, we lock the seat, process payment, and commit. Other users trying to book the same seat block until we're done. We keep the lock duration short — under 100ms — by doing payment pre-authorization outside the transaction."

"For the task processing pipeline, I'd use `SELECT ... FOR UPDATE SKIP LOCKED` to implement a database-backed work queue. Each worker grabs the next unlocked task, so workers never block each other. This avoids the operational complexity of a separate message broker for our scale."

"We prevent deadlocks by always acquiring locks in a deterministic order — sorted by primary key. And we set `lock_timeout` to 3 seconds as a safety net. If a transaction can't acquire a lock within 3 seconds, something is wrong and we'd rather fail fast than cascade the delay."

"The main risk with pessimistic locking is throughput on hot rows. If one product gets 10,000 concurrent purchases, they all serialize through a single row lock. For that scenario, we'd move to a sharded counter pattern — split inventory across 10 rows and decrement from any available shard."

---

## Related Articles

**Next in series:** [Optimistic Locking Patterns](optimistic-locking-patterns.md)

**Previous in series:** [Database Locking & Concurrency](database-locking-and-concurrency.md)

**See also:**
- [Optimistic Locking Patterns](optimistic-locking-patterns.md) — the alternative approach to concurrency control
