# Phase 1: Double-Entry Ledger Core

## Goal

Make Postgres the enforceable source of truth for balanced journal transactions and make the current balance a derived, transactionally maintained projection. The phase is being delivered incrementally; database/repository work is in place, while the public account and transfer routes remain `501` stubs.

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
- Chart-of-accounts policy and ER schema are recorded in [ADR 0005](../adr/0005-chart-of-accounts.md) and the [data model](../data-model.md).

## Chart of Accounts

Each supported currency is seeded with provider clearing (asset), fee income (income), and suspense (liability) system accounts. These accounts permit negative natural balances to represent settlement positions, corrections, and unresolved reconciliation amounts. Customer wallet accounts do not permit negative balances.

Each transaction uses one currency. FX is deferred and must be represented later by linked, independently balanced currency-specific transactions.

## Not Yet Delivered

- Account creation, balance, and transfer HTTP handlers that call the ledger repository. Existing endpoints still validate their contract and return `501`.
- Provider API integration, webhook authentication/deduplication, outbox processing, and reconciliation jobs.
- Property-based ledger tests, sustained k6 throughput/latency results, and failure-injection scripts.
- Production security roles and deployment privilege separation. Current local credentials and database role setup are development-only.

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

Real-money endpoints have an additional security gate: authentication, object authorization, least-privilege database identities, bounded request/rate/concurrency policies, production secret/network controls, and evidence for the high-risk items in the [security guide](../security.md) and [threat model](../threat-model.md) must be completed first. Phase 1 ledger tests do not certify the service for money movement.
