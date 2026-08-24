import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import prisma from "../../src/config/db.js";
import {
  buildApp,
  signIn,
  makeMedicine,
  makeBatch,
  makeUser,
} from "../helpers/factory.js";

/**
 * FR-RPT-09 — the four report exports, end to end.
 *
 * The load-bearing assertion in here is not that a CSV is produced; it is that
 * the CSV and the screen report the same figures. docs/09 section 4 treats those
 * totals as a contract, so an export that quietly disagrees with the page it was
 * exported from is worse than no export at all — it would be filed.
 */

let app;
beforeAll(() => {
  app = buildApp();
});

const get = (token, path) =>
  request(app).get(path).set("Authorization", `Bearer ${token}`);

const parse = (text) => {
  const body = text.replace(/^\uFEFF/, "").trim().split("\r\n");
  return { header: body[0].split(","), rows: body.slice(1) };
};

async function invoiceAt(date, over = {}) {
  const user = await makeUser({ email: `csv-${Math.random()}@test.local` });
  const { subtotal = 100, cgst = 6, sgst = 6, total = 112, ...rest } = over;
  return prisma.invoice.create({
    data: {
      invoiceNumber: `INV-${Math.random().toString(36).slice(2, 10)}`,
      userId: user.id,
      date,
      createdAt: date,
      subtotal,
      cgst,
      sgst,
      totalAmount: total,
      paymentMode: "CASH",
      paymentStatus: "PAID",
      ...rest,
    },
  });
}

describe("CSV export — transport", () => {
  it("sends a downloadable CSV, not JSON", async () => {
    const { token } = await signIn(app);
    const res = await get(token, "/api/billing/invoices/daily-summary/export");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/csv; charset=utf-8/);
    expect(res.headers["content-disposition"]).toMatch(
      /^attachment; filename="daily-summary-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
  });

  it("names the GST file after the period it covers", async () => {
    const { token } = await signIn(app);
    const res = await get(
      token,
      "/api/billing/invoices/gst-report/export?month=3&year=2026",
    );
    expect(res.headers["content-disposition"]).toContain(
      'filename="gst-report-2026-03.csv"',
    );
  });

  it("still validates its query", async () => {
    const { token } = await signIn(app);
    // The export shares the JSON report's schema; a bad period must not become
    // an empty spreadsheet that looks like a month with no sales.
    const res = await get(
      token,
      "/api/billing/invoices/gst-report/export?month=13&year=2026",
    );
    expect(res.status).toBe(400);
  });

  it("keeps the GST export behind the same roles as the report", async () => {
    const { token } = await signIn(app, "CASHIER");
    expect(
      (await get(token, "/api/billing/invoices/gst-report/export?month=3&year=2026"))
        .status,
    ).toBe(403);
    // The daily summary is open to every role, and stays that way.
    expect(
      (await get(token, "/api/billing/invoices/daily-summary/export")).status,
    ).toBe(200);
  });

  it("writes a header row even when there is nothing to report", async () => {
    const { token } = await signIn(app);
    const res = await get(
      token,
      "/api/billing/invoices/gst-report/export?month=1&year=2020",
    );
    const { header, rows } = parse(res.text);

    // An empty file is indistinguishable from a failed download.
    expect(header[0]).toBe("Date");
    expect(rows).toEqual([]);
  });
});

describe("CSV export — agreement with the screen", () => {
  // GUARD G-21 — the export and the report must not drift apart.
  it("reports the same GST totals as the JSON report, to the paisa", async () => {
    const { token } = await signIn(app);
    const when = new Date(2026, 4, 12, 10, 0, 0);
    await invoiceAt(when, { subtotal: 245, cgst: 14.7, sgst: 14.7, total: 274.4 });
    await invoiceAt(when, { subtotal: 99.99, cgst: 9, sgst: 9, total: 117.99 });

    const json = await get(
      token,
      "/api/billing/invoices/gst-report?month=5&year=2026",
    );
    const csv = await get(
      token,
      "/api/billing/invoices/gst-report/export?month=5&year=2026",
    );

    const { header, rows } = parse(csv.text);
    const col = (name) => header.indexOf(name);
    const sum = (name) =>
      rows.reduce((n, r) => n + Number(r.split(",")[col(name)]), 0);

    expect(rows).toHaveLength(json.body.data.invoices.length);
    expect(sum("Taxable")).toBeCloseTo(Number(json.body.data.totals.taxable), 2);
    expect(sum("CGST")).toBeCloseTo(Number(json.body.data.totals.cgst), 2);
    expect(sum("SGST")).toBeCloseTo(Number(json.body.data.totals.sgst), 2);
    expect(sum("Total")).toBeCloseTo(Number(json.body.data.totals.total), 2);
  });

  it("carries money as a 2 dp string, not the API's unwrapped Number", async () => {
    const { token } = await signIn(app);
    const when = new Date(2026, 5, 3, 9, 0, 0);
    // 500 exactly: JSON gives the number 500, the CSV must give "500.00".
    await invoiceAt(when, { subtotal: 500, cgst: 0, sgst: 0, total: 500 });

    const json = await get(
      token,
      "/api/billing/invoices/gst-report?month=6&year=2026",
    );
    const csv = await get(
      token,
      "/api/billing/invoices/gst-report/export?month=6&year=2026",
    );
    const { header, rows } = parse(csv.text);

    expect(json.body.data.invoices[0].totalAmount).toBe(500);
    expect(rows[0].split(",")[header.indexOf("Total")]).toBe("500.00");
  });

  it("includes credit notes as negative rows so the month nets out", async () => {
    const { token } = await signIn(app);
    const when = new Date(2026, 6, 8, 9, 0, 0);
    const sale = await invoiceAt(when, { subtotal: 100, cgst: 6, sgst: 6, total: 112 });
    await invoiceAt(when, {
      subtotal: -100,
      cgst: -6,
      sgst: -6,
      total: -112,
      type: "CREDIT_NOTE",
      reversesId: sale.id,
    });

    const csv = await get(
      token,
      "/api/billing/invoices/gst-report/export?month=7&year=2026",
    );
    const { header, rows } = parse(csv.text);
    const totals = rows.map((r) => r.split(",")[header.indexOf("Total")]);

    expect(totals).toContain("-112.00");
    // The guard must not have turned the negative into text.
    expect(totals.some((t) => t.startsWith("'"))).toBe(false);
    expect(totals.reduce((n, t) => n + Number(t), 0)).toBe(0);
  });
});

describe("CSV export — inventory reports", () => {
  it("exports expiring stock with days remaining", async () => {
    const { token } = await signIn(app);
    const { medicine, supplier } = await makeMedicine({ name: "Amoxicillin" });
    const soon = new Date();
    soon.setDate(soon.getDate() + 10);
    await makeBatch({
      medicineId: medicine.id,
      supplierId: supplier.id,
      batchNumber: "EXP-1",
      expiryDate: soon,
      quantity: 4,
    });

    const res = await get(token, "/api/inventory/batches/expiring/export?days=30");
    const { header, rows } = parse(res.text);
    const row = rows.find((r) => r.includes("EXP-1")).split(",");

    expect(row[header.indexOf("Medicine")]).toBe("Amoxicillin");
    expect(Number(row[header.indexOf("Days To Expiry")])).toBe(10);
    expect(row[header.indexOf("Quantity")]).toBe("4");
    // 4 units at the factory's ₹10 purchase price.
    expect(row[header.indexOf("Stock Value At Cost")]).toBe("40.00");
  });

  it("exports low stock below the threshold", async () => {
    const { token } = await signIn(app);
    const { medicine, supplier } = await makeMedicine({ name: "Cetirizine" });
    await makeBatch({ medicineId: medicine.id, supplierId: supplier.id, batchNumber: "LOW-1", quantity: 3 });
    await makeBatch({ medicineId: medicine.id, supplierId: supplier.id, batchNumber: "FINE-1", quantity: 90 });

    const res = await get(token, "/api/inventory/batches/low-stock/export?threshold=10");
    const { rows } = parse(res.text);

    expect(rows.some((r) => r.includes("LOW-1"))).toBe(true);
    expect(rows.some((r) => r.includes("FINE-1"))).toBe(false);
  });

  // GUARD G-21 — operator-entered text reaches a file someone opens in Excel.
  it("neutralises a medicine name that would run as a formula", async () => {
    const { token } = await signIn(app);
    const { medicine, supplier } = await makeMedicine({
      name: '=HYPERLINK("http://evil.example","click")',
    });
    await makeBatch({
      medicineId: medicine.id,
      supplierId: supplier.id,
      batchNumber: "INJ-1",
      quantity: 2,
    });

    const res = await get(token, "/api/inventory/batches/low-stock/export?threshold=10");
    const row = parse(res.text).rows.find((r) => r.includes("INJ-1"));

    // Quoted because it contains a comma, and prefixed so Excel treats it as
    // text rather than evaluating it.
    expect(row.startsWith("\"'=HYPERLINK")).toBe(true);
  });
});
