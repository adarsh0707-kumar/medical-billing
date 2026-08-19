const express = require("express");
const router = express.Router();
const {
  register,
  login,
  getMe,
  changePassword,
} = require("../controllers/auth.controller");
const { protect, authorize } = require("../middlewares/auth.middleware");
const validate = require("../middlewares/validate.middleware");
const {
  createUserSchema,
  changePasswordSchema,
} = require("../validators/user.validator");

router.post(
  "/register",
  protect,
  authorize("ADMIN"),
  validate(createUserSchema),
  register,
); // only admin can create users
router.post("/login", login); // public
router.get("/me", protect, getMe); // any logged in user
router.put(
  "/change-password",
  protect,
  validate(changePasswordSchema),
  changePassword,
); // any logged in user

module.exports = router;
