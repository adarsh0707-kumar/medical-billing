import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MockAdapter from "axios-mock-adapter";
import api from "@/lib/api";
import Billing from "@/pages/Billing";

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

const result = (over = {}) => ({
  id: "med1",
  name: "Paracetamol 500mg",
  genericName: "Paracetamol",
  unit: "tablet",
  gstPercent: 12,
  isScheduledH: false,
  batchId: "batch1",
  batchNumber: "B-001",
  expiryDate: new Date(Date.now() + 365 * 864e5).toISOString(),
  sellingPrice: 24.5,
  stock: 3,
  ...over,
});

// The cart row renders the same medicine name as the search result, so results
// are addressed by role — only the dropdown entry is a button.
const resultButton = () =>
  screen.findByRole("button", { name: /Paracetamol 500mg/ });

const searchFor = async (user: ReturnType<typeof userEvent.setup>, term = "para") => {
  const before = mock.history.get.length;
  const box = screen.getByPlaceholderText(/search medicine by name/i);
  await user.type(box, term);
  // The search is debounced by 300ms. Counting from `before` matters on the
  // second search of a test — waiting for "any request" would return instantly.
  await waitFor(() => expect(mock.history.get.length).toBeGreaterThan(before), {
    timeout: 2000,
  });
};

beforeEach(() => {
  mock = new MockAdapter(api);
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

    render(<Billing />);
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

    render(<Billing />);
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

    render(<Billing />);
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

    render(<Billing />);
    await searchFor(user);

    await user.click(await resultButton());

    expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
      expect.stringContaining("prescription required"),
    );
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });
});
