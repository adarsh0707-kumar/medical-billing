# 07 — Security

**Scope:** the security posture of v1.0.0 as built. Every control listed as present was verified in source; every gap is actionable.

---

## 1. Summary

| Area | Posture |
|---|---|
| Authentication | **Solid** — bcrypt cost 12, no user enumeration, per-request user revalidation |
| Authorisation | **Solid** — server-enforced RBAC on every mutating route |
| Injection | **Solid** — Prisma parameterises everything, no raw SQL anywhere |
| Input validation | **Mixed** — Zod on most write routes, absent on four |
| Token handling | **Weak** — `localStorage`, no revocation, no refresh, 7-day lifetime |
| Transport | **Absent** — no TLS configuration exists |
| Secrets | **Weak** — database password hard-coded in `docker-compose.yml`; seeded admin password in the repo |
| Auditability | **Absent** — only invoice authorship is recorded |
| Rate limiting | **Present but ineffective behind the proxy** |

The system is defensible on a trusted LAN with the fixes in §9. It is **not ready** for internet exposure.

---

## 2. Authentication

**Registration.** Only an `ADMIN` can create users, through `POST /api/auth/register` or `POST /api/users`. There is no self-service signup — correct for this product.

**Password storage.** `bcrypt.hash(password, 12)`. Cost 12 is appropriate for 2026. Hashes are never selected into any response; the only queries that read the hash are `login` and `changePassword`.

**Login.** Unknown email, wrong password and deactivated account all return the identical `401 Invalid credentials.` — no user enumeration through the response body. (Timing is not equalised: a nonexistent email skips the bcrypt comparison and returns measurably faster. A determined attacker can enumerate accounts through timing; the fix is a dummy comparison on the miss path.)

**Token issuance.** `jwt.sign({ id }, JWT_SECRET, { expiresIn: "7d" })`. HS256. The payload carries only the user id — role is **not** in the token, which is why `protect` reloads the user.

**Per-request revalidation.** Every protected request re-reads the user and rejects `isActive === false`. This means deactivating a user takes effect immediately, without waiting for token expiry — a genuinely good property that most JWT designs lack.

### Weaknesses

| # | Issue | Impact |
|---|---|---|
| A-1 | Token stored in `localStorage` | Any XSS reads it and exfiltrates a 7-day credential |
| A-2 | No revocation / denylist | A leaked token is valid for up to 7 days; logout is client-side only |
| A-3 | 7-day lifetime with no refresh rotation | Long exposure window; `generateRefreshToken` exists but is unused |
| A-4 | No password policy | `"1"` is an acceptable password — no length, complexity or breach check |
| A-5 | No login rate limiting beyond the global 500/15 min | Password guessing is cheap, especially since the limiter is shared behind the proxy |
| A-6 | Password change does not invalidate existing tokens | A compromised session survives the user's response to the compromise |
| A-7 | Seeded admin `admin@medstore.com` / `admin123` is public in the repository | Any unchanged deployment is trivially owned |
| A-8 | No MFA | Acceptable for the threat model; note it |

---

## 3. Authorisation

Two middlewares compose to give the model:

```js
protect                       // authenticated?
authorize("ADMIN", "PHARMACIST")   // permitted?
```

`authorize` is a strict allowlist — `ADMIN` is not implicitly granted a `PHARMACIST` route; every route that pharmacists may use lists `"ADMIN"` explicitly. The codebase does this consistently, which is why the hierarchy holds.

The full permission matrix is in [04 §4](./04-api-reference.md#4-role-matrix).

### Design notes

- **Client-side checks are cosmetic.** The role-filtered sidebar and `ProtectedRoute` improve UX; the server is the boundary. A cashier calling `GET /api/users` directly gets `403` regardless of what the UI shows.
- **Read is broadly permitted.** Every authenticated role can read inventory, customers and invoices, including other operators' invoices. Intentional for a small store; revisit if staff counts grow.
- **The GST report is the only report gated by role** (ADMIN/PHARMACIST). The daily summary is open to cashiers — meaning a cashier can see whole-day store revenue. Confirm that is intended.
- **Deletes are ADMIN-only** across categories, manufacturers, medicines, suppliers and users. Good.
- **Customer writes are open to all roles**, including create and update. A cashier can alter any customer record. Low risk, but there is no audit trail.

---

## 4. Input validation

`validate(schema)` runs `safeParse`, returns `400` with field-level errors on failure, and **replaces `req.body` with the parsed output** on success. Because Zod objects strip unknown keys by default, this also acts as a mass-assignment guard.

| Route | Validated |
|---|:--:|
| `POST/PUT /api/inventory/categories`, `/manufacturers`, `/medicines`, `/suppliers` | ✅ |
| `POST /api/inventory/batches` | ✅ |
| `POST/PUT /api/billing/customers` | ✅ |
| `POST /api/billing/invoices` | ✅ |
| **`PUT /api/inventory/batches/:id`** | ❌ Body forwarded to Prisma nearly raw — [G-05](./08-gap-analysis.md#g-05) |
| **`POST /api/auth/register`** | ❌ No email/password/role checks |
| **`POST /api/users`** | ❌ Same |
| **`PUT /api/users/:id`** | ❌ Role and `isActive` accepted unchecked |
| `POST /api/auth/login` | ❌ Presence check only (acceptable) |

The four unvalidated write routes are all `ADMIN`-gated except the batch update (also `PHARMACIST`), which limits blast radius but does not excuse them.

**Query parameters are not validated anywhere.** `?month=abc` on the GST report produces `Invalid Date` and an empty result rather than a 400. `?limit=999999` on any list endpoint is honoured — a trivial resource-exhaustion vector.

---

## 5. Injection & data-access safety

- **SQL injection:** not reachable. Every query goes through Prisma's parameterised client; there is no `$queryRaw`/`$executeRaw` in the codebase.
- **NoSQL/ORM operator injection:** query values are interpolated into `contains`/`equals` filters as plain strings, never spread from user input into Prisma operator objects.
- **Mass assignment:** blocked by Zod's key-stripping on validated routes; **open** on the four routes above, most notably `PUT /api/inventory/batches/:id`, where `{ "quantity": 999999 }` or `{ "medicineId": "other" }` is accepted.
- **XSS:** React escapes interpolated content by default and there is no `dangerouslySetInnerHTML` in the codebase. The residual risk is a dependency-borne XSS combined with A-1.
- **CSRF:** not applicable — authentication is a bearer header, not a cookie, so browsers do not attach it automatically.

---

## 6. Network & transport

**Security headers.** `helmet()` with defaults: `X-Content-Type-Options`, `X-Frame-Options`, `X-DNS-Prefetch-Control`, `Cross-Origin-*`, and a restrictive default CSP. Note Helmet's CSP is applied to API JSON responses, not to the SPA — the SPA is served by Vite/Nginx and carries **no CSP at all**.

**CORS.** Explicit allowlist with `credentials: true`:

```
http://localhost:3000, http://localhost:5173, http://127.0.0.1:5173,
http://172.17.0.1:5173, process.env.FRONTEND_URL
```

Requests with **no Origin header are allowed** (`if (!origin) callback(null, true)`) — necessary for curl and server-to-server calls, and not a vulnerability by itself since browsers always send Origin on cross-origin requests. The real problem is the opposite: the Nginx origin (`http://localhost`, port 80) is **missing**, so the documented entry point fails ([G-02](./08-gap-analysis.md#g-02)).

**Rate limiting.** 500 requests / 15 minutes on `/api`. Two flaws:

1. `app.set('trust proxy', …)` is never called, so behind Nginx `req.ip` is the proxy's container IP. **All clients share one bucket** — one busy user can lock out the store, and an attacker is never isolated ([G-06](./08-gap-analysis.md#g-06)).
2. There is no stricter limit on `/api/auth/login`. 500 attempts per window is a comfortable password-guessing budget.

**TLS.** None. Nginx listens on `:80` only. Credentials and tokens cross the network in cleartext. On a switched LAN this is a moderate risk; on anything else it is disqualifying.

**Exposed data ports.** `docker-compose.yml` publishes Postgres (5432) and Redis (6379) to the host. Redis has no password. If the host has a public interface, both are directly reachable.

---

## 7. Secrets management

| Secret | Where it lives | Assessment |
|---|---|---|
| `JWT_SECRET` | Host env / root `.env`, interpolated by compose | ✅ Correct pattern. No default fallback — an unset value fails loudly at login rather than signing with a guessable key |
| Postgres credentials | **Hard-coded** in `docker-compose.yml` (`medadmin` / `medpass123`) | ❌ Committed to git |
| Seeded admin password | **Hard-coded** in `src/utils/seed.js` (`admin123`) | ❌ Committed to git |
| `.env` files | Gitignored (`backend/.env`, `frontend/.env`, root `.env`) | ✅ |

There is no secret rotation story. Rotating `JWT_SECRET` invalidates every session at once, which is a blunt but working revocation mechanism in an emergency.

---

## 8. Privacy considerations

The system stores customer **name, phone, email, address, age, gender** and a complete **medicine purchase history**. Purchase history in a pharmacy context reveals health conditions — this is health-adjacent personal data even though the system holds no clinical records.

Current state:

- No encryption at rest beyond whatever the host volume provides.
- No retention limit — records are kept forever, and there is no customer-delete endpoint.
- No access log of who viewed a customer record.
- No consent capture or privacy notice.
- Any authenticated user of any role can read every customer's full purchase history.

Before handling real customers, decide: retention period, deletion path (right-to-erasure), and whether cashiers need customer history at all. See [PRD Q6](./01-product-requirements.md#14-open-questions).

**Schedule H note.** The system flags prescription-only medicines but stores no prescription record and does not block the sale ([FR-MED-12](./01-product-requirements.md#64-medicine-catalogue--fr-med)). Where the Drugs and Cosmetics Rules require a prescription record for such sales, this system does not by itself satisfy that obligation.

---

## 9. Threat model

Assets: customer PII and purchase history · financial records (invoices, GST liability) · stock levels and pricing · user credentials.

| # | Threat | Vector | Likelihood | Impact | Current control | Residual |
|---|---|---|---|---|---|---|
| T-1 | Credential stuffing / brute force on login | Public login endpoint | Med | High | bcrypt, 500/15min shared limit | **High** — needs a per-IP login limiter |
| T-2 | Default admin credentials unchanged | Public repo | High | Critical | Seed script warns in stdout | **Critical** — force a change on first login |
| T-3 | Token theft via XSS | `localStorage` + dependency-borne XSS | Low | High | React escaping, no `dangerouslySetInnerHTML` | Med — no CSP on the SPA |
| T-4 | Token theft on the wire | No TLS | Med (LAN) | High | None | **High** — TLS required |
| T-5 | Privilege escalation | Guessing admin routes | Low | High | `authorize()` on every route | Low |
| T-6 | Stock/price tampering | Unvalidated `PUT /batches/:id` | Med | High | ADMIN/PHARMACIST only | **Med** — add a schema + audit log |
| T-7 | Direct database access | Exposed :5432 with a committed password | Med | Critical | None | **Critical** in any exposed deployment |
| T-8 | Unauthenticated Redis access | Exposed :6379, no auth | Med | Low today (empty) | None | Low now, High once caching lands |
| T-9 | Insider data exfiltration | Any role can page through all customers | Med | Med | None — no logging or export controls | **Med** |
| T-10 | Denial of service | `?limit=999999`, shared rate bucket | Med | Med | Global limiter | Med |
| T-11 | Financial data corruption | Concurrency races ([G-01](./08-gap-analysis.md#g-01), [G-09](./08-gap-analysis.md#g-09)) | Med | High | None | **High** — Phase 7 |
| T-12 | Repudiation of a sale | No audit trail beyond `Invoice.userId` | Low | Med | Invoice authorship | Med |

---

## 10. Hardening backlog

**P0 — before any non-local deployment**

1. Force a password change for the seeded admin on first login; remove the credential from the repo's default path.
2. Terminate TLS at Nginx; redirect 80 → 443; enable HSTS.
3. Stop publishing 5432 and 6379 to the host; move Postgres credentials out of `docker-compose.yml`.
4. `app.set('trust proxy', 1)` and add a strict per-IP limiter on `/api/auth/login` (e.g. 10 / 15 min).
5. Add Zod schemas to `PUT /api/inventory/batches/:id`, `POST /api/auth/register`, `POST /api/users`, `PUT /api/users/:id`.

**P1 — next**

6. Password policy: minimum length, breach check, and a forced reset flow.
7. Invalidate tokens on password change and on deactivation (a Redis denylist keyed by user id + issued-at).
8. Shorten the access token to 15–60 minutes and implement the refresh rotation the util already anticipates.
9. Add a CSP header to the SPA.
10. Clamp `limit` on every paginated endpoint and validate query parameters.
11. Add an audit log — a Prisma middleware capturing actor, entity, before/after on every write, is the cheapest complete answer.

**P2 — hardening and hygiene**

12. Equalise login timing with a dummy bcrypt comparison on the user-miss path.
13. Redis `requirepass` before caching goes live.
14. Dependency scanning (`npm audit` / Dependabot) in CI.
15. Restrict customer-history reads by role if staff counts grow.
16. Document key rotation for `JWT_SECRET` and database credentials.
