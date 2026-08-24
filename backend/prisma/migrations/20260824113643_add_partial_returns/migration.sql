-- Partial returns (FR-BILL-17, deferred from G-15).
--
-- A void reversed a whole invoice. Returning 2 of 5 units was not expressible,
-- so a pharmacist had to void the sale and re-bill it — which changes the
-- invoice number a customer is holding.
--
-- THE GUARD IS THE INTERESTING PART. The old design restored stock exactly once
-- and was protected by two single-shot mechanisms: a conditional update on
-- `status = ACTIVE`, and a UNIQUE index on `reversesId` that allowed only one
-- credit note per sale. Neither survives partials, because a sale can now have
-- several credit notes.
--
-- So the unique index goes and the guarantee moves to `returnedQty`: a
-- cumulative per-line counter applied with a conditional update,
--
--     UPDATE "InvoiceItem" SET "returnedQty" = "returnedQty" + n
--      WHERE id = ? AND "returnedQty" <= quantity - n
--
-- which is the same atomic check-and-apply as the stock decrement in G-09. Two
-- simultaneous returns of the same units cannot both match: the loser affects
-- zero rows and rolls its whole transaction back. `quantity` is safe to read
-- beforehand and use as a constant because invoices are append-only — a line's
-- quantity never changes after it is written.
--
-- The period rule is untouched. The original stays in the GST period it was
-- issued in; each credit note lands in the period it was raised. The original
-- only becomes CANCELLED once every line is fully returned.

-- DropIndex
DROP INDEX "Invoice_reversesId_key";

-- AlterTable
ALTER TABLE "InvoiceItem" ADD COLUMN     "returnedQty" INTEGER NOT NULL DEFAULT 0;
