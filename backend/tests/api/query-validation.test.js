import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import prisma from "../../src/config/db.js";
import { buildApp, signIn, makeSellable } from "../helpers/factory.js";

/**
 * Query-parameter validation — P1-10 in docs/07-security.md, threat T-10.
 *
 * Before this existed, no query string was validated anywhere: `?limit=999999`
 * was honoured, a garbage `month` produced an empty GST report that looked like a
 * quiet month, and `Number(x) || 30` turned `?days=abc` into a 30-day window
 * indistinguishable from a deliberate one. The last is the dangerous shape — a
 * typo returning plausible data rather than an error.
 *
 * The rule these assert: absent means "use the default"; present but unparseable
 * or out of range is a 400.
 */

let app;
let token;

beforeAll(() => {
  app = buildApp();
});

// Every table is emptied before each test, so the signed-in user has to be
// created inside that window rather than once for the file.
beforeEach(async () => {
  ({ token } = await signIn(app, "ADMIN"));
});

const get = (url) =>
  request(app).get(url).set("Authorization", `Bearer ${token}`);

describe("pagination bounds", () => {
  const paginated = [
    ["medicines", "/api/inventory/medicines"],
    ["customers", "/api/billing/customers"],
    ["invoices", "/api/billing/invoices"],
  ];

  it.each(paginated)("%s rejects limit above the maximum", async (_n, url) => {
    const res = await get(`${url}?limit=999999`);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Invalid query parameters");
    expect(res.body.errors[0].field).toBe("limit");
  });

  it.each(paginated)("%s accepts the maximum limit of 100", async (_n, url) => {
    expect((await get(`${url}?limit=100`)).status).toBe(200);
  });

  it.each(paginated)("%s rejects limit=0 and negative limits", async (_n, url) => {
    expect((await get(`${url}?limit=0`)).status).toBe(400);
    expect((await get(`${url}?limit=-5`)).status).toBe(400);
  });

  it.each(paginated)("%s rejects a non-numeric limit or page", async (_n, url) => {
    expect((await get(`${url}?limit=abc`)).status).toBe(400);
    expect((await get(`${url}?page=abc`)).status).toBe(400);
  });

  it.each(paginated)("%s rejects a fractional limit", async (_n, url) => {
    expect((await get(`${url}?limit=1.5`)).status).toBe(400);
  });

  // The dashboard fetches one row purely to read pagination.total. If the parsed
  // limit stopped reaching the controller, `take` would be undefined and this
  // would return every row — which is exactly how a silent regression here would
  // look, so assert the row count rather than just the status.
  it("honours ?limit=1, the dashboard's count trick", async () => {
    await makeSellable();
    await makeSellable();

    const res = await get("/api/inventory/medicines?limit=1");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination.total).toBeGreaterThan(1);
  });

  it("defaults limit when it is absent", async () => {
    const res = await get("/api/inventory/medicines");
    expect(res.status).toBe(200);
    expect(res.body.pagination).toBeDefined();
  });
});

describe("GST report month and year", () => {
  // docs/09 §5.5 left this open: empty result, or 400? Decided 400 — an empty tax
  // period is indistinguishable from a month with no sales, and silently filing
  // from a typo is the worse failure.
  it.each([
    ["garbage month", "?month=abc&year=2026"],
    ["month above 12", "?month=13&year=2026"],
    ["month below 1", "?month=0&year=2026"],
    ["no parameters at all", ""],
    ["missing year", "?month=8"],
    ["missing month", "?year=2026"],
    ["garbage year", "?month=8&year=abc"],
    ["implausible year", "?month=8&year=1200"],
  ])("rejects %s with 400", async (_label, qs) => {
    const res = await get(`/api/billing/invoices/gst-report${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Invalid query parameters");
  });

  it("accepts a valid month and year", async () => {
    const res = await get("/api/billing/invoices/gst-report?month=8&year=2026");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe("daily summary date", () => {
  it("rejects a garbage date rather than reporting an empty day", async () => {
    // The old code built `new Date("garbage")`, and Prisma turned that Invalid
    // Date into a range matching nothing. A day with no sales and a mistyped
    // date returned identical output.
    const res = await get("/api/billing/invoices/daily-summary?date=garbage");
    expect(res.status).toBe(400);
    expect(res.body.errors[0].field).toBe("date");
  });

  it("defaults to today when the date is absent", async () => {
    expect((await get("/api/billing/invoices/daily-summary")).status).toBe(200);
  });

  it("accepts an ISO date", async () => {
    const res = await get(
      "/api/billing/invoices/daily-summary?date=2026-08-20",
    );
    expect(res.status).toBe(200);
  });
});

describe("expiry and low-stock windows", () => {
  // `Number(x) || 30` swallowed a typo and returned a default window. That is
  // worse than an error: the caller gets plausible data for a question they did
  // not ask.
  it("rejects a non-numeric days rather than defaulting to 30", async () => {
    const res = await get("/api/inventory/batches/expiring?days=abc");
    expect(res.status).toBe(400);
    expect(res.body.errors[0].field).toBe("days");
  });

  it.each([
    ["days above the maximum", "/api/inventory/batches/expiring?days=999"],
    ["days of zero", "/api/inventory/batches/expiring?days=0"],
    ["negative days", "/api/inventory/batches/expiring?days=-1"],
    ["non-numeric threshold", "/api/inventory/batches/low-stock?threshold=abc"],
    ["threshold of zero", "/api/inventory/batches/low-stock?threshold=0"],
  ])("rejects %s", async (_label, url) => {
    expect((await get(url)).status).toBe(400);
  });

  // The notification tray polls these on every page load.
  it("serves the notification tray's parameters", async () => {
    expect((await get("/api/inventory/batches/expiring?days=30")).status).toBe(200);
    expect((await get("/api/inventory/batches/low-stock?threshold=10")).status).toBe(200);
  });

  it("defaults days and threshold when absent", async () => {
    expect((await get("/api/inventory/batches/expiring")).status).toBe(200);
    expect((await get("/api/inventory/batches/low-stock")).status).toBe(200);
  });
});

describe("filters and enums", () => {
  it("rejects an unknown paymentMode or paymentStatus", async () => {
    expect((await get("/api/billing/invoices?paymentMode=BITCOIN")).status).toBe(400);
    expect((await get("/api/billing/invoices?paymentStatus=MAYBE")).status).toBe(400);
  });

  it("accepts the documented enum values", async () => {
    expect((await get("/api/billing/invoices?paymentMode=CASH")).status).toBe(200);
    expect((await get("/api/billing/invoices?paymentStatus=PAID")).status).toBe(200);
  });

  it("rejects a garbage date range", async () => {
    expect((await get("/api/billing/invoices?startDate=nope&endDate=2026-08-20")).status).toBe(400);
  });

  it("treats an empty search box as no filter", async () => {
    // The client sends `search=` when the box is cleared. That is not a caller
    // error, and it must not reach Prisma as `contains: ""`.
    expect((await get("/api/inventory/medicines?search=")).status).toBe(200);
    expect((await get("/api/billing/customers?search=")).status).toBe(200);
    expect((await get("/api/inventory/suppliers?search=")).status).toBe(200);
  });

  it("rejects a boolean flag that is not true or false", async () => {
    expect((await get("/api/inventory/batches?expiringSoon=maybe")).status).toBe(400);
    expect((await get("/api/inventory/batches?expiringSoon=true")).status).toBe(200);
  });

  // Regression guard. Adding validateQuery turned expiringSoon and lowStock from
  // the strings URLSearchParams sends into booleans, but the controller still
  // compared them to "true" — so both filters silently matched nothing and every
  // batch came back. The original tests asserted only the status code and passed
  // throughout. A filter test has to assert that the filter filtered.
  it("actually filters on expiringSoon and lowStock, not just returns 200", async () => {
    const { batch, medicine } = await makeSellable();

    // Far future, plenty of stock: matches neither filter.
    await prisma.batch.update({
      where: { id: batch.id },
      data: {
        expiryDate: new Date(Date.now() + 400 * 24 * 60 * 60 * 1000),
        quantity: 500,
      },
    });

    const all = await get("/api/inventory/batches");
    expect(all.status).toBe(200);
    expect(all.body.pagination.total).toBe(1);

    const expiring = await get("/api/inventory/batches?expiringSoon=true");
    expect(expiring.status).toBe(200);
    expect(expiring.body.pagination.total).toBe(0);

    const low = await get("/api/inventory/batches?lowStock=true");
    expect(low.status).toBe(200);
    expect(low.body.pagination.total).toBe(0);

    // Now make it match both, and confirm it appears in each.
    await prisma.batch.update({
      where: { id: batch.id },
      data: {
        expiryDate: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
        quantity: 3,
      },
    });

    expect((await get("/api/inventory/batches?expiringSoon=true")).body.pagination.total).toBe(1);
    expect((await get("/api/inventory/batches?lowStock=true")).body.pagination.total).toBe(1);
    expect(medicine.id).toBeTruthy();
  });

  it("paginates batches instead of returning every row", async () => {
    for (let i = 0; i < 3; i++) await makeSellable();

    const res = await get("/api/inventory/batches?limit=2");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination.total).toBe(3);
    expect(res.body.pagination.pages).toBe(2);
  });

  // The POS search box calls this on every keystroke. One character is not a
  // caller error, so it returns an empty list rather than a 400.
  it("returns an empty list for a one-character POS search", async () => {
    const res = await get("/api/inventory/medicines/search?q=a");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("ignores unknown query parameters rather than rejecting them", async () => {
    // A stray cache-buster should not fail a request.
    expect((await get("/api/inventory/medicines?_cb=12345")).status).toBe(200);
  });
});
