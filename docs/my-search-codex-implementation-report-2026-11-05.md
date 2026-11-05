# my-search implementation package — local execution report

Date: 2026-11-05  
Worktree: `main`, HEAD `be29373 Integrate site collection, search, and public demo workflows`  
Runtime: Node `v24.16.0`, npm `11.13.0`

## 1. Scope and safety

The checkout already contained extensive uncommitted stable-foundation work before this package was implemented (62 tracked modified files and many untracked research/evaluation files). Those edits were preserved; no reset, checkout, cleanup, commit, push, or merge was performed. The package checksum manifest verified 17 files with zero mismatches.

This change adds an opt-in local experiment surface and protocol. No SQLite schema/migration, production search ranking, default UI, saved card, memo, reader text, or live database was changed. The regular feature default is `RESEARCH_EXPERIMENTS_ENABLED=false`; the E2E server also pins it off. Enabled E2E used a separate DB under `.tmp-vitest/`. A separate backup/restore smoke check used a temporary synthetic SQLite DB and verified that restore returned a mutated marker to its backed-up value (`baseline`).

## 2. Files added or changed for this package

- Added `routes/research_experiment_routes.ts`: loopback-only, strict-field E0/E6 API, consent gate, random session IDs, relative timing, categorical outcomes, hash-chained local JSONL, per-session/all-record deletion.
- Added `quality/e0e6/research-lab.html` and `research-lab.js`: isolated synthetic-task lab. It has no article/query/note free-text entry.
- Added `quality/e0e6/synthetic_tasks.json`, `analysis.mjs`, `verify_synthetic.mjs`, and `build_schedule.mjs`: synthetic answer keys, deterministic seeded E6 condition order, and smoke analysis.
- Added `tests/research_experiment_routes.test.ts`, `tests/research_experiment_analysis.test.mjs`, and two E2E specs for default-off and explicit opt-in behavior.
- Added `docs/experiment-evaluation-protocol-2026-11-05.md` and this report.
- Changed `.env.example`, `.gitignore`, `app.ts`, `config/runtime_config.ts`, `package.json`, `playwright.config.ts`, and `tests/config.test.ts`.

## 3. Test and verification record

| Check | Result | Evidence / limitation |
|---|---|---|
| `npm run typecheck` | Passed | Includes the new API router and runtime flag. |
| `npm run build:frontend` | Passed | Existing frontend compilation. |
| `npm run check:frontend` | Passed | Legacy frontend compatibility check. |
| `git diff --check` | Passed | Git emitted existing CRLF-to-LF warnings for several modified files; no whitespace error. |
| `npm run check:encoding` | Failed on unrelated pre-existing content | `docs/product-positioning-landscape-2026-10-26-ja.md` was flagged for the valid Japanese character `遠` (U+9060). This file is outside this package's changes and was left untouched. |
| `npm run experiment:e0e6:verify` | Passed | 3 Node tests; 3 synthetic tasks, 3/3 synthetic completions, balanced/reproducible condition schedule. This is wiring evidence only. |
| `npx vitest run tests/research_experiment_routes.test.ts tests/config.test.ts tests/reader_tools.test.ts --fileParallelism=false` | 26/26 passed | Final focused rerun including API and Reader regression suites. |
| `npx vitest run tests/migration.test.ts --fileParallelism=false --testTimeout=20000` | 5/5 passed | Existing migration/JSON-to-SQLite fixtures in their isolated test DB. An earlier combined run hit the default 5-second test limit on three migrations; rerun passed with the longer limit. |
| `npx vitest run tests/research_experiment_routes.test.ts ...` (local socket) | Route suite 3/3 passed | Normal sandbox attempt was blocked by `EACCES` binding a loopback ephemeral port. The isolated localhost-only test was rerun in the approved environment. No external network used. |
| `npx playwright test e2e/research-experiment-disabled.spec.ts e2e/reader-tools.spec.ts` | 18 passed, 2 skipped | E2E-only DB. The skips are the existing internal feature-flag and demo-sample cases. Default-off lab/API both returned 404. |
| `E2E_RESEARCH_EXPERIMENTS_ENABLED=true ... npx playwright test e2e/research-experiment-enabled.spec.ts` | 1 passed | Separate port and temporary DB. Checked local lab served, consent required, synthetic event accepted, session deletion worked. |
| Isolated backup/restore smoke | Passed | Synthetic SQLite DB only; restored the backup and read `baseline`. No repository DB was used. |

The entire project test suite and entire Playwright suite were not rerun in this step. Existing live `data/cards.db` was not opened or modified by these checks. When `API_KEY` is configured, the existing global API-key guard still applies; the lab page does not persist or solicit that key.

## 4. E0–E9 state

| Experiment | Current state | What is still missing |
|---|---|---|
| E0 burden map | API connected; synthetic tasks and analysis validated | No human pilot or observed real task data. |
| E6 integration | Mock/lab condition labels, seeded order, local logging, synthetic analysis | The `separated` and `integrated` selections currently label a condition; equivalent B/C interaction flows are not implemented or fidelity-tested. No integration-effect result. |
| E1 display | Condition field and protocol only | V does not yet change app display behavior. |
| E2 timing | Condition field and protocol only | T does not yet change app suggestion timing. |
| E3 grouping | Protocol only | Human-confirmed boundary labels and correction workflow not implemented. |
| E4 tools/authority | Existing typed Reader tools and source tracing; protocol only for comparison | No controlled condition comparison or user evaluation. |
| E5 search | Existing search evaluation infrastructure retained; this package did not change ranking | No new search-quality result; production ranking remains unchanged. |
| E7 continued use | Protocol only | Requires participant and longitudinal study. |
| E8 resumption | Existing Reader resume/source-trace E2E passed | No controlled history/memo/summary comparison. |
| E9 verifiability | Existing source-trace/tool state E2E passed | No controlled explanation/verification study. |

No human pilot or main study was run. Synthetic results are not user benefit evidence. A/V/T fields are independently captured, but only the safe `manual/current/on_request` baseline is used in the synthetic E6 schedule; high-authority execution is not implemented.

## 5. Acceptance status and next steps

- **Passed:** package/checksum integrity, default-off config, loopback-only lab/API, strict refusal of query/URL fields, consent gating, local deletion, relative-time recording, seeded balanced schedule, synthetic analysis, existing Reader integrated E2E, migration idempotency tests, isolated backup/restore.
- **Partial:** stable SQLite data remained untouched and no migrations were added, but this change did not run a byte-for-byte OFF→ON→OFF database invariance comparison. The experiment API writes only to its separate JSONL directory.
- **Not yet accepted for a human study:** accessibility/manual screen-reader review, condition fidelity for E6 B/C, validated natural tasks/labels, preregistered outcomes and sample-size/power analysis, retention window, observer/instrument agreement, and pilot results.

Next implementation should make the B/C synthetic workflows behaviorally equivalent except for their linkage, wire V/T to actual isolated UI behavior if still needed, add a flag-toggle data-invariance E2E using a copied test DB, and only then prepare a human pilot protocol. E5/search-quality improvement remains outside this package and production ranking was not altered.
