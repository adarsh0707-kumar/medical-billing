# Changelog

All notable changes to the Medical Billing System will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

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
