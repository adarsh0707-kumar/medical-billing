import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { buildApp, signIn, makeSellable, makeMedicine } from "../helpers/factory.js";

/**
 * The 2.0.0 route layout, and the deprecated aliases that carry clients to it.
 *
 * Routers used to be grouped by module, so a customer lived at
 * `/api/billing/customers` and a medicine at `/api/inventory/medicines`. 2.0.0
 * groups by resource instead.
 *
 * What these assert is the property that makes the aliases safe: an old path and
 * its successor reach the **same handler**, not merely a similar one. Two routes
 * that happen to agree today are a bug waiting for the next change to one of
 * them, so the comparison is on the response body, not on a status code.
 */

let app;
beforeAll(() => {
  app = buildApp();
});

const get = (token, path) =>
  request(app).get(path).set("Authorization", `Bearer ${token}`);

// Every move 2.0.0 makes: [new path, deprecated alias].
const MOVES = [
  ["/api/customers", "/api/billing/customers"],
  ["/api/medicines", "/api/inventory/medicines"],
  ["/api/medicines/search?q=par", "/api/inventory/medicines/search?q=par"],
  ["/api/suppliers", "/api/inventory/suppliers"],
  ["/api/reports/daily-summary", "/api/billing/invoices/daily-summary"],
  ["/api/reports/gst?month=5&year=2026", "/api/billing/invoices/gst-report?month=5&year=2026"],
  ["/api/reports/trend?days=7", "/api/billing/invoices/trend?days=7"],
  ["/api/reports/expiring?days=30", "/api/inventory/batches/expiring?days=30"],
  ["/api/reports/low-stock?threshold=10", "/api/inventory/batches/low-stock?threshold=10"],
];

describe("2.0.0 route layout", () => {
  it.each(MOVES)("%s serves the resource", async (path) => {
    const { token } = await signIn(app);
    await makeSellable();
    const res = await get(token, path);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it.each(MOVES)("%s and its alias return the same body", async (path, alias) => {
    const { token } = await signIn(app);
    await makeSellable();

    const [fresh, old] = await Promise.all([
      get(token, path),
      get(token, alias),
    ]);

    expect(old.status).toBe(fresh.status);
    // Byte-identical, because both run the same controller function.
    expect(old.body).toEqual(fresh.body);
  });
});

describe("deprecated aliases", () => {
  it.each(MOVES)("%s: the alias says it is deprecated", async (path, alias) => {
    const { token } = await signIn(app);
    const res = await get(token, alias);

    // RFC 8594 — a gateway or client library can act on these without anyone
    // having read a changelog.
    expect(res.headers.deprecation).toBe("true");
    expect(res.headers.sunset).toBeTruthy();
    expect(Date.parse(res.headers.sunset)).not.toBeNaN();
    // RFC 8288 — names where it went, not just that it is going.
    expect(res.headers.link).toContain('rel="successor-version"');
  });

  it.each(MOVES)("%s: the new path is not itself marked deprecated", async (path) => {
    const { token } = await signIn(app);
    const res = await get(token, path);
    expect(res.headers.deprecation).toBeUndefined();
    expect(res.headers.sunset).toBeUndefined();
  });
});

describe("the new routers keep the old guards", () => {
  it("still refuses an unauthenticated caller", async () => {
    for (const [path] of MOVES) {
      const res = await request(app).get(path);
      expect(res.status, `${path} should require a token`).toBe(401);
    }
  });

  it("keeps the GST report restricted to ADMIN and PHARMACIST", async () => {
    const { token } = await signIn(app, "CASHIER");
    expect((await get(token, "/api/reports/gst?month=5&year=2026")).status).toBe(403);
    // Moving a route must not quietly widen who may read a filing position.
    expect((await get(token, "/api/reports/daily-summary")).status).toBe(200);
  });

  it("keeps erasure ADMIN-only on the new customer path", async () => {
    const { token } = await signIn(app, "PHARMACIST");
    const res = await request(app)
      .delete("/api/customers/whatever")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("still validates query parameters on the new paths", async () => {
    const { token } = await signIn(app);
    // A garbage period must stay a 400 rather than becoming an empty report.
    expect((await get(token, "/api/reports/gst?month=13&year=2026")).status).toBe(400);
  });

  it("keeps literal paths above parameterised ones", async () => {
    const { token } = await signIn(app);
    await makeMedicine({ name: "Paracetamol 500mg" });
    // If /:id matched first, "search" would be read as a medicine id and 404.
    const res = await get(token, "/api/medicines/search?q=para");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});
