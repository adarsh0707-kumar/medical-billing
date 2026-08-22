const jwt = require("jsonwebtoken");
const prisma = require("../config/db");
const { setActor } = require("../config/audit-context");

// The two halves of this middleware fail for completely different reasons, so
// they get separate catches. Verifying the token is a statement about the
// caller's credential; reloading the user is infrastructure. Catching both and
// answering 401 meant a database blip was reported as "Invalid token." — and
// since lib/api.ts clears localStorage on any 401, a few seconds of database
// trouble signed out every active user and told them their session was invalid.
const protect = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      message: "Access denied. No token provided.",
    });
  }

  let decoded;
  try {
    decoded = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res
        .status(401)
        .json({ success: false, message: "Token expired." });
    }
    if (err.name === "JsonWebTokenError" || err.name === "NotBeforeError") {
      return res
        .status(401)
        .json({ success: false, message: "Invalid token." });
    }
    // jsonwebtoken raises only its own error classes today, including for an
    // unset secret ("secret or public key must be provided" is a
    // JsonWebTokenError). Anything outside them would be a fault on our side, and
    // reporting that as a bad credential is what this whole split exists to stop.
    return next(err);
  }

  try {
    // Reloaded on every request so deactivating a user takes effect immediately
    // (FR-AUTH-04, invariant I-7).
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
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

    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        message: "User not found or deactivated.",
      });
    }

    // Revocation (FR-AUTH-09). The token carries the counter as it stood when
    // it was signed; logout increments the column, so every token issued before
    // it stops verifying here. Free, because the row is already loaded.
    //
    // A missing claim reads as 0, which is the column's default — tokens issued
    // before this control existed keep working until that user logs out once,
    // so shipping it did not sign everybody out.
    if ((decoded.tokenVersion ?? 0) !== user.tokenVersion) {
      return res.status(401).json({
        success: false,
        message: "Session ended. Please sign in again.",
      });
    }

    req.user = user;
    // Tells the audit middleware who is writing, without any controller having
    // to pass an actor down to the data layer (NFR-17).
    setActor(user);
    next();
  } catch (err) {
    next(err);
  }
};

// Role-based access control
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Required role: ${roles.join(" or ")}`,
      });
    }
    next();
  };
};

module.exports = { protect, authorize };
