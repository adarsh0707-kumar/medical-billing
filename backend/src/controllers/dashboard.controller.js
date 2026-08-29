const prisma = require("../config/db");
const { Prisma } = require("@prisma/client");
const { dailyTrend, fillWindow } = require("../utils/trend");

const D = Prisma.Decimal;

/**
 * Everything the dashboard needs, in one request.
 *
 * It previously made **thirteen**: six for the panels plus seven more for the
 * trend chart, one per day. Two of the six existed only to read a number —
 * `?limit=1` on medicines and customers, fetching a row to throw it away and
 * keep `pagination.total`.
 *
 * The expiry and low-stock panels were the expensive part. Both fetched *every*
 * matching batch with its medicine and supplier joined — 281 KB and 481 KB at
 * 25,000 batches — to render eight rows and a count. Counts and rows are now
 * separate: an exact count from the database, and only the rows the page shows.
 */

// What the panels actually render. The counts are exact regardless.
const PANEL_ROWS = 10;
const RECENT_INVOICES = 8;
const EXPIRY_WINDOW_DAYS = 30;
const LOW_STOCK_THRESHOLD = 20;

const batchPreview = {
  select: {
    id: true,
    batchNumber: true,
    expiryDate: true,
    quantity: true,
    sellingPrice: true,
    medicine: { select: { id: true, name: true, unit: true } },
    supplier: { select: { name: true } },
  },
};

const getStats = async (req, res, next) => {
  try {
    const now = new Date();

    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    const expiryCutoff = new Date(now);
    expiryCutoff.setDate(expiryCutoff.getDate() + EXPIRY_WINDOW_DAYS);

    const trendStart = new Date(now);
    trendStart.setDate(trendStart.getDate() - 6);
    trendStart.setHours(0, 0, 0, 0);

    // `startOfDay`, not `now`. Expiry dates are stored at midnight, so keying
    // the window to the current instant drops a batch expiring today the moment
    // the day starts — while `createInvoice` goes on selling it until midnight
    // (FR-BATCH-09). The panel that exists to say "take this off the shelf"
    // must not go quiet on the last day it can.
    //
    // The same defect lived in batch.controller.js's two windows and was fixed
    // there first; this third site was missed in that pass, which is the case
    // for one shared boundary rather than three hand-written ones.
    const expiringWhere = {
      shopId: req.user.shopId,
      expiryDate: { lte: expiryCutoff, gte: startOfDay },
      quantity: { gt: 0 },
    };
    const lowStockWhere = {
      shopId: req.user.shopId,
      quantity: { lte: LOW_STOCK_THRESHOLD, gt: 0 },
    };

    // One round trip from the client, and the queries run concurrently on one
    // connection pool rather than across six HTTP requests.
    const [
      todayAggregate,
      byModeAndType,
      recentInvoices,
      expiringCount,
      expiringItems,
      lowStockCount,
      lowStockItems,
      medicineCount,
      customerCount,
      trendRows,
    ] = await Promise.all([
      // Money only, across every document in the day — sales and the credit
      // notes reversing them — so the takings are net. Counts come from the
      // grouping below, which can tell the two apart.
      prisma.invoice.aggregate({
        where: {
          shopId: req.user.shopId,
          date: { gte: startOfDay, lte: endOfDay },
        },
        _sum: { totalAmount: true, cgst: true, sgst: true },
      }),
      // Grouped by type as well as mode: the same query yields net money per
      // mode, the number of sales raised, and the number reversed.
      prisma.invoice.groupBy({
        by: ["paymentMode", "type"],
        where: {
          shopId: req.user.shopId,
          date: { gte: startOfDay, lte: endOfDay },
        },
        _sum: { totalAmount: true },
        _count: { id: true },
      }),
      prisma.invoice.findMany({
        where: { shopId: req.user.shopId },
        take: RECENT_INVOICES,
        orderBy: { date: "desc" },
        select: {
          id: true,
          invoiceNumber: true,
          date: true,
          totalAmount: true,
          paymentMode: true,
          paymentStatus: true,
          customer: { select: { id: true, name: true } },
        },
      }),
      prisma.batch.count({ where: expiringWhere }),
      prisma.batch.findMany({
        where: expiringWhere,
        orderBy: { expiryDate: "asc" },
        take: PANEL_ROWS,
        ...batchPreview,
      }),
      prisma.batch.count({ where: lowStockWhere }),
      prisma.batch.findMany({
        where: lowStockWhere,
        orderBy: { quantity: "asc" },
        take: PANEL_ROWS,
        ...batchPreview,
      }),
      prisma.medicine.count({
        where: { shopId: req.user.shopId, isActive: true },
      }),
      prisma.customer.count({ where: { shopId: req.user.shopId } }),
      // The same query the reports trend uses — literally the same function, so
      // the two cannot drift. It buckets by the store's local day rather than
      // by UTC; see utils/trend.js for why that distinction is load-bearing.
      dailyTrend(prisma, trendStart, endOfDay, req.user.shopId),
    ]);

    const countOf = (type) =>
      byModeAndType.reduce(
        (n, r) => (r.type === type ? n + r._count.id : n),
        0,
      );

    // Folded back to one row per mode, the shape the client reads: net money,
    // sales-only count. `_count` is an object here, matching the daily summary —
    // it was a bare number, so the panel's `pm._count.id` rendered "undefined
    // bills" on any day with trade.
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
          id: rows.reduce(
            (n, r) => (r.type === "SALE" ? n + r._count.id : n),
            0,
          ),
        },
      };
    });

    // Days with no sales still appear, or the chart silently shifts left.
    const trend = fillWindow(trendRows, 7, now);

    res.json({
      success: true,
      data: {
        summary: {
          totalSales: todayAggregate._sum.totalAmount ?? 0,
          // Sales raised today, whatever became of them since; and the
          // reversals issued today, which the money above is already net of.
          // See docs/03 section 8 for why a voided sale still counts in the
          // period it was raised in.
          totalInvoices: countOf("SALE"),
          creditNotes: countOf("CREDIT_NOTE"),
          totalCgst: todayAggregate._sum.cgst ?? 0,
          totalSgst: todayAggregate._sum.sgst ?? 0,
          byPaymentMode,
        },
        recentInvoices,
        // count is every matching batch; items is only what the panel renders.
        expiring: { count: expiringCount, items: expiringItems },
        lowStock: { count: lowStockCount, items: lowStockItems },
        totals: { medicines: medicineCount, customers: customerCount },
        trend,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { getStats };
