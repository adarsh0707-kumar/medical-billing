import { defineConfig } from "vitest/config";
import path from "path";

// Kept separate from vite.config.ts: the app build runs the React Compiler babel
// pass, which the unit tests neither need nor should pay for.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  test: {
    globals: true,
    // jsdom for the component tests Phase 9.5 still has to add; the cart-maths
    // suite is pure and would run fine in node.
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // Vitest defaults to 5s, which is too tight for this suite and made it
    // flaky rather than slow. The component tests drive the UI through
    // `userEvent`, which simulates real typing one keystroke at a time, and the
    // heaviest of them fill a whole form: `Inventory.batches` normally spends
    // 600ms-1.8s per test, but the files run in parallel and jsdom is not cheap,
    // so on a loaded machine those same tests cross 5s and fail on the timeout
    // rather than on an assertion.
    //
    // Observed 2026-08-31: the suite passed at 31s and failed at 62s on the
    // same commit, with the two slowest `Inventory.batches` cases timing out —
    // one at exactly 5000ms, the other with its request simply not yet sent.
    // Both pass 6/6 when that file is run on its own.
    //
    // 15s is headroom, not permission to be slow: a test that genuinely hangs
    // still fails, just after long enough that a busy CI runner is not what
    // decided it. If a test starts needing this much, that is worth
    // investigating on its own rather than raising the number again.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
