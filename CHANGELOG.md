# Changelog

All notable changes to the Medical Billing System will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Fixed

#### Only one shop could trade — the multi-tenant migration half-applied

`20260828120000_add_shops_multi_tenant` re-keyed `Category.name`, `Manufacturer.name`, `Customer.phone` and `Invoice.invoiceNumber` from global to per-shop, and dropped the old keys with `ALTER TABLE ... DROP CONSTRAINT IF EXISTS`. Prisma writes `@unique` as a bare `CREATE UNIQUE INDEX`, so that statement matched nothing, and `IF EXISTS` made the miss silent. The migration reported applied with every global key still in place.

**Invoice serials restart at `-0001` per shop per day, so the second shop to sell on any given day could not sell at all** — `409 A record with this value already exists`, on a sale the customer had already paid for. The `P2002` retry in `createInvoice` was no help: every attempt re-derives the same per-shop serial. A new shop also could not create a category or manufacturer any other shop had named, and two shops could not hold a customer with the same phone number.

Found while investigating a report that the new monthly report showed no invoices. It showed none because the shop had none: its sales were being refused. Fixed by `20260830190000_drop_stale_global_unique_indexes`, using `DROP INDEX`. The guard asserts the behaviour rather than the index list, so it fails the same way if the keys return by another route.

### Added

#### Monthly and yearly reports (FR-RPT-10, FR-RPT-11)

`GET /api/reports/monthly?month=&year=` and `GET /api/reports/yearly?year=`, each with an `/export`, and two new tabs beside the daily report. A month broken into its days, a year into its months, with the same headline figures the daily summary has always printed.

- **The summary is now computed in one place for all three periods.** `summaryForPeriod` takes a date range and nothing else, so the day, the month and the year cannot disagree about what a period took. Copying it per period is exactly how the daily summary and the trend chart came to disagree about the same sale.
- **The breakdown sums to the headline, and there is a test that says so.** It deliberately does *not* reuse the trend aggregation, which filters to `paymentStatus = 'PAID'` because it charts takings rather than billings. Reusing it would have drawn bars falling short of the total printed above them by exactly the credit sales — two figures on one screen, each correct by its own definition, which is the defect `utils/trend.js` was written to close.
- **Zero-filled across the period**, so a day with no trade is a flat bar rather than a missing one. A gap shifts every later point left and reads as a trend rather than a closed shop.
- **The invoice register is paged from the server, not bundled into the report.** Both responses publish their `start`/`end` bounds, and the screen pages `GET /api/billing/invoices` through them — ten rows a request against an endpoint that is already capped, shop-scoped and tested. Measured on real data: 2,383 documents in the month and 20,204 in the year, with ten in the browser at a time. Bundling them into the report response would have been one line and a performance incident. The CSV still exports the breakdown, one row per bucket, because that is what the report is.
- **Open to every role.** This is the shop's own trading record, not its filing position; the GST return stays ADMIN and PHARMACIST only, and a test asserts the contrast.

Eleven tests, covering the day/month boundaries, the reconciliation with an unpaid invoice in the period, the zero-fill, both CSV shapes and the role split.

### Changed — BREAKING

#### The system holds many pharmacies, not one (2026-08-29)

Every row of shop-specific data now carries a `shopId`, and a shop's data is visible only to its own accounts. Until this landed, "multi-store" was listed in the roadmap as a **non-goal for 1.x**, with a note that it "would restructure every stock query." That estimate was accurate: `shopId` reaches ten tables and the `where` clause of every read and write across eleven controllers.

**`POST /api/auth/signup` is open registration now**, and this is the reversal worth reading twice. It shipped a day earlier as a one-shot bootstrap that sealed itself after the first account, and the entry below argues at length that a signup which worked twice "would be a data breach with a form in front of it" — because any authenticated role can read customer records, and pharmacy purchase history reveals health conditions (threat T-9). That argument was correct for a single-tenant system and has not been rebutted. It has been made inapplicable: a second signup no longer produces a second person inside *your* pharmacy, it produces an empty pharmacy of their own. `SECURITY.md` sets out what the boundary now rests on instead, and what open signup still costs.

- **`Shop`** holds the business details — name, address, phone, GST number — and every other shop-specific table foreign-keys to it. There is deliberately **no cross-shop relation anywhere in the schema**.
- **Categories and manufacturers became per-shop.** They were global lookup tables, which under tenancy is an isolation break rather than a saving: one shop renaming "Analgesic" would rename it for everyone, and the list itself discloses what other pharmacies stock. The cost is that each shop types "Tablet" into its own list once.
- **Invoice serials are per-shop**, so two pharmacies both start at `-0001`. `InvoiceCounter` is keyed on `(shopId, day)` and `Invoice` on `(shopId, invoiceNumber)`.
- **`shopId` is a JWT claim.** No endpoint accepts one in a body or query string, so there is nothing for a caller to target — the only shop a request can reach is the one its token names.
- **Scoped writes are `updateMany`/`deleteMany`, not `update`/`delete`.** Prisma's singular forms take only a unique selector, so `shopId` could not sit in the same `where` as `id`; it would have to be a separate check afterwards, which makes the boundary a property of control flow rather than of the query. A count of zero **is** the 404 — and 404 rather than 403 is deliberate, because a 403 confirms the row exists and turns a guessed id into a probe for another shop's catalogue.
- **`User.email` stays globally unique.** Login takes an email and a password with no shop selector, so a shared address would be ambiguous at the one lookup that matters. Somebody running two shops holds two accounts.
- **An admin-editable shop profile** (`GET`/`PUT /api/shop`, and a Shop tab in Settings) replaces the hardcoded placeholder in the printed invoice header. `GET` is open to every signed-in role, because printing a bill is a cashier's job and the contents are already on every invoice the shop hands out; `PUT` is ADMIN only and audited.
- **`GET /api/auth/setup-status` is gone.** It answered "does this installation still need its first account", which is no longer a question that has an answer.
- **The refresh cookie relaxed to `SameSite=None`** in production, paired with `Secure`, on the theory that a Vercel-hosted SPA calling a Render-hosted API is cross-site. **This may be unnecessary** — `frontend/vercel.json` rewrites `/api` to the backend, and a Vercel rewrite is a server-side proxy, so the browser should see one origin. It is flagged in `README.md` because `SameSite=None` widens CSRF exposure and should be reverted to `strict` if the rewrite is what the deployment actually uses.

**What it cost, recorded rather than smoothed over.** Auditing broke for master data and stayed broken for a day: moving edits onto `updateMany` took them out of the audit middleware's single-record path, so category renames, supplier retirements and user deactivations wrote no audit row at all. Signup deadlocked the connection pool, because `Shop` and `User` are both audited and the audit write takes a second connection while the caller's transaction still holds the first — eight concurrent signups returned eight `500`s and created nothing, while the log kept five shop creations that had rolled back. Both are fixed. **The same hazard remains on the void path**, where `tx.batch.update` audits inside a transaction and five concurrent voids is the measured ceiling; `backend/tests/billing/invoice-void.test.js` documents the arithmetic and caps its own concurrency at four to stay under it.

### The 2026-08-27 audit

A full-surface audit on 2026-08-27 — code, tests, documentation and deployment — and the fixes for what it found. Three of the defects were the same shape: a date boundary drawn differently from the one drawn beside it.

### Fixed

- **A password change no longer signs out the device that made it.** `changePassword` bumped `tokenVersion` and reissued the *access* token, but not the refresh cookie — which still carried the old counter, so `POST /api/auth/refresh` correctly rejected it and the SPA cleared the session. The caller stayed signed in for one token lifetime and was then dropped to `/login`, up to 30 minutes later. Worst on the path nobody can skip: the seeded admin and every administrator-reset account are *forced* through that screen. Both halves of the session are now reissued, and the account's other refresh rows are revoked rather than merely out-versioned.
- **The GST report no longer drops the last millisecond of the month.** `endDate` was built without a milliseconds argument, closing the period at `23:59:59.000` while the next opens at `00:00:00.000`. A sale committed in that 999 ms window appeared in the daily summary and in **no GST return at all** — too late for its own month, too early for the next. Guarded now by a month-boundary test, and by one asserting consecutive months partition the timeline.
- **The expiring-stock report shows batches that expire today.** It filtered from `new Date()`, the current instant, while expiry dates are stored at midnight — so a batch expiring today was already behind the cursor. `createInvoice` sells such a batch all day (FR-BATCH-09), which meant the till traded stock the report built to flag it stayed silent about, along with the topbar notification that reads the same endpoint. Both now derive local midnight from one shared helper.
- **The day's first sale is numbered `-0001` again after a morning credit note.** The counter row was seeded from a `COUNT(*)` over every invoice for the day, credit notes included — though those allocate from their own `CRN` row. Voiding yesterday's sale before today's first opened the sale series at `-0002`, leaving a gap in a book of account.
- **A rejected password is reported once, not twice.** Zod 4 does not abort on a `superRefine` issue, so the field-level and object-level checks both reported the same problem and the Settings form rendered it twice.

### Fixed — tests and CI

- **CI is green again.** The four login-timing guards had been failing since bcryptjs 3.x began dual-publishing ESM and CommonJS: the test `import`ed one build while the controller `require`s the other, so `vi.spyOn` patched a module instance the controller never called. The control itself was never affected — measured at 386 / 386 / 380 ms across the three miss paths — but its guard measured nothing.
- **A timezone-fragile test no longer passes only in UTC.** `reports.test.js` built its `?date=` with `toISOString().slice(0, 10)` on a local-midnight instant, naming the previous day in every zone east of Greenwich. It was green on CI and red on any machine in IST.
- **Node 22 is declared** as `engines` in both manifests. Below it the frontend suite fails to start its workers with a jsdom error that says nothing about the cause.

### Fixed

- **Autofilled inputs keep the form's colours.** Chrome paints `input:-webkit-autofill` with its own pale background and dark text, and it overrides `background-color` from any class — so once the login fields gained `autoComplete` and the browser began filling them, two white boxes appeared on a dark card. Overridden with the inset `box-shadow` trick, which is the one thing that reaches it, plus `-webkit-text-fill-color` for the text. Scoped to the `bg-slate-700` inputs the app uses, so it covers every autofillable form — Settings, Customers, Suppliers — not just the login page.
- **The request log names the endpoint again.** Express rewrites `req.url` when it dispatches into a mounted router, and pino's message builders run on response finish — after the rewrite. So `/api/auth/setup-status` was logged as `GET /setup-status`, and a route at a router's own root as plain `GET /`: `GET / 401` was the entire record of a rejected request to `/api/medicines`. Unfindable by grep, and meaningless to read. The structured `req.url` field was correct throughout, which made it worse rather than better — one line carried two different paths for one request, and the half a person reads was the wrong one. Now built from `originalUrl`, so the query string survives too.

### Added

#### First-run signup (FR-AUTH-12)

`GET /api/auth/setup-status` and `POST /api/auth/signup`, plus a `/signup` page and a "Don't have an account?" link that appears on the login screen **only while the installation is unclaimed**.

Signup creates the first administrator and then closes permanently. It is deliberately not open registration: every authenticated role can read customer records, and purchase history in a pharmacy reveals health conditions (threat T-9), so a signup that worked twice would be a data breach with a form in front of it.

- **It replaces a published credential with a chosen one.** The seeded `admin@medstore.com` / `admin123` has been SECURITY.md's first known issue since the beginning; the mitigation was `mustChangePassword`, which lets that account do exactly one thing. This moves the fix earlier — on a fresh install there is no published credential at all. `npm run seed` stays for development.
- **The account it creates is always `ADMIN`**, because a shop with no administrator cannot create one. `role` is *rejected* rather than ignored — the schema is `.strict()`, so sending one is a `400`. Accepting and silently dropping it would read like a privilege-escalation hole.
- **`mustChangePassword` is not set**, unlike the seeded admin and unlike an administrator's reset. Both of those hand someone a credential they did not choose; this one they chose a request ago.
- **Concurrency is guarded by a Postgres advisory lock** inside the insert's transaction. `count() === 0` then `create()` is a read-then-write race of the same shape as G-01, and a burst would leave two administrators nobody chose. `LOCK TABLE` was tried first and is worse: a queued transaction holds its pooled connection, so eight concurrent signups jammed the pool and every one died on the transaction timeout — never creating a second admin, but answering `500` to all of them. `pg_try_advisory_xact_lock` returns false instead of waiting, so a loser costs one round trip and is told `SETUP_IN_PROGRESS`, which is retryable.
- **Verified against a real fresh install**, not only in tests: 16 migrations applied, `needsSetup: true`, a weak password refused with the specific rule, signup `201` with an ADMIN and a working refresh cookie, then `needsSetup: false`, a second attempt `409`, and exactly one row in `User`.

33 new tests — 23 backend including the eight-way concurrent burst, 10 frontend across both states of the page.

### Fixed — found by covering the dashboard

`dashboard.controller.js` sat at **21.73%** statements, the lowest in the codebase, while serving every panel on the screen the owner reads. Twenty-six tests took it to **97.37%** and turned up two defects on the way — which is the argument for writing them.

- **The trend chart filed early-morning sales under the previous day.** `Invoice.date` is a naked timestamp holding a UTC instant, so `date_trunc('day', …)` bucketed in UTC while the zero-fill loop built its keys from local components. East of Greenwich the two disagreed for the first hours of every day: measured in IST, a ₹777 sale at 02:00 was charted on yesterday's bar and today read ₹0 — while the daily summary, which draws its boundaries in JS, insisted the sale was today. Two screens, one sale, two different days, neither obviously wrong on its own. The query now converts to the store's zone before truncating, by IANA name so a DST zone stays correct across the transition.
- **The dashboard's expiry panel hid batches expiring today** — the third site of the boundary bug fixed in `batch.controller.js`, missed in that pass because the same rule was written out by hand in three places.

### Changed

- **The trend query lives in `utils/trend.js`.** `GET /api/reports/trend` and the dashboard held identical copies of the SQL under a comment saying the two "must agree" — true only while nobody edited one of them, and it meant fixing the timezone defect twice. They now call one function, and a test asserts the two endpoints return the same array.
- **Coverage gates on `dashboard.controller.js` (90%) and `utils/trend.js` (100%).** Not because the numbers are now high, but on the rule the existing two gates use: a regression there misreports takings.

### Fixed — the chain behind the red CI

Repairing the backend suite let the browser smoke job run instead of being skipped, and three defects were waiting behind it, each hiding the next. **The middle one broke the documented setup for every fresh clone.**

- **The development stack applies its migrations.** Neither `docker-compose.yml` nor `Dockerfile.dev` ran them, and the only `prisma migrate deploy` in CI belongs to the backend job against its own service container — so `docker compose up -d` followed by `npm run seed`, exactly as the README prints it, produced a database with **no schema** and an API that failed every request against tables that were never created. It worked only on machines whose `pgdata` volume predated the problem, which is why it lasted. The backend now runs `migrate deploy` before nodemon: it applies committed migrations, never generates or resets one, and is idempotent across restarts.
- **`npm run seed` exits non-zero when it fails.** `main().catch(console.error)` printed the error and exited 0, so CI's "Seed the bootstrap admin" step showed a green tick against an empty database and the real failure surfaced two steps later as a browser test that could not sign in. This is what hid the item above.
- **The browser smoke job installs before it starts the stack.** The frontend dev service bind-mounts `./frontend` and layers an anonymous volume at `/app/node_modules`; Docker creates that mountpoint inside the bind mount, on the host, as root, and `npm ci` then ran as an unprivileged user and died with `EACCES`.
- **Removed the duplicate CodeQL workflow.** `codeql.yml` was an unmodified template analysing the same two languages as the repository's default setup, and every run failed with "CodeQL analyses from advanced configurations cannot be processed when the default setup is enabled". The default setup, which passes, is unaffected.

A job that is skipped reports nothing and reads much like one that passes. The smoke suite had been skipped, not passing, on every run since the backend suite went red.

### Changed

- `render.yaml` states `TRUST_PROXY` explicitly rather than relying on the default. If the platform's edge falls outside the trusted ranges, the rate limiter silently keys every request to one bucket and the per-client budget becomes a shop-wide one.
- `.env` and `.env.*` are excluded from both Docker build contexts. The backend never copied them; the frontend does `COPY . .`, and Vite inlines every `VITE_` value into the bundle at build time.

### Documentation

- Corrected the session description in four places — `SECURITY.md`, `docs/02`, `docs/README`, `docs/10` — which still described the pre-2026-08-22 token: *"7-day expiry, carrying only a user id"*. It is a 30-minute access token carrying `{ id, tokenVersion }`, with the week in a rotating `HttpOnly` cookie. SECURITY.md's own design table contradicted SECURITY.md sixty lines above it, and the glossary's `payload { id } only` denied the existence of the counter the whole revocation model rests on.
- `Prescription.patientName` in the schema claimed it was anonymised alongside the customer. It is not, deliberately — `erase-customer.js` argues the case from Rule 65(11) at length. The schema now records the limit rather than promising the opposite, since it is what a reader consults when deciding whether an erasure was complete.
- CONTRIBUTING said there was exactly one raw SQL statement; there are five. It now points at SECURITY.md's list rather than keeping a second count.
- `docs/02` no longer says there is no production image or multi-stage build — both Dockerfiles are two-stage production images — and no longer lists `generatePurchaseNumber()`, removed with the purchases table.

---

## [2.0.0] - 2026-08-24

The first release since 1.0.0. Versions 1.1.0 through 1.3.0 appear in the roadmap but were never tagged, so everything that accumulated on `main` since 1.0.0 is recorded here rather than back-dated into releases that did not ship.

The major bump is for one change: **the API is now grouped by resource**. Everything else below is additive or a fix.

### Changed — BREAKING

#### Routes are grouped by resource, not by module

Customers were reachable only at `/api/billing/customers`, medicines and suppliers only under `/api/inventory/`, and the five reports were filed under whichever table each one happened to read. It was the single most common source of client confusion, and every document under `docs/` carried a warning about it.

| Was                                            | Now                                 |
| ------------------------------------------------ | ------------------------------------- |
| `/api/billing/customers`                       | `/api/customers`                    |
| `/api/inventory/medicines`                     | `/api/medicines`                    |
| `/api/inventory/suppliers`                     | `/api/suppliers`                    |
| `/api/billing/invoices/daily-summary`          | `/api/reports/daily-summary`        |
| `/api/billing/invoices/gst-report`             | `/api/reports/gst`                  |
| `/api/billing/invoices/trend`                  | `/api/reports/trend`                |
| `/api/inventory/batches/expiring`              | `/api/reports/expiring`             |
| `/api/inventory/batches/low-stock`             | `/api/reports/low-stock`            |

Each report's `/export` moved with it. Report names drop the qualifier the path now supplies — `gst-report` under `/api/reports` was saying it twice.

**Every old path still works.** They are deprecated for one minor version and removed in **2.1.0**. Each responds with `Deprecation: true`, a `Sunset` date and `Link: <successor>; rel="successor-version"`, and logs a warning carrying the request id and the calling user — so 2.1.0 can be scheduled on evidence about who is still calling, rather than on a guess.

An alias and its successor run the **same controller function**, not a copy, so the two cannot answer differently; `backend/tests/api/route-layout.test.js` asserts that on the response body of all nine pairs.

**What did not move:** batches, categories and manufacturers stay under `/api/inventory` — they are stock-keeping concerns reached through the medicine they belong to. Invoices stay under `/api/billing`, because billing is what they are.

`customer.routes.js`, `medicine.routes.js`, `report.routes.js` and `supplier.routes.js` now exist. Four zero-byte placeholders with exactly those names were deleted in 2026-08 ([G-13](./docs/08-gap-analysis.md#g-13)) for implying routers that did not exist.

### Everything below shipped on `main` between 1.0.0 and this release

[SECURITY.md](./SECURITY.md) recommended deploying `main` in preference to 1.0.0 throughout that period — several of these are correctness and security fixes rather than features.

Each item links to its entry in [`docs/08-gap-analysis.md`](./docs/08-gap-analysis.md), where the diagnosis and the verification are recorded.

### Fixed

#### Correctness under concurrency

- **Invoice numbers no longer collide under concurrent checkout** (G-01). Serials came from counting the day's invoices and adding one, executed outside the inserting transaction — two simultaneous sales derived the same number and the second failed with a 409 after the customer had paid. Replaced with an atomic per-day `InvoiceCounter` upsert **inside** the invoice transaction, so concurrent transactions queue on one row and each receives a distinct value. A rolled-back sale returns its number rather than leaving a gap in a tax document. A retry-only fix was tried first and failed: a count-based allocation livelocks, because every retry re-reads the same count.
- **Stock can no longer go negative through concurrent sales** (G-09). The availability check ran before the transaction that deducted stock, so two sales of the last unit both passed and both committed. Deduction is now its own guard — a conditional `updateMany` inside the transaction that matches zero rows when another sale took the units, rolling the whole invoice back.
- **Added a database `CHECK (quantity >= 0)` on `Batch`.** The guarded decrement remains the mechanism; the constraint is a backstop for write paths that do not exist yet.

#### Money

- **All currency moved from `Float` to `DECIMAL(12,2)`** (G-07), with `Prisma.Decimal` arithmetic throughout and a JSON replacer keeping the wire format numeric. Float drift previously left invoice headers a paisa away from the sum of their own lines, so tax totals could not be reconciled. Every invoice now satisfies `subtotal + cgst + sgst − discountAmt = totalAmount` exactly.
- **The POS cart now rounds the way the server does** (G-17). The cart summed unrounded floats while the server rounds CGST and SGST separately and builds totals from the rounded halves — the two disagreed on roughly 40% of realistic inputs. The smallest case: ₹1.00 at 5% GST showed ₹1.05 in the cart and stored ₹1.06 on the invoice. Cart arithmetic now runs in integer paise, mirroring the server statement for statement.

#### Security and validation

- **Every mutating route validates its request body** with Zod (G-05, G-11). `PUT /batches/:id` previously accepted arbitrary fields; its schema is now deliberately narrow and **excludes `quantity`**, because rewriting stock silently bypasses every accounting path.
- **Every query string is now validated** (P1-10, threat T-10). `?limit=999999` was honoured on all three paginated endpoints, a garbage `month` produced an empty GST report indistinguishable from a quiet month, and `Number(x) || 30` turned a typo into a plausible-looking default window. `limit` is capped at 100; absent means use the default, present but unparseable is a 400.
- **Rate limiting is per-client, with a dedicated failed-login budget** (G-06). Behind the proxy every request appeared to come from one address, so the limiter was effectively global — one busy client could lock out the shop.
- **A database failure during authentication no longer reads as an invalid token** (G-18). `protect` caught token verification and the user reload together and answered 401 for both. Since the SPA clears its session on any 401, a few seconds of database trouble signed out every active user and told them their session was invalid.
- **`mfgDate` can be saved** (G-04). Both the column and the controller supported it, but it was missing from the validator, so Zod stripped it silently on every request for months.

#### Correctness of reported data

- **`totalStock` sums every batch** (G-10), rather than reporting the nearest-expiry batch's quantity as the whole stock level.
- **Foreign-key violations return 409, not 500** (G-12). Deleting a category, manufacturer or supplier still referenced by other records now explains itself.

#### Deployment

- **The nginx entry point works** (G-02). Its origin was missing from the CORS allowlist, so `http://localhost` served the app but every API call failed. Both entry points now serve the SPA and proxy `/api` on the **same origin**, so CORS no longer applies to the browser at all.

### Added

- **A backend test suite and CI** (G-14) — 368 tests across 14 files, Vitest and Supertest against a real PostgreSQL database, with a coverage gate on `billing.controller.js` and `auth.middleware.js`, the two files where a regression is a financial or security incident. GitHub Actions runs it on every push and pull request.
- **Frontend unit testing** — Vitest and Testing Library, currently covering the cart arithmetic against the same GST fixtures the backend asserts.

### Removed

- Four zero-byte route files (`customer`, `medicine`, `report`, `supplier`), an empty `frontend/nginx.conf`, and a stray literal `frontend/@/` directory left by a `shadcn add` run (G-13). The route files implied routers that never existed.

### Documentation

- Added [`docs/`](./docs/), a ten-document reference set written by reading the source rather than the previous READMEs, which described intent rather than behaviour. The four component READMEs are now short pointers into it.

---

## [1.0.0] - 2026-04-28

### Initial Release

The first production release of the Medical Billing System, a comprehensive full-stack application for managing medical inventories, billing, customer records, and suppliers.

### Added

#### Backend Features

- **Authentication & Authorization**
  - JWT-based user authentication system
  - Role-based access control middleware
  - Secure session management

- **Inventory Management**
  - Medicine catalog with manufacturing and expiry date tracking
  - Batch tracking and management
  - Category classification for medicines
  - Real-time inventory updates

- **Billing System**
  - Digital invoice generation and management
  - Automated billing calculations
  - Invoice utilities for document generation
  - Billing history and tracking

- **Customer Management**
  - Complete customer records and profiles
  - Customer history tracking
  - Customer data persistence

- **Supplier Management**
  - Supplier database and information management
  - Supplier contact and transaction tracking

- **User Management**
  - User account creation and management
  - User profile management
  - Role assignment and permissions

- **Reporting**
  - Sales and billing reports
  - Inventory reports
  - Transaction history reports

- **Database**
  - Prisma ORM integration with relational database
  - Database migrations system
  - Automated schema versioning

- **Caching**
  - Redis integration for performance optimization
  - Session caching

#### Frontend Features

- **Modern UI Components**
  - Responsive card, button, and input components
  - Dialog and sheet modals
  - Data table with sorting and filtering
  - Select dropdowns and form controls
  - Alert and notification systems
  - Badge and avatar components
  - Skeleton loaders for better UX

- **Core Pages & Features**
  - Dashboard with overview metrics and analytics
  - Inventory management interface
  - Billing and invoice management page
  - Customer management interface
  - Supplier management interface
  - Reports and analytics page
  - Settings configuration page
  - User authentication with login page

- **Authentication**
  - Login/logout functionality
  - Protected routes and role-based access control
  - JWT token management

- **State Management**
  - Zustand store for authentication state
  - Notification store for user feedback
  - Global state management

- **API Integration**
  - Centralized API client for backend communication
  - Request/response interceptors
  - Error handling utilities

- **Notifications**
  - Toast notifications via Sonner
  - Custom notification hooks
  - Real-time user feedback

- **Development Setup**
  - Vite for fast build and development
  - TypeScript for type safety
  - ESLint configuration for code quality
  - Responsive design with Tailwind CSS

### Technical Stack

#### Backend

- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: PostgreSQL (via Prisma ORM)
- **Cache**: Redis
- **Authentication**: JWT (JSON Web Tokens)
- **API**: RESTful API

#### Frontend

- **Framework**: React 18+ with TypeScript
- **Build Tool**: Vite
- **Styling**: CSS + Tailwind CSS (via shadcn/ui components)
- **State Management**: Zustand
- **HTTP Client**: Axios
- **UI Components**: Shadcn/ui component library

#### DevOps

- **Containerization**: Docker
- **Container Orchestration**: Docker Compose
- **Web Server**: Nginx

### Project Structure

```
medical-billing/
├── backend/           # Node.js/Express API server
├── frontend/          # React/TypeScript web application
├── nginx/             # Nginx configuration for reverse proxy
└── docker-compose.yml # Multi-container orchestration
```

### Getting Started

For detailed setup instructions, please refer to:

- [Backend README](backend/README.md)
- [Frontend README](frontend/README.md)
- [Architecture Documentation](Architecture.txt)

### Known Limitations

- Initial release - production usage should be monitored
- Consider implementing additional security measures for sensitive medical data
- Backup and disaster recovery procedures should be implemented before production deployment

---

[1.0.0]: https://github.com/adarsh0707-kumar/medical-billing/releases/tag/v1.0.0
