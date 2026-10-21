/**
 * A malformed `deniedPaths` entry must be DROPPED WITH A WARNING, not left to
 * deny nothing in silence.
 *
 * ## The defect this pins (P3.106)
 *
 * `globToRegex` ESCAPES rather than throws, so the `try/catch` wrapped around it
 * never fires. A malformed entry compiled cleanly into a regex that matched
 * nothing, and the only trace was a `debug()` line that is off unless
 * `NESSY_DEBUG=1`. An administrator's typo in a deny rule therefore denied
 * nothing, silently — the same class as the permission-rule case the owner had
 * already ruled on.
 *
 * ## The policy is OQ-8's, not a new one
 *
 * OQ-8, resolved by the owner 2026-08-27: a permission rule that will not
 * compile is dropped WHATEVER ITS ACTION, with a warning for each.
 * `managed-settings.md#keys-that-fail-closed`: "an individual entry that fails,
 * such as a malformed permission rule, is skipped with a warning while the rest
 * of the file applies." Both halves of that sentence are asserted below — the
 * warning, and that the other entries in the same file still deny.
 *
 * ## Why the classifier is conservative on purpose
 *
 * A FALSE POSITIVE here would drop a WORKING deny, which is the one failure
 * this row must not introduce. So only provable-inert shapes are flagged, and
 * the negative controls below include all 19 shipped defaults: if the
 * classifier ever grows an opinion, the floor's own list is what catches it.
 *
 * SAFETY: every path here is DATA handed to a glob matcher, or a file written
 * under `tmpdir()`. Nothing reads a real credential file.
 */
import { afterEach, describe, expect, it, setDefaultTimeout, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyDeniedPathPattern, shouldAllowToolInMode } from '../mode-manager.ts';
import { SAFE_MODE_CONFIG } from '../mode-types.ts';
import { permissionsConfigCache } from '../permissions-config.ts';

// Same value and reason as `credential-read-floor.test.ts`: `shouldAllowToolInMode`
// is a heavy import and bun's 5s default sits close to its resting cost on a
// cold module graph.
setDefaultTimeout(30_000);

const tempWorkspaces: string[] = [];

function createWorkspacePermissions(config: Record<string, unknown>): string {
  const workspaceRootPath = mkdtempSync(join(tmpdir(), 'nessy-denied-path-'));
  writeFileSync(
    join(workspaceRootPath, 'permissions.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf-8',
  );
  tempWorkspaces.push(workspaceRootPath);
  permissionsConfigCache.invalidateWorkspace(workspaceRootPath);
  return workspaceRootPath;
}

afterEach(() => {
  permissionsConfigCache.clear();
  for (const workspaceRootPath of tempWorkspaces.splice(0)) {
    rmSync(workspaceRootPath, { recursive: true, force: true });
  }
});

describe('classifyDeniedPathPattern names the entries that can never match', () => {
  const INERT: ReadonlyArray<readonly [label: string, pattern: string, defect: string]> = [
    ['an empty entry', '', 'empty'],
    ['a whitespace-only entry', '   ', 'empty'],
    ['a Windows-style path', 'C:\\Users\\me\\.aws\\**', 'backslash'],
    ['a single escaped separator', 'secrets\\**', 'backslash'],
    // The shape a user copying `Read(./secrets/**)` out of the rule syntax
    // writes: candidates are absolute by the time the matcher sees them, so a
    // relative pattern is dead.
    ['a relative directory', 'secrets/**', 'unanchored'],
    ['a bare filename', '.env', 'unanchored'],
    ['a dot-relative path', './secrets/**', 'unanchored'],
    // `~` is an anchor only once expanded; this spelling is not expanded.
    ['a tilde that is not the home anchor', '~notauser/.ssh/**', 'unanchored'],
  ];

  it.each(INERT)('flags %s (%s)', (_label, pattern, defect) => {
    expect(classifyDeniedPathPattern(pattern)).toBe(defect as never);
  });
});

describe('classifyDeniedPathPattern leaves working entries alone', () => {
  // The whole shipped floor. A classifier that grew an opinion would take the
  // credential floor down with it, and this is the row that would go red first.
  it.each(SAFE_MODE_CONFIG.deniedPaths ?? [])('does not flag the shipped entry %s', pattern => {
    expect(classifyDeniedPathPattern(pattern)).toBeNull();
  });

  const VALID: ReadonlyArray<readonly [label: string, pattern: string]> = [
    ['an absolute directory', '/etc/ssl/private/**'],
    ['an any-depth pattern', '**/*.pem'],
    ['a home-anchored pattern', '~/.ssh/**'],
    ['the bare home anchor', '~'],
    ['a single-char wildcard at the front', '?/etc/**'],
    ['a Windows drive with forward slashes', 'C:/Users/me/.aws/**'],
    ['a deny of everything', '**'],
  ];

  it.each(VALID)('does not flag %s (%s)', (_label, pattern) => {
    expect(classifyDeniedPathPattern(pattern)).toBeNull();
  });
});

describe('a malformed entry is dropped with a warning while the rest of the file applies', () => {
  const denied = (workspaceRootPath: string, path: string): boolean => {
    const result = shouldAllowToolInMode(
      'Read',
      { file_path: path },
      'default',
      { permissionsContext: { workspaceRootPath } },
    );
    return result.allowed === false && result.denyPathBlocked === true;
  };

  it('warns once per malformed entry, naming it, and keeps the good entry denying', () => {
    // Distinct from every other pattern in this file: the warning is deduped
    // per process, so a shared spelling would make the count depend on test order.
    const workspaceRootPath = createWorkspacePermissions({
      deniedPaths: [
        'D:\\p3106\\vault\\**',
        'p3106-relative-secrets/**',
        '',
        '/tmp/p3106-real-secrets/**',
      ],
    });
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // The half the contract calls "the rest of the file applies".
      expect(denied(workspaceRootPath, '/tmp/p3106-real-secrets/token.txt')).toBe(true);
      // Negative control: the floor did not simply start refusing everything.
      expect(denied(workspaceRootPath, '/tmp/p3106-ordinary/index.ts')).toBe(false);

      const warned = warn.mock.calls.map(call => String(call[0]));
      const dropped = warned.filter(line => line.includes('deniedPaths entry'));
      expect(dropped).toHaveLength(3);
      // "with a warning for each", and each one NAMES the offending entry —
      // P2.127's rule, kept here.
      expect(dropped.some(line => line.includes('D:\\\\p3106\\\\vault\\\\**'))).toBe(true);
      expect(dropped.some(line => line.includes('p3106-relative-secrets/**'))).toBe(true);
      expect(dropped.some(line => line.includes('""'))).toBe(true);
      for (const line of dropped) expect(line).toContain('was dropped');
    } finally {
      warn.mockRestore();
    }
  });

  it('does not repeat the warning for a pattern it has already reported', () => {
    const workspaceRootPath = createWorkspacePermissions({
      deniedPaths: ['p3106-repeat-secrets/**', '/tmp/p3106-repeat-real/**'],
    });
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(denied(workspaceRootPath, '/tmp/p3106-repeat-real/token.txt')).toBe(true);
      const first = warn.mock.calls.filter(call => String(call[0]).includes('deniedPaths entry')).length;
      expect(first).toBe(1);

      warn.mockClear();
      expect(denied(workspaceRootPath, '/tmp/p3106-repeat-real/other.txt')).toBe(true);
      expect(warn.mock.calls.filter(call => String(call[0]).includes('deniedPaths entry'))).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('a malformed entry never becomes a deny of everything', () => {
    // The inversion the owner weighed when resolving OQ-8, in the opposite
    // direction: dropping must not be implemented as "fail the layer closed".
    const workspaceRootPath = createWorkspacePermissions({
      deniedPaths: ['E:\\p3106\\only-a-typo\\**'],
    });
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(denied(workspaceRootPath, '/tmp/p3106-anything/notes.md')).toBe(false);
      // …and the shipped floor underneath is untouched by the drop.
      expect(denied(workspaceRootPath, '/tmp/p3106-anything/.env')).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
