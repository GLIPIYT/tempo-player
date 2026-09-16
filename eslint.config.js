import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

/**
 * Deliberately narrow.
 *
 * `tsc` already enforces what people usually reach for a linter to get -
 * `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`
 * - and the codebase has exactly one `as any` in it. So the only thing worth
 * adding is the pair of React hooks rules: a stale closure is a real bug and it
 * is completely invisible to the compiler.
 *
 * Adding `js.configs.recommended` on top would flag the sixty-odd deliberate
 * empty `catch {}` blocks and drown the signal. Start here instead.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'src-tauri/**', 'target/**', 'graphify-out/**', 'scripts/**'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // Calling a hook conditionally takes the whole tree down at runtime.
      'react-hooks/rules-of-hooks': 'error',
      // A stale closure is a genuine bug, but the rule also fires on omissions
      // that are deliberate, so it starts as a warning until the list is read.
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
)
