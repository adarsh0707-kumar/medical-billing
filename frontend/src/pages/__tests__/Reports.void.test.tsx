import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MockAdapter from "axios-mock-adapter";
import { toast } from "sonner";
import api from "@/lib/api";
import Reports from "@/pages/Reports";
import { useAuthStore } from "@/store/auth.store";
import { createQueryWrapper } from "@/test/query-wrapper";

/**
 * docs/09 §5.6 — the invoice void and partial-return dialog (FR-BILL-17).
 *
 * Scoped per CONTRIBUTING. Whether the *arithmetic* of a credit note is right,
 * and whether two simultaneous returns of the same units can both win, are
 * settled below this layer in `tests/billing/invoice-void.test.js` — that is
 * where the cumulative `returnedQty` guard is proven. Asserting money here would
 * make the suite slower without making it more truthful.
 *
 * What only this layer sees: that the control is not offered to a cashier, that
 * a quantity the server would reject never leaves the browser, and that the
 * day's figures are refetched once a return commits — without which the screen
 * keeps showing takings that the database no longer agrees with.
 */

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

let mock: MockAdapter;

const LIST_ROW = {
  id: "i1",
  invoiceNumber: "INV260825-0001",
  date: new Date().toISOString(),
  totalAmount: 274.4,
  paymentMode: "CASH",
  paymentStatus: "PAID",
  type: "SALE",
  status: "ACTIVE",
  customer: { name: "Rekha Iyer", phone: "9876543210" },
};

/** Five sold, two already returned — so three are outstanding. */
const DETAIL = {
  ...LIST_ROW,
  subtotal: 245,
  discountAmt: 0,
  cgst: 14.7,
  sgst: 14.7,
  user: { name: "Asha Rao" },
  items: [
    {
      id: "it1",
      medicineName: "Paracetamol 500mg",
      quantity: 5,
      returnedQty: 2,
      unitPrice: 49,
      discount: 0,
      gstPercent: 12,
      totalPrice: 274.4,
      batch: { batchNumber: "B-77", expiryDate: "2027-01-31" },
    },
  ],
};

const stub = (detail: Record<string, unknown> = DETAIL) => {
  mock.onGet(/daily-summary\?/).reply(200, {
    success: true,
    data: { invoices: [detail], summary: null },
  });
  mock.onGet("/api/billing/invoices/i1").reply(200, {
    success: true,
    data: detail,
  });
};

const signInAs = (role: "ADMIN" | "CASHIER") =>
  useAuthStore.setState({
    user: { id: "u1", name: "Test", email: "t@shop.test", role },
    token: "t",
    isAuthenticated: true,
  } as never);

const dailyCalls = () =>
  mock.history.get.filter((r) => /daily-summary\?/.test(r.url ?? "")).length;

/** Opens the detail dialog for the one invoice in the list. */
const openInvoice = async (user: ReturnType<typeof userEvent.setup>) => {
  render(<Reports />, { wrapper: createQueryWrapper() });
  await user.click(
    await screen.findByRole("button", { name: /Invoice INV260825-0001/i }),
  );
  // The line name is the one string present in every fixture, so it is what
  // tells us the detail response has landed rather than just the dialog frame.
  return screen.findByText(/Paracetamol 500mg/i);
};

beforeEach(() => {
  mock = new MockAdapter(api);
  signInAs("ADMIN");
});

afterEach(() => {
  mock.restore();
  vi.clearAllMocks();
  useAuthStore.setState({ user: null, token: null, isAuthenticated: false });
});

describe("Reports — invoice detail", () => {
  it("opens the invoice and shows what is still outstanding", async () => {
    const user = userEvent.setup();
    stub();
    await openInvoice(user);

    expect(await screen.findByText(/2 of 5 already returned/i)).toBeVisible();
    expect(screen.getByText(/billed by Asha Rao/i)).toBeVisible();
  });
});

describe("Reports — the return control is admin-only", () => {
  it("is absent for a cashier", async () => {
    const user = userEvent.setup();
    signInAs("CASHIER");
    stub();

    render(<Reports />, { wrapper: createQueryWrapper() });
    await user.click(
      await screen.findByRole("button", { name: /Invoice INV260825-0001/i }),
    );

    // The lines are readable — a cashier may look at a bill they took.
    expect(await screen.findByText(/Paracetamol 500mg/i)).toBeVisible();
    // The correction path is not offered. Server-side `authorize("ADMIN")` is
    // the actual guard; this is only the UI agreeing with it.
    expect(screen.queryByLabelText(/^Reason/i)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /void|return selected/i }),
    ).toBeNull();
  });

  it("is offered to an admin", async () => {
    const user = userEvent.setup();
    stub();
    await openInvoice(user);

    expect(await screen.findByLabelText(/^Reason/i)).toBeVisible();
  });
});

describe("Reports — a return the server would reject is not sent", () => {
  it("refuses more units than are outstanding", async () => {
    const user = userEvent.setup();
    stub();
    await openInvoice(user);

    const qty = await screen.findByLabelText(
      /Return quantity for Paracetamol 500mg/i,
    );
    // Three outstanding of five. Four is one too many.
    await user.type(qty, "4");
    await user.type(await screen.findByLabelText(/^Reason/i), "Wrong strip");
    await user.click(
      screen.getByRole("button", { name: /return selected units/i }),
    );

    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("3 of 5 still outstanding"),
    );
    expect(mock.history.post).toHaveLength(0);
  });

  it("refuses a reason shorter than the server accepts", async () => {
    const user = userEvent.setup();
    stub();
    await openInvoice(user);

    await user.type(
      await screen.findByLabelText(/Return quantity for Paracetamol/i),
      "1",
    );
    await user.type(await screen.findByLabelText(/^Reason/i), "x");
    await user.click(
      screen.getByRole("button", { name: /return selected units/i }),
    );

    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("at least 3 characters"),
    );
    expect(mock.history.post).toHaveLength(0);
  });
});

describe("Reports — a committed return", () => {
  it("sends only the entered lines and refetches the day", async () => {
    const user = userEvent.setup();
    stub();
    mock.onPost("/api/billing/invoices/i1/void").reply(201, {
      success: true,
      message: "Partial return against INV260825-0001.",
    });
    await openInvoice(user);

    const before = dailyCalls();

    await user.type(
      await screen.findByLabelText(/Return quantity for Paracetamol/i),
      "2",
    );
    await user.type(await screen.findByLabelText(/^Reason/i), "Damaged strip");
    await user.click(
      screen.getByRole("button", { name: /return selected units/i }),
    );

    await waitFor(() => expect(mock.history.post).toHaveLength(1));
    expect(JSON.parse(mock.history.post[0].data)).toEqual({
      reason: "Damaged strip",
      items: [{ invoiceItemId: "it1", quantity: 2 }],
    });

    // Without this the payment-mode split and the period totals keep showing
    // takings the credit note has already reversed.
    await waitFor(() => expect(dailyCalls()).toBeGreaterThan(before));
    expect(toast.success).toHaveBeenCalled();
  });

  it("makes the operator confirm a whole-invoice void first", async () => {
    const user = userEvent.setup();
    stub();
    mock.onPost("/api/billing/invoices/i1/void").reply(201, {
      success: true,
      message: "Invoice INV260825-0001 voided.",
    });
    await openInvoice(user);

    await user.type(await screen.findByLabelText(/^Reason/i), "Billed twice");

    // No quantities entered. The first click states the consequence rather than
    // acting on it.
    await user.click(
      screen.getByRole("button", { name: /void entire invoice/i }),
    );
    expect(mock.history.post).toHaveLength(0);
    // The consequence is spelled out, and the button now names the invoice it
    // is about to void rather than repeating a generic label.
    expect(screen.getByText(/No quantities entered/i)).toBeVisible();
    expect(
      screen.getByText(/all 3 outstanding units return to stock/i),
    ).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: /yes, void INV260825-0001/i }),
    );

    await waitFor(() => expect(mock.history.post).toHaveLength(1));
    // No `items` key at all — absent means "everything outstanding" to the API.
    expect(JSON.parse(mock.history.post[0].data)).toEqual({
      reason: "Billed twice",
    });
  });

  it("explains a 403 rather than reporting a generic failure", async () => {
    const user = userEvent.setup();
    stub();
    mock.onPost("/api/billing/invoices/i1/void").reply(403, {
      success: false,
      message: "Forbidden",
    });
    await openInvoice(user);

    await user.type(
      await screen.findByLabelText(/Return quantity for Paracetamol/i),
      "1",
    );
    await user.type(await screen.findByLabelText(/^Reason/i), "Wrong item");
    await user.click(
      screen.getByRole("button", { name: /return selected units/i }),
    );

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("Only an administrator"),
      ),
    );
  });
});

describe("Reports — nothing to return", () => {
  it.each([
    [
      "an invoice already voided",
      { ...DETAIL, status: "CANCELLED" },
      /already been voided/i,
    ],
    [
      "a credit note",
      { ...DETAIL, type: "CREDIT_NOTE" },
      /cannot itself be voided/i,
    ],
    [
      "an invoice returned in full",
      {
        ...DETAIL,
        items: [{ ...DETAIL.items[0], returnedQty: 5 }],
      },
      /already been returned/i,
    ],
  ])("says why on %s", async (_label, detail, expected) => {
    const user = userEvent.setup();
    stub(detail);

    render(<Reports />, { wrapper: createQueryWrapper() });
    await user.click(
      await screen.findByRole("button", { name: /Invoice INV260825-0001/i }),
    );

    // The reason is shown; the button is not there to be pressed and fail.
    expect(await screen.findByText(expected)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /void|return selected/i }),
    ).toBeNull();
  });
});
