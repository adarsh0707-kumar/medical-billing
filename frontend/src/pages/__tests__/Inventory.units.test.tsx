import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MockAdapter from "axios-mock-adapter";
import api from "@/lib/api";
import Inventory from "@/pages/Inventory";
import { createQueryWrapper } from "@/test/query-wrapper";

/**
 * The dispensing unit on the medicine form.
 *
 * It was a nine-value enum on the server and a matching hard-coded list here,
 * so a shop selling vials, sachets or strips had to file them under "other" —
 * which is then what a customer read in the PACK column of their invoice.
 *
 * What only this layer can see is the payload: that a unit typed by hand
 * actually leaves the browser, and leaves it in the form the server stores.
 * Whether the server accepts it is `tests/inventory/medicines.test.js`.
 */

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

let mock: MockAdapter;

const MASTERS = [{ id: "m1", name: "Analgesics" }];

beforeEach(() => {
  // Radix's Select relies on pointer-capture APIs jsdom does not implement.
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();

  mock = new MockAdapter(api);
  mock.onGet("/api/inventory/categories").reply(200, {
    success: true,
    data: MASTERS,
  });
  mock.onGet("/api/inventory/manufacturers").reply(200, {
    success: true,
    data: MASTERS,
  });
  mock.onGet("/api/suppliers").reply(200, { success: true, data: [] });
  // The vocabulary this shop already uses: one of the nine defaults and one
  // that only exists because somebody typed it.
  mock.onGet("/api/medicines/units").reply(200, {
    success: true,
    data: ["tablet", "vial"],
  });
  mock.onGet(/\/api\/medicines\?/).reply(200, {
    success: true,
    data: [],
    pagination: { pages: 1, total: 0 },
  });
  mock.onPost("/api/medicines").reply(201, { success: true, data: {} });
});

afterEach(() => {
  mock.restore();
  vi.restoreAllMocks();
});

/** Opens Add Medicine with the required fields filled in. */
async function openMedicineForm(user: ReturnType<typeof userEvent.setup>) {
  render(<Inventory />, { wrapper: createQueryWrapper() });
  await user.click(await screen.findByRole("button", { name: /add medicine/i }));
  await user.type(
    await screen.findByPlaceholderText(/amoxicillin 500mg/i),
    "Ceftriaxone 1g",
  );
}

const postedBody = () =>
  JSON.parse(
    mock.history.post.find((r) => r.url === "/api/medicines")?.data ?? "{}",
  );

describe("Inventory — the unit field", () => {
  it("offers the units this shop already uses, not only the built-in list", async () => {
    const user = userEvent.setup();
    await openMedicineForm(user);

    await user.click(screen.getByRole("combobox", { name: /unit/i }));

    // "vial" is on the list only because the shop uses it — the half that
    // makes adding a unit stick rather than being a one-off.
    expect(
      await screen.findByRole("option", { name: "vial" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "capsule" })).toBeInTheDocument();
  });

  it("sends a hand-typed unit, lower-cased", async () => {
    const user = userEvent.setup();
    await openMedicineForm(user);

    await user.click(screen.getByRole("combobox", { name: /unit/i }));
    await user.click(await screen.findByRole("option", { name: /add a unit/i }));
    await user.type(await screen.findByLabelText("New unit"), "Sachet");

    await user.click(screen.getByRole("button", { name: /^add medicine$/i }));

    // Lower-cased here as well as on the server, so the select does not show
    // "Sachet" for a medicine stored as "sachet".
    await waitFor(() => expect(postedBody().unit).toBe("sachet"));
  });

  it("puts the previous unit back when the new one is abandoned", async () => {
    const user = userEvent.setup();
    await openMedicineForm(user);

    await user.click(screen.getByRole("combobox", { name: /unit/i }));
    await user.click(await screen.findByRole("option", { name: /add a unit/i }));
    await user.type(await screen.findByLabelText("New unit"), "sach");
    await user.click(screen.getByRole("button", { name: /cancel new unit/i }));

    // Not left empty: the form opened on "tablet" and cancelling is not a
    // request to clear a required field.
    await user.click(screen.getByRole("button", { name: /^add medicine$/i }));
    await waitFor(() => expect(postedBody().unit).toBe("tablet"));
  });

  it("refuses to submit a blank unit rather than sending one", async () => {
    const user = userEvent.setup();
    await openMedicineForm(user);

    await user.click(screen.getByRole("combobox", { name: /unit/i }));
    await user.click(await screen.findByRole("option", { name: /add a unit/i }));
    await user.type(await screen.findByLabelText("New unit"), "   ");

    await user.click(screen.getByRole("button", { name: /^add medicine$/i }));

    expect(
      mock.history.post.some((r) => r.url === "/api/medicines"),
    ).toBe(false);
  });
});
