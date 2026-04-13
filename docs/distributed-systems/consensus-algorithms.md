# Consensus Algorithms

You have a database with three replicas. The leader crashes. Two followers remain. Both are healthy. Both have recent data. Which one becomes the new leader?

If they both decide they're the leader, you get split-brain — two nodes accepting writes independently, diverging the data. If neither becomes the leader, the system is down. You need the remaining nodes to **agree** on exactly one new leader, even though they can't talk to the crashed node to confirm it's actually dead.

This is the consensus problem: getting multiple nodes to agree on a value (a leader, a transaction commit, a configuration change) despite failures. It's the foundation of every reliable distributed system.

## The Consensus Problem

Formally, consensus requires three properties:

**Agreement:** All non-faulty nodes decide on the same value.

**Validity:** The decided value was proposed by some node (no making up values).

**Termination:** All non-faulty nodes eventually decide (the algorithm doesn't hang forever).

This sounds simple. It's not. The FLP impossibility result (Fischer, Lynch, Paterson, 1985) proved that **no deterministic algorithm can guarantee consensus in an asynchronous system where even one node can crash.** You can't distinguish a crashed node from a slow one, so you can't know when to stop waiting.

Real consensus algorithms work around FLP by using timeouts (introducing partial synchrony) or randomization. They don't guarantee termination in all cases, but they work reliably in practice.

## Why Consensus Matters

Consensus is the mechanism behind:

- **Leader election:** Replicas agree on which node is the leader
- **Atomic commit:** Participants agree on whether to commit or abort a transaction
- **Replicated state machines:** Replicas agree on the order of operations to apply
- **Distributed locks:** Nodes agree on who holds a lock
- **Configuration management:** Cluster members agree on membership changes

Every time you use etcd, ZooKeeper, Kafka (with KRaft), or a replicated database, consensus algorithms are running underneath.

## Paxos

Leslie Lamport published Paxos in 1998. It's the foundational consensus algorithm — theoretically elegant but notoriously difficult to implement correctly.

### Basic Paxos (Single-Value Consensus)

Three roles (a single node can play multiple roles):

- **Proposer:** Proposes a value
- **Acceptor:** Votes on proposals
- **Learner:** Learns the decided value

The algorithm runs in two phases:

### Phase 1: Prepare

The proposer picks a unique, monotonically increasing proposal number `n` and sends `PREPARE(n)` to a majority of acceptors.

Each acceptor, on receiving `PREPARE(n)`:
- If `n` is higher than any proposal number it has already responded to:
  - Promise not to accept any proposal with number less than `n`
  - Reply with the highest-numbered proposal it has already accepted (if any)
- Otherwise, ignore the request

### Phase 2: Accept

If the proposer receives promises from a majority:
- If any acceptor reported a previously accepted value, the proposer **must** propose that value (not its own). This ensures previously decided values aren't overwritten.
- If no acceptor reported a previous value, the proposer can propose its own value.
- Send `ACCEPT(n, value)` to the acceptors.

Each acceptor, on receiving `ACCEPT(n, value)`:
- If it hasn't promised to a higher proposal number, accept the proposal
- Otherwise, reject it

When a majority of acceptors accept the same proposal, consensus is reached.

```
Proposer P1          Acceptors (A1, A2, A3)         
    │                                                
    │── PREPARE(1) ──► A1: Promise(1, none)          
    │── PREPARE(1) ──► A2: Promise(1, none)          
    │── PREPARE(1) ──► A3: (message lost)            
    │                                                
    │ (majority promised)                            
    │                                                
    │── ACCEPT(1, "v") ──► A1: Accepted(1, "v")     
    │── ACCEPT(1, "v") ──► A2: Accepted(1, "v")     
    │                                                
    │ Consensus reached: "v" (majority accepted)     
```

### Why Paxos Is Hard

Basic Paxos decides a single value. Real systems need to decide a sequence of values (a log of operations). **Multi-Paxos** extends basic Paxos to decide a sequence, but Lamport's paper left many implementation details unspecified:

- How to handle leader election efficiently
- How to manage the log of decided values
- How to handle membership changes
- How to snapshot and compact the log

Every implementation fills in these gaps differently, leading to subtle bugs. Google's Chubby team famously said: "There are significant gaps between the description of the Paxos algorithm and the needs of a real-world system... the final system will be based on an unproven protocol."

## Raft

Diego Ongaro and John Ousterhout designed Raft in 2014 specifically to be **understandable**. It provides the same guarantees as Multi-Paxos but with a clearer structure.

Raft decomposes consensus into three sub-problems:

1. **Leader election:** How to choose a leader
2. **Log replication:** How the leader replicates entries to followers
3. **Safety:** How to ensure correctness

### Node States

Every node is in one of three states:

```
┌──────────┐     timeout      ┌───────────┐    wins election   ┌────────┐
│ Follower │ ───────────────► │ Candidate │ ──────────────────► │ Leader │
└──────────┘                  └───────────┘                     └────────┘
      ▲                            │                                 │
      │         loses election     │      discovers higher term      │
      │◄───────────────────────────┘◄────────────────────────────────┘
```

**Follower:** Passive. Responds to RPCs from leader and candidates. If it doesn't hear from a leader within the election timeout, it becomes a candidate.

**Candidate:** Actively seeking votes to become leader. Increments its term, votes for itself, and requests votes from other nodes.

**Leader:** Handles all client requests. Replicates log entries to followers. Sends periodic heartbeats to maintain authority.

### Terms

Raft divides time into **terms** — monotonically increasing integers. Each term begins with an election. If a candidate wins, it serves as leader for the rest of the term. If no one wins (split vote), a new term begins.

Terms act as a logical clock. If a node receives a message with a higher term, it updates its term and reverts to follower. Stale leaders are automatically deposed.

```
Term 1          Term 2          Term 3
├── Election ──►├── Election ──►├── Election ──►
│   Leader: A   │   Leader: B   │   Leader: B
│   ████████    │   ████████    │   ████████████
```

### Leader Election

When a follower's election timeout fires (randomized, typically 150-300ms):

1. Increment current term
2. Vote for self
3. Send `RequestVote` RPCs to all other nodes
4. Wait for responses

A candidate wins if it receives votes from a **majority** of nodes. Each node votes for at most one candidate per term (first-come-first-served). The randomized timeout makes split votes unlikely — one node usually times out first and wins.

```
Node A (timeout fires first):
  Term 2, votes for self
  → RequestVote to B: B votes YES (hasn't voted in term 2)
  → RequestVote to C: C votes YES
  → A wins with 3/3 votes, becomes leader

Node B (timeout fires second, but A already won):
  Receives heartbeat from A with term 2
  → Recognizes A as leader, stays follower
```

### Log Replication

The leader receives client requests and appends them as entries in its log. It then replicates entries to followers via `AppendEntries` RPCs.

```
Leader log:    [1:set x=1] [2:set y=2] [3:set x=3]
                    │            │            │
                    ▼            ▼            ▼
Follower A:    [1:set x=1] [2:set y=2] [3:set x=3]  ← up to date
Follower B:    [1:set x=1] [2:set y=2]               ← one behind
Follower C:    [1:set x=1]                            ← two behind
```

An entry is **committed** when the leader has replicated it to a majority of nodes. Once committed, the entry is durable — it will survive any subsequent leader election. The leader notifies followers of committed entries, and all nodes apply committed entries to their state machines.

### Safety: The Election Restriction

Raft's key safety property: **a candidate can only win an election if its log is at least as up-to-date as a majority of nodes.** When requesting votes, the candidate includes its last log entry's term and index. A voter rejects the vote if its own log is more up-to-date.

This ensures the new leader always has all committed entries. No committed data is ever lost during a leader change.

```
Logs after leader crash:

Node A (crashed leader): [1] [2] [3] [4]  ← had uncommitted entry 4
Node B:                  [1] [2] [3]       ← has all committed entries
Node C:                  [1] [2]           ← missing entry 3

Election: B wins (most up-to-date among survivors)
B becomes leader, replicates entry 3 to C
Entry 4 is lost (was never committed to a majority)
```

## Raft vs Paxos

| Aspect | Paxos | Raft |
|--------|-------|------|
| Understandability | Notoriously difficult | Designed for clarity |
| Leader | Optional (Multi-Paxos uses one) | Required, strong leader |
| Log management | Gaps allowed, complex | No gaps, append-only |
| Membership changes | Complex, often bolted on | Built-in joint consensus |
| Implementations | Varied, often subtly different | Consistent across implementations |
| Performance | Slightly more flexible | Comparable in practice |

Most new systems choose Raft. etcd, CockroachDB, TiKV, Consul, and Kafka (KRaft) all use Raft.

## Real-World Consensus Systems

### etcd (Raft)

Kubernetes stores all cluster state in etcd. Every pod creation, service update, and config change goes through Raft consensus. A 3-node or 5-node etcd cluster tolerates 1 or 2 failures respectively.

### ZooKeeper (ZAB)

ZooKeeper uses ZAB (ZooKeeper Atomic Broadcast), a protocol similar to Raft. It predates Raft and was designed specifically for ZooKeeper's needs. Kafka historically depended on ZooKeeper for metadata management.

### Kafka KRaft

Kafka replaced ZooKeeper with KRaft — an internal Raft implementation. The Kafka controller quorum uses Raft to manage partition metadata, broker membership, and topic configurations. This eliminates the operational burden of running a separate ZooKeeper cluster.

### Google Spanner (Paxos)

Spanner uses Paxos groups for replication within each partition. Each partition has a Paxos group that replicates data across datacenters. Cross-partition transactions use 2PC coordinated across Paxos groups. TrueTime (GPS + atomic clocks) provides globally consistent timestamps.

## Quorum Math

Consensus requires a **majority quorum**: more than half the nodes must agree.

| Cluster Size | Quorum | Failures Tolerated |
|-------------|--------|-------------------|
| 3 | 2 | 1 |
| 5 | 3 | 2 |
| 7 | 4 | 3 |

Why odd numbers? A cluster of 4 requires a quorum of 3 and tolerates 1 failure — same as a cluster of 3. The extra node adds cost without improving fault tolerance. Use 3 for most systems, 5 for critical systems that need to survive 2 simultaneous failures.

**Why not more?** Each additional node adds latency (leader waits for quorum acknowledgment) and network traffic. 7-node clusters are rare. Beyond that is almost never justified.

## Byzantine Fault Tolerance

Standard consensus (Paxos, Raft) assumes **crash faults** — nodes either work correctly or stop. They don't lie, send corrupted data, or act maliciously.

**Byzantine fault tolerance (BFT)** handles nodes that behave arbitrarily — sending conflicting messages to different nodes, corrupting data, or actively trying to subvert the protocol. BFT requires `3f + 1` nodes to tolerate `f` Byzantine faults (compared to `2f + 1` for crash faults).

BFT is used in blockchain systems (PBFT, Tendermint) where nodes don't trust each other. For internal distributed systems where you control all nodes, crash fault tolerance (Raft/Paxos) is sufficient and much cheaper.

## Interview Application

When discussing consensus in an interview, connect it to concrete system design decisions:

"For the metadata store in our distributed database, I'd use a 5-node Raft cluster. This tolerates 2 node failures. All writes go through the Raft leader, which replicates to a majority before acknowledging. Reads can go to the leader for linearizable consistency, or to any node for eventual consistency with lower latency."

"For leader election in our consumer group, we'd use etcd's lease mechanism, which is built on Raft. A consumer acquires a lease (a key with a TTL). If the consumer dies, the lease expires and another consumer acquires it. etcd's Raft consensus ensures only one consumer holds the lease at a time."

"I'd use a 5-node cluster rather than 3 because this is a critical coordination service. With 3 nodes, a single failure during a rolling upgrade (one node down for upgrade + one unexpected failure) would lose quorum. With 5 nodes, we can tolerate 2 failures, giving us room for maintenance."

"We don't need Byzantine fault tolerance — we control all the nodes in our cluster. BFT would require 3f+1 nodes instead of 2f+1 and add significant latency. That's for blockchain-style systems where participants don't trust each other."

---

## Related Articles

**Previous in series:** [Failure Handling Patterns](failure-handling-patterns.md)

**See also:**
- [Database Locking & Concurrency](../transactions/database-locking-and-concurrency.md) — local coordination mechanisms that consensus algorithms generalize to distributed settings
