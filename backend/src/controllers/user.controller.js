const prisma = require("../config/db");
const bcrypt = require("bcryptjs");
const { generateTempPassword } = require("../utils/temp-password");

// Get all users — Admin only
const getAll = async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ success: true, data: users });
  } catch (err) {
    next(err);
  }
};

// Create user — Admin only
const create = async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res
        .status(409)
        .json({ success: false, message: "Email already exists" });
    }

    const hashed = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { name, email, password: hashed, role: role || "CASHIER" },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
      },
    });

    res
      .status(201)
      .json({
        success: true,
        message: "User created successfully",
        data: user,
      });
  } catch (err) {
    next(err);
  }
};

// Update user — Admin only
const update = async (req, res, next) => {
  try {
    const { name, email, role, isActive } = req.body;
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: {
        name,
        email,
        role,
        isActive,
        // Deactivating has to be a revocation, not a pause. `protect` already
        // rejects an inactive user, but that check is only in force while the
        // flag is set — reactivating the account brought every token that was
        // outstanding at deactivation back to life, including a stolen one.
        // Deactivate-then-reactivate is exactly what an administrator does to a
        // compromised account, so it must not hand the session back.
        //
        // Only on an explicit `false`: `isActive` is undefined on a partial
        // update, and renaming somebody should not sign them out.
        ...(isActive === false && { tokenVersion: { increment: 1 } }),
      },
      select: { id: true, name: true, email: true, role: true, isActive: true },
    });
    res.json({
      success: true,
      message: "User updated successfully",
      data: user,
    });
  } catch (err) {
    next(err);
  }
};

// Delete user — Admin only
const remove = async (req, res, next) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({
        success: false,
        message: "You can't delete your own account",
      });
    }
    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ success: true, message: "User deleted successfully" });
  } catch (err) {
    next(err);
  }
};

// Update own profile — Any logged in user
const updateProfile = async (req, res, next) => {
  try {
    const { name, email } = req.body;

    // Check email not taken by another user
    if (email) {
      const existing = await prisma.user.findFirst({
        where: { email, NOT: { id: req.user.id } },
      });
      if (existing) {
        return res
          .status(409)
          .json({ success: false, message: "Email already in use" });
      }
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { name, email },
      select: { id: true, name: true, email: true, role: true },
    });

    res.json({
      success: true,
      message: "Profile updated successfully",
      data: user,
    });
  } catch (err) {
    next(err);
  }
};

// Reset another user's password — Admin only (FR-AUTH-10)
//
// The recovery path for a locked-out account. There is no email in this stack,
// so a self-service "forgot password" link has nowhere to send a token; the
// administrator is the delivery channel, and hands the generated value over
// out of band. `scripts/reset-password.js` is the same operation for the case
// this route cannot serve — the last administrator locking themselves out,
// where there is nobody left holding a session to call it.
const resetPassword = async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, email: true },
    });
    if (!target) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Generated, never taken from the request body. An administrator choosing
    // the value is how `Welcome123` ends up on six accounts, and it would also
    // put a password an operator may have reused elsewhere into a request log.
    // Passing the target's identity applies the same "don't restate your own
    // name or address" rule the user's eventual chosen password must clear.
    const tempPassword = generateTempPassword({
      name: target.name,
      email: target.email,
    });
    const hashed = await bcrypt.hash(tempPassword, 12);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: target.id },
        data: {
          password: hashed,
          // What makes the generated value single-use: while this is set the
          // API refuses every route except signing in, reading your own
          // profile and changing your password (threat T-2). The temporary
          // credential can therefore do exactly one thing — replace itself.
          mustChangePassword: true,
          // A reset is a response to a compromise as often as to forgetfulness,
          // so it has to end whoever is already inside (docs/07 A-6). Same two
          // halves as logout: the counter kills outstanding access tokens, and
          // the sweep below kills the refresh tokens that would mint new ones.
          // Either alone leaves the session alive until the next rotation.
          tokenVersion: { increment: 1 },
        },
      }),
      prisma.refreshToken.updateMany({
        where: { userId: target.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    // The only time this value is ever readable. It is stored as a bcrypt hash
    // like any other password, so an administrator who loses it before handing
    // it over reruns the reset rather than looking it up.
    //
    // Resetting your own account is allowed and deliberately not special-cased:
    // it is a legitimate way to rotate a credential you believe is exposed. It
    // does sign you out — the revocation above does not exempt the caller, the
    // way `changePassword` does by reissuing a token — which is the correct
    // outcome for the compromise case and merely inconvenient otherwise.
    res.json({
      success: true,
      message:
        "Password reset. Give this password to the user — it is shown only once, " +
        "and they must change it at next sign-in.",
      data: {
        id: target.id,
        email: target.email,
        tempPassword,
        mustChangePassword: true,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getAll,
  create,
  update,
  remove,
  updateProfile,
  resetPassword,
};
