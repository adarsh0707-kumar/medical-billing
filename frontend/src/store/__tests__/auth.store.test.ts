import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import MockAdapter from "axios-mock-adapter";
import axios from "axios";
import api from "@/lib/api";
import { useAuthStore } from "@/store/auth.store";

/**
 * Signing out has to reach the server.
 *
 * Until this was wired up, `logout()` cleared two localStorage keys and nothing
 * else: `User.tokenVersion` was never bumped and the `HttpOnly` refresh cookie
 * was never revoked, so the session survived the click and stayed renewable for
 * its full week. SECURITY.md and docs/07 §10.7 both described the API's
 * behaviour as though it were the product's.
 *
 * The guard these tests carry is that the request is made, and that the local
 * sign-out happens regardless of what the server says.
 */

let mock: MockAdapter;
let assignedHref: string | undefined;

const signedIn = () => {
  localStorage.setItem("token", "a-real-token");
  localStorage.setItem("user", JSON.stringify({ id: "u1" }));
  useAuthStore.setState({
    user: { id: "u1", name: "Asha", email: "a@medstore.com", role: "CASHIER" },
    token: "a-real-token",
    isAuthenticated: true,
  });
};

const logoutCalls = () =>
  mock.history.post.filter((r) => r.url === "/api/auth/logout");

beforeEach(() => {
  mock = new MockAdapter(api);
  localStorage.clear();
  assignedHref = undefined;

  // Same stub as lib/__tests__/api.test.ts: jsdom refuses a plain assignment to
  // window.location.href, and the 401 path in the interceptor performs one.
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: {
      ...window.location,
      set href(value: string) {
        assignedHref = value;
      },
      get href() {
        return assignedHref ?? "http://localhost/";
      },
    },
  });
});

afterEach(() => {
  mock.restore();
  vi.restoreAllMocks();
  useAuthStore.setState({ user: null, token: null, isAuthenticated: false });
});

describe("auth store — signing out", () => {
  it("calls the logout endpoint, authenticated", async () => {
    signedIn();
    mock.onPost("/api/auth/logout").reply(200, { success: true });

    await useAuthStore.getState().logout();

    expect(logoutCalls()).toHaveLength(1);
    // The route is behind `protect`, so an unauthenticated request would be
    // refused and revoke nothing.
    expect(logoutCalls()[0].headers?.Authorization).toBe("Bearer a-real-token");
  });

  it("clears local state on success", async () => {
    signedIn();
    mock.onPost("/api/auth/logout").reply(200, { success: true });

    await useAuthStore.getState().logout();

    expect(localStorage.getItem("token")).toBeNull();
    expect(localStorage.getItem("user")).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();
  });

  it("clears local state even when the request fails", async () => {
    // The offline case. A sign-out that cannot reach the server must still sign
    // the user out here rather than trapping them on the page.
    signedIn();
    mock.onPost("/api/auth/logout").networkError();

    await expect(useAuthStore.getState().logout()).resolves.toBeUndefined();

    expect(localStorage.getItem("token")).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it("clears local state when the server rejects it", async () => {
    signedIn();
    mock.onPost("/api/auth/logout").reply(500, { success: false });

    await expect(useAuthStore.getState().logout()).resolves.toBeUndefined();

    expect(localStorage.getItem("token")).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it("does not reject, so a fire-and-forget caller cannot break", async () => {
    // Sidebar and ForcePasswordChange both call this without awaiting. If it
    // rejected, that would surface as an unhandled promise rejection.
    signedIn();
    mock.onPost("/api/auth/logout").reply(503, { success: false });

    const settled = await Promise.allSettled([
      useAuthStore.getState().logout(),
    ]);

    expect(settled[0].status).toBe("fulfilled");
  });
});

describe("auth store — signing out with an expired access token", () => {
  it("recovers via one refresh and still ends the session", async () => {
    // A user idle past the 30-minute access token clicks sign out. The
    // interceptor spends one refresh, retries, and the session is revoked —
    // which is the case that matters most, because the machine has been sitting
    // unattended. Skipping the refresh here would leave the cookie alive.
    signedIn();
    const refresh = vi
      .spyOn(axios, "post")
      .mockResolvedValue({ data: { data: { token: "fresh-token" } } });

    mock
      .onPost("/api/auth/logout")
      .replyOnce(401, { success: false, message: "Invalid token." })
      .onPost("/api/auth/logout")
      .replyOnce(200, { success: true });

    await useAuthStore.getState().logout();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(logoutCalls()).toHaveLength(2);
    expect(logoutCalls()[1].headers?.Authorization).toBe("Bearer fresh-token");
    expect(localStorage.getItem("token")).toBeNull();
  });

  it("stops after one retry when the refresh fails", async () => {
    // The bound that makes the above safe: `_retried` on the request config
    // means a second 401 cannot start a second refresh. Without it, a token the
    // server keeps rejecting would loop.
    signedIn();
    const refresh = vi
      .spyOn(axios, "post")
      .mockRejectedValue(new Error("refresh cookie revoked"));

    mock.onPost("/api/auth/logout").reply(401, { success: false });

    await useAuthStore.getState().logout();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(logoutCalls()).toHaveLength(1);
    expect(localStorage.getItem("token")).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });
});
