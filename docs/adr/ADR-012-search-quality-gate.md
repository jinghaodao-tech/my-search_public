# ADR-012: Search quality regression gate

## Context

A ranking change can preserve latency while making results less useful.

## Decision

A versioned 50-document and 20-query English/Japanese dataset is evaluated in CI. P@1, MRR, Recall@5, and nDCG@5 thresholds fail the command when breached.

## Consequences

Search quality regressions become review-visible and reproducible.