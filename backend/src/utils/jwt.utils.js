const jwt = require("jsonwebtoken");

// `tokenVersion` is the revocation counter from the user's row (FR-AUTH-09).
// `protect` compares it against the current value and rejects the token if it
// has fallen behind, so bumping the column invalidates every session that user
// has open.
//
// It defaults to 0 so a caller that has not loaded the column still produces a
// usable token for a fresh account, and so tokens minted before the column
// existed keep verifying.
const generateToken = (userId, tokenVersion = 0) => {
  return jwt.sign({ id: userId, tokenVersion }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });
};

// Written for a refresh-rotation flow that was never built; nothing calls it.
// Keep the payload in step with generateToken so it is not a trap for whoever
// does build it — a refresh token that skipped the revocation check would hand
// back access tokens for a session the user had already ended.
const generateRefreshToken = (userId, tokenVersion = 0) => {
  return jwt.sign({ id: userId, tokenVersion }, process.env.JWT_SECRET, {
    expiresIn: "30d",
  });
};

module.exports = { generateToken, generateRefreshToken };
