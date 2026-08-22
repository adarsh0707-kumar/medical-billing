const bcrypt = require("bcryptjs");
const prisma = require("../config/db");
const { generateToken } = require("../utils/jwt.utils");

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

    // Find user
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials.",
      });
    }

    // Compare password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials.",
      });
    }

    const token = generateToken(user.id, user.tokenVersion);

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

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: "Current password is incorrect.",
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    const updated = await prisma.user.update({
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
    });

    // ...including the one that just called, which would leave the caller
    // signed out by their own successful password change. So they get a fresh
    // token carrying the new counter: whoever proved they know the current
    // password keeps working, and everyone else is out. That asymmetry is the
    // entire point of the control.
    const token = generateToken(req.user.id, updated.tokenVersion);

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
    await prisma.user.update({
      where: { id: req.user.id },
      data: { tokenVersion: { increment: 1 } },
    });

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

module.exports = { register, login, getMe, changePassword, logout };
