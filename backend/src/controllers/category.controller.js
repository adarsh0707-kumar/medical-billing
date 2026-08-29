const prisma = require("../config/db");

const getAll = async (req, res, next) => {
  try {
    const categories = await prisma.category.findMany({
      where: { shopId: req.user.shopId },
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
    const category = await prisma.category.create({
      data: { ...req.body, shopId: req.user.shopId },
    });
    res
      .status(201)
      .json({ success: true, message: "Category created", data: category });
  } catch (err) {
    next(err);
  }
};

// updateMany/deleteMany scoped by shopId rather than update/delete by id alone
// — otherwise a valid category id from a different shop would 404 by accident
// today and by nothing tomorrow, once ids from two shops can collide in a
// support ticket or a script. Scoping the where clause makes the boundary the
// query itself enforces, not a coincidence of who happens to guess right.
const update = async (req, res, next) => {
  try {
    const result = await prisma.category.updateMany({
      where: { id: req.params.id, shopId: req.user.shopId },
      data: req.body,
    });
    if (result.count === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Category not found." });
    }
    const category = await prisma.category.findUnique({
      where: { id: req.params.id },
    });
    res.json({ success: true, message: "Category updated", data: category });
  } catch (err) {
    next(err);
  }
};

const remove = async (req, res, next) => {
  try {
    const result = await prisma.category.deleteMany({
      where: { id: req.params.id, shopId: req.user.shopId },
    });
    if (result.count === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Category not found." });
    }
    res.json({ success: true, message: "Category deleted" });
  } catch (err) {
    next(err);
  }
};

module.exports = { getAll, create, update, remove };
