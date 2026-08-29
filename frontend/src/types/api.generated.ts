/**
 * GENERATED FILE — DO NOT EDIT (NFR-22).
 *
 * Inferred from the Zod schemas in `backend/src/validators/`, which are the
 * single definition of every request contract. Edit a schema and run:
 *
 *   cd backend && npm run types:generate
 *
 * `npm run types:check` fails if this file is out of date, and runs in CI —
 * so a contract change that is not reflected here turns the build red rather
 * than turning a request into a 400 at runtime.
 *
 * These are **request** types: what a client sends, before the server applies
 * defaults and coercions. A field the schema defaults is optional here, and a
 * query parameter the schema coerces appears as the string it travels as.
 *
 * No imports and no values, deliberately: types are erased before anything
 * runs, which is how a CommonJS backend shares a contract with an ESM
 * frontend without either loading the other.
 */

/** `batchAdjustSchema` — `backend/src/validators/inventory.validator.js` */
export type BatchAdjustInput = { delta: number; reason: string };

/** `batchSchema` — `backend/src/validators/inventory.validator.js` */
export type BatchInput = {
  medicineId: string;
  batchNumber: string;
  expiryDate: string;
  purchasePrice: number;
  sellingPrice: number;
  quantity: number;
  supplierId: string;
  mfgDate?: string | undefined;
};

/** `batchListQuerySchema` — `backend/src/validators/inventory.validator.js` */
export type BatchListQuery = {
  page?: number | string | undefined;
  limit?: number | string | undefined;
  medicineId?: string | undefined;
  expiringSoon?: "true" | "false" | undefined;
  lowStock?: "true" | "false" | undefined;
};

/** `batchUpdateSchema` — `backend/src/validators/inventory.validator.js` */
export type BatchUpdateInput = {
  batchNumber?: string | undefined;
  expiryDate?: string | undefined;
  mfgDate?: string | undefined;
  purchasePrice?: number | undefined;
  sellingPrice?: number | undefined;
};

/** `categorySchema` — `backend/src/validators/inventory.validator.js` */
export type CategoryInput = { name: string };

/** `changePasswordSchema` — `backend/src/validators/user.validator.js` */
export type ChangePasswordInput = {
  currentPassword: string;
  newPassword: string;
};

/** `createInvoiceSchema` — `backend/src/validators/billing.validator.js` */
export type CreateInvoiceInput = {
  items: {
    batchId: string;
    medicineId: string;
    medicineName: string;
    quantity: number;
    unitPrice: number;
    discount?: number | undefined;
    gstPercent?: number | undefined;
  }[];
  customerId?: string | undefined;
  prescription?:
    | {
        prescriberName: string;
        prescriberRegNo: string;
        prescribedOn: string | Date;
        patientName: string;
        notes?: string | undefined;
      }
    | undefined;
  discountAmt?: number | undefined;
  paymentMode?: "CASH" | "UPI" | "CARD" | "CREDIT" | undefined;
  paymentStatus?: "PAID" | "PENDING" | "PARTIAL" | undefined;
  notes?: string | undefined;
};

/** `createUserSchema` — `backend/src/validators/user.validator.js` */
export type CreateUserInput = {
  name: string;
  email: string;
  password: string;
  role?: "ADMIN" | "PHARMACIST" | "CASHIER" | undefined;
};

/** `customerSchema` — `backend/src/validators/billing.validator.js` */
export type CustomerInput = {
  name: string;
  phone?: string | undefined;
  email?: string | undefined;
  address?: string | undefined;
  age?: string | number | undefined;
  gender?: "MALE" | "FEMALE" | "OTHER" | undefined;
};

/** `customerListQuerySchema` — `backend/src/validators/billing.validator.js` */
export type CustomerListQuery = {
  page?: number | string | undefined;
  limit?: number | string | undefined;
  search?: string | undefined;
};

/** `dailySummaryQuerySchema` — `backend/src/validators/billing.validator.js` */
export type DailySummaryQuery = { date?: string | Date | undefined };

/** `expiringQuerySchema` — `backend/src/validators/inventory.validator.js` */
export type ExpiringQuery = { days?: number | string | undefined };

/** `gstReportQuerySchema` — `backend/src/validators/billing.validator.js` */
export type GstReportQuery = { month: number | string; year: number | string };

/** `invoiceListQuerySchema` — `backend/src/validators/billing.validator.js` */
export type InvoiceListQuery = {
  page?: number | string | undefined;
  limit?: number | string | undefined;
  search?: string | undefined;
  startDate?: string | Date | undefined;
  endDate?: string | Date | undefined;
  paymentMode?: "CASH" | "UPI" | "CARD" | "CREDIT" | undefined;
  paymentStatus?: "PAID" | "PENDING" | "PARTIAL" | undefined;
};

/** `lowStockQuerySchema` — `backend/src/validators/inventory.validator.js` */
export type LowStockQuery = { threshold?: number | string | undefined };

/** `manufacturerSchema` — `backend/src/validators/inventory.validator.js` */
export type ManufacturerInput = { name: string };

/** `medicineSchema` — `backend/src/validators/inventory.validator.js` */
export type MedicineInput = {
  name: string;
  categoryId: string;
  manufacturerId: string;
  unit:
    | "tablet"
    | "capsule"
    | "syrup"
    | "injection"
    | "cream"
    | "drops"
    | "powder"
    | "inhaler"
    | "other";
  gstPercent: number;
  genericName?: string | undefined;
  hsnCode?: string | undefined;
  isScheduledH?: boolean | undefined;
};

/** `medicineListQuerySchema` — `backend/src/validators/inventory.validator.js` */
export type MedicineListQuery = {
  page?: number | string | undefined;
  limit?: number | string | undefined;
  search?: string | undefined;
  categoryId?: string | undefined;
};

/** `medicineSearchQuerySchema` — `backend/src/validators/inventory.validator.js` */
export type MedicineSearchQuery = { q?: string | undefined };

/** `prescriptionSchema` — `backend/src/validators/billing.validator.js` */
export type PrescriptionInput = {
  prescriberName: string;
  prescriberRegNo: string;
  prescribedOn: string | Date;
  patientName: string;
  notes?: string | undefined;
};

/** `signupSchema` — `backend/src/validators/user.validator.js` */
export type SignupInput = {
  shopName: string;
  name: string;
  email: string;
  password: string;
};

/** `supplierSchema` — `backend/src/validators/inventory.validator.js` */
export type SupplierInput = {
  name: string;
  contactName?: string | undefined;
  phone?: string | undefined;
  email?: string | undefined;
  gstNumber?: string | undefined;
  address?: string | undefined;
};

/** `supplierListQuerySchema` — `backend/src/validators/inventory.validator.js` */
export type SupplierListQuery = { search?: string | undefined };

/** `trendQuerySchema` — `backend/src/validators/billing.validator.js` */
export type TrendQuery = { days?: number | string | undefined };

/** `updateProfileSchema` — `backend/src/validators/user.validator.js` */
export type UpdateProfileInput = {
  name?: string | undefined;
  email?: string | undefined;
};

/** `updateUserSchema` — `backend/src/validators/user.validator.js` */
export type UpdateUserInput = {
  name?: string | undefined;
  email?: string | undefined;
  role?: "ADMIN" | "PHARMACIST" | "CASHIER" | undefined;
  isActive?: boolean | undefined;
};

/** `voidInvoiceSchema` — `backend/src/validators/billing.validator.js` */
export type VoidInvoiceInput = {
  reason: string;
  items?: { invoiceItemId: string; quantity: number }[] | undefined;
};
