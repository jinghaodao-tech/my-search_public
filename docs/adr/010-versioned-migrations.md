# ADR-010: Versioned migrations as schema source

## Context

The application must build a fresh SQLite database reproducibly and upgrade legacy databases safely.

## Decision

Base tables and schema changes are created through ordered, transactional migrations. Runtime database setup only opens SQLite, runs migrations, verifies compatibility indexes, and performs legacy relation backfill.

## Alternatives

Keeping a complete latest-schema DDL in database.ts was rejected because it could diverge from migration history.

## Consequences

Fresh and upgraded databases share one schema history. Legacy repair migrations remain explicit and rerunnable.