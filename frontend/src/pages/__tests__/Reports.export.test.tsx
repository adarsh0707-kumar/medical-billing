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
 * docs/09 §5.6 — the CSV export controls (FR-RPT-09).
 *
 * Scoped per CONTRIBUTING: the file's *contents* are the server's and are
 * asserted in `tests/reports/csv.test.js` and `csv-export.test.js`, down to the
 * 2 dp money strings. What only this layer sees is which endpoint the button
 * calls — the property that stops the browser going back to computing the
 * figures itself, which is what [G-21] was.
 */

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

let mock: MockAdapter;

const INVOICE = {
  id: "i1",
  invoiceNumber: "INV260824-0001",
  date: new Date().toISOString(),
  subtotal: 245,
  cgst: 14.7,
  sgst: 14.7,
  totalAmount: 274.4,
  customer: null,
};

const stubGst = (invoices: unknown[]) =>
  mock.onGet(/reports\/gst\?/).reply(200, {
    success: true,
    data: {
      invoices,
      totals: { taxable: 245, cgst: 14.7, sgst: 14.7, total: 274.4 },
    },
  });

// The GST tab is rendered only for ADMIN and PHARMACIST, mirroring the
// authorize() on report.routes.js so a cashier's page never fires a request it
// can only get a 403 back from. These tests are about the export button behind
// that tab, so they sign in as somebody allowed to see it.
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
  mock.onGet(/export/).reply(200, "Date,Total\r\n");
  globalThis.URL.createObjectURL = vi.fn(() => "blob:fake");
  globalThis.URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(() => {
  mock.restore();
  vi.restoreAllMocks();
  // The store is a module singleton, so a signed-in user would otherwise be
  // inherited by whatever file runs next in this worker.
  useAuthStore.setState({ user: null, token: null, isAuthenticated: false });
});

const openGst = async (user: ReturnType<typeof userEvent.setup>) => {
  render(<Reports />, { wrapper: createQueryWrapper() });
  await user.click(await screen.findByRole("tab", { name: /gst report/i }));
};

describe("Reports — CSV export", () => {
  it("refuses to export a month with nothing in it", async () => {
    const user = userEvent.setup();
    stubGst([]);
    await openGst(user);

    // A header-only CSV is indistinguishable from a failed download once it is
    // sitting in someone's Downloads folder.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /export csv/i })).toBeDisabled(),
    );
  });

  it("asks the server for the file rather than building one", async () => {
    const user = userEvent.setup();
    stubGst([INVOICE]);
    await openGst(user);

    const button = await screen.findByRole("button", { name: /export csv/i });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    await waitFor(() =>
      expect(
        mock.history.get.some((r) => /gst\/export/.test(r.url ?? "")),
      ).toBe(true),
    );
    const call = mock.history.get.find((r) => /gst\/export/.test(r.url ?? ""))!;
    // A blob, not JSON: whatever bytes the server sent are what gets saved.
    expect(call.responseType).toBe("blob");
  });

  it("sends the period the user is looking at", async () => {
    const user = userEvent.setup();
    stubGst([INVOICE]);
    await openGst(user);

    const button = await screen.findByRole("button", { name: /export csv/i });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    await waitFor(() => {
      const call = mock.history.get.find((r) =>
        /gst\/export/.test(r.url ?? ""),
      );
      const now = new Date();
      expect(call!.url).toContain(`month=${now.getMonth() + 1}`);
      expect(call!.url).toContain(`year=${now.getFullYear()}`);
    });
  });
});

/**
 * The GST tab is ADMIN/PHARMACIST only.
 *
 * Cosmetic, exactly as the sidebar's role filter is: `authorize()` on
 * report.routes.js is the real boundary, and a cashier reaching /api/reports/gst
 * by any other route still gets a 403. What this guards is the second half of
 * the change — the query is gated too, so the page does not spend a request, or
 * react-query's retries of it, on a 403 nobody will ever see.
 */
describe("Reports — GST is not a cashier's screen", () => {
  it("renders no GST tab for a cashier", async () => {
    asRole("CASHIER");
    stubGst([INVOICE]);

    render(<Reports />, { wrapper: createQueryWrapper() });

    // The daily tab is the page's default, so waiting for it means the page has
    // rendered and the GST tab's absence is a decision rather than a race.
    expect(
      await screen.findByRole("tab", { name: /daily report/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: /gst report/i }),
    ).not.toBeInTheDocument();
  });

  it("does not request the GST report for a cashier", async () => {
    asRole("CASHIER");
    stubGst([INVOICE]);

    render(<Reports />, { wrapper: createQueryWrapper() });
    await screen.findByRole("tab", { name: /daily report/i });

    expect(
      mock.history.get.some((r) => /reports\/gst/.test(r.url ?? "")),
    ).toBe(false);
  });
});
