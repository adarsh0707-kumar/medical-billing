const { currentActor } = require("./audit-context");

/**
 * Records who changed what (NFR-17, threat T-12).
 *
 * Installed as a Prisma middleware so it sits under every controller. The
 * alternative — an audit call in each handler — records the writes somebody
 * remembered to instrument, and the ones that matter most are usually the ones
 * added in a hurry.
 */

// Master data and the accounts that touch it. What this deliberately leaves out
// matters as much as what it covers:
//
//   Invoice / InvoiceItem — already attributed by Invoice.userId, append-only,
//     and never edited. Auditing them would double the write volume of the
//     hottest path in the product to restate something already recorded.
//   RefreshToken — churns by design. Access tokens last 30 minutes, so every
//     device rotates one roughly 48 times a day; auditing it would bury the
//     rows anyone actually wants to read.
//   InvoiceCounter — a serial allocator, not business data.
//   AuditLog — auditing the audit log does not terminate.
const AUDITED = new Set([
  "Medicine",
  "Batch",
  "Supplier",
  "Category",
  "Manufacturer",
  "Customer",
  "User",
]);

// Single-record writes only. `updateMany`/`deleteMany` are excluded on purpose:
// the one that matters is the stock decrement inside invoice creation, which is
// an updateMany and is already attributable through the invoice it belongs to.
// Auditing it would also mean an audit row for a sale that later rolled back,
// because the audit write cannot join the caller's transaction.
const AUDITED_ACTIONS = { create: "CREATE", update: "UPDATE", delete: "DELETE" };

// `updateMany` is excluded above for a good reason — the stock decrement inside
// invoice creation is one, and auditing it would double the write volume of the
// hottest path to restate what the invoice already records.
//
// But a conditional `updateMany` is also the only way to apply a bounded change
// atomically, which is exactly what a manual stock adjustment needs to avoid
// driving quantity below zero (FR-BATCH-11). Excluding it wholesale meant the
// one write that most needs a trail produced none.
//
// The opt-in is the reason itself: a handler that calls `setReason` is stating
// that this write is worth recording. The invoice path never does, so it stays
// out; anything deliberately annotated comes in.
const BULK_ACTIONS = { updateMany: "UPDATE", deleteMany: "DELETE" };

// An audit row must never become a second place credentials live.
const REDACTED = new Set(["password", "tokenVersion"]);

// "Batch" -> "batch", the property name on the Prisma client.
const modelAccessor = (model) => model[0].toLowerCase() + model.slice(1);

const strip = (value) => {
  if (!value || typeof value !== "object") return value ?? null;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (REDACTED.has(k)) continue;
    // Prisma sends `{ increment: 1 }` and friends for atomic updates; record the
    // instruction rather than a value that was never in the row.
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
};

const auditMiddleware = (prisma) => async (params, next) => {
  const declared = currentActor()?.reason;
  const action =
    AUDITED_ACTIONS[params.action] ??
    (declared ? BULK_ACTIONS[params.action] : undefined);
  if (!action || !AUDITED.has(params.model)) return next(params);

  // Read the prior state before the write lands. One extra query per audited
  // write, on master data only — the hot paths are excluded above.
  let before = null;
  if (action !== "CREATE" && params.args?.where) {
    try {
      before = await prisma[modelAccessor(params.model)].findUnique({
        where: params.args.where,
      });
    } catch {
      // A `where` this lookup cannot use is not a reason to fail the write.
      before = null;
    }
  }

  const result = await next(params);

  // A bulk write returns `{ count }`, not the row, so the resulting state has to
  // be read back — otherwise `after` records how many rows changed instead of
  // what they changed to, which is not an audit trail.
  const isBulk = Boolean(BULK_ACTIONS[params.action]);
  let after = result;
  if (isBulk) {
    after = null;
    const id = params.args?.where?.id;
    if (id && action !== "DELETE") {
      try {
        after = await prisma[modelAccessor(params.model)].findUnique({
          where: { id },
        });
      } catch {
        after = null;
      }
    }
  }

  // Never let bookkeeping fail the operation it is describing. A lost audit row
  // is a gap in a record; a rejected write is a pharmacist unable to do their
  // job, and the second is worse.
  try {
    const actor = currentActor();
    await prisma.auditLog.create({
      data: {
        actorId: actor?.id ?? null,
        actorEmail: actor?.email ?? null,
        requestId: actor?.requestId ?? null,
        reason: actor?.reason ?? null,
        action,
        model: params.model,
        // `updateMany` returns a count, not a row, so fall back to the id the
        // caller targeted — and leave it null when the where clause was not an
        // identity, rather than inventing one.
        recordId:
          result?.id ?? before?.id ?? params.args?.where?.id ?? null,
        before: action === "CREATE" ? undefined : strip(before),
        after: action === "DELETE" ? undefined : strip(after),
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("audit: failed to record a write", {
      model: params.model,
      action,
      message: err.message,
    });
  }

  return result;
};

module.exports = { auditMiddleware, AUDITED, REDACTED };
