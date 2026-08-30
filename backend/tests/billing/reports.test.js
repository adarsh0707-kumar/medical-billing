import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import prisma from "../../src/config/db.js";
import {
  buildApp,
  signIn,
  makeSellable,
  makeUser,
  line,
} from "../helpers/factory.js";

let app;
beforeAll(() => {
  app = buildApp();
});

const get = (token, path) =>
  request(app).get(path).set("Authorization", `Bearer ${token}`);

// The `?date=` a client would send for a given local day.
//
// NOT `toISOString().slice(0, 10)`. The fixtures below are local instants, and
// local midnight belongs to the *previous* UTC day everywhere east of Greenwich
// — so in IST that idiom asked for 2026-07-14 while the test read as though it
// asked for the 15th, and matched only the fixture planted as the out-of-window
// neighbour. It passed in CI's UTC and failed on every developer machine in the
// timezone this product is built for, which is the wrong way round for a bug to
// be visible. `getTrend` builds its keys from local components for the same
// reason; this mirrors it.
const localDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Writes an invoice straight to the database so a test can place it on any date
// and in any payment state.
async function invoiceAt(
  date,
  { total = 100, cgst = 6, sgst = 6, status = "PAID", mode = "CASH" } = {},
) {
  const user = await makeUser({ email: `writer-${Math.random()}@test.local` });
  return prisma.invoice.create({
    data: {
      shopId: user.shopId,
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

    const res = await get(
      token,
      `/api/billing/invoices/daily-summary?date=${localDay(day)}`,
    );

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

    const res = await get(
      token,
      "/api/billing/invoices/daily-summary?date=2026-07-15",
    );

    // docs/09 section 5.5 asks for the boundaries at exactly 00:00:00.000 and
    // 23:59:59.999. The test above brackets the day only to the nearest second,
    // which leaves 999ms unasserted at each edge — room enough for an endOfDay
    // built without milliseconds to drop the last sale of a trading day, and for
    // the first millisecond of the next day to be counted twice.
    expect(res.body.data.summary.totalInvoices).toBe(2);
    expect(res.body.data.summary.totalSales).toBe(30);
  });

  // A sale and its void on the same day. The money nets to zero either way; what
  // is asserted here is the counting rule in docs/03 section 8 — the sale still
  // counts in the period it was raised in, the reversal is reported separately,
  // and the two are never conflated into "2 invoices".
  it("counts a same-day void as one sale and one credit note, netting to zero", async () => {
    const { token } = await signIn(app, "ADMIN");
    const { medicine, batch } = await makeSellable({ quantity: 10 });

    const sale = await request(app)
      .post("/api/billing/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        items: [line(medicine, batch, { quantity: 2 })],
        paymentMode: "CASH",
      });
    expect(sale.status).toBe(201);

    const voided = await request(app)
      .post(`/api/billing/invoices/${sale.body.data.id}/void`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "counted the wrong pack" });
    expect(voided.status).toBe(201);

    const s = (await get(token, "/api/billing/invoices/daily-summary")).body
      .data.summary;

    expect(s.totalInvoices).toBe(1);
    expect(s.creditNotes).toBe(1);
    expect(s.totalSales).toBe(0);
    expect(s.totalGst).toBe(0);

    // The per-mode count must reconcile with the headline, or the dashboard
    // shows "1 invoice" above "2 bills" on the same screen.
    const cash = s.byPaymentMode.find((r) => r.paymentMode === "CASH");
    expect(cash._count.id).toBe(1);
    expect(cash._sum.totalAmount).toBe(0);
  });

  it("keeps counting a sale in its own day after a later void", async () => {
    const { token } = await signIn(app, "ADMIN");
    const { medicine, batch } = await makeSellable({ quantity: 10 });

    const sale = await request(app)
      .post("/api/billing/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        items: [line(medicine, batch, { quantity: 1 })],
        paymentMode: "CASH",
      });

    // Move the sale into the past, leaving the credit note in today — the shape
    // of a void raised days after the sale.
    const past = new Date("2026-06-10T11:00:00.000");
    await prisma.invoice.update({
      where: { id: sale.body.data.id },
      data: { date: past, createdAt: past },
    });

    await request(app)
      .post(`/api/billing/invoices/${sale.body.data.id}/void`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "returned a week later" });

    // The sale's own day is untouched by a void that happened later: it still
    // reports one sale at full value. Rewriting it would edit a period that may
    // already have been filed.
    const then = (
      await get(token, "/api/billing/invoices/daily-summary?date=2026-06-10")
    ).body.data.summary;
    expect(then.totalInvoices).toBe(1);
    expect(then.creditNotes).toBe(0);
    expect(then.totalSales).toBeGreaterThan(0);

    // Today carries the reversal, and no sale.
    const today = (await get(token, "/api/billing/invoices/daily-summary")).body
      .data.summary;
    expect(today.totalInvoices).toBe(0);
    expect(today.creditNotes).toBe(1);
    expect(today.totalSales).toBeLessThan(0);
  });

  it("reports zeros for a day with no trade", async () => {
    const { token } = await signIn(app);
    const res = await get(
      token,
      "/api/billing/invoices/daily-summary?date=2020-01-01",
    );

    expect(res.body.data.summary).toMatchObject({
      totalInvoices: 0,
      totalSales: 0,
      totalGst: 0,
    });
  });

  it("is readable by a cashier", async () => {
    const { token } = await signIn(app, "CASHIER");
    expect(
      (await get(token, "/api/billing/invoices/daily-summary")).status,
    ).toBe(200);
  });
});

describe("GET /api/billing/invoices/gst-report", () => {
  it("includes only paid invoices", async () => {
    const { token } = await signIn(app);
    const d = new Date("2026-05-10T10:00:00.000");
    await invoiceAt(d, { total: 100, status: "PAID" });
    await invoiceAt(d, { total: 500, status: "PENDING" });
    await invoiceAt(d, { total: 500, status: "PARTIAL" });

    const res = await get(
      token,
      "/api/billing/invoices/gst-report?month=5&year=2026",
    );

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

    const res = await get(
      token,
      "/api/billing/invoices/gst-report?month=5&year=2026",
    );

    expect(res.body.data.invoices).toHaveLength(2);
    expect(res.body.data.totals.total).toBe(30);
  });

  // Guards C-2. The test above brackets the month only to the nearest minute,
  // which left the last 999ms of it unasserted — and `endDate` was built without
  // a milliseconds argument, so it closed at 23:59:59.000. A sale in that gap
  // was in no GST return at all: too late for its own month, too early for the
  // next. The daily summary has the same guard at day scale; a tax period needs
  // it more, because the money that falls through is money nobody files.
  it("includes the last millisecond of the month", async () => {
    const { token } = await signIn(app);
    await Promise.all([
      invoiceAt(new Date("2026-05-01T00:00:00.000"), { total: 10 }),
      invoiceAt(new Date("2026-05-31T23:59:59.999"), { total: 20 }),
      invoiceAt(new Date("2026-06-01T00:00:00.000"), { total: 999 }),
    ]);

    const res = await get(
      token,
      "/api/billing/invoices/gst-report?month=5&year=2026",
    );

    expect(res.body.data.invoices).toHaveLength(2);
    expect(res.body.data.totals.total).toBe(30);
  });

  // The other half of the same property: consecutive months must partition the
  // timeline, so a sale belongs to exactly one of them. Asserting May alone
  // cannot catch a boundary that overlaps.
  it("files a midnight-boundary sale in exactly one month", async () => {
    const { token } = await signIn(app);
    const lastMoment = new Date("2026-05-31T23:59:59.999");
    await invoiceAt(lastMoment, { total: 112, cgst: 6, sgst: 6 });

    const may = (
      await get(token, "/api/billing/invoices/gst-report?month=5&year=2026")
    ).body.data;
    const june = (
      await get(token, "/api/billing/invoices/gst-report?month=6&year=2026")
    ).body.data;

    expect(may.invoices).toHaveLength(1);
    expect(june.invoices).toHaveLength(0);
  });

  it("totals reconcile with the invoices returned", async () => {
    const { token } = await signIn(app);
    const d = new Date("2026-05-10T10:00:00.000");
    await invoiceAt(d, { total: 112, cgst: 6, sgst: 6 });
    await invoiceAt(d, { total: 224, cgst: 12, sgst: 12 });

    const { totals, invoices } = (
      await get(token, "/api/billing/invoices/gst-report?month=5&year=2026")
    ).body.data;

    expect(totals.total).toBeCloseTo(
      invoices.reduce((s, i) => s + i.totalAmount, 0),
      10,
    );
    expect(totals.cgst).toBeCloseTo(
      invoices.reduce((s, i) => s + i.cgst, 0),
      10,
    );
    expect(totals.taxable).toBeCloseTo(
      invoices.reduce((s, i) => s + i.subtotal, 0),
      10,
    );
  });

  it("is closed to cashiers", async () => {
    const { token } = await signIn(app, "CASHIER");
    expect(
      (await get(token, "/api/billing/invoices/gst-report?month=5&year=2026"))
        .status,
    ).toBe(403);
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

    const pending = await get(
      token,
      "/api/billing/invoices?paymentStatus=PENDING",
    );
    expect(pending.body.data).toHaveLength(1);
  });

  it("paginates", async () => {
    const { token } = await signIn(app);
    const now = new Date();
    for (let i = 0; i < 5; i++) await invoiceAt(now);

    const res = await get(token, "/api/billing/invoices?limit=2&page=1");

    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination).toMatchObject({
      total: 5,
      page: 1,
      limit: 2,
      pages: 3,
    });
  });

  it("returns a single invoice with its batch details for reprinting", async () => {
    const { token } = await signIn(app);
    const { medicine, batch } = await makeSellable();
    const created = await request(app)
      .post("/api/billing/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        items: [
          {
            batchId: batch.id,
            medicineId: medicine.id,
            medicineName: medicine.name,
            quantity: 1,
            unitPrice: 24.5,
            discount: 0,
            gstPercent: 12,
          },
        ],
      });

    const res = await get(
      token,
      `/api/billing/invoices/${created.body.data.id}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.data.items[0].batch).toMatchObject({
      batchNumber: batch.batchNumber,
    });
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

  // Same counting rule as the daily summary (docs/03 section 8): the money nets,
  // the count is sales only. Without the split a voided day charts as "1
  // invoice, zero rupees", which reads as a bug in the chart rather than a void.
  it("nets the money but counts only the sale when a day contains a void", async () => {
    const { token } = await signIn(app, "ADMIN");
    const { medicine, batch } = await makeSellable({ quantity: 10 });

    const sale = await request(app)
      .post("/api/billing/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        items: [line(medicine, batch, { quantity: 2 })],
        paymentMode: "CASH",
      });

    await request(app)
      .post(`/api/billing/invoices/${sale.body.data.id}/void`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "wrong customer" });

    const today = (
      await get(token, "/api/billing/invoices/trend")
    ).body.data.at(-1);

    expect(today.invoices).toBe(1);
    expect(today.sales).toBe(0);
  });

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
    expect(
      (await get(token, "/api/billing/invoices/trend?days=1")).body.data,
    ).toHaveLength(1);
    expect(
      (await get(token, "/api/billing/invoices/trend?days=30")).body.data,
    ).toHaveLength(30);
  });

  it("rejects a days value outside the window", async () => {
    const { token } = await signIn(app, "ADMIN");
    expect(
      (await get(token, "/api/billing/invoices/trend?days=999")).status,
    ).toBe(400);
    expect(
      (await get(token, "/api/billing/invoices/trend?days=abc")).status,
    ).toBe(400);
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

// ─── Period reports (FR-RPT-10, FR-RPT-11) ─────────────
//
// `invoiceAt` writes each fixture with its own user, and `makeUser` defaults to
// the shared test shop — so every invoice below lands in the shop `signIn`
// authenticates into, and the reports see them.

describe("GET /api/reports/monthly", () => {
  it("summarises the month and breaks it down by day", async () => {
    const { token } = await signIn(app);
    await invoiceAt(new Date(2026, 2, 3, 10, 0), { total: 100 });
    await invoiceAt(new Date(2026, 2, 3, 15, 0), { total: 250 });
    await invoiceAt(new Date(2026, 2, 20, 11, 0), { total: 400 });
    // Neighbouring months must not leak in.
    await invoiceAt(new Date(2026, 1, 28, 12, 0), { total: 999 });
    await invoiceAt(new Date(2026, 3, 1, 12, 0), { total: 888 });

    const res = await get(token, "/api/reports/monthly?month=3&year=2026");

    expect(res.status).toBe(200);
    expect(res.body.data.label).toBe("March 2026");
    expect(Number(res.body.data.summary.totalSales)).toBe(750);
    expect(res.body.data.summary.totalInvoices).toBe(3);

    // Zero-filled: March has 31 days and every one of them appears, or a quiet
    // day would shift the rest of the chart left and read as a trend.
    const { days } = res.body.data;
    expect(days).toHaveLength(31);
    expect(days.map((d) => d.day)).toEqual(
      Array.from({ length: 31 }, (_, i) => i + 1),
    );
    expect(days.find((d) => d.day === 3)).toMatchObject({
      sales: 350,
      invoices: 2,
    });
    expect(days.find((d) => d.day === 20)).toMatchObject({
      sales: 400,
      invoices: 1,
    });
    expect(days.find((d) => d.day === 4).sales).toBe(0);
  });

  // The guard on the decision in `bucketedSales`: the breakdown is computed on
  // the same basis as the headline, so the bars sum to the number printed above
  // them. Reusing `dailyTrend` here would have made this fail by exactly the
  // unpaid sales, each figure correct by its own definition.
  it("breaks down to exactly the headline, credit sales included", async () => {
    const { token } = await signIn(app);
    await invoiceAt(new Date(2026, 4, 2, 10, 0), { total: 100 });
    await invoiceAt(new Date(2026, 4, 9, 10, 0), {
      total: 500,
      status: "PENDING",
      mode: "CREDIT",
    });
    await invoiceAt(new Date(2026, 4, 9, 12, 0), { total: 75, status: "PARTIAL" });

    const res = await get(token, "/api/reports/monthly?month=5&year=2026");
    const { days, summary } = res.body.data;

    const summed = days.reduce((n, d) => n + d.sales, 0);
    expect(summed).toBeCloseTo(Number(summary.totalSales), 2);
    expect(days.reduce((n, d) => n + d.invoices, 0)).toBe(summary.totalInvoices);
    // And the unpaid ones are genuinely in there, not netted to a coincidence.
    expect(summed).toBe(675);
  });

  // The register is `GET /api/billing/invoices` filtered by these bounds, so
  // they have to be exact: an end of 23:59:59.999 on the last of the month, not
  // midnight, or the final day's sales fall outside the list the same screen
  // says the month contains.
  it("publishes bounds the invoice list can be filtered by", async () => {
    const { token } = await signIn(app);
    const first = await invoiceAt(new Date(2026, 3, 1, 0, 5), { total: 10 });
    const last = await invoiceAt(new Date(2026, 3, 30, 23, 30), { total: 20 });
    await invoiceAt(new Date(2026, 4, 1, 0, 5), { total: 99 });

    const report = await get(token, "/api/reports/monthly?month=4&year=2026");
    const { start, end } = report.body.data;

    const register = await get(
      token,
      `/api/billing/invoices?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}&limit=100`,
    );

    expect(register.status).toBe(200);
    const numbers = register.body.data.map((i) => i.invoiceNumber);
    expect(numbers).toContain(first.invoiceNumber);
    expect(numbers).toContain(last.invoiceNumber);
    expect(register.body.pagination.total).toBe(2);
    // And the register agrees with the headline it sits under.
    expect(register.body.pagination.total).toBe(
      report.body.data.summary.totalInvoices,
    );
  });

  it("rejects a month outside 1–12, and a missing one", async () => {
    const { token } = await signIn(app);
    expect((await get(token, "/api/reports/monthly?month=13&year=2026")).status).toBe(400);
    expect((await get(token, "/api/reports/monthly?year=2026")).status).toBe(400);
    expect((await get(token, "/api/reports/monthly?month=3&year=99")).status).toBe(400);
  });

  it("exports the breakdown, one row per day", async () => {
    const { token } = await signIn(app);
    await invoiceAt(new Date(2026, 5, 4, 10, 0), { total: 120 });

    const res = await get(token, "/api/reports/monthly/export?month=6&year=2026");

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain(
      "monthly-report-2026-06.csv",
    );
    const rows = res.text.trim().split("\r\n");
    // Header plus June's 30 days.
    expect(rows).toHaveLength(31);
    expect(rows[0]).toContain("Period");
    expect(rows.find((r) => r.startsWith("2026-06-04"))).toContain("120.00");
  });
});

describe("GET /api/reports/yearly", () => {
  it("summarises the year and breaks it down by month", async () => {
    const { token } = await signIn(app);
    await invoiceAt(new Date(2026, 0, 15, 10, 0), { total: 100 });
    await invoiceAt(new Date(2026, 6, 4, 10, 0), { total: 300 });
    await invoiceAt(new Date(2026, 6, 5, 10, 0), { total: 200 });
    await invoiceAt(new Date(2025, 11, 31, 23, 0), { total: 777 });

    const res = await get(token, "/api/reports/yearly?year=2026");

    expect(res.status).toBe(200);
    expect(Number(res.body.data.summary.totalSales)).toBe(600);

    const { months } = res.body.data;
    expect(months).toHaveLength(12);
    expect(months.map((m) => m.label)).toEqual([
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]);
    expect(months[0]).toMatchObject({ sales: 100, invoices: 1 });
    expect(months[6]).toMatchObject({ sales: 500, invoices: 2 });
    expect(months[1].sales).toBe(0);
    // December 2025 stayed in 2025.
    expect(months[11].sales).toBe(0);
  });

  it("breaks down to exactly the headline", async () => {
    const { token } = await signIn(app);
    await invoiceAt(new Date(2027, 2, 1, 10, 0), { total: 100 });
    await invoiceAt(new Date(2027, 8, 1, 10, 0), { total: 250, status: "PENDING" });

    const res = await get(token, "/api/reports/yearly?year=2027");
    const { months, summary } = res.body.data;

    expect(months.reduce((n, m) => n + m.sales, 0)).toBeCloseTo(
      Number(summary.totalSales),
      2,
    );
    expect(months.reduce((n, m) => n + m.invoices, 0)).toBe(
      summary.totalInvoices,
    );
  });

  it("publishes bounds spanning the whole year", async () => {
    const { token } = await signIn(app);
    const jan = await invoiceAt(new Date(2028, 0, 1, 0, 1), { total: 10 });
    const dec = await invoiceAt(new Date(2028, 11, 31, 23, 45), { total: 20 });
    await invoiceAt(new Date(2029, 0, 1, 0, 1), { total: 99 });

    const report = await get(token, "/api/reports/yearly?year=2028");
    const { start, end } = report.body.data;
    const register = await get(
      token,
      `/api/billing/invoices?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}&limit=100`,
    );

    const numbers = register.body.data.map((i) => i.invoiceNumber);
    expect(numbers).toEqual(
      expect.arrayContaining([jan.invoiceNumber, dec.invoiceNumber]),
    );
    expect(register.body.pagination.total).toBe(2);
  });

  it("rejects a missing or implausible year", async () => {
    const { token } = await signIn(app);
    expect((await get(token, "/api/reports/yearly")).status).toBe(400);
    expect((await get(token, "/api/reports/yearly?year=20026")).status).toBe(400);
  });

  it("exports twelve rows and a header", async () => {
    const { token } = await signIn(app);
    await invoiceAt(new Date(2026, 9, 8, 10, 0), { total: 60 });

    const res = await get(token, "/api/reports/yearly/export?year=2026");

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain(
      "yearly-report-2026.csv",
    );
    const rows = res.text.trim().split("\r\n");
    expect(rows).toHaveLength(13);
    expect(rows.find((r) => r.startsWith("Oct"))).toContain("60.00");
  });

  it("shows a cashier the trading record, unlike the GST return", async () => {
    const { token } = await signIn(app, "CASHIER");
    expect((await get(token, "/api/reports/yearly?year=2026")).status).toBe(200);
    expect((await get(token, "/api/reports/monthly?month=1&year=2026")).status).toBe(200);
    // Contrast: the filing position stays ADMIN/PHARMACIST only.
    expect((await get(token, "/api/reports/gst?month=1&year=2026")).status).toBe(403);
  });
});
