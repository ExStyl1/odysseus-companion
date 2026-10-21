/**
 * Cross-platform asset copy script.
 *
 * Copies the resources/ directory to dist/resources/.
 * All bundled assets (docs, themes, permissions, tool-icons) now live in resources/
 * which electron-builder handles natively via directories.buildResources.
 *
 * At Electron startup, setBundledAssetsRoot(__dirname) is called, and then
 * getBundledAssetsDir('docs') resolves to <__dirname>/resources/docs/, etc.
 *
 * Run: bun scripts/copy-assets.ts
 */

import { cpSync, copyFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { ELECTRON_INTERCEPTOR_CONTEXT, verifyInterceptorBundle } from '../../../scripts/build/interceptor-pairing';

// bin/codex holds fetched codex-app-server binaries (gitignored, ~200MB each,
// possibly stale from earlier flagged builds). The packaged app receives codex
// only via the flag-gated electron-builder include into app/resources; the
// dist/resources copy is a runtime fallback that never wins, so copying the
// binaries here would smuggle them into every build regardless of the flag.
const codexBinDir = resolve('resources', 'bin', 'codex');

// Copy all resources (icons, themes, docs, permissions, tool-icons, etc.)
rmSync('dist/resources', { recursive: true, force: true });
cpSync('resources', 'dist/resources', {
  recursive: true,
  filter: (source) => !resolve(source).startsWith(codexBinDir),
});

console.log('✓ Copied resources/ → dist/resources/ (bin/codex excluded)');

// Copy PowerShell parser script (for Windows command validation against the read-only allowlist Plan and Don't ask use)
// Source: packages/shared/src/agent/powershell-parser.ps1
// Destination: dist/resources/powershell-parser.ps1
const psParserSrc = join('..', '..', 'packages', 'shared', 'src', 'agent', 'powershell-parser.ps1');
const psParserDest = join('dist', 'resources', 'powershell-parser.ps1');
try {
  copyFileSync(psParserSrc, psParserDest);
  console.log('✓ Copied powershell-parser.ps1 → dist/resources/');
} catch (err) {
  // Only warn - PowerShell validation is optional on non-Windows platforms
  console.log('⚠ powershell-parser.ps1 copy skipped (not critical on non-Windows)');
}

// The interceptor has to SHIP, and this is the last step of `electron:build` —
// the one place in the Electron pipeline that does not rebuild it, so a bundle
// that was never produced (or was produced wrong) is caught here rather than by
// a user whose packaged Pi subprocess runs unpatched with no error. See
// `scripts/build/interceptor-pairing.ts`.
verifyInterceptorBundle(join('dist', 'interceptor.cjs'), ELECTRON_INTERCEPTOR_CONTEXT);
console.log('✓ Verified dist/interceptor.cjs ships with the app');
