# Count-Min Sketch Applications

Your ad platform serves 2 billion ad impressions per day across 50 million distinct ad creatives. The billing system needs to know how many times each ad was shown. The fraud detection system needs to flag ads with suspiciously high impression counts. The analytics dashboard needs to show advertisers their top-performing creatives.

Storing exact counts for 50 million ads is feasible in a single HashMap. But the counts need to be computed from a distributed stream of impression events across hundreds of servers, merged in real-time, and queryable with sub-millisecond latency. This is where Count-Min Sketch's properties — fixed memory, mergeability, and stream-friendliness — become essential.

## Pattern 1: Top-K Heavy Hitters

The most common CMS application in system design: finding the K most frequent elements in a data stream.

### The Algorithm

Combine a Count-Min Sketch with a min-heap of size K:

```
For each element x in the stream:
  1. CMS.update(x)
  2. estimated_count = CMS.estimate(x)
  3. If heap.size < K:
       heap.push((estimated_count, x))
     Elif estimated_count > heap.peek().count:
       heap.pop()
       heap.push((estimated_count, x))
```

The heap always contains the K elements with the highest estimated counts. The CMS provides the frequency estimates in O(1) time and fixed memory.

```
Stream: "a" "b" "a" "c" "a" "b" "d" "a" "b" "a"

After processing (K=2):
  CMS estimates: a→5, b→3, c→1, d→1
  Min-heap: [(3, "b"), (5, "a")]
  Top-2: ["a" (5), "b" (3)]
```

### Memory Analysis

```
CMS (ε=0.001, δ=0.01):  ~54 KB
Min-heap (K=100):        ~100 entries × ~50 bytes = ~5 KB
Total:                   ~59 KB

vs. HashMap approach:    50 million entries × ~80 bytes = ~4 GB
```

### The Accuracy Question

CMS overcounts, so the heap might include elements whose true count is slightly below the Kth element's true count. For heavy hitters, the overcounting is small relative to the true count, so the top-K list is usually correct. For borderline elements near the Kth position, there can be swaps.

In practice, the top-10 or top-100 elements in most real distributions (Zipfian) have counts so much higher than the rest that CMS overcounting doesn't affect the ranking.

## Pattern 2: Distributed Frequency Counting

CMS sketches are **additively mergeable**: to combine counts from two nodes, add corresponding cells.

```
Node A sketch:          Node B sketch:          Merged sketch:
[3  0  1  2  0]        [1  2  0  0  3]        [4  2  1  2  3]
[0  4  0  1  0]   +    [2  0  1  0  0]   =    [2  4  1  1  0]
[1  0  3  0  2]        [0  1  0  2  1]        [1  1  3  2  3]
```

This property enables a powerful distributed architecture:

```
                    ┌─── Node A (local CMS) ───┐
                    │                           │
Events stream ──→  ├─── Node B (local CMS) ───┤──→ Merge ──→ Global CMS
                    │                           │
                    └─── Node C (local CMS) ───┘

Each node:
  - Processes its partition of the event stream
  - Maintains a local CMS
  - Periodically ships its CMS to the aggregator

Aggregator:
  - Receives CMS sketches from all nodes
  - Merges them by cell-wise addition
  - Answers queries against the merged sketch
```

### Why Not Just Use a Central Counter?

A central HashMap or Redis instance receiving 500K increments/second becomes a bottleneck. With CMS:
- Each node processes events locally (no network hop per event)
- Merges happen periodically (e.g., every 10 seconds), not per event
- The merge payload is the sketch itself — a few KB, not millions of key-value pairs

### Merge Frequency Tradeoff

More frequent merges → more accurate global view, more network traffic.
Less frequent merges → stale global view, less network traffic.

For trending detection, merging every 5-10 seconds is typical. For billing, you'd merge more frequently or use exact counting.

## Pattern 3: Sliding Window Frequency

Many applications need frequency counts over a time window: "How many times was this API called in the last 5 minutes?"

### Approach: Rotating Sketches

Maintain multiple CMS instances, one per time bucket:

```
Time:    |  0-1 min  |  1-2 min  |  2-3 min  |  3-4 min  |  4-5 min  |
Sketch:  |   CMS₀    |   CMS₁    |   CMS₂    |   CMS₃    |   CMS₄    |

Current window estimate = sum of estimates across all active sketches

Every minute:
  - Drop the oldest sketch (CMS₀)
  - Create a new empty sketch for the new minute
  - Shift the window forward
```

To estimate the count of element x over the last 5 minutes:

```python
def estimate_window(x, sketches):
    return sum(sketch.estimate(x) for sketch in sketches)
```

This is an approximation of the sliding window — it's actually a tumbling window with 1-minute granularity. For smoother sliding, use smaller buckets (e.g., 10-second buckets for a 5-minute window = 30 sketches).

### Memory

```
5-minute window, 1-minute buckets, each CMS ~54 KB:
Total = 5 × 54 KB = 270 KB

vs. HashMap per minute with 1M distinct keys:
Total = 5 × ~80 MB = 400 MB
```

## Pattern 4: Frequency-Based Caching (TinyLFU)

Caffeine (Java's high-performance cache library) uses a Count-Min Sketch as the frequency estimator in its TinyLFU admission policy.

### The Problem

LRU caches are vulnerable to scan pollution — a one-time scan of many keys evicts frequently-accessed hot keys. LFU caches need per-key counters, which consume memory proportional to the key space.

### TinyLFU Solution

Use a CMS to track access frequencies with fixed memory. When a new item wants to enter the cache, compare its CMS frequency estimate against the item it would evict. Only admit the new item if it's accessed more frequently.

```
Cache is full. New item X arrives.

Victim (least recently used): Y
CMS.estimate(X) = 15
CMS.estimate(Y) = 3

15 > 3 → Admit X, evict Y

---

New item Z arrives.
CMS.estimate(Z) = 1
CMS.estimate(victim) = 20

1 < 20 → Reject Z, keep victim
```

### Aging

Over time, all CMS counters grow, making it impossible to distinguish currently-hot items from historically-hot items. TinyLFU solves this with periodic **halving**: divide all counters by 2 at regular intervals.

```
Every W accesses (W = 10 × cache_size):
  for each cell in CMS:
    cell = cell >> 1   # right shift = divide by 2
```

This exponentially decays old frequencies, giving more weight to recent accesses.

## Pattern 5: Anomaly Detection

Detect unusual spikes in event frequency by comparing current CMS estimates against a baseline.

```
Baseline CMS: trained on "normal" traffic over the past week
Current CMS:  tracks the last 5 minutes

For each monitored element x:
  baseline_rate = baseline_CMS.estimate(x) / baseline_duration
  current_rate  = current_CMS.estimate(x) / current_duration

  if current_rate > threshold × baseline_rate:
    alert("Anomaly detected for element x")
```

This works for DDoS detection (spike in requests from an IP range), fraud detection (spike in transactions from a merchant), and error monitoring (spike in a specific error code).

### Why CMS Over Exact Counts?

The baseline CMS might track millions of distinct elements over a week. Storing exact counts for all of them is expensive. The CMS gives you a fixed-memory baseline that's accurate enough for anomaly detection — you're looking for 10x or 100x spikes, not 1.01x differences.

## Pattern 6: Join Size Estimation

Database query optimizers use CMS to estimate the size of joins without executing them.

```
Table A has column "user_id" with frequency sketch CMS_A
Table B has column "user_id" with frequency sketch CMS_B

Estimated join size = Σ min(CMS_A.estimate(x), CMS_B.estimate(x)) for all x
```

In practice, the optimizer doesn't iterate over all possible values. It uses the sketch properties to compute an upper bound on the join size, which is sufficient for choosing between nested loop, hash join, and merge join strategies.

## Combining CMS with Other Structures

### CMS + Bloom Filter: Frequency with Existence Check

```
Stream processing pipeline:

1. Bloom filter: "Have I seen this event ID before?"
   → No:  new event, process it, add to Bloom filter
   → Yes: duplicate (or false positive), skip

2. CMS: "How many times has this event type occurred?"
   → Increment CMS for the event type
   → Use for rate limiting, trending, analytics
```

### CMS + HyperLogLog: Frequency + Cardinality

```
Per-page analytics:

CMS:        "How many times was page X viewed?"  (total views)
HyperLogLog: "How many unique users viewed page X?"  (unique views)

Ratio = CMS.estimate(X) / HLL.estimate(X) = average views per unique user
```

## Limitations to Be Honest About

1. **Overcounting bias** — CMS never undercounts. For rare elements, the overcount can be larger than the true count. Don't use CMS when you need accurate counts for low-frequency items.

2. **No key enumeration** — You can't ask "what are all the elements with count > 1000?" You can only query specific elements. For top-K, you need a separate structure (heap) to track candidates.

3. **Error scales with total stream size** — The error bound ε × N grows as N grows. For long-running streams, either reset periodically or use the sliding window approach.

4. **Not suitable for exact billing** — If an advertiser is charged per impression, use exact counts. CMS overcounting means you'd overcharge. Use CMS for analytics and monitoring, not financial transactions.

## Interview Application

CMS applications come up in specific interview scenarios. Here's how to deploy them:

**"Design a trending topics system"**

> "Each ingestion server maintains a local Count-Min Sketch tracking hashtag frequencies. Every 10 seconds, servers ship their sketches to an aggregator that merges them by cell-wise addition. The aggregator maintains a min-heap of size K against the merged sketch. To detect trends, I'd compare the current 5-minute sketch against a 1-hour baseline — hashtags with a frequency ratio above a threshold are trending."

**"Design a rate limiter for millions of API keys"**

> "I'd use a CMS with rotating time buckets — say 6 buckets of 10 seconds each for a 1-minute window. For each request, increment the CMS and sum the estimate across active buckets. If the sum exceeds the rate limit, reject the request. CMS overcounting means we might rate-limit slightly early, which is the safe direction. Total memory: ~300 KB regardless of how many API keys exist."

**"How would you find the most popular products?"**

> "Count-Min Sketch for frequency estimation plus a min-heap of size K for tracking the top products. Each product view increments the CMS. If the new estimate exceeds the heap minimum, swap it in. The CMS uses fixed memory — about 54 KB — and the heap holds K product IDs. This handles millions of products without storing per-product counters."

**Key differentiator from Bloom filters:** Bloom filters answer "is it in the set?" (binary). CMS answers "how many times?" (frequency). If the interviewer asks about counting, reach for CMS. If they ask about membership, reach for Bloom filters.

---

## Related Articles

**Next in series:** [HyperLogLog](hyperloglog-part-1.md)

**Previous in series:** [Introduction to Count-Min Sketch](count-min-sketch-part-1.md)

**See also:**
- [Advanced Search Patterns](../search/advanced-search-patterns.md) — query frequency