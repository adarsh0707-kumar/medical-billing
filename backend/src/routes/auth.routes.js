const express = require("express");
const router = express.Router();
const {
  register,
  login,
  getMe,
  changePassword,
  logout,
  refresh,
} = require("../controllers/auth.controller");
const { protect, authorize } = require("../middlewares/auth.middleware");
const requirePasswordChange = require("../middlewares/password-change.middleware");
const validate = require("../middlewares/validate.middleware");
const {
  createUserSchema,
  changePasswordSchema,
} = require("../validators/user.validator");

router.post(
  "/register",
  protect,
  requirePasswordChange,
  authorize("ADMIN"),
  validate(createUserSchema),
  register,
); // only admin can create users
router.post("/login", login); // public
// No `protect`: the caller's access token has expired, which is why they are
// here. The refresh cookie is the credential.
router.post("/refresh", refresh); // public — authenticates via the cookie
router.get("/me", protect, getMe); // any logged in user
router.put(
  "/change-password",
  protect,
  validate(changePasswordSchema),
  changePassword,
); // any logged in user
// No requirePasswordChange, for the same reason /me and /change-password omit
// it: a blocked account must still be able to end its own session.
router.post("/logout", protect, logout); // any logged in user

module.exports = router;
