# Security Policy

The Medical Billing System handles customer records, purchase history, stock levels and tax records for a retail pharmacy. Purchase history in a pharmacy context reveals health conditions, so a vulnerability here has consequences beyond the software.

We take reports seriously and we'd rather hear about a problem early than read about it later.

---

## Supported versions

| Version | Supported | Notes |
|---|---|---|
| `main` | ✅ | Where fixes land first. **Currently the recommended branch to deploy** — several correctness and security fixes have shipped since 1.0.0 |
| 1.0.0 | ⚠️ Limited | The only tagged release (2026-04-28). Predates the fixes below. Security fixes will be backported only for critical issues |
| < 1.0.0 | ❌ | No releases exist |

Fixes on `main` since 1.0.0 that matter for security or data integrity:

- Stock deduction made atomic — concurrent sales could previously drive stock negative
- Invoice serials allocated from a per-day counter — concurrent checkouts could previously fail a paid-for sale
- Money moved to exact decimals — float drift previously left tax totals unreconcilable
- Every mutating route now validates its request body
- Rate limiting made per-client, with a dedicated failed-login budget
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
| Seeded admin credentials (`admin@medstore.com` / `admin123`) are in the repository | By design for first-run setup. **Fixed 2026-08-20**: the account is created needing a password change, and the API refuses everything else until it happens |
| The PostgreSQL password is hard-coded in `docker-compose.yml` | Development default, and still true of the *development* file. `docker-compose.prod.yml` has no credential literals |
| No TLS anywhere — nginx listens on `:80` only | **Fixed 2026-08-20** for the production stack: TLS, HSTS and an 80 → 443 redirect. The development stack is still plain HTTP, deliberately |
| JWTs are stored in `localStorage` and are valid for 7 days | **Reduced 2026-08-22.** The access token is still in `localStorage` but now lasts **30 minutes**. The 7-day half is a `refresh_token` cookie marked `HttpOnly`, so script cannot read it. XSS gets a short-lived token rather than a renewable session |
| ~~No server-side logout or token revocation~~ | **Fixed 2026-08-22**: `POST /api/auth/logout` ends every session for that account, including copies of the token held by someone else. Rotating `JWT_SECRET` remains the blunt lever for signing out *everyone* at once |
| ~~Changing a password doesn't invalidate existing sessions~~ | **Fixed 2026-08-22.** A password change signs out every other session; the device you changed it on stays signed in. Deactivating an account now does the same, so reactivating it no longer restores tokens that were live when it was suspended |
| Password policy is length-only (minimum 8) | No complexity or breach checking yet |
| Login timing reveals whether an email exists | The response body doesn't, but a missing user skips the bcrypt comparison and returns faster |
| ~~No audit log for stock or price changes~~ | **Fixed 2026-08-22.** Every write to medicines, batches, suppliers, categories, manufacturers, customers and users records who did it and the before/after state. Reads are not logged — deliberately; see `docs/03` §3.11 |
| ~~Query parameters are unvalidated — e.g. `?limit=999999` is honoured~~ | **Fixed 2026-08-20.** Every query string is validated; `limit` is capped at 100 |
| Any authenticated role can read every customer's purchase history | Intentional for a single small store; revisit as staff numbers grow |
| PostgreSQL and Redis publish host ports, and Redis has no password | **Fixed 2026-08-20**: the production stack publishes only 80 and 443, and Redis was removed as an unused dependency |

If you can demonstrate impact **beyond** what's described here — a way to exploit one of these that the documentation doesn't anticipate — that is a genuine finding. Please report it.

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
- [x] **Replace the PostgreSQL credentials** — `docker-compose.prod.yml` has no credential literals; all three come from `.env.prod` and the compose file refuses to start if any is unset. `DATABASE_URL` is built from the same variables, so the two can no longer drift
- [x] **Set a strong random `JWT_SECRET`** — enforced twice. `docker-compose.prod.yml` refuses to start the container without it, and the API itself checks the variable at boot and exits with an error naming it and the command to generate one. Before that guard an unset value let the process start and answer `401 Invalid token.` to every request, which sends whoever is debugging to authentication instead of to the variable nobody set ([D-15](./docs/08-gap-analysis.md#d-15))
- [x] **Terminate TLS and redirect `:80` → `:443`** — `nginx/nginx.prod.conf`. HSTS at one year with `includeSubDomains`; `preload` is deliberately omitted, being close to irreversible and your decision rather than a default
- [x] **Stop publishing PostgreSQL and Redis to the host** — the prod stack publishes only 80 and 443. Postgres is reachable only on the internal network. Redis was removed entirely: it was running and unused ([G-03](./docs/08-gap-analysis.md#g-03))
- [x] ~~Set a Redis password~~ — no longer applicable; there is no Redis
- [x] **Set `NODE_ENV=production`** — set in the prod compose file and baked into the backend image, so error stacks stay out of responses
- [x] **Set `TRUST_PROXY`** — defaults to the compose network's private ranges; override in `.env.prod` if another proxy sits in front
- [x] **Restrict the CORS allowlist** — in production the allowlist is exactly `CORS_ORIGINS` and the development origins are *not* appended. It is a required variable
- [x] **Configure database backups and rehearse a restore** — `scripts/backup.sh` and `scripts/restore.sh`. The restore has been rehearsed against the production stack: schema dropped entirely, restored from a dump, every row count matched and the application authenticated again. See [`docs/06`](./docs/06-development-guide.md)
- [ ] **Decide a retention period for customer records** — still yours to make. None is enforced, and purchase history accumulates indefinitely

Two things the software cannot decide for you:

- **The certificate.** `scripts/gen-cert.sh` generates a self-signed one so the stack runs over HTTPS anywhere, which is what makes the above testable. A browser will warn on it, correctly. Replace the two files in `certs/` with a real certificate before anyone but you uses the system
- **Rotating credentials on an existing deployment.** Postgres only applies `POSTGRES_USER`/`POSTGRES_PASSWORD` when it initialises an *empty* data directory. Changing them in `.env.prod` on a running system does nothing to the database and the API will simply fail to authenticate. Rotate with `ALTER ROLE ... WITH PASSWORD` inside Postgres, or take a dump, recreate the volume and restore

The reasoning behind each item, and the current threat model, is in [`docs/07-security.md`](./docs/07-security.md).

### Handling patient-adjacent data

Customer name, phone, address, age, gender and full purchase history are stored in plain columns with no encryption at rest beyond whatever the host volume provides, no retention limit and no access logging. There is also no prescription record for Schedule H medicines — the flag is displayed but the sale is not gated — so the system does not by itself satisfy a prescription-record obligation. Assess this against your local obligations before going live.

---

## Security-relevant design

Briefly, so you know what to expect when reviewing:

| Control | Implementation |
|---|---|
| Password storage | bcrypt, cost factor 12; hashes are never returned by any endpoint |
| Sessions | JWT (HS256), 7-day expiry, carrying only a user id |
| Revocation | Three levers, all effective on the next request because every protected request reloads the user: `POST /api/auth/logout`, a password change, and deactivating an account. Each bumps `User.tokenVersion`, which every token carries a copy of, so all of that account's sessions end. A password change hands the caller a replacement token so only the other sessions drop |
| Authorisation | Server-side `authorize(...roles)` on every mutating route; client-side checks are cosmetic only |
| Input validation | Zod on every mutating route; unknown keys stripped, and rejected outright on the most sensitive routes |
| SQL injection | Prisma parameterises everything. Five raw statements exist — two document-serial upserts, two trend aggregations and the readiness probe — and every one is a bound `$queryRaw` tagged template. `$queryRawUnsafe` appears nowhere ([full list](./docs/07-security.md#5-injection--data-access-safety)) |
| Rate limiting | 500 requests / 15 min per client, plus 10 failed logins / 15 min |
| Transport headers | `helmet()` defaults on API responses; in production nginx adds HSTS, a CSP with `script-src 'self'`, `X-Frame-Options: DENY`, `Referrer-Policy` and `Permissions-Policy` to the SPA |
| Financial integrity | Exact decimal arithmetic; invoice creation and stock deduction commit in a single transaction |

Full detail, including the threat model and the prioritised hardening backlog: [`docs/07-security.md`](./docs/07-security.md).

---

*Last reviewed: 22 August 2026.*
