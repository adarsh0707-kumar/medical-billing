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
