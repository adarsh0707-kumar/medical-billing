import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import prisma from "../../src/config/db.js";
import { buildApp, signIn, makeSellable, line } from "../helpers/factory.js";

let app;
beforeAll(() => {
  app = buildApp();
});

const sell = (token, medicine, batch, quantity = 1) =>
  request(app)
    .post("/api/billing/invoices")
    .set("Authorization", `Bearer ${token}`)
    .send({ items: [line(medicine, batch, { quantity })] });

// Two counters billing at once is normal operation for a pharmacy, and it used
// to corrupt both stock and invoice numbering. These are regression guards for
// G-09 and G-01 — if either fix is undone, these fail.
describe("concurrent checkout", () => {
  it("lets exactly one of two simultaneous sales take the last unit", async () => {
    const { token } = await signIn(app);
    const { medicine, batch } = await makeSellable({ quantity: 1 });

    const results = await Promise.all([
      sell(token, medicine, batch),
      sell(token, medicine, batch),
    ]);
    const statuses = results.map((r) => r.status).sort();

    expect(statuses).toEqual([201, 400]);
    expect((await prisma.batch.findUnique({ where: { id: batch.id } })).quantity).toBe(0);
    expect(await prisma.invoice.count()).toBe(1);
  });

  it("never drives stock negative under a burst of oversell attempts", async () => {
    const { token } = await signIn(app);
    const { medicine, batch } = await makeSellable({ quantity: 10 });

    const results = await Promise.all(
      Array.from({ length: 12 }, () => sell(token, medicine, batch)),
    );

    const created = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 400);
    expect(created).toHaveLength(10);
    expect(rejected).toHaveLength(2);
    expect(results.filter((r) => r.status === 409)).toHaveLength(0);

    const after = await prisma.batch.findUnique({ where: { id: batch.id } });
    expect(after.quantity).toBe(0);
    expect(after.quantity).toBeGreaterThanOrEqual(0);
  });

  it("issues a distinct, gapless serial to every concurrent sale", async () => {
    const { token } = await signIn(app);
    const { medicine, batch } = await makeSellable({ quantity: 100 });

    const results = await Promise.all(
      Array.from({ length: 20 }, () => sell(token, medicine, batch)),
    );

    expect(results.every((r) => r.status === 201)).toBe(true);

    const serials = results
      .map((r) => Number(r.body.data.invoiceNumber.slice(-4)))
      .sort((a, b) => a - b);
    expect(new Set(serials).size).toBe(20);
    expect(serials).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("returns the number to the pool when a sale rolls back", async () => {
    const { token } = await signIn(app);
    const plenty = await makeSellable({ quantity: 100 });
    const empty = await makeSellable({ quantity: 1 });

    const first = await sell(token, plenty.medicine, plenty.batch);
    expect(first.body.data.invoiceNumber).toMatch(/-0001$/);

    // This one fails inside the transaction, so its serial must not be consumed.
    const failed = await sell(token, empty.medicine, empty.batch, 5);
    expect(failed.status).toBe(400);

    const second = await sell(token, plenty.medicine, plenty.batch);
    expect(second.body.data.invoiceNumber).toMatch(/-0002$/);
  });

  // Guards O-3. The counter row is seeded from the documents already recorded
  // for the day, and that seed used to count every Invoice row — credit notes
  // included, even though they allocate from their own CRN-prefixed row.
  //
  // So a shop that took a return before its first sale of the day — void
  // yesterday's invoice at nine in the morning, which is when returns happen —
  // opened its sale series at -0002. There is no -0001, and a missing serial in
  // a book of account is a question somebody has to answer later.
  it("starts the sale series at 0001 even after a credit note that morning", async () => {
    const { token, user } = await signIn(app);
    const { medicine, batch } = await makeSellable({ quantity: 100 });

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const old = await prisma.invoice.create({
      data: {
        invoiceNumber: "INV-FROM-YESTERDAY",
        userId: user.id,
        date: yesterday,
        createdAt: yesterday,
        subtotal: 100, cgst: 6, sgst: 6, totalAmount: 112,
        paymentMode: "CASH", paymentStatus: "PAID",
        items: {
          create: [{
            batchId: batch.id, medicineName: medicine.name, quantity: 1,
            unitPrice: 100, discount: 0, gstPercent: 12, totalPrice: 112,
          }],
        },
      },
    });

    // Today's first document is the reversal, not a sale.
    const voided = await request(app)
      .post(`/api/billing/invoices/${old.id}/void`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "customer returned it this morning" });
    expect(voided.status).toBe(201);
    expect(voided.body.data.invoiceNumber).toMatch(/^CRN\d{6}-0001$/);

    // ...and the day's first sale still opens the sale series.
    const first = await sell(token, medicine, batch);
    expect(first.body.data.invoiceNumber).toMatch(/^INV\d{6}-0001$/);
  });
});
