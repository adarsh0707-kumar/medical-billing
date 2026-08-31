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
    // is a separate document rather than an edit. Only `status` may move — and,
    // since partial returns landed, each line's `returnedQty`, which is
    // bookkeeping about what has since come back rather than a change to what
    // was issued. Every figure that appears on the printed invoice is untouched.
    expect(after.status).toBe("CANCELLED");
    expect(before.status).toBe("ACTIVE");
    // A full void returns everything, so the counter matches what was sold.
    for (const item of after.items) {
      expect(item.returnedQty).toBe(item.quantity);
    }

    const ignoring = ({ status, items, ...rest }) => ({
      ...rest,
      items: items.map(({ returnedQty, ...line }) => line),
    });
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

// Partial returns — the half of FR-BILL-17 deliberately deferred from G-15.
//
// The guard is the point. A full void was protected by two single-shot
// mechanisms: a conditional update on `status = ACTIVE` and a unique index on
// `reversesId`. Neither works once one sale can have several credit notes, so
// the guarantee moved to a cumulative counter on each line.
describe("partial returns", () => {
  const ret = (token, id, items, reason = "customer returned part of the order") =>
    request(app)
      .post(`/api/billing/invoices/${id}/void`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reason, items });

  const lineOf = (invoice) => invoice.items[0];

  it("returns some units, leaves the invoice live for the rest", async () => {
    const { token } = await signIn(app, "ADMIN");
    const { batch, medicine } = await makeSellable({ quantity: 10 });
    const invoice = await sell(token, batch, medicine, 5);
    expect(await stockOf(batch.id)).toBe(5);

    const res = await ret(token, invoice.id, [
      { invoiceItemId: lineOf(invoice).id, quantity: 2 },
    ]);

    expect(res.status).toBe(201);
    expect(await stockOf(batch.id)).toBe(7);

    const after = await prisma.invoice.findUnique({
      where: { id: invoice.id },
      include: { items: true },
    });
    // Still a live sale for the three units the customer kept.
    expect(after.status).toBe("ACTIVE");
    expect(after.items[0].returnedQty).toBe(2);
  });

  it("cancels the invoice only once the last unit comes back", async () => {
    const { token } = await signIn(app, "ADMIN");
    const { batch, medicine } = await makeSellable({ quantity: 10 });
    const invoice = await sell(token, batch, medicine, 5);
    const lineId = lineOf(invoice).id;

    await ret(token, invoice.id, [{ invoiceItemId: lineId, quantity: 2 }]);
    expect((await prisma.invoice.findUnique({ where: { id: invoice.id } })).status).toBe("ACTIVE");

    await ret(token, invoice.id, [{ invoiceItemId: lineId, quantity: 3 }]);

    const after = await prisma.invoice.findUnique({ where: { id: invoice.id } });
    expect(after.status).toBe("CANCELLED");
    expect(await stockOf(batch.id)).toBe(10);
  });

  it("refuses to return more than is outstanding", async () => {
    const { token } = await signIn(app, "ADMIN");
    const { batch, medicine } = await makeSellable({ quantity: 10 });
    const invoice = await sell(token, batch, medicine, 5);
    const lineId = lineOf(invoice).id;

    await ret(token, invoice.id, [{ invoiceItemId: lineId, quantity: 4 }]);
    const res = await ret(token, invoice.id, [{ invoiceItemId: lineId, quantity: 2 }]);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/1 of 5 still outstanding/);
    expect(await stockOf(batch.id)).toBe(9);
  });

  it("credits exactly what the invoice charged, once fully returned", async () => {
    const { token } = await signIn(app, "ADMIN");
    const { batch, medicine } = await makeSellable({ quantity: 10, sellingPrice: 33.33 });
    const invoice = await sell(token, batch, medicine, 3);
    const lineId = lineOf(invoice).id;

    const first = await ret(token, invoice.id, [{ invoiceItemId: lineId, quantity: 1 }]);
    const second = await ret(token, invoice.id, [{ invoiceItemId: lineId, quantity: 2 }]);

    // The whole point of splitting a reversal: the parts must still add up to
    // the original, to the paisa, or a GST period stops reconciling.
    const credited =
      Number(first.body.data.totalAmount) + Number(second.body.data.totalAmount);
    expect(credited).toBeCloseTo(-Number(invoice.totalAmount), 10);
  });

  it("apportions a bill-level discount and settles the remainder on the last return", async () => {
    const { token } = await signIn(app, "ADMIN");
    const { batch, medicine } = await makeSellable({ quantity: 10 });
    const res = await request(app)
      .post("/api/billing/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        items: [line(medicine, batch, { quantity: 4 })],
        discountAmt: 7,
        paymentMode: "CASH",
        paymentStatus: "PAID",
      });
    const invoice = res.body.data;
    const lineId = invoice.items[0].id;

    const a = await ret(token, invoice.id, [{ invoiceItemId: lineId, quantity: 1 }]);
    const b = await ret(token, invoice.id, [{ invoiceItemId: lineId, quantity: 3 }]);

    // Pro-rating alone would leave the credits a paisa off after rounding, so
    // the return that completes the invoice takes whatever discount is left.
    const discountCredited =
      Number(a.body.data.discountAmt) + Number(b.body.data.discountAmt);
    expect(discountCredited).toBeCloseTo(-7, 10);

    const totalCredited =
      Number(a.body.data.totalAmount) + Number(b.body.data.totalAmount);
    expect(totalCredited).toBeCloseTo(-Number(invoice.totalAmount), 10);
  });

  // GUARD G-15/a — the case the whole design exists for. Two returns claiming
  // the same units must not both win. Guards the cumulative conditional update
  // in voidInvoice; delete it and 3 + 3 units come back off a 5-unit line.
  it("lets only one of two simultaneous returns of the same units succeed", async () => {
    const { token } = await signIn(app, "ADMIN");
    const { batch, medicine } = await makeSellable({ quantity: 10 });
    const invoice = await sell(token, batch, medicine, 5);
    const lineId = lineOf(invoice).id;

    // Both ask for 3 of the 5 sold. Together that is 6, which must not happen.
    const [first, second] = await Promise.all([
      ret(token, invoice.id, [{ invoiceItemId: lineId, quantity: 3 }]),
      ret(token, invoice.id, [{ invoiceItemId: lineId, quantity: 3 }]),
    ]);

    const codes = [first.status, second.status].sort();
    expect(codes).toEqual([201, 409]);

    const after = await prisma.invoice.findUnique({
      where: { id: invoice.id },
      include: { items: true },
    });
    expect(after.items[0].returnedQty).toBe(3);
    // Stock moved once, not twice — the loser rolled its whole transaction back.
    expect(await stockOf(batch.id)).toBe(8);
    expect(await prisma.invoice.count({ where: { reversesId: invoice.id } })).toBe(1);
  });

  // Twelve, and the number is load-bearing — it was four until 2026-08-31.
  //
  // A void restores stock with `tx.batch.update`, and Batch is an audited model.
  // While auditing ran as a Prisma middleware it could not see the caller's
  // transaction, so its before/after reads and its AuditLog insert went out on
  // the *global* client while the transaction still held a pooled connection.
  // Every concurrent void therefore needed two connections at once, and N voids
  // deadlocked as soon as N exceeded half the pool — whatever the pool happens
  // to be, since Prisma sizes it from the host's CPU count.
  //
  // So this test capped itself at four: a test written around a defect rather
  // than against it, which is why the cap carried a paragraph explaining that
  // the number was not about the thing being tested.
  //
  // The audit trail is now a client extension writing through the caller's
  // transaction (config/audit.js), so an audited write inside a transaction
  // costs one connection again. Measured on 2026-08-31 by disabling only the
  // `$transaction` wrapper in config/db.js and re-running this test: twelve
  // concurrent returns produced **zero** successes, every one dying on pool
  // exhaustion and the 5s transaction timeout. With the wrapper, twelve of
  // twelve pass in about 300ms.
  //
  // Twelve is therefore chosen to sit well past the old ceiling: a regression to
  // the middleware — or losing that wrapper — turns this red rather than leaving
  // it quietly passing under a lower bar.
  //
  // GUARD G-15/b — guards the *second* half of that design: deciding whether a
  // return completes the invoice by reading back inside the transaction rather
  // than from the pre-transaction snapshot. Move that decision back outside and
  // this is the only test that fails — verified by reverting it.
  it("survives concurrent single-unit returns without over-returning", async () => {
    const { token } = await signIn(app, "ADMIN");
    const { batch, medicine } = await makeSellable({ quantity: 20 });
    const invoice = await sell(token, batch, medicine, 12);
    const lineId = lineOf(invoice).id;

    // Twelve requests, twelve units, all racing for the same line.
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        ret(token, invoice.id, [{ invoiceItemId: lineId, quantity: 1 }]),
      ),
    );

    expect(results.filter((r) => r.status === 201).length).toBe(12);

    const after = await prisma.invoice.findUnique({
      where: { id: invoice.id },
      include: { items: true },
    });
    expect(after.items[0].returnedQty).toBe(12);
    expect(after.status).toBe("CANCELLED");
    expect(await stockOf(batch.id)).toBe(20);
  });

  it("rejects a line that belongs to another invoice", async () => {
    const { token } = await signIn(app, "ADMIN");
    const a = await makeSellable({ quantity: 10 });
    const b = await makeSellable({ quantity: 10 });
    const one = await sell(token, a.batch, a.medicine, 2);
    const two = await sell(token, b.batch, b.medicine, 2);

    const res = await ret(token, one.id, [
      { invoiceItemId: two.items[0].id, quantity: 1 },
    ]);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not on invoice/);
  });

  it("rejects the same line listed twice instead of silently summing it", async () => {
    const { token } = await signIn(app, "ADMIN");
    const { batch, medicine } = await makeSellable({ quantity: 10 });
    const invoice = await sell(token, batch, medicine, 5);
    const lineId = lineOf(invoice).id;

    const res = await ret(token, invoice.id, [
      { invoiceItemId: lineId, quantity: 2 },
      { invoiceItemId: lineId, quantity: 2 },
    ]);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/twice/);
  });

  it("keeps the original in its own GST period and the credit note in this one", async () => {
    const { token } = await signIn(app, "ADMIN");
    const { batch, medicine } = await makeSellable({ quantity: 10 });
    const invoice = await sell(token, batch, medicine, 2);

    const res = await ret(token, invoice.id, [
      { invoiceItemId: lineOf(invoice).id, quantity: 1 },
    ]);

    // The rule partial returns must not disturb: removing a sale from the month
    // it was filed in would rewrite a period that may already have been filed.
    const originalAfter = await prisma.invoice.findUnique({ where: { id: invoice.id } });
    expect(originalAfter.date).toEqual(new Date(invoice.date));
    expect(Number(originalAfter.totalAmount)).toBe(Number(invoice.totalAmount));
    expect(res.body.data.reversesId).toBe(invoice.id);
  });
});
