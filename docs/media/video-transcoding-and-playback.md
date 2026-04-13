# Video Transcoding and Playback

A user uploads a 4K video from their iPhone. The raw file is 2 GB, encoded in HEVC. Another user tries to watch it on a 2015 Android phone over a 3G connection. The phone doesn't support HEVC. The connection can't sustain 20 Mbps. The screen is 720p — 4K pixels are wasted.

If you serve the original file, the video won't play. If you transcode it into a single lower-quality version, desktop users on fiber get a degraded experience. This is the core problem video transcoding solves: take one source video and produce multiple versions optimized for different devices, resolutions, and network conditions.

## Video Fundamentals

Before diving into transcoding pipelines, you need to understand what a video file actually is.

### Containers and Codecs

A video file has two layers:

- **Container** (format): The wrapper that packages video, audio, subtitles, and metadata together. Examples: MP4, MKV, WebM, MOV.
- **Codec**: The algorithm that compresses/decompresses the actual video and audio data. Examples: H.264, H.265 (HEVC), VP9, AV1.

```
┌─────────────────────────────────┐
│         MP4 Container           │
│  ┌───────────┐ ┌─────────────┐  │
│  │ Video     │ │ Audio       │  │
│  │ (H.264)   │ │ (AAC)       │  │
│  └───────────┘ └─────────────┘  │
│  ┌───────────┐ ┌─────────────┐  │
│  │ Subtitles │ │ Metadata    │  │
│  │ (SRT)     │ │ (duration,  │  │
│  │           │ │  bitrate)   │  │
│  └───────────┘ └─────────────┘  │
└─────────────────────────────────┘
```

The container is like a ZIP file — it holds multiple streams. The codec determines how each stream is compressed. You can have H.264 video inside an MP4 container, or inside an MKV container. Same video data, different packaging.

### Key Video Properties

| Property | What It Means | Example Values |
|----------|--------------|----------------|
| Resolution | Pixel dimensions | 3840×2160 (4K), 1920×1080 (1080p), 1280×720 (720p) |
| Bitrate | Data per second | 5 Mbps (1080p), 15 Mbps (4K) |
| Frame rate | Frames per second | 24 fps (film), 30 fps (standard), 60 fps (smooth) |
| Codec | Compression algorithm | H.264, H.265, VP9, AV1 |

**Bitrate is the most important property for streaming.** A 1080p video at 5 Mbps requires the viewer's connection to sustain at least 5 Mbps continuously. Drop below that, and the video buffers.

### Codec Tradeoffs

| Codec | Compression Efficiency | Encoding Speed | Device Support | Licensing |
|-------|----------------------|----------------|----------------|-----------|
| H.264 | Baseline (1x) | Fast | Universal | Licensed |
| H.265 | ~50% better than H.264 | 3-10x slower | Good, not universal | Licensed |
| VP9 | ~50% better than H.264 | Slow | Good (Chrome, Android) | Royalty-free |
| AV1 | ~30% better than H.265 | Very slow (10-100x H.264) | Growing | Royalty-free |

Better compression means smaller files at the same quality — but encoding takes longer and not every device can decode it. This is why platforms transcode into multiple codecs, not just one.

## What Is Transcoding?

Transcoding is converting a video from one encoding to another. In practice, a transcoding pipeline takes a single uploaded video and produces a **ladder** of output versions:

```
                    ┌──→ 2160p @ 15 Mbps (H.264)
                    ├──→ 1080p @ 5 Mbps  (H.264)
Raw Upload ────────►├──→ 720p  @ 2.5 Mbps (H.264)
(4K HEVC, 2 GB)     ├──→ 480p  @ 1 Mbps  (H.264)
                    ├──→ 360p  @ 0.5 Mbps (H.264)
                    └──→ 1080p @ 3 Mbps  (VP9)   ← smaller file, same quality
```

Each output is called a **rendition**. The set of renditions is called a **bitrate ladder** or **encoding ladder**.

### The Transcoding Process

At a high level, transcoding has three stages:

1. **Decode**: Decompress the source video into raw frames (uncompressed pixel data).
2. **Process**: Optionally resize, crop, adjust color, add watermarks.
3. **Encode**: Compress the raw frames using the target codec, resolution, and bitrate.

```
Source File → Decoder → Raw Frames → [Resize/Filter] → Encoder → Output File
  (H.265)     (decode)   (YUV pixels)                   (H.264)    (MP4)
```

Encoding is the expensive step. A single 10-minute 4K video can take 30+ minutes to encode on a modern CPU. This is why transcoding pipelines use parallelism aggressively.

### Chunked Parallel Transcoding

Instead of encoding a full video sequentially, production systems split the video into segments and encode them in parallel:

```
                    ┌─ Segment 1 (0:00-0:10) ──→ Worker A ──→ Encoded Seg 1 ─┐
                    ├─ Segment 2 (0:10-0:20) ──→ Worker B ──→ Encoded Seg 2 ─┤
Source Video ──Split─┤                                                         ├─ Concat ──→ Final
                    ├─ Segment 3 (0:20-0:30) ──→ Worker C ──→ Encoded Seg 3 ─┤
                    └─ Segment 4 (0:30-0:40) ──→ Worker D ──→ Encoded Seg 4 ─┘
```

Splitting must happen at **keyframe boundaries** (I-frames) — points where the frame is a complete image, not a delta from a previous frame. Splitting at arbitrary points produces visual artifacts at segment boundaries.

A typical pipeline:

1. Upload lands in object storage (S3).
2. A message is published to a job queue (SQS, Kafka).
3. A transcoding coordinator splits the source into segments and fans out encoding jobs.
4. Worker fleet (CPU or GPU instances) encodes segments in parallel.
5. Encoded segments are concatenated into the final output.
6. Output renditions are stored in object storage, and a manifest is generated.

### Per-Title Encoding

Netflix pioneered **per-title encoding** — instead of using a fixed bitrate ladder for all content, the ladder is optimized per video. An animated show compresses much better than a live-action sports broadcast. A static lecture can look great at 1 Mbps; a fast-paced action scene needs 8 Mbps at the same resolution.

The idea: run test encodes at various bitrate/resolution combinations, measure quality (using metrics like VMAF), and pick the optimal ladder for that specific video.

```
Fixed Ladder:                    Per-Title Ladder (animation):
  1080p @ 5 Mbps                   1080p @ 2 Mbps    ← 60% savings
  720p  @ 2.5 Mbps                 720p  @ 1.2 Mbps
  480p  @ 1 Mbps                   480p  @ 0.6 Mbps
```

Tradeoff: per-title encoding requires extra compute for the analysis pass, but saves significant bandwidth and storage long-term. Worth it for content viewed millions of times. Overkill for a video viewed 10 times.

## Playback: Adaptive Bitrate Streaming

Transcoding produces the renditions. Playback is how the client selects and consumes them. The dominant approach is **Adaptive Bitrate Streaming (ABR)**.

### How ABR Works

The video is split into small segments (2-10 seconds each), and each segment is available at every quality level. The client measures its download speed and switches between quality levels segment-by-segment.

```
Time:     0s    4s    8s    12s   16s   20s
          ├─────┼─────┼─────┼─────┼─────┤
1080p:    [seg1] [seg2]                [seg5]    ← fast connection
720p:                  [seg3]                    ← speed dropped
480p:                        [seg4]              ← speed dropped more
```

The viewer sees quality fluctuate, but the video never buffers. This is the fundamental tradeoff of ABR: **continuous playback at variable quality beats perfect quality with buffering pauses.**

### Protocols: HLS vs DASH

Two protocols dominate adaptive streaming:

| Feature | HLS (HTTP Live Streaming) | DASH (Dynamic Adaptive Streaming) |
|---------|--------------------------|-----------------------------------|
| Origin | Apple | MPEG consortium (open standard) |
| Segment format | .ts (MPEG-TS) or .fmp4 | .mp4 (fragmented) |
| Manifest | .m3u8 playlist | .mpd (XML) |
| DRM support | FairPlay | Widevine, PlayReady |
| Browser support | Safari native, others via JS | Chrome, Firefox, Edge native |

In practice, most platforms support both. YouTube uses DASH. Apple devices require HLS. Netflix uses both depending on the client.

### The Manifest File

The manifest is the entry point for playback. It tells the player what renditions exist and where to find each segment.

HLS master playlist example:

```
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
1080p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
720p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480
480p/playlist.m3u8
```

Each rendition has its own playlist listing individual segments:

```
#EXTM3U
#EXT-X-TARGETDURATION:4
#EXTINF:4.0,
segment_001.ts
#EXTINF:4.0,
segment_002.ts
#EXTINF:4.0,
segment_003.ts
```

The player fetches the master playlist, picks a rendition based on current bandwidth, then fetches segments from that rendition's playlist. If bandwidth changes, it switches to a different rendition's playlist for the next segment.

### ABR Algorithm

The client-side ABR algorithm decides when to switch quality. A simplified version:

```
buffer_level = current_buffer_seconds()
download_speed = measure_last_segment_speed()

if buffer_level < 5s:
    # Emergency: drop to lowest quality to avoid buffering
    select_rendition(lowest)
elif download_speed > current_rendition.bitrate * 1.5:
    # Headroom: try stepping up one level
    select_rendition(current + 1)
elif download_speed < current_rendition.bitrate * 0.8:
    # Falling behind: step down one level
    select_rendition(current - 1)
else:
    # Stable: stay at current quality
    select_rendition(current)
```

Real algorithms (like BBA — Buffer-Based Approach, or MPC — Model Predictive Control) are more sophisticated, but the core idea is the same: use buffer level and throughput estimates to pick the best rendition that avoids rebuffering.

## CDN and Edge Delivery

Transcoded segments are served from a **CDN (Content Delivery Network)**. Without a CDN, every viewer fetches segments from the origin server — which might be in us-east-1 while the viewer is in Tokyo.

```
Viewer (Tokyo) ──→ CDN Edge (Tokyo) ──cache hit──→ Segment delivered (20ms)
                         │
                    cache miss
                         │
                         ▼
                   CDN Origin (us-east-1) ──→ S3 ──→ Segment fetched (200ms)
                         │
                   cache filled
                         ▼
              Next viewer gets cache hit (20ms)
```

Popular videos get cached at edge locations worldwide. Long-tail content (rarely watched) may always require origin fetches. CDN cache hit ratio is a critical metric — Netflix reports 95%+ cache hit rates.

### Segment Size Tradeoffs

| Segment Duration | Pros | Cons |
|-----------------|------|------|
| 2 seconds | Fast quality switching, low latency | More HTTP requests, larger manifests, worse compression |
| 6 seconds | Good compression, fewer requests | Slower adaptation to bandwidth changes |
| 10 seconds | Best compression efficiency | Sluggish quality switching, high initial latency |

Most platforms use 4-6 second segments as a compromise. Live streaming uses shorter segments (2-4s) to minimize latency.

## End-to-End Architecture

Putting it all together for a platform like YouTube or Netflix:

```
┌──────────┐     ┌──────────┐     ┌──────────────────┐     ┌───────────┐
│  Upload  │────→│  Object  │────→│  Transcoding     │────→│  Object   │
│  Service │     │  Storage │     │  Pipeline         │     │  Storage  │
│          │     │  (raw)   │     │  (worker fleet)   │     │  (output) │
└──────────┘     └──────────┘     └──────────────────┘     └─────┬─────┘
                                                                 │
                                         ┌───────────────────────┤
                                         ▼                       ▼
                                  ┌─────────────┐       ┌──────────────┐
                                  │  Manifest   │       │     CDN      │
                                  │  Generator  │       │  (segments)  │
                                  └──────┬──────┘       └──────┬───────┘
                                         │                     │
                                         ▼                     ▼
                                  ┌────────────────────────────────┐
                                  │         Video Player           │
                                  │  (ABR algorithm, buffering,    │
                                  │   rendition switching)         │
                                  └────────────────────────────────┘
```

### Key Design Decisions

**Storage**: Raw uploads and transcoded outputs go in object storage (S3). Metadata (video ID, title, renditions, status) goes in a database.

**Queue**: Transcoding jobs are queued, not synchronous. Upload returns immediately; transcoding happens asynchronously. Users see a "processing" state until transcoding completes.

**Scaling**: Transcoding is CPU-bound and embarrassingly parallel. Auto-scale worker fleets based on queue depth. GPU instances (with hardware encoders like NVENC) are 5-10x faster but more expensive per hour.

**Fault tolerance**: If a worker dies mid-encode, the segment job is retried. Idempotent segment encoding means retries are safe. The coordinator tracks which segments are complete and only concatenates when all are done.

**Cost**: Transcoding is the most expensive part of a video platform. Netflix spends hundreds of millions annually on encoding compute. Per-title encoding, codec selection, and encoding presets are all levers to optimize cost vs. quality.

## Live Streaming Differences

Live streaming adds real-time constraints that change the architecture:

- **No time for per-title analysis** — the encoding ladder is fixed.
- **Segments must be encoded and available within seconds** — latency budget is tight.
- **The manifest is dynamic** — new segments are appended as the stream progresses.
- **No retry on failure** — a dropped frame is gone forever.

```
Camera → Ingest Server → Real-time Encoder → Segment Packager → CDN → Viewers
                              (< 2s)              (< 1s)
```

Ultra-low-latency live streaming (sub-3-second) uses techniques like CMAF (Common Media Application Format) with chunked transfer encoding, where segments are pushed to the CDN before they're fully encoded.

## Interview Application

When designing a video platform (YouTube, Netflix, TikTok), here's how to structure your discussion:

**Start with the upload path**: User uploads raw video → stored in object storage → transcoding job queued → worker fleet produces renditions → outputs stored with manifest.

**Explain why transcoding exists**: Different devices, codecs, resolutions, and network speeds. One source file can't serve all viewers. Mention the bitrate ladder concept.

**Describe playback**: Manifest file lists available renditions → player fetches segments → ABR algorithm switches quality based on bandwidth and buffer level. Name HLS or DASH.

**Address scale**: Transcoding is CPU-intensive and parallelizable — split into segments, encode in parallel across a worker fleet. CDN caches segments at the edge for popular content.

**Show you understand tradeoffs**:
- Segment size: shorter = faster adaptation but more overhead
- Codec choice: better compression = slower encoding + less device support
- Per-title encoding: better quality/cost but more compute upfront
- Live vs. VOD: live has real-time constraints that limit optimization options

**Common follow-ups to prepare for**:
- "How would you handle a viral video?" → CDN cache warming, origin shield, pre-positioning at popular edge locations.
- "How do you minimize time-to-first-frame?" → Preload first segment, use shorter initial segments, CDN proximity.
- "How do you handle DRM?" → Encrypt segments with content keys, deliver keys via license server, different DRM per platform (Widevine for Chrome/Android, FairPlay for Apple).
- "Cost optimization?" → Per-title encoding, AV1 for popular content (better compression offsets slow encoding), spot instances for transcoding workers, tiered storage for old content.

---

## Related Articles

**Next in series:** [File Chunking](file-chunking.md)

**See also:**
- [File Chunking](file-chunking.md) — segment chunking
- [Failure Handling Patterns](../distributed-systems/failure-handling-patterns.md) — CDN failover