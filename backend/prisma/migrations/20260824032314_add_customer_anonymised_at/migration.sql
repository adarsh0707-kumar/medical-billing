-- Customer erasure and retention (PRD Q6, docs/07 section 8).
--
-- The last unchecked box in SECURITY.md's operator checklist. Customer name,
-- phone, address, age, gender and full purchase history were kept forever, with
-- no way to remove any of it.
--
-- Erasure has to work around one hard constraint: invoices are append-only, they
-- carry a foreign key to Customer, and they are tax records that must survive
-- for years. Deleting the row is therefore not available. Instead the personal
-- fields are blanked in place and this column records when — the sale keeps its
-- counterparty, and the counterparty stops being a person anyone can identify.
--
-- Indexed because the retention sweep's query is "customers whose last invoice
-- predates the window and who have not already been done".

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "anonymisedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Customer_anonymisedAt_idx" ON "Customer"("anonymisedAt");
