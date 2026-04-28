-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER');

-- AlterTable
ALTER TABLE "Batch" ADD COLUMN     "mfgDate" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "age" INTEGER,
ADD COLUMN     "gender" "Gender";
