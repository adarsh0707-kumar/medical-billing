/**
 * Cart arithmetic for the POS screen.
 *
 * The cart is quoted to the customer before the server writes the invoice, so the
 * two have to round identically — otherwise the cashier says one number and the
 * printed bill says another. Everything here mirrors the `Prisma.Decimal` pipeline
 * in `backend/src/controllers/billing.controller.js`, computed in integer paise.
 *
 * Floats are not usable for this. `taxable + gst` in floating point disagreed with
 * the invoice on roughly 40% of realistic inputs — not mainly through float drift,
 * but because the server rounds CGST and SGST *separately* and builds the line from
 * the two rounded halves. At 5% GST on ₹1.00 that is two 3-paisa halves, so the
 * invoice stores ₹1.06 where a single rounding gives ₹1.05.
 *
 * The acceptance fixtures live in `docs/09-testing-strategy.md` section 4.
 */

/** One cart line's money inputs. `CartItem` in Billing.tsx structurally satisfies this. */
export interface CartLine {
  quantity: number;
  unitPrice: number;
  discount: number;
  gstPercent: number;
}

export interface LineTotals {
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  totalPaise: number;
  /** Rupee views for display. Exact to the paisa, so the formatter never rounds. */
  taxable: number;
  gst: number;
  total: number;
}

export interface CartTotals {
  subtotalPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  grandTotalPaise: number;
  subtotal: number;
  totalGst: number;
  grandTotal: number;
}

/**
 * Rupees to whole paise. Prices reach the client from `DECIMAL(x,2)` columns, so
 * they are already 2 dp and this is exact.
 */
export const toPaise = (rupees: number) => Math.round(rupees * 100);

/**
 * `num / den` rounded half-up. Integers only, so no float error can creep in.
 *
 * Inputs are non-negative here — the API validates price and quantity positive and
 * caps discount at 100, so taxable and GST never go below zero. Half-up on
 * negatives would need `Math.sign` handling this deliberately omits.
 */
export const divHalfUp = (num: number, den: number) =>
  Math.floor((num * 2 + den) / (den * 2));

/** One line, rounded exactly the way `createInvoice` rounds it. */
export const calcItemTotal = (item: CartLine): LineTotals => {
  const unitPaise = toPaise(item.unitPrice);
  // Percentages in basis points keep the divisions exact.
  const discountBp = Math.round(item.discount * 100);
  const gstBp = Math.round(item.gstPercent * 100);

  const subtotalPaise = unitPaise * item.quantity;
  // One rounding on the discounted line, matching `money(lineSubtotal - discountVal)`.
  const taxablePaise = divHalfUp(subtotalPaise * (10000 - discountBp), 10000);
  // Each half rounded on its own, and the line built from the rounded halves.
  const cgstPaise = divHalfUp(taxablePaise * gstBp, 20000);
  const sgstPaise = cgstPaise; // identical expression server-side (BR-03)
  const totalPaise = taxablePaise + cgstPaise + sgstPaise;

  return {
    taxablePaise,
    cgstPaise,
    sgstPaise,
    totalPaise,
    taxable: taxablePaise / 100,
    gst: (cgstPaise + sgstPaise) / 100,
    total: totalPaise / 100,
  };
};

/**
 * Whole cart. Summed from the rounded line components exactly as the invoice header
 * is, so `subtotal + cgst + sgst - discount === grandTotal` holds by construction.
 *
 * A bill discount larger than the cart yields a negative total, and that is still
 * exactly what the server computes — F7 (docs/09 section 4) was settled as *reject*
 * rather than *clamp*, so neither side clamps. `POST /api/billing/invoices` refuses
 * such a bill with a 400 naming the maximum.
 *
 * So the honest negative stays here on purpose: it is what the UI needs in order to
 * recognise the state and refuse to submit, which is how the cart mirrors a server
 * that rejects. Clamping to zero here would hide it and send the request anyway.
 */
export const calcCartTotals = (
  cart: CartLine[],
  billDiscount: number,
): CartTotals => {
  let subtotalPaise = 0;
  let cgstPaise = 0;
  let sgstPaise = 0;

  for (const item of cart) {
    const line = calcItemTotal(item);
    subtotalPaise += line.taxablePaise;
    cgstPaise += line.cgstPaise;
    sgstPaise += line.sgstPaise;
  }

  const grandTotalPaise =
    subtotalPaise + cgstPaise + sgstPaise - toPaise(billDiscount);

  return {
    subtotalPaise,
    cgstPaise,
    sgstPaise,
    grandTotalPaise,
    subtotal: subtotalPaise / 100,
    totalGst: (cgstPaise + sgstPaise) / 100,
    grandTotal: grandTotalPaise / 100,
  };
};
