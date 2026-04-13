# Inverted Index Fundamentals

You're building a product search for an e-commerce platform with 50 million listings. A user types "wireless noise cancelling headphones" and expects results in under 100ms. You can't scan every listing's description — that's a full table scan across 50M rows. You need a data structure that maps *words to documents*, not documents to words. That data structure is the inverted index.

## Why Not Just Use a Database?

A naive approach: store products in Postgres and run `SELECT * FROM products WHERE description ILIKE '%wireless%' AND description ILIKE '%noise cancelling%'`.

This fails at scale for three reasons:

1. `LIKE '%term%'` can't use B-tree indexes — it's a full table scan every time
2. No relevance ranking — you get boolean matches, not "best match first"
3. No linguistic awareness — "running" won't match "run", "headphone" won't match "headphones"

A relational database is optimized for structured lookups by key. Full-text search is a fundamentally different problem.

## The Core Idea

A forward index maps documents to their words:

```
Doc 1 → ["wireless", "noise", "cancelling", "headphones", "black"]
Doc 2 → ["wired", "headphones", "studio", "monitor"]
Doc 3 → ["wireless", "earbuds", "noise", "cancelling"]
```

An inverted index flips this — it maps each word to the list of documents containing it:

```
"wireless"    → [Doc 1, Doc 3]
"noise"       → [Doc 1, Doc 3]
"cancelling"  → [Doc 1, Doc 3]
"headphones"  → [Doc 1, Doc 2]
"black"       → [Doc 1]
"wired"       → [Doc 2]
"studio"      → [Doc 2]
"monitor"     → [Doc 2]
"earbuds"     → [Doc 3]
```

Searching for "wireless headphones" becomes: intersect the posting lists for "wireless" and "headphones" → `[Doc 1]`. O(n) in the size of the posting lists, not the size of the corpus.

## Anatomy of an Inverted Index

An inverted index has two components:

### The Term Dictionary

A sorted data structure mapping every unique term to metadata. Typically stored as an FST (Finite State Transducer) or sorted array for prefix lookups.

```
Term          → (PostingListPointer, DocFrequency)
─────────────────────────────────────────────────
"cancelling"  → (offset: 4096, df: 2)
"headphones"  → (offset: 5120, df: 2)
"wireless"    → (offset: 8192, df: 2)
```

### Posting Lists

For each term, an ordered list of document IDs (and optionally positions, frequencies, payloads):

```
"wireless" → [1, 3]                          // doc IDs only
"wireless" → [(1, tf=1), (3, tf=2)]          // with term frequency
"wireless" → [(1, tf=1, pos=[0]), (3, tf=2, pos=[0,5])]  // with positions
```

The level of detail stored in posting lists is a space/functionality tradeoff:

| Posting List Type | Stores | Enables | Size |
|---|---|---|---|
| Doc IDs only | document IDs | boolean search | smallest |
| With frequencies | doc IDs + term count per doc | TF-IDF/BM25 scoring | ~2x |
| With positions | doc IDs + term positions | phrase queries, proximity search | ~3-5x |

## Building an Inverted Index: The Indexing Pipeline

Raw text doesn't go directly into the index. It passes through an analysis pipeline:

```
"The Quick Brown Fox's running!" 
    │
    ▼ Character Filtering (strip HTML, normalize unicode)
"The Quick Brown Fox's running!"
    │
    ▼ Tokenization (split on whitespace/punctuation)
["The", "Quick", "Brown", "Fox's", "running"]
    │
    ▼ Token Filtering
    │   ├── Lowercase:    ["the", "quick", "brown", "fox's", "running"]
    │   ├── Stop words:   ["quick", "brown", "fox's", "running"]
    │   ├── Possessive:   ["quick", "brown", "fox", "running"]
    │   └── Stemming:     ["quick", "brown", "fox", "run"]
    ▼
Index terms: ["quick", "brown", "fox", "run"]
```

### Tokenization Choices Matter

Different tokenizers produce different results for the same input:

```
Input: "user@example.com"

Standard tokenizer:  ["user", "example.com"]
Whitespace tokenizer: ["user@example.com"]
UAX URL Email:       ["user@example.com"]    // keeps emails intact
```

Pick the wrong tokenizer and your users can't find emails by searching for them.

### Stemming vs. Lemmatization

Stemming chops suffixes with rules: "running" → "run", "better" → "better" (misses it).

Lemmatization uses a dictionary: "running" → "run", "better" → "good" (correct but slower).

Tradeoff: stemming is faster and good enough for most search use cases. Lemmatization is more accurate but adds latency and dictionary maintenance overhead.

## Posting List Compression

At scale, posting lists get large. The term "the" in a 50M document corpus might have a posting list with 45M entries. Compression is essential.

### Delta Encoding + Variable-Byte Encoding

Since posting lists are sorted, store deltas instead of absolute IDs:

```
Original:  [1, 5, 9, 100, 105, 106]
Deltas:    [1, 4, 4, 91,  5,   1]
```

Deltas are small numbers that compress well with variable-byte (VByte) encoding — small values use 1 byte, large values use more.

### Frame of Reference (FOR) and PForDelta

Group doc IDs into blocks of 128 or 256. Within each block, compute the minimum value, subtract it, and bit-pack the remainders. This is what Lucene uses internally.

```
Block: [1000, 1003, 1005, 1007]
Min:   1000
Remainders: [0, 3, 5, 7]  → pack in 3 bits each
```

### Roaring Bitmaps

For very dense posting lists, a bitmap (one bit per possible doc ID) is more efficient than a list. Roaring bitmaps adaptively choose between arrays, bitmaps, and run-length encoding per chunk of 65,536 IDs.

## Query Execution on Inverted Indexes

### Boolean Queries

AND = posting list intersection. OR = posting list union. NOT = set difference.

Intersection of two sorted lists is O(n + m) with a merge-join:

```
"wireless" → [1, 3, 7, 15, 22]
"headphones" → [1, 5, 7, 10, 22, 30]

Result (AND): [1, 7, 22]
```

Optimization: start with the shortest posting list to minimize comparisons. Use skip pointers (every Nth entry stores a forward pointer) to jump ahead during intersection.

### Phrase Queries

"noise cancelling" as a phrase requires position data. Find docs containing both terms, then check if positions are adjacent:

```
Doc 1: "noise" at position [2], "cancelling" at position [3]  → adjacent ✓
Doc 3: "noise" at position [5], "cancelling" at position [1]  → not adjacent ✗
```

This is why positional indexes are 3-5x larger — but without them, you can't do phrase search.

## Tradeoffs and Design Decisions

### Index Size vs. Query Capability

| Feature | Index Size Impact | What It Enables |
|---|---|---|
| Positions | +200-400% | Phrase queries, highlighting |
| Term vectors | +100-200% | More-like-this, term statistics |
| Norms | +1 byte/field/doc | Length normalization in scoring |
| Doc values | +variable | Sorting, aggregations without fielddata |

### Write Speed vs. Read Speed

Inverted indexes are write-heavy to build but extremely fast to query. This is the fundamental tradeoff: you pay upfront at index time so that query time is near-instant.

Segment-based architectures (like Lucene) handle this by writing immutable segments and periodically merging them. New documents go to an in-memory buffer, get flushed as a new segment, and background merge keeps segment count manageable.

```
Write path:
  Document → Analyze → Buffer (in-memory) → Flush → New Segment → Background Merge

Read path:
  Query → Search all segments → Merge results
```

### Real-Time vs. Batch Indexing

Near-real-time search (Elasticsearch's `refresh_interval`, default 1s) means there's a delay between indexing a document and it being searchable. You can force a refresh, but that creates many small segments and hurts merge performance.

For systems that need true real-time (chat search, live feeds), you might combine an inverted index for historical data with a brute-force scan of a small in-memory buffer for the most recent documents.

## Interview Application

When an interviewer asks you to design a search system (e-commerce search, document search, log search), the inverted index is your foundational building block. Here's how to articulate it:

- "I'd use an inverted index as the core data structure — it maps terms to document posting lists, giving us O(posting list size) lookups instead of O(corpus size) scans."
- "The indexing pipeline matters: tokenization, lowercasing, stemming. These choices affect recall — if we stem 'running' to 'run', we match more documents but might lose precision."
- "For phrase queries like exact product names, we need positional indexes, which cost 3-5x more storage but enable adjacency checks."
- "At scale, posting list compression (delta encoding, PForDelta) keeps the index manageable — a 50M document index might be 10-20GB instead of 100GB+ uncompressed."
- "The write path uses immutable segments with background merging — this gives us near-real-time search with a configurable refresh interval, typically 1 second."

If the interviewer pushes on "why not just use Postgres full-text search?" — the answer is: Postgres GIN indexes are inverted indexes under the hood, but they lack the scoring sophistication (BM25), distributed query execution, and operational tooling that dedicated search engines provide. For a single-node, moderate-scale use case, Postgres `tsvector` is a legitimate choice. For anything beyond that, you want Elasticsearch or Solr.

---

## Related Articles

**Next in series:** [TF-IDF Scoring Explained](tf-idf-scoring-explained.md)

**See also:**
- [Geohash](../geospatial/geohash.md) — geohash as index key
- [Introduction to Bloom Filters](../probabilistic/bloom-filters-part-1.md) — skip non-matching segments