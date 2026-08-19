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
- Vulnerabilities in Docker, PostgreSQL, Redis or nginx themselves — report those upstream

---

## Known and accepted issues

These are **already documented** in [`docs/07-security.md`](./docs/07-security.md) and [`docs/08-gap-analysis.md`](./docs/08-gap-analysis.md). Reporting them again is welcome but won't be treated as a new finding. They are listed here so operators can't be surprised by them.

| Issue | Status |
|---|---|
| Seeded admin credentials (`admin@medstore.com` / `admin123`) are in the repository | By design for first-run setup. **Change immediately on any real deployment.** A forced first-login change is planned |
| The PostgreSQL password is hard-coded in `docker-compose.yml` | Development default. Must be replaced for any deployment |
| No TLS anywhere — nginx listens on `:80` only | Deployment responsibility today; TLS termination is planned |
| JWTs are stored in `localStorage` and are valid for 7 days | Known trade-off. XSS would expose a long-lived credential |
| No server-side logout or token revocation | A leaked token stays valid until it expires. Rotating `JWT_SECRET` invalidates every session as an emergency measure |
| Changing a password doesn't invalidate existing sessions | Planned |
| Password policy is length-only (minimum 8) | No complexity or breach checking yet |
| Login timing reveals whether an email exists | The response body doesn't, but a missing user skips the bcrypt comparison and returns faster |
| No audit log for stock or price changes | Only invoice authorship is attributed |
| Query parameters are unvalidated — e.g. `?limit=999999` is honoured | Planned |
| Any authenticated role can read every customer's purchase history | Intentional for a single small store; revisit as staff numbers grow |
| PostgreSQL and Redis publish host ports, and Redis has no password | Development convenience. Must not be exposed in a deployment |

If you can demonstrate impact **beyond** what's described here — a way to exploit one of these that the documentation doesn't anticipate — that is a genuine finding. Please report it.

---

## For operators

This software is self-hosted, so most of its real-world security posture is a deployment decision. The shipped configuration is a **development** configuration.

Before running this anywhere real:

- [ ] Change the seeded admin password, and delete the account if it isn't used
- [ ] Replace the PostgreSQL credentials in `docker-compose.yml`; don't commit the replacements
- [ ] Set a strong random `JWT_SECRET` (`openssl rand -hex 32`). There is no default — the API fails loudly without one, which is intended
- [ ] Terminate TLS in front of the application and redirect `:80` → `:443`
- [ ] Stop publishing PostgreSQL (`5432`) and Redis (`6379`) to the host
- [ ] Set a Redis password if Redis is reachable from anywhere but the application
- [ ] Set `NODE_ENV=production` so error stacks stay out of responses
- [ ] Set `TRUST_PROXY` to match your topology — it decides which peers may set `X-Forwarded-For`, and therefore what the rate limiter keys on
- [ ] Restrict the CORS allowlist to your real origin
- [ ] Configure database backups **and rehearse a restore**
- [ ] Decide a retention period for customer records — none is enforced, and purchase history accumulates indefinitely

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
| Revocation | Deactivating a user takes effect on their next request — every protected request reloads the user and rejects `isActive: false` |
| Authorisation | Server-side `authorize(...roles)` on every mutating route; client-side checks are cosmetic only |
| Input validation | Zod on every mutating route; unknown keys stripped, and rejected outright on the most sensitive routes |
| SQL injection | Prisma parameterises everything. One raw statement exists (the invoice-serial upsert) and uses a bound tagged template |
| Rate limiting | 500 requests / 15 min per client, plus 10 failed logins / 15 min |
| Transport headers | `helmet()` defaults on API responses |
| Financial integrity | Exact decimal arithmetic; invoice creation and stock deduction commit in a single transaction |

Full detail, including the threat model and the prioritised hardening backlog: [`docs/07-security.md`](./docs/07-security.md).

---

*Last reviewed: 19 August 2026.*
