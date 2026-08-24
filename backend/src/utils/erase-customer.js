const prisma = require("../config/db");

/**
 * Erases a customer's personal data while leaving their invoices intact
 * (PRD Q6, docs/07 §8).
 *
 * Not a delete. `Invoice.customerId` is a foreign key and invoices are
 * append-only tax records that have to survive for years, so removing the row
 * is not on the table. The personal fields are blanked instead: the sale keeps
 * its counterparty, and the counterparty stops being someone anyone can name.
 *
 * What survives on purpose: the row's `id`, `createdAt`, and every invoice with
 * its lines and totals. A GST return filed against those invoices still
 * reconciles afterwards, which it would not if the rows moved or vanished.
 */

// A marker rather than an empty string, so screens and printed invoices show
// something meaningful instead of a blank where a name used to be.
const ERASED_NAME = "Erased customer";

const ANONYMISED_FIELDS = {
  name: ERASED_NAME,
  // `phone` is uniquely indexed. Null is exempt from that in Postgres, so any
  // number of erased customers can coexist — and the number becomes available
  // again for a new customer, which is correct: it is a phone number, not an
  // identifier we own.
  phone: null,
  email: null,
  address: null,
  age: null,
  gender: null,
};

/**
 * Erasure has to reach the audit log too.
 *
 * The audit middleware records before/after for every Customer write, so those
 * rows hold copies of exactly the data being erased. Blanking the customer while
 * leaving a full copy in `AuditLog` would be theatre — the residue was flagged
 * when the audit log was built (docs/03 §3.11) and this is where it gets paid.
 *
 * The attribution survives: who changed the record and when is still there. Only
 * the personal payload is replaced.
 */
const REDACTION = { redacted: "customer data erased" };

/**
 * What erasure deliberately does **not** reach: `Prescription.patientName`.
 *
 * The prescription register is a statutory record. Rule 65(11) of the Drugs and
 * Cosmetics Rules requires a pharmacy to be able to produce the particulars of a
 * Schedule H supply — including the patient — and a right to erasure does not
 * override an obligation to retain. This is the same reasoning that keeps the
 * invoice: both are records the shop is required to hold, not data it chose to
 * keep.
 *
 * So an erased customer's name disappears from `Customer` and from the audit
 * trail, and survives in the register of any Schedule H medicine they were
 * dispensed. That is a real limit on the erasure promise and is documented in
 * docs/03 §8 rather than left for someone to discover.
 */

const redactAuditTrail = (customerId) =>
  prisma.auditLog.updateMany({
    where: { model: "Customer", recordId: customerId },
    data: { before: REDACTION, after: REDACTION },
  });

const eraseCustomer = async (customerId) => {
  const existing = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { id: true, anonymisedAt: true },
  });
  if (!existing) return { found: false };
  if (existing.anonymisedAt) {
    // Sweep anyway: see the note below on why this is not atomic, and why
    // re-running has to repair rather than report.
    await redactAuditTrail(customerId);
    return { found: true, alreadyErased: true, at: existing.anonymisedAt };
  }

  const at = new Date();

  await prisma.customer.update({
    where: { id: customerId },
    data: { ...ANONYMISED_FIELDS, anonymisedAt: at },
  });

  // Deliberately after the update, and deliberately not inside a transaction
  // with it.
  //
  // The audit middleware records this very update, and it writes through the
  // global client rather than the caller's transaction — so a sweep enclosed
  // with the update could run before the row it most needs to catch even
  // exists, leaving a full pre-erasure copy behind. Running last catches it.
  //
  // The cost is that the two steps are not atomic: a crash between them leaves
  // an erased customer with un-redacted audit rows. That is why the sweep below
  // runs whether or not the customer was already erased — re-running the
  // erasure repairs it, rather than reporting "already done" and walking past
  // the residue.
  await redactAuditTrail(customerId);

  return { found: true, alreadyErased: false, at };
};

module.exports = { eraseCustomer, ERASED_NAME, ANONYMISED_FIELDS, REDACTION };
