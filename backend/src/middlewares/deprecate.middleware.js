const { logger } = require("../config/logger");

/**
 * Marks a route as a deprecated alias, from 2.0.0 until its removal in 3.1.0.
 * The removal was announced for 2.1.0; that release never shipped, because the
 * work after 2.0.0 broke clients and went out as 3.0.0 instead. Only the
 * version number moved — SUNSET below is the date clients were given.
 *
 * The 2.0.0 re-grouping moved customers, medicines and suppliers out of the
 * module-shaped paths they were buried in. Breaking every client on the day of
 * the rename is avoidable: the old paths keep working, and say so.
 *
 * Three signals, because different consumers read different ones:
 *
 * - `Deprecation: true` and `Sunset: <http-date>` — RFC 8594. A client library
 *   or gateway can surface these without anyone reading a changelog.
 * - `Link: <successor>; rel="successor-version"` — RFC 8288, names where the
 *   route went rather than only that it is going.
 * - A `warn` log carrying the request id, so an operator can find *which*
 *   client is still on the old path before it is removed. That is the one that
 *   decides whether 3.1.0 can safely drop them.
 *
 * Removal is a deliberate step in 3.1.0, not an expiry: the header is a promise
 * about intent, and nothing enforces it automatically.
 */

/**
 * The date the aliases stop working. Deliberately a constant rather than a
 * computed offset — a sunset that moves every time the server restarts tells a
 * client nothing it can plan against.
 */
const SUNSET = new Date("2026-11-30T00:00:00Z").toUTCString();

const deprecate = (successor) => (req, res, next) => {
  res.setHeader("Deprecation", "true");
  res.setHeader("Sunset", SUNSET);
  res.setHeader("Link", `<${successor}>; rel="successor-version"`);

  logger.warn(
    {
      reqId: req.id,
      deprecatedPath: req.originalUrl,
      successor,
      userId: req.user?.id,
    },
    `Deprecated route ${req.method} ${req.originalUrl} — moved to ${successor}`,
  );

  next();
};

module.exports = { deprecate, SUNSET };
