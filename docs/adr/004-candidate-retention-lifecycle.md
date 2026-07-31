# ADR-004: Candidate retention lifecycle

## Context
Unreviewed items should not be silently deleted, while reviewed rejects need bounded retention.
## Decision
Use `unreviewed`, `reviewed_not_saved`, `saved_as_card`, and `expired`; only reviewed-not-saved candidates are eligible for retention expiry.
## Alternatives
Delete all old candidates, or archive saved cards through candidate expiry.
## Consequences
Review decisions are visible and saved cards are protected.
## Evidence in code
`repositories/candidates_repository.ts`.
## Reversal condition
Reconsider if a separate user-configured retention policy is required.
