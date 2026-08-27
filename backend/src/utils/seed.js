const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

async function main() {
  const hashedPassword = await bcrypt.hash("admin123", 12);

  const admin = await prisma.user.upsert({
    where: { email: "admin@medstore.com" },
    update: {},
    create: {
      name: "Admin",
      email: "admin@medstore.com",
      password: hashedPassword,
      role: "ADMIN",
      // This password is published in the repository, so the account can sign in
      // and do exactly one thing: replace it. Enforced by the API, not the UI.
      mustChangePassword: true,
    },
  });

  console.log("✅ Admin user created:", admin.email);
  console.log("🔑 Password: admin123");
  console.log("⚠️  The API will refuse every other request until it is changed.");
}

// A non-zero exit on failure, which this did not have.
//
// `.catch(console.error)` printed the error and exited 0, so every caller was
// told the seed had worked. CI's "Seed the bootstrap admin" step passed green
// against a database with no schema at all, and the failure only surfaced two
// steps later as a browser test that could not sign in. A script whose whole
// job is to create one account must not report success when it created none.
//
// Matches the convention in retention.js, which already does this.
main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
