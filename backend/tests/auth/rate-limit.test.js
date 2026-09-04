import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildApp, makeUser, PASSWORD } from "../helpers/factory.js";

// Regression guard for G-06. Built with a real (small) budget rather than the
// suite-wide unlimited one, and each app gets its own limiter store.
const limited = () => buildApp({ loginRateLimitMax: 3 });

const attempt = (app, email, password, ip = "203.0.113.1") =>
  request(app)
    .post("/api/auth/login")
    .set("X-Forwarded-For", ip)
    .send({ email, password });

describe("login rate limiting", () => {
  it("blocks a client after too many failures", async () => {
    const app = limited();
    const user = await makeUser();

    for (let i = 0; i < 3; i++) {
      expect((await attempt(app, user.email, "wrong")).status).toBe(401);
    }

    const blocked = await attempt(app, user.email, "wrong");
    expect(blocked.status).toBe(429);
    expect(blocked.body.message).toMatch(/Too many failed login attempts/);
  });

  it("keeps blocking even when the correct password arrives", async () => {
    const app = limited();
    const user = await makeUser();

    for (let i = 0; i < 3; i++) await attempt(app, user.email, "wrong");

    expect((await attempt(app, user.email, PASSWORD)).status).toBe(429);
  });

  // Proves the proxy header is being honoured: without `trust proxy`, every
  // client behind nginx would share one bucket.
  it("isolates clients by their forwarded address", async () => {
    const app = limited();
    const user = await makeUser();

    for (let i = 0; i < 4; i++) await attempt(app, user.email, "wrong", "203.0.113.7");

    const other = await attempt(app, user.email, "wrong", "203.0.113.99");
    expect(other.status).toBe(401);
  });

  it("does not spend the budget on successful sign-ins", async () => {
    const app = limited();
    const user = await makeUser();

    for (let i = 0; i < 10; i++) {
      expect((await attempt(app, user.email, PASSWORD)).status).toBe(200);
    }
  });

  it("leaves the rest of the API on the general budget", async () => {
    const app = limited();
    const user = await makeUser();

    for (let i = 0; i < 4; i++) await attempt(app, user.email, "wrong");

    // The login bucket is spent; unrelated endpoints must still answer.
    expect((await request(app).get("/health")).status).toBe(200);
  });
});

/**
 * Signup is bounded on **successes**, which is the whole difference between its
 * limiter and login's.
 *
 * `loginLimiter` carries `skipSuccessfulRequests`, and mounting it here counted
 * the wrong half: a successful signup creates a Shop and a User and spends a
 * cost-12 bcrypt hash, so it is the call worth bounding, and it was the one
 * being skipped. The budget could not be spent by the traffic it existed to
 * bound, and SECURITY.md named it as what bounds the rate.
 *
 * These assert the property rather than the wiring, so replacing the limiter
 * with something else later still has to keep it.
 */
const signupLimited = () => buildApp({ signupRateLimitMax: 3 });

// Distinct emails every time: User.email is globally unique by design
// (FR-SHOP-06), so a repeated address would fail with 409 for its own reason
// and prove nothing about the budget.
let n = 0;
const openShop = (app, ip = "203.0.113.20") =>
  request(app)
    .post("/api/auth/signup")
    .set("X-Forwarded-For", ip)
    .send({
      shopName: `Shop ${(n += 1)}`,
      name: `Owner ${n}`,
      email: `owner-${n}@pharmacy.local`,
      password: "a-well-chosen-passphrase",
    });

describe("signup rate limiting", () => {
  it("spends the budget on successful signups", async () => {
    const app = signupLimited();

    for (let i = 0; i < 3; i++) {
      expect((await openShop(app)).status).toBe(201);
    }

    const blocked = await openShop(app);
    expect(blocked.status).toBe(429);
    expect(blocked.body.message).toMatch(/Too many signup attempts/);
  });

  it("isolates clients by their forwarded address", async () => {
    const app = signupLimited();

    for (let i = 0; i < 4; i++) await openShop(app, "203.0.113.21");

    expect((await openShop(app, "203.0.113.22")).status).toBe(201);
  });

  // Two routes sharing one limiter share one bucket. Failed signups would then
  // spend the login budget for that client — behind a single public address,
  // a stranger locking a pharmacy's staff out of their own till.
  it("does not share a bucket with login", async () => {
    const app = buildApp({ signupRateLimitMax: 2, loginRateLimitMax: 3 });
    const user = await makeUser();

    for (let i = 0; i < 3; i++) await openShop(app, "203.0.113.23");
    expect((await openShop(app, "203.0.113.23")).status).toBe(429);

    // Signup is spent; login for the same client is untouched.
    expect(
      (await attempt(app, user.email, PASSWORD, "203.0.113.23")).status,
    ).toBe(200);
  });
});
