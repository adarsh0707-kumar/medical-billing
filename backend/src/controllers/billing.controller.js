const prisma = require("../config/db");
const { toCsv, sendCsv } = require("../utils/csv");
const { Prisma } = require("@prisma/client");
const {
  generateInvoiceNumber,
  generateCreditNoteNumber,
  isDuplicateNumber,
} = require("../utils/invoice.utils");
const { trendForDays, bucketedSales } = require("../utils/trend");

// Thrown from inside the invoice transaction when a batch can no longer cover
// the requested quantity at the moment of deduction. Rolls the transaction back
// and carries the status code to report to the client.
class StockConflictError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "StockConflictError";
    this.statusCode = statusCode;
  }
}

const D = Prisma.Decimal;

// Every currency value that reaches the database is an exact Decimal rounded
// to 2 dp, half-up. Rounding once per line and summing the *rounded* values is
// what makes an invoice reconcile: the printed lines add up to the printed
// total, and the monthly GST report adds up to the sum of the invoices. The
// old float pipeline rounded lines for display but accumulated the unrounded
// binary error into the header, so the two could disagree by a paisa.
const money = (v) => new D(v).toDecimalPlaces(2, D.ROUND_HALF_UP);

// Serials come from an atomic per-day counter (see generateInvoiceNumber), so
// concurrent checkouts cannot derive the same one and this loop should never run
// twice. It stays as a backstop against a collision from outside that path — a
// restored backup, a hand-inserted row — where one more attempt is cheaper than
// failing a sale the customer has already paid for.
const MAX_INVOICE_NUMBER_ATTEMPTS = 5;

// ─── Create Invoice ────────────────────────────────────
const createInvoice = async (req, res, next) => {
  try {
    const {
      customerId,
      items,
      prescription,
      discountAmt = 0,
      paymentMode,
      paymentStatus,
      notes,
    } = req.body;

    // A medicine is good *through* the date printed on it, so a batch expiring
    // today still sells and one that expired yesterday does not. Local midnight,
    // not UTC and not `now()`: the store's day is what a shopkeeper means by
    // "today", and comparing against the current instant would make a batch
    // stop being sellable partway through its own last day.
    //
    // Derived once, from an immutable source. The daily summary draws its
    // boundaries the same way.
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    // Step 1 — Verify stock availability and expiry for all items.
    // Advisory only: it fails fast with a friendly message before any work is
    // done, but the authoritative checks are the guarded decrement in Step 3.
    // Collected while walking the lines, so the Schedule H check below can name
    // exactly which medicines forced the requirement.
    const scheduledH = [];

    for (const item of items) {
      const batch = await prisma.batch.findFirst({
        where: { id: item.batchId, shopId: req.user.shopId },
        // Resolved through the batch, never from `item.medicineId`. That field
        // is validated but not persisted, so a caller could otherwise pair a
        // Schedule H batch with a harmless medicineId and walk past the
        // prescription requirement entirely.
        include: { medicine: { select: { name: true, isScheduledH: true } } },
      });
      if (!batch) {
        return res.status(404).json({
          success: false,
          message: `Batch not found for ${item.medicineName}`,
        });
      }
      if (batch.expiryDate < startOfToday) {
        // No role can override this, deliberately — see FR-BATCH-09. Selling
        // expired medicine is not a permission an administrator should hold;
        // taking it off the shelf is a write-off (FR-BATCH-11), not a sale.
        return res.status(400).json({
          success: false,
          message: `${item.medicineName} (batch ${batch.batchNumber}) expired on ${batch.expiryDate.toISOString().slice(0, 10)} and cannot be sold. Remove it from stock.`,
        });
      }
      if (batch.quantity < item.quantity) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for ${item.medicineName}. Available: ${batch.quantity}`,
        });
      }
      if (batch.medicine?.isScheduledH) scheduledH.push(batch.medicine.name);
    }

    // A Schedule H drug may only be supplied against a registered
    // practitioner's prescription, and the pharmacy has to be able to show the
    // particulars afterwards (FR-MED-12). Until now the flag was displayed and
    // enforced nowhere.
    //
    // Checked here rather than inside the transaction, unlike stock and expiry.
    // Those two guard against a race — the world changing between the check and
    // the commit. This is a statement about the request itself, which cannot
    // change underneath us, so the transaction buys nothing.
    if (scheduledH.length && !prescription) {
      return res.status(400).json({
        success: false,
        message: `A prescription is required: ${[...new Set(scheduledH)].join(", ")} ${scheduledH.length > 1 ? "are" : "is"} Schedule H.`,
        errors: [
          {
            field: "prescription",
            message:
              "Record the prescriber, their registration number, the prescription date and the patient's name.",
          },
        ],
      });
    }

    // Step 2 — Calculate totals
    let subtotal = new D(0);
    let totalCgst = new D(0);
    let totalSgst = new D(0);

    const processedItems = items.map((item) => {
      // Round the unit price first so the stored price times the quantity
      // always reproduces the line — a printed invoice has to add up.
      const unitPrice = money(item.unitPrice);
      const lineSubtotal = unitPrice.times(item.quantity);
      const discountVal = lineSubtotal.times(item.discount).dividedBy(100);
      const taxableAmt = money(lineSubtotal.minus(discountVal));
      const gstAmt = taxableAmt.times(item.gstPercent).dividedBy(100);

      // CGST and SGST are rounded separately and the line total is built from
      // the rounded halves, so a line always equals taxable + cgst + sgst.
      const cgst = money(gstAmt.dividedBy(2));
      const sgst = money(gstAmt.dividedBy(2));

      subtotal = subtotal.plus(taxableAmt);
      totalCgst = totalCgst.plus(cgst);
      totalSgst = totalSgst.plus(sgst);

      return {
        batchId: item.batchId,
        medicineName: item.medicineName,
        quantity: item.quantity,
        unitPrice,
        discount: new D(item.discount),
        gstPercent: new D(item.gstPercent),
        totalPrice: taxableAmt.plus(cgst).plus(sgst),
      };
    });

    // Derived from the same rounded components the lines carry, so
    // totalAmount === subtotal + cgst + sgst - discountAmt holds exactly.
    const billDiscount = money(discountAmt);
    const totalAmount = subtotal
      .plus(totalCgst)
      .plus(totalSgst)
      .minus(billDiscount);

    // F7 (docs/09 section 4): a bill discount larger than the bill is refused,
    // not clamped.
    //
    // Clamping was the other candidate and is worse in every direction. Clamping
    // the total breaks invariant I-4 — subtotal + cgst + sgst - discountAmt would
    // no longer equal totalAmount, and that reconciliation is the guarantee every
    // fixture asserts. Clamping the discount instead stores a figure the operator
    // never typed. And a negative sale would be a second, undocumented way to
    // move money back to a customer, when the credit note already is one.
    //
    // Checked here rather than in Zod: the limit is the computed bill, so a
    // validator would need its own copy of the tax arithmetic. Two
    // implementations of that is what G-17 cost us.
    if (totalAmount.isNegative()) {
      const billTotal = subtotal.plus(totalCgst).plus(totalSgst);
      return res.status(400).json({
        success: false,
        message: `Discount of ${billDiscount.toFixed(2)} is more than the bill total of ${billTotal.toFixed(2)}.`,
        errors: [
          {
            field: "discountAmt",
            message: `discountAmt must be at most ${billTotal.toFixed(2)}`,
          },
        ],
      });
    }

    // Step 3 — Create invoice + deduct stock in a transaction.
    // The serial is allocated inside that transaction from an atomic per-day
    // counter, so concurrent checkouts each get a distinct number and a rolled
    // back sale returns its own rather than leaving a gap in a tax document.
    // The unique index and the retry below are a backstop, not the mechanism.
    let invoice;
    for (let attempt = 1; ; attempt++) {
      try {
        invoice = await prisma.$transaction(async (tx) => {
          const invoiceNumber = await generateInvoiceNumber(
            tx,
            req.user.shopId,
          );

          const newInvoice = await tx.invoice.create({
            data: {
              shopId: req.user.shopId,
              invoiceNumber,
              customerId: customerId || null,
              userId: req.user.id,
              subtotal,
              discountAmt: billDiscount,
              cgst: totalCgst,
              sgst: totalSgst,
              totalAmount,
              paymentMode,
              paymentStatus,
              notes,
              items: { create: processedItems },
              // Written in the same transaction as the sale it belongs to: a
              // Schedule H invoice without its register entry is exactly the
              // gap this closes, so the two cannot come apart.
              //
              // Recorded whenever supplied, even if no line turned out to need
              // it — a pharmacist who logged a prescription meant to.
              ...(prescription && { prescription: { create: prescription } }),
            },
            include: {
              items: true,
              customer: true,
              prescription: true,
              user: { select: { name: true } },
            },
          });

          // Deduct stock from each batch. The quantity guard in the where clause
          // makes check-and-decrement a single atomic statement, so two concurrent
          // invoices can never both claim the same units — the loser matches zero
          // rows and rolls the whole invoice back.
          for (const item of items) {
            const { count } = await tx.batch.updateMany({
              where: {
                id: item.batchId,
                shopId: req.user.shopId,
                quantity: { gte: item.quantity },
                // Expiry joins the same atomic statement as the quantity guard,
                // for the reason G-09 gives about stock: a check made before the
                // transaction is a statement about the past. A batch can expire
                // between the cart being built and the sale committing — over a
                // midnight, or on a till left open — and the only check that
                // cannot be overtaken is the one in the write itself
                // (FR-BATCH-09).
                expiryDate: { gte: startOfToday },
              },
              data: { quantity: { decrement: item.quantity } },
            });

            if (count === 0) {
              // Zero rows means one of three things. Re-read to say which,
              // because "insufficient stock" and "this is expired" send the
              // operator to completely different actions.
              const batch = await tx.batch.findUnique({
                where: { id: item.batchId },
                select: { quantity: true, expiryDate: true, batchNumber: true },
              });
              if (!batch) {
                throw new StockConflictError(
                  `Batch not found for ${item.medicineName}`,
                  404,
                );
              }
              if (batch.expiryDate < startOfToday) {
                throw new StockConflictError(
                  `${item.medicineName} (batch ${batch.batchNumber}) expired on ${batch.expiryDate.toISOString().slice(0, 10)} and cannot be sold. Remove it from stock.`,
                );
              }
              throw new StockConflictError(
                `Insufficient stock for ${item.medicineName}. Available: ${batch.quantity}`,
              );
            }
          }

          return newInvoice;
        });
        break;
      } catch (err) {
        if (
          isDuplicateNumber(err, "invoiceNumber") &&
          attempt < MAX_INVOICE_NUMBER_ATTEMPTS
        ) {
          continue;
        }
        throw err;
      }
    }

    res.status(201).json({
      success: true,
      message: "Invoice created successfully",
      data: invoice,
    });
  } catch (err) {
    if (err instanceof StockConflictError) {
      return res
        .status(err.statusCode)
        .json({ success: false, message: err.message });
    }
    next(err);
  }
};

// ─── Void an invoice ───────────────────────────────────
// Issues a credit note reversing a sale, and returns its units to the batches
// they came from. FR-BILL-17 / G-15; policy settled as PRD Q3 on 2026-08-20.
//
// A void is not an edit. The original keeps every figure it was issued with —
// its number, its date, its totals, its lines — and only its `status` moves to
// CANCELLED. A tax period that has been filed must still reconcile to what was
// filed, so the correction is a separate dated document rather than a rewrite.
// That is also why the GST report is left including the original: the credit
// note lands in the month the void happened, and the two net to zero across
// periods. Removing the original from its own month would be the bug.
const voidInvoice = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason, items: requested } = req.body;

    const original = await prisma.invoice.findFirst({
      where: { id, shopId: req.user.shopId },
      include: { items: true },
    });

    if (!original) {
      return res
        .status(404)
        .json({ success: false, message: "Invoice not found." });
    }
    if (original.type === "CREDIT_NOTE") {
      return res.status(400).json({
        success: false,
        message: "A credit note cannot itself be voided.",
      });
    }
    if (original.status === "CANCELLED") {
      return res.status(409).json({
        success: false,
        message: "This invoice has already been voided.",
      });
    }

    // What is still returnable on each line. `quantity` never changes — invoices
    // are append-only — so this is stable; `returnedQty` is what moves.
    const outstanding = new Map(
      original.items.map((i) => [i.id, i.quantity - i.returnedQty]),
    );

    // Absent `items` means "everything still outstanding", which is exactly what
    // this endpoint did before partial returns existed.
    let returns;
    if (!requested) {
      returns = original.items
        .filter((i) => outstanding.get(i.id) > 0)
        .map((i) => ({ item: i, quantity: outstanding.get(i.id) }));
      if (!returns.length) {
        return res.status(409).json({
          success: false,
          message: "Every line on this invoice has already been returned.",
        });
      }
    } else {
      const byId = new Map(original.items.map((i) => [i.id, i]));
      const seen = new Set();
      returns = [];
      for (const line of requested) {
        const item = byId.get(line.invoiceItemId);
        if (!item) {
          return res.status(400).json({
            success: false,
            message: `Line ${line.invoiceItemId} is not on invoice ${original.invoiceNumber}.`,
          });
        }
        if (seen.has(item.id)) {
          return res.status(400).json({
            success: false,
            message: `Line ${item.medicineName} is listed twice. Combine it into one quantity.`,
          });
        }
        seen.add(item.id);
        const left = outstanding.get(item.id);
        if (line.quantity > left) {
          return res.status(400).json({
            success: false,
            message: `Cannot return ${line.quantity} of ${item.medicineName}: ${left} of ${item.quantity} still outstanding.`,
          });
        }
        returns.push({ item, quantity: line.quantity });
      }
    }

    // Money for the returned units only, through the same pipeline the sale used
    // — round each line, round the two GST halves separately, and build the
    // header from the rounded parts. Anything else and the credit note would not
    // reconcile with the invoice it reverses.
    let subtotal = new D(0);
    let totalCgst = new D(0);
    let totalSgst = new D(0);
    const creditLines = returns.map(({ item, quantity }) => {
      const lineSubtotal = item.unitPrice.times(quantity);
      const discountVal = lineSubtotal.times(item.discount).dividedBy(100);
      const taxableAmt = money(lineSubtotal.minus(discountVal));
      const gstAmt = taxableAmt.times(item.gstPercent).dividedBy(100);
      const cgst = money(gstAmt.dividedBy(2));
      const sgst = money(gstAmt.dividedBy(2));

      subtotal = subtotal.plus(taxableAmt);
      totalCgst = totalCgst.plus(cgst);
      totalSgst = totalSgst.plus(sgst);

      return {
        batchId: item.batchId,
        medicineName: item.medicineName,
        quantity,
        unitPrice: item.unitPrice,
        discount: item.discount,
        gstPercent: item.gstPercent,
        totalPrice: taxableAmt.plus(cgst).plus(sgst).negated(),
      };
    });

    const { creditNote, completes } = await prisma.$transaction(async (tx) => {
      // THE GUARD. One conditional statement per line: increment only while the
      // running total leaves room. Two simultaneous returns of the same units
      // cannot both match — the loser affects zero rows and takes the whole
      // transaction down with it, so no stock is restored twice and no second
      // credit note is written.
      //
      // Same shape as the stock decrement in G-09, and for the same reason: a
      // read, a check and a write are three things, and only one statement is
      // atomic.
      for (const { item, quantity } of returns) {
        const { count } = await tx.invoiceItem.updateMany({
          where: {
            id: item.id,
            returnedQty: { lte: item.quantity - quantity },
          },
          data: { returnedQty: { increment: quantity } },
        });
        if (count === 0) {
          throw new StockConflictError(
            `${item.medicineName} was returned by someone else while this was in progress. Nothing has been changed — check the invoice and try again.`,
            409,
          );
        }
      }

      // Units go back to the batch they came from, keeping its expiry and batch
      // number (PRD Q3). Unconditional: there is no ceiling to race against, and
      // the guard above already ensures this runs once per unit.
      for (const { item, quantity } of returns) {
        await tx.batch.update({
          where: { id: item.batchId },
          data: { quantity: { increment: quantity } },
        });
      }

      // Whether this return finishes the invoice can only be decided HERE, and
      // this is the second half of the guard.
      //
      // Deciding it from `original.items` — read before the transaction opened —
      // is a read-then-decide race: four concurrent single-unit returns of a
      // four-unit line every one of them read `returnedQty: 0`, every one of them
      // concluded "0 + 1 is not 4, so I am not the last", and the invoice was
      // left ACTIVE with nothing outstanding. Measured, not theorised.
      //
      // Reading back inside the transaction, after the increments, is correct
      // because the conditional update above has already serialised every writer
      // on these rows: this statement takes a fresh READ COMMITTED snapshot, so
      // it sees its own increment plus every increment that has committed. The
      // transaction that increments last is therefore the only one that sees a
      // fully returned invoice, and exactly one of them flips the status.
      const settled = await tx.invoiceItem.findMany({
        where: { invoiceId: original.id },
        select: { quantity: true, returnedQty: true },
      });
      const completes = settled.every((i) => i.returnedQty === i.quantity);

      // The bill-level discount is apportioned by value, except on the return
      // that completes the invoice, which gets whatever is left. Pro-rating alone
      // would leave the credit notes a paisa short or over after rounding; this
      // way the credits sum to exactly the original.
      //
      // Inside the transaction for the same reason as `completes`: the sum of
      // what has already been credited is only trustworthy once this return's
      // place in the order is fixed. Read outside, two concurrent partials both
      // see zero credited and both pro-rate against the full discount.
      const priorCredits = await tx.invoice.aggregate({
        where: { reversesId: original.id, type: "CREDIT_NOTE" },
        _sum: { discountAmt: true },
      });
      const creditedSoFar = (
        priorCredits._sum.discountAmt ?? new D(0)
      ).negated();
      let discountToCredit;
      if (completes) {
        discountToCredit = original.discountAmt.minus(creditedSoFar);
      } else if (original.subtotal.isZero()) {
        discountToCredit = new D(0);
      } else {
        discountToCredit = money(
          original.discountAmt.times(subtotal).dividedBy(original.subtotal),
        );
        const room = original.discountAmt.minus(creditedSoFar);
        if (discountToCredit.greaterThan(room)) discountToCredit = room;
      }

      const totalAmount = subtotal
        .plus(totalCgst)
        .plus(totalSgst)
        .minus(discountToCredit);

      // Only once nothing is outstanding. A partially returned invoice is still
      // a live sale for the part the customer kept.
      if (completes) {
        await tx.invoice.updateMany({
          where: { id: original.id, status: "ACTIVE" },
          data: { status: "CANCELLED" },
        });
      }

      const number = await generateCreditNoteNumber(tx, req.user.shopId);

      const created = await tx.invoice.create({
        data: {
          shopId: req.user.shopId,
          invoiceNumber: number,
          type: "CREDIT_NOTE",
          status: "ACTIVE",
          reversesId: original.id,
          customerId: original.customerId,
          userId: req.user.id,
          subtotal: subtotal.negated(),
          discountAmt: discountToCredit.negated(),
          cgst: totalCgst.negated(),
          sgst: totalSgst.negated(),
          totalAmount: totalAmount.negated(),
          paymentMode: original.paymentMode,
          paymentStatus: original.paymentStatus,
          notes: `${completes ? "Reverses" : "Partial return against"} ${original.invoiceNumber}: ${reason}`,
          items: { create: creditLines },
        },
        include: {
          items: true,
          customer: true,
          user: { select: { name: true } },
        },
      });

      return { creditNote: created, completes };
    });

    res.status(201).json({
      success: true,
      message: completes
        ? `Invoice ${original.invoiceNumber} voided. Credit note ${creditNote.invoiceNumber} issued.`
        : `Partial return against ${original.invoiceNumber}. Credit note ${creditNote.invoiceNumber} issued.`,
      data: creditNote,
    });
  } catch (err) {
    if (err instanceof StockConflictError) {
      return res
        .status(err.statusCode)
        .json({ success: false, message: err.message });
    }
    next(err);
  }
};

// ─── Get All Invoices ──────────────────────────────────
const getAll = async (req, res, next) => {
  try {
    // Parsed, coerced and bounded by validateQuery — the defaults live in the
    // schema, so nothing here needs a fallback.
    const {
      page,
      limit,
      search,
      startDate,
      endDate,
      paymentMode,
      paymentStatus,
    } = req.validatedQuery;
    const skip = (page - 1) * limit;

    const where = {
      shopId: req.user.shopId,
      ...(search && {
        OR: [
          { invoiceNumber: { contains: search, mode: "insensitive" } },
          { customer: { name: { contains: search, mode: "insensitive" } } },
        ],
      }),
      ...(startDate && endDate && { date: { gte: startDate, lte: endDate } }),
      ...(paymentMode && { paymentMode }),
      ...(paymentStatus && { paymentStatus }),
    };

    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        skip,
        take: limit,
        orderBy: { date: "desc" },
        include: {
          customer: {
            select: {
              id: true,
              name: true,
              phone: true,
              age: true,
              gender: true,
              address: true,
            },
          },
          user: { select: { name: true } },
          _count: { select: { items: true } },
        },
      }),
      prisma.invoice.count({ where }),
    ]);

    res.json({
      success: true,
      data: invoices,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── Get Single Invoice (for printing) ────────────────
const getOne = async (req, res, next) => {
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, shopId: req.user.shopId },
      include: {
        items: {
          include: {
            batch: { select: { batchNumber: true, expiryDate: true } },
          },
        },
        customer: true,
        user: { select: { name: true } },
      },
    });
    if (!invoice)
      return res
        .status(404)
        .json({ success: false, message: "Invoice not found" });
    res.json({ success: true, data: invoice });
  } catch (err) {
    next(err);
  }
};

// ─── Daily Summary ─────────────────────────────────────
/**
 * The day's figures, shared by the screen and the CSV export.
 *
 * One source deliberately: docs/09 section 4 treats these totals as a contract,
 * and a second query written to serve the export would be free to disagree with
 * the screen the moment either changed.
 */
/**
 * The figures every period report prints: what was billed, what was reversed,
 * the money net of reversals, the tax, and the split by payment mode.
 *
 * A period is a date range and nothing else, so the day, the month and the year
 * compute their headline the same way by construction. Extracted when the
 * monthly and yearly reports landed (FR-RPT-10, FR-RPT-11) — copying it per
 * period is exactly how the daily summary and the trend chart came to disagree
 * about the same sale, which is the defect `utils/trend.js` exists to close.
 */
const summaryForPeriod = async (period) => {
  const totalStats = await prisma.invoice.aggregate({
    where: period,
    _sum: { totalAmount: true, cgst: true, sgst: true },
  });

  // Grouped by type as well as mode, so one query answers three questions: the
  // net money per mode, how many sales were raised, and how many were reversed.
  const byModeAndType = await prisma.invoice.groupBy({
    by: ["paymentMode", "type"],
    where: period,
    _sum: { totalAmount: true },
    _count: { id: true },
  });

  const countOf = (type) =>
    byModeAndType.reduce((n, r) => (r.type === type ? n + r._count.id : n), 0);

  // One row per mode, in the shape clients already read: the money is the net,
  // the count is sales only — so the "N bills" under each mode adds up to the
  // headline count instead of exceeding it by the number of voids.
  const byPaymentMode = [
    ...new Set(byModeAndType.map((r) => r.paymentMode)),
  ].map((paymentMode) => {
    const rows = byModeAndType.filter((r) => r.paymentMode === paymentMode);
    return {
      paymentMode,
      _sum: {
        // .plus, never +: these are Decimals and + concatenates them.
        totalAmount: rows.reduce(
          (sum, r) => sum.plus(r._sum.totalAmount ?? 0),
          new D(0),
        ),
      },
      _count: {
        id: rows.reduce((n, r) => (r.type === "SALE" ? n + r._count.id : n), 0),
      },
    };
  });

  // Prisma returns Decimal (or null on an empty period) — add with Decimal
  // arithmetic, not `+`, which would concatenate the objects as strings.
  const totalCgst = totalStats._sum.cgst ?? new D(0);
  const totalSgst = totalStats._sum.sgst ?? new D(0);

  return {
    // Sales raised in the period, whatever became of them since. A sale
    // voided next week was still raised today, and dropping it from today's
    // count later would rewrite a period after the fact — the one thing the
    // void design exists to prevent (docs/03 section 8).
    totalInvoices: countOf("SALE"),
    // Reversals issued in the period. The money above is already net of them;
    // this is what makes that netting legible rather than a period that
    // mysteriously took less than its invoices add up to.
    creditNotes: countOf("CREDIT_NOTE"),

    totalSales: totalStats._sum.totalAmount ?? new D(0),
    totalCgst,
    totalSgst,
    totalGst: totalCgst.plus(totalSgst),
    byPaymentMode,
  };
};

const dailySummaryData = async (query, shopId) => {
  // Absent means today; a garbage date is a 400 from validateQuery rather than
  // an Invalid Date that silently matched nothing.
  const date = query.date ?? new Date();

  // Each boundary is set on its own copy. `date` is the object validateQuery
  // parsed onto the request, and calling setHours on it directly rewrote it in
  // place — leaving req.validatedQuery.date at 23:59:59.999 for anything that
  // read it afterwards. Nothing does today, which is the only reason that was
  // survivable: G-01 was this same shape, and became a real bug precisely when
  // a second consumer read the mutated value. A controller should not be
  // rewriting what the validation layer put on the request.
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const period = { shopId, date: { gte: startOfDay, lte: endOfDay } };

  const [invoices, summary] = await Promise.all([
    prisma.invoice.findMany({
      where: period,
      include: { customer: { select: { name: true } } },
      orderBy: { date: "desc" },
    }),
    summaryForPeriod(period),
  ]);

  return { date: startOfDay, invoices, summary };
};

// ─── Monthly and yearly reports (FR-RPT-10, FR-RPT-11) ───
//
// The same summary as the day, over a wider window, plus a breakdown: a month
// broken into its days, a year into its months.
//
// **No invoice list, deliberately.** The daily report returns every document
// because a day is a readable number of them; a year is not, and a report that
// quietly ships thousands of rows to a phone is how a list endpoint becomes a
// performance incident. The breakdown is the aggregate, and `/export` is there
// for anyone who wants the underlying documents.

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Local-midnight bounds for a month, and the month after it. */
const monthBounds = (month, year) => ({
  start: new Date(year, month - 1, 1, 0, 0, 0, 0),
  end: new Date(year, month, 0, 23, 59, 59, 999),
});

const monthlyReportData = async ({ month, year }, shopId) => {
  const { start, end } = monthBounds(month, year);
  const period = { shopId, date: { gte: start, lte: end } };

  const [summary, rows] = await Promise.all([
    summaryForPeriod(period),
    bucketedSales({ start, end, bucket: "day", shopId }),
  ]);

  // Zero-filled across the whole month. A day with no sales that simply went
  // missing would shift every later point left and read as a trend rather than
  // a closed shop — the same reason `fillWindow` exists for the 7-day chart.
  const byDay = new Map(rows.map((r) => [r.bucket, r]));
  const days = [];
  for (let d = 1; d <= end.getDate(); d++) {
    const key = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const row = byDay.get(key);
    days.push({
      date: key,
      day: d,
      sales: row ? Number(row.sales) : 0,
      invoices: row ? row.invoices : 0,
      creditNotes: row ? row.creditNotes : 0,
    });
  }

  return {
    month,
    year,
    label: `${MONTH_NAMES[month - 1]} ${year}`,
    // The period's own bounds, so a client can page the register for it
    // through `GET /api/billing/invoices?startDate=&endDate=` rather than
    // recomputing month lengths — and, more to the point, rather than this
    // endpoint growing an invoice list of its own. That list already exists,
    // is already paginated and capped, and is already tested.
    start,
    end,
    summary,
    days,
  };
};

const yearlyReportData = async ({ year }, shopId) => {
  const start = new Date(year, 0, 1, 0, 0, 0, 0);
  const end = new Date(year, 11, 31, 23, 59, 59, 999);
  const period = { shopId, date: { gte: start, lte: end } };

  const [summary, rows] = await Promise.all([
    summaryForPeriod(period),
    bucketedSales({ start, end, bucket: "month", shopId }),
  ]);

  const byMonth = new Map(rows.map((r) => [r.bucket, r]));
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const key = `${year}-${String(m).padStart(2, "0")}`;
    const row = byMonth.get(key);
    months.push({
      month: m,
      // Short label, because twelve full month names do not fit an axis.
      label: MONTH_NAMES[m - 1].slice(0, 3),
      sales: row ? Number(row.sales) : 0,
      invoices: row ? row.invoices : 0,
      creditNotes: row ? row.creditNotes : 0,
    });
  }

  return { year, label: String(year), start, end, summary, months };
};

const getMonthlyReport = async (req, res, next) => {
  try {
    const data = await monthlyReportData(req.validatedQuery, req.user.shopId);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

const getYearlyReport = async (req, res, next) => {
  try {
    const data = await yearlyReportData(req.validatedQuery, req.user.shopId);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

const getDailySummary = async (req, res, next) => {
  try {
    const { invoices, summary } = await dailySummaryData(
      req.validatedQuery,
      req.user.shopId,
    );
    res.json({ success: true, data: { invoices, summary } });
  } catch (err) {
    next(err);
  }
};

// ─── Sales Trend ───────────────────────────────────────
// One grouped query instead of the client making a daily-summary request per
// day. The old shape cost seven round trips, each of which fetched every invoice
// for its day *with the customer joined* and then discarded all of it to read
// two integers (G-08).
//
// Days with no sales still appear, with zeros. The client charts a fixed window,
// so a missing day would silently shift every point left.
const getTrend = async (req, res, next) => {
  try {
    const { days } = req.validatedQuery;

    // Local midnight, not UTC: the store's day is what a shopkeeper means by
    // "yesterday", and the daily summary already draws its boundaries that way.
    // `utils/trend.js` holds the query and the zero-filling, so the dashboard's
    // copy of this chart cannot answer differently — it calls the same function
    // rather than carrying a duplicate of the SQL.
    res.json({
      success: true,
      data: await trendForDays(days, req.user.shopId),
    });
  } catch (err) {
    next(err);
  }
};

// ─── GST Report ────────────────────────────────────────
/**
 * The month's filing figures, shared by the screen and the CSV export. Same
 * reasoning as `dailySummaryData`: one query, so the two cannot disagree.
 */
const gstReportData = async ({ month, year }, shopId) => {
  const startDate = new Date(year, month - 1, 1);
  // `.999`, not `.000`. Omitting the milliseconds argument closed the month at
  // 23:59:59.000 while the next one opens at 00:00:00.000, so a sale committed
  // in the 999 ms between them appeared in the daily summary and in no GST
  // return at all — not its own month's, and too early for the following one.
  // A tax period has to be a partition of time, not a cover with holes in it.
  const endDate = new Date(year, month, 0, 23, 59, 59, 999);

  const invoices = await prisma.invoice.findMany({
    where: {
      shopId,
      date: { gte: startDate, lte: endDate },
      paymentStatus: "PAID",
    },
    include: { items: true },
    orderBy: { date: "asc" },
  });

  const totals = invoices.reduce(
    (acc, inv) => ({
      taxable: acc.taxable.plus(inv.subtotal),
      cgst: acc.cgst.plus(inv.cgst),
      sgst: acc.sgst.plus(inv.sgst),
      total: acc.total.plus(inv.totalAmount),
    }),
    { taxable: new D(0), cgst: new D(0), sgst: new D(0), total: new D(0) },
  );

  return { month, year, invoices, totals };
};

const getGstReport = async (req, res, next) => {
  try {
    const { invoices, totals } = await gstReportData(
      req.validatedQuery,
      req.user.shopId,
    );
    res.json({ success: true, data: { invoices, totals } });
  } catch (err) {
    next(err);
  }
};

/**
 * One row per document, sales and credit notes alike.
 *
 * No totals row. The report's own invariant is that the totals *are* the sum of
 * these rows, so a spreadsheet recomputes them and any disagreement is visible
 * rather than asserted by a row nobody can check. It also keeps the file a
 * single table, which is what every parser downstream expects.
 */
const INVOICE_COLUMNS = [
  { header: "Date", kind: "datetime", get: (i) => i.date },
  { header: "Invoice No", get: (i) => i.invoiceNumber },
  { header: "Type", get: (i) => i.type },
  { header: "Status", get: (i) => i.status },
  { header: "Customer", get: (i) => i.customer?.name ?? "Walk-in" },
  { header: "Payment Mode", get: (i) => i.paymentMode },
  { header: "Payment Status", get: (i) => i.paymentStatus },
  { header: "Taxable", kind: "money", get: (i) => i.subtotal },
  { header: "Discount", kind: "money", get: (i) => i.discountAmt },
  { header: "CGST", kind: "money", get: (i) => i.cgst },
  { header: "SGST", kind: "money", get: (i) => i.sgst },
  { header: "Total", kind: "money", get: (i) => i.totalAmount },
];

const exportDailySummary = async (req, res, next) => {
  try {
    const { date, invoices } = await dailySummaryData(
      req.validatedQuery,
      req.user.shopId,
    );
    const day = date.toISOString().slice(0, 10);
    sendCsv(res, `daily-summary-${day}.csv`, toCsv(INVOICE_COLUMNS, invoices));
  } catch (err) {
    next(err);
  }
};

const exportGstReport = async (req, res, next) => {
  try {
    const { month, year, invoices } = await gstReportData(
      req.validatedQuery,
      req.user.shopId,
    );
    const period = `${year}-${String(month).padStart(2, "0")}`;
    sendCsv(res, `gst-report-${period}.csv`, toCsv(INVOICE_COLUMNS, invoices));
  } catch (err) {
    next(err);
  }
};

/**
 * The period breakdowns export the *aggregate*, not the documents.
 *
 * The daily and GST exports ship one row per invoice because that is what those
 * reports are — a register. A month or a year is read as a shape over time, and
 * a year's worth of documents is both an enormous file and not the thing on the
 * screen. The row a reader wants here is the bucket.
 */
const BREAKDOWN_COLUMNS = [
  { header: "Period", get: (r) => r.date ?? r.label },
  { header: "Invoices", get: (r) => r.invoices },
  { header: "Credit Notes", get: (r) => r.creditNotes },
  { header: "Sales", kind: "money", get: (r) => r.sales },
];

const exportMonthlyReport = async (req, res, next) => {
  try {
    const { month, year, days } = await monthlyReportData(
      req.validatedQuery,
      req.user.shopId,
    );
    const period = `${year}-${String(month).padStart(2, "0")}`;
    sendCsv(
      res,
      `monthly-report-${period}.csv`,
      toCsv(BREAKDOWN_COLUMNS, days),
    );
  } catch (err) {
    next(err);
  }
};

const exportYearlyReport = async (req, res, next) => {
  try {
    const { year, months } = await yearlyReportData(
      req.validatedQuery,
      req.user.shopId,
    );
    sendCsv(res, `yearly-report-${year}.csv`, toCsv(BREAKDOWN_COLUMNS, months));
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createInvoice,
  getAll,
  getOne,
  getDailySummary,
  exportDailySummary,
  exportGstReport,
  getTrend,
  getGstReport,
  getMonthlyReport,
  exportMonthlyReport,
  getYearlyReport,
  exportYearlyReport,
  voidInvoice,
};
