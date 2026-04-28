const { z } = require("zod");

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
  unit: z.enum([
    "tablet",
    "capsule",
    "syrup",
    "injection",
    "cream",
    "drops",
    "powder",
    "inhaler",
    "other",
  ]),
  gstPercent: z
    .number()
    .refine((v) => [0, 5, 12, 18].includes(v), "GST must be 0, 5, 12 or 18"),
  isScheduledH: z.boolean().default(false),
});

const batchSchema = z.object({
  medicineId: z.string().min(1, "Medicine is required"),
  batchNumber: z.string().min(1, "Batch number is required"),
  expiryDate: z
    .string()
    .refine((d) => !isNaN(Date.parse(d)), "Invalid expiry date"),
  purchasePrice: z.number().positive("Purchase price must be positive"),
  sellingPrice: z.number().positive("Selling price must be positive"),
  quantity: z.number().int().positive("Quantity must be positive"),
  supplierId: z.string().min(1, "Supplier is required"),
});

const supplierSchema = z.object({
  name: z.string().min(2, "Supplier name is required"),
  contactName: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  gstNumber: z.string().optional(),
  address: z.string().optional(),
});

module.exports = {
  categorySchema,
  manufacturerSchema,
  medicineSchema,
  batchSchema,
  supplierSchema,
};
