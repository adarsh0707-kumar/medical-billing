# Product Requirements Document (PRD)

| Field             | Value                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| Product           | Medical Billing System (retail pharmacy POS + inventory)                                                   |
| Version described | 1.0.0 (released 2026-04-28)                                                                                |
| Document date     | 2026-08-17                                                                                                 |
| Status            | Living document — reflects shipped code, not intent                                                       |
| Owner             | Adarsh Kumar                                                                                               |
| Related           | [Architecture](./02-architecture.md) · [API](./04-api-reference.md) · [Roadmap](./05-roadmap-and-phases.md) |

---

## 1. Problem statement

An independent retail pharmacy runs on three simultaneous pressures:

1. **Speed at the counter.** A customer waits while the cashier finds a medicine, checks stock, applies price and tax, and prints a bill. Paper or spreadsheet workflows take minutes per sale and produce arithmetic errors on GST.
2. **Perishable, batch-tracked stock.** Medicines expire. Stock is tracked per *batch*, not per product — the same medicine can have three batches at three prices with three expiry dates. Selling an expired batch is a regulatory and safety failure; failing to sell the oldest batch first is a financial loss.
3. **Statutory reporting.** Indian GST filing requires per-invoice taxable value and CGST/SGST split, aggregated monthly. Reconstructing this from paper bills at filing time is error-prone and slow.

Off-the-shelf pharmacy software is either expensive per-seat SaaS or heavyweight desktop software tied to one machine. This product targets the gap: a self-hostable, browser-based system a single store can run on one machine or a small local network.

## 2. Vision

> A pharmacy counter where the cashier types three letters, presses Enter, and a correct, tax-compliant, stock-accurate invoice exists — and the owner can answer "what did we sell, what's expiring, what do we owe in GST" without touching a ledger.

## 3. Goals and non-goals

### Goals

| ID | Goal                                      | Measure                                                                                      |
| -- | ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| G1 | Cut counter time per sale                 | A 5-line invoice completed in under 60 seconds by a trained cashier                          |
| G2 | Never sell stock the system doesn't have  | Stock deduction is transactional; oversell attempts are rejected with a clear message        |
| G3 | Make expiry visible before it costs money | Batches within 30 days of expiry surface as alerts on dashboard and in the notification tray |
| G4 | Make GST filing a report, not a project   | Monthly CGST/SGST/taxable totals available on demand                                         |
| G5 | Deploy on one command                     | `docker compose up` brings the whole stack up                                              |
| G6 | Enforce who can do what                   | Three roles with server-enforced authorisation on every mutating route                       |

### Non-goals (explicitly out of scope for 1.x)

- Multi-store / multi-branch inventory transfer.
- Insurance claim adjudication, TPA integration, or medical coding (ICD/CPT). *Despite the product name, this is a pharmacy retail biller, not a clinical claims system.*
- Prescription image capture, e-prescription, or doctor management.
- E-invoicing / IRN generation with the GST Network portal.
- Accounting ledger, payroll, or purchase-order-to-payment workflows.
- Native mobile applications.
- Offline-first operation. The browser requires the API to be reachable.

## 4. Personas

| Persona                                     | Role in system | Primary jobs                                                                                              | Frequency                       |
| ------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **Store owner / Manager** — "Ramesh" | `ADMIN`      | Reads daily and monthly numbers, files GST, creates staff accounts, deletes bad master data, sets prices  | Daily (reports), weekly (admin) |
| **Pharmacist** — "Priya"             | `PHARMACIST` | Adds medicines and stock batches, manages suppliers, checks expiry, verifies Schedule H items, also bills | Many times daily                |
| **Cashier** — "Amit"                 | `CASHIER`    | Billing only — search, cart, payment mode, print. Registers walk-in customers                            | Continuously during shift       |

### Jobs-to-be-done

- *When a customer hands me a prescription, I want to find each medicine and its live stock in a couple of keystrokes, so the queue doesn't build.*
- *When I take a stock delivery, I want to record batch number, expiry, cost and selling price once, so every future sale is priced and tracked correctly.*
- *When the month closes, I want taxable value and CGST/SGST totals for every paid invoice, so filing is a download and not a reconstruction.*
- *When a batch is 20 days from expiry, I want to be told, so I can return it to the supplier or discount it.*

## 5. Scope

### In scope — 1.0.0 (shipped)

Authentication & RBAC · User management · Category & manufacturer masters · Medicine catalogue · Batch/stock management with expiry · Supplier management · Customer records · POS billing with GST · Invoice history & print · Daily sales report · Monthly GST report · Expiry & low-stock alerts · 7-day sales trend · Dashboard.

### In scope — added on `main` since 1.0.0

Multi-tenancy (§6.0) · Refresh-token rotation and server-side revocation · Audit log, with its retention enforced · Invoice void and partial returns · Schedule H prescription register · Customer erasure and retention · Manual stock adjustment · CSV export on every report · Monthly, yearly and margin reports · A GST tax-invoice print layout.

### In scope — planned, not built

Server-side PDF invoices (FR-BILL-18) · Top-selling medicines (FR-RPT-07) · Password reset by email (FR-AUTH-11) · Email/SMS alerts (FR-NOTIF-06).

> **Corrected 2026-08-31.** This section previously listed *"Purchase orders & goods receipt (schema exists, no API) · Server-side PDF invoices · Audit log"*. The purchases schema was **dropped** on 2026-08-24 (Q7) and the audit log **shipped** on 2026-08-22; only the PDF invoice was still accurate.

### Out of scope

See non-goals, §3.

---

## 6. Functional requirements

Status legend: `✅` implemented · `🟡` partial · `⬜` planned. "Roles" is the server-enforced authorisation, verified in `backend/src/routes/`.

### 6.0 Tenancy — `FR-SHOP`

Added 2026-08-29. The system holds any number of pharmacies side by side; each is a `Shop`, and a shop's data is visible only to its own accounts. This supersedes the "multi-store is a non-goal for 1.x" line that stood in the roadmap until that date.

| ID         | Requirement                                                                                      | Roles  | Status | Evidence                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------ | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FR-SHOP-01 | Every row of shop-specific data carries a `shopId`, and every query filters on it              | —     | ✅     | `Shop` in [schema.prisma](../backend/prisma/schema.prisma); `shopId` on User, Category, Manufacturer, Medicine, Batch, Customer, Supplier, Invoice, InvoiceCounter, AuditLog |
| FR-SHOP-02 | A caller's shop comes from their token, never from the request                                   | All    | ✅     | `shopId` is a JWT claim, read as `req.user.shopId`. No endpoint accepts one in a body or query string                                                                       |
| FR-SHOP-03 | A record belonging to another shop is indistinguishable from one that does not exist             | All    | ✅     | Reads and writes scope by `{ id, shopId }` in the same `where`, so a foreign id answers **404**, never 403 — a 403 would confirm the row exists                       |
| FR-SHOP-04 | Categories and manufacturers are per-shop, not shared                                            | —     | ✅     | `@@unique([shopId, name])` on both. Each shop types "Tablet" into its own list once; a shared lookup row would be a boundary break, not a convenience                       |
| FR-SHOP-05 | Invoice serials are per-shop, so two shops both start at`-0001`                                | —     | ✅     | `InvoiceCounter` is keyed `@@id([shopId, day])`; `Invoice` is `@@unique([shopId, invoiceNumber])`                                                                     |
| FR-SHOP-06 | An email identifies one account system-wide                                                      | —     | ✅     | `User.email` is globally unique **by design** — login takes an email and a password with no shop selector, so a shared address would be ambiguous at the one lookup that matters. Somebody running two shops holds two accounts |
| FR-SHOP-07 | An administrator maintains their shop's own business details, which the invoice header prints    | ADMIN  | ✅     | `GET /api/shop` (any signed-in role — printing a bill is a cashier's job), `PUT /api/shop` (ADMIN). Always the caller's own shop; there is no id in the request to target another |
| FR-SHOP-08 | Nothing in the schema relates one shop to another                                                | —     | ✅     | No cross-shop foreign key exists. Asserted end-to-end in `tests/auth/signup.test.js` across the resource controllers, the user list and the dashboard                     |
| FR-SHOP-09 | A shop records the drug licence it dispenses under, and the invoice prints it                    | ADMIN  | ✅ Since 2026-08-31 | `Shop.drugLicenceNo`, editable on the Shop tab in Settings and printed as **D.L. No.** in the invoice header. Nullable — a shop that has not entered it can still trade ([03 §3.0](./03-data-model.md#30-shop--the-tenant)) |

### 6.1 Authentication & session — `FR-AUTH`

| ID         | Requirement                                                                                               | Roles  | Status | Evidence                                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------- | ------ | ------ | ------------------------------------------------------------------------------ |
| FR-AUTH-01 | A user signs in with email + password and receives a bearer token                                         | Public | ✅     | [auth.controller.js](../backend/src/controllers/auth.controller.js) `login`   |
| FR-AUTH-02 | Passwords are stored as bcrypt hashes, cost factor 12                                                     | —     | ✅     | `bcrypt.hash(password, 12)`                                                  |
| FR-AUTH-03 | The session lasts a week, but the token the browser can read does not                                     | —     | ✅     | [jwt.utils.js](../backend/src/utils/jwt.utils.js). **Corrected 2026-08-31**: this row said "expires after 7 days" long after it stopped being true. Since 2026-08-22 the access token is **30 minutes** and lives in `localStorage`; the week is carried by a rotating `HttpOnly` `refresh_token` cookie that script cannot read. Both halves embed `tokenVersion` |
| FR-AUTH-04 | Every protected route revalidates the user against the DB on each request, rejecting deactivated accounts | All    | ✅     | [auth.middleware.js](../backend/src/middlewares/auth.middleware.js) `protect` |
| FR-AUTH-05 | A signed-in user can read their own identity                                                              | All    | ✅     | `GET /api/auth/me`                                                           |
| FR-AUTH-06 | A signed-in user can change their own password, proving the current one                                   | All    | ✅     | `PUT /api/auth/change-password`                                              |
| FR-AUTH-07 | An admin can register a new user through the auth route                                                   | ADMIN  | ✅     | `POST /api/auth/register`                                                    |
| FR-AUTH-08 | Client discards the token on 401 and returns the user to login                                            | —     | ✅     | [api.ts](../frontend/src/lib/api.ts) response interceptor                       |
| FR-AUTH-09 | Server-side logout / token revocation                                                                     | All    | ✅     | `POST /api/auth/logout` since 2026-08-22, **called by the SPA since 2026-08-25**. Increments `User.tokenVersion`, which every token carries a copy of, so **all** of that account's sessions end — not just the caller's. Between those dates the endpoint existed but the **Sign out** button was still only a client-side `localStorage` clear, leaving the refresh cookie renewable |
| FR-AUTH-10 | Refresh-token rotation                                                                                    | All    | ✅     | `POST /api/auth/refresh` consumes the `HttpOnly` cookie, retires its `RefreshToken` row and issues the next one in a single transaction. Presenting an already-rotated token is treated as theft rather than as a mistake: the counter is bumped and every row for that account revoked, ending all its sessions |
| FR-AUTH-11 | Password reset by email                                                                                   | Public | ⬜     | Documented in`backend/README.md`; not implemented                            |
| FR-AUTH-12 | Public signup creates a new shop and its first administrator | Public | ✅ | `POST /api/auth/signup`. Open permanently — every call creates its own `Shop` and one `ADMIN` who owns it. See [§6.0](#60-tenancy--fr-shop) |

### 6.2 User administration — `FR-USER`

| ID         | Requirement                                                                           | Roles | Status                       |
| ---------- | ------------------------------------------------------------------------------------- | ----- | ---------------------------- |
| FR-USER-01 | List all users with role and active flag                                              | ADMIN | ✅                           |
| FR-USER-02 | Create a user with a role (`ADMIN`/`PHARMACIST`/`CASHIER`, default `CASHIER`) | ADMIN | ✅                           |
| FR-USER-03 | Update a user's name, email, role, active flag                                        | ADMIN | ✅                           |
| FR-USER-04 | Delete a user; deleting your own account is refused                                   | ADMIN | ✅                           |
| FR-USER-05 | Deactivate rather than delete (soft disable) via`isActive`                          | ADMIN | ✅                           |
| FR-USER-06 | Any user updates their own name and email, with email uniqueness enforced             | All   | ✅                           |
| FR-USER-07 | Email addresses are unique across users                                               | —    | ✅ (DB unique + 409 handler) |

### 6.3 Master data — `FR-MASTER`

| ID           | Requirement                                              | Roles             | Status |
| ------------ | -------------------------------------------------------- | ----------------- | ------ |
| FR-MASTER-01 | List categories with a count of medicines in each        | All               | ✅     |
| FR-MASTER-02 | Create / rename a category (name ≥ 2 chars, unique)     | ADMIN, PHARMACIST | ✅     |
| FR-MASTER-03 | Delete a category                                        | ADMIN             | ✅     |
| FR-MASTER-04 | List manufacturers with medicine counts                  | All               | ✅     |
| FR-MASTER-05 | Create / rename a manufacturer (name ≥ 2 chars, unique) | ADMIN, PHARMACIST | ✅     |
| FR-MASTER-06 | Delete a manufacturer                                    | ADMIN             | ✅     |

> Deleting a category or manufacturer still referenced by a medicine returns **409** with *"This record is still in use by other data and cannot be deleted"* and the offending field. Prisma's `P2003` is mapped centrally in `error.middleware.js`; it surfaced as an opaque 500 until [G-12](./08-gap-analysis.md#g-12) was fixed on 2026-08-19.

### 6.4 Medicine catalogue — `FR-MED`

| ID        | Requirement                                                                                                                                     | Roles             | Status                                         |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------- |
| FR-MED-01 | List active medicines, paginated (default 20/page), with category, manufacturer, computed total stock, nearest expiry and current selling price | All               | ✅                                             |
| FR-MED-02 | Filter the list by category                                                                                                                     | All               | ✅                                             |
| FR-MED-03 | Search by brand name, generic name or HSN code (case-insensitive)                                                                               | All               | ✅                                             |
| FR-MED-04 | Fast POS search returning ≤ 10 results with the nearest-expiry in-stock batch attached                                                         | All               | ✅                                             |
| FR-MED-05 | View one medicine with its full batch list, each with supplier                                                                                  | All               | ✅                                             |
| FR-MED-06 | Create a medicine: name, generic name, category, manufacturer, HSN, unit, GST %, Schedule H flag                                                | ADMIN, PHARMACIST | ✅                                             |
| FR-MED-07 | Unit is constrained to tablet, capsule, syrup, injection, cream, drops, powder, inhaler, other                                                  | —                | ✅                                             |
| FR-MED-08 | GST % is constrained to 0, 5, 12 or 18                                                                                                          | —                | ✅                                             |
| FR-MED-09 | Update a medicine                                                                                                                               | ADMIN, PHARMACIST | ✅                                             |
| FR-MED-10 | Delete a medicine — soft delete via`isActive = false`, preserving invoice history                                                            | ADMIN             | ✅                                             |
| FR-MED-11 | Flag prescription-only (Schedule H) medicines, visible at the POS                                                                               | ADMIN, PHARMACIST | ✅                                             |
| FR-MED-12 | Capture a prescription for Schedule H medicines                                                      | All    | ✅ Since 2026-08-24. Any invoice containing a Schedule H line requires a register entry — prescriber, their council registration number, the prescription's date and the patient's name — written in the same transaction as the sale. Schedule H is decided from the **batch's** medicine, never the client-supplied `medicineId`, which is validated but not persisted. See [03 §3.x](./03-data-model.md) and [PRD Q4](#14-open-questions) |
| FR-MED-13 | Record how the product is packed, and print it on the invoice | ADMIN, PHARMACIST | ✅ Since 2026-08-31. `Medicine.packSize` — the **PACK** label copied off the carton (`1*10`, `1*15ML`), free text because every distributor writes it differently. Deliberately **distinct from `unit`**, which is the dispensing unit: a strip of ten tablets is unit `tablet`, packSize `1*10`. Optional ([03 §3.4](./03-data-model.md)) |

### 6.5 Stock & batches — `FR-BATCH`

| ID          | Requirement                                                                                          | Roles             | Status                                                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FR-BATCH-01 | Add a stock batch: medicine, supplier, batch number, expiry, purchase price, selling price, quantity | ADMIN, PHARMACIST | ✅                                                                                                                                                                 |
| FR-BATCH-02 | Batch number is unique per medicine                                                                  | —                | ✅ (`@@unique([medicineId, batchNumber])`)                                                                                                                       |
| FR-BATCH-03 | Opening quantity is captured separately as`initialQty` so depletion is measurable                  | —                | ✅                                                                                                                                                                 |
| FR-BATCH-04 | List batches, filterable by medicine, expiring-soon, or low-stock                                    | All               | ✅                                                                                                                                                                 |
| FR-BATCH-05 | List batches expiring within N days (default 30) that still hold stock                               | All               | ✅                                                                                                                                                                 |
| FR-BATCH-06 | List batches at or below a stock threshold (default 10)                                              | All               | ✅                                                                                                                                                                 |
| FR-BATCH-07 | Update a batch (price and date corrections)                                                          | ADMIN, PHARMACIST | ✅ Validated by a narrow strict schema.**Quantity is deliberately not editable here** — manual adjustment is FR-BATCH-11 ([G-05](./08-gap-analysis.md#g-05)) |
| FR-BATCH-08 | Record manufacture date alongside expiry                                                             | ADMIN, PHARMACIST | ✅ Optional field on the batch form, validated to fall before the expiry date ([G-04](./08-gap-analysis.md#g-04))                                                   |
| FR-BATCH-09 | Prevent sale from an expired batch                                                                   | All              | ✅ Since 2026-08-24. A medicine is sellable **through** the date printed on it, so a batch expiring today still sells and one that expired yesterday is refused with a `400` naming the batch and the date. Enforced inside the invoice transaction, alongside the stock decrement, so a batch expiring between the cart and the commit is still caught. **No role can override it** — clearing expired stock is a write-off ([FR-BATCH-11](#65-stock--batches--fr-batch)), not a sale |
| FR-BATCH-10 | Stock is decremented automatically when an invoice is created                                        | —                | ✅                                                                                                                                                                 |
| FR-BATCH-11 | Manual stock adjustment with a reason/audit trail | ADMIN, PHARMACIST | ✅ Since 2026-08-24. `POST /api/inventory/batches/:id/adjust` takes a signed `delta` and a **mandatory** reason, and every adjustment lands in the audit log with actor, before, after and why. A **delta, not an absolute quantity** — an absolute write would erase a sale that committed between the operator reading the screen and saving. Refuses cleanly rather than hitting the database CHECK if it would take stock below zero. `PUT /batches/:id` still rejects `quantity` ([G-05](./08-gap-analysis.md#g-05)) |
| FR-BATCH-12 | Record the printed MRP against the batch, and show it on the invoice | ADMIN, PHARMACIST | ✅ Since 2026-08-31. `Batch.mrp`, optional. **Per batch, not per medicine** — the same product is repriced between print runs. It is a display value only: the sale is priced from `sellingPrice`, and an unrecorded MRP prints as blank rather than being defaulted from it, because printing the two as equal asserts on a tax document that no discount was given ([03 §3.5](./03-data-model.md#35-batch--the-stock-unit)) |

### 6.6 Suppliers — `FR-SUP`

| ID        | Requirement                                                                | Roles             | Status                                                           |
| --------- | -------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------- |
| FR-SUP-01 | List suppliers, searchable by name or phone                                | All               | ✅                                                               |
| FR-SUP-02 | View a supplier with the stock received from them                          | All               | ✅ The detail response carries `_count.batches`. It used to return a purchase list that was always empty; the purchases tables were **dropped** on 2026-08-24 (Q7) rather than built out, and the empty array went with them |
| FR-SUP-03 | Create a supplier: name, contact person, phone, email, GST number, address | ADMIN, PHARMACIST | ✅                                                               |
| FR-SUP-04 | Update a supplier                                                          | ADMIN, PHARMACIST | ✅                                                               |
| FR-SUP-05 | Delete a supplier                                                          | ADMIN             | ✅                                                               |

### 6.7 Customers — `FR-CUST`

| ID         | Requirement                                                                        | Roles | Status                                        |
| ---------- | ---------------------------------------------------------------------------------- | ----- | --------------------------------------------- |
| FR-CUST-01 | List customers, paginated, searchable by name / phone / email, with invoice counts | All   | ✅                                            |
| FR-CUST-02 | View a customer with their 10 most recent invoices                                 | All   | ✅                                            |
| FR-CUST-03 | Create a customer: name (≥ 2 chars), phone, email, address, age (0–150), gender  | All   | ✅                                            |
| FR-CUST-04 | Phone number is unique across customers                                            | —    | ✅                                            |
| FR-CUST-05 | Register a new customer inline from the billing screen without leaving the cart    | All   | ✅                                            |
| FR-CUST-06 | Update a customer                                                                  | All   | ✅                                            |
| FR-CUST-07 | Bill a walk-in customer with no customer record                                    | All   | ✅ (`customerId` is optional on an invoice) |
| FR-CUST-08 | Erase a customer's personal details on request                                     | ADMIN | ✅`DELETE /api/customers/:id`. Anonymises in place rather than deleting: invoices reference the row and must still reconcile as books of account, so the name, phone, email, address and demographics are cleared and `anonymisedAt` is stamped. `npm run purge:customers -- --apply` does the same in bulk after 36 months of inactivity |

### 6.8 Billing / POS — `FR-BILL`

| ID         | Requirement                                                                                               | Roles | Status                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-BILL-01 | Type-ahead medicine search (min 2 characters, 300 ms debounce)                                            | All   | ✅                                                                                                                                          |
| FR-BILL-02 | Search result carries the nearest-expiry in-stock batch, its price, batch number and available quantity   | All   | ✅                                                                                                                                          |
| FR-BILL-03 | Build a multi-line cart with per-line quantity                                                            | All   | ✅                                                                                                                                          |
| FR-BILL-04 | Per-line discount as a percentage (0–100)                                                                | All   | ✅                                                                                                                                          |
| FR-BILL-05 | Bill-level flat discount amount                                                                           | All   | ✅                                                                                                                                          |
| FR-BILL-06 | GST computed per line from the medicine's rate, split 50/50 into CGST and SGST                            | All   | ✅                                                                                                                                          |
| FR-BILL-07 | Payment mode: CASH, UPI, CARD or CREDIT                                                                   | All   | ✅                                                                                                                                          |
| FR-BILL-08 | Payment status: PAID, PENDING or PARTIAL                                                                  | All   | ✅                                                                                                                                          |
| FR-BILL-09 | Reject the sale if any line exceeds available batch stock, naming the medicine and the quantity available | All   | ✅                                                                                                                                          |
| FR-BILL-10 | Invoice creation and stock deduction are atomic                                                           | —    | ✅`prisma.$transaction`                                                                                                                   |
| FR-BILL-11 | Human-readable sequential invoice number,`INVyymmdd-nnnn`                                               | —    | ✅ Allocated from an atomic per-day counter inside the invoice transaction — gapless and collision-free ([G-01](./08-gap-analysis.md#g-01)) |
| FR-BILL-12 | Line items snapshot the medicine name so later renames don't rewrite history                              | —    | ✅                                                                                                                                          |
| FR-BILL-13 | Invoice records the operator who raised it                                                                | —    | ✅                                                                                                                                          |
| FR-BILL-14 | Print the invoice from the browser                                                                        | All   | ✅`window.print()`                                                                                                                        |
| FR-BILL-15 | Invoice history, paginated, filterable by search text, date range, payment mode and payment status        | All   | ✅                                                                                                                                          |
| FR-BILL-16 | Open a single invoice for reprint, including batch number and expiry per line                             | All   | ✅                                                                                                                                          |
| FR-BILL-17 | Edit or void an invoice with stock restoration                                                            | ADMIN | ✅ Void implemented 2026-08-20, extended to partial returns 2026-08-24. A void issues a credit note and returns stock to the original batches; a partial return credits and restores named quantities and leaves the invoice live for what the customer kept, cancelling it only once nothing is outstanding. **Reachable from the UI since 2026-08-25** — an invoice on the Daily Summary opens a detail dialog carrying the void/return form; before that the endpoint existed but no screen called it, so a correction meant `curl` and an admin token. There is deliberately no *edit* — a filed period must still reconcile to what was filed ([G-15](./08-gap-analysis.md#g-15)) |
| FR-BILL-18 | Server-generated PDF invoice                                                                              | All   | ⬜ Printing is browser-rendered only                                                                                                        |
| FR-BILL-19 | Choose a specific batch when a medicine has several                                                       | All   | ✅ Implemented 2026-08-24. FEFO still decides by default and a plain click still takes it; the search now returns every sellable batch and the POS offers an explicit picker when there is more than one. Expired batches are no longer offered at all — as the earliest-expiring, one used to become the default and block the sale ([G-20](./08-gap-analysis.md#g-20)) |
| FR-BILL-20 | The printed document is a GST tax invoice, not a receipt                                                  | All   | ✅ Since 2026-08-31. Seller and buyer side by side, a **GST INVOICE** band carrying the number and date, then a line table of SN, product, PACK, HSN, batch, expiry, MRP, qty, rate, discount, GST %, net rate and amount, with the tax summary, totals, terms, the total **in words** and an authorised-signatory block. `amountInWords` is its own module and works in paise throughout — rounding to rupees first drops a paisa often enough to contradict the figure printed beside it. **Saving as PDF names the file after the invoice**, because browsers take the filename from `document.title`; `printAs()` restores the title on `afterprint` rather than on a timer, which would race the preview |

> **FR-BILL-20 shipped a live defect fix.** The till printed from the create response, which returned plain `InvoiceItem` rows with no batch relation, while the view read `item.batchNumber` and `item.unit` — supplied only by the detail endpoint. So every receipt handed over the counter read *Batch: undefined*, while a reprint of the same sale from history was correct. Both paths now share `PRINTABLE_ITEM_INCLUDE`, so they cannot drift again.
>
> **Roundoff and the distributor's 5+1 free-goods notation are deliberately absent** from the layout. Roundoff changes what the customer is charged and would break `subtotal + cgst + sgst − discountAmt = totalAmount` (BR-02); free goods have no column to compute from.

### 6.9 Reports & analytics — `FR-RPT`

| ID        | Requirement                                                                                                           | Roles             | Status                                                                                |
| --------- | --------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------- |
| FR-RPT-01 | Daily summary for any date: invoice count, total sales, CGST, SGST, total GST, and a breakdown by payment mode        | All               | ✅                                                                                    |
| FR-RPT-02 | Monthly GST report for paid invoices: per-invoice detail plus taxable / CGST / SGST / total                           | ADMIN, PHARMACIST | ✅                                                                                    |
| FR-RPT-03 | Expiry alert report over a configurable horizon                                                                       | All               | ✅                                                                                    |
| FR-RPT-04 | Low-stock report over a configurable threshold                                                                        | All               | ✅                                                                                    |
| FR-RPT-05 | 7-day sales trend chart                                                                                               | All               | ✅ Server-side since 2026-08-20: one `GET /api/reports/trend` backed by a single grouped query, shared with the dashboard through `utils/trend.js`. It **used** to be seven daily-summary calls, which is what [G-08](./08-gap-analysis.md#g-08) fixed — 7 requests / 259 KB / 102 ms → 1 / under 1 KB / 8 ms |
| FR-RPT-06 | Dashboard: today's sales, invoice count, GST, stock and customer counts, recent invoices, expiry and low-stock panels | All               | ✅                                                                                    |
| FR-RPT-10 | Monthly report: the month's takings, invoices, credit notes and GST, broken down by day | All | ✅ `GET /api/reports/monthly?month=&year=`, plus `/export`. Zero-filled across the month, so a quiet day is a flat bar rather than a missing one — a gap shifts every later point left and reads as a trend. The invoice register is paged from `GET /api/billing/invoices` rather than bundled into the response |
| FR-RPT-11 | Yearly report: the same figures for a year, broken down by month | All | ✅ `GET /api/reports/yearly?year=`, plus `/export`. Shares `summaryForPeriod` with the daily and monthly reports, so the three cannot disagree about what a period took |
| FR-RPT-07 | Top-selling medicines                                                                                                 | All               | ⬜ Claimed in`backend/README.md`; no such endpoint                                  |
| FR-RPT-08 | Profit/margin report (selling vs purchase price)                                                                      | ADMIN             | ✅ Since 2026-08-31. `GET /api/reports/margin?month=&year=`, plus `/export`. A month's revenue against what the stock cost, broken down by day and zero-filled. **Revenue is `subtotal − discountAmt`** — what the shop keeps before tax, not `totalAmount`, which carries GST the shop only collects and would overstate profit by it. **Cost is the batch's `purchasePrice` at the quantity sold**, negated for a credit note, so returned stock takes its cost off the period that took it back. Both come from stored columns; nothing is re-derived ([G-21](./08-gap-analysis.md#g-21)). **ADMIN only** — the deliberate contrast with FR-RPT-10/11, which every role may read: a shop's takings are its own trading record, what its stock cost is not. A batch with a zero recorded cost is counted in `unpricedLines` rather than passing as free stock, because the two are indistinguishable in the arithmetic and one of them reads as a flawless month |
| FR-RPT-09 | Export any report to CSV/Excel                                                                                        | All               | ✅ Implemented 2026-08-24. Six server-side CSV endpoints, one per report ([§9b](./04-api-reference.md)). Generated on the server so the figures are the stored ones: the browser version it replaced derived its tax columns arithmetically and got them wrong ([G-21](./08-gap-analysis.md#g-21)) |

### 6.10 Alerts & notifications — `FR-NOTIF`

| ID          | Requirement                                                                    | Roles | Status                                                            |
| ----------- | ------------------------------------------------------------------------------ | ----- | ----------------------------------------------------------------- |
| FR-NOTIF-01 | Notification tray aggregating expiring batches (30 days) and low stock (≤ 10) | All   | ✅[useNotifications.ts](../frontend/src/hooks/useNotifications.ts) |
| FR-NOTIF-02 | Escalate severity to "danger" when expiry is within 7 days                     | All   | ✅                                                                |
| FR-NOTIF-03 | Poll for fresh alerts every 5 minutes                                          | All   | ✅                                                                |
| FR-NOTIF-04 | Mark one / all notifications read                                              | All   | ✅ (in-memory only — resets on reload)                           |
| FR-NOTIF-05 | Toast feedback on every create/update/delete                                   | All   | ✅ Sonner                                                         |
| FR-NOTIF-06 | Email or SMS alerts                                                            | —    | ⬜                                                                |

### 6.11 Purchases — `FR-PUR`

| ID        | Requirement                                           | Roles             | Status                                                                                                                |
| --------- | ----------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| ~~FR-PUR-01~~ | ~~Record a purchase from a supplier with line items~~ | — | **Removed 2026-08-24.** The tables and `generatePurchaseNumber()` were dropped rather than built out; see Q7 |
| ~~FR-PUR-02~~ | ~~Goods receipt creates the stock batches automatically~~ | — | Not built. Stock enters through `POST /api/inventory/batches`, which records supplier and cost per batch |
| ~~FR-PUR-03~~ | ~~Supplier payable / outstanding tracking~~ | — | Not built, and no longer modelled |

---

## 7. Non-functional requirements

| ID     | Category        | Requirement                                                      | Status                                                                                                                                                                        | Notes |
| ------ | --------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| NFR-01 | Performance     | POS search returns in < 300 ms on a catalogue of 5,000 medicines | 🟡 Unmeasured. Search is`LIMIT 10` with `contains` — no trigram index, so it degrades linearly                                                                           |       |
| NFR-02 | Performance     | List endpoints are paginated                                     | ✅ Paginated where volume warrants it. `batches` was the outlier — 25,000 rows and 8 MB per page load before 2026-08-20, now 20 rows and 7 KB. Categories, manufacturers and suppliers stay unpaginated deliberately: they populate form dropdowns, and truncating them would silently remove options |       |
| NFR-03 | Performance     | Response compression                                             | ✅`compression()` middleware                                                                                                                                                |       |
| NFR-04 | Performance     | Hot reads served from cache                                      | ⬜**No cache layer exists.** Redis was provisioned before it had a consumer and removed in Phase 8 without ever acquiring one ([G-03](./08-gap-analysis.md#g-03)). Revisit only with measured evidence — the obvious candidate, the per-request user reload, trades against instant deactivation |       |
| ~~NFR-05~~ | Availability | ~~The API stays up if Redis is down~~                        | **Retired** — vacuously true once there is no Redis. Kept as a row because other documents cite NFR numbers                                                             |       |
| NFR-06 | Availability    | The API refuses to start without a database                      | ✅`process.exit(1)` on connect failure                                                                                                                                      |       |
| NFR-07 | Availability    | Postgres readiness gates backend start                           | ✅ Compose healthcheck                                                                                                                                                        |       |
| NFR-08 | Security        | All mutating routes require a valid JWT                          | ✅ Except`POST /api/auth/login`, `POST /api/auth/signup` and `POST /api/auth/refresh`. The first two are public by design; the third is authenticated by the `HttpOnly` refresh cookie instead, which is why it — alone in the API — carries a CSRF guard (`middlewares/csrf.middleware.js`, since 2026-08-31) |       |
| NFR-09 | Security        | Role checks are server-side, never client-only                   | ✅`authorize(...)`                                                                                                                                                          |       |
| NFR-10 | Security        | Standard security headers                                        | ✅`helmet()`                                                                                                                                                                |       |
| NFR-11 | Security        | CORS restricted to an allowlist                                  | ✅ Allowlist covers every entry point — and the SPA is now same-origin, so CORS applies only to direct callers ([G-02](./08-gap-analysis.md#g-02))                            |       |
| NFR-12 | Security        | Rate limiting on the API                                         | ✅ 500 req / 15 min per client (`trust proxy` set to private-range peers), plus 10 failed logins / 15 min on `/api/auth/login` ([G-06](./08-gap-analysis.md#g-06))         |       |
| NFR-13 | Security        | Input validation on request bodies**and query strings**    | ✅ Zod on every mutating route body, and`validateQuery` on every query string since 2026-08-20. Only `POST /api/auth/login` is presence-checked only, which is deliberate |       |
| NFR-14 | Security        | SQL injection resistance                                         | ✅ Prisma parameterises everything, and every raw statement is a bound `$queryRaw` tagged template. `$queryRawUnsafe` appears nowhere. *(This row said "one raw statement" until 2026-08-31, when the count had already grown with the trend, period and margin reports. [SECURITY.md](../SECURITY.md#security-relevant-design) holds the authoritative list and the count — do not start a second one here, which is what let the old number rot.)* |       |
| NFR-15 | Security        | Secrets supplied by environment, never committed                 | ✅`.env` is gitignored                                                                                                                                                      |       |
| NFR-16 | Security        | Transport encryption in production                               | ✅ Since 2026-08-20. `nginx/nginx.prod.conf` terminates TLS 1.2/1.3, redirects `:80` to `:443` and sets HSTS at one year with `includeSubDomains`; `preload` is deliberately omitted as close to irreversible and the operator's call. The **development** stack is plain HTTP by design |       |
| NFR-17 | Auditability    | Who-did-what trail for stock and price changes                   | ✅ `AuditLog` since 2026-08-22 — actor, model, record and before/after on every write to master data, recorded at the data layer so a new write path cannot forget. **Moved from a Prisma middleware to a client extension on 2026-08-31**, so the audit row now joins the caller's transaction: a rolled-back write no longer leaves a row claiming it happened, and an audited write inside a transaction no longer costs a second pooled connection (Phase 13). Reads are deliberately not logged ([03 §3.12](./03-data-model.md#312-auditlog--who-changed-what)). **Retention is decided at 24 months and enforced since 2026-08-31** by `npm run purge:audit` — dry by default, `-- --apply` to commit, and scheduled by the operator rather than by a worker this stack deliberately does not have |       |
| NFR-18 | Data integrity  | Financial writes are atomic                                      | ✅ Invoice + stock in one transaction                                                                                                                                         |       |
| NFR-19 | Data integrity  | Monetary values avoid float rounding error                       | ✅`DECIMAL(12,2)` columns with `Prisma.Decimal` arithmetic; invoices reconcile exactly ([G-07](./08-gap-analysis.md#g-07))                                                 |       |
| NFR-20 | Usability       | Responsive from 1024 px counter displays to tablets              | ✅ Tailwind responsive layout                                                                                                                                                 |       |
| NFR-21 | Usability       | Every failed action explains itself in plain language            | ✅ Toasts + structured API messages                                                                                                                                           |       |
| NFR-22 | Maintainability | Type safety on the client                                        | ✅ Implemented 2026-08-24. **Request** types are generated from the backend's Zod schemas into `frontend/src/types/api.generated.ts` (26 contracts) and `npm run types:check` fails CI if they drift. **Response** shapes are still declared per page — the schemas describe what goes in, not what comes back |       |
| NFR-23 | Maintainability | Automated test coverage                                          | ✅ **662 backend tests** across 26 files (Vitest + Supertest) and **144 frontend unit tests** across 18 files (Vitest + Testing Library), plus a 7-flow Playwright smoke — all three on CI, all measured 2026-08-31. 91.8% of backend statements, with 90% gates on the invoice, auth and dashboard paths and 100% on the shared trend query. [09](./09-testing-strategy.md) is where these numbers live; take them from a run rather than from adding up its tables |       |
| NFR-24 | Portability     | One-command local bring-up                                       | ✅`docker compose up`                                                                                                                                                       |       |
| NFR-25 | Observability   | Request logging                                                  | ✅**pino** since Phase 8.8 — one JSON object per line in production, pretty in development, silent under test. Every request carries a correlation id echoed as `X-Request-Id`, and tokens and password fields are redacted. No external error aggregation (no Sentry or equivalent), which is a deployment choice rather than a gap in the code |       |
| NFR-26 | Backup          | Documented restore procedure                                     | ✅ Since 2026-08-20 — `scripts/backup.sh` and `scripts/restore.sh`, and the restore has been **rehearsed** against the production stack: schema dropped entirely, restored from a dump, every row count matched and the application authenticated again ([Phase 8.10](./05-roadmap-and-phases.md#phase-8--production-readiness)). *(This row still read "pgdata volume only" until 2026-08-31.)* Scheduling the backup remains the operator's — nothing runs it |       |

---

## 8. Key business rules

These are the rules the code actually enforces. Changing any of them changes financial output.

**BR-01 — Line total.**

```
lineSubtotal = unitPrice × quantity
lineDiscount = lineSubtotal × (discountPercent / 100)
taxable      = lineSubtotal − lineDiscount
gst          = taxable × (gstPercent / 100)
cgst = sgst  = gst / 2
lineTotal    = taxable + gst          (rounded to 2 dp)
```

**BR-02 — Invoice total.** `totalAmount = Σ taxable + Σ cgst + Σ sgst − billDiscountAmt`. The bill-level discount is applied **after** tax, so it reduces the amount collected without reducing declared tax. This is a deliberate simplification; a discount that should also reduce GST liability must be entered per line instead.

**BR-03 — GST split.** Always 50/50 CGST/SGST — i.e. intra-state supply is assumed. Inter-state (IGST) is not modelled.

**BR-04 — Rate source.** GST% comes from the `Medicine`, and is snapshotted onto the invoice line at sale time. Later rate changes never rewrite historical invoices.

**BR-05 — Price source.** Unit price defaults to the `sellingPrice` of the selected batch, so the same medicine legitimately sells at different prices across batches.

**BR-06 — Batch selection (FEFO).** The POS attaches the in-stock batch with the earliest expiry date. First-Expiry-First-Out is the intended behaviour and is what `orderBy: { expiryDate: 'asc' }, take: 1` produces.

**BR-07 — Stock guard.** Every line is checked against its batch quantity before anything is written. Any failure aborts the whole invoice.

**BR-08 — Atomicity.** Invoice header, line items and every batch decrement commit together or not at all.

**BR-09 — Invoice numbering.** `INV{yy}{mm}{dd}-{0001}`. The serial comes from an atomic per-day counter allocated inside the invoice transaction, **not** from counting the day's invoices — counting is a read-then-write race that retrying cannot fix ([G-01](./08-gap-analysis.md#g-01)). Consistent with FR-BILL-11.

**BR-10 — Purchase numbering.** `PO{yy}{mm}-{0001}`, monthly. Defined but unreachable.

**BR-11 — Soft delete for medicines.** Deleting a medicine sets `isActive = false`, so past invoice lines and batches remain intact. Suppliers, categories and manufacturers hard-delete.

**BR-12 — Name snapshot.** `InvoiceItem.medicineName` is a copy, not a join.

**BR-13 — Anonymous sale.** `customerId` may be null.

**BR-14 — GST report scope.** Only invoices with `paymentStatus = PAID` are included in the monthly GST report.

A **cancelled invoice stays in the month it was issued in**, and the credit note that reverses it appears in the month the void happened — the way a GST credit note (CDNR) works. The two net to zero across periods and neither period is edited after the fact. Removing a cancelled invoice from its own month would rewrite a period that may already have been filed, which is the failure this rule exists to prevent (PRD Q3, decided 2026-08-20).

**BR-15 — Self-deletion.** An admin cannot delete their own account.

**BR-16 — Deactivated user.** `isActive = false` invalidates access on the very next request even if the JWT is still cryptographically valid.

---

## 9. Primary user journeys

### J1 — Sell to a walk-in customer

1. Cashier signs in → lands on Dashboard → opens **Billing**.
2. Types ≥ 2 characters of a medicine name; results appear after a 300 ms debounce with price, batch, expiry, stock.
3. Selects the item → it enters the cart at batch selling price, quantity 1.
4. Adjusts quantity and per-line discount; totals recompute live.
5. Optionally attaches a customer, or registers one inline via **UserPlus**.
6. Chooses payment mode and status → **Create Invoice**.
7. Server validates stock, computes tax, writes invoice + decrements stock in a transaction, returns the saved invoice.
8. The print view opens automatically after 500 ms.

**Failure path:** insufficient stock → `400` naming the medicine and available quantity; nothing is written.

### J2 — Receive a stock delivery

1. Pharmacist opens **Inventory → Batches → Add Batch**.
2. Searches and picks the medicine (creating it first under **Medicines** if new).
3. Picks the supplier, enters batch number, expiry, purchase price, selling price and quantity.
4. Saves. The batch becomes immediately sellable and its expiry enters the alert horizon.

### J3 — File monthly GST

1. Admin opens **Reports → GST**, selects month and year.
2. Reads per-invoice taxable/CGST/SGST rows and the period totals.
3. Exports the month to CSV and works from that, rather than transcribing totals off the screen ([FR-RPT-09](#69-reports--analytics--fr-rpt)).

### J4 — Act on expiry

1. Topbar notification badge shows a count; the tray lists expiring batches with days remaining, red inside 7 days.
2. Pharmacist opens **Reports → Stock Alerts**, adjusts the horizon, and returns or discounts the affected batches.

### J5 — Onboard a new cashier

1. Admin opens **Settings → Users → Add User**, enters name, email, password, role `CASHIER`.
2. The cashier signs in, sees only Dashboard, Billing, Inventory, Customers, Suppliers and Reports — **Settings is hidden**, and admin-only APIs return `403` regardless.

---

## 10. Success metrics

| Metric                  | Definition                                              | Target                                             |
| ----------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| Time-to-invoice         | Cart open → invoice created, 5 lines                   | < 60 s                                             |
| Search latency          | POS keystroke → results painted                        | < 300 ms p95                                       |
| Oversell incidents      | Invoices whose stock deduction drove a batch below zero | 0                                                  |
| Expiry write-off rate   | Value expiring unsold ÷ value purchased                | Falling month over month                           |
| GST prep time           | Hours to produce monthly filing figures                 | < 15 min                                           |
| Invoice correction rate | Invoices needing correction after issue                  | Tracked. Correctable in-app since 2026-08-25 — an ADMIN opens the invoice from the Daily Summary and voids it or returns named quantities, and the system issues a credit note (FR-BILL-17). The API could do this from 2026-08-20; until the dialog shipped there was no screen for it |

## 11. Assumptions

- **Each shop** is a single physical store with a single GSTIN, supplying intra-state only. One installation holds any number of such shops (§6.0) — what is assumed here is the shape of each, not that there is one. *(This line read "single physical store, single GSTIN" until 2026-08-31, three days after multi-tenancy shipped.)*
- Operators are trained staff on a trusted LAN, not the public internet.
- Concurrent billing counters are few (1–3). The invoice-numbering scheme assumes this and breaks beyond it.
- Prices are entered inclusive of nothing — GST is added on top of the entered selling price.
- The browser is modern and evergreen (React 19 + Vite 8 target).

## 12. Constraints

- **Regulatory:** Indian GST invoicing requires taxable value and tax split per invoice; Schedule H medicines require prescription records under the Drugs and Cosmetics Rules. Since 2026-08-24 the system **records the register entry and refuses the sale without one** (FR-MED-12) — prescriber, council registration number, prescription date and patient name, written in the same transaction as the sale. No prescription *image* is stored: Rule 65(11) permits a register in lieu of retaining the paper, and a scan would be a second copy of patient-identifying data with its own retention obligations. Whether the register satisfies your local obligations is still yours to assess. *(This line said the system stores "no prescription record" until 2026-08-31, contradicting FR-MED-12 in the same document.)*
- **Data sensitivity:** customer name, phone, age, gender and purchase history constitute health-adjacent personal data. See [07 — Security](./07-security.md#8-privacy-considerations).
- **Technical:** Prisma 5 + PostgreSQL 15; Express 5; React 19. Money is stored as `DECIMAL(12,2)` and computed with `Prisma.Decimal`, rounded half-up to 2 dp per line; the API serialises it as JSON numbers.

## 13. Dependencies

| Dependency       | Purpose                          | Failure impact                                |
| ---------------- | -------------------------------- | --------------------------------------------- |
| PostgreSQL 15    | System of record                 | Total outage — API exits on start-up failure |
| Nginx            | Single entry point on :80        | Direct ports 5173/5000 still work             |
| Docker / Compose | Local and single-host deployment | Manual`npm` runs remain possible            |

## 14. Open questions

| #  | Question                                                                                               | Blocks                                                       |
| -- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Q1 | Should the bill-level discount reduce taxable value (and thus GST) rather than being applied post-tax? | BR-02 correctness for filing                                 |
| Q2 | Is IGST / inter-state supply ever needed?                                                              | BR-03, data model                                            |
| ~~Q3~~ | ~~Must an invoice be voidable, and if so does stock return to the original batch?~~ **Answered 2026-08-20:** yes; stock returns to the original batches, keeping their expiry dates; the correction is a credit note in the current period, not an edit; whole invoice only, no partial returns | FR-BILL-17                                                   |
| ~~Q4~~ | ~~What must a prescription record contain for Schedule H sales?~~ **Answered 2026-08-24:** prescriber name, council registration number, prescription date and patient name — the particulars Rule 65(11) asks for that the invoice does not already carry. One record per invoice. **No image**: the rules permit a register in lieu of the paper, this stack has no file storage, and a scan would be a second copy of patient data with its own retention obligations | FR-MED-12 |
| Q5 | How many concurrent billing counters must be supported?                                                | Invoice numbering rewrite ([G-01](./08-gap-analysis.md#g-01)) |
| ~~Q6~~ | ~~What is the data retention period for customer records?~~ **Answered 2026-08-24:** customer details are erased after 36 months without a purchase; invoices keep 8 years as books of account. Erasure anonymises the row rather than deleting it, because invoices reference it. Cashiers no longer see purchase history. The purge is an operator-run command, not a scheduled job | Privacy posture |
| ~~Q7~~ | ~~Is the Purchases module in the next release, or is the schema to be dropped?~~ **Answered 2026-08-24: dropped.** The control it looked like it would provide already existed — `Batch` carries `supplierId` and `purchasePrice`, and the audit log records who created it, so stock already has a traceable cause and a cost. What Phase 10 would add on top is purchase-level grouping, supplier payables and margin reporting: features nobody asked for in the four months since 1.0.0. The design survives in git history and in this document, so procurement can be built later against real requirements rather than an April 2026 guess. | FR-PUR |
