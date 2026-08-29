const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middlewares/auth.middleware");
const requirePasswordChange = require("../middlewares/password-change.middleware");
const validate = require("../middlewares/validate.middleware");
const { updateShopSchema } = require("../validators/shop.validator");
const { getShop, updateShop } = require("../controllers/shop.controller");

router.use(protect);
// Must follow protect: it reads req.user, which protect populates.
router.use(requirePasswordChange);

// Any signed-in role: the invoice print view needs this to render its header.
router.get("/", getShop);
// Only an administrator edits the shop's own business details.
router.put("/", authorize("ADMIN"), validate(updateShopSchema), updateShop);

module.exports = router;
