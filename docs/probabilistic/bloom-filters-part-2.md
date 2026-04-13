# Advanced Techniques with Bloom Filters

Your web crawler's Bloom filter is working well — until it isn't. After six months, you've crawled 5 billion URLs, but the filter was sized for 1 billion. The false positive rate has ballooned from 1% to over 30%. You're skipping nearly a third of new URLs because the filter incorrectly claims they've been seen.

You can't just resize a Bloom filter. The hash positions depend on the array size — changing m invalidates every existing entry. You'd need to re-insert every element, but you can't enumerate what's in the filter.

Standard Bloom filters also can't delete elements. When a page is removed from the web, it stays in your filter forever, wasting capacity. These limitations drive the need for advanced variants.

## Counting Bloom Filters

The deletion problem has a clean solution: replace each bit with a counter.

### How It Works

Instead of a bit array, use an array of counters (typically 4-bit counters). Insertion increments the counters at the k hash positions. Deletion decrements them. A query checks if all k positions have a count > 0.

```
Standard Bloom:   [0  1  0  1  1  0  0  1]   ← bits (0 or 1)
Counting Bloom:   [0  2  0  1  3  0  0  1]   ← counters (0 to 15)

Insert "cat" → positions [1, 4, 7]:
                  [0  3  0  1  4  0  0  2]

Delete "dog" → positions [1, 3, 4]:
                  [0  2  0  0  3  0  0  2]

Query "dog":
  counter[1]=2, counter[3]=0  →  0 found  →  "Definitely not in set" ✓
```

### Counter Overflow

With 4-bit counters, the maximum value is 15. If a counter reaches 15, it stays at 15 (saturates) — it never wraps around to 0. This means:

- A saturated counter can never be decremented to 0 by deletions
- This prevents false negatives but means the counter is permanently "stuck"
- In practice, counter overflow is extremely rare with 4-bit counters

The probability of any counter exceeding 15 is negligible for reasonable load factors. Pagh et al. showed that with optimal k, the probability is less than 1.37 × 10^-15 per counter.

### Memory Cost

4-bit counters use 4x the memory of a standard Bloom filter. For many applications, this is acceptable. For others, it's a dealbreaker — and you should consider alternatives like Cuckoo filters.

```
Standard Bloom (1B elements, 1% FP):  ~1.14 GB
Counting Bloom (same parameters):     ~4.56 GB
```

### When to Use

Counting Bloom filters make sense when:
- Elements are added and removed over time (cache invalidation, session tracking)
- The 4x memory overhead is acceptable
- You need the same false positive guarantees as a standard Bloom filter

## Scalable Bloom Filters

Back to the crawler problem: you don't know how many URLs you'll encounter. Scalable Bloom Filters (SBF), proposed by Almeida et al., solve this by chaining multiple Bloom filters together.

### How It Works

Start with a single Bloom filter sized for an initial capacity. When it fills up, create a new filter with a tighter false positive rate and larger capacity. Queries check all filters in the chain.

```
Filter 0: capacity=1M,  fp_rate=0.5%    ← oldest, most full
Filter 1: capacity=2M,  fp_rate=0.25%   ← added when filter 0 filled
Filter 2: capacity=4M,  fp_rate=0.125%  ← added when filter 1 filled
                                          (currently active for inserts)

Insert: always goes to the newest filter
Query:  check all filters, return "yes" if ANY says yes
```

### False Positive Rate Control

The overall false positive rate is the union of individual rates. By making each successive filter's FP rate decrease geometrically (multiply by a tightening ratio r < 1), the total FP rate converges:

```
Total FP ≤ p₀ × (1/(1-r))

With p₀ = 0.5% and r = 0.5:
Total FP ≤ 0.5% × (1/(1-0.5)) = 1%
```

Each new filter is tighter, so the overall rate stays bounded even as you add more filters.

### Tradeoffs

- **Query cost increases** — you check every filter in the chain. With 10 filters, that's 10× the hash computations.
- **No deletion** — each sub-filter is a standard Bloom filter.
- **Memory isn't wasted** — each filter is appropriately sized for its slice of the data.

### Practical Tip

In practice, most systems avoid Scalable Bloom Filters by over-provisioning. If you expect 1 billion URLs, size for 2 billion. The extra memory is cheap compared to the complexity of managing a filter chain. SBFs are most useful when the cardinality is truly unpredictable.

## Cuckoo Filters

Cuckoo filters, introduced by Fan et al. in 2014, are a modern alternative that supports deletion, often uses less memory, and has better lookup performance than Bloom filters.

### How It Works

A Cuckoo filter stores **fingerprints** (short hashes) of elements in a hash table that uses cuckoo hashing for collision resolution.

```
Buckets (each holds up to b fingerprints):

Bucket 0: [f₁, f₂, __, __]
Bucket 1: [f₃, __, __, __]
Bucket 2: [f₄, f₅, f₆, __]
Bucket 3: [__, __, __, __]
...
```

Each element maps to two candidate buckets (computed from the fingerprint). Insertion places the fingerprint in either bucket. If both are full, an existing fingerprint is "kicked" to its alternate bucket — the cuckoo hashing mechanism.

```
Insert element x:
  fp = fingerprint(x)           # e.g., 8-bit hash
  b1 = hash(x) mod num_buckets
  b2 = b1 XOR hash(fp)          # alternate bucket

  if bucket[b1] has space → store fp in bucket[b1]
  elif bucket[b2] has space → store fp in bucket[b2]
  else → kick a random entry from b1 to its alternate bucket, store fp in b1
```

The XOR-based alternate bucket computation is the key trick — it means you can compute the alternate bucket from just the fingerprint and current bucket, without needing the original element.

### Deletion

Because Cuckoo filters store fingerprints (not just bits), deletion is straightforward: find the fingerprint in one of the two candidate buckets and remove it.

```
Delete element x:
  fp = fingerprint(x)
  b1 = hash(x) mod num_buckets
  b2 = b1 XOR hash(fp)

  if fp in bucket[b1] → remove it
  elif fp in bucket[b2] → remove it
  else → element wasn't in the filter
```

Caveat: if you insert the same element twice, you must delete it twice. Deleting an element that was never inserted can cause false negatives (you might remove a fingerprint belonging to a different element with the same fingerprint).

### Cuckoo vs. Bloom — Comparison

| Property | Bloom Filter | Cuckoo Filter |
|----------|-------------|---------------|
| Deletion | No (unless counting) | Yes |
| Space (low FP rates) | Larger | Smaller (for FP < 3%) |
| Lookup | k hash + k memory accesses | 2 bucket lookups |
| Insert | k hash + k memory writes | Amortized O(1), worst case O(n) kicks |
| False negatives | Impossible | Impossible (if used correctly) |
| Implementation complexity | Simple | Moderate |

For false positive rates below 3%, Cuckoo filters use less space per element than Bloom filters. At higher FP rates, Bloom filters are more space-efficient.

## Partitioned Bloom Filters

A simple optimization: divide the bit array into k equal partitions, one per hash function. Each hash function only sets bits within its own partition.

```
Standard Bloom (m=16, k=3):
  All hash functions share one array:
  [0 0 1 0 0 1 0 0 0 1 0 1 0 0 1 0]

Partitioned Bloom (m=16, k=3):
  Partition 0 (h1): [0 1 0 0 0]
  Partition 1 (h2): [0 0 1 0 0]
  Partition 2 (h3): [1 0 0 0 1]
```

Benefits:
- Each partition fills at the same rate (better load distribution)
- Slightly better false positive rate in practice
- Cache-friendlier memory access patterns
- Easier to parallelize — each hash function touches independent memory

The false positive rate becomes exactly `(1 - e^(-n/(m/k)))^k` — the same formula, but the behavior is more predictable because there's no variance from uneven bit distribution.

## Bloom Filters in Distributed Systems

### Distributed Deduplication

In a multi-node streaming system (e.g., Kafka consumers), each node maintains a local Bloom filter. Periodically, filters are merged using bitwise OR to create a global view.

```
Node A filter: [1 0 1 0 0 1 0 0]
Node B filter: [0 0 1 0 1 0 0 1]
Merged filter: [1 0 1 0 1 1 0 1]   ← bitwise OR
```

The merged filter has a higher false positive rate (more bits are set), but it correctly represents the union of both nodes' sets. This is a key property: **Bloom filters are mergeable**.

### Replicated Bloom Filters

Ship a serialized Bloom filter from a central service to edge nodes. The filter is just a byte array — trivially serializable, small enough to fit in a single network packet for many use cases.

```
Central service: builds Bloom filter from blocklist (10M entries, ~12 MB)
                 ↓ ships to edge nodes every hour
Edge node:       receives byte array, deserializes, uses for local lookups
```

This is exactly how Chrome distributes its Safe Browsing filter.

### Bloom Filter as a Routing Index

In a sharded cache (e.g., 100 Memcached nodes), each node periodically publishes a Bloom filter of its cached keys. The routing layer checks all filters to find which node(s) likely have a key — avoiding broadcast queries.

```
Client: "Where is key X?"
Router: check BF_node0(X)=no, BF_node1(X)=yes, BF_node2(X)=no, ...
        → route to node 1
```

## Combining Bloom Filters with Other Structures

### Bloom Filter + Database (Pre-filter Pattern)

The most common pattern: use a Bloom filter as a cheap pre-filter before an expensive exact lookup.

```
Request: "Does user X exist?"

Step 1: Check Bloom filter (in-memory, ~100ns)
  → "Definitely no" → return 404 (saved a DB query)
  → "Probably yes"  → proceed to step 2

Step 2: Query database (network + disk, ~5ms)
  → Found → return user
  → Not found → false positive, return 404
```

If 90% of lookups are for non-existent keys (common in username availability checks, cache lookups), this eliminates 90% of database queries.

### Bloom Filter + Count-Min Sketch

Use a Bloom filter to track "have I seen this element?" and a Count-Min Sketch to track "how many times?" The Bloom filter gates access to the CMS — only increment the CMS for elements that pass the Bloom filter check.

This is useful for detecting new vs. recurring elements in a stream.

## Interview Application

Advanced Bloom filter variants come up when the interviewer pushes past the basics:

**"What if elements need to be removed?"**
> "Standard Bloom filters don't support deletion because clearing a bit could invalidate other elements sharing that position. Two options: a Counting Bloom Filter replaces bits with 4-bit counters — 4x memory but supports decrement. Or a Cuckoo filter, which stores fingerprints and supports deletion natively with better space efficiency at low false positive rates."

**"What if you don't know the dataset size upfront?"**
> "A Scalable Bloom Filter chains multiple filters with geometrically decreasing FP rates. But in practice, I'd over-provision by 2-3x — the memory cost of a larger filter is usually less than the complexity of managing a filter chain."

**"How do you use Bloom filters across multiple nodes?"**
> "Bloom filters are mergeable via bitwise OR, which gives you the union of two sets. You can also serialize and ship them — they're just byte arrays. This makes them ideal for distributed deduplication: each node maintains a local filter, and you periodically merge them."

**"How does this work with your caching layer?"**
> "Each cache node publishes a Bloom filter of its keys. The routing layer checks all filters to find candidate nodes for a key lookup. This avoids broadcasting queries to all nodes. False positives just mean an occasional unnecessary cache check — cheap compared to the broadcast alternative."

The depth signal here is knowing *which variant* to reach for based on the constraint. Deletion needed → Counting Bloom or Cuckoo. Unknown cardinality → Scalable Bloom. Distributed → merge via OR. Pre-filter → Bloom + exact store.

---

## Related Articles

**Next in series:** [Introduction to Count-Min Sketch](count-min-sketch-part-1.md)

**Previous in series:** [Introduction to Bloom Filters](bloom-filters-part-1.md)

**See also:**
- [Flash Sale Inventory Patterns](../transactions/flash-sale-inventory-patterns.md) — dedup in inventory