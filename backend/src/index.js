const createApp = require("./app");
const { logger } = require("./config/logger");

// JWT_SECRET is read only at the moment a token is signed or verified, so an
// unset value used to let the process start perfectly cleanly and then answer
// 401 "Invalid token." to every request: `jsonwebtoken` classifies a missing
// secret as a JsonWebTokenError, which is the same class it raises for a forged
// one. An operator reading that spends the outage looking at authentication
// while the actual fault is a variable nobody set (D-15).
//
// So it is checked here, at the one point where the message can name the cause.
// Deliberately not inside createApp(): the test suite builds the app directly
// and mints its own tokens, and a guard there would make every suite depend on
// process state rather than on its fixtures.
//
// KEEP THIS BELOW require("./app"). Nothing in this codebase calls
// dotenv.config(), but requiring @prisma/client loads backend/.env into
// process.env as a side effect — which is the only reason a non-Docker run picks
// JWT_SECRET up at all. Hoisting this check above the require would read
// process.env too early and refuse to start a correctly configured machine.
//
// The check itself is synchronous, so it still resolves before the database
// connection promise settles and the error is never interleaved with a connect
// banner.
if (!process.env.JWT_SECRET?.trim()) {
  console.error(
    "❌ JWT_SECRET is not set. Refusing to start.\n" +
      "\n" +
      "   Without it the API cannot sign or verify a session, and every\n" +
      "   authenticated request would fail as though the caller's token were\n" +
      "   invalid.\n" +
      "\n" +
      "   Generate one:\n" +
      "     openssl rand -hex 32\n" +
      "\n" +
      "   Under docker compose, put it in the root .env — compose interpolates\n" +
      "   it into this container:\n" +
      '     echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env\n' +
      "\n" +
      "   Running directly, put it in backend/.env or export it:\n" +
      '     echo "JWT_SECRET=$(openssl rand -hex 32)" >> backend/.env\n' +
      "\n" +
      "   Rotating it invalidates every existing session — see SECURITY.md.",
  );
  process.exit(1);
}

// SMTP (FR-AUTH-11).
//
// This refused to start until 2026-09-01, on the reasoning below: without mail,
// every reset request is accepted, answered cheerfully and delivers nothing,
// and because the endpoint must answer identically whether or not the address
// has an account it cannot say so either. Nobody requests a reset on a good
// day, so the misconfiguration would sit undiscovered until the day it
// mattered most.
//
// That reasoning was right about the failure and wrong about the remedy, and
// the cost was paid in production: the container exited at boot on every
// deploy for two days. Billing, inventory, the GST return and the till were
// down — none of which needs a mail server — because one recovery path could
// not run. Worse, the symptom was invisible from outside: the old build kept
// serving, so the API simply appeared to be several commits behind, and every
// missing route looked like a route nobody had written.
//
// A secondary feature must not hold the primary product hostage. The
// requirement — never accept a reset the deployment cannot deliver — is met at
// the endpoint instead, which answers 503 while mail is unconfigured. That is
// the same refusal, scoped to the thing that is actually broken.
//
// Production only: development and the test suite run without a mail server on
// purpose, and `sendMail` logs and returns false there.
if (process.env.NODE_ENV === "production") {
  const { missingMailConfig } = require("./config/mailer");
  // APP_URL rides with them rather than living in the mailer: sending does not
  // need it, but a *reset* does. Without it the link is built against an empty
  // origin and arrives as a relative path — an email that looks right and goes
  // nowhere, which is worse than one that never came.
  const missing = [
    ...missingMailConfig(),
    ...(process.env.APP_URL?.trim() ? [] : ["APP_URL"]),
  ];
  if (missing.length) {
    // Loud, and on stderr as well as the log: this is a real hole in a
    // production deployment, and the only thing louder than this was refusing
    // to serve at all.
    console.error(
      `⚠ ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set. Password reset is DISABLED.\n` +
        "\n" +
        "   The API is starting anyway — billing, inventory and reporting do\n" +
        "   not need a mail server. POST /api/auth/forgot-password answers 503\n" +
        "   until these are set, so nobody is told a link is on its way that\n" +
        "   this deployment cannot send. A user locked out meanwhile needs an\n" +
        "   administrator to reset their password for them.\n" +
        "\n" +
        "   Set them in .env.prod, or in the host's environment:\n" +
        "     SMTP_HOST=smtp.example.com\n" +
        "     SMTP_PORT=587\n" +
        "     SMTP_USER=…\n" +
        "     SMTP_PASS=…\n" +
        '     SMTP_FROM="Pharmacy <noreply@example.com>"\n' +
        "     APP_URL=https://your-pharmacy.example.com\n" +
        "\n" +
        "   See SECURITY.md and docs/06 for what each one is.",
    );
    logger.warn(
      { missing },
      "password reset disabled: mail is not configured",
    );
  }
}

const PORT = process.env.PORT || 5000;

createApp().listen(PORT, () => {
  // Through pino rather than stdout: these are the first two lines in any log
  // aggregator, and a bare console.log arrives there unstructured and unlevelled
  // while every other line is JSON.
  logger.info(
    { port: PORT, env: process.env.NODE_ENV },
    `Server listening on port ${PORT}`,
  );
});
