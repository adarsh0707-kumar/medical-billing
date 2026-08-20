-- Performance indexes. Six b-tree indexes Prisma generated from the @@index
-- declarations in schema.prisma, plus one it cannot express.
--
-- Every one of these tables was on a sequential scan before this migration: the
-- schema had no custom indexes at all, only primary keys and unique constraints.

-- CreateIndex
CREATE INDEX "Batch_expiryDate_idx" ON "Batch"("expiryDate");

-- CreateIndex
CREATE INDEX "Batch_quantity_idx" ON "Batch"("quantity");

-- CreateIndex
CREATE INDEX "Batch_medicineId_idx" ON "Batch"("medicineId");

-- CreateIndex
CREATE INDEX "Invoice_date_idx" ON "Invoice"("date");

-- CreateIndex
CREATE INDEX "Invoice_customerId_idx" ON "Invoice"("customerId");

-- CreateIndex
CREATE INDEX "InvoiceItem_invoiceId_idx" ON "InvoiceItem"("invoiceId");

-- ─────────────────────────────────────────────────────────────────────────────
-- POS search, which Prisma cannot express in schema.prisma.
--
-- `search` matches with ILIKE '%q%'. A leading wildcard makes a b-tree useless —
-- there is no prefix to descend on — so the query degrades to a full scan of
-- every medicine as the catalogue grows. A trigram index can serve it, because
-- it indexes three-character substrings rather than the string's beginning.
--
-- pg_trgm ships with PostgreSQL but is not enabled by default. CREATE EXTENSION
-- needs superuser, which the application role is in the default compose setup;
-- if your deployment's role is not, enable it once as an administrator and this
-- migration will pass over it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- One index covering both columns the search reads, so the OR is served by a
-- single bitmap scan rather than two.
CREATE INDEX "Medicine_name_generic_trgm_idx"
    ON "Medicine" USING GIN (
        "name" gin_trgm_ops,
        COALESCE("genericName", '') gin_trgm_ops
    );
