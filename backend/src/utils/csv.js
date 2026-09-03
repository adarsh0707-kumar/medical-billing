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
 * One row, formatted and escaped.
 *
 * A column is `{ header, get, kind }`. `kind` decides both the formatting and
 * whether the formula guard applies, which is why it is explicit rather than
 * inferred from the value — a money column that happened to be null on the first
 * row would otherwise be typed as text for the whole file.
 *
 * Extracted so `toCsv` and `streamCsv` cannot diverge. They are two ways of
 * delivering the same file, and G-21 is what happens when one export grows its
 * own idea of what a column contains: a second implementation of the escaping
 * rules would be the same defect with a different shape.
 */
const csvRow = (columns, row) =>
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
    .join(",");

const csvHeader = (columns) => columns.map((c) => escape(c.header)).join(",");

/**
 * Builds a CSV from a column spec and a list of rows, in memory.
 *
 * For reports that are bounded by their own shape — a month has at most 31
 * daily buckets, a year has 12, a top-ten is ten — where paging would add a
 * loop around a single query and nothing else. Everything that is one row per
 * *record* uses `streamCsv` instead.
 */
const toCsv = (columns, rows) =>
  // Trailing newline: POSIX convention, and some parsers drop the last record
  // without it.
  BOM +
  [csvHeader(columns), ...rows.map((row) => csvRow(columns, row))].join(EOL) +
  EOL;

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

/**
 * How many rows a streamed export pulls per query.
 *
 * Unrelated to `MAX_LIMIT`, which bounds what a *client* may ask a list
 * endpoint for (threat T-10). This is an internal read size: nobody chose it
 * from a query string and no request gets larger because of it. 500 rows of a
 * GST register is a few hundred kilobytes held at once, which keeps the memory
 * ceiling flat without making the round trips the dominant cost.
 */
const STREAM_PAGE = 500;

/**
 * Streams a CSV as a download, paging the query so memory stays flat.
 *
 * `fetchPage(skip, take)` returns the next slice of rows; the loop stops on the
 * first short page. Rows are formatted by `csvRow`, the same function `toCsv`
 * uses, so the escaping and the formula guard are shared rather than
 * reimplemented.
 *
 * **The first page is fetched before any header is sent.** That is deliberate:
 * once a `200` and the CSV headers are on the wire, a failure can no longer be
 * reported as a `500` with a message — the client has a file. Fetching first
 * means the overwhelmingly common failure (a bad query, a database that is
 * down) still arrives as a clean error through `next(err)`, and only a failure
 * *mid-file* falls to the destroy path below.
 *
 * If a later page throws, the response is destroyed rather than ended. A
 * truncated CSV that terminates cleanly is indistinguishable from a complete
 * one, and on a compliance document that is the worst available outcome — an
 * aborted transfer is a visible failure, which is what the caller needs.
 *
 * **An export is not a snapshot.** Pages are separate queries, so a row written
 * into the period *while the file is being written* may land in no page or in
 * two. The reports that stream are either over a closed period — a past day, a
 * filed month — where nothing is being written any more, or live stock views
 * where the reader is looking at a moving shelf regardless. Making it a true
 * snapshot means holding a repeatable-read transaction open for the length of
 * the download, which trades a connection for a guarantee no reader here has
 * asked for.
 */
const streamCsv = async (res, filename, columns, fetchPage, { logger } = {}) => {
  let skip = 0;
  let rows = await fetchPage(skip, STREAM_PAGE);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.write(BOM + csvHeader(columns) + EOL);

  try {
    while (rows.length) {
      // One write per page rather than per row: the same bytes, an order of
      // magnitude fewer syscalls, and still a bounded buffer.
      res.write(rows.map((row) => csvRow(columns, row)).join(EOL) + EOL);
      if (rows.length < STREAM_PAGE) break;
      skip += STREAM_PAGE;
      rows = await fetchPage(skip, STREAM_PAGE);
    }
    res.end();
  } catch (err) {
    logger?.error(
      { err, filename, rowsWritten: skip },
      "csv export failed mid-file; connection destroyed rather than truncated",
    );
    res.destroy(err);
  }
};

module.exports = {
  toCsv,
  sendCsv,
  streamCsv,
  money,
  isoDate,
  isoDateTime,
  BOM,
  EOL,
  STREAM_PAGE,
};
