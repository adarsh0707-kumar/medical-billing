const crypto = require("crypto");
const { passwordProblem } = require("../validators/password");

/**
 * Generates the one-time password an administrator hands to a locked-out user.
 *
 * **Unambiguous alphabet.** A temp password is transcribed — read down a phone,
 * copied off a sticky note, retyped from a screen in a dispensary. `l`/`1`/`I`
 * and `O`/`0` are the pairs that get this wrong, and a failed sign-in on a
 * mistyped reset is indistinguishable to the user from a reset that did not
 * work. Dropping six characters costs ~0.5 bits each and removes the whole
 * class of failure.
 *
 * **`crypto.randomInt`, not `Math.random` or a modulo of `randomBytes`.**
 * `Math.random` is not a CSPRNG, and `randomBytes(n) % alphabet.length` is
 * biased toward the first `256 % 56` characters. `randomInt` rejects out-of-
 * range samples internally and is uniform.
 *
 * At 16 characters over a 56-character alphabet this carries ~93 bits, which is
 * far beyond what the credential needs: it is single-use by construction, since
 * `mustChangePassword` blocks every route except the one that replaces it.
 */
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LENGTH = 16;

const draw = () =>
  Array.from(
    { length: LENGTH },
    () => ALPHABET[crypto.randomInt(ALPHABET.length)],
  ).join("");

/**
 * `context` is the same shape `passwordProblem` takes — the name and email the
 * password must not restate.
 *
 * The generated value is checked against the ordinary policy rather than
 * trusted because it came from a CSPRNG. A random draw *can* land on something
 * the policy rejects: `isSequential` catches a run like `mnopqrstuvwxyz23`, and
 * a user named after a colour could see their name surface in one. Both are
 * vanishingly rare, and neither is a reason to hand back a password the login
 * path would then refuse. Redrawing is free.
 *
 * The bound exists so a policy change that rejects every possible draw fails
 * loudly here instead of spinning forever inside a request.
 */
const generateTempPassword = (context = {}) => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = draw();
    if (!passwordProblem(candidate, context)) return candidate;
  }
  throw new Error(
    "Could not generate a temporary password satisfying the password policy. " +
      "This means the policy in validators/password.js now rejects the " +
      "generator's entire alphabet or length — one of the two has to change.",
  );
};

module.exports = { generateTempPassword, ALPHABET, LENGTH };
