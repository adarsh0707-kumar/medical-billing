const jwt = require("jsonwebtoken");

// Access tokens are short-lived because they are the half the browser can read:
// they live in localStorage, so anything that runs script in the page can take
// one. Thirty minutes is short enough that a token captured in a log, a proxy or
// a screenshot is usually already dead, and long enough that the silent refresh
// is rare. The session as a whole still lasts a week — see below.
const ACCESS_TOKEN_TTL = "30m";

// The refresh token carries the week. It is never readable by JavaScript: it is
// set as an httpOnly cookie, which is the entire reason splitting the two is
// worth doing. Both halves in localStorage would be strictly worse than the one
// long token this replaced.
const REFRESH_TOKEN_TTL_DAYS = 7;

// `tokenVersion` is the revocation counter from the user's row. `protect`
// compares it and rejects a token that has fallen behind, so bumping the column
// invalidates every session that user has open.
const generateToken = (userId, tokenVersion = 0) =>
  jwt.sign({ id: userId, tokenVersion }, process.env.JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_TTL,
  });

// `jti` is the id of the RefreshToken row backing this session, which is what
// makes rotation and reuse detection possible: the server holds the state and
// the token is only a pointer to it.
const generateRefreshToken = (userId, tokenVersion = 0, jti) =>
  jwt.sign({ id: userId, tokenVersion, jti }, process.env.JWT_SECRET, {
    expiresIn: `${REFRESH_TOKEN_TTL_DAYS}d`,
  });

module.exports = {
  generateToken,
  generateRefreshToken,
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL_DAYS,
};
