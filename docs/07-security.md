# Security

**Scope:** the security posture of v1.0.0 as built. Every control listed as present was verified in source; every gap is actionable.

---

## 1. Summary

| Area             | Posture                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| Authentication   | **Solid** — bcrypt cost 12, no enumeration through the body or through timing, per-request revalidation, minimum-12 password policy with a blocklist |
| Authorisation    | **Solid** — server-enforced RBAC on every mutating route                                             |
| Injection        | **Solid** — Prisma parameterises everything; all five raw statements are bound tagged templates, and `$queryRawUnsafe` appears nowhere |
| Input validation | **Solid** — Zod on every mutating route body, and on every query string since 2026-08-20             |
| Token handling   | **Solid** — 30-minute access tokens, a rotating `HttpOnly` refresh cookie with reuse detection, and three ways to revoke: logout, password change, deactivation |
| Transport        | **Solid in production** — TLS 1.2/1.3, HSTS at one year, 80 → 443 and a CSP in `nginx/nginx.prod.conf`. The development stack is plain HTTP **by design** |
| Secrets          | **Solid in production** — `docker-compose.prod.yml` carries no credential literals and refuses to start without them. The development compose file keeps its literals, deliberately |
| Auditability     | **Solid for writes** — actor, model and before/after recorded for every write to master data. Reads are deliberately not logged (see [03 §3.11](./03-data-model.md#311-auditlog--who-changed-what)) |
| Rate limiting    | **Solid** — per-client behind the proxy, with a separate failed-login budget                         |

**Read every row above as a statement about a specific stack.** `docker-compose.yml` is a development configuration: it speaks plain HTTP, publishes Postgres on the host and carries `medadmin`/`medpass123` in the file. None of that is a finding — it is what a development stack is for, and [SECURITY.md](../SECURITY.md#scope) puts findings against a deployment that skipped the hardening checklist out of scope. `docker-compose.prod.yml` is the deployable one, and it is where this document's claims about TLS, secrets and port exposure apply.

The blockers named in earlier revisions of this document — transport, secrets, token revocation, auditability — have all been addressed. What remains is **not a code gap**: a real TLS certificate in place of the self-signed one, and a retention decision for customer records. Both are the operator's, and both are in [SECURITY.md](../SECURITY.md#for-operators). The largest outstanding item in §10 is a forced-reset flow, and the largest unaddressed threat is T-9 — every authenticated role can read every customer's purchase history.

*Last revised 2026-08-22, after the Phase 8 production work. The previous revision predated it and described TLS as absent, which contradicted the operator checklist that points here for its reasoning.*

---

## 2. Authentication

**Registration.** Only an `ADMIN` can create users, through `POST /api/auth/register` or `POST /api/users`. There is no self-service signup — correct for this product.

**Password storage.** `bcrypt.hash(password, 12)`. Cost 12 is appropriate for 2026. Hashes are never selected into any response; the only queries that read the hash are `login` and `changePassword`.

**Login.** Unknown email, wrong password and deactivated account all return the identical `401 Invalid credentials.` — no user enumeration through the response body, and since 2026-08-22 none through timing either. Every login spends exactly one bcrypt comparison: when the account does not exist the password is checked against a decoy hash generated from random bytes at start-up, at the same cost 12 real passwords are stored with. Measured before the change, an unknown email answered in about 5 ms against 380 ms for a wrong password — the whole cost of bcrypt, and trivially distinguishable. Measured after, the two differ by roughly 12 ms.

> The deactivated-account path had the same hole and is easy to miss: it short-circuited before the comparison too, so a suspended account was distinguishable from an active one with a wrong password — which discloses that the account exists just as surely.

**Token issuance.** `jwt.sign({ id, tokenVersion }, JWT_SECRET, { expiresIn: "30m" })`. HS256. The payload carries the user id and the revocation counter — role is **not** in the token, which is why `protect` reloads the user. The week-long half of the session is a separate refresh token held in an `HttpOnly` cookie.

**Per-request revalidation.** Every protected request re-reads the user and rejects `isActive === false`. This means deactivating a user takes effect immediately, without waiting for token expiry — a genuinely good property that most JWT designs lack.

### Weaknesses

| #        | Issue                                                                         | Impact                                                                       |
| -------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| A-1      | Access token stored in`localStorage`                                        | **Reduced 2026-08-22.** XSS still reads it, but it is now a **30-minute** credential rather than a 7-day one. The week-long half is a `refresh_token` cookie marked `HttpOnly`, which script cannot read — so an XSS gets a short window, not a renewable session. Moving the access token out of `localStorage` too would mean holding it in memory and re-authenticating on every page load |
| ~~A-2~~ | ~~No revocation / denylist~~                                                 | **Fixed 2026-08-22** — `POST /api/auth/logout` increments `User.tokenVersion`, and `protect` rejects any token carrying a stale copy. Ends every session for that account, so a leaked token dies with the one the user actually signed out of. No denylist and no new dependency: the check rides on the user reload `protect` already performs |
| ~~A-3~~ | ~~7-day lifetime with no refresh rotation~~                                  | **Fixed 2026-08-22.** Access tokens last 30 minutes; `POST /api/auth/refresh` exchanges an `HttpOnly` cookie for a new one and **rotates** it each time. Every refresh token is backed by a `RefreshToken` row, so replaying a rotated one is detectable — it means two parties hold the same credential, and the response is to end every session for that user. `generateRefreshToken`, unused since 1.0.0, is what this is built on |
| ~~A-4~~ | ~~Weak password policy~~                                                      | **Strengthened 2026-08-22** — minimum 12, a blocklist that also matches the stem of a padded password, rejection of repeated characters and sequential runs, of the credentials this repository publishes, and of anything containing the account's own name or email. No character-class rules and no breach lookup, both deliberately; see §10 P1-6 |
| ~~A-5~~ | ~~No login rate limiting~~                                                   | **Fixed 2026-08-19** — 10 failed attempts / 15 min per real client IP |
| ~~A-6~~ | ~~Password change does not invalidate existing tokens~~                      | **Fixed 2026-08-22** — a change bumps `tokenVersion`, ending every session for the account. The caller receives a replacement token in the response, so whoever proved they know the current password carries on and everyone else is signed out. Deactivation bumps it too: it used to be a *pause*, and reactivating an account resurrected every token outstanding when it was suspended |
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

- **SQL injection:** not reachable. Every query goes through Prisma's parameterised client, and the raw statements are all `$queryRaw` **tagged templates**, so their interpolations are bound parameters rather than string concatenation. There are five, each with a reason it cannot be expressed through the query builder:

  | Where                              | Statement                                | Why raw                                                   |
  | ---------------------------------- | ---------------------------------------- | --------------------------------------------------------- |
  | `utils/invoice.utils.js`         | `InvoiceCounter` upsert (sale serial)  | `INSERT … ON CONFLICT DO UPDATE … RETURNING` is the atomicity ([G-01](./08-gap-analysis.md#g-01)) |
  | `utils/invoice.utils.js`         | `InvoiceCounter` upsert (credit note)  | Same, namespaced to a`CRN` key                            |
  | `controllers/billing.controller.js` | 7-day sales trend                     | `date_trunc` grouping with zero-filled days ([G-08](./08-gap-analysis.md#g-08)) |
  | `controllers/dashboard.controller.js` | 7-day sales trend                    | A second copy of the same aggregation — see the note below |
  | `app.js`                         | `SELECT 1`                             | The readiness probe; no user input reaches it              |

  Keep it that way: **`$queryRawUnsafe` must not appear in this codebase**, and does not.

  > Not a security issue, but worth recording where the raw statements are catalogued: the trend aggregation is implemented **twice**, in `billing.controller.js#getTrend` and inline in `dashboard.controller.js#getStats`. Two copies of one query is how they drift, and any change to the counting or filtering rule has to be made in both.
- **NoSQL/ORM operator injection:** query values are interpolated into `contains`/`equals` filters as plain strings, never spread from user input into Prisma operator objects.
- **Mass assignment:** blocked by Zod's key-stripping on every mutating route. The two highest-value targets go further and reject unknown keys outright: `PUT /api/inventory/batches/:id` (so `quantity`, `initialQty` and the FK columns cannot be written) and `PUT /api/users/profile` (so a stray `role` cannot look accepted).
- **XSS:** React escapes interpolated content by default and there is no `dangerouslySetInnerHTML` in the codebase. The residual risk is a dependency-borne XSS combined with A-1.
- **CSRF:** not applicable — authentication is a bearer header, not a cookie, so browsers do not attach it automatically.

---

## 6. Network & transport

**Security headers.** Two layers, because they protect different things.

`helmet()` covers **API responses**: `X-Content-Type-Options`, `X-Frame-Options`, `X-DNS-Prefetch-Control`, `Cross-Origin-*` and a restrictive default CSP. That CSP applies to JSON, not to the document the browser renders, so on its own it does nothing for the SPA.

The SPA's headers come from **nginx in production** (`nginx/nginx.prod.conf`): HSTS at one year with `includeSubDomains`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` denying camera/microphone/geolocation/payment, and a CSP of

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self' data:; connect-src 'self';
frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'
```

`'unsafe-inline'` on `style-src` is required by Tailwind's runtime style injection and the inline styles shadcn components emit. `script-src` has no such escape, which is the half that matters against the XSS-plus-`localStorage` path in T-3. `preload` is deliberately omitted from HSTS: it is close to irreversible and belongs to whoever owns the domain.

**The development stack has none of these** — it is plain HTTP through `nginx/nginx.conf`, which is twenty lines of `proxy_pass`. That is deliberate, not an oversight.

**CORS.** Explicit allowlist with `credentials: true`:

```
http://localhost:3000, http://localhost:5173, http://127.0.0.1:5173,
http://172.17.0.1:5173, process.env.FRONTEND_URL
```

Requests with **no Origin header are allowed** (`if (!origin) callback(null, true)`) — necessary for curl and server-to-server calls, and not a vulnerability by itself since browsers always send Origin on cross-origin requests.

Since 2026-08-19 the SPA is **same-origin** on both entry points (nginx on `:80`, the Vite dev-server proxy on `:5173`), so CORS no longer governs the application at all — it only affects tools calling port 5000 directly. `http://localhost` was added to the allowlist for those ([G-02](./08-gap-analysis.md#g-02)).

**The allowlist above is the development one.** Under `NODE_ENV=production` it is exactly `CORS_ORIGINS` and nothing else — the development origins are not appended, because "restrict CORS to your real origin" is impossible to actually do if `localhost:5173` is always permitted. `CORS_ORIGINS` is a required variable in `docker-compose.prod.yml`; the stack refuses to start without it.

**Rate limiting.** 500 requests / 15 minutes on `/api`. Two flaws:

1. ~~`trust proxy` is never called~~ **Fixed 2026-08-19.** `trust proxy` is set to `loopback, linklocal, uniquelocal`, so behind Nginx the real client IP keys the limiter, while a client reaching port 5000 directly cannot forge `X-Forwarded-For` to pick its own bucket ([G-06](./08-gap-analysis.md#g-06)).
2. ~~No stricter limit on `/api/auth/login`~~ **Fixed 2026-08-19.** 10 failed attempts per 15 minutes per IP, with successful sign-ins not counted.

**TLS.** Terminated at nginx in production. `nginx/nginx.prod.conf` listens on `:443` with TLS 1.2 and 1.3 only, a modern ECDHE cipher list, session tickets off, and a `:80` server block that does nothing but `301` to HTTPS. Certificates are mounted read-only from `certs/`.

`scripts/gen-cert.sh` generates a self-signed certificate so the stack can be brought up over HTTPS on any machine with no domain — which is what makes the Phase 8 exit criterion testable rather than aspirational. **A browser will warn on it, correctly.** Replacing those two files with a real certificate is the operator's job and the software cannot do it for them.

The **development stack is plain HTTP** on `:80`, so credentials and tokens cross the network in cleartext there. On a laptop or a trusted LAN that is the intended trade; anywhere else, run the production stack.

**Exposed data ports.** `docker-compose.yml` publishes Postgres (5432) to the host. If the host has a public interface it is directly reachable, with only the committed development password in front of it. `docker-compose.prod.yml` publishes 80 and 443 and nothing else. Redis used to be published here too, unauthenticated; it was removed outright in Phase 8 rather than secured ([G-03](./08-gap-analysis.md#g-03)).

---

## 7. Secrets management

| Secret                | Where it lives                                                                 | Assessment                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `JWT_SECRET`        | Host env / root`.env` (development), `.env.prod` (production), interpolated by compose | ✅ Correct pattern, no default fallback. Since 2026-08-20 `src/index.js` checks it at **boot** and exits with a named error — previously an unset value let the API start and then answer `401 Invalid token.` to every request ([D-15](./08-gap-analysis.md#d-15)). The production compose file also refuses to interpolate an unset value |
| Postgres credentials  | **Development:** literals in `docker-compose.yml` (`medadmin` / `medpass123`). **Production:** `POSTGRES_USER`/`PASSWORD`/`DB` from `.env.prod` | ✅ for production — no literals, and the compose file fails fast with a named error if any is unset. `DATABASE_URL` is composed from the same three variables, so the connection string and the database cannot drift. The development literals are committed on purpose |
| Seeded admin password | **Hard-coded** in `src/utils/seed.js` (`admin123`)                   | ⚠️ Committed to git, and unavoidably so for a first-run bootstrap — but since 2026-08-20 the account is created with `mustChangePassword`, and the API answers `403 PASSWORD_CHANGE_REQUIRED` to everything except reading its own profile and changing its password. The credential is public; the account it opens is not usable |
| `.env` files        | Gitignored (`backend/.env`, `frontend/.env`, root `.env`, `.env.prod`) | ✅ `.env.prod` and `certs/` are both gitignored                                                                          |

**Rotation.** Rotating `JWT_SECRET` invalidates every session at once — blunt, but it is the only revocation lever the system has today (§10 P1-7). Rotating the **database** password is the one that surprises people: Postgres applies `POSTGRES_USER`/`POSTGRES_PASSWORD` only when it initialises an *empty* data directory, so editing `.env.prod` on a running system changes nothing and the API then fails to authenticate with `P1000`. Rotate with `ALTER ROLE … WITH PASSWORD` inside Postgres, or take a dump, recreate the volume and restore. Documenting this properly is §10 P2-16.

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
| T-1  | Credential stuffing / brute force on login | Public login endpoint                                                                  | Med        | High              | bcrypt cost 12, per-IP limiter: 10 failed logins / 15 min, and a constant-work login path | **Low** — the body and the timing now say the same thing whether or not the account exists (P2-12 closed) |
| T-2  | Default admin credentials unchanged        | Public repo                                                                            | High       | Critical          | **Enforced, not requested** — the account is created with `mustChangePassword` and every route but two answers `403 PASSWORD_CHANGE_REQUIRED` | **Low** — the credential is still public, but it opens an account that cannot sell, stock or administer anything |
| T-3  | Token theft via XSS                        | `localStorage` + dependency-borne XSS                                                | Low        | High              | React escaping, no`dangerouslySetInnerHTML`, and a production CSP with `script-src 'self'` | Low in production, **Med in development** — no CSP there, and the token is still a 7-day credential once stolen (T-13) |
| T-4  | Token theft on the wire                    | Plain HTTP                                                                             | Med (LAN)  | High              | TLS 1.2/1.3 with HSTS in production; **nothing in development**                        | Low in production. Unchanged in development, which is why the development stack belongs on a laptop or a trusted LAN |
| T-5  | Privilege escalation                       | Guessing admin routes                                                                  | Low        | High              | `authorize()` on every route                                                              | Low                                                                  |
| T-6  | Stock/price tampering                      | `PUT /batches/:id`                                                                   | Low        | High              | ADMIN/PHARMACIST only; strict schema, stock not editable                                    | Low — price edits are still untracked, pending an audit log (P1-11) |
| T-7  | Direct database access                     | Exposed :5432 with a committed password                                                | Med        | Critical          | Production publishes**only 80 and 443**; Postgres is reachable on the compose network alone, with a generated password | Low in production. **Critical if the development stack is exposed** — that is the deployment SECURITY.md puts out of scope, and this is why |
| ~~T-8~~ | ~~Unauthenticated Redis access~~        | ~~Exposed :6379, no auth~~                                                             | —         | —                | **Eliminated** — the service was removed, not secured ([G-03](./08-gap-analysis.md#g-03))                                                                       | None. Reintroducing a cache reopens this threat                      |
| T-9  | Insider data exfiltration                  | Any role can page through all customers                                                | Med        | Med               | None — no logging or export controls                                                       | **Med**                                                        |
| T-10 | Denial of service                          | ~~`?limit=999999`~~, shared rate bucket                                             | Med        | Med               | Per-client limiter;`limit` capped at 100 and every query parameter validated (2026-08-20) | Low — bounded page sizes; volumetric DoS remains out of scope       |
| T-11 | Financial data corruption                  | Concurrency races ([G-01](./08-gap-analysis.md#g-01), [G-09](./08-gap-analysis.md#g-09)) | Med        | High              | Serials from an atomic per-day counter and stock from a guarded decrement, both**inside** the invoice transaction; a `CHECK (quantity >= 0)` backstop; exact `Decimal` money | **Low** — Phase 7 delivered, and proven by concurrent tests rather than by inspection |
| ~~T-12~~ | Repudiation of a sale or a price change | ~~No audit trail beyond`Invoice.userId`~~                                          | Low        | Med               | Invoice authorship, a void that leaves the original intact, and an`AuditLog` row for every write to master data carrying actor, before and after | **Low** — writes are attributed. Reads are not, which is T-9's problem rather than this one |
| T-13 | Session survives its own compromise        | A stolen token stays usable for its remaining lifetime                                 | Low        | High              | Explicit logout, a password change and deactivation each revoke**every** token for that account (2026-08-22) | Low — the victim now has three ways to end the session. Residual is the window before they notice, which shortening the token lifetime addresses (P1-8) |

---

## 10. Hardening backlog

**P0 — before any non-local deployment. All five delivered; kept as the record of what "production-ready" meant here.**

1. ~~Force a password change for the seeded admin on first login~~ **Done 2026-08-20** — enforced server-side by `password-change.middleware.js`, which answers `403 PASSWORD_CHANGE_REQUIRED` to every route but the two a blocked user needs. T-2 residual drops from Critical to Low.
2. ~~Terminate TLS at Nginx; redirect 80 → 443; enable HSTS~~ **Done 2026-08-20** — `nginx/nginx.prod.conf`, with a CSP, `X-Frame-Options`, `Referrer-Policy` and `Permissions-Policy` alongside.
3. ~~Stop publishing 5432 and 6379 to the host; move Postgres credentials out of `docker-compose.yml`~~ **Done 2026-08-20** in `docker-compose.prod.yml`. Redis was removed rather than secured.
4. ~~`trust proxy` and a strict per-IP limiter on `/api/auth/login`~~ — **done 2026-08-19.**
5. ~~Zod schemas on `PUT /api/inventory/batches/:id`, `POST /api/auth/register`, `POST /api/users`, `PUT /api/users/:id`~~ — **done 2026-08-19.**

**P1 — next**

6. **Password policy** — ~~minimum length~~ (12 since 2026-08-22) and a blocklist, both done. **The breach check was declined**, and the reasoning belongs on the record rather than looking like an oversight. HaveIBeenPwned's k-anonymity range API never transmits the password and is the standard answer, but it would be this stack's **first outbound dependency**: egress from the backend container, a third party in the path of every password change, and either a live network call in CI or a mock that proves nothing. It also has to fail open — a pharmacy must not be unable to change a password because someone else's API is down — and a check that silently passes whenever it cannot run is weaker than its presence suggests. The local blocklist covers what actually threatens this system: an operator choosing `admin123`, `pharmacy2026`, or the credential printed in the README. Revisit if self-service signup ever lands, where the population of chosen passwords stops being a handful of known staff. **A forced reset flow remains open.**
7. ~~Invalidate tokens on password change and on deactivation.~~ **Done 2026-08-22.** A `tokenVersion` counter on `User`, compared against a claim in the token, needing no cache store (there is none since Redis was removed, [G-03](./08-gap-analysis.md#g-03)) and riding on the user reload `protect` already performs. Bumped by `POST /api/auth/logout`, by a password change, and by deactivation. The last of those closed a gap nobody had written down: `protect`'s `isActive` check only holds *while* the flag is set, so reactivating an account handed back every token that was live when it was suspended — and deactivate-then-reactivate is precisely what an administrator does to a compromised account.
8. ~~Shorten the access token to 15–60 minutes and implement the refresh rotation the util already anticipates.~~ **Done 2026-08-22** — 30 minutes, with rotation and reuse detection. The decision that mattered was *where the refresh token lives*: in `localStorage` beside the access token it would have made things worse, because an XSS would gain a renewable credential in place of an expiring one. It is an `HttpOnly` cookie instead.
9. ~~Add a CSP header to the SPA.~~ **Done 2026-08-20** — `nginx/nginx.prod.conf` serves `script-src 'self'` with no inline escape, alongside HSTS, `X-Frame-Options: DENY`, `Referrer-Policy` and `Permissions-Policy`. `style-src` still needs `'unsafe-inline'` for Tailwind's injected styles. **The development stack has no CSP**, which is why T-3's residual is split by environment.
10. ~~Clamp `limit` on every paginated endpoint and validate query parameters.~~ **Done 2026-08-20** — `validateQuery` on all 10 query surfaces, `MAX_LIMIT` 100, 44 tests.
11. ~~Add an audit log.~~ **Done 2026-08-22** — a Prisma middleware capturing actor, model, record and before/after on every write to master data, so a new write path records itself rather than relying on somebody remembering. Covers `Medicine`, `Batch`, `Supplier`, `Category`, `Manufacturer`, `Customer` and `User`; excludes the invoice path, which is already attributed and would double the write volume of the hottest code in the product. `password` and `tokenVersion` are stripped. Retention decided at 24 months, though no purge job exists yet. **Reads are deliberately not logged** — see [03 §3.11](./03-data-model.md#311-auditlog--who-changed-what) for why that is the wrong answer to T-9.

**P2 — hardening and hygiene**

12. ~~Equalise login timing with a dummy bcrypt comparison on the user-miss path.~~ **Done 2026-08-22** — and on the deactivated-account path, which had the same short-circuit. Guarded by a test asserting the comparison happens rather than a wall-clock threshold, which would be flaky on a loaded CI box.
13. ~~Redis `requirepass` before caching goes live.~~ **Not applicable** — there is no Redis ([G-03](./08-gap-analysis.md#g-03)). Reinstate this item if a cache store is ever reintroduced.
14. Dependency scanning (`npm audit` / Dependabot) in CI.
15. Restrict customer-history reads by role if staff counts grow.
16. Document key rotation for `JWT_SECRET` and database credentials.
