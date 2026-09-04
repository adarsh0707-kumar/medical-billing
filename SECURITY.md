# Security Policy

The Medical Billing System handles customer records, purchase history, stock levels and tax records for a retail pharmacy. Purchase history in a pharmacy context reveals health conditions, so a vulnerability here has consequences beyond the software.

We take reports seriously and we'd rather hear about a problem early than read about it later.

---

## Supported versions

| Version | Supported | Notes |
|---|---|---|
| `main` | ✅ | Where fixes land first |
| 3.0.0 | ✅ | Current release (2026-09-04). Multi-tenant: a signup creates its own shop. **Recommended for deployment** |
| 2.0.0 | ⚠️ Limited | 2026-08-24. Single-tenant, and predates the tenancy boundary every later fix assumes. Critical issues only |
| 1.0.1, 1.0.0 | ❌ | 2026-04-28. Predates every fix listed below — atomic stock, exact money, request validation. Do not deploy |

> This table said **"1.0.0 — the only tagged release"** until 2026-09-04, by which point `v1.0.1` and `v2.0.0` had been tagged and 3.0.0 was being cut. It is the table a reporter reads to decide whether their finding affects something supported, so a stale one costs somebody the work of testing against a version nobody runs.

Fixes since 1.0.0 that matter for security or data integrity:

- Stock deduction made atomic — concurrent sales could previously drive stock negative
- Invoice serials allocated from a per-day counter — concurrent checkouts could previously fail a paid-for sale
- Money moved to exact decimals — float drift previously left tax totals unreconcilable
- Every mutating route now validates its request body
- Rate limiting made per-client, with a dedicated failed-login budget
- Server-side revocation and refresh-token rotation with reuse detection
- Tenant isolation: a caller's shop comes from their token, and a foreign id answers 404
- The SPA and API moved to a single origin

---

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a security problem.**

Report it privately through **GitHub Security Advisories**:

> Repository → **Security** tab → **Report a vulnerability**

That opens a private thread visible only to you and the maintainers.

If private reporting is unavailable to you, open a normal issue titled **"Security contact request"** containing **no details of the problem**, and a maintainer will arrange a private channel.

### What to include

The more of this you can provide, the faster it gets fixed:

- What the vulnerability lets an attacker do, in one sentence
- The affected component and, if you have it, the file or endpoint
- Steps to reproduce, ideally against a fresh `docker compose up` with seeded data
- The version, commit or branch you tested
- Any proof-of-concept — a request, a payload, a short script
- Whether you believe it is already publicly known

Please test only against your own local installation.

### What to expect

| Stage | Target |
|---|---|
| Acknowledgement that we received it | 72 hours |
| Initial assessment — accepted, needs more information, or out of scope | 7 days |
| Progress updates while it's open | Every 7 days |
| Fix for a critical or high-severity issue | 30 days |
| Fix for medium or low severity | Next release cycle |

This project is maintained by a small team, so those are honest targets rather than a contractual SLA. If a deadline slips you'll be told why.

If a report is **declined**, you'll get the reasoning — usually that it falls under [known issues](#known-and-accepted-issues) or [out of scope](#scope). You're welcome to push back.

### Disclosure

We follow coordinated disclosure. Once a fix is available, or 90 days after the report if it isn't, the issue can be disclosed publicly. Reporters are credited in the advisory and the changelog unless they'd rather not be.

There is no bug bounty — this is an unfunded project. Credit and genuine gratitude are what's on offer.

### Safe harbour

We will not pursue or support legal action against anyone who reports a vulnerability in good faith: testing only against their own installation, avoiding privacy violations and data destruction, not degrading a service others rely on, and giving us reasonable time to fix the issue before disclosure.

---

## Scope

### In scope

- Authentication and session handling
- Authorisation and the role model (`ADMIN` / `PHARMACIST` / `CASHIER`)
- Injection of any kind, including through Prisma
- Business-logic flaws that corrupt money or stock — miscomputed tax, stock going negative, invoice totals that don't reconcile
- Data exposure across users or roles
- Anything that lets an unauthenticated caller reach authenticated functionality
- Vulnerable dependencies **with a demonstrated exploit path in this application**

### Out of scope

- Findings against a deployment that skipped the [hardening checklist](#for-operators) — for example, an internet-exposed instance still using the seeded password
- The [known issues](#known-and-accepted-issues) below; they are already documented
- Missing hardening headers with no demonstrated impact
- Denial of service by volume, rate-limit tuning opinions, or resource exhaustion requiring authenticated access
- Social engineering, physical access, or attacks on a maintainer's accounts
- Automated scanner output with no analysis of whether it is reachable here
- Vulnerabilities in Docker, PostgreSQL or nginx themselves — report those upstream

---

## Known and accepted issues

These are **already documented** in [`docs/07-security.md`](./docs/07-security.md) and [`docs/08-gap-analysis.md`](./docs/08-gap-analysis.md). Reporting them again is welcome but won't be treated as a new finding. They are listed here so operators can't be surprised by them.

| Issue | Status |
|---|---|
| Seeded admin credentials (`admin@medstore.com` / `admin123`) are in the repository | By design for first-run setup. **Fixed 2026-08-20**: the account is created needing a password change, and the API refuses everything else until it happens. **Avoidable entirely since 2026-08-28**: `POST /api/auth/signup` lets an operator create their own administrator with a password of their own choosing, so there is no published credential to change. `npm run seed` remains for development |
| Signup is open to the public — anyone can create an account | **By design since 2026-08-29**, and a deliberate reversal. See [Open signup](#open-signup-and-what-changed-the-argument) below |
| The PostgreSQL password is hard-coded in `docker-compose.yml` | Development default, and still true of the *development* file. `docker-compose.prod.yml` has no credential literals |
| No TLS anywhere — nginx listens on `:80` only | **Fixed 2026-08-20** for the production stack: TLS, HSTS and an 80 → 443 redirect. The development stack is still plain HTTP, deliberately |
| JWTs are stored in `localStorage` and are valid for 7 days | **Reduced 2026-08-22.** The access token is still in `localStorage` but now lasts **30 minutes**. The 7-day half is a `refresh_token` cookie marked `HttpOnly`, so script cannot read it. XSS gets a short-lived token rather than a renewable session |
| ~~No server-side logout or token revocation~~ | **API fixed 2026-08-22; reachable from the app 2026-08-25.** `POST /api/auth/logout` ends every session for that account, including copies of the token held by someone else. Between those two dates the endpoint existed but nothing called it — the **Sign out** button cleared `localStorage` only, so the `HttpOnly` refresh cookie survived and stayed renewable. A deployment from that window should be treated as though sign-out did not revoke. Rotating `JWT_SECRET` remains the blunt lever for signing out *everyone* at once |
| ~~Changing a password doesn't invalidate existing sessions~~ | **Fixed 2026-08-22.** A password change signs out every other session; the device you changed it on is issued a replacement session — **both halves**, access token and refresh cookie. Until 2026-08-27 only the access token was reissued, so that device was signed out at its next silent refresh, within 30 minutes. Deactivating an account revokes too, so reactivating it no longer restores tokens that were live when it was suspended |
| ~~Password policy is length-only (minimum 8)~~ | **Strengthened 2026-08-22.** Minimum 12, with a blocklist that sees through the usual digit-and-year padding, and refusal of anything containing the account's own name, email, or a credential published in this repo. No character-class rules — by design, per NIST SP 800-63B. **No breach-corpus lookup**, a deliberate trade rather than an omission: it would be this stack's first outbound dependency, and a check that fails open is weaker than it reads |
| ~~Login timing reveals whether an email exists~~ | **Fixed 2026-08-22.** Every login spends one bcrypt comparison, against a decoy hash when the account does not exist, so an unknown email costs the same as a wrong password. The deactivated-account path was fixed with it |
| ~~No audit log for stock or price changes~~ | **Fixed 2026-08-22.** Every write to medicines, batches, suppliers, categories, manufacturers, customers and users records who did it and the before/after state. Reads are not logged — deliberately; see `docs/03` §3.12 |
| ~~Query parameters are unvalidated — e.g. `?limit=999999` is honoured~~ | **Fixed 2026-08-20.** Every query string is validated; `limit` is capped at 100 |
| ~~Any authenticated role can read every customer's purchase history~~ | **Restricted 2026-08-24.** A cashier can find a customer and bill them, but purchase history is ADMIN/PHARMACIST only. Pharmacists and admins can still read every customer, and reads are not logged |
| PostgreSQL and Redis publish host ports, and Redis has no password | **Fixed 2026-08-20**: the production stack publishes only 80 and 443, and Redis was removed as an unused dependency |
| Password reset depends on a mail server, and a failed send is invisible to the user | **Accepted, and the trade is deliberate.** `POST /api/auth/forgot-password` answers identically for a known and an unknown address — that is what stops it being a way to ask who uses this pharmacy — which means it cannot report a send failure either, because a `503` for one and a `200` for the other is the same oracle by another route. So a reset that could not be sent looks exactly like one that was, and **the log is where an operator finds out** (`error` level, with the request id). The case that would otherwise persist is closed at the other end: while `SMTP_HOST/PORT/USER/PASS/FROM` or `APP_URL` is unset the endpoint answers **503** and issues no token, so an unconfigured deployment refuses the request rather than swallowing it. That answer depends on the configuration and not on the address, so it is the same for everybody and is not an oracle. (This was a *boot* guard until 2026-09-01; it exited the process in production, which took a whole API down over a feature none of billing, inventory or reporting uses.) Nobody requests a password reset on a good day |
| The refresh cookie is `SameSite=None` in production | **Accepted, and guarded since 2026-08-31.** The hosted SPA and API are genuinely on different sites — `VITE_API_URL` is set in the Vercel project, so the built client calls the API host directly rather than through the `vercel.json` rewrite. A `Strict` cookie is never sent cross-site, so it would be set at login and never sent again, and every session would end at the 30-minute access token's expiry. `None` is therefore required rather than chosen. It is what makes `POST /api/auth/refresh` — the only cookie-authenticated endpoint — drivable from another site, so that route now carries an explicit `Origin` check (`backend/src/middlewares/csrf.middleware.js`) mounted ahead of CORS. **This was not an open hole in the interim**: the CORS origin callback rejects an unlisted origin with an error, so such a request already died before reaching the route. What changed is that the protection is now named, tested, first in the chain, and answers `403` instead of `500` |

If you can demonstrate impact **beyond** what's described here — a way to exploit one of these that the documentation doesn't anticipate — that is a genuine finding. Please report it.

---

## Open signup, and what changed the argument

`POST /api/auth/signup` is public and stays public. Anyone who can reach the API can create an account. Until **2026-08-29** the opposite was true, and this document argued for it at length, so the reversal is worth setting out rather than quietly editing away.

**The old argument, which was correct at the time.** Signup was a one-shot bootstrap that sealed itself after the first account. The reasoning: every authenticated role can read customer records, and purchase history in a pharmacy reveals health conditions — [threat T-9](./docs/07-security.md). On a single-tenant installation a second account meant a second person inside *the same* pharmacy's customer list. A signup that worked twice would have been a data breach with a form in front of it.

**What changed is not the risk appetite — it is what a second signup produces.** Since the multi-tenant conversion, each signup creates its own `Shop`, and a shop's rows are visible only to its own accounts ([FR-SHOP](./docs/01-product-requirements.md#60-tenancy--fr-shop)). A stranger signing up does not join your pharmacy; they get an empty one of their own. The old argument has not been rebutted — it has been made inapplicable, because the thing it protected against is no longer what the endpoint does.

**What the boundary now rests on.** Previously, isolation was a consequence of there being only one shop: nothing could leak across a line that did not exist. Now the line exists and is enforced per query — a `shopId` carried in the token, and a `where` clause on every read and write that filters by it. That is a real change in the shape of the risk, not just in its size:

- **A missing `shopId` in one query is a cross-tenant leak.** It would not throw, and the response would look entirely normal to whoever read it. This is why scoped writes use `updateMany`/`deleteMany` — the tenant condition sits in the same `where` as the id, so the boundary is the statement rather than a check someone remembered to write beside it ([03 §3.0](./docs/03-data-model.md#30-shop--the-tenant)).
- **It is guarded, not assumed.** `backend/tests/auth/signup.test.js` creates two shops and asserts across the resource controllers, the user list and the dashboard that neither sees the other, and that a foreign id answers 404 rather than 403 — a 403 would confirm the row exists and turn a guessed id into a probe.
- **A cross-tenant read is the highest-severity finding this project can receive.** If you can get one shop's data out of another shop's session, please report it under the process above; it takes precedence over everything in the known-issues table.

**What open signup does still cost**, and these are accepted rather than solved:

- **Unbounded account and shop creation.** Nothing limits how many shops one person opens over time. A dedicated limiter covers the endpoint at 10 per 15 minutes per client, which bounds the rate but not the total; a determined caller can still fill the table. There is no email verification, so the addresses are not proven either.

  **This sentence was false between 2026-08-29 and 2026-09-04, and it is worth saying why rather than quietly correcting the number.** The endpoint was mounted on the *failed-login* limiter, which is built with `skipSuccessfulRequests` — right for login, where only failures are worth counting, and exactly wrong here, because on signup the **successful** call is the one that creates a shop and spends a cost-12 hash. Every call this control existed to bound was the one it skipped, so the real ceiling was the general 500-per-window limiter. It now has its own limiter that counts successes, and `tests/auth/rate-limit.test.js` asserts the budget is spent by successful signups rather than by failures.
- **Each call spends a cost-12 bcrypt hash** before anything is written. That is deliberate — a cheaper hash for signup would be a cheaper hash for the password it stores — but it does make the endpoint the most expensive unauthenticated work in the API.
- **`User.email` is unique system-wide**, so one signup can discover whether an address already has an account, in any shop, from the `409`. Accepted: the alternative is a signup that silently does nothing, and login takes an email with no shop selector, so the address has to be unique regardless ([FR-SHOP-06](./docs/01-product-requirements.md#60-tenancy--fr-shop)).

If open signup is not what your deployment wants — an internal installation for one pharmacy, say — put the API behind a network boundary or a reverse-proxy rule on `POST /api/auth/signup`, and use `npm run seed` plus `POST /api/auth/register` to create accounts. There is no configuration flag for this today.

---

## For operators

This software is self-hosted, so most of its real-world security posture is a deployment decision. The shipped configuration is a **development** configuration.

Before running this anywhere real:

Use `docker-compose.prod.yml`. It exists precisely so most of this list is no longer something you have to remember:

```bash
./scripts/gen-cert.sh                     # or drop a real certificate into certs/
cp .env.prod.example .env.prod            # then fill in every value
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.prod exec backend npx prisma migrate deploy
docker compose -f docker-compose.prod.yml --env-file .env.prod exec backend npm run seed
```

- [x] **Change the seeded admin password** — now enforced, not requested. The seeded admin is created with `mustChangePassword`, and the API answers `403 PASSWORD_CHANGE_REQUIRED` to every route except reading its own profile and changing its password. It cannot sell, stock or administer anything until the password is replaced
- [x] **Replace the PostgreSQL credentials** — `docker-compose.prod.yml` has no credential literals; all three come from `.env.prod` and the compose file refuses to start if any is unset. `DATABASE_URL` is built from the same variables, so the two can no longer drift. **Rotating the password later is not an edit to `.env.prod`** — Postgres reads those variables only when initialising an empty data directory, so the file changes and the database does not, and the API fails `P1000`. [06 § Rotating a secret](./docs/06-development-guide.md#rotating-a-secret) gives both paths and says which to reach for
- [x] **Set a strong random `JWT_SECRET`** — enforced twice. `docker-compose.prod.yml` refuses to start the container without it, and the API itself checks the variable at boot and exits with an error naming it and the command to generate one. Before that guard an unset value let the process start and answer `401 Invalid token.` to every request, which sends whoever is debugging to authentication instead of to the variable nobody set ([D-15](./docs/08-gap-analysis.md#d-15)). **Rotating it later is a procedure, not an improvisation:** it signs every user out at the moment the new process serves its first request, which is the point of it — [06 § Rotating a secret](./docs/06-development-guide.md#rotating-a-secret) has the ordered steps
- [x] **Terminate TLS and redirect `:80` → `:443`** — `nginx/nginx.prod.conf`. HSTS at one year with `includeSubDomains`; `preload` is deliberately omitted, being close to irreversible and your decision rather than a default
- [x] **Stop publishing PostgreSQL and Redis to the host** — the prod stack publishes only 80 and 443. Postgres is reachable only on the internal network. Redis was removed entirely: it was running and unused ([G-03](./docs/08-gap-analysis.md#g-03))
- [x] ~~Set a Redis password~~ — no longer applicable; there is no Redis
- [x] **Set `NODE_ENV=production`** — set in the prod compose file and baked into the backend image, so error stacks stay out of responses
- [x] **Set `TRUST_PROXY`** — defaults to the compose network's private ranges; override in `.env.prod` if another proxy sits in front
- [x] **Restrict the CORS allowlist** — in production the allowlist is exactly `CORS_ORIGINS` and the development origins are *not* appended. It is a required variable
- [x] **Configure database backups and rehearse a restore** — `scripts/backup.sh` and `scripts/restore.sh`. The restore has been rehearsed against the production stack: schema dropped entirely, restored from a dump, every row count matched and the application authenticated again. See [`docs/06`](./docs/06-development-guide.md)
- [x] **Decide a retention period for customer records** — decided 2026-08-24. Customer details are erased after **36 months of no purchases**; invoices keep **8 years** as books of account. Erasure anonymises rather than deletes, because invoices reference the row and must still reconcile. `DELETE /api/billing/customers/:id` does it on request; `npm run purge:customers -- --apply` does it in bulk. **The purge does not run itself** — schedule it, e.g. a nightly cron entry ([docs/06](./docs/06-development-guide.md#running-in-production))
- [x] **Enforce the audit-log retention period** — decided at 24 months when the log shipped on 2026-08-22 and enforced since 2026-08-31 by `npm run purge:audit` (`-- --apply` to commit; dry by default, because deleting an audit trail cannot be undone). Between those dates the policy was documented but nothing applied it. **This one does not run itself either** — schedule it alongside the customer purge ([docs/06](./docs/06-development-guide.md#audit-log-retention))

- [x] **Configure SMTP** — `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` and `APP_URL` are required in `docker-compose.prod.yml` and checked again at boot, because self-service password reset (FR-AUTH-11) is the only way back into an account for a shopkeeper who signed up themselves. Send yourself a reset after deploying: a wrong `APP_URL` produces a link that arrives and goes nowhere, which no start-up check can catch

Two things the software cannot decide for you:

- **The certificate.** `scripts/gen-cert.sh` generates a self-signed one so the stack runs over HTTPS anywhere, which is what makes the above testable. A browser will warn on it, correctly. Replace the two files in `certs/` with a real certificate before anyone but you uses the system
- **Rotating credentials on an existing deployment.** Postgres only applies `POSTGRES_USER`/`POSTGRES_PASSWORD` when it initialises an *empty* data directory. Changing them in `.env.prod` on a running system does nothing to the database and the API will simply fail to authenticate. Rotate with `ALTER ROLE ... WITH PASSWORD` inside Postgres, or take a dump, recreate the volume and restore

The reasoning behind each item, and the current threat model, is in [`docs/07-security.md`](./docs/07-security.md).

### Handling patient-adjacent data

Customer name, phone, address, age, gender and full purchase history are stored in plain columns with no encryption at rest beyond whatever the host volume provides. Retention and erasure now exist (36 months of inactivity, anonymising in place); **reads are still not logged**, which is a deliberate call argued in `docs/03` §3.12. Since 2026-08-24 a Schedule H sale **requires** a register entry — prescriber, council registration number, prescription date and patient name — recorded against the invoice in the same transaction (Rule 65(11) particulars). No prescription image is stored; the register is the record. Whether that satisfies your obligations is still yours to assess against local rules. Assess this against your local obligations before going live.

---

## Security-relevant design

Briefly, so you know what to expect when reviewing:

| Control | Implementation |
|---|---|
| Password storage | bcrypt, cost factor 12; hashes are never returned by any endpoint |
| Sessions | JWT (HS256) access token, **30-minute** expiry, carrying `{ id, tokenVersion }`. The week is carried by a rotating `HttpOnly` `refresh_token` cookie |
| Revocation | Four levers, all effective on the next request because every protected request reloads the user: `POST /api/auth/logout`, a password change, a self-service password reset (FR-AUTH-11), and deactivating an account. Each bumps `User.tokenVersion`, which every token carries a copy of, so all of that account's sessions end. A password change hands the caller a replacement token so only the other sessions drop |
| CSRF | Only `POST /api/auth/refresh` has a surface — every other protected route authenticates with a `Bearer` token that another origin's script cannot read. It is guarded by an `Origin` allowlist check ahead of CORS, which refuses a foreign origin with `403` and leaves the session untouched. A double-submit token was rejected: the SPA is on a different site from the API, so it cannot read a cookie scoped to the API's host, and returning the token in the login body would put a session-renewing credential in `localStorage` |
| Authorisation | Server-side `authorize(...roles)` on every mutating route; client-side checks are cosmetic only |
| Tenant isolation | Every shop-specific row carries a `shopId`; the caller's comes from a JWT claim, never from the request. Reads and writes scope by `{ id, shopId }` in the same `where`, so a foreign id is a 404 rather than a 403 |
| Input validation | Zod on every mutating route; unknown keys stripped, and rejected outright on the most sensitive routes |
| SQL injection | Prisma parameterises everything. **Eight** raw statements exist, and every one is a bound `$queryRaw` tagged template: the readiness probe (`app.js`), the two document-serial upserts (`invoice.utils.js`), and five aggregations in `utils/trend.js` — the 7-day trend, the period-report bucketing, the margin report's revenue and cost, and the top-sellers ranking. `$queryRawUnsafe` appears nowhere ([full list](./docs/07-security.md#5-injection--data-access-safety)). *(Recounted 2026-08-31: this said six, a number taken from a grep that also matched the phrase `$queryRaw` inside a comment. Count the invocations, not the mentions.)* |
| Rate limiting | 500 requests / 15 min per client, plus 10 failed logins / 15 min |
| Transport headers | `helmet()` defaults on API responses; in production nginx adds HSTS, a CSP with `script-src 'self'`, `X-Frame-Options: DENY`, `Referrer-Policy` and `Permissions-Policy` to the SPA |
| Financial integrity | Exact decimal arithmetic; invoice creation and stock deduction commit in a single transaction |

Full detail, including the threat model and the prioritised hardening backlog: [`docs/07-security.md`](./docs/07-security.md).

---

*Last reviewed: 1 September 2026.*
