# Space-Filling Curves and Hilbert's Curve

## The Problem

You have a database with 50 million geographic points. You need to store them on disk such that points close in 2D space are also close on disk. Why? Because disk reads are sequential — reading 100 consecutive rows is 100x faster than reading 100 random rows. If nearby restaurants are scattered across random disk pages, every "find nearby" query triggers hundreds of random I/O operations.

The question becomes: how do you linearize 2D space — map every (x, y) point to a single integer — such that spatial proximity is preserved?

This is the space-filling curve problem.

## What Is a Space-Filling Curve?

A space-filling curve is a continuous curve that passes through every point in a 2D region. As you increase the curve's resolution (order), it visits more and more points until, in the limit, it fills the entire space.

The curve assigns each cell a sequential number. That number becomes the 1D index.

### Z-Order Curve (Morton Curve)

The simplest space-filling curve. Interleave the bits of x and y coordinates:

```
Point (x=5, y=3):
  x = 5 = 101 in binary
  y = 3 = 011 in binary

Interleave (x bits in odd positions, y bits in even):
  x: 1 _ 0 _ 1 _
  y: _ 0 _ 1 _ 1
  z: 1 0 0 1 1 1 = 39

Morton code for (5, 3) = 39
```

The Z-order curve traces a Z-shaped pattern through the grid:

```
Order 1 (2×2):        Order 2 (4×4):
┌───┬───┐             ┌───┬───┬───┬───┐
│ 2 │ 3 │             │ 10│ 11│ 14│ 15│
├───┼───┤             ├───┼───┼───┼───┤
│ 0 │ 1 │             │ 8 │ 9 │ 12│ 13│
└───┴───┘             ├───┼───┼───┼───┤
                      │ 2 │ 3 │ 6 │ 7 │
                      ├───┼───┼───┼───┤
                      │ 0 │ 1 │ 4 │ 5 │
                      └───┴───┴───┴───┘
```

**This is exactly what geohash uses.** The geohash encoding is a Z-order curve with base-32 encoding on top.

### The Z-Order Problem: Jumps

Look at the Z-order numbering. Cell 3 and cell 4 are adjacent in the 1D sequence but far apart in 2D space:

```
┌───┬───┬───┬───┐
│   │   │   │   │
├───┼───┼───┼───┤
│   │   │   │   │
├───┼───┼───┼───┤
│ 2 │ 3→│ 6 │ 7 │    3 → 4: big spatial jump!
├───┼───┼───┼───┤
│ 0 │ 1 │←4 │ 5 │
└───┴───┴───┴───┘
```

Cell 3 is at top-right of the first quadrant. Cell 4 is at bottom-left of the second quadrant. They're far apart spatially but adjacent in the index. This means a range query `[3, 6]` includes cells that are spatially distant, pulling in irrelevant data.

## Hilbert's Curve: The Better Alternative

The Hilbert curve solves the jump problem. It visits every cell in a 2D grid such that consecutive cells are always spatially adjacent — no jumps.

```
Order 1 (2×2):        Order 2 (4×4):
┌───┬───┐             ┌───┬───┬───┬───┐
│ 1 │ 2 │             │ 5 │ 6 │ 9 │ 10│
├───┼───┤             ├───┼───┼───┼───┤
│ 0 │ 3 │             │ 4 │ 7 │ 8 │ 11│
└───┴───┘             ├───┼───┼───┼───┤
                      │ 3 │ 2 │ 13│ 12│
                      ├───┼───┼───┼───┤
                      │ 0 │ 1 │ 14│ 15│
                      └───┴───┴───┴───┘
```

Trace the path: 0→1→2→3→4→5→6→7→8→9→10→11→12→13→14→15. Every step moves to an adjacent cell. No jumps.

```
Order 2 Hilbert curve path:

  ┌──→──┬──→──┐
  │  5  │  6  │  9──→10
  ↑     ↓     ↑      ↓
  │  4  │  7──→  8  │ 11
  ├─────┤           ├────┤
  │  3  │  2  │ 13  │ 12│
  ↓     ↑     ↓      ↑
  │  0──→  1  │ 14──→15│
  └─────┴─────┴─────┴───┘
```

### Why This Matters for Databases

When you store data ordered by Hilbert curve index, a range scan `[a, b]` on the index retrieves a spatially compact region. With Z-order, the same range scan might include spatially distant cells.

```
Query: "Find all points in this region"

Z-order ranges needed:     [0,3], [8,9], [12,13]  → 3 range scans
Hilbert ranges needed:     [0,7]                    → 1 range scan

Fewer range scans = fewer disk seeks = faster queries
```

## Hilbert Curve Construction

### Recursive Definition

The Hilbert curve is built recursively. At each order, the previous order's pattern is placed in each quadrant with specific rotations:

```
Order 1:          Order 2 (each quadrant gets a rotated Order 1):
┌───┬───┐         ┌───┬───┬───┬───┐
│ 1 │ 2 │         │ SW│   │   │ NE│  ← NW quadrant: original
├───┼───┤         │rot│ original  │rot│  ← NE quadrant: original
│ 0 │ 3 │         ├───┤   │   ├───┤
└───┴───┘         │   │   │   │   │
                  ├───┼───┼───┼───┤
                  │ SW│   │   │ SE│
                  │rot│   │   │rot│
                  └───┴───┴───┴───┘

Rotations:
  SW quadrant: rotate 90° clockwise + flip
  SE quadrant: rotate 90° counter-clockwise + flip
  NW quadrant: no rotation
  NE quadrant: no rotation
```

### Coordinate to Hilbert Index

```python
def xy_to_hilbert(x, y, order):
    """Convert (x, y) to Hilbert curve index at given order."""
    d = 0
    s = 2 ** (order - 1)
    while s > 0:
        rx = 1 if (x & s) > 0 else 0
        ry = 1 if (y & s) > 0 else 0
        d += s * s * ((3 * rx) ^ ry)
        # Rotate quadrant
        if ry == 0:
            if rx == 1:
                x = s - 1 - x
                y = s - 1 - y
            x, y = y, x
        s //= 2
    return d

def hilbert_to_xy(d, order):
    """Convert Hilbert index back to (x, y)."""
    x = y = 0
    s = 1
    while s < 2 ** order:
        rx = 1 if (d & 2) > 0 else 0
        ry = 1 if ((d & 1) ^ rx) > 0 else 0  # Note: XOR
        # Rotate
        if ry == 0:
            if rx == 1:
                x = s - 1 - x
                y = s - 1 - y
            x, y = y, x
        x += s * rx
        y += s * ry
        d //= 4
        s *= 2
    return x, y
```

## Locality Preservation: Quantified

The key metric is **locality ratio** — how well does the 1D ordering preserve 2D proximity?

For two points at 2D distance `d`, their 1D index distance is:

| Curve | Average 1D distance | Worst case 1D distance |
|-------|--------------------|-----------------------|
| Z-order | O(d × N^0.5) | O(N) — can jump across entire space |
| Hilbert | O(d²) | O(d² × log(d)) |
| Random | O(N) | O(N) |

Hilbert's worst case is dramatically better. Two points that are close in 2D are guaranteed to be relatively close in 1D. Z-order has no such guarantee — the jumps at quadrant boundaries can place nearby points at opposite ends of the index.

### Practical Impact

For a database with 10 million points, a "find within 1 km" query:

```
Z-order (geohash):
  - Needs 9 cell prefix queries (center + 8 neighbors)
  - Each prefix query is a range scan
  - Some ranges include irrelevant distant cells
  - ~15% over-fetch due to Z-jumps

Hilbert:
  - Needs 1-3 contiguous range scans
  - Ranges are spatially compact
  - ~3% over-fetch
  - 3-5x fewer disk pages read
```

## Where Hilbert Curves Are Used

### Google S2

S2 uses the Hilbert curve to order cells on each face of its cube projection. This is why S2 has better locality than geohash — it's Hilbert vs. Z-order under the hood.

### Apache HBase / BigTable

Row keys ordered by Hilbert curve index ensure that spatial range scans read contiguous regions of the distributed table. Google's internal geospatial systems use this approach.

### R-trees with Hilbert Ordering

Hilbert R-trees pack spatial objects into R-tree nodes using Hilbert curve order. This produces better node packing (less overlap between nodes) and faster queries than random insertion order.

### DynamoDB / Cassandra

For geospatial data in wide-column stores, using Hilbert curve index as the sort key gives better range scan performance than geohash:

```
Partition Key: region_id
Sort Key:      hilbert_index (64-bit integer)

Range query: PK = "region_42" AND SK BETWEEN 1000 AND 2000
→ Returns a spatially compact set of points
```

## Z-Order vs. Hilbert: When Does It Matter?

For most system design interviews, the difference is marginal. But it matters when:

1. **High query volume**: 3-5x fewer disk reads per query compounds at millions of QPS
2. **Large datasets**: With billions of points, the over-fetch from Z-order jumps becomes significant
3. **Range queries over regions**: Covering a polygon with index ranges requires fewer ranges with Hilbert
4. **Sorted storage engines**: LSM-trees (Cassandra, HBase, RocksDB) benefit most because range scans are their strength

When it doesn't matter:
- Small datasets (< 1M points)
- Point lookups (single cell, not range)
- In-memory indexes (disk locality irrelevant)

## Other Space-Filling Curves

### Peano Curve
The original space-filling curve (1890). Divides space into 9 sub-squares (3×3) instead of 4. Rarely used in practice — the 3×3 subdivision doesn't align with binary computer architectures.

### Sierpinski Curve
Fills a triangle rather than a square. Used in some mesh generation algorithms but not in spatial indexing.

### Moore Curve
A variant of the Hilbert curve that forms a closed loop (the start and end points are adjacent). Useful for circular data structures but no practical advantage for spatial indexing.

## Interview Application

### When to Bring Up Space-Filling Curves

- When discussing *why* geohash has boundary issues (it uses Z-order, which has jumps)
- When explaining Google S2's advantage over geohash (Hilbert vs. Z-order)
- When designing a system that stores geospatial data in a sorted key-value store (HBase, DynamoDB, Cassandra)
- When the interviewer asks "how would you optimize disk I/O for spatial queries?"

### How to Explain It

"The fundamental challenge in spatial indexing is mapping 2D coordinates to a 1D index that preserves locality. Space-filling curves do this by tracing a path through every cell in a grid. Geohash uses the Z-order curve, which is simple but has discontinuities — adjacent cells in 2D can be far apart in the index. The Hilbert curve solves this: consecutive index values are always spatially adjacent. This means range scans on a Hilbert index return spatially compact results with minimal over-fetch. Google's S2 library uses Hilbert curves internally, which is one reason it has better query performance than raw geohash for large datasets."

### The One-Liner

"Hilbert curve is to geohash what a well-organized bookshelf is to a pile of books — both contain the same information, but one lets you find what you need without searching the whole collection."

---

## Related Articles

**Next in series:** [Google's S2 Library](googles-s2-library.md)

**Previous in series:** [H3 Hexagonal Hierarchical Spatial Index](h3-hexagonal-indexing.md)

**See also:**
- [Google's S2 Library](googles-s2-library.md) — S2 uses Hilbert curves as its core spatial indexing mechanism
