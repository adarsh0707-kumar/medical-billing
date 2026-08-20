-- Invariant I-1: a batch's stock can never be negative.
--
-- Enforced in application code by the conditional decrement inside the invoice
-- transaction (see G-09), which matches zero rows when another sale already took
-- the units. That guard is correct, but it is the only thing standing between a
-- future write path and negative stock — and stock going negative is silent,
-- corrupts every valuation and reorder report downstream, and is close to
-- impossible to reconstruct after the fact.
--
-- This constraint is the backstop. Nothing in the current codebase should ever
-- reach it; if it fires, a new write path has skipped the guarded decrement and
-- the failed statement is the bug report.
--
-- Prisma cannot express CHECK constraints in schema.prisma, so this migration is
-- hand-written. `prisma migrate dev` will not regenerate it, and a future
-- `prisma db push` against a scratch database will not create it either — the
-- constraint lives only in migration history. schema.prisma carries a doc comment
-- pointing here so it is not invisible to a reader of the model.
--
-- Verified before applying: 0 rows with quantity < 0 (5 batches, minimum 5).

ALTER TABLE "Batch"
  ADD CONSTRAINT "Batch_quantity_non_negative" CHECK ("quantity" >= 0);
