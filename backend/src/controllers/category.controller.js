const prisma = require("../config/db");

const getAll = async (req, res, next) => {
  try {
    const categories = await prisma.category.findMany({
      include: { _count: { select: { medicines: true } } },
      orderBy: { name: "asc" },
    });
    res.json({ success: true, data: categories });
  } catch (err) {
    next(err);
  }
};

const create = async (req, res, next) => {
  try {
    const category = await prisma.category.create({ data: req.body });
    res
      .status(201)
      .json({ success: true, message: "Category created", data: category });
  } catch (err) {
    next(err);
  }
};

const update = async (req, res, next) => {
  try {
    const category = await prisma.category.update({
      where: { id: req.params.id },
      data: req.body,
    });
    res.json({ success: true, message: "Category updated", data: category });
  } catch (err) {
    next(err);
  }
};

const remove = async (req, res, next) => {
  try {
    await prisma.category.delete({ where: { id: req.params.id } });
    res.json({ success: true, message: "Category deleted" });
  } catch (err) {
    next(err);
  }
};

module.exports = { getAll, create, update, remove };
