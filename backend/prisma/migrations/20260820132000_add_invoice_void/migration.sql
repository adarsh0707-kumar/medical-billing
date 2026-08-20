-- Void / credit-note support for invoices (G-15, FR-BILL-17).
--
-- Two enums rather than one more PaymentStatus value. "Was it paid" and "is it a
-- reversal" are orthogonal, and folding CANCELLED into PaymentStatus would have
-- made a voided invoice disappear from the GST report, which filters on PAID —
-- silently rewriting a tax period that may already have been filed.
--
-- The policy this implements (PRD Q3, decided 2026-08-20): a void leaves the
-- original invoice in its own period with every figure intact and issues a dated
-- credit note in the current one, the way a GST credit note (CDNR) works. Stock
-- returns to the batches it came from.

CREATE TYPE "InvoiceType" AS ENUM ('SALE', 'CREDIT_NOTE');
CREATE TYPE "InvoiceStatus" AS ENUM ('ACTIVE', 'CANCELLED');

ALTER TABLE "Invoice" ADD COLUMN "type"   "InvoiceType"   NOT NULL DEFAULT 'SALE';
ALTER TABLE "Invoice" ADD COLUMN "status" "InvoiceStatus" NOT NULL DEFAULT 'ACTIVE';

-- Set on a credit note, pointing at the sale it reverses.
ALTER TABLE "Invoice" ADD COLUMN "reversesId" TEXT;

-- One credit note per sale. This is the guard that makes a double-submitted void
-- restore stock exactly once: the second transaction loses the unique index and
-- rolls back, rather than deducting a second restoration.
CREATE UNIQUE INDEX "Invoice_reversesId_key" ON "Invoice"("reversesId");

ALTER TABLE "Invoice"
    ADD CONSTRAINT "Invoice_reversesId_fkey"
    FOREIGN KEY ("reversesId") REFERENCES "Invoice"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
