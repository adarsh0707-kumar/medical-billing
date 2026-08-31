import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import prisma from "../../src/config/db.js";
import { buildApp, signIn } from "../helpers/factory.js";
import {
  run,
  findExpired,
  cutoffDate,
} from "../../src/utils/audit-retention.js";
import { eraseCustomer } from "../../src/utils/erase-customer.js";

/**
 * Audit-log retention — NFR-17, docs/03 §3.12.
 *
 * The policy was decided at 24 months on 2026-08-22 and had nothing enforcing
 * it until 2026-08-31, so four documents described a rule that was not in force.
 */

let app;
beforeAll(() => {
  app = buildApp();
});

const as = (token, method, path, body) =>
  request(app)[method](path).set("Authorization", `Bearer ${token}`).send(body);

/** An audit row of a given age, written directly — `AuditLog` is not audited. */
const auditRow = async (monthsAgo, over = {}) => {
  const at = new Date();
  at.setMonth(at.getMonth() - monthsAgo);
  return prisma.auditLog.create({
    data: {
      at,
      action: "UPDATE",
      model: "Batch",
      recordId: `rec-${Math.random().toString(36).slice(2)}`,
      before: { sellingPrice: "10.00" },
      after: { sellingPrice: "12.00" },
      ...over,
    },
  });
};

describe("audit retention sweep", () => {
  it("selects rows older than the window and leaves the rest", async () => {
    const stale = await auditRow(30);
    const fresh = await auditRow(3);

    const { count } = await findExpired(cutoffDate(24));
    expect(count).toBe(1);

    await run({ apply: true });

    expect(await prisma.auditLog.findUnique({ where: { id: stale.id } })).toBeNull();
    expect(await prisma.auditLog.findUnique({ where: { id: fresh.id } })).not.toBeNull();
  });

  // The boundary, both sides of it. A retention rule that is a month out is
  // wrong in the direction nobody notices until the rows are gone.
  it("keeps a row just inside the window and removes one just outside", async () => {
    const inside = await auditRow(23);
    const outside = await auditRow(25);

    await run({ apply: true });

    expect(await prisma.auditLog.findUnique({ where: { id: inside.id } })).not.toBeNull();
    expect(await prisma.auditLog.findUnique({ where: { id: outside.id } })).toBeNull();
  });

  it("reports the oldest row and how old it is", async () => {
    await auditRow(40);
    await auditRow(30);

    const { count, oldest } = await findExpired(cutoffDate(24));

    expect(count).toBe(2);
    // The dry run prints this so an operator can see what they are about to
    // lose before they lose it, rather than a bare count.
    expect(oldest.at.getTime()).toBeLessThan(cutoffDate(35).getTime());
  });

  it("changes nothing unless asked to apply", async () => {
    const stale = await auditRow(30);

    // Deleting an audit trail is irreversible, and a tool that does it because
    // somebody was exploring is a bad tool.
    const dry = await run({ apply: false });
    expect(dry.considered).toBe(1);
    expect(dry.deleted).toBe(0);
    expect(await prisma.auditLog.findUnique({ where: { id: stale.id } })).not.toBeNull();

    const applied = await run({ apply: true });
    expect(applied.deleted).toBe(1);
    expect(await prisma.auditLog.findUnique({ where: { id: stale.id } })).toBeNull();
  });

  it("writes no audit rows of its own", async () => {
    await auditRow(30);
    const fresh = await auditRow(1);

    await run({ apply: true });

    // `AuditLog` is deliberately absent from the audited model set, so the
    // sweep's own deleteMany records nothing. A purge that audited itself could
    // never shrink the table — it would replace every row it removed.
    const remaining = await prisma.auditLog.findMany();
    expect(remaining.map((r) => r.id)).toEqual([fresh.id]);
  });

  // ─── The interaction with customer erasure ────────────────────────────────
  //
  // `erase-customer.js` redacts an erased customer's audit payloads in place,
  // so both it and this sweep act on the same rows. The conclusion recorded in
  // `audit-retention.js` is that the sweep cannot undermine erasure, because
  // deleting a row is strictly stronger than redacting it and nothing depends
  // on a row still being there. These assert that rather than trusting it.
  describe("customer erasure", () => {
    const makeCustomer = (token) =>
      as(token, "post", "/api/billing/customers", {
        name: "Sunita Rao",
        phone: `98${Math.floor(10000000 + Math.random() * 89999999)}`,
        email: "sunita@example.in",
        address: "14 Nehru Road",
        age: 61,
        gender: "FEMALE",
      });

    it("still erases cleanly when the customer's audit rows have aged out first", async () => {
      const { token } = await signIn(app, "ADMIN");
      const customer = (await makeCustomer(token)).body.data;

      // Age the CREATE row the API just wrote past the window and sweep it, so
      // erasure arrives to find nothing left to redact.
      await prisma.auditLog.updateMany({
        where: { model: "Customer", recordId: customer.id },
        data: { at: new Date("2020-01-01") },
      });
      await run({ apply: true });
      expect(
        await prisma.auditLog.count({
          where: { model: "Customer", recordId: customer.id },
        }),
      ).toBe(0);

      // `redactAuditTrail` is an updateMany: matching zero rows is a no-op, not
      // a failure. If that were ever not true, erasure would start throwing on
      // exactly the customers whose history had aged out — the ones most likely
      // to be swept.
      const result = await eraseCustomer(customer.id);
      expect(result.found).toBe(true);
      expect(result.alreadyErased).toBe(false);

      const after = await prisma.customer.findUnique({
        where: { id: customer.id },
      });
      expect(after.anonymisedAt).not.toBeNull();
      expect(after.phone).toBeNull();
    });

    it("leaves no personal data behind on either path", async () => {
      const { token } = await signIn(app, "ADMIN");
      const customer = (await makeCustomer(token)).body.data;
      const { phone } = customer;

      await prisma.auditLog.updateMany({
        where: { model: "Customer", recordId: customer.id },
        data: { at: new Date("2020-01-01") },
      });
      await run({ apply: true });
      await eraseCustomer(customer.id);

      // The purge removed the row holding the pre-erasure copy; erasure redacted
      // the row recording its own update. Neither route may leave the name or
      // the number anywhere in the table — which is the property the two
      // mechanisms exist to protect, reached here by both at once.
      const rows = await prisma.auditLog.findMany();
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain("Sunita Rao");
      expect(dump).not.toContain(phone);
    });

    it("does not exempt the row that records an erasure", async () => {
      const { token } = await signIn(app, "ADMIN");
      const customer = (await makeCustomer(token)).body.data;
      await eraseCustomer(customer.id);

      // Deliberate, and the reasoning is in audit-retention.js: the erasure's
      // own row ages on the same 24-month clock as everything else. docs/03
      // once implied it should outlive the 36-month customer window, but the
      // two clocks measure different things from different origins — 24 months
      // from this write, not from the customer's last purchase.
      await prisma.auditLog.updateMany({
        where: { model: "Customer", recordId: customer.id },
        data: { at: new Date("2020-01-01") },
      });

      const { count } = await findExpired(cutoffDate(24));
      expect(count).toBeGreaterThanOrEqual(1);

      await run({ apply: true });
      expect(
        await prisma.auditLog.count({
          where: { model: "Customer", recordId: customer.id },
        }),
      ).toBe(0);
    });
  });
});
