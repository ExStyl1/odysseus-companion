/**
 * ESLint Configuration for UI Package
 *
 * Uses flat config format (ESLint 9+).
 * Enforces use of StyledDropdown wrappers instead of raw Radix primitives.
 */

import tsParser from '@typescript-eslint/parser'
import noHardcodedZIndex from './eslint-rules/no-hardcoded-z-index.cjs'
import noFloatingZTokensInIsland from './eslint-rules/no-floating-z-tokens-in-island.cjs'
import noNonstandardShadows from './eslint-rules/no-nonstandard-shadows.cjs'
import noMotionAntipatterns from './eslint-rules/no-motion-antipatterns.cjs'
import noRawPaletteColors from './eslint-rules/no-raw-palette-colors.cjs'

export default [
  // Ignore patterns
  {
    ignores: [
      'dist/**',
      'node_modules/**',
    ],
  },

  // TypeScript/React files
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      'nessy-styles': {
        rules: {
          'no-hardcoded-z-index': noHardcodedZIndex,
          'no-floating-z-tokens-in-island': noFloatingZTokensInIsland,
          'no-nonstandard-shadows': noNonstandardShadows,
          'no-motion-antipatterns': noMotionAntipatterns,
          'no-raw-palette-colors': noRawPaletteColors,
        },
      },
    },
    linterOptions: {
      // P2.229. ESLint 9 defaults this to `warn`, and a warning does not fail
      // `lint`. This package has ZERO eslint directives today, so the line
      // changes no current output — which is the point, and the same argument
      // `server-core`'s config makes for its zero-hit rules: this is the check
      // that fails the FIRST time someone writes a waiver against a rule this
      // config does not enable, rather than the one that notices years later.
      // Every other package in the repo now gates the same way — the eleven on
      // `nessyPackageConfig` by its default, `server-core` explicitly (P2.88).
      // Verified live by planting a bogus directive under `src/` and watching
      // `lint:ui` go red; without this line the same plant is a warning and the
      // step passes.
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // Prevent direct Radix dropdown imports — use StyledDropdown wrappers instead
      'no-restricted-imports': ['error', {
        paths: [
          {
            name: '@radix-ui/react-dropdown-menu',
            message: 'Use StyledDropdownMenuContent, StyledDropdownMenuItem, etc. from components/ui/StyledDropdown instead.',
          },
        ],
      }],

      // Enforce centralized z-index token scale
      'nessy-styles/no-hardcoded-z-index': 'error',

      // Enforce dedicated island z-index tokens in island components
      'nessy-styles/no-floating-z-tokens-in-island': 'error',

      // Enforce approved shadow utility classes/tokens only
      'nessy-styles/no-nonstandard-shadows': ['error', {
        allowedClasses: [
          'shadow-none',
          'shadow-xs',
          'shadow-elev-0',
          'shadow-elev-1',
          'shadow-elev-2',
          'shadow-elev-3',
          'shadow-minimal',
          'shadow-tinted',
          'shadow-thin',
          'shadow-middle',
          'shadow-strong',
          'shadow-panel-focused',
          'shadow-modal-small',
          'shadow-bottom-border',
          'shadow-bottom-border-thin',
        ],
        allowInlineNone: true,
      }],

      // Design-system guardrails (implementation plan A0): warn until the class codemod (A3–B9) lands
      'nessy-styles/no-motion-antipatterns': 'warn',
      'nessy-styles/no-raw-palette-colors': 'warn',
    },
  },

  // Temporary exceptions for unresolved shadow migrations.
  // UB12.43: ImageCardStack left this list once it drew the allow-listed `shadow-elev-2`
  // (v0.15.1 still lists it); eslint-rules/__tests__/shadow-exemptions.test.ts pins that.
  {
    files: [
      'src/components/ui/BrowserControls.tsx',
      'src/components/ui/__tests__/styled-dropdown.test.ts',
    ],
    rules: {
      'nessy-styles/no-nonstandard-shadows': 'off',
    },
  },

  // Allow raw Radix import in the styled wrapper itself
  {
    files: ['src/components/ui/StyledDropdown.tsx'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
]
