# Security

**Scope:** the security posture of v1.0.0 as built. Every control listed as present was verified in source; every gap is actionable.

---

## 1. Summary

| Area             | Posture                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| Authentication   | **Solid** — bcrypt cost 12, no user enumeration, per-request user revalidation                       |
| Authorisation    | **Solid** — server-enforced RBAC on every mutating route                                             |
| Injection        | **Solid** — Prisma parameterises everything; the single raw statement uses a bound tagged template   |
| Input validation | **Solid** — Zod on every mutating route body, and on every query string since 2026-08-20             |
| Token handling   | **Weak** — `localStorage`, no revocation, no refresh, 7-day lifetime                               |
| Transport        | **Absent** — no TLS configuration exists                                                             |
| Secrets          | **Weak** — database password hard-coded in `docker-compose.yml`; seeded admin password in the repo |
| Auditability     | **Absent** — only invoice authorship is recorded                                                     |
| Rate limiting    | **Solid** — per-client behind the proxy, with a separate failed-login budget                         |

The system is defensible on a trusted LAN. It is **not ready** for internet exposure — TLS, secrets management and token revocation are the blockers; see §10.

*Last revised 2026-08-19, after the Phase 7 validation and rate-limiting work.*

---

## 2. Authentication

**Registration.** Only an `ADMIN` can create users, through `POST /api/auth/register` or `POST /api/users`. There is no self-service signup — correct for this product.

**Password storage.** `bcrypt.hash(password, 12)`. Cost 12 is appropriate for 2026. Hashes are never selected into any response; the only queries that read the hash are `login` and `changePassword`.

**Login.** Unknown email, wrong password and deactivated account all return the identical `401 Invalid credentials.` — no user enumeration through the response body. (Timing is not equalised: a nonexistent email skips the bcrypt comparison and returns measurably faster. A determined attacker can enumerate accounts through timing; the fix is a dummy comparison on the miss path.)

**Token issuance.** `jwt.sign({ id }, JWT_SECRET, { expiresIn: "7d" })`. HS256. The payload carries only the user id — role is **not** in the token, which is why `protect` reloads the user.

**Per-request revalidation.** Every protected request re-reads the user and rejects `isActive === false`. This means deactivating a user takes effect immediately, without waiting for token expiry — a genuinely good property that most JWT designs lack.

### Weaknesses

| #        | Issue                                                                         | Impact                                                                       |
| -------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| A-1      | Token stored in`localStorage`                                               | Any XSS reads it and exfiltrates a 7-day credential                          |
| A-2      | No revocation / denylist                                                      | A leaked token is valid for up to 7 days; logout is client-side only         |
| A-3      | 7-day lifetime with no refresh rotation                                       | Long exposure window;`generateRefreshToken` exists but is unused           |
| A-4      | Weak password policy                                                          | Minimum length 8 since 2026-08-19; still no complexity or breach check       |
| ~~A-5~~ | ~~No login rate limiting~~                                                   | **Fixed 2026-08-19** — 10 failed attempts / 15 min per real client IP |
| A-6      | Password change does not invalidate existing tokens                           | A compromised session survives the user's response to the compromise         |
| A-7      | Seeded admin`admin@medstore.com` / `admin123` is public in the repository | Any unchanged deployment is trivially owned                                  |
| A-8      | No MFA                                                                        | Acceptable for the threat model; note it                                     |

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

| Route                                                                                      |                                                    Validated                                                    |
| ------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------: |
| `POST/PUT /api/inventory/categories`, `/manufacturers`, `/medicines`, `/suppliers` |                                                        ✅                                                        |
| `POST /api/inventory/batches`                                                            |                                                        ✅                                                        |
| `POST/PUT /api/billing/customers`                                                        |                                                        ✅                                                        |
| `POST /api/billing/invoices`                                                             |                                                        ✅                                                        |
| `PUT /api/inventory/batches/:id`                                                         | ✅ Strict narrow schema;`quantity`, `initialQty` and FK columns rejected — [G-05](./08-gap-analysis.md#g-05) |
| `POST /api/auth/register`                                                                |                            ✅`createUserSchema` — [G-11](./08-gap-analysis.md#g-11)                            |
| `POST /api/users`                                                                        |                                              ✅`createUserSchema`                                              |
| `PUT /api/users/:id`                                                                     |                                  ✅`updateUserSchema` — role is enum-checked                                  |
| `POST /api/auth/login`                                                                   |                                       ❌ Presence check only (acceptable)                                       |

As of 2026-08-19 every mutating route runs a schema. `PUT /api/users/profile` and the batch update are additionally `.strict()`, so an unexpected field is a `400` rather than something that looks accepted and is silently dropped — the failure mode behind [G-04](./08-gap-analysis.md#g-04).

~~**Query parameters are not validated anywhere.**~~ **Fixed 2026-08-20.** Every query string now passes through `validateQuery(schema)` before its controller. `limit` is capped at 100, `month`/`year` are required and range-checked, and `days`/`threshold` are coerced and bounded instead of falling back through `Number(x) || default` — which used to turn a typo into plausible wrong data.

The rule: **absent means use the default; present but unparseable or out of range is a 400.** An over-large `limit` is rejected rather than silently clamped, because a caller who asks for 999999 and quietly receives 100 will page through the result set believing they have all of it.

---

## 5. Injection & data-access safety

- **SQL injection:** not reachable. Every query goes through Prisma's parameterised client. There is exactly one raw statement — the invoice-serial upsert in `invoice.utils.js` ([G-01](./08-gap-analysis.md#g-01)) — and it uses a `$queryRaw` tagged template, so its two interpolations are bound parameters rather than string concatenation. Keep it that way: `$queryRawUnsafe` must not appear in this codebase.
- **NoSQL/ORM operator injection:** query values are interpolated into `contains`/`equals` filters as plain strings, never spread from user input into Prisma operator objects.
- **Mass assignment:** blocked by Zod's key-stripping on every mutating route. The two highest-value targets go further and reject unknown keys outright: `PUT /api/inventory/batches/:id` (so `quantity`, `initialQty` and the FK columns cannot be written) and `PUT /api/users/profile` (so a stray `role` cannot look accepted).
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

Requests with **no Origin header are allowed** (`if (!origin) callback(null, true)`) — necessary for curl and server-to-server calls, and not a vulnerability by itself since browsers always send Origin on cross-origin requests.

Since 2026-08-19 the SPA is **same-origin** on both entry points (nginx on `:80`, the Vite dev-server proxy on `:5173`), so CORS no longer governs the application at all — it only affects tools calling port 5000 directly. `http://localhost` was added to the allowlist for those ([G-02](./08-gap-analysis.md#g-02)).

**Rate limiting.** 500 requests / 15 minutes on `/api`. Two flaws:

1. ~~`trust proxy` is never called~~ **Fixed 2026-08-19.** `trust proxy` is set to `loopback, linklocal, uniquelocal`, so behind Nginx the real client IP keys the limiter, while a client reaching port 5000 directly cannot forge `X-Forwarded-For` to pick its own bucket ([G-06](./08-gap-analysis.md#g-06)).
2. ~~No stricter limit on `/api/auth/login`~~ **Fixed 2026-08-19.** 10 failed attempts per 15 minutes per IP, with successful sign-ins not counted.

**TLS.** None. Nginx listens on `:80` only. Credentials and tokens cross the network in cleartext. On a switched LAN this is a moderate risk; on anything else it is disqualifying.

**Exposed data ports.** `docker-compose.yml` publishes Postgres (5432) and Redis (6379) to the host. Redis has no password. If the host has a public interface, both are directly reachable.

---

## 7. Secrets management

| Secret                | Where it lives                                                                 | Assessment                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `JWT_SECRET`        | Host env / root`.env`, interpolated by compose                               | ✅ Correct pattern. No default fallback — an unset value fails loudly at login rather than signing with a guessable key |
| Postgres credentials  | **Hard-coded** in `docker-compose.yml` (`medadmin` / `medpass123`) | ❌ Committed to git                                                                                                      |
| Seeded admin password | **Hard-coded** in `src/utils/seed.js` (`admin123`)                   | ❌ Committed to git                                                                                                      |
| `.env` files        | Gitignored (`backend/.env`, `frontend/.env`, root `.env`)                | ✅                                                                                                                       |

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

| #    | Threat                                     | Vector                                                                                 | Likelihood | Impact            | Current control                                                                             | Residual                                                             |
| ---- | ------------------------------------------ | -------------------------------------------------------------------------------------- | ---------- | ----------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| T-1  | Credential stuffing / brute force on login | Public login endpoint                                                                  | Med        | High              | bcrypt, per-IP limiter: 10 failed logins / 15 min                                           | Low — timing still leaks whether an email exists (P2-12)            |
| T-2  | Default admin credentials unchanged        | Public repo                                                                            | High       | Critical          | Seed script warns in stdout                                                                 | **Critical** — force a change on first login                  |
| T-3  | Token theft via XSS                        | `localStorage` + dependency-borne XSS                                                | Low        | High              | React escaping, no`dangerouslySetInnerHTML`                                               | Med — no CSP on the SPA                                             |
| T-4  | Token theft on the wire                    | No TLS                                                                                 | Med (LAN)  | High              | None                                                                                        | **High** — TLS required                                       |
| T-5  | Privilege escalation                       | Guessing admin routes                                                                  | Low        | High              | `authorize()` on every route                                                              | Low                                                                  |
| T-6  | Stock/price tampering                      | `PUT /batches/:id`                                                                   | Low        | High              | ADMIN/PHARMACIST only; strict schema, stock not editable                                    | Low — price edits are still untracked, pending an audit log (P1-11) |
| T-7  | Direct database access                     | Exposed :5432 with a committed password                                                | Med        | Critical          | None                                                                                        | **Critical** in any exposed deployment                         |
| T-8  | Unauthenticated Redis access               | Exposed :6379, no auth                                                                 | Med        | Low today (empty) | None                                                                                        | Low now, High once caching lands                                     |
| T-9  | Insider data exfiltration                  | Any role can page through all customers                                                | Med        | Med               | None — no logging or export controls                                                       | **Med**                                                        |
| T-10 | Denial of service                          | ~~`?limit=999999`~~, shared rate bucket                                             | Med        | Med               | Per-client limiter;`limit` capped at 100 and every query parameter validated (2026-08-20) | Low — bounded page sizes; volumetric DoS remains out of scope       |
| T-11 | Financial data corruption                  | Concurrency races ([G-01](./08-gap-analysis.md#g-01), [G-09](./08-gap-analysis.md#g-09)) | Med        | High              | None                                                                                        | **High** — Phase 7                                            |
| T-12 | Repudiation of a sale                      | No audit trail beyond`Invoice.userId`                                                | Low        | Med               | Invoice authorship                                                                          | Med                                                                  |

---

## 10. Hardening backlog

**P0 — before any non-local deployment**

1. ~~Force a password change for the seeded admin on first login~~ **Done 2026-08-20** — enforced server-side by `password-change.middleware.js`, which answers `403 PASSWORD_CHANGE_REQUIRED` to every route but the two a blocked user needs. T-2 residual drops from Critical to Low.
2. ~~Terminate TLS at Nginx; redirect 80 → 443; enable HSTS~~ **Done 2026-08-20** — `nginx/nginx.prod.conf`, with a CSP, `X-Frame-Options`, `Referrer-Policy` and `Permissions-Policy` alongside.
3. ~~Stop publishing 5432 and 6379 to the host; move Postgres credentials out of `docker-compose.yml`~~ **Done 2026-08-20** in `docker-compose.prod.yml`. Redis was removed rather than secured.
4. ~~`trust proxy` and a strict per-IP limiter on `/api/auth/login`~~ — **done 2026-08-19.**
5. ~~Zod schemas on `PUT /api/inventory/batches/:id`, `POST /api/auth/register`, `POST /api/users`, `PUT /api/users/:id`~~ — **done 2026-08-19.**

**P1 — next**

6. Password policy: ~~minimum length~~ (done — 8 chars), breach check, and a forced reset flow.
7. Invalidate tokens on password change and on deactivation (a Redis denylist keyed by user id + issued-at).
8. Shorten the access token to 15–60 minutes and implement the refresh rotation the util already anticipates.
9. Add a CSP header to the SPA.
10. ~~Clamp `limit` on every paginated endpoint and validate query parameters.~~ **Done 2026-08-20** — `validateQuery` on all 10 query surfaces, `MAX_LIMIT` 100, 44 tests.
11. Add an audit log — a Prisma middleware capturing actor, entity, before/after on every write, is the cheapest complete answer.

**P2 — hardening and hygiene**

12. Equalise login timing with a dummy bcrypt comparison on the user-miss path.
13. Redis `requirepass` before caching goes live.
14. Dependency scanning (`npm audit` / Dependabot) in CI.
15. Restrict customer-history reads by role if staff counts grow.
16. Document key rotation for `JWT_SECRET` and database credentials.
