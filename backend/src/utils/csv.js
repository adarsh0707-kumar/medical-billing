const { Prisma } = require("@prisma/client");

/**
 * CSV generation for the report exports (FR-RPT-09).
 *
 * Deliberately not `res.json`. The app sets a `json replacer` that unwraps every
 * `Prisma.Decimal` to a JavaScript number, which is right for the API — the
 * client does arithmetic on those values — and wrong for a file that goes to an
 * accountant. `0.1 + 0.2` is a rounding curiosity in a browser and a filing
 * error in a GST return, so money leaves here as the 2 dp string the column
 * actually holds, never as a float that happens to print correctly today.
 */

/**
 * Excel on Windows reads a BOM-less file as the system codepage, which turns
 * every non-ASCII medicine name into mojibake. The BOM costs three bytes and is
 * ignored by every parser that matters.
 */
const BOM = "\uFEFF";

/** RFC 4180 says CRLF, and Excel is the consumer that cares. */
const EOL = "\r\n";

/**
 * A field must be quoted if it contains the delimiter, a quote, or a line break.
 * Inside quotes, a literal `"` is doubled.
 */
const QUOTE_IF = /[",\r\n]/;

/**
 * Formula injection (OWASP). A spreadsheet treats a cell opening with any of
 * these as an expression, so a medicine entered as `=1+1` — or something far
 * worse aimed at whoever opens the file — executes on open. Every text column
 * here is operator-entered, and the whole point of an export is that the file
 * leaves the application, so the guard belongs at the point of writing.
 *
 * Applied to text only. Money and numbers are emitted by our own formatters and
 * can legitimately open with `-` (a credit note is negative); prefixing those
 * would turn a number the accountant needs to sum into text.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

const escape = (text) => {
  const s = String(text);
  return QUOTE_IF.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Money exactly as stored: two decimal places, from the Decimal itself.
 *
 * `.toFixed(2)` on a Decimal is exact. Going via Number first would round-trip
 * through a float, which is the one thing this whole module exists to avoid.
 */
const money = (value) =>
  value === null || value === undefined
    ? ""
    : new Prisma.Decimal(value).toFixed(2);

/** ISO date, so it sorts as text and cannot be read as either D/M or M/D. */
const isoDate = (value) =>
  value ? new Date(value).toISOString().slice(0, 10) : "";

/** ISO date and time to the minute, for rows where two invoices share a day. */
const isoDateTime = (value) =>
  value ? new Date(value).toISOString().slice(0, 16).replace("T", " ") : "";

const FORMATTERS = {
  money,
  date: isoDate,
  datetime: isoDateTime,
  number: (v) => (v === null || v === undefined ? "" : String(v)),
  text: (v) => (v === null || v === undefined ? "" : String(v)),
};

/**
 * Builds a CSV from a column spec and a list of rows.
 *
 * A column is `{ header, get, kind }`. `kind` decides both the formatting and
 * whether the formula guard applies, which is why it is explicit rather than
 * inferred from the value — a money column that happened to be null on the first
 * row would otherwise be typed as text for the whole file.
 */
const toCsv = (columns, rows) => {
  const header = columns.map((c) => escape(c.header)).join(",");

  const body = rows.map((row) =>
    columns
      .map((col) => {
        const kind = col.kind ?? "text";
        const formatted = FORMATTERS[kind](col.get(row));
        // Only text can carry a formula; see FORMULA_LEAD.
        const guarded =
          kind === "text" && FORMULA_LEAD.test(formatted)
            ? `'${formatted}`
            : formatted;
        return escape(guarded);
      })
      .join(","),
  );

  // Trailing newline: POSIX convention, and some parsers drop the last record
  // without it.
  return BOM + [header, ...body].join(EOL) + EOL;
};

/**
 * Sends a CSV as a download.
 *
 * `res.send` rather than `res.json`, so the Decimal-to-Number replacer never
 * sees these values.
 */
const sendCsv = (res, filename, csv) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`,
  );
  res.send(csv);
};

module.exports = { toCsv, sendCsv, money, isoDate, isoDateTime, BOM, EOL };
