import { beforeEach, afterAll } from "vitest";
import prisma from "../../src/config/db.js";

// Children before parents, so foreign keys never block the wipe.
const TABLES = [
  "InvoiceItem",
  "Invoice",
  "PurchaseItem",
  "Purchase",
  "Batch",
  "Medicine",
  "Category",
  "Manufacturer",
  "Supplier",
  "Customer",
  "User",
  "InvoiceCounter",
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
