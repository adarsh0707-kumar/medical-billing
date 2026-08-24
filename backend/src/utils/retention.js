const prisma = require("../config/db");
const { eraseCustomer } = require("./erase-customer");

/**
 * Retention sweep for customer personal data (PRD Q6, docs/07 §8).
 *
 *   npm run purge:customers            # report what it would do
 *   npm run purge:customers -- --apply # do it
 *
 * **Two clocks, because two different rules apply.**
 *
 * Invoices are books of account. Section 36 of the CGST Act requires them kept
 * 72 months from the due date of the annual return, so they are not this
 * script's business and it never touches them. A customer's *contact details*
 * are not a tax record — nothing in a GST return needs a home address — so they
 * answer to the ordinary principle that personal data is kept only as long as it
 * is needed.
 *
 * **Why 36 months of inactivity.** Long enough that a batch recall can still
 * reach whoever bought the affected stock: shelf life is typically under three
 * years, so anything older cannot still be in someone's cupboard. Long enough
 * that a customer with an annual repeat prescription is not erased between
 * visits. Short enough that three years of silence is taken to mean the
 * relationship ended.
 *
 * **Why a script and not a scheduler.** This stack has no background worker, by
 * design (docs/02 §1). `scripts/backup.sh` set the precedent: the software
 * supplies the tool and the operator schedules it. Saying so plainly is better
 * than shipping a cron daemon nobody asked for, or claiming an automatic purge
 * that does not exist.
 *
 * Dry run by default. A retention purge is irreversible, and a tool that erases
 * on its first invocation because someone was exploring is a bad tool.
 */

const RETENTION_MONTHS = Number(process.env.CUSTOMER_RETENTION_MONTHS) || 36;

const cutoffDate = (months = RETENTION_MONTHS) => {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d;
};

/**
 * Customers eligible for erasure: not already erased, and with no invoice since
 * the cutoff. A customer who has never bought anything is measured from when
 * their record was created — otherwise a record entered and abandoned would sit
 * forever, which is the case the policy most wants to catch.
 */
const findExpired = async (cutoff) =>
  prisma.customer.findMany({
    where: {
      anonymisedAt: null,
      OR: [
        { invoices: { none: {} }, createdAt: { lt: cutoff } },
        {
          invoices: { some: {} },
          NOT: { invoices: { some: { date: { gte: cutoff } } } },
        },
      ],
    },
    select: { id: true, name: true, createdAt: true },
  });

const run = async ({ apply = false, months = RETENTION_MONTHS } = {}) => {
  const cutoff = cutoffDate(months);
  const expired = await findExpired(cutoff);

  console.log(
    `Retention: ${months} months. Cutoff ${cutoff.toISOString().slice(0, 10)}.`,
  );
  console.log(`${expired.length} customer(s) with no activity since then.`);

  if (!expired.length) return { considered: 0, erased: 0 };
  if (!apply) {
    console.log("\nDry run — nothing changed. Re-run with --apply to erase.");
    for (const c of expired.slice(0, 20)) {
      console.log(`  would erase ${c.id}`);
    }
    if (expired.length > 20) console.log(`  ...and ${expired.length - 20} more`);
    return { considered: expired.length, erased: 0 };
  }

  let erased = 0;
  for (const customer of expired) {
    // One at a time rather than a bulk update: each erasure also has to redact
    // that customer's audit trail, and a partial failure should stop at a
    // customer boundary rather than halfway through one.
    await eraseCustomer(customer.id);
    erased++;
  }

  console.log(`Erased ${erased} customer record(s). Invoices untouched.`);
  return { considered: expired.length, erased };
};

module.exports = { run, findExpired, cutoffDate, RETENTION_MONTHS };

if (require.main === module) {
  run({ apply: process.argv.includes("--apply") })
    .catch((err) => {
      console.error("Retention sweep failed:", err.message);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
