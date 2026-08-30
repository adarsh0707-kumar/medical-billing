# Medical Billing System

Billing, inventory and GST reporting for a retail pharmacy. A React SPA over a
Node/Express API, PostgreSQL through Prisma, all of it containerised.

It handles money, stock and tax records, so correctness matters more here than
delivery speed — the [contributing guide](./CONTRIBUTING.md) is mostly about the
handful of places where the obvious change is the wrong one.

---

## Quick start

Requires Docker and Docker Compose. For a non-Docker run you also need Node 22
and PostgreSQL 15.

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

Or skip the seed entirely: the login page offers **New shop? Create your
account**, which opens a shop of your own and signs you in as its administrator
with a password you choose. That is open registration, deliberately — see
[Multiple shops](#multiple-shops).

Both entry points serve the SPA and proxy `/api` to the backend on the **same
origin**, so CORS never applies to the browser.

---

## Multiple shops

Since **2026-08-29** one installation holds any number of pharmacies. Each is a
`Shop`; every row of shop-specific data carries a `shopId`; and a shop's data is
visible only to its own accounts. A caller's shop comes from their token, never
from the request, so there is nothing for a client to target — the only shop a
request can reach is the one its token names.

`POST /api/auth/signup` is public and stays public. Signing up creates a new,
empty shop rather than joining an existing one, which is why it is no longer the
one-shot bootstrap it was for its first day. [SECURITY.md](./SECURITY.md#open-signup-and-what-changed-the-argument)
sets out the argument that changed, what the boundary rests on now, and what
open signup still costs. If you want a single-pharmacy installation, put a
proxy rule in front of that one endpoint and create accounts with
`POST /api/auth/register`; there is no configuration flag for it today.

Requirements: [FR-SHOP](./docs/01-product-requirements.md#60-tenancy--fr-shop).
Schema: [03 §3.0](./docs/03-data-model.md#30-shop--the-tenant).

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
| Backend | Node 22, Express 5, Prisma 5 |
| Database | PostgreSQL 15 |
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

Since **2.0.0** the URL layout is grouped by resource: `/api/customers`,
`/api/medicines`, `/api/suppliers`, `/api/reports`. It used to be grouped by
module — customers under `/api/billing/`, medicines and suppliers under
`/api/inventory/` — which was the most common thing clients got wrong. Those
paths still work, now marked deprecated, and are removed in 2.1.0. The mapping
is in [04 §2a](./docs/04-api-reference.md).

---

## Hosted deployment — one origin, and an open question

The Docker stack is unambiguously same-origin: nginx and the Vite dev server
both serve the SPA and proxy `/api` to the backend, so CORS never applies to the
browser.

The hosted deployment is meant to work the same way. `frontend/vercel.json`
rewrites `/api/:path*` to the Render backend, and a Vercel rewrite is a
**server-side proxy** — the browser requests `/api/...` on the Vercel origin and
never learns that Render answered. `frontend/Dockerfile` and `lib/api.ts` agree:
no `VITE_API_URL` is set, so the client uses a relative base URL.

**But the refresh cookie was relaxed to `SameSite=None` on 2026-08-29** to fix
silent refresh failing, on the reasoning that the SPA and API are cross-site.
Both cannot be true. The rewrite predates that change by two days, so if it is
what the deployment actually uses, `SameSite=None` is unnecessary — and it is
not free: it widens CSRF exposure on `POST /api/auth/refresh`, which
`SameSite=Strict` was chosen to close.

The one thing that would make the deployment genuinely cross-site is
`VITE_API_URL` being set in the Vercel project's environment, which is not
visible in this repository. **To settle it:** check that variable in the Vercel
dashboard, or open the deployed app and look at whether the network panel shows
`/api/...` on the app's own origin or an absolute `onrender.com` URL. If it is
same-origin, revert `refreshCookieOptions()` in
`backend/src/controllers/auth.controller.js` to `sameSite: "strict"`.

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
