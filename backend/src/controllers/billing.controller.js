const prisma = require("../config/db");
const {
  generateInvoiceNumber,
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

// Concurrent checkouts can derive the same serial; every retry re-reads the
// count, so a handful of attempts covers far more simultaneous counters than a
// single store will ever run.
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
    let subtotal = 0;
    let totalCgst = 0;
    let totalSgst = 0;

    const processedItems = items.map((item) => {
      const itemSubtotal = item.unitPrice * item.quantity;
      const discountVal = (itemSubtotal * item.discount) / 100;
      const taxableAmt = itemSubtotal - discountVal;
      const gstAmt = (taxableAmt * item.gstPercent) / 100;
      const cgst = gstAmt / 2;
      const sgst = gstAmt / 2;
      const totalPrice = taxableAmt + gstAmt;

      subtotal += taxableAmt;
      totalCgst += cgst;
      totalSgst += sgst;

      return {
        batchId: item.batchId,
        medicineName: item.medicineName,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discount: item.discount,
        gstPercent: item.gstPercent,
        totalPrice: parseFloat(totalPrice.toFixed(2)),
      };
    });

    const totalAmount = parseFloat(
      (subtotal + totalCgst + totalSgst - discountAmt).toFixed(2),
    );

    // Step 3 — Create invoice + deduct stock in a transaction.
    // The serial is allocated inside the transaction, but two concurrent
    // transactions can still read the same count and derive the same number.
    // The unique index lets exactly one of them commit; the loser retries with
    // a fresh serial instead of failing a sale the customer already paid for.
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
              subtotal: parseFloat(subtotal.toFixed(2)),
              discountAmt,
              cgst: parseFloat(totalCgst.toFixed(2)),
              sgst: parseFloat(totalSgst.toFixed(2)),
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

// ─── Get All Invoices ──────────────────────────────────
const getAll = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 20,
      search,
      startDate,
      endDate,
      paymentMode,
      paymentStatus,
    } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const where = {
      ...(search && {
        OR: [
          { invoiceNumber: { contains: search, mode: "insensitive" } },
          { customer: { name: { contains: search, mode: "insensitive" } } },
        ],
      }),
      ...(startDate &&
        endDate && {
          date: { gte: new Date(startDate), lte: new Date(endDate) },
        }),
      ...(paymentMode && { paymentMode }),
      ...(paymentStatus && { paymentStatus }),
    };

    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        skip,
        take: Number(limit),
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
    const date = req.query.date ? new Date(req.query.date) : new Date();
    const startOfDay = new Date(date.setHours(0, 0, 0, 0));
    const endOfDay = new Date(date.setHours(23, 59, 59, 999));

    const [invoices, totalStats] = await Promise.all([
      prisma.invoice.findMany({
        where: { date: { gte: startOfDay, lte: endOfDay } },
        include: { customer: { select: { name: true } } },
        orderBy: { date: "desc" },
      }),
      prisma.invoice.aggregate({
        where: { date: { gte: startOfDay, lte: endOfDay } },
        _sum: { totalAmount: true, cgst: true, sgst: true },
        _count: { id: true },
      }),
    ]);

    // Group by payment mode
    const byPaymentMode = await prisma.invoice.groupBy({
      by: ["paymentMode"],
      where: { date: { gte: startOfDay, lte: endOfDay } },
      _sum: { totalAmount: true },
      _count: { id: true },
    });

    res.json({
      success: true,
      data: {
        invoices,
        summary: {
          totalInvoices: totalStats._count.id,
          totalSales: totalStats._sum.totalAmount || 0,
          totalCgst: totalStats._sum.cgst || 0,
          totalSgst: totalStats._sum.sgst || 0,
          totalGst: (totalStats._sum.cgst || 0) + (totalStats._sum.sgst || 0),
          byPaymentMode,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GST Report ────────────────────────────────────────
const getGstReport = async (req, res, next) => {
  try {
    const { month, year } = req.query;
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
        taxable: acc.taxable + inv.subtotal,
        cgst: acc.cgst + inv.cgst,
        sgst: acc.sgst + inv.sgst,
        total: acc.total + inv.totalAmount,
      }),
      { taxable: 0, cgst: 0, sgst: 0, total: 0 },
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
  getGstReport,
};
