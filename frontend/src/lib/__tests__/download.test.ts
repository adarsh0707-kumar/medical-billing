import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import MockAdapter from "axios-mock-adapter";
import api from "@/lib/api";
import { downloadCsv } from "@/lib/download";

/**
 * FR-RPT-09 — the client's half of the export.
 *
 * GUARD G-21. The GST CSV used to be assembled in the browser, and its tax
 * columns were invented: `totalAmount * 0.8` for taxable and `* 0.1` for each of
 * CGST and SGST, a fixed 25% applied to invoices actually charged at 0, 5, 12 or
 * 18. On live data that overstated a month's CGST by 87% — in the one file whose
 * whole purpose is to be filed.
 *
 * These assert the client asks the server for the bytes and does not compute
 * them, which is the property that stops it happening again.
 */

let mock: MockAdapter;
let clicked: HTMLAnchorElement[];

beforeEach(() => {
  mock = new MockAdapter(api);
  clicked = [];
  // jsdom has no download behaviour; capture the anchor instead of following it.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push(this);
  });
  globalThis.URL.createObjectURL = vi.fn(() => "blob:fake");
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  mock.restore();
  vi.restoreAllMocks();
});

describe("downloadCsv", () => {
  it("fetches the bytes from the server rather than building them", async () => {
    mock.onGet(/gst\/export/).reply(200, "Date,Total\r\n2026-05-12,274.40\r\n");

    await downloadCsv(
      "/api/reports/gst/export?month=5&year=2026",
      "fallback.csv",
    );

    expect(mock.history.get).toHaveLength(1);
    expect(mock.history.get[0].url).toContain("/reports/gst/export");
    // Whatever the server sent is what gets saved; nothing is recomputed here.
    expect(mock.history.get[0].responseType).toBe("blob");
    expect(clicked).toHaveLength(1);
  });

  it("names the file the way the server named it", async () => {
    mock.onGet(/export/).reply(200, "Date\r\n", {
      "content-disposition": 'attachment; filename="gst-report-2026-05.csv"',
    });

    await downloadCsv("/api/x/export", "fallback.csv");

    // The server knows the period and the threshold the report actually used.
    expect(clicked[0].download).toBe("gst-report-2026-05.csv");
  });

  it("falls back to the supplied name when the header is absent", async () => {
    mock.onGet(/export/).reply(200, "Date\r\n");
    await downloadCsv("/api/x/export", "fallback.csv");
    expect(clicked[0].download).toBe("fallback.csv");
  });

  it("propagates a failure instead of saving an error page as a CSV", async () => {
    mock.onGet(/export/).reply(500);

    await expect(downloadCsv("/api/x/export", "fallback.csv")).rejects.toThrow();
    expect(clicked).toHaveLength(0);
  });
});
