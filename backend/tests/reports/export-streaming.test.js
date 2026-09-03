import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import prisma from "../../src/config/db.js";
import { buildApp, signIn, makeSellable } from "../helpers/factory.js";
import { STREAM_PAGE } from "../../src/utils/csv.js";

/**
 * The exports that are one row per record produce the whole register.
 *
 * Until 2026-09-03 the Schedule H register exported its first **100** rows and
 * said nothing about the rest — `MAX_LIMIT`, borrowed from the paging rules
 * that bound what a *client* may ask for, applied to a compliance document that
 * nobody asked to be paginated. Rule 65(11) obliges the pharmacy to produce the
 * particulars; a file that stops early produces the wrong number of them, and
 * a truncated CSV that terminates cleanly is indistinguishable from a complete
 * one.
 *
 * These tests exist to fail if a cap ever comes back. They export **more rows
 * than the old ceiling** and count the lines, which is the only assertion that
 * can tell a complete document from a plausible one.
 *
 * Rows are inserted directly rather than through the billing endpoint. What is
 * under test is the export's paging, not invoice creation — which
 * `tests/billing/` covers at length — and 120 checkouts through the real
 * pipeline would buy nothing here but a slower suite.
 */

let app;
beforeAll(() => {
  app = buildApp();
});

const get = (token, path) =>
  request(app).get(path).set("Authorization", `Bearer ${token}`);

/** Comfortably past the old 100-row cap, and past one streamed page. */
const OVER_CAP = 120;

/** Data rows in a CSV: everything after the header, BOM and trailer removed. */
const dataRows = (text) =>
  text
    .replace(/^\uFEFF/, "")
    .trim()
    .split("\r\n")
    .slice(1);

/**
 * `count` invoices in March 2026, all PAID so the GST return takes them.
 *
 * Dates are spread across the month and two share a timestamp deliberately:
 * the ordering has to be total, or a paged read repeats one row and drops
 * another at a page boundary.
 */
const seedInvoices = async (user, count) => {
  const rows = Array.from({ length: count }, (_, i) => ({
    shopId: user.shopId,
    userId: user.id,
    invoiceNumber: `INV2603-${String(i).padStart(4, "0")}`,
    date: new Date(2026, 2, 1 + (i % 28), 10, 0, 0),
    subtotal: "100.00",
    cgst: "6.00",
    sgst: "6.00",
    totalAmount: "112.00",
    paymentStatus: "PAID",
  }));
  await prisma.invoice.createMany({ data: rows });
  return prisma.invoice.findMany({
    where: { shopId: user.shopId },
    select: { id: true },
  });
};

describe("GET /api/reports/prescriptions/export", () => {
  it(`exports all ${OVER_CAP} entries, not the first 100`, async () => {
    const { token, user } = await signIn(app);
    const invoices = await seedInvoices(user, OVER_CAP);

    await prisma.prescription.createMany({
      data: invoices.map((inv, i) => ({
        invoiceId: inv.id,
        prescriberName: `Dr Number ${i}`,
        prescriberRegNo: `MMC/${1000 + i}`,
        // A single date for every row: `prescribedOn` is a date rather than a
        // timestamp, so a real register ties constantly, and the `id`
        // tiebreaker is what keeps the paged read from repeating rows.
        prescribedOn: new Date(2026, 2, 10),
        patientName: `Patient ${i}`,
      })),
    });

    const res = await get(token, "/api/reports/prescriptions/export");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(dataRows(res.text)).toHaveLength(OVER_CAP);
  });

  it("writes every prescriber exactly once across the page boundary", async () => {
    const { token, user } = await signIn(app);
    const invoices = await seedInvoices(user, OVER_CAP);
    await prisma.prescription.createMany({
      data: invoices.map((inv, i) => ({
        invoiceId: inv.id,
        prescriberName: `Dr Number ${i}`,
        prescriberRegNo: `MMC/${1000 + i}`,
        prescribedOn: new Date(2026, 2, 10),
        patientName: `Patient ${i}`,
      })),
    });

    const rows = dataRows((await get(token, "/api/reports/prescriptions/export")).text);
    const names = rows.map((r) => r.split(",")[1]);

    // A duplicate or a gap here is the failure a row *count* alone can miss:
    // paging over a partial order loses one row and repeats another, leaving
    // the total intact.
    expect(new Set(names).size).toBe(OVER_CAP);
  });

  it("still honours the filter it is given", async () => {
    const { token, user } = await signIn(app);
    const invoices = await seedInvoices(user, OVER_CAP);
    await prisma.prescription.createMany({
      data: invoices.map((inv, i) => ({
        invoiceId: inv.id,
        prescriberName: i === 0 ? "Dr Only One" : `Dr Number ${i}`,
        prescriberRegNo: `MMC/${1000 + i}`,
        prescribedOn: new Date(2026, 2, 10),
        patientName: `Patient ${i}`,
      })),
    });

    const res = await get(
      token,
      "/api/reports/prescriptions/export?search=Only%20One",
    );

    expect(dataRows(res.text)).toHaveLength(1);
  });
});

describe("GET /api/reports/gst/export", () => {
  it(`exports all ${OVER_CAP} invoices in the period`, async () => {
    const { token, user } = await signIn(app);
    await seedInvoices(user, OVER_CAP);

    const res = await get(token, "/api/reports/gst/export?month=3&year=2026");

    expect(res.status).toBe(200);
    expect(dataRows(res.text)).toHaveLength(OVER_CAP);
  });

  it("writes every invoice number exactly once", async () => {
    const { token, user } = await signIn(app);
    await seedInvoices(user, OVER_CAP);

    const rows = dataRows(
      (await get(token, "/api/reports/gst/export?month=3&year=2026")).text,
    );
    const numbers = rows.map((r) => r.split(",")[1]);

    expect(new Set(numbers).size).toBe(OVER_CAP);
  });

  // The whole point of the export: the file and the report have to agree, or
  // the return is filed from a document the screen never showed (G-21).
  it("agrees with the JSON report on how many invoices there are", async () => {
    const { token, user } = await signIn(app);
    await seedInvoices(user, OVER_CAP);

    const json = await get(token, "/api/reports/gst?month=3&year=2026");
    const csv = await get(token, "/api/reports/gst/export?month=3&year=2026");

    expect(dataRows(csv.text)).toHaveLength(json.body.data.invoices.length);
  });

  // Paging is where a tenant filter goes missing: the `where` is easy to build
  // once for the count and forget on the page query. So the other shop gets
  // more than a page of its own invoices — enough that a dropped filter shows
  // up as extra rows rather than as nothing at all.
  it("does not export another shop's invoices", async () => {
    const { token, user } = await signIn(app);
    await seedInvoices(user, 5);

    const otherShop = await prisma.shop.create({ data: { name: "Other" } });
    const { user: theirs } = await signIn(app, "ADMIN", {
      shopId: otherShop.id,
      email: "gst-export-other@test.local",
    });
    await seedInvoices(theirs, OVER_CAP);

    const res = await get(token, "/api/reports/gst/export?month=3&year=2026");

    expect(dataRows(res.text)).toHaveLength(5);
  });
});

describe("GET /api/reports/daily-summary/export", () => {
  it(`exports all ${OVER_CAP} invoices for the day`, async () => {
    const { token, user } = await signIn(app);
    const day = new Date(2026, 2, 12, 10, 0, 0);
    await prisma.invoice.createMany({
      data: Array.from({ length: OVER_CAP }, (_, i) => ({
        shopId: user.shopId,
        userId: user.id,
        invoiceNumber: `INV260312-${String(i).padStart(4, "0")}`,
        // Every invoice at the same instant, which is what a busy till looks
        // like to a `date DESC` sort with no tiebreaker.
        date: day,
        subtotal: "100.00",
        cgst: "6.00",
        sgst: "6.00",
        totalAmount: "112.00",
      })),
    });

    const res = await get(
      token,
      "/api/reports/daily-summary/export?date=2026-03-12",
    );

    expect(dataRows(res.text)).toHaveLength(OVER_CAP);
  });
});

describe("the stock exports", () => {
  /**
   * `count` batches of one medicine, all expiring on the same day.
   *
   * `makeSellable` brings a batch of its own, so it is created well stocked and
   * expiring far out — otherwise it lands in the report beside the seeded rows
   * and the count is one more than was asked for, which is how this fixture
   * failed first time round.
   */
  const seedBatches = async (count, { expiryDate, quantity }) => {
    const { medicine, supplier } = await makeSellable({ quantity: 500 });
    await prisma.batch.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        shopId: medicine.shopId,
        medicineId: medicine.id,
        supplierId: supplier.id,
        batchNumber: `B${String(i).padStart(4, "0")}`,
        expiryDate,
        purchasePrice: "10.00",
        sellingPrice: "24.50",
        quantity,
        initialQty: quantity,
      })),
    });
  };

  const soon = () => {
    const d = new Date();
    d.setDate(d.getDate() + 10);
    return d;
  };

  it(`exports all ${OVER_CAP} expiring batches`, async () => {
    const { token } = await signIn(app);
    await seedBatches(OVER_CAP, { expiryDate: soon(), quantity: 50 });

    const res = await get(token, "/api/reports/expiring/export?days=30");

    expect(dataRows(res.text)).toHaveLength(OVER_CAP);
  });

  it(`exports all ${OVER_CAP} low-stock batches`, async () => {
    const { token } = await signIn(app);
    await seedBatches(OVER_CAP, { expiryDate: new Date("2028-12-31"), quantity: 3 });

    const res = await get(token, "/api/reports/low-stock/export?threshold=5");

    expect(dataRows(res.text)).toHaveLength(OVER_CAP);
  });
});

/**
 * The four that do not stream, and why that is a decision rather than an
 * oversight: their row count is set by the shape of the report, not by how much
 * the shop traded. A month has at most 31 daily buckets whatever happens in it.
 */
describe("the bounded exports stay bounded", () => {
  it("gives a month one row per day however many invoices it holds", async () => {
    const { token, user } = await signIn(app);
    await seedInvoices(user, OVER_CAP);

    const res = await get(token, "/api/reports/monthly/export?month=3&year=2026");

    expect(dataRows(res.text)).toHaveLength(31);
  });

  it("gives a year twelve rows", async () => {
    const { token, user } = await signIn(app);
    await seedInvoices(user, OVER_CAP);

    const res = await get(token, "/api/reports/yearly/export?year=2026");

    expect(dataRows(res.text)).toHaveLength(12);
  });

  it("gives top sellers the number the caller asked for", async () => {
    const { token } = await signIn(app);

    const res = await get(
      token,
      "/api/reports/top-sellers/export?month=3&year=2026&limit=10",
    );

    // Nothing sold in the fixture, so the assertion is that the report is a
    // ranking with a ceiling rather than a register: it cannot exceed `limit`.
    expect(dataRows(res.text).length).toBeLessThanOrEqual(10);
  });
});

it("uses a page size unrelated to the client-facing MAX_LIMIT", () => {
  // If these ever become the same number, someone has re-tied an internal read
  // size to the threat-model cap that started this.
  expect(STREAM_PAGE).toBeGreaterThan(100);
});
