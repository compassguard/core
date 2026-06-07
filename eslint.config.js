import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

const LEGACY_IMPORT_PATTERNS = [
  '**/legacy/**',
  'legacy/**',
  './legacy/**',
  '../**/legacy/**',
  '../legacy/**',
];

export default tseslint.config(
  {
    ignores: [
      '.next',
      'node_modules',
      'front/dist',
      'dist',
      'build',
      'legacy/**',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    ignores: ['legacy/**'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: LEGACY_IMPORT_PATTERNS,
              message:
                'Compass MCP Guard code must not import from legacy/. Refactor the new code instead.',
            },
          ],
        },
      ],
    },
  }
);
