# Google's S2 Library

## The Problem

You're building Google Maps' search backend. A user in Tokyo searches for "coffee shops." You need to find all coffee shops within 500 meters. Sounds simple — until you consider:

1. Tokyo is at 35°N latitude, where a degree of longitude is ~91 km (vs. ~111 km at the equator). Geohash cells are distorted.
2. The search area might straddle the antimeridian (180° longitude). Geohash breaks here — `zbpbp` and `b0000` are adjacent on Earth but maximally distant in the index.
3. You need to cover the 500m circle with index cells. Geohash requires many small rectangles to approximate a circle. You want a system that can cover arbitrary regions efficiently.

Google built S2 to solve all of these problems at planetary scale.

## The S2 Projection: Earth → Cube → Hilbert Curve

### Step 1: Sphere to Cube

S2 projects the Earth's surface onto the six faces of a cube. Each point on the sphere maps to a point on one of the six faces.

```
        ┌─────┐
        │  2  │         Face 0: front  (+x)
   ┌────┼─────┼────┐    Face 1: right  (+y)
   │ 5  │  0  │  3 │    Face 2: top    (+z)
   └────┼─────┼────┘    Face 3: back   (-x)
        │  4  │         Face 4: bottom (-z)
        ├─────┤         Face 5: left   (-y)
        │  1  │
        └─────┘
```

The projection uses a quadratic transform (not linear) to minimize area distortion. The ratio of largest to smallest cell area at the same level is only ~2.1x (vs. ~5.4x for a linear projection). This means cells are relatively uniform in size across the globe.

### Step 2: Face to Hilbert Curve

Each cube face is a unit square [0,1] × [0,1]. S2 applies a Hilbert curve to this square, converting the 2D position to a 1D value. This gives a 64-bit cell ID:

```
Bits: [3 face][2×level bits for each of 30 levels][1 sentinel bit]

Face:     3 bits (0-5, which cube face)
Position: up to 60 bits (Hilbert curve position on that face)
Sentinel: 1 bit (marks the end of the meaningful bits)
```

### Step 3: Hierarchical Cells

Each face is recursively subdivided into 4 children (quadtree on the Hilbert curve), giving 30 levels of hierarchy:

| Level | Cell Count | Avg Area | Avg Edge | Use Case |
|-------|-----------|----------|----------|----------|
| 0 | 6 | 85M km² | 7,842 km | Hemisphere |
| 5 | 6,144 | 13,900 km² | 118 km | Country region |
| 10 | 6,291,456 | 13.5 km² | 3.7 km | City |
| 14 | 1,610,612,736 | 0.05 km² | 228 m | City block |
| 18 | ~4.1 × 10¹¹ | 0.2 m² | 14 m | Building |
| 23 | ~1.1 × 10¹⁴ | 0.8 mm² | 0.9 m | Sub-meter |
| 30 | ~6.9 × 10¹⁸ | ~1 cm² | ~1 cm | Maximum |

Each parent has exactly 4 children. The cell ID encodes the full path from root to leaf.

## S2 Cell IDs

### Structure

```
Cell ID for level 14 cell on face 2:

  010 [28 pairs of bits] 1 [remaining bits = 0]
  ^^^                     ^
  face 2                  sentinel bit

The sentinel bit is a 1 followed by zeros.
It marks where the meaningful bits end.
Level = (number of bits after face) / 2
```

### Key Properties

1. **Parent-child by bit manipulation**: A cell's parent is obtained by clearing the last two position bits. Children are obtained by appending 00, 01, 10, 11.

2. **Range containment**: Cell A contains cell B if and only if A's ID range [A_min, A_max] contains B's ID. This makes containment checks a simple integer comparison.

3. **Hilbert ordering**: Cells at the same level, sorted by ID, follow the Hilbert curve. Range scans on cell IDs return spatially compact results.

```python
from s2geometry import s2

# Lat/lng to S2 cell
latlng = s2.S2LatLng.FromDegrees(40.7128, -74.0060)
cell_id = s2.S2CellId(latlng)

# Get cell at specific level
cell_14 = cell_id.parent(14)

# Get cell ID as integer
print(cell_14.id())  # 64-bit integer

# Get parent and children
parent = cell_14.parent()
children = [cell_14.child(i) for i in range(4)]

# Get neighbors
neighbors = cell_14.GetEdgeNeighbors()  # 4 edge neighbors
```

## Region Covering: S2's Killer Feature

The most powerful S2 operation is **region covering** — given an arbitrary shape (circle, polygon, rectangle), find the minimal set of S2 cells that cover it.

### How It Works

```
Input: Circle centered at (40.71, -74.00), radius 500m

S2 Region Coverer:
  - Start with large cells that intersect the circle
  - Subdivide cells that partially overlap the boundary
  - Stop when cells are small enough (min_level) or
    the covering has enough cells (max_cells)

Output: A set of 8-15 S2 cell IDs that cover the circle
```

```
    ┌─────────────────────────┐
    │         ╱──────╲        │
    │  ┌────╱──┬──────╲───┐  │
    │  │   ╱   │       ╲  │  │
    │  │  │    │    ●   │  │  │  ● = center
    │  │   ╲   │       ╱  │  │
    │  └────╲──┴──────╱───┘  │  Inner cells: fully inside circle
    │         ╲──────╱        │  Boundary cells: partially overlap
    └─────────────────────────┘  (use finer level at boundary)
```

```python
from s2geometry import s2

# Define a circular region
center = s2.S2LatLng.FromDegrees(40.7128, -74.0060)
cap = s2.S2Cap(center.ToPoint(),
               s2.S2Earth.ToAngle(s2.util.units.Meters(500)))

# Configure the coverer
coverer = s2.S2RegionCoverer()
coverer.set_max_cells(20)       # Max cells in covering
coverer.set_min_level(10)       # Coarsest allowed cell
coverer.set_max_level(16)       # Finest allowed cell

# Get the covering
covering = coverer.GetCovering(cap)
# Returns ~12 S2CellIds of varying levels
```

### Why This Is Powerful

With geohash, covering a circle requires:
1. Pick a precision level
2. Find all cells at that level that intersect the circle
3. At precision 6 (~1.2 km), a 500m circle might need 4-9 cells
4. Each cell is the same size — you over-fetch at the boundary

With S2 covering:
1. Interior cells are large (fewer lookups)
2. Boundary cells are small (less over-fetch)
3. The covering adapts to the shape
4. Total cells is bounded by `max_cells`

```
Geohash covering of a circle:     S2 covering of a circle:
┌──┬──┬──┬──┐                     ┌──────┬──────┐
│░░│░░│░░│░░│  All same size      │      │  ┌─┐ │
├──┼──┼──┼──┤  9 cells            │      │  └─┘ │  Mixed sizes
│░░│██│██│░░│  Lots of over-fetch ├──┬───┤──────┤  8 cells
├──┼──┼──┼──┤                     │  │███│      │  Minimal over-fetch
│░░│░░│░░│░░│                     │  │███│      │
└──┴──┴──┴──┘                     └──┴───┴──────┘

░ = over-fetched area              Small cells only at boundary
█ = actual search area             Large cells in interior
```

## S2 in Database Queries

### The Covering-to-Range-Query Pipeline

```
1. Compute S2 covering for search region → [cell1, cell2, ..., cellN]
2. Convert each cell to an ID range: [cell.range_min(), cell.range_max()]
3. Query database with OR of range conditions:

SELECT * FROM places
WHERE s2_cell_id BETWEEN 3456789000 AND 3456789999
   OR s2_cell_id BETWEEN 3456800000 AND 3456800999
   OR ...
```

Because S2 uses Hilbert ordering, each range is spatially compact. The database reads contiguous index pages.

### Google Cloud Spanner

Spanner uses S2 natively for its `GEOGRAPHY` type. Under the hood, spatial queries are converted to S2 cell range scans on the primary index.

```sql
-- Spanner with S2 (conceptual)
CREATE TABLE places (
    place_id INT64,
    name STRING(MAX),
    location GEOGRAPHY,
    s2_cell_id INT64,  -- Pre-computed S2 cell ID
) PRIMARY KEY (s2_cell_id, place_id);

-- Proximity query becomes range scans
SELECT * FROM places
WHERE s2_cell_id BETWEEN @range1_min AND @range1_max
   OR s2_cell_id BETWEEN @range2_min AND @range2_max;
```

### BigQuery

BigQuery's `ST_` functions use S2 internally:

```sql
SELECT name, ST_DISTANCE(location, ST_GEOGPOINT(-74.006, 40.7128)) as dist
FROM `dataset.places`
WHERE ST_DWITHIN(location, ST_GEOGPOINT(-74.006, 40.7128), 500)
ORDER BY dist
LIMIT 20;
```

## S2 vs. Geohash: The Technical Differences

### Projection Distortion

```
Geohash at 60°N latitude:
  Cell width:  ~600m (longitude degrees are shorter)
  Cell height: ~1200m (latitude degrees unchanged)
  Aspect ratio: 1:2 — elongated rectangle

S2 at 60°N latitude:
  Cell width:  ~900m
  Cell height: ~1000m
  Aspect ratio: ~1:1.1 — nearly square
```

S2's cube projection distributes distortion evenly. The worst-case area ratio between cells at the same level is 2.1x. For geohash, it's unbounded as you approach the poles.

### Antimeridian and Poles

Geohash breaks at the antimeridian (180° longitude) and has degenerate cells at the poles. S2 handles both seamlessly because the cube projection has no singularities.

### Covering Efficiency

For a circular region of radius R:

| Metric | Geohash | S2 |
|--------|---------|-----|
| Cells needed | 9 (fixed grid) | 8-15 (adaptive) |
| Over-fetch area | ~40% of total area | ~5-10% |
| Range scans | 9 | 8-15 (but each is tighter) |
| Total data read | Higher | Lower |

## Tradeoffs

### Strengths
- Best locality preservation (Hilbert curve)
- Minimal projection distortion (cube projection)
- Adaptive region covering (mixed cell levels)
- Handles poles and antimeridian correctly
- 30 levels of hierarchy — extremely fine-grained control
- Used in production at Google scale (Maps, Spanner, BigQuery)

### Weaknesses
- **Complexity**: The library is non-trivial. The C++ implementation is ~40K lines. Understanding the internals requires solid computational geometry knowledge.
- **Library dependency**: You need the S2 library. It's available in C++, Java, Go, and Python, but it's not a simple algorithm you can implement in 20 lines.
- **Quadrilateral cells**: Cells are quadrilaterals, not rectangles or hexagons. They're nearly square near the equator but become more trapezoidal near cube face edges.
- **4-child hierarchy**: Each level is 4x finer. You can't get 2x or 7x steps. For some use cases, this granularity is too coarse or too fine.
- **Limited native DB support**: Outside Google Cloud (Spanner, BigQuery), you need to manage S2 cell IDs yourself.

## When to Use S2

| Scenario | Use S2? | Why |
|----------|---------|-----|
| Global service (Google Maps scale) | Yes | Uniform cells worldwide, no pole/antimeridian issues |
| Simple "find nearby" on PostgreSQL | No | PostGIS with geohash or R-tree is simpler |
| Region covering (geofencing) | Yes | Adaptive covering is S2's killer feature |
| Analytics/aggregation by zone | Maybe | H3 hexagons are better for uniform-distance aggregation |
| DynamoDB proximity search | Maybe | Geohash is simpler; S2 is better if you need covering |
| Ride-sharing ETAs | No | H3 is purpose-built for this |

## Interview Application

### When to Propose S2

- "Design Google Maps" or any global-scale location service
- Geofencing systems (is this point inside this region?)
- Any problem where the interviewer pushes on "what about near the poles?" or "what about the international date line?"
- When you need to cover arbitrary polygons efficiently

### How to Explain It

"I'd use Google's S2 library. It projects the Earth onto a cube, then applies a Hilbert curve to each face to generate cell IDs. This gives us three advantages over geohash: first, cells are nearly uniform in size worldwide because the cube projection minimizes distortion. Second, the Hilbert curve preserves spatial locality better than geohash's Z-order curve, so range scans on cell IDs return spatially compact results. Third, S2's region coverer can approximate any shape with a mix of large interior cells and small boundary cells, minimizing over-fetch."

### Key Follow-Ups

**Q: Why not just use geohash?**
"Geohash works well for simple proximity queries in a single region. S2 is better when you need global coverage (geohash distorts near poles), efficient region covering (geohash uses fixed-size cells), or when you're on Google Cloud where S2 is native."

**Q: How does the database query work?**
"I compute an S2 covering for the search region — say 12 cells of varying sizes. Each cell maps to an integer range [min_id, max_id]. The database query is an OR of 12 range conditions on the s2_cell_id column. Because of Hilbert ordering, each range reads contiguous index pages. The total I/O is proportional to the actual search area, not the bounding box."

**Q: What's the overhead of the S2 library?**
"Computing a cell ID from lat/lng is O(1) — a few floating-point operations and bit manipulations. Computing a region covering is O(max_cells × log(max_cells)). The library adds ~2MB to the binary. The main cost is complexity — the team needs to understand S2 concepts, and debugging cell ID issues requires familiarity with the projection."

---

## Related Articles

**Next in series:** [Designing a Map Rendering Service](designing-a-map-rendering-service.md)

**Previous in series:** [Space-Filling Curves and Hilbert's Curve](space-filling-curves-and-hilberts-curve.md)

**See also:**
- [Space-Filling Curves and Hilbert's Curve](space-filling-curves-and-hilberts-curve.md) — the mathematical foundation behind S2's spatial indexing
