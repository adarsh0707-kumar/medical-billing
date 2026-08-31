# Testing Strategy

**Backend, measured 2026-08-31: 634 tests across 24 files, all passing.** Frontend and browser: 125 unit tests across 16 files and a 7-flow smoke, last measured 2026-08-27. All three layers on CI.

⚠️ **The frontend total is stale and understated.** The file table below has been brought back in step with the tree — 18 files, not 16 — but its *count* has not, because this document's rule is that counts come from a run, and the run needs Node 22 (below it the suite dies in jsdom with `webidl.util.markAsUncloneable is not a function`, which says nothing about the cause). Three files are missing from the last measurement: `Signup`, `amount-in-words` and `print-document`. **Run `npm test` in `frontend/` on Node 22 and replace the number**; do not add up the table to get it.

> Counts here are taken by **running the suites**, not by adding up the table below. Three documents previously carried four different numbers because the table was maintained by hand and two suites were never added to it — which is the same failure the warning above is recording, caught earlier this time.

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

**Backend — 634 across 24 files, all passing.** The count is what a run reports, not what passes — recording it the other way would be the drift this section exists to prevent, and for a while the two genuinely differed.

Two failures worth remembering, both fixed 2026-08-27:

- **The login-timing guards were inert for weeks.** bcryptjs 3.x began dual-publishing ESM and CommonJS, the test `import`ed one build while the controller `require`s the other, and `vi.spyOn` patched a module instance the controller never called. The guards reported zero comparisons and failed, so CI was red — but the *control* was fine throughout, which is the trap: a test that fails loudly is a better outcome than one that passes while measuring nothing. `tests/auth/auth.test.js` now reaches bcryptjs through `createRequire`, and says why.
- **One test could only fail off CI.** `reports.test.js` built its `?date=` with `toISOString().slice(0, 10)` on a local-midnight instant, which names the previous day everywhere east of Greenwich. Green in CI's UTC, red on any machine in IST — the timezone this product is actually built for. Dates crossing a local/UTC boundary in a test are worth the same suspicion they get in the controllers.

| File                                            | Tests | Covers                                                                     |
| ----------------------------------------------- | ----: | -------------------------------------------------------------------------- |
| `tests/auth/rbac.test.js`                     |   142 | The full role matrix, plus anonymous rejection on every route              |
| `tests/billing/invoice-create.test.js`        |    48 | GST fixtures, invariants, rejections, atomicity, Schedule H and expiry     |
| `tests/api/logging.test.js`                   |     5 | The path in the human-readable log line, which a mounted router strips off `req.url` |
| `tests/auth/signup.test.js`                   |    25 | Signup: the shop and its first administrator, an eight-way concurrent burst, what it refuses, and **tenant isolation** asserted across the resource controllers, the user list and the dashboard. *(Description corrected 2026-08-31 — it said "the endpoint closing itself", which stopped being true when signup reopened on 2026-08-29.)* |
| `tests/api/dashboard.test.js`                 |    26 | Every panel of `GET /api/dashboard/stats`: counting under a void, count-vs-items, the expiry and low-stock windows, and the trend's day bucketing |
| `tests/api/query-validation.test.js`          |    46 | Every query surface: bounds, coercion, and that a filter actually filters ([G-19](./08-gap-analysis.md#g-19)) |
| `tests/api/route-layout.test.js`              |    41 | All nine moved paths: alias and successor return the same body, and only the alias is marked deprecated |
| `tests/auth/auth.test.js`                     |    48 | Login, token rejection, immediate revocation, password change, refresh rotation and reuse detection, and the `Origin` guard on the refresh route |
| `tests/inventory/batches.test.js`             |    29 | Opening stock, manufacture dates, strict updates, alert windows, manual adjustment |
| `tests/users/users.test.js`                   |    28 | User CRUD, validation, profile safety                                      |
| `tests/billing/reports.test.js`               |    36 | Daily, trend and GST reports, date boundaries, paid-only filtering — **plus the monthly and yearly reports** added 2026-08-30: day/month boundaries, reconciliation with an unpaid invoice in the period, the zero-fill, both CSV shapes and the role split |
| `tests/billing/invoice-void.test.js`          |    22 | Stock restoration, credit notes, partial returns, **twelve** concurrent returns, period rule |
| `tests/inventory/medicines.test.js`           |    19 | Stock totals, POS search, soft delete, validation                          |
| `tests/reports/csv.test.js`                   |    16 | Escaping, the formula-injection guard, the BOM and CRLF                    |
| `tests/inventory/masters.test.js`             |    15 | Masters CRUD, delete conflicts, suppliers                                  |
| `tests/auth/password-change-required.test.js` |    13 | The forced-password-change gate and its two deliberate exemptions          |
| `tests/billing/customers.test.js`             |    13 | Uniqueness, validation, search, history, pagination shape                  |
| `tests/users/password-reset.test.js`          |    13 | The generated temporary password, its single use, and the sessions it ends |
| `tests/billing/customer-erasure.test.js`      |    11 | Anonymisation in place, the audit-trail sweep, invoices left reconciling   |
| `tests/reports/csv-export.test.js`            |    11 | The four export endpoints: filenames, headers, money as stored             |
| `tests/audit/audit-log.test.js`               |     9 | Actor and before/after on every audited write, what is deliberately not audited, and — since the 2026-08-31 migration off `$use` — that an audit row rolls back with the transaction it describes |
| `tests/auth/rate-limit.test.js`               |     5 | Failed-login budget, per-client isolation, successful sign-ins not counted |
| `tests/billing/invoice-concurrency.test.js`   |     5 | Last-unit races, oversell bursts, gapless serials                          |
| `tests/api/shop.test.js`                      |     8 | `GET`/`PUT /api/shop`: the caller's own shop only, the ADMIN gate on `PUT`, and read access for every role because printing a bill is a cashier's job (FR-SHOP-07). **Added with multi-tenancy and missing from this table until 2026-08-31** |

A dash in the **Tests** column means the file postdates the last measured run.

**Frontend — 125 across 16 files.** Counted from a run on 2026-08-25; the 67
recorded here previously predated the screen-by-screen component coverage.

| File                                             | Tests | Covers                                                           |
| ------------------------------------------------ | ----: | ----------------------------------------------------------------- |
| `src/pages/__tests__/cart-math.test.ts`        |    41 | The §4 fixtures in integer paise, mirroring the server ([G-17](./08-gap-analysis.md#g-17)) |
| `src/pages/__tests__/Reports.void.test.tsx`    |    11 | The void and partial-return dialog: role gating, client-side bounds, the refetch ([FR-BILL-17](./01-product-requirements.md)) |
| `src/pages/__tests__/Billing.guards.test.tsx`  |     9 | POS stock guards, driven through the rendered page                |
| `src/lib/__tests__/api.test.ts`                |     8 | The 401 interceptor and the password-change redirect              |
| `src/store/__tests__/auth.store.test.ts`       |     7 | Sign-out reaches the server, and clears locally whatever it answers |
| `src/hooks/__tests__/useNotifications.test.ts` |     6 | Alert derivation and severity thresholds                          |
| `src/pages/__tests__/Inventory.batches.test.tsx` |   6 | Batch form fields and the `mfgDate` guard ([G-04](./08-gap-analysis.md#g-04)) |
| `src/components/__tests__/Sidebar.test.tsx`    |     5 | The role filter on navigation                                     |
| `src/lib/__tests__/download.test.ts`           |     4 | Blob download and the `Content-Disposition` filename              |
| `src/pages/__tests__/Customers.test.tsx`       |     4 | Customer list, search and the history restriction                 |
| `src/pages/__tests__/Settings.users.test.tsx`  |     4 | User management, admin-only                                       |
| `src/components/__tests__/ProtectedRoute.test.tsx` | 3 | Redirect when unauthenticated                                     |
| `src/pages/__tests__/Reports.export.test.tsx`  |     3 | The export button requests the right period                       |
| `src/hooks/__tests__/query-cancellation.test.tsx` |  2 | In-flight queries cancel on unmount                               |
| `src/pages/__tests__/Suppliers.test.tsx`       |     2 | Supplier list and form                                            |
| `src/pages/__tests__/Signup.test.tsx`         |     — | The signup page: what it sends, what it refuses, and that it creates a shop rather than joining one (FR-AUTH-12) |
| `src/lib/__tests__/amount-in-words.test.ts`   |     — | The rupees-and-paise words on the printed invoice, in lakhs and crores, computed in paise throughout (FR-BILL-20) |
| `src/lib/__tests__/print-document.test.ts`    |     — | `printAs()` sets `document.title` so a saved PDF is named after the invoice, and restores it on `afterprint` |

A dash in the **Tests** column means the file postdates the last measured run.

**Browser — 7 flows**, `e2e/smoke.spec.ts`. Chromium runs all seven; Firefox runs
only the CSV download, the one flow built on browser machinery rather than ours.

### Coverage

Measured 2026-08-22: **about 85% of statements** overall. The gate is deliberately not a whole-repo number — it sits on the two files where a regression is a financial or security incident:

| File                              | Statements | Branches | Gate |
| --------------------------------- | ---------: | -------: | ---- |
| `billing.controller.js`         |     97.05% |   80.00% | 90%  |
| `auth.middleware.js`            |     96.66% |   95.00% | 90%  |
| `dashboard.controller.js`       |     97.37% |   91.66% | 90%  |
| `utils/trend.js`                |    100.00% |   90.00% | 100% |

> **`dashboard.controller.js` was the lowest in the codebase at 21.73%**, and is now at 97.37% with a gate of its own. It serves `GET /api/dashboard/stats`, the single request that replaced thirteen, so every panel the dashboard renders depends on it — and almost none of it was exercised. Writing the tests found two defects: the expiry panel keyed its window to the current instant rather than local midnight (the third site of that bug, the other two having been fixed the same day), and the trend chart bucketed days in UTC while the zero-fill loop keyed them locally, so an early-morning sale was charted on the previous day. The second is the more instructive: the chart and the daily summary disagreed about which day a sale belonged to, and neither was obviously wrong on its own screen.

### Still open

- ~~Frontend unit tests — §5.6~~ **done 2026-08-20**: 67 cases across cart maths, the POS stock guards, `ProtectedRoute`, the sidebar role filter, the 401 interceptor and notification severity.
- ~~Wiring `npm test` into the frontend CI job~~ **done** — it runs before the build, and a broken cart rounding now turns CI red.
- ~~A Playwright browser smoke test — §5.7~~ **done 2026-08-20**, all six flows, in its own CI job.
- ~~Component coverage beyond the §5.6 screens, and a second browser besides Chromium~~ — **done 2026-08-24**: Settings, Inventory, Customers, Suppliers and Reports now have component tests (97 frontend cases across 13 files), and Firefox runs the CSV download flow as its own Playwright project.
- The browser suite could not pass on a freshly seeded database between the password-change work and 2026-08-24 — the seeded admin carries `mustChangePassword`, so every flow's `signIn` landed on `/change-password`. `apiLogin` now completes that change idempotently. A CI job that only ever runs against a fresh seed is exactly where this class of breakage hides; worth remembering before adding another bootstrap step.
- Two icon-only controls have no accessible name (the Customers pager) and `Field` in `Inventory.tsx` renders a `Label` not associated with its input, so those tests reach for placeholders and DOM position. Worth fixing for screen readers, not only for tests.
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

**CSRF on `POST /api/auth/refresh`** — the only route authenticated by a cookie, and therefore the only one with a surface. Added 2026-08-31 with the guard:

- A foreign `Origin` → `403`, **and the session survives it.** The second half is the one that matters: the guard deliberately does not clear the cookie the way `refresh`'s own denial path does, because being refused must not become a way for a stranger to sign someone out.
- An allowlisted `Origin` → `200`.
- The literal `null` origin — what a sandboxed iframe or a `data:` document sends → `403`.
- **No `Origin` header at all → allowed**, asserted so that tightening it later is a decision rather than an accident. No browser sends a cookie-bearing cross-site POST without one, so such a request had its cookie set by hand.

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

**Scope.** These assert what only the component layer can see: which request a screen makes, when it makes it, and which guards fire before it does. Business rules are proven below this layer and are not repeated here — see the note in [CONTRIBUTING](../CONTRIBUTING.md#the-frontend-suites).

*Billing / POS*

- Cart line total matches the server fixture set (§4) for the same inputs.
- Quantity cannot exceed the batch `stock` shown in search results.
- Adding a `batchId: null` (no-stock) search result is prevented.
- A plain click takes the FEFO batch; the override picker appears only when there is more than one batch, and the chosen batch carries its own price and its own stock ceiling (FR-BILL-19).

*Auth and shell*

- `ProtectedRoute` redirects an unauthenticated visitor to `/login`.
- The sidebar hides Settings for non-admins.
- A 401 response clears `localStorage` and redirects.
- `useNotifications` marks a batch expiring in 5 days as `danger` and one at 25 days as `warning`.

*Settings — user management*

- The delete button asks first, and answering no sends nothing.
- A confirmed delete calls `DELETE /api/users/:id` and then **re-reads** the list rather than splicing the row out locally.

*Inventory — Add Stock*

- `mfgDate` reaches the request body when filled, and is **absent** rather than `""` when blank ([G-04](./08-gap-analysis.md#g-04)).
- The mfg date input is capped at the expiry date.
- Submit stays disabled until every required field is set.
- Choosing a medicine clears the search dropdown immediately, not after the debounce.

*Customers*

- Paging asks for the page the user moved to; the search term reaches the request.
- A customer profile is not fetched until its dialog is opened.

*Suppliers*

- Saving posts the form and then re-reads the list.

*Reports — CSV export (FR-RPT-09)*

- The export button is disabled on an empty report — a header-only file is indistinguishable from a failed download.
- The button requests `…/export` as a blob for the period on screen. The file's *contents* are asserted server-side in `backend/tests/reports/`; the client is only ever asked to prove it did not compute them itself ([G-21](./08-gap-analysis.md#g-21)).

*Reports — invoice void and partial returns (FR-BILL-17)*

- The return form is absent for a `CASHIER` and present for an `ADMIN`. Authorisation itself is `authorize("ADMIN")` on the server, proven in `tests/auth/rbac.test.js`; what this asserts is that the UI agrees with it — and that a 403 is explained rather than reported as a generic failure, because hiding a control is not a guard.
- A quantity above `quantity − returnedQty`, and a reason under the server's 3-character minimum, are both refused **before** anything is sent. The bounds mirror `voidInvoice` exactly, so the form cannot accept what the request would reject.
- A committed return sends only the entered lines and then **refetches the day**. A credit note lands in the same period, so the payment-mode split and the period totals move too — patching the one row locally would leave the screen showing takings the database has already reversed.
- An empty form means "everything outstanding", so it states the consequence and takes a second click. A native `confirm()` — the pattern used for the user-delete in Settings — would stack a browser dialog on an open modal and could not name the units and the money at stake.
- A cancelled invoice, a credit note and a fully returned invoice each explain why nothing can be returned, in the server's own words, rather than offering a button that fails.

The credit note's *arithmetic*, and the cumulative `returnedQty` guard that makes two simultaneous returns of the same units safe, are proven in `tests/billing/invoice-void.test.js`. Asserting money here would make the suite slower without making it more truthful.

### 5.7 E2E (Playwright) — P3

1. Seed admin logs in → dashboard renders.
2. Create category → manufacturer → medicine → batch; the medicine appears in POS search with the right stock.
3. Sell 2 units → invoice created → the print view opens → batch stock dropped by 2.
4. Oversell attempt → visible error, stock unchanged.
5. Daily report reflects the new invoice.
6. A cashier account sees no Settings link and receives 403 when calling `/api/users` directly.
7. The GST export downloads a CSV through the proxy, named by the server's `Content-Disposition`, BOM intact.

Flow 7 is the only one added since the original six, and it is here because it is the only flow built on *browser* machinery rather than ours: a blob URL, a programmatic anchor click, and a filename that has to survive nginx. The unit test mocks axios and the API test reads the header off a Supertest response that never passed through the proxy — neither can see what this does. It asserts the header row and the BOM, and deliberately no money: those figures are pinned to the paisa in `backend/tests/reports/`.

**Browsers.** Chromium runs all seven. A second engine, **Firefox**, runs flow 7 and nothing else — configured as its own project in [`playwright.config.ts`](../frontend/playwright.config.ts). Running everything twice would roughly double a job whose cost is mostly browser downloads, for almost no signal: the other six exercise our React, our proxy and our API, none of which vary by engine in ways a smoke test catches. Firefox rather than WebKit because it installs and runs on a plain Linux box without extra system libraries, so the project is verifiable before pushing rather than only in CI; WebKit needs `libicu`, `libxml2` and `libflite` on the host.

> Measured cost: the Firefox binary is ~108 MB on top of Chromium's, and the extra flow adds about 16 seconds. The whole suite runs in about 1m20s.

---

## 6. CI

Four jobs in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), plus CodeQL in its own workflow.

| Job | What it does | Why it is separate |
| --- | --- | --- |
| **Backend tests** | `npm run test:coverage` against a real PostgreSQL service container, applying migrations first | Coverage rather than plain `npm test`: the config gates `billing.controller.js` and `auth.middleware.js` at 90% |
| **Frontend lint, test and build** | `npm run lint` → `npm test` → `npm run build` | Unit tests before the build because they take seconds, and the cart-maths cases guard [G-17](./08-gap-analysis.md#g-17). `tsc -b` runs inside the build and catches what lint does not |
| **Dependency audit** | `npm audit --omit=dev --audit-level=high` per workspace, plus a full advisory report that never fails | Reads the lockfile without installing, so it costs seconds. The threshold matches SECURITY.md's scope rule — see [07 §10 P2-14](./07-security.md#10-hardening-backlog) |
| **Browser smoke (Playwright)** | Brings the compose stack up, seeds, runs the seven flows | The Chromium download costs about a minute and it needs the whole stack, so keeping it apart leaves the other three as the fast signal |

> The workflow itself is the source of truth and is **not reproduced here**. An inline copy drifts — the version that used to sit in this section still claimed the backend job ran `npm test` long after it had moved to `npm run test:coverage`.


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
