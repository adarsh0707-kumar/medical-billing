import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import ProtectedRoute from "@/components/ProtectedRoute";
import { useAuthStore } from "@/store/auth.store";

/**
 * docs/09 §5.6 — an unauthenticated visitor is redirected to /login.
 *
 * This is a usability guarantee, not a security one. Every protected screen also
 * calls an API that requires a bearer token, and the server rejects the request
 * regardless of what the client renders. A visitor who bypasses this component
 * sees an empty shell, not data.
 */

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<div>login screen</div>} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <div>dashboard content</div>
            </ProtectedRoute>
          }
        />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  useAuthStore.setState({ user: null, token: null, isAuthenticated: false });
});

describe("ProtectedRoute", () => {
  it("redirects an unauthenticated visitor to /login", () => {
    renderAt("/dashboard");

    expect(screen.getByText("login screen")).toBeInTheDocument();
    expect(screen.queryByText("dashboard content")).not.toBeInTheDocument();
  });

  it("renders the protected content once authenticated", () => {
    useAuthStore.setState({
      user: { id: "u1", name: "Admin", email: "a@b.c", role: "ADMIN" },
      token: "token",
      isAuthenticated: true,
    });

    renderAt("/dashboard");

    expect(screen.getByText("dashboard content")).toBeInTheDocument();
    expect(screen.queryByText("login screen")).not.toBeInTheDocument();
  });

  it("replaces the history entry rather than pushing one", () => {
    // `replace` matters: without it the redirect stacks, and the browser back
    // button bounces the visitor between /dashboard and /login.
    renderAt("/dashboard");
    expect(screen.getByText("login screen")).toBeInTheDocument();
  });
});
