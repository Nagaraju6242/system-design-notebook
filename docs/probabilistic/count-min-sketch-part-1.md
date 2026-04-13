# Introduction to Count-Min Sketch

You're building a real-time analytics dashboard for a search engine. You need to show the top 10 trending search queries over the last hour. The system processes 500,000 queries per second. Storing an exact count for every unique query string would require a HashMap with hundreds of millions of entries — gigabytes of memory that grows unboundedly as new queries appear.

You don't need exact counts. You need to know that "election results" was searched approximately 2.3 million times, not that it was searched exactly 2,314,587 times. The dashboard rounds to "2.3M" anyway.

The Count-Min Sketch (CMS) gives you approximate frequency counts for any element in a data stream, using fixed memory regardless of how many distinct elements pass through.

## How It Works

A Count-Min Sketch is a 2D array of counters with d rows and w columns, paired with d independent hash functions (one per row).

```
         col 0   col 1   col 2   col 3   col 4   col 5   col 6
row 0  [   0       0       0       0       0       0       0   ]  ← h₀
row 1  [   0       0       0       0       0       0       0   ]  ← h₁
row 2  [   0       0       0       0       0       0       0   ]  ← h₂
```

### Increment (Update)

To record an occurrence of element x, hash it with each of the d hash functions and increment the corresponding cell in each row.

```
Increment "cat":
  h₀("cat") = 2  →  table[0][2] += 1
  h₁("cat") = 5  →  table[1][5] += 1
  h₂("cat") = 1  →  table[2][1] += 1

         col 0   col 1   col 2   col 3   col 4   col 5   col 6
row 0  [   0       0       1       0       0       0       0   ]
row 1  [   0       0       0       0       0       1       0   ]
row 2  [   0       1       0       0       0       0       0   ]
```

Now increment "dog" and "cat" again:

```
Increment "dog":
  h₀("dog") = 5  →  table[0][5] += 1
  h₁("dog") = 1  →  table[1][1] += 1
  h₂("dog") = 1  →  table[2][1] += 1    ← collision with "cat" in row 2!

Increment "cat" (second time):
  h₀("cat") = 2  →  table[0][2] += 1
  h₁("cat") = 5  →  table[1][5] += 1    ← collision with "dog" in row 1... no!
                                            "dog" hashed to col 1 in row 1, not col 5
  h₂("cat") = 1  →  table[2][1] += 1

         col 0   col 1   col 2   col 3   col 4   col 5   col 6
row 0  [   0       0       2       0       0       1       0   ]
row 1  [   0       1       0       0       0       2       0   ]
row 2  [   0       3       0       0       0       0       0   ]
```

### Query (Estimate)

To estimate the count of element x, hash it with each function and take the **minimum** across all rows.

```
Query "cat":
  table[0][h₀("cat")] = table[0][2] = 2
  table[1][h₁("cat")] = table[1][5] = 2
  table[2][h₂("cat")] = table[2][1] = 3   ← inflated by "dog" collision

  estimate = min(2, 2, 3) = 2  ✓  (true count is 2)

Query "dog":
  table[0][h₀("dog")] = table[0][5] = 1
  table[1][h₁("dog")] = table[1][1] = 1
  table[2][h₂("dog")] = table[2][1] = 3   ← inflated by "cat" collision

  estimate = min(1, 1, 3) = 1  ✓  (true count is 1)
```

### Why Minimum?

Collisions can only **add** to a counter, never subtract. So every cell's value is ≥ the true count of any element that hashes to it. Taking the minimum across d independent hash functions gives you the cell least affected by collisions — the tightest upper bound.

```
True count of "cat" = 2

Row 0: counter = 2  (no collision → exact)
Row 1: counter = 2  (no collision → exact)
Row 2: counter = 3  (collision with "dog" → inflated)

min(2, 2, 3) = 2 = true count
```

The CMS **never undercounts**. It can only overcount, and the minimum operation minimizes the overcounting.

## The Math

### Error Guarantees

The CMS provides a probabilistic guarantee on the estimation error:

```
P(estimate(x) - true_count(x) ≤ ε × N) ≥ 1 - δ
```

Where:
- ε (epsilon) = error factor — how much overcounting you'll tolerate, relative to total stream size N
- δ (delta) = failure probability — how often the estimate exceeds the error bound
- N = total number of increments across all elements

### Sizing

The dimensions of the table are determined by ε and δ:

```
w (columns) = ⌈e/ε⌉     ≈ 2.72/ε
d (rows)    = ⌈ln(1/δ)⌉
```

Where e ≈ 2.718 (Euler's number).

Practical examples:

| Error (ε) | Failure Prob (δ) | Columns (w) | Rows (d) | Memory |
|-----------|-----------------|-------------|---------|--------|
| 0.01 | 0.01 | 272 | 5 | 5.4 KB |
| 0.001 | 0.01 | 2,720 | 5 | 54 KB |
| 0.0001 | 0.001 | 27,200 | 7 | 762 KB |
| 0.001 | 0.0001 | 2,720 | 10 | 109 KB |

The memory is **fixed** — it doesn't grow with the number of distinct elements. Whether you're tracking 1,000 or 1 billion distinct search queries, the sketch stays the same size.

### Interpreting the Error Bound

The bound `ε × N` is relative to the **total stream size**, not the element's true count. This matters:

```
Stream of N = 1,000,000 events, ε = 0.001

Error bound = 0.001 × 1,000,000 = 1,000

For a popular query with true count 500,000:
  Estimate: 500,000 to 501,000  →  0.2% relative error (great!)

For a rare query with true count 10:
  Estimate: 10 to 1,010  →  10,000% relative error (terrible!)
```

CMS is most accurate for **heavy hitters** — elements with high true counts. For rare elements, the absolute error bound can dwarf the true count. This is a fundamental characteristic, not a bug.

## Implementation

```python
import mmh3
import math

class CountMinSketch:
    def __init__(self, epsilon: float = 0.001, delta: float = 0.01):
        self.w = math.ceil(math.e / epsilon)
        self.d = math.ceil(math.log(1 / delta))
        self.table = [[0] * self.w for _ in range(self.d)]

    def update(self, item: str, count: int = 1):
        for i in range(self.d):
            j = mmh3.hash(item, i) % self.w
            self.table[i][j] += count

    def estimate(self, item: str) -> int:
        return min(
            self.table[i][mmh3.hash(item, i) % self.w]
            for i in range(self.d)
        )
```

That's the entire data structure. The simplicity is part of its appeal — there's almost nothing to get wrong in production.

## CMS vs. HashMap — The Tradeoff

| Property | HashMap | Count-Min Sketch |
|----------|---------|-----------------|
| Memory | O(n) — grows with distinct elements | O(1) — fixed by ε and δ |
| Accuracy | Exact | Approximate (overcounts) |
| Deletion | Yes | Not standard (but possible with negative counts) |
| Enumeration | Yes (iterate keys) | No |
| Merge | Complex | Trivial (cell-wise addition) |
| Stream-friendly | No (unbounded growth) | Yes (fixed memory) |

The crossover point: when the number of distinct elements exceeds what fits in memory, or when you need to merge counts across distributed nodes.

## Handling Negative Counts: Conservative Update

The standard CMS always overcounts. The **Conservative Update** optimization reduces overcounting:

Instead of incrementing all d cells, only increment cells whose current value equals the current minimum estimate.

```
Standard update for "cat" (current estimate = 5):
  Row 0: counter = 5  → increment to 6
  Row 1: counter = 8  → increment to 9  (already inflated, now more inflated)
  Row 2: counter = 5  → increment to 6

Conservative update for "cat" (current estimate = 5):
  Row 0: counter = 5  → increment to 6  (equals min, so update)
  Row 1: counter = 8  → leave at 8      (above min, skip)
  Row 2: counter = 5  → increment to 6  (equals min, so update)
```

Conservative update doesn't change the worst-case guarantees, but significantly reduces overcounting in practice. The implementation cost is one extra read per update (to compute the current minimum before deciding which cells to increment).

## Real-World Use Cases

### Network Traffic Monitoring

Track byte counts per source IP across a high-speed network link. At 10 Gbps, millions of packets per second flow through. A CMS identifies heavy hitters (IPs sending the most traffic) without storing per-IP state.

### Database Query Optimization

PostgreSQL and other databases use frequency sketches to estimate the selectivity of query predicates. "How many rows have `status = 'active'`?" An approximate answer is sufficient for the query planner to choose between a sequential scan and an index scan.

### Rate Limiting

Track request counts per API key over a time window. A CMS with a sliding window (or multiple sketches for time buckets) provides approximate rate limiting in fixed memory. The overcounting property means you might rate-limit slightly early — a safe direction for protecting your service.

### Trending Detection

Maintain two CMS instances: one for the current time window, one for the previous. The difference in estimates reveals which elements are increasing in frequency — trending items.

## Interview Application

Count-Min Sketch appears in interviews around frequency counting at scale. Here's how to use it:

**Trigger phrases:**
- "Find the top K most frequent items in a stream"
- "Track how many times each X appears"
- "Rate limiting across millions of keys"
- "The stream is too large to store in memory"

**How to introduce it:**

> "For tracking query frequencies, I'd use a Count-Min Sketch. It gives us approximate counts in fixed memory — about 54 KB for a 0.1% error rate. We process each query by hashing it into d rows and incrementing counters. To get the count, we take the minimum across rows. It only overcounts, never undercounts, which is safe for our use case."

**For the Top-K problem specifically:**

> "I'd combine a Count-Min Sketch with a min-heap of size K. For each incoming element, estimate its count from the CMS, then check if it belongs in the heap. The CMS handles the frequency tracking in fixed memory, and the heap maintains the current top K. Total memory: CMS size + K entries."

**Key points to hit:**
- Fixed memory regardless of cardinality
- Only overcounts, never undercounts
- Most accurate for heavy hitters, least accurate for rare items
- Trivially mergeable across distributed nodes (cell-wise addition)
- The error bound is relative to total stream size, not per-element count

**Common mistake:** Don't claim CMS gives you exact counts. Be explicit about the overcounting property and explain why it's acceptable for the use case at hand.

---

## Related Articles

**Next in series:** [Count-Min Sketch Applications](count-min-sketch-part-2.md)

**Previous in series:** [Advanced Techniques with Bloom Filters](bloom-filters-part-2.md)

**See also:**
- [Failure Handling Patterns](../distributed-systems/failure-handling-patterns.md) — rate limiting