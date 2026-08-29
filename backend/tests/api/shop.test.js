import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import prisma from "../../src/config/db.js";
import { buildApp, signIn, makeShop } from "../helpers/factory.js";

/**
 * `GET/PUT /api/shop` — the business details printed on every invoice header.
 *
 * What matters most here is tenant isolation: an administrator can only ever
 * read or write their own shop's row, never another shop's, because there is
 * no shopId in either request for a caller to aim elsewhere.
 */

let app;
beforeAll(() => {
  app = buildApp();
});

const as = (token, method, path, body) =>
  request(app)[method](path).set("Authorization", `Bearer ${token}`).send(body);

describe("GET /api/shop", () => {
  it("is readable by every role, not just ADMIN", async () => {
    for (const role of ["ADMIN", "PHARMACIST", "CASHIER"]) {
      const { token } = await signIn(app, role);
      const res = await as(token, "get", "/api/shop");
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ name: expect.any(String) });
    }
  });

  it("returns only this caller's own shop, never another's", async () => {
    const other = await makeShop({ name: "Someone Else's Pharmacy" });
    const { token } = await signIn(app, "ADMIN");

    const res = await as(token, "get", "/api/shop");

    expect(res.body.data.name).not.toBe("Someone Else's Pharmacy");
    expect(res.body.data.id).not.toBe(other.id);
  });
});

describe("PUT /api/shop", () => {
  it("lets an administrator update the shop's business details", async () => {
    const { token } = await signIn(app, "ADMIN");

    const res = await as(token, "put", "/api/shop", {
      name: "Nair Medical Store",
      address: "12 MG Road, Bangalore",
      phone: "9876543210",
      gstNumber: "29AAACN1234A1Z5",
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: "Nair Medical Store",
      address: "12 MG Road, Bangalore",
      phone: "9876543210",
      gstNumber: "29AAACN1234A1Z5",
    });
  });

  it.each(["PHARMACIST", "CASHIER"])(
    "refuses a %s — only ADMIN may edit shop details",
    async (role) => {
      const { token } = await signIn(app, role);

      const res = await as(token, "put", "/api/shop", { name: "Renamed" });

      expect(res.status).toBe(403);
    },
  );

  it("cannot be used to reach or rename another shop", async () => {
    const other = await makeShop({ name: "Untouched Pharmacy" });
    const { token } = await signIn(app, "ADMIN");

    // No shopId field exists on the schema to smuggle one through — this
    // confirms the strict schema rejects the attempt rather than silently
    // ignoring it and updating the caller's own shop instead.
    const res = await as(token, "put", "/api/shop", {
      name: "Hijacked",
      shopId: other.id,
    });

    expect(res.status).toBe(400);

    const untouched = await prisma.shop.findUnique({ where: { id: other.id } });
    expect(untouched.name).toBe("Untouched Pharmacy");
  });

  it("clears an optional field when sent as an empty value", async () => {
    const { token } = await signIn(app, "ADMIN");
    await as(token, "put", "/api/shop", { name: "Shop A", phone: "111" });

    const res = await as(token, "put", "/api/shop", {
      name: "Shop A",
      phone: null,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.phone).toBeNull();
  });

  it("rejects a name under 2 characters", async () => {
    const { token } = await signIn(app, "ADMIN");

    const res = await as(token, "put", "/api/shop", { name: "A" });

    expect(res.status).toBe(400);
  });
});
