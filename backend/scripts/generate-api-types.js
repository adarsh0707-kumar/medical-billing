#!/usr/bin/env node
/**
 * Generates the frontend's request types from the backend's Zod schemas
 * (NFR-22).
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * The backend already declares every request contract once, as a Zod schema.
 * The frontend used to re-declare the same shapes by hand, per page, and the two
 * drifted in silence — the client found out about a contract change when a
 * request came back 400.
 *
 * ── How it crosses the CommonJS / ESM boundary ───────────────────────────────
 * It doesn't. That is the point.
 *
 * The backend is CommonJS and the frontend is ESM TypeScript, and they cannot
 * share a runtime module — G-18 records that the two cannot share so much as a
 * Prisma client instance. A shared *package* would have to be dual-published, or
 * the backend converted, and both are large changes to solve a problem that is
 * not actually a runtime problem.
 *
 * The frontend needs **types**, not code. Types are erased before anything runs,
 * so what crosses the boundary is a generated `.d`-style source file containing
 * no imports and no values — nothing that has a module format at all. The
 * backend keeps `require`, the frontend keeps `import`, and neither loads the
 * other.
 *
 * TypeScript's own checker does the reading: it understands `module.exports` on
 * a `.js` file well enough to infer `z.input<typeof schema>` straight from the
 * CommonJS validators, and `typeToString` prints those inferred types fully
 * expanded rather than as references back to files the frontend cannot resolve.
 *
 * ── Why the output lands inside frontend/src ─────────────────────────────────
 * The two Docker images build from separate contexts (`./backend`, `./frontend`)
 * and each does `COPY . .`. A `shared/` directory at the repo root would be
 * invisible to both. Writing the generated file into `frontend/src/types/` keeps
 * it inside the context that needs it, so both builds keep working untouched.
 *
 * ── Why z.input and not z.infer ──────────────────────────────────────────────
 * `z.infer` is `z.output` — the shape *after* parsing, with defaults filled in
 * and strings coerced. That is what the handler receives, not what the client
 * sends. Emitting it would tell the frontend that `discountAmt` is required when
 * the schema defaults it, and that `expiringSoon` is a boolean when it goes over
 * the wire as the string `"true"` (the exact confusion behind G-19).
 *
 * `z.input` is the client's half of the contract, so that is what is emitted.
 *
 * ── The one thing z.input gets wrong ─────────────────────────────────────────
 * Zod 3 does not model the pre-coercion type: `z.coerce.date()` reports its
 * *input* as `Date`, and `z.coerce.number()` as `number`, when what actually
 * travels is a string. Taking that at face value would hand the frontend a type
 * that contradicts the wire — worse than no shared type, because it looks
 * authoritative.
 *
 * So the coerced leaves are found by walking the schemas at runtime and widened
 * to what a client may really send. If a widening cannot be applied the
 * generator throws rather than emitting the narrow type, because a silently
 * wrong contract is the failure this whole file exists to prevent. (Zod 4 models
 * this properly; when the backend upgrades, `COERCED_WIRE_TYPES` and
 * `widenCoercedFields` can go.)
 *
 * Run `npm run types:generate` after changing a schema; `npm run types:check`
 * fails if the committed file is stale, and runs in CI.
 */

const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { z } = require("zod");

const BACKEND_DIR = path.resolve(__dirname, "..");
const OUT_FILE = path.resolve(
  BACKEND_DIR,
  "../frontend/src/types/api.generated.ts",
);

/**
 * The modules that describe request contracts.
 *
 * `common.validator.js` and `password.js` are deliberately absent: the first
 * exports building blocks (`page`, `limit`, `searchTerm`) that are composed into
 * the schemas below rather than being contracts themselves, and the second
 * exports a predicate and some constants, not schemas.
 */
const MODULES = [
  "billing.validator.js",
  "inventory.validator.js",
  "user.validator.js",
];

/**
 * `createInvoiceSchema` -> `CreateInvoiceInput`, `batchListQuerySchema` ->
 * `BatchListQuery`. A schema already named for a query keeps that word rather
 * than becoming `BatchListQueryInput`.
 */
function typeNameFor(exportName) {
  const base = exportName.replace(/Schema$/, "");
  const pascal = base.charAt(0).toUpperCase() + base.slice(1);
  return pascal.endsWith("Query") ? pascal : `${pascal}Input`;
}

/**
 * What a client may actually put on the wire for a coerced field. Each includes
 * the parsed type too: axios JSON-encodes a `Date` to an ISO string, so passing
 * one is legitimate.
 */
const COERCED_WIRE_TYPES = {
  ZodDate: "string | Date",
  ZodNumber: "number | string",
  ZodBoolean: "boolean | string",
  ZodString: "string",
};

/** Unwraps the wrappers that sit between a field and its underlying type. */
function unwrap(schema) {
  let current = schema;
  for (;;) {
    const def = current._def;
    if (def.innerType) current = def.innerType;
    else if (def.schema) current = def.schema;
    else if (typeof def.type === "object" && def.typeName === "ZodArray")
      return current;
    else return current;
  }
}

/**
 * Every coerced leaf reachable from a schema, by field name.
 *
 * Names rather than paths because the printed type is flat and, within one
 * schema, a coerced name occurs once — which `widenCoercedFields` verifies
 * rather than assumes.
 */
function collectCoercedFields(schema, found = new Map()) {
  const inner = unwrap(schema);
  const def = inner._def;

  if (def.typeName === "ZodObject") {
    for (const [key, child] of Object.entries(def.shape())) {
      const leaf = unwrap(child);
      if (leaf._def.coerce) {
        const wire = COERCED_WIRE_TYPES[leaf._def.typeName];
        if (!wire) {
          throw new Error(
            `no wire type known for coerced ${leaf._def.typeName} (field "${key}")`,
          );
        }
        found.set(key, wire);
      }
      collectCoercedFields(child, found);
    }
  } else if (def.typeName === "ZodArray") {
    collectCoercedFields(def.type, found);
  }

  return found;
}

/**
 * Widens the coerced fields in an already-printed type.
 *
 * Throws if a field it expected to widen is not there: that means the schema and
 * the printed output have diverged, and emitting the un-widened type would ship
 * a contract that disagrees with the wire.
 */
function widenCoercedFields(typeName, printed, coerced) {
  let out = printed;
  for (const [field, wire] of coerced) {
    // `field: X;` or `field?: X | undefined;` — the wire type subsumes X.
    const pattern = new RegExp(`\\b${field}(\\??): ([^;]+);`, "g");
    const matches = [...out.matchAll(pattern)];
    if (matches.length !== 1) {
      throw new Error(
        `${typeName}: expected exactly one "${field}" field to widen, found ${matches.length}`,
      );
    }
    const [, optional, current] = matches[0];
    const widened = current.endsWith(" | undefined")
      ? `${wire} | undefined`
      : wire;
    out = out.replace(pattern, `${field}${optional}: ${widened};`);
  }
  return out;
}

/** Every Zod schema each module exports, discovered by asking the values. */
function collectSchemas() {
  const found = [];
  for (const file of MODULES) {
    const mod = require(path.join(BACKEND_DIR, "src/validators", file));
    for (const [exportName, value] of Object.entries(mod)) {
      if (value instanceof z.ZodType) {
        found.push({
          file,
          exportName,
          typeName: typeNameFor(exportName),
          coerced: collectCoercedFields(value),
        });
      }
    }
  }
  found.sort((a, b) => a.typeName.localeCompare(b.typeName));
  return found;
}

/**
 * Builds the entry module in memory rather than on disk.
 *
 * It has to *resolve* as though it sat in `backend/`, so `zod` and the
 * validators are found, but it never needs to exist there — a temp file would
 * survive a crash and end up committed.
 */
function printExpandedTypes(schemas) {
  const entryPath = path.join(BACKEND_DIR, "__api-types-entry__.ts");

  const entrySource = [
    `import { z } from "zod";`,
    ...MODULES.map(
      (file, i) => `import * as m${i} from "./src/validators/${file}";`,
    ),
    ...schemas.map(
      (s) =>
        `export type ${s.typeName} = z.input<typeof m${MODULES.indexOf(s.file)}.${s.exportName}>;`,
    ),
  ].join("\n");

  const options = {
    allowJs: true,
    esModuleInterop: true,
    skipLibCheck: true,
    strict: true,
    noEmit: true,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2020,
  };

  const host = ts.createCompilerHost(options, true);
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);

  host.fileExists = ((original) => (fileName) =>
    fileName === entryPath || original(fileName))(
    host.fileExists.bind(host),
  );
  host.readFile = (fileName) =>
    fileName === entryPath ? entrySource : readFile(fileName);
  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    fileName === entryPath
      ? ts.createSourceFile(fileName, entrySource, languageVersion, true)
      : getSourceFile(fileName, languageVersion, ...rest);

  const program = ts.createProgram([entryPath], options, host);

  // A schema that fails to type-check would otherwise be emitted as `any`, which
  // is worse than no shared types at all: it silently accepts everything.
  const errors = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length) {
    const text = ts.formatDiagnostics(errors, {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => BACKEND_DIR,
      getNewLine: () => "\n",
    });
    throw new Error(`the validators did not type-check:\n${text}`);
  }

  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entryPath);
  const flags =
    ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias;

  const printed = new Map();
  ts.forEachChild(source, (node) => {
    if (!ts.isTypeAliasDeclaration(node)) return;
    const type = checker.getTypeAtLocation(node.name);
    printed.set(node.name.text, checker.typeToString(type, node, flags));
  });

  return printed;
}

function render(schemas, printed) {
  const lines = [
    "/**",
    " * GENERATED FILE — DO NOT EDIT (NFR-22).",
    " *",
    " * Inferred from the Zod schemas in `backend/src/validators/`, which are the",
    " * single definition of every request contract. Edit a schema and run:",
    " *",
    " *   cd backend && npm run types:generate",
    " *",
    " * `npm run types:check` fails if this file is out of date, and runs in CI —",
    " * so a contract change that is not reflected here turns the build red rather",
    " * than turning a request into a 400 at runtime.",
    " *",
    " * These are **request** types: what a client sends, before the server applies",
    " * defaults and coercions. A field the schema defaults is optional here, and a",
    " * query parameter the schema coerces appears as the string it travels as.",
    " *",
    " * No imports and no values, deliberately: types are erased before anything",
    " * runs, which is how a CommonJS backend shares a contract with an ESM",
    " * frontend without either loading the other.",
    " */",
    "",
  ];

  for (const s of schemas) {
    const body = widenCoercedFields(
      s.typeName,
      printed.get(s.typeName),
      s.coerced,
    );
    lines.push(
      `/** \`${s.exportName}\` — \`backend/src/validators/${s.file}\` */`,
      `export type ${s.typeName} = ${body};`,
      "",
    );
  }

  return lines.join("\n");
}

function main() {
  const check = process.argv.includes("--check");
  const schemas = collectSchemas();
  const printed = printExpandedTypes(schemas);
  const output = render(schemas, printed);

  if (check) {
    const current = fs.existsSync(OUT_FILE)
      ? fs.readFileSync(OUT_FILE, "utf8")
      : "";
    if (current !== output) {
      console.error(
        "api.generated.ts is out of date with the Zod schemas.\n" +
          "Run `npm run types:generate` in backend/ and commit the result.",
      );
      process.exit(1);
    }
    console.log(`api.generated.ts is up to date (${schemas.length} contracts).`);
    return;
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, output);
  console.log(
    `wrote ${path.relative(path.resolve(BACKEND_DIR, ".."), OUT_FILE)} — ${schemas.length} contracts`,
  );
}

main();
