import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MockAdapter from "axios-mock-adapter";
import api from "@/lib/api";
import Customers from "@/pages/Customers";
import { createQueryWrapper } from "@/test/query-wrapper";

/**
 * docs/09 §5.6 — the Customers screen.
 *
 * Scoped per CONTRIBUTING to what the component owns: which request it makes and
 * when. Whether the API paginates correctly is proven in
 * `tests/billing/customers.test.js`.
 */

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

let mock: MockAdapter;

const page = (n: number) => ({
  success: true,
  data: [{ id: `c${n}`, name: `Customer page ${n}`, phone: "9000000000" }],
  pagination: { pages: 3, total: 30 },
});

beforeEach(() => {
  mock = new MockAdapter(api);
  mock.onGet(/\/api\/customers\?/).reply((config) => {
    const n = Number(new URL(config.url!, "http://x").searchParams.get("page"));
    return [200, page(n)];
  });
});

afterEach(() => {
  mock.restore();
  vi.restoreAllMocks();
});

const listRequests = () =>
  mock.history.get.filter((r) => /\/customers\?/.test(r.url ?? ""));

describe("Customers — paging", () => {
  it("asks for the next page when the pager advances", async () => {
    const user = userEvent.setup();
    render(<Customers />, { wrapper: createQueryWrapper() });

    await screen.findByText("Customer page 1");

    const pager = screen.getByText(/Page 1 of 3/).parentElement!;
    const [, next] = within(pager).getAllByRole("button");
    await user.click(next);

    await waitFor(() => expect(screen.getByText("Customer page 2")).toBeInTheDocument());
    expect(listRequests().at(-1)!.url).toContain("page=2");
  });

  it("carries the search term into the request", async () => {
    const user = userEvent.setup();
    render(<Customers />, { wrapper: createQueryWrapper() });
    await screen.findByText("Customer page 1");

    await user.type(screen.getByPlaceholderText(/search/i), "asha");

    // Filtering is the server's job here — the list is paginated, so filtering
    // only the current page in the browser would hide matches on every other one.
    await waitFor(() =>
      expect(listRequests().at(-1)!.url).toContain("search=asha"),
    );
  });
});

describe("Customers — profile dialog", () => {
  it("does not load a profile until one is opened", async () => {
    render(<Customers />, { wrapper: createQueryWrapper() });
    await screen.findByText("Customer page 1");

    // The query is `enabled` only when a customer is selected and the dialog is
    // open. Fetching on mount would pull a record nobody asked to see.
    expect(mock.history.get.some((r) => /\/customers\/c1$/.test(r.url ?? ""))).toBe(
      false,
    );
  });

  it("loads the profile when the dialog opens", async () => {
    const user = userEvent.setup();
    mock.onGet("/api/customers/c1").reply(200, {
      success: true,
      data: { id: "c1", name: "Customer page 1", invoices: [] },
    });
    render(<Customers />, { wrapper: createQueryWrapper() });
    await screen.findByText("Customer page 1");

    await user.click(screen.getByRole("button", { name: /view customer details/i }));

    await waitFor(() =>
      expect(
        mock.history.get.some((r) => /\/customers\/c1$/.test(r.url ?? "")),
      ).toBe(true),
    );
  });
});
