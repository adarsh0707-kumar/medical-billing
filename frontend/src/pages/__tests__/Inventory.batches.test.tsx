import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MockAdapter from "axios-mock-adapter";
import api from "@/lib/api";
import Inventory from "@/pages/Inventory";
import { createQueryWrapper } from "@/test/query-wrapper";

/**
 * docs/09 §5.6 — the Add Stock form on the Batches tab.
 *
 * Scoped per CONTRIBUTING: what is asserted here is the *payload the component
 * assembles*, not whether the API accepts it. Batch validation lives in
 * `tests/inventory/batches.test.js`; duplicating it here would be slower and
 * less precise. What only this layer can see is whether a field the user filled
 * in actually leaves the browser.
 */

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

let mock: MockAdapter;

const SUPPLIERS = [{ id: "sup1", name: "Kaveri Distributors" }];
const MEDICINE = { id: "med1", name: "Amoxicillin 500mg", unit: "capsule" };

beforeEach(() => {
  // Radix's Select relies on pointer-capture APIs jsdom does not implement.
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();

  mock = new MockAdapter(api);
  mock.onGet(/\/api\/inventory\/batches\?/).reply(200, {
    success: true,
    data: [],
    pagination: { pages: 1, total: 0 },
  });
  mock.onGet("/api/suppliers").reply(200, { success: true, data: SUPPLIERS });
  mock.onGet("/api/inventory/categories").reply(200, { success: true, data: [] });
  mock.onGet("/api/inventory/manufacturers").reply(200, { success: true, data: [] });
  mock.onGet(/\/api\/medicines\?search=/).reply(200, {
    success: true,
    data: [MEDICINE],
  });
  mock.onGet(/\/api\/medicines\?/).reply(200, {
    success: true,
    data: [],
    pagination: { pages: 1, total: 0 },
  });
  mock.onPost("/api/inventory/batches").reply(201, { success: true, data: {} });
});

afterEach(() => {
  mock.restore();
  vi.restoreAllMocks();
});

const dateInputs = () =>
  Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type="date"]'),
  );

/** Opens the Batches tab and the Add Stock dialog, with a medicine chosen. */
async function openBatchForm(user: ReturnType<typeof userEvent.setup>) {
  render(<Inventory />, { wrapper: createQueryWrapper() });

  await user.click(await screen.findByRole("tab", { name: /stock batches/i }));
  await user.click(await screen.findByRole("button", { name: /add stock/i }));

  const dialog = await screen.findByRole("dialog");

  // Pick the medicine through the search dropdown, the way a user does.
  await user.type(
    within(dialog).getByPlaceholderText(/search medicine/i),
    "amox",
  );
  await user.click(await within(dialog).findByRole("button", { name: MEDICINE.name }));

  // Radix renders its listbox in a portal, so the option is on `screen`, not
  // inside the dialog subtree.
  await user.click(within(dialog).getByRole("combobox"));
  await user.click(await screen.findByRole("option", { name: SUPPLIERS[0].name }));

  await user.type(within(dialog).getByPlaceholderText(/BATCH001/i), "AMX-2411");
  const prices = within(dialog).getAllByPlaceholderText("₹0.00");
  await user.type(prices[0], "40");
  await user.type(prices[1], "82");
  await user.type(within(dialog).getByPlaceholderText("0"), "25");

  return dialog;
}

describe("Inventory — Add Stock payload", () => {
  // GUARD G-04. `mfgDate` was silently dropped once before, because the field
  // existed on the form and not in the schema. This asserts the client half:
  // a date the user typed reaches the request body.
  it("sends mfgDate when the user supplies one", async () => {
    const user = userEvent.setup();
    const dialog = await openBatchForm(user);

    const [expiry, mfg] = dateInputs();
    await user.type(expiry, "2027-11-30");
    await user.type(mfg, "2025-06-01");

    await user.click(within(dialog).getByRole("button", { name: /add stock/i }));

    await waitFor(() => expect(mock.history.post).toHaveLength(1));
    const body = JSON.parse(mock.history.post[0].data);
    expect(body.mfgDate).toBe("2025-06-01");
    expect(body.expiryDate).toBe("2027-11-30");
    expect(body.batchNumber).toBe("AMX-2411");
    expect(body.medicineId).toBe("med1");
  });

  // The other half of the same decision: Zod rejects an empty string for an
  // optional date, so a blank field has to be absent rather than "".
  it("omits mfgDate entirely when the field is left blank", async () => {
    const user = userEvent.setup();
    const dialog = await openBatchForm(user);

    await user.type(dateInputs()[0], "2027-11-30");

    await user.click(within(dialog).getByRole("button", { name: /add stock/i }));

    await waitFor(() => expect(mock.history.post).toHaveLength(1));
    const body = JSON.parse(mock.history.post[0].data);
    expect("mfgDate" in body).toBe(false);
  });

  it("caps the mfg date at the expiry date", async () => {
    const user = userEvent.setup();
    await openBatchForm(user);

    await user.type(dateInputs()[0], "2027-11-30");

    // Manufactured after it expires is not a typo worth a round trip.
    await waitFor(() =>
      expect(dateInputs()[1]).toHaveAttribute("max", "2027-11-30"),
    );
  });
});

describe("Inventory — medicine search in the batch form", () => {
  it("clears the dropdown as soon as a medicine is chosen", async () => {
    const user = userEvent.setup();
    const dialog = await openBatchForm(user);

    // The chosen name goes into the field; the result list must not still be
    // offering it. Cached results sit under the previous debounced key for
    // another 300ms, so this is read off the live input, not the debounced one.
    expect(
      within(dialog).queryByRole("button", { name: MEDICINE.name }),
    ).toBeNull();
  });
});

describe("Inventory — Add Stock completeness guard", () => {
  it("keeps submit disabled until every required field is filled", async () => {
    const user = userEvent.setup();
    render(<Inventory />, { wrapper: createQueryWrapper() });

    await user.click(await screen.findByRole("tab", { name: /stock batches/i }));
    await user.click(await screen.findByRole("button", { name: /add stock/i }));
    const dialog = await screen.findByRole("dialog");

    // An empty form must not be submittable. The server would refuse it, but a
    // disabled button says so without a round trip and without a red toast.
    expect(
      within(dialog).getByRole("button", { name: /add stock/i }),
    ).toBeDisabled();
  });

  it("enables submit once the form is complete", async () => {
    const user = userEvent.setup();
    const dialog = await openBatchForm(user);
    await user.type(dateInputs()[0], "2027-11-30");

    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: /add stock/i }),
      ).toBeEnabled(),
    );
  });
});
