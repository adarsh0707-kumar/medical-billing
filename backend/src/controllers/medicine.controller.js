const prisma = require("../config/db");

const getAll = async (req, res, next) => {
  try {
    // Parsed and bounded by validateQuery — already numbers, already clamped.
    const { search, categoryId, page, limit } = req.validatedQuery;
    const skip = (page - 1) * limit;

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
        take: limit,
        orderBy: { name: "asc" },
      }),
      prisma.medicine.count({ where }),
    ]);

    // Stock is summed in its own query. The included `batches` array is capped
    // at the nearest-expiry batch — reducing over it reported that one batch's
    // quantity as the medicine's total, understating anything multi-batch.
    const stockByMedicine = medicines.length
      ? await prisma.batch.groupBy({
          by: ["medicineId"],
          where: {
            medicineId: { in: medicines.map((m) => m.id) },
            quantity: { gt: 0 },
          },
          _sum: { quantity: true },
        })
      : [];
    const totalStock = new Map(
      stockByMedicine.map((row) => [row.medicineId, row._sum.quantity ?? 0]),
    );

    // The single included batch is the FEFO one — what the POS would sell next,
    // and therefore the price and expiry worth showing.
    const result = medicines.map((m) => ({
      ...m,
      totalStock: totalStock.get(m.id) ?? 0,
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
    const { q } = req.validatedQuery;
    if (typeof q !== "string" || q.length < 2)
      return res.json({ success: true, data: [] });

    // A batch is good *through* the date printed on it (FR-BATCH-09), so the
    // cutoff is local midnight today — the same comparison billing.controller.js
    // makes when it refuses the sale.
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const medicines = await prisma.medicine.findMany({
      where: {
        isActive: true,
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { genericName: { contains: q, mode: "insensitive" } },
        ],
      },
      include: {
        // Every sellable batch, earliest expiry first, not just the first one.
        // The operator has to be able to choose (FR-BILL-19), and choosing needs
        // something to choose from.
        //
        // Expired batches are excluded rather than listed-and-disabled. They are
        // not a choice: the API refuses them outright and no role overrides that.
        // Leaving them in did real damage — because FEFO orders by expiry
        // ascending, an expired batch sorted to the *front* and became the
        // auto-attached default, so a medicine with good stock behind it could
        // not be sold at all until someone cleared the shelf.
        batches: {
          where: { quantity: { gt: 0 }, expiryDate: { gte: startOfToday } },
          orderBy: { expiryDate: "asc" },
          // Bounded: this runs on every keystroke. Twenty is far past what any
          // real medicine carries, and the ones past it are the longest-dated —
          // the last a FEFO shop would reach for.
          take: 20,
        },
        // Stock that exists but cannot be sold. Without this the response cannot
        // tell "we never stocked it" apart from "all of it is expired", and the
        // POS would print "No Stock" over a shelf that is full.
        _count: {
          select: {
            batches: {
              where: { quantity: { gt: 0 }, expiryDate: { lt: startOfToday } },
            },
          },
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
      // FEFO stays the default: these flattened fields are batches[0], and a
      // client that ignores `batches` entirely behaves exactly as it did before.
      batchId: m.batches[0]?.id || null,
      batchNumber: m.batches[0]?.batchNumber || "No Stock",
      expiryDate: m.batches[0]?.expiryDate || null,
      sellingPrice: m.batches[0]?.sellingPrice || 0,
      stock: m.batches[0]?.quantity || 0,
      batches: m.batches.map((b) => ({
        id: b.id,
        batchNumber: b.batchNumber,
        expiryDate: b.expiryDate,
        sellingPrice: b.sellingPrice,
        quantity: b.quantity,
      })),
      expiredBatches: m._count.batches,
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
