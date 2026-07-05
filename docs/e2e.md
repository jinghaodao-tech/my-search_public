# Playwright E2E Tests

The E2E suite verifies core user flows through a real browser, complementing the Vitest / Supertest API tests.

## Run Locally

Install Playwright browsers once:

```bash
npx playwright install chromium
```

Run the E2E suite:

```bash
npm run test:e2e
```

Open Playwright UI mode:

```bash
npm run test:e2e:ui
```

## Test Database Strategy

Playwright starts the app with:

```txt
PORT=3100
DB_PATH=data/e2e-test.db
MOCK_AI_SUMMARY=true
```

The E2E server launcher deletes `data/e2e-test.db`, `data/e2e-test.db-shm`, and `data/e2e-test.db-wal` before each run unless `E2E_RESET_DB=false` is set. Production data in `data/cards.db` is not used or modified.

## Covered Flows

- Card creation through the browser UI
- BM25 search through the BM25 tab using card data
- Archive and restore through list selection controls
- KJ group creation, card assignment display, rename, and delete
- Zettelkasten link creation and backlink display

## CI

GitHub Actions installs Playwright Chromium and runs `npm run test:e2e` after type checks and API tests.

## Remaining Coverage Gaps

- AI summary provider behavior is not covered; E2E uses `MOCK_AI_SUMMARY=true`.
- Drag-and-drop KJ assignment is not covered because browser drag events are more fragile than the API-backed assignment path.
- Mobile-specific UI behavior is not covered yet.
