import { beforeEach } from "vitest";
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

// ─── Shops (tenants) ───────────────────────────────────
//
// Every fixture below needs a shopId, and the overwhelming majority of tests
// are about one shop — an admin managing their own cashiers, a sale against
// their own medicines — not about tenant isolation itself. Defaulting every
// fixture to the *same* shop within a test, without every call site having to
// pass one, is what keeps this factory's existing call shape working.
//
// Reset before each test rather than created once for the whole suite: the
// database is wiped between tests (see tests/setup/each-test.js), so a cached
// id from the previous test would point at a row that no longer exists.
let cachedShopId = null;
beforeEach(() => {
  cachedShopId = null;
});

async function defaultShopId() {
  if (!cachedShopId) {
    const shop = await prisma.shop.create({ data: { name: "Test Pharmacy" } });
    cachedShopId = shop.id;
  }
  return cachedShopId;
}

// For tests that are specifically about isolation between two shops, rather
// than about the single shop most fixtures share.
export async function makeShop(data = {}) {
  return prisma.shop.create({ data: { name: "Another Pharmacy", ...data } });
}

export async function makeUser({
  role = "ADMIN",
  email = `${role.toLowerCase()}@test.local`,
  name = role,
  isActive = true,
  shopId,
} = {}) {
  return prisma.user.create({
    data: {
      shopId: shopId ?? (await defaultShopId()),
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
export async function signIn(_app, role = "ADMIN", opts = {}) {
  const user = await makeUser({ role, ...opts });
  // Carry the revocation counter, so a token minted here verifies the same way
  // one from the login route does (FR-AUTH-09).
  return {
    user,
    token: generateToken(user.id, user.tokenVersion, user.shopId),
  };
}

// A second token for a user who already exists — for asserting that logout ends
// *every* session, not only the one that called it. Reads the counter fresh, so
// calling it after a logout produces a token that works.
export async function tokenFor(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  return generateToken(user.id, user.tokenVersion, user.shopId);
}

// For tests that need the real sign-in path.
export async function loginViaApi(app, email, password = PASSWORD) {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ email, password });
  return res;
}

export const auth = (req, token) => req.set("Authorization", `Bearer ${token}`);

// ─── Inventory fixtures ────────────────────────────────

// Category and manufacturer names are unique per shop, not globally, so
// fixtures still get a suffix — a test that builds two sellable medicines in
// the same shop would otherwise collide with itself.
let seq = 0;
export async function makeMasters({ shopId } = {}) {
  const n = ++seq;
  const shop = shopId ?? (await defaultShopId());
  const [category, manufacturer, supplier] = await Promise.all([
    prisma.category.create({ data: { shopId: shop, name: `Analgesic ${n}` } }),
    prisma.manufacturer.create({ data: { shopId: shop, name: `Cipla ${n}` } }),
    prisma.supplier.create({ data: { shopId: shop, name: `MedPlus ${n}` } }),
  ]);
  return { category, manufacturer, supplier, shopId: shop };
}

export async function makeMedicine({
  name = "Paracetamol 500mg",
  gstPercent = 12,
  masters,
  shopId,
  ...rest
} = {}) {
  const m = masters ?? (await makeMasters({ shopId }));
  const medicine = await prisma.medicine.create({
    data: {
      shopId: m.shopId,
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
  shopId,
  batchNumber = "B1",
  expiryDate = new Date("2028-12-31"),
  sellingPrice = 24.5,
  quantity = 100,
} = {}) {
  return prisma.batch.create({
    data: {
      shopId: shopId ?? (await defaultShopId()),
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
export async function makeSellable({
  gstPercent = 12,
  sellingPrice = 24.5,
  quantity = 100,
  // Lets a test put a batch either side of the expiry boundary. Defaults to
  // makeBatch's far-future date, so every existing caller is unaffected.
  expiryDate,
  batchNumber,
  shopId,
} = {}) {
  const { medicine, category, manufacturer, supplier } = await makeMedicine({
    gstPercent,
    shopId,
  });
  const batch = await makeBatch({
    medicineId: medicine.id,
    supplierId: supplier.id,
    shopId: medicine.shopId,
    sellingPrice,
    quantity,
    ...(expiryDate && { expiryDate }),
    ...(batchNumber && { batchNumber }),
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
