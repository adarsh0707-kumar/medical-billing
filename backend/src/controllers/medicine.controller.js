const prisma = require("../config/db");

const getAll = async (req, res, next) => {
  try {
    const { search, categoryId, page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const where = {
      isActive: true,
      ...(search && {
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { genericName: { contains: search, mode: "insensitive" } },
          { hsnCode: { contains: search } },
        ],
      }),
      ...(categoryId && { categoryId }),
    };

    const [medicines, total] = await Promise.all([
      prisma.medicine.findMany({
        where,
        include: {
          category: true,
          manufacturer: true,
          batches: {
            where: { quantity: { gt: 0 } },
            orderBy: { expiryDate: "asc" },
            take: 1,
          },
        },
        skip,
        take: Number(limit),
        orderBy: { name: "asc" },
      }),
      prisma.medicine.count({ where }),
    ]);

    // Add total stock to each medicine
    const result = medicines.map((m) => ({
      ...m,
      totalStock: m.batches.reduce((sum, b) => sum + b.quantity, 0),
      nearestExpiry: m.batches[0]?.expiryDate || null,
      sellingPrice: m.batches[0]?.sellingPrice || 0,
    }));

    res.json({
      success: true,
      data: result,
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

const getOne = async (req, res, next) => {
  try {
    const medicine = await prisma.medicine.findUnique({
      where: { id: req.params.id },
      include: {
        category: true,
        manufacturer: true,
        batches: {
          include: { supplier: true },
          orderBy: { expiryDate: "asc" },
        },
      },
    });
    if (!medicine)
      return res
        .status(404)
        .json({ success: false, message: "Medicine not found" });
    res.json({ success: true, data: medicine });
  } catch (err) {
    next(err);
  }
};

// Search for billing POS — fast lookup
const search = async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json({ success: true, data: [] });

    const medicines = await prisma.medicine.findMany({
      where: {
        isActive: true,
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { genericName: { contains: q, mode: "insensitive" } },
        ],
        
      },
      include: {
        batches: {
          where: { quantity: { gt: 0 } },
          orderBy: { expiryDate: "asc" },
          take: 1,
        },
      },
      take: 10,
    });

    const result = medicines.map((m) => ({
      id: m.id,
      name: m.name,
      genericName: m.genericName,
      unit: m.unit,
      gstPercent: m.gstPercent,
      isScheduledH: m.isScheduledH,
      batchId: m.batches[0]?.id || null,
      batchNumber: m.batches[0]?.batchNumber || "No Stock",
      expiryDate: m.batches[0]?.expiryDate || null,
      sellingPrice: m.batches[0]?.sellingPrice || 0,
      stock: m.batches[0]?.quantity || 0,
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

const create = async (req, res, next) => {
  try {
    const medicine = await prisma.medicine.create({
      data: req.body,
      include: { category: true, manufacturer: true },
    });
    res
      .status(201)
      .json({ success: true, message: "Medicine created", data: medicine });
  } catch (err) {
    next(err);
  }
};

const update = async (req, res, next) => {
  try {
    const medicine = await prisma.medicine.update({
      where: { id: req.params.id },
      data: req.body,
      include: { category: true, manufacturer: true },
    });
    res.json({ success: true, message: "Medicine updated", data: medicine });
  } catch (err) {
    next(err);
  }
};

const remove = async (req, res, next) => {
  try {
    // Soft delete
    await prisma.medicine.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });
    res.json({ success: true, message: "Medicine deleted" });
  } catch (err) {
    next(err);
  }
};

module.exports = { getAll, getOne, search, create, update, remove };
