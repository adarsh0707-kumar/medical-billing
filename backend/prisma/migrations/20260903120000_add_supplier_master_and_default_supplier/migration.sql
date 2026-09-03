-- Supplier grows the fields a real distributor master carries, and Medicine
-- gains the "who do we usually buy this from" link that a supplier master
-- expresses and this schema had nowhere to put.
--
-- Every column is nullable and nothing is backfilled: an existing supplier row
-- is a valid supplier row that simply has not been filled in yet. There is no
-- default that would be true of a distributor nobody has entered details for.

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "city" TEXT,
ADD COLUMN     "code" TEXT,
ADD COLUMN     "creditLimit" DECIMAL(12,2),
ADD COLUMN     "deliveryDays" TEXT,
ADD COLUMN     "drugLicenceNo" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "paymentTerms" TEXT,
ADD COLUMN     "pincode" TEXT,
ADD COLUMN     "state" TEXT;

-- AlterTable
ALTER TABLE "Medicine" ADD COLUMN     "defaultSupplierId" TEXT;

-- CreateIndex
CREATE INDEX "Medicine_defaultSupplierId_idx" ON "Medicine"("defaultSupplierId");

-- Unique per shop, and only where a code exists: Postgres treats NULLs as
-- distinct, so the suppliers with no code do not collide with one another.
-- CreateIndex
CREATE UNIQUE INDEX "Supplier_shopId_code_key" ON "Supplier"("shopId", "code");

-- SET NULL rather than RESTRICT: deleting a distributor should clear the
-- preference, not refuse the deletion. A *batch* reference still blocks it,
-- because that one is history rather than a preference.
-- AddForeignKey
ALTER TABLE "Medicine" ADD CONSTRAINT "Medicine_defaultSupplierId_fkey" FOREIGN KEY ("defaultSupplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
