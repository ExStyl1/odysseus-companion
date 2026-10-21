/**
 * ESLint Configuration for Electron App
 *
 * Uses flat config format (ESLint 9+).
 * Includes custom navigation rule to enforce navigate() usage.
 */

import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import reactPlugin from 'eslint-plugin-react'
import reactHooksPlugin from 'eslint-plugin-react-hooks'
import noDirectNavigationState from './eslint-rules/no-direct-navigation-state.cjs'
import noLocalStorage from './eslint-rules/no-localstorage.cjs'
import noDirectPlatformCheck from './eslint-rules/no-direct-platform-check.cjs'
import noHardcodedPathSeparator from './eslint-rules/no-hardcoded-path-separator.cjs'
import noDirectFileOpen from './eslint-rules/no-direct-file-open.cjs'
import noInlineSourceAuthCheck from './eslint-rules/no-inline-source-auth-check.cjs'
import noHardcodedZIndex from './eslint-rules/no-hardcoded-z-index.cjs'
import noNonstandardShadows from './eslint-rules/no-nonstandard-shadows.cjs'
// Design-system guardrails shared with packages/ui (one implementation)
import noMotionAntipatterns from '../../packages/ui/eslint-rules/no-motion-antipatterns.cjs'
import noRawPaletteColors from '../../packages/ui/eslint-rules/no-raw-palette-colors.cjs'

export default [
  // Ignore patterns
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'release/**',
      '*.cjs',
      'eslint-rules/**',
      // D1.313 — `electron:build:servers` STAGES three bundled servers here, and
      // one of them is 25.8 MB on one line. ESLint parsing it exhausts V8:
      // measured 2026-09-18, `npx eslint resources/session-mcp-server/index.js`
      // (the 8.6 MB sibling) under a 512 MB cap gives
      // `FATAL ERROR: Reached heap limit Allocation failed` and exit 134.
      //
      // Two of the three are untracked build output, so `eslint .` by hand dies
      // only on a machine that has built the servers — which is what makes it
      // read as a flake rather than as a file set nobody meant to lint. This is
      // shipped ARTEFACT, not source: every `.ts`/`.tsx` under `src/` that the
      // block below actually configures is unaffected, and `lint:electron`'s own
      // file count is the proof (1002 before and after).
      //
      // D1.304 routes the lint RUNNER around it by defaulting to the target
      // `lint:electron` declares; this is the other half, for the developer who
      // types `eslint .` and gets no such default.
      'resources/**',
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
      '@typescript-eslint': tsPlugin,
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      // Custom plugin for Nessy Desktop rules
      'nessy-general-agent': {
        rules: {
          'no-direct-navigation-state': noDirectNavigationState,
          'no-localstorage': noLocalStorage,
        },
      },
      // Custom plugin for platform detection rules
      'nessy-platform': {
        rules: {
          'no-direct-platform-check': noDirectPlatformCheck,
        },
      },
      // Custom plugin for cross-platform path rules
      'nessy-paths': {
        rules: {
          'no-hardcoded-path-separator': noHardcodedPathSeparator,
        },
      },
      // Custom plugin for link interceptor enforcement
      'nessy-links': {
        rules: {
          'no-direct-file-open': noDirectFileOpen,
        },
      },
      // Custom plugin for source auth checks (shared with packages/shared)
      'nessy-sources': {
        rules: {
          'no-inline-source-auth-check': noInlineSourceAuthCheck,
        },
      },
      // Custom style rules
      'nessy-styles': {
        rules: {
          'no-hardcoded-z-index': noHardcodedZIndex,
          'no-nonstandard-shadows': noNonstandardShadows,
          'no-motion-antipatterns': noMotionAntipatterns,
          'no-raw-palette-colors': noRawPaletteColors,
        },
      },
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    linterOptions: {
      // P2.229. ESLint 9 defaults this to `warn`, and a warning does not fail
      // `lint` — so three directives here named
      // `@typescript-eslint/no-explicit-any`, a rule no config in this repo has
      // ever enabled, and the gate reported them harmlessly on every run.
      // Deleted with this change: `src/main/browser-pane-manager.ts:3376,3387`
      // (Electron's `details` handler arguments) and
      // `src/renderer/playground/registry/types.ts:30` (`ComponentType<any>`).
      // Same fossil class as `server-core/src/transport/client.ts:355` (P2.88)
      // and the two P2.319 found in `core` and `webui`.
      //
      // The nine surviving directives are all `react-hooks/exhaustive-deps`,
      // which IS enabled — at `warn`, and a directive that suppresses a warning
      // counts as used, so raising this to `error` does not touch them.
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // React Hooks rules
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // Custom Nessy Desktop rules
      'nessy-general-agent/no-direct-navigation-state': 'error',
      'nessy-general-agent/no-localstorage': 'warn',

      // Custom platform detection rule
      'nessy-platform/no-direct-platform-check': 'error',

      // Custom cross-platform path rule
      'nessy-paths/no-hardcoded-path-separator': 'warn',

      // Custom link interceptor rule — prevents bypassing in-app file preview
      'nessy-links/no-direct-file-open': 'error',

      // Custom source auth check rule — use isSourceUsable() instead of inline checks
      'nessy-sources/no-inline-source-auth-check': 'error',

      // Custom style rule — use z-index token scale instead of hardcoded literals
      'nessy-styles/no-hardcoded-z-index': 'error',

      // Custom style rule — enforce approved shadow classes/tokens only
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
          'shadow-dragging', // UA2.3/UA2.4: the drag-lift utility (index.css --shadow-dragging), v0.13.4
        ],
        allowInlineNone: true,
      }],

      // Design-system guardrails (implementation plan A0): warn until the class codemod (A3–B9) lands
      'nessy-styles/no-motion-antipatterns': 'warn',
      'nessy-styles/no-raw-palette-colors': 'warn',

      // Enforce centralized action registry for keyboard shortcuts
      'no-restricted-imports': ['error', {
        paths: [
          {
            name: 'react-hotkeys-hook',
            message: 'Use useAction from @/actions instead. See actions/index.ts'
          }
        ],
      }],
    },
  },

  // Temporary exceptions for unresolved shadow migrations.
  {
    files: [
      'src/renderer/components/ui/sortable-list.tsx',
      'src/main/browser-pane-manager.ts',
      'src/shared/browser-live-fx.ts',
      'src/renderer/components/KeyboardShortcutsDialog.tsx',
      'src/renderer/playground/**/*.{ts,tsx}',
    ],
    rules: {
      'nessy-styles/no-nonstandard-shadows': 'off',
    },
  },

  // Playground demos show raw colors on purpose (swatches, before/after)
  {
    files: ['src/renderer/playground/**/*.{ts,tsx}'],
    rules: {
      'nessy-styles/no-raw-palette-colors': 'off',
    },
  },

  // Enforce backend abstraction boundary in Electron main process.
  {
    files: ['src/main/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          {
            name: '@nessy-agent/shared/codex',
            message: 'Use provider-agnostic APIs from @nessy-agent/shared/agent/backend instead.',
          },
          {
            name: '@nessy-agent/shared/agent/claude-agent',
            message: 'Provider backends must stay behind @nessy-agent/shared/agent/backend.',
          },
          {
            name: '@nessy-agent/shared/agent/pi-agent',
            message: 'Provider backends must stay behind @nessy-agent/shared/agent/backend.',
          },
        ],
      }],
    },
  },

  // Keep main model fetchers provider-agnostic (delegate to shared backend APIs only).
  {
    files: ['src/main/model-fetchers/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error',
        {
          selector: "CallExpression[callee.name='fetch']",
          message: 'Do not call provider APIs directly in Electron model fetchers. Delegate to fetchBackendModels() from @nessy-agent/shared/agent/backend.',
        },
        {
          selector: "ImportDeclaration[source.value='@anthropic-ai/claude-agent-sdk']",
          message: 'Provider SDK usage must stay in backend drivers under packages/shared/src/agent/backend/internal/drivers.',
        },
        {
          selector: "ImportDeclaration[source.value='@earendil-works/pi-ai']",
          message: 'Provider SDK usage must stay in backend drivers under packages/shared/src/agent/backend/internal/drivers.',
        },
        {
          selector: "ImportDeclaration[source.value='@earendil-works/pi-coding-agent']",
          message: 'Provider SDK usage must stay in backend drivers under packages/shared/src/agent/backend/internal/drivers.',
        },
      ],
    },
  },
]
