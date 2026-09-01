const { z } = require("zod");
const { page, limit, searchTerm } = require("./common.validator");

const categorySchema = z.object({
  name: z.string().min(2, "Category name must be at least 2 characters"),
});

const manufacturerSchema = z.object({
  name: z.string().min(2, "Manufacturer name must be at least 2 characters"),
});

const medicineSchema = z.object({
  name: z.string().min(2, "Medicine name is required"),
  genericName: z.string().optional(),
  categoryId: z.string().min(1, "Category is required"),
  manufacturerId: z.string().min(1, "Manufacturer is required"),
  hsnCode: z.string().optional(),
  // Printed on the invoice as PACK. Free text — it is a label off the
  // carton ("1*15ML"), not a quantity, so no shape is imposed on it.
  packSize: z.string().max(30, "Pack size is too long").optional(),
  /**
   * The dispensing unit. Nine values were hard-coded here as an enum, so a
   * shop that sells vials, sachets, strips or tubes had to file them under
   * "other" — and "other" on a printed invoice tells a customer nothing.
   *
   * A bounded string rather than a longer list: the list was never going to be
   * complete, and a closed enum makes every omission a 400 the operator cannot
   * act on. What the server still guarantees is that a unit is short and is
   * actually a word — long enough for "sachet", too short to be a sentence,
   * and printable in the invoice's PACK column.
   *
   * Lower-cased on the way in, so "Tablet" and "tablet" cannot become two
   * entries in the units list the form offers back. The nine originals are
   * already lower case, so nothing existing moves.
   */
  unit: z
    .string()
    .trim()
    .min(1, "Unit is required")
    .max(20, "Unit is too long — 20 characters at most")
    .regex(
      /^[a-zA-Z][a-zA-Z0-9 .\-/]*$/,
      "Unit must start with a letter and use only letters, digits, spaces, . - or /",
    )
    .transform((v) => v.toLowerCase()),
  gstPercent: z
    .number()
    .refine((v) => [0, 5, 12, 18].includes(v), "GST must be 0, 5, 12 or 18"),
  isScheduledH: z.boolean().default(false),
});

// A batch cannot have been made after it expires. Applied wherever both dates
// are present, so a partial update is still checked.
const datesInOrder = (b) =>
  !b.mfgDate || !b.expiryDate || Date.parse(b.mfgDate) < Date.parse(b.expiryDate);
const dateOrderError = {
  message: "Manufacture date must be before the expiry date",
  path: ["mfgDate"],
};

const batchSchema = z
  .object({
    medicineId: z.string().min(1, "Medicine is required"),
    batchNumber: z.string().min(1, "Batch number is required"),
    expiryDate: z
      .string()
      .refine((d) => !isNaN(Date.parse(d)), "Invalid expiry date"),
    mfgDate: z
      .string()
      .refine((d) => !isNaN(Date.parse(d)), "Invalid manufacture date")
      .optional(),
    purchasePrice: z.number().positive("Purchase price must be positive"),
    sellingPrice: z.number().positive("Selling price must be positive"),
    // Optional: a shop that does not track MRP simply prints no MRP
    // column. Never defaulted from sellingPrice — see the schema note.
    mrp: z.number().positive("MRP must be positive").optional(),
    quantity: z.number().int().positive("Quantity must be positive"),
    supplierId: z.string().min(1, "Supplier is required"),
  })
  .refine(datesInOrder, dateOrderError);

// PUT /batches/:id. Deliberately narrow: stock quantity is NOT editable here.
// Rewriting it silently bypasses every stock-accounting path and leaves no
// trace — manual adjustment belongs in its own endpoint with an audit trail
// (FR-BATCH-11). The FK columns are excluded for the same reason: repointing a
// batch at another medicine or supplier rewrites history.
//
// .strict() so an unrecognised field is a 400 rather than a silent no-op, which
// is the failure mode that hid the mfgDate bug.
// FR-BATCH-11. Deliberately a separate schema from batchUpdateSchema, which
// still rejects `quantity` outright (G-05) — stock does not move through a
// general-purpose edit.
//
// A **delta**, not a new absolute quantity. "Set it to 47" reads more naturally
// but loses a race that a shop actually hits: if a sale commits between the
// operator reading the screen and pressing save, an absolute write silently
// erases that sale's deduction. A delta composes with a concurrent decrement
// instead of clobbering it.
const batchAdjustSchema = z
  .object({
    delta: z
      .number({ error: "delta must be a number" })
      .int("delta must be a whole number of units")
      .refine((n) => n !== 0, "delta must not be zero"),
    // Mandatory, and long enough to be a sentence rather than a keystroke. An
    // adjustment without a reason is the untracked stock rewrite this endpoint
    // exists to replace — "40 became 37" is not an audit trail when breakage,
    // theft and a miscount all look identical.
    reason: z
      .string()
      .trim()
      .min(10, "Give a reason — what happened to this stock, in a sentence")
      .max(500),
  })
  .strict();

const batchUpdateSchema = z
  .object({
    batchNumber: z.string().min(1, "Batch number is required").optional(),
    expiryDate: z
      .string()
      .refine((d) => !isNaN(Date.parse(d)), "Invalid expiry date")
      .optional(),
    mfgDate: z
      .string()
      .refine((d) => !isNaN(Date.parse(d)), "Invalid manufacture date")
      .optional(),
    purchasePrice: z.number().positive("Purchase price must be positive").optional(),
    sellingPrice: z.number().positive("Selling price must be positive").optional(),
    mrp: z.number().positive("MRP must be positive").optional(),
  })
  .strict()
  .refine(datesInOrder, dateOrderError);

const supplierSchema = z.object({
  name: z.string().min(2, "Supplier name is required"),
  contactName: z.string().optional(),
  phone: z.string().optional(),
  email: z.email().optional().or(z.literal("")),
  gstNumber: z.string().optional(),
  address: z.string().optional(),
});

// ─── Query schemas ─────────────────────────────────────

// URLSearchParams sends booleans as the strings "true"/"false".
const booleanFlag = z
  .enum(["true", "false"], { error: "must be true or false" })
  .optional()
  .transform((v) => v === "true");

const medicineListQuerySchema = z.object({
  page,
  limit,
  search: searchTerm,
  categoryId: z.string().trim().min(1).optional(),
});

const medicineSearchQuerySchema = z.object({
  // Shorter than two characters returns an empty list rather than a 400: the POS
  // search box calls this on every keystroke, and the first character is not a
  // caller error.
  q: z.string().trim().max(200, "search term is too long").optional(),
});

const batchListQuerySchema = z.object({
  page,
  limit,
  medicineId: z.string().trim().min(1).optional(),
  expiringSoon: booleanFlag,
  lowStock: booleanFlag,
});

const expiringQuerySchema = z.object({
  // `Number(x) || 30` used to swallow a typo silently, so ?days=abc returned a
  // 30-day window that looked exactly like a deliberate one.
  days: z.coerce
    .number({ error: "days must be a number" })
    .int("days must be a whole number")
    .min(1, "days must be at least 1")
    .max(365, "days must be at most 365")
    .default(30),
});

const lowStockQuerySchema = z.object({
  threshold: z.coerce
    .number({ error: "threshold must be a number" })
    .int("threshold must be a whole number")
    .min(1, "threshold must be at least 1")
    .max(100000, "threshold must be at most 100000")
    .default(10),
});

const supplierListQuerySchema = z.object({ search: searchTerm });

module.exports = {
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
};
