const { currentActor, currentTransactionClient } = require("./audit-context");

/**
 * Records who changed what (NFR-17, threat T-12).
 *
 * Installed on the Prisma client so it sits under every controller. The
 * alternative — an audit call in each handler — records the writes somebody
 * remembered to instrument, and the ones that matter most are usually the ones
 * added in a hurry.
 *
 * ## A client extension, not `$use`, since 2026-08-31
 *
 * A Prisma middleware cannot see the transaction its caller is in, so every
 * audited write inside one issued its reads and its `AuditLog` insert on the
 * *global* client — a second pooled connection, taken while the caller still
 * held the first. Two consequences, and the second is the one that made this
 * worth doing:
 *
 * 1. **A concurrency ceiling.** With a pool of 9, N concurrent voids need 2N
 *    connections and deadlock as soon as N > 9 − N. Measured at five;
 *    `tests/billing/invoice-void.test.js` capped its own concurrency at four to
 *    stay underneath, which is a test written around a defect rather than
 *    against it.
 * 2. **A correctness bug nobody had written down.** The audit insert committed
 *    on its own connection, so a sale that rolled back left an audit row
 *    claiming a change that never happened. Verified against this database
 *    before the migration: one surviving row per rolled-back transaction.
 *
 * An extension does not solve this by itself — Prisma gives a `query` extension
 * no handle on the caller's transaction either. What closes it is
 * `config/db.js` wrapping `$transaction` so the callback runs inside an
 * `AsyncLocalStorage`, which this reads back through `currentTransactionClient`.
 * The extension is what makes that reachable at all: `$use` runs outside the
 * extended client's operation pipeline, so there was nowhere to put it.
 *
 * **The array form `$transaction([...])` is unchanged**, and still writes its
 * audit rows outside the transaction. Prisma exposes no client for that form, so
 * there is nothing to capture. It is used for a handful of account writes in
 * `auth.controller.js` and `user.controller.js`, none of which are contended, so
 * the ceiling does not bite there.
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
//
// This exclusion used to carry a second reason — that auditing it would leave a
// row behind for a sale that later rolled back, because the audit write could
// not join the caller's transaction. **That reason is gone as of 2026-08-31**
// and is recorded here rather than quietly deleted, because it was real: the
// write now joins the transaction and rolls back with it. What still stands is
// the first reason, which is sufficient on its own — auditing the decrement
// would double the write volume of the hottest path in the product to restate
// something `Invoice.userId` already records.
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

/**
 * Builds the extension.
 *
 * `baseClient` is the **unextended** client, and that is deliberate. Its reads
 * do not re-enter this extension, so there is no recursion to guard against, and
 * it is only ever reached when there is no transaction to use.
 */
const auditExtension = (baseClient) => ({
  name: "audit",
  query: {
    $allOperations: async ({ model, operation, args, query }) => {
      const declared = currentActor()?.reason;
      const bulk = BULK_ACTIONS[operation];
      const action =
        AUDITED_ACTIONS[operation] ??
        (bulk && (declared || auditsBulkWrite(model, args)) ? bulk : undefined);
      // `model` is undefined for client-level operations ($queryRaw, $executeRaw),
      // which `$allOperations` also sees and `$use` did not.
      if (!action || !model || !AUDITED.has(model)) return query(args);

      // Everything this extension does itself — the before/after reads and the
      // audit insert — goes through the caller's transaction when there is one.
      //
      // That is the whole point of the migration. On the global client these
      // took a second pooled connection while the caller held the first, which
      // is what capped concurrent voids at five; and the insert committed
      // independently, so a rolled-back write left an audit row behind claiming
      // it had happened.
      //
      // It also makes the `before` read correct inside a transaction, which it
      // was not: read on the global client it could not see the transaction's
      // own earlier writes, so a second edit to the same row in one transaction
      // recorded the state from before the first.
      const db = currentTransactionClient() ?? baseClient;

      // Read the prior state before the write lands. One extra query per audited
      // write, on master data only — the hot paths are excluded above.
      //
      // `findFirst` for a bulk write, `findUnique` for a singular one. They are
      // not interchangeable: a tenant-scoped `updateMany` selects on
      // `{ id, shopId }`, and `findUnique` rejects a non-unique field outright
      // rather than filtering by it. Sent there, every bulk `before` was thrown
      // away by the catch below and the audit row recorded a change from nothing.
      let before = null;
      if (action !== "CREATE" && args?.where) {
        const accessor = db[modelAccessor(model)];
        try {
          before = bulk
            ? await accessor.findFirst({ where: args.where })
            : await accessor.findUnique({ where: args.where });
        } catch {
          // A `where` this lookup cannot use is not a reason to fail the write.
          before = null;
        }
      }

      const result = await query(args);

      // A bulk write returns `{ count }`, not the row, so the resulting state
      // has to be read back — otherwise `after` records how many rows changed
      // instead of what they changed to, which is not an audit trail.
      let after = result;
      if (bulk) {
        after = null;
        const id = args?.where?.id;
        if (id && action !== "DELETE") {
          try {
            after = await db[modelAccessor(model)].findUnique({
              where: { id },
            });
          } catch {
            after = null;
          }
        }
      }

      const actor = currentActor();
      const row = {
        shopId: actor?.shopId ?? null,
        actorId: actor?.id ?? null,
        actorEmail: actor?.email ?? null,
        requestId: actor?.requestId ?? null,
        reason: actor?.reason ?? null,
        action,
        model,
        // `updateMany` returns a count, not a row, so fall back to the id the
        // caller targeted — and leave it null when the where clause was not an
        // identity, rather than inventing one.
        recordId: result?.id ?? before?.id ?? args?.where?.id ?? null,
        before: action === "CREATE" ? undefined : strip(before),
        after: action === "DELETE" ? undefined : strip(after),
      };

      // Outside a transaction: never let bookkeeping fail the operation it is
      // describing. A lost audit row is a gap in a record; a rejected write is a
      // pharmacist unable to do their job, and the second is worse.
      //
      // **Inside one, the same swallow would be actively harmful**, which is new
      // with this migration and is the one behaviour it deliberately changes. A
      // failed statement aborts the whole Postgres transaction, so by the time
      // this catch ran the caller's transaction would already be doomed —
      // swallowing would hide the cause and surface it later as an unrelated
      // "current transaction is aborted" on the caller's next statement. Letting
      // it propagate rolls the write back with a message that names what
      // actually failed.
      if (currentTransactionClient()) {
        await db.auditLog.create({ data: row });
      } else {
        try {
          await db.auditLog.create({ data: row });
        } catch (err) {
          console.error("audit: failed to record a write", {
            model,
            action,
            message: err.message,
          });
        }
      }

      return result;
    },
  },
});

module.exports = { auditExtension, AUDITED, REDACTED };
