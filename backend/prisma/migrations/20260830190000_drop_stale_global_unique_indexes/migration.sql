-- Drops four unique indexes that the multi-tenant migration meant to remove and
-- did not, leaving the tenant boundary half-applied.
--
-- WHAT WENT WRONG. `20260828120000_add_shops_multi_tenant` re-keyed these four
-- from global to per-shop, and removed the old keys with:
--
--     ALTER TABLE "Category" DROP CONSTRAINT IF EXISTS "Category_name_key";
--
-- Prisma emits `@unique` as a bare `CREATE UNIQUE INDEX`, not as a table
-- constraint. `DROP CONSTRAINT` does not match an index, and `IF EXISTS` turns
-- the miss into a silent success — so the migration reported applied, the new
-- per-shop keys were added alongside, and all four global keys survived. A
-- migration that half-succeeds without saying so is the worst version of this:
-- `_prisma_migrations` says the tenancy landed.
--
-- WHAT IT COST, measured on the development database before this ran:
--
--   * `Invoice_invoiceNumber_key` — the severe one. Serials are per shop and
--     restart at `-0001` each day for each shop, so the SECOND shop to sell on
--     any given day collided with the first and got
--     `409 A record with this value already exists`. Not a degraded report: no
--     shop but one could take money at all. `createInvoice`'s P2002 retry could
--     not help, because every attempt re-derives the same per-shop serial.
--   * `Category_name_key`, `Manufacturer_name_key` — a new shop could not
--     create a category or manufacturer any other shop had already named, so
--     "Tablet" was claimed system-wide by whoever typed it first.
--   * `Customer_phone_key` — two shops could not both hold a customer with the
--     same phone number, which for a chemist next door to another chemist is
--     an ordinary occurrence.
--
-- The per-shop replacements already exist and are untouched here; this only
-- removes the global keys that should have gone with them.

DROP INDEX IF EXISTS "Category_name_key";
DROP INDEX IF EXISTS "Manufacturer_name_key";
DROP INDEX IF EXISTS "Customer_phone_key";
DROP INDEX IF EXISTS "Invoice_invoiceNumber_key";
