import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import prisma from "../../src/config/db.js";
import { buildApp, signIn, makeSellable, line } from "../helpers/factory.js";

let app;
beforeAll(() => {
  app = buildApp();
});

const post = (token, body) =>
  request(app).post("/api/billing/invoices").set("Authorization", `Bearer ${token}`).send(body);

// The acceptance set from docs/09-testing-strategy.md §4. These numbers are the
// contract: what the customer is charged and what is declared as tax.
describe("GST engine fixtures", () => {
  it("F1 — single line, no discount", async () => {
    const { token } = await signIn(app);
    const { medicine, batch } = await makeSellable({ gstPercent: 12, sellingPrice: 24.5 });

    const res = await post(token, { items: [line(medicine, batch, { quantity: 10 })] });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      subtotal: 245,
      cgst: 14.7,
      sgst: 14.7,
      totalAmount: 274.4,
    });
    expect(res.body.data.items[0].totalPrice).toBe(274.4);
  });

  it("F2 — 10% line discount", async () => {
    const { token } = await signIn(app);
    const { medicine, batch } = await makeSellable({ gstPercent: 5, sellingPrice: 100 });

    const res = await post(token, {
      items: [line(medicine, batch, { quantity: 3, discount: 10 })],
    });

    expect(res.body.data).toMatchObject({ subtotal: 270, cgst: 6.75, sgst: 6.75, totalAmount: 283.5 });
  });

  it("F3 — zero-rated medicine attracts no tax", async () => {
    const { token } = await signIn(app);
    const { medicine, batch } = await makeSellable({ gstPercent: 0, sellingPrice: 250 });

    const res = await post(token, { items: [line(medicine, batch, { quantity: 2 })] });

    expect(res.body.data).toMatchObject({ subtotal: 500, cgst: 0, sgst: 0, totalAmount: 500 });
  });

  it("F4 — multiple lines with a bill-level discount", async () => {
    const { token } = await signIn(app);
    const a = await makeSellable({ gstPercent: 12, sellingPrice: 24.5 });
    const b = await makeSellable({ gstPercent: 5, sellingPrice: 100 });

    const res = await post(token, {
      items: [
        line(a.medicine, a.batch, { quantity: 10 }),
        line(b.medicine, b.batch, { quantity: 3, discount: 10 }),
      ],
      discountAmt: 50,
    });

    expect(res.body.data).toMatchObject({
      subtotal: 515,
      cgst: 21.45,
      sgst: 21.45,
      totalAmount: 507.9,
    });
  });

  it("F5 — a fully discounted line costs nothing", async () => {
    const { token } = await signIn(app);
    const { medicine, batch } = await makeSellable({ gstPercent: 18, sellingPrice: 80 });

    const res = await post(token, { items: [line(medicine, batch, { discount: 100 })] });

    expect(res.body.data).toMatchObject({ subtotal: 0, cgst: 0, sgst: 0, totalAmount: 0 });
  });

  it("F6 — rounding: 33.33 x 3 at 18%", async () => {
    const { token } = await signIn(app);
    const { medicine, batch } = await makeSellable({ gstPercent: 18, sellingPrice: 33.33 });

    const res = await post(token, { items: [line(medicine, batch, { quantity: 3 })] });

    expect(res.body.data).toMatchObject({ subtotal: 99.99, cgst: 9, sgst: 9, totalAmount: 117.99 });
  });

  // Documents current behaviour rather than endorsing it — see open question Q1
  // in docs/01-product-requirements.md. If the rule changes, this test should
  // change with it deliberately.
  it("F7 — a bill discount larger than the bill currently yields a negative total", async () => {
    const { token } = await signIn(app);
    const { medicine, batch } = await makeSellable({ gstPercent: 0, sellingPrice: 250 });

    const res = await post(token, {
      items: [line(medicine, batch, { quantity: 2 })],
      discountAmt: 600,
    });

    expect(res.status).toBe(201);
    expect(res.body.data.totalAmount).toBe(-100);
  });
});

// These held only by luck under floating point. They are the reason money is
// stored and computed as Decimal.
describe("invoice arithmetic invariants", () => {
  const cases = [
    ["12% single line", { gstPercent: 12, sellingPrice: 24.5, quantity: 10, discount: 0 }],
    ["5% with discount", { gstPercent: 5, sellingPrice: 100, quantity: 3, discount: 10 }],
    ["18% odd price", { gstPercent: 18, sellingPrice: 33.33, quantity: 3, discount: 0 }],
    ["18% odd price and discount", { gstPercent: 18, sellingPrice: 10.1, quantity: 7, discount: 3.5 }],
  ];

  it.each(cases)("%s reconciles exactly", async (_label, spec) => {
    const { token } = await signIn(app);
    const { medicine, batch } = await makeSellable(spec);

    const res = await post(token, {
      items: [line(medicine, batch, { quantity: spec.quantity, discount: spec.discount })],
      discountAmt: 5,
    });
    const inv = res.body.data;

    expect(inv.cgst).toBe(inv.sgst);
    expect(inv.subtotal + inv.cgst + inv.sgst - inv.discountAmt).toBeCloseTo(inv.totalAmount, 10);
    const lineSum = inv.items.reduce((s, i) => s + i.totalPrice, 0);
    expect(lineSum).toBeCloseTo(inv.subtotal + inv.cgst + inv.sgst, 10);
  });

  it("serialises money as JSON numbers, not Decimal strings", async () => {
    const { token } = await signIn(app);
    const { medicine, batch } = await makeSellable();

    const inv = (await post(token, { items: [line(medicine, batch)] })).body.data;

    for (const key of ["subtotal", "cgst", "sgst", "totalAmount", "discountAmt"]) {
      expect(typeof inv[key]).toBe("number");
    }
    expect(typeof inv.items[0].unitPrice).toBe("number");
  });
});

describe("invoice creation", () => {
  it("records the operator, the customer and a snapshot of the medicine name", async () => {
    const { token, user } = await signIn(app, "CASHIER");
    const { medicine, batch } = await makeSellable();
    const customer = await prisma.customer.create({ data: { name: "Ramesh", phone: "9876543210" } });

    const res = await post(token, { items: [line(medicine, batch)], customerId: customer.id });
    const inv = res.body.data;

    expect(inv.userId).toBe(user.id);
    expect(inv.customerId).toBe(customer.id);
    expect(inv.items[0].medicineName).toBe(medicine.name);

    // Renaming the medicine must not rewrite history.
    await prisma.medicine.update({ where: { id: medicine.id }, data: { name: "Renamed" } });
    const again = await request(app)
      .get(`/api/billing/invoices/${inv.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(again.body.data.items[0].medicineName).toBe(medicine.name);
  });

  it("bills a walk-in with no customer", async () => {
    const { token } = await signIn(app);
    const { medicine, batch } = await makeSellable();

    const res = await post(token, { items: [line(medicine, batch)] });

    expect(res.status).toBe(201);
    expect(res.body.data.customerId).toBeNull();
  });

  it("defaults payment mode and status", async () => {
    const { token } = await signIn(app);
    const { medicine, batch } = await makeSellable();

    const inv = (await post(token, { items: [line(medicine, batch)] })).body.data;

    expect(inv.paymentMode).toBe("CASH");
    expect(inv.paymentStatus).toBe("PAID");
  });

  it("numbers invoices INVyymmdd-nnnn, sequentially within the day", async () => {
    const { token } = await signIn(app);
    const { medicine, batch } = await makeSellable();

    const first = (await post(token, { items: [line(medicine, batch)] })).body.data;
    const second = (await post(token, { items: [line(medicine, batch)] })).body.data;

    expect(first.invoiceNumber).toMatch(/^INV\d{6}-\d{4}$/);
    expect(second.invoiceNumber).toMatch(/^INV\d{6}-\d{4}$/);
    expect(Number(second.invoiceNumber.slice(-4))).toBe(Number(first.invoiceNumber.slice(-4)) + 1);
  });

  it("deducts stock from the batch", async () => {
    const { token } = await signIn(app);
    const { medicine, batch } = await makeSellable({ quantity: 100 });

    await post(token, { items: [line(medicine, batch, { quantity: 7 })] });

    const after = await prisma.batch.findUnique({ where: { id: batch.id } });
    expect(after.quantity).toBe(93);
  });
});

describe("invoice rejections", () => {
  it("refuses an empty cart", async () => {
    const { token } = await signIn(app);
    const res = await post(token, { items: [] });

    expect(res.status).toBe(400);
    expect(res.body.errors[0].message).toMatch(/At least one item/);
  });

  it("refuses an unknown batch", async () => {
    const { token } = await signIn(app);
    const { medicine, batch } = await makeSellable();

    const res = await post(token, {
      items: [line(medicine, batch, { batchId: "does-not-exist" })],
    });

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/Batch not found/);
  });

  it("refuses to sell more than the batch holds, naming what is available", async () => {
    const { token } = await signIn(app);
    const { medicine, batch } = await makeSellable({ quantity: 5 });

    const res = await post(token, { items: [line(medicine, batch, { quantity: 6 })] });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe(`Insufficient stock for ${medicine.name}. Available: 5`);
    expect(await prisma.invoice.count()).toBe(0);
  });

  it.each([
    ["zero quantity", { quantity: 0 }],
    ["negative quantity", { quantity: -1 }],
    ["fractional quantity", { quantity: 1.5 }],
    ["discount above 100", { discount: 101 }],
    ["negative discount", { discount: -1 }],
    ["zero unit price", { unitPrice: 0 }],
  ])("refuses %s", async (_label, overrides) => {
    const { token } = await signIn(app);
    const { medicine, batch } = await makeSellable();

    const res = await post(token, { items: [line(medicine, batch, overrides)] });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Validation failed");
  });

  it("refuses an unknown payment mode", async () => {
    const { token } = await signIn(app);
    const { medicine, batch } = await makeSellable();

    const res = await post(token, { items: [line(medicine, batch)], paymentMode: "BITCOIN" });
    expect(res.status).toBe(400);
  });
});

// The single most important property of this endpoint: an invoice and its stock
// movements are all-or-nothing.
describe("atomicity", () => {
  it("writes nothing when a later line is short of stock", async () => {
    const { token } = await signIn(app);
    const ok = await makeSellable({ quantity: 100 });
    const short = await makeSellable({ quantity: 1 });

    const res = await post(token, {
      items: [
        line(ok.medicine, ok.batch, { quantity: 5 }),
        line(short.medicine, short.batch, { quantity: 50 }),
      ],
    });

    expect(res.status).toBe(400);
    expect(await prisma.invoice.count()).toBe(0);
    expect(await prisma.invoiceItem.count()).toBe(0);
    expect((await prisma.batch.findUnique({ where: { id: ok.batch.id } })).quantity).toBe(100);
    expect((await prisma.batch.findUnique({ where: { id: short.batch.id } })).quantity).toBe(1);
  });
});
