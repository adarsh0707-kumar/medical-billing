const { z } = require("zod");

// The largest page any client asks for today is 12 (Inventory, Customers); the
// dashboard asks for 1 to read a count. 100 leaves generous headroom while
// keeping a single request from pulling an unbounded set — `?limit=999999` used
// to be honoured, which is threat T-10 in docs/07-security.md.
const MAX_LIMIT = 100;

// Absent means "use the default"; present but unparseable is a 400. A typo must
// not quietly return a different page of results than the caller asked for.
const page = z.coerce
  .number({ invalid_type_error: "page must be a number" })
  .int("page must be a whole number")
  .min(1, "page must be at least 1")
  .default(1);

const limit = z.coerce
  .number({ invalid_type_error: "limit must be a number" })
  .int("limit must be a whole number")
  .min(1, "limit must be at least 1")
  .max(MAX_LIMIT, `limit must be at most ${MAX_LIMIT}`)
  .default(20);

// Search boxes send an empty string when cleared. That means "no filter", not a
// bad request, so it is normalised to undefined rather than reaching Prisma as
// `contains: ""`.
const searchTerm = z
  .string()
  .trim()
  .max(200, "search term is too long")
  .optional()
  .transform((v) => (v === "" ? undefined : v));

module.exports = { MAX_LIMIT, page, limit, searchTerm };
