const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middlewares/auth.middleware");
const requirePasswordChange = require("../middlewares/password-change.middleware");
const validateQuery = require("../middlewares/validate-query.middleware");
const {
  dailySummaryQuerySchema,
  gstReportQuerySchema,
  monthlyReportQuerySchema,
  topSellersQuerySchema,
  yearlyReportQuerySchema,
  trendQuerySchema,
} = require("../validators/billing.validator");
const {
  expiringQuerySchema,
  lowStockQuerySchema,
} = require("../validators/inventory.validator");

const billingCtrl = require("../controllers/billing.controller");
const batchCtrl = require("../controllers/batch.controller");

/**
 * Reports — `/api/reports` (2.0.0).
 *
 * The five reports were scattered across two modules and buried under the
 * resource they happened to read: the daily summary and the GST return sat at
 * `/api/billing/invoices/...`, the expiry and low-stock reports at
 * `/api/inventory/batches/...`. Nothing about a GST return is a property of one
 * invoice, and a reader looking for "the reports" had to already know which
 * table each one queried.
 *
 * They are one thing from the outside — the screens that read them are one tab
 * group — so they are one router now, and the names lose the qualifier the path
 * already supplies (`gst-report` under `/reports` was saying it twice).
 *
 * The handlers are unchanged and still live with the data they read: nothing
 * here re-implements a report, and the deprecated aliases in `billing.routes.js`
 * and `inventory.routes.js` call these same functions, which is what makes the
 * two paths provably identical rather than merely similar.
 */

router.use(protect);
router.use(requirePasswordChange);

// ─── Sales ────────────────────────────────────────────
router.get(
  "/daily-summary",
  validateQuery(dailySummaryQuerySchema),
  billingCtrl.getDailySummary,
);
router.get(
  "/daily-summary/export",
  validateQuery(dailySummaryQuerySchema),
  billingCtrl.exportDailySummary,
);
router.get("/trend", validateQuery(trendQuerySchema), billingCtrl.getTrend);

// A month and a year of the same figures the daily summary prints, plus the
// breakdown that period is read as: a month by its days, a year by its months.
// Open to every role, like the daily summary — this is the shop's own trading
// record, not its filing position, which is what makes the GST report ADMIN and
// PHARMACIST only.
router.get(
  "/monthly",
  validateQuery(monthlyReportQuerySchema),
  billingCtrl.getMonthlyReport,
);
router.get(
  "/monthly/export",
  validateQuery(monthlyReportQuerySchema),
  billingCtrl.exportMonthlyReport,
);
router.get(
  "/yearly",
  validateQuery(yearlyReportQuerySchema),
  billingCtrl.getYearlyReport,
);
router.get(
  "/yearly/export",
  validateQuery(yearlyReportQuerySchema),
  billingCtrl.exportYearlyReport,
);

// What moved most in a month. Open to every role for the same reason as the
// period reports — it says what the shop sold, not what any of it cost, which
// is what keeps it on this side of the line from `/margin` below.
router.get(
  "/top-sellers",
  validateQuery(topSellersQuerySchema),
  billingCtrl.getTopSellers,
);
router.get(
  "/top-sellers/export",
  validateQuery(topSellersQuerySchema),
  billingCtrl.exportTopSellers,
);

// ─── Margin (FR-RPT-08) ───────────────────────────────
// ADMIN only, and the contrast with the two reports above is the point: those
// are open to everyone because a shop's takings are its own trading record.
// What the stock cost is not, so this sits with the GST return rather than with
// the period reports it otherwise mirrors exactly.
router.get(
  "/margin",
  authorize("ADMIN"),
  validateQuery(monthlyReportQuerySchema),
  billingCtrl.getMarginReport,
);
router.get(
  "/margin/export",
  authorize("ADMIN"),
  validateQuery(monthlyReportQuerySchema),
  billingCtrl.exportMarginReport,
);

// ─── Tax ──────────────────────────────────────────────
// A GST return is the shop's filing position, not a cashier's screen.
router.get(
  "/gst",
  authorize("ADMIN", "PHARMACIST"),
  validateQuery(gstReportQuerySchema),
  billingCtrl.getGstReport,
);
router.get(
  "/gst/export",
  authorize("ADMIN", "PHARMACIST"),
  validateQuery(gstReportQuerySchema),
  billingCtrl.exportGstReport,
);

// ─── Stock ────────────────────────────────────────────
router.get(
  "/expiring",
  validateQuery(expiringQuerySchema),
  batchCtrl.getExpiring,
);
router.get(
  "/expiring/export",
  validateQuery(expiringQuerySchema),
  batchCtrl.exportExpiring,
);
router.get(
  "/low-stock",
  validateQuery(lowStockQuerySchema),
  batchCtrl.getLowStock,
);
router.get(
  "/low-stock/export",
  validateQuery(lowStockQuerySchema),
  batchCtrl.exportLowStock,
);

module.exports = router;
