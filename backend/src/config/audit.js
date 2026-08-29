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
  "Shop",
]);

// Single-record writes only. `updateMany`/`deleteMany` are excluded on purpose:
// the one that matters is the stock decrement inside invoice creation, which is
// an updateMany and is already attributable through the invoice it belongs to.
// Auditing it would also mean an audit row for a sale that later rolled back,
// because the audit write cannot join the caller's transaction.
const AUDITED_ACTIONS = {
  create: "CREATE",
  update: "UPDATE",
  delete: "DELETE",
};

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
//
// That opt-in is now one of three ways in, not the only one — see
// `auditsBulkWrite` below, which multi-tenancy made necessary.
const BULK_ACTIONS = { updateMany: "UPDATE", deleteMany: "DELETE" };

// Multi-tenancy forced every ordinary admin edit — rename a category, retire a
// supplier, deactivate a user — onto `updateMany`/`deleteMany` too: Prisma's
// singular `update`/`delete` accept only a unique selector, and `shopId` has to
// sit in the same `where` as `id` for the tenant boundary to be the query
// itself rather than a coincidence (see category.controller.js). Gating every
// one of those behind `setReason` would mean silently losing the audit trail
// for exactly the writes NFR-17 cares about, or forcing a reason prompt onto
// every category rename to get it back.
//
// So these models' bulk writes are audited unconditionally, same as their
// singular writes always were.
const BULK_AUDITED_UNCONDITIONALLY = new Set([
  "Category",
  "Manufacturer",
  "Medicine",
  "Supplier",
  "Customer",
  "User",
]);

// Batch cannot be settled by set membership either way, because one model's
// `updateMany` serves two writes with opposite requirements:
//
//   - the stock decrement inside every sale — the hot path the exclusion above
//     exists to protect, already attributed through `Invoice.userId`, and the
//     thing `leaves the invoice path alone` pins down;
//   - `PUT /batches/:id`, an ordinary admin edit of price and dates, which is
//     the write NFR-17 names first: "who changed this price, and from what".
//
// What separates them is the field list, not the route — a Prisma middleware
// cannot see a route. The sale's decrement writes nothing but `quantity`. The
// edit's schema is strict and deliberately *excludes* `quantity` (G-05), so it
// can never write it. A manual adjustment writes only `quantity` too, and comes
// in through the `setReason` opt-in it already declares (FR-BATCH-11).
//
// Hence: audit a Batch bulk write when it touches any field other than
// `quantity`. Keying off the data actually written rather than the caller means
// a future path that edits a price gets the trail without having to remember to
// ask for it — which is the whole reason this lives in a middleware.
const BULK_AUDIT_EXEMPT_FIELDS = { Batch: new Set(["quantity"]) };

const auditsBulkWrite = (model, args) => {
  if (BULK_AUDITED_UNCONDITIONALLY.has(model)) return true;
  const exempt = BULK_AUDIT_EXEMPT_FIELDS[model];
  if (!exempt) return false;
  return Object.keys(args?.data ?? {}).some((field) => !exempt.has(field));
};

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
  const bulk = BULK_ACTIONS[params.action];
  const action =
    AUDITED_ACTIONS[params.action] ??
    (bulk && (declared || auditsBulkWrite(params.model, params.args))
      ? bulk
      : undefined);
  if (!action || !AUDITED.has(params.model)) return next(params);

  // Read the prior state before the write lands. One extra query per audited
  // write, on master data only — the hot paths are excluded above.
  //
  // `findFirst` for a bulk write, `findUnique` for a singular one. They are not
  // interchangeable: a tenant-scoped `updateMany` selects on `{ id, shopId }`,
  // and `findUnique` rejects a non-unique field outright rather than filtering
  // by it. Sent there, every bulk `before` was thrown away by the catch below
  // and the audit row recorded a change from nothing.
  let before = null;
  if (action !== "CREATE" && params.args?.where) {
    const model = prisma[modelAccessor(params.model)];
    try {
      before = bulk
        ? await model.findFirst({ where: params.args.where })
        : await model.findUnique({ where: params.args.where });
    } catch {
      // A `where` this lookup cannot use is not a reason to fail the write.
      before = null;
    }
  }

  const result = await next(params);

  // A bulk write returns `{ count }`, not the row, so the resulting state has to
  // be read back — otherwise `after` records how many rows changed instead of
  // what they changed to, which is not an audit trail.
  let after = result;
  if (bulk) {
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
        shopId: actor?.shopId ?? null,
        actorId: actor?.id ?? null,
        actorEmail: actor?.email ?? null,
        requestId: actor?.requestId ?? null,
        reason: actor?.reason ?? null,
        action,
        model: params.model,
        // `updateMany` returns a count, not a row, so fall back to the id the
        // caller targeted — and leave it null when the where clause was not an
        // identity, rather than inventing one.
        recordId: result?.id ?? before?.id ?? params.args?.where?.id ?? null,
        before: action === "CREATE" ? undefined : strip(before),
        after: action === "DELETE" ? undefined : strip(after),
      },
    });
  } catch (err) {
    console.error("audit: failed to record a write", {
      model: params.model,
      action,
      message: err.message,
    });
  }

  return result;
};

module.exports = { auditMiddleware, AUDITED, REDACTED };
