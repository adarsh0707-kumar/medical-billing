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

module.exports = { register, login, getMe, changePassword, logout, refresh };
