/**
 * UB4.5 — ChatPage's `handleOpenFile` resolves attachment paths through the
 * cross-platform `isAbsolutePath` (drafts.ts), not a POSIX-only prefix check.
 *
 * The defect this pins was measured at HEAD before the fix: the as-is arm read
 * `path.startsWith('/') || path.startsWith('~/')`, so a Windows `C:\work\a.ts`
 * was treated as relative and re-prefixed with the workspace root — a doubled,
 * non-existent path (upstream craft-agents-oss#922/#875, fixed in v0.15.1's
 * ChatPage by importing the drafts helper this repo already had).
 *
 * A source pin, not a render test, deliberately: the resolution lives inside a
 * React callback over `window.electronAPI`, and the behaviour that can regress
 * is exactly which predicate guards the as-is arm. The helper's own semantics
 * (drive letters, backslashes, relative negatives) are pinned by
 * `lib/__tests__/drafts.test.ts` — this file pins that the page USES it.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(import.meta.dir, '..', 'ChatPage.tsx'),
  'utf8',
);

describe('UB4.5 — ChatPage resolves open-file paths cross-platform', () => {
  it('positive — both arms guard with isAbsolutePath (as-is and smart fallback)', () => {
    expect({ usesHelperOnPath: source.includes('isAbsolutePath(path) || path.startsWith(\'~/\')') })
      .toEqual({ usesHelperOnPath: true });
    expect({ usesHelperOnResolved: source.includes('if (isAbsolutePath(resolved))') })
      .toEqual({ usesHelperOnResolved: true });
    // The smart fallback must split BOTH separators, or a `C:\…` path that
    // reaches it finds no parent directory.
    expect({
      backslashAware: source.includes("Math.max(resolved.lastIndexOf('/'), resolved.lastIndexOf('\\\\'))"),
    }).toEqual({ backslashAware: true });
  });

  it('negative (control) — the POSIX-only prefix check is gone', () => {
    // Fails against the pre-UB4.5 file, whose as-is arm was exactly this.
    expect({ posixOnlyArm: source.includes("path.startsWith('/') || path.startsWith('~/')") })
      .toEqual({ posixOnlyArm: false });
    expect({ posixOnlyFallback: /if \(resolved\.startsWith\('\/'\)\)/.test(source) })
      .toEqual({ posixOnlyFallback: false });
  });
});
