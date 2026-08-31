const { Prisma } = require("@prisma/client");
const prisma = require("../config/db");

// Money stays exact all the way to the response boundary, where the app's json
// replacer turns it into a number — and to the CSV, where it must not.
const Decimal = Prisma.Decimal;

/**
 * The daily sales trend, bucketed by the store's day.
 *
 * One implementation, used by `GET /api/reports/trend` and by the dashboard.
 * The two carried identical copies of this SQL with a comment saying they "must
 * agree" — which held only for as long as nobody edited one of them, and left
 * the same defect to be fixed twice.
 *
 * ─── Why the timezone dance ──────────────────────────────────────────────────
 *
 * `Invoice.date` is `timestamp without time zone` holding a UTC instant, so
 * `date_trunc('day', "date")` truncates in **UTC** — it has no zone to consult.
 * The caller then builds its day keys from local components, because the store's
 * day is what a shopkeeper means by "yesterday". East of Greenwich those two
 * disagree for the first hours of every day.
 *
 * Measured in IST (UTC+5:30): a sale at 02:00 local on the 27th is 20:30 UTC on
 * the 26th, so the SQL filed it under the 26th while the loop looked for it
 * under the 27th. It landed on yesterday's bar and today read zero — with the
 * daily summary, which draws its boundaries in JS, insisting the sale was
 * today. Two screens, one sale, two different days.
 *
 * Converting to local wall time before truncating fixes it: the naked timestamp
 * is labelled UTC, converted into the application's zone, and truncated there.
 * An IANA zone name rather than a fixed offset, so a store in a DST zone stays
 * correct across the transition.
 *
 * In UTC — which is what CI runs in — this is an identity, so the behaviour
 * there is unchanged and a regression here cannot be caught by CI alone. The
 * guard has to be an assertion that the trend and the daily summary agree about
 * a given sale, which is true in both zones and false only when this breaks.
 */
const APP_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/**
 * Rows of `{ day, invoices, sales }` for the window, one per day that had
 * activity. Days with none are absent — the caller zero-fills, because only it
 * knows how wide a window it is drawing.
 *
 * `sales` sums every document, so a credit note nets its sale out. `invoices`
 * counts sales only, so a bar can never read "1 invoice, ₹0".
 *
 * `paymentStatus = 'PAID'` because this charts takings, not billings. The daily
 * summary deliberately counts everything raised; the two answer different
 * questions and both are asserted.
 */
const dailyTrend = (client, start, end, shopId, timeZone = APP_TIME_ZONE) =>
  client.$queryRaw`
    SELECT to_char(
             date_trunc('day', "date" AT TIME ZONE 'UTC' AT TIME ZONE ${timeZone}),
             'YYYY-MM-DD'
           )                                              AS day,
           COUNT(*) FILTER (WHERE "type" = 'SALE')::int   AS invoices,
           COALESCE(SUM("totalAmount"), 0)                AS sales
    FROM "Invoice"
    WHERE "shopId" = ${shopId}
      AND "date" >= ${start} AND "date" <= ${end}
      AND "paymentStatus" = 'PAID'::"PaymentStatus"
    GROUP BY 1
    ORDER BY 1`;

/**
 * Sales bucketed by day or by month over an arbitrary window.
 *
 * Backs the monthly and yearly reports (FR-RPT-10, FR-RPT-11), where the
 * breakdown has to add up to the headline the same screen prints.
 *
 * ─── Why this is not `dailyTrend` with a wider window ────────────────────────
 *
 * `dailyTrend` filters `paymentStatus = 'PAID'`, because a chart of *takings*
 * should not draw money nobody has handed over yet. The period summaries count
 * every document raised, paid or not — the same basis the daily summary has
 * always used, and the one a shopkeeper means by "what did we bill in August".
 *
 * Reusing `dailyTrend` here would therefore have drawn bars that did not sum to
 * the total printed above them, off by exactly the credit sales. Two numbers on
 * one screen disagreeing, each correct by its own definition, is the shape of
 * defect this file already exists to prevent — so the period reports get a
 * query on their own basis, and a test asserts the bars sum to the headline.
 *
 * `trunc` and `format` are bound parameters like any other — Postgres takes the
 * field name of `date_trunc` and the pattern of `to_char` as text arguments —
 * so this is a `$queryRaw` tagged template with nothing interpolated into the
 * statement. They still come from a fixed map rather than the caller's string,
 * because a typo should be a bug here and not an error from the database.
 */
const BUCKETS = {
  day: { trunc: "day", format: "YYYY-MM-DD" },
  month: { trunc: "month", format: "YYYY-MM" },
};

const bucketedSales = (
  { start, end, bucket, shopId, timeZone = APP_TIME_ZONE },
  client = prisma,
) => {
  const { trunc, format } = BUCKETS[bucket] ?? BUCKETS.day;
  return client.$queryRaw`
    SELECT to_char(
             date_trunc(${trunc}, "date" AT TIME ZONE 'UTC' AT TIME ZONE ${timeZone}),
             ${format}
           )                                              AS bucket,
           COUNT(*) FILTER (WHERE "type" = 'SALE')::int   AS invoices,
           COUNT(*) FILTER (WHERE "type" = 'CREDIT_NOTE')::int AS "creditNotes",
           COALESCE(SUM("totalAmount"), 0)                AS sales
    FROM "Invoice"
    WHERE "shopId" = ${shopId}
      AND "date" >= ${start} AND "date" <= ${end}
    GROUP BY 1
    ORDER BY 1`;
};

/** `YYYY-MM-DD` for a date's **local** day — the key `dailyTrend` returns. */
/**
 * Revenue and cost of goods, bucketed the same way (FR-RPT-08).
 *
 * Lives here rather than in the controller for one reason: the day boundary.
 * `date_trunc` on a naked UTC timestamp buckets in UTC, which put early-morning
 * sales on the previous day everywhere east of Greenwich and made the dashboard
 * and the daily summary disagree about the same sale. That is fixed once, in
 * `APP_TIME_ZONE` and the two statements above, and a third copy of the
 * conversion is how it comes back. (The file's name is now narrower than its
 * contents — it holds the period aggregations, of which the trend is one.)
 *
 * **Two statements, not a join, because the grain differs.** Revenue is a
 * property of the invoice and cost is a property of its lines, so summing both
 * across one join would multiply each invoice's revenue by its line count. They
 * are grouped separately and merged on the bucket key, of which there are at
 * most 31.
 *
 * **Revenue is `subtotal − discountAmt`: what the shop keeps, before tax.**
 * Not `totalAmount`, which includes GST the shop collects and remits and never
 * owns — counting it would overstate profit by the tax. Both columns are stored,
 * so nothing is re-derived here (G-21): a credit note already holds both negated,
 * which is what makes a reversal net itself out of its own period without a
 * special case.
 *
 * **Cost is the batch's `purchasePrice` at the quantity sold**, negated for a
 * credit note — returned stock is back on the shelf, so its cost comes off the
 * period that took it back. Credit-note lines carry a positive `quantity` and a
 * negative `totalPrice`, so the sign has to be taken from the invoice's type
 * rather than from the line.
 *
 * `unpricedLines` counts lines whose batch cost is zero. `purchasePrice` is
 * validated positive, so a zero means the cost was never really recorded — and a
 * zero cost is indistinguishable from free stock in the arithmetic, which would
 * read as 100% margin. Counting them lets the report say so instead.
 */
const bucketedMargin = async (
  { start, end, bucket, shopId, timeZone = APP_TIME_ZONE },
  client = prisma,
) => {
  const { trunc, format } = BUCKETS[bucket] ?? BUCKETS.day;

  const [revenueRows, costRows] = await Promise.all([
    client.$queryRaw`
      SELECT to_char(
               date_trunc(${trunc}, "date" AT TIME ZONE 'UTC' AT TIME ZONE ${timeZone}),
               ${format}
             )                                          AS bucket,
             COALESCE(SUM("subtotal" - "discountAmt"), 0) AS revenue
      FROM "Invoice"
      WHERE "shopId" = ${shopId}
        AND "date" >= ${start} AND "date" <= ${end}
      GROUP BY 1
      ORDER BY 1`,
    client.$queryRaw`
      SELECT to_char(
               date_trunc(${trunc}, i."date" AT TIME ZONE 'UTC' AT TIME ZONE ${timeZone}),
               ${format}
             )                                          AS bucket,
             COALESCE(SUM(
               b."purchasePrice" * ii."quantity"
               * (CASE WHEN i."type" = 'CREDIT_NOTE' THEN -1 ELSE 1 END)
             ), 0)                                      AS cost,
             COUNT(*) FILTER (WHERE b."purchasePrice" = 0)::int AS "unpricedLines"
      FROM "InvoiceItem" ii
      JOIN "Invoice" i ON i."id" = ii."invoiceId"
      JOIN "Batch"   b ON b."id" = ii."batchId"
      WHERE i."shopId" = ${shopId}
        AND i."date" >= ${start} AND i."date" <= ${end}
      GROUP BY 1
      ORDER BY 1`,
  ]);

  const merged = new Map();
  const at = (key) => {
    if (!merged.has(key)) {
      merged.set(key, {
        bucket: key,
        revenue: new Decimal(0),
        cost: new Decimal(0),
        unpricedLines: 0,
      });
    }
    return merged.get(key);
  };

  for (const r of revenueRows) at(r.bucket).revenue = new Decimal(r.revenue);
  for (const c of costRows) {
    const row = at(c.bucket);
    row.cost = new Decimal(c.cost);
    row.unpricedLines = c.unpricedLines;
  }

  return [...merged.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
};

const localDayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Zero-fills a window of `days` ending today, oldest first.
 *
 * Days with no sales still appear. A missing one would silently shift every
 * later point left on the chart, which reads as a trend rather than a gap.
 */
const fillWindow = (rows, days, now = new Date()) => {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = localDayKey(d);
    const row = byDay.get(key);
    out.push({
      date: key,
      sales: row ? Number(row.sales) : 0,
      invoices: row ? row.invoices : 0,
    });
  }
  return out;
};

/** The whole thing: query the window and zero-fill it. */
const trendForDays = async (
  days,
  shopId,
  client = prisma,
  now = new Date(),
) => {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  const start = new Date(now);
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);

  return fillWindow(await dailyTrend(client, start, end, shopId), days, now);
};

module.exports = {
  dailyTrend,
  bucketedSales,
  bucketedMargin,
  fillWindow,
  localDayKey,
  trendForDays,
  APP_TIME_ZONE,
};
