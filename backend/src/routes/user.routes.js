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

module.exports = router;
