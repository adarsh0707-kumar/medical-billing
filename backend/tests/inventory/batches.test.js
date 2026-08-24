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

// FR-BATCH-11. The counterpart to the G-05 guard above: stock still cannot move
// through the general edit, but breakage, theft and miscounts are real and need
// a path that leaves a trace.
describe("POST /api/inventory/batches/:id/adjust", () => {
  const adjust = (token, id, body) =>
    request(app)
      .post(`/api/inventory/batches/${id}/adjust`)
      .set("Authorization", `Bearer ${token}`)
      .send(body);

  const aBatch = async (quantity = 40) => {
    const { medicine, supplier } = await makeMedicine();
    return makeBatch({ medicineId: medicine.id, supplierId: supplier.id, quantity });
  };

  it("removes stock and records who, what and why", async () => {
    const { token, user } = await signIn(app, "PHARMACIST");
    const batch = await aBatch(40);

    const res = await adjust(token, batch.id, {
      delta: -3,
      reason: "Three strips crushed when the shelf collapsed",
    });

    expect(res.status).toBe(200);
    expect((await prisma.batch.findUnique({ where: { id: batch.id } })).quantity).toBe(37);

    // The whole point of the requirement: 40 → 37 on its own is not an audit
    // trail, because breakage, theft and a miscount look identical.
    const entry = await prisma.auditLog.findFirst({
      where: { model: "Batch", recordId: batch.id, action: "UPDATE" },
      orderBy: { at: "desc" },
    });
    expect(entry.actorEmail).toBe(user.email);
    expect(entry.reason).toMatch(/shelf collapsed/);
    expect(entry.before.quantity).toBe(40);
    expect(entry.after.quantity).toBe(37);
  });

  it("adds stock too, for a miscount the other way", async () => {
    const { token } = await signIn(app, "PHARMACIST");
    const batch = await aBatch(40);

    const res = await adjust(token, batch.id, {
      delta: 5,
      reason: "Recount after stocktake — five strips were behind the box",
    });

    expect(res.status).toBe(200);
    expect((await prisma.batch.findUnique({ where: { id: batch.id } })).quantity).toBe(45);
  });

  it("refuses to take stock below zero, cleanly", async () => {
    const { token } = await signIn(app, "PHARMACIST");
    const batch = await aBatch(2);

    const res = await adjust(token, batch.id, {
      delta: -5,
      reason: "Attempting to write off more than we hold",
    });

    // A 400 explaining itself, not a 500 from the database CHECK constraint
    // (Batch_quantity_non_negative) — the constraint is the backstop, not the
    // user-facing rule.
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cannot go negative/i);
    expect((await prisma.batch.findUnique({ where: { id: batch.id } })).quantity).toBe(2);
  });

  it("takes a batch to exactly zero", async () => {
    const { token } = await signIn(app, "PHARMACIST");
    const batch = await aBatch(2);

    const res = await adjust(token, batch.id, {
      delta: -2,
      reason: "Both remaining strips expired and were destroyed",
    });

    expect(res.status).toBe(200);
    expect((await prisma.batch.findUnique({ where: { id: batch.id } })).quantity).toBe(0);
  });

  it.each([
    ["no reason at all", { delta: -1 }],
    ["a reason too short to mean anything", { delta: -1, reason: "oops" }],
    ["a zero adjustment", { delta: 0, reason: "Nothing actually happened here" }],
    ["a fractional adjustment", { delta: -1.5, reason: "Half a strip went missing" }],
    ["an unknown field", { delta: -1, reason: "Padding out the reason field", quantity: 5 }],
  ])("refuses %s", async (_label, body) => {
    const { token } = await signIn(app, "PHARMACIST");
    const batch = await aBatch(40);

    expect((await adjust(token, batch.id, body)).status).toBe(400);
    expect((await prisma.batch.findUnique({ where: { id: batch.id } })).quantity).toBe(40);
  });

  it("is closed to cashiers", async () => {
    const { token: pharmacist } = await signIn(app, "PHARMACIST");
    const batch = await aBatch(40);
    const { token: cashier } = await signIn(app, "CASHIER");

    expect(
      (await adjust(cashier, batch.id, { delta: -1, reason: "Should not be permitted" })).status,
    ).toBe(403);
    expect((await prisma.batch.findUnique({ where: { id: batch.id } })).quantity).toBe(40);
    // The pharmacist who does handle stock still can.
    expect(
      (await adjust(pharmacist, batch.id, { delta: -1, reason: "Damaged in transit from the store room" })).status,
    ).toBe(200);
  });

  it("404s for a batch that does not exist", async () => {
    const { token } = await signIn(app, "PHARMACIST");
    expect((await adjust(token, "nope", { delta: -1, reason: "No such batch exists" })).status).toBe(404);
  });

  it("does not weaken the G-05 guard on the update route", async () => {
    const { token } = await signIn(app, "PHARMACIST");
    const batch = await aBatch(40);

    // Adding an adjustment path must not make the general edit permissive: the
    // two exist precisely so stock cannot move without a stated reason.
    const res = await request(app)
      .put(`/api/inventory/batches/${batch.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ quantity: 99999 });

    expect(res.status).toBe(400);
    expect((await prisma.batch.findUnique({ where: { id: batch.id } })).quantity).toBe(40);
  });
});
