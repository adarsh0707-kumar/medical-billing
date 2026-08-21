# Testing Strategy

**Current state (2026-08-20): 327 backend tests, 66 frontend unit tests and a 6-flow browser smoke — all three layers on CI.** The backend suite is implemented. Frontend unit testing is now set up (Vitest + Testing Library) and covers the cart arithmetic; the remaining §5.6 cases and the browser smoke test are still open. Sections 1–4 describe the approach and the acceptance fixtures; §5 lists the cases, most of which now exist.

---

## 1. Why this is urgent

The GST engine in `billing.controller.js` decides what the store charges customers and what it declares to the tax authority. Every Phase 7 fix — the oversell race, invoice numbering, the `Float`→`Decimal` migration — modified that same code path. A regression there is a financial error, not a UI glitch, which is why the fixtures in §4 are treated as a contract rather than a convenience.

Those fixes were each verified by hand as they landed. The suite exists so that verification is repeated on every commit instead of once.

---

---

## 1a. Running the suite

```bash
# against the Docker stack
docker compose exec \
  -e DATABASE_URL='postgresql://medadmin:medpass123@postgres:5432/medicaldb_test' \
  backend npm test

# watch mode, or with the coverage gate
… backend npm run test:watch
… backend npm run test:coverage
```

`DATABASE_URL` **must** name a database ending in `_test`. The suite empties every table between tests, so `global-setup.js` refuses to start against anything else — pointing it at `medicaldb` is a hard error rather than a data-loss incident. The database is created and migrated automatically on first run.

### How it is put together

| Piece                           | Purpose                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `backend/vitest.config.mjs`   | Node environment,`NODE_ENV=test`, files run serially (they share one database), coverage thresholds |
| `tests/setup/global-setup.js` | Guards the database name, then applies migrations once                                                |
| `tests/setup/each-test.js`    | Empties every table before each test, children first                                                  |
| `tests/helpers/factory.js`    | `buildApp()`, signed-in users by role, and inventory fixtures                                       |

Two decisions worth knowing:

- **`createApp()` is a factory.** `src/index.js` binds a port; `src/app.js` builds the app. Tests mount the real middleware stack without listening, and the rate-limit tests build an app with a small budget while every other test gets an effectively unlimited one — so one file can never spend another's.
- **Cleanup uses `DELETE`, not `TRUNCATE`.** At fixture scale, `TRUNCATE`'s exclusive lock costs more than the deletes. The switch took the suite from 52s to 21s.
- **Tokens are minted directly** in the factory rather than by calling the login route, and the bcrypt hash is computed once for the whole run. `tests/auth/auth.test.js` covers the login route itself.

### What exists

| File                                          | Tests | Covers                                                                     |
| --------------------------------------------- | ----: | -------------------------------------------------------------------------- |
| `tests/auth/auth.test.js`                   |    13 | Login, token rejection, immediate revocation, password change              |
| `tests/auth/rbac.test.js`                   |   142 | The full role matrix, plus anonymous rejection on every route              |
| `tests/auth/rate-limit.test.js`             |     5 | Failed-login budget, per-client isolation, successful sign-ins not counted |
| `tests/billing/invoice-create.test.js`      |    28 | GST fixtures, invariants, rejections, atomicity                            |
| `tests/billing/invoice-concurrency.test.js` |     4 | Last-unit races, oversell bursts, gapless serials                          |
| `tests/billing/reports.test.js`             |    12 | Daily and GST reports, date boundaries, paid-only filtering                |
| `tests/billing/customers.test.js`           |    10 | Uniqueness, validation, search, history                                    |
| `tests/inventory/medicines.test.js`         |    14 | Stock totals, POS search, soft delete, validation                          |
| `tests/inventory/batches.test.js`           |    16 | Opening stock, manufacture dates, strict updates, alert windows            |
| `tests/inventory/masters.test.js`           |    17 | Masters CRUD, delete conflicts, suppliers                                  |
| `tests/users/users.test.js`                 |    17 | User CRUD, validation, profile safety                                      |

Coverage is 87% overall; `billing.controller.js` and `auth.middleware.js` are gated at 90% in CI.

### Still open

- ~~Frontend unit tests — §5.6~~ **done 2026-08-20**: 66 cases across cart maths, the POS stock guards, `ProtectedRoute`, the sidebar role filter, the 401 interceptor and notification severity.
- ~~Wiring `npm test` into the frontend CI job~~ **done** — it runs before the build, and a broken cart rounding now turns CI red.
- ~~A Playwright browser smoke test — §5.7~~ **done 2026-08-20**, all six flows, in its own CI job.
- Component coverage beyond the §5.6 screens, and a second browser besides Chromium.
- ~~Query-parameter validation cases, once the API validates them~~ — **done 2026-08-20**, `tests/api/query-validation.test.js` (44 cases)

## 2. Target shape

```
        ╱ E2E — Playwright, ~6 flows ╲            slow, few
      ╱ Integration — Supertest + real Postgres ╲  the bulk of the value
    ╱ Unit — pure functions, calculations       ╲  fast, many
```

Integration tests carry the weight here, because most of the risk lives in the interaction between validator, controller, Prisma and the database — not in isolated pure functions. Aim high on the money paths and low everywhere else; a coverage percentage across the whole repo is not a useful target.

| Layer               | Tooling                                 | Scope                                                            |
| ------------------- | --------------------------------------- | ---------------------------------------------------------------- |
| Backend unit        | Vitest                                  | GST maths, invoice numbering, JWT utils                          |
| Backend integration | Vitest + Supertest + throwaway Postgres | Every route: auth, RBAC, validation, error mapping, transactions |
| Frontend unit       | Vitest + Testing Library                | Cart totals, auth store, notification derivation                 |
| E2E                 | Playwright                              | Login → sell → verify stock → report                          |

**Test database:** a disposable schema per run (`DATABASE_URL` pointing at `medicaldb_test`, `prisma migrate deploy`, truncate between tests) or Testcontainers. Do not mock Prisma — the bugs in [08](./08-gap-analysis.md) are database-behaviour bugs, and a mock would have hidden every one of them.

---

## 3. Priority order

| Priority | Area                                                                            | Why                                                                               |
| -------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| P0       | Invoice creation: maths, stock deduction, transaction rollback                  | The core write path; two known 🔴 defects live here                               |
| P0       | Concurrency: simultaneous invoices on one batch, simultaneous invoice numbering | Proves[G-01](./08-gap-analysis.md#g-01) and [G-09](./08-gap-analysis.md#g-09) fixed |
| P0       | Auth: login, token verification,`isActive` revocation                         | The security boundary                                                             |
| P1       | RBAC: the full 403 matrix                                                       | Cheap, tabular, high regression value                                             |
| P1       | Validation: every Zod schema's boundaries                                       | Catches stripped-field bugs like[G-04](./08-gap-analysis.md#g-04)                  |
| P1       | Reports: daily summary and GST aggregation                                      | Feeds tax filing                                                                  |
| P2       | Inventory CRUD, soft delete, unique constraints                                 |                                                                                   |
| P2       | Frontend cart maths mirroring the server                                        | Client and server compute totals independently — they must agree                 |
| P3       | E2E smoke                                                                       | Integration confidence, slow feedback                                             |

---

## 4. GST engine fixtures

These are the acceptance set for `createInvoice`. All values follow [PRD §8 BR-01/BR-02](./01-product-requirements.md#8-key-business-rules).

| #                                        | Input                                   | Expected                                                                                                       |
| ---------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **F1** Single line, no discount    | 1 × (₹24.50 × 10 units, 0%, GST 12%) | taxable 245.00 · cgst 14.70 · sgst 14.70 · lineTotal 274.40 ·**total 274.40**                        |
| **F2** Line discount               | 1 × (₹100.00 × 3, 10%, GST 5%)       | taxable 270.00 · cgst 6.75 · sgst 6.75 ·**total 283.50**                                              |
| **F3** Zero-rated                  | 1 × (₹250.00 × 2, 0%, GST 0%)        | taxable 500.00 · cgst 0 · sgst 0 ·**total 500.00**                                                    |
| **F4** Multi-line + bill discount  | F1 line + F2 line,`discountAmt` ₹50  | subtotal 515.00 · cgst 21.45 · sgst 21.45 ·**total 507.90**                                           |
| **F5** Full line discount          | 1 × (₹80.00 × 1, 100%, GST 18%)      | taxable 0 · gst 0 ·**total 0.00**                                                                      |
| **F6** Rounding                    | 1 × (₹33.33 × 3, 0%, GST 18%)        | taxable 99.99 · cgst 9.00 · sgst 9.00 ·**total 117.99**                                               |
| **F7** Bill discount exceeds total | F3 with`discountAmt` ₹600            | **`400`**, field error on `discountAmt` naming the maximum. Settled 2026-08-21: refused, never clamped |

**Invariants to assert on every fixture:**

- `cgst === sgst` (BR-03, unconditional 50/50 split).
- `totalAmount === subtotal + cgst + sgst − discountAmt`, **exactly**. Since the `Decimal` migration (2026-08-19) the header is derived from the same rounded components the lines carry, so no tolerance is acceptable here ([G-07](./08-gap-analysis.md#g-07)). Invoices written before that migration can be a paisa off and are left as printed — exclude them by date rather than loosening the assertion.
- Σ `InvoiceItem.totalPrice` reconciles to `subtotal + cgst + sgst`.
- The client's cart total (Billing page) equals the server's `totalAmount` for the same input. **Holds by construction since 2026-08-20** ([G-17](./08-gap-analysis.md#g-17)): the cart runs the same rounding pipeline in integer paise, in [`frontend/src/lib/cart-math.ts`](../frontend/src/lib/cart-math.ts), asserted against these fixtures by `frontend/src/pages/__tests__/cart-math.test.ts`. It previously summed unrounded floats and disagreed on roughly 40% of realistic inputs — the smallest witness being ₹1.00 × 1 at 5% GST, where the cart showed ₹1.05 and the invoice stored ₹1.06. Assert CGST and SGST **separately**, not just the total: the divergence lives in the split, and a test that only checks `totalAmount` misses it whenever the two errors cancel.

---

## 5. Critical test cases

### 5.1 Invoice creation — P0

**Happy path**

- Creates the invoice, the correct number of items, and decrements each batch by exactly its quantity.
- `invoiceNumber` matches `/^INV\d{6}-\d{4}$/`.
- `userId` is the caller; `customerId` is null when omitted.
- `medicineName` is snapshotted — renaming the medicine afterwards does not change the line.
- Payment mode/status defaults are `CASH`/`PAID` when omitted.

**Rejections**

- `items: []` → 400 `At least one item is required`.
- Unknown `batchId` → 404 `Batch not found for <name>`.
- `quantity` > stock → 400 `Insufficient stock for <name>. Available: <n>`.
- `quantity: 0`, `-1`, `1.5` → 400.
- `discount: 101`, `-1` → 400.
- `paymentMode: "BITCOIN"` → 400.
- No token → 401.

**Atomicity**

- With two lines where the second is invalid, **no** invoice row exists and **no** batch was decremented.
- Force a failure inside the transaction (e.g. duplicate invoice number) and assert full rollback of both invoice and stock.

**Concurrency — the tests that matter most**

- Batch with `quantity: 1`. Fire two invoices for 1 unit concurrently → exactly one 201 and one 400; final `quantity` is `0`, never `-1`.
- Fire 20 concurrent invoices → 20 distinct `invoiceNumber` values, zero 409s.
- 50 concurrent single-unit sales from a batch of 30 → 30 successes, 20 rejections, final quantity 0.

### 5.2 Authentication & authorisation — P0/P1

- Valid credentials → 200 with a decodable token carrying the right `id`.
- Wrong password, unknown email and deactivated user → **identical** 401 body.
- Missing header, malformed header, expired token, token signed with a different secret → 401 with the specific message.
- A token for a user deleted mid-session → 401 on the next request.
- Deactivating a user (`isActive: false`) invalidates their still-valid token immediately.
- `changePassword` with the wrong current password → 400; with the right one → the new password logs in and the old one does not.
- **RBAC matrix:** table-drive the whole of [04 §4](./04-api-reference.md#4-role-matrix) — for each (role, route) pair assert 403 or non-403. One parameterised test covers ~40 assertions.
- An admin cannot delete their own account → 400.

### 5.3 Inventory — P1/P2

- Medicine create rejects `unit: "bottle"` and `gstPercent: 7` (Zod allowlists).
- Duplicate category/manufacturer name → 409 with a `field` key.
- Soft delete: after `DELETE /medicines/:id`, the record is absent from list **and** search but its batches and invoice lines survive.
- Duplicate `(medicineId, batchNumber)` → 409; the same batch number under a *different* medicine → 201.
- `POST /batches` sets `initialQty === quantity`.
- **`mfgDate` regression test:** send `mfgDate` and assert it persists. This fails today ([G-04](./08-gap-analysis.md#g-04)) and is the guard that keeps it fixed.
- `expiring?days=N` includes a batch at N−1 days, excludes one at N+1 days, excludes an expired batch, excludes a zero-quantity batch.
- `low-stock?threshold=T` includes `quantity = T`, excludes `T+1`, excludes `0`.
- **`totalStock` regression test:** a medicine with batches of 20/150/300 reports 470, not 20 ([G-10](./08-gap-analysis.md#g-10)).
- `medicines/search?q=a` (1 char) → `[]`; `q=par` → matches on brand *and* generic name; a zero-stock medicine returns `batchId: null` and `batchNumber: "No Stock"`.
- Deleting a referenced category returns 409, not 500 ([G-12](./08-gap-analysis.md#g-12)).

### 5.4 Customers — P2

- Duplicate phone → 409; two customers with `phone: null` both succeed.
- `age: 151` and `age: -1` → 400; `age: "45"` (string) is accepted and stored as `45`.
- `email: ""` accepted; `email: "nope"` → 400.
- Pagination and search across name, phone and email.

### 5.5 Reports — P1

- Daily summary counts only the target date — assert boundaries at `00:00:00.000` and `23:59:59.999`.
- `byPaymentMode` sums per mode and reconciles to `totalSales`.
- An empty day returns zeros, not nulls.
- GST report includes only `PAID` invoices — seed a `PENDING` and a `PARTIAL` and assert exclusion.
- GST report month boundaries: an invoice on the 1st at 00:00 and one on the last day at 23:59 are both included; the 1st of the next month is not.
- `totals` reconciles to the sum of the returned invoices.
- ~~Missing/garbage `month`/`year` → currently an empty result; decide whether it should 400 and assert that.~~ **Decided 2026-08-20: 400.** An empty tax period is indistinguishable from a month with genuinely no sales, and filing from a typo is the worse failure. Asserted in `tests/api/query-validation.test.js`.

### 5.6 Frontend — P2

- Cart line total matches the server fixture set (§4) for the same inputs.
- Quantity cannot exceed the batch `stock` shown in search results.
- Adding a `batchId: null` (no-stock) search result is prevented.
- `ProtectedRoute` redirects an unauthenticated visitor to `/login`.
- The sidebar hides Settings for non-admins.
- A 401 response clears `localStorage` and redirects.
- `useNotifications` marks a batch expiring in 5 days as `danger` and one at 25 days as `warning`.

### 5.7 E2E (Playwright) — P3

1. Seed admin logs in → dashboard renders.
2. Create category → manufacturer → medicine → batch; the medicine appears in POS search with the right stock.
3. Sell 2 units → invoice created → the print view opens → batch stock dropped by 2.
4. Oversell attempt → visible error, stock unchanged.
5. Daily report reflects the new invoice.
6. A cashier account sees no Settings link and receives 403 when calling `/api/users` directly.

---

## 6. CI outline

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  backend:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15-alpine
        env: { POSTGRES_USER: test, POSTGRES_PASSWORD: test, POSTGRES_DB: medicaldb_test }
        options: >-
          --health-cmd "pg_isready -U test" --health-interval 5s
          --health-timeout 5s --health-retries 5
        ports: ["5432:5432"]
    env:
      DATABASE_URL: postgresql://test:test@localhost:5432/medicaldb_test
      JWT_SECRET: test-secret-not-used-anywhere-real
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm, cache-dependency-path: backend/package-lock.json }
      - run: npm ci
        working-directory: backend
      - run: npx prisma migrate deploy && npx prisma generate
        working-directory: backend
      - run: npm test
        working-directory: backend

  frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm, cache-dependency-path: frontend/package-lock.json }
      - run: npm ci --legacy-peer-deps
        working-directory: frontend
      - run: npm run lint
        working-directory: frontend
      - run: npm run build      # tsc -b catches type errors lint does not
        working-directory: frontend
```

**Gates to enforce on PRs:** backend tests green · frontend lint and build green · `billing.controller.js` and `auth.middleware.js` above 90% line coverage · no new `console.log` in backend `src/`.

---

## 7. Manual QA checklist

Until the automated suite lands, run this before any release. It is ordered so each step sets up the next.

**Setup**

- [ ] `docker compose up -d` from clean; `/health` returns 200
- [ ] `npm run seed`; admin logs in at http://localhost:5173

**Auth & roles**

- [ ] Wrong password shows an error and does not sign in
- [ ] Create a `CASHIER`; sign in as them; Settings is absent from the sidebar
- [ ] As cashier, `GET /api/users` via curl returns 403
- [ ] Deactivate the cashier while they are signed in — their next action bounces them to login

**Master data & stock**

- [ ] Create a category and a manufacturer; duplicate names are rejected with a clear message
- [ ] Create a medicine (unit `tablet`, GST 12%, Schedule H on)
- [ ] Create a supplier
- [ ] Add a batch: qty 100, expiry ~20 days out, selling price ₹24.50
- [ ] The medicine's stock and nearest expiry appear in the Inventory list
- [ ] The batch appears under Reports → Stock Alerts and in the notification tray

**Billing**

- [ ] POS search finds the medicine on 3 characters; batch, expiry, price and stock are shown; the Schedule H badge appears
- [ ] Add 10 units → line total ₹274.40 (F1)
- [ ] Apply a 10% line discount → totals update correctly
- [ ] Register a customer inline; they attach to the bill
- [ ] Attempt 200 units → clear insufficient-stock error, nothing saved
- [ ] Complete the sale → invoice number is `INVyymmdd-nnnn`, print view opens
- [ ] Batch stock is now 90
- [ ] The invoice appears in history and reprints identically

**Reports**

- [ ] Daily report shows the sale, correct GST split and payment mode
- [ ] GST report for the current month includes it
- [ ] Sales trend renders 7 days
- [ ] Dashboard tiles match the daily report

**Edge cases**

- [ ] Bill a walk-in with no customer attached
- [ ] Sell a 0% GST medicine → no tax charged
- [ ] Soft-delete a medicine → gone from search, its past invoice still prints
- [ ] Refresh mid-session → still signed in (persisted store)
- [ ] Sign out → protected routes redirect to login

---

## 8. What good looks like

The suite is doing its job when:

- A regression in the GST maths fails CI before review.
- The concurrency tests fail on the current `main` and pass after the Phase 7 fixes — proving the fix rather than asserting it.
- Adding a column without adding it to its Zod schema breaks a test ([G-04](./08-gap-analysis.md#g-04) never recurs).
- The RBAC matrix test fails the moment a route's `authorize()` list changes without an intentional decision.
