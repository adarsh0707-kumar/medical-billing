const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const prisma = require("./config/db");
const { httpLogger } = require("./config/logger");
const { Prisma } = require("@prisma/client");

const authRoutes = require("./routes/auth.routes");
const { errorHandler, notFound } = require("./middlewares/error.middleware");
const inventoryRoutes = require("./routes/inventory.routes");
const billingRoutes = require("./routes/billing.routes");
const customerRoutes = require("./routes/customer.routes");
const medicineRoutes = require("./routes/medicine.routes");
const supplierRoutes = require("./routes/supplier.routes");
const reportRoutes = require("./routes/report.routes");
const userRoutes = require("./routes/user.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const shopRoutes = require("./routes/shop.routes");
const auditContextMiddleware = require("./middlewares/audit-context.middleware");

/**
 * Builds the Express application.
 *
 * A factory rather than a module-level singleton so tests can mount the real
 * middleware stack without binding a port, and can dial the rate limits down to
 * exercise them deliberately. Each call gets its own limiter store, which keeps
 * one test file from spending another's budget.
 */
const createApp = ({
  rateLimitMax = Number(process.env.RATE_LIMIT_MAX) || 500,
  loginRateLimitMax = Number(process.env.LOGIN_RATE_LIMIT_MAX) || 10,
} = {}) => {
  const app = express();

  // ─── Security Middlewares ──────────────────────────────
  app.use(helmet());
  app.use(compression());
  // Structured JSON in production, pretty in development, silent under test —
  // request logs drown the assertion output. Each request carries a correlation
  // id, echoed back as X-Request-Id.
  app.use(httpLogger);

  // ─── Proxy Awareness ───────────────────────────────────
  // Nginx sets X-Real-IP and X-Forwarded-For. Without this, req.ip is the proxy's
  // container address, so every client shares one rate-limit bucket and one busy
  // dashboard can lock out the billing counter.
  //
  // Trust is restricted to private-range peers rather than `true`: port 5000 is
  // published, and a client reaching it directly must not be able to forge
  // X-Forwarded-For to dodge the limiter. Override with TRUST_PROXY when the
  // deployment topology differs.
  app.set(
    "trust proxy",
    process.env.TRUST_PROXY || "loopback, linklocal, uniquelocal",
  );

  // ─── CORS ─────────────────────────────────────────────
  // Only needed for callers that reach port 5000 directly and cross-origin. The
  // SPA no longer does: it calls /api on its own origin through nginx or the Vite
  // dev-server proxy, so its requests are same-origin and never preflighted.
  // In production the allowlist is exactly CORS_ORIGINS and nothing else — the
  // development origins are not appended, or "restrict CORS to your real origin"
  // would be impossible to actually do. The SPA is same-origin through nginx and
  // never appears here; this governs callers reaching the API directly.
  const allowedOrigins =
    process.env.NODE_ENV === "production"
      ? (process.env.CORS_ORIGINS || "")
          .split(",")
          .map((o) => o.trim())
          .filter(Boolean)
      : [
          "http://localhost", // nginx entry point on :80
          "http://localhost:3000",
          "http://localhost:5173",
          "http://127.0.0.1:5173",
          // Docker's default bridge gateway. Kept generic on purpose: a
          // container's actual address depends on which networks the daemon has
          // already created, so hard-coding the one this machine happened to get
          // fixes it for one developer and breaks it for the next. If your
          // bridge is not the default, set FRONTEND_URL rather than editing
          // this list — that is what the variable is for.
          "http://172.17.0.1:5173",
          process.env.FRONTEND_URL,
        ].filter(Boolean);

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error("Not allowed by CORS"));
        }
      },
      credentials: true,
    }),
  );

  // ─── JSON Serialisation ────────────────────────────────
  // Money columns are Decimal in the database, and Decimal.toJSON() emits a
  // string. The API contract has always been numbers and the client does
  // arithmetic on them, so unwrap at the boundary. Exactness is what matters in
  // storage and in the calculations — not in a 2 dp display value.
  // The replacer receives the post-toJSON value, so read the original off the
  // holder (`this`) to recognise a Decimal.
  app.set("json replacer", function (key, value) {
    const original = this[key];
    return Prisma.Decimal.isDecimal(original) ? original.toNumber() : value;
  });

  // ─── Body Parser ───────────────────────────────────────
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // ─── Rate Limiter ──────────────────────────────────────
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: rateLimitMax,
    message: {
      success: false,
      message: "Too many requests, please try again later.",
    },
  });
  app.use("/api", limiter);

  // Login is the one endpoint worth guessing at, and 500 requests per window is a
  // comfortable password-guessing budget. Successful sign-ins are not counted, so
  // a counter signing in and out through a shift never trips this.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: loginRateLimitMax,
    skipSuccessfulRequests: true,
    message: {
      success: false,
      message:
        "Too many failed login attempts. Please try again in 15 minutes.",
    },
  });
  app.use("/api/auth/login", loginLimiter);

  // Signup shares that budget. It is a one-shot endpoint — after the first
  // account it refuses before touching bcrypt — but *before* setup every call
  // costs a cost-12 hash, and an unclaimed installation is exactly when nobody
  // is watching. The same 10-per-window ceiling keeps that from being a way to
  // burn a fresh instance's CPU, and one honest operator needs one request.
  app.use("/api/auth/signup", loginLimiter);

  // ─── Health Check ──────────────────────────────────────
  // Liveness: is this process up? Deliberately cheap and dependency-free, so a
  // database outage does not cause an orchestrator to kill an otherwise healthy
  // process and turn a recoverable incident into a restart loop.
  app.get("/health", (req, res) => {
    res.json({
      success: true,
      message: "Medical Billing API is running!",
      timestamp: new Date().toISOString(),
    });
  });

  // Readiness: can this process actually serve a request? A 200 from /health
  // used to mean only that Express was listening — it said nothing about whether
  // the database was reachable, which is the thing that makes every route work.
  app.get("/health/ready", async (req, res) => {
    const checks = {};
    let ok = true;

    const started = Date.now();
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = { status: "up", latencyMs: Date.now() - started };
    } catch (err) {
      ok = false;
      checks.database = { status: "down", error: err.message };
    }

    // 503, not 500: this is "not ready to take traffic", which is what a load
    // balancer needs to hear in order to route around it.
    res.status(ok ? 200 : 503).json({
      success: ok,
      status: ok ? "ready" : "degraded",
      checks,
      timestamp: new Date().toISOString(),
    });
  });

  // ─── Audit context ─────────────────────────────────────
  // Opens the per-request store the Prisma audit middleware reads. Mounted here,
  // before the routers, because it has to wrap everything that might write;
  // `protect` fills in who the caller is once it knows (NFR-17).
  app.use(auditContextMiddleware);

  // ─── Routes ────────────────────────────────────────────
  app.use("/api/auth", authRoutes);
  // add after auth route
  // ─── 2.0.0 route layout ──────────────────────────────
  // Grouped by resource. Until 2.0.0 the routers were grouped by *module*, so
  // customers were reachable only at /api/billing/customers and medicines at
  // /api/inventory/medicines — the single most common source of client
  // confusion, and warned about in every document under docs/.
  app.use("/api/customers", customerRoutes);
  app.use("/api/medicines", medicineRoutes);
  app.use("/api/suppliers", supplierRoutes);
  app.use("/api/reports", reportRoutes);

  // Batches, categories and manufacturers stay here: they are stock-keeping
  // concerns rather than resources a client reasons about on its own.
  app.use("/api/inventory", inventoryRoutes);
  // Invoices, voids and credit notes. The customer and report routes it still
  // carries are deprecated aliases — see deprecate.middleware.js.
  app.use("/api/billing", billingRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/dashboard", dashboardRoutes);
  app.use("/api/shop", shopRoutes);

  // ─── Error Handlers ────────────────────────────────────
  app.use(notFound);
  app.use(errorHandler);

  return app;
};

module.exports = createApp;
