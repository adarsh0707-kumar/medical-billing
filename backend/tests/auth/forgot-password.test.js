import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import prisma from "../../src/config/db.js";
import { buildApp, makeUser, PASSWORD } from "../helpers/factory.js";

// `require`, not `import`, and for the reason auth.test.js reaches for bcryptjs
// the same way: an `import *` of a CommonJS module gives Vitest's namespace
// wrapper, and spying on that patches an object the controller — which
// `require`s the module — never reads. The spy then observes nothing and every
// assertion about mail passes vacuously, which is the failure docs/09 §1a
// records. Keep this a `require`; swapping it back disarms these silently
// rather than breaking them loudly.
const mailer = createRequire(import.meta.url)("../../src/config/mailer.js");

/**
 * Self-service password reset — FR-AUTH-11, docs/07 §10 P1-6.
 *
 * The property most of these defend is that **the endpoint says the same thing
 * to everybody**. A shop's customer list is health-adjacent (threat T-9), and an
 * endpoint that answers differently for a known address is a way to ask whether
 * somebody works at a particular pharmacy.
 *
 * The tests therefore assert on the *response* being indistinguishable and on
 * the *table* to see what actually happened, never on the response to learn it.
 */

let app;
beforeAll(() => {
  app = buildApp();
});

// The suite has no mail server, which is the point: `sendMail` logs and returns
// false without one, so the failure path is the default and needs no mocking.
// Where a test wants to know an email *would* have gone, it spies.
// Spied once and cleared per test, not re-spied per test: `vi.spyOn` on an
// already-spied property hands back the same mock, so re-spying accumulates
// calls from every earlier test and `toHaveBeenCalledTimes` starts counting the
// whole file.
const sent = vi.spyOn(mailer, "sendMail");
beforeEach(() => {
  sent.mockReset();
  sent.mockResolvedValue(true);
});

const forgot = (email) =>
  request(app).post("/api/auth/forgot-password").send({ email });

const reset = (token, newPassword) =>
  request(app).post("/api/auth/reset-password").send({ token, newPassword });

const NEW_PASSWORD = "a-properly-long-new-password";

/** Asks for a reset and digs the token out of the row, as the email would. */
const requestReset = async (user) => {
  const raw = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    },
  });
  return raw;
};

describe("POST /api/auth/forgot-password", () => {
  it("answers a known and an unknown address identically", async () => {
    const user = await makeUser({ email: "known@test.local" });

    const known = await forgot(user.email);
    const unknown = await forgot("nobody@test.local");

    // Byte for byte. A difference in status, shape or wording is an oracle for
    // which addresses have accounts.
    expect(known.status).toBe(unknown.status);
    expect(known.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
  });

  it("does not claim to have sent anything", async () => {
    const res = await forgot("nobody@test.local");
    // "If that address has an account…" — saying "we've emailed you" would be
    // a lie on this path, and one the reader can catch.
    expect(res.body.message).toMatch(/if that address has an account/i);
  });

  it("writes a token for a known address and none for an unknown one", async () => {
    const user = await makeUser({ email: "writes@test.local" });

    await forgot(user.email);
    expect(await prisma.passwordResetToken.count()).toBe(1);

    await forgot("nobody@test.local");
    expect(await prisma.passwordResetToken.count()).toBe(1);
  });

  it("never stores the token it emailed", async () => {
    const user = await makeUser({ email: "hashed@test.local" });
    await forgot(user.email);

    const row = await prisma.passwordResetToken.findFirst();
    const link = sent.mock.calls[0][0].text;
    const emailed = link.match(/token=([a-f0-9]+)/)[1];

    // What is in the table is a digest of what went out, so a dump of this
    // table cannot be turned into a reset.
    expect(row.tokenHash).not.toBe(emailed);
    expect(row.tokenHash).toBe(
      crypto.createHash("sha256").update(emailed).digest("hex"),
    );
  });

  it("spends an earlier pending link when a second is asked for", async () => {
    const user = await makeUser({ email: "twice@test.local" });

    await forgot(user.email);
    const first = await prisma.passwordResetToken.findFirst();
    await forgot(user.email);

    // The older email may be sitting in the mailbox that is the reason for the
    // reset. Asking again should leave exactly one live link.
    expect(
      (await prisma.passwordResetToken.findUnique({ where: { id: first.id } }))
        .usedAt,
    ).not.toBeNull();
    expect(
      await prisma.passwordResetToken.count({ where: { usedAt: null } }),
    ).toBe(1);
  });

  it("says the same thing to a deactivated account, and emails nothing", async () => {
    const user = await makeUser({ email: "gone@test.local", isActive: false });

    const res = await forgot(user.email);

    expect(res.status).toBe(200);
    expect(sent).not.toHaveBeenCalled();
    // Letting a suspended account reset would hand it a way back in; saying so
    // would confirm the account exists.
    expect(await prisma.passwordResetToken.count()).toBe(0);
  });

  it("rejects a malformed address", async () => {
    expect((await forgot("not-an-email")).status).toBe(400);
  });

  // ─── The failure this endpoint cannot report ──────────────────────────────
  it("answers normally when the mail server is unreachable", async () => {
    const user = await makeUser({ email: "smtp-down@test.local" });
    sent.mockResolvedValue(false);

    const res = await forgot(user.email);

    // Deliberate, and argued in config/mailer.js: any difference here — a 503
    // for a real address against a 200 for a stranger's — is the account oracle
    // the whole endpoint is shaped to avoid. The failure goes to the log
    // instead, and SECURITY.md says so rather than leaving it to be discovered
    // by a user who never got their email.
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe("POST /api/auth/reset-password", () => {
  it("sets the new password and lets it sign in", async () => {
    const user = await makeUser({ email: "resets@test.local" });
    const token = await requestReset(user);

    const res = await reset(token, NEW_PASSWORD);
    expect(res.status).toBe(200);

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: NEW_PASSWORD });
    expect(login.status).toBe(200);
  });

  it("stops the old password working", async () => {
    const user = await makeUser({ email: "old-gone@test.local" });
    const token = await requestReset(user);
    await reset(token, NEW_PASSWORD);

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: PASSWORD });
    expect(login.status).toBe(401);
  });

  it("ends every other session", async () => {
    const user = await makeUser({ email: "sessions@test.local" });
    const before = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: PASSWORD });
    const oldToken = before.body.data.token;

    // Still good.
    expect(
      (
        await request(app)
          .get("/api/auth/me")
          .set("Authorization", `Bearer ${oldToken}`)
      ).status,
    ).toBe(200);

    const token = await requestReset(user);
    await reset(token, NEW_PASSWORD);

    // A reset is how somebody responds to losing control of an account, so the
    // session the other party is holding has to end — the same reasoning that
    // makes a password change bump the counter.
    expect(
      (
        await request(app)
          .get("/api/auth/me")
          .set("Authorization", `Bearer ${oldToken}`)
      ).status,
    ).toBe(401);
    expect(
      await prisma.refreshToken.count({
        where: { userId: user.id, revokedAt: null },
      }),
    ).toBe(0);
  });

  it("does not sign the caller in", async () => {
    const user = await makeUser({ email: "no-session@test.local" });
    const token = await requestReset(user);

    const res = await reset(token, NEW_PASSWORD);

    // Possession of a mailbox is not proof of identity the way knowing the
    // current password is. Handing back a session would make a compromised
    // inbox a one-step account takeover.
    expect(res.body.data?.token).toBeUndefined();
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("is single use", async () => {
    const user = await makeUser({ email: "once@test.local" });
    const token = await requestReset(user);

    expect((await reset(token, NEW_PASSWORD)).status).toBe(200);
    expect((await reset(token, "another-long-password-here")).status).toBe(400);
  });

  it("refuses an expired token", async () => {
    const user = await makeUser({ email: "expired@test.local" });
    const token = await requestReset(user);
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect((await reset(token, NEW_PASSWORD)).status).toBe(400);
  });

  it("gives one answer to expired, spent and never-existed", async () => {
    const user = await makeUser({ email: "same-answer@test.local" });
    const token = await requestReset(user);
    await reset(token, NEW_PASSWORD);

    const spent = await reset(token, NEW_PASSWORD);
    const invented = await reset("f".repeat(64), NEW_PASSWORD);

    // Telling them apart tells a guesser whether they are close.
    expect(spent.status).toBe(invented.status);
    expect(spent.body).toEqual(invented.body);
  });

  it("kills the account's other pending links", async () => {
    const user = await makeUser({ email: "others@test.local" });
    const stale = await requestReset(user);
    const current = await requestReset(user);

    await reset(current, NEW_PASSWORD);

    expect((await reset(stale, "yet-another-long-password")).status).toBe(400);
  });

  it("applies the same password rules as everywhere else", async () => {
    const user = await makeUser({ email: "weak@test.local" });
    const token = await requestReset(user);

    const res = await reset(token, "password123");

    expect(res.status).toBe(400);
    // And the token survives, so a rejected attempt does not cost the user
    // their only link.
    expect(
      await prisma.passwordResetToken.count({ where: { usedAt: null } }),
    ).toBe(1);
  });

  it("refuses a password that restates the account's own address", async () => {
    const user = await makeUser({ email: "contextual@test.local" });
    const token = await requestReset(user);

    // The account-context rule needs the user, which only the token identifies
    // — so it runs in the controller, as it does for changePassword.
    const res = await reset(token, "contextual@test.local");
    expect(res.status).toBe(400);
  });

  it("refuses a token belonging to a deactivated account", async () => {
    const user = await makeUser({ email: "suspended@test.local" });
    const token = await requestReset(user);
    await prisma.user.update({
      where: { id: user.id },
      data: { isActive: false },
    });

    expect((await reset(token, NEW_PASSWORD)).status).toBe(400);
  });

  it("clears mustChangePassword", async () => {
    const user = await makeUser({ email: "forced@test.local" });
    await prisma.user.update({
      where: { id: user.id },
      data: { mustChangePassword: true },
    });
    const token = await requestReset(user);

    await reset(token, NEW_PASSWORD);

    // They have just chosen their own password; there is nothing left to force.
    expect(
      (await prisma.user.findUnique({ where: { id: user.id } }))
        .mustChangePassword,
    ).toBe(false);
  });
});
