# API Reference

**Version:** 1.0.0 · **Verified against source:** 2026-08-17

This document lists **every endpoint that exists**. It was written by reading `backend/src/routes/*` and the controllers they mount. Endpoints listed in `backend/README.md` but absent from the code are catalogued in [§10](#10-endpoints-that-do-not-exist).

---

## 1. Base URL

| Environment             | Base URL                      | Notes                                                        |
| ----------------------- | ----------------------------- | ------------------------------------------------------------ |
| Via Nginx               | `http://localhost/api`      | The entry point. Same-origin for the SPA                     |
| Via the Vite dev server | `http://localhost:5173/api` | Proxied to the backend; also same-origin                     |
| Direct                  | `http://localhost:5000`     | The API itself. For curl, Postman and server-to-server calls |

All paths below are absolute from the host root, e.g. `POST http://localhost:5000/api/auth/login`.

## 2. Router map

Five routers are mounted. **Resource paths do not follow the obvious REST grouping** — read this table before writing a client.

| Prefix             | Resources                                                                           |
| ------------------ | ----------------------------------------------------------------------------------- |
| `/api/auth`      | login · register · me · change-password                                          |
| `/api/users`     | user CRUD · own profile                                                            |
| `/api/inventory` | categories · manufacturers ·**medicines** · batches · **suppliers** |
| `/api/billing`   | **customers** · invoices · void · daily-summary · trend · gst-report   |
| `/api/dashboard` | `stats` — every dashboard panel in one request                                    |

> Customers are under **`/api/billing/customers`**. Suppliers and medicines are under **`/api/inventory/`**. There is no `/api/customers`, `/api/medicines`, `/api/suppliers` or `/api/reports`.

## 3. Authentication

Every endpoint except `POST /api/auth/login` and `GET /health` requires:

```http
Authorization: Bearer <jwt>
```

The token comes from `POST /api/auth/login`, is signed HS256 with `JWT_SECRET`, and expires in **30 minutes**. On each request the server decodes it and **reloads the user from the database**, so a deactivated (`isActive = false`) or deleted user is rejected immediately regardless of token validity.

**A session lasts a week; the access token does not.** Login also sets a **`refresh_token` cookie** — `HttpOnly`, `SameSite=Strict`, `Path=/api/auth`, `Secure` in production — valid for 7 days. When the access token expires, `POST /api/auth/refresh` exchanges the cookie for a new one. The split is the point: the access token lives in `localStorage` where script can read it, so it is short; the week-long half is in a cookie JavaScript cannot touch. Putting both in `localStorage` would have been worse than the single 7-day token it replaced.

A client should treat a `401` on an ordinary call as "try refreshing once, then give up" rather than as a sign-out — see the note under `/api/auth/refresh`.

| Failure                                               | Status        | Body message                                          |
| ----------------------------------------------------- | ------------- | ----------------------------------------------------- |
| Header missing or not`Bearer …`                    | 401           | `Access denied. No token provided.`                 |
| Signature invalid / malformed                         | 401           | `Invalid token.`                                    |
| Expired                                               | 401           | `Token expired.`                                    |
| Not valid yet (`nbf` in the future)                 | 401           | `Invalid token.`                                    |
| User deleted or deactivated                           | 401           | `User not found or deactivated.`                    |
| Revoked by a logout                                   | 401           | `Session ended. Please sign in again.`              |
| Refresh cookie missing, expired, replayed or revoked  | 401           | `Session expired. Please sign in again.`            |
| Authenticated but wrong role                          | 403           | `Access denied. Required role: ADMIN or PHARMACIST` |
| **Database unreachable during the user reload** | **500** | The underlying error                                  |

The 500 row matters to clients. Token verification and the user reload are checked separately, so a database failure is **not** reported as a bad token ([G-18](./08-gap-analysis.md#g-18)). A client that signs the user out on 401 — as `frontend/src/lib/api.ts` does — must not treat a 500 the same way, or a transient database fault becomes a forced logout for everyone.

> An unset `JWT_SECRET` no longer reaches this layer: `src/index.js` checks it at boot and exits with a named error rather than starting. Until 2026-08-20 it surfaced here as `401 Invalid token.` on every request, because `jsonwebtoken` reports a missing secret as a `JsonWebTokenError` — indistinguishable from a forged one ([D-15](./08-gap-analysis.md#d-15)).

## 4. Role matrix

`ADMIN` › `PHARMACIST` › `CASHIER`. A blank cell means the role receives `403`.

| Capability                                                               | ADMIN | PHARMACIST | CASHIER |
| ------------------------------------------------------------------------ | :---: | :--------: | :-----: |
| Log in, read own profile, change own password, update own profile        |  ✅  |     ✅     |   ✅   |
| List / create / update / delete users                                    |  ✅  |            |        |
| Register user via`/api/auth/register`                                  |  ✅  |            |        |
| Read categories, manufacturers, medicines, batches, suppliers            |  ✅  |     ✅     |   ✅   |
| Create / update categories, manufacturers, medicines, batches, suppliers |  ✅  |     ✅     |        |
| Delete categories, manufacturers, medicines, suppliers                   |  ✅  |            |        |
| Read customers, create / update customers                                |  ✅  |     ✅     |   ✅   |
| Read a customer's**purchase history**                              |  ✅  |     ✅     |        |
| Erase a customer's personal data                                         |  ✅  |            |        |
| Read invoices, create invoices, daily summary, sales trend               |  ✅  |     ✅     |   ✅   |
| Dashboard stats                                                          |  ✅  |     ✅     |   ✅   |
| Void an invoice                                                          |  ✅  |            |        |
| GST report                                                               |  ✅  |     ✅     |        |

## 5. Conventions

### Success envelope

```jsonc
{
  "success": true,
  "data": { },            // object or array
  "message": "…",         // present on writes
  "pagination": {          // list endpoints that paginate
    "total": 137, "page": 1, "limit": 20, "pages": 7
  }
}
```

### Error envelope

```jsonc
{ "success": false, "message": "Human readable reason" }
```

Validation failures add a field-level array:

```jsonc
{
  "success": false,
  "message": "Validation failed",
  "errors": [ { "field": "items.0.quantity", "message": "Quantity must be positive" } ]
}
```

In `NODE_ENV=development` unhandled errors also carry a `stack` string.

> The root `README.md` documented `{ "success": false, "error": "...", "statusCode": 400 }` until 2026-08-20. That shape was never produced by any code path. The key is `message`.

### Query parameters

Every query string is validated before its controller runs (since 2026-08-20). A rejection is a `400` with the same field-level array as a body failure, under `"message": "Invalid query parameters"`:

```jsonc
{
  "success": false,
  "message": "Invalid query parameters",
  "errors": [ { "field": "limit", "message": "limit must be at most 100" } ]
}
```

The rule is uniform: **absent means use the default; present but unparseable or out of range is a `400`.** A value is never silently corrected — `?days=abc` used to fall through `Number(x) || 30` and return a 30-day window indistinguishable from a deliberate one.

| Parameter                      | Endpoints                                 | Rule                                                                                                                                                                                                    |
| ------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page`                       | medicines, customers, invoices            | Integer ≥ 1. Default`1`                                                                                                                                                                              |
| `limit`                      | medicines, customers, invoices            | Integer 1–**100**. Default `20`. Over the maximum is **rejected, not clamped** — a caller who asks for 999999 and quietly receives 100 would page through the set believing it complete |
| `search`                     | medicines, customers, invoices, suppliers | String, max 200 chars. An empty string means no filter, not a bad request                                                                                                                               |
| `categoryId`                 | medicines                                 | Non-empty string                                                                                                                                                                                        |
| `q`                          | medicines/search                          | String, max 200. Under 2 characters returns`[]` rather than a 400 — the POS box calls this on every keystroke                                                                                        |
| `startDate`, `endDate`     | invoices                                  | Dates. Both must be present for the filter to apply                                                                                                                                                     |
| `paymentMode`                | invoices                                  | `CASH` · `UPI` · `CARD` · `CREDIT`                                                                                                                                                           |
| `paymentStatus`              | invoices                                  | `PAID` · `PENDING` · `PARTIAL`                                                                                                                                                                  |
| `date`                       | invoices/daily-summary                    | Date. Default today                                                                                                                                                                                     |
| `month`, `year`            | invoices/gst-report                       | **Both required.** `month` 1–12, `year` 2000–2100                                                                                                                                           |
| `days`                       | batches/expiring                          | Integer 1–365. Default`30`                                                                                                                                                                           |
| `threshold`                  | batches/low-stock                         | Integer 1–100000. Default`10`                                                                                                                                                                        |
| `medicineId`                 | batches                                   | Non-empty string                                                                                                                                                                                        |
| `expiringSoon`, `lowStock` | batches                                   | `"true"` or `"false"`                                                                                                                                                                               |

Unknown parameters are **stripped, not rejected**, so a cache-buster does not fail a request. As with body validation, a parameter missing from the schema silently vanishes — add it to the schema in the same commit as the controller that reads it.

### Money

All currency fields are `DECIMAL(12,2)` in the database and are computed with exact decimal arithmetic. They are serialised as JSON **numbers**, not strings, so the wire format is unchanged. Every invoice satisfies `totalAmount = subtotal + cgst + sgst − discountAmt` exactly, and `cgst = sgst` always. Rates (`gstPercent`, line `discount` %) are `DECIMAL(5,2)`, also serialised as numbers.

### Status codes

| Code | Meaning                                                                                                                                                                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200  | OK                                                                                                                                                                                                         |
| 201  | Created (register, user create, medicine/batch/supplier/category/manufacturer/customer create, invoice create)                                                                                             |
| 400  | Validation failure, insufficient stock, wrong current password, self-deletion attempt                                                                                                                      |
| 401  | Missing / invalid / expired token, bad credentials, deactivated user                                                                                                                                       |
| 403  | Authenticated but role not permitted                                                                                                                                                                       |
| 404  | Record not found, or route not found (`Route not found: <url>`)                                                                                                                                          |
| 409  | Conflict. Either a unique violation — duplicate email, category name, phone, batch number (`P2002`, includes a `field` key) — or a delete blocked because the record is still referenced (`P2003`) |
| 429  | Rate limit exceeded                                                                                                                                                                                        |
| 500  | Unhandled error                                                                                                                                                                                            |

### Pagination

Supported by `GET /api/inventory/medicines`, `GET /api/billing/customers`, `GET /api/billing/invoices` via `?page=` (default 1) and `?limit=` (default 20).

**Not paginated** — batches, suppliers, categories, manufacturers and users return the full set.

### Rate limiting

Two limiters, both keyed on the client IP:

| Scope                    | Budget                               | Notes                                                                                                                |
| ------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `/api/*`               | 500 requests / 15 min                | `429` with `Too many requests, please try again later.`                                                          |
| `POST /api/auth/login` | 10**failed** attempts / 15 min | `429` with `Too many failed login attempts. Please try again in 15 minutes.` Successful sign-ins are not counted |

`trust proxy` is set to private-range peers, so behind Nginx the real client IP is used rather than the proxy's — but a client reaching port 5000 directly from outside cannot forge `X-Forwarded-For` to pick its own bucket. Override with the `TRUST_PROXY` environment variable ([G-06](./08-gap-analysis.md#g-06)).

---

## 6. Health

### `GET /health`

Public, outside `/api` and therefore outside the rate limiter.

```json
{ "success": true, "message": "Medical Billing API is running!", "timestamp": "2026-08-17T09:12:44.101Z" }
```

**Liveness.** It does **not** check database connectivity — a `200` here does not mean the system can serve requests. That is deliberate: if a database outage made this fail, an orchestrator would kill an otherwise healthy process and turn a recoverable incident into a restart loop.

### `GET /health/ready`

Readiness. Runs `SELECT 1` and reports what it found.

```json
{
  "success": true,
  "status": "ready",
  "checks": { "database": { "status": "up", "latencyMs": 4 } },
  "timestamp": "2026-08-22T13:18:44.741Z"
}
```

**503** with `"status": "degraded"` and `checks.database.status: "down"` when the database is unreachable — 503 rather than 500, because "not ready to take traffic" is what a load balancer needs to hear in order to route around an instance.

> **Reachable on port 5000 only.** Neither nginx config proxies it: `nginx/nginx.conf` has just `location /` and `location /api`, and `nginx/nginx.prod.conf` has `location = /health`, an *exact* match. So `GET /health/ready` through nginx falls through to the SPA and returns `200 text/html` — a check that would look like it passes while testing nothing.
>
> The compose healthchecks are unaffected because they bypass the proxy: the backend's runs `fetch('http://localhost:5000/health/ready')` inside its own container, and nginx's requests `/health`, which does match. An **external** load balancer pointed at nginx cannot currently reach the readiness probe; that needs a `location = /health/ready` block in the nginx config.

---

## 7. Authentication & users

### `POST /api/auth/login` — public

```json
{ "email": "admin@medstore.com", "password": "admin123" }
```

**200**

```json
{
  "success": true,
  "message": "Login successful.",
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
    "user": { "id": "clx…", "name": "Admin", "email": "admin@medstore.com", "role": "ADMIN" }
  }
}
```

**400** if either field is missing. **401** `Invalid credentials.` for an unknown email, a wrong password, *or* a deactivated account — deliberately indistinguishable.

> No request-body schema is applied here; only presence is checked.

### `POST /api/auth/register` — ADMIN

Creates a user. Functionally the same as `POST /api/users`, but additionally returns a token for the newly created user.

```json
{ "name": "Priya", "email": "priya@medstore.com", "password": "…", "role": "PHARMACIST" }
```

`role` defaults to `CASHIER`. **201** returns `{ user, token }`; **409** if the email exists.

Validated: `name` ≥ 2 characters, valid email, password ≥ 8 characters, `role` one of the three enum values. Unknown fields are stripped.

### `GET /api/auth/me` — any authenticated role

```json
{ "success": true, "data": { "user": { "id": "…", "name": "…", "email": "…", "role": "ADMIN", "isActive": true } } }
```

Returns the freshly-loaded user attached by `protect` — no additional query.

### `PUT /api/auth/change-password` — any authenticated role

```json
{ "currentPassword": "old", "newPassword": "new" }
```

**200** — and the body now carries a **replacement token**:

```json
{ "success": true, "message": "Password changed successfully.", "data": { "token": "eyJhbGciOi…" } }
```

**400** `Current password is incorrect.`

> **A password change signs out every session for the account, including the one that called.** That is the point: it is how a user responds to a compromise, so it has to end the attacker's session. The caller gets the replacement above because they just proved they know the current password — **store it before the next request**, or that request answers `401 Session ended. Please sign in again.` and a successful change looks like a failure.

> **Password rules** (identical for this route and `POST /api/users`): at least **12 characters**, at most 200. Refused if it is a common password or a close variant of one — the blocklist matches the stem, so `password1234` and `pharmacy2026` are caught too — a single repeated character, a straight alphabetical or numeric run, one of the credentials published in this repository, or anything containing the account's own name or email address.
>
> There are deliberately **no character-class requirements**. [NIST SP 800-63B](https://pages.nist.gov/800-63-3/sp800-63b.html) advises against them because they push people towards predictable shapes like `Password1!` that cracking dictionaries already hold; a long passphrase with no digits at all is a good password here and is accepted. There is **no breach-corpus lookup** either — see [07 §10](./07-security.md#10-hardening-backlog) for why that trade was declined.
>
> A failure is a `400` carrying a field-level error on `password` / `newPassword`.

### `POST /api/auth/refresh` — public (the cookie is the credential)

Exchanges the `refresh_token` cookie for a new access token. **No `Authorization` header** — the access token it replaces has expired, which is why the caller is here. No request body.

**200**

```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOi…",
    "user": { "id": "…", "name": "…", "email": "…", "role": "CASHIER", "mustChangePassword": false }
  }
}
```

A new `refresh_token` cookie is set on every success. **401** `Session expired. Please sign in again.` for every failure — missing cookie, expired, forged, already rotated, revoked by a logout, or a deactivated user. Deliberately one message: which of those it was is not the caller's business.

**Rotation and reuse detection.** Each refresh token is backed by a `RefreshToken` row, and its `jti` is that row's id. Using a token revokes its row and issues a new one. Presenting a row that is **already revoked** means two parties hold the same credential — a legitimate client never replays one — so the server treats it as theft and ends *every* session for that user, the honest one included. Losing a session beats leaving someone else in one.

> **Clients must serialise their refreshes.** Because every use rotates, two concurrent refreshes with the same cookie look exactly like theft: the second presents what the first just retired, and the account is signed out. A client firing several requests at once needs one shared in-flight refresh — `frontend/src/lib/api.ts` keeps a single promise for this reason.

### `POST /api/auth/logout` — any authenticated role

Ends **every** session for the calling account, not only the one that called. No request body.

**200**

```json
{ "success": true, "message": "Signed out. All sessions for this account have ended." }
```

Afterwards every token issued to that user answers **401** `Session ended. Please sign in again.` — including tokens the caller never held, which is the point: a copy someone else took is revoked too. A client-side `localStorage` clear cannot do that.

| Failure                | Status |
| ---------------------- | ------ |
| No token               | 401    |
| Already-revoked token  | 401`Session ended. Please sign in again.` |

Calling it twice is harmless. It is **not** gated by the forced-password-change middleware, for the same reason `GET /me` and `PUT /change-password` are not: an account carrying `mustChangePassword` must still be able to sign out of itself.

**How it works.** `User.tokenVersion` is a counter; every token carries the value current when it was signed, and `protect` rejects any token whose copy has fallen behind. Logout increments it. The check is free — `protect` already reloads the user row on every request.

> A counter rather than a "tokens valid from" timestamp, deliberately: JWT `iat` is second-granular, so a token signed in the same second as a logout would compare equal and survive the revocation it was meant to be caught by.
>
> Tokens issued **before** this shipped carry no `tokenVersion` claim; a missing claim reads as `0`, which is the column default, so they kept working until their user logged out once. Deploying the feature did not sign everybody out.

### `GET /api/users` — ADMIN

Returns all users ordered by newest first: `id, name, email, role, isActive, createdAt`. Never includes the password hash. Unpaginated.

### `POST /api/users` — ADMIN

`{ name, email, password, role? }` → **201** with the created user (no token). **409** on duplicate email.

### `PUT /api/users/:id` — ADMIN

`{ name?, email?, role?, isActive? }` → **200** with the updated user. Used by Settings for both editing and the active/inactive toggle. **404** if the id does not exist (`P2025`).

### `DELETE /api/users/:id` — ADMIN

**200** on success. **400** `You can't delete your own account` when `:id` equals the caller. **409** `This record is still in use by other data and cannot be deleted.` for a user who has raised invoices — the foreign key holds, and the honest answer is to deactivate them instead ([G-12](./08-gap-analysis.md#g-12)).

### `PUT /api/users/profile` — any authenticated role

`{ name?, email? }`, applied to the caller. **409** if the email belongs to another user. Note this route is declared before the admin routes so `profile` is never captured by `/:id`.

---

## 8. Inventory

All routes below require authentication (`router.use(protect)`).

### 8.1 Categories

| Method | Path                              | Role              | Body         |
| ------ | --------------------------------- | ----------------- | ------------ |
| GET    | `/api/inventory/categories`     | any               | —           |
| POST   | `/api/inventory/categories`     | ADMIN, PHARMACIST | `{ name }` |
| PUT    | `/api/inventory/categories/:id` | ADMIN, PHARMACIST | `{ name }` |
| DELETE | `/api/inventory/categories/:id` | ADMIN             | —           |

`name` must be ≥ 2 characters and unique (**409** otherwise). GET returns each category with `_count.medicines`, ordered by name:

```json
{ "success": true, "data": [ { "id": "clx…", "name": "Analgesic", "_count": { "medicines": 14 } } ] }
```

Deleting a category still referenced by a medicine returns **409** `This record is still in use by other data and cannot be deleted.`, with a `field` key naming the constraint ([G-12](./08-gap-analysis.md#g-12)).

### 8.2 Manufacturers

Identical contract at `/api/inventory/manufacturers` — same methods, same roles, same `{ name }` body, same `_count.medicines` shape.

### 8.3 Medicines

#### `GET /api/inventory/medicines` — any role

| Query          | Default | Purpose                                             |
| -------------- | ------- | --------------------------------------------------- |
| `search`     | —      | Case-insensitive match on name, generic name or HSN |
| `categoryId` | —      | Filter by category                                  |
| `page`       | 1       |                                                     |
| `limit`      | 20      |                                                     |

Only `isActive: true` medicines are returned, ordered by name.

```json
{
  "success": true,
  "data": [
    {
      "id": "clx…", "name": "Paracetamol 500mg", "genericName": "Paracetamol",
      "hsnCode": "3004", "unit": "tablet", "gstPercent": 12,
      "isScheduledH": false, "isActive": true,
      "category": { "id": "…", "name": "Analgesic" },
      "manufacturer": { "id": "…", "name": "Cipla" },
      "batches": [ { "id": "…", "batchNumber": "B2401", "expiryDate": "2027-03-31T00:00:00.000Z", "sellingPrice": 24.5, "quantity": 180 } ],
      "totalStock": 180,
      "nearestExpiry": "2027-03-31T00:00:00.000Z",
      "sellingPrice": 24.5
    }
  ],
  "pagination": { "total": 137, "page": 1, "limit": 20, "pages": 7 }
}
```

`totalStock` is the sum across **every** in-stock batch. The single batch in `batches` is the FEFO one — what the POS would sell next — and it is where `nearestExpiry` and `sellingPrice` come from.

#### `GET /api/inventory/medicines/search?q=<term>` — any role

The POS lookup. Returns `[]` when `q` is shorter than 2 characters. Max 10 results, each flattened with the nearest-expiry in-stock batch:

```json
{
  "success": true,
  "data": [
    {
      "id": "clx…", "name": "Amoxicillin 500mg", "genericName": "Amoxicillin",
      "unit": "capsule", "gstPercent": 12, "isScheduledH": true,
      "batchId": "clb…", "batchNumber": "AMX-2311",
      "expiryDate": "2026-11-30T00:00:00.000Z",
      "sellingPrice": 82.0, "stock": 46
    }
  ]
}
```

When a medicine has no stock, `batchId` is `null`, `batchNumber` is the string `"No Stock"`, `sellingPrice` is `0` and `stock` is `0`. Out-of-stock medicines are **still returned** — the client must guard against adding a null `batchId` to the cart.

#### `GET /api/inventory/medicines/:id` — any role

Full record including category, manufacturer and **all** batches (each with its supplier) ordered by expiry. **404** `Medicine not found`.

#### `POST /api/inventory/medicines` — ADMIN, PHARMACIST

```json
{
  "name": "Paracetamol 500mg",
  "genericName": "Paracetamol",
  "categoryId": "clx…",
  "manufacturerId": "clm…",
  "hsnCode": "3004",
  "unit": "tablet",
  "gstPercent": 12,
  "isScheduledH": false
}
```

| Field                              | Rule                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `name`                           | required, ≥ 2 chars                                                              |
| `genericName`, `hsnCode`       | optional strings                                                                  |
| `categoryId`, `manufacturerId` | required, must exist                                                              |
| `unit`                           | one of`tablet, capsule, syrup, injection, cream, drops, powder, inhaler, other` |
| `gstPercent`                     | number, one of`0, 5, 12, 18`                                                    |
| `isScheduledH`                   | boolean, default`false`                                                         |

**201** with the created medicine including its category and manufacturer. Unknown fields are silently stripped by Zod.

#### `PUT /api/inventory/medicines/:id` — ADMIN, PHARMACIST

Same schema as create — all fields required, so send the complete object.

#### `DELETE /api/inventory/medicines/:id` — ADMIN

**Soft delete**: sets `isActive = false`. The record, its batches and its invoice history survive; it disappears from list and search. There is no un-delete endpoint.

### 8.4 Batches (stock)

#### `GET /api/inventory/batches` — any role

| Query                 | Effect                            |
| --------------------- | --------------------------------- |
| `medicineId`        | Only this medicine's batches      |
| `expiringSoon=true` | Expiry between today and +30 days |
| `lowStock=true`     | `quantity ≤ 10` and `> 0`    |

Ordered by expiry ascending, each batch including `medicine { name, unit }` and `supplier { name }`. Unpaginated.

#### `GET /api/inventory/batches/expiring?days=30` — any role

Batches expiring between now and +`days` **that still hold stock** (`quantity > 0`). Powers the dashboard panel, the Stock Alerts report and the notification tray.

#### `GET /api/inventory/batches/low-stock?threshold=10` — any role

Batches with `0 < quantity ≤ threshold`, ordered by quantity ascending. Includes the medicine's category.

#### `POST /api/inventory/batches` — ADMIN, PHARMACIST

```json
{
  "medicineId": "clx…",
  "supplierId": "cls…",
  "batchNumber": "B2401",
  "expiryDate": "2027-03-31",
  "purchasePrice": 18.4,
  "sellingPrice": 24.5,
  "quantity": 200
}
```

| Field                                           | Rule                          |
| ----------------------------------------------- | ----------------------------- |
| `medicineId`, `supplierId`, `batchNumber` | required, non-empty           |
| `expiryDate`                                  | any`Date.parse`-able string |
| `purchasePrice`, `sellingPrice`             | numbers > 0                   |
| `quantity`                                    | positive integer              |

The server sets `initialQty = quantity`. **409** if `(medicineId, batchNumber)` already exists.

> `mfgDate` is optional. When supplied it must parse as a date and fall **before** `expiryDate`, otherwise the request is rejected with a field-level error on `mfgDate`.

#### `PUT /api/inventory/batches/:id` — ADMIN, PHARMACIST

Accepts only `batchNumber`, `expiryDate`, `purchasePrice` and `sellingPrice`, all optional. The schema is **strict**: any other field — including `quantity`, `initialQty`, `medicineId` and `supplierId` — is rejected with a `400`, not silently ignored.

> **Stock is not adjustable through this route.** Quantity moves through batch creation, a sale, a void, or the adjustment endpoint below — never through a general edit, so it always has a stated cause ([G-05](./08-gap-analysis.md#g-05)).

#### `POST /api/inventory/batches/:id/adjust` — ADMIN, PHARMACIST

Manual stock adjustment for breakage, theft, a miscount, or expired stock coming off the shelf (FR-BATCH-11).

```json
{ "delta": -3, "reason": "Three strips crushed when the shelf collapsed" }
```

| Field | Rule |
| --- | --- |
| `delta` | Signed whole number, non-zero. **Relative, not absolute** |
| `reason` | Required, 10–500 characters |

`.strict()` — an unrecognised field, `quantity` included, is a `400`.

**Why a delta rather than "set it to 47".** An absolute quantity loses a race a shop actually hits: if a sale commits between the operator reading the screen and pressing save, an absolute write silently erases that sale's deduction. A delta composes with a concurrent decrement instead of clobbering it.

| Outcome | Status |
|---|---|
| Adjusted | `200` with the updated batch |
| Would take stock below zero | `400` naming the batch and what is actually in stock — not a `500` from the `Batch_quantity_non_negative` constraint, which is the backstop rather than the user-facing rule |
| Missing or too-short reason, zero or fractional delta, unknown field | `400` |
| Caller is a CASHIER | `403` |
| No such batch | `404` |

> **This is not a way to reverse a sale.** That is a [void](#post-apibillinginvoicesidvoid--admin-only), which issues a credit note, returns the exact units to the batches they came from, and leaves the tax period intact. An adjustment that added the units back would leave the invoice standing and the money uncorrected. Nothing here can stop an administrator misusing it — the defence is that the reason is mandatory and the adjustment is attributed, which is the point of the requirement.

### 8.5 Suppliers

| Method | Path                                 | Role              |
| ------ | ------------------------------------ | ----------------- |
| GET    | `/api/inventory/suppliers?search=` | any               |
| GET    | `/api/inventory/suppliers/:id`     | any               |
| POST   | `/api/inventory/suppliers`         | ADMIN, PHARMACIST |
| PUT    | `/api/inventory/suppliers/:id`     | ADMIN, PHARMACIST |
| DELETE | `/api/inventory/suppliers/:id`     | ADMIN             |

`search` matches name (case-insensitive) or phone. Results ordered by name, unpaginated.

```json
{ "name": "MedPlus Distributors", "contactName": "Rahul", "phone": "9876543210",
  "email": "rahul@medplus.in", "gstNumber": "27AABCU9603R1ZM", "address": "…" }
```

`name` is required (≥ 2 chars); everything else is optional. `email` must be a valid address **or** an empty string.

`GET /:id` returns the supplier with `_count.batches` — how many stock batches have been received from them. **404** `Supplier not found`.

> It used to include a `purchases` array that was always empty, because nothing could ever write one. The tables were dropped on 2026-08-24 ([PRD Q7](./01-product-requirements.md#14-open-questions)).

Deleting a supplier that still has batches returns **409** `This record is still in use by other data and cannot be deleted.` ([G-12](./08-gap-analysis.md#g-12)). Suppliers are hard-deleted, and batches reference them permanently, so in practice a supplier you have ever received stock from cannot be removed.

---

## 9. Billing

All routes require authentication.

### 9.1 Customers — `/api/billing/customers`

#### `GET /api/billing/customers` — any role

| Query      | Default                   |
| ---------- | ------------------------- |
| `search` | — (name, phone or email) |
| `page`   | 1                         |
| `limit`  | 20                        |

```json
{
  "success": true,
  "data": [ { "id": "clc…", "name": "Ramesh Gupta", "phone": "9876543210",
              "email": null, "address": "…", "age": 54, "gender": "MALE",
              "createdAt": "…", "_count": { "invoices": 12 } } ],
  "pagination": { "total": 340, "page": 1, "limit": 20, "pages": 17 }
}
```

#### `GET /api/billing/customers/:id` — any role

The customer, plus their 10 most recent invoices (`id, invoiceNumber, date, totalAmount, paymentMode, paymentStatus`). **404** `Customer not found`.

> **`invoices` is returned only to ADMIN and PHARMACIST.** For a CASHIER the key is **absent** — not an empty array, which would assert the customer had never bought anything. Purchase history in a pharmacy reveals health conditions, and a cashier needs to bill someone, not to browse what they have been treated for (threat T-9). Customer lookup, search and billing are unaffected.

#### `POST /api/billing/customers` — any role

```json
{ "name": "Ramesh Gupta", "phone": "9876543210", "email": "", "address": "MG Road", "age": 54, "gender": "MALE" }
```

| Field      | Rule                                              |
| ---------- | ------------------------------------------------- |
| `name`   | required, ≥ 2 chars                              |
| `phone`  | optional,**unique** across customers → 409 |
| `email`  | optional, valid email or`""`                    |
| `age`    | optional, string or number, 0–150                |
| `gender` | optional,`MALE` \| `FEMALE` \| `OTHER`      |

**201** with the created customer. This is the endpoint behind the POS "add customer" dialog.

#### `PUT /api/billing/customers/:id` — any role

Same schema. Sends all fields; omitted optional fields are written as `null`.

#### `DELETE /api/billing/customers/:id` — ADMIN

**Erasure, not deletion.** The row survives — `Invoice.customerId` is a foreign key and invoices are append-only tax records — but `name`, `phone`, `email`, `address`, `age` and `gender` are blanked and `anonymisedAt` is stamped. Every invoice keeps its number, date and totals, so a GST return filed against them still reconciles.

It also **redacts that customer's audit-log entries**, replacing the before/after payloads with a marker while keeping the attribution. Erasing the customer and leaving a full copy in the audit trail would not be an erasure.

| Outcome | Status |
|---|---|
| Erased | `200` |
| Already erased | `200`, with the date it happened. Idempotent, and re-running repairs a half-finished erasure |
| No such customer | `404` |
| Caller is not an ADMIN | `403` |

Bulk retention is a separate, operator-run job rather than an endpoint — `npm run purge:customers` — described in [03 §8](./03-data-model.md#8-data-lifecycle--retention).

### 9.2 Invoices — `/api/billing/invoices`

#### `POST /api/billing/invoices` — any role

The central write path of the product.

```json
{
  "customerId": "clc…",
  "items": [
    {
      "batchId": "clb…",
      "medicineId": "clx…",
      "medicineName": "Paracetamol 500mg",
      "quantity": 10,
      "unitPrice": 24.5,
      "discount": 5,
      "gstPercent": 12
    }
  ],
  "discountAmt": 10,
  "paymentMode": "UPI",
  "paymentStatus": "PAID",
  "notes": "Regular customer"
}
```

| Field                                                 | Rule                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| `customerId`                                        | optional — omit for a walk-in sale                             |
| `items`                                             | required, at least 1                                            |
| `items[].batchId`, `medicineId`, `medicineName` | required, non-empty                                             |
| `items[].quantity`                                  | positive integer                                                |
| `items[].unitPrice`                                 | positive number                                                 |
| `items[].discount`                                  | 0–100,**percentage**, default 0                          |
| `items[].gstPercent`                                | number, default 0                                               |
| `discountAmt`                                       | ≥ 0,**flat currency amount** on the bill, default 0. May not exceed the bill — see below |
| `paymentMode`                                       | `CASH` \| `UPI` \| `CARD` \| `CREDIT`, default `CASH` |
| `paymentStatus`                                     | `PAID` \| `PENDING` \| `PARTIAL`, default `PAID`        |
| `notes`                                             | optional string                                                 |
| `prescription`                                    | **Required when any line's medicine is Schedule H**, refused otherwise as a `400`. Object: `prescriberName`, `prescriberRegNo`, `prescribedOn` (not in the future), `patientName`, optional `notes`. `.strict()` |

**Server-side computation** (see [PRD §8](./01-product-requirements.md#8-key-business-rules)) — the client's totals are never trusted:

```
per line:  taxable  = unitPrice × quantity × (1 − discount/100)
           gst      = taxable × gstPercent/100
           cgst = sgst = gst / 2
           totalPrice = taxable + gst                (2 dp)

invoice:   subtotal    = Σ taxable
           cgst        = Σ cgst
           sgst        = Σ sgst
           totalAmount = subtotal + cgst + sgst − discountAmt
```

`medicineId` is validated but not persisted — the line is tied to the batch, and the name is snapshotted.

**Sequence:** stock and expiry are verified for every line → totals computed → invoice number generated → invoice, items and every batch decrement written inside one `prisma.$transaction`.

> **Schedule H sales require a prescription record** (FR-MED-12). One per invoice — a customer hands over one prescription covering every controlled item on the bill — written in the same transaction as the sale, so a rolled-back invoice leaves no orphan entry. It records the particulars Rule 65(11) asks for that the invoice does not already carry: the prescriber, their council registration number, the prescription's own date, and the patient's name (needed because a Schedule H sale can be a walk-in with no `customerId`). **No image is stored.**
>
> Whether a line is Schedule H is decided from the **batch's** medicine, never the `medicineId` in the request — that field is validated but not persisted, so trusting it would let a caller pair a Schedule H batch with a harmless id and skip the requirement.

> **Expiry is enforced, not just displayed** (FR-BATCH-09). A medicine is sellable **through** the date printed on it: a batch expiring *today* sells, one that expired *yesterday* is refused. The authoritative check is a predicate on the same atomic `updateMany` that decrements stock, so a batch that expires between the cart being built and the sale committing — a till left open over midnight — is still caught. The pre-transaction check is advisory and exists only for a faster, friendlier message.
>
> **No role can override this, including ADMIN.** The case that looks like it needs an override — "we need to sell stock expiring today" — is already allowed. For genuinely expired stock there is no lawful retail sale; taking it off the shelf is a write-off ([FR-BATCH-11](./01-product-requirements.md#65-stock--batches--fr-batch)), which keeps the stock movement attributable instead of disguised as a sale.

**201** returns the invoice with `items`, `customer` and `user.name`.

| Failure                     | Status | Message                                                                                                                                                                            |
| --------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Body fails schema           | 400    | `Validation failed` + `errors[]`                                                                                                                                               |
| A`batchId` does not exist | 404    | `Batch not found for <medicineName>`                                                                                                                                             |
| Quantity exceeds stock      | 400    | `Insufficient stock for <medicineName>. Available: <n>`                                                                                                                          |
| The batch has expired       | 400    | `<medicineName> (batch <batchNumber>) expired on <yyyy-mm-dd> and cannot be sold. Remove it from stock.`                                                                        |
| A Schedule H line has no prescription | 400 | `A prescription is required: <names> is/are Schedule H.` plus a field-level error on `prescription`                                                              |
| `discountAmt` exceeds the bill | 400 | `Discount of <x> is more than the bill total of <y>.`, with a field error on `discountAmt` naming the maximum. **Refused, never clamped** — clamping the total would break `subtotal + cgst + sgst − discountAmt = totalAmount`, and clamping the discount would store a figure nobody typed. Money moving back to a customer is a credit note (§9.2, void), not a negative sale ([F7](./09-testing-strategy.md#4-gst-engine-fixtures)) |
| Invoice number collision    | 409    | `A record with this value already exists.` — unreachable in normal operation since the atomic per-day counter landed ([G-01](./08-gap-analysis.md#g-01)); retained as a backstop |

There is **no update or delete** for invoices. Since 2026-08-20 there is a **void**, which is neither.

#### `POST /api/billing/invoices/:id/void` — ADMIN only

```json
{ "reason": "duplicate bill — customer was charged twice" }
```

`reason` is required, 3–500 characters, and the body is `.strict()`. Why a bill was cancelled is the whole value of the audit trail.

In one transaction this:

- marks the original `status: "CANCELLED"` and changes **nothing else** about it — not its number, date, totals or lines;
- returns each line's units to the batch they came from, keeping that batch's expiry date and batch number;
- creates a credit note: `type: "CREDIT_NOTE"`, a `CRNyymmdd-nnnn` serial from its own series, every money field negated, and `reversesId` pointing at the original.

| Outcome | Status |
|---|---|
| Voided | `201`, the credit note |
| Already voided, or lost a concurrent race | `409` |
| The target is itself a credit note | `400` |
| Missing or too-short `reason` | `400` |
| Caller is not an ADMIN | `403` |
| No such invoice | `404` |

**A voided invoice stays in its own period's GST report.** The credit note lands in the period the void happened, and the two net to zero across periods. This is deliberate and is the point of the whole design: removing the original from its own month would rewrite a tax period that may already have been filed. See [BR-14](./01-product-requirements.md#8-key-business-rules).

Restoration happens exactly once, guarded twice — a conditional update on `status: ACTIVE` catches a repeated submission, and a unique index on `reversesId` catches two simultaneous ones.

Partial returns are not supported: a void reverses a whole invoice.

#### `GET /api/billing/invoices` — any role

| Query                       | Effect                                                                          |
| --------------------------- | ------------------------------------------------------------------------------- |
| `page`, `limit`         | Pagination (defaults 1 / 20)                                                    |
| `search`                  | Invoice number or customer name, case-insensitive                               |
| `startDate` + `endDate` | Inclusive date range —**both must be supplied**, either alone is ignored |
| `paymentMode`             | Exact enum match                                                                |
| `paymentStatus`           | Exact enum match                                                                |

Ordered newest first; each row carries the customer summary, `user.name` and `_count.items`.

#### `GET /api/billing/invoices/daily-summary?date=YYYY-MM-DD` — any role

Defaults to today. Returns every invoice for the day plus aggregates:

```json
{
  "success": true,
  "data": {
    "invoices": [ /* full invoices with customer.name */ ],
    "summary": {
      "totalInvoices": 42,
      "creditNotes": 1,
      "totalSales": 18450.75,
      "totalCgst": 987.5,
      "totalSgst": 987.5,
      "totalGst": 1975.0,
      "byPaymentMode": [
        { "paymentMode": "CASH", "_sum": { "totalAmount": 9100.0 }, "_count": { "id": 22 } },
        { "paymentMode": "UPI",  "_sum": { "totalAmount": 9350.75 }, "_count": { "id": 20 } }
      ]
    }
  }
}
```

Powers the dashboard, the Daily report, and — called seven times — the Sales Trend chart.

`totalInvoices` counts **sales** raised that day, cancelled ones included; `creditNotes` counts the reversals issued that day; and every money figure sums **both**, so the takings are net. A sale voided the same day therefore reads `totalInvoices: 1, creditNotes: 1, totalSales: 0` — not `2`. The per-mode `_count.id` is likewise sales-only, so the mode counts add up to `totalInvoices`. The reasoning, and why a cancelled sale still counts in its own period, is in [03 §8](./03-data-model.md#8-data-lifecycle--retention).

#### `GET /api/billing/invoices/trend?days=<1-90>` — any role

Daily sales totals for the last `days` days, ending today. `days` defaults to **7** and is validated by `trendQuerySchema`; out of range is a `400`.

```json
{
  "success": true,
  "data": [
    { "date": "2026-08-20", "sales": 34913.72, "invoices": 97 },
    { "date": "2026-08-21", "sales": 0,        "invoices": 2  },
    { "date": "2026-08-22", "sales": 0,        "invoices": 0  }
  ]
}
```

Three things to know before charting it:

- **Days with no trade are returned with zeros, not omitted.** The client draws a fixed window, so a missing day would silently shift every point left.
- **Only `PAID` invoices are counted.** `PENDING` and `PARTIAL` are excluded, which is why this can disagree with `daily-summary` — that endpoint sums every payment status.
- **`invoices` counts sales; `sales` sums sales and credit notes.** So a day whose sales were all voided reads `invoices: 2, sales: 0`, exactly as the second row above. Same rule as the daily summary ([03 §8](./03-data-model.md#8-data-lifecycle--retention)).

Days are bounded at the **store's local midnight**, not UTC — "yesterday" means what a shopkeeper means by it.

This replaced seven `daily-summary` calls, one per day, each of which fetched every invoice for its day with the customer joined and then read two integers off it ([G-08](./08-gap-analysis.md#g-08)). On 20,000 invoices: 7 requests / 259 KB / 102 ms → 1 request / under 1 KB / 8 ms.

> Declared **above** `/invoices/:id` in `billing.routes.js`, or `trend` would be read as an invoice id. Same rule as `daily-summary` and `gst-report`.

#### `GET /api/billing/invoices/gst-report?month=<1-12>&year=<yyyy>` — ADMIN, PHARMACIST

Every **`PAID`** invoice in the month, ascending by date, with items, plus period totals:

```json
{ "success": true, "data": { "invoices": [ … ], "totals": { "taxable": 412300.0, "cgst": 24738.0, "sgst": 24738.0, "total": 461776.0 } } }
```

`month` is 1-based. **Both parameters are required and validated** by `gstReportQuerySchema` — `month` 1–12, `year` 2000–2100. A missing or non-numeric value is a `400`, not an empty report.

That distinction is the whole reason the validation was added: an empty tax period and a period that failed to parse look identical in the response, and only one of them means the shop had no sales. Before 2026-08-20 a typo in `month` produced an `Invalid Date` range and a plausible-looking empty result.

#### `GET /api/billing/invoices/:id` — any role

The full invoice for printing: items (each with `batch.batchNumber` and `batch.expiryDate`), the complete customer record, and `user.name`. **404** `Invoice not found`.

> Route ordering matters here: `daily-summary`, `gst-report` and `trend` are declared **before** `/:id`, so they are matched correctly. Keep any new literal sub-path above `/:id`.

---

## 9a. Dashboard — `/api/dashboard`

Its own router, mounted at `/api/dashboard`. One endpoint.

### `GET /api/dashboard/stats` — any role

Everything the dashboard renders, in one request. No query parameters; the windows are fixed in the controller (30-day expiry horizon, low-stock threshold 20, 8 recent invoices, 10 rows per panel, 7-day trend).

```jsonc
{
  "success": true,
  "data": {
    "summary": {
      "totalSales": 34913.72,      // today, net of any credit notes
      "totalInvoices": 97,         // sales raised today, cancelled ones included
      "creditNotes": 0,            // reversals issued today
      "totalCgst": 1870.2,
      "totalSgst": 1870.2,
      "byPaymentMode": [ { "paymentMode": "CASH", "_sum": { "totalAmount": 9100 }, "_count": { "id": 22 } } ]
    },
    "recentInvoices": [ { "id": "…", "invoiceNumber": "INV260822-0097", "date": "…",
                          "totalAmount": 274.4, "paymentMode": "CASH",
                          "paymentStatus": "PAID", "customer": { "id": "…", "name": "…" } } ],
    "expiring": { "count": 840, "items": [ /* ≤10 batches, nearest expiry first */ ] },
    "lowStock": { "count": 63,  "items": [ /* ≤10 batches, lowest quantity first */ ] },
    "totals":   { "medicines": 10056, "customers": 5003 },
    "trend":    [ { "date": "2026-08-16", "sales": 0, "invoices": 0 }, /* … 7 entries … */ ]
  }
}
```

**`count` and `items` are deliberately separate.** `count` is an exact database count of every matching batch; `items` is only the handful the panel renders. The panels previously fetched *every* matching batch with its medicine and supplier joined — 281 KB and 481 KB at 25,000 batches — to show eight rows and a number.

Each batch in `expiring.items` / `lowStock.items` carries `id`, `batchNumber`, `expiryDate`, `quantity`, `sellingPrice`, `medicine { id, name, unit }` and `supplier { name }`.

The `summary` and `trend` blocks follow the same counting rules as `GET /api/billing/invoices/daily-summary` and `GET /api/billing/invoices/trend` in §9.2 above; `trend` here is always 7 days.

**This endpoint replaced thirteen requests**, not six: the six panel calls plus seven `daily-summary` calls for the chart. Two of the six existed only to read a number — `?limit=1` on medicines and customers, fetching a row to throw it away and keep `pagination.total`. Measured: **794 KB / 159 ms → 6 KB / 19 ms** ([G-08](./08-gap-analysis.md#g-08)).

> Open to every authenticated role, matching the panels it replaced — which means a cashier can see whole-day store revenue. That was already true of `daily-summary` and is flagged as an open question in [07 §3](./07-security.md#3-authorisation).

---

## 10. Endpoints that do not exist

Documented elsewhere in the repo but absent from the code. Requests to these return **404** `Route not found: …`.

| Claimed in            | Path                                                                                               | Reality                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| backend README        | `POST /api/auth/refresh`                                                                         | `generateRefreshToken` exists, no route                                                                        |
| backend README        | `POST /api/auth/forgot-password`, `/reset-password`                                            | Not implemented                                                                                                  |
| backend README        | `PUT /api/users/:id/password`, `/:id/role`                                                     | Covered by`PUT /api/users/:id`                                                                                 |
| root + backend README | `/api/customers/*`                                                                               | Use`/api/billing/customers`                                                                                    |
| root + backend README | `/api/medicines/*`                                                                               | Use`/api/inventory/medicines`                                                                                  |
| root + backend README | `/api/suppliers/*`                                                                               | Use`/api/inventory/suppliers`                                                                                  |
| root + backend README | `/api/reports/*` (sales, inventory, billing, top-medicines, daily-sales, low-stock, gst-summary) | Use`/api/billing/invoices/daily-summary`, `/gst-report`, `/api/inventory/batches/expiring`, `/low-stock` |
| backend README        | `GET /api/inventory` , `/inventory/add`, `/inventory/remove`                                 | Stock moves only via batch create and invoice create                                                             |
| backend README        | `GET /api/billing/:id/invoice` (download)                                                        | Printing is browser-side                                                                                         |
| backend README        | `DELETE /api/billing/:id`, `PUT /api/billing/:id`                                              | Invoices are immutable                                                                                           |
| Architecture.txt      | `POST /api/batches`, `GET /api/batches/expiring`                                               | Under`/api/inventory/`                                                                                         |

There is no `customer.routes.js`, `medicine.routes.js`, `report.routes.js` or `supplier.routes.js`. Four zero-byte placeholders with those names were deleted on 2026-08-20 ([G-13](./08-gap-analysis.md#g-13)); the four routers that exist are `auth`, `inventory`, `billing` and `user`.

---

## 11. Worked example — a complete sale

```bash
BASE=http://localhost:5000

# 1. Authenticate
TOKEN=$(curl -s -X POST $BASE/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@medstore.com","password":"admin123"}' \
  | jq -r .data.token)

# 2. Find a medicine (POS search)
curl -s "$BASE/api/inventory/medicines/search?q=para" \
  -H "Authorization: Bearer $TOKEN" | jq

# 3. Create the invoice using the batchId returned above
curl -s -X POST $BASE/api/billing/invoices \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "items": [{
      "batchId": "clb_xxx", "medicineId": "clm_xxx",
      "medicineName": "Paracetamol 500mg",
      "quantity": 10, "unitPrice": 24.5, "discount": 0, "gstPercent": 12
    }],
    "paymentMode": "CASH", "paymentStatus": "PAID"
  }' | jq

# 4. Read the day back
curl -s "$BASE/api/billing/invoices/daily-summary" \
  -H "Authorization: Bearer $TOKEN" | jq .data.summary
```

Expected arithmetic for step 3: taxable `245.00`, GST 12% = `29.40` → CGST `14.70`, SGST `14.70`, total `274.40`.
