import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { toCsv, money } from "../../src/utils/csv.js";

/**
 * FR-RPT-09 — the serialisation rules for exported reports.
 *
 * Unit-level because these are the rules a file has to obey to be safe to open
 * and correct to file with, and every one of them is invisible in a passing
 * integration test that only checks a 200.
 */

const rows = (csv) => csv.replace(/^﻿/, "").trim().split("\r\n");

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
    expect(csv.replace(/^﻿/, "").trim().split("\r\n")).toHaveLength(2);
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
