# ADR-008: AI summaries as optional helpers

## Context
AI providers are external and may be unavailable or intentionally unset.
## Decision
Keep AI summaries and keyword expansion optional; core collection, search, CRUD, import/export, and SQLite persistence work without provider keys.
## Alternatives
Make AI mandatory or persist automatic AI decisions.
## Consequences
The local-first workflow remains usable and auditable without external services.
## Evidence in code
`services/ai_service.ts`, `routes/ai_routes.ts`.
## Reversal condition
Reconsider only with explicit provider, privacy, and failure-mode requirements.
