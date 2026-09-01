import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MockAdapter from "axios-mock-adapter";
import api from "@/lib/api";
import Reports from "@/pages/Reports";
import { createQueryWrapper } from "@/test/query-wrapper";
import { useAuthStore } from "@/store/auth.store";
import type { User } from "@/types";

/**
 * docs/09 §5.6 — the Top Sellers and Profit & Margin tabs (FR-RPT-07, FR-RPT-08).
 *
 * These two endpoints shipped on 2026-08-31 with **no screen calling them**,
 * which is the third time this repo has done that: `POST /api/auth/logout` was
 * live for three days before the Sign out button called it, and the void
 * endpoint for five before a dialog existed. So the assertions that matter here
 * are the same ones that would have caught those — that a tab exists, that
 * opening it requests the right endpoint, and that the role split the server
 * enforces is the one the page renders.
 *
 * The figures themselves belong to the server and are pinned in
 * `tests/reports/margin.test.js` and `top-sellers.test.js`; asserting arithmetic
 * here would make this suite slower without making it more truthful.
 */

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

let mock: MockAdapter;

const MARGIN = {
  label: "March 2026",
  margin: {
    revenue: 245,
    cost: 100,
    profit: 145,
    marginPercent: 59.18,
    unpricedLines: 0,
  },
  days: [
    { date: "2026-03-12", day: 12, revenue: 245, cost: 100, profit: 145 },
    { date: "2026-03-13", day: 13, revenue: 0, cost: 0, profit: 0 },
  ],
};

const TOP_SELLERS = {
  label: "March 2026",
  medicines: [
    {
      medicineId: "m1",
      name: "Paracetamol 500mg",
      unit: "tablet",
      quantity: 42,
      value: 1029,
    },
    {
      medicineId: "m2",
      name: "Amoxicillin 250mg",
      unit: "capsule",
      quantity: 11,
      value: 540,
    },
  ],
};

const asRole = (role: User["role"]) =>
  useAuthStore.setState({
    user: { id: "u1", name: role, email: `${role}@test.local`, role },
    token: "token",
    isAuthenticated: true,
  });

beforeEach(() => {
  asRole("ADMIN");
  mock = new MockAdapter(api);
  mock.onGet(/daily-summary\?/).reply(200, {
    success: true,
    data: { invoices: [], summary: null },
  });
  mock.onGet(/reports\/margin\?/).reply(200, { success: true, data: MARGIN });
  mock
    .onGet(/reports\/top-sellers\?/)
    .reply(200, { success: true, data: TOP_SELLERS });
  mock.onGet(/export/).reply(200, "Date,Revenue\r\n");
  globalThis.URL.createObjectURL = vi.fn(() => "blob:fake");
  globalThis.URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(() => {
  mock.restore();
  vi.restoreAllMocks();
  useAuthStore.setState({ user: null, token: null, isAuthenticated: false });
});

const openTab = async (
  user: ReturnType<typeof userEvent.setup>,
  name: RegExp,
) => {
  render(<Reports />, { wrapper: createQueryWrapper() });
  await user.click(await screen.findByRole("tab", { name }));
};

describe("Reports — Top Sellers", () => {
  it("has a tab, and opening it asks the server", async () => {
    const user = userEvent.setup();
    await openTab(user, /top sellers/i);

    // The assertion that would have caught this shipping without a screen.
    await waitFor(() =>
      expect(
        mock.history.get.some((r) => /top-sellers\?/.test(r.url ?? "")),
      ).toBe(true),
    );
  });

  it("lists what sold, in the order the server ranked it", async () => {
    const user = userEvent.setup();
    await openTab(user, /top sellers/i);

    expect(await screen.findByText("Paracetamol 500mg")).toBeInTheDocument();
    expect(screen.getByText("Amoxicillin 250mg")).toBeInTheDocument();
    // Ranking is the server's — the page must not re-sort and quietly disagree
    // with the CSV of the same period.
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Paracetamol 500mg");
    expect(rows[1]).toHaveTextContent("Amoxicillin 250mg");
  });

  it("carries the chosen limit into the request", async () => {
    const user = userEvent.setup();
    await openTab(user, /top sellers/i);
    await screen.findByText("Paracetamol 500mg");

    await user.selectOptions(screen.getByLabelText(/how many/i), "20");

    await waitFor(() =>
      expect(
        mock.history.get.some((r) => /top-sellers\?.*limit=20/.test(r.url ?? "")),
      ).toBe(true),
    );
  });

  it("asks the server for the CSV rather than building one", async () => {
    const user = userEvent.setup();
    await openTab(user, /top sellers/i);

    const button = await screen.findByRole("button", { name: /export csv/i });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    await waitFor(() =>
      expect(
        mock.history.get.some((r) => /top-sellers\/export/.test(r.url ?? "")),
      ).toBe(true),
    );
  });

  it("is open to a cashier, like the other period reports", async () => {
    asRole("CASHIER");
    const user = userEvent.setup();
    await openTab(user, /top sellers/i);

    expect(await screen.findByText("Paracetamol 500mg")).toBeInTheDocument();
  });
});

describe("Reports — Profit & Margin", () => {
  it("has a tab, and opening it asks the server", async () => {
    const user = userEvent.setup();
    await openTab(user, /profit & margin/i);

    await waitFor(() =>
      expect(
        mock.history.get.some((r) => /reports\/margin\?/.test(r.url ?? "")),
      ).toBe(true),
    );
  });

  it("shows revenue, cost, profit and the margin the server computed", async () => {
    const user = userEvent.setup();
    await openTab(user, /profit & margin/i);

    expect(await screen.findByText("59.18%")).toBeInTheDocument();
    expect(screen.getByText(/cost of goods/i)).toBeInTheDocument();
    // Profit is the server's figure, not one the page derives — the same rule
    // that G-21 was about.
    expect(screen.getByText("₹145.00")).toBeInTheDocument();
  });

  it("shows a dash rather than 0% for a month that sold nothing", async () => {
    mock.onGet(/reports\/margin\?/).reply(200, {
      success: true,
      data: {
        ...MARGIN,
        margin: { ...MARGIN.margin, marginPercent: null, revenue: 0, profit: 0 },
        days: [{ date: "2026-03-01", day: 1, revenue: 0, cost: 0, profit: 0 }],
      },
    });
    const user = userEvent.setup();
    await openTab(user, /profit & margin/i);

    // 0% is a claim about a period that traded.
    expect(await screen.findByText("—")).toBeInTheDocument();
  });

  it("warns when a line had no recorded cost, and stays quiet when none did", async () => {
    const user = userEvent.setup();
    await openTab(user, /profit & margin/i);
    await screen.findByText("59.18%");

    // Nothing to warn about in the default fixture.
    expect(screen.queryByText(/upper bound/i)).not.toBeInTheDocument();
  });

  it("says the profit is an upper bound when a batch had no cost price", async () => {
    mock.onGet(/reports\/margin\?/).reply(200, {
      success: true,
      data: { ...MARGIN, margin: { ...MARGIN.margin, unpricedLines: 3 } },
    });
    const user = userEvent.setup();
    await openTab(user, /profit & margin/i);

    // Without this the month reads as a better one than the shop had, and
    // nothing on the screen says why.
    expect(await screen.findByText(/upper bound/i)).toBeInTheDocument();
  });

  it("asks the server for the CSV rather than building one", async () => {
    const user = userEvent.setup();
    await openTab(user, /profit & margin/i);

    const button = await screen.findByRole("button", { name: /export csv/i });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    await waitFor(() =>
      expect(
        mock.history.get.some((r) => /margin\/export/.test(r.url ?? "")),
      ).toBe(true),
    );
  });

  // ─── The role split ───────────────────────────────────────────────────────
  //
  // Narrower than the GST tab's, and the contrast is the design: takings are
  // the shop's own trading record, what the stock cost is not.
  it.each(["PHARMACIST", "CASHIER"] as const)(
    "renders no margin tab for a %s",
    async (role) => {
      asRole(role);
      render(<Reports />, { wrapper: createQueryWrapper() });

      expect(await screen.findByRole("tab", { name: /daily report/i })).toBeInTheDocument();
      expect(
        screen.queryByRole("tab", { name: /profit & margin/i }),
      ).not.toBeInTheDocument();
    },
  );

  it("never requests margin for a role the server would refuse", async () => {
    asRole("CASHIER");
    render(<Reports />, { wrapper: createQueryWrapper() });
    await screen.findByRole("tab", { name: /daily report/i });

    // Hiding the tab is not access control — `authorize("ADMIN")` is. What this
    // asserts is that the page does not fire a request it can only get a 403
    // back from, which is how a hidden control still produces an error toast.
    expect(
      mock.history.get.some((r) => /reports\/margin/.test(r.url ?? "")),
    ).toBe(false);
  });

  it("shows a pharmacist the GST tab but not margin", async () => {
    asRole("PHARMACIST");
    render(<Reports />, { wrapper: createQueryWrapper() });

    // The two gates are different widths, and this is the test that fails if
    // somebody collapses them into one `canViewReports`.
    expect(await screen.findByRole("tab", { name: /gst report/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: /profit & margin/i }),
    ).not.toBeInTheDocument();
  });
});
