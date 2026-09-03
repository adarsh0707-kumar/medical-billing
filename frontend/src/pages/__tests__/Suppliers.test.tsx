import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MockAdapter from "axios-mock-adapter";
import api from "@/lib/api";
import Suppliers from "@/pages/Suppliers";
import { createQueryWrapper } from "@/test/query-wrapper";
import { toast } from "sonner";

/**
 * docs/09 §5.6 — the Suppliers screen.
 *
 * Supplier field validation belongs to the server and is proven in
 * `tests/inventory/suppliers.test.js`. What only this layer sees is that saving
 * re-reads the list rather than patching it locally — the bug class where a
 * screen shows a row the server never accepted.
 */

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

let mock: MockAdapter;

const SUPPLIERS = [
  { id: "s1", name: "Kaveri Distributors", phone: "9000000001", contactName: "Ravi" },
];

beforeEach(() => {
  mock = new MockAdapter(api);
  mock.onGet(/\/api\/suppliers/).reply(200, { success: true, data: SUPPLIERS });
  mock.onPost("/api/suppliers").reply(201, { success: true, data: {} });
});

afterEach(() => {
  mock.restore();
  vi.restoreAllMocks();
});

const listRequests = () =>
  mock.history.get.filter((r) => /\/suppliers/.test(r.url ?? ""));

describe("Suppliers", () => {
  it("renders the suppliers the API returned", async () => {
    render(<Suppliers />, { wrapper: createQueryWrapper() });
    expect(await screen.findByText("Kaveri Distributors")).toBeInTheDocument();
  });

  it("posts a new supplier and then re-reads the list", async () => {
    const user = userEvent.setup();
    render(<Suppliers />, { wrapper: createQueryWrapper() });
    await screen.findByText("Kaveri Distributors");

    await user.click(screen.getByRole("button", { name: /add supplier/i }));
    await user.type(
      await screen.findByPlaceholderText(/Company \/ Distributor name/i),
      "Nilgiri Pharma",
    );
    // Two controls share the label: the toolbar trigger and the form's submit.
    // The submit is the one inside the form.
    const submit = screen
      .getAllByRole("button", { name: /add supplier/i })
      .find((b) => b.getAttribute("type") === "submit")!;
    await user.click(submit);

    await waitFor(() => expect(mock.history.post).toHaveLength(1));
    expect(JSON.parse(mock.history.post[0].data).name).toBe("Nilgiri Pharma");

    // The server decides what a supplier record looks like once saved; pushing
    // the local form object into the list would show fields it never returned.
    await waitFor(() => expect(listRequests().length).toBeGreaterThan(1));
  });

  /**
   * Deleting a supplier was reachable from nothing.
   *
   * `DELETE /api/suppliers/:id` has existed since the resource did; the card
   * offered only Edit, so a distributor entered by mistake stayed in the
   * dropdown of every batch form for good.
   */
  describe("deleting", () => {
    it("asks first, then deletes, then re-reads the list", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      mock.onDelete("/api/suppliers/s1").reply(200, { success: true });

      const user = userEvent.setup();
      render(<Suppliers />, { wrapper: createQueryWrapper() });
      await screen.findByText("Kaveri Distributors");
      const before = listRequests().length;

      await user.click(
        screen.getByRole("button", { name: /delete kaveri distributors/i }),
      );

      expect(window.confirm).toHaveBeenCalled();
      await waitFor(() => expect(mock.history.delete).toHaveLength(1));
      // Same reasoning as the save above: the list comes from the server.
      await waitFor(() =>
        expect(listRequests().length).toBeGreaterThan(before),
      );
    });

    it("sends nothing when the confirm is declined", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(false);
      mock.onDelete(/\/api\/suppliers\//).reply(200, { success: true });

      const user = userEvent.setup();
      render(<Suppliers />, { wrapper: createQueryWrapper() });
      await screen.findByText("Kaveri Distributors");

      await user.click(
        screen.getByRole("button", { name: /delete kaveri distributors/i }),
      );

      expect(mock.history.delete).toHaveLength(0);
    });

    // A supplier with stock against it comes back 409 with a sentence saying
    // exactly that. Replacing it with a generic failure would leave the
    // operator retrying a delete that can never succeed.
    it("shows the server's reason when the supplier is still in use", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      mock.onDelete("/api/suppliers/s1").reply(409, {
        success: false,
        message: "This record is still in use by other data and cannot be deleted.",
      });

      const user = userEvent.setup();
      render(<Suppliers />, { wrapper: createQueryWrapper() });
      await screen.findByText("Kaveri Distributors");

      await user.click(
        screen.getByRole("button", { name: /delete kaveri distributors/i }),
      );

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          "This record is still in use by other data and cannot be deleted.",
        ),
      );
    });
  });

  /**
   * The distributor card grew the fields a real supplier master carries, and
   * the form's shape is not the API's in two ways this layer is the only place
   * to see.
   */
  describe("the fuller card", () => {
    const openForm = async (user: ReturnType<typeof userEvent.setup>) => {
      render(<Suppliers />, { wrapper: createQueryWrapper() });
      await screen.findByText("Kaveri Distributors");
      await user.click(screen.getByRole("button", { name: /add supplier/i }));
      await user.type(
        await screen.findByPlaceholderText(/Company \/ Distributor name/i),
        "Sharma Medical Agencies",
      );
    };

    const submit = async (user: ReturnType<typeof userEvent.setup>) => {
      const button = screen
        .getAllByRole("button", { name: /add supplier/i })
        .find((b) => b.getAttribute("type") === "submit")!;
      await user.click(button);
    };

    const posted = () => JSON.parse(mock.history.post[0].data);

    it("sends the whole card when it is filled in", async () => {
      const user = userEvent.setup();
      await openForm(user);

      await user.type(screen.getByPlaceholderText("SUP-001"), "SUP-001");
      await user.type(screen.getByPlaceholderText("Patna"), "Patna");
      await user.type(screen.getByPlaceholderText("Bihar"), "Bihar");
      await user.type(screen.getByPlaceholderText("800004"), "800004");
      await user.type(
        screen.getByPlaceholderText(/BR\/PAT/),
        "BR/PAT/20B-2214",
      );
      await user.type(screen.getByPlaceholderText("30 days credit"), "30 days credit");
      await user.type(screen.getByPlaceholderText("Mon, Wed, Fri"), "Mon, Wed, Fri");
      await user.type(screen.getByPlaceholderText("250000"), "250000");

      await submit(user);

      await waitFor(() => expect(mock.history.post).toHaveLength(1));
      expect(posted()).toMatchObject({
        name: "Sharma Medical Agencies",
        code: "SUP-001",
        city: "Patna",
        state: "Bihar",
        pincode: "800004",
        drugLicenceNo: "BR/PAT/20B-2214",
        paymentTerms: "30 days credit",
        deliveryDays: "Mon, Wed, Fri",
      });
    });

    // `code` is unique per shop and an empty string is a *value*: two blank
    // codes collide on the index and the second supplier is refused over a
    // field nobody filled in. NULLs are distinct, so absent must be absent.
    it("omits the fields nobody filled in rather than sending empty strings", async () => {
      const user = userEvent.setup();
      await openForm(user);

      await submit(user);

      await waitFor(() => expect(mock.history.post).toHaveLength(1));
      const body = posted();
      expect(body).toEqual({ name: "Sharma Medical Agencies" });
      expect("code" in body).toBe(false);
    });

    it("sends the credit limit as a number, not the typed string", async () => {
      const user = userEvent.setup();
      await openForm(user);
      await user.type(screen.getByPlaceholderText("250000"), "250000");

      await submit(user);

      await waitFor(() => expect(mock.history.post).toHaveLength(1));
      expect(posted().creditLimit).toBe(250000);
    });

    it("refuses to send a credit limit that is not a number", async () => {
      const user = userEvent.setup();
      await openForm(user);
      await user.type(screen.getByPlaceholderText("250000"), "two lakh");

      await submit(user);

      expect(mock.history.post).toHaveLength(0);
      expect(toast.error).toHaveBeenCalledWith("Credit limit must be a number");
    });
  });
});
