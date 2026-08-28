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
 * First-run setup, both halves of it.
 *
 * Scoped per CONTRIBUTING: these assert wiring the components own — whether the
 * link is offered, what is sent, and what the closed state says. That signup
 * refuses a second account is the server's job and is proven in
 * `backend/tests/auth/signup.test.js`, including under a concurrent burst.
 */

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return { ...actual, useNavigate: () => navigate };
});

let mock: MockAdapter;

const renderAt = (ui: React.ReactElement) =>
  render(ui, { wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter> });

beforeEach(() => {
  mock = new MockAdapter(api);
  navigate.mockClear();
  useAuthStore.setState({ user: null, token: null, isAuthenticated: false } as never);
  localStorage.clear();
});

afterEach(() => {
  mock.restore();
});

describe("the signup link on the login page", () => {
  it("is offered while the installation is unclaimed", async () => {
    mock.onGet("/api/auth/setup-status").reply(200, {
      success: true,
      data: { needsSetup: true },
    });

    renderAt(<Login />);

    expect(
      await screen.findByRole("link", { name: /set up this system/i }),
    ).toHaveAttribute("href", "/signup");
  });

  it("is absent once the system has an account", async () => {
    mock.onGet("/api/auth/setup-status").reply(200, {
      success: true,
      data: { needsSetup: false },
    });

    renderAt(<Login />);

    // Waited for, not asserted immediately: the check is asynchronous, so an
    // instant assertion would pass even if the link appeared a tick later.
    await waitFor(() => expect(mock.history.get.length).toBe(1));
    expect(screen.queryByRole("link", { name: /set up this system/i })).toBeNull();
  });

  // Offering a link whose only outcome is "closed" is worse than offering
  // nothing, so an unreachable API renders as no link rather than as a guess.
  it("is absent when the status check fails", async () => {
    mock.onGet("/api/auth/setup-status").networkError();

    renderAt(<Login />);

    await waitFor(() => expect(mock.history.get.length).toBe(1));
    expect(screen.queryByRole("link", { name: /set up this system/i })).toBeNull();
  });
});

describe("Signup — the open state", () => {
  const openSetup = () =>
    mock.onGet("/api/auth/setup-status").reply(200, {
      success: true,
      data: { needsSetup: true },
    });

  it("creates the account, signs in, and goes to the dashboard", async () => {
    openSetup();
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

    await user.type(await screen.findByLabelText(/your name/i), "Priya Nair");
    await user.type(screen.getByLabelText(/^email$/i), "priya@pharmacy.test");
    await user.type(screen.getByLabelText(/^password$/i), "a-well-chosen-passphrase");
    await user.type(screen.getByLabelText(/confirm password/i), "a-well-chosen-passphrase");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => expect(mock.history.post).toHaveLength(1));
    expect(JSON.parse(mock.history.post[0].data)).toEqual({
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
    openSetup();
    mock.onPost("/api/auth/signup").reply(201, {
      success: true,
      data: { token: "t", user: { id: "u1", name: "P", email: "p@x.test", role: "ADMIN" } },
    });

    renderAt(<Signup />);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText(/your name/i), "Priya Nair");
    await user.type(screen.getByLabelText(/^email$/i), "priya@pharmacy.test");
    await user.type(screen.getByLabelText(/^password$/i), "a-well-chosen-passphrase");
    await user.type(screen.getByLabelText(/confirm password/i), "a-well-chosen-passphrase");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => expect(mock.history.post).toHaveLength(1));
    expect(JSON.parse(mock.history.post[0].data)).not.toHaveProperty("role");
  });

  it("refuses to send when the two passwords differ", async () => {
    openSetup();

    renderAt(<Signup />);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText(/your name/i), "Priya Nair");
    await user.type(screen.getByLabelText(/^email$/i), "priya@pharmacy.test");
    await user.type(screen.getByLabelText(/^password$/i), "a-well-chosen-passphrase");
    await user.type(screen.getByLabelText(/confirm password/i), "something-else-entirely");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(mock.history.post).toHaveLength(0);
  });

  // "Validation failed" tells an operator nothing about what to type instead.
  // The server sends the specific rule that was broken; the form shows it.
  it("surfaces the server's password rule rather than a generic message", async () => {
    openSetup();
    mock.onPost("/api/auth/signup").reply(400, {
      success: false,
      message: "Validation failed",
      errors: [
        { field: "password", message: "Password must be at least 12 characters" },
      ],
    });

    renderAt(<Signup />);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText(/your name/i), "Priya Nair");
    await user.type(screen.getByLabelText(/^email$/i), "priya@pharmacy.test");
    await user.type(screen.getByLabelText(/^password$/i), "shortpasswrd");
    await user.type(screen.getByLabelText(/confirm password/i), "shortpasswrd");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    const { toast } = await import("sonner");
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Password must be at least 12 characters",
      ),
    );
  });
});

describe("Signup — the closed state", () => {
  it("explains how accounts are actually created, and does not show a form", async () => {
    mock.onGet("/api/auth/setup-status").reply(200, {
      success: true,
      data: { needsSetup: false },
    });

    renderAt(<Signup />);

    expect(await screen.findByText(/signup is closed/i)).toBeInTheDocument();
    expect(screen.getByText(/ask yours to add you/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^password$/i)).toBeNull();
    expect(screen.getByRole("link", { name: /back to sign in/i })).toHaveAttribute(
      "href",
      "/login",
    );
  });

  it("closes the form if the installation is claimed while it is open", async () => {
    mock.onGet("/api/auth/setup-status").reply(200, {
      success: true,
      data: { needsSetup: true },
    });
    mock.onPost("/api/auth/signup").reply(409, {
      success: false,
      code: "SETUP_ALREADY_COMPLETE",
      message: "This system already has an account. Ask an administrator to create yours.",
    });

    renderAt(<Signup />);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText(/your name/i), "Priya Nair");
    await user.type(screen.getByLabelText(/^email$/i), "priya@pharmacy.test");
    await user.type(screen.getByLabelText(/^password$/i), "a-well-chosen-passphrase");
    await user.type(screen.getByLabelText(/confirm password/i), "a-well-chosen-passphrase");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    // Someone else finished setup first. Leaving the form up would invite the
    // operator to keep retrying a request that can never succeed again.
    expect(await screen.findByText(/signup is closed/i)).toBeInTheDocument();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it("does not render the form while the check is still in flight", () => {
    mock.onGet("/api/auth/setup-status").reply(() => new Promise(() => {}));

    renderAt(<Signup />);

    // Neither state is correct yet, so neither is shown — flashing a form that
    // is about to be replaced by "closed" reads as a bug.
    expect(screen.queryByLabelText(/^password$/i)).toBeNull();
    expect(screen.queryByText(/signup is closed/i)).toBeNull();
  });
});
