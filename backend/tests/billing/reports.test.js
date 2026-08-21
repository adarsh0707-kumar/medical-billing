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

  it("includes the first and last millisecond of the day, and neither neighbour", async () => {
    const { token } = await signIn(app);

    await Promise.all([
      invoiceAt(new Date("2026-07-15T00:00:00.000"), { total: 10 }),
      invoiceAt(new Date("2026-07-15T23:59:59.999"), { total: 20 }),
      invoiceAt(new Date("2026-07-14T23:59:59.999"), { total: 999 }),
      invoiceAt(new Date("2026-07-16T00:00:00.000"), { total: 999 }),
    ]);

    const res = await get(token, "/api/billing/invoices/daily-summary?date=2026-07-15");

    // docs/09 section 5.5 asks for the boundaries at exactly 00:00:00.000 and
    // 23:59:59.999. The test above brackets the day only to the nearest second,
    // which leaves 999ms unasserted at each edge — room enough for an endOfDay
    // built without milliseconds to drop the last sale of a trading day, and for
    // the first millisecond of the next day to be counted twice.
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

// ─── Sales trend ───────────────────────────────────────
// Added with the endpoint that replaced seven daily-summary calls (G-08). The
// coverage gate caught that the endpoint had shipped without any test at all.
describe("GET /api/billing/invoices/trend", () => {
  // Takes a token rather than signing in: the factory gives each role one fixed
  // email, so calling signIn twice in a test collides on the unique constraint.
  const seedInvoiceOn = async (token, daysAgo, total) => {
    const { medicine, batch } = await makeSellable({ quantity: 100 });
    const res = await request(app)
      .post("/api/billing/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        items: [
          {
            batchId: batch.id,
            medicineId: medicine.id,
            medicineName: medicine.name,
            quantity: 1,
            unitPrice: total,
            discount: 0,
            gstPercent: 0,
          },
        ],
        discountAmt: 0,
        paymentMode: "CASH",
        paymentStatus: "PAID",
      });
    expect(res.status).toBe(201);

    const when = new Date();
    when.setDate(when.getDate() - daysAgo);
    when.setHours(12, 0, 0, 0);
    await prisma.invoice.update({
      where: { id: res.body.data.id },
      data: { date: when },
    });
    return res.body.data;
  };

  it("returns one entry per day, oldest first, defaulting to 7", async () => {
    const { token } = await signIn(app, "ADMIN");
    const res = await get(token, "/api/billing/invoices/trend");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(7);
    const dates = res.body.data.map((d) => d.date);
    expect([...dates].sort()).toEqual(dates); // already ascending
  });

  it("reports zeros for days with no sales rather than omitting them", async () => {
    // A missing day would silently shift every point on the chart left.
    const { token } = await signIn(app, "ADMIN");
    const res = await get(token, "/api/billing/invoices/trend?days=5");

    expect(res.body.data).toHaveLength(5);
    for (const day of res.body.data) {
      expect(day).toMatchObject({ sales: 0, invoices: 0 });
      expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("totals each day's sales and counts", async () => {
    const { token } = await signIn(app, "ADMIN");
    await seedInvoiceOn(token, 2, 100);
    await seedInvoiceOn(token, 2, 50);
    await seedInvoiceOn(token, 0, 30);

    const res = await get(token, "/api/billing/invoices/trend?days=7");

    const byDate = Object.fromEntries(res.body.data.map((d) => [d.date, d]));
    const key = (daysAgo) => {
      const d = new Date();
      d.setDate(d.getDate() - daysAgo);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };

    expect(byDate[key(2)]).toMatchObject({ sales: 150, invoices: 2 });
    expect(byDate[key(0)]).toMatchObject({ sales: 30, invoices: 1 });
  });

  it("honours the days parameter", async () => {
    const { token } = await signIn(app, "ADMIN");
    expect((await get(token, "/api/billing/invoices/trend?days=1")).body.data).toHaveLength(1);
    expect((await get(token, "/api/billing/invoices/trend?days=30")).body.data).toHaveLength(30);
  });

  it("rejects a days value outside the window", async () => {
    const { token } = await signIn(app, "ADMIN");
    expect((await get(token, "/api/billing/invoices/trend?days=999")).status).toBe(400);
    expect((await get(token, "/api/billing/invoices/trend?days=abc")).status).toBe(400);
  });

  it("is not shadowed by /invoices/:id", async () => {
    // "trend" would be read as an invoice id if the routes were declared the
    // other way round, and the failure would be a 404 rather than anything loud.
    const { token } = await signIn(app, "ADMIN");
    expect((await get(token, "/api/billing/invoices/trend")).status).toBe(200);
  });

  it("counts only PAID invoices", async () => {
    const { token } = await signIn(app, "ADMIN");
    const inv = await seedInvoiceOn(token, 1, 200);
    await prisma.invoice.update({
      where: { id: inv.id },
      data: { paymentStatus: "PENDING" },
    });

    const res = await get(token, "/api/billing/invoices/trend?days=7");
    const total = res.body.data.reduce((s, d) => s + d.sales, 0);
    expect(total).toBe(0);
  });
});
