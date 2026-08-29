import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MockAdapter from "axios-mock-adapter";
import api from "@/lib/api";
import Billing from "@/pages/Billing";
import { createQueryWrapper } from "@/test/query-wrapper";

/**
 * docs/09 §5.6 — the two stock guards on the POS screen.
 *
 * Driven through the rendered page rather than against extracted helpers,
 * because the risk being guarded against is the guard becoming *unwired* — a
 * search result whose click handler skips the check is exactly as broken as a
 * missing check, and a helper-level test cannot see that.
 *
 * Neither guard is authoritative. The server re-checks stock inside the invoice
 * transaction with a conditional decrement (G-09), so a client that bypasses
 * these gets a 400, not an oversell. They exist so a cashier finds out before
 * taking money, not after.
 */

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

import { toast } from "sonner";

let mock: MockAdapter;

const FAR = new Date(Date.now() + 365 * 864e5).toISOString();

// The flattened FEFO fields and `batches[0]` describe the same batch, exactly as
// the API guarantees. A fixture that let them drift would test a response shape
// the server never sends.
const result = (over: Record<string, unknown> = {}) => ({
  id: "med1",
  name: "Paracetamol 500mg",
  genericName: "Paracetamol",
  unit: "tablet",
  gstPercent: 12,
  isScheduledH: false,
  batchId: "batch1",
  batchNumber: "B-001",
  expiryDate: FAR,
  sellingPrice: 24.5,
  stock: 3,
  batches: [
    {
      id: "batch1",
      batchNumber: "B-001",
      expiryDate: FAR,
      sellingPrice: 24.5,
      quantity: 3,
    },
  ],
  expiredBatches: 0,
  ...over,
});

// A medicine carrying a second, longer-dated batch — the case FR-BILL-19 is
// about. FEFO still points at B-001.
const twoBatches = (over: Record<string, unknown> = {}) => {
  const later = {
    id: "batch2",
    batchNumber: "B-002",
    expiryDate: new Date(Date.now() + 730 * 864e5).toISOString(),
    sellingPrice: 31,
    quantity: 12,
  };
  const base = result();
  return { ...base, batches: [...base.batches, later], ...over };
};

// The cart row renders the same medicine name as the search result, so results
// are addressed by role — only the dropdown entry is a button.
const resultButton = () =>
  screen.findByRole("button", { name: /Paracetamol 500mg/ });

// Search requests only. The page also GETs /api/shop on mount for the invoice
// header, and counting every GET let that one satisfy the wait below — so a
// search could be reported as sent while it was still inside its debounce.
const searchCount = () =>
  mock.history.get.filter((r) => /medicines\/search/.test(r.url ?? "")).length;

const searchFor = async (user: ReturnType<typeof userEvent.setup>, term = "para") => {
  const before = searchCount();
  const box = screen.getByPlaceholderText(/search medicine by name/i);
  await user.type(box, term);
  // The search is debounced by 300ms. Counting from `before` matters on the
  // second search of a test — waiting for "any request" would return instantly.
  await waitFor(() => expect(searchCount()).toBeGreaterThan(before), {
    timeout: 2000,
  });
};

beforeEach(() => {
  mock = new MockAdapter(api);
  // The page reads the shop's own details on mount, for the printed invoice
  // header. Nothing here asserts on them — the stub exists so the query
  // resolves instead of leaving an unhandled rejection behind every test.
  mock.onGet("/api/shop").reply(200, {
    success: true,
    data: { name: "Test Pharmacy", address: null, phone: null, gstNumber: null },
  });
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.warning).mockClear();
});

afterEach(() => {
  mock.restore();
});

describe("POS cart guards", () => {
  it("refuses a search result with no batch (batchId: null)", async () => {
    const user = userEvent.setup();
    // The API returns out-of-stock medicines with batchNumber "No Stock" and a
    // null batchId, so the row is visible but unsellable. Adding it would post
    // an invoice item with no batch to deduct from.
    mock.onGet(/medicines\/search/).reply(200, {
      success: true,
      data: [result({ batchId: null, batchNumber: "No Stock", stock: 0 })],
    });

    render(<Billing />, { wrapper: createQueryWrapper() });
    await searchFor(user);

    await user.click(await resultButton());

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringContaining("no stock available"),
    );
    // Nothing reached the cart: the totals row never appears.
    expect(screen.queryByText(/Grand Total/i)).not.toBeInTheDocument();
  });

  it("will not let the cart quantity exceed the batch stock", async () => {
    const user = userEvent.setup();
    mock.onGet(/medicines\/search/).reply(200, {
      success: true,
      data: [result({ stock: 3 })],
    });

    render(<Billing />, { wrapper: createQueryWrapper() });
    await searchFor(user);
    await user.click(await resultButton());

    // Adding clears the search box and results, so the way a cashier reaches a
    // quantity above one is the cart's own stepper — which is the path this
    // guard actually has to cover.
    const increase = await screen.findByLabelText("Increase quantity");

    await user.click(increase); // 2
    await user.click(increase); // 3 — exactly the batch
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();

    await user.click(increase); // 4 — one more than exists
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Insufficient stock!");

    // And the displayed quantity stayed at the cap rather than creeping up.
    expect(screen.getByDisplayValue("3")).toBeInTheDocument();
  });

  it("refuses a re-added batch once the cart already holds all of it", async () => {
    const user = userEvent.setup();
    // The other half of the same guard: `addToCart` checks the quantity already
    // in the cart against the batch, for a cashier who searches the same
    // medicine again rather than using the stepper.
    mock.onGet(/medicines\/search/).reply(200, {
      success: true,
      data: [result({ stock: 1 })],
    });

    render(<Billing />, { wrapper: createQueryWrapper() });
    await searchFor(user);
    await user.click(await resultButton());
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();

    await searchFor(user, "para");
    await user.click(await resultButton());

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Insufficient stock!");
  });

  it("warns but still allows a Schedule H medicine", async () => {
    const user = userEvent.setup();
    // The flag is advisory only: FR-MED-12 is unbuilt, no prescription is
    // recorded, and the sale is deliberately not gated. Asserted so that stays
    // a known state rather than an assumption.
    mock.onGet(/medicines\/search/).reply(200, {
      success: true,
      data: [result({ isScheduledH: true })],
    });

    render(<Billing />, { wrapper: createQueryWrapper() });
    await searchFor(user);

    await user.click(await resultButton());

    expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
      expect.stringContaining("prescription required"),
    );
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });
});

/**
 * FR-BILL-19 — the operator may overrule FEFO, but only on purpose.
 *
 * AD-04 traded operator choice away for automatic expiry minimisation. These
 * assert the trade is now a default rather than a cage: the ordinary click must
 * still take the earliest-expiring batch with no extra step, and the override
 * must take a deliberate second action to reach.
 */
describe("batch selection at the POS", () => {
  const batchesButton = () => screen.findByRole("button", { name: /2 batches/ });

  it("takes the FEFO batch on a plain click, with no extra step", async () => {
    const user = userEvent.setup();
    mock.onGet(/medicines\/search/).reply(200, {
      success: true,
      data: [twoBatches()],
    });

    render(<Billing />, { wrapper: createQueryWrapper() });
    await searchFor(user);
    await user.click(await resultButton());

    // B-001 is the earliest-expiring, so its price is what the cart quotes.
    expect(await screen.findByText(/Batch: B-001/)).toBeInTheDocument();
    expect(screen.queryByText(/Batch: B-002/)).not.toBeInTheDocument();
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it("offers no override when there is only one batch", async () => {
    const user = userEvent.setup();
    mock.onGet(/medicines\/search/).reply(200, {
      success: true,
      data: [result()],
    });

    render(<Billing />, { wrapper: createQueryWrapper() });
    await searchFor(user);
    await screen.findByRole("button", { name: /Paracetamol 500mg/ });

    // A picker over a single option is a false choice and a wasted click.
    expect(screen.queryByRole("button", { name: /batches/ })).toBeNull();
  });

  it("adds the batch the operator picked, at that batch's price", async () => {
    const user = userEvent.setup();
    mock.onGet(/medicines\/search/).reply(200, {
      success: true,
      data: [twoBatches()],
    });

    render(<Billing />, { wrapper: createQueryWrapper() });
    await searchFor(user);
    await user.click(await batchesButton());

    // The picker lists both, FEFO first and marked as the default.
    expect(await screen.findByText("Default")).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: /B-002/ }));

    expect(await screen.findByText(/Batch: B-002/)).toBeInTheDocument();
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      expect.stringContaining("B-002"),
    );
  });

  it("caps the picked batch at its own stock, not the FEFO batch's", async () => {
    const user = userEvent.setup();
    // B-001 holds 3, B-002 holds 12. Carrying the wrong ceiling across would
    // either block a legitimate sale or let the cart overshoot into a 400.
    mock.onGet(/medicines\/search/).reply(200, {
      success: true,
      data: [twoBatches()],
    });

    render(<Billing />, { wrapper: createQueryWrapper() });
    await searchFor(user);
    await user.click(await batchesButton());
    await user.click(await screen.findByRole("button", { name: /B-002/ }));
    await screen.findByText(/Batch: B-002/);

    // The cart row's inputs, in order: quantity, unit price, discount. The unit
    // price proves the picked batch's own price came across, not the FEFO one's.
    const [qty, price] = screen.getAllByRole("spinbutton");
    expect(price).toHaveValue(31);

    // Four clicks takes it to 5 — past B-001's 3, well inside B-002's 12. If the
    // cart had kept the FEFO batch's ceiling this would refuse at 4.
    const plus = screen.getByLabelText("Increase quantity");
    for (let i = 0; i < 4; i++) await user.click(plus);

    expect(qty).toHaveValue(5);
    expect(vi.mocked(toast.error)).not.toHaveBeenCalledWith(
      "Insufficient stock!",
    );
  });

  it("says stock is expired rather than absent when it is", async () => {
    const user = userEvent.setup();
    // The shelf is full; none of it is sellable. "No Stock" would send someone
    // to reorder a medicine they already have boxes of.
    mock.onGet(/medicines\/search/).reply(200, {
      success: true,
      data: [
        result({
          batchId: null,
          batchNumber: "No Stock",
          stock: 0,
          batches: [],
          expiredBatches: 2,
        }),
      ],
    });

    render(<Billing />, { wrapper: createQueryWrapper() });
    await searchFor(user);

    expect(await screen.findByText("Stock Expired")).toBeInTheDocument();
    await user.click(await resultButton());

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringContaining("expired"),
    );
  });
});
