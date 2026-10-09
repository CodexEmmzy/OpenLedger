# ADR 0004: Raw SQL via node-pg-migrate; no ORM

## Status

Accepted

## Context

Ledger correctness depends on constraints, transactions, and explicit `BIGINT` columns. ORMs often hide types (especially money) and generate migrations that are hard to review.

## Decision

Use **node-pg-migrate** with SQL (or `pgm.sql`) migrations. Access Postgres with `node-pg` (`pg`). No Prisma, Knex query builder, or TypeORM.

Stay with this tool for the life of the project.

## Consequences

- Schema changes are reviewable SQL.
- Application code writes parameterized SQL.
- Type safety comes from TypeScript + OpenAPI types, not from an ORM.
