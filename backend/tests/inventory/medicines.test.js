import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import prisma from "../../src/config/db.js";
import { buildApp, signIn, makeMasters, makeMedicine, makeBatch, makeSellable } from "../helpers/factory.js";

let app;
beforeAll(() => {
  app = buildApp();
});

const get = (token, path) => request(app).get(path).set("Authorization", `Bearer ${token}`);

describe("GET /api/inventory/medicines", () => {
  // Regression guard for G-10: this field once summed an array capped at one
  // element, so a medicine with three batches reported the smallest of them.
  it("reports stock across every batch, not just the nearest-expiry one", async () => {
    const { token } = await signIn(app);
    const { medicine, supplier } = await makeMedicine();
    await makeBatch({ medicineId: medicine.id, supplierId: supplier.id, batchNumber: "B1", quantity: 20, sellingPrice: 24.5, expiryDate: new Date("2027-01-31") });
    await makeBatch({ medicineId: medicine.id, supplierId: supplier.id, batchNumber: "B2", quantity: 150, sellingPrice: 25, expiryDate: new Date("2027-06-30") });
    await makeBatch({ medicineId: medicine.id, supplierId: supplier.id, batchNumber: "B3", quantity: 300, sellingPrice: 26, expiryDate: new Date("2028-01-31") });

    const res = await get(token, "/api/inventory/medicines");
    const row = res.body.data[0];

    expect(row.totalStock).toBe(470);
    // Price and expiry still come from the batch the POS would sell next.
    expect(row.nearestExpiry.slice(0, 10)).toBe("2027-01-31");
    expect(row.sellingPrice).toBe(24.5);
  });

  it("excludes sold-out batches from the total", async () => {
    const { token } = await signIn(app);
    const { medicine, supplier } = await makeMedicine();
    await makeBatch({ medicineId: medicine.id, supplierId: supplier.id, batchNumber: "A", quantity: 0 });
    await makeBatch({ medicineId: medicine.id, supplierId: supplier.id, batchNumber: "B", quantity: 5 });

    const res = await get(token, "/api/inventory/medicines");
    expect(res.body.data[0].totalStock).toBe(5);
  });

  it("reports zero stock without failing", async () => {
    const { token } = await signIn(app);
    await makeMedicine();

    const res = await get(token, "/api/inventory/medicines");
    expect(res.body.data[0].totalStock).toBe(0);
    expect(res.body.data[0].sellingPrice).toBe(0);
    expect(res.body.data[0].nearestExpiry).toBeNull();
  });

  it("searches name, generic name and HSN", async () => {
    const { token } = await signIn(app);
    const masters = await makeMasters();
    await makeMedicine({ name: "Crocin", genericName: "Paracetamol", hsnCode: "3004", masters });
    await makeMedicine({ name: "Amoxil", genericName: "Amoxicillin", hsnCode: "3005", masters });

    expect((await get(token, "/api/inventory/medicines?search=croc")).body.data).toHaveLength(1);
    expect((await get(token, "/api/inventory/medicines?search=paracet")).body.data).toHaveLength(1);
    expect((await get(token, "/api/inventory/medicines?search=3005")).body.data).toHaveLength(1);
  });

  it("paginates", async () => {
    const { token } = await signIn(app);
    const masters = await makeMasters();
    for (let i = 0; i < 5; i++) await makeMedicine({ name: `Med ${i}`, masters });

    const res = await get(token, "/api/inventory/medicines?limit=2&page=2");
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination).toMatchObject({ total: 5, pages: 3 });
  });
});

describe("GET /api/inventory/medicines/search", () => {
  it("stays quiet until there are two characters to go on", async () => {
    const { token } = await signIn(app);
    await makeSellable();

    expect((await get(token, "/api/inventory/medicines/search?q=P")).body.data).toEqual([]);
    expect((await get(token, "/api/inventory/medicines/search")).body.data).toEqual([]);
  });

  it("returns the FEFO batch inline for the POS", async () => {
    const { token } = await signIn(app);
    const { medicine, supplier } = await makeMedicine({ name: "Paracetamol 500mg" });
    await makeBatch({ medicineId: medicine.id, supplierId: supplier.id, batchNumber: "LATER", quantity: 10, expiryDate: new Date("2029-01-01"), sellingPrice: 30 });
    await makeBatch({ medicineId: medicine.id, supplierId: supplier.id, batchNumber: "SOONER", quantity: 7, expiryDate: new Date("2027-01-01"), sellingPrice: 24.5 });

    const [hit] = (await get(token, "/api/inventory/medicines/search?q=para")).body.data;

    expect(hit.batchNumber).toBe("SOONER");
    expect(hit.stock).toBe(7);
    expect(hit.sellingPrice).toBe(24.5);
  });

  it("flags a medicine with no stock instead of hiding it", async () => {
    const { token } = await signIn(app);
    await makeMedicine({ name: "Paracetamol 500mg" });

    const [hit] = (await get(token, "/api/inventory/medicines/search?q=para")).body.data;

    expect(hit.batchId).toBeNull();
    expect(hit.batchNumber).toBe("No Stock");
    expect(hit.stock).toBe(0);
  });
});

describe("medicine writes", () => {
  const validBody = (masters) => ({
    name: "Paracetamol 500mg",
    genericName: "Paracetamol",
    categoryId: masters.category.id,
    manufacturerId: masters.manufacturer.id,
    hsnCode: "3004",
    unit: "tablet",
    gstPercent: 12,
    isScheduledH: false,
  });

  it("creates a medicine", async () => {
    const { token } = await signIn(app);
    const masters = await makeMasters();

    const res = await request(app)
      .post("/api/inventory/medicines")
      .set("Authorization", `Bearer ${token}`)
      .send(validBody(masters));

    expect(res.status).toBe(201);
    expect(res.body.data.category.id).toBe(masters.category.id);
  });

  it.each([
    ["an unlisted unit", { unit: "bottle" }],
    ["an unlisted GST rate", { gstPercent: 7 }],
    ["a one-character name", { name: "P" }],
    ["no category", { categoryId: "" }],
  ])("refuses %s", async (_label, override) => {
    const { token } = await signIn(app);
    const masters = await makeMasters();

    const res = await request(app)
      .post("/api/inventory/medicines")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...validBody(masters), ...override });

    expect(res.status).toBe(400);
  });

  // Soft delete: invoice history must survive the product being retired.
  it("hides a deleted medicine but keeps its rows", async () => {
    const { token } = await signIn(app);
    const { medicine } = await makeSellable();

    const del = await request(app)
      .delete(`/api/inventory/medicines/${medicine.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(200);

    expect((await get(token, "/api/inventory/medicines")).body.data).toHaveLength(0);
    expect((await get(token, "/api/inventory/medicines/search?q=para")).body.data).toHaveLength(0);

    const row = await prisma.medicine.findUnique({ where: { id: medicine.id } });
    expect(row.isActive).toBe(false);
    expect(await prisma.batch.count({ where: { medicineId: medicine.id } })).toBe(1);
  });
});
