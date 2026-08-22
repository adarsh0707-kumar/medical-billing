# Medical Billing System — Documentation

This folder is the single source of truth for **what the system does, how it is built, and where it is going**.

Everything here was written by reading the actual source tree (`backend/src`, `frontend/src`, `prisma/schema.prisma`, `docker-compose.yml`, `nginx/nginx.conf`) as of **17 August 2026**, application version **1.0.0**.

> **Reading rule used throughout these docs:** every capability is tagged with a status.
> `✅ Implemented` — present in code and reachable from the UI or API.
> `🟡 Partial` — present but incomplete, unreachable, or unused.
> `⬜ Planned` — not in the codebase; described as intent only.
>
> The component READMEs at the repo root (`README.md`, `backend/README.md`, `frontend/README.md`, `nginx/README.md`) once contained a number of aspirational claims the code did not implement — endpoints that were never built, a cookie-based session, an `express-validator` dependency. All four were trimmed on 2026-08-20 to a short "what this is / how to run it" plus links into this set, and the discrepancies are catalogued as `D-nn` in [08 — Gap Analysis](./08-gap-analysis.md). **Where any document disagrees with this set, check the code — that is how both were written.**

---

## Document index

| # | Document | What it answers |
|---|----------|-----------------|
| 01 | [Product Requirements (PRD)](./01-product-requirements.md) | Who it's for, what problem it solves, every functional & non-functional requirement with status |
| 02 | [Architecture](./02-architecture.md) | System context, containers, request flows, deployment topology, design decisions |
| 03 | [Data Model](./03-data-model.md) | ERD, every table & column, enums, invariants, migration history |
| 04 | [API Reference](./04-api-reference.md) | Every implemented endpoint: auth, roles, params, payloads, responses, errors |
| 05 | [Roadmap & Phases](./05-roadmap-and-phases.md) | What shipped in phases 0–6, what phases 7–11 contain, exit criteria |
| 06 | [Development Guide](./06-development-guide.md) | Setup, env vars, daily commands, recipes for adding endpoints/pages, troubleshooting |
| 07 | [Security](./07-security.md) | AuthN/AuthZ design, RBAC matrix, threat model, hardening backlog |
| 08 | [Gap Analysis](./08-gap-analysis.md) | Docs-vs-code drift and code-level defects found during this review, prioritised |
| 09 | [Testing Strategy](./09-testing-strategy.md) | Test pyramid, critical cases per module, GST math fixtures, CI outline, QA checklist |
| 10 | [Glossary](./10-glossary.md) | Domain terms — Schedule H, HSN, CGST/SGST, FEFO, batch, and system terms |

---

## The 60-second summary

A single-store **retail pharmacy billing and inventory system** for the Indian market. A cashier searches a medicine, the system pulls the nearest-expiry batch with stock, builds a cart, computes per-line GST split into CGST/SGST, writes an invoice, and decrements batch stock in one database transaction. Pharmacists and admins manage the medicine catalogue, stock batches, suppliers and users. Reports cover daily sales, monthly GST, expiry/low-stock alerts, and a 7-day sales trend.

```
React 19 + Vite SPA  →  Express 5 REST API  →  PostgreSQL 15 (via Prisma 5)
       (5173)                  (5000)                    (5432)
       All fronted by Nginx on :80 in Docker Compose
```

**Roles:** `ADMIN` › `PHARMACIST` › `CASHIER`.
**Auth:** JWT bearer token, 7-day expiry, stored in browser `localStorage`.
**Money model:** per-line discount %, bill-level flat discount, GST split 50/50 into CGST + SGST.

## Where to start

- **New developer?** [06 — Development Guide](./06-development-guide.md), then [02 — Architecture](./02-architecture.md).
- **Integrating with the API?** [04 — API Reference](./04-api-reference.md).
- **Planning the next sprint?** [05 — Roadmap & Phases](./05-roadmap-and-phases.md) and [08 — Gap Analysis](./08-gap-analysis.md).
- **Security or compliance review?** [07 — Security](./07-security.md), then the risk table in [08](./08-gap-analysis.md).

## Keeping these docs true

These documents drifted once already (see [08](./08-gap-analysis.md)). To stop it happening again:

1. A change to `backend/src/routes/*` **must** update [04 — API Reference](./04-api-reference.md).
2. A change to `prisma/schema.prisma` **must** update [03 — Data Model](./03-data-model.md) and ship with a migration.
3. A new user-visible capability **must** get an `FR-` ID in [01 — PRD](./01-product-requirements.md) with a status tag.
4. Never document intent as fact. If it isn't in the code, tag it `⬜ Planned`.
