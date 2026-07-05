import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 7_500 },
  fullyParallel: false,
  reporter: [["list"]],
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
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PORT: String(port),
      DB_PATH: "data/e2e-test.db",
      MOCK_AI_SUMMARY: "true",
      IMPORT_RATE_LIMIT: "1000",
      E2E_RESET_DB: "true",
    },
  },
});
