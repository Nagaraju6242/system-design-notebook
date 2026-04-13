# Database Isolation Levels

Two users simultaneously buy the last concert ticket. Both read `available = 1`, both decrement it, both get a confirmation email. The venue now has -1 tickets and two angry customers at the door.

This is a **concurrency anomaly** — and isolation levels are how databases let you choose which anomalies you're willing to tolerate. Higher isolation means fewer surprises but worse throughput. Lower isolation means faster queries but data you can't fully trust mid-transaction.

## The Problem: Concurrent Access

When a single transaction runs against a database, everything is simple. The complexity explodes when multiple transactions run simultaneously and touch the same data.

```
Transaction A                    Transaction B
─────────────                    ─────────────
BEGIN                            BEGIN
READ balance → 1000
                                 READ balance → 1000
UPDATE balance = 500
                                 UPDATE balance = 700
COMMIT
                                 COMMIT
-- Final balance: 700 (A's write is lost)
```

This is a **lost update**. Both transactions read the same starting value, computed independently, and the last writer won. Transaction A's deduction vanished.

Databases prevent these problems through isolation — but full isolation (serializable) is expensive. So the SQL standard defines four levels, each permitting a specific set of anomalies.

## The Three Anomalies

Before understanding the levels, you need to understand what they protect against.

### Dirty Read

Reading uncommitted data from another transaction.

```
Transaction A                    Transaction B
─────────────                    ─────────────
BEGIN                            BEGIN
UPDATE balance = 500
                                 READ balance → 500  ← dirty read
ROLLBACK
                                 -- B now has a value that never existed
```

Transaction B made a decision based on data that was rolled back. In a financial system, this could mean approving a loan based on a balance that was never real.

### Non-Repeatable Read

Reading the same row twice within a transaction and getting different values because another transaction modified and committed it in between.

```
Transaction A                    Transaction B
─────────────                    ─────────────
BEGIN
READ balance → 1000
                                 BEGIN
                                 UPDATE balance = 500
                                 COMMIT
READ balance → 500  ← different!
COMMIT
```

If Transaction A is generating a report that reads the same account twice, the numbers won't add up.

### Phantom Read

Running the same query twice and getting different rows because another transaction inserted or deleted rows that match the query's WHERE clause.

```
Transaction A                    Transaction B
─────────────                    ─────────────
BEGIN
SELECT COUNT(*) FROM orders
  WHERE status = 'pending' → 5
                                 BEGIN
                                 INSERT INTO orders (status)
                                   VALUES ('pending')
                                 COMMIT
SELECT COUNT(*) FROM orders
  WHERE status = 'pending' → 6  ← phantom row
COMMIT
```

The individual rows A read didn't change — a new row appeared. This is subtly different from a non-repeatable read.

## The Four Isolation Levels

### Read Uncommitted

The lowest level. Transactions can see uncommitted changes from other transactions.

```sql
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;
```

| Anomaly | Permitted? |
|---------|-----------|
| Dirty Read | Yes |
| Non-Repeatable Read | Yes |
| Phantom Read | Yes |

**When to use:** Almost never. Some analytics workloads use it to get approximate counts without blocking writers. PostgreSQL doesn't even implement it — `READ UNCOMMITTED` behaves as `READ COMMITTED`.

**Tradeoff:** Maximum throughput, zero data trust.

### Read Committed

A transaction only sees data that has been committed. This is the default in PostgreSQL and Oracle.

```sql
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
```

| Anomaly | Permitted? |
|---------|-----------|
| Dirty Read | No |
| Non-Repeatable Read | Yes |
| Phantom Read | Yes |

**How it works:** Each SQL statement sees a snapshot of the database as of the moment that statement begins executing. If another transaction commits between two of your statements, the second statement sees the new data.

```sql
-- Transaction A (Read Committed)
BEGIN;
SELECT balance FROM accounts WHERE id = 1;  -- sees 1000
-- Transaction B commits: UPDATE balance = 500 WHERE id = 1
SELECT balance FROM accounts WHERE id = 1;  -- sees 500 (new commit visible)
COMMIT;
```

**When to use:** General-purpose OLTP workloads. Good enough for most web applications where individual statements need accurate data but you don't need a consistent snapshot across multiple statements.

**Tradeoff:** No dirty reads, but your transaction can see the world change between statements.

### Repeatable Read

Once a transaction reads a row, it sees the same value for that row for the entire transaction, even if other transactions modify and commit it.

```sql
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
```

| Anomaly | Permitted? |
|---------|-----------|
| Dirty Read | No |
| Non-Repeatable Read | No |
| Phantom Read | Yes (SQL standard) / No (PostgreSQL, MySQL InnoDB) |

**How it works:** The transaction sees a snapshot of the database as of the moment the transaction began (not each statement). All reads within the transaction see this same snapshot.

```sql
-- Transaction A (Repeatable Read)
BEGIN;
SELECT balance FROM accounts WHERE id = 1;  -- sees 1000
-- Transaction B commits: UPDATE balance = 500 WHERE id = 1
SELECT balance FROM accounts WHERE id = 1;  -- still sees 1000 (snapshot)
COMMIT;
```

**Important nuance:** The SQL standard says Repeatable Read permits phantom reads. But PostgreSQL and MySQL InnoDB use MVCC-based snapshot isolation, which also prevents phantoms at this level. This means their Repeatable Read is stronger than the standard requires.

**When to use:** Report generation, any workflow that reads the same data multiple times and needs consistency. MySQL InnoDB uses this as its default.

**Tradeoff:** Consistent reads, but write conflicts are possible. Two transactions can read the same row, both try to update it, and one must be aborted (serialization failure).

### Serializable

The strongest level. Transactions behave as if they executed one at a time, in some serial order.

```sql
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
```

| Anomaly | Permitted? |
|---------|-----------|
| Dirty Read | No |
| Non-Repeatable Read | No |
| Phantom Read | No |

**How it works:** Depends on the database.

- **PostgreSQL:** Uses Serializable Snapshot Isolation (SSI). Transactions run on snapshots (like Repeatable Read) but the database tracks read/write dependencies. At commit time, it checks for cycles in the dependency graph. If a cycle exists, one transaction is aborted.
- **MySQL InnoDB:** Uses gap locks and next-key locks to physically prevent other transactions from inserting or modifying conflicting rows. This means transactions actually block each other.

```
PostgreSQL SSI approach:
  Optimistic — let transactions run, detect conflicts at commit
  → Higher throughput when conflicts are rare
  → Aborts increase under contention

MySQL gap locking approach:
  Pessimistic — block conflicting operations immediately
  → Lower throughput (more waiting)
  → Fewer aborts (conflicts prevented, not detected)
```

**When to use:** Financial systems, inventory management, anywhere correctness is non-negotiable and you can tolerate reduced throughput.

**Tradeoff:** Correctness guaranteed, but significant performance cost. Your application must handle serialization failures with retry logic.

## How MVCC Implements Isolation

Most modern databases use Multi-Version Concurrency Control (MVCC) rather than pure locking. Understanding MVCC clarifies why isolation levels behave the way they do.

Each row has a creation timestamp (or transaction ID) and a deletion timestamp. When a row is updated, the database creates a new version and marks the old version as deleted.

```
Row: account_id=1

Version 1: balance=1000, created_by=txn_100, deleted_by=txn_150
Version 2: balance=500,  created_by=txn_150, deleted_by=NULL (current)
```

When a transaction reads, it applies visibility rules based on its isolation level:

- **Read Committed:** See the latest version committed before the current statement started.
- **Repeatable Read:** See the latest version committed before the transaction started.
- **Serializable:** Same snapshot as Repeatable Read, plus dependency tracking.

This is why readers don't block writers in PostgreSQL and MySQL. Each transaction reads from its own consistent snapshot while writers create new versions.

## Choosing the Right Level

| Scenario | Recommended Level | Why |
|----------|------------------|-----|
| Web app reading user profiles | Read Committed | Stale reads are harmless |
| Financial transfer between accounts | Serializable | Lost updates are unacceptable |
| Report generation across tables | Repeatable Read | Need consistent snapshot |
| Analytics dashboard (approximate) | Read Committed | Speed over precision |
| Inventory decrement (e-commerce) | Serializable or explicit locking | Must not oversell |

The default (Read Committed in PostgreSQL, Repeatable Read in MySQL) is correct for most workloads. Escalate to Serializable only for operations where anomalies cause real business damage.

## Common Mistakes

**Assuming Repeatable Read prevents all anomalies.** The SQL standard allows phantom reads at this level. PostgreSQL and MySQL happen to prevent them, but this is implementation-specific. Don't rely on it if you might switch databases.

**Using Serializable everywhere.** It's tempting to set it globally for "safety." In practice, this tanks throughput and increases abort rates. Use it surgically for specific critical transactions.

**Ignoring serialization failures.** At Repeatable Read and Serializable, the database will abort transactions that conflict. Your application must catch these errors and retry. If you don't retry, you've just made your system less reliable than Read Committed.

```python
# Required pattern for Serializable transactions
for attempt in range(3):
    try:
        with db.transaction(isolation='serializable'):
            balance = db.query("SELECT balance FROM accounts WHERE id = 1")
            db.execute("UPDATE accounts SET balance = %s WHERE id = 1", balance - 100)
            break
    except SerializationError:
        if attempt == 2:
            raise
        continue
```

**Confusing isolation with locking.** Isolation levels define what anomalies are permitted. Locking is one mechanism to enforce them. MVCC is another. You can have strong isolation without heavy locking (PostgreSQL's SSI), and you can have locking without strong isolation (MySQL's Read Committed still uses row locks for writes).

## Interview Application

When isolation levels come up in a system design interview, show that you understand the tradeoff spectrum:

"For the payment service, I'd use Serializable isolation for the actual balance transfer — we can't tolerate lost updates or phantom reads when moving money. But for the transaction history query, Read Committed is fine since we're just displaying data and a slightly stale read won't cause harm."

"PostgreSQL's Serializable uses SSI — it's optimistic, so transactions run concurrently on snapshots and conflicts are detected at commit time. This means we need retry logic in the application layer. Under low contention this performs well, but if many transactions touch the same rows, abort rates climb and we might consider explicit pessimistic locking instead."

"The key insight is that isolation levels are a dial, not a switch. We don't set one level for the whole database — we choose per-transaction based on what anomalies that specific operation can tolerate. Most of our reads use Read Committed. Only the critical write paths use Serializable."

---

## Related Articles

**Next in series:** [Database Locking & Concurrency](database-locking-and-concurrency.md)

**Previous in series:** [Database Transactions](database-transactions.md)

**See also:**
- [Consistency Models](../distributed-systems/consistency-models.md) — distributed consistency parallels isolation levels
