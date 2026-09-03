import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import {
  toCsv,
  streamCsv,
  money,
  STREAM_PAGE,
} from "../../src/utils/csv.js";

/**
 * FR-RPT-09 — the serialisation rules for exported reports.
 *
 * Unit-level because these are the rules a file has to obey to be safe to open
 * and correct to file with, and every one of them is invisible in a passing
 * integration test that only checks a 200.
 */

const rows = (csv) => csv.replace(/^\uFEFF/, "").trim().split("\r\n");

describe("CSV money serialisation", () => {
  // The reason this module exists rather than reusing res.json.
  it("writes money as the stored 2 dp string, never a float", () => {
    const csv = toCsv(
      [{ header: "Total", kind: "money", get: (r) => r.total }],
      [{ total: new Prisma.Decimal("0.10").plus("0.20") }],
    );

    expect(rows(csv)[1]).toBe("0.30");
    // What the API's Decimal-to-Number replacer would have produced.
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it("keeps trailing zeros, which a Number would drop", () => {
    const csv = toCsv(
      [{ header: "Total", kind: "money", get: (r) => r.total }],
      [{ total: new Prisma.Decimal("274.40") }, { total: new Prisma.Decimal("500") }],
    );

    // 274.4 and 500 would not line up in a column an accountant reads.
    expect(rows(csv).slice(1)).toEqual(["274.40", "500.00"]);
  });

  it("survives a value beyond what a double can hold exactly", () => {
    // 12 digits + 2 dp is what DECIMAL(12,2) allows; past 2^53 a Number rounds.
    const exact = "9007199254740993.01";
    expect(money(new Prisma.Decimal(exact))).toBe(exact);
    expect(String(Number(exact))).not.toBe(exact);
  });

  it("writes an empty cell for null rather than the word null", () => {
    const csv = toCsv(
      [
        { header: "Invoice", get: (r) => r.invoiceNumber },
        { header: "Total", kind: "money", get: (r) => r.total },
      ],
      [{ invoiceNumber: "INV-1", total: null }],
    );
    // A second column, because a lone empty field makes the whole record an
    // empty line and `trim()` in the helper would eat it.
    expect(rows(csv)[1]).toBe("INV-1,");
  });
});

describe("CSV escaping", () => {
  const text = [{ header: "Name", get: (r) => r.name }];

  it("quotes a field containing the delimiter", () => {
    expect(rows(toCsv(text, [{ name: "Vitamin B, complex" }]))[1]).toBe(
      '"Vitamin B, complex"',
    );
  });

  it("doubles an embedded quote", () => {
    expect(rows(toCsv(text, [{ name: 'Tab "500"' }]))[1]).toBe('"Tab ""500"""');
  });

  it("quotes a field containing a line break, keeping one record per row", () => {
    const csv = toCsv(text, [{ name: "Line1\nLine2" }]);
    // Two physical lines, still one logical record: the split on CRLF sees the
    // header and one row, because the embedded break is a bare LF inside quotes.
    expect(csv.replace(/^\uFEFF/, "").trim().split("\r\n")).toHaveLength(2);
    expect(csv).toContain('"Line1\nLine2"');
  });

  it("emits a UTF-8 BOM and CRLF line endings for Excel", () => {
    const csv = toCsv(text, [{ name: "Paracetamol" }]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain("\r\n");
    expect(csv.endsWith("\r\n")).toBe(true);
  });
});

describe("CSV formula injection", () => {
  const text = [{ header: "Name", get: (r) => r.name }];

  // GUARD G-21 — a spreadsheet executes a cell that opens with these. Every
  // text column in every export is operator-entered free text.
  it.each(["=1+1", "+1", "-1+1", "@SUM(A1)", "\tx", "=HYPERLINK(\"http://x\")"])(
    "neutralises a name starting with %j",
    (name) => {
      const cell = rows(toCsv(text, [{ name }]))[1];
      expect(cell.replace(/^"/, "").startsWith("'")).toBe(true);
    },
  );

  it("leaves a negative money value alone so it still sums", () => {
    // A credit note is negative and opens with `-`. Guarding it would turn the
    // one column the accountant has to add up into text.
    const csv = toCsv(
      [{ header: "Total", kind: "money", get: (r) => r.total }],
      [{ total: new Prisma.Decimal("-87.36") }],
    );
    expect(rows(csv)[1]).toBe("-87.36");
  });

  it("leaves an ordinary name untouched", () => {
    expect(rows(toCsv(text, [{ name: "Paracetamol 500mg" }]))[1]).toBe(
      "Paracetamol 500mg",
    );
  });
});

/**
 * The streamed writer produces the same file as the in-memory one.
 *
 * `streamCsv` exists because five exports are one row per record and a register
 * cannot stop at whatever fit in memory. What it must *not* be is a second
 * implementation of the escaping and the formula guard — that is G-21's shape
 * exactly, an export growing its own idea of what a column contains. Both go
 * through `csvRow`, and this is what holds them there.
 */
describe("streamCsv", () => {
  const COLUMNS = [
    { header: "Name", get: (r) => r.name },
    { header: "Total", kind: "money", get: (r) => r.total },
    { header: "When", kind: "date", get: (r) => r.when },
  ];

  const row = (i) => ({
    // Every hazard the escaping rules cover, in one fixture: a comma, a quote,
    // a newline, and a leading `=`.
    name: `=Paracetamol, "500mg"\n#${i}`,
    total: new Prisma.Decimal(i).dividedBy(100).toFixed(2),
    when: new Date(Date.UTC(2026, 2, 12)),
  });

  /** A response double that records what would go on the wire. */
  const fakeRes = () => {
    const chunks = [];
    return {
      headers: {},
      chunks,
      setHeader(k, v) {
        this.headers[k.toLowerCase()] = v;
      },
      write(chunk) {
        chunks.push(chunk);
        return true;
      },
      end() {
        this.ended = true;
      },
      destroy(err) {
        this.destroyedWith = err;
      },
      get body() {
        return chunks.join("");
      },
    };
  };

  /** Pages an array the way Prisma pages a table. */
  const pager = (all) => (skip, take) =>
    Promise.resolve(all.slice(skip, skip + take));

  it("writes byte-for-byte what toCsv would have built", async () => {
    // Deliberately past STREAM_PAGE, so the assertion covers the page joins —
    // the boundary where a hand-rolled writer drops or doubles a line break.
    const all = Array.from({ length: STREAM_PAGE * 2 + 7 }, (_, i) => row(i));
    const res = fakeRes();

    await streamCsv(res, "x.csv", COLUMNS, pager(all));

    expect(res.body).toBe(toCsv(COLUMNS, all));
    expect(res.ended).toBe(true);
  });

  it("sends the same download headers as sendCsv", async () => {
    const res = fakeRes();

    await streamCsv(res, "prescription-register.csv", COLUMNS, pager([row(1)]));

    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="prescription-register.csv"',
    );
  });

  it("writes a header and nothing else when there are no rows", async () => {
    const res = fakeRes();

    await streamCsv(res, "x.csv", COLUMNS, pager([]));

    expect(res.body).toBe(toCsv(COLUMNS, []));
  });

  // An export whose last page fails must not look finished. A CSV that ends
  // cleanly is indistinguishable from a complete one, which on a compliance
  // document is the worst available outcome.
  it("destroys the response rather than ending a truncated file", async () => {
    const all = Array.from({ length: STREAM_PAGE + 1 }, (_, i) => row(i));
    const boom = new Error("connection lost");
    const res = fakeRes();

    await streamCsv(res, "x.csv", COLUMNS, (skip, take) =>
      skip === 0 ? Promise.resolve(all.slice(0, take)) : Promise.reject(boom),
    );

    expect(res.ended).toBeUndefined();
    expect(res.destroyedWith).toBe(boom);
  });

  // The first page is fetched before any header goes out, so the common
  // failure is still a clean 500 through the controller's catch.
  it("lets a first-page failure throw before the response is touched", async () => {
    const res = fakeRes();
    const boom = new Error("database down");

    await expect(
      streamCsv(res, "x.csv", COLUMNS, () => Promise.reject(boom)),
    ).rejects.toBe(boom);

    expect(res.headers).toEqual({});
    expect(res.chunks).toEqual([]);
  });
});
