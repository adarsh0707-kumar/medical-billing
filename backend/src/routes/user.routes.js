const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middlewares/auth.middleware");
const {
  getAll,
  create,
  update,
  remove,
  updateProfile,
} = require("../controllers/user.controller");

router.use(protect);

// Own profile update (any logged in user)
router.put("/profile", updateProfile);

// Admin only routes
router.get("/", authorize("ADMIN"), getAll);
router.post("/", authorize("ADMIN"), create);
router.put("/:id", authorize("ADMIN"), update);
router.delete("/:id", authorize("ADMIN"), remove);

module.exports = router;
