import { beforeEach, afterAll } from "vitest";
import prisma from "../../src/config/db.js";

// Children before parents, so foreign keys never block the wipe.
const TABLES = [
  // Carries no foreign key — attribution has to survive the actor being
  // deleted — so nothing cascades it away and it must be listed explicitly.
  "AuditLog",
  // Cascade-deleted with its User today; listed anyway, so a change to that
  // FK cannot quietly start leaking sessions between tests.
  "RefreshToken",
  // Both reference Invoice, so both go before it.
  "Prescription",
  "InvoiceItem",
  "Invoice",
  "Batch",
  "Medicine",
  "Category",
  "Manufacturer",
  "Supplier",
  "Customer",
  "User",
  "InvoiceCounter",
  // Referenced by everything above, so it has to be last.
  "Shop",
];

// A clean database per test. Slower than wrapping each test in a transaction
// and rolling back, but the code under test opens its own transactions, and a
// nested one would not behave the way production does — production behaviour is
// exactly what these tests exist to assert.
beforeEach(async () => {
  // DELETE rather than TRUNCATE: at fixture scale the tables hold a handful of
  // rows, and TRUNCATE's exclusive lock and file truncation cost more than the
  // deletes do. Measured at roughly half the suite's wall-clock.
  await prisma.$transaction(
    TABLES.map((t) => prisma.$executeRawUnsafe(`DELETE FROM "${t}"`)),
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});
