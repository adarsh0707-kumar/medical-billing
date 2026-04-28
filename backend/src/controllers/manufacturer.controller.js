const prisma = require("../config/db");

const getAll = async (req, res, next) => {
  try {
    const manufacturers = await prisma.manufacturer.findMany({
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
    const manufacturer = await prisma.manufacturer.create({ data: req.body });
    res
      .status(201)
      .json({
        success: true,
        message: "Manufacturer created",
        data: manufacturer,
      });
  } catch (err) {
    next(err);
  }
};

const update = async (req, res, next) => {
  try {
    const manufacturer = await prisma.manufacturer.update({
      where: { id: req.params.id },
      data: req.body,
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
    await prisma.manufacturer.delete({ where: { id: req.params.id } });
    res.json({ success: true, message: "Manufacturer deleted" });
  } catch (err) {
    next(err);
  }
};

module.exports = { getAll, create, update, remove };
