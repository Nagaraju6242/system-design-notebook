# Introduction to Bloom Filters

Google Chrome needs to check every URL you visit against a list of known malicious websites. That list contains millions of URLs. Sending every URL to Google's servers would be slow and a privacy nightmare. Downloading the entire list to every browser would consume hundreds of megabytes.

Chrome's solution: a Bloom filter. It downloads a compact representation of the malicious URL set — a few megabytes — and checks URLs locally. If the Bloom filter says "not malicious," Chrome trusts it (zero false negatives). If it says "possibly malicious," Chrome makes a server call to confirm (handling the occasional false positive).

This is the Bloom filter's sweet spot: fast, memory-efficient set membership testing where false positives are tolerable but false negatives are not.

## How It Works

A Bloom filter has two components:
1. A **bit array** of m bits, all initialized to 0
2. A set of **k independent hash functions**, each mapping an element to a position in [0, m-1]

### Insertion

To add an element, compute all k hash functions and set those bit positions to 1.

```
Bit array (m=16): [0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0]

Insert "cat":
  h1("cat") = 2   → set bit[2]  = 1
  h2("cat") = 5   → set bit[5]  = 1
  h3("cat") = 11  → set bit[11] = 1

Bit array:         [0 0 1 0 0 1 0 0 0 0 0 1 0 0 0 0]

Insert "dog":
  h1("dog") = 5   → set bit[5]  = 1  (already 1)
  h2("dog") = 9   → set bit[9]  = 1
  h3("dog") = 14  → set bit[14] = 1

Bit array:         [0 0 1 0 0 1 0 0 0 1 0 1 0 0 1 0]
```

### Lookup

To check if an element is in the set, compute all k hash functions and check if all corresponding bits are 1.

```
Query "cat":
  bit[2]=1, bit[5]=1, bit[11]=1  →  All 1s  →  "Probably in set"

Query "bird":
  h1("bird") = 2, h2("bird") = 9, h3("bird") = 14
  bit[2]=1, bit[9]=1, bit[14]=1  →  All 1s  →  "Probably in set"
  ⚠️ FALSE POSITIVE — "bird" was never inserted!

Query "fish":
  h1("fish") = 0, h2("fish") = 5, h3("fish") = 13
  bit[0]=0  →  At least one 0  →  "Definitely not in set" ✓
```

The "bird" false positive happened because bits set by "cat" and "dog" coincidentally covered all of "bird"'s hash positions. This is the fundamental mechanism behind false positives.

### Why No False Negatives?

When you insert an element, its k bit positions are set to 1 and **never set back to 0**. So when you query that same element, those exact positions are guaranteed to still be 1. A false negative is structurally impossible.

## The Math

### False Positive Probability

After inserting n elements into a bit array of size m using k hash functions, the probability that a specific bit is still 0:

```
P(bit is 0) = (1 - 1/m)^(kn) ≈ e^(-kn/m)
```

The false positive probability — all k bits being 1 for an element not in the set:

```
P(false positive) = (1 - e^(-kn/m))^k
```

This formula drives all sizing decisions.

### Optimal Number of Hash Functions

For a given m and n, the optimal k that minimizes the false positive rate:

```
k_optimal = (m/n) × ln(2) ≈ 0.693 × (m/n)
```

More hash functions means more bits checked (reducing false positives), but also more bits set per element (increasing false positives). The optimal k balances these forces.

### Sizing the Bit Array

Given a desired false positive rate p and expected number of elements n:

```
m = -(n × ln(p)) / (ln(2))^2
```

Some practical numbers:

| Elements (n) | FP Rate (p) | Bits (m) | Bytes | Hash Functions (k) |
|--------------|-------------|----------|-------|-------------------|
| 1 million | 1% | 9.6M | 1.2 MB | 7 |
| 1 million | 0.1% | 14.4M | 1.8 MB | 10 |
| 10 million | 1% | 96M | 12 MB | 7 |
| 1 billion | 1% | 9.6B | 1.14 GB | 7 |
| 1 billion | 0.1% | 14.4B | 1.71 GB | 10 |

Key insight: **memory scales linearly with n, and logarithmically with 1/p.** Cutting the false positive rate by 10x only costs ~1.44x more memory.

## Implementation

A minimal but correct Bloom filter in Python:

```python
import mmh3  # MurmurHash3 — fast, good distribution

class BloomFilter:
    def __init__(self, expected_items: int, fp_rate: float = 0.01):
        self.size = int(-expected_items * math.log(fp_rate) / (math.log(2) ** 2))
        self.num_hashes = int((self.size / expected_items) * math.log(2))
        self.bits = bytearray(self.size // 8 + 1)

    def _get_positions(self, item: str) -> list[int]:
        # Double hashing: h(i) = h1 + i*h2 — avoids computing k independent hashes
        h1 = mmh3.hash(item, 0) % self.size
        h2 = mmh3.hash(item, 1) % self.size
        return [(h1 + i * h2) % self.size for i in range(self.num_hashes)]

    def add(self, item: str):
        for pos in self._get_positions(item):
            self.bits[pos // 8] |= (1 << (pos % 8))

    def might_contain(self, item: str) -> bool:
        return all(
            self.bits[pos // 8] & (1 << (pos % 8))
            for pos in self._get_positions(item)
        )
```

The double hashing trick (`h1 + i*h2`) is standard practice. Kirsch and Mitzenmacher proved it provides the same false positive guarantees as k fully independent hash functions.

## Real-World Applications

### 1. Database Read Optimization (Cassandra, HBase, RocksDB)

LSM-tree databases store data in sorted, immutable files called SSTables. A point lookup might need to check dozens of SSTables to find a key. Each check is a disk read.

Each SSTable has an associated Bloom filter. Before reading the file, check the Bloom filter. If it says "no," skip the file entirely. This turns most negative lookups from O(num_sstables × disk_seek) into O(num_sstables × hash_computation).

```
Query: GET key="user:12345"

SSTable-1 Bloom filter: "no"   → skip (saved a disk read)
SSTable-2 Bloom filter: "no"   → skip (saved a disk read)
SSTable-3 Bloom filter: "yes"  → read SSTable-3 → found it!
SSTable-4 Bloom filter: "no"   → skip
```

Cassandra allocates ~1.2 MB of Bloom filter per million keys per SSTable. The disk reads saved are worth orders of magnitude more than this memory cost.

### 2. Web Crawler URL Deduplication

A crawler discovers URLs at a rate of millions per hour. Before adding a URL to the crawl queue, check if it's already been crawled. A Bloom filter holding 10 billion URLs at 1% FP rate uses ~1.14 GB. The false positives mean ~1% of uncrawled URLs get skipped — acceptable for most crawlers.

### 3. CDN Cache Routing

A CDN with thousands of edge servers needs to know which server has a cached copy of a resource. Each server maintains a Bloom filter of its cached keys and shares it with the routing layer. The router checks all filters to find candidate servers — much faster than querying each server.

### 4. Spell Checkers

Store a dictionary of valid words in a Bloom filter. Check each word in a document against it. "Definitely not in dictionary" means it's misspelled. "Probably in dictionary" means it's likely correct (with rare false positives letting through misspelled words that happen to collide).

## Limitations

### No Deletion

You cannot remove an element from a standard Bloom filter. Setting a bit to 0 would potentially invalidate other elements that share that bit position.

```
"cat" sets bits [2, 5, 11]
"dog" sets bits [5, 9, 14]

Delete "cat" → set bits [2, 5, 11] to 0
Now bit[5] = 0, but "dog" needs bit[5] = 1
→ "dog" now returns false negative — BROKEN
```

This is addressed by Counting Bloom Filters (covered in Part 2).

### No Enumeration

You cannot list the elements in a Bloom filter. The bit array doesn't store elements — it stores a lossy projection of their hash values. There's no way to reverse the hash functions.

### Fixed Capacity

Once a Bloom filter is sized for n elements, inserting significantly more than n elements degrades the false positive rate. At 2x capacity, the FP rate roughly squares. You need to know your expected cardinality upfront.

### No Count Information

A Bloom filter answers "is it in the set?" — not "how many times was it added?" Inserting the same element twice has no effect (the bits are already 1).

## Bloom Filter vs. HashSet — When to Use Which

| Factor | HashSet | Bloom Filter |
|--------|---------|-------------|
| Memory | O(n) — stores actual elements | O(n) but 8-10x smaller in practice |
| False positives | None | Configurable (typically 0.1-1%) |
| False negatives | None | None |
| Deletion | Yes | No (standard) |
| Enumeration | Yes | No |
| Serialization | Expensive | Trivial (it's just a byte array) |
| Distribution | Complex | Simple — ship the byte array |

Use a HashSet when: dataset fits in memory, you need exact answers, you need deletion or enumeration.

Use a Bloom filter when: dataset is large, false positives are tolerable, you need to distribute the filter (e.g., to edge servers), or you're using it as a fast pre-filter before an expensive exact check.

## Interview Application

Bloom filters appear in system design interviews more than any other probabilistic structure. Here's how to deploy them:

**Trigger phrases from the interviewer:**
- "How do you avoid duplicate processing?"
- "How do you check if a URL has been crawled?"
- "How do you reduce unnecessary database lookups?"
- "The dataset has billions of entries..."

**How to introduce it:**

> "For the deduplication layer, I'd use a Bloom filter. It gives us O(1) membership checks with zero false negatives. We'd size it for our expected cardinality — say 1 billion URLs at a 0.1% false positive rate, which is about 1.7 GB. That fits in memory on a single node. The false positives mean we'd occasionally re-process a URL, but that's idempotent in our design, so it's harmless."

**Follow-up points to demonstrate depth:**
- Mention the sizing formula: `m = -(n × ln(p)) / (ln(2))^2`
- Explain why false negatives are impossible (bits never flip back to 0)
- Note that Bloom filters are trivially serializable — you can ship them between services or persist them to disk
- If the interviewer asks about deletion, pivot to Counting Bloom Filters
- If they ask about growing datasets, mention Scalable Bloom Filters (covered in Part 2)

**Common mistake to avoid:** Don't suggest a Bloom filter when exact answers are required. If the system can't tolerate any false positives (e.g., "has this payment already been processed?"), you need an exact structure. Bloom filters are for cases where a false positive triggers a cheap verification step, not where it causes incorrect behavior.

---

## Related Articles

**Next in series:** [Advanced Techniques with Bloom Filters](bloom-filters-part-2.md)

**Previous in series:** [Introduction to Probabilistic Data Structures](probabilistic-data-structures-overview.md)

**See also:**
- [Inverted Index Fundamentals](../search/inverted-index-fundamentals.md) — skip non-matching segments