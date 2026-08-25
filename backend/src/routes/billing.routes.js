const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middlewares/auth.middleware");
const requirePasswordChange = require("../middlewares/password-change.middleware");
const validate = require("../middlewares/validate.middleware");
const validateQuery = require("../middlewares/validate-query.middleware");
const { deprecate } = require("../middlewares/deprecate.middleware");
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

// ─── Customers — DEPRECATED, moved to /api/customers in 2.0.0 ─────────
//
// Kept for one minor version so existing clients keep working while they
// migrate. Every one of these calls the same controller function the new router
// does, so the two paths cannot drift; `deprecate` adds the Deprecation, Sunset
// and Link headers and logs who is still calling.
const movedCustomers = deprecate("/api/customers");

router.get(
  "/customers",
  movedCustomers,
  validateQuery(customerListQuerySchema),
  customerCtrl.getAll,
);
router.get("/customers/:id", movedCustomers, customerCtrl.getOne);
router.post(
  "/customers",
  movedCustomers,
  validate(customerSchema),
  customerCtrl.create,
);
router.put(
  "/customers/:id",
  movedCustomers,
  validate(customerSchema),
  customerCtrl.update,
);
router.delete(
  "/customers/:id",
  movedCustomers,
  authorize("ADMIN"),
  customerCtrl.erase,
);

// ─── Invoices ─────────────────────────────────────────
router.get("/invoices", validateQuery(invoiceListQuerySchema), billingCtrl.getAll);
// ─── Reports — DEPRECATED, moved to /api/reports in 2.0.0 ─────────────
// Nothing about a GST return is a property of one invoice; these were filed
// under the table they happen to read. Same handlers as the new router.
router.get(
  "/invoices/daily-summary",
  deprecate("/api/reports/daily-summary"),
  validateQuery(dailySummaryQuerySchema),
  billingCtrl.getDailySummary,
);
router.get(
  "/invoices/gst-report",
  deprecate("/api/reports/gst"),
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
  deprecate("/api/reports/daily-summary/export"),
  validateQuery(dailySummaryQuerySchema),
  billingCtrl.exportDailySummary,
);
router.get(
  "/invoices/gst-report/export",
  deprecate("/api/reports/gst/export"),
  authorize("ADMIN", "PHARMACIST"),
  validateQuery(gstReportQuerySchema),
  billingCtrl.exportGstReport,
);
// Above /invoices/:id, or "trend" is read as an invoice id.
router.get(
  "/invoices/trend",
  deprecate("/api/reports/trend"),
  validateQuery(trendQuerySchema),
  billingCtrl.getTrend,
);

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
