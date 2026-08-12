# ADR-023: API status codes, error shape, and idempotency

## Status

Accepted

## Context

Card, candidate, collector, AI, and article-import routes must let clients distinguish invalid input, missing resources, state conflicts, asynchronous work, and unexpected failures. Returning failures as `200` payloads or converting every failure to `400` prevents clients from making correct retry and outage decisions.

## Decision

1. Represent success and failure with HTTP status codes: `400` for invalid input, `401` for authentication failure, `403` for insufficient permission, `404` for missing resources, `409` for state conflicts, `429` for rate limits, and the appropriate `5xx` status for server or upstream failures.
2. Return API errors in the shared JSON shape `{ error, code, requestId, details? }`. `code` is a stable machine-readable value, `error` is a short message, and `requestId` correlates the response with logs.
3. Return `validation_failed` and sanitized validation details for Zod validation failures. Never expose stack traces or internal implementation details in HTTP responses.
4. Record request ID, method, path, status, and duration in structured server logs.
5. Make safely repeatable operations suppress duplicates through unique constraints, transactions, or existing-state checks. Add a general `Idempotency-Key` persistence and replay mechanism only after its endpoint scope and retention policy are defined.
6. Return state conflicts as an explicit `409` with a stable error code instead of presenting them as success. Use `202` and a job identifier for asynchronous work only when a status endpoint exists.

## Alternatives

- Return every failure as `200`: rejected because HTTP clients, monitoring, and retry logic cannot reliably detect failure.
- Return every client error as `400`: rejected because it loses the meaning of authentication, missing resources, conflicts, and rate limits.
- Add a generic idempotency-key system to every POST immediately: deferred because storage, TTL, payload mismatch, and replay semantics must be defined first.
- Use a different error shape in each repository: rejected because integration clients would need repository-specific branching. Domain-specific error codes remain defined by each repository's ADR.

## Evidence

- Shared error construction and request IDs are implemented in `services/http_service.ts`.
- Input validation is implemented under `schemas/` and in route handlers.
- Some duplicate-save and conflict paths are protected by unique constraints and transactions.
- ADR-014 covers client-side non-2xx handling and the shared error contract; this ADR complements it with server-side status classification and idempotency policy.

## Consequences

Clients can determine error category, retryability, and log correlation mechanically. A general idempotency-key mechanism and complete conflict normalization across every route are not implemented yet; the implemented boundary is the existing combination of unique constraints, transactions, and state checks.

## Reversal condition

When external retries, asynchronous jobs, multi-user operation, or distributed deployment requires it, define endpoint scope, TTL, payload mismatch behavior, and response replay for idempotency keys, then update this ADR.
