import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { buildApp, signIn } from "../helpers/factory.js";

let app;
beforeAll(() => {
  app = buildApp();
});

const ROLES = ["ADMIN", "PHARMACIST", "CASHIER"];

// The permission matrix from docs/04-api-reference.md, asserted route by route.
// One table here is worth a dozen hand-written tests: when someone changes an
// authorize(...) list, this fails and forces the change to be deliberate.
const MATRIX = [
  // [method, path, roles allowed]
  ["get", "/api/auth/me", ROLES],
  ["put", "/api/users/profile", ROLES],

  ["get", "/api/users", ["ADMIN"]],
  ["post", "/api/users", ["ADMIN"]],
  ["put", "/api/users/some-id", ["ADMIN"]],
  ["delete", "/api/users/some-id", ["ADMIN"]],
  ["post", "/api/auth/register", ["ADMIN"]],

  ["get", "/api/inventory/categories", ROLES],
  ["post", "/api/inventory/categories", ["ADMIN", "PHARMACIST"]],
  ["put", "/api/inventory/categories/some-id", ["ADMIN", "PHARMACIST"]],
  ["delete", "/api/inventory/categories/some-id", ["ADMIN"]],

  ["get", "/api/inventory/manufacturers", ROLES],
  ["post", "/api/inventory/manufacturers", ["ADMIN", "PHARMACIST"]],
  ["delete", "/api/inventory/manufacturers/some-id", ["ADMIN"]],

  ["get", "/api/inventory/medicines", ROLES],
  ["get", "/api/inventory/medicines/search", ROLES],
  ["post", "/api/inventory/medicines", ["ADMIN", "PHARMACIST"]],
  ["put", "/api/inventory/medicines/some-id", ["ADMIN", "PHARMACIST"]],
  ["delete", "/api/inventory/medicines/some-id", ["ADMIN"]],

  ["get", "/api/inventory/batches", ROLES],
  ["get", "/api/inventory/batches/expiring", ROLES],
  ["get", "/api/inventory/batches/low-stock", ROLES],
  ["post", "/api/inventory/batches", ["ADMIN", "PHARMACIST"]],
  ["put", "/api/inventory/batches/some-id", ["ADMIN", "PHARMACIST"]],

  ["get", "/api/inventory/suppliers", ROLES],
  ["post", "/api/inventory/suppliers", ["ADMIN", "PHARMACIST"]],
  ["put", "/api/inventory/suppliers/some-id", ["ADMIN", "PHARMACIST"]],
  ["delete", "/api/inventory/suppliers/some-id", ["ADMIN"]],

  ["get", "/api/billing/customers", ROLES],
  ["post", "/api/billing/customers", ROLES],
  ["put", "/api/billing/customers/some-id", ROLES],

  ["get", "/api/billing/invoices", ROLES],
  ["post", "/api/billing/invoices", ROLES],
  ["get", "/api/billing/invoices/daily-summary", ROLES],
  ["get", "/api/billing/invoices/gst-report", ["ADMIN", "PHARMACIST"]],
];

describe("role-based access control", () => {
  for (const [method, path, allowed] of MATRIX) {
    for (const role of ROLES) {
      const permitted = allowed.includes(role);
      it(`${role} ${permitted ? "may" : "may NOT"} ${method.toUpperCase()} ${path}`, async () => {
        const { token } = await signIn(app, role);
        const res = await request(app)[method](path).set("Authorization", `Bearer ${token}`).send({});

        if (permitted) {
          // The request may still fail validation or 404 — what matters is that
          // authorisation let it through.
          expect(res.status).not.toBe(403);
        } else {
          expect(res.status).toBe(403);
          expect(res.body.message).toMatch(/Access denied. Required role/);
        }
      });
    }
  }
});

describe("unauthenticated access", () => {
  it.each(MATRIX.map(([m, p]) => [m, p]))("%s %s requires a token", async (method, path) => {
    const res = await request(app)[method](path).send({});
    expect(res.status).toBe(401);
  });

  it("leaves the health check open", async () => {
    expect((await request(app).get("/health")).status).toBe(200);
  });

  it("allows login without a token", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "x@y.z", password: "nope" });
    expect(res.status).toBe(401); // rejected on credentials, not on auth
  });
});
