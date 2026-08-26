const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middlewares/auth.middleware");
const requirePasswordChange = require("../middlewares/password-change.middleware");
const validate = require("../middlewares/validate.middleware");
const {
  createUserSchema,
  updateUserSchema,
  updateProfileSchema,
} = require("../validators/user.validator");
const {
  getAll,
  create,
  update,
  remove,
  updateProfile,
  resetPassword,
} = require("../controllers/user.controller");

router.use(protect);
// Must follow protect: it reads req.user, which protect populates.
router.use(requirePasswordChange);

// Own profile update (any logged in user)
router.put("/profile", validate(updateProfileSchema), updateProfile);

// Admin only routes
router.get("/", authorize("ADMIN"), getAll);
router.post("/", authorize("ADMIN"), validate(createUserSchema), create);
router.put("/:id", authorize("ADMIN"), validate(updateUserSchema), update);
router.delete("/:id", authorize("ADMIN"), remove);
// Takes no body: the password is generated server-side, so there is no request
// contract to validate and nothing for `validate()` to do here.
//
// Sits under the router-level `requirePasswordChange` on purpose. An
// administrator who has not yet replaced their own temporary password cannot
// reset anybody else's — otherwise a freshly reset admin account, which is the
// one most likely to be in someone else's hands, could reset its way across
// every account in the shop without ever proving it knows a chosen password.
router.post("/:id/reset-password", authorize("ADMIN"), resetPassword);

module.exports = router;
