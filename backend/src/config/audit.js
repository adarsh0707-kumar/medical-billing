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

// An audit row must never become a second place credentials live.
const REDACTED = new Set(["password", "tokenVersion"]);

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
  const action = AUDITED_ACTIONS[params.action];
  if (!action || !AUDITED.has(params.model)) return next(params);

  // Read the prior state before the write lands. One extra query per audited
  // write, on master data only — the hot paths are excluded above.
  let before = null;
  if (action !== "CREATE" && params.args?.where) {
    try {
      before = await prisma[params.model[0].toLowerCase() + params.model.slice(1)].findUnique(
        { where: params.args.where },
      );
    } catch {
      // A `where` this lookup cannot use is not a reason to fail the write.
      before = null;
    }
  }

  const result = await next(params);

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
        action,
        model: params.model,
        recordId: result?.id ?? before?.id ?? null,
        before: action === "CREATE" ? undefined : strip(before),
        after: action === "DELETE" ? undefined : strip(result),
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
