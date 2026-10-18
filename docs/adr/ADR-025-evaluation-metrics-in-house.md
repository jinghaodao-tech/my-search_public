# ADR-025: Keep evaluation metrics in-house, but hold them to a reference definition

## Context

Search quality metrics — Precision@k, R-Precision, MRR, Recall@5, nDCG@5 — are
implemented by hand in `scripts/evaluate_search_quality.ts`. Established
implementations of these metrics exist (`trec_eval`, `ir_measures`, `ranx`).
They are Python tools; this project is TypeScript, and the evaluation runs as
part of `npm run evaluate:search`.

The in-house implementation has already produced one defect. `precisionAt`
divides by `Math.min(k, results.length || k)` rather than by `k`:

```ts
function precisionAt(results: string[], expected: string[], k: number): number {
  const set = new Set(expected);
  return results.slice(0, k).filter(id => set.has(id)).length
       / Math.min(k, results.length || k);
}
```

With a variable denominator, a case that returns fewer than `k` results scores
higher than the standard definition allows. The reported Precision@3 exceeded
its own theoretical upper bound, which is impossible under the standard
definition. This was caught only because a theoretical-bound check was added
later.

Precision@3 has since been replaced by R-Precision in the gate, but
`precisionAt` remains in the file and is still used for Precision@1. At `k=1`
the denominator is always 1, so there is no present defect — but the function
is still wrong, and calling it with `k>1` reintroduces the error.

## Decision

Keep the metrics in-house. Add two constraints.

1. **Fix `precisionAt` to divide by `k`.** The standard definition is
   `(relevant retrieved in top k) / k`. A query that returns fewer than `k`
   results is penalized, which is correct: returning nothing is not precision.
2. **Every metric carries a reference and a theoretical bound.** Each metric
   in `search_quality_config.ts` gets a one-line comment naming its standard
   definition, and `theoreticalUpperBounds` covers it. The existing
   `assertMetricsWithinUpperBounds` already fails the run when a measured value
   exceeds its bound; this is the mechanism that catches definition drift.

Metrics are not added without both.

## Alternatives

- **Adopt `ir_measures` or `ranx`.** Rejected. They are Python, and the
  evaluation is part of a Node verification pipeline that also builds the
  index, runs the ranking engine, and writes artifacts. Introducing a Python
  boundary in the middle of that pipeline costs more than the metrics are
  worth — they are roughly ten lines each once the definition is fixed.
- **Emit a TREC-format run file and shell out to `trec_eval`.** Rejected for
  the same reason, plus it would make the evaluation depend on an external
  binary being installed.
- **Keep the metrics in-house with no reference definition.** Rejected. This
  is the status quo that produced the Precision@3 defect. The metric was wrong
  for months and was not noticed, because nothing compared it to anything.
- **Delete `precisionAt` entirely since R-Precision replaced it.** Rejected.
  Precision@1 is still the primary gate for the real-data scope and is the
  most legible metric for a reader. It should be correct, not removed.

## Consequences

- Metric definitions stay small and readable, and the evaluation stays a
  single-language pipeline.
- Definition drift is caught by the theoretical-bound check rather than by
  inspection. A measured value above its bound is an implementation defect, by
  construction.
- Fixing the denominator will lower reported Precision@k for `k>1` on cases
  that return fewer than `k` results. Any gate that used the old value must be
  re-derived, not carried over.
- The project accepts responsibility for metric correctness. That
  responsibility is discharged by the bound check, not by trust.

## Reversal

If the metric set grows beyond standard IR measures — graded relevance, rank
correlation, statistical significance between runs — the argument for a
maintained library becomes stronger than the argument for a single-language
pipeline. At that point, export a TREC-format run file and evaluate outside
the Node pipeline.
