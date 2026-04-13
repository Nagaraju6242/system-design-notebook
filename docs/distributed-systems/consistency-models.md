# Consistency Models

You post a photo on Instagram. You refresh your profile immediately — the photo isn't there. You refresh again — still nothing. Five seconds later, it appears. Meanwhile, your friend in another city saw it instantly because their request hit a different replica that already had the update.

This isn't a bug. It's a consistency model choice. Instagram uses eventual consistency for the feed — your write propagates to all replicas asynchronously. The replica you read from just hadn't received it yet.

Consistency models define the contract between a distributed data store and its clients: **what values can a read return, and when?** Choosing the right model is one of the most consequential decisions in system design.

## The Spectrum

Consistency models form a spectrum from strongest (most intuitive, most expensive) to weakest (least intuitive, cheapest):

```
Strongest                                              Weakest
    │                                                      │
    ▼                                                      ▼
Linearizable → Sequential → Causal → Read-your-writes → Eventual
    │              │           │            │                │
 Behaves like   Global     Respects     You see your     All replicas
 single copy    ordering   causality    own writes       converge
                                                         eventually
    ◄──── More expensive, slower ────────── Cheaper, faster ────►
```

## Linearizability (Strong Consistency)

The strongest model. The system behaves as if there's a single copy of the data, and all operations happen atomically at some point between their invocation and response.

In practice: once a write completes, every subsequent read — from any client, on any node — sees that write or a later one. No stale reads. Ever.

```
Timeline:
Client A:  ──── write(x=1) ────────────────────────►
                              │
Client B:          read(x) ──┤── must return 1 (or later value)
                              │
Client C:              read(x) ── must return 1 (or later value)
```

### How It Works

Linearizability requires coordination. Common implementations:

**Single leader with synchronous replication.** All reads and writes go through the leader. The leader replicates synchronously to followers before acknowledging. Reads from followers are blocked until they're caught up.

**Consensus protocols (Raft, Paxos).** A quorum of nodes agrees on every write. Reads go through the leader or require a quorum read. etcd, ZooKeeper, and Google Spanner use this approach.

### The Cost

Linearizability is expensive:

- **Latency**: Every write requires a round-trip to a quorum. In a geo-distributed system with replicas in US, EU, and Asia, that's 100-300ms per write.
- **Availability**: During a network partition, the minority partition can't serve reads or writes (it can't reach a quorum).
- **Throughput**: All writes are serialized through a single leader or consensus protocol. You can't scale writes horizontally.

### When You Need It

- **Distributed locks and leader election.** If two nodes both think they're the leader, you get split-brain. Linearizable reads ensure only one node holds the lock.
- **Unique constraints.** Two users registering the same username must not both succeed. Linearizable compare-and-swap prevents this.
- **Financial balances.** A bank account must never show a balance that allows overdraft due to stale reads.

## Sequential Consistency

Weaker than linearizability. All operations appear to execute in some sequential order, and each client's operations appear in the order they were issued. But there's no real-time guarantee — the global order doesn't have to match wall-clock time.

```
Linearizable:
  Client A writes x=1 at time T=1
  Client B reads x at time T=2 → MUST see x=1

Sequential:
  Client A writes x=1 at time T=1
  Client B reads x at time T=2 → MIGHT see old value
  (as long as B's operations are internally ordered)
```

The difference is subtle but important. Sequential consistency allows a replica to be "behind" real-time, as long as it processes operations in a consistent order. This is cheaper because replicas don't need to synchronize on every operation.

**Where you see it:** ZooKeeper provides sequential consistency for reads (not linearizable). Reads from a single client are ordered, but a client might read stale data if it's connected to a lagging follower. ZooKeeper offers a `sync` command to force a linearizable read when needed.

## Causal Consistency

Causal consistency preserves cause-and-effect relationships. If operation A could have influenced operation B (A "happened before" B), then every node sees A before B. But operations that are **concurrent** (neither caused the other) can be seen in any order.

```
Causal relationship:
  Alice posts: "Anyone want to grab lunch?"     (A)
  Bob replies: "Sure, where?"                    (B, caused by A)
  
  Every node must show A before B.

Concurrent (no causal relationship):
  Alice posts about lunch                        (A)
  Charlie posts about the weather                (C)
  
  Some nodes show A before C, others show C before A. Both are valid.
```

### Implementation

Causal consistency is tracked using **vector clocks** or **dependency tracking**. Each operation carries metadata about which operations it depends on. A node only makes an operation visible after all its dependencies are visible.

```
Vector Clock Tracking:

Alice's post:  vc = {Alice: 1}
Bob's reply:   vc = {Alice: 1, Bob: 1}  ← depends on Alice's post

Node receives Bob's reply first:
  → Holds it in buffer
  → Waits for Alice's post (dependency)
  → Delivers Alice's post, then Bob's reply
```

### The Sweet Spot

Causal consistency is the strongest model that doesn't require global coordination. It can be implemented without a single leader and without cross-datacenter synchronous replication. This makes it the strongest consistency model that's compatible with availability during partitions.

**Where you see it:** MongoDB (with causal consistency sessions), some CRDT-based systems, academic systems like COPS and Eiger.

## Read-Your-Writes (Session Consistency)

A pragmatic guarantee: after you write a value, your subsequent reads will see that write (or a later one). Other clients might still see stale data.

This is the "Instagram photo" problem from the opening. You posted the photo — you should see it immediately, even if other users see it with a delay.

### Implementation Strategies

**Sticky sessions.** Route a user's requests to the same replica. If they wrote to replica A, their reads go to replica A. Simple but breaks if the replica fails.

**Read-after-write token.** The write returns a token (e.g., a timestamp or log position). Subsequent reads include this token. The replica only serves the read if it's caught up to that position.

```
Sequence:
1. Client writes x=5 to Leader → gets token: {log_position: 42}
2. Client reads from Follower, includes token: {log_position: 42}
3. Follower checks: am I caught up to position 42?
   - Yes → serve the read
   - No  → wait until caught up, then serve (or redirect to leader)
```

**Read from leader after write.** For a short window after writing (e.g., 10 seconds), route that user's reads to the leader. After the window, followers have likely caught up.

### Cross-Device Consistency

Read-your-writes gets tricky across devices. You post from your phone, then check on your laptop. Different devices, different sessions, potentially different replicas.

Solutions:
- Use a centralized session store that tracks the user's latest write position
- Route all of a user's devices to the same datacenter
- Include the write token in the user's profile/session, accessible from any device

## Monotonic Reads

A guarantee that you won't see time go backward. If you read a value at time T, subsequent reads won't return a value from before T.

Without monotonic reads:
```
Read 1 → Replica A (up to date):    x = 5
Read 2 → Replica B (lagging):       x = 3  ← Time went backward!
```

This is disorienting for users. A comment appears, then disappears on refresh, then reappears. Monotonic reads prevent this by ensuring each client reads from replicas that are at least as up-to-date as the last replica they read from.

**Implementation:** Similar to read-your-writes — track the last read position and only serve from replicas at or past that position.

## Eventual Consistency

The weakest useful guarantee. If no new writes occur, all replicas will **eventually** converge to the same value. No bound on how long "eventually" takes.

```
Write x=5 at T=0:

T=0:   Leader: x=5    Follower1: x=3    Follower2: x=3
T=1:   Leader: x=5    Follower1: x=5    Follower2: x=3
T=2:   Leader: x=5    Follower1: x=5    Follower2: x=5  ← converged
```

Eventual consistency is the default for most distributed databases (Cassandra, DynamoDB, Riak) because it allows maximum availability and performance. No coordination required — every node accepts writes independently and syncs in the background.

### Conflict Resolution

When multiple nodes accept concurrent writes to the same key, they must resolve conflicts during convergence:

**Last-Write-Wins (LWW):** Use timestamps to pick the "latest" write. Simple but lossy — concurrent writes are silently dropped. Clock skew can cause the "wrong" write to win.

**CRDTs (Conflict-free Replicated Data Types):** Data structures designed to merge automatically without conflicts. A G-Counter (grow-only counter) tracks increments per node and sums them. An OR-Set (observed-remove set) tracks additions and removals without conflicts.

**Application-level resolution:** Return all conflicting versions to the application and let it merge. Amazon's shopping cart famously used this — conflicting carts were merged by taking the union of items.

## Choosing a Consistency Model

| Model | Latency | Availability | Use Case |
|-------|---------|-------------|----------|
| Linearizable | High | Low during partitions | Locks, leader election, financial transactions |
| Sequential | Medium | Medium | Coordination with relaxed real-time requirements |
| Causal | Low-Medium | High | Social feeds, collaborative editing |
| Read-your-writes | Low | High | User-facing apps where users expect to see their own changes |
| Eventual | Lowest | Highest | Caches, analytics, metrics, DNS |

The key insight: **most systems use multiple consistency models simultaneously.** The user profile read is eventually consistent. The password change is linearizable. The social feed is causally consistent. The payment is serializable.

Don't pick one model for your entire system. Pick the right model for each operation based on its correctness requirements.

## Interview Application

When discussing consistency in an interview, show that you understand the spectrum and can make targeted choices:

"For the social media feed, I'd use eventual consistency. A post appearing 2 seconds late on some users' feeds is acceptable, and it lets us serve reads from local replicas with sub-10ms latency. We'd add read-your-writes consistency for the author — when you post something, you should see it immediately on your own feed. We implement this with sticky sessions to the same replica, falling back to reading from the leader for 10 seconds after a write."

"For the messaging system, I'd use causal consistency. Messages in a conversation must appear in causal order — a reply must appear after the message it's replying to. But messages in unrelated conversations can be delivered in any order. We track causal dependencies using vector clocks per conversation."

"For the distributed lock service, we need linearizability. If two nodes both acquire the same lock, we get data corruption. We'd use etcd or ZooKeeper, which provide linearizable reads through Raft consensus. The cost is higher latency per lock acquisition (~10-50ms), but correctness is non-negotiable here."

"I wouldn't use linearizability everywhere — it's too expensive. The key is matching the consistency model to the operation's requirements. Most reads in our system are eventually consistent. Only the critical coordination paths need strong consistency."

---

## Related Articles

**Next in series:** [Distributed Transactions](distributed-transactions.md)

**Previous in series:** [CAP and PACELC Theorem](cap-and-pacelc-theorem.md)

**See also:**
- [Database Isolation Levels](../transactions/database-isolation-levels.md) — isolation levels are the single-node analog of distributed consistency models
