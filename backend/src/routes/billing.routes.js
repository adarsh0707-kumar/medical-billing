const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middlewares/auth.middleware");
const validate = require("../middlewares/validate.middleware");
const {
  createInvoiceSchema,
  customerSchema,
} = require("../validators/billing.validator");

const billingCtrl = require("../controllers/billing.controller");
const customerCtrl = require("../controllers/customer.controller");

router.use(protect);

// ─── Customers ────────────────────────────────────────
router.get("/customers", customerCtrl.getAll);
router.get("/customers/:id", customerCtrl.getOne);
router.post("/customers", validate(customerSchema), customerCtrl.create);
router.put("/customers/:id", validate(customerSchema), customerCtrl.update);

// ─── Invoices ─────────────────────────────────────────
router.get("/invoices", billingCtrl.getAll);
router.get("/invoices/daily-summary", billingCtrl.getDailySummary);
router.get(
  "/invoices/gst-report",
  authorize("ADMIN", "PHARMACIST"),
  billingCtrl.getGstReport,
);
router.get("/invoices/:id", billingCtrl.getOne);
router.post(
  "/invoices",
  validate(createInvoiceSchema),
  billingCtrl.createInvoice,
);

module.exports = router;
