const prisma = require("../config/db");

const getAll = async (req, res, next) => {
  try {
    const manufacturers = await prisma.manufacturer.findMany({
      where: { shopId: req.user.shopId },
      include: { _count: { select: { medicines: true } } },
      orderBy: { name: "asc" },
    });
    res.json({ success: true, data: manufacturers });
  } catch (err) {
    next(err);
  }
};

const create = async (req, res, next) => {
  try {
    const manufacturer = await prisma.manufacturer.create({
      data: { ...req.body, shopId: req.user.shopId },
    });
    res.status(201).json({
      success: true,
      message: "Manufacturer created",
      data: manufacturer,
    });
  } catch (err) {
    next(err);
  }
};

// See category.controller.js for why this is updateMany/deleteMany + a count
// check rather than update/delete by bare id: the where clause is the tenant
// boundary, so it has to include shopId, and Prisma's singular update/delete
// take only a unique selector.
const update = async (req, res, next) => {
  try {
    const result = await prisma.manufacturer.updateMany({
      where: { id: req.params.id, shopId: req.user.shopId },
      data: req.body,
    });
    if (result.count === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Manufacturer not found." });
    }
    const manufacturer = await prisma.manufacturer.findUnique({
      where: { id: req.params.id },
    });
    res.json({
      success: true,
      message: "Manufacturer updated",
      data: manufacturer,
    });
  } catch (err) {
    next(err);
  }
};

const remove = async (req, res, next) => {
  try {
    const result = await prisma.manufacturer.deleteMany({
      where: { id: req.params.id, shopId: req.user.shopId },
    });
    if (result.count === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Manufacturer not found." });
    }
    res.json({ success: true, message: "Manufacturer deleted" });
  } catch (err) {
    next(err);
  }
};

module.exports = { getAll, create, update, remove };
