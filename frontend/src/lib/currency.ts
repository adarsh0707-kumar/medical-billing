/**
 * Compact money for a chart axis.
 *
 * ─── The bug this replaces ───────────────────────────────────────────────────
 *
 * Three charts each carried their own copy of
 * `` (v) => `₹${(v / 1000).toFixed(0)}k` ``, which is wrong below ₹1,000:
 * `245 / 1000` is `0.245`, and `.toFixed(0)` makes that `"0"`. So every tick on
 * the axis read **₹0k** while the bars above them had obvious height — reported
 * against the September margin chart, where a quiet month's takings are in the
 * hundreds. It was invisible in testing because the fixtures and the busier
 * months all ran to thousands.
 *
 * It also mangled negatives, which the margin report can genuinely produce: a
 * month whose only activity is credit notes against earlier sales runs at a
 * loss, and `-245` formatted as `₹-0k`.
 *
 * ─── Why one function rather than three fixed copies ─────────────────────────
 *
 * The three copies were identical, so the defect was identical in all three and
 * fixing one would have left two. That is the shape `utils/trend.js` exists to
 * close on the server — two blocks under a comment saying they must agree, true
 * only until somebody edits one.
 *
 * ─── Lakhs and crores, not millions ──────────────────────────────────────────
 *
 * The scale steps follow the Indian grouping the rest of the product uses:
 * `amount-in-words.ts` says "one lakh twenty thousand" on the printed invoice,
 * and an axis reading `₹1.2M` beside it would be the same number in a different
 * counting system.
 */
export function formatAxisINR(value: number): string {
  const abs = Math.abs(value);

  // Exact rupees below a thousand. This is the case the old formatter lost, and
  // it is the common one for a single shop's daily figures.
  if (abs < 1_000) return `₹${Math.round(value)}`;

  // One decimal until the unit reaches double digits, then none: `₹1.2k` is
  // worth the character, `₹12.3k` is noise on an axis label.
  const scale = (divisor: number, suffix: string) => {
    const scaled = value / divisor;
    const digits = Math.abs(scaled) >= 10 ? 0 : 1;
    return `₹${scaled.toFixed(digits)}${suffix}`;
  };

  if (abs < 100_000) return scale(1_000, "k");
  if (abs < 10_000_000) return scale(100_000, "L");
  return scale(10_000_000, "cr");
}
