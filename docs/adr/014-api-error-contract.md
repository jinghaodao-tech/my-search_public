# ADR-014: Shared API error contract

## Context

Non-2xx responses must not be treated as successful JSON payloads by the browser.

## Decision

JSON and binary API helpers reject non-2xx responses while preserving status, code, and requestId. Server routes use stable error codes for search, export, collector, and candidate state failures.

## Consequences

Failure UX can distinguish validation, not-found, conflict, and server errors.