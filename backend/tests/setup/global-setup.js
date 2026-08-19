import { execSync } from "node:child_process";

// Runs once for the whole suite: point Prisma at a throwaway database and bring
// its schema up to date.
//
// The name guard is the important part. These tests truncate every table, and
// DATABASE_URL in a dev shell points at real data — so refuse to run unless the
// database name makes its disposability unmistakable.
export default async function setup() {
  const url = process.env.DATABASE_URL;

  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Point it at a disposable test database:\n" +
        "  DATABASE_URL=postgresql://medadmin:medpass123@postgres:5432/medicaldb_test npm test",
    );
  }

  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!/_test$/.test(dbName)) {
    throw new Error(
      `Refusing to run: database "${dbName}" does not end in "_test".\n` +
        "This suite truncates every table, so it only runs against a database " +
        "whose name says it is disposable.",
    );
  }

  execSync("npx prisma migrate deploy", { stdio: "inherit" });
}
