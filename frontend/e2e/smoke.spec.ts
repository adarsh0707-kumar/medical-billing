import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Browser smoke — the six flows in docs/09 §5.7.
 *
 * Scope, stated plainly: this layer exists to catch wiring that the other two
 * cannot see — the nginx proxy, the token round trip, the built client reaching
 * the real API. It is not where business rules are proven. GST arithmetic is
 * asserted 28 times in `backend/tests/billing/invoice-create.test.js` and 40 more
 * in `cart-math.test.ts`; concurrency is proven in `invoice-concurrency.test.js`.
 * Re-asserting any of that through a browser would be slow and no more truthful.
 *
 * Fixture data is created over the API rather than by filling forms. Six modal
 * dialogs of setup would make the suite mostly a test of shadcn, and every
 * failure would take a screenshot to diagnose. The UI is driven where the UI is
 * the thing being tested: signing in, searching the POS, taking a sale, seeing
 * the error, reading the report, and what a cashier is shown.
 */

const ADMIN = { email: "admin@medstore.com", password: "admin123" };

// Random first: Date.now() in base 36 shares its leading characters across runs
// in the same window, and the POS search returns only ten hits — a fixture whose
// distinguishing suffix falls outside the search term is invisible.
const unique = () =>
  Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

async function apiLogin(request: APIRequestContext, creds = ADMIN) {
  const res = await request.post("/api/auth/login", { data: creds });
  expect(res.ok(), "seed admin must exist — run `npm run seed`").toBeTruthy();
  return (await res.json()).data.token as string;
}

/** Creates a sellable medicine with a known stock level, over the API. */
async function seedSellable(
  request: APIRequestContext,
  token: string,
  { quantity = 10, sellingPrice = 24.5, gstPercent = 12 } = {},
) {
  const h = { Authorization: `Bearer ${token}` };
  const tag = unique();
  const name = `E2E Paracetamol ${tag}`;

  const post = async (url: string, data: Record<string, unknown>) => {
    const res = await request.post(url, { headers: h, data });
    expect(res.ok(), `${url} -> ${res.status()} ${await res.text()}`).toBeTruthy();
    return (await res.json()).data;
  };

  const category = await post("/api/inventory/categories", { name: `Cat ${tag}` });
  const manufacturer = await post("/api/inventory/manufacturers", { name: `Mfr ${tag}` });
  const supplier = await post("/api/inventory/suppliers", { name: `Sup ${tag}` });
  const medicine = await post("/api/inventory/medicines", {
    name,
    categoryId: category.id,
    manufacturerId: manufacturer.id,
    unit: "tablet",
    gstPercent,
  });
  const batch = await post("/api/inventory/batches", {
    medicineId: medicine.id,
    batchNumber: `E2E-${tag}`,
    expiryDate: new Date(Date.now() + 365 * 864e5).toISOString(),
    purchasePrice: 10,
    sellingPrice,
    quantity,
    supplierId: supplier.id,
  });

  return { name, medicine, batch, token };
}

async function batchStock(
  request: APIRequestContext,
  token: string,
  batchId: string,
  medicineId: string,
) {
  // Scoped to the medicine rather than scanning the whole list: /batches is
  // paginated, so a freshly created batch is not on the first page.
  const res = await request.get(`/api/inventory/batches?medicineId=${medicineId}&limit=100`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.ok()).toBeTruthy();
  const found = (await res.json()).data.find((b: { id: string }) => b.id === batchId);
  expect(found, `batch ${batchId} should be in the medicine's batches`).toBeTruthy();
  return found.quantity as number;
}

async function signIn(page: Page, creds = ADMIN) {
  await page.goto("/login");
  await page.getByPlaceholder("admin@medstore.com").fill(creds.email);
  await page.getByPlaceholder("••••••••").fill(creds.password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

/** Searches the POS and adds the first result to the cart. */
async function addToCart(page: Page, name: string) {
  const box = page.getByPlaceholder(/search medicine by name/i);
  await box.fill(name);
  const row = page.getByRole("button", { name: new RegExp(name) });
  await expect(row).toBeVisible();
  await row.click();
}

// ─── 1 ───────────────────────────────────────────────────

test("the seeded admin can sign in and the dashboard renders", async ({ page }) => {
  await signIn(page);

  // Something data-driven, not just the shell: the greeting carries the user's
  // name, which only arrives from /api/auth/me through the proxy.
  await expect(page.getByRole("heading", { level: 2 })).toContainText("!");
  // By role: "Dashboard" is both a nav link and the topbar heading.
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
});

// ─── 2 ───────────────────────────────────────────────────

test("a newly stocked medicine appears in POS search with the right stock", async ({
  page,
  request,
}) => {
  const token = await apiLogin(request);
  const { name } = await seedSellable(request, token, { quantity: 7 });

  await signIn(page);
  await page.goto("/billing");

  await page.getByPlaceholder(/search medicine by name/i).fill(name);

  const row = page.getByRole("button", { name: new RegExp(name) });
  await expect(row).toBeVisible();
  await expect(row).toContainText("7"); // the stock figure the POS shows
});

// ─── 3 ───────────────────────────────────────────────────

test("selling 2 units creates an invoice and drops the batch by exactly 2", async ({
  page,
  request,
}) => {
  const token = await apiLogin(request);
  const { name, batch, medicine } = await seedSellable(request, token, { quantity: 10 });
  expect(await batchStock(request, token, batch.id, medicine.id)).toBe(10);

  await signIn(page);
  await page.goto("/billing");
  await addToCart(page, name);
  await page.getByLabel("Increase quantity").click(); // 1 -> 2

  await page.getByRole("button", { name: /Generate Invoice/i }).click();

  // The print view is the confirmation the cashier sees.
  await expect(page.getByText(/MedBill Pro/i).first()).toBeVisible();

  expect(await batchStock(request, token, batch.id, medicine.id)).toBe(8);
});

// ─── 4 ───────────────────────────────────────────────────

test("an oversell attempt is refused and leaves stock untouched", async ({
  page,
  request,
}) => {
  const token = await apiLogin(request);
  const { name, batch, medicine } = await seedSellable(request, token, { quantity: 2 });

  await signIn(page);
  await page.goto("/billing");
  await addToCart(page, name);

  const increase = page.getByLabel("Increase quantity");
  await increase.click(); // 2 — exactly the batch
  await increase.click(); // 3 — one more than exists

  // sonner renders an aria-live copy alongside the visible toast.
  await expect(page.getByText("Insufficient stock!").first()).toBeVisible();

  // The client refused, so nothing was ever sent. The server would also have
  // refused: the conditional decrement inside the invoice transaction is the
  // authoritative check (G-09), and it is proven under concurrency in the
  // backend suite rather than here.
  expect(await batchStock(request, token, batch.id, medicine.id)).toBe(2);
});

// ─── 5 ───────────────────────────────────────────────────

test("the daily report reflects a sale made moments earlier", async ({
  page,
  request,
}) => {
  const token = await apiLogin(request);
  const { name } = await seedSellable(request, token, { quantity: 5, sellingPrice: 100 });

  await signIn(page);
  await page.goto("/billing");
  await addToCart(page, name);
  await page.getByRole("button", { name: /Generate Invoice/i }).click();
  await expect(page.getByText(/MedBill Pro/i).first()).toBeVisible();

  // The daily report lists invoice numbers, so ask the API which one was just
  // written rather than guessing at the serial.
  const latest = await request.get("/api/billing/invoices?limit=1&page=1", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const invoiceNumber = (await latest.json()).data[0].invoiceNumber as string;

  await page.goto("/reports");

  // Asserting the invoice appears, not its total: arithmetic is proven in the
  // backend fixtures, and this layer only has to show the wiring reaches here.
  await expect(page.getByText(invoiceNumber)).toBeVisible({ timeout: 15_000 });
});

// ─── 6 ───────────────────────────────────────────────────

test("a cashier sees no Settings link and is refused by /api/users", async ({
  page,
  request,
}) => {
  const token = await apiLogin(request);
  const tag = unique();
  const cashier = { email: `e2e-cashier-${tag}@test.local`, password: "cashier-password-1" };

  const created = await request.post("/api/users", {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: `E2E Cashier ${tag}`, ...cashier, role: "CASHIER" },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  await signIn(page, cashier);

  // Cosmetic half: the nav item is filtered out.
  await expect(page.getByRole("link", { name: "Billing" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);

  // The half that actually matters. Hiding a link is not access control — a
  // cashier who calls the endpoint directly must be refused by the server.
  const cashierToken = (await (await request.post("/api/auth/login", { data: cashier })).json())
    .data.token;
  const direct = await request.get("/api/users", {
    headers: { Authorization: `Bearer ${cashierToken}` },
  });
  expect(direct.status()).toBe(403);
});
