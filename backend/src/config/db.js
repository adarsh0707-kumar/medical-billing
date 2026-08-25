const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient({
  log:
    process.env.NODE_ENV === "development"
      ? ["query", "error", "warn"]
      : ["error"],
});

// Attribution for every write to master data, installed here rather than in the
// controllers so a new write path records itself without being asked (NFR-17).
// Must be registered before any query runs.
const { auditMiddleware } = require("./audit");
const { logger } = require("./logger");
prisma.$use(auditMiddleware(prisma));

// Test connection
prisma
  .$connect()
  .then(() => logger.info("Database connected"))
  .catch((err) => {
    logger.error({ err }, "Database connection failed");
    process.exit(1);
  });

module.exports = prisma;
