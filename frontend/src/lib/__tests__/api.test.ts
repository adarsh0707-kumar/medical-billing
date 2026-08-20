import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import MockAdapter from "axios-mock-adapter";
import api from "@/lib/api";

/**
 * docs/09 §5.6 — a 401 clears localStorage and redirects.
 *
 * This interceptor is why G-18 mattered on the backend: it treats *any* 401 as
 * "your session is gone". Before `protect` separated its catches, a database
 * failure answered 401, and this code then signed out every active user and told
 * them their session was invalid. The client behaviour is correct; the server
 * had to stop lying to it.
 */

let mock: MockAdapter;
let assignedHref: string | undefined;

beforeEach(() => {
  mock = new MockAdapter(api);
  localStorage.clear();
  assignedHref = undefined;

  // jsdom refuses a plain `window.location.href = …`, so the property is
  // replaced with a recording stub for the duration of each test.
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
});

describe("api client — 401 handling", () => {
  it("clears the stored session and redirects to /login", async () => {
    localStorage.setItem("token", "a-real-token");
    localStorage.setItem("user", JSON.stringify({ id: "u1" }));
    mock.onGet("/api/auth/me").reply(401, {
      success: false,
      message: "Invalid token.",
    });

    await expect(api.get("/api/auth/me")).rejects.toBeTruthy();

    expect(localStorage.getItem("token")).toBeNull();
    expect(localStorage.getItem("user")).toBeNull();
    expect(assignedHref).toBe("/login");
  });

  it("leaves the session alone on a 500", async () => {
    // The distinction G-18 introduced on the server. A server fault must not
    // cost the user their session — if this ever starts signing people out on
    // 5xx, a database blip becomes a mass logout again.
    localStorage.setItem("token", "a-real-token");
    mock.onGet("/api/inventory/medicines").reply(500, {
      success: false,
      message: "connection terminated unexpectedly",
    });

    await expect(api.get("/api/inventory/medicines")).rejects.toBeTruthy();

    expect(localStorage.getItem("token")).toBe("a-real-token");
    expect(assignedHref).toBeUndefined();
  });

  it.each([403, 404, 409, 400])(
    "leaves the session alone on a %i",
    async (status) => {
      localStorage.setItem("token", "a-real-token");
      mock.onGet("/api/users").reply(status, { success: false });

      await expect(api.get("/api/users")).rejects.toBeTruthy();

      expect(localStorage.getItem("token")).toBe("a-real-token");
      expect(assignedHref).toBeUndefined();
    },
  );

  it("attaches the bearer token to outgoing requests", async () => {
    localStorage.setItem("token", "a-real-token");
    mock.onGet("/api/auth/me").reply(200, { success: true, data: {} });

    await api.get("/api/auth/me");

    expect(mock.history.get[0].headers?.Authorization).toBe(
      "Bearer a-real-token",
    );
  });

  it("sends no Authorization header when there is no token", async () => {
    mock.onGet("/api/auth/me").reply(200, { success: true, data: {} });

    await api.get("/api/auth/me");

    expect(mock.history.get[0].headers?.Authorization).toBeUndefined();
  });
});
