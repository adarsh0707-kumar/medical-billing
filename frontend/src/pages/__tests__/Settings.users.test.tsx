import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MockAdapter from "axios-mock-adapter";
import api from "@/lib/api";
import Settings from "@/pages/Settings";
import { useAuthStore } from "@/store/auth.store";
import { createQueryWrapper } from "@/test/query-wrapper";

/**
 * docs/09 §5.6 — user management on the Settings screen.
 *
 * Scoped per CONTRIBUTING: these assert *wiring and guards the component owns*,
 * not authorisation. Whether a cashier may delete a user is settled by
 * `authorize("ADMIN")` on the server and proven in `tests/auth/rbac.test.js`;
 * hiding the tab is UX. What is only true here is that the destructive button
 * asks first, and that declining means nothing is sent.
 */

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

let mock: MockAdapter;

const USERS = [
  { id: "u1", name: "Asha Rao", email: "asha@shop.test", role: "PHARMACIST", isActive: true },
  { id: "u2", name: "Bela Nair", email: "bela@shop.test", role: "CASHIER", isActive: false },
];

const renderAsAdmin = () => {
  useAuthStore.setState({
    user: { id: "admin", name: "Admin", email: "admin@shop.test", role: "ADMIN" },
    token: "t",
    isAuthenticated: true,
  } as never);
  return render(<Settings />, { wrapper: createQueryWrapper() });
};

beforeEach(() => {
  mock = new MockAdapter(api);
  mock.onGet("/api/users").reply(200, { success: true, data: USERS });
});

afterEach(() => {
  mock.restore();
  vi.restoreAllMocks();
});

const openUsersTab = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole("tab", { name: /user management/i }));
  return screen.findByText("Asha Rao");
};

describe("Settings — user management", () => {
  it("lists the users the API returned", async () => {
    const user = userEvent.setup();
    renderAsAdmin();
    await openUsersTab(user);

    expect(screen.getByText("Bela Nair")).toBeInTheDocument();
  });

  // The guard worth having a test for: this is irreversible and one click away.
  it("asks before deleting, and sends nothing if the answer is no", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderAsAdmin();
    await openUsersTab(user);

    const rows = screen.getAllByRole("button", { name: /delete user/i });
    await user.click(rows[0]);

    expect(window.confirm).toHaveBeenCalled();
    expect(mock.history.delete).toHaveLength(0);
  });

  it("deletes only after the confirmation is accepted", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mock.onDelete("/api/users/u1").reply(200, { success: true });
    renderAsAdmin();
    await openUsersTab(user);

    await user.click(screen.getAllByRole("button", { name: /delete user/i })[0]);

    await waitFor(() => expect(mock.history.delete).toHaveLength(1));
    expect(mock.history.delete[0].url).toBe("/api/users/u1");
  });

  it("refetches the list after a delete instead of mutating it locally", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mock.onDelete("/api/users/u1").reply(200, { success: true });
    renderAsAdmin();
    await openUsersTab(user);

    const before = mock.history.get.filter((r) => r.url === "/api/users").length;
    await user.click(screen.getAllByRole("button", { name: /delete user/i })[0]);

    // The server is the source of truth for who exists; splicing the row out
    // locally would show a delete that may have been refused.
    await waitFor(() =>
      expect(
        mock.history.get.filter((r) => r.url === "/api/users").length,
      ).toBeGreaterThan(before),
    );
  });
});
