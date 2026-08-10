# ADR-013: Deterministic fixture collector

## Context

Core E2E flows must not depend on external feed availability or direct database inserts.

## Decision

The public collect endpoint accepts the portfolio-demo fixture and persists deterministic articles through the normal collector path.

## Consequences

The browser workflow tests the same public collection boundary used by demos.