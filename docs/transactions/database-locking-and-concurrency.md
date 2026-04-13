# Database Locking & Concurrency

An e-commerce platform runs a flash sale. 10,000 users click "Buy" within the same second, all targeting the same product with 50 units in stock. Without proper concurrency control, the database either oversells (500 people get confirmation for 50 items) or grinds to a halt as every request waits in line.

This is the fundamental tension in database concurrency: **allow maximum parallelism while preventing data corruption.** Locking is the primary mechanism databases use to manage this tension.

## Why Locking Exists

Databases serve concurrent clients. Two transactions modifying the same row at the same time will corrupt data unless the database enforces ordering. Locks are the traffic signals.

```
Without locking:
  T1: READ inventory → 50
  T2: READ inventory → 50
  T1: WRITE inventory = 49
  T2: WRITE inventory = 49   ← lost update, sold 2 items but only decremented once

With locking:
  T1: LOCK row, READ inventory → 50, WRITE inventory = 49, UNLOCK
  T2: LOCK row, READ inventory → 49, WRITE inventory = 48, UNLOCK
  ← correct
```

## Lock Types

### Shared Locks (S-Locks / Read Locks)

Multiple transactions can hold a shared lock on the same resource simultaneously. Used for reads.

```
T1: SHARED LOCK on row → reads row
T2: SHARED LOCK on row → reads row (allowed — both are reading)
T3: EXCLUSIVE LOCK on row → BLOCKED (must wait for T1 and T2 to release)
```

### Exclusive Locks (X-Locks / Write Locks)

Only one transaction can hold an exclusive lock. All other lock requests (shared or exclusive) must wait.

```
T1: EXCLUSIVE LOCK on row → writes row
T2: SHARED LOCK on row → BLOCKED
T3: EXCLUSIVE LOCK on row → BLOCKED
```

### Compatibility Matrix

|  | Shared (S) | Exclusive (X) |
|--|-----------|--------------|
| **Shared (S)** | Compatible | Conflict |
| **Exclusive (X)** | Conflict | Conflict |

This is the core rule: reads don't block reads, but writes block everything.

## Lock Granularity

Databases can lock at different levels of granularity. Finer granularity means more concurrency but more overhead.

### Row-Level Locks

Lock individual rows. This is the default for most modern databases (PostgreSQL, MySQL InnoDB).

```sql
-- Implicitly locks only the row where id = 1
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
```

**Tradeoff:** Maximum concurrency (other rows are unaffected), but the database must track thousands of individual locks under heavy load.

### Page-Level Locks

Lock a page (typically 8KB block of rows). SQL Server sometimes uses this as an intermediate step.

**Tradeoff:** Less lock management overhead than row locks, but unrelated rows on the same page get blocked.

### Table-Level Locks

Lock the entire table. Used for DDL operations (ALTER TABLE) or explicitly requested.

```sql
LOCK TABLE accounts IN EXCLUSIVE MODE;
```

**Tradeoff:** Zero concurrency on that table, but zero overhead for lock tracking. Useful for bulk operations like data migrations.

### Lock Escalation

Some databases (SQL Server) automatically escalate from row locks to table locks when a transaction holds too many row locks (typically >5000). This reduces memory pressure but kills concurrency.

```
T1 updates 6000 rows individually
  → Database: "Too many row locks, escalating to table lock"
  → Every other transaction on this table is now blocked
```

PostgreSQL does not do lock escalation. MySQL InnoDB does not either. This is a SQL Server and DB2 behavior to be aware of.

## Explicit Locking in SQL

### SELECT ... FOR UPDATE

Acquires an exclusive lock on the selected rows. Other transactions that try to read these rows with `FOR UPDATE` or modify them will block.

```sql
BEGIN;
SELECT balance FROM accounts WHERE id = 1 FOR UPDATE;
-- Row is now exclusively locked
-- Do application logic...
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
COMMIT;
-- Lock released
```

This is the workhorse of pessimistic concurrency control. You lock the row before reading it, guaranteeing nobody else can change it while you compute.

### SELECT ... FOR SHARE

Acquires a shared lock. Other transactions can also `FOR SHARE` the same rows, but nobody can `FOR UPDATE` or modify them.

```sql
BEGIN;
SELECT balance FROM accounts WHERE id = 1 FOR SHARE;
-- Other transactions can also FOR SHARE this row
-- But nobody can UPDATE it until we commit
COMMIT;
```

Useful when you need to ensure a referenced row doesn't change (e.g., verifying a foreign key target exists and won't be deleted).

### NOWAIT and SKIP LOCKED

Two modifiers that change blocking behavior:

```sql
-- NOWAIT: fail immediately instead of waiting
SELECT * FROM tasks WHERE status = 'pending'
  FOR UPDATE NOWAIT;
-- Throws an error if any row is already locked

-- SKIP LOCKED: skip locked rows, return only unlocked ones
SELECT * FROM tasks WHERE status = 'pending'
  LIMIT 1
  FOR UPDATE SKIP LOCKED;
-- Returns the first unlocked pending task
```

`SKIP LOCKED` is powerful for implementing work queues directly in the database. Multiple workers can each grab a different unlocked task without blocking each other.

```
Worker 1: SELECT ... LIMIT 1 FOR UPDATE SKIP LOCKED → gets task A
Worker 2: SELECT ... LIMIT 1 FOR UPDATE SKIP LOCKED → gets task B (skips locked A)
Worker 3: SELECT ... LIMIT 1 FOR UPDATE SKIP LOCKED → gets task C (skips locked A, B)
```

## Deadlocks

The inevitable consequence of locking: two transactions each hold a lock the other needs.

```
T1: LOCK row A          T2: LOCK row B
T1: try LOCK row B ←──→ T2: try LOCK row A
         ↓                        ↓
      BLOCKED                  BLOCKED
         └──── DEADLOCK ────────┘
```

### Detection

Databases maintain a **wait-for graph**. When a cycle is detected, one transaction is chosen as the victim and aborted.

```
Wait-for graph:
  T1 → waits for → T2
  T2 → waits for → T1
  Cycle detected → abort T1 (or T2, depending on policy)
```

PostgreSQL detects deadlocks by checking the wait-for graph periodically (default: every 1 second, configurable via `deadlock_timeout`). MySQL InnoDB checks immediately when a lock wait occurs.

### Prevention

**Consistent lock ordering.** If every transaction that needs rows A and B always locks A first, then B, deadlocks between those rows are impossible.

```sql
-- GOOD: always lock lower ID first
BEGIN;
SELECT * FROM accounts WHERE id = 1 FOR UPDATE;
SELECT * FROM accounts WHERE id = 2 FOR UPDATE;
-- process transfer
COMMIT;

-- BAD: inconsistent ordering across transactions
-- T1 locks id=1 then id=2, T2 locks id=2 then id=1 → deadlock possible
```

**Lock timeouts.** Set `lock_timeout` so transactions don't wait forever.

```sql
SET lock_timeout = '5s';
-- Any lock wait longer than 5 seconds throws an error
```

## MVCC vs. Locking

Modern databases use MVCC (Multi-Version Concurrency Control) to reduce locking. The key insight: **readers don't need locks if they can read from a snapshot.**

### Pure Locking (old approach)

```
T1: SHARED LOCK → read row
T2: EXCLUSIVE LOCK → BLOCKED (waiting for T1's shared lock)
-- Readers block writers, writers block readers
```

### MVCC (modern approach)

```
T1: read row (version 1 from snapshot, no lock needed)
T2: write row (creates version 2, acquires exclusive lock on current version)
-- T1 continues reading version 1, T2 writes version 2
-- No blocking between reader and writer
```

MVCC doesn't eliminate locking entirely. Writers still lock against other writers. But the massive win is that readers never block writers and writers never block readers.

| Operation | Pure Locking | MVCC |
|-----------|-------------|------|
| Read vs Read | Both get shared locks (compatible) | No locks needed |
| Read vs Write | Reader blocks writer (or vice versa) | No blocking |
| Write vs Write | Exclusive lock conflict — one waits | Exclusive lock conflict — one waits |

## Advisory Locks

PostgreSQL offers **advisory locks** — application-level locks managed by the database but not tied to any table or row.

```sql
-- Acquire advisory lock (blocks if already held)
SELECT pg_advisory_lock(12345);

-- Do work that needs mutual exclusion...

-- Release
SELECT pg_advisory_unlock(12345);
```

Use cases:
- Coordinating cron jobs across multiple app servers (only one should run)
- Implementing distributed locks without Redis
- Protecting application-level resources that don't map to a single row

```sql
-- Try to acquire without blocking
SELECT pg_try_advisory_lock(12345);
-- Returns true if acquired, false if already held
```

Advisory locks are session-level by default (released when the connection closes) or transaction-level (`pg_advisory_xact_lock`, released at COMMIT/ROLLBACK).

## Lock Monitoring

When your application slows down, locks are often the culprit.

### PostgreSQL

```sql
-- See current locks and what's waiting
SELECT pid, relation::regclass, mode, granted
FROM pg_locks
WHERE NOT granted;

-- See blocked queries and what's blocking them
SELECT blocked.pid AS blocked_pid,
       blocked.query AS blocked_query,
       blocking.pid AS blocking_pid,
       blocking.query AS blocking_query
FROM pg_stat_activity blocked
JOIN pg_locks bl ON bl.pid = blocked.pid AND NOT bl.granted
JOIN pg_locks kl ON kl.relation = bl.relation AND kl.granted
JOIN pg_stat_activity blocking ON blocking.pid = kl.pid;
```

### MySQL

```sql
-- InnoDB lock waits
SELECT * FROM information_schema.INNODB_LOCK_WAITS;

-- Current locks
SELECT * FROM performance_schema.data_locks;
```

## Concurrency Patterns Summary

| Pattern | Mechanism | Best For |
|---------|-----------|----------|
| MVCC snapshots | Read from snapshot, no read locks | High-read workloads |
| SELECT FOR UPDATE | Exclusive row lock before modify | Critical write paths |
| SELECT FOR SHARE | Shared row lock, prevent modification | Referential integrity checks |
| SKIP LOCKED | Skip locked rows | Work queue / task distribution |
| Advisory locks | Application-level mutual exclusion | Cross-row or cross-table coordination |
| Table locks | Lock entire table | Bulk operations, migrations |

## Interview Application

When discussing locking and concurrency in a system design interview:

"For the checkout flow, we use `SELECT ... FOR UPDATE` on the inventory row to prevent overselling. This acquires an exclusive lock, so concurrent checkouts for the same product serialize at the database level. The lock is held only for the duration of the transaction — we keep it short by doing validation before opening the transaction."

"For the task queue, we use `SELECT ... FOR UPDATE SKIP LOCKED` so multiple workers can pull tasks concurrently without blocking each other. Each worker grabs the next unlocked task, processes it, and commits. This gives us a simple, reliable work queue without needing a separate message broker."

"We rely on MVCC for read-heavy paths — product catalog reads, user profile lookups — so readers never block writers. We only use explicit locking on the write paths where correctness matters: balance transfers, inventory decrements, seat reservations."

"We prevent deadlocks by always locking resources in a consistent order — lower account ID first for transfers. And we set `lock_timeout` to 5 seconds so a stuck lock doesn't cascade into a system-wide outage."

---

## Related Articles

**Next in series:** [Pessimistic Locking Strategies](pessimistic-locking-strategies.md)

**Previous in series:** [Database Isolation Levels](database-isolation-levels.md)

**See also:**
- [Consensus Algorithms](../distributed-systems/consensus-algorithms.md) — distributed coordination parallels database locking
