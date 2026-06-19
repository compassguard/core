# Pending: Policy Cache for Hybrid Architecture

## Status

**Pending** — Deferred from the initial hybrid architecture proposal to reduce scope.

## Intent

Add a local policy cache to the hybrid architecture so the local proxy can make conservative decisions during hosted backend outages without depending on network availability.

## Product Value

- Enables conservative local decisions during hosted backend outages.
- Reduces latency for frequently accessed policy data.
- Provides fallback behavior for high-risk operations when hosted evaluation is unreachable.

## Scope

### In Scope

- Local policy snapshot storage (version, expiry, retrieval timestamp).
- Policy cache refresh on startup and when snapshot expires.
- Fallback behavior: use cached policy for conservative denies or explicitly safe low-risk checks during hosted outage.
- Cache invalidation when hosted policy updates.

### Out of Scope

- Real-time policy synchronization (websockets, SSE).
- Multi-version policy support.
- Policy conflict resolution between local cache and hosted state.

## API Contract Addition

```http
GET /v1/policies/snapshot?clientVersion=<version>
```

Returns the latest policy snapshot, version, expiry, and compatibility status.

## Requirements (from deferred FR-CACHE)

- **FR-CACHE-001**: The local proxy MUST store policy snapshot, version, expiry, and retrieval timestamp.
- **FR-CACHE-002**: The local proxy MUST refresh policy cache on startup and when the snapshot is expired or incompatible.
- **FR-CACHE-003**: The local proxy MAY use a valid cache for local preflight but MUST NOT use cache alone to allow high-risk operations when hosted evaluation is reachable.
- **FR-CACHE-004**: When hosted policy sync fails, the local proxy MUST use cached policy only for conservative denies or explicitly safe low-risk checks.

## Deferred Scenario

### Policy cache refresh

- GIVEN the local policy snapshot is expired
- WHEN the local proxy starts or receives the next guarded call
- THEN it MUST request the latest snapshot
- AND it MUST store the returned version, expiry, and compatibility state.

## Dependencies

- Requires the hybrid architecture HTTP API contract to be implemented first.
- Requires hosted backend policy snapshot endpoint.

## Next Steps

When ready to implement:
1. Add `GET /v1/policies/snapshot` endpoint to hosted backend.
2. Implement local policy cache storage and refresh logic.
3. Update local proxy to use cache for fallback decisions.
4. Add cache invalidation on hosted policy updates.
