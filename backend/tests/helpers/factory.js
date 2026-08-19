import request from "supertest";
import bcrypt from "bcryptjs";
import createApp from "../../src/app.js";
import prisma from "../../src/config/db.js";
import { generateToken } from "../../src/utils/jwt.utils.js";

// Rate limits are effectively disabled by default: a test asserting a 401 should
// not fail because an earlier test spent the budget. The limiter tests build
// their own app with real numbers.
export const buildApp = (options = {}) =>
  createApp({ rateLimitMax: 1e6, loginRateLimitMax: 1e6, ...options });

export const PASSWORD = "test-password-123";

// Hashed once for the whole suite. bcrypt is deliberately slow, and paying for
// it per fixture dominated the run time.
let passwordHash;
const hashOnce = async () => (passwordHash ??= await bcrypt.hash(PASSWORD, 4));

export async function makeUser({
  role = "ADMIN",
  email = `${role.toLowerCase()}@test.local`,
  name = role,
  isActive = true,
} = {}) {
  return prisma.user.create({
    data: {
      name,
      email,
      password: await hashOnce(),
      role,
      isActive,
    },
  });
}

// A user of the given role plus a token to act as them. Mints the token
// directly rather than going through the login route: the token is a means to
// an end for most tests, and tests/auth/auth.test.js covers the route itself.
export async function signIn(_app, role = "ADMIN") {
  const user = await makeUser({ role });
  return { user, token: generateToken(user.id) };
}

// For tests that need the real sign-in path.
export async function loginViaApi(app, email, password = PASSWORD) {
  const res = await request(app).post("/api/auth/login").send({ email, password });
  return res;
}

export const auth = (req, token) => req.set("Authorization", `Bearer ${token}`);

// ─── Inventory fixtures ────────────────────────────────

// Category and manufacturer names are unique, so fixtures get a suffix — a test
// that builds two sellable medicines would otherwise collide with itself.
let seq = 0;
export async function makeMasters() {
  const n = ++seq;
  const [category, manufacturer, supplier] = await Promise.all([
    prisma.category.create({ data: { name: `Analgesic ${n}` } }),
    prisma.manufacturer.create({ data: { name: `Cipla ${n}` } }),
    prisma.supplier.create({ data: { name: `MedPlus ${n}` } }),
  ]);
  return { category, manufacturer, supplier };
}

export async function makeMedicine({
  name = "Paracetamol 500mg",
  gstPercent = 12,
  masters,
  ...rest
} = {}) {
  const m = masters ?? (await makeMasters());
  const medicine = await prisma.medicine.create({
    data: {
      name,
      categoryId: m.category.id,
      manufacturerId: m.manufacturer.id,
      unit: "tablet",
      gstPercent,
      ...rest,
    },
  });
  // masters spread first: spreading them last would overwrite `medicine` when
  // the caller passed a previous makeMedicine() result back in as `masters`.
  return { ...m, medicine };
}

export async function makeBatch({
  medicineId,
  supplierId,
  batchNumber = "B1",
  expiryDate = new Date("2028-12-31"),
  sellingPrice = 24.5,
  quantity = 100,
} = {}) {
  return prisma.batch.create({
    data: {
      medicineId,
      supplierId,
      batchNumber,
      expiryDate,
      purchasePrice: 10,
      sellingPrice,
      quantity,
      initialQty: quantity,
    },
  });
}

// A medicine with one batch in stock — the usual starting point for a sale.
export async function makeSellable({ gstPercent = 12, sellingPrice = 24.5, quantity = 100 } = {}) {
  const { medicine, category, manufacturer, supplier } = await makeMedicine({ gstPercent });
  const batch = await makeBatch({
    medicineId: medicine.id,
    supplierId: supplier.id,
    sellingPrice,
    quantity,
  });
  return { medicine, batch, category, manufacturer, supplier };
}

// One invoice line, shaped the way the POS sends it.
export const line = (medicine, batch, overrides = {}) => ({
  batchId: batch.id,
  medicineId: medicine.id,
  medicineName: medicine.name,
  quantity: 1,
  unitPrice: Number(batch.sellingPrice),
  discount: 0,
  gstPercent: Number(medicine.gstPercent),
  ...overrides,
});
