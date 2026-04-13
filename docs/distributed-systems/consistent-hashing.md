# Consistent Hashing

You have 4 cache servers. You distribute keys using `hash(key) % 4`. It works — until you add a fifth server. Now it's `hash(key) % 5`, and roughly 80% of your keys map to a different server. Every one of those keys is a cache miss. Your database gets slammed with traffic that the cache was supposed to absorb.

This isn't a theoretical problem. Any system that distributes data across multiple nodes — caches, databases, CDNs, message brokers — faces this exact issue every time the number of nodes changes. Consistent hashing solves it by ensuring that when nodes are added or removed, only a minimal fraction of keys need to move.

## The Problem with Modular Hashing

Standard modular hashing (`hash(key) % N`) has a fatal flaw: the modulus changes when N changes.

With 4 servers, `hash("user:42") % 4 = 2` → Server 2.
Add a server: `hash("user:42") % 5 = 3` → Server 3.

The key moved. And so did most other keys. On average, an `N/(N+1)` fraction of keys remap when you add one server. For 4 → 5 servers, that's 80%.

| Event | Keys Remapped |
|-------|--------------|
| 4 → 5 servers | ~80% |
| 10 → 11 servers | ~91% |
| 100 → 101 servers | ~99% |

It gets worse as you scale. This is the opposite of what you want.

## The Hash Ring

Consistent hashing replaces modular arithmetic with a circular keyspace — a ring.

The hash function outputs values in a fixed range, say 0 to 2³² - 1. Treat this range as a circle where 0 and 2³² - 1 are adjacent.

### Step 1: Place Servers on the Ring

Hash each server's identifier to get its position:

```
hash("server-A") →  450,000
hash("server-B") →  1,200,000
hash("server-C") →  2,800,000
```

These three points divide the ring into three arcs.

### Step 2: Place Keys on the Ring

Hash each key using the same function:

```
hash("user:42")  →  900,000
hash("order:99") →  3,100,000
```

### Step 3: Route Keys to Servers

For each key, walk clockwise around the ring. The first server you encounter owns that key.

```
hash("user:42") = 900,000
  → clockwise → next server is server-B at 1,200,000
  → server-B owns this key

hash("order:99") = 3,100,000
  → clockwise → wraps past 2³² → next server is server-A at 450,000
  → server-A owns this key
```

Each server owns the arc from the previous server's position (exclusive) up to its own position (inclusive), going clockwise.

| Server | Owns Range | Arc Size |
|--------|-----------|----------|
| server-A | 2,800,001 → 450,000 | wraps around zero |
| server-B | 450,001 → 1,200,000 | |
| server-C | 1,200,001 → 2,800,000 | |

### No Central Assignment

Nobody assigns these ranges. They emerge from where the hash function places each server. Every client that knows the server list can independently hash the names, build the same ring, and route any key to the correct server — without asking a coordinator.

The only shared knowledge needed is the membership list: which servers exist. Not what ranges they own.

## Adding and Removing Nodes

### Adding a Node

A new server joins: `hash("server-D") → 2,000,000`.

Server-D lands between server-B (1,200,000) and server-C (2,800,000).

Before:
```
server-C owned 1,200,001 → 2,800,000
```

After:
```
server-D owns  1,200,001 → 2,000,000  (took this chunk)
server-C owns  2,000,001 → 2,800,000  (kept the rest)
```

Only keys in the range 1,200,001 → 2,000,000 move from server-C to server-D. Servers A and B are completely unaffected. Their keys don't move. Their ranges don't change.

On average, only `K/N` keys move (K = total keys, N = total servers after the change).

### Removing a Node

Server-B (at 1,200,000) dies.

Before:
```
server-B owned 450,001 → 1,200,000
```

After: the next clockwise server (server-D at 2,000,000) absorbs server-B's range:
```
server-D now owns 450,001 → 2,000,000
```

Again, only server-B's keys move. Servers A and C are untouched.

### Comparison

| Event | Modular Hashing | Consistent Hashing |
|-------|----------------|-------------------|
| Add 1 server to 4 | ~80% keys move | ~20% keys move |
| Remove 1 of 4 | ~75% keys move | ~25% keys move |
| Add 1 server to 100 | ~99% keys move | ~1% keys move |

## The Hotspot Problem and Virtual Nodes

With 3 servers on the ring, the hash function might place them unevenly — one server could own 60% of the keyspace while another owns 10%. With few points on the ring, the distribution is essentially random and often skewed.

### Virtual Nodes

The fix: instead of hashing each server once, hash it many times with different suffixes.

```
hash("server-A-0") →  450,000
hash("server-A-1") →  1,800,000
hash("server-A-2") →  3,200,000
hash("server-B-0") →  200,000
hash("server-B-1") →  1,200,000
hash("server-B-2") →  2,600,000
hash("server-C-0") →  900,000
hash("server-C-1") →  2,100,000
hash("server-C-2") →  3,800,000
```

Now there are 9 points on the ring instead of 3. Each physical server owns 3 small scattered arcs instead of 1 large one. The total keyspace owned by each server converges toward 1/3.

With 150–200 virtual nodes per server, the distribution becomes nearly uniform. The standard deviation of load drops proportionally to `1/√(virtual nodes)`.

### Virtual Node Tradeoffs

| Virtual Nodes per Server | Load Balance | Memory for Ring | Lookup Speed |
|--------------------------|-------------|-----------------|-------------|
| 1 | Poor (high variance) | Minimal | O(log N) |
| 50 | Good | Moderate | O(log 50N) |
| 150–200 | Excellent | Higher | O(log 200N) |

More virtual nodes = better balance but more memory for the ring data structure and slightly slower lookups (though still O(log N) with a sorted ring and binary search).

### Heterogeneous Servers

Virtual nodes also handle servers with different capacities. A server with 2x the memory gets 2x the virtual nodes, so it owns roughly 2x the keyspace. No special logic needed — just vary the count.

## Membership: The One Thing You Do Need

The hash function eliminates the need for a range-to-server mapping. But you still need to know which servers are alive. A dead server's keys need to be routed to the next server on the ring.

How systems maintain membership:

| System | Membership Mechanism |
|--------|---------------------|
| Cassandra | Gossip protocol — nodes periodically exchange membership state |
| DynamoDB | Centralized coordinator tracks membership |
| Memcached (ketama) | Client-side config file listing servers; client builds the ring |
| Redis Cluster | Gossip protocol over a cluster bus |
| Kafka | ZooKeeper or KRaft consensus for broker membership |

The distinction: you need to know **who** is in the ring, but you never store **what range** each server owns. Ranges are always computed on the fly.

## Implementation

The ring is typically stored as a sorted array of (hash value, server) pairs. Key lookup is a binary search for the next hash value ≥ the key's hash, wrapping around if needed.

```
Ring (sorted): [(200K, B), (450K, A), (900K, C), (1.2M, B), (1.8M, A), (2.1M, C), ...]

Lookup "user:42" → hash = 950K
  → binary search for first entry ≥ 950K
  → (1.2M, B)
  → route to server-B
```

Time complexity: O(log V) where V = total virtual nodes across all servers.

Adding/removing a server: insert or remove its virtual node entries from the sorted array. O(V_per_server × log V) total.

## Variants

### Jump Consistent Hash

Google's jump consistent hash (2014) uses no ring at all. It's a function that takes a key and bucket count, and outputs a bucket number. It achieves perfect balance and minimal remapping with zero memory overhead.

Limitation: servers must be numbered 0 to N-1. You can only add or remove the last server. This makes it unsuitable for systems where arbitrary servers can fail, but excellent for systems with ordered shards.

### Rendezvous Hashing (Highest Random Weight)

For each key, hash the key with every server name. Pick the server that produces the highest hash value.

```
score("user:42", "server-A") → 847291
score("user:42", "server-B") → 923847  ← highest, wins
score("user:42", "server-C") → 612384
```

When a server is removed, only its keys move — each key's second-highest-scoring server takes over. No ring needed, no virtual nodes needed.

Tradeoff: O(N) per lookup (must hash against every server). Fine for small N, impractical for hundreds of servers.

### Bounded-Load Consistent Hashing

Google's extension (2017) adds a capacity cap to each server. If the next clockwise server is overloaded, the key continues clockwise to the next available server. This prevents hotspots from skewed key distributions even when virtual nodes aren't enough.

## Real-World Usage

| System | What It Distributes | Notes |
|--------|-------------------|-------|
| Amazon DynamoDB | Data partitions across storage nodes | Uses virtual nodes for balance |
| Apache Cassandra | Row keys across cluster nodes | Token ring with vnodes |
| Akamai CDN | Web content across edge servers | Original consistent hashing paper (1997) |
| Memcached (ketama) | Cache keys across servers | Client-side ring with 150 vnodes |
| Redis Cluster | Keys across masters | Uses 16,384 fixed hash slots (a variation) |
| Nginx | Upstream server selection | `consistent_hash` directive |
| gRPC | Client-side load balancing | Ring hash policy |

## Interview Application

When discussing consistent hashing in an interview, connect it to the specific system you're designing:

"For the distributed cache layer, I'd use consistent hashing with 200 virtual nodes per server. When we scale from 10 to 11 cache servers, only about 9% of keys remap — so we avoid a cache stampede. Each application server maintains the ring locally and routes cache requests directly, no lookup service needed."

"For database sharding, I'd use consistent hashing to assign user IDs to shards. When we add a shard, we only need to migrate the keys that fall in the new shard's range. We'd use a background migration process — the old shard continues serving reads for migrating keys until the transfer completes, then we update the ring."

"I'd use virtual nodes with counts proportional to server capacity. Our newer servers have 2x the memory, so they get 2x the virtual nodes and handle roughly 2x the keys. This lets us run a heterogeneous fleet without manual rebalancing."

"For the CDN, consistent hashing ensures that the same content is always routed to the same edge server, maximizing cache hit rates. Without it, the same URL could be cached on every edge server, wasting storage. With it, each URL lives on one server (plus replicas for fault tolerance)."

---

## Related Articles

**Part of series:** [Introduction to Distributed Systems](introduction-to-distributed-systems.md)

**See also:**

- [CAP and PACELC Theorem](cap-and-pacelc-theorem.md) — the availability and consistency tradeoffs that consistent hashing helps navigate during node failures
- [Failure Handling Patterns](failure-handling-patterns.md) — what happens when a node on the ring fails and how systems detect and recover
