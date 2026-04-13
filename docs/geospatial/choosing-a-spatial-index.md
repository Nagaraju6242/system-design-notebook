# Choosing a Spatial Index

## The Problem

You're in a system design interview. The problem is "Design Uber" or "Design Yelp" or "Design a delivery tracking system." You know you need a spatial index. But which one? Geohash, QuadTree, S2, H3, R-tree? The interviewer is watching to see if you can make a reasoned choice — not just name-drop technologies.

This article gives you a decision framework.

## The Decision Matrix

| Factor | Geohash | QuadTree | S2 | H3 | R-tree (PostGIS) |
|--------|---------|----------|----|----|-------------------|
| Implementation complexity | Trivial | Moderate | High | Moderate | Built-in |
| Database native support | Redis, ES, DynamoDB | None | Spanner, BigQuery | PostgreSQL (ext) | PostGIS |
| Cell shape | Rectangle | Rectangle (adaptive) | Quadrilateral | Hexagon | Rectangle (MBR) |
| Adaptive resolution | No | Yes (data-driven) | Yes (query-driven) | No (fixed levels) | Yes (data-driven) |
| Moving objects | Good | Poor | Good | Good | Moderate |
| Region covering | Poor | N/A | Excellent | Good | Excellent |
| Distributed systems | Excellent | Poor | Good | Good | Poor |
| Pole/antimeridian | Broken | N/A (local) | Correct | Correct | Depends |

## Decision Tree

```
Start here:
│
├─ Are you using PostGIS?
│  └─ YES → Use PostGIS native spatial index (GiST/R-tree)
│           It handles everything. Don't overthink it.
│
├─ Do you need to cover arbitrary regions (geofencing, polygons)?
│  └─ YES → S2 (region coverer is unmatched)
│
├─ Is this for analytics/aggregation per zone (surge pricing, heatmaps)?
│  └─ YES → H3 (uniform hexagons, clean hierarchy)
│
├─ Is data density highly variable (cities vs. rural)?
│  └─ YES → QuadTree (adaptive resolution)
│           But only if data fits in memory on one machine.
│
├─ Do you need a distributed database (DynamoDB, Cassandra, HBase)?
│  └─ YES → Geohash or S2
│           Geohash if simple proximity is enough.
│           S2 if you need region covering or global uniformity.
│
└─ Default → Geohash
             Simplest, widest database support, good enough for most cases.
```

## Scenario Walkthroughs

### Scenario 1: "Design Yelp" (Find Nearby Restaurants)

**Data characteristics:**
- 200 million restaurants worldwide (static data, updates daily)
- Query: "find 20 closest restaurants to my location"
- Read-heavy (1000:1 read/write ratio)

**Best choice: Geohash on PostgreSQL/DynamoDB**

Why:
- Data is static — no update storm
- Simple proximity query — no complex region shapes
- Geohash prefix query + 8 neighbors covers the search area
- Works natively with DynamoDB (partition key = geohash prefix)

```
DynamoDB schema:
  PK: geohash_prefix (precision 5, ~5km cells)
  SK: full_geohash + restaurant_id
  
Query: 9 parallel GetItem calls (center + 8 neighbors)
Post-filter: Haversine distance, sort, limit 20
```

Why not others:
- QuadTree: Overkill for static data. Adds in-memory complexity.
- S2: More complex, no benefit for simple proximity.
- H3: No advantage over geohash for "find nearest" queries.

### Scenario 2: "Design Uber" (Real-Time Driver Matching)

**Data characteristics:**
- 5 million active drivers, positions update every 4 seconds
- Query: "find closest available driver to rider"
- Write-heavy (1.25M position updates/sec)
- Need surge pricing per zone

**Best choice: H3 for surge pricing, Geohash/Redis for driver matching**

Why H3 for surge:
- Surge pricing needs uniform zones — hexagons have no corner bias
- Hierarchical aggregation: block-level → neighborhood-level demand
- Clean neighbor relationships for smoothing prices across zones

Why Geohash/Redis for matching:
- Redis GEOSEARCH is O(log n) and handles 1M+ updates/sec
- Driver position update = GEOADD (sorted set update)
- Nearest driver = GEOSEARCH BYRADIUS

```
# Driver position update (1.25M/sec)
GEOADD drivers -74.006 40.7128 "driver:12345"

# Find nearest driver (rider request)
GEOSEARCH drivers FROMLONLAT -74.005 40.713 BYRADIUS 2 km ASC COUNT 5
```

Why not others:
- QuadTree: Can't handle 1.25M updates/sec without constant rebalancing.
- S2: Overkill for driver matching. Redis GEO is simpler and faster.
- PostGIS: Too slow for 1.25M writes/sec.

### Scenario 3: "Design Google Maps Search"

**Data characteristics:**
- Billions of POIs worldwide
- Queries span the globe (Tokyo to São Paulo)
- Need to search within visible map viewport (arbitrary rectangle)
- Need to search within drawn polygon (geofencing)

**Best choice: S2**

Why:
- Global coverage without pole/antimeridian issues
- Region covering handles arbitrary viewports and polygons efficiently
- Hilbert curve ordering gives optimal range scan performance
- Google uses S2 internally for exactly this use case

```
Query: "coffee shops in this viewport"
1. Compute S2 covering for viewport → 10-15 cells
2. Each cell → range query on s2_cell_id column
3. Post-filter by exact viewport intersection
4. Return results
```

Why not others:
- Geohash: Breaks at antimeridian, distorted at poles, poor region covering.
- H3: Better for analytics than search. No region covering advantage.
- QuadTree: Doesn't scale to billions of points across distributed storage.

### Scenario 4: "Design a Delivery Zone System"

**Data characteristics:**
- Define delivery zones as polygons
- Determine which zone a given address falls in
- Calculate delivery fees based on zone
- Aggregate order volume per zone for capacity planning

**Best choice: H3 + S2 hybrid**

Why:
- S2 for point-in-polygon: "which delivery zone is this address in?"
- H3 for aggregation: "how many orders per zone per hour?"
- H3 hexagons give uniform area for fair capacity comparison

```
Setup:
1. Define delivery zone polygons
2. S2 covering for each polygon → store in lookup table
3. H3 polyfill each zone at resolution 9 → store cell-to-zone mapping

Point-in-zone query:
1. Compute S2 cell for address
2. Look up which zone's covering contains this cell

Aggregation:
1. Each order tagged with H3 cell at resolution 9
2. Roll up to resolution 7 for zone-level metrics
```

### Scenario 5: "Design a Game World" (In-Memory Spatial Index)

**Data characteristics:**
- 100K-1M entities in a 2D game world
- Collision detection, visibility queries
- All in memory, single server
- Entities move constantly

**Best choice: QuadTree**

Why:
- In-memory — no database overhead
- Adaptive resolution — dense battle areas get fine cells, empty areas stay coarse
- Range queries for collision detection are O(log n)
- Well-understood algorithm with simple implementation

Why not others:
- Geohash: Fixed grid wastes resolution in sparse areas.
- S2/H3: Designed for Earth coordinates, overkill for a game world.

## The "It Depends" Factors

### Factor 1: Database Choice

Your database often dictates the spatial index:

| Database | Native Spatial | Best Index |
|----------|---------------|------------|
| PostgreSQL + PostGIS | Full spatial support | GiST (R-tree). Just use it. |
| Redis | GEOSEARCH | Geohash (built-in) |
| DynamoDB | None | Geohash (PK/SK model) |
| Elasticsearch | geo_point, geo_shape | Geohash + BKD tree (built-in) |
| MongoDB | 2dsphere | GeoJSON with S2 (built-in) |
| Spanner | GEOGRAPHY | S2 (native) |
| Cassandra | None | Geohash or S2 (manual) |

### Factor 2: Read vs. Write Ratio

```
Read-heavy (Yelp, Google Maps):
  → Any index works. Optimize for query performance.
  → S2 or R-tree for best query efficiency.

Write-heavy (Uber drivers, delivery tracking):
  → Need fast updates. Redis GEO (geohash) or H3 cell reassignment.
  → Avoid QuadTree (rebalancing) and R-tree (node splits).

Balanced (social check-ins, fleet management):
  → Geohash is the safe default.
```

### Factor 3: Query Shape

```
Point radius ("find within 5 km"):
  → Geohash (9-cell query) or Redis GEOSEARCH

Rectangle ("map viewport"):
  → Geohash (compute covering cells) or R-tree (native bbox query)

Polygon ("delivery zone", "geofence"):
  → S2 (region coverer) or PostGIS (ST_Contains)

K-nearest ("find 10 closest"):
  → QuadTree (in-memory) or PostGIS (KNN operator <->)
```

### Factor 4: Scale

```
< 1M points, single server:
  → PostGIS or in-memory QuadTree. Don't overthink it.

1M - 100M points, few servers:
  → Geohash on PostgreSQL/Elasticsearch. Standard approach.

100M+ points, distributed:
  → S2 on Spanner/BigQuery, or Geohash on DynamoDB/Cassandra.
  → Need to shard spatially. Geohash prefix = natural shard key.

Billions of points, global:
  → S2. It's what Google built it for.
```

## Anti-Patterns

### 1. Using PostGIS and Adding Geohash

If you're already on PostGIS, its native GiST index handles spatial queries efficiently. Adding a geohash column is redundant complexity.

### 2. QuadTree in a Distributed System

QuadTrees are single-machine data structures. Distributing a tree across nodes requires complex partitioning and cross-node queries. Use a grid-based index instead.

### 3. S2 for a Simple "Find Nearby" on DynamoDB

S2's region coverer is powerful but unnecessary for basic proximity. Geohash with 9-cell queries is simpler, faster to implement, and sufficient.

### 4. H3 Without Analytics

H3's advantage is uniform hexagonal zones for aggregation. If you're just doing point lookups, geohash is simpler with the same performance.

### 5. Ignoring the Fine Filter

Every spatial index is a coarse filter. You always need a fine filter (exact distance calculation) on the candidates. Skipping this returns incorrect results — points in the cell but outside the actual search radius.

## Interview Application

### The Framework

When the interviewer asks "how would you handle location-based queries?":

1. **State the query type**: proximity, viewport, polygon, or KNN
2. **State the data characteristics**: size, update frequency, distribution
3. **Pick an index with reasoning**: "Given that we have 200M static POIs and need simple proximity queries, I'd use geohash because..."
4. **Describe the query flow**: coarse filter → fine filter → sort → limit
5. **Address edge cases**: boundary effects, moving objects, scale

### The One-Sentence Answers

- **Geohash**: "Simple, works everywhere, good enough for most proximity queries."
- **QuadTree**: "Adaptive resolution for variable-density data, but in-memory only."
- **S2**: "Best for global scale and arbitrary region covering, but complex."
- **H3**: "Best for zone-based analytics where uniform distance matters."
- **R-tree/PostGIS**: "If you're on PostgreSQL, just use PostGIS — it handles everything."

### Showing Depth

The interviewer is impressed when you:
- Explain *why* you chose one index over another (not just what it is)
- Mention the coarse-filter → fine-filter pattern
- Acknowledge tradeoffs ("geohash has boundary effects, so we query 9 cells")
- Know when to use the database's built-in spatial support vs. rolling your own
- Can estimate the numbers (cell sizes, query counts, storage)

---

## Related Articles

**Previous in series:** [Designing a Map Rendering Service](designing-a-map-rendering-service.md)

**See also:**
- [Elasticsearch Architecture Essentials](../search/elasticsearch-architecture-essentials.md) — Elasticsearch geo queries use spatial indexes under the hood
