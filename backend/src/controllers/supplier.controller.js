const prisma = require("../config/db");

const getAll = async (req, res, next) => {
  try {
    const { search } = req.validatedQuery;
    const suppliers = await prisma.supplier.findMany({
      where: {
        shopId: req.user.shopId,
        ...(search && {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { phone: { contains: search } },
          ],
        }),
      },
      orderBy: { name: "asc" },
    });
    res.json({ success: true, data: suppliers });
  } catch (err) {
    next(err);
  }
};

const getOne = async (req, res, next) => {
  try {
    const supplier = await prisma.supplier.findFirst({
      where: { id: req.params.id, shopId: req.user.shopId },
      // No `purchases` include. It returned an array that was always empty —
      // not because this supplier had never sold us anything, but because no
      // code path has ever written a Purchase. An empty array is a claim, and
      // that one was false. If a goods-receipt flow is built, it comes back
      // with something real in it.
      include: {
        _count: { select: { batches: true } },
      },
    });
    if (!supplier)
      return res
        .status(404)
        .json({ success: false, message: "Supplier not found" });
    res.json({ success: true, data: supplier });
  } catch (err) {
    next(err);
  }
};

const create = async (req, res, next) => {
  try {
    const supplier = await prisma.supplier.create({
      data: { ...req.body, shopId: req.user.shopId },
    });
    res
      .status(201)
      .json({ success: true, message: "Supplier created", data: supplier });
  } catch (err) {
    next(err);
  }
};

const update = async (req, res, next) => {
  try {
    const result = await prisma.supplier.updateMany({
      where: { id: req.params.id, shopId: req.user.shopId },
      data: req.body,
    });
    if (result.count === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Supplier not found" });
    }
    const supplier = await prisma.supplier.findUnique({
      where: { id: req.params.id },
    });
    res.json({ success: true, message: "Supplier updated", data: supplier });
  } catch (err) {
    next(err);
  }
};

const remove = async (req, res, next) => {
  try {
    const result = await prisma.supplier.deleteMany({
      where: { id: req.params.id, shopId: req.user.shopId },
    });
    if (result.count === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Supplier not found" });
    }
    res.json({ success: true, message: "Supplier deleted" });
  } catch (err) {
    next(err);
  }
};

module.exports = { getAll, getOne, create, update, remove };
