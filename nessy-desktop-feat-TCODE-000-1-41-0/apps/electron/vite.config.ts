import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

/**
 * Strip a leading `#!` line before rollup parses the module (W9-bq, 2026-09-10).
 *
 * ## The measurement
 *
 * `bash apps/electron/scripts/build-dmg.sh arm64` FAILED at the wave gate, and
 * `bun run electron:build:renderer` reproduces it in 9.6 s:
 *
 *   node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs (1:57): Expected ident
 *   1: import { __vitePreload } from " vite/preload-helper.js";#!/usr/bin/env node
 *
 * `sdk.mjs` begins with `#!/usr/bin/env node` — re-read at the vendored
 * 0.3.247 / claudeCodeVersion 2.1.247 (C3.252, 2026-09-12) and still does; it
 * read 0.3.233 / 2.1.233 when this note was written. It contains dynamic imports of its own, so vite's
 * import-analysis prepends the `__vitePreload` helper AT OFFSET 0 — onto the
 * shebang line — and rollup then refuses the file. Nothing in the repo's own
 * sources changed; `d4948e99b` (claude-agent-sdk 0.3.223 -> 0.3.233) is the only
 * recent change to that file, and this is the first packaged build since.
 *
 * ## What this fixes, and what it deliberately does NOT
 *
 * It makes the file PARSEABLE. It never stopped the renderer from BUNDLING the
 * SDK; that was a second, independent defect, and P6.971 (W9-cb, 2026-09-10)
 * closed it in the source rather than here — see below.
 *
 * The plugin is scoped by CONTENT, not by package name: any dependency shipping
 * a CLI entry point in its module build has this defect, and a name list would
 * go stale the way every enumeration in this tree does. It therefore stays even
 * though the SDK is no longer in the renderer graph: the next dependency with a
 * shebang would otherwise re-break the build with a message about `Expected
 * ident` that names neither the shebang nor the package.
 *
 * ## THE BUILD IS GREEN, AND WHAT MADE IT GREEN WAS NOT A BUILD-CONFIG CHANGE
 *
 * This section said "THE BUILD IS STILL RED" until P6.971 landed. What it
 * described — `mcp-wire-name.ts (5:9): "createHash" is not exported by
 * "__vite-browser-external"` — was the first of a long queue, because rollup
 * aborts at the FIRST missing named export and reports nothing about the rest.
 *
 * The mechanism, read from `vite/dist/node/chunks/dep-*.js` (the
 * `browserExternalId` resolve+load pair) rather than guessed: in a PRODUCTION
 * build every browser-externalized node builtin resolves to the same stub module
 * whose whole body is `export default {}`. So a NAMED import of a builtin is a
 * hard error and a default/namespace import is only the "externalized for
 * browser compatibility" warning.
 *
 * Measured by walking value-only static imports from the four renderer entries:
 * the graph reached 1026 modules, **175** of which imported a builtin by name —
 * i.e. 175 queued hard errors — and every one of the 175 sat behind ONE edge,
 * `AppSettingsPage.tsx -> @nessy-agent/shared/config/storage`, for two pure
 * constants. With that edge cut the same walk reaches 830 modules and **0**.
 * So the fix was two source changes and nothing here: an isomorphic SHA-256
 * behind `mcp-wire-name.ts`'s digest (the wire names are a contract and do not
 * change), and `config/cross-session-inbound-vocabulary.ts`, a module with no
 * Node import that both the renderer and `storage.ts` read.
 *
 * The standing rule that keeps it green, and the reading that proves it: the
 * renderer build must print **zero** `has been externalized for browser
 * compatibility` warnings. It printed 282 before P6.971 and 0 after. A warning
 * returning means a shared module that touches Node is back in the renderer
 * graph, and the hard error is one named import behind it.
 *
 * That rule is ENFORCED since P6.981, and deliberately not here:
 * `scripts/electron-build-renderer.ts` — the repo's own entry point, the one
 * `bun run electron:build:renderer` runs — reads the child's stdout and stderr
 * and refuses on any such warning, naming every module and its importer.
 *
 * A `build.rollupOptions.onwarn` COULD see the same warning: vite emits it from
 * its resolve plugin through the rollup plugin context (`this.warn`, read in
 * `vite/dist/node/chunks/dep-*.js` beside the `browserExternalId` pair, 6.4.3).
 * It is not used because a hook that throws aborts at the FIRST warning, which
 * is the exact failure mode P6.971 paid for — 175 queued errors behind one
 * abort. Collecting the whole build's output and listing every module at the end
 * is what makes the refusal actionable in one pass.
 */
const stripShebang = {
  name: 'nessy:strip-shebang',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!id.includes('node_modules') || !code.startsWith('#!')) return null
    // Keep the line, blanked, so every later line number is unchanged: a
    // sourcemap that is off by one is worse than no fix at all.
    return { code: code.replace(/^#![^\n]*/, ''), map: null }
  },
}

export default defineConfig({
  plugins: [
    stripShebang,
    react({
      babel: {
        plugins: [
          // Jotai HMR support: caches atom instances in globalThis.jotaiAtomCache
          // so that HMR module re-execution returns stable atom references
          // instead of creating new (empty) atoms that orphan existing data.
          'jotai/babel/plugin-debug-label',
          ['jotai/babel/plugin-react-refresh', { customAtomNames: ['atomFamily'] }],
        ],
      },
    }),
    tailwindcss(),
  ],
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    // P6.975 — this read `emptyDirBeforeWrite: true` from the 2026-07-05
    // baseline until 2026-09-10. Vite has no such option (6.4.3: TS2769,
    // "'emptyDirBeforeWrite' does not exist in type 'BuildEnvironmentOptions'"),
    // and the typo was invisible because `vite.config.ts` was outside every
    // typecheck program — `apps/electron/tsconfig.json` included `src/**` only.
    // It is in that program's `include` now, so the compiler sees this file.
    // `emptyOutDir` is needed EXPLICITLY because `dist/renderer` sits outside
    // the renderer root, which vite refuses to empty unasked ("(!) outDir ... is
    // not inside project root and will not be emptied").
    // Not a live break, and the row's "stale bundles can accumulate" is narrower
    // than it reads: the repo's own entry point,
    // `scripts/electron-build-renderer.ts`, `rmSync`s the directory before
    // spawning vite, so only a direct `vite build --config` could accumulate.
    // This makes the config true on its own instead of relying on its wrapper.
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/renderer/index.html'),
        playground: resolve(__dirname, 'src/renderer/playground.html'),
        'browser-toolbar': resolve(__dirname, 'src/renderer/browser-toolbar.html'),
        'browser-empty-state': resolve(__dirname, 'src/renderer/browser-empty-state.html'),
      }
    }
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
      '@config': resolve(__dirname, '../../packages/shared/src/config'),
      // Force all React imports to use the root node_modules React
      // Bun hoists deps to root. This prevents "multiple React copies" error from @nessy-agent/ui
      'react': resolve(__dirname, '../../node_modules/react'),
      'react-dom': resolve(__dirname, '../../node_modules/react-dom'),
    },
    dedupe: ['react', 'react-dom']
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'jotai', 'pdfjs-dist'],
    exclude: ['@nessy-agent/ui'],
    esbuildOptions: {
      supported: { 'top-level-await': true },
      target: 'esnext'
    }
  },
  server: {
    port: 5173,
    open: false
  }
})
