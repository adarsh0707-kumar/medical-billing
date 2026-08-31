const { z } = require("zod");

// PUT /api/shop — the business details an administrator fills in once and an
// invoice header reads from ever after. Every field but the name is optional:
// a shop can print invoices with just a name, the way it always could before
// this existed, and fill in the rest as they get around to it.
//
// `.strict()`: this is the shop's own row, not a place to smuggle a shopId or
// an id through — there is exactly one shop this request could mean, the
// caller's own, and the controller never reads either from the body.
const updateShopSchema = z
  .object({
    name: z.string().min(2, "Shop name must be at least 2 characters"),
    address: z.string().max(500).optional().nullable(),
    phone: z.string().max(20).optional().nullable(),
    gstNumber: z.string().max(20).optional().nullable(),
    // Printed on the invoice header. A retail pharmacy dispenses under a
    // licence and is expected to show it on the bill.
    drugLicenceNo: z.string().max(40).optional().nullable(),
  })
  .strict();

module.exports = { updateShopSchema };
