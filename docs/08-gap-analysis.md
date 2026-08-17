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
| D-6 | `npm test`, `npm run test:coverage`, `npm run test:watch`, `npm run lint`, `npm run format` for the backend | backend + root README | Only `test` exists and it exits 1. No lint or format script |
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
| [G-01](#g-01) | 🔴 | Invoice numbers collide under concurrent checkout |
| [G-09](#g-09) | 🔴 | Stock check happens outside the transaction — oversell race |
| [G-07](#g-07) | 🔴 | All money stored as `Float` |
| [G-02](#g-02) | 🟠 | Nginx entry point is unusable — origin missing from the CORS allowlist |
| [G-05](#g-05) | 🟠 | `PUT /api/inventory/batches/:id` accepts arbitrary fields |
| [G-06](#g-06) | 🟠 | Rate limiter is global, not per-client, behind the proxy |
| [G-04](#g-04) | 🟠 | `mfgDate` can never be saved |
| [G-10](#g-10) | 🟠 | `totalStock` reports one batch, not all |
| [G-11](#g-11) | 🟠 | User-management routes are unvalidated |
| [G-12](#g-12) | 🟠 | FK violations surface as 500 |
| [G-03](#g-03) | 🟡 | Redis is a dead dependency |
| [G-08](#g-08) | 🟡 | Sales trend costs 7 HTTP round trips |
| [G-13](#g-13) | 🟡 | Dead code: 4 empty route files, unused utils, empty nginx.conf |
| [G-14](#g-14) | 🟡 | No automated tests |
| [G-15](#g-15) | 🟡 | Invoices are immutable with no correction path |

---

### <a id="g-01"></a>G-01 🔴 Invoice numbers collide under concurrency

**Where:** [`backend/src/utils/invoice.utils.js`](../backend/src/utils/invoice.utils.js)

```js
const count = await prisma.invoice.count({ where: { createdAt: { gte: startOfDay } } });
const serial = String(count + 1).padStart(4, "0");
return `${prefix}-${serial}`;
```

**Problem.** The count runs *outside* the transaction that inserts the invoice. Two checkouts starting within the same window both read `count = 41` and both build `INV260817-0042`. `Invoice.invoiceNumber` is unique, so the second insert fails with `P2002` → the cashier sees `409 A record with this value already exists.` on a perfectly valid sale, after the customer has paid.

A second, subtler bug: `new Date(today.setHours(0,0,0,0))` **mutates** `today`, so `prefix` is computed from the date before mutation and the boundary from after. It happens to work because `prefix` is built first — but any reordering of those lines silently breaks day boundaries.

**Fix.** Use a database sequence per day, or wrap generation and insertion in the same transaction with a retry on `P2002`:

```js
for (let attempt = 0; attempt < 5; attempt++) {
  try { return await prisma.$transaction(async (tx) => { /* count + create */ }); }
  catch (e) { if (e.code !== "P2002") throw e; }
}
throw new Error("Could not allocate an invoice number");
```

Stop mutating `today`; derive both values from a single immutable date.

---

### <a id="g-09"></a>G-09 🔴 Stock check is outside the transaction

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

### <a id="g-07"></a>G-07 🔴 Money stored as `Float`

**Where:** [`schema.prisma`](../backend/prisma/schema.prisma) — `purchasePrice`, `sellingPrice`, `subtotal`, `discountAmt`, `cgst`, `sgst`, `totalAmount`, `unitPrice`, `discount`, `totalPrice`, `costPrice`.

**Problem.** IEEE-754 doubles cannot represent most decimal fractions exactly. The controller rounds each line to 2 dp, but invoice-level `subtotal`, `cgst` and `sgst` accumulate **unrounded** values before rounding, and the GST report sums thousands of these floats. Monthly totals will drift from the sum of the printed invoices — precisely the number that goes on a tax filing.

**Fix.** Migrate to `Decimal @db.Decimal(12, 2)` (Prisma returns `Decimal.js` instances) or store integer paise. Either way, round once per line at the boundary and aggregate exact values. Ship this migration on its own, with a verification query comparing pre- and post-migration totals.

---

### <a id="g-02"></a>G-02 🟠 The Nginx entry point does not work

**Where:** [`backend/src/index.js`](../backend/src/index.js) allowlist · [`nginx/nginx.conf`](../nginx/nginx.conf) · `docker-compose.yml`

**Problem.** Nginx serves the app on `:80` and proxies `/api` to the backend. But the SPA is configured with `VITE_API_URL=http://localhost:5000`, so it calls the backend **directly** — and when the page is loaded from `http://localhost`, that origin is not in the CORS allowlist (`3000`, `5173`, `127.0.0.1:5173`, `172.17.0.1:5173`). Every API call fails. The proxy's `/api` block is never exercised, and the documented port-80 entry point is unusable. Everyone works on `:5173` and the proxy is decorative.

**Fix — pick one:**
- **Preferred:** set `VITE_API_URL=/api` so the SPA uses relative URLs through Nginx. Same origin, no CORS at all, and the deployment gains a single entry point.
- **Minimal:** add `http://localhost` and the production hostname to the allowlist.

Also note `frontend/nginx.conf` is an **empty file** — a placeholder for the production static-serving config that was never written.

---

### <a id="g-05"></a>G-05 🟠 Batch update accepts arbitrary fields

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

### <a id="g-06"></a>G-06 🟠 Rate limiter is effectively global

**Where:** `index.js`

**Problem.** `express-rate-limit` keys on `req.ip`. Express is not configured with `trust proxy`, so behind Nginx every request presents the proxy's container IP. All users share one 500-request bucket: a busy dashboard can lock out the billing counter, and no attacker is ever isolated.

**Fix.** `app.set('trust proxy', 1)` (Nginx already sets `X-Real-IP` and `X-Forwarded-For`), and add a strict limiter on `/api/auth/login`:

```js
app.use("/api/auth/login", rateLimit({ windowMs: 15*60*1000, max: 10 }));
```

---

### <a id="g-04"></a>G-04 🟠 `mfgDate` can never be saved

**Where:** `inventory.validator.js` (`batchSchema`) vs `batch.controller.js#create`

**Problem.** The column exists (migration `20260419152932_add_mfgdate`) and the controller handles it — `mfgDate: req.body.mfgDate ? new Date(...) : null`. But `batchSchema` does not declare the field, and Zod strips unknown keys before `req.body` reaches the controller. The frontend batch form does not send it either. The column is dead: always `null`.

This is the canonical example of the [AD-09](./02-architecture.md#9-architecture-decisions) trade-off — silent stripping means a missing schema field is not an error, just data loss.

**Fix.** Add `mfgDate: z.string().refine(d => !isNaN(Date.parse(d))).optional()` to `batchSchema` and a date input to the batch form. Consider validating `mfgDate < expiryDate`.

---

### <a id="g-10"></a>G-10 🟠 `totalStock` reports only one batch

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

### <a id="g-11"></a>G-11 🟠 User-management routes are unvalidated

**Where:** `auth.routes.js#register`, `user.routes.js` create/update

**Problem.** No Zod schema on any of them. Consequences: no email format check; no password length or strength check (`"1"` is accepted); an invalid `role` string reaches Prisma and surfaces as a 500 rather than a 400; `PUT /api/users/:id` accepts whatever fields the controller destructures, and `updateProfile` will write `null` over a name if `name` is omitted.

**Fix.** Add `registerSchema` / `userUpdateSchema` alongside the existing validators — email format, password ≥ 8 with a breach check, `role` as `z.enum(["ADMIN","PHARMACIST","CASHIER"])`, and `.partial()` for updates so omitted fields are left alone rather than nulled.

---

### <a id="g-12"></a>G-12 🟠 Foreign-key violations surface as 500

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

### <a id="g-14"></a>G-14 🟡 No automated tests

**Problem.** Zero test files. `backend/package.json` has `"test": "echo \"Error: no test specified\" && exit 1"`; the frontend has no test script at all. The GST engine — the most consequential logic in the product — has never been asserted against a fixture. There is no CI configuration.

Every fix in [Phase 7](./05-roadmap-and-phases.md#phase-7--correctness--data-integrity) changes financial code paths. Without tests, those changes are unverifiable.

**Fix.** [Phase 9](./05-roadmap-and-phases.md#phase-9--test--ci-foundation); acceptance fixtures in [09 — Testing Strategy](./09-testing-strategy.md).

---

### <a id="g-15"></a>G-15 🟡 Invoices cannot be corrected

**Problem.** There is no update or delete route for invoices. A wrong quantity, wrong customer or wrong payment mode is permanent. The stock deducted by a mistaken invoice can only be restored by hand-editing a batch through the unvalidated `PUT /batches/:id` ([G-05](#g-05)) — which is exactly the kind of untracked adjustment that makes stock records untrustworthy.

Immutability is the right *default* for financial records; the missing piece is a **credit note / void** path that reverses an invoice with an audit trail rather than editing history.

**Fix.** Add a void endpoint (ADMIN) that marks the original `CANCELLED`, writes a reversing record, and restores stock to the original batches inside one transaction. Depends on [Q3](./01-product-requirements.md#14-open-questions).

---

## Prioritised remediation order

| Order | Items | Rationale |
|---|---|---|
| 1 | [G-09](#g-09), [G-01](#g-01) | Silent data corruption during normal two-counter operation |
| 2 | [G-07](#g-07) | Financial precision; needs a data migration, so do it before invoice volume grows |
| 3 | [G-05](#g-05), [G-11](#g-11), [G-06](#g-06) | Open write paths and an ineffective limiter |
| 4 | [G-02](#g-02) | Blocks the documented deployment topology |
| 5 | [G-10](#g-10), [G-04](#g-04), [G-12](#g-12) | Wrong or missing data shown to staff |
| 6 | [G-14](#g-14) | Required to keep 1–5 fixed |
| 7 | [G-08](#g-08), [G-03](#g-03), [G-13](#g-13), [G-15](#g-15) | Performance, dead weight, operational usability |
| 8 | Part A (docs) | Trim the READMEs to point at `docs/` |
