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
| `npm run seed` | creates the bootstrap admin |

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
├── app.js            createApp() — builds the app without binding a port
├── index.js          binds the port
├── config/db.js      the Prisma singleton; all database access goes through it
├── routes/           auth · inventory · billing · user  (all four are mounted)
├── controllers/
├── middlewares/      auth · validate · validate-query · error
├── validators/       Zod schemas — never inline in a route
└── utils/            invoice numbering, JWT helpers
```

Routers are grouped by **module, not by resource**: customers live under
`/api/billing/`, medicines and suppliers under `/api/inventory/`, and there is no
`/api/reports`. Re-grouping is queued for 2.0.0.

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
