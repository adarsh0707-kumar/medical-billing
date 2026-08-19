import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Keeps morgan and Prisma's query logging out of the assertion output, and
    // is what the app checks to stay quiet.
    env: { NODE_ENV: "test" },
    // Every file shares one PostgreSQL database and truncates between tests, so
    // they must not run concurrently. Correctness over wall-clock here — the
    // whole suite takes seconds.
    fileParallelism: false,
    globalSetup: ["./tests/setup/global-setup.js"],
    setupFiles: ["./tests/setup/each-test.js"],
    testTimeout: 20000,
    hookTimeout: 60000,
    include: ["tests/**/*.test.js"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.js"],
      exclude: ["src/index.js", "src/utils/seed.js", "src/config/redis.js"],
      // A gate on the two files where a regression is a financial or security
      // incident rather than a bug. Deliberately not a whole-repo percentage:
      // that number goes up by testing whatever is easiest, which is not the
      // same as testing what matters.
      thresholds: {
        "src/controllers/billing.controller.js": { statements: 90, lines: 90 },
        "src/middlewares/auth.middleware.js": { statements: 90, lines: 90 },
      },
    },
  },
});
