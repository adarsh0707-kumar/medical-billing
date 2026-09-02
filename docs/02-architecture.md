# Architecture

**Version:** 1.0.0 · **Reviewed:** 2026-08-17 · Supersedes [`Architecture.txt`](../Architecture.txt), which describes an earlier plan that the code diverged from.

---

## 1. Architectural style

A conventional **three-tier layered monolith**, containerised:

- **Presentation** — React SPA, all rendering client-side, no SSR.
- **Application** — a single stateless Express process exposing REST/JSON. Layered `routes → middleware → validator → controller → Prisma`.
- **Data** — PostgreSQL as the system of record. There is no cache layer: a Redis service was provisioned before it had a consumer and removed in Phase 8 without ever acquiring one ([G-03](./08-gap-analysis.md#g-03)).

There is no service mesh, message queue, or background worker. Every operation is a synchronous request/response. This is a deliberate fit for the target deployment: one host, a handful of concurrent users per shop. Since 2026-08-29 a single process serves **many** pharmacies — see [03 §3.0](./03-data-model.md#30-shop--the-tenant) — but each is a small shop, and they share the process rather than straining it.

**Why a monolith:** the domain is small and highly transactional (invoice + stock must commit together). Splitting billing from inventory would force a distributed transaction for the single most important write path in the product.

---

## 2. System context

```mermaid
graph TB
    Cashier["Cashier<br/><i>CASHIER</i>"]
    Pharma["Pharmacist<br/><i>PHARMACIST</i>"]
    Owner["Store owner<br/><i>ADMIN</i>"]

    subgraph MBS["Medical Billing System"]
        App["Web application<br/>React SPA + Express API"]
    end

    Printer["Browser print / thermal printer"]

    Cashier -->|"Sells, prints bills"| App
    Pharma -->|"Manages stock, suppliers, catalogue"| App
    Owner -->|"Reports, GST, user admin"| App
    App -->|"window.print()"| Printer
```

No external system integrations exist: no payment gateway, no GST portal, no SMS/email provider, no accounting export.

---

## 3. Container view

```mermaid
graph TB
    Browser["Browser<br/>React 19 SPA"]

    subgraph Docker["Docker Compose network"]
        Nginx["nginx:alpine<br/>:80"]
        FE["frontend<br/>Vite dev server :5173"]
        BE["backend<br/>Express 5 :5000"]
        PG[("postgres:15-alpine<br/>:5432<br/>volume pgdata")]
    end

    Browser -->|"HTTP /"| Nginx
    Browser -->|"HTTP /api"| Nginx
    Nginx -->|"proxy /"| FE
    Nginx -->|"proxy /api"| BE
    BE -->|"Prisma / SQL"| PG
```

> **The SPA is same-origin.** It calls `/api/...` on whichever origin served it — Nginx on `:80`, or the Vite dev server on `:5173`, which proxies `/api` to the backend itself. Neither path is cross-origin, so CORS never applies to the browser; the allowlist exists only for tools that call port 5000 directly. Set `VITE_API_URL` only when the API genuinely lives on another host. *(Before 2026-08-19 the SPA called `:5000` directly and the `:80` entry point was unusable — [G-02](./08-gap-analysis.md#g-02).)*

### Containers at a glance

| Container    | Image / build                                         | Port (host:container) | Persistence            | Purpose                                     |
| ------------ | ----------------------------------------------------- | --------------------- | ---------------------- | ------------------------------------------- |
| `nginx`    | `nginx:alpine`                                      | 80:80                 | —                     | Single entry point; proxies SPA and`/api` |
| `frontend` | `./frontend/Dockerfile.dev` (node:22-slim)          | 5173:5173             | bind-mounted source    | Vite dev server with HMR                    |
| `backend`  | `./backend/Dockerfile.dev` (node:22-slim + openssl) | 5000:5000             | bind-mounted source    | Express API under nodemon                   |
| `postgres` | `postgres:15-alpine`                                | 5432:5432             | named volume`pgdata` | System of record                            |

Start order is enforced: `backend` waits for Postgres to pass `pg_isready`; `frontend` waits for `backend`; `nginx` waits for both.

> **The images in the table above are the development ones** (`Dockerfile.dev`): they run `npm run dev` / `nodemon`, mount source, and install dev dependencies. Production images exist alongside them and are what `docker-compose.prod.yml` builds — `backend/Dockerfile` and `frontend/Dockerfile`, both two-stage, the backend self-contained under a non-root user and the frontend serving `vite build` output from nginx. See [Phase 8](./05-roadmap-and-phases.md#phase-8--production-readiness).

---

## 4. Backend component view

```
backend/src/
├── index.js                     Checks JWT_SECRET is set, then binds the port. Nothing else.
├── app.js                       createApp() factory — the whole middleware stack, listed below.
│                                A factory so tests mount the real stack without listening,
│                                and can dial rate limits down to exercise them.
├── config/
│   ├── db.js                    PrismaClient singleton; exits the process if connect fails.
│   │                            Applies the audit extension, and wraps $transaction so the
│   │                            audit row can join the caller's transaction rather than
│   │                            taking a second pooled connection.
│   ├── audit.js                 The audit trail, as a Prisma client extension. Was a $use
│   │                            middleware until 2026-08-31 — see docs/03 §3.12.
│   ├── audit-context.js         Two AsyncLocalStorage stores: the acting user (per request)
│   │                            and the current transaction client (per transaction).
│   ├── origins.js               The one web-origin allowlist. Read by the CORS middleware and
│   │                            by the CSRF guard, which answer different questions and must
│   │                            not drift apart.
│   └── logger.js                pino + pino-http. One JSON object per line in production,
│                                pretty in development, silent under test. Every request
│                                carries a correlation id echoed as X-Request-Id, and the
│                                redaction list covers tokens and every password field.
├── middlewares/
│   ├── auth.middleware.js       protect() verifies the JWT, then reloads the user — two
│   │                            separate catches, so a database fault is a 500 rather than
│   │                            a bad-credential 401 (G-18); authorize(...roles) RBAC
│   ├── password-change.middleware.js
│   │                            403 PASSWORD_CHANGE_REQUIRED while the flag is set, so the
│   │                            seeded admin cannot use the system until it is replaced
│   ├── csrf.middleware.js       requireKnownOrigin — an Origin allowlist check on
│   │                            POST /api/auth/refresh, the only cookie-authenticated route.
│   │                            Mounted ahead of CORS in app.js, or CORS would reject a
│   │                            foreign origin first and turn its 403 into a 500.
│   ├── validate.middleware.js   validate(zodSchema) — parses, replaces req.body, 400 on failure
│   ├── validate-query.middleware.js
│   │                            validateQuery(zodSchema) → req.validatedQuery. Deliberately
│   │                            NOT req.query: in Express 5 that is a getter, and assigning
│   │                            to it reads as working code while silently doing nothing
│   └── error.middleware.js      notFound() + errorHandler() incl. Prisma P2002/P2003/P2025
├── validators/                  Zod schemas — billing · common · inventory · shop · user
│                                · password (the shared strength rules, not a route schema)
├── routes/                      auth · shop · customer · medicine · supplier · report
│                                · inventory · billing · user · dashboard  (10, all mounted)
├── controllers/                 auth · user · shop · category · manufacturer · medicine
│                                · batch · supplier · customer · billing · dashboard
└── utils/
    ├── jwt.utils.js             generateToken (30m access) · generateRefreshToken (7d,
    │                            carries the RefreshToken row id as jti). Both embed
    │                            tokenVersion, which is what makes revocation work.
    ├── invoice.utils.js         generateInvoiceNumber() · generateCreditNoteNumber()
    │                            · isDuplicateNumber()
    ├── trend.js                 The daily sales trend, shared by /api/reports/trend and
    │                            the dashboard so the two cannot disagree. Buckets by the
    │                            store's LOCAL day, not UTC — see the file for why.
    └── seed.js                  Creates admin@medstore.com, flagged mustChangePassword

backend/tests/                   741 tests across 30 files — Vitest + Supertest, real PostgreSQL
├── setup/                       Database-name guard, migrations, per-test cleanup
├── helpers/factory.js           buildApp(), signed-in users by role, inventory fixtures
├── api/                         Query-parameter validation across all ten surfaces
├── auth/                        Login, tokens, RBAC matrix, rate limiting, forced password change
├── billing/                     GST fixtures, concurrency, void and credit notes, reports,
│                                customers
├── inventory/                   Medicines, batches, master data
└── users/                       User administration
```

### Router mounting — the real map

`app.js` mounts ten routers. **Since 2.0.0 the grouping is by resource**, so the URL a client wants is the one it would guess:

| Mount              | Router file             | Resources served                                                                          |
| ------------------ | ----------------------- | ----------------------------------------------------------------------------------------- |
| `/api/auth`      | `auth.routes.js`      | login, register, me, change-password                                                      |
| `/api/users`     | `user.routes.js`      | user CRUD + own-profile update                                                            |
| `/api/customers` | `customer.routes.js`  | customer CRUD + erasure                                                                   |
| `/api/medicines` | `medicine.routes.js`  | medicine CRUD + the POS`/search`                                                        |
| `/api/suppliers` | `supplier.routes.js`  | supplier CRUD                                                                             |
| `/api/reports`   | `report.routes.js`    | daily summary, monthly, yearly, top sellers, margin, GST, the Schedule H register, trend, expiring, low stock — and each one's CSV export |
| `/api/inventory` | `inventory.routes.js` | categories, manufacturers, batches                                                        |
| `/api/billing`   | `billing.routes.js`   | invoices, void and credit notes                                                           |
| `/api/dashboard` | `dashboard.routes.js` | `GET /stats` — every dashboard panel in one request ([G-08](./08-gap-analysis.md#g-08)) |
| `/api/shop`      | `shop.routes.js`      | the caller's own shop record — the business details an invoice header prints (Phase 12) |

**Before 2.0.0** the routers were grouped by *module*, and this was the single most common source of client confusion: customers were reachable only at `/api/billing/customers`, medicines and suppliers only under `/api/inventory/`, and the five reports were filed under whichever table each happened to read. Every one of those paths still works and is **deprecated** — they carry `Deprecation`, `Sunset` and `Link: rel="successor-version"` headers, log a warning naming the caller, and are removed in 2.1.0. See [`docs/04` §2a](./04-api-reference.md) for the full mapping.

What did **not** move, and why:

- **Batches, categories and manufacturers** stay under `/api/inventory`. They are stock-keeping concerns rather than resources a client reasons about on its own — a batch is only ever reached through the medicine it belongs to.
- **Invoices** stay under `/api/billing`. Billing is what they are, not the module that happens to own them.

`customer.routes.js`, `medicine.routes.js`, `report.routes.js` and `supplier.routes.js` now exist. Four zero-byte placeholders with exactly those names were deleted on 2026-08-20 ([G-13](./08-gap-analysis.md#g-13)) because they implied routers that did not exist; 2.0.0 is where they became real.

### Middleware order (`app.js`)

```
helmet()  →  compression()  →  pino-http (correlation id → X-Request-Id)
  →  set("trust proxy", TRUST_PROXY)      private ranges, not `true` — port 5000 is
  →  cors(allowlist)                      published, so X-Forwarded-For must not be forgeable
  →  set("json replacer", …)              unwraps Prisma Decimal to a JSON number
  →  express.json()  →  express.urlencoded()
  →  rateLimit(15 min / 500 req)          mounted on /api only
  →  rateLimit(15 min / 10 failures)      mounted on /api/auth/login, successes not counted
  →  GET /health  ·  GET /health/ready    (outside the rate limiter)
  →  /api/auth  /api/customers  /api/medicines  /api/suppliers  /api/reports
  →  /api/inventory  /api/billing  /api/users  /api/dashboard
  →  notFound  →  errorHandler
```

Within a protected router the per-request chain is:

```
protect  →  requirePasswordChange  →  authorize(...roles)  →  validate(schema)  →  controller
```

`validateQuery(schema)` takes `validate`'s place on read routes, landing its output on `req.validatedQuery`.

**`requirePasswordChange` is mounted by routing, not by an exemption list.** Four routers apply it with `router.use()`; `auth.routes.js` applies it per route, and deliberately omits it from `GET /me` and `PUT /change-password` — the two routes a blocked account needs in order to stop being blocked. Keeping the exemption in the routing rather than in a list inside the middleware means there is no second place for the two to drift apart.

`protect` does a **database read on every request** to reload the user and check `isActive`. That is a correctness win (instant deactivation) at the cost of one query per call — the most obvious candidate if a cache is ever introduced, though caching it trades directly against the immediate-deactivation guarantee that makes the read worth doing.

---

## 5. Frontend component view

```
frontend/src/
├── main.tsx / App.tsx           BrowserRouter; /login public, everything else wrapped in
│                                ProtectedRoute → Layout (Sidebar + Topbar + <Outlet/>)
├── lib/
│   ├── api.ts                   Axios instance; request interceptor attaches Bearer token
│   │                            from localStorage; response interceptor hard-redirects on 401
│   └── utils.ts                 cn() class merge helper
├── store/
│   ├── auth.store.ts            Zustand + persist("auth-storage") — user, token, isAuthenticated
│   └── notification.store.ts    In-memory alert list + unread count
├── hooks/
│   ├── useNotifications.ts     Polls expiring + low-stock every 5 min into the notification store
│   ├── useMasters.ts           Shared category / manufacturer / supplier queries
│   └── useDebounced.ts         Settles an input before it becomes a query key
├── components/
│   ├── ProtectedRoute.tsx       Redirects to /login when not authenticated
│   ├── layout/                  Layout · Sidebar (role-filtered nav) · Topbar (alerts, user menu)
│   └── ui/                      20 shadcn/ui primitives over Radix
├── pages/
│   ├── Login.tsx                POST /api/auth/login → store → /dashboard
│   ├── Dashboard.tsx            6 parallel calls: daily summary, recent invoices, expiring,
│   │                            low stock, medicine count, customer count
│   ├── Billing.tsx              POS: debounced search, cart, totals, invoice POST, print
│   ├── Inventory.tsx            Tabs: Medicines · Batches · Categories/Manufacturers · Suppliers
│   ├── Customers.tsx            Searchable list + create/edit dialog
│   ├── Suppliers.tsx            Searchable list + create/edit dialog
│   ├── Reports.tsx              Tabs: Daily · GST · Stock Alerts · Sales Trend (Recharts)
│   └── Settings.tsx             Tabs: Profile · Password · Users (ADMIN only)
└── types/index.ts               Role, User, AuthState only — API payloads are typed per-page
```

**State model.** Three kinds of state, kept apart on purpose.

*Server state* is **TanStack Query** (`@tanstack/react-query`, adopted 2026-08-24). Every read goes through `useQuery` with a key describing exactly what it asked for — `["medicines", page, search, categoryFilter]`, `["gst-report", month, year]` — and every `queryFn` forwards the query's `AbortSignal` to axios. Mutations are still plain `api.post`/`put`/`delete` calls followed by `invalidateQueries`, which is the same "write then refetch" shape as before, except the refetch reaches every component holding that key instead of only the one that wrote.

*Client state* stays `useState`: form fields, dialogs, the current page number, the search box.

*Global state* is Zustand, and only for the two things that are genuinely global: auth (persisted) and notifications (ephemeral). The notification store survived the migration because it owns read/unread, which no server response knows about — the fetching underneath it moved, the store did not.

Until this change each page owned its own `useState` + `useEffect` fetch. Nothing was incorrect, but the pattern *cannot express cancellation*: a response for a screen the user has left still resolves and still calls `setState`, so a slow request could land on top of a fresh one. Eleven call sites also hand-rolled `loading` and error handling separately, which is how their error messages drifted apart. Both are now one thing each — a shared `QueryClient` in [`frontend/src/lib/query-client.ts`](../frontend/src/lib/query-client.ts) raises one toast per failed query, overridable per call via `meta.errorMessage` ([G-16](./08-gap-analysis.md#g-16)).

Shared reads are shared for real: [`useMasters.ts`](../frontend/src/hooks/useMasters.ts) holds categories, manufacturers and suppliers, which four tabs used to fetch independently, and the alert bell and the Reports stock panel now hit the same cache entry for the same 30-day window.

**Route protection is defence in depth, not the control.** `ProtectedRoute` and the role-filtered sidebar are UX; the server's `authorize()` is the actual boundary.

---

## 6. Key runtime flows

### 6.1 Sign-in

```mermaid
sequenceDiagram
    participant U as User
    participant SPA as React SPA
    participant API as Express
    participant DB as PostgreSQL

    U->>SPA: email + password
    SPA->>API: POST /api/auth/login
    API->>DB: SELECT user WHERE email
    DB-->>API: user row
    API->>API: reject if !isActive
    API->>API: bcrypt.compare(password, hash)
    API->>API: jwt.sign({id}, JWT_SECRET, 7d)
    API-->>SPA: 200 { token, user }
    SPA->>SPA: localStorage.token + zustand persist
    SPA-->>U: redirect /dashboard
```

Invalid email and wrong password return the **same** `401 "Invalid credentials."` — no user enumeration.

### 6.2 Creating an invoice (the critical path)

```mermaid
sequenceDiagram
    participant SPA as Billing page
    participant API as Express
    participant Z as Zod validator
    participant DB as PostgreSQL

    SPA->>API: POST /api/billing/invoices  (Bearer)
    API->>DB: protect → reload user
    API->>Z: createInvoiceSchema.safeParse(body)
    Z-->>API: typed body (unknown keys stripped)

    loop each line
        API->>DB: SELECT batch WHERE id
        API->>API: 404 if missing · 400 if qty > stock
    end

    API->>API: per line: taxable, gst, cgst=sgst=gst/2, lineTotal
    API->>API: totalAmount = Σtaxable + Σcgst + Σsgst − discountAmt
    API->>DB: INSERT … ON CONFLICT on InvoiceCounter → INVyymmdd-nnnn

    rect rgb(235,245,235)
    Note over API,DB: prisma.$transaction
    API->>DB: INSERT invoice + nested invoice_items
    loop each line
        API->>DB: UPDATE batch SET quantity = quantity − qty
    end
    end

    API-->>SPA: 201 { invoice with items, customer, user }
    SPA->>SPA: setTimeout(window.print, 500)
```

**Concurrency (fixed 2026-08-18).** The pre-transaction stock check is advisory — it fails fast with a friendly message. The authoritative guard is the decrement itself, a conditional `updateMany` inside the transaction that matches zero rows when another sale took the units, rolling the whole invoice back. The serial likewise comes from an atomic per-day `InvoiceCounter` upsert inside the same transaction, not from a `COUNT()`. See [G-09](./08-gap-analysis.md#g-09) and [G-01](./08-gap-analysis.md#g-01) for the before/after and the verification runs.

### 6.3 Dashboard load — superseded

**One request:** `GET /api/dashboard/stats` returns every panel ([G-08](./08-gap-analysis.md#g-08)).

It replaced the six parallel calls below, which are kept as the record of what the measurement was taken against — **794 KB / 159 ms → 6 KB / 19 ms**. The paths are the ones in use at the time; several moved in 2.0.0, and none of these calls is made any more:

| Call (historical, pre-G-08)                            | Purpose                                         |
| ------------------------------------------------------ | ----------------------------------------------- |
| `GET /api/billing/invoices/daily-summary?date=today` | Today's sales, GST, payment-mode split          |
| `GET /api/billing/invoices?limit=8&page=1`           | Recent invoices table                           |
| `GET /api/inventory/batches/expiring?days=30`        | Expiry panel                                    |
| `GET /api/inventory/batches/low-stock?threshold=20`  | Low-stock panel                                 |
| `GET /api/inventory/medicines?limit=1`               | Total medicine count (from`pagination.total`) |
| `GET /api/billing/customers?limit=1`                 | Total customer count (from`pagination.total`) |

The last two fetched one row purely to read a count out of `pagination.total` — which is what made "six calls" really thirteen once the seven-day chart was included.

### 6.4 Alert polling

`useNotifications` runs inside `Layout`, so it is live on every authenticated page: two calls (`expiring?days=30`, `low-stock?threshold=10`) on mount and every 5 minutes, merged into notification objects with severity `danger` when ≤ 7 days to expiry. Errors are swallowed silently by design — a failed poll must not interrupt billing.

---

## 7. Cross-cutting concerns

| Concern                | Mechanism                                                                                                                                                                                            | Location                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Authentication         | JWT HS256,`Authorization: Bearer`, 30-minute access token carrying `{ id, tokenVersion }`, per-request DB reload; the 7-day half is a rotating `HttpOnly` refresh cookie                       | `auth.middleware.js`            |
| Authorisation          | `authorize(...roles)` → 403 with the required role named                                                                                                                                          | `auth.middleware.js`            |
| Forced password change | `403 PASSWORD_CHANGE_REQUIRED` on every route but reading your own profile and changing your password, while `User.mustChangePassword` is set                                                    | `password-change.middleware.js` |
| Body validation        | Zod`safeParse`; on success `req.body` is **replaced** by parsed data (unknown keys dropped)                                                                                                | `validate.middleware.js`        |
| Query validation       | Zod`safeParse` onto **`req.validatedQuery`** — never `req.query`, which is a getter in Express 5. Absent means default; present but unparseable is a 400                                | `validate-query.middleware.js`  |
| Money on the wire      | An Express`json replacer` unwraps `Prisma.Decimal` to a JSON number, so exactness lives in storage and arithmetic while the API contract stays numeric                                           | `app.js`                        |
| Error handling         | Central`errorHandler`; maps Prisma `P2002` → 409 (duplicate, with offending field), `P2003` → 409 (still referenced) and `P2025` → 404; stack included only when `NODE_ENV=development` | `error.middleware.js`           |
| 404 routing            | `notFound` builds `Route not found: <url>` and delegates                                                                                                                                         | `error.middleware.js`           |
| Logging                | **pino** — one JSON object per line in production, pretty in development, silent under test. A correlation id per request, echoed as `X-Request-Id`; tokens and password fields redacted    | `config/logger.js`              |
| Rate limiting          | 500 requests / 15 min on`/api`, plus 10 **failed** logins / 15 min on `/api/auth/login`. Keyed on the real client via `trust proxy`                                                      | `app.js`                        |
| CORS                   | Explicit origin allowlist +`credentials: true`. In production the allowlist is exactly `CORS_ORIGINS`; the development origins are not appended                                                  | `app.js`                        |
| Compression            | gzip on all responses                                                                                                                                                                                | `app.js`                        |
| Security headers       | helmet defaults on API responses; the SPA's CSP and HSTS come from nginx in production                                                                                                               | `app.js`, `nginx.prod.conf`   |
| Health                 | `/health` is liveness and touches nothing, and reports the `version` and short `commit` of the running build so "is production current?" is one request rather than an inference; `/health/ready` runs `SELECT 1` and answers 503 when the database is unreachable | `app.js`                        |
| Caching                | *None.* The Redis service was removed in Phase 8 without ever acquiring a consumer ([G-03](./08-gap-analysis.md#g-03))                                                                              | —                                |

### Response envelope

Every controller returns the same shape, which is what makes the client's error handling uniform:

```jsonc
// success
{ "success": true, "data": <object|array>, "message": "…", "pagination": { … } }

// failure
{ "success": false, "message": "…", "errors": [ { "field": "…", "message": "…" } ] }
```

Note `message` — not `error` / `statusCode`, which the root README claimed until it was corrected on 2026-08-20. Full catalogue in [04 — API Reference](./04-api-reference.md#5-error-format).

---

## 8. Deployment topology

Two topologies are configured: `docker-compose.yml` for development and `docker-compose.prod.yml` for deployment. They are not variants of one file — the differences are the point.

### Development (`docker-compose.yml`)

```
host:80   → nginx  ─┬─ /      → frontend:5173 (Vite HMR, WebSocket upgrade headers set)
                    └─ /api   → backend:5000
host:5173 → frontend  (direct)
host:5000 → backend   (direct)   ← for curl and tests; the SPA does not use it
host:5432 → postgres  (direct, exposed)
```

Source is bind-mounted (`./backend:/app`, `./frontend:/app`) with anonymous volumes preserving each container's `node_modules`. Editing a file on the host restarts nodemon / triggers HMR.

> On some host filesystems — external or network-mounted volumes in particular — inotify events do not cross the bind mount, so nodemon never sees the write and keeps serving the old code. If a change appears to have no effect, `docker compose restart backend` before doubting the change.

### Production (`docker-compose.prod.yml`)

```
host:443 → nginx  ─┬─ /      → frontend:80    (static `vite build` output, no Node at runtime)
                   └─ /api   → backend:5000
host:80  → nginx     301 → https://$host$request_uri
                     postgres — internal network only, no published port
```

The differences that matter:

- **No bind mounts.** What runs is what was built, not whatever is in the working tree.
- **Postgres publishes no host port.** It is reachable only on the compose network, which is the difference between a password being a defence and being the only defence.
- **No credential literals.** Every value comes from `.env.prod`, and the compose file fails fast with a named error if any is unset. `DATABASE_URL` is composed from the same variables Postgres uses, so the two cannot drift.
- **`restart: unless-stopped`** everywhere, with healthcheck-gated startup and a `pgdata_prod` volume distinct from the development stack's — Postgres only applies `POSTGRES_USER`/`PASSWORD` when initialising an empty data directory, so sharing a volume would silently keep the development credentials.

Setup, TLS certificates, backup and restore: [06 — Development Guide](./06-development-guide.md#running-in-production).

### Environment matrix

| Variable              | Service  | Compose value                                                | Notes                                                                                                                                     |
| --------------------- | -------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`      | backend  | `postgresql://medadmin:medpass123@postgres:5432/medicaldb` | Credentials are hard-coded in`docker-compose.yml`                                                                                       |
| `JWT_SECRET`        | backend  | `${JWT_SECRET}`                                            | **Sourced from the host env / root `.env`** — no default; the API refuses to start without it ([D-15](./08-gap-analysis.md#d-15)) |
| `NODE_ENV`          | backend  | `development`                                              | Controls Prisma query logging and stack exposure                                                                                          |
| `PORT`              | backend  | defaults to 5000                                             | Read in`index.js`                                                                                                                       |
| `FRONTEND_URL`      | backend  | *(not set in compose)*                                     | Appended to the CORS allowlist when present                                                                                               |
| `VITE_API_URL`      | frontend | *(unset — relative `/api`)*                             | Baked into the bundle at build time; set only for a cross-host API                                                                        |
| `VITE_PROXY_TARGET` | frontend | `http://backend:5000`                                      | Where the Vite dev server forwards`/api`                                                                                                |

`frontend/.env` exists but is **empty**, which is correct — the client calls `/api` on its own origin, so it needs no variables at all. The dev-server proxy target comes from `VITE_PROXY_TARGET` in compose and defaults to `http://localhost:5000` for a non-Docker run.

### Production readiness

Everything [Phase 8](./05-roadmap-and-phases.md#phase-8--production-readiness) listed as a blocker has shipped:

| Was missing                                           | Now                                                                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Multi-stage images;`vite build` served statically   | `backend/Dockerfile` and `frontend/Dockerfile`. The frontend image is nginx serving static output, with no Node at runtime                         |
| TLS termination and HSTS                              | `nginx/nginx.prod.conf` — TLS 1.2/1.3, HSTS at one year, 80 → 443, plus a CSP, `X-Frame-Options`, `Referrer-Policy` and `Permissions-Policy` |
| Credentials from a secret store, not compose literals | `docker-compose.prod.yml` has none, and refuses to start without them                                                                                |
| Host port exposure on the data tier                   | Only 80 and 443 are published; Redis was removed entirely ([G-03](./08-gap-analysis.md#g-03))                                                           |
| `app.set('trust proxy', …)`                        | `loopback, linklocal, uniquelocal`, overridable with `TRUST_PROXY`, so the limiter keys on the real client rather than a spoofable header          |
| Structured logs                                       | pino, with a correlation id echoed as`X-Request-Id`                                                                                                  |
| A readiness probe                                     | `/health/ready` runs `SELECT 1` and answers 503 when the database is unreachable                                                                   |
| Backup and restore                                    | `scripts/backup.sh` and `scripts/restore.sh`, rehearsed against the production stack by dropping the schema and restoring it                       |
| The seeded admin password                             | Enforced, not requested —`403 PASSWORD_CHANGE_REQUIRED` until it is replaced                                                                        |

**Two things remain the operator's**, and no configuration can decide them: a real TLS certificate in place of the self-signed one `scripts/gen-cert.sh` generates, and a retention period for customer records. Both are in [SECURITY.md](../SECURITY.md#for-operators).

---

## 9. Architecture decisions

| #     | Decision                                                                                                                         | Rationale                                                                                                                       | Consequence / trade-off                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AD-01 | Monolithic Express API                                                                                                           | Invoice + stock must be one transaction; the domain is small                                                                    | Scales vertically only; the whole API redeploys as one unit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| AD-02 | Prisma over raw SQL/Sequelize                                                                                                    | Type-safe client, first-class migrations, easy`$transaction`                                                                  | Some query shapes (aggregations, trend series) are awkward and get pushed to the client                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| AD-03 | Batch-level stock, not product-level                                                                                             | Pharmacy reality: price and expiry vary per batch                                                                               | Every sale must resolve a batch, adding a step to search and the cart model                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| AD-04 | FEFO batch auto-selection,**overridable since 2026-08-24**                                                                 | Minimises expiry write-offs without operator effort                                                                             | Was: operator could not pick a different batch. FEFO is now the*default* rather than the only option — search returns every sellable batch and the POS offers a picker, so the two cases FEFO cannot see (customer needs a specific pack; the earliest-expiring pack is at the back of the shelf) no longer require a workaround. Cost: the override is a second click, and a shop that uses it carelessly loses the write-off protection this decision bought. Expired batches are excluded from selection entirely — as earliest-expiring they used to *become* the default ([G-20](./08-gap-analysis.md#g-20)) |
| AD-05 | Snapshot medicine name and GST% onto invoice lines                                                                               | Historical invoices must never change when masters change                                                                       | Denormalised data; renames don't propagate (correct here)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| AD-06 | Soft delete for medicines only                                                                                                   | Invoice lines and batches reference medicines                                                                                   | Inconsistent with hard-deleted suppliers/categories, which can fail on FK                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| AD-07 | JWT in`localStorage`, no refresh flow                                                                                          | Simplest client; the SPA is not cookie-based                                                                                    | XSS-exfiltratable; no server-side revocation ([07 — Security](./07-security.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| AD-08 | Per-request user reload in`protect`                                                                                            | Deactivation takes effect immediately                                                                                           | One extra query per request — prime cache candidate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| AD-09 | Zod at the route boundary                                                                                                        | Validation lives next to the contract, and strips unknown keys                                                                  | Any field absent from a schema is silently dropped — the cause of the`mfgDate` bug ([G-04](./08-gap-analysis.md#g-04))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| AD-10 | Zustand over Redux/Context,**for client state only** *(revised 2026-08-24)*                                              | Tiny surface for two small global stores                                                                                        | Was: no caching/invalidation layer, each page hand-rolled fetching. Server state moved to TanStack Query ([G-16](./08-gap-analysis.md#g-16)); Zustand keeps auth and the notification store, which owns read/unread that no response carries. The split is now the rule: if it came from the API it belongs to a query key                                                                                                                                                                                                                                                                                              |
| AD-11 | shadcn/ui (source-vendored Radix components)                                                                                     | Full control of component source, no runtime UI dependency                                                                      | 20 component files to maintain in-repo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| AD-12 | Redis provisioned before it is used —**reversed in Phase 8**                                                              | Reserve the dependency and prove connectivity early                                                                             | It never acquired a consumer, so it was a running service and a documented feature that did nothing. Removed rather than secured ([G-03](./08-gap-analysis.md#g-03)); NFR-04 is now explicitly unmet rather than notionally pending                                                                                                                                                                                                                                                                                                                                                                                     |
| AD-13 | `DECIMAL(12,2)` for money, `Prisma.Decimal` for arithmetic, rounded half-up per line *(revised 2026-08-19; was `Float`)* | Exact totals; an invoice must reconcile with what it printed, and a month must reconcile with its invoices                      | Decimal objects must never meet the`+` operator, and are unwrapped to numbers by a `json replacer` at the response boundary ([G-07](./08-gap-analysis.md#g-07))                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| AD-14 | Vite dev server behind Nginx even in "prod-ish" runs                                                                             | One entry point during development                                                                                              | No production asset pipeline exists yet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| AD-15 | Request types**generated** from the Zod schemas, not shared as a package *(2026-08-24)*                                  | The backend already defines every contract once; the frontend was re-declaring the same shapes and drifting in silence (NFR-22) | A build step: change a schema and`npm run types:check` fails until `types:generate` is re-run and the output committed. Chosen over a shared package because the backend is CommonJS and the frontend ESM — types are erased before runtime, so a generated file crosses that boundary where a module cannot, and neither Docker context has to change. Covers **requests only**; responses are still typed per page                                                                                                                                                                                        |

---

## 10. Scalability & performance notes

**Current ceiling.** One backend process, one Postgres instance, shared by every shop on the installation. Comfortable for a handful of small pharmacies: a few concurrent users each, thousands of medicines, tens of thousands of invoices. The tenancy model puts no ceiling on shop *count* — every table is indexed on `shopId` — but they compete for one connection pool, which is where the limit will show up first.

**First bottlenecks, in the order they will bite:**

1. **Invoice-number contention** — breaks at 2+ simultaneous checkouts, not at scale. Fix first.
2. **`protect` DB read on every request** — the highest-frequency query in the system. Caching the user by id with a short TTL is the obvious answer, but it needs a cache store reintroduced (there is none since Phase 8) and it weakens instant deactivation. Measure before doing either.
3. **`contains` search without an index** — POS search does two `ILIKE %q%` scans; add a `pg_trgm` GIN index on `medicine.name` and `genericName` past ~10k rows.
4. **Unpaginated list endpoints** — batches, suppliers, users and masters return everything.
5. **Client-composed trend report** — 7 round trips for one chart; replace with a single server aggregation.
6. **Dashboard fan-out** — 6 requests per load, collapsible into one `/stats` call.

**Scaling out** would require: stateless backend replicas behind Nginx `upstream` (already stateless — JWT, no session store), a shared cache store if one is wanted (none is deployed), and a database sequence for invoice numbers. No code change is needed for horizontal scale *except* the numbering fix.
