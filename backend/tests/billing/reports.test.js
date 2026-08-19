import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import prisma from "../../src/config/db.js";
import { buildApp, signIn, makeSellable, makeUser } from "../helpers/factory.js";

let app;
beforeAll(() => {
  app = buildApp();
});

const get = (token, path) => request(app).get(path).set("Authorization", `Bearer ${token}`);

// Writes an invoice straight to the database so a test can place it on any date
// and in any payment state.
async function invoiceAt(date, { total = 100, cgst = 6, sgst = 6, status = "PAID", mode = "CASH" } = {}) {
  const user = await makeUser({ email: `writer-${Math.random()}@test.local` });
  return prisma.invoice.create({
    data: {
      invoiceNumber: `INV-${Math.random().toString(36).slice(2, 10)}`,
      userId: user.id,
      date,
      createdAt: date,
      subtotal: total - cgst - sgst,
      cgst,
      sgst,
      totalAmount: total,
      paymentMode: mode,
      paymentStatus: status,
    },
  });
}

describe("GET /api/billing/invoices/daily-summary", () => {
  it("totals the day and breaks it down by payment mode", async () => {
    const { token } = await signIn(app);
    const today = new Date();
    await invoiceAt(today, { total: 100, mode: "CASH" });
    await invoiceAt(today, { total: 250, mode: "UPI" });
    await invoiceAt(today, { total: 150, mode: "UPI" });

    const res = await get(token, "/api/billing/invoices/daily-summary");
    const s = res.body.data.summary;

    expect(s.totalInvoices).toBe(3);
    expect(s.totalSales).toBe(500);
    expect(s.totalGst).toBeCloseTo(s.totalCgst + s.totalSgst, 10);

    const upi = s.byPaymentMode.find((r) => r.paymentMode === "UPI");
    expect(upi._count.id).toBe(2);
    expect(upi._sum.totalAmount).toBe(400);
  });

  it("counts the whole day and nothing either side of it", async () => {
    const { token } = await signIn(app);
    const day = new Date("2026-07-15T00:00:00.000");
    const start = new Date("2026-07-15T00:00:00.000");
    const end = new Date("2026-07-15T23:59:59.000");
    const before = new Date("2026-07-14T23:59:59.000");
    const after = new Date("2026-07-16T00:00:01.000");

    await Promise.all([
      invoiceAt(start, { total: 10 }),
      invoiceAt(end, { total: 20 }),
      invoiceAt(before, { total: 999 }),
      invoiceAt(after, { total: 999 }),
    ]);

    const res = await get(token, `/api/billing/invoices/daily-summary?date=${day.toISOString().slice(0, 10)}`);

    expect(res.body.data.summary.totalInvoices).toBe(2);
    expect(res.body.data.summary.totalSales).toBe(30);
  });

  it("reports zeros for a day with no trade", async () => {
    const { token } = await signIn(app);
    const res = await get(token, "/api/billing/invoices/daily-summary?date=2020-01-01");

    expect(res.body.data.summary).toMatchObject({ totalInvoices: 0, totalSales: 0, totalGst: 0 });
  });

  it("is readable by a cashier", async () => {
    const { token } = await signIn(app, "CASHIER");
    expect((await get(token, "/api/billing/invoices/daily-summary")).status).toBe(200);
  });
});

describe("GET /api/billing/invoices/gst-report", () => {
  it("includes only paid invoices", async () => {
    const { token } = await signIn(app);
    const d = new Date("2026-05-10T10:00:00.000");
    await invoiceAt(d, { total: 100, status: "PAID" });
    await invoiceAt(d, { total: 500, status: "PENDING" });
    await invoiceAt(d, { total: 500, status: "PARTIAL" });

    const res = await get(token, "/api/billing/invoices/gst-report?month=5&year=2026");

    expect(res.body.data.invoices).toHaveLength(1);
    expect(res.body.data.totals.total).toBe(100);
  });

  it("covers the whole month and stops at its edges", async () => {
    const { token } = await signIn(app);
    await Promise.all([
      invoiceAt(new Date("2026-05-01T00:00:01.000"), { total: 10 }),
      invoiceAt(new Date("2026-05-31T23:59:00.000"), { total: 20 }),
      invoiceAt(new Date("2026-04-30T23:59:00.000"), { total: 999 }),
      invoiceAt(new Date("2026-06-01T00:00:01.000"), { total: 999 }),
    ]);

    const res = await get(token, "/api/billing/invoices/gst-report?month=5&year=2026");

    expect(res.body.data.invoices).toHaveLength(2);
    expect(res.body.data.totals.total).toBe(30);
  });

  it("totals reconcile with the invoices returned", async () => {
    const { token } = await signIn(app);
    const d = new Date("2026-05-10T10:00:00.000");
    await invoiceAt(d, { total: 112, cgst: 6, sgst: 6 });
    await invoiceAt(d, { total: 224, cgst: 12, sgst: 12 });

    const { totals, invoices } = (await get(token, "/api/billing/invoices/gst-report?month=5&year=2026")).body.data;

    expect(totals.total).toBeCloseTo(invoices.reduce((s, i) => s + i.totalAmount, 0), 10);
    expect(totals.cgst).toBeCloseTo(invoices.reduce((s, i) => s + i.cgst, 0), 10);
    expect(totals.taxable).toBeCloseTo(invoices.reduce((s, i) => s + i.subtotal, 0), 10);
  });

  it("is closed to cashiers", async () => {
    const { token } = await signIn(app, "CASHIER");
    expect((await get(token, "/api/billing/invoices/gst-report?month=5&year=2026")).status).toBe(403);
  });
});

describe("GET /api/billing/invoices", () => {
  it("filters by payment mode and status", async () => {
    const { token } = await signIn(app);
    const now = new Date();
    await invoiceAt(now, { mode: "CASH", status: "PAID" });
    await invoiceAt(now, { mode: "UPI", status: "PAID" });
    await invoiceAt(now, { mode: "UPI", status: "PENDING" });

    const upi = await get(token, "/api/billing/invoices?paymentMode=UPI");
    expect(upi.body.data).toHaveLength(2);

    const pending = await get(token, "/api/billing/invoices?paymentStatus=PENDING");
    expect(pending.body.data).toHaveLength(1);
  });

  it("paginates", async () => {
    const { token } = await signIn(app);
    const now = new Date();
    for (let i = 0; i < 5; i++) await invoiceAt(now);

    const res = await get(token, "/api/billing/invoices?limit=2&page=1");

    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination).toMatchObject({ total: 5, page: 1, limit: 2, pages: 3 });
  });

  it("returns a single invoice with its batch details for reprinting", async () => {
    const { token } = await signIn(app);
    const { medicine, batch } = await makeSellable();
    const created = await request(app)
      .post("/api/billing/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        items: [{
          batchId: batch.id, medicineId: medicine.id, medicineName: medicine.name,
          quantity: 1, unitPrice: 24.5, discount: 0, gstPercent: 12,
        }],
      });

    const res = await get(token, `/api/billing/invoices/${created.body.data.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data.items[0].batch).toMatchObject({ batchNumber: batch.batchNumber });
  });

  it("404s for an unknown invoice", async () => {
    const { token } = await signIn(app);
    expect((await get(token, "/api/billing/invoices/nope")).status).toBe(404);
  });
});
