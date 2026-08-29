const pino = require("pino");
const { randomUUID } = require("crypto");

/**
 * Structured logging.
 *
 * `morgan("dev")` wrote a coloured line per request and nothing else — readable
 * at a terminal, useless anywhere a log is collected. There was no way to follow
 * one request through several lines, no way to filter by level, and no way for a
 * log processor to read a field.
 *
 * Production emits one JSON object per line. Development keeps a human-readable
 * stream via pino-pretty, because a developer reads logs with their eyes.
 */

const isProduction = process.env.NODE_ENV === "production" || "";
const isTest = process.env.NODE_ENV === "test";

const prettyTransport = () => {
  try {
    require.resolve("pino-pretty");
    return {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
    };
  } catch {
    return undefined;
  }
};

const logger = pino({
  level: process.env.LOG_LEVEL || (isTest ? "silent" : "info"),

  // Anything here would end up in a log aggregator, a support ticket or a
  // screenshot. A pharmacy's logs must not carry credentials or patient-adjacent
  // detail, so the redaction list is deliberately broad.
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.body.password",
      "req.body.currentPassword",
      "req.body.newPassword",
      "res.headers['set-cookie']",
    ],
    censor: "[redacted]",
  },

  ...(isProduction
    ? {
        formatters: {
          // `level: "info"` rather than `level: 30` — the number means nothing
          // to whoever is reading at 2am.
          level: (label) => ({ level: label }),
        },
        timestamp: pino.stdTimeFunctions.isoTime,
      }
    : {
        // Pretty output is a developer convenience, and pino-pretty is a dev
        // dependency. If it is missing — a production-style install, a partial
        // node_modules — fall back to JSON rather than refusing to start. A
        // logger must never be the reason the application is down.
        transport: prettyTransport(),
      }),
});

/**
 * The full path of a request, for the human-readable log line.
 *
 * `originalUrl`, not `url`. Express rewrites `req.url` when it dispatches into a
 * mounted router, and the message builders below run on response finish — by
 * which point the path is relative to the mount point. `/api/auth/setup-status`
 * logged as `GET /setup-status`, and a route at a router's own root logged as
 * plain `GET /`, so `GET / 401` was the entire record of a rejected request to
 * `/api/medicines`.
 *
 * The structured `req.url` field below was always correct, because pino-http
 * captures it before the rewrite — which made this worse rather than better:
 * one line carried two different paths for the same request, and the half a
 * person reads was the wrong one. Grepping the logs for an endpoint found
 * nothing.
 *
 * `deprecate.middleware.js` already uses originalUrl, for the same reason.
 */
const requestPath = (req) => req.originalUrl ?? req.url;

/**
 * Request logging with a correlation id.
 *
 * Every request gets an id, echoed back as `X-Request-Id`. When a cashier says
 * "the sale failed at about half past four", that header from their browser is
 * the thread through every log line the request produced — including the error
 * handler's.
 */
const httpLogger = require("pino-http")({
  logger,
  genReqId: (req, res) => {
    // Honour an id from the edge if there is one, so a trace survives the proxy.
    const existing = req.headers["x-request-id"];
    const id = existing || randomUUID();
    res.setHeader("X-Request-Id", id);
    return id;
  },
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    // Health probes every fifteen seconds would bury everything else.
    if (req.url === "/health" || req.url === "/health/ready") return "silent";
    return "info";
  },
  customSuccessMessage: (req, res) =>
    `${req.method} ${requestPath(req)} ${res.statusCode}`,
  customErrorMessage: (req, res, err) =>
    `${req.method} ${requestPath(req)} ${res.statusCode} — ${err.message}`,
  serializers: {
    req: (req) => ({
      id: req.id,
      method: req.method,
      url: req.url,
      // req.ip is resolved through the trust-proxy setting, so this is the real
      // client rather than the proxy's container address.
      remoteAddress: req.raw?.ip ?? req.remoteAddress,
    }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
});

module.exports = { logger, httpLogger, requestPath };
