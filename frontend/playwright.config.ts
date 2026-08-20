import { defineConfig, devices } from "@playwright/test";

/**
 * Browser smoke — docs/09 §5.7, six flows.
 *
 * Runs against the real compose stack rather than a stubbed backend, because the
 * point of this layer is to catch the wiring that unit and integration tests
 * cannot see: the proxy, the token round trip, the built client talking to the
 * real API. Bring it up first:
 *
 *   docker compose up -d
 *   docker compose exec backend npm run seed
 *   npx playwright test
 *
 * Targets nginx on :80 by default — the entry point closest to a deployment, and
 * the one that exercises the same-origin proxy. Override with E2E_BASE_URL.
 */
export default defineConfig({
  testDir: "./e2e",
  // The suite writes to a shared database: one invoice's stock deduction is
  // another test's starting state. Serial execution keeps failures readable.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
