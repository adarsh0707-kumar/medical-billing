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
  trendQuerySchema,
  voidInvoiceSchema,
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
// Erasure, not deletion — the row survives because invoices reference it and are
// tax records. ADMIN only: this is irreversible and removes data the shop may be
// obliged to have had. See docs/07 section 8.
router.delete("/customers/:id", authorize("ADMIN"), customerCtrl.erase);

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

// ─── CSV exports (FR-RPT-09) ──────────────────────────
// Same data, same query schemas, same roles as the JSON reports above — only
// the serialisation differs. Money leaves as a 2 dp string rather than through
// the Decimal-to-Number replacer; see utils/csv.js.
router.get(
  "/invoices/daily-summary/export",
  validateQuery(dailySummaryQuerySchema),
  billingCtrl.exportDailySummary,
);
router.get(
  "/invoices/gst-report/export",
  authorize("ADMIN", "PHARMACIST"),
  validateQuery(gstReportQuerySchema),
  billingCtrl.exportGstReport,
);
// Above /invoices/:id, or "trend" is read as an invoice id.
router.get("/invoices/trend", validateQuery(trendQuerySchema), billingCtrl.getTrend);

router.get("/invoices/:id", billingCtrl.getOne);

// ADMIN only: voiding moves money and stock, and is the one billing action with
// no counterpart a cashier could need mid-shift.
router.post(
  "/invoices/:id/void",
  authorize("ADMIN"),
  validate(voidInvoiceSchema),
  billingCtrl.voidInvoice,
);
router.post(
  "/invoices",
  validate(createInvoiceSchema),
  billingCtrl.createInvoice,
);

module.exports = router;
