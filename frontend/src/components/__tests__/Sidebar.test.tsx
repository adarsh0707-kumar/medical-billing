import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Sidebar from "@/components/layout/Sidebar";
import { useAuthStore } from "@/store/auth.store";
import type { User } from "@/types";

/**
 * docs/09 §5.6 — the sidebar hides Settings for non-admins.
 *
 * WHY THIS IS COSMETIC ONLY, and why the test says so out loud:
 *
 * Hiding a nav item is not access control. It removes a link, not a capability —
 * a cashier who types /settings, or calls `GET /api/users` with curl, is stopped
 * by `authorize("ADMIN")` on the server, which is the real boundary. That server
 * side is asserted by the 142-case RBAC matrix in `backend/tests/auth/rbac.test.js`
 * and again by the Playwright smoke, which signs in as a cashier and confirms
 * both the missing link AND a 403 from the API.
 *
 * If this test ever passes while the server check is missing, the system is
 * wide open and this file will not tell you. It guards the UI, nothing more.
 */

const asRole = (role: User["role"]) =>
  useAuthStore.setState({
    user: { id: "u1", name: role, email: `${role}@test.local`, role },
    token: "token",
    isAuthenticated: true,
  });

const renderSidebar = () =>
  render(
    <MemoryRouter>
      {/* The drawer props belong to the phone layout; this file is about the
          role filter, which is the same either side of the breakpoint. */}
      <Sidebar collapsed={false} open={false} onClose={() => {}} />
    </MemoryRouter>,
  );

beforeEach(() => {
  useAuthStore.setState({ user: null, token: null, isAuthenticated: false });
});

describe("Sidebar", () => {
  it("shows Settings to an ADMIN", () => {
    asRole("ADMIN");
    renderSidebar();
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it.each(["PHARMACIST", "CASHIER"] as const)(
    "hides Settings from a %s",
    (role) => {
      asRole(role);
      renderSidebar();
      expect(screen.queryByText("Settings")).not.toBeInTheDocument();
    },
  );

  it("shows every non-admin item to every role", () => {
    // The filter is `!item.adminOnly || role === "ADMIN"`. A regression that
    // inverted it would hide everything from a cashier, which this catches.
    asRole("CASHIER");
    renderSidebar();

    for (const label of [
      "Dashboard",
      "Billing",
      "Inventory",
      "Customers",
      "Suppliers",
      "Reports",
    ])
      expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("hides Settings when there is no user at all", () => {
    renderSidebar();
    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
  });
});
