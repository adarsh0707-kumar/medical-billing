import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Tracked debt, not an accepted pattern. Eleven call sites fetch on mount by
      // calling setState synchronously inside an effect. Fixing it properly means
      // moving data fetching to a query library, which is a refactor of its own —
      // see G-16 in docs/08-gap-analysis.md for the sites and the proposed fix.
      // Downgraded so the debt stays visible instead of blocking every other
      // change; it should go back to 'error' once G-16 is closed.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
  {
    // shadcn/ui primitives are generated and, per CONTRIBUTING, composed rather
    // than hand-edited. They export a variants const alongside their component,
    // which this rule flags purely because it costs fast-refresh granularity — a
    // dev-server ergonomic with no bearing on correctness. Scoped to this
    // directory so the rule keeps protecting code we actually write.
    files: ['src/components/ui/**'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
