# File Chunking

A user is uploading a 5 GB video file over a flaky mobile connection. At 4.2 GB, the connection drops for 3 seconds. Without chunking, the entire upload fails and must restart from zero. The user has wasted 20 minutes and all the bandwidth. With chunking, the client resumes from chunk #420 and finishes in under a minute.

File chunking — splitting a file into smaller pieces — is a foundational technique in distributed systems. It enables resumable uploads, parallel transfers, deduplication, and efficient storage. Every major cloud storage system (S3, GCS, Google Drive, Dropbox) uses it.

## Why Chunk Files?

A single large file is fragile in a distributed system:

- **Network failure** kills the entire transfer. No partial credit.
- **Memory pressure** — loading a 10 GB file into memory to process it isn't feasible.
- **No parallelism** — one file means one stream. You can't use multiple connections or workers.
- **No deduplication** — if two files share 90% of their content, you store both in full.
- **Storage limits** — many storage systems have per-object size limits (S3: 5 GB per PUT).

Chunking solves all of these by breaking the file into fixed-size or content-defined pieces that can be handled independently.

## Fixed-Size Chunking

The simplest approach: split the file into equal-sized blocks.

```
File (20 MB):
┌──────┬──────┬──────┬──────┐
│ 5 MB │ 5 MB │ 5 MB │ 5 MB │
│  C1  │  C2  │  C3  │  C4  │
└──────┴──────┴──────┴──────┘
```

Implementation is trivial — read N bytes, emit a chunk, repeat:

```python
def fixed_size_chunks(filepath, chunk_size=5 * 1024 * 1024):
    with open(filepath, 'rb') as f:
        index = 0
        while True:
            data = f.read(chunk_size)
            if not data:
                break
            yield index, data
            index += 1
```

### Choosing Chunk Size

| Chunk Size | Upload Overhead | Resume Granularity | Metadata Cost | Use Case |
|-----------|----------------|-------------------|---------------|----------|
| 256 KB | High (many requests) | Very fine | High (many chunk records) | Small files, dedup-heavy |
| 4 MB | Moderate | Good | Moderate | General purpose (Dropbox) |
| 8-16 MB | Low | Coarse | Low | Large file uploads (S3 multipart) |
| 64-128 MB | Very low | Very coarse | Minimal | Big data / HDFS blocks |

The tradeoff is always the same: smaller chunks give better resume granularity and dedup potential, but increase metadata overhead and HTTP request count. Larger chunks are more efficient for throughput but waste more on failure.

S3 multipart upload uses 5 MB minimum, up to 5 GB per part, with a maximum of 10,000 parts. For a 50 GB file, you'd use ~640 parts at 80 MB each.

### The Boundary Shift Problem

Fixed-size chunking has a critical flaw for deduplication. Insert a single byte at the beginning of a file, and every chunk boundary shifts:

```
Original:    [AAAAA][BBBBB][CCCCC][DDDDD]
                 ↑ boundaries at positions 5, 10, 15

After inserting 1 byte at position 0:
             [xAAAA][ABBBB][BCCCC][CDDDD][D]
                 ↑ every chunk is now different
```

All four chunks have changed, even though the actual content is 99.99% identical. For a storage system that deduplicates by chunk hash, this means storing the entire file again. This is where content-defined chunking comes in.

## Content-Defined Chunking (CDC)

Instead of splitting at fixed byte offsets, CDC uses the file's content to determine boundaries. The most common technique is **Rabin fingerprinting** (a rolling hash).

The algorithm:
1. Slide a window across the file, computing a rolling hash at each byte position.
2. When the hash meets a condition (e.g., last 13 bits are zero), declare a chunk boundary.
3. The boundary depends on the local content, not the absolute position.

```python
def content_defined_chunks(data, target_size=4096, mask=0x1FFF):
    """mask=0x1FFF means boundary when last 13 bits are 0 → avg chunk ~8KB"""
    start = 0
    h = 0
    for i, byte in enumerate(data):
        h = rolling_hash_update(h, byte)
        if (h & mask) == 0 or (i - start) >= target_size * 4:
            yield data[start:i+1]
            start = i + 1
            h = 0
    if start < len(data):
        yield data[start:]
```

### Why CDC Survives Insertions

The key insight: chunk boundaries are determined by local content patterns, not global position. Inserting a byte at the beginning only affects the first chunk. All subsequent boundaries are found at the same content patterns:

```
Original:    [AAAA|A][BBB|BB][CCC|CC][DDD|DD]
                   ↑ boundary triggered by content pattern "A][B"

After inserting 1 byte at position 0:
             [xAAA|A][BBB|BB][CCC|CC][DDD|DD]
              ↑ only this chunk changed
```

Chunks 2, 3, and 4 are identical to the original. The dedup system recognizes them by hash and stores only the new first chunk. For a 1 GB file with a 1-byte edit, you store ~4 KB of new data instead of 1 GB.

### CDC Tradeoffs

| Aspect | Fixed-Size | Content-Defined |
|--------|-----------|----------------|
| Implementation | Trivial | Complex (rolling hash) |
| Chunk size variance | None (exact) | Variable (need min/max bounds) |
| Dedup after edits | Poor (boundary shift) | Excellent |
| CPU overhead | Minimal | Moderate (hash per byte) |
| Best for | Upload/download chunking | Storage dedup, sync engines |

Dropbox uses CDC for their sync engine. Git's packfiles use a form of content-defined chunking. rsync uses a rolling checksum (Adler-32) for the same reason.

## Chunk Integrity and Reassembly

Every chunk needs a way to verify integrity and know its place in the file.

### Chunk Metadata

```json
{
  "file_id": "f-abc123",
  "chunk_index": 3,
  "offset": 15728640,
  "size": 5242880,
  "hash": "sha256:a1b2c3d4...",
  "total_chunks": 12
}
```

The hash serves double duty:
1. **Integrity check**: After upload, the server hashes the received bytes and compares. Mismatch = corruption = retry.
2. **Deduplication key**: If two chunks from different files have the same hash, store one copy and point both to it.

### Reassembly

The server reconstructs the file by concatenating chunks in order:

```
Chunk manifest (ordered):
  chunk_0: sha256:aaa → storage_key: blk/aaa
  chunk_1: sha256:bbb → storage_key: blk/bbb
  chunk_2: sha256:ccc → storage_key: blk/ccc
  chunk_3: sha256:ddd → storage_key: blk/ddd

Reassembly:
  read(blk/aaa) + read(blk/bbb) + read(blk/ccc) + read(blk/ddd) → original file
```

The manifest is the source of truth. The actual chunk blobs can live anywhere — distributed across storage nodes, replicated across regions. As long as the manifest is intact and all referenced chunks exist, the file can be reconstructed.

## Resumable Uploads

Chunking enables resumable uploads naturally. The protocol:

```
Client                              Server
  │                                    │
  ├── POST /upload/init ──────────────→│  Create upload session
  │←── {upload_id, chunk_size} ────────┤
  │                                    │
  ├── PUT /upload/{id}/chunk/0 ───────→│  Store chunk 0
  │←── 200 OK ─────────────────────────┤
  │                                    │
  ├── PUT /upload/{id}/chunk/1 ───────→│  Store chunk 1
  │←── 200 OK ─────────────────────────┤
  │                                    │
  │  ✕ CONNECTION DROPS                │
  │                                    │
  │  ... reconnect ...                 │
  │                                    │
  ├── GET /upload/{id}/status ────────→│  Which chunks received?
  │←── {completed: [0, 1]} ────────────┤
  │                                    │
  ├── PUT /upload/{id}/chunk/2 ───────→│  Resume from chunk 2
  │←── 200 OK ─────────────────────────┤
  │                                    │
  ├── POST /upload/{id}/complete ─────→│  Finalize
  │←── 200 OK {file_id} ──────────────┤
```

The server tracks which chunks have been received. On reconnect, the client asks for status and only sends missing chunks. For a 5 GB file with 5 MB chunks, a failure at 4.2 GB means resending at most one 5 MB chunk instead of 4.2 GB.

### Parallel Upload

Chunks are independent — the client can upload multiple chunks simultaneously:

```
Client Thread 1: ──chunk 0──chunk 4──chunk 8──→
Client Thread 2: ──chunk 1──chunk 5──chunk 9──→
Client Thread 3: ──chunk 2──chunk 6──chunk 10─→
Client Thread 4: ──chunk 3──chunk 7──chunk 11─→
```

This saturates the network connection and can dramatically reduce upload time. S3 multipart upload documentation recommends parallel part uploads for this reason.

## Deduplication at Scale

Chunking enables block-level deduplication. Instead of comparing entire files, you compare chunk hashes.

```
File A: [chunk_h1] [chunk_h2] [chunk_h3] [chunk_h4]
File B: [chunk_h1] [chunk_h2] [chunk_h5] [chunk_h4]
                                  ↑ only new chunk

Storage without dedup: 8 chunks stored
Storage with dedup:    5 unique chunks stored (37.5% savings)
```

At Dropbox's scale, this is massive. Users upload millions of files daily, and many share common content — the same PDF attachment forwarded to 50 people, the same library bundled in every project.

### Dedup Architecture

```
┌────────────┐     ┌──────────────┐     ┌─────────────┐
│   Client   │────→│  Chunk Hash  │────→│  Chunk Store │
│  (chunks)  │     │   Index      │     │  (blob store)│
└────────────┘     │  (hash→ref)  │     └─────────────┘
                   └──────────────┘
                         │
                   hash exists?
                   ├── yes → skip upload, add reference
                   └── no  → upload chunk, add to index
```

The client can even check hashes before uploading. If the server already has a chunk, the client skips it entirely. This is how Dropbox achieves near-instant sync for files that already exist elsewhere in the system.

## Chunking in Distributed Storage

Large-scale storage systems use chunking as a core primitive:

**HDFS**: Default 128 MB blocks. Each block replicated 3x across DataNodes. The NameNode stores the block-to-file mapping.

**GFS (Google File System)**: 64 MB chunks. Similar to HDFS — the master tracks chunk locations, chunkservers store the data.

**S3**: Objects up to 5 TB, but internally sharded. Multipart upload API exposes chunking to the client for objects > 5 GB.

**Cassandra/HBase**: SSTables are effectively chunked data files with index blocks for efficient range lookups.

The common pattern: split data into chunks, distribute chunks across nodes, maintain a metadata index mapping logical files to physical chunk locations.

```
Logical File: report.csv (500 MB)
  │
  ├── Block 0 (128 MB) → Node A (primary), Node C (replica), Node E (replica)
  ├── Block 1 (128 MB) → Node B (primary), Node D (replica), Node F (replica)
  ├── Block 2 (128 MB) → Node C (primary), Node A (replica), Node D (replica)
  └── Block 3 (116 MB) → Node D (primary), Node B (replica), Node F (replica)
```

## Interview Application

File chunking appears in many system design problems. Here's how to deploy it:

**"Design Dropbox/Google Drive"** — this is the primary chunking question. Cover:
- Fixed-size chunking for upload/download (resumability, parallel transfer).
- Content-defined chunking for the sync engine (efficient delta detection after edits).
- Chunk-level deduplication to reduce storage costs.
- Manifest-based file reconstruction.

**"Design a large file upload service"** — focus on:
- Multipart upload protocol with chunk tracking.
- Resumable uploads via server-side chunk status.
- Parallel chunk upload for throughput.
- Integrity verification via chunk hashes.
- Mention S3 multipart as a real-world reference.

**"Design YouTube/Netflix"** — chunking intersects with video:
- Video segments (2-10 seconds) are effectively chunks optimized for streaming.
- Each segment is independently decodable (starts with a keyframe).
- Manifest files (HLS/DASH) are chunk manifests for video.

**Key tradeoffs to articulate**:
- Chunk size: smaller = better resume/dedup, larger = less overhead.
- Fixed vs. content-defined: fixed is simple and fast, CDC is essential for dedup after edits.
- Dedup savings depend on workload — high for shared documents, low for unique media.
- Metadata overhead grows with chunk count — the chunk index itself must be durable and fast.

**Numbers to have ready**:
- S3 multipart: 5 MB min part, 5 GB max part, 10,000 parts max → 50 TB max object.
- HDFS default block: 128 MB, 3x replication.
- Dropbox chunk size: ~4 MB (content-defined).
- A 1 GB file at 4 MB chunks = 256 chunks = 256 hash entries in the index.

---

## Related Articles

**Previous in series:** [Video Transcoding and Playback](video-transcoding-and-playback.md)

**See also:**
- [Video Transcoding and Playback](video-transcoding-and-playback.md) — video segments
- [Designing a Map Rendering Service](../geospatial/designing-a-map-rendering-service.md) — tile chunking parallel