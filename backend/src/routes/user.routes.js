const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middlewares/auth.middleware");
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

// Own profile update (any logged in user)
router.put("/profile", validate(updateProfileSchema), updateProfile);

// Admin only routes
router.get("/", authorize("ADMIN"), getAll);
router.post("/", authorize("ADMIN"), validate(createUserSchema), create);
router.put("/:id", authorize("ADMIN"), validate(updateUserSchema), update);
router.delete("/:id", authorize("ADMIN"), remove);

module.exports = router;
