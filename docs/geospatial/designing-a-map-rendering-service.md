# Designing a Map Rendering Service

## The Problem

A user opens Google Maps on their phone. They see a detailed street map of their neighborhood. They pinch to zoom out — the streets disappear, replaced by highways and city names. They zoom out further — countries and oceans. They pan left — new map content loads seamlessly. All of this happens in under 200ms per interaction, for 1 billion monthly active users.

The raw map data for the entire planet is ~1.5 TB (OpenStreetMap). Rendering a single map view requires selecting relevant features from this dataset, styling them, and producing an image or vector tile — all in real time. How?

## The Tile Pyramid

### Core Concept

Don't render the entire map. Divide the world into square tiles at multiple zoom levels. Pre-render (or dynamically render) only the tiles the user needs.

```
Zoom 0: 1 tile (entire world)
Zoom 1: 4 tiles (2×2)
Zoom 2: 16 tiles (4×4)
...
Zoom 18: 68,719,476,736 tiles (262,144 × 262,144)

Total tiles across all zoom levels: ~87 billion
```

Each tile is typically 256×256 or 512×512 pixels. The tile is identified by three values: `(zoom, x, y)`.

```
Zoom 0:          Zoom 1:              Zoom 2:
┌──────────┐     ┌─────┬─────┐       ┌──┬──┬──┬──┐
│          │     │ 0,0 │ 1,0 │       │  │  │  │  │
│   0,0    │     ├─────┼─────┤       ├──┼──┼──┼──┤
│          │     │ 0,1 │ 1,1 │       │  │  │  │  │
└──────────┘     └─────┴─────┘       ├──┼──┼──┼──┤
                                     │  │  │  │  │
                                     ├──┼──┼──┼──┤
                                     │  │  │  │  │
                                     └──┴──┴──┴──┘
```

### Tile URL Scheme

```
https://tiles.example.com/{z}/{x}/{y}.png     # Raster tile
https://tiles.example.com/{z}/{x}/{y}.pbf     # Vector tile (Protobuf)
https://tiles.example.com/{z}/{x}/{y}.mvt     # Mapbox Vector Tile
```

The client computes which tiles are visible in the current viewport and fetches them.

## Raster vs. Vector Tiles

### Raster Tiles

Pre-rendered PNG/JPEG images. The server does all the rendering work.

```
Server: Raw data → Style rules → Rendered image → PNG
Client: Fetch PNG → Display

Pros:
  - Client is simple (just display images)
  - Works everywhere (any browser, any device)
  - Consistent rendering across clients

Cons:
  - Huge storage (87B tiles × ~20KB = ~1.7 PB for one style)
  - Can't rotate or tilt the map (it's a flat image)
  - Style changes require re-rendering ALL tiles
  - No client-side interactivity (can't highlight a road on hover)
```

### Vector Tiles

Send the raw geometry + attributes. The client renders using a style sheet.

```
Server: Raw data → Simplify → Encode as Protobuf → Send
Client: Fetch Protobuf → Apply style → Render with GPU

Pros:
  - 10-50x smaller than raster (geometry compresses well)
  - Client can rotate, tilt, zoom smoothly between levels
  - Style changes are instant (just update the stylesheet)
  - Interactive (hover, click, highlight features)
  - One tile set serves multiple visual styles

Cons:
  - Client needs a rendering engine (Mapbox GL, Google Maps SDK)
  - Rendering quality varies by device GPU
  - More complex client implementation
```

Modern map services (Google Maps, Apple Maps, Mapbox) all use vector tiles. Raster tiles are still used for satellite imagery and specialized overlays.

## System Architecture

```
┌──────────────────────────────────────────────────────────┐
│                        Client                             │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ Viewport    │  │ Tile Manager │  │ Render Engine  │  │
│  │ Calculator  │→ │ (fetch/cache)│→ │ (GPU/Canvas)   │  │
│  └─────────────┘  └──────────────┘  └────────────────┘  │
└──────────────────────┬───────────────────────────────────┘
                       │ HTTPS requests for tiles
                       ▼
┌──────────────────────────────────────────────────────────┐
│                       CDN                                 │
│  (CloudFront, Fastly, Cloudflare)                        │
│  Cache hit rate: 80-95% for popular areas                │
└──────────────────────┬───────────────────────────────────┘
                       │ Cache miss
                       ▼
┌──────────────────────────────────────────────────────────┐
│                  Tile Server Fleet                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │ Server 1 │  │ Server 2 │  │ Server N │              │
│  │ (render) │  │ (render) │  │ (render) │              │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘              │
└───────┼──────────────┼──────────────┼────────────────────┘
        │              │              │
        ▼              ▼              ▼
┌──────────────────────────────────────────────────────────┐
│              Spatial Database / Tile Store                │
│  ┌──────────────┐  ┌──────────────┐                     │
│  │ PostGIS      │  │ Pre-computed │                     │
│  │ (raw data)   │  │ tile cache   │                     │
│  └──────────────┘  │ (S3/GCS)    │                     │
│                     └──────────────┘                     │
└──────────────────────────────────────────────────────────┘
```

## The Rendering Pipeline

### Step 1: Data Ingestion

Raw map data (OpenStreetMap, proprietary sources) is processed into a spatial database:

```
Raw OSM data (planet.osm.pbf, ~70 GB compressed)
    │
    ▼
Import tool (osm2pgsql, imposm3)
    │
    ▼
PostGIS database with spatial indexes
    │
    Tables: roads, buildings, water, landuse, POIs, ...
    Each row has: geometry (LINESTRING, POLYGON), attributes (name, type, ...)
    Spatial index: GiST (R-tree variant)
```

### Step 2: Tile Generation

For a requested tile `(z, x, y)`:

```
1. Compute tile bounding box in lat/lng
2. Query PostGIS for features intersecting the bbox:
   SELECT * FROM roads
   WHERE ST_Intersects(geometry, tile_bbox)
     AND road_type IN (allowed_types_for_zoom_z)

3. Simplify geometries (remove detail invisible at this zoom):
   ST_Simplify(geometry, tolerance_for_zoom_z)

4. Clip geometries to tile boundary:
   ST_Intersection(geometry, tile_bbox)

5. Encode as vector tile (Protobuf):
   - Convert coordinates to tile-local pixel coordinates
   - Delta-encode vertex sequences
   - Pack into Mapbox Vector Tile format
```

### Step 3: Generalization (Level of Detail)

Different zoom levels show different features:

```
Zoom 0-3:   Country borders, oceans, continent labels
Zoom 4-7:   States/provinces, major highways, large cities
Zoom 8-11:  Cities, secondary roads, large parks, rivers
Zoom 12-15: Streets, buildings, small parks, POIs
Zoom 16-18: Building footprints, house numbers, benches
```

This is controlled by style rules that filter features by zoom level:

```json
{
  "layer": "roads",
  "filter": [">=", "zoom", 12],
  "source-layer": "transportation",
  "filter": ["==", "class", "street"],
  "paint": {
    "line-color": "#ffffff",
    "line-width": 2
  }
}
```

### Step 4: Geometry Simplification

At zoom 5, a coastline with 10 million vertices is overkill — you can't see that detail. Simplification algorithms (Douglas-Peucker, Visvalingam) reduce vertex count while preserving shape:

```
Original (zoom 18):     Simplified (zoom 5):
  ╱╲╱╲                    ╱╲
 ╱    ╲╱╲                ╱  ╲
╱        ╲              ╱    ╲
```

## Caching Strategy

### Multi-Layer Cache

```
Layer 1: Client tile cache (IndexedDB/memory)
  - Stores recently viewed tiles
  - Enables offline map viewing
  - ~50-200 MB budget

Layer 2: CDN (CloudFront/Fastly)
  - Caches tiles at edge locations worldwide
  - TTL: hours to days for base map tiles
  - Hit rate: 80-95% for popular areas (NYC, London)
  - Hit rate: 10-30% for rural/ocean areas

Layer 3: Tile cache (Redis/S3)
  - Pre-computed tiles stored in object storage
  - Serves as origin for CDN
  - Popular zoom levels (0-14) fully pre-rendered

Layer 4: On-demand rendering
  - High zoom levels (15-18) rendered on request
  - Result cached in Layer 3 for future requests
```

### Cache Invalidation

Map data changes (new roads, updated buildings). How do you invalidate cached tiles?

```
Strategy 1: Time-based TTL
  - Base map tiles: TTL = 24 hours
  - Traffic overlay: TTL = 60 seconds
  - Simple but stale data for up to TTL

Strategy 2: Region-based invalidation
  - When data changes in region R, compute affected tiles
  - Purge those tiles from CDN and tile cache
  - Requires tracking which data contributes to which tiles

Strategy 3: Versioned tiles
  - URL includes version: /v42/{z}/{x}/{y}.pbf
  - Data update → increment version → all clients fetch new tiles
  - Clean but causes a thundering herd on version bump
```

## Handling Scale

### The Numbers

```
1 billion MAU, 100M DAU
Average session: 20 tile requests
Peak: 10x average (rush hour, events)

Steady state: 100M × 20 / 86400 = ~23,000 tile requests/sec
Peak:         ~230,000 tile requests/sec
```

### CDN Absorbs Most Load

With 90% CDN hit rate, the origin sees ~23,000 req/sec at peak. Each tile render takes ~10-50ms. A fleet of 100 tile servers handles this comfortably.

### Pre-Rendering vs. On-Demand

```
Zoom 0-10:  ~1.4 million tiles total
  → Pre-render all. Store in S3. Serve from CDN.
  → Storage: ~28 GB (at ~20 KB/tile)

Zoom 11-14: ~357 million tiles
  → Pre-render for populated areas. On-demand for rest.
  → Storage: ~2 TB for populated areas

Zoom 15-18: ~85 billion tiles
  → On-demand only. Cache after first render.
  → Most tiles are ocean/desert and never requested.
```

## Real-Time Overlays

Base map tiles are relatively static. But traffic, weather, and live events need real-time overlays:

```
┌─────────────────────────────────┐
│         Client Display          │
│  ┌───────────┐ ┌─────────────┐ │
│  │ Base map  │+│  Traffic    │ │  Composited on client
│  │ (cached)  │ │  overlay    │ │
│  └───────────┘ └─────────────┘ │
└─────────────────────────────────┘

Base map: fetched from CDN, cached for hours
Traffic:  fetched every 60s, short TTL
Weather:  fetched every 5 min, separate tile set
```

Overlays are separate tile sets with their own rendering pipeline and cache TTLs. The client composites them on top of the base map.

## Offline Maps

For offline support (Google Maps offline areas):

```
1. User selects a region on the map
2. Client computes all tiles needed for that region at zoom 0-15
3. Downloads tiles in background:
   - Zoom 0-10: ~100 tiles (tiny)
   - Zoom 11-15: ~10,000-50,000 tiles for a city
   - Total: ~50-200 MB
4. Stores in device local storage (SQLite/IndexedDB)
5. Tile manager checks local cache before network
```

## Interview Application

### When This Comes Up

- "Design Google Maps"
- "Design a map rendering service"
- "How would you serve map tiles to 1 billion users?"

### How to Structure Your Answer

1. **Start with the tile pyramid**: "The world is divided into tiles at multiple zoom levels. Each tile is identified by (zoom, x, y). The client computes which tiles are visible and fetches them."

2. **Vector vs. raster**: "Modern systems use vector tiles — send geometry as Protobuf, render on the client with GPU. This is 10-50x smaller than raster, supports rotation/tilt, and allows instant style changes."

3. **Caching is everything**: "90%+ of requests hit the CDN. Low zoom levels are pre-rendered and stored in S3. High zoom levels are rendered on-demand and cached. The tile server fleet only handles cache misses."

4. **Rendering pipeline**: "For a cache miss, the tile server queries PostGIS for features in the tile's bounding box, simplifies geometry for the zoom level, clips to tile boundaries, and encodes as a vector tile."

5. **Real-time overlays**: "Traffic and weather are separate tile sets with short TTLs, composited on the client."

### Key Numbers to Know

- Zoom 0: 1 tile. Zoom 18: ~69 billion tiles.
- Vector tile: 10-50 KB. Raster tile: 15-30 KB (PNG).
- CDN hit rate: 80-95% for populated areas.
- Tile render time: 10-50ms per tile.
- OpenStreetMap planet file: ~70 GB compressed, ~1.5 TB in PostGIS.

### Common Follow-Ups

**Q: How do you handle map updates?**
"Region-based cache invalidation. When OSM data changes in an area, we compute the affected tiles and purge them from CDN. For the base map, a 24-hour TTL is acceptable. For traffic overlays, 60-second TTL."

**Q: How do you handle different map styles (dark mode, satellite)?**
"With vector tiles, styles are applied client-side. One tile set serves all visual styles — the client just swaps the stylesheet. Satellite imagery is a separate raster tile set."

**Q: How would you estimate storage?**
"Pre-rendering zoom 0-14 for the entire world: ~360 million tiles × 20 KB = ~7 TB. Zoom 15-18 on-demand only. With vector tiles, total pre-rendered storage is ~2-3 TB. CDN caches the hot set. S3 stores the full set at ~$0.023/GB/month = ~$70/month for the tile store."

---

## Related Articles

**Next in series:** [Choosing a Spatial Index](choosing-a-spatial-index.md)

**Previous in series:** [Google's S2 Library](googles-s2-library.md)

**See also:**
- [File Chunking](../media/file-chunking.md) — tile chunking in map rendering parallels file chunking strategies
- [Video Transcoding and Playback](../media/video-transcoding-and-playback.md) — CDN delivery patterns for tiles mirror video streaming
