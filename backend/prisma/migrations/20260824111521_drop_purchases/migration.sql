-- Remove the unbuilt purchases schema (PRD Q7, G-13).
--
-- Purchase and PurchaseItem were modelled in the initial migration and never
-- acquired a write path: no controller, no route, no validator, no UI, and
-- generatePurchaseNumber() was written and never called. The only thing that
-- referenced them was GET /api/inventory/suppliers/:id, which returned a
-- `purchases` array that was always empty — not because a supplier had sold us
-- nothing, but because nothing could ever write one. An empty array is a claim,
-- and that one was false.
--
-- Decided 2026-08-24: delete rather than build. The control this would have
-- provided already exists — Batch carries supplierId and purchasePrice, and
-- since 2026-08-22 the audit log records who created it, so stock already has a
-- traceable cause and a cost. What Phase 10 would add on top is purchase-level
-- grouping, supplier payables and margin reporting: features, not controls, and
-- ones nobody has asked for in the four months since 1.0.0.
--
-- Reversible where it matters. The design is preserved in git history and in
-- docs/05 Phase 10, so procurement can be built later against real requirements
-- instead of resurrecting an April 2026 guess. Keeping dead schema is not free:
-- it misled every reader of the model, it kept G-13 permanently open, and it
-- made an API endpoint lie.
--
-- Verified empty before writing this: both tables held 0 rows.

/*
  Warnings:

  - You are about to drop the `Purchase` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PurchaseItem` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "Purchase" DROP CONSTRAINT "Purchase_supplierId_fkey";

-- DropForeignKey
ALTER TABLE "PurchaseItem" DROP CONSTRAINT "PurchaseItem_batchId_fkey";

-- DropForeignKey
ALTER TABLE "PurchaseItem" DROP CONSTRAINT "PurchaseItem_purchaseId_fkey";

-- DropTable
DROP TABLE "Purchase";

-- DropTable
DROP TABLE "PurchaseItem";
