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
    // The production stack ships a self-signed certificate by default (see
    // scripts/gen-cert.sh), which the browser correctly refuses. Accepting it
    // here is scoped to the test run and does not weaken the deployment.
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },

    /**
     * A second engine, deliberately scoped to one flow.
     *
     * Running all seven flows twice would roughly double a job that already
     * costs about a minute just to download a browser, and it would buy almost
     * nothing: the other six exercise our React, our proxy and our API, none of
     * which vary by engine in ways a smoke test would catch.
     *
     * The CSV download is the exception, and it is the whole reason this project
     * exists. Saving a file is the one thing in this app built on browser
     * machinery rather than ours — a blob URL, a programmatic anchor click, and a
     * `Content-Disposition` filename — and it is genuinely where engines differ.
     * `lib/download.ts` carries two claims about that (Firefox will not follow a
     * click on a detached anchor; WebKit can cancel the download if the blob URL
     * is revoked synchronously) which were, until this project, unverified
     * assertions in a comment.
     *
     * Firefox rather than WebKit: it is the second engine that can actually be
     * installed and run on a plain Linux box without extra system libraries, so
     * this project is verifiable by whoever is changing it and not only by CI.
     * WebKit needs `libicu`, `libxml2` and `libflite` on the host, which makes
     * it a browser nobody runs before pushing.
     */
    {
      name: "firefox-download",
      use: { ...devices["Desktop Firefox"] },
      grep: /downloads a CSV through the proxy/,
    },
  ],
});
