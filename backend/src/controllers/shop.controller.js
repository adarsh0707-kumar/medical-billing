const prisma = require("../config/db");

// GET /api/shop — every authenticated role, not just ADMIN: the invoice
// header needs this to print, and printing a bill is a cashier's job as much
// as an admin's. There's nothing sensitive in a shop's own name, address,
// phone or GST number — it's the information already printed on every
// invoice the shop hands a customer.
const getShop = async (req, res, next) => {
  try {
    const shop = await prisma.shop.findUnique({
      where: { id: req.user.shopId },
      select: {
        id: true,
        name: true,
        address: true,
        phone: true,
        gstNumber: true,
        drugLicenceNo: true,
      },
    });
    res.json({ success: true, data: shop });
  } catch (err) {
    next(err);
  }
};

// PUT /api/shop — ADMIN only (enforced by the route). Always the caller's own
// shop: there's no id in the request to target another one, and the
// `where: { id: req.user.shopId }` below is what makes that structural rather
// than just unrequested.
const updateShop = async (req, res, next) => {
  try {
    const shop = await prisma.shop.update({
      where: { id: req.user.shopId },
      data: req.body,
      select: {
        id: true,
        name: true,
        address: true,
        phone: true,
        gstNumber: true,
        drugLicenceNo: true,
      },
    });
    res.json({ success: true, message: "Shop details updated", data: shop });
  } catch (err) {
    next(err);
  }
};

module.exports = { getShop, updateShop };
