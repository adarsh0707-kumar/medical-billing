-- Token revocation (FR-AUTH-09, docs/07 A-2 / P1-7).
--
-- Every issued JWT carries the value of this counter at the moment it was
-- signed. `protect` compares the token's copy against the row on every request
-- — it already reloads the user, so this costs nothing extra — and rejects any
-- token whose copy has fallen behind. Incrementing therefore invalidates every
-- outstanding session for that one user, which is what logout does.
--
-- A counter rather than a "tokens valid from" timestamp, deliberately. JWT
-- `iat` is second-granular: a token signed in the same second as a logout would
-- compare equal and survive the revocation it was meant to be caught by. A
-- one-second hole in a revocation control is not a revocation control.
--
-- Default 0 means tokens issued before this migration keep working: they carry
-- no claim, the middleware reads a missing claim as 0, and 0 matches the column
-- until that user logs out once. Deploying this does not sign everybody out.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "tokenVersion" INTEGER NOT NULL DEFAULT 0;
