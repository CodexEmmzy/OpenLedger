# Phase 0: Foundations

## Purpose

Establish a repeatable local environment, a validated API contract, database connectivity, and automated checks before implementing ledger writes. This phase is infrastructure and scaffolding only; it does not claim to deliver accounts, balances, or transfers.

## Delivered Baseline

- npm workspaces for the API, worker, simulator, and shared utilities.
- TypeScript strict mode, ESLint, Prettier, and Vitest.
- Fastify API with request IDs, structured logs, health checks, and OpenAPI-driven request validation.
- Postgres primary, PgBouncer in transaction mode, a migration service, Redis reserved but unused, and one-command Docker Compose startup.
- `node-pg-migrate` raw SQL migrations and a baseline `pgcrypto` migration.
- Startup environment validation and a checked-in `.env.example`.
- GitHub Actions jobs for formatting, lint, type checking, unit tests, and Postgres-backed integration tests.
- ADRs for integer minor units, Fastify, Postgres-first infrastructure, and raw SQL migrations.

## Explicitly Not Delivered

- Account, ledger transaction, or entry schema.
- Account creation, balance reads, or transfer posting; the contract-defined account and transfer handlers return `501`.
- Idempotency persistence, outbox processing, webhooks, reconciliation, or audit records.
- Redis caching, read replicas, or production deployment configuration.
- The target concurrency, load, latency, property, and failure-injection test suites.
- An operator dashboard; `dashboard/` is a placeholder.

The absence of these features is intentional for this phase, not evidence that the project has met the associated correctness or performance targets.

## Phase 0 Exit Checklist

Run these checks before treating a source change as ready:

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
```

With Docker available, validate the full-stack path:

```bash
docker compose config --quiet
docker compose up --build
```

Confirm that `http://localhost:3000/health` reports Postgres as up, and that the simulator health route is reachable. The GitHub Actions integration job provides an additional real-Postgres check by applying migrations and running `npm run test:integration`.

Before an external push, review the staged file list and diff, confirm that no local `.env` or editor/session artifacts are included, choose a project license if the repository will be public, and configure the intended Git remote. These repository publication decisions are independent of application test status.

## Decisions Carried Forward

- Postgres remains the source of truth. Add Redis or a replica only after measurements show a need; see [ADR 0003](../adr/0003-postgres-first.md).
- Money remains integer minor units; see [ADR 0001](../adr/0001-integer-minor-units.md).
- Keep Fastify and raw SQL migrations; see [ADR 0002](../adr/0002-fastify.md) and [ADR 0004](../adr/0004-raw-sql-migrations.md).
- Keep the monorepo structure small until distinct domain and infrastructure package boundaries are justified by implemented behavior.

## Next Phase Gate

The initial database-core gate is delivered in [Phase 1](phase-1.md): account and ledger schema, commit-time balancing, append-only entries, transactionally maintained balances, idempotency, and hot-account integration coverage. The next gate is to wire account and transfer endpoints to the repository, add API-level behavior tests, then build load and failure-recovery tooling. Local PostgreSQL development on Linux and Windows is documented in the [architecture guide](../architecture.md#local-postgresql-for-phase-1-development). Docker Compose remains the reproducible local stack and CI environment.
