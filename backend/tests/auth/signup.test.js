import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import prisma from "../../src/config/db.js";
import {
  buildApp,
  makeUser,
  makeShop,
  makeMasters,
  makeMedicine,
  makeBatch,
  makeSellable,
  signIn,
  line,
  PASSWORD,
} from "../helpers/factory.js";

/**
 * `POST /api/auth/signup` — a new shopkeeper's own shop, self-serve
 * (FR-AUTH-12, revised for multi-tenancy).
 *
 * Unlike the single-tenant bootstrap this replaced, the endpoint stays open
 * forever and is expected to succeed any number of times — each call creates
 * its own Shop. What matters here is that every signup gets its own, fully
 * isolated shop: two calls must never share so much as a Category row, and
 * nothing in the request can aim a signup at an existing shop.
 */

let app;
beforeAll(() => {
  app = buildApp();
});

const GOOD = {
  shopName: "Nair Medical Store",
  name: "Priya Nair",
  email: "priya@pharmacy.local",
  password: "a-well-chosen-passphrase",
};

const signup = (body = GOOD) =>
  request(app).post("/api/auth/signup").send(body);
const cookieOf = (res) =>
  (res.headers["set-cookie"] ?? []).find((c) => c.startsWith("refresh_token="));

describe("POST /api/auth/signup — creating a shop", () => {
  it("creates a shop and its ADMIN, and signs them straight in", async () => {
    const res = await signup();

    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({
      email: GOOD.email,
      name: GOOD.name,
      role: "ADMIN",
    });

    // A shop with no administrator cannot create one, so the first account has
    // to be able to administer.
    const row = await prisma.user.findUnique({ where: { email: GOOD.email } });
    expect(row.role).toBe("ADMIN");
    expect(row.isActive).toBe(true);

    const shop = await prisma.shop.findUnique({ where: { id: row.shopId } });
    expect(shop.name).toBe(GOOD.shopName);
  });

  // Unlike the seeded admin and unlike an administrator's reset, both of which
  // hand someone a credential they did not choose. This one they chose.
  it("does not force a password change", async () => {
    const res = await signup();

    expect(res.body.data.user.mustChangePassword).toBe(false);
    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${res.body.data.token}`);
    expect(me.status).toBe(200);

    // Proof it is not merely unflagged but actually unblocked: a route the
    // forced-change middleware guards answers normally.
    const users = await request(app)
      .get("/api/users")
      .set("Authorization", `Bearer ${res.body.data.token}`);
    expect(users.status).toBe(200);
  });

  it("opens a real session, both halves", async () => {
    const res = await signup();

    expect(res.body.data.token).toBeTruthy();
    const cookie = cookieOf(res);
    expect(cookie).toBeTruthy();
    expect(cookie).toMatch(/HttpOnly/i);
    // The refresh cookie has to work, or the operator is signed out thirty
    // minutes into setting the shop up — the C-1 failure, in the one place it
    // would be least explicable.
    expect(
      (await request(app).post("/api/auth/refresh").set("Cookie", cookie))
        .status,
    ).toBe(200);
  });

  it("never returns the password hash", async () => {
    const res = await signup();
    expect(JSON.stringify(res.body)).not.toContain("$2");
    expect(res.body.data.user.password).toBeUndefined();
  });

  it("lets the new admin sign in with the password they chose", async () => {
    await signup();
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: GOOD.email, password: GOOD.password });

    expect(login.status).toBe(200);
    expect(login.body.data.user.role).toBe("ADMIN");
  });
});

describe("POST /api/auth/signup — every call opens its own shop", () => {
  it("succeeds again for a second shopkeeper, with their own shop", async () => {
    const first = await signup();

    const second = await signup({
      shopName: "Verma Pharmacy",
      name: "Someone Else",
      email: "intruder@elsewhere.test",
      password: "another-long-passphrase",
    });

    expect(second.status).toBe(201);
    expect(await prisma.user.count()).toBe(2);
    expect(await prisma.shop.count()).toBe(2);

    const firstUser = await prisma.user.findUnique({
      where: { email: GOOD.email },
    });
    const secondUser = await prisma.user.findUnique({
      where: { email: "intruder@elsewhere.test" },
    });
    expect(firstUser.shopId).not.toBe(secondUser.shopId);
    void first;
  });

  it("keeps two shops' data apart from the first request onward", async () => {
    const a = await signup({ ...GOOD, shopName: "Shop A" });
    const b = await signup({
      shopName: "Shop B",
      name: "Owner B",
      email: "owner-b@test.local",
      password: "another-long-passphrase",
    });

    // /api/inventory/categories, not /api/categories: the 2.0.0 resource layout
    // keeps batches, categories and manufacturers under /api/inventory, because
    // each is a stock-keeping concern reached through the medicine it belongs
    // to. This test posted to the top-level path for its first three days and
    // 404'd there, so the assertion below was never reached.
    const category = await request(app)
      .post("/api/inventory/categories")
      .set("Authorization", `Bearer ${a.body.data.token}`)
      .send({ name: "Antibiotics" });
    expect(category.status).toBe(201);

    const asB = await request(app)
      .get("/api/inventory/categories")
      .set("Authorization", `Bearer ${b.body.data.token}`);
    expect(asB.body.data).toEqual([]);
  });

  it("creates a fresh account under a concurrent burst, one shop each", async () => {
    const attempts = Array.from({ length: 8 }, (_, i) =>
      signup({
        shopName: `Racer Pharmacy ${i}`,
        name: `Racer ${i}`,
        email: `racer-${i}@test.local`,
        password: "a-well-chosen-passphrase",
      }),
    );

    const results = await Promise.all(attempts);

    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(results.some((r) => r.status >= 500)).toBe(false);
    expect(await prisma.user.count()).toBe(8);
    expect(await prisma.shop.count()).toBe(8);
  });
});

describe("POST /api/auth/signup — validation", () => {
  it.each([
    ["a short password", { ...GOOD, password: "short" }],
    ["a blocklisted password", { ...GOOD, password: "administrator" }],
    [
      "the credential published in this repo",
      { ...GOOD, password: "admin123admin123" },
    ],
    [
      "a password containing the account's own name",
      { ...GOOD, password: "priya-nair-priya" },
    ],
    ["a malformed email", { ...GOOD, email: "not-an-email" }],
    [
      "a missing name",
      { shopName: GOOD.shopName, email: GOOD.email, password: GOOD.password },
    ],
    [
      "a missing shop name",
      { name: GOOD.name, email: GOOD.email, password: GOOD.password },
    ],
  ])("rejects %s", async (_label, body) => {
    const res = await signup(body);

    expect(res.status).toBe(400);
    // Nothing may be created by a rejected signup.
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.shop.count()).toBe(0);
  });

  // Strict, so this is a 400 rather than a silent strip. A caller who thinks
  // they chose their own role should be told they did not, not left believing
  // it worked — that is the reading that looks like privilege escalation.
  it("rejects an attempt to choose a role", async () => {
    const res = await signup({ ...GOOD, role: "CASHIER" });

    expect(res.status).toBe(400);
    expect(await prisma.user.count()).toBe(0);
  });

  // Rejected outright, not silently ignored — accepting and ignoring a shopId
  // would look like it let a caller join an existing shop when it did not,
  // which is a worse failure mode than a 400.
  it("rejects an attempt to name an existing shop", async () => {
    const first = await signup();
    const shopId = (
      await prisma.user.findUnique({ where: { email: GOOD.email } })
    ).shopId;

    const res = await signup({
      shopName: "Shop B",
      name: "Intruder",
      email: "intruder@test.local",
      password: "another-long-passphrase",
      shopId,
    });

    expect(res.status).toBe(400);
    void first;
  });

  it("reports a rejected password once, not twice", async () => {
    const res = await signup({ ...GOOD, password: "administrator" });

    const onPassword = res.body.errors.filter((e) => e.field === "password");
    expect(onPassword).toHaveLength(1);
  });
});

describe("POST /api/auth/signup — it is not a second way in", () => {
  it("cannot be used to take over an existing account's email", async () => {
    const existing = await makeUser({
      role: "ADMIN",
      email: "owner@test.local",
    });

    const res = await signup({ ...GOOD, email: "owner@test.local" });

    expect(res.status).toBe(409);
    // The original password still works: nothing was overwritten, and no
    // orphan Shop was left behind from the rejected attempt.
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: existing.email, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(await prisma.shop.count()).toBe(1);
  });
});

/**
 * The tenant boundary, swept across the resource controllers.
 *
 * The test above proves it holds from the signup request onward. This proves it
 * holds everywhere afterwards, which is a different claim and the one that has
 * to survive every future change: a `where` clause that forgets `shopId` leaks
 * one shop's customers, stock and takings into another's screen, and nothing
 * about the response would look wrong to whoever reads it.
 *
 * Both shops are built through the factory rather than through signup — the
 * behaviour under test is the same, and this pays for two cost-4 hashes instead
 * of two cost-12 ones.
 *
 * **A failure here is not a broken test.** It is a cross-tenant leak, and the
 * fix belongs in the controller the assertion names, not in this file.
 */
describe("tenant isolation across the resource controllers", () => {
  let tokenA, tokenB, shopA, shopB, aData, bMasters;

  const asB = (method, path) =>
    request(app)[method](path).set("Authorization", `Bearer ${tokenB}`);

  beforeEach(async () => {
    [shopA, shopB] = await Promise.all([
      makeShop({ name: "Shop A" }),
      makeShop({ name: "Shop B" }),
    ]);

    // Distinct emails: User.email is globally unique, deliberately, because
    // login takes an email and a password with no shop selector.
    const [a, b] = await Promise.all([
      signIn(app, "ADMIN", { shopId: shopA.id, email: "admin-a@test.local" }),
      signIn(app, "ADMIN", { shopId: shopB.id, email: "admin-b@test.local" }),
    ]);
    tokenA = a.token;
    tokenB = b.token;

    // Shop A's world: masters, a medicine in stock, a customer and a sale.
    const masters = await makeMasters({ shopId: shopA.id });
    const { medicine } = await makeMedicine({
      masters,
      name: "A's Paracetamol",
    });
    const batch = await makeBatch({
      medicineId: medicine.id,
      supplierId: masters.supplier.id,
      shopId: shopA.id,
    });

    const customer = await request(app)
      .post("/api/customers")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ name: "A's Customer", phone: "9990000001" });
    expect(customer.status).toBe(201);

    const invoice = await request(app)
      .post("/api/billing/invoices")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        items: [line(medicine, batch, { quantity: 2 })],
        paymentMode: "CASH",
        paymentStatus: "PAID",
      });
    expect(invoice.status).toBe(201);

    aData = {
      category: masters.category,
      supplier: masters.supplier,
      medicine,
      customer: customer.body.data,
      invoice: invoice.body.data,
    };

    // B's own masters, so a PUT from B carries a body that passes validation on
    // its own merits — otherwise a 400 would masquerade as the 404 being tested.
    bMasters = await makeMasters({ shopId: shopB.id });
  });

  it("shows shop B none of shop A's rows", async () => {
    const [medicines, customers, suppliers, invoices, categories] =
      await Promise.all([
        asB("get", "/api/medicines"),
        asB("get", "/api/customers"),
        asB("get", "/api/suppliers"),
        asB("get", "/api/billing/invoices"),
        asB("get", "/api/inventory/categories"),
      ]);

    for (const res of [
      medicines,
      customers,
      suppliers,
      invoices,
      categories,
    ]) {
      expect(res.status).toBe(200);
    }

    expect(medicines.body.data).toEqual([]);
    expect(customers.body.data).toEqual([]);
    expect(invoices.body.data).toEqual([]);
    // B has masters of its own, so these are not empty — the assertion is that
    // A's rows are not among them. An `toEqual([])` here would pass for the
    // wrong reason the day B's own fixtures changed.
    expect(suppliers.body.data.map((s) => s.id)).not.toContain(
      aData.supplier.id,
    );
    expect(categories.body.data.map((c) => c.id)).not.toContain(
      aData.category.id,
    );
  });

  it("answers 404 — not 403, and not 200 — when B edits A's rows", async () => {
    const attempts = await Promise.all([
      asB("put", `/api/inventory/categories/${aData.category.id}`).send({
        name: "Hijacked",
      }),
      asB("put", `/api/suppliers/${aData.supplier.id}`).send({
        name: "Hijacked",
      }),
      asB("put", `/api/customers/${aData.customer.id}`).send({
        name: "Hijacked",
      }),
      asB("put", `/api/medicines/${aData.medicine.id}`).send({
        name: "Hijacked",
        categoryId: bMasters.category.id,
        manufacturerId: bMasters.manufacturer.id,
        unit: "tablet",
        gstPercent: 12,
      }),
    ]);

    // 404 rather than 403 is the point. A 403 would confirm the id exists,
    // which turns a guessed id into a probe for another shop's catalogue.
    for (const res of attempts) expect(res.status).toBe(404);

    // And nothing moved.
    const category = await prisma.category.findUnique({
      where: { id: aData.category.id },
    });
    expect(category.name).toBe(aData.category.name);
  });

  it("answers 404 when B deletes A's rows, and leaves them standing", async () => {
    const attempts = await Promise.all([
      asB("delete", `/api/inventory/categories/${aData.category.id}`),
      asB("delete", `/api/suppliers/${aData.supplier.id}`),
      asB("delete", `/api/medicines/${aData.medicine.id}`),
      asB("delete", `/api/customers/${aData.customer.id}`),
    ]);

    for (const res of attempts) expect(res.status).toBe(404);

    expect(
      await prisma.category.findUnique({ where: { id: aData.category.id } }),
    ).not.toBeNull();
    expect(
      await prisma.supplier.findUnique({ where: { id: aData.supplier.id } }),
    ).not.toBeNull();
    // Medicine delete is a soft delete and customer delete anonymises in place,
    // so "still there" is not enough for these two — read the field each one
    // would have changed.
    const medicine = await prisma.medicine.findUnique({
      where: { id: aData.medicine.id },
    });
    expect(medicine.isActive).toBe(true);
    const customer = await prisma.customer.findUnique({
      where: { id: aData.customer.id },
    });
    expect(customer.anonymisedAt).toBeNull();
    expect(customer.name).toBe("A's Customer");
  });

  /**
   * GUARD — the per-shop keys are the *only* uniqueness on these four columns.
   *
   * The multi-tenant migration re-keyed Category.name, Manufacturer.name,
   * Customer.phone and Invoice.invoiceNumber from global to per-shop, and tried
   * to drop the old keys with `ALTER TABLE ... DROP CONSTRAINT IF EXISTS`.
   * Prisma writes `@unique` as a bare `CREATE UNIQUE INDEX`, so that matched
   * nothing and `IF EXISTS` made the miss silent: the migration reported
   * applied with every global key still in place.
   *
   * The cost was not subtle. Serials restart at `-0001` per shop per day, so
   * with `Invoice_invoiceNumber_key` still global the **second shop to sell on
   * any day could not sell at all** — a 409 on a sale the customer had paid
   * for. Fixed by `20260830190000_drop_stale_global_unique_indexes`.
   *
   * This asserts the behaviour rather than the index list, so it fails the same
   * way if the keys ever come back by another route.
   */
  it("lets two shops hold the same names, phones and invoice numbers", async () => {
    const name = `Tablet ${Date.now()}`;
    const phone = `9${Date.now()}`.slice(0, 10);

    for (const token of [tokenA, tokenB]) {
      const category = await request(app)
        .post("/api/inventory/categories")
        .set("Authorization", `Bearer ${token}`)
        .send({ name });
      expect(category.status).toBe(201);

      const customer = await request(app)
        .post("/api/customers")
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "Shared Phone", phone });
      expect(customer.status).toBe(201);
    }

    // The one that stopped a shop trading. Shop A already sold once in the
    // beforeEach, so its series is ahead; shop B must still open its own at
    // -0001 and walk into a number A is already holding.
    const sell = async (token, shopId) => {
      const { medicine, batch } = await makeSellable({ shopId, quantity: 5 });
      const sale = await request(app)
        .post("/api/billing/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          items: [line(medicine, batch)],
          paymentMode: "CASH",
          paymentStatus: "PAID",
        });
      expect(sale.status).toBe(201);
      return sale.body.data.invoiceNumber;
    };

    const aSecond = await sell(tokenA, shopA.id);
    const bFirst = await sell(tokenB, shopB.id);
    const bSecond = await sell(tokenB, shopB.id);

    // B's series is its own and starts at 1, regardless of what A has done.
    expect(bFirst).toMatch(/-0001$/);
    expect(bSecond).toBe(aSecond);

    // And both rows genuinely exist under that one number, in different shops.
    const shared = await prisma.invoice.findMany({
      where: { invoiceNumber: aSecond },
      select: { shopId: true },
    });
    expect(shared).toHaveLength(2);
    expect(new Set(shared.map((i) => i.shopId))).toEqual(
      new Set([shopA.id, shopB.id]),
    );
  });

  it("lists only shop B's own user accounts", async () => {
    const res = await asB("get", "/api/users");

    expect(res.status).toBe(200);
    expect(res.body.data.map((u) => u.email)).toEqual(["admin-b@test.local"]);
  });

  it("reports none of shop A's takings on B's dashboard", async () => {
    const res = await asB("get", "/api/dashboard/stats");

    expect(res.status).toBe(200);
    const { summary, totals, recentInvoices } = res.body.data;
    // A sold two units at 24.50 a moment ago. None of it is B's.
    expect(Number(summary.totalSales)).toBe(0);
    expect(summary.totalInvoices).toBe(0);
    expect(recentInvoices).toEqual([]);
    expect(totals.medicines).toBe(0);
    expect(totals.customers).toBe(0);
  });
});
