const prisma = require("../config/db");
const { eraseCustomer } = require("../utils/erase-customer");

const getAll = async (req, res, next) => {
  try {
    const { search, page, limit } = req.validatedQuery;
    const skip = (page - 1) * limit;
    const where = {
      shopId: req.user.shopId,
      ...(search && {
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { phone: { contains: search } },
          { email: { contains: search, mode: "insensitive" } },
        ],
      }),
    };
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

// Purchase history in a pharmacy reveals health conditions, so who may read it
// is a real decision rather than a default (threat T-9, docs/07 section 3).
//
// A cashier needs to find a customer and attach them to a sale — name, phone,
// contact details — and the POS is unaffected by this. A cashier does not need
// to browse what somebody has been buying, and until now every role could, with
// nothing recording that they had.
//
// One line to reverse if the shop decides otherwise; see docs/07 section 3.
const HISTORY_ROLES = ["ADMIN", "PHARMACIST"];

const getOne = async (req, res, next) => {
  try {
    const mayReadHistory = HISTORY_ROLES.includes(req.user.role);

    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id, shopId: req.user.shopId },
      include: {
        invoices: mayReadHistory
          ? {
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
            }
          : false,
      },
    });
    if (!customer)
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });
    // Absent rather than empty: an empty array would read as "this customer has
    // never bought anything", which is a different and false statement.
    res.json({
      success: true,
      data: mayReadHistory ? customer : { ...customer, invoices: undefined },
    });
  } catch (err) {
    next(err);
  }
};

const create = async (req, res, next) => {
  try {
    const { name, phone, email, address, age, gender } = req.body;
    const customer = await prisma.customer.create({
      data: {
        shopId: req.user.shopId,
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
    const result = await prisma.customer.updateMany({
      where: { id: req.params.id, shopId: req.user.shopId },
      data: {
        name,
        phone,
        email,
        address,
        age: age ? Number(age) : null,
        gender: gender || null,
      },
    });
    if (result.count === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });
    }
    const customer = await prisma.customer.findUnique({
      where: { id: req.params.id },
    });
    res.json({ success: true, message: "Customer updated", data: customer });
  } catch (err) {
    next(err);
  }
};

// ─── Erase (right to erasure) ──────────────────────────
// Not a delete: invoices reference this row and are append-only tax records, so
// the personal fields are blanked in place instead (PRD Q6). ADMIN only.
const erase = async (req, res, next) => {
  try {
    const result = await eraseCustomer(req.params.id, req.user.shopId);

    if (!result.found) {
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });
    }
    if (result.alreadyErased) {
      return res.json({
        success: true,
        message: `This customer's details were already erased on ${result.at.toISOString().slice(0, 10)}.`,
      });
    }

    res.json({
      success: true,
      message:
        "Customer details erased. Their invoices are unchanged — they remain tax records and still reconcile.",
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { getAll, getOne, create, update, erase };
