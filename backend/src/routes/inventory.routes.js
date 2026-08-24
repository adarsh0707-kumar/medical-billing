const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middlewares/auth.middleware");
const requirePasswordChange = require("../middlewares/password-change.middleware");
const validate = require("../middlewares/validate.middleware");
const validateQuery = require("../middlewares/validate-query.middleware");
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

// ─── Medicines ────────────────────────────────────────
router.get(
  "/medicines/search",
  validateQuery(medicineSearchQuerySchema),
  medicineCtrl.search,
); // for POS billing search
router.get(
  "/medicines",
  validateQuery(medicineListQuerySchema),
  medicineCtrl.getAll,
);
router.get("/medicines/:id", medicineCtrl.getOne);
router.post(
  "/medicines",
  authorize("ADMIN", "PHARMACIST"),
  validate(medicineSchema),
  medicineCtrl.create,
);
router.put(
  "/medicines/:id",
  authorize("ADMIN", "PHARMACIST"),
  validate(medicineSchema),
  medicineCtrl.update,
);
router.delete("/medicines/:id", authorize("ADMIN"), medicineCtrl.remove);

// ─── Batches / Stock ──────────────────────────────────
router.get("/batches", validateQuery(batchListQuerySchema), batchCtrl.getAll);
router.get(
  "/batches/expiring",
  validateQuery(expiringQuerySchema),
  batchCtrl.getExpiring,
);
router.get(
  "/batches/low-stock",
  validateQuery(lowStockQuerySchema),
  batchCtrl.getLowStock,
);

// ─── CSV exports (FR-RPT-09) ──────────────────────────
router.get(
  "/batches/expiring/export",
  validateQuery(expiringQuerySchema),
  batchCtrl.exportExpiring,
);
router.get(
  "/batches/low-stock/export",
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

// ─── Suppliers ────────────────────────────────────────
router.get(
  "/suppliers",
  validateQuery(supplierListQuerySchema),
  supplierCtrl.getAll,
);
router.get("/suppliers/:id", supplierCtrl.getOne);
router.post(
  "/suppliers",
  authorize("ADMIN", "PHARMACIST"),
  validate(supplierSchema),
  supplierCtrl.create,
);
router.put(
  "/suppliers/:id",
  authorize("ADMIN", "PHARMACIST"),
  validate(supplierSchema),
  supplierCtrl.update,
);
router.delete("/suppliers/:id", authorize("ADMIN"), supplierCtrl.remove);

module.exports = router;
