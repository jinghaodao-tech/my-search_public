# ADR-024: Initial rate-limit thresholds and review policy

## Context

The API has general, AI-assisted, and import endpoints with different cost and abuse profiles. A rate limit must protect the local service without making normal interactive search or small imports unusable. The current application is local-first and single-user by default, so these values are operational defaults rather than a per-user quota system.

## Decision

Use a fixed one-minute window with these defaults:

| Bucket | Default | Reason |
|---|---:|---|
| General API | 60 requests/minute | Allows interactive reads and searches while bounding accidental request loops. |
| AI endpoints | 10 requests/minute | AI calls are slower and more expensive than local reads. |
| Import endpoints | 10 requests/minute | Imports are write-heavy and can trigger tokenization and database work. |

Expose the values through `API_RATE_LIMIT`, `AI_RATE_LIMIT`, and `IMPORT_RATE_LIMIT`. Return the shared 429 error contract and emit a structured rate-limit log event when a bucket is exceeded.

These numbers are conservative starting points, not measured probabilities or a security boundary. They are intentionally easy to override for tests and controlled local batch jobs.

## Alternatives

- One limit for every endpoint: rejected because AI and import work have materially different cost profiles.
- No rate limiting for a local-first app: rejected because accidental loops and local integrations can still overload the process.
- Per-user or token-bucket quotas: deferred until authentication and multi-user ownership exist.

## Evidence

- Defaults are implemented in `config/runtime_config.ts` and `middlewares/rate_limiters.ts`.
- Import throttling is covered by the API test suite.
- Rate-limit events are observable through structured logs.

## Consequences

The defaults protect the current single-user service from accidental bursts, but they do not provide tenant isolation or distributed abuse prevention. Threshold changes must be accompanied by a load test or observed request-rate evidence and an update to this ADR.

## Reversal condition

Revisit the values when authenticated multi-user operation, a distributed deployment, measured throttling complaints, or production request-rate data becomes available.
