# Medical Billing System

Billing, inventory and GST reporting for a retail pharmacy. A React SPA over a
Node/Express API, PostgreSQL through Prisma, all of it containerised.

It handles money, stock and tax records, so correctness matters more here than
delivery speed — the [contributing guide](./CONTRIBUTING.md) is mostly about the
handful of places where the obvious change is the wrong one.

---

## Quick start

Requires Docker and Docker Compose. For a non-Docker run you also need Node 20,
PostgreSQL 15 and Redis.

```bash
git clone https://github.com/adarsh0707-kumar/medical-billing.git
cd medical-billing

# JWT_SECRET is interpolated into the backend container by docker compose.
# There is no default, and the API will not issue tokens without it.
echo "JWT_SECRET=$(openssl rand -hex 32)" > .env

docker compose up -d
docker compose exec backend npm run seed     # creates the bootstrap admin
```

| URL | What |
|---|---|
| http://localhost:5173 | The app via the Vite dev server — develop against this, it has HMR |
| http://localhost | The same app via nginx, closest to a deployment |
| http://localhost:5000/health | The API directly |

Sign in with `admin@medstore.com` / `admin123`. **Change that password before the
system is reachable by anyone else** — see [SECURITY.md](./SECURITY.md).

Both entry points serve the SPA and proxy `/api` to the backend on the **same
origin**, so CORS never applies to the browser.

---

## What it does

Point-of-sale billing with GST, batch-level stock with expiry tracking, customer
and supplier records, user accounts with three roles (`ADMIN`, `PHARMACIST`,
`CASHIER`), and daily-sales and GST reports.

Full requirement list, each with a status:
[`docs/01-product-requirements.md`](./docs/01-product-requirements.md).

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Vite, Tailwind v4, shadcn/ui |
| Backend | Node 20, Express 5, Prisma 5 |
| Database | PostgreSQL 15 |
| Cache | Redis 7 — running, but not yet used by the application |
| Web server | nginx |

---

## Documentation

`docs/` is the reference for how the system actually works. It was written by
reading the source, and it is kept in step with the code.

| Document | Covers |
|---|---|
| [01 Product requirements](./docs/01-product-requirements.md) | Every requirement with a build status, and the open product questions |
| [02 Architecture](./docs/02-architecture.md) | Components, request flow, environment variables, production gaps |
| [03 Data model](./docs/03-data-model.md) | Schema, relationships, invariants |
| [04 API reference](./docs/04-api-reference.md) | Every endpoint, its query parameters and its failure modes |
| [05 Roadmap](./docs/05-roadmap-and-phases.md) | Phased plan with exit criteria |
| [06 Development guide](./docs/06-development-guide.md) | Setup, environment, troubleshooting |
| [07 Security](./docs/07-security.md) | Threat model and the prioritised hardening backlog |
| [08 Gap analysis](./docs/08-gap-analysis.md) | Known defects, each with a diagnosis and a fix |
| [09 Testing strategy](./docs/09-testing-strategy.md) | What is tested, what is not, and the GST acceptance fixtures |
| [10 Glossary](./docs/10-glossary.md) | Domain terms |

The URL layout is grouped by module rather than by resource, which is not what
you would guess — customers live under `/api/billing/`, medicines and suppliers
under `/api/inventory/`, and there is no `/api/reports`. See
[04](./docs/04-api-reference.md) before writing a client.

---

## Tests

```bash
# backend — the database must end in _test; the suite empties every table
docker compose exec \
  -e DATABASE_URL='postgresql://medadmin:medpass123@postgres:5432/medicaldb_test' \
  backend npm test

# frontend
cd frontend && npm test
```

---

## Contributing

[CONTRIBUTING.md](./CONTRIBUTING.md) covers setup, conventions, and the landmines
worth knowing before a first pull request — how Zod silently strips undeclared
fields, why money must never meet the `+` operator, and where stock is allowed to
change.

Found a security problem? **Don't open an issue** — follow
[SECURITY.md](./SECURITY.md).

## Licence

[MIT](./LICENSE).
