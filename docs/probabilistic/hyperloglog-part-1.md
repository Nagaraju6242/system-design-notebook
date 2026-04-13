# HyperLogLog

You're building an analytics platform. Every page on your site needs a "unique visitors" count. You have 100 million pages and 500 million daily active users. Storing a Set of user IDs per page would require, in the worst case, 100M pages × 500M users × 8 bytes = way more memory than exists on Earth. Even with realistic distributions (most pages have few visitors), you'd need terabytes of RAM.

HyperLogLog (HLL) gives you an approximate distinct count using 12 KB per counter. That's 100 million pages × 12 KB = 1.2 TB total — large but feasible. And each counter is accurate to within ~2% regardless of whether the page has 100 or 100 million unique visitors.

## The Intuition: Coin Flips and Rare Events

Before diving into the algorithm, understand the core insight through an analogy.

Imagine flipping a fair coin repeatedly and recording the longest streak of heads. If you flip 10 times, a streak of 3-4 heads is normal. A streak of 10 heads is extraordinary — it suggests you flipped many more times than 10.

The key observation: **the length of the longest run of a specific pattern tells you approximately how many trials occurred.**

```
Longest streak of heads:  3  →  ~2³ = 8 trials (rough estimate)
Longest streak of heads:  7  →  ~2⁷ = 128 trials
Longest streak of heads: 20  →  ~2²⁰ ≈ 1 million trials
```

HyperLogLog applies this to hash values. Hash each element to a binary string. Count the leading zeros. The maximum number of leading zeros across all elements estimates the cardinality.

## From Intuition to Algorithm

### Step 1: Hash and Observe Leading Zeros

Hash each element to a uniform binary string. Count the number of leading zeros + 1 (the position of the first 1-bit, called ρ).

```
Element "alice" → hash → 00010110...  → ρ = 3 (first 1 at position 3)
Element "bob"   → hash → 00000001...  → ρ = 7
Element "carol" → hash → 01001010...  → ρ = 1
Element "dave"  → hash → 00000000001... → ρ = 10
```

If we track the maximum ρ across all elements, we get a rough cardinality estimate of 2^max(ρ). With max(ρ) = 10, we'd estimate ~1024 distinct elements.

### The Problem: High Variance

A single maximum is a terrible estimator. One unlucky hash with many leading zeros wildly inflates the estimate. One element hashing to `0000000000001...` makes you think there are 8192 distinct elements even if there are only 5.

### Step 2: Stochastic Averaging (Multiple Buckets)

The fix: split elements into many buckets (called **registers**) and average their estimates.

Use the first p bits of the hash to select a register. Use the remaining bits to compute ρ.

```
Hash: 01011 | 00010110...
      ─────   ──────────
      bucket   remaining bits → ρ = 3
      = 11

With p=5 bits → 2⁵ = 32 registers
```

Each register stores the maximum ρ seen for elements assigned to it.

```
Register  0: max_ρ = 4
Register  1: max_ρ = 2
Register  2: max_ρ = 7
Register  3: max_ρ = 3
...
Register 31: max_ρ = 5
```

### Step 3: Harmonic Mean

Average the per-register estimates using a **harmonic mean**, which is less sensitive to outliers than an arithmetic mean:

```
E = α_m × m² × (Σ 2^(-M[j]) for j=0..m-1)^(-1)
```

Where:
- m = number of registers (2^p)
- M[j] = value in register j (max ρ for that bucket)
- α_m = bias correction constant ≈ 0.7213 / (1 + 1.079/m) for large m

The harmonic mean naturally dampens the effect of outlier registers with unusually high or low values.

## Concrete Walkthrough

Let's trace through a small example with p=2 (4 registers):

```
Elements: {"alice", "bob", "carol", "dave", "eve", "frank"}

Hash each to 8-bit values (simplified):
  "alice" → 01 | 010110  → register 1, ρ("010110") = 1
  "bob"   → 11 | 000101  → register 3, ρ("000101") = 3
  "carol" → 00 | 100010  → register 0, ρ("100010") = 0  (first bit is 1, so ρ=0... 
                                                           actually ρ = position of first 1)
```

Let me use a cleaner notation. ρ = number of leading zeros + 1 in the remaining bits:

```
  "alice" → reg 1, remaining = 010110 → leading zeros = 1, ρ = 2
  "bob"   → reg 3, remaining = 000101 → leading zeros = 3, ρ = 4
  "carol" → reg 0, remaining = 100010 → leading zeros = 0, ρ = 1
  "dave"  → reg 2, remaining = 001100 → leading zeros = 2, ρ = 3
  "eve"   → reg 1, remaining = 001010 → leading zeros = 2, ρ = 3
  "frank" → reg 0, remaining = 010001 → leading zeros = 1, ρ = 2

Registers after processing:
  R[0] = max(1, 2) = 2
  R[1] = max(2, 3) = 3
  R[2] = max(3)    = 3
  R[3] = max(4)    = 4

Harmonic mean calculation:
  Σ 2^(-M[j]) = 2^(-2) + 2^(-3) + 2^(-3) + 2^(-4)
               = 0.25 + 0.125 + 0.125 + 0.0625
               = 0.5625

  E = α₄ × 4² × (1/0.5625)
    = 0.532 × 16 × 1.778
    ≈ 15.1

  (With correction factors applied, this gets closer to 6)
```

The raw estimate is off because we only have 4 registers. With 16,384 registers (the standard), the estimate converges to within ~0.81% of the true value.

## Standard Parameters

The standard HyperLogLog implementation uses:

```
p = 14  →  m = 2^14 = 16,384 registers
Each register: 6 bits (stores values 0-63, enough for 64-bit hashes)
Total memory: 16,384 × 6 bits = 12,288 bytes ≈ 12 KB
```

### Accuracy

The standard error of HLL is:

```
Standard error = 1.04 / √m

With m = 16,384:
  SE = 1.04 / √16384 = 1.04 / 128 = 0.008125 ≈ 0.81%
```

This means for a true cardinality of 1,000,000, the estimate will typically be between 991,875 and 1,008,125. That's remarkably accurate for 12 KB of memory.

### Range

HLL with 64-bit hashes can estimate cardinalities up to ~2^64 with no structural changes. The same 12 KB works for 1,000 elements or 1 trillion elements.

## Corrections for Edge Cases

Raw HLL has systematic biases at very low and very high cardinalities.

### Small Range Correction (Linear Counting)

When many registers are still 0 (low cardinality), HLL overestimates. The fix: if the raw estimate is below 5/2 × m, switch to **Linear Counting**:

```
V = number of registers with value 0
E_linear = m × ln(m / V)
```

Linear Counting is more accurate than HLL for small cardinalities. The threshold 5/2 × m ≈ 40,960 for standard parameters.

### Large Range Correction

When the estimate approaches 2^32 (for 32-bit hashes), hash collisions cause underestimation. The fix:

```
if E > 2^32 / 30:
  E_corrected = -2^32 × ln(1 - E / 2^32)
```

With 64-bit hashes (standard in modern implementations), this correction is rarely needed.

### HyperLogLog++ (Google's Improvement)

Google's HyperLogLog++ paper (2013) introduced:
1. 64-bit hashes (eliminates large range correction)
2. Empirical bias correction using lookup tables (better accuracy at all ranges)
3. Sparse representation for low cardinalities (saves memory when most registers are empty)

Redis's `PFADD`/`PFCOUNT` implements HyperLogLog++.

## Implementation

```python
import mmh3
import math

class HyperLogLog:
    def __init__(self, p: int = 14):
        self.p = p
        self.m = 1 << p
        self.registers = [0] * self.m
        self.alpha = 0.7213 / (1 + 1.079 / self.m)

    def add(self, item: str):
        h = mmh3.hash64(item, signed=False)[0]
        # First p bits → register index
        idx = h >> (64 - self.p)
        # Remaining bits → count leading zeros
        remaining = h << self.p | (1 << (self.p - 1))  # ensure termination
        rho = self._leading_zeros(remaining) + 1
        self.registers[idx] = max(self.registers[idx], rho)

    def count(self) -> int:
        # Raw harmonic mean estimate
        indicator = sum(2.0 ** (-r) for r in self.registers)
        estimate = self.alpha * self.m * self.m / indicator

        # Small range correction
        if estimate <= 2.5 * self.m:
            zeros = self.registers.count(0)
            if zeros > 0:
                estimate = self.m * math.log(self.m / zeros)

        return int(estimate)

    def _leading_zeros(self, value: int) -> int:
        if value == 0:
            return 64 - self.p
        count = 0
        for i in range(63, -1, -1):
            if value & (1 << i):
                break
            count += 1
        return count
```

## HLL in Redis

Redis provides HyperLogLog as a first-class data type:

```redis
PFADD page:home:visitors "user:123" "user:456" "user:789"
PFADD page:home:visitors "user:123"  # duplicate, no effect

PFCOUNT page:home:visitors
# → (integer) 3

# Merge multiple HLLs
PFMERGE page:all:visitors page:home:visitors page:about:visitors
PFCOUNT page:all:visitors
# → union cardinality
```

Each HLL key in Redis uses at most 12 KB. `PFADD` is O(1). `PFCOUNT` is O(1) for a single key, O(n) when merging n keys.

## Interview Application

HyperLogLog is the go-to answer for "count unique X" at scale. Here's how to use it:

**Trigger phrases:**
- "How many unique users visited..."
- "Count distinct elements in a stream"
- "Approximate cardinality"
- "The dataset has billions of unique items"

**How to introduce it:**

> "For unique visitor counts, I'd use HyperLogLog. Each page gets its own HLL counter — 12 KB of memory, regardless of whether the page has 100 or 100 million unique visitors. The standard error is about 0.81%, so for 1 million true unique visitors, we'd report between roughly 992K and 1.008M. For a dashboard showing '~1M unique visitors,' that's more than sufficient."

**Depth signals:**
- Explain the leading-zeros intuition: "It's based on the observation that the maximum number of leading zeros in a set of random hashes estimates the log₂ of the cardinality"
- Mention registers and harmonic mean: "It splits elements into 16K buckets and uses a harmonic mean to reduce variance from outliers"
- Note mergeability: "HLL counters are mergeable — take the max of each register. So I can compute per-shard unique counts and merge them for a global count"
- Reference Redis: "Redis has native HLL support via PFADD/PFCOUNT, using 12 KB per key"

**Common mistake:** Don't confuse HLL with counting total events (that's a simple counter) or counting frequency of specific events (that's Count-Min Sketch). HLL answers specifically "how many *distinct* elements?" — the cardinality question.

---

## Related Articles

**Next in series:** [How to Use HyperLogLog in System Design](hyperloglog-part-2.md)

**Previous in series:** [Count-Min Sketch Applications](count-min-sketch-part-2.md)

**See also:**
- [Elasticsearch Architecture Essentials](../search/elasticsearch-architecture-essentials.md) — cardinality aggregations