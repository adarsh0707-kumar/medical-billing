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
 * Top-selling medicines — FR-RPT-07.
 *
 * Claimed in the old backend README and never built, which is how it came to be
 * catalogued as documentation drift rather than as a feature (D-1).
 *
 * The two properties worth the most here are the ones that look like details:
 * a renamed medicine must stay one row, and a return must come off the units.
 */

let app;
beforeAll(() => {
  app = buildApp();
});

const as = (token, method, path, body) =>
  request(app)[method](path).set("Authorization", `Bearer ${token}`).send(body);

const get = (token, path) => as(token, "get", path);

const MARCH = new Date(2026, 2, 12, 10, 0);
const APRIL = new Date(2026, 3, 8, 10, 0);
const REPORT = "/api/reports/top-sellers?month=3&year=2026";

/** A sale through the real pipeline, dated into a chosen month. */
const sellAt = async (
  token,
  { when, quantity = 1, name, sellingPrice = 24.5 } = {},
) => {
  const { medicine, batch } = await makeSellable({
    sellingPrice,
    quantity: 1000,
  });
  if (name) {
    await prisma.medicine.update({ where: { id: medicine.id }, data: { name } });
    medicine.name = name;
  }

  const res = await as(token, "post", "/api/billing/invoices", {
    items: [line(medicine, batch, { quantity })],
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

/** Sells more of a medicine that already exists, from its existing batch. */
const sellMore = async (token, { medicine, batch, quantity, when }) => {
  const res = await as(token, "post", "/api/billing/invoices", {
    items: [line(medicine, batch, { quantity })],
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
  return res.body.data;
};

const returnUnits = async (token, invoice, invoiceItemId, quantity, when) => {
  const res = await as(
    token,
    "post",
    `/api/billing/invoices/${invoice.id}/void`,
    { reason: "customer returned some", items: [{ invoiceItemId, quantity }] },
  );
  expect(res.status).toBe(201);
  if (when) {
    await prisma.invoice.update({
      where: { id: res.body.data.id },
      data: { date: when },
    });
  }
  return res.body.data;
};

const rows = (body) => body.data.medicines;
const rowFor = (body, name) => rows(body).find((r) => r.name === name);

describe("GET /api/reports/top-sellers", () => {
  it("ranks the month's medicines by units sold", async () => {
    const { token } = await signIn(app);
    await sellAt(token, { when: MARCH, quantity: 3, name: "Slow Mover" });
    await sellAt(token, { when: MARCH, quantity: 11, name: "Best Seller" });
    await sellAt(token, { when: MARCH, quantity: 7, name: "Middle" });

    const res = await get(token, REPORT);

    expect(res.status).toBe(200);
    expect(res.body.data.label).toBe("March 2026");
    expect(rows(res.body).map((r) => r.name)).toEqual([
      "Best Seller",
      "Middle",
      "Slow Mover",
    ]);
    expect(rows(res.body).map((r) => r.quantity)).toEqual([11, 7, 3]);
  });

  it("reports the value of what sold, not just the count", async () => {
    const { token } = await signIn(app);
    // 10 × ₹24.50 at 12% GST is the F1 fixture: ₹274.40 on the line.
    await sellAt(token, { when: MARCH, quantity: 10, name: "Priced" });

    const row = rowFor(await get(token, REPORT).then((r) => r.body), "Priced");
    expect(row.quantity).toBe(10);
    expect(row.value).toBe(274.4);
  });

  it("keeps neighbouring months out", async () => {
    const { token } = await signIn(app);
    await sellAt(token, { when: MARCH, quantity: 5, name: "In March" });
    await sellAt(token, { when: APRIL, quantity: 50, name: "In April" });

    const res = await get(token, REPORT);
    expect(rows(res.body).map((r) => r.name)).toEqual(["In March"]);
  });

  // ─── The rename trap (BR-12) ──────────────────────────────────────────────
  //
  // `InvoiceItem.medicineName` is a snapshot taken at sale time, so a later
  // rename cannot rewrite what a customer was handed. Group by that column and
  // one medicine becomes two rows the day somebody fixes a spelling — and each
  // half ranks lower than the whole, so a shop's best seller can drop off its
  // own top-ten.
  describe("a renamed medicine", () => {
    it("stays one row, under the name it has now", async () => {
      const { token } = await signIn(app);
      const { medicine, batch } = await sellAt(token, {
        when: MARCH,
        quantity: 4,
        name: "Paracetmol 500mg", // as first typed
      });

      // Sold again, then the spelling is corrected.
      await sellMore(token, { medicine, batch, quantity: 6, when: MARCH });
      await prisma.medicine.update({
        where: { id: medicine.id },
        data: { name: "Paracetamol 500mg" },
      });

      const res = await get(token, REPORT);

      expect(rows(res.body)).toHaveLength(1);
      expect(rows(res.body)[0]).toMatchObject({
        name: "Paracetamol 500mg",
        quantity: 10,
      });
    });

    it("does not leave the old name behind on the invoice lines", async () => {
      const { token } = await signIn(app);
      const { medicine } = await sellAt(token, {
        when: MARCH,
        quantity: 4,
        name: "Old Name",
      });
      await prisma.medicine.update({
        where: { id: medicine.id },
        data: { name: "New Name" },
      });

      // The line still says what it said when it was sold — that is BR-12 and
      // is not what this report reads.
      const item = await prisma.invoiceItem.findFirst();
      expect(item.medicineName).toBe("Old Name");
      expect(rowFor(await get(token, REPORT).then((r) => r.body), "New Name"))
        .toBeTruthy();
    });
  });

  // ─── Returns ──────────────────────────────────────────────────────────────
  describe("returns", () => {
    it("takes returned units off the quantity sold", async () => {
      const { token } = await signIn(app);
      const { invoice } = await sellAt(token, {
        when: MARCH,
        quantity: 10,
        name: "Partly Returned",
      });
      await returnUnits(token, invoice, invoice.items[0].id, 4, MARCH);

      const row = rowFor(
        await get(token, REPORT).then((r) => r.body),
        "Partly Returned",
      );
      expect(row.quantity).toBe(6);
    });

    it("drops a medicine that was returned in full", async () => {
      const { token } = await signIn(app);
      const { invoice } = await sellAt(token, {
        when: MARCH,
        quantity: 5,
        name: "All Back",
      });
      await returnUnits(token, invoice, invoice.items[0].id, 5, MARCH);

      // Zero net units is not a top seller, and a row reading "0 units" on a
      // list of best sellers is noise rather than information.
      expect(rows(await get(token, REPORT).then((r) => r.body))).toHaveLength(0);
    });

    // The period rule, and the reason this counts credit-note lines rather than
    // subtracting `returnedQty`: that column is cumulative and would make a
    // report of March change every time somebody returns a March purchase.
    it("books the return in the month it was issued, leaving the sale's month alone", async () => {
      const { token } = await signIn(app);
      const { invoice } = await sellAt(token, {
        when: MARCH,
        quantity: 10,
        name: "Sold In March",
      });
      await returnUnits(token, invoice, invoice.items[0].id, 4, APRIL);

      const march = await get(token, REPORT).then((r) => r.body);
      const april = await get(
        token,
        "/api/reports/top-sellers?month=4&year=2026",
      ).then((r) => r.body);

      // March is what March was, whatever happened afterwards.
      expect(rowFor(march, "Sold In March").quantity).toBe(10);
      // April's net is negative, so it is not a best seller there either.
      expect(rows(april)).toHaveLength(0);
    });
  });

  // ─── The limit ────────────────────────────────────────────────────────────
  describe("limit", () => {
    it("returns the top N when asked", async () => {
      const { token } = await signIn(app);
      for (const [i, name] of ["A", "B", "C"].entries()) {
        await sellAt(token, { when: MARCH, quantity: 10 - i, name });
      }

      const res = await get(token, `${REPORT}&limit=2`);
      expect(rows(res.body).map((r) => r.name)).toEqual(["A", "B"]);
      expect(res.body.data.limit).toBe(2);
    });

    it("caps a limit above the maximum rather than honouring it", async () => {
      const { token } = await signIn(app);
      // `?limit=999999` was honoured on every paginated endpoint once, which is
      // threat T-10. A new query surface must not reintroduce it.
      expect((await get(token, `${REPORT}&limit=999999`)).status).toBe(400);
      expect((await get(token, `${REPORT}&limit=0`)).status).toBe(400);
      expect((await get(token, `${REPORT}&limit=abc`)).status).toBe(400);
    });

    it("defaults when the limit is absent", async () => {
      const { token } = await signIn(app);
      expect((await get(token, REPORT)).body.data.limit).toBe(20);
    });
  });

  // ─── Who may read it ──────────────────────────────────────────────────────
  //
  // Every role, like the other period reports — this says what the shop sold,
  // not what any of it cost. The contrast with `/margin`, which is ADMIN only,
  // is the line between a trading record and a cost book.
  it.each(["ADMIN", "PHARMACIST", "CASHIER"])("is open to %s", async (role) => {
    const { token } = await signIn(app, role, {
      email: `top-${role}@test.local`,
    });
    expect((await get(token, REPORT)).status).toBe(200);
    expect((await get(token, `${REPORT.replace("?", "/export?")}`)).status).toBe(
      200,
    );
  });

  it("is readable by a role the margin report refuses", async () => {
    const { token } = await signIn(app, "CASHIER", {
      email: "top-contrast@test.local",
    });
    expect((await get(token, REPORT)).status).toBe(200);
    expect(
      (await get(token, "/api/reports/margin?month=3&year=2026")).status,
    ).toBe(403);
  });

  it("does not see another shop's sales", async () => {
    const { token } = await signIn(app);
    await sellAt(token, { when: MARCH, quantity: 9, name: "Ours" });

    const other = await makeShop();
    const { token: otherToken } = await signIn(app, "ADMIN", {
      shopId: other.id,
      email: "other-top-admin@test.local",
    });

    expect(rows(await get(otherToken, REPORT).then((r) => r.body))).toHaveLength(
      0,
    );
  });

  it("rejects a month outside 1–12", async () => {
    const { token } = await signIn(app);
    expect(
      (await get(token, "/api/reports/top-sellers?month=13&year=2026")).status,
    ).toBe(400);
  });

  it("returns an empty list for a month with no sales", async () => {
    const { token } = await signIn(app);
    const res = await get(token, "/api/reports/top-sellers?month=7&year=2026");
    expect(res.status).toBe(200);
    expect(rows(res.body)).toEqual([]);
  });
});

describe("GET /api/reports/top-sellers/export", () => {
  it("sends the ranking with money as the stored 2 dp string", async () => {
    const { token } = await signIn(app);
    await sellAt(token, { when: MARCH, quantity: 10, name: "Exported" });

    const res = await get(
      token,
      "/api/reports/top-sellers/export?month=3&year=2026",
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain(
      "top-sellers-2026-03.csv",
    );
    expect(res.text).toContain("Medicine,Unit,Units Sold,Value");
    // Units is a count and must stay one; only Value is money.
    expect(res.text).toContain("Exported,tablet,10,274.40");
  });
});
