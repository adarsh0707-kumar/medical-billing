const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middlewares/auth.middleware");
const requirePasswordChange = require("../middlewares/password-change.middleware");
const validate = require("../middlewares/validate.middleware");
const validateQuery = require("../middlewares/validate-query.middleware");
const {
  customerSchema,
  customerListQuerySchema,
} = require("../validators/billing.validator");

const customerCtrl = require("../controllers/customer.controller");

/**
 * Customers — `/api/customers` (2.0.0).
 *
 * Lived at `/api/billing/customers` until 2.0.0, because the routers were
 * grouped by module rather than by resource. A customer is not a billing
 * concept: they exist before a sale and survive every one, which is why erasure
 * has to blank the row rather than delete it. The old path still works and is
 * marked deprecated — see `app.js`.
 */

router.use(protect);
// Must follow protect: it reads req.user, which protect populates.
router.use(requirePasswordChange);

router.get("/", validateQuery(customerListQuerySchema), customerCtrl.getAll);
router.get("/:id", customerCtrl.getOne);
router.post("/", validate(customerSchema), customerCtrl.create);
router.put("/:id", validate(customerSchema), customerCtrl.update);
// Erasure, not deletion — the row survives because invoices reference it and are
// tax records. ADMIN only: this is irreversible and removes data the shop may be
// obliged to have had. See docs/07 section 8.
router.delete("/:id", authorize("ADMIN"), customerCtrl.erase);

module.exports = router;
