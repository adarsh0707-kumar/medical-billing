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

    const token = generateToken(user.id);

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

    const token = generateToken(user.id);

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
    await prisma.user.update({
      where: { id: req.user.id },
      // Clearing the flag here is what lets the user back into the system.
      data: { password: hashedPassword, mustChangePassword: false },
    });

    res.json({ success: true, message: "Password changed successfully." });
  } catch (err) {
    next(err);
  }
};

module.exports = { register, login, getMe, changePassword };
