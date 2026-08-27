# Backend — Medical Billing API

Node 22 · Express 5 · Prisma 5 · PostgreSQL 15. CommonJS, not ESM.

Run it from the repository root with `docker compose up -d`; see the
[root README](../README.md) for first-run setup.

```bash
# non-Docker
npm install
npx prisma migrate dev
npm run dev          # nodemon on :5000
```

| Script | What |
|---|---|
| `npm run dev` | nodemon |
| `npm start` | plain node |
| `npm test` | Vitest + Supertest against a real database |
| `npm run test:watch` | the same, in watch mode |
| `npm run test:coverage` | with the coverage gate |
| `npm run lint` / `lint:fix` | ESLint — runs in CI and fails the build |
| `npm run format` / `format:check` | Prettier; **not** a CI gate, run it on what you touched |
| `npm run types:generate` | regenerate the client's request types from the Zod schemas |
| `npm run types:check` | fail if the committed types are stale — runs in CI |
| `npm run seed` | creates the bootstrap admin |
| `npm run reset-password` | console break-glass when the last admin is locked out |
| `npm run purge:customers` | retention sweep; dry run unless `-- --apply` |
| `npm run prisma:generate` / `prisma:migrate` / `prisma:studio` | Prisma CLI |

`DATABASE_URL` **must** name a database ending in `_test` when running the suite.
It empties every table between tests and refuses to start against anything else —
that guard is the only thing between a mistyped variable and your dev data.

```bash
docker compose exec \
  -e DATABASE_URL='postgresql://medadmin:medpass123@postgres:5432/medicaldb_test' \
  backend npm test
```

## Layout

```
src/
├── app.js            createApp() — the whole middleware stack, without a port
├── index.js          checks JWT_SECRET is set, then binds the port
├── config/           db.js (the Prisma singleton — all access goes through it)
│                     · logger.js (pino) · audit.js · audit-context.js
├── routes/           auth · users · customers · medicines · suppliers
│                     · reports · inventory · billing · dashboard  (nine, all mounted)
├── controllers/      one per resource, plus dashboard
├── middlewares/      auth · password-change · validate · validate-query
│                     · deprecate · audit-context · error
├── validators/       Zod schemas — never inline in a route
└── utils/            invoice numbering · JWT · CSV · customer erasure
                      · retention · temporary passwords · seed
scripts/              generate-api-types.js · reset-password.js
```

## Routing

Since **2.0.0** routers are grouped by **resource**, so the URL you would guess
is the one that works:

| Prefix | Serves |
|---|---|
| `/api/auth` | login · register · me · change-password · refresh · logout |
| `/api/users` | user CRUD · own profile · admin password reset |
| `/api/customers` | customer CRUD · erasure |
| `/api/medicines` | medicine CRUD · `/search` (the POS lookup) |
| `/api/suppliers` | supplier CRUD |
| `/api/reports` | daily-summary · gst · trend · expiring · low-stock, each with `/export` |
| `/api/inventory` | categories · manufacturers · batches |
| `/api/billing` | invoices · void · credit notes |
| `/api/dashboard` | `stats` — every dashboard panel in one request |

Batches, categories and manufacturers stay under `/api/inventory`, and invoices
under `/api/billing`. Those are not oversights: a batch is reached through the
medicine it belongs to, and an invoice is a billing document.

Before 2.0.0 the grouping was by *module* — customers under `/api/billing/`,
medicines and suppliers under `/api/inventory/`, no `/api/reports` at all. Every
one of those paths still works and is **deprecated**: each answers with
`Deprecation`, `Sunset` and `Link: rel="successor-version"` headers, logs a
warning naming the caller, and is removed in **2.1.0**. An alias and its
successor run the same controller function, so they cannot answer differently.
Full mapping: [docs/04 §2a](../docs/04-api-reference.md).

## Documentation

This file deliberately stops here. The reference lives in
[`docs/`](../docs/) and is kept in step with the code:

- [API reference](../docs/04-api-reference.md) — every endpoint, its query
  parameters, its failure modes
- [Data model](../docs/03-data-model.md) — schema and invariants
- [Architecture](../docs/02-architecture.md) — request flow and environment
- [Security](../docs/07-security.md) — threat model and hardening backlog
- [Testing](../docs/09-testing-strategy.md) — the GST acceptance fixtures

Before changing anything that touches money, stock or authentication, read the
landmines section of [CONTRIBUTING.md](../CONTRIBUTING.md).

## Licence

[MIT](../LICENSE).
