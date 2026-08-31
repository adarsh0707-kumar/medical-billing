const prisma = require("../config/db");

/**
 * Retention sweep for the audit log (NFR-17, docs/03 §3.12).
 *
 *   npm run purge:audit            # report what it would do
 *   npm run purge:audit -- --apply # do it
 *
 * **Why this exists.** Audit retention was decided at 24 months when the log
 * shipped on 2026-08-22, and nothing enforced it — four documents described a
 * policy that was not in force, and the table only grew. At this shop's volume
 * that is a few hundred rows a day, so it was never urgent; "not urgent" and
 * "not a decision" are different things.
 *
 * **Why 24 months.** Long enough to answer "who changed this price, and from
 * what" across a full annual cycle of GST filings, which is when a wrong figure
 * usually surfaces. Long enough that an erasure stays auditable well past the
 * point anyone would ask about it.
 *
 * **Why a script and not a scheduler**, same as the customer purge: this stack
 * has no background worker by design (docs/02 §1), and `scripts/backup.sh` set
 * the precedent — the software supplies the tool, the operator schedules it.
 *
 * Dry run by default. Deleting an audit trail is irreversible and is exactly the
 * kind of thing that should not happen because somebody was exploring.
 */

/**
 * ## Does this collide with customer erasure? No — and the direction is why.
 *
 * `erase-customer.js` blanks a customer's personal fields and then calls
 * `redactAuditTrail`, an `updateMany` that overwrites `before`/`after` on that
 * customer's audit rows with a marker. So both this sweep and erasure act on the
 * same rows, and the question is whether one can undermine the other.
 *
 * **It cannot, because deleting a row is strictly stronger than redacting it.**
 * Redaction exists to stop an audit row holding a copy of data that has been
 * erased everywhere else. A purge that removed the row first achieves that and
 * more — there is no copy left to redact. The two agree about the outcome and
 * differ only in how much they leave behind.
 *
 * **Nothing depends on a row still being there.** `redactAuditTrail` is an
 * `updateMany`; matching zero rows is a no-op, not a failure, so an erasure
 * whose audit rows have already aged out still succeeds and still leaves no
 * personal data anywhere. That is asserted in `tests/audit/audit-retention.test.js`
 * rather than left as reasoning — it is the one claim here that would be
 * expensive to get wrong.
 *
 * The hazard would have to run the other way, with erasure depending on rows
 * this sweep removes. It does not: the audit log is written and read by people,
 * never read back by the application to reconstruct state.
 *
 * **What gets no carve-out, deliberately.** The audit row recording an erasure
 * ages on this same 24-month clock. docs/03 §3.12 said audit retention "must
 * outlive the customer-retention period", written while PRD Q6 was still open
 * and the number unknown; Q6 landed at 36 months, which is longer than 24. Those
 * two clocks measure different things from different origins — 36 months from a
 * customer's last purchase, 24 months from an individual write — so one being
 * the larger number does not put them in conflict. What matters is that an
 * erasure stays auditable for two years after it happens, and it does. Carving
 * out erasure rows so they outlive everything else would be a different policy,
 * and it is not the one that was decided.
 */

const AUDIT_RETENTION_MONTHS = Number(process.env.AUDIT_RETENTION_MONTHS) || 24;

const cutoffDate = (months = AUDIT_RETENTION_MONTHS) => {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d;
};

/**
 * What the sweep would remove: every row written before the cutoff.
 *
 * **Not scoped by shop, and that is the exception rather than an oversight.**
 * Every query in the request path filters on `shopId` because a shop's data is
 * only its own. This is not the request path: retention is a property of the
 * installation the operator runs, applied on one clock to every tenant. A
 * per-shop sweep would mean one shop's operator could choose to keep records
 * another had purged, which is not a decision this policy hands anybody.
 *
 * `at` is indexed (`@@index([at])`), so both the count and the delete are a
 * range scan rather than a table walk.
 */
const findExpired = async (cutoff) => {
  const [count, oldest] = await Promise.all([
    prisma.auditLog.count({ where: { at: { lt: cutoff } } }),
    prisma.auditLog.findFirst({
      where: { at: { lt: cutoff } },
      orderBy: { at: "asc" },
      select: { at: true, model: true, action: true },
    }),
  ]);
  return { count, oldest };
};

const monthsSince = (date) =>
  Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24 * 30.44));

const run = async ({ apply = false, months = AUDIT_RETENTION_MONTHS } = {}) => {
  const cutoff = cutoffDate(months);
  const { count, oldest } = await findExpired(cutoff);

  console.log(
    `Audit retention: ${months} months. Cutoff ${cutoff.toISOString().slice(0, 10)}.`,
  );
  console.log(`${count} audit row(s) written before then.`);

  if (!count) return { considered: 0, deleted: 0 };

  if (oldest) {
    console.log(
      `Oldest is ${oldest.at.toISOString().slice(0, 10)} — about ${monthsSince(oldest.at)} months old ` +
        `(${oldest.action} on ${oldest.model}).`,
    );
  }

  if (!apply) {
    console.log("\nDry run — nothing changed. Re-run with --apply to delete.");
    return { considered: count, deleted: 0 };
  }

  // One statement, not a loop. The customer purge goes row by row because each
  // erasure is several writes that should fail at a customer boundary; this has
  // no such structure — it is one range delete on an indexed column, and
  // splitting it would only widen the window in which the table is half-swept.
  //
  // It writes no audit rows of its own: `AuditLog` is deliberately absent from
  // the audited model set in `config/audit.js`, so this `deleteMany` passes
  // through the extension untouched. A sweep that audited itself could never
  // shrink the table.
  const { count: deleted } = await prisma.auditLog.deleteMany({
    where: { at: { lt: cutoff } },
  });

  console.log(`Deleted ${deleted} audit row(s).`);
  return { considered: count, deleted };
};

module.exports = { run, findExpired, cutoffDate, AUDIT_RETENTION_MONTHS };

if (require.main === module) {
  run({ apply: process.argv.includes("--apply") })
    .catch((err) => {
      console.error("Audit retention sweep failed:", err.message);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
