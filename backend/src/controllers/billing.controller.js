const prisma = require("../config/db");
const { Prisma } = require("@prisma/client");
const {
  generateInvoiceNumber,
  generateCreditNoteNumber,
  isDuplicateNumber,
} = require("../utils/invoice.utils");

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
      discountAmt = 0,
      paymentMode,
      paymentStatus,
      notes,
    } = req.body;

    // Step 1 — Verify stock availability for all items.
    // Advisory only: it fails fast with a friendly message before any work is
    // done, but the authoritative check is the guarded decrement in Step 3.
    for (const item of items) {
      const batch = await prisma.batch.findUnique({
        where: { id: item.batchId },
      });
      if (!batch) {
        return res.status(404).json({
          success: false,
          message: `Batch not found for ${item.medicineName}`,
        });
      }
      if (batch.quantity < item.quantity) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for ${item.medicineName}. Available: ${batch.quantity}`,
        });
      }
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
          const invoiceNumber = await generateInvoiceNumber(tx);

          const newInvoice = await tx.invoice.create({
            data: {
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
            },
            include: {
              items: true,
              customer: true,
              user: { select: { name: true } },
            },
          });

          // Deduct stock from each batch. The quantity guard in the where clause
          // makes check-and-decrement a single atomic statement, so two concurrent
          // invoices can never both claim the same units — the loser matches zero
          // rows and rolls the whole invoice back.
          for (const item of items) {
            const { count } = await tx.batch.updateMany({
              where: { id: item.batchId, quantity: { gte: item.quantity } },
              data: { quantity: { decrement: item.quantity } },
            });

            if (count === 0) {
              const batch = await tx.batch.findUnique({
                where: { id: item.batchId },
                select: { quantity: true },
              });
              if (!batch) {
                throw new StockConflictError(
                  `Batch not found for ${item.medicineName}`,
                  404,
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
    const { reason } = req.body;

    const original = await prisma.invoice.findUnique({
      where: { id },
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

    const creditNote = await prisma.$transaction(async (tx) => {
      // Flip the original first. Combined with the unique index on reversesId
      // this is what makes a double-submitted void safe: the second transaction
      // either sees CANCELLED here or loses the index below, and rolls back
      // before restoring anything a second time.
      const { count: flipped } = await tx.invoice.updateMany({
        where: { id, status: "ACTIVE", type: "SALE" },
        data: { status: "CANCELLED" },
      });
      if (flipped === 0) {
        throw new StockConflictError("This invoice has already been voided.", 409);
      }

      // Return the units to the batches they came from, keeping the original
      // expiry dates and batch numbers (PRD Q3). Unconditional increment: unlike
      // the deduction there is no ceiling to race against, and the guard above
      // already ensures this runs once.
      for (const item of original.items) {
        await tx.batch.update({
          where: { id: item.batchId },
          data: { quantity: { increment: item.quantity } },
        });
      }

      const number = await generateCreditNoteNumber(tx);

      // Negative amounts, so any period that sums invoices nets correctly
      // without every report having to learn about credit notes.
      return tx.invoice.create({
        data: {
          invoiceNumber: number,
          type: "CREDIT_NOTE",
          status: "ACTIVE",
          reversesId: original.id,
          customerId: original.customerId,
          userId: req.user.id,
          subtotal: original.subtotal.negated(),
          discountAmt: original.discountAmt.negated(),
          cgst: original.cgst.negated(),
          sgst: original.sgst.negated(),
          totalAmount: original.totalAmount.negated(),
          paymentMode: original.paymentMode,
          paymentStatus: original.paymentStatus,
          notes: reason
            ? `Reverses ${original.invoiceNumber}: ${reason}`
            : `Reverses ${original.invoiceNumber}`,
          items: {
            create: original.items.map((i) => ({
              batchId: i.batchId,
              medicineName: i.medicineName,
              quantity: i.quantity,
              unitPrice: i.unitPrice,
              discount: i.discount,
              gstPercent: i.gstPercent,
              totalPrice: i.totalPrice.negated(),
            })),
          },
        },
        include: { items: true, customer: true, user: { select: { name: true } } },
      });
    });

    res.status(201).json({
      success: true,
      message: `Invoice ${original.invoiceNumber} voided. Credit note ${creditNote.invoiceNumber} issued.`,
      data: creditNote,
    });
  } catch (err) {
    if (err instanceof StockConflictError) {
      return res
        .status(err.statusCode)
        .json({ success: false, message: err.message });
    }
    // Losing the race for the unique index means another void committed first.
    if (isDuplicateNumber(err, "reversesId")) {
      return res.status(409).json({
        success: false,
        message: "This invoice has already been voided.",
      });
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
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
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
const getDailySummary = async (req, res, next) => {
  try {
    // Absent means today; a garbage date is a 400 from validateQuery rather than
    // an Invalid Date that silently matched nothing.
    const date = req.validatedQuery.date ?? new Date();

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

    const period = { date: { gte: startOfDay, lte: endOfDay } };

    const [invoices, totalStats] = await Promise.all([
      prisma.invoice.findMany({
        where: period,
        include: { customer: { select: { name: true } } },
        orderBy: { date: "desc" },
      }),
      // Money only. Summed across every document in the period, sales and credit
      // notes alike, so a day's takings are net of anything reversed that day.
      prisma.invoice.aggregate({
        where: period,
        _sum: { totalAmount: true, cgst: true, sgst: true },
      }),
    ]);

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

    // Prisma returns Decimal (or null on an empty day) — add with Decimal
    // arithmetic, not `+`, which would concatenate the objects as strings.
    const totalCgst = totalStats._sum.cgst ?? new D(0);
    const totalSgst = totalStats._sum.sgst ?? new D(0);

    res.json({
      success: true,
      data: {
        invoices,
        summary: {
          // Sales raised in the period, whatever became of them since. A sale
          // voided next week was still raised today, and dropping it from
          // today's count later would rewrite a period after the fact — the one
          // thing the void design exists to prevent (docs/03 section 8).
          totalInvoices: countOf("SALE"),
          // Reversals issued in the period. The money above is already net of
          // them; this is what makes that netting legible rather than a day
          // that mysteriously took less than its invoices add up to.
          creditNotes: countOf("CREDIT_NOTE"),

          totalSales: totalStats._sum.totalAmount ?? new D(0),
          totalCgst,
          totalSgst,
          totalGst: totalCgst.plus(totalSgst),
          byPaymentMode,
        },
      },
    });
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
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    const start = new Date();
    start.setDate(start.getDate() - (days - 1));
    start.setHours(0, 0, 0, 0);

    const rows = await prisma.$queryRaw`
      SELECT to_char(date_trunc('day', "date"), 'YYYY-MM-DD')   AS day,
             COUNT(*) FILTER (WHERE "type" = 'SALE')::int       AS invoices,
             COALESCE(SUM("totalAmount"), 0)                    AS sales
      FROM "Invoice"
      WHERE "date" >= ${start} AND "date" <= ${end}
        AND "paymentStatus" = 'PAID'::"PaymentStatus"
      GROUP BY 1
      ORDER BY 1`;

    const byDay = new Map(rows.map((r) => [r.day, r]));

    const trend = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const row = byDay.get(key);
      trend.push({
        date: key,
        sales: row ? Number(row.sales) : 0,
        invoices: row ? row.invoices : 0,
      });
    }

    res.json({ success: true, data: trend });
  } catch (err) {
    next(err);
  }
};

// ─── GST Report ────────────────────────────────────────
const getGstReport = async (req, res, next) => {
  try {
    const { month, year } = req.validatedQuery;
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);

    const invoices = await prisma.invoice.findMany({
      where: {
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

    res.json({ success: true, data: { invoices, totals } });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createInvoice,
  getAll,
  getOne,
  getDailySummary,
  getTrend,
  getGstReport,
  voidInvoice,
};
