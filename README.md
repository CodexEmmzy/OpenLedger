# OpenLedger

OpenLedger is a double-entry ledger project built around one requirement: concurrent activity must never corrupt an account balance. The repository is being developed in phases. The current Phase 0 establishes the service, database, API contract, and testing foundations; it does not yet post ledger transactions.

> **Current scope:** account and transfer routes are contract-defined stubs and return `501 Not Implemented`. Do not use this project to hold or move real money.

## Project Guide

- [Phase 0 scope and exit checklist](docs/roadmap/phase-0.md)
- [Performance and correctness targets](docs/targets.md)
- [Architecture decisions](docs/adr/)
- [OpenAPI contract](docs/openapi.yaml)

The targets describe the intended system, not measured Phase 0 results. Throughput, contention, latency, idempotency, and failure-recovery goals must be demonstrated by the tests and load tooling planned for later phases.

## Design Goals

- Represent money as integer minor units such as kobo or cents; never use floating-point arithmetic for balances.
- Treat Postgres as the system of record and enforce ledger invariants at the database transaction boundary.
- Start with a small number of understandable services and add infrastructure only when measurements justify it.
- Define the HTTP contract in OpenAPI and validate requests against that contract.
- Make local startup, automated checks, and later performance measurements repeatable.

These goals are captured in the [architecture decision records](docs/adr/). The project has chosen Fastify, Postgres-first storage, and reviewable raw SQL migrations. It has not chosen Prisma or an ORM.

## Architecture

Phase 0 runs the API and worker against one Postgres primary through PgBouncer. Migrations connect directly to Postgres. Redis is present in Compose as a reserved service but no application currently depends on it. The simulator and dashboard are placeholders, not production clients.

```mermaid
flowchart LR
	client[Client] --> api[Fastify API]
	simulator[Simulator placeholder] --> api
	api --> pool[PgBouncer]
	worker[Worker heartbeat] --> pool
	pool --> db[Postgres primary]
	migrator[Migration service] --> db
	redis[Redis reserved, unused]
```

The API currently exposes `GET /health` and contract-shaped account and transfer routes. Health checks verify that Postgres answers a query. Account and transfer routes validate request shapes and return `501`. The worker performs a periodic database heartbeat. These behaviors are foundation checks, not ledger functionality.

## Repository Layout

| Path                 | Responsibility                                                           |
| -------------------- | ------------------------------------------------------------------------ |
| `api/`               | Fastify application, routes, database plugin, and API integration tests  |
| `worker/`            | Background worker process; currently a database heartbeat                |
| `simulator/`         | Local traffic-simulator service placeholder                              |
| `dashboard/`         | Operator UI placeholder and future dashboard notes                       |
| `packages/shared/`   | Environment parsing, logging, money helpers, and generated OpenAPI types |
| `migrations/`        | Raw SQL database migrations managed by `node-pg-migrate`                 |
| `docs/openapi.yaml`  | Source API contract                                                      |
| `docs/adr/`          | Accepted technical decisions and their rationale                         |
| `docs/roadmap/`      | Phase scope, status, and exit criteria                                   |
| `.github/workflows/` | Continuous integration checks                                            |

The repository uses npm workspaces. The API, worker, and simulator are separate processes, while shared utilities remain in one package until their ownership needs justify a more granular split.

## Requirements

- Docker with the Compose v2 plugin for the complete local stack.
- Node.js 22 or newer and npm for running checks or services directly on the host.
- A running Postgres service for migrations and integration tests.

The checked-in `.env.example` documents local values. Copy it to `.env` as a reference when useful, but host-run Node processes do not automatically load `.env`; export the needed variables in the shell first. `.env` files other than `.env.example` are ignored by Git. Compose and example credentials are development-only and must not be reused in a deployed environment.

## Start the Full Stack

From the repository root:

```bash
docker compose up --build
```

Compose starts Postgres and Redis. Once Postgres is healthy, the migration service applies migrations while PgBouncer starts; the API waits for both migration completion and PgBouncer readiness, and the worker waits for migration completion and PgBouncer readiness. Database data is stored in the `pgdata` named volume and remains between ordinary `docker compose down` and subsequent starts.

| Service    | Local address                  | Phase 0 behavior                        |
| ---------- | ------------------------------ | --------------------------------------- |
| API        | `http://localhost:3000`        | Health route and validated route stubs  |
| API health | `http://localhost:3000/health` | Checks Postgres connectivity            |
| Simulator  | `http://localhost:3001/health` | Placeholder health endpoint             |
| Postgres   | `localhost:5432`               | Primary database and migration target   |
| PgBouncer  | `localhost:6432`               | Transaction-pooling connection endpoint |
| Redis      | `localhost:6379`               | Started, not used by application code   |

Stop services with `docker compose down`. `docker compose down -v` also deletes the database volume and its contents; use it only when you intend to discard local database state.

## Install and Check Locally

Install dependencies once:

```bash
npm ci
```

The checks that do not require a running database are:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
```

Integration tests require Postgres and an applied schema. With the Compose database running, set the connection URL and run the migration and integration suite.

PowerShell:

```powershell
$env:DATABASE_URL = 'postgres://openledger:openledger@localhost:5432/openledger'
npm run migrate
npm run test:integration
Remove-Item Env:DATABASE_URL
```

Bash:

```bash
export DATABASE_URL=postgres://openledger:openledger@localhost:5432/openledger
npm run migrate
npm run test:integration
unset DATABASE_URL
```

The integration suite uses a real Postgres database. GitHub Actions creates a Postgres service, applies migrations, and runs those tests separately from unit checks.

## Run Services on the Host

Use Docker Compose for Postgres and PgBouncer, then open separate terminals for the processes you need. API and worker require `DATABASE_URL`; the simulator does not.

```bash
npm run dev:api
npm run dev:worker
npm run dev:simulator
```

The `dev:*` scripts watch source files. To run one process, start only its command. Set `DATABASE_URL` in that terminal before starting the API or worker.

## Configuration

Configuration is parsed and validated at process startup by the shared environment schemas. Invalid values stop the service rather than silently falling back to unusable configuration.

| Variable             | Used by        | Default or requirement     |
| -------------------- | -------------- | -------------------------- |
| `NODE_ENV`           | All services   | `development`              |
| `LOG_LEVEL`          | All services   | `info`                     |
| `DATABASE_URL`       | API and worker | Required connection string |
| `PORT`               | API            | `3000`                     |
| `WORKER_INTERVAL_MS` | Worker         | `30000`                    |
| `SIMULATOR_PORT`     | Simulator      | `3001`                     |

The API uses structured Pino logs and assigns a request ID to each request. A supplied `x-request-id` is echoed; otherwise the API generates one. The ID is included in error responses where applicable.

## API Contract and Money

`docs/openapi.yaml` is the source API contract. Request schemas are loaded by the API and used for Fastify validation. TypeScript contract types are generated into `packages/shared/src/openapi.ts`; regenerate them after contract changes with:

```bash
npm run openapi:types
```

Do not edit the generated type file directly. Account and transfer endpoints establish request and response shapes, but their handlers intentionally return `501` in this phase. Money fields use integer minor units. See [ADR 0001](docs/adr/0001-integer-minor-units.md) before changing amount representation.

## Database and Migrations

Postgres is the system of record. `node-pg-migrate` applies versioned migrations from `migrations/`; application database access uses parameterized `pg` queries. API and worker connect through PgBouncer in transaction-pooling mode, while the migration service connects directly to Postgres.

Phase 0 currently creates the `pgcrypto` extension only. It does not yet define accounts, ledger transactions, entries, idempotency records, or an outbox. Schema and transaction design for those records belongs to later phases and must preserve the invariant that each posted transaction balances to zero.

## Tests and Continuous Integration

- Unit tests cover shared money and environment helpers.
- API integration tests exercise request validation and health behavior against Postgres.
- `npm run lint`, `npm run typecheck`, and `npm run format:check` gate source quality.
- GitHub Actions runs local checks and integration tests against a Postgres service.

Phase 0 does not yet contain the concurrency, property-based invariant, k6 load, or failure-injection tests listed in [the target matrix](docs/targets.md). Do not report target throughput or latency numbers as achieved until results are checked in with the tooling that produced them.

## Security and Publication Notes

This is an engineering foundation, not a production deployment. Compose credentials are intentionally simple local-development values. Do not put real credentials, customer data, or production keys in source, documentation, test fixtures, or screenshots. Keep local environment files and editor/session artifacts out of commits; review `git status` and the staged diff before publishing.

No project license has been selected yet. Decide on a license before presenting this as an openly licensed public project. Deployment hardening, authentication, authorization, key management, threat modeling, audit retention, and operational runbooks are not implemented in Phase 0.

## Roadmap and Visual References

Phase-specific scope and exit criteria live in [docs/roadmap/phase-0.md](docs/roadmap/phase-0.md); scaling targets live in [docs/targets.md](docs/targets.md). Architecture decisions live under [docs/adr/](docs/adr/).

Architecture and interface designs can be added as they are finalized. Visual assets supplied for the project will be kept in documentation assets and referenced from the relevant guide, with captions and alternative text where appropriate. No design or image files are part of the current Phase 0 baseline.
