# Geospatial Search Introduction

## The Problem

You open Uber. Within seconds, the app shows five drivers near you, sorted by distance, with live ETAs. Behind that simple UI is a query: "find all drivers within 2 km of (37.7749, -122.4194)." Now multiply that by 20 million active riders making this query simultaneously, against 5 million drivers whose positions change every 4 seconds.

A naive approach — compute the distance from the rider to every driver in the database — is O(n) per query. At 5 million drivers, that's 5 million Haversine calculations per request. Under 20 million concurrent users, the system collapses.

This is the geospatial search problem: how do you efficiently find things near a point on Earth?

## Why Regular Indexes Don't Work

### The Two-Dimensional Trap

A B-tree index works beautifully for one-dimensional data. You can index `latitude` and quickly find all rows where `lat BETWEEN 37.77 AND 37.78`. But a proximity query needs *both* dimensions simultaneously.

```sql
-- This looks reasonable but performs terribly
SELECT * FROM drivers
WHERE lat BETWEEN 37.77 AND 37.78
  AND lng BETWEEN -122.42 AND -122.41;
```

The database uses one index (say latitude), filters to a band of rows, then scans that band linearly for the longitude condition. For a city-scale dataset, that band might contain hundreds of thousands of rows.

```
        lng →
   ┌──────────────────────────┐
   │          ░░░░░░          │  ← lat index narrows to this band
l  │          ░░░░░░          │
a  │          ░░▓▓░░          │  ← actual results are the ▓ region
t  │          ░░░░░░          │
↓  │          ░░░░░░          │
   └──────────────────────────┘

   ░ = rows scanned but discarded (wasted I/O)
   ▓ = actual matches
```

### The Bounding Box Problem

Even if you use a compound index on `(lat, lng)`, B-trees sort lexicographically. Points close in 2D space aren't necessarily close in the index. Two restaurants across the street from each other might be far apart in the B-tree if they differ in the first indexed dimension.

## The Core Insight: Reduce 2D to 1D

Every geospatial indexing technique solves the same fundamental problem: **map two-dimensional coordinates into a one-dimensional value that preserves spatial locality**. Points that are close on Earth should have similar index values.

```
  2D Space                    1D Index
  ┌─────────┐
  │ A     B  │               A ─── B ─── C ─── D
  │    C     │    ──────►    
  │       D  │               Close in 2D → Close in 1D
  └─────────┘
```

Once you have a 1D value, you can use a standard B-tree index, range queries, and all the database machinery that already exists.

## The Major Approaches

### 1. Geohash

Divide the world into a grid of rectangles. Encode each cell as a string. Longer strings = smaller cells = higher precision.

```
Precision 1:  "9"         → ~5000 km × 5000 km
Precision 5:  "9q8yy"     → ~5 km × 5 km
Precision 7:  "9q8yyk8"   → ~150 m × 150 m
```

**Best for**: Simple proximity queries, database-native support (PostGIS, Redis, DynamoDB). Easy to implement and reason about.

**Tradeoff**: Rectangular cells cause edge effects at cell boundaries. Two points 10 meters apart can have completely different geohash prefixes if they straddle a cell boundary.

### 2. QuadTrees

Recursively subdivide space into four quadrants. Subdivide further only where data is dense. Sparse ocean areas get large cells; Manhattan gets tiny ones.

```
┌───────┬───────┐       ┌───┬───┬───────┐
│       │       │       │ . │   │       │
│   .   │       │  ──►  ├───┼───┤       │
│       │       │       │   │ . │       │
├───────┼───────┤       ├───┴───┼───────┤
│       │   .   │       │       │   .   │
│       │       │       │       │       │
└───────┴───────┘       └───────┴───────┘
```

**Best for**: In-memory spatial indexes, game engines, adaptive resolution based on data density.

**Tradeoff**: Tree structure doesn't map to database indexes easily. Requires in-memory data structures. Rebalancing on updates is expensive.

### 3. S2 Geometry (Google)

Project Earth onto a cube, then onto six square faces. Subdivide each face using a Hilbert curve to produce cell IDs. The Hilbert curve preserves locality better than geohash's Z-order curve.

**Best for**: Global-scale systems, variable-precision region covering, Google-scale infrastructure.

**Tradeoff**: Complex to implement. Requires the S2 library. Overkill for simple "find nearby" queries.

### 4. H3 (Uber)

Tile the globe with hexagons at multiple resolutions. Hexagons have uniform distance from center to every edge (unlike rectangles), making distance calculations more consistent.

**Best for**: Ride-sharing, delivery ETAs, any system where uniform distance from cell center matters.

**Tradeoff**: Hexagons can't perfectly tile a sphere — some pentagons are needed. More complex than geohash.

## How These Map to Real Systems

| System | Technique | Why |
|--------|-----------|-----|
| Uber | H3 | Uniform distance for ETA calculations, surge pricing zones |
| Google Maps | S2 | Global coverage, variable precision for region queries |
| Redis GEO | Geohash | Simple, fits sorted set data structure |
| PostGIS | R-tree + GiST | General-purpose spatial queries including polygons |
| DynamoDB | Geohash | Fits partition key + sort key model |
| Elasticsearch | Geohash + BKD tree | Combines text search with spatial filtering |

## The Query Pattern

Regardless of which technique you use, the query pattern is almost always the same:

```
1. Convert query point to cell ID(s)
2. Find neighboring cells (to handle boundary effects)
3. Fetch all candidates from those cells (coarse filter)
4. Compute exact distance for each candidate (fine filter)
5. Sort by distance, apply limit
```

```
    ┌─────┬─────┬─────┐
    │     │  .  │     │    Step 1: User is in center cell
    ├─────┼─────┼─────┤    Step 2: Include 8 neighboring cells
    │  .  │  ★  │     │    Step 3: Fetch all points (.) from 9 cells
    ├─────┼─────┼─────┤    Step 4: Compute exact distance from ★
    │     │     │  .  │    Step 5: Return closest matches
    └─────┴─────┴─────┘
```

This two-phase approach (coarse filter → fine filter) is the universal pattern. The coarse filter uses the spatial index to eliminate 99%+ of candidates. The fine filter uses exact geometry on the small remaining set.

## Precision vs. Performance Tradeoff

Every spatial index has a resolution parameter. Higher resolution means:
- **Smaller cells** → fewer false positives in the coarse filter
- **More cells to query** → more index lookups
- **More storage** → longer keys, more index entries

```
Low precision:   1 cell lookup,  10,000 candidates, 9,950 discarded
Med precision:   9 cell lookups,    500 candidates,   450 discarded
High precision: 25 cell lookups,     50 candidates,     0 discarded
```

The sweet spot depends on data density. In rural Montana, low precision is fine — there are 3 restaurants in a 50 km radius. In Tokyo, you need high precision or you'll drown in candidates.

## Moving Objects: The Update Problem

Static data (restaurants, landmarks) is indexed once. Moving objects (drivers, delivery couriers) change position every few seconds. This creates an update storm:

```
5 million drivers × 1 update every 4 seconds = 1.25 million writes/sec
```

Strategies:
- **Write-optimized stores**: Redis with geohash (O(log n) update via sorted sets)
- **Temporal bucketing**: Only re-index when a driver moves to a different cell
- **Dual-write**: Keep a fast in-memory index for real-time queries, batch-update the persistent store

## Interview Application

### When to Bring Up Geospatial Indexing

Any problem involving "find nearby X" — Yelp, Uber, Tinder, Google Maps, delivery services, store locators.

### How to Structure Your Answer

1. **State the problem**: "We need to efficiently query points by proximity. A full table scan is O(n) per query, which won't scale."
2. **Introduce the concept**: "The key insight is converting 2D coordinates into a 1D index that preserves spatial locality."
3. **Pick a technique**: Choose geohash for simplicity, S2 for global scale, H3 for uniform-distance needs. Justify your choice.
4. **Describe the query flow**: Coarse filter (cell lookup) → fine filter (exact distance). This shows you understand it's not magic — there's still post-filtering.
5. **Address edge cases**: Boundary effects (query neighboring cells), moving objects (update frequency), precision tuning.

### Key Phrases That Signal Depth

- "Geohash has boundary discontinuities — two points 1 meter apart can have completely different prefixes if they're on a cell boundary. We handle this by querying the 8 neighboring cells."
- "We use a two-phase approach: the spatial index gives us candidates, then we compute exact Haversine distance for the final ranking."
- "For moving objects like drivers, we only re-index when they cross a cell boundary, which reduces write amplification by ~10x."

---

## Related Articles

**Next in series:** [Geohash](geohash.md)

**See also:**
- [Inverted Index Fundamentals](../search/inverted-index-fundamentals.md) — indexing is the shared concept behind spatial and text search
