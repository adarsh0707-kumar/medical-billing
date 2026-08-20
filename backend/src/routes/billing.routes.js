const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middlewares/auth.middleware");
const requirePasswordChange = require("../middlewares/password-change.middleware");
const validate = require("../middlewares/validate.middleware");
const validateQuery = require("../middlewares/validate-query.middleware");
const {
  createInvoiceSchema,
  customerSchema,
  invoiceListQuerySchema,
  dailySummaryQuerySchema,
  gstReportQuerySchema,
  customerListQuerySchema,
} = require("../validators/billing.validator");

const billingCtrl = require("../controllers/billing.controller");
const customerCtrl = require("../controllers/customer.controller");

router.use(protect);
// Must follow protect: it reads req.user, which protect populates.
router.use(requirePasswordChange);

// ─── Customers ────────────────────────────────────────
router.get(
  "/customers",
  validateQuery(customerListQuerySchema),
  customerCtrl.getAll,
);
router.get("/customers/:id", customerCtrl.getOne);
router.post("/customers", validate(customerSchema), customerCtrl.create);
router.put("/customers/:id", validate(customerSchema), customerCtrl.update);

// ─── Invoices ─────────────────────────────────────────
router.get("/invoices", validateQuery(invoiceListQuerySchema), billingCtrl.getAll);
router.get(
  "/invoices/daily-summary",
  validateQuery(dailySummaryQuerySchema),
  billingCtrl.getDailySummary,
);
router.get(
  "/invoices/gst-report",
  authorize("ADMIN", "PHARMACIST"),
  validateQuery(gstReportQuerySchema),
  billingCtrl.getGstReport,
);
router.get("/invoices/:id", billingCtrl.getOne);
router.post(
  "/invoices",
  validate(createInvoiceSchema),
  billingCtrl.createInvoice,
);

module.exports = router;
