-- Audit log (NFR-17, docs/07 P1-11, threat T-12).
--
-- Until now the only attributed write in the system was Invoice.userId. Who
-- changed a selling price, who edited a batch's expiry, who deactivated an
-- account — none of it was recorded, which is also what has blocked
-- FR-BATCH-11: manual stock adjustment is only safe if it leaves a trace.
--
-- Written by a Prisma middleware, not by controllers. A controller-by-controller
-- approach records exactly the writes somebody remembered to instrument, which
-- over time is the writes that were never interesting.
--
-- The actor is a snapshot rather than a relation: actorId carries no foreign key
-- and actorEmail is copied in. A FK would either block deleting a user or null
-- the column out, and an audit trail that forgets who did something the moment
-- their account is removed is not an audit trail.
--
-- before/after are JSONB. Password hashes and the token-revocation counter are
-- stripped before storage — an audit row must never become a second place the
-- credential material lives.

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "action" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "recordId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "requestId" TEXT,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");

-- CreateIndex
CREATE INDEX "AuditLog_model_recordId_idx" ON "AuditLog"("model", "recordId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");
