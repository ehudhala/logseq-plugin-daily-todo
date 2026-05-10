// ESLint 9 flat config. Mechanical style rules only — type-aware
// checking is handled by `pnpm check` (tsc --noEmit).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

const styleRules = {
  quotes: ['warn', 'single', { allowTemplateLiterals: true }],
  'arrow-parens': ['warn', 'as-needed'],
  'comma-spacing': ['warn', { after: true }],
  'linebreak-style': ['error', 'unix'],
  'object-curly-spacing': ['error', 'always'],
  semi: ['warn', 'always'],
  '@typescript-eslint/no-explicit-any': 'off',
  '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
  'no-unused-vars': 'off',
  'no-empty': ['warn', { allowEmptyCatch: true }],
};

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // perf-test/host.html is HTML; the script tag inside is browser-only
    // and would need an HTML parser to lint. e2e/fixtures/ is test data.
    ignores: ['dist/**', 'node_modules/**', 'e2e/fixtures/**', 'perf-test/**', '**/*.html'],
  },
  {
    // Plugin source runs in the Logseq plugin iframe — browser globals
    // plus the SDK's `logseq` global.
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, logseq: 'readonly' },
    },
    rules: styleRules,
  },
  {
    // Test harness, perf driver, and bundler config run in Node.
    // The perf driver also drives a Chromium page so it pokes at
    // browser globals through Playwright — include both. `$APP` is
    // Logseq's renderer-side ClojureScript global the harness reaches
    // into for the current-repo helper.
    files: ['scripts/**/*.mjs', 'e2e/**/*.mjs', 'vitest.config.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser, $APP: 'readonly' },
    },
    rules: styleRules,
  },
);
