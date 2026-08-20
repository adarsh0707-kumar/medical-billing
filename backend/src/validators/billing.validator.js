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

const createInvoiceSchema = z.object({
  customerId: z.string().optional(),
  items: z.array(invoiceItemSchema).min(1, "At least one item is required"),
  discountAmt: z.number().min(0).default(0),
  paymentMode: z.enum(["CASH", "UPI", "CARD", "CREDIT"]).default("CASH"),
  paymentStatus: z.enum(["PAID", "PENDING", "PARTIAL"]).default("PAID"),
  notes: z.string().optional(),
});

const customerSchema = z.object({
  name: z.string().min(2, "Name is required"),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
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
  startDate: z.coerce.date({ invalid_type_error: "startDate must be a date" }).optional(),
  endDate: z.coerce.date({ invalid_type_error: "endDate must be a date" }).optional(),
  paymentMode: z.enum(["CASH", "UPI", "CARD", "CREDIT"]).optional(),
  paymentStatus: z.enum(["PAID", "PENDING", "PARTIAL"]).optional(),
});

const dailySummaryQuerySchema = z.object({
  // Absent means today. Present but unparseable used to produce an Invalid Date,
  // which Prisma turned into a range that matched nothing — an empty day that
  // looked like a real one.
  date: z.coerce.date({ invalid_type_error: "date must be a valid date" }).optional(),
});

const gstReportQuerySchema = z.object({
  // Both are required. A missing or garbage month used to yield an empty report
  // rather than an error, and an empty tax period is indistinguishable from a
  // month with no sales — see docs/09 section 5.5.
  month: z.coerce
    .number({ invalid_type_error: "month is required and must be a number" })
    .int("month must be a whole number")
    .min(1, "month must be between 1 and 12")
    .max(12, "month must be between 1 and 12"),
  year: z.coerce
    .number({ invalid_type_error: "year is required and must be a number" })
    .int("year must be a whole number")
    .min(2000, "year must be between 2000 and 2100")
    .max(2100, "year must be between 2000 and 2100"),
});

const customerListQuerySchema = z.object({ page, limit, search: searchTerm });

module.exports = {
  createInvoiceSchema,
  customerSchema,
  invoiceListQuerySchema,
  dailySummaryQuerySchema,
  gstReportQuerySchema,
  customerListQuerySchema,
};
