const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const { Prisma } = require("@prisma/client");

const authRoutes = require("./routes/auth.routes");
const { errorHandler, notFound } = require("./middlewares/error.middleware");
const inventoryRoutes = require("./routes/inventory.routes");
const billingRoutes = require("./routes/billing.routes");
const userRoutes = require("./routes/user.routes");

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
  // Silent under test — request logs drown the assertion output.
  if (process.env.NODE_ENV !== "test") app.use(morgan("dev"));

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
  const allowedOrigins = [
    "http://localhost", // nginx entry point on :80
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://172.17.0.1:5173", // Docker network IP
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
      message: "Too many failed login attempts. Please try again in 15 minutes.",
    },
  });
  app.use("/api/auth/login", loginLimiter);

  // ─── Health Check ──────────────────────────────────────
  app.get("/health", (req, res) => {
    res.json({
      success: true,
      message: "Medical Billing API is running!",
      timestamp: new Date().toISOString(),
    });
  });

  // ─── Routes ────────────────────────────────────────────
  app.use("/api/auth", authRoutes);
  // add after auth route
  app.use("/api/inventory", inventoryRoutes);
  app.use("/api/billing", billingRoutes); // ← add this
  app.use("/api/users", userRoutes);

  // ─── Error Handlers ────────────────────────────────────
  app.use(notFound);
  app.use(errorHandler);

  return app;
};

module.exports = createApp;
