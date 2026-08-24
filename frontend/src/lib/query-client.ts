import { QueryCache, QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

/**
 * The shared query client (G-16).
 *
 * Data fetching used to be hand-rolled per screen: an effect, a `loading`
 * boolean, a `try/catch` that fired a toast, and a `setState` in the effect body.
 * Eleven of those. None was wrong, but none could cancel a request either, so a
 * fast route change could land a stale response over a fresh one — and every
 * screen re-implemented the same three pieces of state slightly differently.
 */

/**
 * One toast per failed query, raised centrally.
 *
 * Each call site used to write its own `catch { toast.error(...) }`, which is
 * why the messages had drifted apart. A query can still override this with its
 * own `meta.errorMessage`.
 */
const queryCache = new QueryCache({
  onError: (_error, query) => {
    const message =
      (query.meta?.errorMessage as string | undefined) ??
      "Something went wrong loading this page";
    toast.error(message);
  },
});

export const queryClient = new QueryClient({
  queryCache,
  defaultOptions: {
    queries: {
      // A pharmacy till is not a dashboard left open for hours: stock and
      // invoices move constantly, and a stale figure on a stock screen is worse
      // than a brief spinner. Thirty seconds is long enough to make tab-switching
      // and back-navigation feel instant without showing yesterday's stock.
      staleTime: 30_000,
      // The API's own error handling already distinguishes a 401 (refreshed and
      // retried once by the axios interceptor) from a real failure, so a blanket
      // retry mostly just delays the error the user needs to see.
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
