import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import MockAdapter from "axios-mock-adapter";
import api from "@/lib/api";
import { createQueryWrapper } from "@/test/query-wrapper";

/**
 * GUARD G-16 — the property the whole migration exists for.
 *
 * The old pattern was `useEffect(() => { api.get(...).then(setState) })`. Nothing
 * about it was incorrect, but it *cannot express cancellation*: a request whose
 * screen has moved on still resolves, and still calls `setState`. A slow response
 * for a term the user has already backspaced past, or a page they have already
 * left, lands on top of the current one.
 *
 * These assert the two halves of the fix directly — the request is aborted, and
 * a late response cannot win — rather than asserting that a screen renders,
 * which stayed true throughout and is why the bug was invisible.
 */

let mock: MockAdapter;

beforeEach(() => {
  mock = new MockAdapter(api);
});

afterEach(() => {
  mock.restore();
});

/** Mirrors how every converted screen fetches: keyed query, forwarded signal. */
const useTerm = (term: string) =>
  useQuery<string>({
    queryKey: ["probe", term],
    queryFn: async ({ signal }) => {
      const res = await api.get(`/api/probe?term=${term}`, { signal });
      return res.data.value;
    },
  });

describe("query cancellation", () => {
  it("aborts a request whose key has moved on", async () => {
    const signals: AbortSignal[] = [];
    mock.onGet(/\/api\/probe/).reply((config) => {
      if (config.signal) signals.push(config.signal as AbortSignal);
      // "slow": never settles on its own, so only an abort can end it.
      return new Promise(() => {});
    });

    const { rerender } = renderHook(({ term }) => useTerm(term), {
      wrapper: createQueryWrapper(),
      initialProps: { term: "para" },
    });

    await waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0].aborted).toBe(false);

    // The user keeps typing; the previous term is abandoned.
    rerender({ term: "paracet" });

    // This is the assertion the effect-based pattern could not make: the
    // abandoned request is actually cancelled, not merely ignored on arrival.
    await waitFor(() => expect(signals[0].aborted).toBe(true));
  });

  it("does not let a late response overwrite a newer one", async () => {
    const resolvers: Record<string, (v: string) => void> = {};
    mock.onGet(/\/api\/probe/).reply((config) => {
      const term = new URL(config.url!, "http://x").searchParams.get("term")!;
      return new Promise((resolve) => {
        resolvers[term] = (value) => resolve([200, { value }]);
      });
    });

    const { result, rerender } = renderHook(({ term }) => useTerm(term), {
      wrapper: createQueryWrapper(),
      initialProps: { term: "slow" },
    });

    await waitFor(() => expect(resolvers.slow).toBeDefined());
    rerender({ term: "fast" });
    await waitFor(() => expect(resolvers.fast).toBeDefined());

    // The newer request answers first, then the abandoned one answers late —
    // the exact ordering that used to corrupt the screen.
    await act(async () => {
      resolvers.fast("FAST");
    });
    await waitFor(() => expect(result.current.data).toBe("FAST"));

    await act(async () => {
      resolvers.slow("STALE");
    });

    // Still FAST. Under the old pattern both `.then(setState)` callbacks ran in
    // arrival order and the screen would now read STALE.
    expect(result.current.data).toBe("FAST");
  });
});
