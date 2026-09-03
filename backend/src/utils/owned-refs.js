const prisma = require("../config/db");

/**
 * Checks that the foreign ids in a request body belong to the caller's shop.
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 *
 * Multi-tenancy in this codebase is enforced by putting `shopId` in the same
 * `where` as `id` on every scoped read and write ([12.4](../../../docs/05-roadmap-and-phases.md)).
 * That rule covers the row being written. It says nothing about the rows that
 * row *points at*.
 *
 * `POST /api/medicines` took `categoryId` and `manufacturerId` straight from
 * the body into `prisma.medicine.create`, and a foreign key only asks whether
 * the row exists — never whose it is. So a caller could file their medicine
 * under another shop's category, and the `include: { category: true }` on the
 * response would then read that shop's category name back to them. A small
 * leak, and a real one. `POST /api/inventory/batches` checked its `medicineId`
 * and not its `supplierId`, which is the same shape half-closed.
 *
 * Adding `Medicine.defaultSupplierId` would have made it three. One guard,
 * used everywhere a body carries a reference, is the answer that does not
 * depend on the next person remembering.
 *
 * ─── The 404 ─────────────────────────────────────────────────────────────────
 *
 * A reference to another shop's row answers exactly as a reference to a row
 * that never existed. That is the rule the rest of the API follows — a foreign
 * id is *not found*, never *forbidden* — because the alternative confirms the
 * row exists to someone who cannot see it.
 */

/**
 * Prisma delegates by name, so a caller cannot pass an arbitrary string and
 * have it reach the client. Every model here carries a `shopId` column;
 * anything that does not cannot be checked this way and is not listed.
 */
const DELEGATES = {
  category: () => prisma.category,
  manufacturer: () => prisma.manufacturer,
  supplier: () => prisma.supplier,
  medicine: () => prisma.medicine,
  customer: () => prisma.customer,
};

/**
 * Returns the label of the first reference that is not this shop's, or `null`
 * when every one of them is.
 *
 * `refs` is `[{ model, id, label }]`. Entries with no id are skipped: a body
 * that omits an optional reference is not making a claim about one. Checks run
 * in parallel — they are independent, and a create should not pay three round
 * trips in series.
 */
const findForeignRef = async (shopId, refs) => {
  const present = refs.filter((ref) => ref.id);
  if (!present.length) return null;

  const results = await Promise.all(
    present.map(async ({ model, id }) => {
      const delegate = DELEGATES[model];
      if (!delegate) {
        // A typo in a call site would otherwise pass silently, which is worse
        // than the leak this module exists to close.
        throw new Error(`owned-refs: no delegate registered for "${model}"`);
      }
      return delegate().findFirst({ where: { id, shopId }, select: { id: true } });
    }),
  );

  const missing = results.findIndex((row) => !row);
  return missing === -1 ? null : present[missing].label;
};

module.exports = { findForeignRef };
