const { z } = require("zod");
const { passwordProblem } = require("./password");

const role = z.enum(["ADMIN", "PHARMACIST", "CASHIER"], {
  error: "Role must be ADMIN, PHARMACIST or CASHIER",
});

const name = z.string().min(2, "Name must be at least 2 characters");
const email = z.email("A valid email address is required");

// Rules live in validators/password.js, with the reasoning for what is
// deliberately absent — no character-class requirements, no breach-corpus
// lookup. Applied through a single refinement so every password path shares one
// definition rather than drifting apart.
const password = z.string().superRefine((value, ctx) => {
  const problem = passwordProblem(value);
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
});

// POST /api/users and POST /api/auth/register.
// Not strict: the Settings form posts its whole state object, and the extra
// keys are harmless once stripped.
const createUserSchema = z
  .object({
    name,
    email,
    password,
    role: role.optional(),
  })
  // Re-run the rules once the whole object is known, so the password can be
  // checked against this account's own name and email. A password that restates
  // either is guessable by anyone who can see the user list — which is every
  // administrator.
  //
  // The context-free problems are skipped here because the field-level check
  // above has already reported them. A `superRefine` issue does not abort the
  // parse in Zod 4, so both refinements run on the same value and, without this
  // guard, a weak password came back with the identical message twice — which
  // the Settings form duly rendered twice under one field.
  .superRefine((data, ctx) => {
    if (typeof data.password !== "string") return;
    if (passwordProblem(data.password)) return;
    const problem = passwordProblem(data.password, {
      name: data.name,
      email: data.email,
    });
    if (problem) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["password"],
        message: problem,
      });
    }
  });

// PUT /api/users/:id — every field optional so a partial edit leaves the rest
// alone. Not strict: the active/inactive toggle sends the whole user row back.
const updateUserSchema = z.object({
  name: name.optional(),
  email: email.optional(),
  role: role.optional(),
  isActive: z.boolean().optional(),
});

// PUT /api/users/profile — the caller's own name and email, nothing else.
// Strict: a stray `role` here would otherwise look accepted while being
// silently dropped, which reads like a privilege-escalation hole.
const updateProfileSchema = z
  .object({
    name: name.optional(),
    email: email.optional(),
  })
  .strict();

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: password,
});

module.exports = {
  createUserSchema,
  updateUserSchema,
  updateProfileSchema,
  changePasswordSchema,
};
