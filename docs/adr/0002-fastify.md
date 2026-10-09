# ADR 0002: Fastify as the HTTP framework

## Status

Accepted

## Context

Phase 0 had three reasonable options: NestJS (structure and DI), Express (familiarity), Fastify (low overhead, schema-aware). Targets include 1,500 transfers/s and p99 write latency under 200 ms on one primary. Extra framework layers would need justification.

## Decision

Use **Fastify 5** with TypeScript.

- JSON Schema validation is native, so the OpenAPI contract can drive request checks without a second validation stack.
- Less ceremony than NestJS while still being modular (plugins).
- Better default throughput/latency than Express for JSON APIs.

NestJS is deferred until (if ever) the process count or module graph makes DI the simpler story. Express is not used.

## Consequences

- Routes are Fastify plugins. Shared domain code stays in `@openledger/shared`, not in a Nest module.
- OpenAPI is the contract; Fastify schemas are derived from it.
