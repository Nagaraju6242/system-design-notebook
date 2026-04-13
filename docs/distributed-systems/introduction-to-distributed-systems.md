# Introduction to Distributed Systems

A single PostgreSQL instance handles your startup's traffic just fine. 50 requests per second, all reads and writes go to one machine, transactions are ACID, life is simple. Then your app hits the front page of Hacker News. Traffic spikes to 5,000 requests per second. The database CPU pins at 100%. Queries time out. Users see errors.

You can't just buy a bigger machine forever. At some point, you need multiple machines working together. That's a distributed system — and it introduces an entirely new class of problems that don't exist on a single node.

## Why Distribute?

Three forces push systems from single-node to distributed:

**Scale.** A single machine has finite CPU, memory, disk, and network bandwidth. When your data exceeds what one disk can hold or your queries exceed what one CPU can process, you must spread the work across machines.

**Availability.** A single machine is a single point of failure. Hard drives fail. Power supplies die. If your business requires 99.99% uptime (52 minutes of downtime per year), you need redundancy across independent failure domains.

**Latency.** Physics limits the speed of light. A user in Tokyo talking to a server in Virginia experiences ~150ms round-trip latency. If you need sub-50ms responses globally, you need servers in multiple regions.

```
Single Node:
┌─────────────────┐
│   Application    │
│   + Database     │  ← Simple, but limited
│   (one machine)  │
└─────────────────┘

Distributed:
┌──────┐  ┌──────┐  ┌──────┐
│Node A│  │Node B│  │Node C│  ← Scalable, available,
│ (US) │  │ (EU) │  │(Asia)│    but complex
└──┬───┘  └──┬───┘  └──┬───┘
   └─────────┴─────────┘
         Network
```

## The Fundamental Problem: Partial Failure

On a single machine, things either work or they don't. The process runs or it crashes. The disk is accessible or it isn't. You don't get half-results.

In a distributed system, **part of the system can fail while the rest continues running**. This is partial failure, and it's the root cause of almost every distributed systems problem.

Node A sends a request to Node B. Node A doesn't get a response. What happened?

1. Node B never received the request (network dropped it)
2. Node B received it, processed it, but the response was lost
3. Node B received it but is slow (GC pause, overloaded)
4. Node B crashed after processing but before responding
5. Node B processed it, responded, but Node A's network interface dropped the response

Node A cannot distinguish between these cases. This is the **two generals problem** — you can never be certain about the state of a remote node based solely on the absence of a response.

## The Network Is Not Reliable

The network is the shared medium connecting all nodes. It is unreliable in specific, predictable ways:

**Packet loss.** Packets get dropped by overloaded routers, corrupted in transit, or discarded by firewalls. TCP retransmits, but retransmission adds latency and can fail entirely.

**Variable latency.** The same request might take 1ms or 500ms depending on network congestion, routing changes, and queuing delays. There is no upper bound on how long a network call can take.

**Partitions.** The network can split into disconnected segments. Nodes in segment A can talk to each other but not to nodes in segment B. Both segments continue operating, potentially making conflicting decisions.

```
Normal operation:
  A ←──────→ B ←──────→ C

Network partition:
  A ←──────→ B    ✗    C ←──────→ D
  [Segment 1]         [Segment 2]
  
  Both segments think they're the "real" cluster.
```

## Clocks Are Not Synchronized

On a single machine, `time.now()` gives a consistent ordering of events. In a distributed system, each node has its own clock, and they drift apart.

NTP (Network Time Protocol) synchronizes clocks, but only to within tens of milliseconds at best. In practice, clock skew of 100ms+ is common. This means:

- You cannot use wall-clock timestamps to determine which event happened first across nodes
- "Last write wins" conflict resolution using timestamps can silently lose data
- Lease-based locks can expire on one node while another thinks they're still valid

### Logical Clocks

Since physical clocks are unreliable, distributed systems use **logical clocks** to establish ordering:

**Lamport timestamps** assign a counter to each event. When a node sends a message, it includes its counter. The receiver sets its counter to `max(local, received) + 1`. This gives a partial ordering — if event A causally precedes event B, A's timestamp is lower. But two events with ordered timestamps aren't necessarily causally related.

**Vector clocks** extend this. Each node maintains a vector of counters, one per node. This captures true causal relationships — you can determine if two events are causally related or concurrent (happened independently).

```
Vector Clock Example (3 nodes: A, B, C):

Node A: [1,0,0] → sends msg to B
Node B: [1,1,0] → receives, increments own counter
Node B: [1,2,0] → local event
Node C: [0,0,1] → local event (concurrent with A and B's events)

[1,2,0] and [0,0,1] are concurrent — neither caused the other.
```

## Replication

Replication copies data across multiple nodes. Two reasons: fault tolerance (if one node dies, others have the data) and performance (read from the nearest replica).

### Leader-Follower (Primary-Replica)

One node is the leader. All writes go to the leader. The leader replicates changes to followers. Reads can go to any replica.

```
         Writes
           │
           ▼
       ┌────────┐
       │ Leader  │
       └────┬───┘
      ┌─────┼─────┐
      ▼     ▼     ▼
   ┌────┐┌────┐┌────┐
   │ F1 ││ F2 ││ F3 │  ← Followers serve reads
   └────┘└────┘└────┘
```

**Synchronous replication**: Leader waits for followers to confirm before acknowledging the write. Strong consistency, but one slow follower blocks all writes.

**Asynchronous replication**: Leader acknowledges immediately, replicates in the background. Fast writes, but followers can serve stale data. If the leader crashes before replicating, data is lost.

**Semi-synchronous**: Leader waits for one follower (not all). Balances durability and performance. This is what most production databases use.

### Multi-Leader

Multiple nodes accept writes. Each leader replicates to the others. Useful for multi-datacenter setups where you want local writes in each region.

The problem: **write conflicts**. Two users edit the same document on different leaders simultaneously. When the leaders sync, they have conflicting versions. You need a conflict resolution strategy — last-write-wins, merge, or application-level resolution.

### Leaderless (Dynamo-Style)

No designated leader. Any node accepts reads and writes. Writes go to multiple nodes. Reads query multiple nodes and reconcile.

Uses **quorum** logic: with N replicas, write to W nodes, read from R nodes. If `W + R > N`, at least one read node has the latest write. Common configuration: N=3, W=2, R=2.

```
Quorum: N=3, W=2, R=2

Write "x=5":
  Node 1: x=5 ✓ (ack)
  Node 2: x=5 ✓ (ack)  ← W=2 satisfied, write succeeds
  Node 3: x=3   (stale, hasn't received update yet)

Read:
  Node 1: x=5
  Node 3: x=3   ← R=2 satisfied, return x=5 (latest version)
```

## Partitioning (Sharding)

Replication copies the same data to multiple nodes. Partitioning splits different data across nodes. Each partition holds a subset of the total dataset.

**Hash partitioning**: Hash the key, assign to a partition based on hash range. Distributes data evenly but destroys key ordering — range queries must hit all partitions.

**Range partitioning**: Assign key ranges to partitions (A-F → Partition 1, G-M → Partition 2). Preserves ordering for range queries but can create hotspots if access patterns are skewed.

```
Hash Partitioning (4 partitions):
  hash(key) % 4 = 0 → Partition 0
  hash(key) % 4 = 1 → Partition 1
  hash(key) % 4 = 2 → Partition 2
  hash(key) % 4 = 3 → Partition 3

Range Partitioning:
  user_id 1-1000     → Partition 0
  user_id 1001-2000  → Partition 1
  user_id 2001-3000  → Partition 2
```

**Consistent hashing** solves the rebalancing problem. When you add or remove a node, only keys near that node on the hash ring move. Without it, adding a node reshuffles most keys.

## The Core Tradeoffs

Every distributed system design is a series of tradeoff decisions:

| Tradeoff | Option A | Option B |
|----------|----------|----------|
| Consistency vs. Availability | Reject requests during partitions (CP) | Serve potentially stale data (AP) |
| Latency vs. Consistency | Synchronous replication (slow, consistent) | Async replication (fast, eventually consistent) |
| Throughput vs. Durability | Acknowledge before persisting (fast) | Persist before acknowledging (safe) |
| Simplicity vs. Scale | Single node (simple) | Distributed (complex, scalable) |

There are no silver bullets. Every choice has a cost. The art of system design is choosing the right tradeoffs for your specific requirements.

## Key Takeaways

1. **Distribute only when you must.** A single well-tuned PostgreSQL instance handles more traffic than most people think. Don't distribute prematurely.
2. **Partial failure is the defining challenge.** Everything else — consensus, replication, consistency models — exists to handle partial failure.
3. **The network is the bottleneck.** It's unreliable, has variable latency, and can partition. Design for it.
4. **Clocks lie.** Use logical clocks for ordering events across nodes.
5. **Replication and partitioning are your two scaling tools.** Replication for reads and availability. Partitioning for write throughput and data volume.

## Interview Application

When discussing distributed systems in an interview, anchor your reasoning in the fundamentals:

"We need to distribute this system for three reasons: the data volume exceeds single-node storage, we need multi-region availability, and we need low-latency reads globally. I'd start with leader-follower replication for the read-heavy workload — writes go to a single leader, reads fan out to regional replicas."

"The tradeoff with async replication is that a user might write data and then read from a replica that hasn't received the update yet. For this use case — a social media feed — that's acceptable. A post appearing 500ms late is fine. For a banking ledger, it wouldn't be."

"For partitioning, I'd use hash partitioning on user_id. This distributes writes evenly. The downside is that queries spanning multiple users hit all partitions, but our access pattern is single-user lookups, so that's fine."

"I'd use consistent hashing so we can add nodes without reshuffling the entire dataset. With virtual nodes, we get even distribution even with heterogeneous hardware."

This shows you understand *why* you're distributing, *what* tradeoffs you're making, and *how* the mechanisms work — not just buzzword-dropping.

---

## Related Articles

**Next in series:** [CAP and PACELC Theorem](cap-and-pacelc-theorem.md)

**See also:**
- [Database Transactions](../transactions/database-transactions.md) — single-node transaction foundations before going distributed
