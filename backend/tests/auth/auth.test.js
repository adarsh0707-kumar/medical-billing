import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import prisma from "../../src/config/db.js";
import { buildApp, makeUser, signIn, tokenFor, PASSWORD } from "../helpers/factory.js";
import { generateToken } from "../../src/utils/jwt.utils.js";
import jwt from "jsonwebtoken";

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

  // Regression guard for G-18. `protect` used to wrap token verification and the
  // user reload in one try/catch that answered 401 for everything, so a database
  // failure reached the caller as a bad token. lib/api.ts clears localStorage and
  // redirects on any 401, so a few seconds of database trouble signed out every
  // active user and told them their session was invalid.
  //
  // The token below is signed with the real secret but carries a numeric id,
  // which Prisma rejects with a PrismaClientValidationError rather than returning
  // a miss — a genuine throw out of the query, no mocking involved. (Mocking is
  // not an option here: the suite's Prisma client and the app's are separate
  // instances, because the tests import config/db.js as ESM while the middleware
  // `require`s it.) Only our own secret can mint that token, so a valid signature
  // carrying a payload our own code cannot use is a server fault, not a bad
  // credential — 500 is the honest answer.
  it("reports a failing user lookup as 500, not as a bad token", async () => {
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${generateToken(12345)}`);

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    // The half that matters: it must not look like a credential problem, because
    // the client logs the user out whenever it does.
    expect(res.body.message).not.toBe("Invalid token.");
    expect(res.body.message).not.toBe("Token expired.");
  });

  it("keeps answering 401 for a genuinely bad token", async () => {
    // The corollary to the split: verification runs first and on its own, so a
    // garbage token is still a 401 and never reaches the database at all.
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", "Bearer nonsense.nonsense.nonsense");

    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Invalid token.");
  });

  // The other two ways verification can fail. Both are documented in
  // docs/04-api-reference.md §3; neither had a test before G-18 split the catches.
  it("answers 401 'Token expired.' for an expired token", async () => {
    const expired = jwt.sign({ id: "whoever" }, process.env.JWT_SECRET, {
      expiresIn: "-1s",
    });
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${expired}`);

    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Token expired.");
  });

  it("answers 401 for a token that is not valid yet", async () => {
    const notYet = jwt.sign({ id: "whoever" }, process.env.JWT_SECRET, {
      notBefore: 3600,
    });
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${notYet}`);

    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Invalid token.");
  });

  // Pins today's behaviour rather than endorsing it. jsonwebtoken reports an
  // unset secret as a JsonWebTokenError, so an operator who forgets JWT_SECRET
  // gets "Invalid token." on every request — and nothing validates the variable
  // at boot, despite SECURITY.md claiming the API fails loudly without one.
  // If a boot guard lands (docs/08 D-15), this test should be deleted with it.
  it("currently reports an unset JWT_SECRET as a bad token", async () => {
    const { token } = await signIn(app, "CASHIER");
    const real = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;

    try {
      const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(401);
      expect(res.body.message).toBe("Invalid token.");
    } finally {
      process.env.JWT_SECRET = real;
    }
  });
});

// Guards FR-AUTH-09 / docs/07 A-2. Before this, logout was a client-side
// localStorage clear and a leaked token stayed valid for its full seven days.
describe("POST /api/auth/logout", () => {
  const me = (token) =>
    request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
  const logout = (token) =>
    request(app).post("/api/auth/logout").set("Authorization", `Bearer ${token}`);

  it("ends the session it was called with", async () => {
    const { token } = await signIn(app, "CASHIER");
    expect((await me(token)).status).toBe(200);

    expect((await logout(token)).status).toBe(200);

    const res = await me(token);
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Session ended. Please sign in again.");
  });

  it("ends every other session for the same user, not just the caller's", async () => {
    const { token: first, user } = await signIn(app, "CASHIER");
    const second = await tokenFor(user.id);
    expect((await me(second)).status).toBe(200);

    await logout(first);

    // The point of the whole feature: a stolen copy of the token dies with the
    // session the user actually ended, which a client-side clear cannot do.
    expect((await me(second)).status).toBe(401);
  });

  it("leaves other users signed in", async () => {
    const { token: cashier } = await signIn(app, "CASHIER");
    const { token: admin } = await signIn(app, "ADMIN");

    await logout(cashier);

    expect((await me(admin)).status).toBe(200);
  });

  it("issues a working token again on the next sign-in", async () => {
    const { token, user } = await signIn(app, "CASHIER");
    await logout(token);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect((await me(res.body.data.token)).status).toBe(200);
  });

  it("is available to an account that must change its password", async () => {
    const user = await makeUser({ role: "CASHIER", email: "blocked@test.local" });
    await prisma.user.update({
      where: { id: user.id },
      data: { mustChangePassword: true },
    });
    const token = await tokenFor(user.id);

    // Every other route answers 403 PASSWORD_CHANGE_REQUIRED. Being unable to
    // sign out of an account you cannot otherwise use would be a worse trap
    // than the one the flag exists to set.
    expect((await request(app).get("/api/inventory/categories").set("Authorization", `Bearer ${token}`)).status).toBe(403);
    expect((await logout(token)).status).toBe(200);
  });

  it("refuses an anonymous caller", async () => {
    expect((await request(app).post("/api/auth/logout")).status).toBe(401);
  });

  it("still accepts a token minted before the revocation counter existed", async () => {
    const { user } = await signIn(app, "CASHIER");
    // No tokenVersion claim at all, as tokens issued before this shipped.
    const legacy = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    // Reads as version 0, which is the column default — so deploying the
    // feature did not sign every existing user out.
    expect((await me(legacy)).status).toBe(200);

    await logout(legacy);
    expect((await me(legacy)).status).toBe(401);
  });
});

// Guards FR-AUTH-10 / docs/07 A-3. Access tokens are short-lived; the week is
// carried by a refresh cookie that JavaScript cannot read.
describe("POST /api/auth/refresh", () => {
  const cookieOf = (res) =>
    (res.headers["set-cookie"] ?? []).find((c) => c.startsWith("refresh_token="));

  const signInFor = async (email) => {
    const user = await makeUser({ role: "CASHIER", email });
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: PASSWORD });
    return { user, res, cookie: cookieOf(res) };
  };

  it("issues the refresh token as an httpOnly cookie, not in the body", async () => {
    const { res, cookie } = await signInFor("cookie@test.local");

    expect(cookie).toBeTruthy();
    // The entire reason for splitting the two: script in the page can read the
    // access token, and must not be able to read the long-lived half.
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(JSON.stringify(res.body)).not.toContain("refresh_token");
  });

  it("issues an access token that expires in 30 minutes, not 7 days", async () => {
    const { res } = await signInFor("shortlived@test.local");
    const { iat, exp } = jwt.decode(res.body.data.token);

    expect(Math.round((exp - iat) / 60)).toBe(30);
  });

  it("exchanges the cookie for a fresh access token", async () => {
    const { cookie } = await signInFor("exchange@test.local");

    const res = await request(app).post("/api/auth/refresh").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeTruthy();
    expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${res.body.data.token}`)).status).toBe(200);
  });

  it("rotates the cookie on every use", async () => {
    const { cookie } = await signInFor("rotate@test.local");

    const res = await request(app).post("/api/auth/refresh").set("Cookie", cookie);

    expect(cookieOf(res)).toBeTruthy();
    expect(cookieOf(res)).not.toBe(cookie);
  });

  it("treats a replayed cookie as theft and ends every session", async () => {
    const { cookie: original } = await signInFor("replay@test.local");

    const rotated = cookieOf(
      await request(app).post("/api/auth/refresh").set("Cookie", original),
    );
    // A legitimate client never replays a rotated token, so presenting one
    // means two parties hold the same credential.
    expect((await request(app).post("/api/auth/refresh").set("Cookie", original)).status).toBe(401);

    // ...and the response is to end everything, including the session the
    // honest client is holding. Losing a session beats leaving a thief in one.
    expect((await request(app).post("/api/auth/refresh").set("Cookie", rotated)).status).toBe(401);
  });

  it("refuses with no cookie at all", async () => {
    expect((await request(app).post("/api/auth/refresh")).status).toBe(401);
  });

  it("stops working after a logout", async () => {
    const { res, cookie } = await signInFor("loggedout@test.local");

    await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${res.body.data.token}`);

    // Otherwise signing out would last only until the next silent refresh.
    expect((await request(app).post("/api/auth/refresh").set("Cookie", cookie)).status).toBe(401);
  });

  it("stops working once the account is deactivated", async () => {
    const { user, cookie } = await signInFor("deactivated@test.local");
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });

    expect((await request(app).post("/api/auth/refresh").set("Cookie", cookie)).status).toBe(401);
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

  // Guards docs/07 A-6. A password change is how someone responds to a
  // compromise; before this it ended nothing.
  it("revokes every other session for the account", async () => {
    const { token, user } = await signIn(app, "CASHIER");
    const otherDevice = await tokenFor(user.id);
    expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${otherDevice}`)).status).toBe(200);

    await request(app)
      .put("/api/auth/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: PASSWORD, newPassword: "a-brand-new-one" });

    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${otherDevice}`);
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Session ended. Please sign in again.");
  });

  it("hands the caller a replacement token so they stay signed in", async () => {
    const { token } = await signIn(app, "CASHIER");

    const change = await request(app)
      .put("/api/auth/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: PASSWORD, newPassword: "a-brand-new-one" });

    expect(change.status).toBe(200);
    // The old token is gone — the caller's own session was revoked with the
    // rest — but the replacement works, so a successful password change does
    // not sign the user out of the device they changed it on.
    expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`)).status).toBe(401);
    expect(change.body.data.token).toBeTruthy();
    expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${change.body.data.token}`)).status).toBe(200);
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
