import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import prisma from "../../src/config/db.js";
import { buildApp, makeUser, PASSWORD } from "../helpers/factory.js";

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

    const category = await request(app)
      .post("/api/categories")
      .set("Authorization", `Bearer ${a.body.data.token}`)
      .send({ name: "Antibiotics" });
    expect(category.status).toBe(201);

    const asB = await request(app)
      .get("/api/categories")
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
