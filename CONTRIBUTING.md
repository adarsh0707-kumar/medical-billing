# Contributing to the Medical Billing System

Thanks for taking an interest. This is a retail pharmacy billing and inventory system — it handles money, stock and tax records, so correctness matters more here than speed of delivery.

Read this before your first pull request. Most of it is about the handful of places where the obvious change is the wrong one.

- **Documentation:** [`docs/`](./docs/) is the reference for how the system actually works
- **Security issues:** do **not** open a public issue — see [SECURITY.md](./SECURITY.md)
- **Conduct:** [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)

---

## Ground rules

1. **The docs are part of the code.** [`docs/`](./docs/) describes what the system does today, not what it should do. If your change makes a document wrong, fix the document in the same commit.
2. **Never document intent as fact.** Anything not in the code is tagged `⬜ Planned`. The repo has been burned by this before — the component READMEs describe endpoints that were never built, which is why [`docs/08-gap-analysis.md`](./docs/08-gap-analysis.md) exists.
3. **Financial and stock code needs proof, not confidence.** If you change the GST engine, stock deduction or invoice numbering, say in the PR how you verified it. See [Testing](#testing).
4. **Small, single-purpose commits.** A schema migration ships on its own.

---

## Getting set up

```bash
git clone https://github.com/adarsh0707-kumar/medical-billing.git
cd medical-billing

# JWT_SECRET is interpolated into the backend container by docker-compose.
echo "JWT_SECRET=$(openssl rand -hex 32)" > .env

docker compose up -d
docker compose exec backend npm run seed     # creates the bootstrap admin
```

| URL                          | What                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------- |
| http://localhost:5173        | The app via the Vite dev server —**develop against this**, it has HMR |
| http://localhost             | The same app via nginx, closest to a deployment                              |
| http://localhost:5000/health | The API directly                                                             |

Sign in with `admin@medstore.com` / `admin123`.

Both entry points serve the SPA and proxy `/api` to the backend on the **same origin**, so CORS never applies to the browser. Don't reintroduce an absolute API URL in the client.

**Running the suites outside Docker needs Node 22**, declared as `engines` in both `package.json` files and pinned in CI. On Node 20 the frontend suite does not fail a test — it fails to start its workers with `TypeError: webidl.util.markAsUncloneable is not a function` from inside jsdom, which says nothing about the actual cause.

Full setup, environment variables and troubleshooting: [`docs/06-development-guide.md`](./docs/06-development-guide.md).

---

## Finding something to work on

| Source                                                                  | What's in it                                                                                   |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [`docs/08-gap-analysis.md`](./docs/08-gap-analysis.md)                 | Known defects, each with a diagnosis and a suggested fix. Anything not marked ✅ Fixed is open |
| [`docs/05-roadmap-and-phases.md`](./docs/05-roadmap-and-phases.md)     | Phased plan with exit criteria; Phase 9 (tests and CI) is the highest-value open work          |
| [`docs/01-product-requirements.md`](./docs/01-product-requirements.md) | Every requirement with a status —`⬜ Planned` rows are unbuilt features                     |

If you're picking up a `G-nn` item, reference it in your PR. If you disagree with the diagnosis there, say so — several entries have already been corrected by the work of fixing them.

---

## Landmines

These are the things that have actually caused defects in this codebase. Each is cheap to avoid and expensive to miss.

### Changing a schema regenerates the client's types

Every request contract is a Zod schema in `backend/src/validators/`, and the
frontend's request types are **generated** from them into
`frontend/src/types/api.generated.ts`. Edit a schema and run:

```bash
cd backend && npm run types:generate   # then commit the result
```

`npm run types:check` runs in CI and fails if the committed file is stale, so a
contract change that skips this turns the build red instead of turning a request
into a 400. Do not hand-edit the generated file.

It generates `z.input`, not `z.infer` — what a client *sends*, before defaults
and coercions are applied. A field the schema defaults is optional there.

### Zod strips unknown keys

`validate(schema)` replaces `req.body` with the parsed output, and `z.object()` drops anything not in the schema. A field you forget to declare doesn't error — it **silently vanishes**.

This is how `Batch.mfgDate` stayed `null` for months while both the column and the controller supported it ([G-04](./docs/08-gap-analysis.md#g-04)).

> **When you add a column, add it to the validator in the same commit.** On the highest-value routes use `.strict()`, so an unrecognised field is a `400` instead of a silent no-op.

### Money is `Decimal`, and `+` will betray you

All currency is `DECIMAL(12,2)` and Prisma returns `Decimal` instances. `a + b` on two of those **concatenates them as strings**. Use `.plus()`, `.minus()`, `.times()`, `.dividedBy()`.

The rounding rule exists so invoices reconcile by construction:

- each line rounds its taxable value, CGST and SGST to 2 dp (half-up) and builds its total from those rounded parts;
- the invoice header sums the **rounded** line components;
- `totalAmount` derives from those same components.

So `subtotal + cgst + sgst − discountAmt = totalAmount` **exactly**, and the printed lines add up to the printed total. Don't accumulate unrounded values into the header — that was [G-07](./docs/08-gap-analysis.md#g-07), and it left a real invoice a paisa out of balance.

Responses convert `Decimal` to JSON numbers via an Express `json replacer`. Keep the wire format numeric.

### Stock changes need a cause

`Batch.quantity` moves in exactly two places: creating a batch, and creating an invoice. There is deliberately **no** endpoint that just sets it — see [FR-BATCH-11](./docs/01-product-requirements.md#65-stock--batches--fr-batch). If you need manual adjustment, build it with an audit trail rather than widening `PUT /batches/:id`.

Deduction is a conditional update inside the invoice transaction:

```js
const { count } = await tx.batch.updateMany({
  where: { id: item.batchId, quantity: { gte: item.quantity } },
  data:  { quantity: { decrement: item.quantity } },
});
if (count === 0) throw new StockConflictError(/* … */);
```

Check-and-decrement must stay one atomic statement. A read-then-write pair lets two concurrent sales claim the same units ([G-09](./docs/08-gap-analysis.md#g-09)).

### Invoice numbers come from a counter, not a count

Serials are allocated by an atomic upsert against `InvoiceCounter` **inside the invoice transaction**. Counting today's invoices and adding one is a race that retrying does not fix — it livelocks, because every retry re-reads the same count ([G-01](./docs/08-gap-analysis.md#g-01)).

### Route order: literal paths before parameterised ones

`/medicines/search` must be declared above `/medicines/:id`, or `search` is read as an id. Same for `/invoices/daily-summary` and `/invoices/gst-report` above `/invoices/:id`.

### The URL layout changed in 2.0.0 — don't copy an old path

Routers are grouped by **resource** now. Customers are at `/api/customers`, medicines at `/api/medicines`, suppliers at `/api/suppliers`, and the five reports at `/api/reports/...`.

Before 2.0.0 they were grouped by *module* — customers only at `/api/billing/customers`, medicines and suppliers under `/api/inventory/`, reports filed under whichever table each one read. Those paths **still work and are deprecated**: they answer with `Deprecation`, `Sunset` and `Link: rel="successor-version"` headers, log a warning naming the caller, and are removed in **2.1.0**.

So when you copy a path out of an old branch, an old ticket or a stale tab, check it against the mapping table in [`docs/04-api-reference.md` §2a](./docs/04-api-reference.md). A deprecated path works, which is exactly what makes it easy to leave in.

Batches, categories and manufacturers stay under `/api/inventory`, and invoices under `/api/billing` — those are not oversights. A batch is reached through its medicine; an invoice is a billing document.

New routes go on the resource router, never on an alias.

### Every query is scoped to one shop, and forgetting is silent

One installation holds many pharmacies. Every shop-specific table carries a
`shopId`, and **a query that omits it leaks one shop's data into another's
screen** — without throwing, and with a response that looks entirely normal to
whoever reads it. This is the easiest serious mistake to make in this codebase.

The shop comes from the token, never from the request:

```js
where: { id: req.params.id, shopId: req.user.shopId }
```

Two rules follow, and both look wrong until you know why:

- **Scoped writes use `updateMany` / `deleteMany`, never `update` / `delete`.**
  The singular forms accept only a unique selector, so `shopId` cannot join `id`
  in the same `where` — it would have to be a check *after* the read, which
  makes the boundary a property of control flow rather than of the query. With
  the bulk forms, `count === 0` **is** the 404. Read the row back afterwards if
  you need to return it.
- **Answer `404`, not `403`, for another shop's id.** A 403 confirms the row
  exists, which turns a guessed id into a probe for another pharmacy's
  catalogue. The scoped `where` gives you this for free — it cannot tell the two
  cases apart, and that is the point.

`backend/tests/auth/signup.test.js` asserts this across the resource
controllers, the user list and the dashboard. If you add a resource, add it
there too.

Full rules: [FR-SHOP](./docs/01-product-requirements.md#60-tenancy--fr-shop) and
[03 §3.0](./docs/03-data-model.md#30-shop--the-tenant).

### Never select the password hash

Every user query uses an explicit `select` that omits `password`. The only exceptions are `login` and `changePassword`, which need it to compare. Preserve that.

---

## Conventions

### Backend

- CommonJS (`require` / `module.exports`), not ESM.
- Middleware chain order: `protect → authorize(...roles) → validate(schema) → controller`.
- Every async handler wraps in `try/catch` and calls `next(err)`. Don't hand-roll a 500.
- All responses use the envelope: `{ success, data, message? }` / `{ success: false, message, errors? }`.
- Database access only through the `config/db.js` singleton.
- Zod schemas live in `validators/`, never inline in a route.
- Prisma error codes are mapped centrally in `error.middleware.js` (`P2002` → 409, `P2003` → 409, `P2025` → 404). Add new mappings there rather than in controllers.
- Raw SQL is a last resort. There are six statements — the two document-serial upserts, which need the atomicity; the two trend aggregations and the monthly/yearly bucketing, which would otherwise be a query per bucket; and the readiness probe. Each is a `$queryRaw` tagged template, so its inputs are bound. The current list is in [SECURITY.md](./SECURITY.md#security-relevant-design); add to it there rather than starting a second count here. **`$queryRawUnsafe` must not appear in this codebase.**

### Frontend

- TypeScript throughout; `@/` aliases `src/` (configured in both `vite.config.ts` and `tsconfig.app.json` — update both).
- All HTTP goes through `lib/api.ts` so the auth interceptors apply.
- UI primitives come from `components/ui/` (shadcn/ui over Radix). Compose them; don't restyle from scratch.
- Tailwind v4; merge classes with `cn()` from `lib/utils`.
- Feedback via `sonner` toasts, never `alert()`.
- Icons from `lucide-react`.
- Hiding a nav item is not access control. Every admin-only screen also needs `authorize()` on the server.

### Both

- 2 spaces, double quotes, semicolons.
- Comments explain *why*, not *what*. The codebase favours a short note at a non-obvious decision over narration.

---

## Database changes

```bash
# 1. edit backend/prisma/schema.prisma
docker compose exec backend npx prisma migrate dev --name add_something
docker compose exec backend npx prisma generate
```

- A schema change **must** ship with its migration and an update to [`docs/03-data-model.md`](./docs/03-data-model.md).
- Migrations are forward-only. Don't edit one that has been applied anywhere but your machine.
- Prisma won't prompt for destructive-cast confirmation in a non-interactive shell. Use `--create-only`, review the SQL, then apply.
- Data migrations that touch money or stock ship **alone**, with a before/after reconciliation query in the PR.

---

## Testing

The backend has a Vitest + Supertest suite that runs against a real PostgreSQL database. CI runs it on every push and pull request.

```bash
docker compose exec \
  -e DATABASE_URL='postgresql://medadmin:medpass123@postgres:5432/medicaldb_test' \
  backend npm test

# or: npm run test:watch  /  npm run test:coverage
```

**`DATABASE_URL` must name a database ending in `_test`.** The suite empties every table between tests, so it refuses to start against anything else. That guard is the only thing standing between a mistyped variable and your dev data — don't remove it.

### Linting and formatting

Both halves lint. The backend's config is [`backend/eslint.config.js`](./backend/eslint.config.js) — flat config, CommonJS, on the same ESLint version line as the frontend so there is one toolchain rather than two.

```bash
cd backend
npm run lint          # runs in CI; fails the build
npm run format        # Prettier, 80 cols / 2 spaces / double quotes / semicolons
```

`format` is **not** a CI gate and is deliberately not applied across the tree: 13 files predate it and reformatting them belongs in its own commit, not buried in someone's bug fix. Run it on what you touched.

The lint rules are the ones where a violation is a defect rather than a preference — a stray `console.log` in `src/` (logging goes through pino), a loose `==` in code that compares money and stock, a `return` inside `finally`. Formatting is Prettier's job and is not duplicated as lint rules.

### Writing tests

- Use `tests/helpers/factory.js`: `buildApp()`, `signIn(app, "CASHIER")`, `makeSellable()`, `line()`. Rate limits are effectively off by default, so a test asserting a `401` never fails because an earlier test spent the budget.
- Put a **named regression guard** on any bug you fix, and say in a comment which one it guards. Several existing tests reference their `G-nn` — that's what stops a fix from quietly coming undone.
- Anything touching money asserts the invariants, not just the total: `cgst === sgst`, `subtotal + cgst + sgst − discountAmt === totalAmount`, and Σ line totals matching the header.
- Concurrency bugs need concurrent tests. `Promise.all` over a burst of requests is how the stock and numbering races are pinned down.

### The frontend suites

```bash
cd frontend
npm test          # 144 component and unit tests, seconds — needs Node 22
npm run test:e2e  # 7 browser flows — needs `docker compose up -d` first
```

Both run on CI. The browser smoke has its own job because the browser downloads
dominate it — Chromium costs about a minute and Firefox adds ~108 MB on top — so
lint, unit tests and the backend suite stay the fast signal.

Chromium runs all seven flows. Firefox runs exactly one: the CSV download, the
only flow built on browser machinery (a blob URL, a programmatic anchor click, a
`Content-Disposition` filename) rather than on ours. Running the rest twice would
double the job for no signal.

**What the browser layer is not for.** It catches wiring the other layers cannot
see — the proxy, the token round trip, the built client reaching the real API.
Business rules are proven cheaper and more precisely below it: GST arithmetic in
`invoice-create.test.js` and `cart-math.test.ts`, concurrency in
`invoice-concurrency.test.js`. Adding an arithmetic assertion to a browser test
makes the suite slower without making it more truthful.

Every screen now has component coverage — the list is in
[`docs/09` §5.6](./docs/09-testing-strategy.md). For UI changes outside those
paths, run the
[manual QA checklist](./docs/09-testing-strategy.md#7-manual-qa-checklist) and
say in the PR what you saw.

---

## Pull requests

### Branches

`feat/`, `fix/`, `docs/`, `chore/` + a short description: `fix/batch-update-validation`. `main` is the default and the PR target.

### Commit messages

Imperative mood, scoped by area, wrapped at ~72 characters:

```
billing: make invoice creation safe under concurrent checkout

The availability check ran before the transaction that deducted stock,
so two concurrent sales of the last unit both passed validation and
both committed, driving Batch.quantity negative.

The decrement is now its own guard - a conditional updateMany inside
the transaction that matches zero rows when another sale took the
units, rolling the whole invoice back.

Verified: 12 concurrent sales against a batch of 10 produce 10
invoices, 2 clean 400s and a final quantity of 0.
```

Scopes in use: `billing`, `inventory`, `auth`, `api`, `frontend`, `docs`, `chore`. Explain **why** the change is correct, not just what moved.

### Checklist

- [ ] `npm test` passes in `backend/`
- [ ] `npm run lint` passes in `backend/` **and** `frontend/`
- [ ] `npm run build` passes in `frontend/` — `tsc -b` catches type errors lint won't
- [ ] Schema changes ship with a migration
- [ ] New or changed endpoints are in [`docs/04-api-reference.md`](./docs/04-api-reference.md)
- [ ] New capabilities have an `FR-` id in [`docs/01-product-requirements.md`](./docs/01-product-requirements.md)
- [ ] Any doc your change contradicts has been updated
- [ ] No `.env`, credential or secret is staged
- [ ] The PR says how you verified it

### Review

Expect questions about correctness on anything touching money, stock or auth — that scrutiny is the point, not a comment on your work. Small PRs get reviewed faster.

---

## Reporting bugs

Use the [issue templates](./.github/ISSUE_TEMPLATE/). Useful reports include what you did, what you expected, what happened, and whether it reproduces on a fresh `docker compose up` with seeded data.

Check [`docs/08-gap-analysis.md`](./docs/08-gap-analysis.md) first — it may already be documented, with a diagnosis you can build on.

**Security vulnerabilities do not belong in the issue tracker.** See [SECURITY.md](./SECURITY.md).

---

## Licence

The repository ships an [MIT licence](./LICENSE), and contributions are accepted under those terms. `LICENSE`, both `package.json` files and the root README all agree as of 2026-08-20.
