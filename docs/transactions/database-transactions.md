# Database Transactions

A user transfers $500 from their checking account to their savings account. The system deducts $500 from checking. Then the server crashes. The savings account never receives the $500. The money has vanished.

This is why **database transactions** exist. They guarantee that a group of operations either all succeed or all fail. No partial state. No vanishing money.

## What Is a Transaction?

A transaction is a sequence of database operations treated as a single logical unit. The classic example is a bank transfer:

```sql
BEGIN TRANSACTION;
UPDATE accounts SET balance = balance - 500 WHERE id = 1;  -- debit checking
UPDATE accounts SET balance = balance + 500 WHERE id = 2;  -- credit savings
COMMIT;
```

Both statements execute together. If the second fails, the first is undone. The database never shows a state where money left one account but didn't arrive in the other.

Without transactions, every multi-step operation is a gamble. Insert an order, then insert order items — what if the connection drops between them? You get an order with no items. Update inventory, then update the sales record — crash between them, and your numbers don't add up.

Transactions eliminate this class of bugs entirely.

## ACID Properties

Every database transaction is defined by four properties, collectively known as **ACID**. These aren't abstract theory — they're the concrete guarantees your application depends on.

### Atomicity

All operations in a transaction succeed, or none of them do. There is no partial execution.

If you're inserting a user and their profile in one transaction, you'll never end up with a user row but no profile row. If the profile insert fails, the user insert is rolled back.

**How it works internally:** The database writes changes to a **write-ahead log (WAL)** before modifying actual data pages. If a crash occurs mid-transaction, the database reads the WAL on recovery and undoes incomplete transactions. The WAL is the safety net.

```
Transaction starts → Write to WAL → Modify data pages → COMMIT → Mark WAL entry complete
                                          ↓
                                    Crash here?
                                          ↓
                              Recovery: Read WAL → Undo changes
```

### Consistency

A transaction moves the database from one valid state to another. It cannot violate constraints — foreign keys, unique indexes, check constraints, NOT NULL rules.

If you try to insert an order referencing a customer that doesn't exist, the transaction fails. The database enforces its own rules.

```sql
-- This will fail if customer_id 999 doesn't exist in the customers table
BEGIN TRANSACTION;
INSERT INTO orders (id, customer_id, total) VALUES (1, 999, 49.99);
COMMIT;
-- ERROR: foreign key constraint violation
```

Consistency is partly the database's job (enforcing constraints) and partly your job (writing correct application logic). The database won't let you violate declared constraints, but it can't prevent you from writing logically wrong data that satisfies all constraints.

### Isolation

Concurrent transactions don't interfere with each other. Each transaction behaves as if it's the only one running, even when thousands execute simultaneously.

This is the hardest property to implement and the one with the most nuance. In practice, databases offer **isolation levels** that trade strictness for performance:

| Level | Dirty Reads | Non-Repeatable Reads | Phantom Reads | Performance |
|-------|-------------|---------------------|---------------|-------------|
| Read Uncommitted | Yes | Yes | Yes | Fastest |
| Read Committed | No | Yes | Yes | Fast |
| Repeatable Read | No | No | Yes | Moderate |
| Serializable | No | No | No | Slowest |

**Dirty Read:** Transaction A reads data that Transaction B has written but not yet committed. If B rolls back, A has read data that never existed.

**Non-Repeatable Read:** Transaction A reads a row, Transaction B updates that row and commits, Transaction A reads the same row again and gets a different value.

**Phantom Read:** Transaction A queries rows matching a condition, Transaction B inserts a new row matching that condition and commits, Transaction A runs the same query and gets an extra row.

Most production databases default to **Read Committed** (PostgreSQL, Oracle) or **Repeatable Read** (MySQL InnoDB). Serializable is rarely used because the performance cost is steep.

### Durability

Once a transaction commits, the data survives any failure — power outage, OS crash, disk failure (with replication).

**How it works internally:** The database flushes the WAL to disk before acknowledging the COMMIT. Even if the server crashes immediately after, the WAL on disk contains the committed changes. On recovery, the database replays the WAL to restore committed transactions.

```
COMMIT received → Flush WAL to disk → Acknowledge to client
                        ↓
                  Power failure here?
                        ↓
              Recovery: Replay WAL → Data restored
```

The WAL flush is the critical moment. Before the flush, the transaction can be lost. After the flush, it's permanent. This is why `fsync` performance matters so much for database throughput — every commit waits for a disk write.

## Transaction Lifecycle

A transaction goes through a well-defined lifecycle:

```
BEGIN → Active → [operations] → COMMIT → Committed
                      ↓
                   Error?
                      ↓
                  ROLLBACK → Aborted
```

### BEGIN

Marks the start of a transaction. All subsequent operations are part of this transaction until COMMIT or ROLLBACK.

```sql
BEGIN TRANSACTION;
-- or simply
BEGIN;
```

Some databases (MySQL, SQL Server) use `START TRANSACTION`. Some operate in **autocommit mode** by default — every single statement is its own transaction unless you explicitly begin one.

### COMMIT

Makes all changes permanent. Once committed, other transactions can see the changes (depending on isolation level), and the changes survive crashes.

```sql
COMMIT;
```

### ROLLBACK

Undoes all changes made during the transaction. The database reverts to the state before BEGIN.

```sql
ROLLBACK;
```

### SAVEPOINT

Creates a checkpoint within a transaction. You can rollback to a savepoint without aborting the entire transaction.

```sql
BEGIN;
INSERT INTO orders (id, total) VALUES (1, 100);
SAVEPOINT after_order;

INSERT INTO order_items (order_id, product_id) VALUES (1, 999);
-- This fails — product 999 doesn't exist
ROLLBACK TO after_order;

-- Order insert is still intact, we can try a different item
INSERT INTO order_items (order_id, product_id) VALUES (1, 42);
COMMIT;
```

Savepoints are useful for complex operations where you want partial retry logic without restarting the entire transaction.

## How Databases Implement Transactions

Understanding the internals helps you reason about performance and failure modes.

### Write-Ahead Logging (WAL)

The WAL is the backbone of transaction durability and atomicity. Every change is written to the log before it's applied to the actual data.

```
Client: UPDATE balance = 500 WHERE id = 1
   ↓
Database: Write to WAL (sequential disk write — fast)
   ↓
Database: Update in-memory buffer pool
   ↓
Database: Eventually flush dirty pages to disk (background)
   ↓
Client: COMMIT
   ↓
Database: Write commit record to WAL, fsync to disk
   ↓
Database: Acknowledge commit to client
```

Sequential writes to the WAL are fast. Random writes to data pages are slow. By batching and deferring data page writes, the database achieves high throughput while maintaining durability.

### Undo and Redo Logs

- **Undo log:** Stores the old values before modification. Used for ROLLBACK and for showing consistent snapshots to other transactions (MVCC).
- **Redo log:** Stores the new values. Used during crash recovery to replay committed transactions whose data pages weren't flushed to disk.

On crash recovery:
1. **Redo** all committed transactions (their changes might not have reached data pages)
2. **Undo** all uncommitted transactions (their partial changes might have reached data pages)

### MVCC (Multi-Version Concurrency Control)

Most modern databases (PostgreSQL, MySQL InnoDB, Oracle) use MVCC instead of pure locking. MVCC keeps multiple versions of each row.

When Transaction A reads a row, it sees the version that was current when A started (or when A's statement started, depending on isolation level). When Transaction B updates that row, it creates a new version. A still sees the old version. No blocking.

```
Time 1: Row X = 100 (version 1)
Time 2: Transaction A starts, reads Row X → sees 100 (version 1)
Time 3: Transaction B updates Row X = 200 (creates version 2)
Time 4: Transaction A reads Row X again → still sees 100 (version 1)
Time 5: Transaction B commits
Time 6: Transaction A reads Row X again → sees 100 (Repeatable Read) or 200 (Read Committed)
```

MVCC is why readers don't block writers and writers don't block readers. This is the key to high concurrency in modern databases.

The tradeoff: old row versions accumulate and must be cleaned up. PostgreSQL calls this **VACUUM**. MySQL does it via **purge threads**. If cleanup falls behind, you get table bloat and degraded performance.

## Common Transaction Pitfalls

### Long-Running Transactions

A transaction that stays open for minutes (or hours) causes problems:
- **Lock contention:** Other transactions wait for locks held by the long transaction
- **MVCC bloat:** The database can't clean up old row versions because the long transaction might still need them
- **Replication lag:** In replicated setups, long transactions delay applying changes to replicas

**Rule of thumb:** Keep transactions as short as possible. Do your computation outside the transaction, then open a transaction only for the actual database writes.

```python
# BAD: computation inside transaction
with db.transaction():
    data = expensive_api_call()        # holds transaction open during network I/O
    result = heavy_computation(data)   # holds transaction open during CPU work
    db.insert(result)

# GOOD: computation outside transaction
data = expensive_api_call()
result = heavy_computation(data)
with db.transaction():
    db.insert(result)                  # transaction open only for the write
```

### Deadlocks

Two transactions each hold a lock the other needs. Neither can proceed.

```
Transaction A: UPDATE accounts SET balance = 100 WHERE id = 1;  -- locks row 1
Transaction B: UPDATE accounts SET balance = 200 WHERE id = 2;  -- locks row 2
Transaction A: UPDATE accounts SET balance = 300 WHERE id = 2;  -- waits for B's lock on row 2
Transaction B: UPDATE accounts SET balance = 400 WHERE id = 1;  -- waits for A's lock on row 1
-- DEADLOCK
```

Databases detect deadlocks and abort one transaction (the "victim"). Your application must be prepared to retry.

**Prevention:** Always acquire locks in a consistent order. If you're updating accounts 1 and 2, always lock the lower ID first.

### Implicit Commits

Some databases auto-commit DDL statements (CREATE TABLE, ALTER TABLE, DROP). In MySQL, a DDL statement inside a transaction implicitly commits everything before it.

```sql
BEGIN;
INSERT INTO users (name) VALUES ('Alice');
ALTER TABLE users ADD COLUMN age INT;  -- implicitly commits the INSERT
-- You cannot rollback the INSERT anymore
```

This catches people off guard. Know your database's behavior around DDL and transactions.

### Connection Pool Leaks

If your application opens a transaction but crashes before committing or rolling back, the connection returns to the pool with an open transaction. The next request that gets this connection inherits the stale transaction.

**Prevention:** Use connection pool middleware that automatically rolls back uncommitted transactions when connections are returned to the pool. Most ORMs and connection pools handle this, but verify.

## Transactions in Practice

### ORMs and Transactions

Most ORMs provide transaction management. Use explicit transaction boundaries for multi-step operations:

```python
# SQLAlchemy
with session.begin():
    user = User(name="Alice")
    session.add(user)
    profile = Profile(user=user, bio="Engineer")
    session.add(profile)
# auto-commits on exit, auto-rollbacks on exception

# Django
from django.db import transaction

with transaction.atomic():
    order = Order.objects.create(customer=customer, total=99.99)
    OrderItem.objects.create(order=order, product=product, quantity=1)
```

### Retry Logic

Transactions can fail due to deadlocks, serialization failures, or transient errors. Your application should retry:

```python
MAX_RETRIES = 3

for attempt in range(MAX_RETRIES):
    try:
        with db.transaction():
            transfer_funds(from_account, to_account, amount)
            break
    except DeadlockError:
        if attempt == MAX_RETRIES - 1:
            raise
        time.sleep(0.1 * (2 ** attempt))  # exponential backoff
```

### Read-Only Transactions

If you're only reading data and need a consistent snapshot, use a read-only transaction. The database can optimize — no undo log entries, no lock escalation.

```sql
BEGIN TRANSACTION READ ONLY;
SELECT balance FROM accounts WHERE id = 1;
SELECT balance FROM accounts WHERE id = 2;
-- Both reads see a consistent snapshot
COMMIT;
```

PostgreSQL and MySQL both support this. It's especially useful for generating reports where you need consistent data across multiple queries.

## When Transactions Aren't Enough

Single-database transactions solve the problem when all your data lives in one database. But modern systems often have:

- **Multiple databases** — Order Service has its own DB, Payment Service has its own
- **External APIs** — you can't rollback a Stripe charge with a database ROLLBACK
- **Message brokers** — you need to update a DB and publish a Kafka message atomically

These scenarios require **distributed transactions** — a fundamentally harder problem covered in a separate article. The key insight: single-database ACID transactions are a solved problem. Distributed transactions across services are not.

## Interview Application

When discussing transactions in system design interviews, demonstrate depth:

"For the payment flow, we need atomicity across the balance deduction and the transaction record insert. We'll wrap both in a single database transaction. If either fails, both roll back. Since both tables are in the same database, a local transaction gives us full ACID guarantees."

"We'll use Read Committed isolation — it prevents dirty reads without the performance cost of Serializable. Our application handles the rare non-repeatable read case with optimistic locking on the account balance."

"We keep transactions short — compute the transfer validation outside the transaction, then open a transaction only for the two UPDATEs. This minimizes lock hold time under high concurrency."

"For retry safety, we use an idempotency key. If the client retries after a timeout, we check if a transaction with that key already committed. This prevents double-charging."

This shows you understand not just what transactions are, but how to use them correctly in production systems — short transactions, appropriate isolation levels, retry logic, and knowing when single-database transactions aren't enough.

---

## Related Articles

**Next in series:** [Database Isolation Levels](database-isolation-levels.md)

**See also:**
- [Distributed Transactions](../distributed-systems/distributed-transactions.md) — distributed version of the same concept
