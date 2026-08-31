# Glossary

Domain and system vocabulary used across this documentation and in the code.

---

## Pharmacy & retail domain

**Batch** — A physical lot of one medicine received from a supplier, identified by the manufacturer's batch number and carrying its own expiry date, purchase price and selling price. **Stock lives on the batch, not on the medicine.** The same medicine can have several batches at different prices. Modelled as `Batch`.

**Batch number** — The manufacturer's printed lot identifier. Unique per medicine in this system (`@@unique([medicineId, batchNumber])`), not globally.

**FEFO — First Expiry, First Out** — Dispensing policy: sell the batch that expires soonest. The POS applies it automatically by attaching the in-stock batch with the earliest `expiryDate` to each search result. Distinct from FIFO, which orders by receipt date; for perishable stock FEFO is the correct rule.

**Generic name** — The active molecule or salt (e.g. *Paracetamol*), as opposed to the brand name (*Crocin*). Searchable, because prescriptions and customers use both.

**HSN code** — *Harmonised System of Nomenclature*. The product classification code that determines the applicable GST rate on an invoice. Stored on `Medicine`, optional, searchable.

**Manufacturer** — The pharmaceutical company producing a medicine (Cipla, Sun Pharma). A master record; distinct from **Supplier**, who is the distributor you buy from.

**Medicine** — A catalogue entry: brand name, generic name, category, manufacturer, unit, GST rate and Schedule H flag. Holds **no stock and no price** of its own — both come from its batches.

**MRP** — Maximum Retail Price, printed on the pack. Modelled since 2026-08-31 as `Batch.mrp` — per batch, because the same product is repriced between print runs. It is a **display** value: nullable, never used in arithmetic, and left blank on the printed line when unrecorded rather than defaulted from `sellingPrice`, since printing the two as equal would assert on a tax document that no discount was given. The price the sale actually uses is `Batch.sellingPrice`, which is pre-GST.

**Schedule H** — A category under India's Drugs and Cosmetics Rules covering medicines that may be sold only against a registered practitioner's prescription. `Medicine.isScheduledH` flags them, the POS shows a badge, and since 2026-08-24 an invoice containing such a line **cannot be created without a register entry** — prescriber, council registration number, prescription date and patient name, written in the same transaction as the sale ([FR-MED-12](./01-product-requirements.md#64-medicine-catalogue--fr-med)).

**Shop** — A pharmacy, and the tenant boundary. One installation holds many; every row of shop-specific data carries a `shopId`, and a shop's data is visible only to its own accounts. A caller's shop comes from a claim in their token, never from the request, so there is nothing a client can name but its own ([03 §3.0](./03-data-model.md#30-shop--the-tenant)).

**Supplier** — The distributor or stockist a batch is purchased from. Carries a GSTIN. Every batch records its supplier, which is what makes a recall traceable back to source.

**Unit** — The dispensing form: tablet, capsule, syrup, injection, cream, drops, powder, inhaler, other. Constrained by the Zod validator, not by the database.

**Walk-in** — A sale with no customer record attached. `Invoice.customerId` is nullable precisely to support this.

---

## Tax & billing

**CGST / SGST** — Central and State Goods and Services Tax. For an intra-state supply the GST liability splits equally between them. This system **always** splits 50/50, i.e. it assumes every sale is intra-state.

**IGST** — Integrated GST, applied to inter-state supply instead of CGST+SGST. **Not modelled.** See [PRD Q2](./01-product-requirements.md#14-open-questions).

**GST rate** — 0%, 5%, 12% or 18% in this system, set per medicine and **snapshotted onto the invoice line** at sale time so a later rate change never rewrites history.

**Taxable value** — The line amount after discount and before tax: `unitPrice × quantity × (1 − discount%/100)`. `Invoice.subtotal` is the sum of these across lines. This is the figure GST is charged on and the figure that appears in the GST report.

**Line discount** — A **percentage** (0–100) applied to one invoice line before tax, so it reduces both the taxable value and the tax.

**Bill discount** (`discountAmt`) — A **flat currency amount** subtracted from the invoice after tax. It reduces what the customer pays without reducing declared GST. Deliberate simplification — see [BR-02](./01-product-requirements.md#8-key-business-rules) and [Q1](./01-product-requirements.md#14-open-questions).

**Invoice** — The immutable record of a sale: header totals plus line items. Once created it cannot be edited or deleted ([G-15](./08-gap-analysis.md#g-15)).

**Invoice number** — Human-readable identifier, `INV{yy}{mm}{dd}-{nnnn}`, e.g. `INV260817-0042`. Unique, and allocated from an atomic per-day counter inside the invoice transaction, so concurrent checkouts cannot collide ([G-01](./08-gap-analysis.md#g-01), fixed 2026-08-18).

**Payment mode** — `CASH`, `UPI`, `CARD`, `CREDIT`. `CREDIT` means the customer owes; it is a mode, not a status.

**Payment status** — `PAID`, `PENDING`, `PARTIAL`. **Only `PAID` invoices enter the monthly GST report.**

**Purchase / Purchase order** — An inward stock transaction from a supplier. Tables exist (`Purchase`, `PurchaseItem`) with a numbering scheme (`PO{yy}{mm}-{nnnn}`), but **no API, controller or UI** — [FR-PUR](./01-product-requirements.md#611-purchases--fr-pur).

**POS** — Point of Sale. The Billing screen: search, cart, totals, payment, print.

---

## System & architecture

**Bearer token** — The JWT sent as `Authorization: Bearer <token>` on every authenticated request. Attached automatically by the axios request interceptor.

**CUID** — Collision-resistant unique identifier. Every primary key in the schema is a CUID string, not an auto-increment integer.

**Envelope** — The uniform response shape `{ success, data, message?, pagination? }` / `{ success: false, message, errors? }`. Every controller returns it; the client relies on it.

**FEFO batch resolution** — See FEFO. Implemented as `where: { quantity: { gt: 0 } }, orderBy: { expiryDate: "asc" }, take: 1`.

**JWT** — JSON Web Token, HS256, signed with `JWT_SECRET`. The access token expires in **30 minutes** and carries `{ id, tokenVersion }`; the refresh token adds a `jti` and lasts 7 days. Role is not in either — the server reloads the user on every request. `tokenVersion` is the revocation counter: `protect` compares the token's copy against the column, so bumping it ends every session for that account.

**Middleware chain** — The per-request order `protect → authorize → validate → controller`. Anything missing a link is a gap; see [07 §4](./07-security.md#4-input-validation).

**`protect`** — Authentication middleware. Verifies the JWT, reloads the user from the database, rejects `isActive: false`, and attaches `req.user`.

**`authorize(...roles)`** — Authorisation middleware. Strict allowlist — `ADMIN` is listed explicitly on every route pharmacists may also use.

**`validate(schema)`** — Validation middleware. Runs Zod `safeParse` and **replaces `req.body` with the parsed result**, silently dropping unknown keys. This is both the mass-assignment guard and the cause of [G-04](./08-gap-analysis.md#g-04).

**Prisma** — The ORM and migration tool. A single `PrismaClient` from `config/db.js` is shared process-wide; the process exits if it cannot connect.

**`$transaction`** — Prisma's atomic block. Used for invoice creation + stock deduction, the one place in the system where atomicity is non-negotiable.

**Soft delete** — Marking a record inactive instead of removing it. Applied to `Medicine` (`isActive: false`). Users are **hard-deleted**; their `isActive` flag is a separate disable switch, checked on every request so a deactivation takes effect immediately. Categories, manufacturers and suppliers also hard-delete.

**Snapshot** — Copying a value onto a transaction record so later master-data changes do not rewrite history. Applied to `InvoiceItem.medicineName`, `unitPrice` and `gstPercent`.

**Zustand** — The frontend state library. Two stores: `auth.store` (persisted to `localStorage` under `auth-storage`) and `notification.store` (in-memory).

**shadcn/ui** — Component pattern where Radix-based primitives are vendored into `frontend/src/components/ui/` as editable source rather than installed as a runtime dependency.

---

## Roles

| Role                 | Meaning                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| **ADMIN**      | Full access: user management, deletes, GST report, everything below                               |
| **PHARMACIST** | Manages catalogue, stock, suppliers; reads the GST report; bills                                  |
| **CASHIER**    | Bills and reads inventory and customers. No master-data writes, no user management, no GST report |

Full matrix: [04 §4](./04-api-reference.md#4-role-matrix).

---

## Status tags used in these docs

| Tag                                        | Meaning                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| ✅ Implemented                             | In the code and reachable from the UI or API                                       |
| 🟡 Partial                                 | Present but incomplete, unreachable, or unused                                     |
| ⬜ Planned                                 | Not in the codebase — intent only                                                 |
| 🔴 / 🟠 / 🟡 (in[08](./08-gap-analysis.md)) | Defect severity: data-corrupting or security-exposing / incorrect output / quality |
| `FR-xx-nn`                               | Functional requirement id ([01](./01-product-requirements.md))                      |
| `NFR-nn`                                 | Non-functional requirement id ([01](./01-product-requirements.md))                  |
| `BR-nn`                                  | Business rule ([01 §8](./01-product-requirements.md#8-key-business-rules))         |
| `AD-nn`                                  | Architecture decision ([02 §9](./02-architecture.md#9-architecture-decisions))     |
| `G-nn`                                   | Gap or defect ([08](./08-gap-analysis.md))                                          |
| `I-n`                                    | Data invariant ([03 §5](./03-data-model.md#5-invariants))                          |
| `T-nn`                                   | Threat ([07 §9](./07-security.md#9-threat-model))                                  |
| `Q-n`                                    | Open question ([01 §14](./01-product-requirements.md#14-open-questions))           |
