const prisma = require("../config/db");

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

module.exports = { getAll, getExpiring, getLowStock, create, update };
