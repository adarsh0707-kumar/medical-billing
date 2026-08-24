const prisma = require("../config/db");
const { setReason } = require("../config/audit-context");

const getAll = async (req, res, next) => {
  try {
    // `expiringSoon` and `lowStock` arrive as booleans: validateQuery coerces the
    // "true"/"false" strings URLSearchParams sends. Comparing them to the string
    // "true" here silently disabled both filters and returned every batch.
    const { medicineId, expiringSoon, lowStock, page, limit } =
      req.validatedQuery;

    const today = new Date();
    const thirtyDaysLater = new Date();
    thirtyDaysLater.setDate(today.getDate() + 30);

    const where = {
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

const getExpiring = async (req, res, next) => {
  try {
    const { days } = req.validatedQuery;
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + days);

    const batches = await prisma.batch.findMany({
      where: {
        expiryDate: { lte: futureDate, gte: new Date() },
        quantity: { gt: 0 },
      },
      include: {
        medicine: { select: { name: true, unit: true } },
        supplier: { select: { name: true } },
      },
      orderBy: { expiryDate: "asc" },
    });

    res.json({ success: true, data: batches });
  } catch (err) {
    next(err);
  }
};

const getLowStock = async (req, res, next) => {
  try {
    const { threshold } = req.validatedQuery;

    const batches = await prisma.batch.findMany({
      where: { quantity: { lte: threshold, gt: 0 } },
      include: {
        medicine: { select: { name: true, unit: true, category: true } },
        supplier: { select: { name: true } },
      },
      orderBy: { quantity: "asc" },
    });

    res.json({ success: true, data: batches });
  } catch (err) {
    next(err);
  }
};

const create = async (req, res, next) => {
  try {
    const data = {
      ...req.body,
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
    const batch = await prisma.batch.update({
      where: { id: req.params.id },
      data: {
        ...req.body,
        ...(req.body.expiryDate && {
          expiryDate: new Date(req.body.expiryDate),
        }),
        ...(req.body.mfgDate && { mfgDate: new Date(req.body.mfgDate) }),
      },
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
    // off the same last unit cannot both succeed.
    const { count } = await prisma.batch.updateMany({
      where: {
        id: req.params.id,
        ...(delta < 0 && { quantity: { gte: -delta } }),
      },
      data: { quantity: { increment: delta } },
    });

    if (count === 0) {
      const batch = await prisma.batch.findUnique({
        where: { id: req.params.id },
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

module.exports = { getAll, getExpiring, getLowStock, create, update, adjust };
