import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import prisma from "../../src/config/db.js";
import { buildApp, makeUser, signIn, PASSWORD } from "../helpers/factory.js";
import { generateToken } from "../../src/utils/jwt.utils.js";

/**
 * Forced password change — P0-1 in docs/07-security.md, threat T-2.
 *
 * The seeded bootstrap admin ships with a password published in this repository.
 * The old mitigation was a line in SECURITY.md asking operators to change it,
 * which is a hope rather than a control.
 *
 * The half that matters is that this is enforced by the API. A client-side
 * redirect would be the same class of thing as hiding a nav item — anyone with
 * curl walks past it — so these tests deliberately call the endpoints directly
 * rather than exercising the screen.
 */

let app;
beforeAll(() => {
  app = buildApp();
});

let flagged;
let token;

beforeEach(async () => {
  flagged = await makeUser({ role: "ADMIN", email: "flagged@test.local" });
  await prisma.user.update({
    where: { id: flagged.id },
    data: { mustChangePassword: true },
  });
  token = generateToken(flagged.id);
});

const auth = (req) => req.set("Authorization", `Bearer ${token}`);

describe("an account that must change its password", () => {
  it.each([
    ["inventory", "/api/inventory/medicines"],
    ["billing", "/api/billing/invoices"],
    ["customers", "/api/billing/customers"],
    ["users", "/api/users"],
  ])("is refused from %s with a code the client can act on", async (_n, url) => {
    const res = await auth(request(app).get(url));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PASSWORD_CHANGE_REQUIRED");
    // A generic "access denied" would leave the user stuck with no next step.
    expect(res.body.message).toMatch(/change your password/i);
  });

  it("is refused from writes, not just reads", async () => {
    const res = await auth(request(app).post("/api/inventory/categories")).send({
      name: "Should not be created",
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PASSWORD_CHANGE_REQUIRED");
    expect(await prisma.category.count()).toBe(0);
  });

  it("can still read its own profile", async () => {
    // One of exactly two escape hatches. Without it the client cannot tell the
    // difference between "blocked" and "broken".
    const res = await auth(request(app).get("/api/auth/me"));

    expect(res.status).toBe(200);
    expect(res.body.data.user.mustChangePassword).toBe(true);
  });

  it("can change its password, and that clears the block", async () => {
    const change = await auth(
      request(app).put("/api/auth/change-password"),
    ).send({ currentPassword: PASSWORD, newPassword: "a-properly-long-one" });
    expect(change.status).toBe(200);

    // The change revokes every token for the account — that is A-6, and it has
    // to include this one, or "change your password" would not end a session an
    // attacker is holding. The old token is therefore dead:
    const withOld = await auth(request(app).get("/api/inventory/medicines"));
    expect(withOld.status).toBe(401);

    // ...but the response carries a replacement, so the user is still not made
    // to sign in again. The original intent of this case — no re-login noise
    // after clearing the block — survives; only the mechanics changed.
    const fresh = change.body.data.token;
    expect(fresh).toBeTruthy();
    const after = await request(app)
      .get("/api/inventory/medicines")
      .set("Authorization", `Bearer ${fresh}`);
    expect(after.status).toBe(200);
  });

  it("stays blocked if the password change fails", async () => {
    const change = await auth(
      request(app).put("/api/auth/change-password"),
    ).send({ currentPassword: "not-the-password", newPassword: "a-long-one" });
    expect(change.status).toBe(400);

    const after = await auth(request(app).get("/api/inventory/medicines"));
    expect(after.status).toBe(403);
  });
});

describe("an account that does not need to change its password", () => {
  it("is unaffected", async () => {
    const { token: normal } = await signIn(app, "ADMIN");

    const res = await request(app)
      .get("/api/inventory/medicines")
      .set("Authorization", `Bearer ${normal}`);

    expect(res.status).toBe(200);
  });

  it("reports the flag as false on login", async () => {
    const user = await makeUser({ role: "CASHIER", email: "normal@test.local" });
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.user.mustChangePassword).toBe(false);
  });
});

describe("the flag itself", () => {
  it("defaults to false for an ordinary new user", async () => {
    const user = await makeUser({ role: "CASHIER", email: "fresh@test.local" });
    expect(user.mustChangePassword).toBe(false);
  });

  it("is reported on login so the client can route straight to the screen", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: flagged.email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.user.mustChangePassword).toBe(true);
  });

  it("never leaks the password hash alongside it", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: flagged.email, password: PASSWORD });

    expect(JSON.stringify(res.body)).not.toContain("$2");
  });
});
