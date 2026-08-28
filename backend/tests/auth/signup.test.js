import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import prisma from "../../src/config/db.js";
import { buildApp, makeUser, PASSWORD } from "../helpers/factory.js";

/**
 * `POST /api/auth/signup` — the first administrator, once (FR-AUTH-12).
 *
 * The only public route that creates an account. What matters here is not that
 * it works but that it **stops** working: every authenticated role can read
 * customer records, and purchase history in a pharmacy reveals health
 * conditions, so a signup that succeeded twice would be a data breach with a
 * form in front of it.
 */

let app;
beforeAll(() => {
  app = buildApp();
});

const GOOD = {
  name: "Priya Nair",
  email: "priya@pharmacy.local",
  password: "a-well-chosen-passphrase",
};

const signup = (body = GOOD) => request(app).post("/api/auth/signup").send(body);
const cookieOf = (res) =>
  (res.headers["set-cookie"] ?? []).find((c) => c.startsWith("refresh_token="));

describe("GET /api/auth/setup-status", () => {
  it("says setup is needed when there are no users", async () => {
    const res = await request(app).get("/api/auth/setup-status");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ needsSetup: true });
  });

  it("says setup is done once any account exists", async () => {
    await makeUser({ role: "CASHIER" });
    const res = await request(app).get("/api/auth/setup-status");
    expect(res.body.data).toEqual({ needsSetup: false });
  });

  // It is public and unauthenticated, so it must be a single bit and nothing
  // more — not a count, not an email, not a timestamp.
  it("discloses one boolean and nothing else", async () => {
    await makeUser({ role: "ADMIN", email: "secret-admin@test.local" });
    const res = await request(app).get("/api/auth/setup-status");

    expect(Object.keys(res.body.data)).toEqual(["needsSetup"]);
    expect(JSON.stringify(res.body)).not.toContain("secret-admin");
  });
});

describe("POST /api/auth/signup — the first account", () => {
  it("creates an ADMIN and signs them straight in", async () => {
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
    expect((await request(app).post("/api/auth/refresh").set("Cookie", cookie)).status).toBe(200);
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

describe("POST /api/auth/signup — closing itself", () => {
  it("refuses once any account exists, whatever its role", async () => {
    await makeUser({ role: "CASHIER", email: "cashier@test.local" });

    const res = await signup();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SETUP_ALREADY_COMPLETE");
    expect(await prisma.user.count()).toBe(1);
  });

  it("refuses a second time after a successful first", async () => {
    expect((await signup()).status).toBe(201);

    const second = await signup({
      name: "Someone Else",
      email: "intruder@elsewhere.test",
      password: "another-long-passphrase",
    });

    expect(second.status).toBe(409);
    expect(await prisma.user.count()).toBe(1);
  });

  // The regression guard that matters. `count() === 0` then `create()` is a
  // read-then-write race of the same shape as G-01 and G-09: two requests
  // arriving together both read zero and both insert, leaving the installation
  // with two administrators nobody chose. One-shot endpoints get this wrong
  // because the window looks too small to matter — it is small and permanent.
  it("creates exactly one administrator under a concurrent burst", async () => {
    const attempts = Array.from({ length: 8 }, (_, i) =>
      signup({
        name: `Racer ${i}`,
        email: `racer-${i}@test.local`,
        password: "a-well-chosen-passphrase",
      }),
    );

    const results = await Promise.all(attempts);

    // The invariant is "exactly one administrator", and the losers are told
    // apart on purpose: SETUP_ALREADY_COMPLETE means somebody finished first,
    // SETUP_IN_PROGRESS means somebody is finishing right now and this caller
    // may retry. Both are 409 and neither creates anything.
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    expect(
      results
        .filter((r) => r.status === 409)
        .every((r) =>
          ["SETUP_ALREADY_COMPLETE", "SETUP_IN_PROGRESS"].includes(r.body.code),
        ),
    ).toBe(true);
    // Nothing answered 500: an earlier attempt at this used LOCK TABLE, where
    // every queued transaction held a pooled connection and the whole burst
    // died on the transaction timeout.
    expect(results.some((r) => r.status >= 500)).toBe(false);

    expect(await prisma.user.count()).toBe(1);
    expect((await prisma.user.findMany())[0].role).toBe("ADMIN");
  });

  it("stops advertising itself once it has been used", async () => {
    expect((await request(app).get("/api/auth/setup-status")).body.data.needsSetup).toBe(true);
    await signup();
    expect((await request(app).get("/api/auth/setup-status")).body.data.needsSetup).toBe(false);
  });
});

describe("POST /api/auth/signup — validation", () => {
  it.each([
    ["a short password", { ...GOOD, password: "short" }],
    ["a blocklisted password", { ...GOOD, password: "administrator" }],
    ["the credential published in this repo", { ...GOOD, password: "admin123admin123" }],
    ["a password containing the account's own name", { ...GOOD, password: "priya-nair-priya" }],
    ["a malformed email", { ...GOOD, email: "not-an-email" }],
    ["a missing name", { email: GOOD.email, password: GOOD.password }],
  ])("rejects %s", async (_label, body) => {
    const res = await signup(body);

    expect(res.status).toBe(400);
    // Nothing may be created by a rejected signup — otherwise the endpoint has
    // closed itself on a request that failed.
    expect(await prisma.user.count()).toBe(0);
  });

  // Strict, so this is a 400 rather than a silent strip. A caller who thinks
  // they chose their own role should be told they did not, not left believing
  // it worked — that is the reading that looks like privilege escalation.
  it("rejects an attempt to choose a role", async () => {
    const res = await signup({ ...GOOD, role: "CASHIER" });

    expect(res.status).toBe(400);
    expect(await prisma.user.count()).toBe(0);
  });

  it("reports a rejected password once, not twice", async () => {
    const res = await signup({ ...GOOD, password: "administrator" });

    const onPassword = res.body.errors.filter((e) => e.field === "password");
    expect(onPassword).toHaveLength(1);
  });

  it("still refuses a weak password when setup is already closed", async () => {
    await makeUser({ role: "ADMIN" });

    // Validation runs before the controller, so this is a 400 and not a 409.
    // Worth pinning: the reverse order would tell an unauthenticated caller
    // whether the installation is claimed *before* checking their input.
    const res = await signup({ ...GOOD, password: "short" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/signup — it is not a second way in", () => {
  it("cannot be used to take over an existing account's email", async () => {
    const existing = await makeUser({ role: "ADMIN", email: "owner@test.local" });

    const res = await signup({ ...GOOD, email: "owner@test.local" });

    expect(res.status).toBe(409);
    // The original password still works: nothing was overwritten.
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: existing.email, password: PASSWORD });
    expect(login.status).toBe(200);
  });

  it("does not resurrect signup when every account is deactivated", async () => {
    await makeUser({ role: "ADMIN", isActive: false });

    // A deactivated account is still an account. If signup keyed on "no *active*
    // users" instead, suspending the only admin would reopen public
    // registration — which is the opposite of what suspending them means.
    const res = await signup();
    expect(res.status).toBe(409);
  });
});
