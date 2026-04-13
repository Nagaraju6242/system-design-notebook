# H3 Hexagonal Hierarchical Spatial Index

## The Problem

You're building Uber's surge pricing system. You need to divide a city into zones, measure supply and demand in each zone, and set prices accordingly. You try geohash — rectangular cells at precision 6 (~1.2 km). But rectangles have a problem: the distance from the center of a rectangle to its corners is 41% longer than to its edge midpoints. A driver at the corner of a cell is significantly farther from the cell center than a driver at the edge midpoint, yet both are "in the same zone."

```
Rectangle:                    Hexagon:
┌─────────────┐               ╱╲
│  1.41d       │             ╱    ╲
│    ╲        │           ╱   d    ╲
│  d  ● center│          │    ●     │
│             │           ╲   d    ╱
│             │             ╲    ╱
└─────────────┘               ╲╱

Corner distance = 1.41 × edge distance    All edges equidistant from center
```

For surge pricing, ETA estimation, and demand forecasting, this non-uniformity introduces systematic bias. Hexagons solve this — every neighbor is equidistant from the center, and the distance from center to any edge is uniform.

## Why Hexagons?

### The Tiling Problem

Only three regular polygons tile a plane: triangles, squares, and hexagons.

```
Triangles:        Squares:          Hexagons:
╱╲╱╲╱╲           ┌─┬─┬─┐           ╱╲╱╲╱╲
╲╱╲╱╲╱           ├─┼─┼─┤          ╱╲╱╲╱╲╱╲
╱╲╱╲╱╲           ├─┼─┼─┤          ╲╱╲╱╲╱╲╱
╲╱╲╱╲╱           └─┴─┴─┘           ╲╱╲╱╲╱
```

Hexagons win for spatial analysis because:

| Property | Triangle | Square | Hexagon |
|----------|----------|--------|---------|
| Neighbors | 3 (edge) + 9 (vertex) | 4 (edge) + 4 (vertex) | 6 (all edge) |
| Neighbor types | 2 (edge vs vertex) | 2 (edge vs diagonal) | 1 (all equivalent) |
| Center-to-edge uniformity | Poor | Moderate | Best |
| Area-to-perimeter ratio | Worst | Middle | Best (closest to circle) |
| Sampling bias | High | Moderate | Lowest |

The single neighbor type is crucial. With squares, you have edge-neighbors (4) and diagonal-neighbors (4) at different distances. With hexagons, all 6 neighbors are edge-neighbors at the same distance. This simplifies algorithms that aggregate or diffuse values across neighbors.

## H3: Uber's Hexagonal System

H3 is Uber's open-source hierarchical hexagonal indexing system. It projects the Earth onto an icosahedron (20-faced polyhedron), then tiles each face with hexagons at multiple resolutions.

### Resolution Levels

H3 defines 16 resolution levels (0-15):

| Resolution | Avg Hex Area | Avg Edge Length | Hex Count | Use Case |
|-----------|-------------|-----------------|-----------|----------|
| 0 | 4,357,449 km² | 1,108 km | 122 | Continental |
| 3 | 12,393 km² | 59 km | 41,162 | Country region |
| 5 | 253 km² | 8.5 km | 2,016,842 | Metro area |
| 7 | 5.16 km² | 1.2 km | 98,825,162 | Neighborhood |
| 9 | 0.105 km² | 174 m | 4,842,432,842 | City block |
| 11 | 0.002 km² | 24 m | ~2.4 × 10¹¹ | Building |
| 15 | 0.9 m² | 0.5 m | ~5.7 × 10¹⁴ | Sub-meter |

Each parent hexagon contains approximately 7 children (not exactly 7 due to the geometry of hexagonal tiling — this is a key detail).

### The Pentagon Problem

You can't tile a sphere with only hexagons. Euler's formula requires exactly 12 pentagons at each resolution level. H3 places these pentagons at the vertices of the icosahedron — mostly in oceans.

```
Icosahedron vertices (pentagon locations):
  - 10 in oceans
  - 2 on land (one near Sahara, one near Southeast Asia)

In practice: your code should handle pentagons, but they
rarely affect real-world applications.
```

Pentagons have 5 neighbors instead of 6. If your algorithm assumes 6 neighbors, it will break on pentagons. H3's API handles this transparently.

### H3 Cell Indexing

Each H3 cell is identified by a 64-bit integer:

```
Bits:  [4 mode][4 reserved][4 resolution][7 base cell][3×res bits per level]

Example at resolution 9:
  Mode:       1 (hexagon)
  Resolution: 9
  Base cell:  22 (one of 122 base cells)
  Digits:     0-6 per level indicating which child
```

```python
import h3

# Lat/lng to H3 index
cell = h3.latlng_to_cell(40.7128, -74.0060, 9)
# → '892a1008003ffff'

# Get cell center
lat, lng = h3.cell_to_latlng(cell)

# Get cell boundary (vertices)
boundary = h3.cell_to_boundary(cell)

# Get neighbors (k-ring)
neighbors = h3.grid_disk(cell, 1)  # 7 cells (center + 6 neighbors)
ring_only = h3.grid_ring(cell, 1)  # 6 cells (neighbors only)

# Get parent/children
parent = h3.cell_to_parent(cell, 7)      # Resolution 7 parent
children = h3.cell_to_children(cell, 11)  # Resolution 11 children
```

## Core Operations

### K-Ring (grid_disk)

The most common operation: find all cells within K steps of a center cell.

```
K=0:  Just the center cell (1 cell)

K=1:  Center + immediate neighbors (7 cells)
         ╱╲
       ╱╲╱╲╱╲
       ╲╱╲●╱╲╱
       ╱╲╱╲╱╲
         ╲╱

K=2:  Two rings out (19 cells)
           ╱╲
         ╱╲╱╲╱╲
       ╱╲╱╲╱╲╱╲╱╲
       ╲╱╲╱╲●╱╲╱╲╱
       ╱╲╱╲╱╲╱╲╱╲
         ╲╱╲╱╲╱
           ╲╱

Cell count at distance K: 3K² + 3K + 1
K=1: 7,  K=2: 19,  K=3: 37,  K=5: 91
```

### Polyfill

Convert a polygon into the set of H3 cells that cover it:

```python
# Define a polygon (GeoJSON format)
polygon = {
    "type": "Polygon",
    "coordinates": [[
        [-74.01, 40.70], [-73.97, 40.70],
        [-73.97, 40.75], [-74.01, 40.75],
        [-74.01, 40.70]
    ]]
}

# Get all resolution-9 cells covering this polygon
cells = h3.polygon_to_cells(
    h3.LatLngPoly(polygon["coordinates"][0]), 9
)
```

This is how you answer "how many drivers are in this surge zone?" — polyfill the zone, then count entities per cell.

### Hierarchical Aggregation

Roll up data from fine to coarse resolution:

```
Resolution 9 (city blocks):
  Cell A: 3 drivers    Cell B: 5 drivers    Cell C: 2 drivers
  Cell D: 1 driver     Cell E: 4 drivers    Cell F: 0 drivers
  Cell G: 2 drivers

Resolution 7 parent (neighborhood):
  Parent cell: 17 drivers (sum of ~49 children)
```

This enables multi-scale analysis. Zoom out on the map → aggregate to coarser resolution. Zoom in → show fine-grained data.

## Real-World Applications

### Surge Pricing (Uber)

```
1. Divide city into resolution-7 hexagons (~1.2 km)
2. Every 30 seconds, count:
   - Riders requesting rides in each cell
   - Available drivers in each cell (via k-ring overlap)
3. Supply/demand ratio per cell → surge multiplier
4. Smooth across neighbors to avoid sharp price boundaries
```

Hexagons make the smoothing natural — all 6 neighbors are equidistant, so a weighted average doesn't have directional bias.

### ETA Estimation

```
1. Pre-compute average travel speed per H3 cell per time-of-day
2. Route from A to B passes through cells C1, C2, ..., Cn
3. ETA = Σ (cell_distance / cell_speed) for each cell
4. Hexagonal cells give more uniform distance estimates
   than rectangular cells
```

### Delivery Zone Optimization

```
1. Polyfill delivery area at resolution 9
2. Assign each cell a delivery cost based on:
   - Distance from warehouse
   - Historical delivery time
   - Road network density
3. Group cells into delivery zones using clustering
4. Hexagonal neighbors make zone boundaries smoother
```

## H3 in Databases

### PostgreSQL with h3-pg Extension

```sql
CREATE EXTENSION h3;

ALTER TABLE restaurants ADD COLUMN h3_index h3index;
UPDATE restaurants SET h3_index = h3_lat_lng_to_cell(
    ST_Y(location)::float, ST_X(location)::float, 9
);
CREATE INDEX idx_h3 ON restaurants (h3_index);

-- Find restaurants near a point (k-ring query)
SELECT * FROM restaurants
WHERE h3_index = ANY(
    h3_grid_disk(h3_lat_lng_to_cell(40.7128, -74.0060, 9), 2)
);
```

### DynamoDB

```
Partition Key: h3_resolution_7 (coarse cell for partition distribution)
Sort Key:      h3_resolution_9 (fine cell for range queries within partition)

Query: PK = parent_cell → returns all entities in that neighborhood
Filter: SK IN (k_ring_cells) → narrow to specific area
```

### Redis

```bash
# Store entities by H3 cell in sets
SADD "h3:892a1008003ffff" "driver:123" "driver:456"
SADD "h3:892a1008007ffff" "driver:789"

# Query: get all drivers in k-ring
# (compute k-ring cells client-side, then SUNION)
SUNION "h3:892a1008003ffff" "h3:892a1008007ffff" ...
```

## Tradeoffs

### Strengths
- Uniform distance from center to all edges — no directional bias
- Clean hierarchical aggregation (parent/child relationships)
- K-ring gives a natural "search radius" with predictable cell counts
- Excellent for analytics: heatmaps, demand forecasting, zone-based pricing
- Open source with bindings for Python, Java, Go, JavaScript, C

### Weaknesses
- **Pentagon handling**: 12 pentagons per resolution level. Most code ignores them, but edge cases exist.
- **Not exactly 7 children**: The parent-child ratio is approximately 7, not exactly. Some children straddle parent boundaries. This complicates exact hierarchical rollups.
- **No native database support**: Unlike geohash (Redis, Elasticsearch), H3 requires an extension or client-side computation.
- **Aperture 7**: Each resolution step changes area by ~7x. You can't get a 2x or 3x resolution change — it's always ~7x. This can be too coarse or too fine for some use cases.
- **Complexity**: More complex than geohash. The icosahedral projection, pentagon handling, and non-exact hierarchy add implementation burden.

## H3 vs. Geohash vs. S2

| Aspect | H3 | Geohash | S2 |
|--------|----|---------|----|
| Cell shape | Hexagon | Rectangle | Quadrilateral |
| Neighbor uniformity | All equidistant | Edge vs corner | Near-uniform |
| Hierarchy ratio | ~7 children | 32 children | 4 children |
| Pole distortion | Low (icosahedron) | High (Mercator-like) | Low (cube) |
| Best for | Analytics, zones, ETAs | Simple proximity, DB-native | Global coverage, regions |
| Library needed | Yes (h3-py) | No (trivial to implement) | Yes (s2geometry) |

## Interview Application

### When to Propose H3

- Ride-sharing or delivery systems (Uber, DoorDash, Instacart)
- Surge pricing or dynamic zone-based pricing
- Demand forecasting and supply optimization
- Any problem where "aggregate metrics per geographic zone" is a core requirement

### How to Explain It

"I'd use H3, Uber's hexagonal indexing system. It tiles the globe with hexagons at multiple resolutions. Hexagons are better than rectangles for spatial analysis because every neighbor is equidistant from the center — there's no corner-vs-edge bias. For surge pricing, I'd use resolution 7 (~1.2 km hexagons), count supply and demand per cell, and smooth across the 6 neighbors for gradual price transitions."

### Key Follow-Ups

**Q: Why not just use geohash?**
"Geohash cells are rectangular, so the distance from center to corner is 41% more than center to edge. For ETA estimation and surge pricing, this creates systematic bias. Hexagons give uniform distance in all directions, which matters when you're aggregating metrics per zone."

**Q: How does the hierarchy work?**
"Each H3 cell has approximately 7 children at the next finer resolution. I can roll up block-level data (resolution 9) to neighborhood-level (resolution 7) by mapping each child to its parent. The 'approximately 7' is because hexagons don't subdivide perfectly — some children straddle boundaries — but H3 handles this in the library."

**Q: How do you handle the database layer?**
"H3 cells are 64-bit integers, so they fit in any database as a column with a B-tree index. For DynamoDB, I'd use the coarse resolution as partition key and fine resolution as sort key. For PostgreSQL, there's an h3-pg extension that adds native H3 functions. The k-ring computation happens client-side or in the extension, then I query for those specific cell IDs."

---

## Related Articles

**Next in series:** [Space-Filling Curves and Hilbert's Curve](space-filling-curves-and-hilberts-curve.md)

**Previous in series:** [QuadTrees](quadtrees.md)

**See also:**
- [Consistency Models](../distributed-systems/consistency-models.md) — consistency trade-offs in distributed spatial queries
