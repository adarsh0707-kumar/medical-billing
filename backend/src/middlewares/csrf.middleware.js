const { isAllowedOrigin } = require("../config/origins");

/**
 * Refuses a cross-site request to a route authenticated by a cookie.
 *
 * ## Why this route and no other
 *
 * `POST /api/auth/refresh` is the only endpoint in this API whose credential is
 * a cookie. Every other protected route takes a `Bearer` token out of
 * `localStorage`, which another origin's script cannot read and therefore cannot
 * attach — those routes have no CSRF surface at all. This one the browser
 * authenticates *for* the caller, which is exactly the condition CSRF needs.
 *
 * ## Why it exists now and did not before
 *
 * The refresh cookie was `SameSite=Strict`, and a Strict cookie is simply never
 * sent on a cross-site request — the browser was the defence. Since the hosted
 * SPA and the API are on different sites, Strict meant the cookie was set at
 * login and then never sent again, so every silent refresh failed and a
 * 30-minute access token expired into a full logout. Relaxing to `None` fixed
 * that and gave up the defence in the same move.
 *
 * ## What this is, precisely: an accident made deliberate
 *
 * **The hole was not open in between.** `app.js` rejects an unlisted origin by
 * calling the CORS origin callback with an `Error`, and `cors` turns that into
 * `next(err)` — so a cross-site request to this route was already dying in the
 * middleware stack before the router saw it. That was worth establishing before
 * writing any of this, and it means this change hardens a working protection
 * rather than closing an exploited gap.
 *
 * Two reasons it is still worth having:
 *
 * 1. **It was incidental.** Nothing named it, no test asserted it, and the
 *    documented way to stop that rejection returning a 500 is
 *    `callback(null, false)` — which passes the request *through* to the route
 *    and merely withholds the response header. Someone tidying a noisy 500
 *    would open the hole and have no reason to suspect it.
 * 2. **The 500 was itself wrong.** A request from an origin this API does not
 *    trust is the caller's problem. Reporting it as an internal server error
 *    puts a stack trace in the log and tells an operator to go looking at the
 *    server.
 *
 * ## What the attack would be
 *
 * Not data theft: CORS still stops another origin reading the response. It is
 * *forced session loss*. An attacker's page triggers the refresh, the row
 * rotates, and if the victim's browser does not keep the replacement cookie —
 * third-party cookie writes are blocked by default in more browsers every year —
 * the victim's own next refresh presents a token that has already been rotated.
 * `refresh` correctly reads that as theft and revokes **every** session for the
 * account. So any website could sign a pharmacy's staff out of every device,
 * silently, at will.
 *
 * ## Why an Origin check rather than a double-submit token
 *
 * The usual double-submit pattern cannot work in this deployment. It requires
 * script to read a cookie and echo it in a header — but the SPA is on a
 * different site from the API, so `document.cookie` there cannot see a cookie
 * scoped to the API's host. Handing the token back in the login response body
 * instead would mean storing it beside the access token in `localStorage`, and
 * that is worse than doing nothing: an XSS would then hold everything needed to
 * renew a session indefinitely, which is precisely the property the HttpOnly
 * refresh cookie exists to deny it (threat T-13).
 *
 * `Origin` is a forbidden header name, so page script cannot set or remove it,
 * and browsers send it on every cross-origin request that can carry a cookie —
 * `fetch`, `XMLHttpRequest`, `sendBeacon` and cross-site form POSTs alike. A
 * sandboxed or `data:` document sends the literal `null`, which is not in any
 * allowlist and is refused. That makes it a complete check for the thing being
 * defended against, and it costs no state, which matters in an API that has
 * none.
 *
 * ## Why a missing Origin is allowed through
 *
 * Deliberate, and the one place this could look too lax. A CSRF attack needs a
 * browser, because it works by the browser attaching the cookie on its own; and
 * no browser produces a cookie-bearing cross-site POST without an `Origin`
 * header. A request that arrives without one therefore had its cookie set by
 * hand — by curl, by a test, by a server-to-server caller — and whoever set it
 * already had the credential. Refusing those would break debugging and the
 * Supertest suite while blocking nothing an attacker can do. A privacy tool that
 * strips `Origin` also lands here, and keeps working, which is the right outcome
 * for a real user.
 */
const requireKnownOrigin = (req, res, next) => {
  const origin = req.headers.origin;

  if (origin === undefined) return next();
  if (isAllowedOrigin(origin)) return next();

  // 403, not 401, and it deliberately does **not** clear the cookie. `refresh`
  // clears it on every denial, which is right when the credential is bad — but
  // reaching for that here would hand the attacker the outcome this middleware
  // exists to prevent: a stranger's page could sign the victim out by being
  // refused. Nothing about the session is wrong, so nothing about it changes.
  return res.status(403).json({
    success: false,
    message: "This request did not come from a recognised origin.",
  });
};

module.exports = requireKnownOrigin;
