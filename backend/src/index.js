const createApp = require("./app");

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

const PORT = process.env.PORT || 5000;

createApp().listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📦 Environment: ${process.env.NODE_ENV}`);
});
