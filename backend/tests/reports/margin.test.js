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
 * Profit and margin report — FR-RPT-08.
 *
 * The arithmetic it has to get right, and the reason each is asserted rather
 * than reasoned about:
 *
 *   revenue = subtotal − discountAmt   what the shop keeps, before tax. Not
 *                                      totalAmount, which carries GST the shop
 *                                      only collects.
 *   cost    = purchasePrice × quantity at the batch each line was sold from,
 *                                      negated for a credit note.
 *
 * Both come from stored columns, so the report re-derives nothing (G-21).
 */

let app;
beforeAll(() => {
  app = buildApp();
});

const as = (token, method, path, body) =>
  request(app)[method](path).set("Authorization", `Bearer ${token}`).send(body);

const get = (token, path) => as(token, "get", path);

/**
 * One sale through the real pipeline, then dated into a chosen month.
 *
 * Selling through the API rather than inserting rows is the point: the figures
 * the report reads are the ones `createInvoice` actually stored, so a change to
 * the GST engine shows up here instead of being papered over by a fixture that
 * agrees with the old maths.
 */
const sellAt = async (
  token,
  {
    when,
    quantity = 10,
    sellingPrice = 24.5,
    purchasePrice = 10,
    gstPercent = 12,
    discount = 0,
  } = {},
) => {
  const { medicine, batch } = await makeSellable({
    sellingPrice,
    gstPercent,
    quantity: 1000,
  });
  if (purchasePrice !== 10) {
    await prisma.batch.update({
      where: { id: batch.id },
      data: { purchasePrice },
    });
  }

  const res = await as(token, "post", "/api/billing/invoices", {
    items: [line(medicine, batch, { quantity, discount })],
    paymentMode: "CASH",
    paymentStatus: "PAID",
  });
  expect(res.status).toBe(201);

  if (when) {
    await prisma.invoice.update({
      where: { id: res.body.data.id },
      data: { date: when },
    });
  }
  return { invoice: res.body.data, medicine, batch };
};

const returnAll = async (token, invoice, when) => {
  const res = await as(token, "post", `/api/billing/invoices/${invoice.id}/void`, {
    reason: "customer returned the lot",
  });
  expect(res.status).toBe(201);
  if (when) {
    await prisma.invoice.update({
      where: { id: res.body.data.id },
      data: { date: when },
    });
  }
  return res.body.data;
};

const MARCH = new Date(2026, 2, 12, 10, 0);
const APRIL = new Date(2026, 3, 8, 10, 0);
const marginOf = (body) => body.data.margin;

describe("GET /api/reports/margin", () => {
  // F1 from the docs/09 fixture set, priced: 10 × ₹24.50 at 12% GST, from a
  // batch that cost ₹10 a unit.
  //
  //   revenue 245.00   (subtotal, GST excluded)
  //   cost    100.00
  //   profit  145.00   → 59.18%
  it("prices a month's trade against what the stock cost", async () => {
    const { token } = await signIn(app, "ADMIN");
    await sellAt(token, { when: MARCH });

    const res = await get(token, "/api/reports/margin?month=3&year=2026");

    expect(res.status).toBe(200);
    expect(res.body.data.label).toBe("March 2026");
    expect(marginOf(res.body)).toMatchObject({
      revenue: 245,
      cost: 100,
      profit: 145,
      marginPercent: 59.18,
      unpricedLines: 0,
    });
  });

  // Revenue is deliberately not `totalAmount`. GST is collected for the
  // government and remitted; counting it as revenue would overstate this month's
  // profit by ₹29.40 and every month's by its tax.
  it("excludes GST from revenue", async () => {
    const { token } = await signIn(app, "ADMIN");
    await sellAt(token, { when: MARCH });

    const res = await get(token, "/api/reports/margin?month=3&year=2026");
    const invoice = await prisma.invoice.findFirst({ where: { type: "SALE" } });

    expect(Number(invoice.totalAmount)).toBe(274.4);
    expect(marginOf(res.body).revenue).toBe(245);
  });

  it("reconciles: the day rows sum to the headline", async () => {
    const { token } = await signIn(app, "ADMIN");
    await sellAt(token, { when: new Date(2026, 2, 3, 10, 0) });
    await sellAt(token, { when: new Date(2026, 2, 3, 15, 0), quantity: 4 });
    await sellAt(token, { when: new Date(2026, 2, 20, 11, 0), quantity: 7 });

    const res = await get(token, "/api/reports/margin?month=3&year=2026");
    const { days } = res.body.data;
    const margin = marginOf(res.body);

    const sum = (key) => days.reduce((n, d) => n + d[key], 0);
    // Rounded because these are floats on the wire; the stored values are exact
    // Decimals and the CSV asserts those separately.
    expect(sum("revenue")).toBeCloseTo(margin.revenue, 2);
    expect(sum("cost")).toBeCloseTo(margin.cost, 2);
    expect(sum("profit")).toBeCloseTo(margin.profit, 2);
    expect(margin.profit).toBeCloseTo(margin.revenue - margin.cost, 2);
  });

  it("zero-fills the month, so a quiet day is a flat line rather than a gap", async () => {
    const { token } = await signIn(app, "ADMIN");
    await sellAt(token, { when: MARCH });

    const { days } = (await get(token, "/api/reports/margin?month=3&year=2026"))
      .body.data;

    expect(days).toHaveLength(31);
    expect(days.map((d) => d.day)).toEqual(
      Array.from({ length: 31 }, (_, i) => i + 1),
    );
    expect(days.find((d) => d.day === 12)).toMatchObject({ revenue: 245 });
    expect(days.find((d) => d.day === 13)).toMatchObject({
      revenue: 0,
      cost: 0,
      profit: 0,
    });
  });

  it("keeps neighbouring months out", async () => {
    const { token } = await signIn(app, "ADMIN");
    await sellAt(token, { when: MARCH });
    await sellAt(token, { when: new Date(2026, 1, 28, 12, 0) });
    await sellAt(token, { when: new Date(2026, 3, 1, 12, 0) });

    const res = await get(token, "/api/reports/margin?month=3&year=2026");
    expect(marginOf(res.body).revenue).toBe(245);
  });

  // ─── Credit notes ─────────────────────────────────────────────────────────
  describe("credit notes", () => {
    it("reduces the margin of the period the credit note was issued in", async () => {
      const { token } = await signIn(app, "ADMIN");
      const a = await sellAt(token, { when: MARCH });
      await sellAt(token, { when: MARCH });
      await returnAll(token, a.invoice, MARCH);

      const res = await get(token, "/api/reports/margin?month=3&year=2026");

      // Two sales less one return: one sale's worth of everything.
      expect(marginOf(res.body)).toMatchObject({
        revenue: 245,
        cost: 100,
        profit: 145,
      });
    });

    // BR-14, and the half that is easy to get wrong: a sale stays in the month
    // it was raised in even after it is cancelled. Dropping it from its own
    // month would rewrite a period that may already have been filed.
    it("leaves the reversed sale in its own month and books the reversal in the next", async () => {
      const { token } = await signIn(app, "ADMIN");
      const sale = await sellAt(token, { when: MARCH });
      await returnAll(token, sale.invoice, APRIL);

      const march = marginOf(
        (await get(token, "/api/reports/margin?month=3&year=2026")).body,
      );
      const april = marginOf(
        (await get(token, "/api/reports/margin?month=4&year=2026")).body,
      );

      // March is untouched by what happened in April.
      expect(march).toMatchObject({ revenue: 245, cost: 100, profit: 145 });
      // April carries the reversal — the stock came back, so its cost comes off
      // the month that took it back, not the month that sold it.
      expect(april).toMatchObject({ revenue: -245, cost: -100, profit: -145 });
    });

    it("still counts the cancelled sale in the month's invoice count", async () => {
      const { token } = await signIn(app, "ADMIN");
      const sale = await sellAt(token, { when: MARCH });
      await returnAll(token, sale.invoice, MARCH);

      const { summary } = (
        await get(token, "/api/reports/margin?month=3&year=2026")
      ).body.data;

      expect(summary.totalInvoices).toBe(1);
      expect(summary.creditNotes).toBe(1);
    });
  });

  // ─── A cost that was never recorded ───────────────────────────────────────
  //
  // `purchasePrice` is validated positive, so a zero is a cost nobody entered
  // rather than stock that was free. The arithmetic cannot tell those apart —
  // both make the line pure profit — so the report counts them instead of
  // quietly reporting a better month than the shop had.
  it("counts a line whose batch has no recorded cost rather than treating it as free", async () => {
    const { token } = await signIn(app, "ADMIN");
    await sellAt(token, { when: MARCH, purchasePrice: 0 });

    const margin = marginOf(
      (await get(token, "/api/reports/margin?month=3&year=2026")).body,
    );

    // The flag is the whole point: without it this month reads as a flawless
    // 100% margin and nothing on the screen says why.
    expect(margin.unpricedLines).toBe(1);
    expect(margin.revenue).toBe(245);
    expect(margin.cost).toBe(0);
  });

  it("counts only the unpriced lines, not every line beside them", async () => {
    const { token } = await signIn(app, "ADMIN");
    await sellAt(token, { when: MARCH });
    await sellAt(token, { when: MARCH, purchasePrice: 0 });

    const margin = marginOf(
      (await get(token, "/api/reports/margin?month=3&year=2026")).body,
    );

    expect(margin.unpricedLines).toBe(1);
    expect(margin.cost).toBe(100);
  });

  it("states no margin percentage for a month that sold nothing", async () => {
    const { token } = await signIn(app, "ADMIN");

    const margin = marginOf(
      (await get(token, "/api/reports/margin?month=7&year=2026")).body,
    );

    // Null, not 0. Zero percent is a claim about a month that traded.
    expect(margin.marginPercent).toBeNull();
    expect(margin.revenue).toBe(0);
  });

  // ─── Who may read it ──────────────────────────────────────────────────────
  //
  // The contrast is the assertion. The period reports are open to every role
  // because a shop's takings are its own trading record; what the stock cost is
  // not, so this one sits with the GST return.
  describe("authorisation", () => {
    it("is open to an admin", async () => {
      const { token } = await signIn(app, "ADMIN");
      expect(
        (await get(token, "/api/reports/margin?month=3&year=2026")).status,
      ).toBe(200);
    });

    it.each(["PHARMACIST", "CASHIER"])("refuses a %s", async (role) => {
      const { token } = await signIn(app, role, {
        email: `margin-${role}@test.local`,
      });
      expect(
        (await get(token, "/api/reports/margin?month=3&year=2026")).status,
      ).toBe(403);
      expect(
        (await get(token, "/api/reports/margin/export?month=3&year=2026"))
          .status,
      ).toBe(403);
    });

    it("refuses a role the monthly report admits, which is the point", async () => {
      const { token } = await signIn(app, "CASHIER", {
        email: "margin-contrast@test.local",
      });

      expect(
        (await get(token, "/api/reports/monthly?month=3&year=2026")).status,
      ).toBe(200);
      expect(
        (await get(token, "/api/reports/margin?month=3&year=2026")).status,
      ).toBe(403);
    });
  });

  it("does not see another shop's trade", async () => {
    const { token } = await signIn(app, "ADMIN");
    await sellAt(token, { when: MARCH });

    const other = await makeShop();
    const { token: otherToken } = await signIn(app, "ADMIN", {
      shopId: other.id,
      email: "other-shop-admin@test.local",
    });

    // A leak here would put one pharmacy's cost prices on another's screen.
    const margin = marginOf(
      (await get(otherToken, "/api/reports/margin?month=3&year=2026")).body,
    );
    expect(margin).toMatchObject({ revenue: 0, cost: 0, profit: 0 });
  });

  it("shares its summary with the monthly report rather than deriving one", async () => {
    const { token } = await signIn(app, "ADMIN");
    await sellAt(token, { when: MARCH });
    await sellAt(token, { when: new Date(2026, 2, 20, 11, 0), quantity: 3 });

    const margin = (await get(token, "/api/reports/margin?month=3&year=2026"))
      .body.data;
    const monthly = (await get(token, "/api/reports/monthly?month=3&year=2026"))
      .body.data;

    // Same function, so these cannot drift. Two screens disagreeing about one
    // month is the defect `utils/trend.js` exists to prevent.
    expect(margin.summary).toEqual(monthly.summary);
  });

  it("rejects a month outside 1–12", async () => {
    const { token } = await signIn(app, "ADMIN");
    expect(
      (await get(token, "/api/reports/margin?month=13&year=2026")).status,
    ).toBe(400);
  });
});

describe("GET /api/reports/margin/export", () => {
  it("sends money as the stored 2 dp string, not a float", async () => {
    const { token } = await signIn(app, "ADMIN");
    await sellAt(token, { when: MARCH });

    const res = await get(token, "/api/reports/margin/export?month=3&year=2026");

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain(
      "margin-report-2026-03.csv",
    );
    expect(res.text).toContain("Date,Revenue,Cost,Profit");
    // Exactly as stored. Routed through the API's Decimal-to-Number replacer
    // this is where a filing error would enter the file (G-21).
    expect(res.text).toContain("2026-03-12,245.00,100.00,145.00");
    // A quiet day still gets a row, with zeroes rather than blanks.
    expect(res.text).toContain("2026-03-13,0.00,0.00,0.00");
  });

  it("writes a credit note's month as negative money", async () => {
    const { token } = await signIn(app, "ADMIN");
    const sale = await sellAt(token, { when: MARCH });
    await returnAll(token, sale.invoice, APRIL);

    const res = await get(token, "/api/reports/margin/export?month=4&year=2026");

    // Negative numbers are emitted unprefixed: the formula guard applies to
    // operator-entered text only, and prefixing these would turn a figure the
    // accountant needs to sum into a string.
    expect(res.text).toContain("2026-04-08,-245.00,-100.00,-145.00");
  });
});
