/**
 * Password rules (docs/07 A-4 / P1-6).
 *
 * Two decisions worth stating, because both look like omissions otherwise.
 *
 * **No character-class rules.** "One uppercase, one digit, one symbol" is the
 * reflex, and NIST SP 800-63B and the NCSC both advise against it: it buys
 * little entropy and pushes people to predictable shapes — `Password1!`,
 * `Medstore@2026` — which are exactly what a cracking dictionary contains. The
 * length floor moved from 8 to 12 instead, which is worth far more.
 *
 * **No breach-corpus lookup.** HaveIBeenPwned's k-anonymity range API is the
 * standard answer and it never sends the password anywhere, but it would be this
 * stack's first outbound dependency. That means egress from the backend
 * container, a third party in the path of every password change, and either a
 * network call in CI or a mock that proves nothing. It also has to fail open —
 * a pharmacy must not be unable to change a password because an API is down —
 * and a check that silently passes whenever it cannot run is weaker than it
 * reads.
 *
 * A local blocklist catches what actually threatens this system: an operator
 * picking `admin123`, `pharmacy2026` or the seeded credential that is published
 * in this repository. It is not a substitute for a breach corpus and does not
 * pretend to be. If the shop ever wants one, the note in docs/07 P1-6 records
 * what adding it costs.
 */

const MIN_LENGTH = 12;
// bcrypt hashes at most 72 bytes; anything beyond is silently ignored, so a
// longer value is not more secure and a bound keeps absurd input out of hashing.
const MAX_LENGTH = 200;

// The shapes that actually turn up, plus the ones this repository publishes.
// Deliberately short and readable rather than a bundled corpus — see above.
const BLOCKLIST = new Set(
  [
    "password",
    "password1",
    "password123",
    "passw0rd",
    "123456",
    "12345678",
    "123456789",
    "1234567890",
    "qwerty",
    "qwerty123",
    "letmein",
    "welcome",
    "welcome1",
    "admin",
    "admin1",
    "admin123",
    "administrator",
    "iloveyou",
    "monkey",
    "dragon",
    "sunshine",
    "princess",
    "football",
    "abc123",
    "changeme",
    "secret",
    "trustno1",
    "medical",
    "pharmacy",
    "medstore",
    "pharmacy123",
    "medstore123",
    "medicalbilling",
  ].map((p) => p.toLowerCase()),
);

// Checked by *containment*, unlike the blocklist above, which matches exactly.
// These two strings are printed in README.md, seed.js and half of docs/, so they
// are the first thing anyone targeting this system will try — and padding one
// out to reach a length floor (`admin123admin123`) is exactly the shortcut a
// hurried operator takes. Kept deliberately tiny: containment on a general
// blocklist would reject "my-passwords-are-long" for containing "password".
const PUBLISHED_CREDENTIALS = ["admin123", "admin@medstore.com"];

const normalise = (value) => value.trim().toLowerCase();

// "aaaaaaaaaaaa" and "123456789012" clear a length floor while carrying almost
// no entropy.
const isSingleRepeatedCharacter = (value) => /^(.)\1+$/.test(value);

const isSequential = (value) => {
  const seqs = "abcdefghijklmnopqrstuvwxyz0123456789";
  const lower = value.toLowerCase();
  if (lower.length < 4) return false;
  for (let i = 0; i + lower.length <= seqs.length; i++) {
    if (seqs.slice(i, i + lower.length) === lower) return true;
  }
  return false;
};

/**
 * Returns the first problem with a password, or null if it is acceptable.
 *
 * `context` carries the identity fields a password must not simply restate.
 * Callers pass what they have: the create-user body knows the name and email,
 * while change-password only learns them from the authenticated session.
 */
const passwordProblem = (value, context = {}) => {
  if (typeof value !== "string" || value.length < MIN_LENGTH) {
    return `Password must be at least ${MIN_LENGTH} characters`;
  }
  if (value.length > MAX_LENGTH) {
    return `Password must be at most ${MAX_LENGTH} characters`;
  }

  const candidate = normalise(value);

  // Check the stem as well as the whole string. Appending a year or a couple of
  // digits is the single most common way a weak password is stretched to clear a
  // length rule — `password1234`, `pharmacy2026`, `medstore@2026` — and an
  // exact-match list lets every one of them through while blocking the base word
  // it was built from. Cracking dictionaries apply the same mutation, so the
  // list has to see past it.
  //
  // False positives stay unlikely because the *stem* must itself be an exact
  // entry: "correct horse battery staple" reduces to itself and is fine.
  const stem = candidate.replace(/[^a-z]+$/, "");
  if (BLOCKLIST.has(candidate) || (stem.length >= 4 && BLOCKLIST.has(stem))) {
    return "That password is too close to one of the most commonly used ones. Choose something else";
  }
  if (isSingleRepeatedCharacter(value) || isSequential(value)) {
    return "That password is too predictable. Choose something else";
  }
  if (PUBLISHED_CREDENTIALS.some((c) => candidate.includes(c))) {
    return "That password is published in this project's documentation. Choose something else";
  }

  // A password that is the account's own email or name is guessable by anyone
  // who can see the user list — which is every administrator.
  for (const field of ["email", "name"]) {
    const raw = context[field];
    if (!raw) continue;
    const identity = normalise(String(raw).split("@")[0]);
    if (identity.length >= 3 && candidate.includes(identity)) {
      return `Password must not contain your ${field === "email" ? "email address" : "name"}`;
    }
  }

  return null;
};

module.exports = {
  passwordProblem,
  MIN_LENGTH,
  MAX_LENGTH,
  BLOCKLIST,
};
