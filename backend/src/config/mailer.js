const nodemailer = require("nodemailer");
const { logger } = require("./logger");

/**
 * The stack's first outbound dependency (FR-AUTH-11).
 *
 * ─── Why this one, when the breach check was declined ────────────────────────
 *
 * docs/07 §10 P1-6 turned down HaveIBeenPwned on the reasoning that it would be
 * the first egress from this container, a third party in the path of every
 * password change, **and that it would have to fail open** — a pharmacy must not
 * be unable to change a password because someone else's API is down. A check
 * that silently passes whenever it cannot run is weaker than its presence
 * suggests.
 *
 * That reasoning is not contradicted here, because the shape is different in
 * the way that mattered. The breach check sat *inside* a control: when it failed
 * open the password still changed, and the security property quietly evaporated
 * while every screen said it had been enforced. Mail is not inside a control —
 * it is the delivery of a reset the user asked for. When it fails, **nothing is
 * weakened**: no token is honoured, no password changes, no session ends. The
 * user simply does not receive a link, and the very next thing they do is
 * notice.
 *
 * The same entry also says to revisit once self-service signup lands. It did, on
 * 2026-08-29, and a stranger who opens a shop has no administrator to ask for a
 * reset — which is what turns FR-AUTH-11 from a convenience into the only path
 * back into an account.
 *
 * ─── What happens when the mail server is unreachable ────────────────────────
 *
 * The honest answer, in three parts, because "reset silently did nothing" is the
 * failure that will actually occur:
 *
 * 1. **Misconfiguration cannot be answered cheerfully.** While the variables
 *    are unset, `POST /api/auth/forgot-password` answers **503** and issues no
 *    token, rather than accepting a reset it can never fulfil. That closes the
 *    case that would otherwise persist for weeks, because nobody requests a
 *    password reset on a good day.
 *
 *    This was a boot guard until 2026-09-01 — the process exited in production
 *    if the variables were unset, the way it does for `JWT_SECRET` — and that
 *    was the wrong layer. It took an entire deployment down for two days:
 *    billing, inventory, the GST return and the till, none of which send mail,
 *    because one recovery path could not run. `JWT_SECRET` earns a boot guard
 *    because nothing works without it; mail does not, because everything else
 *    does.
 *
 * 2. **A send failure does not change the response.** It cannot: the request
 *    endpoint answers identically for a known and an unknown address, and any
 *    difference — a 503 here, a 200 there — would turn it into an oracle for
 *    which addresses have accounts. So a failed send is reported *only* in the
 *    log, at `error`, carrying the request id.
 *
 * 3. **That trade is real and is not hidden.** A reset that could not be sent
 *    looks exactly like one that was. The log is where an operator finds out,
 *    and SECURITY.md says so rather than leaving somebody to discover it from a
 *    user who never got their email. The alternative — telling the caller — is
 *    an account-enumeration hole, and this is the cheaper of the two costs.
 */

const REQUIRED = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"];

/** Which of the required variables are missing. Used by the boot guard. */
const missingMailConfig = () =>
  REQUIRED.filter((key) => !process.env[key]?.trim());

const isConfigured = () => missingMailConfig().length === 0;

// Built once, lazily, and only when configured. nodemailer pools connections
// itself; constructing a transport per send would open a TCP connection per
// reset request, which is the wrong shape for something behind a rate limiter
// that exists to make requests cheap to refuse.
let transport = null;
const getTransport = () => {
  if (transport) return transport;
  const port = Number(process.env.SMTP_PORT);
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    // 465 is implicit TLS; 587 and 25 start plaintext and upgrade with
    // STARTTLS. Deriving this from the port rather than asking for a second
    // variable removes a way to configure a combination that silently sends
    // credentials in the clear.
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transport;
};

/**
 * Sends, and **never throws**.
 *
 * Deliberate, and the one place in this codebase where swallowing is right: the
 * caller has already answered the request. Rejecting here would surface as an
 * unhandled rejection long after the response went out, and could not change
 * what the caller was told even if it were caught.
 *
 * Returns whether it sent, for the tests and for anything that wants to count
 * failures; nothing in the request path branches on it.
 */
const sendMail = async ({ to, subject, text, requestId }) => {
  if (!isConfigured()) {
    logger.error(
      { missing: missingMailConfig(), requestId },
      "mail: not configured, message not sent",
    );
    return false;
  }

  try {
    await getTransport().sendMail({
      from: process.env.SMTP_FROM,
      to,
      subject,
      text,
    });
    return true;
  } catch (err) {
    // The recipient is logged and the body is not. An address is needed to
    // work out who did not get their email; a reset link in a log file is a
    // credential in a log file.
    logger.error(
      { err, to, subject, requestId },
      "mail: send failed — the recipient was told nothing was wrong",
    );
    return false;
  }
};

// Exported for the test suite, which swaps in its own transport rather than
// opening a socket. `sendMail` is what production calls.
const __setTransportForTests = (t) => {
  transport = t;
};

module.exports = {
  sendMail,
  isConfigured,
  missingMailConfig,
  REQUIRED,
  __setTransportForTests,
};
