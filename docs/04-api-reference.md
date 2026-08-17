# 04 — API Reference

**Version:** 1.0.0 · **Verified against source:** 2026-08-17

This document lists **every endpoint that exists**. It was written by reading `backend/src/routes/*` and the controllers they mount. Endpoints listed in `backend/README.md` but absent from the code are catalogued in [§10](#10-endpoints-that-do-not-exist).

---

## 1. Base URL

| Environment | Base URL | Notes |
|---|---|---|
| Local / Docker (direct) | `http://localhost:5000` | What the SPA actually uses (`VITE_API_URL`) |
| Via Nginx | `http://localhost/api` | Proxy exists; the CORS allowlist does not include this origin — see [G-02](./08-gap-analysis.md#g-02) |

All paths below are absolute from the host root, e.g. `POST http://localhost:5000/api/auth/login`.

## 2. Router map

Four routers are mounted. **Resource paths do not follow the obvious REST grouping** — read this table before writing a client.

| Prefix | Resources |
|---|---|
| `/api/auth` | login · register · me · change-password |
| `/api/users` | user CRUD · own profile |
| `/api/inventory` | categories · manufacturers · **medicines** · batches · **suppliers** |
| `/api/billing` | **customers** · invoices · daily-summary · gst-report |

> Customers are under **`/api/billing/customers`**. Suppliers and medicines are under **`/api/inventory/`**. There is no `/api/customers`, `/api/medicines`, `/api/suppliers` or `/api/reports`.

## 3. Authentication

Every endpoint except `POST /api/auth/login` and `GET /health` requires:

```http
Authorization: Bearer <jwt>
```

The token comes from `POST /api/auth/login`, is signed HS256 with `JWT_SECRET`, and expires in **7 days**. On each request the server decodes it and **reloads the user from the database**, so a deactivated (`isActive = false`) or deleted user is rejected immediately regardless of token validity.

| Failure | Status | Body message |
|---|---|---|
| Header missing or not `Bearer …` | 401 | `Access denied. No token provided.` |
| Signature invalid / malformed | 401 | `Invalid token.` |
| Expired | 401 | `Token expired.` |
| User deleted or deactivated | 401 | `User not found or deactivated.` |
| Authenticated but wrong role | 403 | `Access denied. Required role: ADMIN or PHARMACIST` |

## 4. Role matrix

`ADMIN` › `PHARMACIST` › `CASHIER`. A blank cell means the role receives `403`.

| Capability | ADMIN | PHARMACIST | CASHIER |
|---|:---:|:---:|:---:|
| Log in, read own profile, change own password, update own profile | ✅ | ✅ | ✅ |
| List / create / update / delete users | ✅ | | |
| Register user via `/api/auth/register` | ✅ | | |
| Read categories, manufacturers, medicines, batches, suppliers | ✅ | ✅ | ✅ |
| Create / update categories, manufacturers, medicines, batches, suppliers | ✅ | ✅ | |
| Delete categories, manufacturers, medicines, suppliers | ✅ | | |
| Read customers, create / update customers | ✅ | ✅ | ✅ |
| Read invoices, create invoices, daily summary | ✅ | ✅ | ✅ |
| GST report | ✅ | ✅ | |

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

> The root `README.md` documents `{ "success": false, "error": "...", "statusCode": 400 }`. That shape is **not** produced by any code path. The key is `message`.

### Status codes

| Code | Meaning |
|---|---|
| 200 | OK |
| 201 | Created (register, user create, medicine/batch/supplier/category/manufacturer/customer create, invoice create) |
| 400 | Validation failure, insufficient stock, wrong current password, self-deletion attempt |
| 401 | Missing / invalid / expired token, bad credentials, deactivated user |
| 403 | Authenticated but role not permitted |
| 404 | Record not found, or route not found (`Route not found: <url>`) |
| 409 | Unique constraint violation — duplicate email, category name, phone, batch number (Prisma `P2002`, includes a `field` key) |
| 429 | Rate limit exceeded |
| 500 | Unhandled error |

### Pagination

Supported by `GET /api/inventory/medicines`, `GET /api/billing/customers`, `GET /api/billing/invoices` via `?page=` (default 1) and `?limit=` (default 20).

**Not paginated** — batches, suppliers, categories, manufacturers and users return the full set.

### Rate limiting

500 requests per 15 minutes, applied to the `/api` prefix only. Exceeding it returns `429` with `{ "success": false, "message": "Too many requests, please try again later." }`. `trust proxy` is not configured, so behind Nginx the limit is effectively global rather than per-client ([G-06](./08-gap-analysis.md#g-06)).

---

## 6. Health

### `GET /health`

Public, outside `/api` and therefore outside the rate limiter.

```json
{ "success": true, "message": "Medical Billing API is running!", "timestamp": "2026-08-17T09:12:44.101Z" }
```

It does **not** check database or Redis connectivity — a `200` here does not mean the system can serve requests.

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

> ⚠️ No validation: password strength, email format and role validity are unchecked. An invalid role string fails at the database layer as a 500.

### `GET /api/auth/me` — any authenticated role

```json
{ "success": true, "data": { "user": { "id": "…", "name": "…", "email": "…", "role": "ADMIN", "isActive": true } } }
```

Returns the freshly-loaded user attached by `protect` — no additional query.

### `PUT /api/auth/change-password` — any authenticated role

```json
{ "currentPassword": "old", "newPassword": "new" }
```

**200** `Password changed successfully.` · **400** `Current password is incorrect.`

> No minimum length or complexity is enforced, and existing tokens remain valid after the change.

### `GET /api/users` — ADMIN

Returns all users ordered by newest first: `id, name, email, role, isActive, createdAt`. Never includes the password hash. Unpaginated.

### `POST /api/users` — ADMIN

`{ name, email, password, role? }` → **201** with the created user (no token). **409** on duplicate email.

### `PUT /api/users/:id` — ADMIN

`{ name?, email?, role?, isActive? }` → **200** with the updated user. Used by Settings for both editing and the active/inactive toggle. **404** if the id does not exist (`P2025`).

### `DELETE /api/users/:id` — ADMIN

**200** on success. **400** `You can't delete your own account` when `:id` equals the caller. Deleting a user who has raised invoices fails on the foreign key (surfaces as 500) — deactivate instead.

### `PUT /api/users/profile` — any authenticated role

`{ name?, email? }`, applied to the caller. **409** if the email belongs to another user. Note this route is declared before the admin routes so `profile` is never captured by `/:id`.

---

## 8. Inventory

All routes below require authentication (`router.use(protect)`).

### 8.1 Categories

| Method | Path | Role | Body |
|---|---|---|---|
| GET | `/api/inventory/categories` | any | — |
| POST | `/api/inventory/categories` | ADMIN, PHARMACIST | `{ name }` |
| PUT | `/api/inventory/categories/:id` | ADMIN, PHARMACIST | `{ name }` |
| DELETE | `/api/inventory/categories/:id` | ADMIN | — |

`name` must be ≥ 2 characters and unique (**409** otherwise). GET returns each category with `_count.medicines`, ordered by name:

```json
{ "success": true, "data": [ { "id": "clx…", "name": "Analgesic", "_count": { "medicines": 14 } } ] }
```

Deleting a category still referenced by a medicine violates the FK and returns **500** rather than a clean 409.

### 8.2 Manufacturers

Identical contract at `/api/inventory/manufacturers` — same methods, same roles, same `{ name }` body, same `_count.medicines` shape.

### 8.3 Medicines

#### `GET /api/inventory/medicines` — any role

| Query | Default | Purpose |
|---|---|---|
| `search` | — | Case-insensitive match on name, generic name or HSN |
| `categoryId` | — | Filter by category |
| `page` | 1 | |
| `limit` | 20 | |

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

⚠️ **`totalStock` is not total stock.** The query includes only the single nearest-expiry in-stock batch (`take: 1`), so this field reports that one batch's quantity. Multi-batch medicines are understated — [G-10](./08-gap-analysis.md#g-10).

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

| Field | Rule |
|---|---|
| `name` | required, ≥ 2 chars |
| `genericName`, `hsnCode` | optional strings |
| `categoryId`, `manufacturerId` | required, must exist |
| `unit` | one of `tablet, capsule, syrup, injection, cream, drops, powder, inhaler, other` |
| `gstPercent` | number, one of `0, 5, 12, 18` |
| `isScheduledH` | boolean, default `false` |

**201** with the created medicine including its category and manufacturer. Unknown fields are silently stripped by Zod.

#### `PUT /api/inventory/medicines/:id` — ADMIN, PHARMACIST

Same schema as create — all fields required, so send the complete object.

#### `DELETE /api/inventory/medicines/:id` — ADMIN

**Soft delete**: sets `isActive = false`. The record, its batches and its invoice history survive; it disappears from list and search. There is no un-delete endpoint.

### 8.4 Batches (stock)

#### `GET /api/inventory/batches` — any role

| Query | Effect |
|---|---|
| `medicineId` | Only this medicine's batches |
| `expiringSoon=true` | Expiry between today and +30 days |
| `lowStock=true` | `quantity ≤ 10` and `> 0` |

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

| Field | Rule |
|---|---|
| `medicineId`, `supplierId`, `batchNumber` | required, non-empty |
| `expiryDate` | any `Date.parse`-able string |
| `purchasePrice`, `sellingPrice` | numbers > 0 |
| `quantity` | positive integer |

The server sets `initialQty = quantity`. **409** if `(medicineId, batchNumber)` already exists.

> `mfgDate` is **not** in the schema, so Zod strips it even though the column and the controller support it. Manufacture date cannot currently be recorded — [G-04](./08-gap-analysis.md#g-04).

#### `PUT /api/inventory/batches/:id` — ADMIN, PHARMACIST

⚠️ **No validation middleware on this route.** The request body is passed to `prisma.batch.update` almost as-is (only `expiryDate` is coerced to a Date). Any column can be written, including `quantity`, `initialQty` and `medicineId`. Treat it as an admin-grade tool and see [G-05](./08-gap-analysis.md#g-05).

### 8.5 Suppliers

| Method | Path | Role |
|---|---|---|
| GET | `/api/inventory/suppliers?search=` | any |
| GET | `/api/inventory/suppliers/:id` | any |
| POST | `/api/inventory/suppliers` | ADMIN, PHARMACIST |
| PUT | `/api/inventory/suppliers/:id` | ADMIN, PHARMACIST |
| DELETE | `/api/inventory/suppliers/:id` | ADMIN |

`search` matches name (case-insensitive) or phone. Results ordered by name, unpaginated.

```json
{ "name": "MedPlus Distributors", "contactName": "Rahul", "phone": "9876543210",
  "email": "rahul@medplus.in", "gstNumber": "27AABCU9603R1ZM", "address": "…" }
```

`name` is required (≥ 2 chars); everything else is optional. `email` must be a valid address **or** an empty string.

`GET /:id` includes the 10 most recent `purchases` — always an empty array, because no purchase-creation path exists. **404** `Supplier not found`.

Deleting a supplier that has batches violates the FK and surfaces as **500**.

---

## 9. Billing

All routes require authentication.

### 9.1 Customers — `/api/billing/customers`

#### `GET /api/billing/customers` — any role

| Query | Default |
|---|---|
| `search` | — (name, phone or email) |
| `page` | 1 |
| `limit` | 20 |

```json
{
  "success": true,
  "data": [ { "id": "clc…", "name": "Ramesh Gupta", "phone": "9876543210",
              "email": null, "address": "…", "age": 54, "gender": "MALE",
              "createdAt": "…", "_count": { "invoices": 12 } } ],
  "pagination": { "total": 340, "page": 1, "limit": 20 }
}
```

Note: this endpoint's `pagination` omits `pages` (the invoice and medicine endpoints include it).

#### `GET /api/billing/customers/:id` — any role

The customer plus their 10 most recent invoices (`id, invoiceNumber, date, totalAmount, paymentMode, paymentStatus`). **404** `Customer not found`.

#### `POST /api/billing/customers` — any role

```json
{ "name": "Ramesh Gupta", "phone": "9876543210", "email": "", "address": "MG Road", "age": 54, "gender": "MALE" }
```

| Field | Rule |
|---|---|
| `name` | required, ≥ 2 chars |
| `phone` | optional, **unique** across customers → 409 |
| `email` | optional, valid email or `""` |
| `age` | optional, string or number, 0–150 |
| `gender` | optional, `MALE` \| `FEMALE` \| `OTHER` |

**201** with the created customer. This is the endpoint behind the POS "add customer" dialog.

#### `PUT /api/billing/customers/:id` — any role

Same schema. Sends all fields; omitted optional fields are written as `null`.

There is **no delete endpoint** for customers.

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

| Field | Rule |
|---|---|
| `customerId` | optional — omit for a walk-in sale |
| `items` | required, at least 1 |
| `items[].batchId`, `medicineId`, `medicineName` | required, non-empty |
| `items[].quantity` | positive integer |
| `items[].unitPrice` | positive number |
| `items[].discount` | 0–100, **percentage**, default 0 |
| `items[].gstPercent` | number, default 0 |
| `discountAmt` | ≥ 0, **flat currency amount** on the bill, default 0 |
| `paymentMode` | `CASH` \| `UPI` \| `CARD` \| `CREDIT`, default `CASH` |
| `paymentStatus` | `PAID` \| `PENDING` \| `PARTIAL`, default `PAID` |
| `notes` | optional string |

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

**Sequence:** stock is verified for every line → totals computed → invoice number generated → invoice, items and every batch decrement written inside one `prisma.$transaction`.

**201** returns the invoice with `items`, `customer` and `user.name`.

| Failure | Status | Message |
|---|---|---|
| Body fails schema | 400 | `Validation failed` + `errors[]` |
| A `batchId` does not exist | 404 | `Batch not found for <medicineName>` |
| Quantity exceeds stock | 400 | `Insufficient stock for <medicineName>. Available: <n>` |
| Invoice number collision | 409 | `A record with this value already exists.` (concurrency — [G-01](./08-gap-analysis.md#g-01)) |

There is **no update or delete** for invoices.

#### `GET /api/billing/invoices` — any role

| Query | Effect |
|---|---|
| `page`, `limit` | Pagination (defaults 1 / 20) |
| `search` | Invoice number or customer name, case-insensitive |
| `startDate` + `endDate` | Inclusive date range — **both must be supplied**, either alone is ignored |
| `paymentMode` | Exact enum match |
| `paymentStatus` | Exact enum match |

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

#### `GET /api/billing/invoices/gst-report?month=<1-12>&year=<yyyy>` — ADMIN, PHARMACIST

Every **`PAID`** invoice in the month, ascending by date, with items, plus period totals:

```json
{ "success": true, "data": { "invoices": [ … ], "totals": { "taxable": 412300.0, "cgst": 24738.0, "sgst": 24738.0, "total": 461776.0 } } }
```

`month` is 1-based. Both parameters are required and unvalidated — a missing or non-numeric value produces an `Invalid Date` range and an empty result rather than a 400.

#### `GET /api/billing/invoices/:id` — any role

The full invoice for printing: items (each with `batch.batchNumber` and `batch.expiryDate`), the complete customer record, and `user.name`. **404** `Invoice not found`.

> Route ordering matters here: `daily-summary` and `gst-report` are declared **before** `/:id`, so they are matched correctly. Keep any new literal sub-path above `/:id`.

---

## 10. Endpoints that do not exist

Documented elsewhere in the repo but absent from the code. Requests to these return **404** `Route not found: …`.

| Claimed in | Path | Reality |
|---|---|---|
| root + backend README | `POST /api/auth/logout` | Logout is client-side only |
| backend README | `POST /api/auth/refresh` | `generateRefreshToken` exists, no route |
| backend README | `POST /api/auth/forgot-password`, `/reset-password` | Not implemented |
| backend README | `PUT /api/users/:id/password`, `/:id/role` | Covered by `PUT /api/users/:id` |
| root + backend README | `/api/customers/*` | Use `/api/billing/customers` |
| root + backend README | `/api/medicines/*` | Use `/api/inventory/medicines` |
| root + backend README | `/api/suppliers/*` | Use `/api/inventory/suppliers` |
| root + backend README | `/api/reports/*` (sales, inventory, billing, top-medicines, daily-sales, low-stock, gst-summary) | Use `/api/billing/invoices/daily-summary`, `/gst-report`, `/api/inventory/batches/expiring`, `/low-stock` |
| backend README | `GET /api/inventory` , `/inventory/add`, `/inventory/remove` | Stock moves only via batch create and invoice create |
| backend README | `GET /api/billing/:id/invoice` (download) | Printing is browser-side |
| backend README | `DELETE /api/billing/:id`, `PUT /api/billing/:id` | Invoices are immutable |
| Architecture.txt | `POST /api/batches`, `GET /api/batches/expiring` | Under `/api/inventory/` |

`backend/src/routes/customer.routes.js`, `medicine.routes.js`, `report.routes.js` and `supplier.routes.js` are **empty placeholder files** — nothing imports them.

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
