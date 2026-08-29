import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import prisma from "../../src/config/db.js";
import {
  buildApp,
  signIn,
  makeSellable,
  makeShop,
  line,
} from "../helpers/factory.js";

/**
 * Audit log — NFR-17, docs/07 P1-11, threat T-12.
 *
 * The point of putting this at the data layer is that a write path cannot opt
 * out by forgetting. These tests therefore go through the API and assert on the
 * table, never on the middleware directly: if someone reroutes a controller and
 * the attribution stops arriving, that has to fail here.
 */

let app;
beforeAll(() => {
  app = buildApp();
});

const as = (token, method, path, body) =>
  request(app)[method](path).set("Authorization", `Bearer ${token}`).send(body);

const auditFor = (model, recordId) =>
  prisma.auditLog.findFirst({
    where: { model, recordId },
    orderBy: { at: "desc" },
  });

describe("audit log", () => {
  it("records who created a record, and what they created", async () => {
    const { token, user } = await signIn(app, "PHARMACIST");

    const res = await as(token, "post", "/api/inventory/categories", {
      name: "Audited Category",
    });
    expect(res.status).toBe(201);

    const row = await auditFor("Category", res.body.data.id);
    expect(row).toMatchObject({
      action: "CREATE",
      actorId: user.id,
      actorEmail: user.email,
    });
    expect(row.after.name).toBe("Audited Category");
    // Nothing existed beforehand, so there is nothing honest to put here.
    expect(row.before).toBeNull();
  });

  it("records the before and after of a price change", async () => {
    const { token } = await signIn(app, "PHARMACIST");
    const { batch } = await makeSellable({ sellingPrice: 24.5 });

    await as(token, "put", `/api/inventory/batches/${batch.id}`, {
      sellingPrice: 31.75,
    });

    const row = await auditFor("Batch", batch.id);
    // The whole reason NFR-17 exists: "who changed this price, and from what".
    expect(row.action).toBe("UPDATE");
    expect(Number(row.before.sellingPrice)).toBe(24.5);
    expect(Number(row.after.sellingPrice)).toBe(31.75);
  });

  it("records a delete with the row that was removed", async () => {
    const { token } = await signIn(app, "ADMIN");
    const created = await as(token, "post", "/api/inventory/manufacturers", {
      name: "Doomed Manufacturer",
    });

    await as(
      token,
      "delete",
      `/api/inventory/manufacturers/${created.body.data.id}`,
    );

    const row = await auditFor("Manufacturer", created.body.data.id);
    expect(row.action).toBe("DELETE");
    // After a delete the only useful record is what was there.
    expect(row.before.name).toBe("Doomed Manufacturer");
    expect(row.after).toBeNull();
  });

  it("never stores a password hash or the revocation counter", async () => {
    const { token } = await signIn(app, "ADMIN");

    const res = await as(token, "post", "/api/users", {
      name: "Audited User",
      email: "audited@test.local",
      password: "a-properly-long-password",
      role: "CASHIER",
    });

    const row = await auditFor("User", res.body.data.id);
    expect(row.after.email).toBe("audited@test.local");
    // An audit row must not become a second place the credential lives.
    expect(row.after).not.toHaveProperty("password");
    expect(row.after).not.toHaveProperty("tokenVersion");
    expect(JSON.stringify(row)).not.toContain("$2");
  });

  it("leaves the invoice path alone", async () => {
    const { token } = await signIn(app, "CASHIER");
    const { medicine, batch } = await makeSellable({ quantity: 10 });
    const before = await prisma.auditLog.count();

    const res = await as(token, "post", "/api/billing/invoices", {
      items: [line(medicine, batch, { quantity: 2 })],
      paymentMode: "CASH",
      paymentStatus: "PAID",
    });
    expect(res.status).toBe(201);

    // Invoices are already attributed by Invoice.userId and never edited, and
    // the stock decrement is an updateMany inside the sale's transaction.
    // Auditing either would double the write volume of the hottest path in the
    // product to restate something already recorded.
    expect(await prisma.auditLog.count()).toBe(before);
  });

  it("attributes a write with no signed-in user to nobody, rather than guessing", async () => {
    // Mirrors the seed script and migrations: writes that happen outside a
    // request run outside the actor context.
    const shop = await makeShop();
    const category = await prisma.category.create({
      data: { shopId: shop.id, name: "Written By The System" },
    });

    const row = await auditFor("Category", category.id);
    expect(row.action).toBe("CREATE");
    expect(row.actorId).toBeNull();
    expect(row.actorEmail).toBeNull();
  });
});
