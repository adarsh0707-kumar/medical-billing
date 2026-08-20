# Architecture

**Version:** 1.0.0 · **Reviewed:** 2026-08-17 · Supersedes [`Architecture.txt`](../Architecture.txt), which describes an earlier plan that the code diverged from.

---

## 1. Architectural style

A conventional **three-tier layered monolith**, containerised:

- **Presentation** — React SPA, all rendering client-side, no SSR.
- **Application** — a single stateless Express process exposing REST/JSON. Layered `routes → middleware → validator → controller → Prisma`.
- **Data** — PostgreSQL as the system of record; Redis provisioned as a cache but not yet used.

There is no service mesh, message queue, or background worker. Every operation is a synchronous request/response. This is a deliberate fit for the target deployment: one store, one host, a handful of concurrent users.

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
        RD[("redis:7-alpine<br/>:6379")]
    end

    Browser -->|"HTTP /"| Nginx
    Browser -->|"HTTP /api"| Nginx
    Nginx -->|"proxy /"| FE
    Nginx -->|"proxy /api"| BE
    BE -->|"Prisma / SQL"| PG
    BE -.->|"connected, unused"| RD
```

> **The SPA is same-origin.** It calls `/api/...` on whichever origin served it — Nginx on `:80`, or the Vite dev server on `:5173`, which proxies `/api` to the backend itself. Neither path is cross-origin, so CORS never applies to the browser; the allowlist exists only for tools that call port 5000 directly. Set `VITE_API_URL` only when the API genuinely lives on another host. *(Before 2026-08-19 the SPA called `:5000` directly and the `:80` entry point was unusable — [G-02](./08-gap-analysis.md#g-02).)*

### Containers at a glance

| Container    | Image / build                                         | Port (host:container) | Persistence            | Purpose                                     |
| ------------ | ----------------------------------------------------- | --------------------- | ---------------------- | ------------------------------------------- |
| `nginx`    | `nginx:alpine`                                      | 80:80                 | —                     | Single entry point; proxies SPA and`/api` |
| `frontend` | `./frontend/Dockerfile.dev` (node:20-slim)          | 5173:5173             | bind-mounted source    | Vite dev server with HMR                    |
| `backend`  | `./backend/Dockerfile.dev` (node:20-slim + openssl) | 5000:5000             | bind-mounted source    | Express API under nodemon                   |
| `postgres` | `postgres:15-alpine`                                | 5432:5432             | named volume`pgdata` | System of record                            |
| `redis`    | `redis:7-alpine`                                    | 6379:6379             | none                   | Cache (reserved)                            |

Start order is enforced: `backend` waits for Postgres to pass `pg_isready`; `frontend` waits for `backend`; `nginx` waits for both.

> **Both Dockerfiles are development images.** They run `npm run dev` / `nodemon`, mount source, and install dev dependencies. There is no production image, no multi-stage build, and no `vite build` served as static assets. See [Phase 8](./05-roadmap-and-phases.md#phase-8--production-readiness).

---

## 4. Backend component view

```
backend/src/
├── index.js                     Binds the port. Nothing else.
├── app.js                       createApp() factory — helmet → compression → morgan → CORS
│                                → json/urlencoded → rate limit (/api) → login limiter
│                                → /health → routers → notFound → errorHandler.
│                                A factory so tests mount the real stack without listening,
│                                and can dial rate limits down to exercise them.
├── config/
│   ├── db.js                    PrismaClient singleton; exits the process if connect fails
│   └── redis.js                 Redis client; connects, logs, never throws — imported by nothing
├── middlewares/
│   ├── auth.middleware.js       protect() verifies JWT + reloads user; authorize(...roles) RBAC
│   ├── validate.middleware.js   validate(zodSchema) — parses, replaces req.body, 400 on failure
│   └── error.middleware.js      notFound() + errorHandler() incl. Prisma P2002/P2003/P2025
├── validators/                  Zod schemas — billing.validator.js, inventory.validator.js
├── routes/                      auth · inventory · billing · user   (4 files, all mounted)
│                                customer · medicine · report · supplier  (4 EMPTY FILES)
├── controllers/                 auth · user · category · manufacturer · medicine · batch
│                                · supplier · customer · billing
└── utils/
    ├── jwt.utils.js             generateToken (7d) · generateRefreshToken (30d, unused)
    ├── invoice.utils.js         generateInvoiceNumber() · generatePurchaseNumber() (unused)
    └── seed.js                  Creates admin@medstore.com / admin123

backend/tests/                   278 tests — Vitest + Supertest against real PostgreSQL
├── setup/                       Database-name guard, migrations, per-test cleanup
├── helpers/factory.js           buildApp(), signed-in users by role, inventory fixtures
├── auth/                        Login, tokens, RBAC matrix, rate limiting
├── billing/                     GST fixtures, concurrency, reports, customers
├── inventory/                   Medicines, batches, master data
└── users/                       User administration
```

### Router mounting — the real map

`index.js` mounts exactly four routers. Resource grouping does **not** follow the file names:

| Mount              | Router file             | Resources served                                                            |
| ------------------ | ----------------------- | --------------------------------------------------------------------------- |
| `/api/auth`      | `auth.routes.js`      | login, register, me, change-password                                        |
| `/api/users`     | `user.routes.js`      | user CRUD + own-profile update                                              |
| `/api/inventory` | `inventory.routes.js` | categories, manufacturers,**medicines**, batches, **suppliers** |
| `/api/billing`   | `billing.routes.js`   | **customers**, invoices, daily summary, GST report                    |

Two consequences worth internalising before writing client code:

- **Customers live under `/api/billing/customers`**, not `/api/customers`.
- **Suppliers and medicines live under `/api/inventory/`**, not at the top level.
- There is no `customer.routes.js`, `medicine.routes.js`, `report.routes.js` or `supplier.routes.js`. Four zero-byte placeholders with those names were deleted on 2026-08-20 ([G-13](./08-gap-analysis.md#g-13)) because they implied routers that never existed. Re-grouping the URLs is queued for 2.0.0.

### Middleware order (`index.js`)

```
helmet()  →  compression()  →  morgan("dev")  →  cors(allowlist)
  →  express.json()  →  express.urlencoded()
  →  rateLimit(15 min / 500 req)  mounted on /api only
  →  GET /health          (outside the rate limiter)
  →  /api/auth  /api/inventory  /api/billing  /api/users
  →  notFound  →  errorHandler
```

Within a protected router the per-request chain is:

```
protect  →  authorize(...roles)  →  validate(schema)  →  controller
```

`protect` does a **database read on every request** to reload the user and check `isActive`. That is a correctness win (instant deactivation) at the cost of one query per call — the single most obvious candidate for the unused Redis cache.

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
├── hooks/useNotifications.ts    Polls expiring + low-stock every 5 min, builds alert objects
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

**State model.** There is no data-fetching library (no React Query/SWR). Each page owns its `useState` + `useEffect` fetch, and mutations are followed by an explicit refetch. Only auth (persisted) and notifications (ephemeral) are global. This keeps the mental model flat and is fine at current scale; it is also why the 7-day trend fires seven sequential-ish requests.

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

### 6.3 Dashboard load

Six requests fire in parallel via `Promise.all`:

| Call                                                   | Purpose                                         |
| ------------------------------------------------------ | ----------------------------------------------- |
| `GET /api/billing/invoices/daily-summary?date=today` | Today's sales, GST, payment-mode split          |
| `GET /api/billing/invoices?limit=8&page=1`           | Recent invoices table                           |
| `GET /api/inventory/batches/expiring?days=30`        | Expiry panel                                    |
| `GET /api/inventory/batches/low-stock?threshold=20`  | Low-stock panel                                 |
| `GET /api/inventory/medicines?limit=1`               | Total medicine count (from`pagination.total`) |
| `GET /api/billing/customers?limit=1`                 | Total customer count (from`pagination.total`) |

The last two fetch one row purely to read a count — cheap, but a dedicated `/stats` endpoint would be cleaner.

### 6.4 Alert polling

`useNotifications` runs inside `Layout`, so it is live on every authenticated page: two calls (`expiring?days=30`, `low-stock?threshold=10`) on mount and every 5 minutes, merged into notification objects with severity `danger` when ≤ 7 days to expiry. Errors are swallowed silently by design — a failed poll must not interrupt billing.

---

## 7. Cross-cutting concerns

| Concern          | Mechanism                                                                                                                                                                                            | Location                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Authentication   | JWT HS256,`Authorization: Bearer`, 7-day expiry, per-request DB reload                                                                                                                             | `auth.middleware.js`         |
| Authorisation    | `authorize(...roles)` → 403 with the required role named                                                                                                                                          | `auth.middleware.js`         |
| Validation       | Zod`safeParse`; on success `req.body` is **replaced** by parsed data (unknown keys dropped)                                                                                                | `validate.middleware.js`     |
| Error handling   | Central`errorHandler`; maps Prisma `P2002` → 409 (duplicate, with offending field), `P2003` → 409 (still referenced) and `P2025` → 404; stack included only when `NODE_ENV=development` | `error.middleware.js`        |
| 404 routing      | `notFound` builds `Route not found: <url>` and delegates                                                                                                                                         | `error.middleware.js`        |
| Logging          | `morgan("dev")` to stdout; Prisma logs queries in development                                                                                                                                      | `index.js`, `config/db.js` |
| Rate limiting    | 500 requests / 15 min,`/api` prefix only                                                                                                                                                           | `index.js`                   |
| CORS             | Explicit origin allowlist +`credentials: true`                                                                                                                                                     | `index.js`                   |
| Compression      | gzip on all responses                                                                                                                                                                                | `index.js`                   |
| Security headers | helmet defaults                                                                                                                                                                                      | `index.js`                   |
| Caching          | *None active*                                                                                                                                                                                      | —                             |

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

### Development (the only configured topology)

```
host:80   → nginx  ─┬─ /      → frontend:5173 (Vite HMR, WebSocket upgrade headers set)
                    └─ /api   → backend:5000
host:5173 → frontend  (direct)
host:5000 → backend   (direct)   ← for curl and tests; the SPA does not use it
host:5432 → postgres  (direct, exposed)
host:6379 → redis     (direct, exposed)
```

Source is bind-mounted (`./backend:/app`, `./frontend:/app`) with anonymous volumes preserving each container's `node_modules`. Editing a file on the host restarts nodemon / triggers HMR.

### Environment matrix

| Variable              | Service  | Compose value                                                | Notes                                                                                                      |
| --------------------- | -------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`      | backend  | `postgresql://medadmin:medpass123@postgres:5432/medicaldb` | Credentials are hard-coded in`docker-compose.yml`                                                        |
| `REDIS_URL`         | backend  | `redis://redis:6379`                                       | Client connects; nothing consumes it                                                                       |
| `JWT_SECRET`        | backend  | `${JWT_SECRET}`                                            | **Sourced from the host env / root `.env`** — no default; an unset value makes `jwt.sign` throw |
| `NODE_ENV`          | backend  | `development`                                              | Controls Prisma query logging and stack exposure                                                           |
| `PORT`              | backend  | defaults to 5000                                             | Read in`index.js`                                                                                        |
| `FRONTEND_URL`      | backend  | *(not set in compose)*                                     | Appended to the CORS allowlist when present                                                                |
| `VITE_API_URL`      | frontend | *(unset — relative `/api`)*                             | Baked into the bundle at build time; set only for a cross-host API                                         |
| `VITE_PROXY_TARGET` | frontend | `http://backend:5000`                                      | Where the Vite dev server forwards`/api`                                                                 |

`frontend/.env` exists but is **empty**, which is correct — the client calls `/api` on its own origin, so it needs no variables at all. The dev-server proxy target comes from `VITE_PROXY_TARGET` in compose and defaults to `http://localhost:5000` for a non-Docker run.

### Production gaps

The stack has no production path today. Minimum required before a real deployment — expanded in [Phase 8](./05-roadmap-and-phases.md#phase-8--production-readiness):

- ~~Multi-stage Dockerfiles; `vite build` output served statically by Nginx.~~ **Done 2026-08-20** — `backend/Dockerfile` and `frontend/Dockerfile`.
- ~~TLS termination and HSTS.~~ **Done** — `nginx/nginx.prod.conf`, plus the security headers and gzip the nginx README had long claimed.
- ~~Postgres credentials and `JWT_SECRET` from a secret store, not compose literals.~~ **Done** — `docker-compose.prod.yml` has no credential literals and refuses to start without them.
- ~~Remove host port exposure for Postgres and Redis.~~ **Done** — only 80 and 443 are published; Redis was removed entirely ([G-03](./08-gap-analysis.md#g-03)).
- ~~`app.set('trust proxy', …)`~~ **done** — set to `loopback, linklocal, uniquelocal` (override with `TRUST_PROXY`), so the rate limiter keys on the real client address rather than a spoofable header.
- ~~Backup/restore for the `pgdata` volume.~~ **Done** — `scripts/backup.sh` and `scripts/restore.sh`, rehearsed against the production stack.

---

## 9. Architecture decisions

| #     | Decision                                                                                                                         | Rationale                                                                                                  | Consequence / trade-off                                                                                                                                            |
| ----- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AD-01 | Monolithic Express API                                                                                                           | Invoice + stock must be one transaction; the domain is small                                               | Scales vertically only; the whole API redeploys as one unit                                                                                                        |
| AD-02 | Prisma over raw SQL/Sequelize                                                                                                    | Type-safe client, first-class migrations, easy`$transaction`                                             | Some query shapes (aggregations, trend series) are awkward and get pushed to the client                                                                            |
| AD-03 | Batch-level stock, not product-level                                                                                             | Pharmacy reality: price and expiry vary per batch                                                          | Every sale must resolve a batch, adding a step to search and the cart model                                                                                        |
| AD-04 | FEFO batch auto-selection                                                                                                        | Minimises expiry write-offs without operator effort                                                        | Operator cannot deliberately pick a different batch (FR-BILL-19)                                                                                                   |
| AD-05 | Snapshot medicine name and GST% onto invoice lines                                                                               | Historical invoices must never change when masters change                                                  | Denormalised data; renames don't propagate (correct here)                                                                                                          |
| AD-06 | Soft delete for medicines only                                                                                                   | Invoice lines and batches reference medicines                                                              | Inconsistent with hard-deleted suppliers/categories, which can fail on FK                                                                                          |
| AD-07 | JWT in`localStorage`, no refresh flow                                                                                          | Simplest client; the SPA is not cookie-based                                                               | XSS-exfiltratable; no server-side revocation ([07 — Security](./07-security.md))                                                                                   |
| AD-08 | Per-request user reload in`protect`                                                                                            | Deactivation takes effect immediately                                                                      | One extra query per request — prime cache candidate                                                                                                               |
| AD-09 | Zod at the route boundary                                                                                                        | Validation lives next to the contract, and strips unknown keys                                             | Any field absent from a schema is silently dropped — the cause of the`mfgDate` bug ([G-04](./08-gap-analysis.md#g-04))                                           |
| AD-10 | Zustand over Redux/Context                                                                                                       | Tiny surface for two small global stores                                                                   | No caching/invalidation layer; each page hand-rolls fetching                                                                                                       |
| AD-11 | shadcn/ui (source-vendored Radix components)                                                                                     | Full control of component source, no runtime UI dependency                                                 | 20 component files to maintain in-repo                                                                                                                             |
| AD-12 | Redis provisioned before it is used                                                                                              | Reserve the dependency and prove connectivity early                                                        | Dead dependency in the compose file; NFR-04 unmet                                                                                                                  |
| AD-13 | `DECIMAL(12,2)` for money, `Prisma.Decimal` for arithmetic, rounded half-up per line *(revised 2026-08-19; was `Float`)* | Exact totals; an invoice must reconcile with what it printed, and a month must reconcile with its invoices | Decimal objects must never meet the`+` operator, and are unwrapped to numbers by a `json replacer` at the response boundary ([G-07](./08-gap-analysis.md#g-07)) |
| AD-14 | Vite dev server behind Nginx even in "prod-ish" runs                                                                             | One entry point during development                                                                         | No production asset pipeline exists yet                                                                                                                            |

---

## 10. Scalability & performance notes

**Current ceiling.** One backend process, one Postgres instance. Comfortable for a single store: a few concurrent users, thousands of medicines, tens of thousands of invoices.

**First bottlenecks, in the order they will bite:**

1. **Invoice-number contention** — breaks at 2+ simultaneous checkouts, not at scale. Fix first.
2. **`protect` DB read on every request** — the highest-frequency query in the system. Cache the user by id in Redis with a short TTL and invalidate on user update.
3. **`contains` search without an index** — POS search does two `ILIKE %q%` scans; add a `pg_trgm` GIN index on `medicine.name` and `genericName` past ~10k rows.
4. **Unpaginated list endpoints** — batches, suppliers, users and masters return everything.
5. **Client-composed trend report** — 7 round trips for one chart; replace with a single server aggregation.
6. **Dashboard fan-out** — 6 requests per load, collapsible into one `/stats` call.

**Scaling out** would require: stateless backend replicas behind Nginx `upstream` (already stateless — JWT, no session store), Redis for shared cache, and a database sequence for invoice numbers. No code change is needed for horizontal scale *except* the numbering fix.
