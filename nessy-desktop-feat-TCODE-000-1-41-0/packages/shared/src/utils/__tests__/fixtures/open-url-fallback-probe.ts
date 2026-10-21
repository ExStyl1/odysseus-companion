/**
 * Reaches `openUrl`'s NON-ELECTRON fallback, which no in-process test can.
 *
 * The repo's `bunfig.toml` preloads `apps/electron/testing/electron-mock-preload.ts`
 * for both `bun run` and `bun test`, and that mock supplies a `shell` whose
 * `openExternal` resolves. So inside any repo-local bun process `openUrl` takes
 * its Electron branch and returns — the `open`-package fallback, and therefore
 * the documented command-line cap on it, is unreachable. Measured 2026-09-06,
 * with the control that separates rig from behaviour: the same import with the
 * process CWD outside the repo (where bunfig does not apply) yields
 * `typeof shell === 'undefined'`, which is the real `electron/index.js` string
 * export and the shape every non-Electron production process sees.
 *
 * Hence a CHILD, launched with a CWD outside the repo. Every side effect is
 * behind `import.meta.main`: a fixture whose module body runs on import kills
 * the test runner at import time and reports exit 0 with zero tests executed.
 *
 * Usage: `bun <this file> <url>` — prints `REFUSED:<message>` or `OPENED`.
 * It is only ever called with an OVER-CAP url, which is refused before anything
 * is spawned; calling it with a short one would open a real browser.
 */
import { openUrl } from '../../open-url.ts';

export async function probeOpenUrl(url: string): Promise<string> {
  try {
    await openUrl(url);
    return 'OPENED';
  } catch (error) {
    return `REFUSED:${error instanceof Error ? error.message : String(error)}`;
  }
}

if (import.meta.main) {
  const url = process.argv[2] ?? '';
  console.log(await probeOpenUrl(url));
}
