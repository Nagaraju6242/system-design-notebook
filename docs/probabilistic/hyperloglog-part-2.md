# How to Use HyperLogLog in System Design

Your social media platform needs to show each post's "reach" — the number of unique users who saw it. Posts go viral. A single post might be shown to 50 million users across thousands of feed-serving nodes. Each node sees a different slice of the audience. You need a global unique count, not a sum of per-node counts (which would massively overcount users who appear on multiple nodes).

This is the distributed cardinality problem, and HyperLogLog's mergeability makes it the standard solution.

## The Merge Property

HLL's most powerful feature for system design: two HLL sketches can be merged by taking the element-wise maximum of their registers.

```
Node A registers: [3, 1, 5, 2, 4, 0, 3, 1, ...]
Node B registers: [2, 4, 5, 1, 0, 3, 2, 2, ...]
Merged registers: [3, 4, 5, 2, 4, 3, 3, 2, ...]  ← max of each position
```

The merged HLL gives the cardinality of the **union** of both sets. This is exact — not an approximation of the merge. The merge itself introduces zero additional error.

Why does max work? Each register stores the maximum ρ (leading zeros) seen for elements in that bucket. If element X went to Node A and element Y went to Node B, and both hash to register 5, the merged register 5 correctly holds the maximum ρ across both X and Y — exactly what a single HLL would have computed if it had seen both elements.

## Architecture Pattern: Distributed Unique Counting

### The Standard Pipeline

```
                    ┌─── Feed Server 1 (local HLL) ───┐
                    │                                   │
User impressions →  ├─── Feed Server 2 (local HLL) ───┤──→ Aggregator ──→ Redis
                    │                                   │    (merge HLLs)   (store merged HLL)
                    └─── Feed Server N (local HLL) ───┘

Query: "How many unique users saw post X?"
  → Redis: PFCOUNT post:{X}:reach
  → ~12 KB lookup, O(1), returns approximate unique count
```

Each feed server maintains an in-memory HLL per post. Periodically (every 5-30 seconds), it flushes its local HLLs to the aggregator. The aggregator merges them into the global HLL stored in Redis.

### Why Not Just Send User IDs?

At 50 million impressions per post, sending raw user IDs to the aggregator means:
- 50M × 8 bytes = 400 MB of data per post per flush
- Network bandwidth: prohibitive at scale
- Aggregator memory: must hold a Set of all user IDs

With HLL:
- Each server sends a 12 KB sketch per post per flush
- 1000 servers × 12 KB = 12 MB per post per flush
- Aggregator: merge is O(m) = O(16,384) per post — microseconds

## Design Problem: Real-Time Analytics Dashboard

### Requirements
- Show unique visitors per page, per hour, per day
- 100 million pages
- 500 million daily active users
- Sub-100ms query latency
- Data freshness: within 30 seconds

### Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Web Server  │     │  Web Server  │     │  Web Server  │
│  (pageview   │     │  (pageview   │     │  (pageview   │
│   events)    │     │   events)    │     │   events)    │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       └────────────┬───────┘────────────────────┘
                    ▼
              ┌───────────┐
              │   Kafka   │  (pageview events partitioned by page_id)
              └─────┬─────┘
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐
   │Consumer │ │Consumer │ │Consumer │
   │ Group   │ │ Group   │ │ Group   │
   │(local   │ │(local   │ │(local   │
   │  HLLs)  │ │  HLLs)  │ │  HLLs)  │
   └────┬────┘ └────┬────┘ └────┬────┘
        │           │           │
        └───────────┼───────────┘
                    ▼
              ┌───────────┐
              │   Redis   │  (PFMERGE per page per time bucket)
              │  HLL keys │
              └─────┬─────┘
                    │
                    ▼
              ┌───────────┐
              │ Dashboard │  (PFCOUNT queries)
              │   API     │
              └───────────┘
```

### Key Design Decisions

**Redis key structure:**
```
page:{page_id}:uv:hour:{YYYYMMDDHH}    ← hourly HLL
page:{page_id}:uv:day:{YYYYMMDD}       ← daily HLL (merged from hourly)
```

**Hourly to daily rollup:**
```redis
PFMERGE page:123:uv:day:20260412 \
  page:123:uv:hour:2026041200 \
  page:123:uv:hour:2026041201 \
  ... \
  page:123:uv:hour:2026041223
```

The daily HLL is the merge of 24 hourly HLLs. The merged result gives the unique count across the entire day — users who visited in multiple hours are counted once.

**Memory budget:**
```
100M pages × 1 HLL per page per hour × 12 KB = 1.2 TB per hour
  → Too much for a single Redis cluster

Solution: Only keep HLLs for active pages.
  Active pages per hour (with at least 1 visit): ~5M
  5M × 12 KB = 60 GB per hour
  24 hours × 60 GB = 1.44 TB for a full day
  → Fits in a Redis cluster with sharding
```

**TTL strategy:**
```
Hourly HLLs: TTL = 48 hours (keep for rollup + buffer)
Daily HLLs:  TTL = 90 days
```

## Design Problem: Unique Count with Intersection

HLL natively supports union (merge). It does **not** natively support intersection. But you can approximate it using inclusion-exclusion:

```
|A ∩ B| = |A| + |B| - |A ∪ B|

Where:
  |A|     = PFCOUNT hll_A
  |B|     = PFCOUNT hll_B
  |A ∪ B| = PFCOUNT (PFMERGE hll_A hll_B)
```

### The Accuracy Problem

Inclusion-exclusion amplifies HLL's error. If |A| = 1,000,000 and |B| = 1,000,000 and |A ∩ B| = 10,000:

```
True: |A ∩ B| = 10,000

With 2% error on each estimate:
  |A|     = 1,000,000 ± 20,000
  |B|     = 1,000,000 ± 20,000
  |A ∪ B| = 1,990,000 ± 39,800

  |A ∩ B| = 1,000,000 + 1,000,000 - 1,990,000 = 10,000
  Error range: ±(20,000 + 20,000 + 39,800) = ±79,800

  Estimate could be anywhere from -69,800 to 89,800
```

The intersection estimate is useless when |A ∩ B| is small relative to |A| and |B|. This is a fundamental limitation.

**When intersection works:** When the overlap is large (e.g., |A ∩ B| > 0.1 × |A|), the relative error is manageable.

**When it doesn't:** For small overlaps, use MinHash (Jaccard similarity estimation) or exact methods.

## Design Problem: Counting Across Time Windows

### Sliding Window Unique Counts

"How many unique users visited in the last 7 days?"

You can't subtract from an HLL. If a user visited on day 1 but not days 2-7, you can't remove them from the 7-day HLL when day 1 expires.

**Solution: Merge daily HLLs on query.**

```
7-day unique count = PFCOUNT(PFMERGE day1_hll, day2_hll, ..., day7_hll)
```

This works because merging daily HLLs gives the union — users appearing on any day are counted once. When the window slides, drop the oldest daily HLL and add the newest.

```
Day 8 query:
  PFMERGE week_hll day2_hll day3_hll day4_hll day5_hll day6_hll day7_hll day8_hll
  PFCOUNT week_hll
```

**Cost:** Merging 7 HLLs = 7 × 12 KB reads + register-wise max. Fast enough for real-time queries.

### Multi-Granularity Rollups

```
Minute HLLs → merge into → Hour HLLs → merge into → Day HLLs → merge into → Month HLLs

Each level is a merge of the level below.
No double-counting across any time boundary.
```

This is the standard pattern for analytics systems. Store fine-grained HLLs for recent data, roll up into coarser HLLs for historical data, expire the fine-grained ones.

## HLL vs. Exact Counting — Decision Framework

| Factor | Use HLL | Use Exact (Set/DB) |
|--------|---------|-------------------|
| Cardinality | > 100K distinct elements | < 100K distinct elements |
| Accuracy needed | ±2% is fine | Exact count required |
| Memory budget | Tight (KB per counter) | Generous (MB-GB per counter) |
| Mergeability | Required (distributed counting) | Not needed |
| Need to list elements | No | Yes |
| Need intersection | Large overlap only | Any overlap |
| Regulatory/billing | No | Yes (financial accuracy) |

## HLL in Production Systems

### Redis
```redis
PFADD key element [element ...]   # Add elements
PFCOUNT key [key ...]             # Count (merges if multiple keys)
PFMERGE destkey sourcekey [...]   # Merge into destination
```
12 KB per key. O(1) add and count. Used by virtually every analytics system that runs on Redis.

### PostgreSQL (with extensions)
```sql
-- Using postgresql-hll extension
CREATE TABLE page_stats (
  page_id   BIGINT,
  day       DATE,
  visitors  hll
);

-- Add a visitor
UPDATE page_stats
SET visitors = hll_add(visitors, hll_hash_text('user:123'))
WHERE page_id = 42 AND day = '2026-04-12';

-- Count uniques
SELECT hll_cardinality(visitors) FROM page_stats
WHERE page_id = 42 AND day = '2026-04-12';

-- Merge across days
SELECT hll_cardinality(hll_union_agg(visitors))
FROM page_stats
WHERE page_id = 42 AND day BETWEEN '2026-04-06' AND '2026-04-12';
```

### Apache Spark / Flink
Both support HLL for approximate distinct counts in streaming and batch processing. Spark's `approx_count_distinct()` uses HLL internally.

```sql
-- Spark SQL
SELECT page_id, approx_count_distinct(user_id) as unique_visitors
FROM pageviews
GROUP BY page_id;
```

### BigQuery
```sql
SELECT page_id, HLL_COUNT.MERGE(sketch) as unique_visitors
FROM (
  SELECT page_id, HLL_COUNT.INIT(user_id) as sketch
  FROM pageviews
  GROUP BY page_id
)
GROUP BY page_id;
```

## Common Pitfalls

1. **Using HLL for small sets.** If you have < 10,000 distinct elements, just use a Set. HLL's 12 KB overhead isn't worth it, and the ±2% error is unnecessary.

2. **Expecting exact intersection.** HLL intersection via inclusion-exclusion is unreliable for small overlaps. Don't promise "users who visited both page A and page B" with HLL unless the overlap is substantial.

3. **Forgetting that HLL is append-only.** You can't remove elements. Design your time windows around merge-and-expire, not add-and-remove.

4. **Summing HLL counts instead of merging.** If Node A counted 500K uniques and Node B counted 500K uniques, the total is NOT 1M. Many users appear on both nodes. You must merge the HLLs and count the merged result.

## Interview Application

HLL is the standard answer for "count unique X at scale." Here's how to deploy it across common interview problems:

**"Design a unique visitors counter for a website"**
> "Each web server maintains a local HLL per page. Every 10 seconds, servers flush their HLLs to Redis using PFMERGE. The dashboard queries PFCOUNT. Memory: 12 KB per page. For 10M active pages, that's 120 GB in Redis — fits in a single cluster. Accuracy: ±0.81% standard error."

**"Design a real-time analytics system showing daily/weekly/monthly uniques"**
> "I'd use multi-granularity HLL rollups. Minute-level HLLs merge into hourly, hourly into daily, daily into weekly. Each merge is a register-wise max — no double-counting. For a 7-day unique count, merge 7 daily HLLs at query time. Store in Redis with TTLs: hourly HLLs expire after 48 hours, daily after 90 days."

**"How do you count unique users across a distributed system?"**
> "HLL's key property is mergeability. Each node maintains a local HLL. Periodically, nodes ship their 12 KB sketches to an aggregator that merges them with register-wise max. The merged HLL gives the exact union cardinality — users seen by any node, counted once. This avoids shipping raw user IDs across the network."

**When the interviewer pushes on accuracy:**
> "Standard error is 1.04/√m. With 16,384 registers (12 KB), that's 0.81%. For 1 million true uniques, the estimate is typically within 992K to 1.008M. If we need higher accuracy, we can increase to 2^16 registers (48 KB) for 0.4% error. The tradeoff is linear: 4x memory for 2x accuracy."

**When they ask about intersection:**
> "HLL supports union natively but not intersection. You can approximate intersection via inclusion-exclusion: |A ∩ B| = |A| + |B| - |A ∪ B|. But the error amplifies when the intersection is small relative to the sets. For reliable intersection estimates, I'd use MinHash for Jaccard similarity, or maintain exact sets if the cardinality is manageable."

---

## Related Articles

**Previous in series:** [HyperLogLog](hyperloglog-part-1.md)

**See also:**
- [Consistency Models](../distributed-systems/consistency-models.md) — distributed counting