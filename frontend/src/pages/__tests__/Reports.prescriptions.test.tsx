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
 * The Schedule H register tab — FR-MED-12, Rule 65(11).
 *
 * The fourth endpoint in this repo to be built before anything called it: the
 * prescription was recorded at the till from 2026-08-24, `Prescription` carried
 * indexes for exactly the query an inspection asks, and producing the register
 * meant a psql prompt.
 *
 * So the assertions here are the ones that catch that failure and not the
 * figures: a tab exists, opening it asks the server, the filters reach the
 * request, and the role split the server enforces is the one the page renders.
 * What the register *contains* is pinned in
 * `backend/tests/reports/prescription-register.test.js`.
 */

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

let mock: MockAdapter;

const REGISTER = {
  success: true,
  data: [
    {
      id: "p1",
      prescriberName: "Dr Priya Nair",
      prescriberRegNo: "KMC/99887",
      prescribedOn: "2026-03-10T00:00:00.000Z",
      patientName: "Ravi Kumar",
      notes: null,
      invoice: {
        id: "i1",
        invoiceNumber: "INV260310-0004",
        date: "2026-03-12T09:30:00.000Z",
        status: "ACTIVE",
        totalAmount: 274.4,
        items: [{ medicineName: "Alprazolam 0.5mg", quantity: 10 }],
      },
    },
  ],
  pagination: { total: 1, page: 1, limit: 20, pages: 1 },
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
  mock.onGet(/reports\/prescriptions\?/).reply(200, REGISTER);
  mock.onGet(/export/).reply(200, "Prescribed On,Prescriber\r\n");
  globalThis.URL.createObjectURL = vi.fn(() => "blob:fake");
  globalThis.URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(() => {
  mock.restore();
  vi.restoreAllMocks();
  useAuthStore.setState({ user: null, token: null, isAuthenticated: false });
});

const openTab = async (user: ReturnType<typeof userEvent.setup>) => {
  render(<Reports />, { wrapper: createQueryWrapper() });
  await user.click(await screen.findByRole("tab", { name: /prescriptions/i }));
};

const asked = (pattern: RegExp) =>
  mock.history.get.some((r) => pattern.test(r.url ?? ""));

describe("Reports — Prescription register", () => {
  it("has a tab, and opening it asks the server", async () => {
    const user = userEvent.setup();
    await openTab(user);

    // The assertion that would have caught this shipping without a screen.
    await waitFor(() => expect(asked(/reports\/prescriptions\?/)).toBe(true));
  });

  it("shows the particulars an inspection asks for", async () => {
    const user = userEvent.setup();
    await openTab(user);

    expect(await screen.findByText("Dr Priya Nair")).toBeInTheDocument();
    expect(screen.getByText("KMC/99887")).toBeInTheDocument();
    expect(screen.getByText("Ravi Kumar")).toBeInTheDocument();
    // What was actually handed over, so the row answers the question rather
    // than pointing at an invoice to go and look up.
    expect(screen.getByText(/Alprazolam 0\.5mg ×10/)).toBeInTheDocument();
    expect(screen.getByText("INV260310-0004")).toBeInTheDocument();
  });

  it("says so plainly when nothing matches", async () => {
    mock.onGet(/reports\/prescriptions\?/).reply(200, {
      success: true,
      data: [],
      pagination: { total: 0, page: 1, limit: 20, pages: 0 },
    });
    const user = userEvent.setup();
    await openTab(user);

    expect(
      await screen.findByText(/no prescriptions recorded/i),
    ).toBeInTheDocument();
  });

  // What the deployed app actually showed on 2026-09-01: the request failed and
  // the card still read "0 entries — no prescriptions recorded for this
  // filter". On a statutory register that is the screen asserting a compliance
  // fact it does not have.
  it("does not report an empty register when the request failed", async () => {
    mock.onGet(/reports\/prescriptions\?/).reply(500);
    const user = userEvent.setup();
    await openTab(user);

    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/no prescriptions recorded/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/0 entries/i)).not.toBeInTheDocument();
    // The toast that accompanies this ("Failed to load the prescription
    // register", from the query's `meta.errorMessage`) is raised by the app's
    // shared queryCache, which `createQueryWrapper` deliberately does not
    // install — so it is not asserted here.
  });

  it("carries the search box into the request", async () => {
    const user = userEvent.setup();
    await openTab(user);
    await screen.findByText("Dr Priya Nair");

    await user.type(screen.getByLabelText(/search prescriber/i), "Nair");

    await waitFor(() =>
      expect(asked(/reports\/prescriptions\?.*search=Nair/)).toBe(true),
    );
  });

  // Sending one bound would silently widen the register back to everything
  // while the date box on screen says otherwise, because the server ignores a
  // lone bound rather than treating it as open-ended.
  it("sends a date range only once both ends are set", async () => {
    const user = userEvent.setup();
    await openTab(user);
    await screen.findByText("Dr Priya Nair");

    await user.type(screen.getByLabelText(/prescribed from/i), "2026-03-01");
    await waitFor(() => expect(asked(/startDate=/)).toBe(false));

    await user.type(screen.getByLabelText(/prescribed to/i), "2026-03-31");
    await waitFor(() =>
      expect(
        asked(/startDate=2026-03-01&endDate=2026-03-31/),
      ).toBe(true),
    );
  });

  it("asks the server for the CSV rather than building one", async () => {
    const user = userEvent.setup();
    await openTab(user);

    const button = await screen.findByRole("button", { name: /export csv/i });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    await waitFor(() =>
      expect(asked(/reports\/prescriptions\/export/)).toBe(true),
    );
  });

  // Every row names a patient and what they were dispensed. The server refuses
  // a cashier with `authorize("ADMIN", "PHARMACIST")`; this keeps the page from
  // offering a tab that would 403.
  describe("who is offered the tab", () => {
    it("offers it to a pharmacist", async () => {
      asRole("PHARMACIST");
      render(<Reports />, { wrapper: createQueryWrapper() });

      expect(
        await screen.findByRole("tab", { name: /prescriptions/i }),
      ).toBeInTheDocument();
    });

    it("does not offer it to a cashier", async () => {
      asRole("CASHIER");
      render(<Reports />, { wrapper: createQueryWrapper() });

      await screen.findByRole("tab", { name: /daily report/i });
      expect(
        screen.queryByRole("tab", { name: /prescriptions/i }),
      ).not.toBeInTheDocument();
    });
  });
});
