# Frontend — Medical Billing SPA

React 19 · TypeScript · Vite 8 · Tailwind v4 · shadcn/ui over Radix.

Run it from the repository root with `docker compose up -d`; see the
[root README](../README.md) for first-run setup.

```bash
# non-Docker — needs Node 20
npm install --legacy-peer-deps
npm run dev          # http://localhost:5173
```

| Script | What |
|---|---|
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | `tsc -b` then `vite build` |
| `npm run lint` | ESLint |
| `npm test` | Vitest |
| `npm run test:watch` | the same, in watch mode |
| `npm run preview` | serve the production build locally |

`tsc -b` runs as part of the build and catches type errors lint does not, so
`npm run build` is the real gate.

## How it talks to the API

All HTTP goes through `src/lib/api.ts`, which attaches the bearer token and
clears the session on a 401. The client calls **`/api` on its own origin** — both
the Vite dev server and nginx proxy it to the backend, so CORS never applies.
There is deliberately no absolute API URL; don't reintroduce one.

## Layout

```text
src/
├── pages/            one file per screen — Billing is the POS
├── components/ui/    shadcn primitives; compose them, don't restyle
├── components/layout/
├── store/            Zustand — auth, notifications
├── hooks/
├── lib/              api.ts · cart-math.ts · utils.ts
└── types/
```

`@/` aliases `src/` and is configured in **both** `vite.config.ts` and
`tsconfig.app.json` — update both or resolution silently diverges.

Cart arithmetic lives in `lib/cart-math.ts` rather than in the Billing page, so
it can be unit-tested. It runs in integer paise and mirrors the server's rounding
exactly; the two must agree to the paisa or the cashier quotes one number and the
invoice prints another.

## Documentation

The reference lives in [`docs/`](../docs/):

- [API reference](../docs/04-api-reference.md) — endpoints and query parameters
- [Testing](../docs/09-testing-strategy.md) — including the GST fixtures the cart
  is asserted against
- [Architecture](../docs/02-architecture.md)

Conventions and landmines: [CONTRIBUTING.md](../CONTRIBUTING.md). Note that
hiding a nav item is not access control — every admin-only screen also needs
`authorize()` on the server.

## Licence

[MIT](../LICENSE).
