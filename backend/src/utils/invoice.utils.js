const prisma = require("../config/db");

const twoDigit = (n) => String(n).padStart(2, "0");

const startOfDay = (date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());

const startOfNextDay = (date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);

const dayKey = (date) =>
  `${String(date.getFullYear()).slice(-2)}${twoDigit(date.getMonth() + 1)}${twoDigit(date.getDate())}`;

// Allocates the next invoice serial for `now`'s date — INVyymmdd-nnnn — scoped
// to one shop. Each shop numbers its own invoices from its own counter row, so
// two shops both issuing their first sale of the day both get -0001.
//
// Counting today's invoices and adding one is a read-then-write race: two
// checkouts read the same count and derive the same number, and retrying only
// makes them collide again. Instead the serial comes from a single atomic
// statement against a per-shop-per-day counter row. Concurrent transactions
// queue on that row's lock, so each gets a distinct value; and because the
// increment lives inside the caller's transaction, a rolled-back sale gives
// its number back rather than leaving a gap in a tax document.
//
// The row is seeded from the invoices already recorded for the shop and day,
// so days written before this counter existed continue where they left off.
// The seed counts SALES only: credit notes allocate from their own
// CRN-prefixed row, so counting them here started the sale series above 1 on
// any day whose first document was a reversal — void yesterday's invoice at
// 9am and the day's first sale was numbered -0002, with no -0001. A gap in a
// serial sequence is exactly what this counter exists to prevent, and it is a
// tax document.
//
// MUST be called with the transaction client that inserts the invoice.
const generateInvoiceNumber = async (
  client = prisma,
  shopId,
  now = new Date(),
) => {
  const [{ seq }] = await client.$queryRaw`
    INSERT INTO "InvoiceCounter" ("shopId", "day", "seq")
    VALUES (
      ${shopId},
      ${dayKey(now)},
      (SELECT COUNT(*)::int FROM "Invoice"
        WHERE "shopId" = ${shopId}
          AND "type" = 'SALE'::"InvoiceType"
          AND "createdAt" >= ${startOfDay(now)}
          AND "createdAt" < ${startOfNextDay(now)}) + 1
    )
    ON CONFLICT ("shopId", "day") DO UPDATE SET "seq" = "InvoiceCounter"."seq" + 1
    RETURNING "seq"`;

  return `INV${dayKey(now)}-${String(seq).padStart(4, "0")}`;
};

// CRNyymmdd-nnnn. Credit notes get their own series so a tax authority — or a
// shopkeeper — can tell a sale from a reversal at a glance, and so voiding never
// consumes a sale's serial.
//
// Shares InvoiceCounter with the sale series by namespacing the key: the row is
// "CRN260820" rather than "260820", which keeps the same atomic allocation
// without a second table — still one row per shop per (namespaced) day. MUST
// be called with the transaction client.
const generateCreditNoteNumber = async (
  client = prisma,
  shopId,
  now = new Date(),
) => {
  const key = `CRN${dayKey(now)}`;
  const [{ seq }] = await client.$queryRaw`
    INSERT INTO "InvoiceCounter" ("shopId", "day", "seq")
    VALUES (
      ${shopId},
      ${key},
      (SELECT COUNT(*)::int FROM "Invoice"
        WHERE "shopId" = ${shopId}
          AND "type" = 'CREDIT_NOTE'::"InvoiceType"
          AND "createdAt" >= ${startOfDay(now)}
          AND "createdAt" < ${startOfNextDay(now)}) + 1
    )
    ON CONFLICT ("shopId", "day") DO UPDATE SET "seq" = "InvoiceCounter"."seq" + 1
    RETURNING "seq"`;

  return `CRN${dayKey(now)}-${String(seq).padStart(4, "0")}`;
};

// True when a write lost the race for a document number to a transaction that
// committed first. The counter makes this unreachable in normal operation; it
// stays as the backstop for numbers created before the counter existed.
const isDuplicateNumber = (err, field) =>
  err?.code === "P2002" && [].concat(err.meta?.target ?? []).includes(field);

module.exports = {
  generateInvoiceNumber,
  generateCreditNoteNumber,
  isDuplicateNumber,
};
