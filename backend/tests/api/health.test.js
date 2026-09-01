import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { buildApp } from "../helpers/factory.js";
// `createRequire` rather than an import attribute: the ESLint parser this
// repo runs does not accept `with { type: "json" }` yet, and the suite already
// crosses the CJS boundary this way elsewhere.
import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../../package.json");

/**
 * `/health` says which build is answering.
 *
 * On 2026-09-01 four features were live in the browser and absent from the
 * API — the frontend host had redeployed and the API host had not — and
 * nothing in the response could tell you that. Every symptom was a 404, which
 * looks exactly like a route nobody wrote; establishing that production was
 * simply behind meant probing an unrelated public endpoint and reasoning from
 * its absence.
 *
 * So the fields asserted here are not decoration. They are the difference
 * between "the deploy did not happen" and "the code is wrong", which are the
 * two explanations for a 404 in production and have nothing in common.
 */

const ENV_KEYS = ["RENDER_GIT_COMMIT", "GIT_COMMIT"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const health = () => request(buildApp()).get("/health");

describe("GET /health", () => {
  it("stays a cheap, dependency-free 200", async () => {
    const res = await health();

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("names the running version", async () => {
    const res = await health();

    // Whatever package.json says, not a literal repeated here — a copy would
    // be one more thing to forget on a release.
    expect(res.body.version).toBe(pkg.version);
  });

  it("reports the commit the platform deployed, shortened", async () => {
    process.env.RENDER_GIT_COMMIT = "3904fcd5300d42bab6b03721507eda9f558e1131";

    expect((await health()).body.commit).toBe("3904fcd");
  });

  it("falls back to GIT_COMMIT off Render", async () => {
    delete process.env.RENDER_GIT_COMMIT;
    process.env.GIT_COMMIT = "abcdef1234567890";

    expect((await health()).body.commit).toBe("abcdef1");
  });

  // Development sets neither, and the question does not arise there. It must
  // still be a word rather than an empty string: `"commit": ""` in a response
  // reads as a build that failed to identify itself.
  it("says so plainly when no commit was supplied", async () => {
    for (const key of ENV_KEYS) delete process.env[key];

    expect((await health()).body.commit).toBe("unknown");
  });
});
