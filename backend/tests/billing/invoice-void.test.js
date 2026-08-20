import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import prisma from "../../src/config/db.js";
import { buildApp, signIn, makeSellable, line } from "../helpers/factory.js";

/**
 * Voiding an invoice — FR-BILL-17, G-15. Policy settled as PRD Q3 on 2026-08-20:
 *
 *   - stock returns to the batches it came from, keeping their expiry dates;
 *   - the original invoice stays in its own period with every figure intact, and
 *     a dated credit note lands in the period the void happened, the way a GST
 *     credit note works;
 *   - whole invoice only, no partial returns.
 *
 * The period rule is the part most easily got wrong, and the reason it is worth
 * stating twice: removing a cancelled invoice from its own month would rewrite a
 * tax period that may already have been filed. The net across the two periods is
 * zero; neither period on its own is edited after the fact.
 */

let app;
let admin;

beforeAll(async () => {
  app = buildApp();
});

const sell = async (token, batch, medicine, quantity = 3) => {
  const res = await request(app)
    .post("/api/billing/invoices")
    .set("Authorization", `Bearer ${token}`)
    .send({
      items: [line(medicine, batch, { quantity })],
      discountAmt: 0,
      paymentMode: "CASH",
      paymentStatus: "PAID",
    });
  expect(res.status).toBe(201);
  return res.body.data;
};

const stockOf = async (batchId) =>
  (await prisma.batch.findUnique({ where: { id: batchId } })).quantity;

const voidIt = (token, id, reason = "keyed the wrong quantity") =>
  request(app)
    .post(`/api/billing/invoices/${id}/void`)
    .set("Authorization", `Bearer ${token}`)
    .send({ reason });

describe("voiding an invoice", () => {
  it("restores stock to the original batch and issues a credit note", async () => {
    ({ token: admin } = await signIn(app, "ADMIN"));
    const { batch, medicine } = await makeSellable({ quantity: 10 });

    const invoice = await sell(admin, batch, medicine, 3);
    expect(await stockOf(batch.id)).toBe(7);

    const res = await voidIt(admin, invoice.id);
    expect(res.status).toBe(201);

    // Back into the same batch, so the expiry date and batch number the units
    // were sold under are the ones they return under (PRD Q3).
    expect(await stockOf(batch.id)).toBe(10);

    const note = res.body.data;
    expect(note.type).toBe("CREDIT_NOTE");
    expect(note.invoiceNumber).toMatch(/^CRN\d{6}-\d{4}$/);
    expect(note.reversesId).toBe(invoice.id);
    expect(Number(note.totalAmount)).toBe(-Number(invoice.totalAmount));
  });

  it("leaves every field of the original except its status untouched", async () => {
    const { token } = await signIn(app, "ADMIN");
    const { batch, medicine } = await makeSellable({ quantity: 10 });
    const invoice = await sell(token, batch, medicine, 2);

    const before = await prisma.invoice.findUnique({
      where: { id: invoice.id },
      include: { items: true },
    });

    expect((await voidIt(token, invoice.id)).status).toBe(201);

    const after = await prisma.invoice.findUnique({
      where: { id: invoice.id },
      include: { items: true },
    });

    // A filed period must still reconcile to what was filed, so the correction
    // is a separate document rather than an edit. Only `status` may move.
    expect(after.status).toBe("CANCELLED");
    expect(before.status).toBe("ACTIVE");

    const ignoring = ({ status, ...rest }) => rest;
    expect(JSON.parse(JSON.stringify(ignoring(after)))).toEqual(
      JSON.parse(JSON.stringify(ignoring(before))),
    );
  });

  it("restores stock exactly once when the void is submitted twice", async () => {
    const { token } = await signIn(app, "ADMIN");
    const { batch, medicine } = await makeSellable({ quantity: 10 });
    const invoice = await sell(token, batch, medicine, 4);
    expect(await stockOf(batch.id)).toBe(6);

    expect((await voidIt(token, invoice.id)).status).toBe(201);
    expect(await stockOf(batch.id)).toBe(10);

    const second = await voidIt(token, invoice.id, "double submit");
    expect(second.status).toBe(409);
    // The failure mode this guards: a second restoration taking stock to 14,
    // inventing four units that never existed.
    expect(await stockOf(batch.id)).toBe(10);
    expect(await prisma.invoice.count({ where: { type: "CREDIT_NOTE" } })).toBe(1);
  });

  it("restores stock exactly once under two concurrent voids", async () => {
    // The sequential case above is caught by the status check. This one is
    // caught by the unique index on reversesId: both transactions can read
    // ACTIVE, and only one can insert the credit note.
    const { token } = await signIn(app, "ADMIN");
    const { batch, medicine } = await makeSellable({ quantity: 20 });
    const invoice = await sell(token, batch, medicine, 5);
    expect(await stockOf(batch.id)).toBe(15);

    const results = await Promise.all([
      voidIt(token, invoice.id, "first"),
      voidIt(token, invoice.id, "second"),
    ]);

    const created = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 409);
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(1);

    expect(await stockOf(batch.id)).toBe(20);
    expect(await prisma.invoice.count({ where: { type: "CREDIT_NOTE" } })).toBe(1);
  });

  it("refuses to void a credit note", async () => {
    const { token } = await signIn(app, "ADMIN");
    const { batch, medicine } = await makeSellable({ quantity: 10 });
    const invoice = await sell(token, batch, medicine, 1);
    const note = (await voidIt(token, invoice.id)).body.data;

    const res = await voidIt(token, note.id, "reversing the reversal");
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/credit note cannot itself be voided/i);
  });

  it("requires a reason", async () => {
    const { token } = await signIn(app, "ADMIN");
    const { batch, medicine } = await makeSellable({ quantity: 10 });
    const invoice = await sell(token, batch, medicine, 1);

    const res = await request(app)
      .post(`/api/billing/invoices/${invoice.id}/void`)
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
    // Why a bill was cancelled is the whole value of the audit trail.
    expect(await stockOf(batch.id)).toBe(9);
  });

  it("404s for an invoice that does not exist", async () => {
    const { token } = await signIn(app, "ADMIN");
    const res = await voidIt(token, "no-such-invoice");
    expect(res.status).toBe(404);
  });
});

describe("who may void", () => {
  it.each(["PHARMACIST", "CASHIER"])("refuses a %s with 403", async (role) => {
    const { token: adminToken } = await signIn(app, "ADMIN");
    const { batch, medicine } = await makeSellable({ quantity: 10 });
    const invoice = await sell(adminToken, batch, medicine, 2);

    const { token } = await signIn(app, role);
    const res = await voidIt(token, invoice.id);

    expect(res.status).toBe(403);
    // Refused before anything moved.
    expect(await stockOf(batch.id)).toBe(8);
    expect(
      (await prisma.invoice.findUnique({ where: { id: invoice.id } })).status,
    ).toBe("ACTIVE");
  });
});

describe("what a void does to the reports", () => {
  it("nets to zero across the daily summary, without editing the original day", async () => {
    const { token } = await signIn(app, "ADMIN");
    const { batch, medicine } = await makeSellable({ quantity: 10 });
    const invoice = await sell(token, batch, medicine, 2);

    const today = new Date().toISOString().split("T")[0];
    const before = await request(app)
      .get(`/api/billing/invoices/daily-summary?date=${today}`)
      .set("Authorization", `Bearer ${token}`);
    const salesBefore = Number(before.body.data.summary.totalSales);

    expect((await voidIt(token, invoice.id)).status).toBe(201);

    const after = await request(app)
      .get(`/api/billing/invoices/daily-summary?date=${today}`)
      .set("Authorization", `Bearer ${token}`);

    // Both documents fall on the same day here, so the day nets to what it was
    // before the sale — the credit note's negative cancels the sale's positive.
    expect(Number(after.body.data.summary.totalSales)).toBe(
      salesBefore - Number(invoice.totalAmount),
    );
  });

  it("leaves the original in its own month and puts the credit note in the current one", async () => {
    // The month boundary, which is the case most easily got wrong. A sale made
    // last month and voided this month must not change last month's figures:
    // that period may already have been filed.
    const { token } = await signIn(app, "ADMIN");
    const { batch, medicine } = await makeSellable({ quantity: 10 });
    const invoice = await sell(token, batch, medicine, 2);

    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1, 15);
    lastMonth.setHours(12, 0, 0, 0);
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { date: lastMonth },
    });

    const gst = (d) =>
      request(app)
        .get(
          `/api/billing/invoices/gst-report?month=${d.getMonth() + 1}&year=${d.getFullYear()}`,
        )
        .set("Authorization", `Bearer ${token}`);

    const priorBefore = Number((await gst(lastMonth)).body.data.totals.total);

    expect((await voidIt(token, invoice.id)).status).toBe(201);

    const priorAfter = await gst(lastMonth);
    const current = await gst(new Date());

    // Last month is untouched — the invoice is still there, cancelled or not.
    expect(Number(priorAfter.body.data.totals.total)).toBe(priorBefore);
    expect(
      priorAfter.body.data.invoices.some((i) => i.id === invoice.id),
    ).toBe(true);

    // This month carries the reversal.
    expect(Number(current.body.data.totals.total)).toBe(
      -Number(invoice.totalAmount),
    );
  });

  it("keeps cgst === sgst on the credit note", async () => {
    const { token } = await signIn(app, "ADMIN");
    const { batch, medicine } = await makeSellable({ quantity: 10 });
    const invoice = await sell(token, batch, medicine, 3);

    const note = (await voidIt(token, invoice.id)).body.data;

    expect(Number(note.cgst)).toBe(Number(note.sgst));
    // The reversal reconciles the same way the sale did.
    expect(
      Number(note.subtotal) +
        Number(note.cgst) +
        Number(note.sgst) -
        Number(note.discountAmt),
    ).toBeCloseTo(Number(note.totalAmount), 2);
  });
});
