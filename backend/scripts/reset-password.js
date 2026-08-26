/**
 * Break-glass password reset, run from a server console (FR-AUTH-10).
 *
 *   npm run reset-password -- someone@example.com
 *
 * `POST /api/users/:id/reset-password` covers every case where somebody still
 * holds an administrator session. This covers the one it cannot: the last
 * administrator locking themselves out, where there is no session left to
 * authorise the call and no email in this stack to send a link. Without it,
 * that state is only recoverable by hand-editing a bcrypt hash into the
 * database, which is how an operator ends up pasting a hash from a blog post.
 *
 * Uses `src/config/db.js` rather than a bare PrismaClient — unlike seed.js —
 * so the write passes through the audit middleware and leaves a row. It has no
 * actor, which is exactly right and is the same way migrations and the seed
 * appear: the trail says this was done from the console, not by a signed-in
 * user (NFR-17).
 */
const bcrypt = require("bcryptjs");
const prisma = require("../src/config/db");
const { generateTempPassword } = require("../src/utils/temp-password");

const fail = (message) => {
  console.error(`\n✖ ${message}\n`);
  process.exitCode = 1;
};

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();

  if (!email) {
    return fail(
      "Usage: npm run reset-password -- <email>\n\n" +
        "  Resets that account's password to a generated one-time value and\n" +
        "  requires it to be changed at next sign-in.",
    );
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true, email: true, role: true, isActive: true },
  });

  if (!user) {
    const others = await prisma.user.findMany({
      select: { email: true, role: true },
      orderBy: { createdAt: "asc" },
      take: 25,
    });
    return fail(
      `No account with the email ${email}.\n\n` +
        (others.length
          ? "  Accounts that do exist:\n" +
            others.map((u) => `    ${u.email}  (${u.role})`).join("\n")
          : "  There are no accounts at all — run `npm run seed` first."),
    );
  }

  const tempPassword = generateTempPassword({
    name: user.name,
    email: user.email,
  });
  const hashed = await bcrypt.hash(tempPassword, 12);

  // Same two-part revocation as the HTTP route and as logout: the counter ends
  // outstanding access tokens, the sweep ends the refresh tokens that would
  // otherwise mint replacements. A reset that leaves the previous holder signed
  // in is not a reset.
  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashed,
        mustChangePassword: true,
        tokenVersion: { increment: 1 },
      },
    }),
    prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);

  console.log(`
✅ Password reset for ${user.email} (${user.role})

   Temporary password:  [REDACTED]

   It is stored only as a hash, so rerun this if a new temporary password is needed.
   Every session for this account has ended, and the API will refuse every
   route except signing in and changing the password until it is replaced.
`);

  if (!user.isActive) {
    console.log(
      "⚠  This account is deactivated, so it still cannot sign in.\n" +
        "   Reactivate it from Settings → Users, or the reset has no effect.\n",
    );
  }
}

main()
  .catch((err) => fail(err.message))
  .finally(() => prisma.$disconnect());
