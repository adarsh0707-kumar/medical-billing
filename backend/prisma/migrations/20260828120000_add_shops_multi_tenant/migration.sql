-- Multi-tenant conversion (signup feature, docs/05 roadmap).
--
-- Every table that used to be implicitly "the shop's" data now carries a
-- `shopId`. Existing installations are not empty, so this cannot simply add
-- NOT NULL columns: it creates one "legacy-default-shop" row first and backs
-- every existing record onto it, so an install upgrading in place keeps
-- working exactly as before, as the one shop it always was. New installs
-- create their own Shop through POST /api/auth/signup and never see this row.
--
-- Order matters throughout: each table gets its column added nullable,
-- backfilled, then locked to NOT NULL — a column cannot be required before
-- every existing row has a value for it.

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "gstNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

INSERT INTO "Shop" ("id", "name")
VALUES ('legacy-default-shop', 'My Shop');

-- ─── User ────────────────────────────────────────────────
ALTER TABLE "User" ADD COLUMN "shopId" TEXT;
UPDATE "User" SET "shopId" = 'legacy-default-shop';
ALTER TABLE "User" ALTER COLUMN "shopId" SET NOT NULL;
CREATE INDEX "User_shopId_idx" ON "User"("shopId");
ALTER TABLE "User" ADD CONSTRAINT "User_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── AuditLog ────────────────────────────────────────────
-- Nullable: an unauthenticated write (the seed script, a migration) has no
-- shop to attribute it to, same as it already has no actor.
ALTER TABLE "AuditLog" ADD COLUMN "shopId" TEXT;
UPDATE "AuditLog" SET "shopId" = 'legacy-default-shop';
CREATE INDEX "AuditLog_shopId_idx" ON "AuditLog"("shopId");
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Category ────────────────────────────────────────────
ALTER TABLE "Category" DROP CONSTRAINT IF EXISTS "Category_name_key";
ALTER TABLE "Category" ADD COLUMN "shopId" TEXT;
UPDATE "Category" SET "shopId" = 'legacy-default-shop';
ALTER TABLE "Category" ALTER COLUMN "shopId" SET NOT NULL;
CREATE UNIQUE INDEX "Category_shopId_name_key" ON "Category"("shopId", "name");
CREATE INDEX "Category_shopId_idx" ON "Category"("shopId");
ALTER TABLE "Category" ADD CONSTRAINT "Category_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Manufacturer ────────────────────────────────────────
ALTER TABLE "Manufacturer" DROP CONSTRAINT IF EXISTS "Manufacturer_name_key";
ALTER TABLE "Manufacturer" ADD COLUMN "shopId" TEXT;
UPDATE "Manufacturer" SET "shopId" = 'legacy-default-shop';
ALTER TABLE "Manufacturer" ALTER COLUMN "shopId" SET NOT NULL;
CREATE UNIQUE INDEX "Manufacturer_shopId_name_key" ON "Manufacturer"("shopId", "name");
CREATE INDEX "Manufacturer_shopId_idx" ON "Manufacturer"("shopId");
ALTER TABLE "Manufacturer" ADD CONSTRAINT "Manufacturer_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Medicine ────────────────────────────────────────────
ALTER TABLE "Medicine" ADD COLUMN "shopId" TEXT;
UPDATE "Medicine" SET "shopId" = 'legacy-default-shop';
ALTER TABLE "Medicine" ALTER COLUMN "shopId" SET NOT NULL;
CREATE INDEX "Medicine_shopId_idx" ON "Medicine"("shopId");
ALTER TABLE "Medicine" ADD CONSTRAINT "Medicine_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Batch ───────────────────────────────────────────────
-- Denormalised from medicine.shopId — see the schema comment.
ALTER TABLE "Batch" ADD COLUMN "shopId" TEXT;
UPDATE "Batch" SET "shopId" = 'legacy-default-shop';
ALTER TABLE "Batch" ALTER COLUMN "shopId" SET NOT NULL;
CREATE INDEX "Batch_shopId_idx" ON "Batch"("shopId");
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Customer ────────────────────────────────────────────
ALTER TABLE "Customer" DROP CONSTRAINT IF EXISTS "Customer_phone_key";
ALTER TABLE "Customer" ADD COLUMN "shopId" TEXT;
UPDATE "Customer" SET "shopId" = 'legacy-default-shop';
ALTER TABLE "Customer" ALTER COLUMN "shopId" SET NOT NULL;
CREATE UNIQUE INDEX "Customer_shopId_phone_key" ON "Customer"("shopId", "phone");
CREATE INDEX "Customer_shopId_idx" ON "Customer"("shopId");
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Supplier ────────────────────────────────────────────
ALTER TABLE "Supplier" ADD COLUMN "shopId" TEXT;
UPDATE "Supplier" SET "shopId" = 'legacy-default-shop';
ALTER TABLE "Supplier" ALTER COLUMN "shopId" SET NOT NULL;
CREATE INDEX "Supplier_shopId_idx" ON "Supplier"("shopId");
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Invoice ─────────────────────────────────────────────
ALTER TABLE "Invoice" DROP CONSTRAINT IF EXISTS "Invoice_invoiceNumber_key";
ALTER TABLE "Invoice" ADD COLUMN "shopId" TEXT;
UPDATE "Invoice" SET "shopId" = 'legacy-default-shop';
ALTER TABLE "Invoice" ALTER COLUMN "shopId" SET NOT NULL;
CREATE UNIQUE INDEX "Invoice_shopId_invoiceNumber_key" ON "Invoice"("shopId", "invoiceNumber");
CREATE INDEX "Invoice_shopId_idx" ON "Invoice"("shopId");
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── InvoiceCounter ──────────────────────────────────────
-- The primary key moves from ("day") to ("shopId", "day"), so the existing
-- row(s) need a shopId before the key can change shape at all.
ALTER TABLE "InvoiceCounter" ADD COLUMN "shopId" TEXT;
UPDATE "InvoiceCounter" SET "shopId" = 'legacy-default-shop';
ALTER TABLE "InvoiceCounter" ALTER COLUMN "shopId" SET NOT NULL;
ALTER TABLE "InvoiceCounter" DROP CONSTRAINT "InvoiceCounter_pkey";
ALTER TABLE "InvoiceCounter" ADD CONSTRAINT "InvoiceCounter_pkey" PRIMARY KEY ("shopId", "day");
ALTER TABLE "InvoiceCounter" ADD CONSTRAINT "InvoiceCounter_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
