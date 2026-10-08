# Medical Billing System

> **Multi-tenant pharmacy billing, inventory, GST reporting, and role-based operations built as a production-oriented full-stack application.**

Medical Billing System is a web application for pharmacies that need to manage sales, stock, customers, suppliers, users, and GST reporting from one system.

The project focuses on the parts of a billing system where correctness matters: **money arithmetic, stock integrity, tenant isolation, authorization, auditability, and predictable failure handling**.

> **Status:** Active development / portfolio-ready  
> **Current version:** 3.0.0  
> **Deployment:** Docker Compose for local development; the frontend also has a Vercel deployment configuration  
> **Important:** This is not presented as a certified accounting, tax, or production pharmacy system. Operational and regulatory requirements must be validated before real-world use.

---

## Highlights

### Billing & GST
- Create pharmacy invoices with GST.
- Supports GST rates used by the application, including 0%, 5%, 12%, and 18%.
- Keeps monetary values at two decimal places.
- Cart calculations use integer paise and mirror the backend's rounding pipeline.
- GST reporting and CSV export use persisted server-side values rather than re-calculating tax in the browser.
- Invoice voiding creates a separate credit note and restores stock transactionally.

### Inventory
- Medicine, batch, category, manufacturer, and supplier management.
- Batch-level quantities and expiry dates.
- FEFO-style stock selection.
- Expired stock is excluded from sale selection.
- Low-stock and expiry filtering.
- Stock changes are tied to transactional billing operations.

### Multi-tenancy & access control
- Each pharmacy is represented by a `Shop`.
- Shop-specific records carry a `shopId`.
- The authenticated token determines the active shop; clients do not submit a shop ID to select another tenant.
- Roles: `ADMIN`, `PHARMACIST`, and `CASHIER`.
- Protected API routes enforce authentication and authorization.

### Operational safeguards
- Zod request validation.
- JWT authentication.
- HTTP security headers with Helmet.
- Rate limiting.
- Structured logging with Pino.
- Transactional database operations for critical billing/stock paths.
- Refresh-token flow with an HttpOnly cookie and an Origin check for cross-site deployment.
- Automated frontend and backend tests.

---

## Architecture

The application uses a conventional control/data flow with the browser isolated from direct database access:

```text
┌──────────────────────┐
│ React 19 + TypeScript │
│ Vite + Tailwind       │
└──────────┬───────────┘
           │ HTTP / API
           ▼
┌──────────────────────┐
│ Nginx / Vite Proxy    │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Node.js + Express 5   │
│ Auth / RBAC / Billing │
│ Inventory / Reports   │
└──────────┬───────────┘
           │ Prisma
           ▼
┌──────────────────────┐
│ PostgreSQL 15         │
│ Durable application   │
│ state                 │
└──────────────────────┘
```

### Critical billing path

```text
Authenticated request
        │
        ▼
Validate input
        │
        ▼
Resolve tenant from token
        │
        ▼
Read stock / pricing data
        │
        ▼
Database transaction
   ┌────┴─────────────┐
   │                  │
   ▼                  ▼
Create invoice     Decrement stock
   │                  │
   └────────┬─────────┘
            ▼
      Commit atomically
```

The important invariant is that an invoice and its stock movement must agree. Money and inventory are not treated as independent UI concerns.

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Vite, Tailwind CSS v4, shadcn/ui |
| Data fetching | TanStack Query, Axios |
| Backend | Node.js 22, Express 5 |
| Validation | Zod |
| Authentication | JWT, bcryptjs, HttpOnly refresh cookie |
| Database | PostgreSQL 15, Prisma 5 |
| Web server | nginx |
| Testing | Vitest, Supertest, Testing Library, Playwright |
| Infrastructure | Docker, Docker Compose |
| Logging / security | Pino, Helmet, express-rate-limit |

---

## API

The backend exposes resource-oriented routes under `/api`.

Examples include:

```text
POST   /api/auth/signup
POST   /api/auth/login
POST   /api/auth/refresh

GET    /api/customers
GET    /api/medicines
GET    /api/suppliers

POST   /api/billing/invoices
POST   /api/billing/invoices/:id/void

GET    /api/reports/...
```

For the complete route list, parameters, response shapes, and failure modes, see the [API reference](./docs/04-api-reference.md).

> Older module-grouped routes remain available as deprecated compatibility paths and are scheduled for removal in 3.1.0.

---

## Local development

### Prerequisites

- Docker
- Docker Compose
- OpenSSL (for generating a local JWT secret)

For a non-Docker backend/frontend setup, use Node.js 22 and PostgreSQL 15.

### Start the application

```bash
git clone https://github.com/adarsh0707-kumar/medical-billing.git
cd medical-billing

echo "JWT_SECRET=$(openssl rand -hex 32)" > .env

docker compose up -d
```

The Compose backend applies committed Prisma migrations automatically before starting the development server.

### Local URLs

| URL | Purpose |
|---|---|
| http://localhost | nginx entry point |
| http://localhost:5173 | Vite development server with HMR |
| http://localhost:5000/health | Backend health endpoint |

### Development seed

If you want sample data:

```bash
docker compose exec backend npm run seed
```

The seed creates a bootstrap administrator for local development.

**Seed credentials are development-only. Do not reuse them outside a disposable local environment, and change/remove the account before exposing the application.**

You can also create a new pharmacy through the application's public signup flow.

---

## Testing

### Backend

```bash
docker compose exec \
  -e DATABASE_URL='postgresql://medadmin:medpass123@postgres:5432/medicaldb_test' \
  backend npm test
```

The test database must end in `_test`. The suite clears its test data, so never point this command at a database containing real data.

### Frontend

```bash
cd frontend
npm test
```

Additional checks available in the repository include:

```bash
# backend
npm run lint
npm run format:check
npm run test:coverage

# frontend
npm run lint
npm run build
npm run test:e2e
```

The test strategy and acceptance fixtures are documented in [docs/09-testing-strategy.md](./docs/09-testing-strategy.md).

---

## Security model

The application treats authentication, tenant isolation, and financial data as security-sensitive boundaries.

Key controls include:

- JWT-based authentication.
- Role-based authorization.
- Tenant resolution from authenticated identity.
- Zod input validation.
- Password hashing with bcryptjs.
- Helmet security headers.
- Rate limiting.
- HttpOnly refresh cookies for the refresh-token path.
- Origin validation on the cookie-authenticated refresh endpoint.
- Database transactions around critical invoice/stock operations.
- Security-focused regression tests.

### What this does not claim

This repository is **not** a guarantee of regulatory compliance, PCI certification, GST filing compliance, or security against every deployment-specific threat.

Secrets, TLS termination, database exposure, backups, monitoring, account recovery, infrastructure hardening, and operational access controls still need environment-specific configuration.

See [SECURITY.md](./SECURITY.md) and the [security documentation](./docs/07-security.md) before deploying.

---

## Documentation

The repository keeps detailed engineering documentation outside the root README:

| Document | Purpose |
|---|---|
| [Product requirements](./docs/01-product-requirements.md) | Requirements and build status |
| [Architecture](./docs/02-architecture.md) | Components, flows, and deployment considerations |
| [Data model](./docs/03-data-model.md) | Schema, relationships, and invariants |
| [API reference](./docs/04-api-reference.md) | Endpoints and failure modes |
| [Roadmap](./docs/05-roadmap-and-phases.md) | Planned phases and exit criteria |
| [Development guide](./docs/06-development-guide.md) | Local setup and troubleshooting |
| [Security](./docs/07-security.md) | Threat model and hardening |
| [Gap analysis](./docs/08-gap-analysis.md) | Known defects, fixes, and remaining gaps |
| [Testing strategy](./docs/09-testing-strategy.md) | Test coverage and GST acceptance fixtures |
| [Glossary](./docs/10-glossary.md) | Domain terminology |

---

## Current limitations

The project is intentionally transparent about what still needs production work:

- No claim of regulatory certification or production pharmacy compliance.
- Hosted deployment security depends on the actual Vercel/Render configuration.
- Infrastructure secrets and TLS are environment concerns.
- Open signup is enabled by design; installations that require closed enrollment need an upstream access policy.
- Deprecated API paths remain until the planned 3.1.0 removal.
- Performance numbers are not presented unless measured in a documented environment.

For the full list of known gaps, see [docs/08-gap-analysis.md](./docs/08-gap-analysis.md).

---

## Roadmap

Near-term engineering priorities:

1. Complete remaining documented product requirements.
2. Remove deprecated API routes in 3.1.0.
3. Continue security and authorization regression coverage.
4. Strengthen deployment and operational hardening.
5. Expand end-to-end and production-like validation.
6. Measure performance under representative pharmacy workloads.

---

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before making changes.

For security vulnerabilities, follow [SECURITY.md](./SECURITY.md) rather than opening a public issue.

---

## License

MIT — see [LICENSE](./LICENSE).

---

## Author

**Adarsh Kumar**

This project demonstrates practical work across:

```text
Full-Stack Engineering
Backend Systems
PostgreSQL / Prisma
Authentication & Authorization
Financial / GST Data Correctness
Multi-Tenant SaaS
Testing
Docker
Security Hardening
```
