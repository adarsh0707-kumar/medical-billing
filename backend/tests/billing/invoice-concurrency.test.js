import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import prisma from "../../src/config/db.js";
import { buildApp, signIn, makeSellable, line } from "../helpers/factory.js";

let app;
beforeAll(() => {
  app = buildApp();
});

const sell = (token, medicine, batch, quantity = 1) =>
  request(app)
    .post("/api/billing/invoices")
    .set("Authorization", `Bearer ${token}`)
    .send({ items: [line(medicine, batch, { quantity })] });

// Two counters billing at once is normal operation for a pharmacy, and it used
// to corrupt both stock and invoice numbering. These are regression guards for
// G-09 and G-01 — if either fix is undone, these fail.
describe("concurrent checkout", () => {
  it("lets exactly one of two simultaneous sales take the last unit", async () => {
    const { token } = await signIn(app);
    const { medicine, batch } = await makeSellable({ quantity: 1 });

    const results = await Promise.all([
      sell(token, medicine, batch),
      sell(token, medicine, batch),
    ]);
    const statuses = results.map((r) => r.status).sort();

    expect(statuses).toEqual([201, 400]);
    expect((await prisma.batch.findUnique({ where: { id: batch.id } })).quantity).toBe(0);
    expect(await prisma.invoice.count()).toBe(1);
  });

  it("never drives stock negative under a burst of oversell attempts", async () => {
    const { token } = await signIn(app);
    const { medicine, batch } = await makeSellable({ quantity: 10 });

    const results = await Promise.all(
      Array.from({ length: 12 }, () => sell(token, medicine, batch)),
    );

    const created = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 400);
    expect(created).toHaveLength(10);
    expect(rejected).toHaveLength(2);
    expect(results.filter((r) => r.status === 409)).toHaveLength(0);

    const after = await prisma.batch.findUnique({ where: { id: batch.id } });
    expect(after.quantity).toBe(0);
    expect(after.quantity).toBeGreaterThanOrEqual(0);
  });

  it("issues a distinct, gapless serial to every concurrent sale", async () => {
    const { token } = await signIn(app);
    const { medicine, batch } = await makeSellable({ quantity: 100 });

    const results = await Promise.all(
      Array.from({ length: 20 }, () => sell(token, medicine, batch)),
    );

    expect(results.every((r) => r.status === 201)).toBe(true);

    const serials = results
      .map((r) => Number(r.body.data.invoiceNumber.slice(-4)))
      .sort((a, b) => a - b);
    expect(new Set(serials).size).toBe(20);
    expect(serials).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("returns the number to the pool when a sale rolls back", async () => {
    const { token } = await signIn(app);
    const plenty = await makeSellable({ quantity: 100 });
    const empty = await makeSellable({ quantity: 1 });

    const first = await sell(token, plenty.medicine, plenty.batch);
    expect(first.body.data.invoiceNumber).toMatch(/-0001$/);

    // This one fails inside the transaction, so its serial must not be consumed.
    const failed = await sell(token, empty.medicine, empty.batch, 5);
    expect(failed.status).toBe(400);

    const second = await sell(token, plenty.medicine, plenty.batch);
    expect(second.body.data.invoiceNumber).toMatch(/-0002$/);
  });
});
