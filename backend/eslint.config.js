const js = require("@eslint/js");
const globals = require("globals");

/**
 * Backend lint (D-6).
 *
 * The README claimed `npm run lint` and `npm run format` for months while
 * neither existed. This is the half that can actually fail a build.
 *
 * Flat config and the same ESLint version line as the frontend, so there is one
 * toolchain to reason about rather than two — but written as CommonJS, because
 * that is what this half of the repository is (CONTRIBUTING) and a `.mjs` config
 * beside 40 `require`s would be its own small lie.
 */
module.exports = [
  {
    ignores: ["node_modules/**", "coverage/**", "prisma/migrations/**"],
  },

  js.configs.recommended,

  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: globals.node,
    },
    rules: {
      // Formatting is Prettier's job, not the linter's — see `npm run format`.
      // What is left here is the class of thing that is a bug rather than a
      // preference.

      // An unused `require` is usually a leftover from a refactor; an unused
      // argument often is not, because Express middleware signatures are
      // positional. `(err, req, res, next)` must keep `next` to be recognised
      // as an error handler at all, and dropping it silently changes routing.
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_|^next$",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
          // `const { password, ...safe } = user` is how this codebase drops a
          // field, and the dropped binding is the entire point of writing it.
          // Not the default in ESLint 10, so it is stated rather than assumed.
          ignoreRestSiblings: true,
        },
      ],

      // `console.log` in `src/` is a gate the project already enforces by review
      // (docs/09 §6). Logging goes through pino; a stray debug line should not
      // reach production. Warnings, errors and the boot banner are allowed.
      "no-console": ["error", { allow: ["warn", "error", "info"] }],

      // Both are real defects rather than style: a promise executor that throws
      // is unhandled, and a `return` inside `finally` swallows the exception the
      // caller was about to see.
      "no-promise-executor-return": "error",
      "no-unsafe-finally": "error",

      // Money and stock code compares a lot of loosely-typed input.
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },

  {
    // Scripts and the seed talk to an operator at a terminal; that is what
    // stdout is for.
    files: [
      "scripts/**/*.js",
      "src/utils/seed.js",
      "src/utils/retention.js",
      "src/utils/audit-retention.js",
    ],
    rules: { "no-console": "off" },
  },

  {
    // The suites are ESM (`import`) and run under Vitest, whose globals are
    // injected rather than required.
    files: ["tests/**/*.js"],
    languageOptions: {
      sourceType: "module",
      globals: { ...globals.node, ...globals.vitest },
    },
    rules: { "no-console": "off" },
  },
];
