// The one list of web origins this API trusts.
//
// Two things consult it and they must not drift apart: the CORS middleware in
// `app.js`, which decides whether a browser may *read* a cross-origin response,
// and `requireKnownOrigin` in `middlewares/csrf.middleware.js`, which decides
// whether a cross-site request may *happen at all* on the one route
// authenticated by a cookie. Those answer different questions, and the second
// only became necessary when the refresh cookie relaxed to `SameSite=None`.
//
// Kept here rather than in `app.js` because the middleware cannot reach a
// `const` inside `createApp()`. Copying the list into both is the shape of
// defect `utils/trend.js` was written to close — two identical blocks under a
// comment saying they must agree, which is true only until somebody edits one.

// Computed per call, not once at load. The test suite builds apps with
// different `NODE_ENV` values in the same process (see the production-cookie
// guard in tests/auth/auth.test.js), and a list captured at require time would
// answer for whichever environment happened to load this module first.
const allowedOrigins = () =>
  process.env.NODE_ENV === "production"
    ? // In production the allowlist is exactly CORS_ORIGINS and nothing else.
      // The development origins are deliberately not appended, or "restrict
      // CORS to your real origin" would be impossible to actually do.
      (process.env.CORS_ORIGINS || "")
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean)
    : [
        "http://localhost", // nginx entry point on :80
        "http://localhost:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        // Docker's default bridge gateway. Kept generic on purpose: a
        // container's actual address depends on which networks the daemon has
        // already created, so hard-coding the one this machine happened to get
        // fixes it for one developer and breaks it for the next. If your
        // bridge is not the default, set FRONTEND_URL rather than editing this
        // list — that is what the variable is for.
        "http://172.17.0.1:5173",
        process.env.FRONTEND_URL,
      ].filter(Boolean);

// `origin` is the raw `Origin` header. A sandboxed iframe or a `data:` document
// sends the literal string "null", which is not an origin this or any
// deployment can list — so it falls through to false, which is correct.
const isAllowedOrigin = (origin) => allowedOrigins().includes(origin);

module.exports = { allowedOrigins, isAllowedOrigin };
