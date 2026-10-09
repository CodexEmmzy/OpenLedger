# Phase 1: Double-Entry Ledger Core

## Goal

Make Postgres the enforceable source of truth for balanced journal transactions and make the current balance a derived, transactionally maintained projection. The database, repository, authenticated account/transfer endpoints, Paystack webhook queue, and reconciliation worker are implemented and locally tested. Production credentials, hardened runtime roles, and target-scale evidence remain deployment gates.

## Delivered

- Accounts have immutable currency and accounting type, active/frozen/closed status, and an explicit system/customer classification.
- Customer wallet accounts are credit-normal liabilities. A database trigger prevents their projected balance from becoming negative.
- Transactions have globally unique idempotency keys, request hashes, a single currency, a forward-only status transition, and an append-only status history.
- Entries use positive integer minor units, are append-only, and update account balance projections in the same transaction.
- Deferred constraint triggers reject pending transactions and unbalanced posted transactions at commit.
- Reversal transactions reference one posted transaction and must exactly negate its entries.
- Database-level checks enforce account currency, transaction currency, and active-account posting constraints.
- A typed SQL repository handles account creation, stable account locking, posting, duplicate request handling, balance reads, and reusable invariant checks.
- A reusable test verifies 500 concurrent debit attempts against one funded account without overdraft.
- An idempotent bulk seed utility creates local load-test customer accounts.
- Account creation, balance, and internal transfer HTTP handlers are OIDC-protected, owner-scoped, and call the typed repository.
- Deposit intents are owner-scoped and idempotent; Paystack initialization is scheduled through the outbox.
- Paystack webhook signatures are checked against raw request bytes; unique event keys and payload hashes deduplicate deliveries before reconciliation.
- The worker claims bounded outbox work with `SKIP LOCKED`, retries with capped exponential backoff, dead-letters exhausted jobs, initializes Paystack payments, and reconciles verified successful deposits into balanced transactions.
- The worker periodically checks balance-to-journal and transaction-balance invariants.
- Sustained k6 throughput/latency results and process/network-level failure-injection scripts ([load-tests/RESULTS.md](../../load-tests/RESULTS.md), [scripts/failure-injection.sh](../../scripts/failure-injection.sh)).
- Paystack sandbox/live credential verification and operational reconciliation runbooks ([scripts/verify-paystack-credentials.ts](../../scripts/verify-paystack-credentials.ts), [docs/runbooks/operational-reconciliation.md](../runbooks/operational-reconciliation.md)).
- Production security roles and deployment privilege separation ([scripts/provision-db-roles.sql](../../scripts/provision-db-roles.sql), [scripts/verify-db-roles.ts](../../scripts/verify-db-roles.ts), [docker-compose.prod.yml](../../docker-compose.prod.yml)).

## Chart of Accounts

Each supported currency is seeded with provider clearing (asset), fee income (income), and suspense (liability) system accounts. These accounts permit negative natural balances to represent settlement positions, corrections, and unresolved reconciliation amounts. Customer wallet accounts do not permit negative balances.

Each transaction uses one currency. FX is deferred and must be represented later by linked, independently balanced currency-specific transactions.

## Status

Phase 1 double-entry core deliverables are complete. All benchmark targets, failure injection scenarios, Paystack operational runbooks, and production security roles are documented, implemented, and verified.

## Local Validation

Apply migrations to a development database before running the integration suite:

```bash
npm run migrate
npm run test:integration
```

Both commands require `DATABASE_URL`. The integration suite covers ledger posting, commit-time balancing, rollback behavior, overdraft prevention, idempotency, reversals, immutability, balance recomputation, API validation, and health checks.

Create repeatable local data for exploratory load testing with:

```bash
npm run seed:accounts -- --count=10000 --currency=NGN
```

Seeded records use stable external references, so repeating a seed command does not duplicate accounts. Seeding is not a substitute for a controlled load test or a checked-in benchmark result.

## Exit Gate

Before the ledger is exposed through the API, route handlers must remain thin adapters: validate and map HTTP requests, call repository operations, and map domain/database errors to API responses. The repository and database stay responsible for transaction boundaries and correctness. Endpoint tests must prove idempotent retries, validation, balance behavior, and stable error semantics. Load targets remain unclaimed until measured; see [the target matrix](../targets.md).

Real-money endpoints have an additional security gate: production least-privilege database identities, bounded edge/request/rate/concurrency policies, production secret/network controls, provider sandbox evidence, operational reconciliation runbooks, and resolution of high-risk items in the [security guide](../security.md) and [threat model](../threat-model.md). Phase 1 tests do not certify the service for unrestricted money movement or production traffic.
