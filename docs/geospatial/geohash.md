# Geohash

## The Problem

You're building a restaurant finder. Your database has 10 million restaurants worldwide, each with a latitude and longitude. A user at (40.7128, -74.0060) — Manhattan — wants the 20 closest restaurants. You need to answer this in under 50ms.

You can't index latitude and longitude independently — a B-tree on `lat` narrows to a horizontal band, then you linearly scan for `lng`. What you need is a single value that encodes *both* dimensions and can be indexed with a standard B-tree.

That's exactly what geohash does.

## How Geohash Works

### Step 1: Binary Subdivision

Geohash works by repeatedly bisecting the world, alternating between longitude and latitude.

Start with the entire world:
- Longitude: [-180, 180]
- Latitude: [-90, 90]

For a point at (40.7128, -74.0060):

```
Bit 1 (longitude): Is -74.006 in [-180, 0) or [0, 180]?
       → [-180, 0) → bit = 0, narrow to [-180, 0]

Bit 2 (latitude):  Is 40.7128 in [-90, 0) or [0, 90]?
       → [0, 90] → bit = 1, narrow to [0, 90]

Bit 3 (longitude): Is -74.006 in [-180, -90) or [-90, 0]?
       → [-90, 0] → bit = 1, narrow to [-90, 0]

Bit 4 (latitude):  Is 40.7128 in [0, 45) or [45, 90]?
       → [0, 45) → bit = 0, narrow to [0, 45]

... continue for desired precision
```

The bits interleave: `longitude, latitude, longitude, latitude, ...`

```
Bits so far: 0  1  1  0  ...
             │  │  │  │
             │  │  │  └── lat bit 2
             │  │  └───── lng bit 2
             │  └──────── lat bit 1
             └─────────── lng bit 1
```

### Step 2: Base-32 Encoding

Every 5 bits map to a character using a custom base-32 alphabet:

```
0  = 0     8  = s    16 = h    24 = w
1  = 1     9  = t    17 = j    25 = x
2  = 2    10  = u    18 = k    26 = y
3  = 3    11  = v    19 = m    27 = z
4  = 4    12  = w    20 = n
5  = 5    13  = x    21 = p
6  = 6    14  = y    22 = q
7  = 7    15  = z    23 = r
```

Wait — the actual base-32 alphabet for geohash is:

```
0123456789bcdefghjkmnpqrstuvwxyz
```

(Note: `a`, `i`, `l`, `o` are excluded to avoid confusion with digits.)

Manhattan (40.7128, -74.0060) encodes to approximately `dr5ru7`.

### Step 3: Precision Levels

Each character adds 5 bits of precision, narrowing the cell:

| Characters | Bits | Cell Width | Cell Height | Use Case |
|-----------|------|------------|-------------|----------|
| 1 | 5 | ~5,000 km | ~5,000 km | Continent |
| 2 | 10 | ~1,250 km | ~625 km | Large country region |
| 3 | 15 | ~156 km | ~156 km | State/province |
| 4 | 20 | ~39 km | ~19.5 km | City |
| 5 | 25 | ~5 km | ~5 km | Neighborhood |
| 6 | 30 | ~1.2 km | ~0.6 km | Street level |
| 7 | 35 | ~150 m | ~150 m | Building |
| 8 | 40 | ~38 m | ~19 m | Precise location |

## The Key Property: Prefix Sharing

Points in the same cell share a geohash prefix. This is what makes it indexable:

```
Times Square:    dr5ru6
Empire State:    dr5ruk
Central Park:    dr5rvm
Brooklyn:        dr5x1p
San Francisco:   9q8yy5
```

Times Square and Empire State share `dr5ru` — they're in the same ~5 km cell. A prefix query `WHERE geohash LIKE 'dr5ru%'` finds all points in that neighborhood using a B-tree range scan.

```sql
-- Find restaurants near Times Square (precision 5 = ~5km cell)
SELECT * FROM restaurants
WHERE geohash LIKE 'dr5ru%';

-- Equivalent range query (more efficient)
SELECT * FROM restaurants
WHERE geohash >= 'dr5ru' AND geohash < 'dr5rv';
```

## The Boundary Problem

Here's the critical flaw. Consider two points 10 meters apart, but on opposite sides of a cell boundary:

```
    ┌──────────────┬──────────────┐
    │              │              │
    │   Cell       │   Cell       │
    │   "dr5ru"    │   "dr5rv"    │
    │         A ●──┼──● B        │
    │              │              │
    └──────────────┴──────────────┘

    A and B are 10m apart but share NO common prefix.
    A query for "dr5ru%" misses B entirely.
```

### Solution: Query Neighboring Cells

For any geohash cell, compute its 8 neighbors and query all 9 cells:

```
    ┌────────┬────────┬────────┐
    │ dr5rg  │ dr5ru  │ dr5rv  │
    ├────────┼────────┼────────┤
    │ dr5rf  │ dr5rs  │ dr5rt  │  ← Query all 9 cells
    ├────────┼────────┼────────┤
    │ dr5rd  │ dr5re  │ dr5rk  │
    └────────┴────────┴────────┘
```

Computing neighbors is straightforward — increment/decrement the binary representation and re-encode.

```python
def geohash_neighbors(ghash):
    """Return the 8 neighboring geohash cells."""
    lat, lng = decode(ghash)
    lat_err, lng_err = decode_error(ghash)
    
    neighbors = []
    for dlat in [-1, 0, 1]:
        for dlng in [-1, 0, 1]:
            if dlat == 0 and dlng == 0:
                continue
            n = encode(lat + dlat * lat_err * 2,
                       lng + dlng * lng_err * 2,
                       precision=len(ghash))
            neighbors.append(n)
    return neighbors
```

## Geohash in Practice

### Redis GEO Commands

Redis stores geospatial data using geohash internally, backed by a sorted set:

```bash
# Add locations
GEOADD restaurants -74.006 40.7128 "times_square_deli"
GEOADD restaurants -73.985 40.7484 "empire_state_cafe"

# Find within radius
GEOSEARCH restaurants FROMLONLAT -74.006 40.7128 BYRADIUS 2 km ASC COUNT 20

# Get geohash
GEOHASH restaurants "times_square_deli"
# → "dr5ru6j3u0"
```

Under the hood, Redis converts the geohash to a 52-bit integer score in the sorted set. `GEOSEARCH` computes the bounding cells, does range queries on the sorted set, then filters by exact distance.

### DynamoDB

Geohash fits DynamoDB's key model naturally:

```
Partition Key: geohash prefix (e.g., "dr5ru")
Sort Key:      full geohash + entity ID

Query: PK = "dr5ru" returns all items in that cell
```

For neighboring cells, you issue 9 parallel queries (one per cell). DynamoDB handles this efficiently since each is a single partition lookup.

### PostgreSQL with PostGIS

```sql
-- PostGIS uses R-trees internally, but you can use geohash too
CREATE INDEX idx_restaurants_geohash 
ON restaurants (ST_GeoHash(location, 8));

-- Or use native PostGIS spatial index (usually better)
CREATE INDEX idx_restaurants_gist 
ON restaurants USING GIST (location);
```

## Geohash for Range Queries

Geohash excels at "find everything in this rectangular region" — useful for map viewport queries:

```
User's visible map viewport:
  SW corner: (40.70, -74.02)  → geohash "dr5rs"
  NE corner: (40.75, -73.97)  → geohash "dr5rv"

Find all geohash cells that overlap this viewport,
then query for each cell prefix.
```

For irregular regions (polygons, circles), you compute the set of geohash cells that cover the region, query all of them, then post-filter with exact geometry.

## Tradeoffs

### Strengths
- Dead simple to implement — it's just string encoding
- Works with any database that supports range queries on strings
- Prefix-based queries are fast on B-tree indexes
- Easy to adjust precision by truncating the string
- Human-readable (you can eyeball that `dr5ru` is NYC)

### Weaknesses
- **Boundary discontinuities**: The Z-order curve that geohash follows has jumps. Adjacent cells in space can be far apart in the encoding. Querying neighbors mitigates but doesn't eliminate this.
- **Rectangular cells**: At high latitudes, cells become very elongated because longitude degrees shrink toward the poles. A cell at the equator is roughly square; at 60°N it's twice as wide as it is tall.
- **Fixed grid**: The grid doesn't adapt to data density. Manhattan and the Sahara get the same cell sizes. You waste precision in sparse areas and lack resolution in dense ones.
- **Not great for polygons**: Covering an irregular shape with geohash cells requires many cells at the boundaries, leading to over-fetching.

## Geohash vs. Other Approaches

| Criteria | Geohash | S2 | H3 |
|----------|---------|----|----|
| Cell shape | Rectangle | Quadrilateral (near-square) | Hexagon |
| Locality curve | Z-order | Hilbert | Hex ring |
| Boundary behavior | Discontinuities at Z-jumps | Smooth (Hilbert) | Uniform distance |
| Pole distortion | Severe | Minimal (cube projection) | Moderate |
| Implementation | Trivial | Complex (need S2 lib) | Moderate (need H3 lib) |
| Database support | Native in Redis, Elasticsearch, DynamoDB | BigQuery, Spanner | Limited native support |

## Interview Application

### When to Use Geohash

Reach for geohash when:
- You need a simple proximity search and the database supports string range queries
- You're using DynamoDB, Redis, or Elasticsearch (native support)
- The data is relatively static (restaurants, stores, POIs)
- You don't need sub-meter precision

### How to Explain It

"Geohash converts a 2D coordinate into a 1D string by interleaving the bits of latitude and longitude, then base-32 encoding. Points in the same area share a prefix, so a B-tree range query on the prefix returns nearby points. The main gotcha is boundary effects — two nearby points can have different prefixes if they're on a cell boundary — so we always query the target cell plus its 8 neighbors, then post-filter by exact distance."

### Common Follow-Up Questions

**Q: How do you choose the precision?**
"It depends on the search radius. For a 5 km radius, precision 5 (~5 km cells) means querying 9 cells covers the area. For 500m, precision 6. I'd benchmark with real data density to find the sweet spot between too many candidates (low precision) and too many cell queries (high precision)."

**Q: How do you handle moving objects?**
"For objects like drivers that move every few seconds, I'd only re-index when they cross a cell boundary. At precision 6 (~1.2 km cells), a driver moving at 60 km/h crosses a boundary roughly every minute, reducing write amplification by ~15x compared to updating on every position change."

**Q: What about the equator vs. poles issue?**
"Geohash cells are rectangular in lat/lng space, but the Earth is a sphere. Near the poles, a degree of longitude is much shorter than at the equator, so cells become elongated. For a global service, I'd consider S2 which projects onto a cube first, giving more uniform cell shapes. For a service operating in a single country at mid-latitudes, geohash distortion is acceptable."

---

## Related Articles

**Next in series:** [QuadTrees](quadtrees.md)

**Previous in series:** [Geospatial Search Introduction](geospatial-search-introduction.md)

**See also:**
- [Inverted Index Fundamentals](../search/inverted-index-fundamentals.md) — geohash strings can be used as text index keys
