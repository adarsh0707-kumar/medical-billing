const prisma = require("../config/db");

const generateInvoiceNumber = async () => {
  const today = new Date();
  const year = today.getFullYear().toString().slice(-2);
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  const prefix = `INV${year}${month}${day}`;

  // Count today's invoices
  const startOfDay = new Date(today.setHours(0, 0, 0, 0));
  const count = await prisma.invoice.count({
    where: { createdAt: { gte: startOfDay } },
  });

  const serial = String(count + 1).padStart(4, "0");
  return `${prefix}-${serial}`;
};

const generatePurchaseNumber = async () => {
  const today = new Date();
  const year = today.getFullYear().toString().slice(-2);
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const prefix = `PO${year}${month}`;

  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const count = await prisma.purchase.count({
    where: { createdAt: { gte: startOfMonth } },
  });

  const serial = String(count + 1).padStart(4, "0");
  return `${prefix}-${serial}`;
};

module.exports = { generateInvoiceNumber, generatePurchaseNumber };
