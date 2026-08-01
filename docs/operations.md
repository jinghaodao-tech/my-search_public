# Search Operations

## Index health

Run the read-only check before and after large imports or restores:

```powershell
npm.cmd run check:search-index
```

It checks SQLite integrity, foreign keys, FTS/card parity, orphan FTS rows,
and missing precomputed card tokens. It never repairs or deletes data.

To rebuild only the derived FTS index, stop active writers and run:

```powershell
npm.cmd run rebuild:search-index
npm.cmd run check:search-index
```

The rebuild runs in a transaction. If the database is locked or read-only it
exits without changing the index and prints the required operator action.

For normal incremental maintenance, use `npm.cmd run sync:search-index`.

Token backfill can be resumed from the last reported ID:

```powershell
npm.cmd run backfill:card-tokens -- --batch-size 500
npm.cmd run backfill:card-tokens -- --batch-size 500 --after-id <lastId>
```

## Large datasets

`cards_fts` is a rebuildable derived index. Keep `tokens_json` and
`doc_length` populated during imports, run the index check after bulk writes,
and capture benchmark output for the expected corpus size. A failed check
should stop automated publishing until the database is backed up and the
index is rebuilt deliberately.

## Recovery

Use the existing `npm.cmd run backup` command before bulk maintenance. Keep
the database and its backup directory together; do not treat a successful
HTTP response as proof that the SQLite file is healthy.
