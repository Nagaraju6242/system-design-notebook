# Future Enhancements

Planned topics to add, organized by priority.

## High Priority

- **Caching** — cache strategies (aside/through/back), eviction policies, cache stampede, distributed caching (Redis/Memcached), consistency patterns
- **Message Queues & Event Streaming** — Kafka internals, consumer groups, partitioning, exactly-once semantics, dead letter queues, event sourcing vs CQRS
- **Rate Limiting & Throttling** — token bucket, sliding window, distributed rate limiting, API gateway patterns
- **Load Balancing** — L4 vs L7, consistent hashing, health checks, connection draining, service mesh
- **API Design** — REST vs gRPC vs GraphQL, pagination strategies, idempotency keys, versioning, backward compatibility
- **Database Scaling** — sharding strategies, read replicas, connection pooling, query optimization, choosing SQL vs NoSQL
- **Authentication & Authorization** — OAuth2, JWT, RBAC/ABAC, API keys, service-to-service auth (mTLS)

## Medium Priority

- **Observability** — distributed tracing (OpenTelemetry), metrics (RED/USE), structured logging, alerting strategies
- **Service Discovery & Communication** — DNS-based, service registries, sidecar proxies, circuit breakers, retries with backoff
- **Data Pipelines & ETL** — batch vs stream processing, CDC (change data capture), data lake patterns, exactly-once processing
- **Container Orchestration** — Kubernetes networking, pod scheduling, resource limits, rolling deployments, health probes
- **DNS & Networking** — DNS resolution, CDN architecture, TCP/UDP, connection pooling, keep-alive

## Lower Priority

- **Unique ID Generation** — UUID, Snowflake, ULID, database sequences at scale
- **Object Storage & CDN** — S3 internals, pre-signed URLs, multi-part uploads, edge caching
- **Notification Systems** — push vs pull, WebSockets, SSE, fan-out patterns, delivery guarantees
- **Task Scheduling** — cron at scale, distributed job queues, idempotent workers, priority queues
