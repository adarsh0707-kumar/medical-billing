const { runWithActor } = require("../config/audit-context");

/**
 * Publishes the acting user for the rest of the request, so the Prisma audit
 * middleware can attribute writes without any controller passing an actor down.
 *
 * Mounted after `protect` on each router — `req.user` does not exist before it.
 * Writes that happen with no authenticated user (the seed script, a migration)
 * simply run outside any context and are recorded with a null actor, which is
 * the truth rather than a gap.
 */
const auditContextMiddleware = (req, res, next) => {
  runWithActor(
    {
      id: req.user?.id ?? null,
      email: req.user?.email ?? null,
      // Ties an audit row to the log lines for the same request. pino-http sets
      // this header before any route runs.
      requestId: res.getHeader("X-Request-Id") ?? null,
      // Filled in by any handler that has something to say; see setReason.
      reason: null,
    },
    next,
  );
};

module.exports = auditContextMiddleware;
