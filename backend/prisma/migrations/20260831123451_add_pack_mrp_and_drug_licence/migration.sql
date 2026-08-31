-- AlterTable
ALTER TABLE "Batch" ADD COLUMN     "mrp" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "Medicine" ADD COLUMN     "packSize" TEXT;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "drugLicenceNo" TEXT;
