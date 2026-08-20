// The query-string counterpart to validate.middleware.js.
//
// It deliberately does NOT mirror `validate`'s `req.body = result.data`. In
// Express 5 `req.query` is a lazy getter on the request prototype: assigning to
// it neither throws nor takes effect, so `req.query = parsed` reads as working
// code and silently leaves the raw strings in place. The parsed result therefore
// lands on `req.validatedQuery`, and controllers read that explicitly.
//
// Unknown keys are stripped rather than rejected — a stray cache-buster should
// not fail a request — so `req.validatedQuery` contains exactly what the schema
// declares. As with body validation, a field you forget to declare vanishes.
const validateQuery = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    const errors = result.error.errors.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    }));
    return res
      .status(400)
      .json({ success: false, message: "Invalid query parameters", errors });
  }
  req.validatedQuery = result.data;
  next();
};

module.exports = validateQuery;
