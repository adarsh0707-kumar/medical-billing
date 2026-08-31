const { PrismaClient } = require("@prisma/client");

const base = new PrismaClient({
  log:
    process.env.NODE_ENV === "development"
      ? ["query", "error", "warn"]
      : ["error"],
});

// Attribution for every write to master data, installed here rather than in the
// controllers so a new write path records itself without being asked (NFR-17).
const { auditExtension } = require("./audit");
const { runInTransaction } = require("./audit-context");
const { logger } = require("./logger");

// The extension is handed the *unextended* client: it is what the audit code
// falls back to when there is no transaction, and reads through it do not
// re-enter the extension, so there is no recursion to defend against.
const prisma = base.$extends(auditExtension(base));

// ─── Making the caller's transaction reachable ──────────────────────────────
//
// A Prisma `query` extension is given the operation, its arguments and a
// `query()` to run it — and no handle on the client it is running under. So an
// extension alone does not let the audit row join the caller's transaction; it
// only moves the code. This is the half that does.
//
// `$transaction(callback)` is wrapped so the callback runs inside an
// AsyncLocalStorage holding the transaction client. Anything beneath it — the
// audit extension included, four layers down — can ask for it without being
// passed it, which is the same trick `audit-context.js` already uses for the
// acting user and for the same reason: the alternative is threading a parameter
// through every controller, which is the remembering this design exists to
// remove.
//
// Assigning over `$transaction` on an extended client is verified to work on
// Prisma 5.22 (the client is a Proxy, and the property is writable). If a Prisma
// upgrade ever makes it read-only this fails loudly at boot rather than
// silently reverting to the old behaviour — but the guard that would actually
// catch it is the rollback test in `tests/audit/audit-log.test.js`, which fails
// the moment an audit row outlives the transaction it belongs to.
//
// The array form, `$transaction([...])`, is passed straight through. Prisma
// exposes no client for it, so there is nothing to capture and its audit rows
// still commit independently — unchanged behaviour, and it is used only for a
// few uncontended account writes.
const runTransaction = prisma.$transaction.bind(prisma);
prisma.$transaction = (arg, options) =>
  typeof arg === "function"
    ? runTransaction((tx) => runInTransaction(tx, () => arg(tx)), options)
    : runTransaction(arg, options);

// Test connection
prisma
  .$connect()
  .then(() => logger.info("Database connected"))
  .catch((err) => {
    logger.error({ err }, "Database connection failed");
    process.exit(1);
  });

module.exports = prisma;
