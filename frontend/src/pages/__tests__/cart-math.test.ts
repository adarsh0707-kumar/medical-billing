import { describe, it, expect } from "vitest";
import {
  calcItemTotal,
  calcCartTotals,
  divHalfUp,
  toPaise,
  type CartLine,
} from "@/lib/cart-math";

/**
 * Regression guard for G-17 — the POS cart quoted a different total than the
 * invoice the server wrote.
 *
 * The cart summed unrounded floats, while `createInvoice` rounds CGST and SGST
 * separately and builds every total from the rounded halves. On ~40% of realistic
 * inputs the two disagreed by a paisa; the smallest witness is ₹1.00 × 1 at 5% GST,
 * where the cart showed ₹1.05 and the invoice stored ₹1.06.
 *
 * The fixtures below are the acceptance set from docs/09-testing-strategy.md
 * section 4 — the same set the backend suite asserts against. If these two ever
 * disagree, one of the two rounding pipelines has drifted.
 */

const line = (
  unitPrice: number,
  quantity: number,
  discount: number,
  gstPercent: number,
): CartLine => ({ unitPrice, quantity, discount, gstPercent });

describe("cart maths — docs/09 §4 GST fixtures", () => {
  it("F1 single line, no discount", () => {
    const t = calcCartTotals([line(24.5, 10, 0, 12)], 0);
    expect(t.subtotal).toBe(245.0);
    expect(t.cgstPaise / 100).toBe(14.7);
    expect(t.sgstPaise / 100).toBe(14.7);
    expect(t.grandTotal).toBe(274.4);
  });

  it("F2 line discount", () => {
    const t = calcCartTotals([line(100.0, 3, 10, 5)], 0);
    expect(t.subtotal).toBe(270.0);
    expect(t.cgstPaise / 100).toBe(6.75);
    expect(t.sgstPaise / 100).toBe(6.75);
    expect(t.grandTotal).toBe(283.5);
  });

  it("F3 zero-rated", () => {
    const t = calcCartTotals([line(250.0, 2, 0, 0)], 0);
    expect(t.subtotal).toBe(500.0);
    expect(t.cgstPaise).toBe(0);
    expect(t.sgstPaise).toBe(0);
    expect(t.grandTotal).toBe(500.0);
  });

  it("F4 multi-line with a bill discount", () => {
    const t = calcCartTotals([line(24.5, 10, 0, 12), line(100.0, 3, 10, 5)], 50);
    expect(t.subtotal).toBe(515.0);
    expect(t.cgstPaise / 100).toBe(21.45);
    expect(t.sgstPaise / 100).toBe(21.45);
    expect(t.grandTotal).toBe(507.9);
  });

  it("F5 full line discount", () => {
    const t = calcCartTotals([line(80.0, 1, 100, 18)], 0);
    expect(t.subtotal).toBe(0);
    expect(t.cgstPaise).toBe(0);
    expect(t.grandTotal).toBe(0);
  });

  it("F6 rounding", () => {
    const t = calcCartTotals([line(33.33, 3, 0, 18)], 0);
    expect(t.subtotal).toBe(99.99);
    expect(t.cgstPaise / 100).toBe(9.0);
    expect(t.sgstPaise / 100).toBe(9.0);
    expect(t.grandTotal).toBe(117.99);
  });

  it("F7 bill discount exceeding the total goes negative, as the server does", () => {
    // Deliberately asserts today's behaviour rather than a preferred one: whether
    // this should reject or clamp to zero is undecided (docs/09 §4 F7, PRD Q1).
    // The cart's job is to show what the invoice will store, so if the server
    // starts clamping, this test should be updated alongside it — not before.
    const t = calcCartTotals([line(250.0, 2, 0, 0)], 600);
    expect(t.grandTotal).toBe(-100.0);
  });
});

describe("invariants that must hold on every cart", () => {
  const carts: Array<{ name: string; cart: CartLine[]; discount: number }> = [
    { name: "F1", cart: [line(24.5, 10, 0, 12)], discount: 0 },
    { name: "F2", cart: [line(100.0, 3, 10, 5)], discount: 0 },
    { name: "F3", cart: [line(250.0, 2, 0, 0)], discount: 0 },
    {
      name: "F4",
      cart: [line(24.5, 10, 0, 12), line(100.0, 3, 10, 5)],
      discount: 50,
    },
    { name: "F5", cart: [line(80.0, 1, 100, 18)], discount: 0 },
    { name: "F6", cart: [line(33.33, 3, 0, 18)], discount: 0 },
    {
      name: "mixed",
      cart: [
        line(1.0, 1, 0, 5),
        line(33.33, 3, 12.5, 18),
        line(999.99, 7, 33, 28),
      ],
      discount: 10,
    },
  ];

  it.each(carts)("$name — cgst === sgst (BR-03)", ({ cart, discount }) => {
    const t = calcCartTotals(cart, discount);
    expect(t.cgstPaise).toBe(t.sgstPaise);
  });

  it.each(carts)(
    "$name — subtotal + cgst + sgst - discount === total, exactly",
    ({ cart, discount }) => {
      const t = calcCartTotals(cart, discount);
      expect(t.grandTotalPaise).toBe(
        t.subtotalPaise + t.cgstPaise + t.sgstPaise - toPaise(discount),
      );
    },
  );

  it.each(carts)(
    "$name — line totals reconcile to subtotal + cgst + sgst",
    ({ cart, discount }) => {
      const t = calcCartTotals(cart, discount);
      const sumOfLines = cart.reduce(
        (s, l) => s + calcItemTotal(l).totalPaise,
        0,
      );
      expect(sumOfLines).toBe(t.subtotalPaise + t.cgstPaise + t.sgstPaise);
    },
  );

  it.each(carts)("$name — every total is a whole paisa", ({ cart, discount }) => {
    const t = calcCartTotals(cart, discount);
    for (const v of [
      t.subtotalPaise,
      t.cgstPaise,
      t.sgstPaise,
      t.grandTotalPaise,
    ])
      expect(Number.isInteger(v)).toBe(true);
  });
});

describe("G-17 regression — the specific divergences that were shipped", () => {
  it("₹1.00 × 1 at 5% GST is ₹1.06, not ₹1.05", () => {
    // The smallest witness. The old float cart computed 1.00 + 0.05 = 1.05; the
    // server rounds each half of the 5-paisa GST up to 3 paise, storing 1.06.
    const t = calcCartTotals([line(1.0, 1, 0, 5)], 0);
    expect(t.cgstPaise).toBe(3);
    expect(t.sgstPaise).toBe(3);
    expect(t.grandTotalPaise).toBe(106);
  });

  it("splits GST into two separately-rounded halves, never one rounding", () => {
    // taxable 99.99 at 18% is 17.9982; halved and rounded that is 9.00 + 9.00 =
    // 18.00, where rounding the whole would give 18.00 too — but at 5% on ₹1.00
    // the difference is a full paisa. Assert the halves, not just the total.
    const t = calcItemTotal(line(33.33, 3, 0, 18));
    expect(t.cgstPaise).toBe(900);
    expect(t.sgstPaise).toBe(900);
    expect(t.totalPaise).toBe(t.taxablePaise + t.cgstPaise + t.sgstPaise);
  });

  it("does not accumulate float error across many lines", () => {
    // 100 lines of ₹0.10 at 18%. In floats the taxable sum drifts off 10.00.
    const cart = Array.from({ length: 100 }, () => line(0.1, 1, 0, 18));
    const t = calcCartTotals(cart, 0);
    expect(t.subtotalPaise).toBe(1000);
    expect(Number.isInteger(t.grandTotalPaise)).toBe(true);
  });
});

describe("rounding primitives", () => {
  it("divHalfUp rounds halves away from zero", () => {
    expect(divHalfUp(1, 2)).toBe(1); // 0.5 -> 1
    expect(divHalfUp(3, 2)).toBe(2); // 1.5 -> 2
    expect(divHalfUp(5, 2)).toBe(3); // 2.5 -> 3, not 2 (banker's would give 2)
    expect(divHalfUp(1, 4)).toBe(0); // 0.25 -> 0
    expect(divHalfUp(3, 4)).toBe(1); // 0.75 -> 1
    expect(divHalfUp(2, 4)).toBe(1); // 0.50 -> 1
  });

  it("toPaise is exact on the 2 dp values prices actually take", () => {
    expect(toPaise(0.1)).toBe(10);
    expect(toPaise(24.5)).toBe(2450);
    expect(toPaise(33.33)).toBe(3333);
    expect(toPaise(999.99)).toBe(99999);
    // 0.1 + 0.2 !== 0.3 in floats; going through paise removes the question.
    expect(toPaise(0.1) + toPaise(0.2)).toBe(toPaise(0.3));
  });
});
