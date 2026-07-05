# Test Coverage

Last verified: 2026-07-05

## Commands

```bash
npm run typecheck
npm test
npm run acceptance:test
```

## Latest Results

| Command | Result |
|---|---:|
| `npm run typecheck` | passed |
| `npm test` | passed 71/71 |
| `npm run acceptance:test` | passed 46/46 |

## API / Server Tests

| Area | Test |
|---|---|
| Health | returns health status |
| Request ID | echoes `X-Request-Id` response header |
| Card CRUD | creates a card |
| Validation | rejects an empty title |
| Validation | rejects an oversized body |
| Not found | returns 404 for a missing card id |
| Card CRUD | updates a card without changing its id |
| Card CRUD | deletes a card |
| Link cleanup | removes deleted card ids from other cards links |
| Bulk validation | rejects bulk operations when `ids` is not an array |
| Bulk operations | archives, restores, and bulk deletes cards |
| Bulk link cleanup | removes bulk-deleted card ids from remaining cards links |
| Link validation | rejects self links |
| Links / Backlinks | creates and removes bidirectional links |
| KJ groups | assigns and removes a card from a KJ group |
| CSV import validation | rejects invalid CSV imports |
| JSON import validation | rejects invalid JSON imports |
| Rate limiting | applies rate limiting to import APIs |
| Search metadata | returns title match fields and keywords |
| Search metadata | returns body match fields and keywords |
| Search metadata | returns tag match fields and keywords |
| Scheduler validation | rejects an empty scheduler cron expression |
| Collect validation | rejects non-boolean collect background flag |
| Collect validation | rejects invalid collect config |
| BM25 run validation | rejects an empty run mode id |

## Acceptance / Module Tests

| Area | Test |
|---|---|
| API validation | returns 404 for invalid IDs |
| API validation | returns 400 for empty create bodies |
| BM25 search | ranks exact and partial matches above unrelated cards |
| BM25 search | does not crash for empty and missing queries |
| BM25 scoring | reflects keyword weight and synonyms in scores |
| BM25 limit | keeps result count within `resultLimit` |
| BM25 weighting | gives higher contribution to weighted keywords |
| BM25 synonyms | matches synonyms in search results |
| Performance | stays under the performance threshold for a generated corpus |
| Card CRUD | creates, reads, updates, and deletes cards |
| Archive / Restore | archives and restores cards |
| Bulk archive | bulk archives multiple cards |
| Bulk delete | bulk deletes cards and removes link references |
| Tags | adds, removes, and searches tags |
| Tag junction table | stores tags in `card_tags` when cards are created |
| Tag update | replaces old tag relations when tags are updated |
| Tag removal | removes tag relations when tags are cleared |
| Backlinks | returns backlinks when A links to B |
| Link junction table | stores Zettelkasten links in `card_links` |
| Self-link rejection | rejects self links through the API |
| Duplicate link handling | does not duplicate link rows when the same link is added twice |
| Link removal | removes link rows when cards are unlinked |
| Junction persistence | persists tags and links through junction tables |
| Card deletion cleanup | removes tag and link relations when a card is deleted |
| Bulk delete cleanup | bulk delete removes related tag and link rows |
| API compatibility | keeps API responses compatible with `tags` and `links` arrays |
| KJ groups | creates, updates, assigns, and deletes KJ groups |
| CSV import | imports valid CSV |
| JSON import | imports valid JSON |
| Import error handling | does not crash the process for invalid import input |
| Markdown export | returns a card as Markdown |
| Markdown export headers | sets Markdown download headers |
| Markdown export metadata | includes summary, metadata, tags, URL, and links |
| Markdown export not found | returns 404 for missing card IDs |
| Markdown filename safety | uses a safe filename for dangerous title characters |
| Markdown optional sections | omits optional sections when summary, URL, and links are absent |
| Bulk Markdown export | exports multiple cards as a zip of Markdown files |
| Bulk Markdown not found | returns 404 when bulk Markdown export finds no cards |
| DB migration | preserves count and key fields after JSON to SQLite migration |
| Junction migration | migrates legacy `tags_json` / `links_json` into junction tables |
| Migration idempotency | running migration twice does not corrupt relation data |
| KJ migration | creates KJ group schema, indexes, and migrates KJ group JSON |
| Request ID | returns the request ID header |
| Error response | includes `requestId` in validation errors |
| Not found response | includes `requestId` in 404 errors |
| 500 response safety | does not expose stack traces in 500 responses |
| Sensitive logging | does not log sensitive request headers or private card body content |
| Zettelkasten graph | excludes isolated cards from nodes |

## Junction Table Coverage

| Target | Verified behavior |
|---|---|
| Tag junction table | Card creation writes tags to `card_tags` |
| Tag update | Updating tags removes old tag rows and keeps only the new tags |
| Tag removal | Updating a card with no tags leaves `card_tags` empty |
| Tag search | Tag filtering returns only cards with the requested tag |
| Card deletion | Deleting a card removes related `card_tags` rows |
| Link junction table | Creating an A-B link writes rows to `card_links` |
| Bidirectional links | Creating an A-B link is reflected in B-side backlinks |
| Self-link rejection | A-A links return `400` and do not create link rows |
| Duplicate link rejection | Creating the same link twice keeps a single junction row |
| Link removal | `unlinkCards` removes rows from `card_links` |
| Link consistency on card deletion | Deleting B removes A-B link references |
| Bulk delete | Bulk deletion removes related tag and link rows |
| Migration | Legacy `tags_json` / `links_json` data migrates into junction tables |
| Migration idempotency | Running migration twice does not corrupt relation data |
| API compatibility | APIs still return `tags` and `links` arrays while DB uses junction tables |
