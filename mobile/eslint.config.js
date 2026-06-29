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
      // Mirror the desktop (app/eslint.config.js): the feedback provider file
      // co-exports its `FeedbackProvider` component with the `useToast` /
      // `useConfirm` hooks (same pattern as the desktop Toast/Confirm context),
      // which this HMR-only rule flags. Correctness is unaffected.
      'react-refresh/only-export-components': 'off',
    },
  },
])
