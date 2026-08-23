import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import prisma from "../../src/config/db.js";
import { buildApp, signIn, makeUser, tokenFor } from "../helpers/factory.js";

let app;
beforeAll(() => {
  app = buildApp();
});

const as = (token, method, path, body) =>
  request(app)[method](path).set("Authorization", `Bearer ${token}`).send(body);

const newUser = { name: "Priya", email: "priya@test.local", password: "long-enough-pw", role: "PHARMACIST" };

describe("POST /api/users", () => {
  it("creates a user without ever echoing the hash", async () => {
    const { token } = await signIn(app);

    const res = await as(token, "post", "/api/users", newUser);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ email: newUser.email, role: "PHARMACIST" });
    expect(res.body.data.password).toBeUndefined();
  });

  it("defaults to the least-privileged role", async () => {
    const { token } = await signIn(app);
    const { role, ...withoutRole } = newUser;

    const res = await as(token, "post", "/api/users", withoutRole);
    expect(res.body.data.role).toBe("CASHIER");
  });

  // Regression guard for G-11: these routes had no schema at all, so a bad role
  // reached Prisma and came back as a 500.
  it.each([
    ["a malformed email", { email: "not-an-email" }],
    ["a password under 12 characters", { password: "short-one11" }],
    ["an invented role", { role: "SUPERUSER" }],
    ["a one-character name", { name: "P" }],
    ["no password", { password: undefined }],
  ])("refuses %s with a 400", async (_label, override) => {
    const { token } = await signIn(app);

    const res = await as(token, "post", "/api/users", { ...newUser, ...override });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Validation failed");
  });

  // Guards docs/07 A-4 / P1-6. The policy was a length floor of 8 and nothing
  // else, so `admin123` — the credential published in this repository — was an
  // acceptable choice for a new account.
  //
  // Deliberately no character-class rules: NIST SP 800-63B advises against them
  // because they push people to `Password1!` shapes that dictionaries already
  // hold. The length floor and a blocklist do the work instead.
  it.each([
    ["one of the most common passwords", "administrator"],
    ["the seeded credential, padded to length", "admin123admin123"],
    ["a common password stretched with digits", "password1234"],
    ["a common password stretched with a year", "pharmacy2026"],
    ["a single repeated character", "aaaaaaaaaaaa"],
    ["a straight alphabet run", "abcdefghijkl"],
    ["the account's own email address", "priya-is-here"],
    ["the account's own name", "Priya-Priya-1"],
  ])("refuses %s", async (_label, password) => {
    const { token } = await signIn(app);

    const res = await as(token, "post", "/api/users", { ...newUser, password });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Validation failed");
    expect(res.body.errors.some((e) => e.field === "password")).toBe(true);
  });

  it("accepts a long, unremarkable passphrase", async () => {
    const { token } = await signIn(app);

    const res = await as(token, "post", "/api/users", {
      ...newUser,
      password: "correct horse battery staple",
    });

    // The corollary of dropping character-class rules: a passphrase with no
    // digits or symbols is a good password and must not be refused.
    expect(res.status).toBe(201);
  });

  it("rejects a duplicate email", async () => {
    const { token } = await signIn(app);
    await as(token, "post", "/api/users", newUser);

    expect((await as(token, "post", "/api/users", newUser)).status).toBe(409);
  });
});

describe("PUT /api/users/:id", () => {
  it("accepts the whole user row, as the active/inactive toggle sends it", async () => {
    const { token } = await signIn(app);
    const created = (await as(token, "post", "/api/users", newUser)).body.data;

    const res = await as(token, "put", `/api/users/${created.id}`, { ...created, isActive: false });

    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(false);
  });

  it("still enforces the role enum on update", async () => {
    const { token } = await signIn(app);
    const created = (await as(token, "post", "/api/users", newUser)).body.data;

    expect((await as(token, "put", `/api/users/${created.id}`, { role: "GOD" })).status).toBe(400);
  });

  it("404s for a user that does not exist", async () => {
    const { token } = await signIn(app);
    expect((await as(token, "put", "/api/users/nope", { name: "Whoever" })).status).toBe(404);
  });
});

describe("DELETE /api/users/:id", () => {
  it("deletes another user", async () => {
    const { token } = await signIn(app);
    const created = (await as(token, "post", "/api/users", newUser)).body.data;

    expect((await as(token, "delete", `/api/users/${created.id}`)).status).toBe(200);
    expect(await prisma.user.findUnique({ where: { id: created.id } })).toBeNull();
  });

  it("refuses to let an admin delete themselves", async () => {
    const { token, user } = await signIn(app);

    const res = await as(token, "delete", `/api/users/${user.id}`);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/your own account/i);
  });
});

describe("PUT /api/users/profile", () => {
  it("updates the caller's own name and email", async () => {
    const { token, user } = await signIn(app, "CASHIER");

    const res = await as(token, "put", "/api/users/profile", { name: "New Name", email: "new@test.local" });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: user.id, name: "New Name", email: "new@test.local" });
  });

  // Strict schema here: a stray `role` must not look accepted while being
  // silently dropped, which would read like a privilege-escalation hole.
  it("rejects an attempt to smuggle in a role change", async () => {
    const { token, user } = await signIn(app, "CASHIER");

    const res = await as(token, "put", "/api/users/profile", { name: "Sneaky", role: "ADMIN" });

    expect(res.status).toBe(400);
    expect((await prisma.user.findUnique({ where: { id: user.id } })).role).toBe("CASHIER");
  });

  it("refuses an email another user already holds", async () => {
    const { token } = await signIn(app, "CASHIER");
    await makeUser({ role: "PHARMACIST", email: "taken@test.local" });

    expect((await as(token, "put", "/api/users/profile", { email: "taken@test.local" })).status).toBe(409);
  });
});

describe("GET /api/users", () => {
  it("lists users without their hashes", async () => {
    const { token } = await signIn(app);
    await makeUser({ role: "CASHIER", email: "c@test.local" });

    const res = await as(token, "get", "/api/users");

    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(res.body)).not.toContain("$2");
  });
});

// Guards docs/07 A-6 / T-13. Deactivation used to be a pause: `protect` rejects
// an inactive user, but only while the flag is set, so reactivating an account
// brought every token outstanding at deactivation back to life. Deactivating
// and reactivating is exactly what an administrator does to a compromised
// account, and it handed the attacker their session back.
describe("deactivation revokes tokens permanently", () => {
  it("does not resurrect old tokens when the account is reactivated", async () => {
    const { token: adminToken } = await signIn(app, "ADMIN");
    const victim = await makeUser({ role: "CASHIER", email: "victim@test.local" });
    const stolen = await tokenFor(victim.id);

    const me = () =>
      request(app).get("/api/auth/me").set("Authorization", `Bearer ${stolen}`);

    expect((await me()).status).toBe(200);

    await request(app)
      .put(`/api/users/${victim.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ isActive: false });
    expect((await me()).status).toBe(401);

    await request(app)
      .put(`/api/users/${victim.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ isActive: true });

    // The account works again; the token that was live when it was suspended
    // does not.
    expect((await me()).status).toBe(401);
  });

  it("leaves sessions alone when an unrelated field changes", async () => {
    const { token: adminToken } = await signIn(app, "ADMIN");
    const staff = await makeUser({ role: "CASHIER", email: "renamed@test.local" });
    const session = await tokenFor(staff.id);

    await request(app)
      .put(`/api/users/${staff.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "New Name" });

    // Renaming somebody must not sign them out.
    expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${session}`)).status).toBe(200);
  });
});
