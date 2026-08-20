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

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
