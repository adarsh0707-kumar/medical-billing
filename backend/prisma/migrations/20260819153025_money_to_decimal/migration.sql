-- Money and tax rates move from `double precision` to exact `numeric`.
--
-- Floats cannot represent most decimal fractions, so per-line values were
-- rounded for display while invoice-level totals accumulated the unrounded
-- binary error. Summing thousands of those in the monthly GST report drifted
-- from the sum of the printed invoices — the figure that goes on a tax filing.
--
-- Postgres rounds half-up when casting double precision to a scaled numeric,
-- so existing rows land on the value that was already being displayed.

-- Tax rates: 0 / 5 / 12 / 18, and line discount percentages.
ALTER TABLE "Medicine"
  ALTER COLUMN "gstPercent" SET DATA TYPE DECIMAL(5,2);

ALTER TABLE "InvoiceItem"
  ALTER COLUMN "discount"   SET DATA TYPE DECIMAL(5,2),
  ALTER COLUMN "gstPercent" SET DATA TYPE DECIMAL(5,2);

-- Currency.
ALTER TABLE "Batch"
  ALTER COLUMN "purchasePrice" SET DATA TYPE DECIMAL(12,2),
  ALTER COLUMN "sellingPrice"  SET DATA TYPE DECIMAL(12,2);

ALTER TABLE "InvoiceItem"
  ALTER COLUMN "unitPrice"  SET DATA TYPE DECIMAL(12,2),
  ALTER COLUMN "totalPrice" SET DATA TYPE DECIMAL(12,2);

ALTER TABLE "Invoice"
  ALTER COLUMN "subtotal"    SET DATA TYPE DECIMAL(12,2),
  ALTER COLUMN "discountAmt" SET DATA TYPE DECIMAL(12,2),
  ALTER COLUMN "cgst"        SET DATA TYPE DECIMAL(12,2),
  ALTER COLUMN "sgst"        SET DATA TYPE DECIMAL(12,2),
  ALTER COLUMN "totalAmount" SET DATA TYPE DECIMAL(12,2);

ALTER TABLE "Purchase"
  ALTER COLUMN "totalAmount" SET DATA TYPE DECIMAL(12,2);

ALTER TABLE "PurchaseItem"
  ALTER COLUMN "costPrice" SET DATA TYPE DECIMAL(12,2);
