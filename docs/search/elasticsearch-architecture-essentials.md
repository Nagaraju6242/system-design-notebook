# Elasticsearch Architecture Essentials

Your e-commerce platform has 200 million product listings. Users expect sub-200ms search with faceted filtering (brand, price range, rating), fuzzy matching for typos, and real-time indexing when sellers update listings. A single-node inverted index won't cut it — you need distributed search. Elasticsearch is the most widely deployed solution for this, and understanding its architecture is essential for any system design involving full-text search at scale.

## Core Concepts

### Documents and Indexes

An Elasticsearch index is a collection of JSON documents that share a schema (mapping). Think of it as a database table, but optimized for search instead of transactions.

```json
// A document in the "products" index
{
  "id": "prod_8821",
  "title": "Sony WH-1000XM5 Wireless Headphones",
  "description": "Industry-leading noise cancelling...",
  "brand": "Sony",
  "price": 349.99,
  "rating": 4.7,
  "categories": ["electronics", "headphones", "wireless"]
}
```

Each field has a type that determines how it's indexed:

| Field Type | Indexed As | Supports |
|---|---|---|
| `text` | Inverted index (analyzed) | Full-text search, scoring |
| `keyword` | Inverted index (exact value) | Filtering, aggregations, sorting |
| `integer/float` | BKD tree (point values) | Range queries, sorting |
| `date` | BKD tree | Range queries, date math |
| `nested` | Separate hidden documents | Querying arrays of objects |

### Nodes and Clusters

An Elasticsearch cluster is a group of nodes (servers) that collectively store data and handle queries.

```
┌─────────────────────── Cluster: "prod-search" ───────────────────────┐
│                                                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │  Node 1       │  │  Node 2       │  │  Node 3       │              │
│  │  (master +    │  │  (data)       │  │  (data)       │              │
│  │   data)       │  │               │  │               │              │
│  │  Shard 0 (P)  │  │  Shard 1 (P)  │  │  Shard 2 (P)  │             │
│  │  Shard 1 (R)  │  │  Shard 2 (R)  │  │  Shard 0 (R)  │             │
│  └──────────────┘  └──────────────┘  └──────────────┘               │
│                                                                       │
│  ┌──────────────┐  ┌──────────────┐                                  │
│  │  Node 4       │  │  Node 5       │                                 │
│  │  (coordinating │  │  (ingest)     │                                │
│  │   only)       │  │               │                                 │
│  └──────────────┘  └──────────────┘                                  │
└───────────────────────────────────────────────────────────────────────┘
```

Node roles:

| Role | Responsibility |
|---|---|
| Master-eligible | Cluster state management, index creation/deletion, shard allocation |
| Data | Stores shards, executes search and indexing operations |
| Coordinating | Routes requests, merges results from data nodes (every node does this by default) |
| Ingest | Pre-processes documents before indexing (pipelines) |

### Shards: The Unit of Distribution

An index is split into shards. Each shard is a self-contained Lucene index — a complete inverted index with its own segments.

```
Index: "products" (3 primary shards, 1 replica each)

Shard 0 (Primary) → Node 1     Shard 0 (Replica) → Node 3
Shard 1 (Primary) → Node 2     Shard 1 (Replica) → Node 1
Shard 2 (Primary) → Node 3     Shard 2 (Replica) → Node 2
```

Document-to-shard routing (default):

```
shard_number = hash(_routing) % number_of_primary_shards
```

By default, `_routing` = document `_id`. This means you **cannot change the number of primary shards** after index creation — it would change the routing and documents would be "lost" (routed to wrong shards).

## The Write Path

### Indexing a Document

```
Client → Coordinating Node → Primary Shard → Replica Shard(s) → Ack to Client

1. Client sends index request to any node (becomes coordinating node)
2. Coordinating node routes to correct primary shard (hash routing)
3. Primary shard:
   a. Validates the document
   b. Writes to translog (WAL for durability)
   c. Adds to in-memory buffer
   d. Returns success to coordinating node
4. Primary forwards to replica shard(s) in parallel
5. Once all in-sync replicas acknowledge, coordinating node responds to client
```

### Refresh: Making Documents Searchable

Documents in the in-memory buffer are NOT searchable. The `refresh` operation flushes the buffer into a new Lucene segment (on the filesystem cache, not disk).

```
In-memory buffer → [refresh] → New segment (searchable, in OS page cache)
```

Default refresh interval: **1 second**. This is why Elasticsearch is "near-real-time" — there's up to a 1-second delay between indexing and searchability.

Tradeoff: lower refresh interval = more real-time, but creates more small segments = more merge overhead.

### Flush: Durability to Disk

The translog grows until a `flush` occurs. Flush commits all segments to disk and clears the translog.

```
Translog + In-memory segments → [flush] → Committed segments on disk → Clear translog
```

Flush happens automatically when the translog exceeds 512MB or every 30 minutes.

### Segment Merging

Each refresh creates a new segment. Too many segments slow down search (each query must search every segment). Background merge combines small segments into larger ones.

```
Before merge:  [seg0: 100 docs] [seg1: 50 docs] [seg2: 80 docs] [seg3: 30 docs]
After merge:   [seg0_merged: 260 docs]
```

Merging also permanently removes deleted documents (deletes are just markers until merge).

## The Read Path

### Search Execution: Query Then Fetch

A search query executes in two phases:

```
Phase 1: QUERY (scatter)
  Coordinating node → broadcasts query to all relevant shards
  Each shard:
    1. Executes query against local Lucene index
    2. Returns top-N doc IDs + scores (NOT full documents)

Phase 2: FETCH (gather)
  Coordinating node:
    1. Merges and sorts all shard results globally
    2. Picks final top-N doc IDs
    3. Fetches full documents from the shards that hold them
    4. Returns results to client
```

```
Client
  │
  ▼
Coordinating Node
  │
  ├──query──→ Shard 0: returns [(doc_5, 8.2), (doc_12, 7.1)]
  ├──query──→ Shard 1: returns [(doc_88, 9.1), (doc_3, 6.5)]
  └──query──→ Shard 2: returns [(doc_41, 7.8), (doc_99, 5.2)]
  │
  ▼ merge + sort
  Global top results: [doc_88(9.1), doc_5(8.2), doc_41(7.8), doc_12(7.1)]
  │
  ├──fetch──→ Shard 1: get doc_88
  ├──fetch──→ Shard 0: get doc_5, doc_12
  └──fetch──→ Shard 2: get doc_41
  │
  ▼
Client receives final results
```

### Deep Pagination Problem

Requesting page 100 with 10 results per page means `from=990, size=10`. Each shard must return its top 1000 results (not just 10), and the coordinating node merges 3000 results to find the global top 990-1000.

At `from=100000`, each shard returns 100,010 results. This is O(shards × from+size) in memory and CPU.

Solutions:
- **`search_after`**: Cursor-based pagination using the sort values of the last result. Each shard only needs to return `size` results. Efficient but can't jump to arbitrary pages.
- **`scroll` API**: Creates a point-in-time snapshot for iterating through all results. Good for batch processing, not for user-facing pagination.
- **Point-in-time (PIT) + `search_after`**: The modern recommended approach. PIT freezes the index state, `search_after` paginates efficiently.

## Shard Sizing and Allocation

### How Many Shards?

The number of primary shards is fixed at index creation. Getting it wrong is painful.

Rules of thumb:
- Target **10-50 GB per shard** for most use cases
- Each shard has overhead (~500MB heap). 1000 shards × 500MB = 500GB heap just for shard metadata
- Fewer, larger shards = less overhead, but slower rebalancing and recovery
- More, smaller shards = better parallelism, but more overhead and merge pressure

### Oversharding: The Silent Killer

A common mistake: creating an index with 20 shards for 1GB of data. Each shard is 50MB — tiny segments that waste resources. The cluster spends more time managing shard metadata than actually searching.

Symptoms: high heap usage, slow cluster state updates, excessive merge activity.

### Time-Based Indexes and Rollover

For time-series data (logs, metrics, events), use index-per-time-period with rollover:

```
logs-2024.01.01  (3 shards, read-only, force-merged to 1 segment)
logs-2024.01.02  (3 shards, read-only, force-merged)
...
logs-2024.01.15  (3 shards, actively writing)
```

Benefits:
- Old indexes can be force-merged (1 segment = fastest search)
- Old indexes can move to cheaper storage (warm/cold tiers)
- Deleting old data = dropping an index (instant, no merge overhead)

## Relevance and Scoring

Elasticsearch uses BM25 by default (since version 5.0). Scores are computed per-shard, which means IDF values are local to each shard.

### The Per-Shard IDF Problem

If data is unevenly distributed across shards, IDF values differ per shard, and the same document might score differently depending on which shard it's on.

Solutions:
- **`dfs_query_then_fetch`**: Adds a pre-query phase that collects global term statistics from all shards. More accurate but adds a network round trip.
- **Sufficient data**: With enough documents per shard (>1000), local IDF approximates global IDF well enough.

## Cluster Resilience

### Split-Brain Prevention

If master-eligible nodes lose connectivity, you could get two masters (split-brain). Elasticsearch prevents this by requiring a quorum of master-eligible nodes to elect a master.

Minimum master-eligible nodes for production: **3** (quorum = 2).

### Shard Allocation Awareness

Configure rack/zone awareness so primary and replica shards land on different failure domains:

```json
// Node configuration
node.attr.zone: "us-east-1a"

// Index setting
{
  "index.routing.allocation.awareness.attributes": "zone"
}
```

This ensures that losing an entire availability zone doesn't lose both primary and replica of any shard.

## Tradeoffs Summary

| Decision | Tradeoff |
|---|---|
| More shards | Better write parallelism, but more overhead and coordination cost |
| Lower refresh interval | More real-time, but more small segments and merge pressure |
| More replicas | Better read throughput and fault tolerance, but more storage and write amplification |
| `dfs_query_then_fetch` | More accurate scoring, but extra network round trip |
| Nested fields | Correct object array queries, but each nested object is a hidden Lucene document |

## Interview Application

Elasticsearch architecture comes up in any "design a search system" interview. Here's how to structure your answer:

- "I'd use Elasticsearch for the search layer. Data is distributed across shards — each shard is a self-contained Lucene index. Documents are routed to shards by hashing the document ID, so the number of primary shards is fixed at index creation."
- "Writes go to the primary shard first, then replicate to replicas. Documents become searchable after a refresh (default 1 second), so it's near-real-time, not truly real-time."
- "Search uses a scatter-gather pattern: the coordinating node fans out the query to all shards, each returns its local top-N, and the coordinator merges globally. This is why deep pagination is expensive — each shard must return `from + size` results."
- "For sizing, I'd target 10-50GB per shard. Oversharding is a common mistake — too many small shards waste heap on metadata."

If asked about alternatives: "For simpler use cases, Postgres full-text search with GIN indexes works and avoids the operational complexity of a separate search cluster. For very large scale with strong consistency requirements, you might look at Apache Solr (similar architecture, different operational model). For pure vector/semantic search, purpose-built vector databases like Milvus or Pinecone might be more appropriate, though Elasticsearch now supports vector search too."

---

## Related Articles

**Next in series:** [Advanced Search Patterns](advanced-search-patterns.md)

**Previous in series:** [BM25 and Parameter Tuning](bm25-and-parameter-tuning.md)

**See also:**
- [Failure Handling Patterns](../distributed-systems/failure-handling-patterns.md) — cluster resilience
- [CAP and PACELC Theorem](../distributed-systems/cap-and-pacelc-theorem.md) — ES consistency tradeoffs