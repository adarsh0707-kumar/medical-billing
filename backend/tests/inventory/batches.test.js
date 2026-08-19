import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import prisma from "../../src/config/db.js";
import { buildApp, signIn, makeMedicine, makeBatch } from "../helpers/factory.js";

let app;
beforeAll(() => {
  app = buildApp();
});

const get = (token, path) => request(app).get(path).set("Authorization", `Bearer ${token}`);
const post = (token, body) =>
  request(app).post("/api/inventory/batches").set("Authorization", `Bearer ${token}`).send(body);

const daysFromNow = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
};

describe("POST /api/inventory/batches", () => {
  const body = (medicine, supplier, extra = {}) => ({
    medicineId: medicine.id,
    supplierId: supplier.id,
    batchNumber: "B1",
    expiryDate: "2028-12-31",
    purchasePrice: 18.4,
    sellingPrice: 24.5,
    quantity: 200,
    ...extra,
  });

  it("records opening stock separately so depletion stays measurable", async () => {
    const { token } = await signIn(app);
    const { medicine, supplier } = await makeMedicine();

    const res = await post(token, body(medicine, supplier));

    expect(res.status).toBe(201);
    const row = await prisma.batch.findFirst();
    expect(row.quantity).toBe(200);
    expect(row.initialQty).toBe(200);
  });

  // Regression guard for G-04: the column and controller supported mfgDate, but
  // it was missing from the schema, and Zod drops undeclared keys silently.
  it("stores the manufacture date it was given", async () => {
    const { token } = await signIn(app);
    const { medicine, supplier } = await makeMedicine();

    await post(token, body(medicine, supplier, { mfgDate: "2026-06-30" }));

    const row = await prisma.batch.findFirst();
    expect(row.mfgDate).not.toBeNull();
    expect(row.mfgDate.toISOString().slice(0, 10)).toBe("2026-06-30");
  });

  it("refuses a manufacture date after the expiry date", async () => {
    const { token } = await signIn(app);
    const { medicine, supplier } = await makeMedicine();

    const res = await post(token, body(medicine, supplier, { expiryDate: "2026-01-01", mfgDate: "2027-01-01" }));

    expect(res.status).toBe(400);
    expect(res.body.errors[0].field).toBe("mfgDate");
  });

  it("keeps batch numbers unique per medicine, but not across medicines", async () => {
    const { token } = await signIn(app);
    const first = await makeMedicine();
    const second = await makeMedicine({ masters: first });

    expect((await post(token, body(first.medicine, first.supplier))).status).toBe(201);
    expect((await post(token, body(first.medicine, first.supplier))).status).toBe(409);
    expect((await post(token, body(second.medicine, first.supplier))).status).toBe(201);
  });

  it.each([
    ["a negative price", { sellingPrice: -1 }],
    ["zero quantity", { quantity: 0 }],
    ["a fractional quantity", { quantity: 1.5 }],
    ["an unparseable expiry", { expiryDate: "not-a-date" }],
  ])("refuses %s", async (_label, override) => {
    const { token } = await signIn(app);
    const { medicine, supplier } = await makeMedicine();

    expect((await post(token, body(medicine, supplier, override))).status).toBe(400);
  });
});

// Regression guard for G-05. This route had no validator at all, so any column
// could be rewritten — including stock, silently and untraceably.
describe("PUT /api/inventory/batches/:id", () => {
  const put = (token, id, body) =>
    request(app).put(`/api/inventory/batches/${id}`).set("Authorization", `Bearer ${token}`).send(body);

  it("accepts a price correction", async () => {
    const { token } = await signIn(app);
    const { medicine, supplier } = await makeMedicine();
    const batch = await makeBatch({ medicineId: medicine.id, supplierId: supplier.id });

    const res = await put(token, batch.id, { sellingPrice: 30.5 });

    expect(res.status).toBe(200);
    const row = await prisma.batch.findUnique({ where: { id: batch.id } });
    expect(Number(row.sellingPrice)).toBe(30.5);
    expect(row.quantity).toBe(batch.quantity);
  });

  it.each([
    ["stock quantity", { quantity: 99999 }],
    ["opening quantity", { initialQty: 1 }],
    ["the medicine it belongs to", { medicineId: "someone-else" }],
    ["the supplier it came from", { supplierId: "someone-else" }],
  ])("refuses to rewrite %s", async (_label, body) => {
    const { token } = await signIn(app);
    const { medicine, supplier } = await makeMedicine();
    const batch = await makeBatch({ medicineId: medicine.id, supplierId: supplier.id, quantity: 100 });

    const res = await put(token, batch.id, body);

    expect(res.status).toBe(400);
    const row = await prisma.batch.findUnique({ where: { id: batch.id } });
    expect(row.quantity).toBe(100);
    expect(row.medicineId).toBe(medicine.id);
  });
});

describe("expiry and low-stock alerts", () => {
  it("includes a batch inside the window and excludes one outside it", async () => {
    const { token } = await signIn(app);
    const { medicine, supplier } = await makeMedicine();
    await makeBatch({ medicineId: medicine.id, supplierId: supplier.id, batchNumber: "SOON", expiryDate: daysFromNow(29) });
    await makeBatch({ medicineId: medicine.id, supplierId: supplier.id, batchNumber: "LATER", expiryDate: daysFromNow(31) });

    const res = await get(token, "/api/inventory/batches/expiring?days=30");

    expect(res.body.data.map((b) => b.batchNumber)).toEqual(["SOON"]);
  });

  it("ignores already-expired and sold-out batches", async () => {
    const { token } = await signIn(app);
    const { medicine, supplier } = await makeMedicine();
    await makeBatch({ medicineId: medicine.id, supplierId: supplier.id, batchNumber: "GONE", expiryDate: daysFromNow(-5) });
    await makeBatch({ medicineId: medicine.id, supplierId: supplier.id, batchNumber: "EMPTY", expiryDate: daysFromNow(5), quantity: 0 });

    expect((await get(token, "/api/inventory/batches/expiring?days=30")).body.data).toEqual([]);
  });

  it("treats the low-stock threshold as inclusive, and skips empty batches", async () => {
    const { token } = await signIn(app);
    const { medicine, supplier } = await makeMedicine();
    await makeBatch({ medicineId: medicine.id, supplierId: supplier.id, batchNumber: "AT", quantity: 10 });
    await makeBatch({ medicineId: medicine.id, supplierId: supplier.id, batchNumber: "OVER", quantity: 11 });
    await makeBatch({ medicineId: medicine.id, supplierId: supplier.id, batchNumber: "EMPTY", quantity: 0 });

    const res = await get(token, "/api/inventory/batches/low-stock?threshold=10");

    expect(res.body.data.map((b) => b.batchNumber)).toEqual(["AT"]);
  });
});
