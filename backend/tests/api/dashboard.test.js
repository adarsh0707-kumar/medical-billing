import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import prisma from "../../src/config/db.js";
import {
  buildApp,
  signIn,
  makeUser,
  makeMedicine,
  makeBatch,
  makeSellable,
  line,
  localMidnight,
} from "../helpers/factory.js";

/**
 * `GET /api/dashboard/stats` — the single request that replaced thirteen.
 *
 * This controller sat at 21.73% statements, the lowest in the codebase, while
 * serving every panel on the screen the owner actually looks at. It aggregates
 * money, folds a grouped query back into the shape the client reads, and holds
 * a second copy of the trend SQL that has to agree with the billing
 * controller's. None of that was asserted anywhere.
 *
 * What is tested here is the arithmetic and the boundaries, not the rendering:
 * counting rules under a void, the difference between a panel's `count` and its
 * `items`, the expiry window's edges, and the trend's zero-filling.
 */

let app;
beforeAll(() => {
  app = buildApp();
});

const stats = (token) =>
  request(app)
    .get("/api/dashboard/stats")
    .set("Authorization", `Bearer ${token}`);

/** A date `n` days from now, at noon — clear of either midnight boundary. */
const daysFromNow = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(12, 0, 0, 0);
  return d;
};

/** Midnight today, the way batch.controller.create stores an expiry date. */
// Local midnight, matching the boundary getStats draws. Was
// `new Date(new Date().toISOString().slice(0, 10))` — UTC midnight of the UTC
// date, which is a different instant anywhere the offset is not zero.
const midnightToday = () => localMidnight();

/** An invoice written straight to the database, on any date and in any state. */
async function invoiceAt(
  date,
  {
    total = 100,
    cgst = 6,
    sgst = 6,
    status = "PAID",
    mode = "CASH",
    type = "SALE",
  } = {},
) {
  const user = await makeUser({ email: `dash-${Math.random()}@test.local` });
  return prisma.invoice.create({
    data: {
      shopId: user.shopId,
      invoiceNumber: `INV-${Math.random().toString(36).slice(2, 10)}`,
      userId: user.id,
      date,
      createdAt: date,
      type,
      subtotal: total - cgst - sgst,
      cgst,
      sgst,
      totalAmount: total,
      paymentMode: mode,
      paymentStatus: status,
    },
  });
}

describe("GET /api/dashboard/stats — access", () => {
  it("is refused without a token", async () => {
    expect((await request(app).get("/api/dashboard/stats")).status).toBe(401);
  });

  // Deliberately open to every role, matching the panels it replaced. Note this
  // means a cashier sees whole-day store revenue, which was already true of the
  // daily summary and is an open question in docs/07 section 3 — asserted here
  // so that changing it is a decision rather than an accident.
  it.each(["ADMIN", "PHARMACIST", "CASHIER"])("is open to %s", async (role) => {
    const { token } = await signIn(app, role);
    expect((await stats(token)).status).toBe(200);
  });

  it("answers with every panel the dashboard renders", async () => {
    const { token } = await signIn(app);
    const { body } = await stats(token);

    expect(body.success).toBe(true);
    expect(Object.keys(body.data).sort()).toEqual([
      "expiring",
      "lowStock",
      "recentInvoices",
      "summary",
      "totals",
      "trend",
    ]);
  });

  it("is empty but well-formed on a database with nothing in it", async () => {
    const { token } = await signIn(app);
    const { body } = await stats(token);

    // A fresh install must render, not divide by zero or read a null.
    expect(body.data.summary).toMatchObject({
      totalSales: 0,
      totalInvoices: 0,
      creditNotes: 0,
      totalCgst: 0,
      totalSgst: 0,
      totalGst: 0,
      byPaymentMode: [],
    });
    expect(body.data.recentInvoices).toEqual([]);
    expect(body.data.expiring).toEqual({ count: 0, items: [] });
    expect(body.data.lowStock).toEqual({ count: 0, items: [] });
    expect(body.data.totals).toEqual({ medicines: 0, customers: 0 });
    expect(body.data.trend).toHaveLength(7);
    expect(
      body.data.trend.every((d) => d.sales === 0 && d.invoices === 0),
    ).toBe(true);
  });
});

describe("GET /api/dashboard/stats — today's money", () => {
  it("totals today and ignores yesterday", async () => {
    const { token } = await signIn(app);
    await invoiceAt(new Date(), { total: 100 });
    await invoiceAt(new Date(), { total: 250 });
    await invoiceAt(daysFromNow(-1), { total: 999 });

    const s = (await stats(token)).body.data.summary;

    expect(s.totalSales).toBe(350);
    expect(s.totalInvoices).toBe(2);
  });

  it("keeps GST as the sum of its two halves", async () => {
    const { token } = await signIn(app);
    await invoiceAt(new Date(), { total: 112, cgst: 6, sgst: 6 });
    await invoiceAt(new Date(), { total: 224, cgst: 12, sgst: 12 });

    const s = (await stats(token)).body.data.summary;

    expect(s.totalCgst).toBe(18);
    expect(s.totalSgst).toBe(18);
    // BR-03: the two halves are equal by construction, so a dashboard showing
    // them apart must still add up.
    expect(s.totalCgst).toBe(s.totalSgst);

    // This test was named for exactly this property and asserted everything
    // except it. `totalGst` was absent from the response altogether, and the
    // panel's `summary?.totalGst || 0` printed a confident ₹0 under a correct
    // CGST and SGST of ₹18 each.
    expect(s.totalGst).toBe(36);
    expect(s.totalGst).toBe(s.totalCgst + s.totalSgst);
  });

  it("folds the grouped query into one row per payment mode", async () => {
    const { token } = await signIn(app);
    await invoiceAt(new Date(), { total: 100, mode: "CASH" });
    await invoiceAt(new Date(), { total: 250, mode: "UPI" });
    await invoiceAt(new Date(), { total: 150, mode: "UPI" });

    const modes = (await stats(token)).body.data.summary.byPaymentMode;

    expect(modes).toHaveLength(2);
    const upi = modes.find((m) => m.paymentMode === "UPI");
    expect(upi._sum.totalAmount).toBe(400);
    // `_count` is an object, not a bare number: the panel reads `pm._count.id`,
    // and a number rendered "undefined bills" on any day with trade.
    expect(upi._count).toEqual({ id: 2 });
  });

  // The counting rule from docs/03 section 8, which the daily summary asserts
  // too. A sale voided today is still a sale raised today; the money is net of
  // the reversal, and the reversal is reported separately rather than being
  // subtracted from the count.
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

    const s = (await stats(token)).body.data.summary;

    expect(s.totalInvoices).toBe(1);
    expect(s.creditNotes).toBe(1);
    expect(s.totalSales).toBe(0);

    // The per-mode count must reconcile with the headline, or the panel shows
    // "1 invoice" above "2 bills" on the same screen.
    const cash = s.byPaymentMode.find((m) => m.paymentMode === "CASH");
    expect(cash._count.id).toBe(1);
    expect(cash._sum.totalAmount).toBe(0);
  });

  it("includes unpaid invoices in the day's figures", async () => {
    const { token } = await signIn(app);
    await invoiceAt(new Date(), { total: 100, status: "PAID" });
    await invoiceAt(new Date(), { total: 50, status: "PENDING" });

    // Unlike the trend below, the summary does not filter on payment status:
    // a credit sale is still a sale raised today.
    const s = (await stats(token)).body.data.summary;
    expect(s.totalInvoices).toBe(2);
    expect(s.totalSales).toBe(150);
  });
});

describe("GET /api/dashboard/stats — recent invoices", () => {
  it("returns the eight most recent, newest first", async () => {
    const { token } = await signIn(app);
    for (let i = 0; i < 10; i++) {
      await invoiceAt(daysFromNow(-i), { total: 100 + i });
    }

    const recent = (await stats(token)).body.data.recentInvoices;

    expect(recent).toHaveLength(8);
    const dates = recent.map((r) => new Date(r.date).getTime());
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
    // Newest first means the oldest two of the ten are absent.
    expect(recent[0].totalAmount).toBe(100);
  });

  it("never carries a customer's contact details", async () => {
    const { token } = await signIn(app);
    const user = await makeUser({ email: "recent@test.local" });
    const customer = await prisma.customer.create({
      data: {
        shopId: user.shopId,
        name: "Asha",
        phone: "9990001111",
        address: "12 Nehru Road",
        age: 41,
      },
    });
    await prisma.invoice.create({
      data: {
        shopId: user.shopId,
        invoiceNumber: "INV-RECENT",
        userId: user.id,
        customerId: customer.id,
        subtotal: 100,
        cgst: 6,
        sgst: 6,
        totalAmount: 112,
        paymentMode: "CASH",
        paymentStatus: "PAID",
      },
    });

    const recent = (await stats(token)).body.data.recentInvoices;

    // Purchase history in a pharmacy is patient-adjacent (threat T-9). The panel
    // needs a name to render; it does not need an address, and this endpoint is
    // open to every role.
    expect(recent[0].customer).toEqual({ id: customer.id, name: "Asha" });
    expect(JSON.stringify(recent)).not.toContain("9990001111");
    expect(JSON.stringify(recent)).not.toContain("Nehru Road");
  });
});

describe("GET /api/dashboard/stats — expiry panel", () => {
  it("counts every match but returns only the rows the panel renders", async () => {
    const { token } = await signIn(app);
    const { medicine, supplier } = await makeMedicine();
    for (let i = 1; i <= 14; i++) {
      await makeBatch({
        medicineId: medicine.id,
        supplierId: supplier.id,
        batchNumber: `E${i}`,
        expiryDate: daysFromNow(i),
      });
    }

    const { count, items } = (await stats(token)).body.data.expiring;

    // The whole point of the rewrite: an exact count from the database, and
    // only the ten rows the page shows — not every matching batch with its
    // medicine and supplier joined.
    expect(count).toBe(14);
    expect(items).toHaveLength(10);
    // Soonest first, so the panel leads with what has to move.
    const days = items.map((b) => new Date(b.expiryDate).getTime());
    expect(days).toEqual([...days].sort((a, b) => a - b));
  });

  // Guards the third site of C-3. The window used to open at the current
  // instant while expiry dates are stored at midnight, so a batch expiring
  // today vanished from this panel the moment the day began — even though
  // createInvoice sells it until midnight. The same bug was fixed in
  // batch.controller.js first and missed here.
  it("shows a batch expiring today, which is still sellable", async () => {
    const { token } = await signIn(app);
    const { medicine, supplier } = await makeMedicine();
    await makeBatch({
      medicineId: medicine.id,
      supplierId: supplier.id,
      batchNumber: "TODAY",
      expiryDate: midnightToday(),
    });

    const { count, items } = (await stats(token)).body.data.expiring;

    expect(count).toBe(1);
    expect(items[0].batchNumber).toBe("TODAY");
  });

  it("excludes what expired yesterday, what expires past the window, and what is sold out", async () => {
    const { token } = await signIn(app);
    const { medicine, supplier } = await makeMedicine();
    await makeBatch({
      medicineId: medicine.id,
      supplierId: supplier.id,
      batchNumber: "GONE",
      expiryDate: daysFromNow(-1),
    });
    await makeBatch({
      medicineId: medicine.id,
      supplierId: supplier.id,
      batchNumber: "FAR",
      expiryDate: daysFromNow(31),
    });
    await makeBatch({
      medicineId: medicine.id,
      supplierId: supplier.id,
      batchNumber: "EMPTY",
      expiryDate: daysFromNow(5),
      quantity: 0,
    });
    await makeBatch({
      medicineId: medicine.id,
      supplierId: supplier.id,
      batchNumber: "SOON",
      expiryDate: daysFromNow(29),
    });

    const { count, items } = (await stats(token)).body.data.expiring;

    expect(count).toBe(1);
    expect(items.map((b) => b.batchNumber)).toEqual(["SOON"]);
  });
});

describe("GET /api/dashboard/stats — low-stock panel", () => {
  it("counts every match but returns only the rows the panel renders", async () => {
    const { token } = await signIn(app);
    const { medicine, supplier } = await makeMedicine();
    for (let i = 1; i <= 13; i++) {
      await makeBatch({
        medicineId: medicine.id,
        supplierId: supplier.id,
        batchNumber: `L${i}`,
        quantity: i,
      });
    }

    const { count, items } = (await stats(token)).body.data.lowStock;

    expect(count).toBe(13);
    expect(items).toHaveLength(10);
    // Scarcest first.
    expect(items.map((b) => b.quantity)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  // The dashboard's threshold is 20; /api/reports/low-stock defaults to 10.
  // That is deliberate — the panel is a wider early warning than the report an
  // operator runs to order stock — and asserting it keeps the difference a
  // decision rather than a drift.
  it("uses a threshold of 20, inclusive, and skips sold-out batches", async () => {
    const { token } = await signIn(app);
    const { medicine, supplier } = await makeMedicine();
    await makeBatch({
      medicineId: medicine.id,
      supplierId: supplier.id,
      batchNumber: "AT",
      quantity: 20,
    });
    await makeBatch({
      medicineId: medicine.id,
      supplierId: supplier.id,
      batchNumber: "OVER",
      quantity: 21,
    });
    await makeBatch({
      medicineId: medicine.id,
      supplierId: supplier.id,
      batchNumber: "EMPTY",
      quantity: 0,
    });

    const { count, items } = (await stats(token)).body.data.lowStock;

    expect(count).toBe(1);
    expect(items.map((b) => b.batchNumber)).toEqual(["AT"]);
  });
});

describe("GET /api/dashboard/stats — totals", () => {
  it("counts active medicines and every customer", async () => {
    const { token } = await signIn(app);
    const { medicine, ...masters } = await makeMedicine({ name: "Active one" });
    await makeMedicine({ name: "Retired one", masters, isActive: false });
    await prisma.customer.create({
      data: { shopId: medicine.shopId, name: "Asha", phone: "9990002222" },
    });
    await prisma.customer.create({
      data: { shopId: medicine.shopId, name: "Bimal", phone: "9990003333" },
    });

    const totals = (await stats(token)).body.data.totals;

    // A soft-deleted medicine is off the catalogue, so it is off the count.
    expect(totals.medicines).toBe(1);
    expect(totals.customers).toBe(2);
    expect(medicine.isActive).toBe(true);
  });
});

describe("GET /api/dashboard/stats — trend", () => {
  it("always returns seven days, oldest first, zero-filled", async () => {
    const { token } = await signIn(app);
    await invoiceAt(new Date(), { total: 100 });

    const trend = (await stats(token)).body.data.trend;

    expect(trend).toHaveLength(7);
    // A missing day would silently shift every point left on the chart.
    const keys = trend.map((d) => d.date);
    expect(keys).toEqual([...keys].sort());
    expect(trend[6].sales).toBe(100);
    expect(
      trend.slice(0, 6).every((d) => d.sales === 0 && d.invoices === 0),
    ).toBe(true);
  });

  it("keys days by local date, not UTC", async () => {
    const { token } = await signIn(app);
    await invoiceAt(new Date(), { total: 100 });

    const now = new Date();
    const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    // Local midnight belongs to the previous UTC day east of Greenwich, so a
    // key built from toISOString() would label today as yesterday for every
    // user in the timezone this product is built for.
    expect((await stats(token)).body.data.trend.at(-1).date).toBe(localToday);
  });

  it("counts only sales but sums every document, so a reversal nets out", async () => {
    const { token } = await signIn(app);
    await invoiceAt(new Date(), { total: 500 });
    await invoiceAt(new Date(), { total: -200, type: "CREDIT_NOTE" });

    const today = (await stats(token)).body.data.trend.at(-1);

    // `invoices` counts SALE only, so a bar reading "1 invoice, ₹0" cannot
    // happen; `sales` sums both, so the money is net.
    expect(today.invoices).toBe(1);
    expect(today.sales).toBe(300);
  });

  it("excludes unpaid invoices from the chart", async () => {
    const { token } = await signIn(app);
    await invoiceAt(new Date(), { total: 100, status: "PAID" });
    await invoiceAt(new Date(), { total: 900, status: "PENDING" });

    // The trend charts takings, not billings — unlike the summary above, which
    // counts everything raised. The two answer different questions on purpose.
    const today = (await stats(token)).body.data.trend.at(-1);
    expect(today.sales).toBe(100);
    expect(today.invoices).toBe(1);
  });

  it("drops a sale older than the seven-day window", async () => {
    const { token } = await signIn(app);
    await invoiceAt(daysFromNow(-7), { total: 999 });
    await invoiceAt(daysFromNow(-6), { total: 100 });

    const trend = (await stats(token)).body.data.trend;

    expect(trend[0].sales).toBe(100);
    expect(trend.reduce((sum, d) => sum + d.sales, 0)).toBe(100);
  });

  // The bug this guards: `Invoice.date` is a naked timestamp holding a UTC
  // instant, so `date_trunc('day', ...)` truncated in UTC while the zero-fill
  // loop built keys from local components. East of Greenwich the two disagreed
  // for the first hours of every day.
  //
  // Measured in IST before the fix: a ₹777 sale at 02:00 today was charted on
  // *yesterday's* bar and today read ₹0 — while the daily summary, which draws
  // its boundaries in JS, insisted the sale was today. Two screens, one sale,
  // two different days.
  //
  // Asserted as agreement between the two endpoints rather than as a literal
  // day key, because that is true in every timezone. In UTC the two formulas
  // coincide and this passes trivially, which is worth knowing: CI cannot catch
  // a regression here on its own.
  it("puts an early-morning sale on the same day the daily summary does", async () => {
    const { token } = await signIn(app);
    // 02:00 local: in any zone ahead of UTC this instant belongs to the
    // previous UTC day.
    const early = new Date();
    early.setHours(2, 0, 0, 0);
    await invoiceAt(early, { total: 777 });

    const now = new Date();
    const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    const trend = (await stats(token)).body.data.trend;
    const summary = (
      await request(app)
        .get("/api/billing/invoices/daily-summary")
        .set("Authorization", `Bearer ${token}`)
    ).body.data.summary;

    const todaysBar = trend.find((d) => d.date === localToday);
    expect(todaysBar).toBeTruthy();
    expect(todaysBar.sales).toBe(777);
    expect(todaysBar.invoices).toBe(1);
    // The chart and the summary must file the sale under the same day.
    expect(todaysBar.sales).toBe(summary.totalSales);
  });

  // The dashboard held a second copy of the trend SQL. The comment above it
  // said the two "must agree" — true only for as long as nobody edited one of
  // them. They now call the same function in utils/trend.js, and this asserts
  // it on the response.
  it("agrees with GET /api/reports/trend over the same window", async () => {
    const { token } = await signIn(app);
    await invoiceAt(new Date(), { total: 250, mode: "UPI" });
    await invoiceAt(daysFromNow(-2), { total: 400 });
    await invoiceAt(daysFromNow(-3), { total: 50, status: "PENDING" });
    await invoiceAt(new Date(), { total: -100, type: "CREDIT_NOTE" });

    const fromDashboard = (await stats(token)).body.data.trend;
    const fromReport = (
      await request(app)
        .get("/api/reports/trend?days=7")
        .set("Authorization", `Bearer ${token}`)
    ).body.data;

    expect(fromDashboard).toEqual(fromReport);
  });
});
