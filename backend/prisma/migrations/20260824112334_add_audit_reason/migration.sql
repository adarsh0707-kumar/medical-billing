-- A "why" for audited writes (FR-BATCH-11).
--
-- The audit log already answers who, when, and what changed. For most writes
-- that is the whole story: before/after says a price went from 24.50 to 31.75
-- and there is nothing further to record.
--
-- Manual stock adjustment is the case where it is not. "Quantity went from 40 to
-- 37" is not an audit trail — breakage, theft and a miscount are three different
-- events with the same before and after, and telling them apart is the entire
-- reason FR-BATCH-11 exists. So the reason travels with the request, on the same
-- AsyncLocalStorage context that carries the actor, and lands here.
--
-- Nullable because most writes have nothing to add. The adjustment endpoint
-- requires it regardless; that is a rule about the endpoint, not the column.

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "reason" TEXT;
