import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import prisma from "../../src/config/db.js";
import {
  buildApp,
  signIn,
  makeUser,
  tokenFor,
  loginViaApi,
  PASSWORD,
} from "../helpers/factory.js";

let app;
beforeAll(() => {
  app = buildApp();
});

const as = (token, method, path, body) =>
  request(app)[method](path).set("Authorization", `Bearer ${token}`).send(body);

const resetOf = (token, id) => as(token, "post", `/api/users/${id}/reset-password`);

describe("POST /api/users/:id/reset-password", () => {
  it("returns a temporary password and forces a change at next sign-in", async () => {
    const { token } = await signIn(app);
    const target = await makeUser({ role: "CASHIER", email: "locked@test.local" });

    const res = await resetOf(token, target.id);

    expect(res.status).toBe(200);
    expect(res.body.data.tempPassword).toEqual(expect.any(String));
    expect(res.body.data.mustChangePassword).toBe(true);

    const after = await prisma.user.findUnique({ where: { id: target.id } });
    expect(after.mustChangePassword).toBe(true);
  });

  it("issues a password that actually signs the user in", async () => {
    const { token } = await signIn(app);
    const target = await makeUser({ role: "CASHIER", email: "signin@test.local" });

    const { body } = await resetOf(token, target.id);
    const res = await loginViaApi(app, target.email, body.data.tempPassword);

    expect(res.status).toBe(200);
    expect(res.body.data.user.mustChangePassword).toBe(true);
  });

  it("invalidates the password the user had before", async () => {
    const { token } = await signIn(app);
    const target = await makeUser({ role: "CASHIER", email: "old-pw@test.local" });

    await resetOf(token, target.id);

    const res = await loginViaApi(app, target.email, PASSWORD);
    expect(res.status).toBe(401);
  });

  // A reset is how somebody responds to a compromise, so it has to evict whoever
  // is already inside — not merely stop them signing in again (docs/07 A-6).
  it("ends the target's existing sessions", async () => {
    const { token } = await signIn(app);
    const target = await makeUser({ role: "CASHIER", email: "evict@test.local" });
    const victimToken = await tokenFor(target.id);

    // Live before the reset.
    expect((await as(victimToken, "get", "/api/auth/me")).status).toBe(200);

    await resetOf(token, target.id);

    expect((await as(victimToken, "get", "/api/auth/me")).status).toBe(401);
  });

  it("revokes refresh tokens, so a stolen session cannot mint a new one", async () => {
    const { token } = await signIn(app);
    const target = await makeUser({ role: "CASHIER", email: "refresh@test.local" });
    await prisma.refreshToken.create({
      data: {
        userId: target.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    });

    await resetOf(token, target.id);

    const live = await prisma.refreshToken.count({
      where: { userId: target.id, revokedAt: null },
    });
    expect(live).toBe(0);
  });

  it("never echoes or stores the temporary password in the clear", async () => {
    const { token } = await signIn(app);
    const target = await makeUser({ role: "CASHIER", email: "hash@test.local" });

    const { body } = await resetOf(token, target.id);
    const after = await prisma.user.findUnique({ where: { id: target.id } });

    expect(body.data.password).toBeUndefined();
    expect(after.password).not.toBe(body.data.tempPassword);
    expect(after.password).toMatch(/^\$2[aby]\$/);
  });

  it("gives every reset a different password", async () => {
    const { token } = await signIn(app);
    const target = await makeUser({ role: "CASHIER", email: "twice@test.local" });

    const first = await resetOf(token, target.id);
    const second = await resetOf(token, target.id);

    expect(first.body.data.tempPassword).not.toBe(second.body.data.tempPassword);
  });

  it("404s on an account that does not exist", async () => {
    const { token } = await signIn(app);
    const res = await resetOf(token, "clzzzzzzzzzzzzzzzzzzzzzzz");
    expect(res.status).toBe(404);
  });

  // The reset is a privilege-escalation primitive: whoever can call it can take
  // over any account in the shop, so the guard on it matters more than the
  // feature does.
  it.each([["PHARMACIST"], ["CASHIER"]])(
    "refuses a %s with a 403",
    async (role) => {
      const { token } = await signIn(app, role);
      const target = await makeUser({ role: "CASHIER", email: `t-${role}@test.local` });

      expect((await resetOf(token, target.id)).status).toBe(403);
    },
  );

  it("refuses an unauthenticated caller with a 401", async () => {
    const target = await makeUser({ role: "CASHIER", email: "anon@test.local" });
    const res = await request(app).post(`/api/users/${target.id}/reset-password`);
    expect(res.status).toBe(401);
  });

  // Otherwise a freshly reset admin account — the one most likely to be in
  // someone else's hands — could reset its way across every account in the shop
  // without ever proving it knows a chosen password.
  it("refuses an admin who has not yet replaced their own temporary password", async () => {
    const { user } = await signIn(app);
    await prisma.user.update({
      where: { id: user.id },
      data: { mustChangePassword: true },
    });
    const target = await makeUser({ role: "CASHIER", email: "blocked@test.local" });

    const res = await resetOf(await tokenFor(user.id), target.id);
    expect(res.status).toBe(403);
  });

  it("records the reset in the audit log without the hash", async () => {
    const { token } = await signIn(app);
    const target = await makeUser({ role: "CASHIER", email: "audited@test.local" });

    await resetOf(token, target.id);

    const rows = await prisma.auditLog.findMany({
      where: { model: "User", action: "UPDATE" },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain("$2b$");
    expect(JSON.stringify(rows)).not.toContain("$2a$");
  });
});
