import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import MockAdapter from "axios-mock-adapter";
import api from "@/lib/api";
import Signup from "@/pages/Signup";
import Login from "@/pages/Login";
import { useAuthStore } from "@/store/auth.store";

/**
 * Signup, now multi-tenant.
 *
 * Scoped per CONTRIBUTING: these assert wiring the components own — whether
 * the link is offered, what is sent, and what the form does with what comes
 * back. That the server actually isolates one shop's data from another's is
 * proven in the backend's own test suite.
 */

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return { ...actual, useNavigate: () => navigate };
});

let mock: MockAdapter;

const renderAt = (ui: React.ReactElement) =>
  render(ui, {
    wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter>,
  });

beforeEach(() => {
  mock = new MockAdapter(api);
  navigate.mockClear();
  useAuthStore.setState({
    user: null,
    token: null,
    isAuthenticated: false,
  } as never);
  localStorage.clear();
});

afterEach(() => {
  mock.restore();
});

describe("the login form is not pinned to one account", () => {
  it("starts empty rather than pre-filled with the seeded admin", async () => {
    renderAt(<Login />);

    // These carried admin@medstore.com / admin123 as their initial state, so a
    // pharmacist or cashier had to clear two fields before typing their own —
    // and a working password sat on screen at the counter.
    expect(await screen.findByLabelText(/email/i)).toHaveValue("");
    expect(screen.getByLabelText(/password/i)).toHaveValue("");
  });

  it("signs in whoever types, not just an administrator", async () => {
    mock.onPost("/api/auth/login").reply(200, {
      success: true,
      data: {
        token: "cashier-token",
        user: {
          id: "u9",
          name: "Ravi Kumar",
          email: "ravi@pharmacy.test",
          role: "CASHIER",
          mustChangePassword: false,
        },
      },
    });

    renderAt(<Login />);
    const user = userEvent.setup();

    await user.type(
      await screen.findByLabelText(/email/i),
      "ravi@pharmacy.test",
    );
    await user.type(screen.getByLabelText(/password/i), "a-cashier-passphrase");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(mock.history.post).toHaveLength(1));
    expect(JSON.parse(mock.history.post[0].data)).toEqual({
      email: "ravi@pharmacy.test",
      password: "a-cashier-passphrase",
    });
    // A cashier reaches the app like anyone else. What differs is what the
    // sidebar offers and what the API authorises, not whether they may sign in.
    expect(useAuthStore.getState().user?.role).toBe("CASHIER");
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/dashboard"));
  });
});

describe("the signup link on the login page", () => {
  // Always offered now: every shop is its own tenant, so there is no
  // "installation" for the link to be wrong about.
  it("is always offered", () => {
    renderAt(<Login />);

    expect(
      screen.getByRole("link", { name: /create your account/i }),
    ).toHaveAttribute("href", "/signup");
  });
});

describe("Signup", () => {
  it("creates the shop and its administrator, signs in, and goes to the dashboard", async () => {
    mock.onPost("/api/auth/signup").reply(201, {
      success: true,
      data: {
        token: "fresh-token",
        user: {
          id: "u1",
          name: "Priya Nair",
          email: "priya@pharmacy.test",
          role: "ADMIN",
          mustChangePassword: false,
        },
      },
    });

    renderAt(<Signup />);
    const user = userEvent.setup();

    await user.type(
      await screen.findByLabelText(/shop name/i),
      "Nair Medical Store",
    );
    await user.type(screen.getByLabelText(/your name/i), "Priya Nair");
    await user.type(screen.getByLabelText(/^email$/i), "priya@pharmacy.test");
    await user.type(
      screen.getByLabelText(/^password$/i),
      "a-well-chosen-passphrase",
    );
    await user.type(
      screen.getByLabelText(/confirm password/i),
      "a-well-chosen-passphrase",
    );
    await user.click(screen.getByRole("button", { name: /create shop/i }));

    await waitFor(() => expect(mock.history.post).toHaveLength(1));
    expect(JSON.parse(mock.history.post[0].data)).toEqual({
      shopName: "Nair Medical Store",
      name: "Priya Nair",
      email: "priya@pharmacy.test",
      password: "a-well-chosen-passphrase",
    });

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/dashboard", { replace: true }),
    );
    expect(useAuthStore.getState().user?.role).toBe("ADMIN");
    expect(localStorage.getItem("token")).toBe("fresh-token");
  });

  // The role is not a field on this form, and the schema is `.strict()` — a
  // caller who thinks they chose CASHIER should get a 400, not a silent strip.
  it("never sends a role", async () => {
    mock.onPost("/api/auth/signup").reply(201, {
      success: true,
      data: {
        token: "t",
        user: { id: "u1", name: "P", email: "p@x.test", role: "ADMIN" },
      },
    });

    renderAt(<Signup />);
    const user = userEvent.setup();

    await user.type(
      await screen.findByLabelText(/shop name/i),
      "Nair Medical Store",
    );
    await user.type(screen.getByLabelText(/your name/i), "Priya Nair");
    await user.type(screen.getByLabelText(/^email$/i), "priya@pharmacy.test");
    await user.type(
      screen.getByLabelText(/^password$/i),
      "a-well-chosen-passphrase",
    );
    await user.type(
      screen.getByLabelText(/confirm password/i),
      "a-well-chosen-passphrase",
    );
    await user.click(screen.getByRole("button", { name: /create shop/i }));

    await waitFor(() => expect(mock.history.post).toHaveLength(1));
    expect(JSON.parse(mock.history.post[0].data)).not.toHaveProperty("role");
  });

  it("refuses to send when the two passwords differ", async () => {
    renderAt(<Signup />);
    const user = userEvent.setup();

    await user.type(
      await screen.findByLabelText(/shop name/i),
      "Nair Medical Store",
    );
    await user.type(screen.getByLabelText(/your name/i), "Priya Nair");
    await user.type(screen.getByLabelText(/^email$/i), "priya@pharmacy.test");
    await user.type(
      screen.getByLabelText(/^password$/i),
      "a-well-chosen-passphrase",
    );
    await user.type(
      screen.getByLabelText(/confirm password/i),
      "something-else-entirely",
    );
    await user.click(screen.getByRole("button", { name: /create shop/i }));

    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(mock.history.post).toHaveLength(0);
  });

  // "Validation failed" tells an operator nothing about what to type instead.
  // The server sends the specific rule that was broken; the form shows it.
  it("surfaces the server's password rule rather than a generic message", async () => {
    mock.onPost("/api/auth/signup").reply(400, {
      success: false,
      message: "Validation failed",
      errors: [
        {
          field: "password",
          message: "Password must be at least 12 characters",
        },
      ],
    });

    renderAt(<Signup />);
    const user = userEvent.setup();

    await user.type(
      await screen.findByLabelText(/shop name/i),
      "Nair Medical Store",
    );
    await user.type(screen.getByLabelText(/your name/i), "Priya Nair");
    await user.type(screen.getByLabelText(/^email$/i), "priya@pharmacy.test");
    await user.type(screen.getByLabelText(/^password$/i), "shortpasswrd");
    await user.type(screen.getByLabelText(/confirm password/i), "shortpasswrd");
    await user.click(screen.getByRole("button", { name: /create shop/i }));

    const { toast } = await import("sonner");
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Password must be at least 12 characters",
      ),
    );
  });

  // A second signup with an email already in use is a normal, expected
  // outcome now — not a race against a global "first account" lock — so the
  // form just surfaces the server's message and leaves the form open to retry
  // with a different address.
  it("surfaces a 409 for an email already in use, and leaves the form open", async () => {
    mock.onPost("/api/auth/signup").reply(409, {
      success: false,
      message: "An account with this email already exists.",
    });

    renderAt(<Signup />);
    const user = userEvent.setup();

    await user.type(
      await screen.findByLabelText(/shop name/i),
      "Nair Medical Store",
    );
    await user.type(screen.getByLabelText(/your name/i), "Priya Nair");
    await user.type(screen.getByLabelText(/^email$/i), "priya@pharmacy.test");
    await user.type(
      screen.getByLabelText(/^password$/i),
      "a-well-chosen-passphrase",
    );
    await user.type(
      screen.getByLabelText(/confirm password/i),
      "a-well-chosen-passphrase",
    );
    await user.click(screen.getByRole("button", { name: /create shop/i }));

    const { toast } = await import("sonner");
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "An account with this email already exists.",
      ),
    );
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(screen.getByLabelText(/shop name/i)).toBeInTheDocument();
  });
});
