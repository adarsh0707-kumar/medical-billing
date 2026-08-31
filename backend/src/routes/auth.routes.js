const express = require("express");
const router = express.Router();
const {
  signup,
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
  signupSchema,
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
// ─── Signup ───────────────────────────────────────────
// Public, and stays public: this is how a new shopkeeper gets onto the system
// at all, so there is nobody signed in yet for `protect` to check. Each call
// creates its own Shop, so unlike the single-tenant bootstrap this replaced,
// there is nothing here to close.
router.post("/signup", validate(signupSchema), signup);

router.post("/login", login); // public
// No `protect`: the caller's access token has expired, which is why they are
// here. The refresh cookie is the credential.
//
// This is the only route in the API with a CSRF surface — every other protected
// route takes a Bearer token another origin's script cannot read, while here
// the browser attaches the credential itself. Its guard, `requireKnownOrigin`,
// is **not** mounted here: it is in `app.js`, ahead of the CORS middleware,
// because CORS would otherwise reject a foreign origin first and turn a 403
// into a 500. See the comment there.
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
