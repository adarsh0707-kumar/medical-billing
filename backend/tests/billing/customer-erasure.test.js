import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import prisma from "../../src/config/db.js";
import { buildApp, signIn, makeSellable, line } from "../helpers/factory.js";
import { run, findExpired, cutoffDate } from "../../src/utils/retention.js";

/**
 * Customer erasure and retention — PRD Q6, docs/07 §8.
 *
 * The constraint that shapes all of this: invoices carry a foreign key to
 * Customer and are append-only tax records, so "delete the customer" is not
 * available. Erasure blanks the personal fields and leaves the sale standing.
 */

let app;
beforeAll(() => {
  app = buildApp();
});

const as = (token, method, path, body) =>
  request(app)[method](path).set("Authorization", `Bearer ${token}`).send(body);

const makeCustomer = (token, over = {}) =>
  as(token, "post", "/api/billing/customers", {
    name: "Sunita Rao",
    phone: `98${Math.floor(10000000 + Math.random() * 89999999)}`,
    email: "sunita@example.in",
    address: "14 Nehru Road",
    age: 61,
    gender: "FEMALE",
    ...over,
  });

describe("DELETE /api/billing/customers/:id — erasure", () => {
  it("blanks the personal fields but keeps the row and its invoices", async () => {
    const { token } = await signIn(app, "ADMIN");
    const customer = (await makeCustomer(token)).body.data;
    const { medicine, batch } = await makeSellable({ quantity: 10 });

    const invoice = (
      await as(token, "post", "/api/billing/invoices", {
        customerId: customer.id,
        items: [line(medicine, batch, { quantity: 2 })],
        paymentMode: "CASH",
        paymentStatus: "PAID",
      })
    ).body.data;

    const res = await as(token, "delete", `/api/billing/customers/${customer.id}`);
    expect(res.status).toBe(200);

    const after = await prisma.customer.findUnique({ where: { id: customer.id } });
    // The row survives, because the invoice points at it.
    expect(after).not.toBeNull();
    expect(after.anonymisedAt).toBeInstanceOf(Date);
    expect(after.phone).toBeNull();
    expect(after.email).toBeNull();
    expect(after.address).toBeNull();
    expect(after.age).toBeNull();
    expect(after.gender).toBeNull();
    expect(after.name).not.toContain("Sunita");

    // And the tax record is untouched — same number, same money. A GST return
    // filed against it still reconciles.
    const keptInvoice = await prisma.invoice.findUnique({ where: { id: invoice.id } });
    expect(keptInvoice.invoiceNumber).toBe(invoice.invoiceNumber);
    expect(Number(keptInvoice.totalAmount)).toBe(Number(invoice.totalAmount));
    expect(keptInvoice.customerId).toBe(customer.id);
  });

  it("redacts the customer's audit trail, including the erasure's own entry", async () => {
    const { token } = await signIn(app, "ADMIN");
    const customer = (await makeCustomer(token)).body.data;

    await as(token, "put", `/api/billing/customers/${customer.id}`, {
      name: "Sunita Rao",
      phone: customer.phone,
      address: "22 Gandhi Marg",
    });

    await as(token, "delete", `/api/billing/customers/${customer.id}`);

    const rows = await prisma.auditLog.findMany({
      where: { model: "Customer", recordId: customer.id },
    });
    expect(rows.length).toBeGreaterThanOrEqual(2);

    // Blanking the customer while a full copy sat in the audit log would be
    // theatre. The trail keeps who and when; only the payload goes.
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain("Sunita");
    expect(dump).not.toContain("Nehru");
    expect(dump).not.toContain("Gandhi Marg");
    for (const row of rows) {
      expect(row.actorEmail).toBeTruthy();
      expect(row.at).toBeInstanceOf(Date);
    }
  });

  it("is idempotent, and repairs a half-finished erasure", async () => {
    const { token } = await signIn(app, "ADMIN");
    const customer = (await makeCustomer(token)).body.data;

    await as(token, "delete", `/api/billing/customers/${customer.id}`);
    const second = await as(token, "delete", `/api/billing/customers/${customer.id}`);

    expect(second.status).toBe(200);
    expect(second.body.message).toMatch(/already erased/i);
  });

  it("is refused to anyone but an admin", async () => {
    const { token: admin } = await signIn(app, "ADMIN");
    const customer = (await makeCustomer(admin)).body.data;

    for (const role of ["PHARMACIST", "CASHIER"]) {
      const { token } = await signIn(app, role);
      expect((await as(token, "delete", `/api/billing/customers/${customer.id}`)).status).toBe(403);
    }

    expect((await prisma.customer.findUnique({ where: { id: customer.id } })).anonymisedAt).toBeNull();
  });

  it("404s for a customer that does not exist", async () => {
    const { token } = await signIn(app, "ADMIN");
    expect((await as(token, "delete", "/api/billing/customers/nope")).status).toBe(404);
  });
});

// Decision 3. Purchase history in a pharmacy reveals health conditions, so this
// is a real access decision rather than a default (threat T-9).
describe("who may read a customer's purchase history", () => {
  it("gives it to an admin and a pharmacist", async () => {
    const { token: admin } = await signIn(app, "ADMIN");
    const customer = (await makeCustomer(admin)).body.data;
    const { medicine, batch } = await makeSellable({ quantity: 10 });
    await as(admin, "post", "/api/billing/invoices", {
      customerId: customer.id,
      items: [line(medicine, batch, { quantity: 1 })],
      paymentMode: "CASH",
      paymentStatus: "PAID",
    });

    // Reuses the admin token rather than signing in again: the factory gives
    // each role one fixed email, so a second signIn for the same role in one
    // test collides on the unique constraint.
    const { token: pharmacist } = await signIn(app, "PHARMACIST");
    for (const token of [admin, pharmacist]) {
      const res = await as(token, "get", `/api/billing/customers/${customer.id}`);
      expect(res.body.data.invoices).toHaveLength(1);
    }
  });

  it("withholds it from a cashier, without breaking customer lookup", async () => {
    const { token: admin } = await signIn(app, "ADMIN");
    const customer = (await makeCustomer(admin)).body.data;
    const { medicine, batch } = await makeSellable({ quantity: 10 });
    await as(admin, "post", "/api/billing/invoices", {
      customerId: customer.id,
      items: [line(medicine, batch, { quantity: 1 })],
      paymentMode: "CASH",
      paymentStatus: "PAID",
    });

    const { token: cashier } = await signIn(app, "CASHIER");
    const res = await as(cashier, "get", `/api/billing/customers/${customer.id}`);

    expect(res.status).toBe(200);
    // The POS still needs to find people and attach them to a sale.
    expect(res.body.data.name).toBe("Sunita Rao");
    expect(res.body.data.phone).toBeTruthy();
    // Absent, not empty: an empty array would assert they had never bought
    // anything, which is false.
    expect(res.body.data.invoices).toBeUndefined();
  });

  it("still lets a cashier search the customer list", async () => {
    const { token: admin } = await signIn(app, "ADMIN");
    await makeCustomer(admin, { name: "Findable Person" });

    const { token: cashier } = await signIn(app, "CASHIER");
    const res = await as(cashier, "get", "/api/billing/customers?search=Findable");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});

describe("retention sweep", () => {
  const backdate = async (customerId, monthsAgo) => {
    const when = new Date();
    when.setMonth(when.getMonth() - monthsAgo);
    await prisma.customer.update({
      where: { id: customerId },
      data: { createdAt: when },
    });
    return when;
  };

  it("selects a customer who has never bought anything and is older than the window", async () => {
    const { token } = await signIn(app, "ADMIN");
    const stale = (await makeCustomer(token, { name: "Long Gone" })).body.data;
    const recent = (await makeCustomer(token, { name: "Still Here" })).body.data;
    await backdate(stale.id, 40);

    const expired = await findExpired(cutoffDate(36));
    const ids = expired.map((c) => c.id);

    expect(ids).toContain(stale.id);
    expect(ids).not.toContain(recent.id);
  });

  it("keeps a customer whose last purchase is inside the window", async () => {
    const { token } = await signIn(app, "ADMIN");
    const customer = (await makeCustomer(token)).body.data;
    const { medicine, batch } = await makeSellable({ quantity: 10 });
    await as(token, "post", "/api/billing/invoices", {
      customerId: customer.id,
      items: [line(medicine, batch, { quantity: 1 })],
      paymentMode: "CASH",
      paymentStatus: "PAID",
    });
    // Old record, recent trade — the relationship is alive.
    await backdate(customer.id, 60);

    const ids = (await findExpired(cutoffDate(36))).map((c) => c.id);
    expect(ids).not.toContain(customer.id);
  });

  it("changes nothing unless asked to apply", async () => {
    const { token } = await signIn(app, "ADMIN");
    const stale = (await makeCustomer(token)).body.data;
    await backdate(stale.id, 40);

    // A retention purge is irreversible; a tool that erases because somebody
    // was looking at it is a bad tool.
    const dry = await run({ apply: false });
    expect(dry.considered).toBeGreaterThanOrEqual(1);
    expect(dry.erased).toBe(0);
    expect((await prisma.customer.findUnique({ where: { id: stale.id } })).anonymisedAt).toBeNull();

    const applied = await run({ apply: true });
    expect(applied.erased).toBeGreaterThanOrEqual(1);
    expect((await prisma.customer.findUnique({ where: { id: stale.id } })).anonymisedAt).not.toBeNull();
  });
});
