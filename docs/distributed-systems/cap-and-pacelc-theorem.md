# CAP and PACELC Theorem

Your e-commerce platform runs across two datacenters — US-East and US-West. A fiber cut severs the link between them. Both datacenters are still running. Users in both regions are sending requests. The product catalog database has replicas in both datacenters.

You have a choice:

1. **Stop serving writes** in one datacenter until the link is restored. Users see errors, but the data stays consistent.
2. **Keep serving writes** in both datacenters independently. Users stay happy, but the two copies of the catalog diverge. When the link heals, you have conflicting data.

This is the CAP theorem in action. It's not an abstract academic concept — it's a decision you make every time you design a replicated data system.

## The CAP Theorem

Eric Brewer proposed the CAP conjecture in 2000. Seth Gilbert and Nancy Lynch proved it in 2002. It states that a distributed data store can provide at most two of three guarantees simultaneously:

**Consistency (C):** Every read receives the most recent write or an error. All nodes see the same data at the same time. This is linearizability — the system behaves as if there's a single copy of the data.

**Availability (A):** Every request receives a non-error response, without guarantee that it contains the most recent write. Every non-failing node must return a response.

**Partition Tolerance (P):** The system continues to operate despite network partitions — arbitrary message loss or delay between nodes.

### Why It's Really C vs A

The theorem says "pick two of three," but that's misleading. In any distributed system, **network partitions will happen**. Cables get cut. Switches fail. Cloud availability zones lose connectivity. You don't get to opt out of partition tolerance.

So the real choice is: **when a partition occurs**, do you sacrifice consistency or availability?

```
Network Partition Occurs:

┌──────────┐          ┌──────────┐
│ Node A   │    ✗     │ Node B   │
│ (US-East)│  ──────  │ (US-West)│
└──────────┘          └──────────┘

Option CP: Node B rejects writes → Consistent but unavailable
Option AP: Both accept writes   → Available but inconsistent
```

**CP (Consistency + Partition Tolerance):** During a partition, the system refuses requests that could cause inconsistency. A node that can't confirm it has the latest data returns an error rather than stale data. Examples: HBase, MongoDB (with majority write concern), etcd, ZooKeeper.

**AP (Availability + Partition Tolerance):** During a partition, every node continues serving requests using its local data, even if that data might be stale or divergent. Examples: Cassandra, DynamoDB, CouchDB, DNS.

### What CAP Does NOT Say

CAP is widely misunderstood. Common misconceptions:

**"You must always choose two."** No. CAP only applies during a partition. When the network is healthy, you can have all three. Most of the time, your system operates normally with full consistency and availability.

**"CP means the system is always unavailable."** No. A CP system is only unavailable during partitions. The rest of the time it's fully available. Partitions are rare in well-managed networks — maybe minutes per year.

**"AP means data is always inconsistent."** No. An AP system is only inconsistent during partitions. Once the partition heals, replicas converge. The question is how long inconsistency lasts and how conflicts are resolved.

**"CAP applies to single-node systems."** No. A single PostgreSQL instance isn't making a CAP tradeoff. CAP only applies to replicated data across multiple nodes.

## Real-World CAP Classifications

| System | Classification | Behavior During Partition |
|--------|---------------|--------------------------|
| ZooKeeper | CP | Minority partition stops accepting writes |
| etcd | CP | Raft leader in minority partition steps down |
| MongoDB (majority) | CP | Writes require majority acknowledgment |
| Cassandra | AP (tunable) | All nodes accept reads/writes |
| DynamoDB | AP | All replicas serve requests |
| CouchDB | AP | Accepts writes, resolves conflicts later |
| PostgreSQL (streaming) | CP | Follower won't serve reads if disconnected from leader |
| Redis Cluster | AP-leaning | Accepts writes on both sides of partition |

Most real systems are **tunable**. Cassandra lets you set consistency level per query — `QUORUM` reads are CP-ish, `ONE` reads are AP. MongoDB with `w:1` is AP, with `w:majority` is CP.

## The Problem with CAP

CAP is useful as a mental model but limited as a design tool. Its biggest flaw: **it says nothing about what happens when there's no partition** — which is 99.99% of the time.

During normal operation, the real tradeoff isn't consistency vs. availability. It's **consistency vs. latency**. Synchronous replication to all replicas gives you consistency but adds latency. Asynchronous replication gives you low latency but allows stale reads.

CAP treats this as a non-issue because "no partition = you get everything." But in practice, the latency cost of consistency is the dominant design concern.

## PACELC Theorem

Daniel Abadi proposed PACELC in 2012 to address CAP's blind spot. It extends CAP:

> If there is a **P**artition, choose between **A**vailability and **C**onsistency.
> **E**lse (normal operation), choose between **L**atency and **C**onsistency.

```
PACELC Decision Tree:

Is there a network partition?
├── YES (PAC): Choose Availability or Consistency
│   ├── PA: Serve requests, accept inconsistency
│   └── PC: Reject requests, maintain consistency
│
└── NO (ELC): Choose Latency or Consistency
    ├── EL: Low latency, async replication (stale reads possible)
    └── EC: Higher latency, sync replication (always consistent)
```

This captures the full picture. A system's PACELC classification tells you its behavior in both failure and normal modes.

### PACELC Classifications

| System | During Partition | Normal Operation | Classification |
|--------|-----------------|------------------|----------------|
| DynamoDB | Available | Low Latency | PA/EL |
| Cassandra | Available | Low Latency | PA/EL |
| CouchDB | Available | Low Latency | PA/EL |
| MongoDB (default) | Consistent | Low Latency | PC/EL |
| PostgreSQL (async) | Consistent | Low Latency | PC/EL |
| ZooKeeper | Consistent | Consistent | PC/EC |
| etcd | Consistent | Consistent | PC/EC |
| Google Spanner | Consistent | Consistent | PC/EC |
| Cosmos DB | Tunable | Tunable | PA/EL or PC/EC |

**PA/EL** (DynamoDB, Cassandra): Prioritizes availability and speed in all conditions. Accepts inconsistency as the cost. Best for: high-throughput, latency-sensitive workloads where stale reads are tolerable (social feeds, product catalogs, session stores).

**PC/EL** (MongoDB default, PostgreSQL async): Consistent during partitions, but uses async replication normally for speed. The most common pattern — you get consistency guarantees with reasonable performance. Best for: most OLTP workloads.

**PC/EC** (ZooKeeper, Spanner): Consistent always, at the cost of latency. Every write waits for replication. Best for: coordination services, financial systems, anything where stale reads are unacceptable.

**PA/EC** is theoretically possible but rare in practice — it would mean "during partitions, serve stale data, but during normal operation, pay for full consistency." This is an unusual combination.

## Applying PACELC to Design Decisions

### Example: User Profile Service

Requirements: 500M users, global, read-heavy (1000:1 read/write ratio), users tolerate seeing their own stale profile for a few seconds.

Analysis:
- Partitions: We want availability — a user should always see *some* profile, even if slightly stale. → **PA**
- Normal operation: Low latency matters more than perfect consistency for profile reads. → **EL**
- Classification: **PA/EL** → Use Cassandra or DynamoDB with eventual consistency reads.

### Example: Bank Account Balance

Requirements: Must never show wrong balance, regulatory compliance, users expect immediate consistency.

Analysis:
- Partitions: Reject transactions rather than risk double-spending. → **PC**
- Normal operation: Consistency is non-negotiable, even at latency cost. → **EC**
- Classification: **PC/EC** → Use PostgreSQL with synchronous replication, or Google Spanner.

### Example: E-Commerce Inventory

Requirements: Don't oversell, but brief staleness on product pages is fine. Checkout must be consistent.

Analysis: This is a **mixed** system. Product catalog reads are PA/EL. Inventory decrement at checkout is PC/EC. Use different consistency levels for different operations.

```
Product Page (read):
  → Cassandra, consistency=ONE (PA/EL)
  → User sees "In Stock" even if 2 seconds stale

Checkout (write):
  → PostgreSQL, synchronous replication (PC/EC)
  → Inventory decrement is serializable
  → Never oversell
```

## Beyond CAP: Practical Consistency Tuning

Real systems don't make a single CAP choice. They tune consistency per operation:

**Cassandra consistency levels:**
- `ONE`: Read/write to one replica. Fastest, least consistent.
- `QUORUM`: Read/write to majority. Balanced.
- `ALL`: Read/write to all replicas. Slowest, most consistent.
- `LOCAL_QUORUM`: Quorum within the local datacenter. Good for multi-DC.

**MongoDB write/read concerns:**
- `w:1`: Acknowledge after primary writes. Fast, risk of data loss.
- `w:majority`: Acknowledge after majority replicates. Durable.
- `readConcern: linearizable`: Strongest read guarantee. Slowest.

**DynamoDB:**
- Eventually consistent reads: Half the cost, might be stale.
- Strongly consistent reads: Full cost, always current.

The pattern: **default to eventual consistency, upgrade to strong consistency for operations that require it.** This gives you the best of both worlds — low latency for most reads, correctness for critical writes.

## Interview Application

When discussing database choices in an interview, use PACELC to justify your decision:

"For the chat message store, I'd use Cassandra. Messages are write-heavy and latency-sensitive. Users can tolerate seeing messages arrive slightly out of order across devices — that's a PA/EL tradeoff. We get high write throughput and low latency globally."

"For the payment ledger, I'd use PostgreSQL with synchronous replication. We can't show a wrong balance or process a duplicate payment. That's PC/EC — we accept higher write latency for correctness. During a partition, we'd rather reject a transaction than risk inconsistency."

"For the product catalog, I'd actually use both patterns. Product page reads go through a Cassandra cache with eventual consistency — showing a price that's 2 seconds stale is fine. But the checkout flow reads inventory from PostgreSQL with strong consistency to prevent overselling."

"CAP tells us we must choose during partitions. PACELC tells us the full story — even without partitions, there's a latency-consistency tradeoff. Most of our system is PA/EL because latency matters more than perfect consistency for user-facing reads. The critical financial paths are PC/EC."

This demonstrates you understand the nuance beyond "pick two of three" and can apply the framework to make concrete, justified design decisions.

---

## Related Articles

**Next in series:** [Consistency Models](consistency-models.md)

**Previous in series:** [Introduction to Distributed Systems](introduction-to-distributed-systems.md)

**See also:**
- [Database Isolation Levels](../transactions/database-isolation-levels.md) — local consistency tradeoffs mirror distributed CAP choices
