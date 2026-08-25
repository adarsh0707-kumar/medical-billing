const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middlewares/auth.middleware");
const requirePasswordChange = require("../middlewares/password-change.middleware");
const validate = require("../middlewares/validate.middleware");
const validateQuery = require("../middlewares/validate-query.middleware");
const {
  supplierSchema,
  supplierListQuerySchema,
} = require("../validators/inventory.validator");

const supplierCtrl = require("../controllers/supplier.controller");

/**
 * Suppliers — `/api/suppliers` (2.0.0).
 *
 * Lived at `/api/inventory/suppliers` until 2.0.0. A supplier is a counterparty,
 * not a unit of stock; batches reference one, which is the whole of its
 * relationship to inventory.
 */

router.use(protect);
router.use(requirePasswordChange);

router.get("/", validateQuery(supplierListQuerySchema), supplierCtrl.getAll);
router.get("/:id", supplierCtrl.getOne);
router.post(
  "/",
  authorize("ADMIN", "PHARMACIST"),
  validate(supplierSchema),
  supplierCtrl.create,
);
router.put(
  "/:id",
  authorize("ADMIN", "PHARMACIST"),
  validate(supplierSchema),
  supplierCtrl.update,
);
router.delete("/:id", authorize("ADMIN"), supplierCtrl.remove);

module.exports = router;
