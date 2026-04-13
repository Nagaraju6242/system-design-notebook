# QuadTrees

## The Problem

You're designing Yelp. San Francisco has 15,000 restaurants packed into 121 km². Rural Wyoming has 200 restaurants spread across 253,000 km². If you use a fixed grid (like geohash), you either waste resolution in Wyoming (tiny cells with nothing in them) or lack resolution in SF (cells with thousands of restaurants requiring expensive post-filtering).

What you need is an adaptive spatial index — one that subdivides densely populated areas into small cells while keeping sparse areas as large cells. That's a quadtree.

## How a QuadTree Works

### The Core Idea

Start with a bounding box covering your entire area. If a cell contains more than N points (the capacity threshold), split it into 4 equal quadrants. Repeat recursively.

```
Step 0: All points in one cell       Step 1: Split (capacity = 4)
┌───────────────────────┐            ┌───────────┬───────────┐
│ .  .                  │            │ .  .      │           │
│    . .                │            │    . .    │           │
│  .    .               │    ──►     ├───────────┤           │
│         .             │            │  .    .   │     .     │
│              .        │            │           │        .  │
└───────────────────────┘            └───────────┴───────────┘

Step 2: NW quadrant exceeds capacity, split again
┌─────┬─────┬───────────┐
│ .  .│     │           │
├─────┼─────┤           │
│  . .│ .   │           │
├─────┴─────┤           │
│  .    .   │     .     │
│           │        .  │
└───────────┴───────────┘
```

### Node Structure

```python
class QuadTreeNode:
    def __init__(self, boundary, capacity=4):
        self.boundary = boundary    # (x, y, width, height)
        self.capacity = capacity
        self.points = []
        self.divided = False
        self.nw = self.ne = self.sw = self.se = None

    def insert(self, point):
        if not self.boundary.contains(point):
            return False

        if len(self.points) < self.capacity and not self.divided:
            self.points.append(point)
            return True

        if not self.divided:
            self._subdivide()

        return (self.nw.insert(point) or self.ne.insert(point) or
                self.sw.insert(point) or self.se.insert(point))

    def _subdivide(self):
        x, y, w, h = self.boundary
        hw, hh = w / 2, h / 2
        self.nw = QuadTreeNode((x, y + hh, hw, hh), self.capacity)
        self.ne = QuadTreeNode((x + hw, y + hh, hw, hh), self.capacity)
        self.sw = QuadTreeNode((x, y, hw, hh), self.capacity)
        self.se = QuadTreeNode((x + hw, y, hw, hh), self.capacity)

        # Re-insert existing points into children
        for p in self.points:
            self.nw.insert(p) or self.ne.insert(p) or \
            self.sw.insert(p) or self.se.insert(p)
        self.points = []
        self.divided = True
```

### Range Query

To find all points within a search rectangle:

```python
def query_range(self, search_rect, found=None):
    if found is None:
        found = []

    if not self.boundary.intersects(search_rect):
        return found  # Prune entire subtree

    if not self.divided:
        for p in self.points:
            if search_rect.contains(p):
                found.append(p)
    else:
        self.nw.query_range(search_rect, found)
        self.ne.query_range(search_rect, found)
        self.sw.query_range(search_rect, found)
        self.se.query_range(search_rect, found)

    return found
```

The power is in the pruning. If the search rectangle doesn't intersect a quadrant, we skip that entire subtree — potentially eliminating millions of points in one comparison.

## Nearest Neighbor Search

Finding the K nearest neighbors is more nuanced than a range query:

```
Algorithm: K-Nearest Neighbors in QuadTree
1. Start with a search circle centered on query point
2. Find the leaf node containing the query point
3. Check all points in that leaf
4. Expand to sibling nodes, then parent's siblings
5. Track the K closest points found so far
6. Use the distance to the Kth closest as a pruning radius
7. Skip any subtree whose boundary is entirely outside the pruning radius
```

```
    ┌─────┬─────┬───────────┐
    │     │  ●  │           │  ● = query point
    ├─────┼─────┤           │  ○ = candidates checked
    │  ○  │ ○ ○ │           │
    ├─────┴─────┤           │  Start in query's leaf cell,
    │  ○        │           │  expand outward, prune branches
    │           │           │  that can't contain closer points
    └───────────┴───────────┘
```

## Adaptive Resolution in Action

This is the quadtree's killer feature. Consider indexing all businesses in the US:

```
Manhattan (1.6 km²):
  Tree depth: 12-15 levels
  Leaf cells: ~50m × 50m
  Points per leaf: 3-4 businesses

Rural Kansas:
  Tree depth: 3-4 levels
  Leaf cells: ~50km × 50km
  Points per leaf: 2-3 businesses
```

The tree automatically allocates resolution where the data is. No tuning required.

```
US QuadTree (conceptual):
┌───────────────────────────────────────────┐
│                                           │
│   Rural areas: large cells, few points    │
│                                           │
│         ┌──┬──┐                           │
│         │░░│░░│ ← NYC: deeply subdivided  │
│         ├──┼──┤                           │
│         │░░│░░│                           │
│         └──┴──┘                           │
│                    ┌──┬──┐                │
│                    │░░│  │ ← LA           │
│                    └──┴──┘                │
└───────────────────────────────────────────┘
```

## QuadTree Variants

### Point QuadTree
What we described above. Each leaf stores actual points. Best for point data (restaurants, users, drivers).

### Region QuadTree
Each cell stores a value (like a pixel color or terrain type). Used in image processing and GIS raster data. Every cell is subdivided until it's homogeneous or reaches max depth.

### Point-Region (PR) QuadTree
Hybrid: subdivides space into regions but stores points. Each internal node represents a spatial partition, leaves store points. This is the most common variant for spatial indexing.

### Compressed QuadTree
Skips levels where only one child has data. Reduces tree depth and memory usage for clustered data.

```
Standard:                    Compressed:
    A                            A
   / \                          / \
  B   ∅                        B   D
 / \                          (skipped empty
C   ∅                          intermediate nodes)
|
D
```

## Building a QuadTree for a Database

QuadTrees are in-memory data structures. To use them with a database-backed system:

### Option 1: In-Memory Index, Database Storage

```
┌──────────────┐     ┌──────────────┐
│  QuadTree    │     │   Database   │
│  (in memory) │────►│  (Postgres)  │
│              │     │              │
│  Stores:     │     │  Stores:     │
│  - point_id  │     │  - full data │
│  - lat/lng   │     │  - lat/lng   │
│              │     │  - metadata  │
└──────────────┘     └──────────────┘

Query flow:
1. QuadTree returns candidate IDs
2. Fetch full records from DB by ID
```

This is how Yelp-like systems work. The quadtree fits in memory (10M points × 24 bytes = ~240 MB), and it handles the spatial filtering. The database handles everything else.

### Option 2: Serialize the Tree

Store the quadtree structure in a key-value store. Each node is a key, children are referenced by key.

```
Key: "node:root"     → {boundary, children: ["node:nw", "node:ne", ...]}
Key: "node:nw"       → {boundary, children: [...]}
Key: "node:nw:sw"    → {boundary, points: [id1, id2, id3]}
```

This works but adds network round trips per tree traversal level. Typically worse than option 1.

## QuadTree vs. Geohash

| Aspect | QuadTree | Geohash |
|--------|----------|---------|
| Resolution | Adaptive to data density | Fixed grid |
| Storage | In-memory tree structure | String in any database |
| Updates | O(log n) insert, but may trigger splits | O(1) — just compute new hash |
| Range query | Excellent — prune entire subtrees | Good — query 9 cells |
| Database fit | Poor — needs custom in-memory layer | Excellent — B-tree range query |
| Moving objects | Expensive — delete + reinsert + possible rebalance | Cheap — update hash string |
| Distributed | Hard to partition a tree across nodes | Easy — partition by prefix |

### When QuadTree Wins
- Data density varies wildly (cities vs. rural)
- You need in-memory speed for real-time queries
- The dataset fits in memory on a single machine
- You need exact nearest-neighbor, not approximate

### When Geohash Wins
- You need database-native indexing
- The system is distributed across multiple nodes
- Objects move frequently (drivers, couriers)
- Simplicity matters more than optimal resolution

## Handling Updates

QuadTrees struggle with frequent updates because moving a point means:

1. Find and remove from current leaf — O(log n)
2. If leaf is now below minimum occupancy, potentially merge with siblings
3. Insert at new position — O(log n)
4. If new leaf exceeds capacity, split

For 5 million drivers updating every 4 seconds, that's 1.25M delete-insert cycles per second with potential tree restructuring. This is why Uber uses H3 (a grid system) rather than quadtrees for real-time driver tracking.

### Mitigation: Loose QuadTree

A loose quadtree allows nodes to overlap slightly. Points don't need to move between nodes for small position changes. This reduces update frequency at the cost of slightly more candidates in range queries.

## Memory Analysis

For N points with capacity C per leaf:

```
Leaf nodes:     ~N/C
Internal nodes: ~N/(3C)  (each internal has 4 children)
Total nodes:    ~4N/(3C)

Per node: boundary (32 bytes) + pointers (32 bytes) + points array
Leaf:     32 + 32 + C × 24 bytes ≈ 160 bytes (C=4)
Internal: 32 + 32 = 64 bytes

Total for 10M points, C=4:
  Leaf nodes:     2.5M × 160 bytes = 400 MB
  Internal nodes: 833K × 64 bytes  =  53 MB
  Total:          ~453 MB
```

Fits comfortably in memory on a single server. For 100M+ points, you'd need to shard — which is where quadtrees get awkward and grid-based approaches (geohash, S2) shine.

## Interview Application

### When to Propose a QuadTree

- "Design Yelp" or "Design a nearby places service" with static POI data
- Any problem where data density varies significantly by region
- When the interviewer asks "how would you handle the fact that NYC has 100x more data points than rural areas?"

### How to Explain It

"I'd use a quadtree as an in-memory spatial index. It recursively subdivides space into quadrants, splitting only when a cell exceeds a capacity threshold. This gives us adaptive resolution — dense areas like Manhattan get small cells with few points each, while sparse areas stay as large cells. Range queries are O(log n) because we prune entire subtrees that don't intersect the search area."

### Pivot Points

**If asked about scaling**: "A single quadtree fits ~10M points in ~500 MB. Beyond that, I'd shard geographically — each server owns a region of the world. Or I'd switch to geohash/S2 which maps naturally to distributed databases."

**If asked about updates**: "QuadTrees are better for static data. For moving objects like drivers, each position update requires a delete-reinsert cycle that may trigger tree restructuring. I'd use a grid-based index like geohash or H3 instead, where updates are just changing a hash value."

**If asked about the database layer**: "The quadtree is the spatial index only — it stores point IDs and coordinates in memory. Full entity data lives in the database. The query flow is: quadtree returns candidate IDs → batch fetch from database → return to client."

---

## Related Articles

**Next in series:** [H3 Hexagonal Hierarchical Spatial Index](h3-hexagonal-indexing.md)

**Previous in series:** [Geohash](geohash.md)

**See also:**
- [Introduction to Bloom Filters](../probabilistic/bloom-filters-part-1.md) — Bloom filters can be used to skip empty quadrants efficiently
