# System Design Domain Knowledge

A collection of in-depth articles covering essential system design concepts — written for engineers preparing for interviews and building real-world systems.

Every article follows the same structure: a concrete problem scenario, progressive technical depth, honest tradeoffs, and an interview application section.

---

<div id="progress-tracker"></div>

## 📚 Topics

### [Transactions](transactions/database-transactions.md)

How databases guarantee correctness — from single-row ACID to flash sale inventory under extreme concurrency.

| Article | Focus |
|---------|-------|
| [Database Transactions](transactions/database-transactions.md) | ACID properties, WAL, MVCC internals |
| [Database Isolation Levels](transactions/database-isolation-levels.md) | Read phenomena, isolation level tradeoffs |
| [Database Locking & Concurrency](transactions/database-locking-and-concurrency.md) | Shared/exclusive locks, deadlocks, lock granularity |
| [Pessimistic Locking Strategies](transactions/pessimistic-locking-strategies.md) | SELECT FOR UPDATE, NOWAIT, SKIP LOCKED |
| [Optimistic Locking Patterns](transactions/optimistic-locking-patterns.md) | Version columns, conditional writes, retry strategies |
| [Flash Sale Inventory Patterns](transactions/flash-sale-inventory-patterns.md) | Redis atomic ops, sharded counters, queue-based limiting |

### [Distributed Systems](distributed-systems/introduction-to-distributed-systems.md)

The fundamentals of building systems that span multiple machines — failures, consistency, and coordination.

| Article | Focus |
|---------|-------|
| [Introduction to Distributed Systems](distributed-systems/introduction-to-distributed-systems.md) | Why distribute, partial failure, network unreliability |
| [CAP and PACELC Theorem](distributed-systems/cap-and-pacelc-theorem.md) | Consistency vs availability tradeoffs |
| [Consistency Models](distributed-systems/consistency-models.md) | Linearizability through eventual consistency |
| [Distributed Transactions](distributed-systems/distributed-transactions.md) | 2PC, Saga pattern, choreography vs orchestration |
| [Failure Handling Patterns](distributed-systems/failure-handling-patterns.md) | Retries, circuit breakers, bulkheads, load shedding |
| [Consensus Algorithms](distributed-systems/consensus-algorithms.md) | Paxos, Raft, leader election |
| [Consistent Hashing](distributed-systems/consistent-hashing.md) | Hash ring, virtual nodes, minimal key remapping |

### [Geospatial Search](geospatial/geospatial-search-introduction.md)

How to index and query location data — from basic geohashing to production spatial index selection.

| Article | Focus |
|---------|-------|
| [Geospatial Search Introduction](geospatial/geospatial-search-introduction.md) | The core problem, coarse-to-fine filtering |
| [Geohash](geospatial/geohash.md) | Binary subdivision, prefix sharing, boundary problem |
| [QuadTrees](geospatial/quadtrees.md) | Recursive spatial subdivision, adaptive resolution |
| [H3 Hexagonal Indexing](geospatial/h3-hexagonal-indexing.md) | Uber's hex grid, k-ring, polyfill |
| [Space-Filling Curves & Hilbert's Curve](geospatial/space-filling-curves-and-hilberts-curve.md) | Z-order, Hilbert curve, locality preservation |
| [Google's S2 Library](geospatial/googles-s2-library.md) | Sphere projection, cell hierarchy, region covering |
| [Designing a Map Rendering Service](geospatial/designing-a-map-rendering-service.md) | Tile pyramids, vector tiles, caching strategy |
| [Choosing a Spatial Index](geospatial/choosing-a-spatial-index.md) | Decision matrix, scenario walkthroughs |

### [Search Engine Mechanics](search/inverted-index-fundamentals.md)

How search works under the hood — from inverted indexes to production Elasticsearch patterns.

| Article | Focus |
|---------|-------|
| [Inverted Index Fundamentals](search/inverted-index-fundamentals.md) | Term dictionaries, posting lists, compression |
| [TF-IDF Scoring Explained](search/tf-idf-scoring-explained.md) | Term frequency, inverse document frequency |
| [BM25 and Parameter Tuning](search/bm25-and-parameter-tuning.md) | Saturation, length normalization, k1/b tuning |
| [Elasticsearch Architecture Essentials](search/elasticsearch-architecture-essentials.md) | Shards, write/read paths, deep pagination |
| [Advanced Search Patterns](search/advanced-search-patterns.md) | Autocomplete, fuzzy matching, faceted search, hybrid |

### [Media Systems](media/video-transcoding-and-playback.md)

How video streaming and file storage work at scale.

| Article | Focus |
|---------|-------|
| [Video Transcoding and Playback](media/video-transcoding-and-playback.md) | Codecs, ABR streaming, HLS/DASH, CDN delivery |
| [File Chunking](media/file-chunking.md) | Fixed vs content-defined chunking, resumable uploads |

### [Probabilistic Data Structures](probabilistic/probabilistic-data-structures-overview.md)

Space-efficient data structures that trade perfect accuracy for massive memory savings.

| Article | Focus |
|---------|-------|
| [Overview](probabilistic/probabilistic-data-structures-overview.md) | Core tradeoff, error types, comparison |
| [Bloom Filters: Fundamentals](probabilistic/bloom-filters-part-1.md) | Hash functions, false positive math, sizing |
| [Bloom Filters: Advanced Techniques](probabilistic/bloom-filters-part-2.md) | Counting, scalable, Cuckoo filters |
| [Count-Min Sketch: Fundamentals](probabilistic/count-min-sketch-part-1.md) | Frequency estimation, conservative update |
| [Count-Min Sketch: Applications](probabilistic/count-min-sketch-part-2.md) | Heavy hitters, sliding windows, TinyLFU |
| [HyperLogLog: Fundamentals](probabilistic/hyperloglog-part-1.md) | Cardinality estimation, registers, harmonic mean |
| [HyperLogLog: System Design Applications](probabilistic/hyperloglog-part-2.md) | Merge property, real-time analytics, rollups |
