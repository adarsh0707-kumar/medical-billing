const bcrypt = require("bcryptjs");
const prisma = require("../config/db");
const jwt = require("jsonwebtoken");
const {
  generateToken,
  generateRefreshToken,
  REFRESH_TOKEN_TTL_DAYS,
} = require("../utils/jwt.utils");

const { passwordProblem } = require("../validators/password");

const REFRESH_COOKIE = "refresh_token";

// Thrown from inside the signup transaction when the installation turns out to
// already have an account. Its own class so the catch can tell it apart from a
// genuine database fault and answer 409 rather than 500 — the same split
// `protect` makes between a bad credential and infrastructure trouble.
class SetupClosedError extends Error {
  constructor() {
    super("Setup already complete");
    this.name = "SetupClosedError";
  }
}

// Raised when another signup request holds the advisory lock. Distinct from
// SetupClosedError because it is a different answer: the installation is not
// necessarily claimed, someone is merely mid-claim. Retryable, and told so.
class SetupInProgressError extends Error {
  constructor() {
    super("Setup already in progress");
    this.name = "SetupInProgressError";
  }
}

// The advisory-lock key for first-run signup. An arbitrary constant — advisory
// locks are a namespace the application owns, and nothing else in this codebase
// takes one, so any value would do. It is written out rather than hashed from a
// string so that `SELECT * FROM pg_locks` is greppable against this file.
const SIGNUP_LOCK_KEY = 8241990001n;

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
// token. SameSite=Strict means a cross-site request never carries it, which is
// what stands in for CSRF protection on the refresh route. Path scopes it to the
// auth endpoints, so it is not attached to every API call. Secure only in
// production, because the development stack is deliberately plain HTTP and a
// Secure cookie would simply never be sent there.
const refreshCookieOptions = () => ({
  httpOnly: true,
  sameSite: "strict",
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
    generateRefreshToken(user.id, user.tokenVersion, row.id),
    refreshCookieOptions(),
  );

  return generateToken(user.id, user.tokenVersion);
};

// ─── First-run setup ───────────────────────────────────
//
// Whether the shop still needs its first account. Public, and deliberately
// answers with one boolean and nothing else: before setup it says "nobody has
// claimed this installation", and after it says only "signup is closed". It
// does not leak how many users exist, who they are, or when they were created.
//
// The login page reads this to decide whether to offer the signup link at all,
// which is a courtesy — `signup` below refuses on its own regardless of what
// the client renders, in the same way `password-change.middleware.js` is the
// control and its screen is only the manners.
const setupStatus = async (req, res, next) => {
  try {
    const users = await prisma.user.count();
    res.json({ success: true, data: { needsSetup: users === 0 } });
  } catch (err) {
    next(err);
  }
};

// ─── Signup — the first administrator, once ────────────
//
// The only public route that creates an account, and it exists for exactly one
// moment: a fresh installation with an empty user table. It hands that first
// account ADMIN, because a shop with no administrator cannot create one.
//
// **Why this is not open registration.** Every authenticated role can read
// customer records, and purchase history in a pharmacy reveals health
// conditions (threat T-9). A public signup that worked more than once would let
// anyone who can reach the URL read all of it. So the endpoint closes itself
// permanently the moment it succeeds, and every later caller gets a 409.
//
// **Why it is better than the seeded admin it replaces.** `npm run seed`
// creates admin@medstore.com with a password printed in this repository, and
// SECURITY.md has carried that as its first known issue since the beginning.
// The mitigation was `mustChangePassword` — the account can sign in and do
// exactly one thing. This is the same idea moved earlier: there is no published
// credential at all, because the operator chooses the first one. The seed stays
// for development and for anyone who prefers it.
const signup = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;

    // Fast path, and only that. It answers the overwhelmingly common case — an
    // installed system — without taking a lock, but it is an optimisation and
    // never the guard: the authoritative check is inside the transaction below,
    // because anything read outside one is a statement about the past.
    if ((await prisma.user.count()) > 0) {
      return res.status(409).json({
        success: false,
        code: "SETUP_ALREADY_COMPLETE",
        message:
          "This system already has an account. Ask an administrator to create yours.",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    let user;
    try {
      user = await prisma.$transaction(async (tx) => {
        // THE GUARD. `count() === 0` followed by `create()` is a read-then-write
        // race of exactly the shape G-01 and G-09 were: two requests arriving
        // together both read zero, both insert, and the installation ends up
        // with two administrators nobody chose. It is a one-shot endpoint, so
        // the window is small and permanent — precisely the kind that gets
        // dismissed and then happens.
        //
        // Postgres has no "insert if the table is empty" as a single statement
        // the way the invoice counter has an upsert — that would need a raw
        // INSERT ... WHERE NOT EXISTS, and `id` is a client-side cuid, so the
        // one row created that way would carry an id in a different shape from
        // every other user's.
        //
        // So the serialisation is a lock, and `try` is the important half.
        // `LOCK TABLE "User" IN EXCLUSIVE MODE` was tried first and is worse
        // than it looks: a queued transaction holds its pooled connection while
        // it waits, so a burst of eight jammed the pool and every request died
        // on the transaction timeout — correct, in that no second administrator
        // was ever created, but answering 500 to all of them. `pg_try_advisory_
        // xact_lock` returns false instead of waiting, so a loser costs one
        // round trip and no queue, and the lock is released on commit.
        const [{ acquired }] = await tx.$queryRaw`
          SELECT pg_try_advisory_xact_lock(${SIGNUP_LOCK_KEY}) AS acquired`;
        // Somebody else is inside this block right now. They will either create
        // the account or fail; either way the honest answer is "not you, and
        // not now" rather than a second insert.
        if (!acquired) throw new SetupInProgressError();

        if ((await tx.user.count()) > 0) throw new SetupClosedError();

        return tx.user.create({
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
          },
        });
      });
    } catch (err) {
      if (err instanceof SetupClosedError) {
        return res.status(409).json({
          success: false,
          code: "SETUP_ALREADY_COMPLETE",
          message:
            "This system already has an account. Ask an administrator to create yours.",
        });
      }
      if (err instanceof SetupInProgressError) {
        return res.status(409).json({
          success: false,
          code: "SETUP_IN_PROGRESS",
          message: "Setup is already under way. Try again in a moment.",
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
      message: "Administrator account created. You are signed in.",
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

// ─── Register (Admin only, first time setup) ───────────
const register = async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body;

    // Check if user exists
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res
        .status(409)
        .json({ success: false, message: "Email already registered." });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: { name, email, password: hashedPassword, role: role || "CASHIER" },
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
    const token = generateToken(user.id, 0);

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
      .json({ success: false, message: "Session expired. Please sign in again." });
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
      generateRefreshToken(user.id, user.tokenVersion, next.id),
      refreshCookieOptions(),
    );

    res.json({
      success: true,
      data: {
        token: generateToken(user.id, user.tokenVersion),
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
  setupStatus,
  signup,
  register,
  login,
  getMe,
  changePassword,
  logout,
  refresh,
};
