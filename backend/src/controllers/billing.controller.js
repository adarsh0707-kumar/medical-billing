const prisma = require("../config/db");
const { generateInvoiceNumber } = require("../utils/invoice.utils");

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

    // Step 1 — Verify stock availability for all items
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
    const invoiceNumber = await generateInvoiceNumber();

    // Step 3 — Create invoice + deduct stock in a transaction
    const invoice = await prisma.$transaction(async (tx) => {
      // Create invoice
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

      // Deduct stock from each batch
      for (const item of items) {
        await tx.batch.update({
          where: { id: item.batchId },
          data: { quantity: { decrement: item.quantity } },
        });
      }

      return newInvoice;
    });

    res.status(201).json({
      success: true,
      message: "Invoice created successfully",
      data: invoice,
    });
  } catch (err) {
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
