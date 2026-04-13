# Optimistic Locking Patterns

Two engineers edit the same wiki page. Alice spends 20 minutes writing a new section. Bob fixes a typo in 30 seconds. Bob saves first. Alice saves second, and Bob's typo fix is silently overwritten. Alice never held a lock — she didn't even know Bob was editing.

Optimistic locking solves this without making anyone wait. Both editors work freely, but when Alice tries to save, the system detects that the page changed since she loaded it and rejects her save. She merges her changes and saves again.

## The Core Idea

Optimistic locking assumes conflicts are rare. Instead of locking resources upfront, you:

1. Read the data along with a **version indicator**
2. Do your work (no locks held)
3. At write time, check if the version changed
4. If unchanged → write succeeds
5. If changed → someone else modified it, your write is rejected

```
Optimistic approach:
  1. READ data + version (no lock)
  2. COMPUTE changes (no lock)
  3. WRITE only if version matches (atomic check-and-set)
  4. If version mismatch → retry or report conflict
```

No locks are held during steps 1 and 2. This means other transactions proceed without blocking. The cost is paid only when a conflict actually occurs — and the assumption is that conflicts are infrequent.

## Version Column Pattern

The most common implementation. Add a `version` column to the table.

```sql
CREATE TABLE products (
    id BIGINT PRIMARY KEY,
    name TEXT,
    price DECIMAL(10,2),
    quantity INT,
    version INT NOT NULL DEFAULT 0
);
```

### Read

```sql
SELECT id, name, price, quantity, version
FROM products WHERE id = 42;
-- Returns: id=42, name="Widget", price=29.99, quantity=100, version=3
```

### Write with Version Check

```sql
UPDATE products
SET price = 34.99, version = version + 1
WHERE id = 42 AND version = 3;
```

If the row still has `version = 3`, the update succeeds and bumps the version to 4. If another transaction already changed it (version is now 4 or higher), the WHERE clause matches zero rows. The application checks the affected row count:

```python
result = db.execute(
    "UPDATE products SET price = %s, version = version + 1 "
    "WHERE id = %s AND version = %s",
    (new_price, product_id, expected_version)
)
if result.rowcount == 0:
    raise OptimisticLockError("Product was modified by another transaction")
```

### Full Timeline

```
Time    Transaction A                    Transaction B
────    ─────────────                    ─────────────
T1      SELECT ... → version=3
T2                                       SELECT ... → version=3
T3      UPDATE ... WHERE version=3
        → 1 row affected, version→4
T4                                       UPDATE ... WHERE version=3
                                         → 0 rows affected (version is now 4)
                                         → CONFLICT DETECTED
```

No locks. No blocking. Transaction B simply fails and can retry with the fresh data.

## Timestamp Column Pattern

Instead of an integer version, use a timestamp.

```sql
CREATE TABLE documents (
    id BIGINT PRIMARY KEY,
    content TEXT,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

```sql
UPDATE documents
SET content = 'new content', updated_at = NOW()
WHERE id = 1 AND updated_at = '2026-04-12 10:30:00.000';
```

**Tradeoff vs. version column:**
- Timestamps give you "when was it last modified" for free
- But timestamp precision can cause issues — two updates within the same millisecond may get the same timestamp, making the conflict check unreliable
- Integer versions are monotonically increasing and never collide

**Recommendation:** Use integer versions for correctness. Add a `updated_at` column separately if you need the timestamp for display purposes.

## Hash-Based Conflict Detection

Instead of a version column, compute a hash of the row's contents and compare at write time.

```python
# Read
row = db.query("SELECT * FROM products WHERE id = 42")
original_hash = hashlib.sha256(serialize(row)).hexdigest()

# ... do work ...

# Write
current_row = db.query("SELECT * FROM products WHERE id = 42")
current_hash = hashlib.sha256(serialize(current_row)).hexdigest()

if current_hash != original_hash:
    raise OptimisticLockError("Row changed")

db.execute("UPDATE products SET price = %s WHERE id = 42", new_price)
```

**Tradeoff:** No schema change needed (no version column), but the check-and-write is not atomic unless wrapped in a transaction with `SELECT FOR UPDATE` — which defeats the purpose. This pattern is mostly useful at the application layer (e.g., HTTP ETags) rather than the database layer.

## Conditional Writes (Compare-and-Swap)

Some systems support atomic conditional writes natively.

### DynamoDB

```python
table.update_item(
    Key={'id': '42'},
    UpdateExpression='SET price = :new_price, version = version + :inc',
    ConditionExpression='version = :expected_version',
    ExpressionAttributeValues={
        ':new_price': 34.99,
        ':expected_version': 3,
        ':inc': 1
    }
)
# Throws ConditionalCheckFailedException if version != 3
```

### Redis (WATCH/MULTI)

```
WATCH product:42:version
version = GET product:42:version
MULTI
SET product:42:price 34.99
INCR product:42:version
EXEC
# Returns nil if product:42:version changed between WATCH and EXEC
```

### PostgreSQL (single atomic UPDATE)

The `UPDATE ... WHERE version = N` pattern is already atomic in PostgreSQL. The database handles the check-and-set within a single statement. No explicit CAS instruction needed.

## Retry Strategies

When an optimistic lock conflict occurs, the application must decide what to do.

### Simple Retry

Re-read the data, re-apply the change, try again.

```python
MAX_RETRIES = 3

for attempt in range(MAX_RETRIES):
    product = db.query("SELECT * FROM products WHERE id = 42")
    new_price = compute_new_price(product)

    updated = db.execute(
        "UPDATE products SET price = %s, version = version + 1 "
        "WHERE id = 42 AND version = %s",
        (new_price, product.version)
    )
    if updated.rowcount == 1:
        break  # success
    if attempt == MAX_RETRIES - 1:
        raise ConflictError("Too many conflicts")
    # else: loop and retry with fresh data
```

### Merge Strategy

For document editing or collaborative systems, don't just retry — merge the changes.

```python
# Alice's change: added paragraph to section 2
# Bob's change: fixed typo in section 1
# These don't conflict — auto-merge is possible

original = load_version(doc_id, original_version)
current = load_current(doc_id)
mine = alice_changes

merged = three_way_merge(original, current, mine)
if merged.has_conflicts:
    return show_conflict_resolution_ui(merged)
else:
    save(doc_id, merged, current.version)
```

### Exponential Backoff

When conflicts are caused by high concurrency (not logical conflicts), add jitter and backoff.

```python
for attempt in range(MAX_RETRIES):
    try:
        optimistic_update(product_id, new_price)
        break
    except OptimisticLockError:
        if attempt == MAX_RETRIES - 1:
            raise
        sleep_ms = min(100 * (2 ** attempt), 2000) + random.randint(0, 50)
        time.sleep(sleep_ms / 1000)
```

## ORM Support

Most ORMs have built-in optimistic locking.

### JPA / Hibernate

```java
@Entity
public class Product {
    @Id
    private Long id;

    @Version
    private Integer version;  // Hibernate auto-manages this

    private BigDecimal price;
}

// Hibernate automatically adds "WHERE version = ?" to UPDATE statements
// Throws OptimisticLockException on conflict
```

### Django

```python
# Django doesn't have built-in optimistic locking, but the pattern is simple:
updated = Product.objects.filter(id=42, version=3).update(
    price=34.99,
    version=F('version') + 1
)
if updated == 0:
    raise ConflictError()
```

### SQLAlchemy

```python
from sqlalchemy.orm import configure_mappers
from sqlalchemy import Column, Integer

class Product(Base):
    __tablename__ = 'products'
    id = Column(Integer, primary_key=True)
    version_id = Column(Integer, nullable=False)
    __mapper_args__ = {"version_id_col": version_id}

# SQLAlchemy auto-checks version on flush
# Raises StaleDataError on conflict
```

## Optimistic vs. Pessimistic: Decision Framework

| Factor | Optimistic | Pessimistic |
|--------|-----------|-------------|
| Conflict frequency | Low (< 1% of operations) | High |
| Read-to-write ratio | High (many reads, few writes) | Low (most reads lead to writes) |
| Lock hold time | N/A (no locks) | Must be short |
| Throughput | Higher (no blocking) | Lower (serialization) |
| Failure mode | Retry on conflict | Wait on lock |
| Complexity | Retry logic in application | Lock ordering, deadlock handling |
| User experience | "Someone else edited this" | "Please wait..." |

**Use optimistic when:** Conflicts are rare, operations are long (user editing a document), or you can't hold database connections open (HTTP request-response cycle).

**Use pessimistic when:** Conflicts are frequent, operations are short (inventory decrement), or the cost of a conflict is high (financial transactions).

## Anti-Patterns

### Forgetting to Check Row Count

```python
# BUG: doesn't check if the update actually happened
db.execute(
    "UPDATE products SET price = %s, version = version + 1 WHERE id = %s AND version = %s",
    (new_price, product_id, expected_version)
)
# If version mismatched, 0 rows updated, but code continues as if it succeeded
```

### Version Check Without Atomic Update

```python
# BUG: race condition between SELECT and UPDATE
current = db.query("SELECT version FROM products WHERE id = 42")
if current.version == expected_version:
    # Another transaction can change the version RIGHT HERE
    db.execute("UPDATE products SET price = %s WHERE id = 42", new_price)
```

The version check and the update must be in the same SQL statement (or within a `SELECT FOR UPDATE` transaction, which makes it pessimistic).

### Infinite Retry Loops

```python
# BUG: under high contention, this never terminates
while True:
    try:
        optimistic_update(product_id, new_price)
        break
    except OptimisticLockError:
        continue  # no backoff, no retry limit
```

Always cap retries and add backoff.

## Interview Application

When discussing optimistic locking in a system design interview:

"For the document editing service, I'd use optimistic locking with a version column. Users can edit concurrently without blocking each other. When a user saves, we check the version — if it changed, we show a conflict resolution UI. Since most edits are to different documents, conflict rates are low and optimistic locking gives us much better throughput than pessimistic."

"For the product catalog update API, we include the version in the ETag header. The client sends `If-Match: version-3` on update requests. The server does `UPDATE ... WHERE version = 3`. If it returns 0 rows, we respond with HTTP 409 Conflict. The client re-fetches and retries."

"The key tradeoff: optimistic locking moves complexity from the database (lock management) to the application (retry logic). For our workload with 99%+ non-conflicting writes, this is the right call. If we had a hot row with high contention — like a global counter — we'd switch to pessimistic locking or a sharded counter."

---

## Related Articles

**Next in series:** [Flash Sale Inventory Patterns](flash-sale-inventory-patterns.md)

**Previous in series:** [Pessimistic Locking Strategies](pessimistic-locking-strategies.md)

**See also:**
- [Pessimistic Locking Strategies](pessimistic-locking-strategies.md) — the alternative approach to concurrency control
