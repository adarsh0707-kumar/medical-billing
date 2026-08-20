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

| URL | What |
|---|---|
| http://localhost:5173 | The app via the Vite dev server — **develop against this**, it has HMR |
| http://localhost | The same app via nginx, closest to a deployment |
| http://localhost:5000/health | The API directly |

Sign in with `admin@medstore.com` / `admin123`.

Both entry points serve the SPA and proxy `/api` to the backend on the **same origin**, so CORS never applies to the browser. Don't reintroduce an absolute API URL in the client.

Full setup, environment variables and troubleshooting: [`docs/06-development-guide.md`](./docs/06-development-guide.md).

---

## Finding something to work on

| Source | What's in it |
|---|---|
| [`docs/08-gap-analysis.md`](./docs/08-gap-analysis.md) | Known defects, each with a diagnosis and a suggested fix. Anything not marked ✅ Fixed is open |
| [`docs/05-roadmap-and-phases.md`](./docs/05-roadmap-and-phases.md) | Phased plan with exit criteria; Phase 9 (tests and CI) is the highest-value open work |
| [`docs/01-product-requirements.md`](./docs/01-product-requirements.md) | Every requirement with a status — `⬜ Planned` rows are unbuilt features |

If you're picking up a `G-nn` item, reference it in your PR. If you disagree with the diagnosis there, say so — several entries have already been corrected by the work of fixing them.

---

## Landmines

These are the things that have actually caused defects in this codebase. Each is cheap to avoid and expensive to miss.

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

### The URL layout is not what you'd guess

Routers are grouped by module, not by resource:

- customers live under **`/api/billing/customers`**
- medicines and suppliers live under **`/api/inventory/`**
- there is no `/api/customers`, `/api/medicines`, `/api/suppliers` or `/api/reports`

Re-grouping them would be a breaking change and is queued for 2.0.0. Until then, follow the existing layout. Full map: [`docs/04-api-reference.md`](./docs/04-api-reference.md).

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
- Raw SQL is a last resort. There is exactly one statement — the invoice-serial upsert, which needs the atomicity — and it uses a `$queryRaw` tagged template so its inputs are bound. **`$queryRawUnsafe` must not appear in this codebase.**

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

### Writing tests

- Use `tests/helpers/factory.js`: `buildApp()`, `signIn(app, "CASHIER")`, `makeSellable()`, `line()`. Rate limits are effectively off by default, so a test asserting a `401` never fails because an earlier test spent the budget.
- Put a **named regression guard** on any bug you fix, and say in a comment which one it guards. Several existing tests reference their `G-nn` — that's what stops a fix from quietly coming undone.
- Anything touching money asserts the invariants, not just the total: `cgst === sgst`, `subtotal + cgst + sgst − discountAmt === totalAmount`, and Σ line totals matching the header.
- Concurrency bugs need concurrent tests. `Promise.all` over a burst of requests is how the stock and numbering races are pinned down.

### What's still missing

Frontend unit tests and a Playwright browser smoke test. [`docs/09-testing-strategy.md`](./docs/09-testing-strategy.md) specifies both, and they're good first contributions. Until they exist, run the [manual QA checklist](./docs/09-testing-strategy.md#7-manual-qa-checklist) for UI changes and say in the PR what you saw.

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
- [ ] `npm run lint` passes in `frontend/`
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
