# OpenLedger

OpenLedger is a double-entry ledger project built around one requirement: concurrent activity must never corrupt an account balance. The repository is being developed in public phases. Phase 1 now provides a database-enforced ledger core and typed repository; the HTTP account and transfer routes are not yet wired to it and still return `501 Not Implemented`.

> **Current scope:** account and transfer routes are contract-defined stubs and return `501 Not Implemented`. Do not use this project to hold or move real money.

## Project Guide

- [Phase 0 scope and exit checklist](docs/roadmap/phase-0.md)
- [Phase 1 ledger core status](docs/roadmap/phase-1.md)
- [Performance and correctness targets](docs/targets.md)
- [Ledger schema and invariants](docs/data-model.md)
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

The local stack runs the API and worker against one Postgres primary through PgBouncer. Migrations connect directly to Postgres. Redis is present in Compose as a reserved service but no application currently depends on it. The simulator and dashboard are placeholders, not production clients. Phase 1 adds the ledger schema and repository module; application endpoints remain stubs until they are deliberately connected to the repository.

The supplied system diagram is the **target architecture**, not a picture of the current deployment. The present and planned designs, request flow, scaling rationale, and Phase 1 local PostgreSQL setup are described in [the architecture guide](docs/architecture.md).

![Target OpenLedger topology with stateless API replicas, PgBouncer, Redis, a Postgres primary, read replica, and workers](docs/OpenledgerArchitecture.png)

_Target topology for a later scale phase. Components beyond the single Phase 0 API and Postgres primary are proposals, not implemented or measured services._

```mermaid
flowchart LR
	subgraph Current_Phase_0
		client[HTTP client] --> api[One Fastify API]
		api --> pool[PgBouncer]
		worker[Heartbeat worker] --> pool
		migrator[Migration job] --> db[(Postgres primary)]
		pool --> db
		redis[(Redis started, unused)]
		sim[Simulator health placeholder]
	end
```

The API currently exposes `GET /health` and contract-shaped account and transfer routes. Health checks verify that Postgres answers a query. Account and transfer routes validate request shapes and return `501`. The worker performs a periodic database heartbeat. These behaviors are foundation checks, not ledger functionality.

## Repository Layout

| Path                              | Responsibility                                                           |
| --------------------------------- | ------------------------------------------------------------------------ |
| `api/`                            | Fastify application, routes, database plugin, and API integration tests  |
| `api/src/modules/ledger/`         | Typed SQL repository and reusable ledger invariant checker               |
| `worker/`                         | Background worker process; currently a database heartbeat                |
| `simulator/`                      | Local traffic-simulator service placeholder                              |
| `dashboard/`                      | Operator UI placeholder and future dashboard notes                       |
| `packages/shared/`                | Environment parsing, logging, money helpers, and generated OpenAPI types |
| `migrations/`                     | Raw SQL database migrations managed by `node-pg-migrate`                 |
| `scripts/seed-accounts.ts`        | Idempotent bulk account seeder for local load testing                    |
| `docs/openapi.yaml`               | Source API contract                                                      |
| `docs/data-model.md`              | Ledger entity diagram and database invariant reference                   |
| `docs/architecture.md`            | Current and target system diagrams and design rationale                  |
| `docs/OpenledgerArchitecture.png` | Supplied target topology image                                           |
| `docs/adr/`                       | Accepted technical decisions and their rationale                         |
| `docs/roadmap/`                   | Phase scope, status, and exit criteria                                   |
| `.github/workflows/`              | Continuous integration checks                                            |

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

The `dev:*` scripts watch source files. Each process can be started independently. The API and worker require `DATABASE_URL` in their process environment. Phase 1 local Linux and Windows PostgreSQL setup is documented in [the architecture guide](docs/architecture.md#local-postgresql-for-phase-1-development).

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

The migrations enable `pgcrypto`, define accounts, transactions, immutable entries, balance projections, and status history, and seed provider-clearing, fee-income, and suspense accounts for NGN and USD. A deferred constraint trigger rejects incomplete or unbalanced posted transactions at commit. Entry triggers update the balance projection atomically and reject customer overdrafts. See the [data model](docs/data-model.md), [Phase 1 status](docs/roadmap/phase-1.md), and [chart-of-accounts ADR](docs/adr/0005-chart-of-accounts.md).

## Tests and Continuous Integration

- Unit tests cover shared money and environment helpers.
- API integration tests exercise request validation and health behavior against Postgres.
- `npm run lint`, `npm run typecheck`, and `npm run format:check` gate source quality.
- GitHub Actions runs local checks and integration tests against a Postgres service.

Phase 1 includes a 500-request hot-account integration test, idempotency and reversal checks, and a reusable invariant checker. It does not yet contain the k6 throughput/latency suite or failure-injection tests listed in [the target matrix](docs/targets.md). Do not report target throughput or latency numbers as achieved until results are checked in with the tooling that produced them.

## Seed Local Accounts

After migrations have been applied and `DATABASE_URL` is set, the seeder creates 10,000 NGN load-test customer accounts by default. Re-running it is safe because each generated account has a stable external reference.

```bash
npm run seed:accounts
npm run seed:accounts -- --count=2000 --currency=USD
```

The supported currencies are currently NGN and USD. The seed command is intended for development databases, not production.

## Security and Publication Notes

This is an engineering foundation, not a production deployment. Compose credentials are intentionally simple local-development values. Do not put real credentials, customer data, or production keys in source, documentation, test fixtures, or screenshots. Keep local environment files and editor/session artifacts out of commits; review `git status` and the staged diff before publishing.

No project license has been selected yet. Decide on a license before presenting this as an openly licensed public project. Deployment hardening, authentication, authorization, key management, threat modeling, audit retention, and operational runbooks are not implemented in Phase 0.

## Roadmap and Visual References

The public roadmap records phase scope and exit criteria in [docs/roadmap/](docs/roadmap/), with scaling targets in [docs/targets.md](docs/targets.md). It distinguishes implemented foundations from planned capabilities so progress remains visible without presenting future work as delivered. Architecture decisions live under [docs/adr/](docs/adr/).

The supplied architecture image is included above and in the [architecture guide](docs/architecture.md). Future diagrams should distinguish implemented behavior from proposed design and include a short rationale so the visuals explain decisions, not just components.
