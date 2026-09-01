const bcrypt = require("bcryptjs");
const prisma = require("../config/db");
const jwt = require("jsonwebtoken");
const {
  generateToken,
  generateRefreshToken,
  REFRESH_TOKEN_TTL_DAYS,
} = require("../utils/jwt.utils");

const { passwordProblem } = require("../validators/password");
// Called as `mailer.sendMail(...)`, not destructured, and that is load-bearing.
// Destructuring binds the function at require time, so a test that replaces the
// export patches a reference this file never reads — which is precisely how the
// login-timing guards spent weeks asserting nothing (docs/09 §1a). Reaching
// through the module object keeps the seam a test can actually hold.
const mailer = require("../config/mailer");
const { logger } = require("../config/logger");
const crypto = require("node:crypto");

const REFRESH_COOKIE = "refresh_token";

// Thirty minutes. A reset link is a bearer credential sitting in a mailbox —
// the one place a password is most likely to be read by somebody else — so it
// should be worth stealing for as short a time as possible. Long enough that a
// distracted user still gets in; short enough that a link found in an inbox
// months later is inert.
const RESET_TOKEN_TTL_MINUTES = 30;

// The token goes out in the email; only this goes in the table. SHA-256 rather
// than bcrypt because the input is 32 random bytes, not a chosen password:
// there is no dictionary to run against it, so a slow hash would buy nothing
// and cost a lookup on every reset.
const hashResetToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

// A decoy for the login miss path, so an unknown email costs the same bcrypt
// work as a known one (docs/07 P2-12).
//
// Derived from random bytes at start-up rather than hard-coded: there is no
// value in the source that could be mistaken for a real credential, and nothing
// a caller can type will ever match it. Cost 12 to match how real passwords are
// stored — a cheaper decoy would reintroduce the very difference it exists to
// hide. Costs one hash at boot, once.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
  require("node:crypto").randomBytes(32).toString("hex"),
  12,
);

// httpOnly so script in the page cannot read it — that is the point of holding
// the long-lived half here rather than in localStorage alongside the access
// token. Path scopes it to the auth endpoints, so it is not attached to every
// API call. Secure only in production, because the development stack is
// deliberately plain HTTP and a Secure cookie would simply never be sent there.
//
// `sameSite` cannot be a flat "strict" once frontend and backend are on
// different sites — a browser refuses to send a Strict (or Lax) cookie on any
// cross-site request at all, including this app's own XHR calls from a
// Vercel-hosted SPA to a Render-hosted API. With Strict, the cookie is set
// once at login and then never sent again, so every refresh attempt fails
// silently and the 30-minute access token's expiry becomes a full logout —
// which looks like "sessions don't last a week" when the code otherwise
// behaves exactly as designed.
//
// "None" is the setting that actually allows a cross-site cookie to be sent,
// and browsers require Secure whenever SameSite is None — which production
// already sets. Kept at "strict" outside production, where frontend and
// backend share an origin through the dev proxy and Strict costs nothing.
//
// **Strict used to be the CSRF defence on the refresh route, and None gives
// that up.** It is not a free change and it is not left uncovered: the
// protection the browser was providing is now an explicit `Origin` check,
// `requireKnownOrigin` in `middlewares/csrf.middleware.js`, which that file
// argues at length. Confirmed 2026-08-31 that the deployment really is
// cross-site — `VITE_API_URL` is set in the Vercel project, so the SPA calls the
// API host directly rather than through the `vercel.json` rewrite.
const refreshCookieOptions = () => ({
  httpOnly: true,
  sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
  secure: process.env.NODE_ENV === "production",
  path: "/api/auth",
  maxAge: REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
});

// Express does not parse cookies and this is the only one the API reads, so a
// dependency for it would be more surface than the five lines it saves.
const readCookie = (req, name) => {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
};

// Opens a session: one RefreshToken row (the device), a refresh cookie pointing
// at it, and a short access token. Used by login and by every rotation.
const issueSession = async (res, user) => {
  const expiresAt = new Date(
    Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  );
  const row = await prisma.refreshToken.create({
    data: { userId: user.id, expiresAt },
    select: { id: true },
  });

  res.cookie(
    REFRESH_COOKIE,
    generateRefreshToken(user.id, user.tokenVersion, row.id, user.shopId),
    refreshCookieOptions(),
  );

  return generateToken(user.id, user.tokenVersion, user.shopId);
};

// ─── Signup — a new shop and its first administrator ───
//
// The public, self-serve way a new shopkeeper gets onto the system: this
// creates a brand-new Shop and, inside the same transaction, the ADMIN account
// that owns it. Unlike the single-tenant bootstrap this replaces, it is not a
// one-time endpoint — every shopkeeper who has never used the system before
// calls this once, and the system can hold any number of shops side by side.
//
// **Why every shop still gets exactly one thing this way.** Nothing here
// stops a person from calling it twice and ending up with two shops, and
// nothing should — that is two independent businesses, which is a legitimate
// thing for one person to run. What it must never do is let a signup attach
// itself to an *existing* shop or read anything belonging to one: there is no
// shopId in the request body at all, so there is nothing for a caller to
// target. The only shop a signup can ever join is the one it creates.
//
// **Isolation, not a lock.** The old bootstrap needed an advisory lock because
// "the first account" was a single, global, racing resource — two concurrent
// signups could not both win. A signup here only ever contends with itself:
// each one creates its own Shop row, so there is no shared state for two
// signups to race over, and the only serialisation that still matters is
// `email` being globally unique, which Postgres already enforces.
const signup = async (req, res, next) => {
  try {
    const { shopName, name, email, password } = req.body;

    const hashedPassword = await bcrypt.hash(password, 12);

    let user;
    try {
      // One nested write rather than an interactive transaction. Prisma runs a
      // nested create together with its parent on a single connection, so this
      // is still all-or-nothing: a duplicate email rolls the shop back with it,
      // which is the only thing the transaction was here for.
      //
      // WHY NOT `$transaction`. Shop and User are both audited, and the audit
      // middleware writes its row on the *global* client — so every in-flight
      // signup needed a second connection while its own transaction still held
      // the first. On the default pool of 9, eight concurrent signups returned
      // eight 500s and created nothing: five died on the 5s interactive
      // transaction timeout, three never got a connection at all. Worse, the
      // audit rows are written outside the transaction and so did *not* roll
      // back — the log kept five shop creations that never happened. Measured
      // through this path instead: 8/8 in 80ms, with auditing untouched.
      //
      // Deliberately not fixed by widening the pool or the timeout. Signup is
      // public, unauthenticated, and spends a cost-12 hash per call, so a
      // ceiling that merely moves is a ceiling that gets found.
      //
      // THE TRADE: a nested create is invisible to the middleware, which sees
      // only the top-level `user.create`, so the Shop gets no CREATE row of its
      // own here. Little is lost. That row carried no actor — signup is public,
      // so `protect` never ran to name one — and `Shop.createdAt` already
      // records that the shop was created and when. The User row that replaces
      // it is properly attributed and carries the shopId in its `after`. Shop
      // edits through `PUT /api/shop` are authenticated and audited as before.
      user = await prisma.user.create({
        data: {
          name,
          email,
          password: hashedPassword,
          role: "ADMIN",
          // Not set, unlike the seeded admin and unlike an administrator's
          // reset. Both of those hand someone a credential they did not
          // choose, which is what the flag exists to force them out of. This
          // password was chosen by the person typing it.
          mustChangePassword: false,
          shop: { create: { name: shopName } },
        },
      });
    } catch (err) {
      // Unique-constraint violation on User.email — someone already has an
      // account under this address, in this shop or another one.
      if (err.code === "P2002") {
        return res.status(409).json({
          success: false,
          message: "An account with this email already exists.",
        });
      }
      throw err;
    }

    // Signed in immediately, both halves, the way login does. Making the
    // operator type the password again on the next screen would prove nothing:
    // they chose it one request ago.
    const token = await issueSession(res, user);

    res.status(201).json({
      success: true,
      message: "Shop and administrator account created. You are signed in.",
      data: {
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          mustChangePassword: false,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── Register (Admin only) — add staff to the caller's own shop ───
const register = async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body;

    // Check if user exists. Email is globally unique, not per-shop, so this
    // is enough on its own — there is no "already registered in this shop"
    // versus "registered in another shop" distinction to make here.
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res
        .status(409)
        .json({ success: false, message: "Email already registered." });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        shopId: req.user.shopId,
        name,
        email,
        password: hashedPassword,
        role: role || "CASHIER",
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
      },
    });

    // A brand-new account is at revocation version 0. Passed explicitly rather
    // than left to the default, and not added to the `select` above, because
    // the counter is internal state and this select is the response shape.
    const token = generateToken(user.id, 0, req.user.shopId);

    res.status(201).json({
      success: true,
      message: "User registered successfully.",
      data: { user, token },
    });
  } catch (err) {
    next(err);
  }
};

// ─── Login ─────────────────────────────────────────────
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required.",
      });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    // Always pay for one bcrypt comparison, whether or not the account exists
    // (docs/07 P2-12). The three failures below already return an identical
    // body, but returning it in a fifth of the time when the email is unknown
    // told an attacker exactly as much — bcrypt at cost 12 is the expensive
    // part of this request, and skipping it is measurable from outside.
    //
    // Both misses had to be covered, not just the unknown email: a deactivated
    // account skipped the comparison too, so it was distinguishable from an
    // active one with the wrong password — which is itself a disclosure that
    // the account exists.
    const isMatch = await bcrypt.compare(
      password,
      user?.password ?? DUMMY_PASSWORD_HASH,
    );

    if (!user || !user.isActive || !isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials.",
      });
    }

    // Sets the refresh cookie as a side effect and returns the access token.
    const token = await issueSession(res, user);

    res.json({
      success: true,
      message: "Login successful.",
      data: {
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          // The client routes straight to the change-password screen on this.
          // The server refuses everything else regardless — see
          // middlewares/password-change.middleware.js.
          mustChangePassword: user.mustChangePassword,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── Get Current User ──────────────────────────────────
const getMe = async (req, res) => {
  res.json({
    success: true,
    data: { user: req.user },
  });
};

// ─── Change Password ───────────────────────────────────
const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    // The schema has already applied every rule that needs only the password
    // itself. This one needs the account: the request body carries no name or
    // email, so "don't use your own address as your password" can only be
    // checked here, where `protect` has already loaded the user.
    const contextProblem = passwordProblem(newPassword, {
      name: req.user.name,
      email: req.user.email,
    });
    if (contextProblem) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: [{ field: "newPassword", message: contextProblem }],
      });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: "Current password is incorrect.",
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    const [updated] = await prisma.$transaction([
      prisma.user.update({
        where: { id: req.user.id },
        data: {
          password: hashedPassword,
          // Clearing the flag here is what lets the user back into the system.
          mustChangePassword: false,
          // Changing a password is how someone responds to a compromise, so it
          // has to end the attacker's session and not merely the victim's
          // patience (docs/07 A-6). Bumping the counter invalidates every token
          // outstanding for this account.
          tokenVersion: { increment: 1 },
        },
        select: { tokenVersion: true },
      }),
      // The counter kills outstanding access tokens; this kills the refresh
      // tokens that would otherwise mint new ones. Same two halves as logout
      // and as an administrator's reset — either alone leaves the other
      // sessions alive until their next rotation.
      prisma.refreshToken.updateMany({
        where: { userId: req.user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    // ...including the one that just called, which would leave the caller
    // signed out by their own successful password change. So they are handed a
    // whole new session: whoever proved they know the current password keeps
    // working, and everyone else is out. That asymmetry is the entire point of
    // the control.
    //
    // BOTH halves have to be reissued, not just the access token. Handing back
    // a token while leaving the caller's refresh cookie pointing at the old
    // `tokenVersion` looked like it worked — the next request carried the new
    // token and succeeded — and then signed the caller out at the first silent
    // refresh, up to thirty minutes later, because `refresh` correctly rejects
    // a cookie whose counter has moved. That is the forced path for the seeded
    // admin and for every account an administrator resets, so the account most
    // likely to hit it was the one least able to explain it.
    const token = await issueSession(res, {
      id: req.user.id,
      shopId: req.user.shopId,
      tokenVersion: updated.tokenVersion,
    });

    res.json({
      success: true,
      message: "Password changed successfully.",
      data: { token },
    });
  } catch (err) {
    next(err);
  }
};

// ─── Logout ────────────────────────────────────────────
// Ends every session this user has open, not just the one that called
// (FR-AUTH-09). Until this existed, logout was a client-side localStorage
// clear: the token stayed valid for the rest of its seven days, and anyone
// holding a copy kept full access. The only lever was rotating JWT_SECRET,
// which signs out the entire shop.
//
// Increment rather than set, so two concurrent logouts cannot race to the same
// value — and so this composes with any future bump (a password change, an
// admin-forced sign-out) without either needing to know about the other.
//
// Deliberately mounted with `protect` alone. A user carrying
// mustChangePassword must still be able to end their session; trapping them in
// a state they can only leave by choosing a new password would be a worse
// outcome than the one the flag exists to prevent.
// ─── Self-service password reset (FR-AUTH-11) ────────────
//
// Two endpoints, both public: one to ask for a link, one to spend it. The
// account this exists for is the shopkeeper who signed up themselves since
// 2026-08-29 and has no administrator to ask — an admin-initiated reset
// (`POST /api/users/:id/reset-password`) covers staff and always did.

/**
 * `POST /api/auth/forgot-password`
 *
 * **Answers the same thing to everyone**, which is the constraint that shapes
 * the rest of it. A different status, body or obvious delay for a known address
 * turns this into a way to test whether somebody banks here — and pharmacy
 * custom is health-adjacent, which is threat T-9's whole premise.
 *
 * So: the response is fixed before any branch, the send happens *after* it, and
 * a send failure changes nothing the caller sees (`config/mailer.js` argues
 * that trade at length).
 */
const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;

    /**
     * Refuse rather than accept a reset this deployment cannot deliver.
     *
     * Until 2026-09-01 this case was caught at boot: the process exited if the
     * mail variables were unset. That took the whole API down — billing,
     * inventory, the GST return — for a feature none of them use, and in
     * production it did exactly that for two days.
     *
     * The refusal belongs here, where the thing that is broken actually is. It
     * is **not** an enumeration oracle: the answer depends only on the
     * deployment's configuration, so every address gets it, including
     * addresses with no account. 503 rather than 500 — the request was
     * well-formed and would succeed once somebody sets six variables.
     *
     * `resetPassword` is deliberately not guarded: a link already delivered
     * must keep working, and consuming a token needs no mail server.
     */
    if (!mailer.isConfigured() || !process.env.APP_URL?.trim()) {
      logger.error(
        { requestId: req.id },
        "password reset requested but mail is not configured",
      );
      return res.status(503).json({
        success: false,
        message:
          "Password reset is not configured on this system, so no link can be sent. Ask your administrator to reset your password for you.",
      });
    }

    // Said the same way on both paths, and deliberately not "we've sent you an
    // email" — which would be a lie on the unknown-address path, and the kind
    // of lie a user can catch.
    const answer = {
      success: true,
      message:
        "If that address has an account, a reset link is on its way. It is valid for 30 minutes. If it does not arrive, check the address and ask your administrator.",
    };

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, isActive: true },
    });

    // A deactivated account gets the same answer and no email. Letting it reset
    // would hand a suspended user a way back in; saying so would confirm the
    // account exists.
    if (!user || !user.isActive) {
      return res.json(answer);
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60_000);

    // Any earlier pending reset is spent first. Asking twice should leave one
    // working link rather than several, so a token read from an older email —
    // the one still sitting in the mailbox that may be the reason for the
    // reset — stops working the moment a new one is issued.
    await prisma.$transaction([
      prisma.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      }),
      prisma.passwordResetToken.create({
        data: { userId: user.id, tokenHash: hashResetToken(token), expiresAt },
      }),
    ]);

    // Answer first, send after. The caller's wait then does not include a
    // network round trip to somebody else's mail server — which is both the
    // timing half of "answers identically" and the reason a slow SMTP host
    // cannot hold a request open.
    res.json(answer);

    const link = `${(process.env.APP_URL || "").replace(/\/$/, "")}/reset-password?token=${token}`;
    // `void` because the response has already gone: nothing can be done with
    // the outcome here, and `sendMail` never rejects — it logs (mailer.js).
    void mailer.sendMail({
      to: user.email,
      subject: "Reset your Medical Billing password",
      text:
        `Hello ${user.name},\n\n` +
        `Someone asked to reset the password for this account. If that was you, open the link below within ${RESET_TOKEN_TTL_MINUTES} minutes:\n\n` +
        `${link}\n\n` +
        "Opening it will sign you out everywhere else, which is what you want if somebody else has your password.\n\n" +
        "If it was not you, you can ignore this — nothing has changed and the link will expire on its own.\n",
      requestId: req.id,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * `POST /api/auth/reset-password`
 *
 * Spends the token. Every refusal answers the same way for the same reason as
 * above — expired, already used and never existed are one message, because
 * telling them apart tells a guesser whether they are close.
 */
const resetPassword = async (req, res, next) => {
  try {
    const { token, newPassword } = req.body;

    const deny = () =>
      res.status(400).json({
        success: false,
        message:
          "That reset link is invalid or has expired. Request a new one.",
      });

    const row = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashResetToken(token) },
      include: {
        user: { select: { id: true, name: true, email: true, isActive: true } },
      },
    });

    if (!row || row.usedAt || row.expiresAt <= new Date()) return deny();
    if (!row.user?.isActive) return deny();

    // The same contextual rules a chosen password faces anywhere else: the
    // schema has checked everything that needs only the password, and this
    // needs the account, which the token is what identifies.
    const contextProblem = passwordProblem(newPassword, {
      name: row.user.name,
      email: row.user.email,
    });
    if (contextProblem) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: [{ field: "newPassword", message: contextProblem }],
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await prisma.$transaction([
      // Conditional on still being unused: two clicks on the same link, or two
      // tabs submitting at once, must apply once. `updateMany` with the
      // condition in the same `where` is the guard — the same shape as the
      // stock decrement (G-09), and for the same reason.
      prisma.passwordResetToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() },
      }),
      prisma.user.update({
        where: { id: row.user.id },
        data: {
          password: hashedPassword,
          // A reset is how somebody responds to losing control of an account,
          // so it ends every other session rather than merely changing what
          // the next login needs — the same reasoning as `changePassword`.
          tokenVersion: { increment: 1 },
          // Whoever completes this has chosen their own password, so there is
          // nothing left to force.
          mustChangePassword: false,
        },
      }),
      prisma.refreshToken.updateMany({
        where: { userId: row.user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      // Any other pending reset for this account dies with it. Someone who has
      // just recovered an account should not have a second live link addressed
      // to a mailbox that may be the thing that was compromised.
      prisma.passwordResetToken.updateMany({
        where: { userId: row.user.id, usedAt: null },
        data: { usedAt: new Date() },
      }),
    ]);

    // No session is issued. Unlike `changePassword`, nothing here proved the
    // caller is the account holder beyond possession of a mailbox, and signing
    // them straight in would make a stolen email a complete account takeover
    // in one step rather than one that still needs the new password typed.
    res.json({
      success: true,
      message:
        "Password reset. You have been signed out everywhere — sign in with your new password.",
    });
  } catch (err) {
    next(err);
  }
};

const logout = async (req, res, next) => {
  try {
    await prisma.$transaction([
      prisma.user.update({
        where: { id: req.user.id },
        data: { tokenVersion: { increment: 1 } },
      }),
      // The counter kills outstanding access tokens; this kills the refresh
      // tokens that would otherwise mint new ones. Both halves, or signing out
      // only ends the session until the next silent refresh.
      prisma.refreshToken.updateMany({
        where: { userId: req.user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());

    // 200 with no data: the client's job is to discard its copy, and there is
    // nothing to hand back. Calling it twice is harmless.
    res.json({
      success: true,
      message: "Signed out. All sessions for this account have ended.",
    });
  } catch (err) {
    next(err);
  }
};

// ─── Refresh ───────────────────────────────────────────
// Exchanges the refresh cookie for a new access token, and rotates the cookie.
// Public in the sense that it takes no Authorization header — the cookie is the
// credential, which is the point: the access token it replaces has expired.
//
// Rotation is what makes theft detectable. Each use revokes the row it was
// issued against and creates a new one, so presenting a row that is *already*
// revoked means two parties hold the same credential. A legitimate client never
// does that, so it is treated as theft and every session for the user ends.
const refresh = async (req, res, next) => {
  const deny = () => {
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
    return res
      .status(401)
      .json({
        success: false,
        message: "Session expired. Please sign in again.",
      });
  };

  try {
    const raw = readCookie(req, REFRESH_COOKIE);
    if (!raw) return deny();

    let decoded;
    try {
      decoded = jwt.verify(raw, process.env.JWT_SECRET);
    } catch {
      // Expired or forged. Indistinguishable to the caller on purpose.
      return deny();
    }
    if (!decoded.jti) return deny();

    const row = await prisma.refreshToken.findUnique({
      where: { id: decoded.jti },
    });
    if (!row || row.userId !== decoded.id) return deny();

    if (row.revokedAt) {
      // Reuse of a rotated token. Either the real client replayed an old cookie
      // — which it has no reason to do — or somebody else is holding a copy.
      // Cannot tell which, so assume the worse one and end everything: bump the
      // counter (kills outstanding access tokens) and revoke every row.
      await prisma.$transaction([
        prisma.user.update({
          where: { id: row.userId },
          data: { tokenVersion: { increment: 1 } },
        }),
        prisma.refreshToken.updateMany({
          where: { userId: row.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      ]);
      return deny();
    }

    if (row.expiresAt <= new Date()) return deny();

    const user = await prisma.user.findUnique({
      where: { id: row.userId },
      select: {
        id: true,
        shopId: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        mustChangePassword: true,
        tokenVersion: true,
      },
    });
    if (!user || !user.isActive) return deny();
    // The counter moved under us — a logout, a password change or a
    // deactivation happened after this cookie was issued.
    if ((decoded.tokenVersion ?? 0) !== user.tokenVersion) return deny();

    // Retire this row and open the next one in a single transaction, so a
    // crash between the two cannot leave a session with no live token.
    const expiresAt = new Date(
      Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    );
    const [, next] = await prisma.$transaction([
      prisma.refreshToken.update({
        where: { id: row.id },
        data: { revokedAt: new Date() },
      }),
      prisma.refreshToken.create({
        data: { userId: user.id, expiresAt },
        select: { id: true },
      }),
    ]);

    res.cookie(
      REFRESH_COOKIE,
      generateRefreshToken(user.id, user.tokenVersion, next.id, user.shopId),
      refreshCookieOptions(),
    );

    res.json({
      success: true,
      data: {
        token: generateToken(user.id, user.tokenVersion, user.shopId),
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          mustChangePassword: user.mustChangePassword,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  forgotPassword,
  resetPassword,
  signup,
  register,
  login,
  getMe,
  changePassword,
  logout,
  refresh,
};
