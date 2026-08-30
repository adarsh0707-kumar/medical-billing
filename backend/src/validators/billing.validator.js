const { z } = require("zod");
const { page, limit, searchTerm } = require("./common.validator");

const invoiceItemSchema = z.object({
  batchId: z.string().min(1, "Batch is required"),
  medicineId: z.string().min(1, "Medicine is required"),
  medicineName: z.string().min(1, "Medicine name is required"),
  quantity: z.number().int().positive("Quantity must be positive"),
  unitPrice: z.number().positive("Price must be positive"),
  discount: z.number().min(0).max(100).default(0),
  gstPercent: z.number().default(0),
});

// The register entry for a Schedule H sale (FR-MED-12). Required only when a
// line's medicine is Schedule H — the controller decides that from the *batch's*
// medicine, not from the client's `medicineId`, which is not persisted and so
// cannot be trusted to say what is being sold.
const prescriptionSchema = z
  .object({
    prescriberName: z
      .string()
      .trim()
      .min(2, "Prescriber name is required"),
    // The field that makes "registered medical practitioner" checkable rather
    // than asserted. Not pattern-matched: registration formats differ by state
    // council, and a regex that rejects a valid number would block a lawful sale.
    prescriberRegNo: z
      .string()
      .trim()
      .min(3, "Prescriber registration number is required"),
    prescribedOn: z.coerce
      .date({ error: "Prescription date is required" })
      .refine((d) => d <= new Date(), {
        message: "A prescription cannot be dated in the future",
      }),
    patientName: z.string().trim().min(2, "Patient name is required"),
    notes: z.string().trim().max(500).optional(),
  })
  .strict();

const createInvoiceSchema = z.object({
  customerId: z.string().optional(),
  prescription: prescriptionSchema.optional(),
  items: z.array(invoiceItemSchema).min(1, "At least one item is required"),
  discountAmt: z.number().min(0).default(0),
  paymentMode: z.enum(["CASH", "UPI", "CARD", "CREDIT"]).default("CASH"),
  paymentStatus: z.enum(["PAID", "PENDING", "PARTIAL"]).default("PAID"),
  notes: z.string().optional(),
});

const customerSchema = z.object({
  name: z.string().min(2, "Name is required"),
  phone: z.string().optional(),
  email: z.email().optional().or(z.literal("")),
  address: z.string().optional(),
  age: z
    .union([z.string(), z.number()])
    .optional()
    .refine((val) => !val || (Number(val) >= 0 && Number(val) <= 150), {
      message: "Age must be between 0 and 150",
    }),
  gender: z.enum(["MALE", "FEMALE", "OTHER"]).optional(),
});

// ─── Query schemas ─────────────────────────────────────

const invoiceListQuerySchema = z.object({
  page,
  limit,
  search: searchTerm,
  startDate: z.coerce.date({ error: "startDate must be a date" }).optional(),
  endDate: z.coerce.date({ error: "endDate must be a date" }).optional(),
  paymentMode: z.enum(["CASH", "UPI", "CARD", "CREDIT"]).optional(),
  paymentStatus: z.enum(["PAID", "PENDING", "PARTIAL"]).optional(),
});

const dailySummaryQuerySchema = z.object({
  // Absent means today. Present but unparseable used to produce an Invalid Date,
  // which Prisma turned into a range that matched nothing — an empty day that
  // looked like a real one.
  date: z.coerce.date({ error: "date must be a valid date" }).optional(),
});

const gstReportQuerySchema = z.object({
  // Both are required. A missing or garbage month used to yield an empty report
  // rather than an error, and an empty tax period is indistinguishable from a
  // month with no sales — see docs/09 section 5.5.
  month: z.coerce
    .number({ error: "month is required and must be a number" })
    .int("month must be a whole number")
    .min(1, "month must be between 1 and 12")
    .max(12, "month must be between 1 and 12"),
  year: z.coerce
    .number({ error: "year is required and must be a number" })
    .int("year must be a whole number")
    .min(2000, "year must be between 2000 and 2100")
    .max(2100, "year must be between 2000 and 2100"),
});

// ─── Period reports (FR-RPT-10, FR-RPT-11) ────────────
//
// Same bounds as the GST period, and required for the same reason: a missing
// month once produced an empty report, which is indistinguishable from a month
// with no sales. The year floor and ceiling keep a typo — 202 or 20026 — from
// becoming a scan of the whole invoice table.
const monthlyReportQuerySchema = z.object({
  month: z.coerce
    .number({ error: "month is required and must be a number" })
    .int("month must be a whole number")
    .min(1, "month must be between 1 and 12")
    .max(12, "month must be between 1 and 12"),
  year: z.coerce
    .number({ error: "year is required and must be a number" })
    .int("year must be a whole number")
    .min(2000, "year must be between 2000 and 2100")
    .max(2100, "year must be between 2000 and 2100"),
});

const yearlyReportQuerySchema = z.object({
  year: z.coerce
    .number({ error: "year is required and must be a number" })
    .int("year must be a whole number")
    .min(2000, "year must be between 2000 and 2100")
    .max(2100, "year must be between 2000 and 2100"),
});

const trendQuerySchema = z.object({
  // The dashboard and the reports chart both draw fixed windows; 90 days is well
  // past anything either asks for and keeps one query bounded.
  days: z.coerce
    .number({ error: "days must be a number" })
    .int("days must be a whole number")
    .min(1, "days must be at least 1")
    .max(90, "days must be at most 90")
    .default(7),
});

const voidInvoiceSchema = z
  .object({
    // Why an invoice was cancelled is the whole value of the audit trail, so it
    // is required rather than optional.
    reason: z
      .string()
      .trim()
      .min(3, "Give a reason of at least 3 characters")
      .max(500, "Reason is too long"),
    // Absent means the whole invoice, which is what this endpoint did before
    // partial returns existed — so every existing caller keeps working.
    // Present means return exactly these units.
    items: z
      .array(
        z
          .object({
            invoiceItemId: z.string().min(1, "invoiceItemId is required"),
            quantity: z
              .number()
              .int("Return quantity must be a whole number")
              .positive("Return quantity must be positive"),
          })
          .strict(),
      )
      .min(1, "Give at least one line to return")
      .optional(),
  })
  .strict();

const customerListQuerySchema = z.object({ page, limit, search: searchTerm });

module.exports = {
  prescriptionSchema,
  createInvoiceSchema,
  customerSchema,
  invoiceListQuerySchema,
  dailySummaryQuerySchema,
  gstReportQuerySchema,
  monthlyReportQuerySchema,
  yearlyReportQuerySchema,
  trendQuerySchema,
  voidInvoiceSchema,
  customerListQuerySchema,
};
