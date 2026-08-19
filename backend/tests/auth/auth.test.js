import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import prisma from "../../src/config/db.js";
import { buildApp, makeUser, signIn, PASSWORD } from "../helpers/factory.js";

let app;
beforeAll(() => {
  app = buildApp();
});

describe("POST /api/auth/login", () => {
  it("returns a token and the user for valid credentials", async () => {
    const user = await makeUser({ role: "PHARMACIST" });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toEqual(expect.any(String));
    expect(res.body.data.user).toMatchObject({
      id: user.id,
      email: user.email,
      role: "PHARMACIST",
    });
  });

  it("never returns the password hash", async () => {
    const user = await makeUser();
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: PASSWORD });

    expect(JSON.stringify(res.body)).not.toContain("$2");
    expect(res.body.data.user.password).toBeUndefined();
  });

  // An attacker must not be able to tell a real account from a fake one, or a
  // disabled account from a wrong password.
  it("gives the same answer for unknown email, wrong password and disabled user", async () => {
    await makeUser({ email: "real@test.local" });
    await makeUser({ email: "disabled@test.local", isActive: false, role: "CASHIER" });

    const [unknown, wrong, disabled] = await Promise.all([
      request(app).post("/api/auth/login").send({ email: "nobody@test.local", password: PASSWORD }),
      request(app).post("/api/auth/login").send({ email: "real@test.local", password: "nope" }),
      request(app).post("/api/auth/login").send({ email: "disabled@test.local", password: PASSWORD }),
    ]);

    for (const res of [unknown, wrong, disabled]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ success: false, message: "Invalid credentials." });
    }
  });

  it("rejects a missing field with 400", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "a@b.c" });
    expect(res.status).toBe(400);
  });
});

describe("token handling", () => {
  it("accepts a valid token on a protected route", async () => {
    const { token, user } = await signIn(app, "CASHIER");
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(user.id);
  });

  it.each([
    ["no header", undefined, "Access denied. No token provided."],
    ["a malformed header", "not-a-bearer-token", "Access denied. No token provided."],
    ["a garbage token", "Bearer nonsense.nonsense.nonsense", "Invalid token."],
  ])("rejects %s", async (_label, header, message) => {
    const req = request(app).get("/api/auth/me");
    if (header) req.set("Authorization", header);
    const res = await req;

    expect(res.status).toBe(401);
    expect(res.body.message).toBe(message);
  });

  // The reason `protect` reloads the user on every request instead of trusting
  // the token's claims: revocation has to be immediate.
  it("stops accepting a still-valid token once the user is deactivated", async () => {
    const { token, user } = await signIn(app, "CASHIER");
    expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`)).status).toBe(200);

    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });

    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("User not found or deactivated.");
  });

  it("stops accepting a token for a deleted user", async () => {
    const { token, user } = await signIn(app, "CASHIER");
    await prisma.user.delete({ where: { id: user.id } });

    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});

describe("PUT /api/auth/change-password", () => {
  it("changes the password when the current one is right", async () => {
    const { token, user } = await signIn(app);

    const res = await request(app)
      .put("/api/auth/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: PASSWORD, newPassword: "a-new-long-password" });
    expect(res.status).toBe(200);

    const after = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: "a-new-long-password" });
    expect(after.status).toBe(200);

    const old = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: PASSWORD });
    expect(old.status).toBe(401);
  });

  it("refuses when the current password is wrong", async () => {
    const { token } = await signIn(app);
    const res = await request(app)
      .put("/api/auth/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "not-it", newPassword: "a-new-long-password" });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Current password is incorrect.");
  });

  it("refuses a new password under 8 characters", async () => {
    const { token } = await signIn(app);
    const res = await request(app)
      .put("/api/auth/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: PASSWORD, newPassword: "short" });

    expect(res.status).toBe(400);
    expect(res.body.errors[0].field).toBe("newPassword");
  });
});
