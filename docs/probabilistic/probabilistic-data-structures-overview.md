# Introduction to Probabilistic Data Structures

You're building a web crawler. Before fetching a URL, you need to check: have I already crawled this? You have 10 billion URLs. Storing them all in a HashSet would consume hundreds of gigabytes of RAM. A database lookup on every single URL would be painfully slow. You need an answer in microseconds, and you can tolerate being wrong occasionally.

This is the exact class of problem that probabilistic data structures solve. They trade perfect accuracy for dramatic reductions in memory and time.

## The Core Tradeoff

Traditional data structures give you exact answers. A HashSet tells you definitively whether an element exists. A HashMap gives you the precise count of every key. A sorted set gives you the exact number of distinct elements.

The cost? Memory proportional to the data size. Store 1 billion unique user IDs in a HashSet, and you need roughly 8 GB of RAM (8 bytes per ID, plus overhead). That's per machine, per replica.

Probabilistic data structures flip this equation:

| Question | Exact Structure | Memory | Probabilistic Structure | Memory |
|----------|----------------|--------|------------------------|--------|
| "Is X in the set?" | HashSet | O(n) | Bloom Filter | O(1)* |
| "How many times has X appeared?" | HashMap | O(n) | Count-Min Sketch | O(1)* |
| "How many distinct elements exist?" | Set | O(n) | HyperLogLog | O(1)* |

*O(1) meaning fixed memory regardless of data size — typically kilobytes instead of gigabytes.

The catch: they can be wrong. But they're wrong in predictable, controllable ways.

## Types of Errors

Probabilistic data structures don't produce random garbage. Their errors follow strict rules.

### False Positives

A Bloom filter might tell you "yes, this URL has been crawled" when it actually hasn't. It will **never** tell you "no, this URL hasn't been crawled" when it has. This is a one-directional error.

```
Bloom Filter says "YES"  →  Maybe (could be a false positive)
Bloom Filter says "NO"   →  Definitely no (guaranteed)
```

### Overcounting

A Count-Min Sketch might tell you a search term appeared 1,050 times when the true count is 1,000. It will **never** undercount. The error is always in one direction — upward.

```
True count: 1,000
CMS estimate: 1,000 to 1,050  (never 950)
```

### Approximation

HyperLogLog might tell you there are 1,020,000 unique visitors when the true count is 1,000,000. The error goes in both directions, but stays within a predictable range (typically ±2%).

```
True cardinality: 1,000,000
HLL estimate: 980,000 to 1,020,000  (standard error ~2%)
```

## Why This Matters in System Design

At scale, exact answers become expensive. Consider these real scenarios:

**Scenario 1: Duplicate detection in a streaming pipeline.** You're processing 1 million events per second from Kafka. Each event has a UUID. You need to deduplicate. A Redis set holding all seen UUIDs would consume terabytes over time. A Bloom filter uses a few hundred megabytes and catches 99.9%+ of duplicates.

**Scenario 2: Counting unique visitors per page.** You have 100 million pages. Each needs a distinct visitor count. Storing a set of user IDs per page is prohibitive. HyperLogLog gives you a ±2% accurate count using 12 KB per page — that's 1.2 TB vs. potentially petabytes.

**Scenario 3: Rate limiting by IP.** You need to track request counts per IP address over a sliding window. Millions of IPs, and you need sub-millisecond lookups. A Count-Min Sketch handles this in fixed memory.

## The Three Structures You Need to Know

### Bloom Filter — Set Membership

Answers: "Is this element in the set?"

A bit array plus multiple hash functions. To add an element, hash it k times and set those bit positions to 1. To query, hash it k times and check if all positions are 1.

```
Insert "apple":
  h1("apple") = 3    →  bit[3] = 1
  h2("apple") = 7    →  bit[7] = 1
  h3("apple") = 11   →  bit[11] = 1

Query "apple":
  bit[3]=1, bit[7]=1, bit[11]=1  →  "Probably yes"

Query "grape":
  bit[3]=1, bit[5]=0, bit[11]=1  →  "Definitely no"
```

False positives occur when different elements happen to set the same combination of bits. You control the false positive rate by sizing the bit array and choosing the number of hash functions.

**Used in:** Chrome's malicious URL detection, Cassandra's SSTable lookups, CDN cache routing, web crawlers.

### Count-Min Sketch — Frequency Estimation

Answers: "How many times has this element appeared?"

A 2D array (d rows × w columns) with d independent hash functions. To increment, hash the element with each function and increment the corresponding cell. To query, take the minimum across all rows.

```
         col0  col1  col2  col3  col4
row0  [  0     3     0     1     0  ]   h0("cat") → col1
row1  [  1     0     0     2     0  ]   h1("cat") → col3
row2  [  0     0     4     0     0  ]   h2("cat") → col2

estimate("cat") = min(3, 2, 4) = 2
```

The minimum operation is key — collisions can only inflate counts, never deflate them. Taking the minimum across rows minimizes the inflation.

**Used in:** Network traffic monitoring, trending topic detection, heavy hitter identification, database query optimization.

### HyperLogLog — Cardinality Estimation

Answers: "How many distinct elements are in this set?"

Based on a statistical observation: if you hash elements uniformly, the maximum number of leading zeros in any hash tells you roughly how many distinct elements you've seen. Seeing a hash with 10 leading zeros suggests ~2^10 = 1024 distinct elements.

HyperLogLog improves accuracy by splitting elements into thousands of buckets (registers) and averaging their estimates using a harmonic mean.

```
Element → hash → first p bits select bucket, remaining bits → count leading zeros

Bucket 0: max leading zeros = 5  → local estimate ~32
Bucket 1: max leading zeros = 8  → local estimate ~256
Bucket 2: max leading zeros = 3  → local estimate ~8
...
Final estimate = harmonic_mean(all bucket estimates) × correction_factor
```

With 16,384 registers (2^14), HyperLogLog uses 12 KB of memory and achieves ~0.81% standard error — regardless of whether you're counting 1,000 or 1 billion distinct elements.

**Used in:** Redis's `PFCOUNT`, database query planners (PostgreSQL), real-time analytics dashboards, network flow analysis.

## Choosing the Right Structure

```
"Do I need to check if something exists?"
  → Bloom Filter

"Do I need to count how often something appears?"
  → Count-Min Sketch

"Do I need to count how many unique things there are?"
  → HyperLogLog
```

These structures also compose well. A common pattern in analytics systems:

1. **Bloom filter** at the ingestion layer to deduplicate events
2. **Count-Min Sketch** to track per-event-type frequencies
3. **HyperLogLog** to count unique users per time window

All three running in-memory, all three using fixed space regardless of data volume.

## What They Don't Do

- **No deletion** (standard Bloom filters — Counting Bloom Filters address this)
- **No enumeration** — you can't list what's in a Bloom filter
- **No exact answers** — if you need precision, use exact structures
- **No element retrieval** — these are write-and-query structures, not storage

If your dataset fits comfortably in memory with exact structures, use exact structures. Probabilistic data structures earn their keep when exact approaches become impractical — billions of elements, tight memory budgets, or microsecond latency requirements.

## The Memory Argument

Here's the math that makes these structures compelling in interviews:

**1 billion unique user IDs (64-bit integers):**
- HashSet: ~8 GB + overhead ≈ 12-16 GB
- Bloom filter (1% FP rate): ~1.2 GB
- Bloom filter (0.1% FP rate): ~1.8 GB

**Counting occurrences of 1 billion distinct keys:**
- HashMap<String, Integer>: 50+ GB (keys + values + overhead)
- Count-Min Sketch (ε=0.001, δ=0.01): ~15 MB

**Counting distinct elements in a stream of 1 billion events:**
- HashSet: 8-16 GB
- HyperLogLog: 12 KB

That's not a marginal improvement. It's the difference between needing a cluster and needing a single process.

## Interview Application

When to bring up probabilistic data structures in a system design interview:

1. **The interviewer mentions "billions" of anything** — URLs, users, events, IPs. This is your cue. Exact structures at that scale are expensive.

2. **Deduplication in streaming systems** — "We need to check if we've seen this event before." Bloom filter.

3. **Top-K or frequency tracking** — "Show the most popular search queries." Count-Min Sketch + min-heap.

4. **Unique counts in analytics** — "How many unique users visited this page?" HyperLogLog.

How to articulate the tradeoff:

> "We could store every user ID in a Redis set, but at 100 million users that's roughly 800 MB per counter. If we need this per page, it doesn't scale. Instead, we can use HyperLogLog — 12 KB per page, ±2% accuracy. For a dashboard showing 'approximately 1.2M unique visitors,' that's more than sufficient."

The key phrase: **"We're trading exact precision for bounded, predictable error in exchange for orders-of-magnitude memory savings."**

Don't reach for these structures when the dataset is small or when exact answers are required (financial transactions, inventory counts). They shine when approximate answers at massive scale are acceptable — which covers most analytics, monitoring, and content delivery use cases.

---

## Related Articles

**Next in series:** [Introduction to Bloom Filters](bloom-filters-part-1.md)

**See also:**
- [Inverted Index Fundamentals](../search/inverted-index-fundamentals.md) — Bloom filters in search