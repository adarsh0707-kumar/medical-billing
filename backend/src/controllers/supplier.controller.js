const prisma = require("../config/db");

const getAll = async (req, res, next) => {
  try {
    const { search } = req.query;
    const suppliers = await prisma.supplier.findMany({
      where: search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { phone: { contains: search } },
            ],
          }
        : undefined,
      orderBy: { name: "asc" },
    });
    res.json({ success: true, data: suppliers });
  } catch (err) {
    next(err);
  }
};

const getOne = async (req, res, next) => {
  try {
    const supplier = await prisma.supplier.findUnique({
      where: { id: req.params.id },
      include: { purchases: { take: 10, orderBy: { date: "desc" } } },
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
    const supplier = await prisma.supplier.create({ data: req.body });
    res
      .status(201)
      .json({ success: true, message: "Supplier created", data: supplier });
  } catch (err) {
    next(err);
  }
};

const update = async (req, res, next) => {
  try {
    const supplier = await prisma.supplier.update({
      where: { id: req.params.id },
      data: req.body,
    });
    res.json({ success: true, message: "Supplier updated", data: supplier });
  } catch (err) {
    next(err);
  }
};

const remove = async (req, res, next) => {
  try {
    await prisma.supplier.delete({ where: { id: req.params.id } });
    res.json({ success: true, message: "Supplier deleted" });
  } catch (err) {
    next(err);
  }
};

module.exports = { getAll, getOne, create, update, remove };
