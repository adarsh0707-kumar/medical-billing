const prisma = require("../config/db");

const getAll = async (req, res, next) => {
  try {
    const { search, page, limit } = req.validatedQuery;
    const skip = (page - 1) * limit;
    const where = search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { phone: { contains: search } },
            { email: { contains: search, mode: "insensitive" } },
          ],
        }
      : {};
    const [customers, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        skip,
        take: limit,
        orderBy: { name: "asc" },
        include: { _count: { select: { invoices: true } } },
      }),
      prisma.customer.count({ where }),
    ]);
    res.json({
      success: true,
      data: customers,
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
    const customer = await prisma.customer.findUnique({
      where: { id: req.params.id },
      include: {
        invoices: {
          orderBy: { date: "desc" },
          take: 10,
          select: {
            id: true,
            invoiceNumber: true,
            date: true,
            totalAmount: true,
            paymentMode: true,
            paymentStatus: true,
          },
        },
      },
    });
    if (!customer)
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });
    res.json({ success: true, data: customer });
  } catch (err) {
    next(err);
  }
};

const create = async (req, res, next) => {
  try {
    const { name, phone, email, address, age, gender } = req.body;
    const customer = await prisma.customer.create({
      data: {
        name,
        phone,
        email,
        address,
        age: age ? Number(age) : null,
        gender: gender || null,
      },
    });
    res
      .status(201)
      .json({ success: true, message: "Customer created", data: customer });
  } catch (err) {
    next(err);
  }
};

const update = async (req, res, next) => {
  try {
    const { name, phone, email, address, age, gender } = req.body;
    const customer = await prisma.customer.update({
      where: { id: req.params.id },
      data: {
        name,
        phone,
        email,
        address,
        age: age ? Number(age) : null,
        gender: gender || null,
      },
    });
    res.json({ success: true, message: "Customer updated", data: customer });
  } catch (err) {
    next(err);
  }
};

module.exports = { getAll, getOne, create, update };
