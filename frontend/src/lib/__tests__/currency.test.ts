import { describe, it, expect } from "vitest";
import { formatAxisINR } from "@/lib/currency";

/**
 * The axis formatter behind the three sales charts.
 *
 * The regression guard is the sub-₹1,000 block: every tick on the September
 * margin chart read "₹0k" while the bars had obvious height, because
 * `(245 / 1000).toFixed(0)` is `"0"`. Fixtures and busy months all ran to
 * thousands, so nothing caught it until a quiet month was looked at.
 */
describe("formatAxisINR", () => {
  // GUARD: this is the case that was broken in all three charts.
  it("shows exact rupees below a thousand, never ₹0k", () => {
    expect(formatAxisINR(245)).toBe("₹245");
    expect(formatAxisINR(999)).toBe("₹999");
    expect(formatAxisINR(1)).toBe("₹1");
  });

  it("still reads zero as zero", () => {
    expect(formatAxisINR(0)).toBe("₹0");
  });

  it("handles the negatives a margin chart can produce", () => {
    // A month whose only activity is credit notes against earlier sales runs
    // at a loss. The old formatter rendered this as "₹-0k".
    expect(formatAxisINR(-245)).toBe("₹-245");
    expect(formatAxisINR(-2450)).toBe("₹-2.5k");
  });

  it("uses thousands with one decimal, then drops it", () => {
    expect(formatAxisINR(1_000)).toBe("₹1.0k");
    expect(formatAxisINR(2_450)).toBe("₹2.5k");
    // Past ten thousand the decimal is noise on an axis label.
    expect(formatAxisINR(12_300)).toBe("₹12k");
    expect(formatAxisINR(99_900)).toBe("₹100k");
  });

  it("counts in lakhs and crores, not millions", () => {
    // The printed invoice says "one lakh twenty thousand" (amount-in-words.ts);
    // an axis reading ₹1.2M beside it would be a different counting system.
    expect(formatAxisINR(120_000)).toBe("₹1.2L");
    expect(formatAxisINR(1_500_000)).toBe("₹15L");
    expect(formatAxisINR(12_000_000)).toBe("₹1.2cr");
  });

  it("switches unit at the boundary, not near it", () => {
    expect(formatAxisINR(999)).toBe("₹999");
    expect(formatAxisINR(1_000)).toBe("₹1.0k");
    expect(formatAxisINR(99_999)).toBe("₹100k");
    expect(formatAxisINR(100_000)).toBe("₹1.0L");
    expect(formatAxisINR(9_999_999)).toBe("₹100L");
    expect(formatAxisINR(10_000_000)).toBe("₹1.0cr");
  });
});
