# Design Decisions

My Search App is a local-first knowledge management app. The main design goal is to keep personal notes searchable, portable, and understandable without requiring a hosted backend.

## Why Local-First

Personal notes can contain private drafts, links, learning logs, and work-in-progress ideas. Keeping the default data path local reduces privacy risk, avoids account setup, and makes the app usable without a network connection.

## Why Not Cloud Deployment

The portfolio goal is to show product and backend quality, not to operate a public SaaS. A cloud deployment would add authentication, authorization, tenancy, secret rotation, billing, and abuse controls that are outside the current product scope.

## Why SQLite

SQLite fits a desktop/local-first app because it is embedded, easy to back up, fast for the expected data size, and requires no separate database server. It also supports indexes, migrations, constraints, and transactional writes, which were missing from the original JSON storage.

## Why Not PostgreSQL

PostgreSQL would be a strong choice for a multi-user hosted service, but it adds server setup and operations overhead. For a single-user local app, SQLite gives enough relational structure without changing the deployment model.

## Why Not Elasticsearch

Elasticsearch is powerful for large-scale search clusters, but it would be excessive here. It adds a separate service, indexing operations, memory overhead, and deployment complexity. The current BM25 implementation keeps search local and inspectable.

## Why BM25

BM25 is a transparent lexical ranking algorithm. It is easier to debug than opaque AI-only search, works offline, and gives predictable behavior for keyword-heavy knowledge management tasks.

## Why Not Vector Search First

Vector search can help semantic matching, but it introduces embedding models, model versioning, storage size questions, and less transparent ranking. The current product benefits more from a reliable lexical baseline. Vector search is a future comparison target, not the foundation.

## Why AI Summary Is Not the Core

AI summaries are useful helpers, but they depend on external providers or mock mode. The core app should still work without API keys, credits, or network access. Search, CRUD, import/export, and SQLite persistence remain the durable foundation.

## Why Migrate from JSON to SQLite

JSON files were simple for the first version, but full-file reads/writes made validation, relationships, migrations, and filtering harder. SQLite provides safer persistence, indexes, constraints, and a clearer migration path while staying local-first.

## Why Normalize Tags and Links

Tags and Zettelkasten links started as JSON arrays for simplicity. Moving them into `card_tags` and `card_links` makes filtering, backlinks, deletion cleanup, and future indexing more reliable. Compatibility arrays are still returned by the API so the frontend is not forced to change at once.

## If Multi-User Support Is Added

A hosted multi-user version would need authentication, authorization, tenant-aware schemas, row-level ownership checks, sync/conflict resolution, rate limiting per user, audit logs, and likely PostgreSQL. The current SQLite repository layer would become the boundary for that migration.

## If the Dataset Reaches 1M Items

Likely bottlenecks would be token parsing, ranking all documents, relation hydration, sorting large result sets, and simple text filtering. Improvements would include SQL-side filtering, tag joins, FTS5 experiments, top-k ranking, incremental indexes, background token backfills, and possibly a separate search index. Those changes should be benchmark-driven rather than added prematurely.
