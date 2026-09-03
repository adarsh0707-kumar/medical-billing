const prisma = require("../config/db");
const { streamCsv } = require("../utils/csv");
const { logger } = require("../config/logger");
const { setReason } = require("../config/audit-context");

// Local midnight today — the same boundary `createInvoice` derives, and for the
// same reason: a medicine is good *through* the date printed on it, so a batch
// expiring today is still sellable and still worth warning about.
//
// These reports used to start at `new Date()`, the current instant. Expiry
// dates are stored at midnight, so from the first moment of the day a batch
// expiring today was already behind the cursor: the till sold it happily while
// the report built to say "take this off the shelf" — and the topbar
// notification that reads the same endpoint — stayed silent on the one day it
// mattered. Shared from here so the sale path and the warning path cannot
// disagree about what "expired" means again.
const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const getAll = async (req, res, next) => {
  try {
    // `expiringSoon` and `lowStock` arrive as booleans: validateQuery coerces the
    // "true"/"false" strings URLSearchParams sends. Comparing them to the string
    // "true" here silently disabled both filters and returned every batch.
    const { medicineId, expiringSoon, lowStock, page, limit } =
      req.validatedQuery;

    const today = startOfToday();
    const thirtyDaysLater = new Date();
    thirtyDaysLater.setDate(thirtyDaysLater.getDate() + 30);

    const where = {
      shopId: req.user.shopId,
      ...(medicineId && { medicineId }),
      ...(expiringSoon && {
        expiryDate: { lte: thirtyDaysLater, gte: today },
      }),
      ...(lowStock && { quantity: { lte: 10, gt: 0 } }),
    };

    // Paginated: unfiltered this returned every batch in the shop, which at
    // 25,000 rows was 8 MB and about a second and a half per page load.
    const [batches, total] = await Promise.all([
      prisma.batch.findMany({
        where,
        include: {
          medicine: { select: { name: true, unit: true } },
          supplier: { select: { name: true } },
        },
        orderBy: { expiryDate: "asc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.batch.count({ where }),
    ]);

    res.json({
      success: true,
      data: batches,
      pagination: {
        total,
        page,
        limit,
        pages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Batches expiring inside the window, shared by the screen and the CSV export so
 * the two cannot drift apart.
 */
const expiringWhere = ({ days, shopId }) => {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + days);

  return {
    shopId,
    expiryDate: { lte: futureDate, gte: startOfToday() },
    quantity: { gt: 0 },
  };
};

/**
 * What an expiry row carries, and in what order.
 *
 * `id` closes the ordering: a shop takes in many batches with the same expiry
 * date, so `expiryDate` alone leaves a tie the database may break differently
 * between two queries — which a paged export turns into a repeated row and a
 * missing one.
 */
const EXPIRING_LIST = {
  include: {
    medicine: { select: { name: true, unit: true } },
    supplier: { select: { name: true } },
  },
  orderBy: [{ expiryDate: "asc" }, { id: "asc" }],
};

const expiringData = async ({ days, shopId }) => ({
  days,
  batches: await prisma.batch.findMany({
    where: expiringWhere({ days, shopId }),
    ...EXPIRING_LIST,
  }),
});

const getExpiring = async (req, res, next) => {
  try {
    const { batches } = await expiringData({
      ...req.validatedQuery,
      shopId: req.user.shopId,
    });
    res.json({ success: true, data: batches });
  } catch (err) {
    next(err);
  }
};

/** Same split, same reason, for the low-stock report. */
const lowStockWhere = ({ threshold, shopId }) => ({
  shopId,
  quantity: { lte: threshold, gt: 0 },
});

/** `id` closes the ordering — quantity ties constantly. See `EXPIRING_LIST`. */
const LOW_STOCK_LIST = {
  include: {
    medicine: { select: { name: true, unit: true, category: true } },
    supplier: { select: { name: true } },
  },
  orderBy: [{ quantity: "asc" }, { id: "asc" }],
};

const lowStockData = async ({ threshold, shopId }) => ({
  threshold,
  batches: await prisma.batch.findMany({
    where: lowStockWhere({ threshold, shopId }),
    ...LOW_STOCK_LIST,
  }),
});

const getLowStock = async (req, res, next) => {
  try {
    const { batches } = await lowStockData({
      ...req.validatedQuery,
      shopId: req.user.shopId,
    });
    res.json({ success: true, data: batches });
  } catch (err) {
    next(err);
  }
};

const DAY_MS = 86400000;

/**
 * `daysToExpiry` is computed here rather than left to the reader. A date alone
 * makes the reader do the arithmetic that decides whether to act, and the point
 * of pulling this into a spreadsheet is to sort by urgency.
 */
const EXPIRING_COLUMNS = [
  { header: "Medicine", get: (b) => b.medicine?.name ?? "" },
  { header: "Batch No", get: (b) => b.batchNumber },
  { header: "Expiry", kind: "date", get: (b) => b.expiryDate },
  {
    header: "Days To Expiry",
    kind: "number",
    get: (b) =>
      Math.ceil((new Date(b.expiryDate).getTime() - Date.now()) / DAY_MS),
  },
  { header: "Quantity", kind: "number", get: (b) => b.quantity },
  { header: "Unit", get: (b) => b.medicine?.unit ?? "" },
  { header: "Selling Price", kind: "money", get: (b) => b.sellingPrice },
  // What walking away from it would cost, at what the shop paid.
  {
    header: "Stock Value At Cost",
    kind: "money",
    get: (b) => b.purchasePrice.times(b.quantity),
  },
  { header: "Supplier", get: (b) => b.supplier?.name ?? "" },
];

const LOW_STOCK_COLUMNS = [
  { header: "Medicine", get: (b) => b.medicine?.name ?? "" },
  { header: "Category", get: (b) => b.medicine?.category?.name ?? "" },
  { header: "Batch No", get: (b) => b.batchNumber },
  { header: "Quantity", kind: "number", get: (b) => b.quantity },
  { header: "Unit", get: (b) => b.medicine?.unit ?? "" },
  { header: "Expiry", kind: "date", get: (b) => b.expiryDate },
  { header: "Selling Price", kind: "money", get: (b) => b.sellingPrice },
  { header: "Supplier", get: (b) => b.supplier?.name ?? "" },
];

const exportExpiring = async (req, res, next) => {
  try {
    const { days } = req.validatedQuery;
    const where = expiringWhere({ days, shopId: req.user.shopId });

    await streamCsv(
      res,
      `expiring-${days}-days.csv`,
      EXPIRING_COLUMNS,
      (skip, take) =>
        prisma.batch.findMany({ where, ...EXPIRING_LIST, skip, take }),
      { logger },
    );
  } catch (err) {
    next(err);
  }
};

const exportLowStock = async (req, res, next) => {
  try {
    const { threshold } = req.validatedQuery;
    const where = lowStockWhere({ threshold, shopId: req.user.shopId });

    await streamCsv(
      res,
      `low-stock-at-${threshold}.csv`,
      LOW_STOCK_COLUMNS,
      (skip, take) =>
        prisma.batch.findMany({ where, ...LOW_STOCK_LIST, skip, take }),
      { logger },
    );
  } catch (err) {
    next(err);
  }
};

const create = async (req, res, next) => {
  try {
    // The medicine being batched has to be this shop's own, or a batch would
    // attach itself — and its denormalised shopId — to another tenant's
    // medicine. findFirst rather than findUnique-then-check for the same
    // reason as medicine.controller.js: a foreign id should read as "not
    // found", not as a separate ownership rejection.
    const medicine = await prisma.medicine.findFirst({
      where: { id: req.body.medicineId, shopId: req.user.shopId },
      select: { id: true },
    });
    if (!medicine) {
      return res
        .status(404)
        .json({ success: false, message: "Medicine not found" });
    }

    const data = {
      ...req.body,
      shopId: req.user.shopId,
      mfgDate: req.body.mfgDate ? new Date(req.body.mfgDate) : null,
      expiryDate: new Date(req.body.expiryDate),
      initialQty: req.body.quantity,
    };
    const batch = await prisma.batch.create({
      data,
      include: {
        medicine: { select: { name: true } },
        supplier: { select: { name: true } },
      },
    });
    res
      .status(201)
      .json({ success: true, message: "Batch added to stock", data: batch });
  } catch (err) {
    next(err);
  }
};

const update = async (req, res, next) => {
  try {
    const result = await prisma.batch.updateMany({
      where: { id: req.params.id, shopId: req.user.shopId },
      data: {
        ...req.body,
        ...(req.body.expiryDate && {
          expiryDate: new Date(req.body.expiryDate),
        }),
        ...(req.body.mfgDate && { mfgDate: new Date(req.body.mfgDate) }),
      },
    });
    if (result.count === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Batch not found" });
    }
    const batch = await prisma.batch.findUnique({
      where: { id: req.params.id },
    });
    res.json({ success: true, message: "Batch updated", data: batch });
  } catch (err) {
    next(err);
  }
};

// ─── Adjust stock ──────────────────────────────────────
// FR-BATCH-11. Until now `Batch.quantity` moved in exactly two places — batch
// creation and a sale — and `PUT /batches/:id` refused to touch it (G-05),
// because rewriting stock through a general edit bypasses every accounting path.
// That is still true: this is a separate endpoint with a separate schema, not a
// widening of the update.
//
// What it is for: breakage, theft, a miscount, expired stock coming off the
// shelf. Physical reality disagreeing with the record.
//
// What it is **not** for: reversing a sale. That is a void, which issues a
// credit note, restores the exact units to the batches they came from and keeps
// the tax period intact. An adjustment that happened to add three units back
// would leave the invoice standing and the money uncorrected. Nothing here can
// stop an administrator misusing it, so the defence is that the reason is
// mandatory and the whole thing is attributed — the point of FR-BATCH-11.
const adjust = async (req, res, next) => {
  try {
    const { delta, reason } = req.body;

    // Published on the request before the write, so the audit middleware picks
    // it up along with the actor.
    setReason(reason);

    // Conditional update, the same shape as the sale's decrement: a negative
    // adjustment that would take stock below zero matches no rows instead of
    // reaching the database CHECK and surfacing as a 500. Two operators writing
    // off the same last unit cannot both succeed. shopId is part of the same
    // where clause, not a separate check, so a foreign batch id fails the same
    // conditional match rather than a distinguishable ownership branch.
    const { count } = await prisma.batch.updateMany({
      where: {
        id: req.params.id,
        shopId: req.user.shopId,
        ...(delta < 0 && { quantity: { gte: -delta } }),
      },
      data: { quantity: { increment: delta } },
    });

    if (count === 0) {
      const batch = await prisma.batch.findFirst({
        where: { id: req.params.id, shopId: req.user.shopId },
        select: { quantity: true, batchNumber: true },
      });
      if (!batch) {
        return res
          .status(404)
          .json({ success: false, message: "Batch not found" });
      }
      return res.status(400).json({
        success: false,
        message: `Cannot remove ${-delta} from batch ${batch.batchNumber}: only ${batch.quantity} in stock. Stock cannot go negative.`,
      });
    }

    const batch = await prisma.batch.findUnique({
      where: { id: req.params.id },
      include: { medicine: { select: { name: true, unit: true } } },
    });

    res.json({
      success: true,
      message: `Stock adjusted by ${delta > 0 ? "+" : ""}${delta}. Recorded against ${req.user.email}.`,
      data: batch,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getAll,
  getExpiring,
  exportExpiring,
  getLowStock,
  exportLowStock,
  create,
  update,
  adjust,
};
