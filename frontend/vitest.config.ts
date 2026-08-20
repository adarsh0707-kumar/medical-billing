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
  },
});
