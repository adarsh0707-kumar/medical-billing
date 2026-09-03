import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MockAdapter from "axios-mock-adapter";
import api from "@/lib/api";
import Inventory from "@/pages/Inventory";
import { createQueryWrapper } from "@/test/query-wrapper";
import { HSN_CODES } from "@/lib/hsn";

/**
 * The HSN code on the medicine form.
 *
 * HSN is the classification a GST return is filed against, so it is not the
 * shop's to invent — but picking between `30049099` and `30049011` from memory
 * at the counter is how a return comes back wrong. The field offers the codes
 * a pharmacy uses with what each covers.
 *
 * The assertion that matters most is the last one: the catalogue holds
 * six-digit codes from before this list existed, and a select that silently
 * dropped a code it did not recognise would rewrite what a medicine is filed
 * under every time somebody edited its name.
 */

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

let mock: MockAdapter;

const MASTERS = [{ id: "m1", name: "Analgesics" }];

/** A medicine filed under a code that is not on the reference list. */
const OFF_LIST = {
  id: "med1",
  name: "Legacy Item",
  genericName: "",
  unit: "tablet",
  gstPercent: 12,
  hsnCode: "300406",
  packSize: "",
  isScheduledH: false,
  isActive: true,
  category: MASTERS[0],
  manufacturer: MASTERS[0],
  totalStock: 0,
};

beforeEach(() => {
  // Radix's Select relies on pointer-capture APIs jsdom does not implement.
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();

  mock = new MockAdapter(api);
  mock.onGet("/api/inventory/categories").reply(200, { success: true, data: MASTERS });
  mock.onGet("/api/inventory/manufacturers").reply(200, { success: true, data: MASTERS });
  mock.onGet("/api/suppliers").reply(200, { success: true, data: [] });
  mock.onGet("/api/medicines/units").reply(200, { success: true, data: ["tablet"] });
  mock.onGet(/\/api\/medicines\?/).reply(200, {
    success: true,
    data: [],
    pagination: { pages: 1, total: 0 },
  });
  mock.onPost("/api/medicines").reply(201, { success: true, data: {} });
  mock.onPut(/\/api\/medicines\//).reply(200, { success: true, data: {} });
});

afterEach(() => {
  mock.restore();
  vi.restoreAllMocks();
});

const openAddForm = async (user: ReturnType<typeof userEvent.setup>) => {
  render(<Inventory />, { wrapper: createQueryWrapper() });
  await user.click(await screen.findByRole("button", { name: /add medicine/i }));
  await user.type(
    await screen.findByPlaceholderText(/amoxicillin 500mg/i),
    "Ceftriaxone 1g",
  );
};

const submit = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: /^add medicine$/i }));

const posted = () =>
  JSON.parse(mock.history.post.find((r) => r.url === "/api/medicines")?.data ?? "{}");

describe("Inventory — the HSN code", () => {
  it("offers each code with what it covers", async () => {
    const user = userEvent.setup();
    await openAddForm(user);

    await user.click(screen.getByRole("combobox", { name: /hsn code/i }));

    // The description is the whole point: an eight-digit box tells the
    // operator nothing about which of two neighbouring codes is right.
    const insulin = await screen.findByRole("option", { name: /30043110/ });
    expect(insulin).toHaveTextContent("Insulin");
    expect(
      screen.getByRole("option", { name: /30049011/ }),
    ).toHaveTextContent("Ayurvedic / Unani / Siddha medicaments");
  });

  it("offers the whole reference list", async () => {
    const user = userEvent.setup();
    await openAddForm(user);

    await user.click(screen.getByRole("combobox", { name: /hsn code/i }));
    await screen.findByRole("option", { name: /30041011/ });

    for (const { code } of HSN_CODES) {
      expect(screen.getByRole("option", { name: new RegExp(code) })).toBeInTheDocument();
    }
  });

  it("sends the code that was picked", async () => {
    const user = userEvent.setup();
    await openAddForm(user);

    await user.click(screen.getByRole("combobox", { name: /hsn code/i }));
    await user.click(await screen.findByRole("option", { name: /30045000/ }));
    await submit(user);

    await waitFor(() => expect(posted().hsnCode).toBe("30045000"));
  });

  // A closed list would be the `unit` enum again: a shop selling something
  // outside these twelve would file it under a code it knows is wrong.
  it("takes a code that is not on the list", async () => {
    const user = userEvent.setup();
    await openAddForm(user);

    await user.click(screen.getByRole("combobox", { name: /hsn code/i }));
    await user.click(await screen.findByRole("option", { name: /other hsn code/i }));
    await user.type(await screen.findByLabelText("Other HSN code"), "90189099");
    await submit(user);

    await waitFor(() => expect(posted().hsnCode).toBe("90189099"));
  });

  it("puts the previous code back when a typed one is abandoned", async () => {
    const user = userEvent.setup();
    await openAddForm(user);

    await user.click(screen.getByRole("combobox", { name: /hsn code/i }));
    await user.click(await screen.findByRole("option", { name: /30042099/ }));
    await user.click(screen.getByRole("combobox", { name: /hsn code/i }));
    await user.click(await screen.findByRole("option", { name: /other hsn code/i }));
    await user.type(await screen.findByLabelText("Other HSN code"), "999");
    await user.click(screen.getByRole("button", { name: /cancel other hsn code/i }));

    await submit(user);

    await waitFor(() => expect(posted().hsnCode).toBe("30042099"));
  });

  it("can be cleared back to nothing", async () => {
    const user = userEvent.setup();
    await openAddForm(user);

    await user.click(screen.getByRole("combobox", { name: /hsn code/i }));
    await user.click(await screen.findByRole("option", { name: /30049099/ }));
    await user.click(screen.getByRole("combobox", { name: /hsn code/i }));
    await user.click(await screen.findByRole("option", { name: /^not set$/i }));

    await submit(user);

    // Optional on the server, so an empty string is a medicine with no HSN
    // rather than a validation failure.
    await waitFor(() => expect(posted().hsnCode).toBe(""));
  });

  /**
   * The catalogue holds six-digit codes entered before this list existed. A
   * select that offered only its twelve would show an empty box for those and
   * drop the code on the next save — rewriting what a medicine is filed under
   * as a side effect of correcting its spelling.
   */
  it("keeps a code it does not recognise when editing an existing medicine", async () => {
    mock.onGet(/\/api\/medicines\?/).reply(200, {
      success: true,
      data: [OFF_LIST],
      pagination: { pages: 1, total: 1 },
    });

    const user = userEvent.setup();
    render(<Inventory />, { wrapper: createQueryWrapper() });
    await user.click(await screen.findByRole("button", { name: /edit medicine/i }));

    // Present on the trigger, so the operator can see what it is filed under.
    const trigger = await screen.findByRole("combobox", { name: /hsn code/i });
    expect(trigger).toHaveTextContent("300406");

    await user.click(screen.getByRole("button", { name: /^update$/i }));

    await waitFor(() => expect(mock.history.put).toHaveLength(1));
    expect(JSON.parse(mock.history.put[0].data).hsnCode).toBe("300406");
  });
});
