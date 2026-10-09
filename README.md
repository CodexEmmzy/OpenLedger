# OpenLedger

Double-entry ledger foundations. **Done** when you can start it with one command, hit it with heavy concurrent traffic, and fail to corrupt a single balance.

Phase 0 is scaffolding only: contract-first OpenAPI, Fastify, Postgres through PgBouncer, CI. Transfers are stubs (`501`).

## Start

```bash
docker compose up --build
```

- API: `http://localhost:3000/health`
- Simulator placeholder: `http://localhost:3001/health`
- Postgres: `localhost:5432`
- PgBouncer: `localhost:6432`
- Redis is running but unused until a measurement says we need it ([ADR 0003](docs/adr/0003-postgres-first.md))

## Local tests

```bash
cp .env.example .env
npm ci
DATABASE_URL=postgres://openledger:openledger@localhost:5432/openledger npm run migrate
npm test
DATABASE_URL=postgres://openledger:openledger@localhost:5432/openledger npm run test:integration
```

## Targets

See [docs/targets.md](docs/targets.md). Decisions: [docs/adr](docs/adr). Contract: [docs/openapi.yaml](docs/openapi.yaml).
