const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middlewares/auth.middleware");
const requirePasswordChange = require("../middlewares/password-change.middleware");
const validate = require("../middlewares/validate.middleware");
const validateQuery = require("../middlewares/validate-query.middleware");
const {
  medicineSchema,
  medicineListQuerySchema,
  medicineSearchQuerySchema,
} = require("../validators/inventory.validator");

const medicineCtrl = require("../controllers/medicine.controller");

/**
 * Medicines — `/api/medicines` (2.0.0).
 *
 * Lived at `/api/inventory/medicines` until 2.0.0. Batches, categories and
 * manufacturers stay under `/api/inventory`: those are genuinely stock-keeping
 * concerns, whereas a medicine is the catalogue entry every other resource
 * points at.
 */

router.use(protect);
router.use(requirePasswordChange);

// Literal before parameterised, or "search" is read as a medicine id.
router.get(
  "/search",
  validateQuery(medicineSearchQuerySchema),
  medicineCtrl.search,
); // the POS lookup
router.get("/", validateQuery(medicineListQuerySchema), medicineCtrl.getAll);
router.get("/:id", medicineCtrl.getOne);
router.post(
  "/",
  authorize("ADMIN", "PHARMACIST"),
  validate(medicineSchema),
  medicineCtrl.create,
);
router.put(
  "/:id",
  authorize("ADMIN", "PHARMACIST"),
  validate(medicineSchema),
  medicineCtrl.update,
);
router.delete("/:id", authorize("ADMIN"), medicineCtrl.remove);

module.exports = router;
