const prisma = require("../config/db");

const getAll = async (req, res, next) => {
  try {
    const { medicineId, expiringSoon, lowStock } = req.query;

    const today = new Date();
    const thirtyDaysLater = new Date();
    thirtyDaysLater.setDate(today.getDate() + 30);

    const where = {
      ...(medicineId && { medicineId }),
      ...(expiringSoon === "true" && {
        expiryDate: { lte: thirtyDaysLater, gte: today },
      }),
      ...(lowStock === "true" && { quantity: { lte: 10, gt: 0 } }),
    };

    const batches = await prisma.batch.findMany({
      where,
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

const getExpiring = async (req, res, next) => {
  try {
    const days = Number(req.query.days) || 30;
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
    const threshold = Number(req.query.threshold) || 10;

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
      },
    });
    res.json({ success: true, message: "Batch updated", data: batch });
  } catch (err) {
    next(err);
  }
};

module.exports = { getAll, getExpiring, getLowStock, create, update };
