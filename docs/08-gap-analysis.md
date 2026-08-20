# 08 — Gap Analysis

Two kinds of gap, both found by reading the source on 2026-08-17:

- **Part A — documentation drift.** Existing repo docs claim capabilities the code does not have.
- **Part B — code-level defects.** Real problems in the shipped code, with the fix for each.

Every `G-nn` is referenced from the other documents in this set.

---

## Part A — Documentation drift

The root `README.md`, `backend/README.md`, `frontend/README.md` and `nginx/README.md` were written as *intent* and never reconciled with the code. The most consequential mismatches:

| # | Claim | Where | Reality |
|---|---|---|---|
| D-1 | `/api/customers`, `/api/medicines`, `/api/suppliers`, `/api/reports` exist | root + backend README | Customers are under `/api/billing/`; medicines and suppliers under `/api/inventory/`; **no `/api/reports` router exists at all** |
| D-2 | `POST /api/auth/logout`, `/refresh`, `/forgot-password`, `/reset-password` | backend README | None exist. Logout is client-side |
| D-3 | Error responses are `{ success, error, statusCode }` | root README | Actual shape is `{ success, message }` (+ `errors[]` on validation) |
| D-4 | JWT is stored in an HTTP-only cookie | backend README | Stored in `localStorage`, sent as a `Bearer` header |
| D-5 | Frontend runs on port 3000 | root README | Compose maps **5173** |
| D-6 | `npm test`, `npm run test:coverage`, `npm run test:watch`, `npm run lint`, `npm run format` for the backend | backend + root README | ~~Only `test` exists and it exits 1~~ — the three test scripts are real as of 2026-08-19. There is still no backend lint or format script |
| D-7 | `express-validator` is a dependency | backend README | The project uses **Zod** |
| D-8 | Redis caches frequently accessed data | root + backend README | The client connects and is imported by **nothing** ([G-03](#g-03)) |
| D-9 | Pagination, indexing and connection pooling are performance features | backend README | Pagination exists on 3 of 8 list endpoints; **no custom indexes exist**; pooling is Prisma's default |
| D-10 | `inventory.controller.js` and a `frontend/src/api/` directory exist | backend + frontend README | Neither exists — inventory is split across 5 controllers; the API client is `frontend/src/lib/api.ts` |
| D-11 | Nginx provides gzip, security headers, load balancing, SSL | nginx README | `nginx/nginx.conf` is 20 lines: two `proxy_pass` blocks. None of those features are configured |
| D-12 | `GET /api/billing/:id/invoice` downloads an invoice | backend README | No such route; printing is `window.print()` in the browser |
| D-13 | Backend `.env.example` exists (`cp .env.example .env`) | backend README | No `.env.example` file in the repository |
| D-14 | `Architecture.txt` route layout (`/api/invoices`, `/api/batches`, `/api/reports/*`) | Architecture.txt | Superseded — everything moved under `/api/billing` and `/api/inventory` |

**Recommendation:** rather than rewriting four READMEs, trim each to a short "what this is / how to run it" and link to `docs/`. This set is now the reference.

---

## Part B — Code-level findings

Severity: 🔴 causes data corruption or a security exposure · 🟠 causes incorrect output or blocks a feature · 🟡 quality and maintenance.

| ID | Severity | Finding |
|---|---|---|
| [G-01](#g-01) | ✅ Fixed | Invoice numbers collide under concurrent checkout |
| [G-09](#g-09) | ✅ Fixed | Stock check happens outside the transaction — oversell race |
| [G-07](#g-07) | ✅ Fixed | All money stored as `Float` |
| [G-02](#g-02) | ✅ Fixed | Nginx entry point is unusable — origin missing from the CORS allowlist |
| [G-05](#g-05) | ✅ Fixed | `PUT /api/inventory/batches/:id` accepts arbitrary fields |
| [G-06](#g-06) | ✅ Fixed | Rate limiter is global, not per-client, behind the proxy |
| [G-04](#g-04) | ✅ Fixed | `mfgDate` can never be saved |
| [G-10](#g-10) | ✅ Fixed | `totalStock` reports one batch, not all |
| [G-11](#g-11) | ✅ Fixed | User-management routes are unvalidated |
| [G-12](#g-12) | ✅ Fixed | FK violations surface as 500 |
| [G-03](#g-03) | 🟡 | Redis is a dead dependency |
| [G-08](#g-08) | 🟡 | Sales trend costs 7 HTTP round trips |
| [G-13](#g-13) | 🟡 | Dead code: 4 empty route files, unused utils, empty nginx.conf |
| [G-14](#g-14) | ✅ Fixed | No automated tests |
| [G-15](#g-15) | 🟡 | Invoices are immutable with no correction path |

---

### <a id="g-01"></a>G-01 ✅ FIXED — Invoice numbers collided under concurrency

**Where:** [`backend/src/utils/invoice.utils.js`](../backend/src/utils/invoice.utils.js)

```js
const count = await prisma.invoice.count({ where: { createdAt: { gte: startOfDay } } });
const serial = String(count + 1).padStart(4, "0");
return `${prefix}-${serial}`;
```

**Problem.** The count runs *outside* the transaction that inserts the invoice. Two checkouts starting within the same window both read `count = 41` and both build `INV260817-0042`. `Invoice.invoiceNumber` is unique, so the second insert fails with `P2002` → the cashier sees `409 A record with this value already exists.` on a perfectly valid sale, after the customer has paid.

A second, subtler bug: `new Date(today.setHours(0,0,0,0))` **mutates** `today`, so `prefix` is computed from the date before mutation and the boundary from after. It happens to work because `prefix` is built first — but any reordering of those lines silently breaks day boundaries.

**Fix proposed at review time** (superseded — see the resolution below). Use a database sequence per day, or wrap generation and insertion in the same transaction with a retry on `P2002`:

```js
for (let attempt = 0; attempt < 5; attempt++) {
  try { return await prisma.$transaction(async (tx) => { /* count + create */ }); }
  catch (e) { if (e.code !== "P2002") throw e; }
}
throw new Error("Could not allocate an invoice number");
```

Stop mutating `today`; derive both values from a single immutable date.

---

**Resolution (2026-08-18).** Replaced with an atomic per-day counter. A new `InvoiceCounter` table holds one row per business day; the serial comes from a single `INSERT … ON CONFLICT ("day") DO UPDATE SET seq = seq + 1 RETURNING seq` executed **inside the invoice transaction**. Concurrent transactions queue on that row's lock and each receives a distinct value, and because the increment shares the invoice's transaction, a rolled-back sale returns its number instead of leaving a gap in a tax document. The row seeds itself from the invoices already recorded that day, so days written before the counter existed continue where they left off. `today` is no longer mutated. A retry on `P2002` remains as a backstop.

> A retry-only fix was tried first and **failed**: with 12 simultaneous checkouts, four still returned 409 after five attempts each — a count-based allocation livelocks because every retry re-reads the same count. The counter is the fix; the retry is only a safety net.

**Verified** against a throwaway database: 12 concurrent sales on a batch of 10 → 10 created, 2 clean `400 Insufficient stock`, zero 409s; 40 concurrent sales on a batch of 50 → 40 created with gapless `INV260818-0001`…`-0040`; and a day with pre-existing invoices but no counter row continued at `-0041`.


---

### <a id="g-09"></a>G-09 ✅ FIXED — Stock check was outside the transaction

**Where:** [`backend/src/controllers/billing.controller.js`](../backend/src/controllers/billing.controller.js), `createInvoice`

```js
for (const item of items) {                    // ← Step 1: reads, no transaction
  const batch = await prisma.batch.findUnique({ where: { id: item.batchId } });
  if (batch.quantity < item.quantity) return res.status(400)…
}
// … later …
await prisma.$transaction(async (tx) => {      // ← Step 3: writes
  await tx.batch.update({ data: { quantity: { decrement: item.quantity } } });
});
```

**Problem.** Between the read and the write, another request can consume the same stock. Both pass validation, both decrement, and `Batch.quantity` goes negative — the database has no `CHECK` constraint to stop it. The product's second-most-important guarantee (G2: "never sell stock we don't have") does not hold under two concurrent counters.

**Fix.** Make the decrement itself the guard, inside the transaction:

```js
const result = await tx.batch.updateMany({
  where: { id: item.batchId, quantity: { gte: item.quantity } },
  data:  { quantity: { decrement: item.quantity } },
});
if (result.count === 0) throw new InsufficientStockError(item.medicineName);
```

`updateMany` with a conditional `where` is atomic; zero affected rows means someone else took the stock, and throwing rolls the whole invoice back. Keep the pre-check for fast, friendly errors, but never rely on it. Add `CHECK (quantity >= 0)` as a backstop.

---

**Resolution (2026-08-18).** The decrement is now its own guard, inside the transaction:

```js
const { count } = await tx.batch.updateMany({
  where: { id: item.batchId, quantity: { gte: item.quantity } },
  data:  { quantity: { decrement: item.quantity } },
});
if (count === 0) throw new StockConflictError(/* re-reads the batch for the message */);
```

Check-and-decrement is a single atomic statement, so the loser of a race matches zero rows and rolls the entire invoice back. `StockConflictError` carries the status code out to the handler, preserving the existing 400/404 messages. The pre-transaction check is kept, now advisory only — it fails fast with a friendly message before any work is done.

**Verified:** 12 concurrent single-unit sales against a batch of 10 leave the batch at exactly `0`, never negative, with 10 successes and 2 rejections. Still worth adding `CHECK (quantity >= 0)` as a database-level backstop (Phase 7.9).


---

### <a id="g-07"></a>G-07 ✅ FIXED — Money was stored as `Float`

**Where:** [`schema.prisma`](../backend/prisma/schema.prisma) — `purchasePrice`, `sellingPrice`, `subtotal`, `discountAmt`, `cgst`, `sgst`, `totalAmount`, `unitPrice`, `discount`, `totalPrice`, `costPrice`.

**Problem.** IEEE-754 doubles cannot represent most decimal fractions exactly. The controller rounds each line to 2 dp, but invoice-level `subtotal`, `cgst` and `sgst` accumulate **unrounded** values before rounding, and the GST report sums thousands of these floats. Monthly totals will drift from the sum of the printed invoices — precisely the number that goes on a tax filing.

**Fix.** Migrate to `Decimal @db.Decimal(12, 2)` (Prisma returns `Decimal.js` instances) or store integer paise. Either way, round once per line at the boundary and aggregate exact values. Ship this migration on its own, with a verification query comparing pre- and post-migration totals.

---

**Resolution (2026-08-19).** Migration `20260819153025_money_to_decimal` converts every currency column to `DECIMAL(12,2)` and the two rate columns (`gstPercent`, line `discount` %) to `DECIMAL(5,2)`. Postgres rounds half-up on the cast, so existing rows land on the value that was already being displayed.

The arithmetic moved to `Prisma.Decimal`, and the rounding rule changed to make invoices reconcile by construction:

- each line rounds its taxable value, CGST and SGST to 2 dp, and the line total is built from those rounded parts;
- the invoice header sums the **rounded** line components;
- `totalAmount` is derived from those same rounded components, so `subtotal + cgst + sgst − discountAmt = totalAmount` holds exactly, and Σ line totals equals `subtotal + cgst + sgst`.

Previously lines were rounded for display while the header accumulated unrounded binary error, so the two could disagree. **The migration exposed a real instance of this in existing data:** `INV260419-0005` stores `totalAmount = 106.79` while its own components sum to `106.78`. Historical rows are left as written — they are what was printed and given to the customer.

Because `Decimal.toJSON()` emits a string and the API contract has always been numbers, `index.js` now sets an Express `json replacer` that unwraps `Decimal` to `Number` at the response boundary. Exactness matters in storage and arithmetic, not in a 2 dp display value — **the frontend needed no changes**.

**Verified** against a throwaway database: all six GST fixtures from [09 — Testing Strategy](./09-testing-strategy.md#4-gst-engine-fixtures) produce their documented values; on every one, `cgst === sgst`, the header reconciles exactly, and Σ line totals matches. Across 100 invoices the daily-summary total equals the SQL `SUM` to the paisa. Every money field on the medicines, search, batches, invoice, invoice-detail, GST-report and daily-summary endpoints serialises as a JSON `number`. The [G-09](#g-09)/[G-01](#g-01) concurrency behaviour was re-tested unchanged.


---

### <a id="g-02"></a>G-02 ✅ FIXED — The Nginx entry point did not work

**Where:** [`backend/src/index.js`](../backend/src/index.js) allowlist · [`nginx/nginx.conf`](../nginx/nginx.conf) · `docker-compose.yml`

**Problem.** Nginx serves the app on `:80` and proxies `/api` to the backend. But the SPA is configured with `VITE_API_URL=http://localhost:5000`, so it calls the backend **directly** — and when the page is loaded from `http://localhost`, that origin is not in the CORS allowlist (`3000`, `5173`, `127.0.0.1:5173`, `172.17.0.1:5173`). Every API call fails. The proxy's `/api` block is never exercised, and the documented port-80 entry point is unusable. Everyone works on `:5173` and the proxy is decorative.

**Fix — pick one** (the preferred option was taken; see the resolution below):
- **Preferred:** set `VITE_API_URL=/api` so the SPA uses relative URLs through Nginx. Same origin, no CORS at all, and the deployment gains a single entry point.
- **Minimal:** add `http://localhost` and the production hostname to the allowlist.

Also note `frontend/nginx.conf` is an **empty file** — a placeholder for the production static-serving config that was never written.

---

**Resolution (2026-08-19).** Took the preferred option, and closed the dev-server half of it too:

- `api.ts` defaults `baseURL` to `""` (`??` rather than `||`, so an explicit empty value survives), so the SPA calls `/api/...` on whatever origin served it.
- `vite.config.ts` gains a dev-server proxy forwarding `/api` to the API, with `xfwd: true` so the rate limiter still sees the real client rather than the frontend container.
- `docker-compose.yml` drops `VITE_API_URL` and sets `VITE_PROXY_TARGET=http://backend:5000` instead.
- `http://localhost` was added to the CORS allowlist anyway, for tools that still call port 5000 directly and cross-origin.

Both entry points are now same-origin, so **CORS never enters the picture for the SPA at all**, and Nginx's `/api` block does real work. Port 5173 keeps Vite's HMR exactly as before, so the development workflow is unchanged. `VITE_API_URL` remains available for a deployment where the API genuinely lives on another host.

**Verified:** the SPA is served with `200` on both `:80` and `:5173`; `POST /api/auth/login` reaches the backend through **both** (401 on bad credentials, not a 404 or a CORS failure); a real sign-in through `:80` returns a token and an authenticated `GET /api/inventory/medicines` returns data — the exact flow that was broken. The served `api.ts` module no longer contains a hardcoded API origin, and `npm run build` (with `tsc -b`) passes.


---

### <a id="g-05"></a>G-05 ✅ FIXED — Batch update accepted arbitrary fields

**Where:** `inventory.routes.js` → `batch.controller.js#update`

```js
router.put("/batches/:id", authorize("ADMIN", "PHARMACIST"), batchCtrl.update);  // no validate()
```

```js
data: { ...req.body, ...(req.body.expiryDate && { expiryDate: new Date(req.body.expiryDate) }) }
```

**Problem.** Every other write route runs a Zod schema, which both validates and strips unknown keys. This one forwards the body to Prisma. A pharmacist can set `quantity` to any value (bypassing all stock accounting), rewrite `initialQty`, or repoint `medicineId`/`supplierId` at another record — silently, with no audit trail.

**Fix.** Add a `batchUpdateSchema` with only the fields that may legitimately change (`sellingPrice`, `purchasePrice`, `expiryDate`, `mfgDate`, and `quantity` only if manual adjustment is a real requirement — in which case log it).

---

**Resolution (2026-08-19).** `batchUpdateSchema` now guards the route, and it is deliberately narrow: `batchNumber`, `expiryDate`, `purchasePrice`, `sellingPrice`. **`quantity` and `initialQty` are not editable here** — rewriting stock silently bypasses every accounting path and leaves no trace. Manual adjustment is [FR-BATCH-11](./01-product-requirements.md#65-stock--batches--fr-batch) and needs its own endpoint with an audit trail. The FK columns are excluded for the same reason: repointing a batch at another medicine or supplier rewrites history.

The schema is `.strict()`, so an unrecognised field is a `400` rather than a silent no-op. Silent stripping is exactly how [G-04](#g-04) hid, and this route is where it would be most expensive.

**Verified:** `{ quantity: 99999 }`, `{ initialQty: 1 }` and `{ medicineId: … }` are all rejected with the stock left untouched; `{ sellingPrice: -5 }` is rejected; `{ sellingPrice: 30.5 }` applies and leaves `quantity` alone.


---

### <a id="g-06"></a>G-06 ✅ FIXED — Rate limiter was effectively global

**Where:** `index.js`

**Problem.** `express-rate-limit` keys on `req.ip`. Express is not configured with `trust proxy`, so behind Nginx every request presents the proxy's container IP. All users share one 500-request bucket: a busy dashboard can lock out the billing counter, and no attacker is ever isolated.

**Fix.** `app.set('trust proxy', 1)` (Nginx already sets `X-Real-IP` and `X-Forwarded-For`), and add a strict limiter on `/api/auth/login`:

```js
app.use("/api/auth/login", rateLimit({ windowMs: 15*60*1000, max: 10 }));
```

---

**Resolution (2026-08-19).** Both parts landed:

```js
app.set("trust proxy", process.env.TRUST_PROXY || "loopback, linklocal, uniquelocal");
```

Trust is restricted to private-range peers rather than `true`. Port 5000 is published, so a client reaching it directly must not be able to forge `X-Forwarded-For` and pick its own bucket; `TRUST_PROXY` overrides it when the topology differs.

A dedicated limiter now guards `POST /api/auth/login` at 10 attempts per 15 minutes with `skipSuccessfulRequests: true`, so only failures count and a cashier signing in and out through a shift never trips it.

**Verified:** ten failed logins from one forwarded IP return `401`, the eleventh returns `429`, a different forwarded IP is unaffected (which is what proves the proxy header is being honoured), and fifteen successful logins in a row do not consume the budget.


---

### <a id="g-04"></a>G-04 ✅ FIXED — `mfgDate` could never be saved

**Where:** `inventory.validator.js` (`batchSchema`) vs `batch.controller.js#create`

**Problem.** The column exists (migration `20260419152932_add_mfgdate`) and the controller handles it — `mfgDate: req.body.mfgDate ? new Date(...) : null`. But `batchSchema` does not declare the field, and Zod strips unknown keys before `req.body` reaches the controller. The frontend batch form does not send it either. The column is dead: always `null`.

This is the canonical example of the [AD-09](./02-architecture.md#9-architecture-decisions) trade-off — silent stripping means a missing schema field is not an error, just data loss.

**Fix.** Add `mfgDate: z.string().refine(d => !isNaN(Date.parse(d))).optional()` to `batchSchema` and a date input to the batch form. Consider validating `mfgDate < expiryDate`.

---

**Resolution (2026-08-19).** `mfgDate` added to `batchSchema` and to `batchUpdateSchema`, the batch update controller now coerces it to a `Date` the way create already did, and the Inventory batch form gained a **Mfg Date** input (optional, capped at the chosen expiry date). A cross-field rule rejects a manufacture date on or after the expiry date, reported against the `mfgDate` field.

**Verified:** a batch created with `mfgDate` persists it instead of storing `null`; `mfgDate` after `expiryDate` is rejected with `400` and a field-level error; and the value is editable through `PUT /batches/:id` and stored as a real `Date`.


---

### <a id="g-10"></a>G-10 ✅ FIXED — `totalStock` reported only one batch

**Where:** `medicine.controller.js#getAll`

```js
batches: { where: { quantity: { gt: 0 } }, orderBy: { expiryDate: "asc" }, take: 1 },
…
totalStock: m.batches.reduce((sum, b) => sum + b.quantity, 0),
```

**Problem.** The reduce runs over an array capped at **one** element, so `totalStock` equals the nearest-expiry batch's quantity. A medicine with batches of 20, 150 and 300 units displays `20`. Staff reading the Inventory list see a number that looks like total stock and is not — and it will drive unnecessary reordering.

**Fix.** Either aggregate separately:

```js
const stock = await prisma.batch.groupBy({
  by: ["medicineId"], where: { medicineId: { in: ids }, quantity: { gt: 0 } },
  _sum: { quantity: true },
});
```

…or include all batches and keep `take: 1` only for the `nearestExpiry`/`sellingPrice` derivation. Rename the field if the intent really is "sellable-now stock".

---

**Resolution (2026-08-19).** Stock is now summed in its own `groupBy` over every in-stock batch of the listed medicines, keyed back onto each row. The `take: 1` include stays, because that batch is genuinely useful — it is the FEFO batch the POS would sell next, and therefore the right source for `nearestExpiry` and `sellingPrice`. The query is skipped when the page is empty.

**Verified:** a medicine with batches of 20, 150 and 300 now reports `totalStock: 470` (previously `20`), while `nearestExpiry` and `sellingPrice` still come from the earliest-expiring batch.


---

### <a id="g-11"></a>G-11 ✅ FIXED — User-management routes were unvalidated

**Where:** `auth.routes.js#register`, `user.routes.js` create/update

**Problem.** No Zod schema on any of them. Consequences: no email format check; no password length or strength check (`"1"` is accepted); an invalid `role` string reaches Prisma and surfaces as a 500 rather than a 400; and `PUT /api/users/:id` accepts whatever fields the controller destructures. *(An earlier draft of this entry also claimed `updateProfile` nulls an omitted name — that was wrong. Prisma treats `undefined` as "leave alone", so an omitted field is simply not written.)*

**Fix.** Add `registerSchema` / `userUpdateSchema` alongside the existing validators — email format, password ≥ 8 with a breach check, `role` as `z.enum(["ADMIN","PHARMACIST","CASHIER"])`, and `.partial()` for updates so omitted fields are left alone rather than nulled.

---

**Resolution (2026-08-19).** New `validators/user.validator.js` supplies four schemas, wired into both routers:

| Schema | Route | Notes |
|---|---|---|
| `createUserSchema` | `POST /api/users`, `POST /api/auth/register` | name ≥ 2, valid email, password ≥ 8, `role` enum |
| `updateUserSchema` | `PUT /api/users/:id` | all fields optional; **not** `.strict()` — the active/inactive toggle posts the whole user row back |
| `updateProfileSchema` | `PUT /api/users/profile` | `.strict()`, so a stray `role` is a 400 rather than something that looks accepted and is silently dropped |
| `changePasswordSchema` | `PUT /api/auth/change-password` | new password ≥ 8 |

Password rules are length-only; complexity and breach checks need an external service and stay on the [P1 hardening list](./07-security.md#10-hardening-backlog).

**Verified:** malformed email, short password and an invalid role are each rejected with `400`; a valid create returns `201`; the Settings toggle posting the entire user object still returns `200`; a stray `role` on the profile route is rejected; and a weak new password on change-password is rejected.


---

### <a id="g-12"></a>G-12 ✅ FIXED — Foreign-key violations surfaced as 500

**Where:** `error.middleware.js`

**Problem.** The handler maps Prisma `P2002` (unique) → 409 and `P2025` (not found) → 404, but not `P2003` (FK constraint). Deleting a category, manufacturer or supplier that is still referenced throws `P2003` and falls through to the generic branch — a 500 with no useful message, when the honest answer is "this is still in use".

**Fix.**

```js
if (err.code === "P2003") {
  return res.status(409).json({
    success: false,
    message: "This record is still referenced by other data and cannot be deleted.",
    field: err.meta?.field_name,
  });
}
```

Consider soft-deleting suppliers the way medicines are soft-deleted, since batches keep referencing them forever.

---

**Resolution (2026-08-19).** `errorHandler` now maps Prisma `P2003` to `409` with `This record is still in use by other data and cannot be deleted.` and the offending field, alongside the existing `P2002` and `P2025` mappings.

**Verified:** deleting a category that still has medicines returns `409` with that message rather than an opaque `500`; the same for a supplier that still has batches; and deleting an unused category still returns `200`.

Soft-deleting suppliers the way medicines are soft-deleted remains worth considering, since batches reference them permanently.


---

### <a id="g-03"></a>G-03 🟡 Redis is a dead dependency

**Where:** [`backend/src/config/redis.js`](../backend/src/config/redis.js)

**Problem.** The client is created, connects, and logs success. **No module imports it.** The compose file runs a Redis container and publishes port 6379 with no password. Two READMEs claim caching is a live performance feature. Nothing is cached.

**Fix.** Either use it or drop it. The highest-value first use is the per-request user lookup in `protect` — the single most frequent query in the system — with a short TTL and invalidation on user update ([Phase 11.1](./05-roadmap-and-phases.md#phase-11--performance--scale)). Category and manufacturer lists are the next candidates. If caching is deferred, remove the service from compose so the dependency surface matches reality.

---

### <a id="g-08"></a>G-08 🟡 Sales trend costs 7 HTTP round trips

**Where:** [`frontend/src/pages/Reports.tsx`](../frontend/src/pages/Reports.tsx) `SalesTrend`

**Problem.** The 7-day chart calls `daily-summary` once per day. Each call fetches **every invoice for that day with its customer**, then discards all of it to read two aggregate numbers. Seven round trips and seven full-day payloads for fourteen integers. On a busy store that is megabytes of JSON per chart render.

**Fix.** Add `GET /api/billing/invoices/trend?days=7` backed by one `groupBy` over `date`, returning `[{ date, sales, invoices }]`. Same shape the chart already consumes.

The dashboard has a milder version of this — six calls, two of which fetch a single row purely to read `pagination.total`. A `/api/dashboard/stats` endpoint would collapse it to one.

---

### <a id="g-13"></a>G-13 🟡 Dead code

| Artefact | Status |
|---|---|
| `backend/src/routes/customer.routes.js` | **Empty file**, not imported |
| `backend/src/routes/medicine.routes.js` | **Empty file**, not imported |
| `backend/src/routes/report.routes.js` | **Empty file**, not imported |
| `backend/src/routes/supplier.routes.js` | **Empty file**, not imported |
| `frontend/nginx.conf` | **Empty file** |
| `generateRefreshToken` (`jwt.utils.js`) | Never called |
| `generatePurchaseNumber` (`invoice.utils.js`) | Never called |
| `Purchase` / `PurchaseItem` models | No route, controller or UI |
| `frontend/@/components/ui/` | Stray duplicates of `card.tsx`, `label.tsx`, `select.tsx` — the `@` alias resolved as a literal directory during a `shadcn add` run |
| Redis client | See [G-03](#g-03) |

The empty route files are actively misleading — a reader reasonably assumes `report.routes.js` means reports have a router. Delete them, or fill them as part of the [2.0.0 route re-grouping](./05-roadmap-and-phases.md#release-plan).

---

### <a id="g-14"></a>G-14 ✅ FIXED — There were no automated tests

**Problem.** Zero test files. `backend/package.json` has `"test": "echo \"Error: no test specified\" && exit 1"`; the frontend has no test script at all. The GST engine — the most consequential logic in the product — has never been asserted against a fixture. There is no CI configuration.

Every fix in [Phase 7](./05-roadmap-and-phases.md#phase-7--correctness--data-integrity) changes financial code paths. Without tests, those changes are unverifiable.

**Fix.** [Phase 9](./05-roadmap-and-phases.md#phase-9--test--ci-foundation); acceptance fixtures in [09 — Testing Strategy](./09-testing-strategy.md).

---

**Resolution (2026-08-19).** A backend suite of **278 tests across 11 files**, run by Vitest with Supertest against a real PostgreSQL database, plus a GitHub Actions workflow.

`src/index.js` was split into `src/app.js` (a `createApp()` factory) and `src/index.js` (bind a port), so tests mount the real middleware stack without listening, and can build an app with small rate limits to exercise the limiter deliberately.

What it covers:

| Area | Notes |
|---|---|
| GST engine | All seven fixtures from [09 §4](./09-testing-strategy.md#4-gst-engine-fixtures), plus the reconciliation invariants on four rate/discount combinations |
| Concurrency | The [G-09](#g-09) and [G-01](#g-01) regressions: last-unit races, a 12-way oversell burst, 20 simultaneous sales taking gapless serials, and serial reuse after a rollback |
| Auth | Login, identical answers for unknown/wrong/disabled, token rejection cases, immediate revocation on deactivation, password change |
| RBAC | The whole matrix from [04 §4](./04-api-reference.md#4-role-matrix) — 142 table-driven assertions, plus every route rejecting an anonymous caller |
| Validation | Boundary cases per schema, and a named regression guard for each of [G-04](#g-04), [G-05](#g-05), [G-10](#g-10), [G-11](#g-11), [G-12](#g-12) |
| Reports | Daily and monthly boundaries to the second, paid-only filtering, totals reconciling with the rows returned |
| Rate limiting | [G-06](#g-06): the failed-login budget, per-forwarded-IP isolation, and successful sign-ins not counting |

Two safety properties of the harness are worth knowing. The database is wiped between tests, so `global-setup.js` **refuses to run unless the database name ends in `_test`** — pointing it at a dev database is a hard error, not a data-loss incident. And cleanup uses `DELETE` rather than `TRUNCATE`, which at fixture scale cut the suite from 52s to **21s**.

Coverage is 87% overall, with a CI gate at 90% on `billing.controller.js` (94%) and `auth.middleware.js` (96%) — the two files where a regression is a financial or security incident rather than a bug.

**Still open:** the Playwright browser smoke test (9.6) and frontend unit tests (9.5). The backend, where all the money and stock logic lives, is covered.


---

### <a id="g-15"></a>G-15 🟡 Invoices cannot be corrected

**Problem.** There is no update or delete route for invoices. A wrong quantity, wrong customer or wrong payment mode is permanent. The stock deducted by a mistaken invoice can only be restored by hand-editing a batch through the unvalidated `PUT /batches/:id` ([G-05](#g-05)) — which is exactly the kind of untracked adjustment that makes stock records untrustworthy.

Immutability is the right *default* for financial records; the missing piece is a **credit note / void** path that reverses an invoice with an audit trail rather than editing history.

**Fix.** Add a void endpoint (ADMIN) that marks the original `CANCELLED`, writes a reversing record, and restores stock to the original batches inside one transaction. Depends on [Q3](./01-product-requirements.md#14-open-questions).

---

### <a id="g-16"></a>G-16 🟡 Data fetching sets state synchronously inside effects

**Problem.** Eleven components fetch on mount by calling `setState` synchronously in an effect body. `eslint-plugin-react-hooks` v7 promotes this to an error (`react-hooks/set-state-in-effect`), and it was the reason **CI failed on every run from the commit that introduced it until 2026-08-20**.

| File | Lines |
|---|---|
| `frontend/src/pages/Customers.tsx` | 110, 302 |
| `frontend/src/pages/Inventory.tsx` | 182, 671, 681, 1102, 1303 |
| `frontend/src/pages/Reports.tsx` | 163, 353 |
| `frontend/src/pages/Settings.tsx` | 427 |
| `frontend/src/pages/Suppliers.tsx` | 76 |

The pattern causes a guaranteed second render on every mount, and each site hand-rolls its own `loading` / `error` state. Three of them (`Reports.tsx:163`, `Reports.tsx:353`, `useNotifications.ts:73`) also carry `react-hooks/exhaustive-deps` warnings, which is the same root cause seen from a different angle.

Nothing here is *incorrect* today — the screens work. It is a structural problem: the fetch-then-setState pattern cannot express request cancellation, so a fast route change can land a stale response over a fresh one.

**Fix.** Move data fetching to a query library (TanStack Query is the obvious fit) so caching, cancellation and loading state stop being re-implemented per screen. Until then the rule is set to `warn` in [`frontend/eslint.config.js`](../frontend/eslint.config.js) with a comment pointing here. **Restore it to `error` when this is closed.**

> Deliberately *not* fixed alongside the React Compiler purity errors on 2026-08-20: that change had to stay small enough to verify by eye, and this one is a refactor of every screen's data layer.

---

## Prioritised remediation order

| Order | Items | Rationale |
|---|---|---|
| ~~1~~ | ~~[G-09](#g-09), [G-01](#g-01)~~ | **Done 2026-08-18** — both fixed and verified under concurrency |
| ~~2~~ | ~~[G-07](#g-07)~~ | **Done 2026-08-19** — money is `DECIMAL(12,2)`, arithmetic is `Prisma.Decimal`, invoices reconcile exactly |
| ~~3~~ | ~~[G-05](#g-05), [G-11](#g-11), [G-06](#g-06)~~ | **Done 2026-08-19** — write paths validated, limiter per-client with a login-specific budget |
| ~~4~~ | ~~[G-02](#g-02)~~ | **Done 2026-08-19** — both entry points same-origin through a proxy |
| ~~5~~ | ~~[G-10](#g-10), [G-04](#g-04), [G-12](#g-12)~~ | **Done 2026-08-19** — stock totals correct, manufacture dates recordable, delete conflicts explained |
| ~~6~~ | ~~[G-14](#g-14)~~ | **Done 2026-08-19** — 278 tests, CI, and a coverage gate on the money and auth paths |
| 7 | [G-08](#g-08), [G-03](#g-03), [G-13](#g-13), [G-15](#g-15) | Performance, dead weight, operational usability |
| 8 | Part A (docs) | Trim the READMEs to point at `docs/` |
| 9 | [G-16](#g-16) | Frontend data-layer refactor. Largest and least urgent — the screens work today. Closing it restores `set-state-in-effect` to `error` |
