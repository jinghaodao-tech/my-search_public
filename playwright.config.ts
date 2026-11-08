import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 7_500 },
  fullyParallel: false,
  // All files use one local SQLite server and the same fixture candidate IDs.
  workers: 1,
  reporter: process.env.E2E_JSON_OUTPUT_FILE
    ? [["list"], ["json", { outputFile: process.env.E2E_JSON_OUTPUT_FILE }]]
    : [["list"]],
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npx tsx scripts/start_e2e_server.ts",
    url: baseURL,
    reuseExistingServer: process.env.E2E_REUSE_SERVER === "true",
    timeout: 120_000,
    env: {
      PORT: String(port),
      DB_PATH: process.env.E2E_DB_PATH ?? "data/e2e-test.db",
      MOCK_AI_SUMMARY: "true",
      IMPORT_RATE_LIMIT: "1000",
      E2E_RESET_DB: "true",
      RESEARCH_EXPERIMENTS_ENABLED: process.env.E2E_RESEARCH_EXPERIMENTS_ENABLED ?? "false",
      RESEARCH_EXPERIMENTS_STORAGE: "test",
      CARD_SEARCH_ENGINE: process.env.E2E_CARD_SEARCH_ENGINE ?? "fts5",
      READER_TOOLS_ENABLED: process.env.READER_TOOLS_ENABLED ?? "true",
      DEMO_MODE: process.env.DEMO_MODE ?? "false",
      DEMO_DATA_SCOPE: process.env.DEMO_DATA_SCOPE ?? "shared",
    },
  },
});
