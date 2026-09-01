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

// SMTP, on the same principle and for the same reason (FR-AUTH-11).
//
// Self-service password reset is the only way back into an account for a
// shopkeeper who signed up themselves and has no administrator to ask. If the
// mail variables are unset, every reset request is accepted, answered
// cheerfully and delivers nothing — and because the endpoint must answer
// identically whether or not the address has an account, it cannot tell the
// caller that either. Nobody requests a password reset on a good day, so the
// misconfiguration would sit undiscovered until the day it mattered most.
//
// Production only. Development and the test suite run without a mail server on
// purpose; `sendMail` logs and returns false there, which is what lets the
// suite assert the failure path without one.
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
    console.error(
      `❌ ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set. Refusing to start.\n` +
        "\n" +
        "   Without SMTP the API still accepts password-reset requests and\n" +
        "   answers them normally — it just never sends the email, and it\n" +
        "   cannot say so without revealing which addresses have accounts.\n" +
        "   A shopkeeper who signed up themselves would have no way back in.\n" +
        "\n" +
        "   Set them in .env.prod:\n" +
        "     SMTP_HOST=smtp.example.com\n" +
        "     SMTP_PORT=587\n" +
        "     SMTP_USER=…\n" +
        "     SMTP_PASS=…\n" +
        '     SMTP_FROM="Pharmacy <noreply@example.com>"\n' +
        "\n" +
        "   See SECURITY.md and docs/06 for what each one is.",
    );
    process.exit(1);
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
