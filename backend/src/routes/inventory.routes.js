const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middlewares/auth.middleware");
const requirePasswordChange = require("../middlewares/password-change.middleware");
const validate = require("../middlewares/validate.middleware");
const validateQuery = require("../middlewares/validate-query.middleware");
const { deprecate } = require("../middlewares/deprecate.middleware");
const {
  categorySchema,
  manufacturerSchema,
  medicineSchema,
  batchSchema,
  batchUpdateSchema,
  batchAdjustSchema,
  supplierSchema,
  medicineListQuerySchema,
  medicineSearchQuerySchema,
  batchListQuerySchema,
  expiringQuerySchema,
  lowStockQuerySchema,
  supplierListQuerySchema,
} = require("../validators/inventory.validator");

const categoryCtrl = require("../controllers/category.controller");
const manufacturerCtrl = require("../controllers/manufacturer.controller");
const medicineCtrl = require("../controllers/medicine.controller");
const batchCtrl = require("../controllers/batch.controller");
const supplierCtrl = require("../controllers/supplier.controller");

// All routes require authentication
router.use(protect);
// Must follow protect: it reads req.user, which protect populates.
router.use(requirePasswordChange);

// ─── Categories ───────────────────────────────────────
router.get("/categories", categoryCtrl.getAll);
router.post(
  "/categories",
  authorize("ADMIN", "PHARMACIST"),
  validate(categorySchema),
  categoryCtrl.create,
);
router.put(
  "/categories/:id",
  authorize("ADMIN", "PHARMACIST"),
  validate(categorySchema),
  categoryCtrl.update,
);
router.delete("/categories/:id", authorize("ADMIN"), categoryCtrl.remove);

// ─── Manufacturers ────────────────────────────────────
router.get("/manufacturers", manufacturerCtrl.getAll);
router.post(
  "/manufacturers",
  authorize("ADMIN", "PHARMACIST"),
  validate(manufacturerSchema),
  manufacturerCtrl.create,
);
router.put(
  "/manufacturers/:id",
  authorize("ADMIN", "PHARMACIST"),
  validate(manufacturerSchema),
  manufacturerCtrl.update,
);
router.delete(
  "/manufacturers/:id",
  authorize("ADMIN"),
  manufacturerCtrl.remove,
);

// ─── Medicines — DEPRECATED, moved to /api/medicines in 2.0.0 ─────────
const movedMedicines = deprecate("/api/medicines");

router.get(
  "/medicines/search",
  movedMedicines,
  validateQuery(medicineSearchQuerySchema),
  medicineCtrl.search,
);
router.get(
  "/medicines",
  movedMedicines,
  validateQuery(medicineListQuerySchema),
  medicineCtrl.getAll,
);
router.get("/medicines/:id", movedMedicines, medicineCtrl.getOne);
router.post(
  "/medicines",
  movedMedicines,
  authorize("ADMIN", "PHARMACIST"),
  validate(medicineSchema),
  medicineCtrl.create,
);
router.put(
  "/medicines/:id",
  movedMedicines,
  authorize("ADMIN", "PHARMACIST"),
  validate(medicineSchema),
  medicineCtrl.update,
);
router.delete(
  "/medicines/:id",
  movedMedicines,
  authorize("ADMIN"),
  medicineCtrl.remove,
);

// ─── Batches / Stock ──────────────────────────────────
router.get("/batches", validateQuery(batchListQuerySchema), batchCtrl.getAll);
// ─── Stock reports — DEPRECATED, moved to /api/reports in 2.0.0 ───────
router.get(
  "/batches/expiring",
  deprecate("/api/reports/expiring"),
  validateQuery(expiringQuerySchema),
  batchCtrl.getExpiring,
);
router.get(
  "/batches/low-stock",
  deprecate("/api/reports/low-stock"),
  validateQuery(lowStockQuerySchema),
  batchCtrl.getLowStock,
);

// ─── CSV exports (FR-RPT-09) ──────────────────────────
router.get(
  "/batches/expiring/export",
  deprecate("/api/reports/expiring/export"),
  validateQuery(expiringQuerySchema),
  batchCtrl.exportExpiring,
);
router.get(
  "/batches/low-stock/export",
  deprecate("/api/reports/low-stock/export"),
  validateQuery(lowStockQuerySchema),
  batchCtrl.exportLowStock,
);
router.post(
  "/batches",
  authorize("ADMIN", "PHARMACIST"),
  validate(batchSchema),
  batchCtrl.create,
);
router.put(
  "/batches/:id",
  authorize("ADMIN", "PHARMACIST"),
  validate(batchUpdateSchema),
  batchCtrl.update,
);
// FR-BATCH-11. Its own verb and its own schema, deliberately — `quantity` stays
// rejected by the update above (G-05), so stock never moves through a general
// edit. ADMIN and PHARMACIST: the people who handle physical stock.
router.post(
  "/batches/:id/adjust",
  authorize("ADMIN", "PHARMACIST"),
  validate(batchAdjustSchema),
  batchCtrl.adjust,
);

// ─── Suppliers — DEPRECATED, moved to /api/suppliers in 2.0.0 ─────────
const movedSuppliers = deprecate("/api/suppliers");

router.get(
  "/suppliers",
  movedSuppliers,
  validateQuery(supplierListQuerySchema),
  supplierCtrl.getAll,
);
router.get("/suppliers/:id", movedSuppliers, supplierCtrl.getOne);
router.post(
  "/suppliers",
  movedSuppliers,
  authorize("ADMIN", "PHARMACIST"),
  validate(supplierSchema),
  supplierCtrl.create,
);
router.put(
  "/suppliers/:id",
  movedSuppliers,
  authorize("ADMIN", "PHARMACIST"),
  validate(supplierSchema),
  supplierCtrl.update,
);
router.delete(
  "/suppliers/:id",
  movedSuppliers,
  authorize("ADMIN"),
  supplierCtrl.remove,
);

module.exports = router;
