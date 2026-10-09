# ADR 0003: Postgres first; Redis only after measurement

## Status

Accepted

## Context

The architecture sketch fans reads out to Redis and a replica. Adding those on day one would hide whether the primary can already meet the write target and would add failure modes before any ledger exists.

## Decision

Postgres is the system of record and, in Phase 0, the only datastore the application talks to.

- `docker-compose.yml` starts Redis so later phases have a place to land.
- Application config does **not** require `REDIS_URL` until a k6 (or equivalent) measurement shows the primary cannot meet cached-read p99.
- API, worker, and jobs connect through PgBouncer in transaction mode. Migrations may connect to Postgres directly.

## Consequences

- Fewer moving parts to debug during foundations.
- Adding Redis is an explicit later ADR backed by numbers from `docs/targets.md`.
