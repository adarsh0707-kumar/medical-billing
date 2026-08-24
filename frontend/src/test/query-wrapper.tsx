import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * A QueryClientProvider for tests (G-16).
 *
 * A fresh client per call, so one test's cache cannot answer another's query —
 * the shared app client would make tests order-dependent in exactly the way a
 * cache is designed to.
 *
 * Retries off: the app retries once, which in a test only turns an intended
 * failure into a slow intended failure.
 */
export function createQueryWrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
    },
  });

  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}
