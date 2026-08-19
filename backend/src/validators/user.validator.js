const { z } = require("zod");

const role = z.enum(["ADMIN", "PHARMACIST", "CASHIER"], {
  errorMap: () => ({ message: "Role must be ADMIN, PHARMACIST or CASHIER" }),
});

const name = z.string().min(2, "Name must be at least 2 characters");
const email = z.string().email("A valid email address is required");

// Length only. Complexity and breach checks need an external service and are
// tracked as a P1 item in docs/07-security.md.
const password = z.string().min(8, "Password must be at least 8 characters");

// POST /api/users and POST /api/auth/register.
// Not strict: the Settings form posts its whole state object, and the extra
// keys are harmless once stripped.
const createUserSchema = z.object({
  name,
  email,
  password,
  role: role.optional(),
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
