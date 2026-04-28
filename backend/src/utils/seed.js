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
    },
  });

  console.log("✅ Admin user created:", admin.email);
  console.log("🔑 Password: admin123");
  console.log("⚠️  Change this password after first login!");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
