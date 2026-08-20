/**
 * Blocks an account that must change its password (threat T-2, P0-1).
 *
 * The seeded bootstrap admin ships with a password published in this repository.
 * Telling an operator to change it is a hope; refusing to work until they do is a
 * control.
 *
 * Deliberately server-side. A client-side redirect would be the same class of
 * thing as hiding a nav item — it removes the screen, not the capability, and
 * anyone with curl walks straight past it.
 *
 * MUST be mounted after `protect`, which populates `req.user` with a freshly
 * reloaded record so the flag can never be stale. It is applied to every router
 * except the two routes a blocked user needs in order to get out of the state:
 * `GET /api/auth/me` and `PUT /api/auth/change-password`, which simply do not
 * mount it. Keeping the exemption in the routing rather than in a list here means
 * there is no second place for the two to drift apart.
 */
const requirePasswordChange = (req, res, next) => {
  if (!req.user?.mustChangePassword) return next();

  return res.status(403).json({
    success: false,
    // A distinct code so the client can route to the change-password screen
    // rather than showing a generic "access denied" the user cannot act on.
    code: "PASSWORD_CHANGE_REQUIRED",
    message:
      "You must change your password before using the system. Choose a new one to continue.",
  });
};

module.exports = requirePasswordChange;
