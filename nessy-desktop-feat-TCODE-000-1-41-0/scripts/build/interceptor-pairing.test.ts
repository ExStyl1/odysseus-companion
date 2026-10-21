/**
 * L4 — the Electron build must FAIL when the interceptor does not ship.
 *
 * `resolveInterceptorBundlePath` returns `undefined` when `dist/interceptor.cjs`
 * is missing and the Pi subprocess then starts unpatched with no error, so a
 * broken artifact is indistinguishable from a working one at runtime. The
 * Electron build's only check used to be `console.warn` + return (and it was
 * dead code besides), which is the same as no check at all.
 *
 * The wrong-file case has its own assertion because an existence check passes on
 * an empty or truncated bundle and ships the identical silent failure.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ELECTRON_INTERCEPTOR_CONTEXT,
  INTERCEPTOR_BUNDLE_MARKER,
  verifyInterceptorBundle,
} from './interceptor-pairing';

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'nessy-interceptor-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('verifyInterceptorBundle', () => {
  /**
   * The assertion is asserted on its OWN message, not merely on "it threw".
   * Dropping the existence check still throws — `readFileSync` raises ENOENT and
   * that message carries the path too — so a check for the path alone passes
   * with the guard deleted. Measured: the first version of this test scored a
   * green against exactly that mutation.
   */
  test('a missing bundle fails, and the message names the file and how to restore it', () => {
    withTempDir(dir => {
      const bundle = join(dir, 'dist', 'interceptor.cjs');
      expect(() => verifyInterceptorBundle(bundle, ELECTRON_INTERCEPTOR_CONTEXT))
        .toThrow(`Interceptor bundle missing at ${bundle}`);
      expect(() => verifyInterceptorBundle(bundle, ELECTRON_INTERCEPTOR_CONTEXT))
        .toThrow('bun run build:interceptor');
    });
  });

  test('a bundle that is not the interceptor fails on the marker', () => {
    withTempDir(dir => {
      const bundle = join(dir, 'interceptor.cjs');
      writeFileSync(bundle, '// truncated build output\n');
      expect(() => verifyInterceptorBundle(bundle, ELECTRON_INTERCEPTOR_CONTEXT))
        .toThrow(INTERCEPTOR_BUNDLE_MARKER);
    });
  });

  test('a real bundle passes, so a normal build is unchanged', () => {
    withTempDir(dir => {
      const bundle = join(dir, 'interceptor.cjs');
      writeFileSync(bundle, `console.log("${INTERCEPTOR_BUNDLE_MARKER}")\n`);
      expect(() => verifyInterceptorBundle(bundle, ELECTRON_INTERCEPTOR_CONTEXT)).not.toThrow();
    });
  });
});
