# ADR 0001: Money is stored as integer minor units

## Status

Accepted

## Context

Ledgers that store money as IEEE-754 floats (or as JSON numbers that went through a float) silently lose precision. Naira kobo and US cents must round-trip exactly.

## Decision

All amounts are integers of the smallest currency unit (kobo, cents). In Postgres that is `BIGINT`. In TypeScript that is `bigint` (`MinorUnits`). APIs expose amounts as JSON integers (or integer strings if a value would exceed `Number.MAX_SAFE_INTEGER`). Floats are rejected at parse time.

Never use `number` arithmetic for money. Never use `NUMERIC` with a scale that implies decimal-as-float conversion in the application.

## Consequences

- Application helpers live in `@openledger/shared` (`parseMinorUnits`, `formatMinorUnits`).
- Schema and OpenAPI must not use `number`/`float`/`double` for money.
- Display-layer decimals (e.g. `10.50`) are formatting only, not storage.
