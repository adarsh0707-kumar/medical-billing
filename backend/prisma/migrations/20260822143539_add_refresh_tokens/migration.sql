-- Refresh-token rotation (FR-AUTH-10, docs/07 A-3 / P1-8).
--
-- Access tokens drop from 7 days to 30 minutes. A 7-day bearer credential in
-- localStorage is a long window for anything that reads it once; 30 minutes is
-- short enough that a captured access token is usually already dead.
--
-- The long-lived half becomes a refresh token in an httpOnly cookie, which
-- JavaScript cannot read. That is the whole point of the split: if both halves
-- sat in localStorage an XSS would steal the refresh credential and mint access
-- tokens at will, which is worse than the single token it replaced.
--
-- One row per signed-in device. The refresh token's jti is the row id, so the
-- server holds the authoritative state and the client only carries a pointer.
-- Every use rotates: the presented row is revoked and a new one issued. A
-- presented row that is ALREADY revoked means two parties hold the same
-- credential — a legitimate client never replays one — so that is treated as
-- theft and every session for that user is ended.
--
-- ON DELETE CASCADE so deleting a user does not fail on this foreign key. Users
-- who have raised invoices already cannot be deleted; sessions must not add a
-- second reason.

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
