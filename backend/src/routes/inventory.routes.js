const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middlewares/auth.middleware");
const validate = require("../middlewares/validate.middleware");
const {
  categorySchema,
  manufacturerSchema,
  medicineSchema,
  batchSchema,
  supplierSchema,
} = require("../validators/inventory.validator");

const categoryCtrl = require("../controllers/category.controller");
const manufacturerCtrl = require("../controllers/manufacturer.controller");
const medicineCtrl = require("../controllers/medicine.controller");
const batchCtrl = require("../controllers/batch.controller");
const supplierCtrl = require("../controllers/supplier.controller");

// All routes require authentication
router.use(protect);

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
router.get("/medicines/search", medicineCtrl.search); // for POS billing search
router.get("/medicines", medicineCtrl.getAll);
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
router.get("/batches", batchCtrl.getAll);
router.get("/batches/expiring", batchCtrl.getExpiring);
router.get("/batches/low-stock", batchCtrl.getLowStock);
router.post(
  "/batches",
  authorize("ADMIN", "PHARMACIST"),
  validate(batchSchema),
  batchCtrl.create,
);
router.put("/batches/:id", authorize("ADMIN", "PHARMACIST"), batchCtrl.update);

// ─── Suppliers ────────────────────────────────────────
router.get("/suppliers", supplierCtrl.getAll);
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
