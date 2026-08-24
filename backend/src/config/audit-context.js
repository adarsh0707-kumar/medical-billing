const { AsyncLocalStorage } = require("node:async_hooks");

/**
 * Carries the acting user from the request into the data layer.
 *
 * The audit middleware lives on the Prisma client, which is where it has to be
 * if a new write path cannot be allowed to forget itself — but a Prisma
 * middleware has no idea a request exists, let alone who made it. Threading the
 * actor through every controller call would put the remembering back in the
 * controllers, which is the thing being designed out.
 *
 * AsyncLocalStorage is the standard answer: the value is set once per request
 * and is visible to anything that awaits beneath it, without being passed.
 * Node's own async context tracking follows it across promises, so a write four
 * layers down inside a transaction still sees the right actor.
 *
 * Nothing outside a request has a context, and that is correct: the seed script
 * and migrations write with no actor, and their rows say so.
 */
const auditContext = new AsyncLocalStorage();

const runWithActor = (actor, fn) => auditContext.run(actor, fn);

const currentActor = () => auditContext.getStore() ?? null;

/**
 * Fills in who the caller turned out to be.
 *
 * The context has to be opened before the routers, but the actor is only known
 * once `protect` has verified the token and reloaded the user. Mutating the
 * store the request already owns keeps this to a single mount point, instead of
 * a line in every router that someone will eventually forget.
 */
const setActor = ({ id, email }) => {
  const store = auditContext.getStore();
  if (!store) return;
  store.id = id ?? null;
  store.email = email ?? null;
};

/**
 * Records why this request is writing.
 *
 * Most writes have no answer worth storing — before/after already says a price
 * became 31.75. A manual stock adjustment is the case where it does: breakage,
 * theft and a miscount produce identical before/after values and are entirely
 * different events (FR-BATCH-11).
 *
 * Set on the same per-request store as the actor, so the reason reaches the
 * Prisma middleware the same way and any future endpoint can annotate its own
 * writes without touching the middleware.
 */
const setReason = (reason) => {
  const store = auditContext.getStore();
  if (store) store.reason = reason ?? null;
};

module.exports = {
  auditContext,
  runWithActor,
  currentActor,
  setActor,
  setReason,
};
