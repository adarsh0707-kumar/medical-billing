import { describe, it, expect } from "vitest";
import { requestPath } from "../../src/config/logger.js";

/**
 * The path in the human-readable log line.
 *
 * Express rewrites `req.url` when it dispatches into a mounted router, and the
 * message builders run on response finish — after the rewrite. So the line an
 * operator actually reads named a path that did not exist, while the structured
 * field beside it named the right one.
 */
describe("requestPath", () => {
  // The exact case observed: /api/auth is a mounted router, so by response time
  // req.url is "/setup-status" and the full path lives only on originalUrl.
  it("keeps the mount prefix a router has stripped", () => {
    expect(
      requestPath({ originalUrl: "/api/auth/setup-status", url: "/setup-status" }),
    ).toBe("/api/auth/setup-status");
  });

  // The worst version of the bug. A route at a router's own root leaves
  // req.url as "/", so `GET / 401` was the entire record of a rejected request
  // to /api/medicines — unfindable by grep, and meaningless to read.
  it("names the endpoint for a route at a router's root", () => {
    expect(requestPath({ originalUrl: "/api/medicines", url: "/" })).toBe(
      "/api/medicines",
    );
  });

  it("keeps the query string, which is where a bad request usually shows", () => {
    expect(
      requestPath({ originalUrl: "/api/reports/gst?month=13", url: "/gst" }),
    ).toBe("/api/reports/gst?month=13");
  });

  // An unmatched request never enters a router, so nothing rewrote req.url and
  // the two agree. It was the one case that always logged correctly, which is
  // part of why this went unnoticed.
  it("is unchanged for a request no router matched", () => {
    expect(requestPath({ originalUrl: "/api/nope", url: "/api/nope" })).toBe(
      "/api/nope",
    );
  });

  // pino-http calls these with its own request wrapper in some paths, which
  // does not carry originalUrl. Falling back keeps the line useful rather than
  // logging "undefined".
  it("falls back to url when originalUrl is absent", () => {
    expect(requestPath({ url: "/health" })).toBe("/health");
  });
});
