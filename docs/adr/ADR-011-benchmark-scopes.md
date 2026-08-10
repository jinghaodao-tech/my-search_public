# ADR-011: Benchmark scope definitions

## Context

A pipeline-only benchmark must not be presented as an HTTP or process cold-start measurement.

## Decision

The benchmark records ranking-only, production-like, candidate near-duplicate, candidate diverse, HTTP candidate API, saved-card HTTP, process cold-start, and warm-request scopes. Each scope writes measured JSON and has a regression threshold.

## Consequences

Latency claims remain tied to the code path actually measured.