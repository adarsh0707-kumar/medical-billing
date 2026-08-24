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

const ADMIN_EMAIL = "admin@medstore.com";

/**
 * The seed creates this account with `mustChangePassword: true` — the published
 * credential can sign in and do exactly one thing, replace itself. So the suite
 * has to complete that change before any flow can reach a screen; without it
 * every `signIn` lands on `/change-password` and every test fails.
 *
 * Not in the blocklist, over the 12-character floor, and free of the account's
 * own name and address, all of which `passwordProblem` enforces.
 */
const SEEDED_PASSWORD = "admin123";
const ADMIN_PASSWORD =
  process.env.E2E_ADMIN_PASSWORD ?? "Kaveri counter till 2026";

const ADMIN = { email: ADMIN_EMAIL, password: ADMIN_PASSWORD };

// Random first: Date.now() in base 36 shares its leading characters across runs
// in the same window, and the POS search returns only ten hits — a fixture whose
// distinguishing suffix falls outside the search term is invisible.
const unique = () =>
  Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

async function tryLogin(
  request: APIRequestContext,
  creds: { email: string; password: string },
) {
  const res = await request.post("/api/auth/login", { data: creds });
  return res.ok() ? ((await res.json()).data as { token: string }) : null;
}

/**
 * An admin token, bootstrapping the forced password change on a fresh database.
 *
 * Idempotent on purpose: the first run finds the seeded credential and replaces
 * it, every later run finds the replacement already in place. A retry against a
 * database the previous attempt already changed must not fail.
 */
async function apiLogin(request: APIRequestContext, creds = ADMIN) {
  const direct = await tryLogin(request, creds);
  if (direct) return direct.token;

  // Only the admin has a seeded credential to fall back to.
  expect(
    creds.email,
    `${creds.email} could not sign in`,
  ).toBe(ADMIN_EMAIL);

  const seeded = await tryLogin(request, {
    email: ADMIN_EMAIL,
    password: SEEDED_PASSWORD,
  });
  expect(seeded, "seed admin must exist — run `npm run seed`").toBeTruthy();

  const changed = await request.put("/api/auth/change-password", {
    headers: { Authorization: `Bearer ${seeded!.token}` },
    data: {
      currentPassword: SEEDED_PASSWORD,
      newPassword: ADMIN_PASSWORD,
    },
  });
  expect(changed.ok(), await changed.text()).toBeTruthy();

  // Changing a password bumps `tokenVersion`, which retires the token that made
  // the change — so the one to carry forward comes from a fresh sign-in.
  const fresh = await tryLogin(request, ADMIN);
  expect(fresh, "the new admin password should work immediately").toBeTruthy();
  return fresh!.token;
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
  // A flow that only drives the UI still needs the forced change done first.
  if (creds === ADMIN) await apiLogin(page.request);

  await page.goto("/login");
  await page.getByPlaceholder("admin@medstore.com").fill(creds.email);
  await page.getByPlaceholder("••••••••").fill(creds.password);
  await page.getByRole("button", { name: "Sign In" }).click();
  // Naming the wrong destination explicitly: landing here means an account still
  // carries `mustChangePassword`, which is what broke every flow in this file
  // once before.
  await expect(page, "signed in but was sent to the password-change screen")
    .not.toHaveURL(/\/change-password/);
  await expect(page).toHaveURL(/\/dashboard/);
}

/** Reads a completed download off disk as text. */
async function readDownload(download: import("@playwright/test").Download) {
  const path = await download.path();
  expect(path, "the download should have been written to disk").toBeTruthy();
  return (await import("node:fs/promises")).readFile(path!, "utf8");
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

// ─── 7 ───────────────────────────────────────────────────

test("the GST export downloads a CSV through the proxy, named by the server", async ({
  page,
  request,
}) => {
  const token = await apiLogin(request);

  // A sale so the month has something in it — the export button is deliberately
  // disabled on an empty report, and a header-only file is indistinguishable
  // from a failed download once it is sitting in someone's Downloads folder.
  const { batch, medicine } = await seedSellable(request, token, { quantity: 5 });
  const sale = await request.post("/api/billing/invoices", {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      items: [
        {
          batchId: batch.id,
          medicineId: medicine.id,
          medicineName: medicine.name,
          quantity: 1,
          unitPrice: 24.5,
          discount: 0,
          gstPercent: 12,
        },
      ],
      paymentMode: "CASH",
      paymentStatus: "PAID",
    },
  });
  expect(sale.ok(), await sale.text()).toBeTruthy();

  await signIn(page);
  await page.goto("/reports");
  await page.getByRole("tab", { name: /GST Report/i }).click();

  const button = page.getByRole("button", { name: /Export CSV/i });
  await expect(button).toBeEnabled();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    button.click(),
  ]);

  // The filename comes from the server's Content-Disposition, which has to
  // survive the nginx proxy to get here. Nothing below this layer can prove it
  // does: the unit test mocks axios, and the API test reads the header off a
  // Supertest response that never passed through nginx.
  const now = new Date();
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  expect(download.suggestedFilename()).toBe(`gst-report-${period}.csv`);

  const body = await readDownload(download);

  // Deliberately only the header row and that rows exist. The *figures* are the
  // server's and are asserted to the paisa in `backend/tests/reports/`; a money
  // assertion here would be slower and no more truthful (CONTRIBUTING).
  const lines = body.replace(/^\uFEFF/, "").trim().split("\r\n");
  expect(lines[0]).toBe(
    "Date,Invoice No,Type,Status,Customer,Payment Mode,Payment Status,Taxable,Discount,CGST,SGST,Total",
  );
  expect(lines.length).toBeGreaterThan(1);

  // The BOM is what stops Excel mangling non-ASCII medicine names, and it is a
  // byte the proxy could plausibly eat.
  expect(body.charCodeAt(0)).toBe(0xfeff);
});
