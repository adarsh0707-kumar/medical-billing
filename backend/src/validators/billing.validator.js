const { z } = require("zod");

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

module.exports = { createInvoiceSchema, customerSchema };
