# Changelog

All notable changes to the Medical Billing System will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.1.0] - Unreleased

Not yet tagged. Everything below is on `main`, which [SECURITY.md](./SECURITY.md) currently recommends deploying in preference to 1.0.0 — several of these are correctness and security fixes rather than features.

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
