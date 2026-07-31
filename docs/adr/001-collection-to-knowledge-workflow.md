# ADR-001: Collection-to-knowledge workflow

## Context
Collected articles and saved cards have different purposes and retention rules.
## Decision
Use Collect -> BM25 rank -> Review -> Save as Card -> Organize -> Search -> Export as the primary workflow.
## Alternatives
Treat every collected item as a permanent card, or use one undifferentiated search path.
## Consequences
The candidate lifecycle is explicit and saved knowledge remains stable.
## Evidence in code
`routes/candidate_routes.ts`, `repositories/candidates_repository.ts`.
## Reversal condition
Reconsider if candidates and cards become operationally identical.
