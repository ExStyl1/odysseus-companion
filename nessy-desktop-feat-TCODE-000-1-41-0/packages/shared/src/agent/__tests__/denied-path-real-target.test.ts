/**
 * F1.711 — the `deniedPaths` floor judges the file a symlink REACHES, not only
 * the link's own name (`denied-path-real-target.ts`).
 *
 * Measured at HEAD 2026-09-26 (DN-115), this file before the fix: the two link
 * arms below were ALLOWED — `Read` of a workspace link to a `.env`, and `Read`
 * or `Write` through a workspace link to a `.git/glab-cli` directory — while the
 * same files named directly were REFUSED in the same run. The contract is
 * Claude's own, `permissions.md#read-and-edit`: "Deny rules: apply when either
 * the symlink path or its target matches. A symlink that points to a denied
 * file is itself denied."
 *
 * F1.1120 — the four residues DN-115 stated rather than fixed, re-measured at
 * HEAD 2026-10-09 (probe in work/bk-18/, all four ALLOWED with their controls
 * REFUSED) and closed here: a RELATIVE file-tool path is resolved against the
 * SESSION working directory before the real-path step; a DANGLING link is
 * judged at the target its link names; a `Bash` command path is judged at its
 * real path; and a deny pattern written through a symlinked FOLDER (the row's
 * `/etc/**` on macOS, where `/etc` is a link to `private/etc`) is applied at
 * the folder's real location — Claude's own behaviour since v2.1.268, which
 * the shipped SDK (2.1.274) already carries for its own rules and this host
 * floor now matches for all three runtimes.
 *
 * The rig uses two SHIPPED patterns that need no home directory, the double-star
 * dot-env entry and the double-star `.git/glab-cli` entry, so nothing here names
 * or touches the real home; the one custom pattern lives in a workspace
 * permissions.json under the same temp root. SAFETY: every file and link is
 * created under a fresh temp directory and removed afterwards; the files hold
 * fake text; nothing is read or executed.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shouldAllowToolInMode } from '../mode-manager.ts';
import { permissionsConfigCache } from '../permissions-config.ts';
import type { PermissionMode } from '../mode-types.ts';

// The same value and reason as `denied-path-shell-spelling.test.ts`: `mode-manager.ts`
// is a heavy import on a cold module graph.
setDefaultTimeout(30_000);

let root = '';
const ws = (...segments: string[]) => join(root, 'ws', ...segments);

beforeAll(() => {
  // macOS's TMPDIR sits behind `/var` -> `/private/var`; the (d) arm below
  // re-anchors a pattern at a REALPATH, so the rig must not carry a second
  // alias its candidate spellings never use — root is the real spelling and
  // the ONLY link in play is the `linked` -> `private-real` one the row is
  // about (the `/etc/**` on macOS stand-in).
  root = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1711-')));
  mkdirSync(join(root, 'outside', '.git', 'glab-cli'), { recursive: true });
  mkdirSync(join(root, 'private-real'));
  writeFileSync(join(root, 'outside', '.env'), 'FAKE=1\n');
  writeFileSync(join(root, 'outside', '.git', 'glab-cli', 'config.yml'), 'token: fake\n');
  writeFileSync(join(root, 'outside', 'notes.txt'), 'hello\n');
  writeFileSync(join(root, 'private-real', 'hosts'), 'fake-hosts\n');
  mkdirSync(ws());
  mkdirSync(join(root, 'private-real-sibling'));
  writeFileSync(join(root, 'private-real-sibling', 'hosts'), 'fake-sibling\n');
  symlinkSync(join(root, 'outside', '.env'), ws('settings.txt'));
  symlinkSync(join(root, 'outside', '.git', 'glab-cli'), ws('glab'));
  symlinkSync(join(root, 'outside', 'notes.txt'), ws('readme.txt'));
  // F1.1120 (b): DANGLING links — the targets are never created, so realpath
  // fails at the leaf and only the link itself names where a read would land.
  symlinkSync(join(root, 'outside', '.env.secrets'), ws('dangling.env'));
  symlinkSync(join(root, 'outside', 'absent-notes.txt'), ws('dangling-ok.txt'));
  // F1.1120 (d): the symlinked FOLDER a deny pattern is written through — the
  // row's `/etc/**` on macOS stand-in (`linked` -> `private-real`).
  symlinkSync(join(root, 'private-real'), join(root, 'linked'));
  writeFileSync(
    ws('permissions.json'),
    `${JSON.stringify({ deniedPaths: [join(root, 'linked', '**')] }, null, 2)}\n`,
    'utf-8',
  );
  permissionsConfigCache.invalidateWorkspace(ws());
});

afterAll(() => {
  permissionsConfigCache.clear();
  if (root) rmSync(root, { recursive: true, force: true });
});

function floorVerdict(
  toolName: string,
  toolInput: unknown,
  mode: PermissionMode = 'default',
  options: { workingDirectory?: string; deniedPathBase?: string; blockReadsOutsideWorkingDirectories?: boolean; permissionsContext?: { workspaceRootPath: string } } = {},
): 'REFUSED' | 'ALLOWED' {
  const result = shouldAllowToolInMode(toolName, toolInput, mode, Object.keys(options).length > 0 ? options : undefined);
  return result.allowed === false && result.denyPathBlocked === true ? 'REFUSED' : 'ALLOWED';
}

describe('deniedPaths floor: a symlink is judged at the file it reaches (F1.711)', () => {
  it('refuses a link to a denied file, on both argument spellings and in bypassPermissions, naming the pattern', () => {
    expect(floorVerdict('Read', { file_path: ws('settings.txt') })).toBe('REFUSED');
    expect(floorVerdict('Read', { path: ws('settings.txt') })).toBe('REFUSED'); // Pi's `read` sends `path`
    expect(floorVerdict('Read', { file_path: ws('settings.txt') }, 'bypassPermissions')).toBe('REFUSED');
    const result = shouldAllowToolInMode('Read', { file_path: ws('settings.txt') }, 'default');
    expect(result.allowed === false ? result.reason : '').toContain('**/.env');
  });

  it('refuses a read and a search through a linked denied directory', () => {
    expect(floorVerdict('Read', { file_path: ws('glab', 'config.yml') })).toBe('REFUSED');
    expect(floorVerdict('Grep', { path: ws('glab') })).toBe('REFUSED');
  });

  it('refuses a NEW file written through a linked denied directory (nearest existing ancestor)', () => {
    expect(floorVerdict('Write', { file_path: ws('glab', 'new.yml') })).toBe('REFUSED');
  });

  it('allows a link to a harmless file, and a new file in a real directory', () => {
    expect(floorVerdict('Read', { file_path: ws('readme.txt') })).toBe('ALLOWED');
    expect(floorVerdict('Write', { file_path: ws('new.txt') })).toBe('ALLOWED');
    expect(floorVerdict('Read', { file_path: ws('absent', 'deeper.txt') })).toBe('ALLOWED');
  });
});

describe('deniedPaths floor: the four by-name-only residues are closed (F1.1120)', () => {
  it('(a) a RELATIVE file-tool path is resolved against the SESSION working directory before the real-path step', () => {
    // `settings.txt` is the link to the `.env`; handed relatively, the floor
    // must judge it where the session says it is, not where process.cwd() is.
    expect(floorVerdict('Read', { file_path: 'settings.txt' }, 'default', { workingDirectory: ws() })).toBe('REFUSED');
    expect(floorVerdict('Read', { file_path: join('glab', 'config.yml') }, 'default', { workingDirectory: ws() })).toBe('REFUSED');
  });

  it('(a) negative: a relative path to a harmless file stays allowed, and with no base nothing new is judged', () => {
    expect(floorVerdict('Read', { file_path: 'readme.txt' }, 'default', { workingDirectory: ws() })).toBe('ALLOWED');
    // No working directory in hand: the floor declines to resolve rather than
    // inventing process.cwd() — the read fence's own rule, one screen up.
    expect(floorVerdict('Read', { file_path: 'settings.txt' })).toBe('ALLOWED');
  });

  it('(b) a DANGLING link is judged at the target its link names, not only at its own name', () => {
    expect(floorVerdict('Read', { file_path: ws('dangling.env') })).toBe('REFUSED');
    expect(floorVerdict('Grep', { path: ws('dangling.env') })).toBe('REFUSED');
  });

  it('(b) negative: a dangling link to a harmless name stays allowed', () => {
    expect(floorVerdict('Read', { file_path: ws('dangling-ok.txt') })).toBe('ALLOWED');
  });

  it('(c) a Bash command path is ALSO judged at its real path — token, relative token, and redirect target', () => {
    expect(floorVerdict('Bash', { command: `cat ${ws('settings.txt')}` })).toBe('REFUSED');
    expect(floorVerdict('Bash', { command: 'cat ./settings.txt' }, 'default', { workingDirectory: ws() })).toBe('REFUSED');
    expect(floorVerdict('Bash', { command: `cat > ${ws('settings.txt')}` })).toBe('REFUSED');
  });

  it('(c) negative: Bash over a harmless path stays allowed', () => {
    expect(floorVerdict('Bash', { command: `cat ${ws('readme.txt')}` })).toBe('ALLOWED');
    expect(floorVerdict('Bash', { command: 'echo hi' })).toBe('ALLOWED');
  });

  it('(d) a deny pattern written through a symlinked FOLDER applies at the folder\'s real location', () => {
    const ctx = { permissionsContext: { workspaceRootPath: ws() } };
    expect(floorVerdict('Read', { file_path: join(root, 'private-real', 'hosts') }, 'default', ctx)).toBe('REFUSED');
    expect(floorVerdict('Read', { file_path: join(root, 'private-real') }, 'default', ctx)).toBe('REFUSED'); // the folder itself
    expect(floorVerdict('Grep', { path: join(root, 'private-real') }, 'default', ctx)).toBe('REFUSED');
    // The link spelling was already denied directly — it stays denied.
    expect(floorVerdict('Read', { file_path: join(root, 'linked', 'hosts') }, 'default', ctx)).toBe('REFUSED');
  });

  it('(d) negative: paths outside the re-anchored folder stay allowed, prefix collisions included', () => {
    const ctx = { permissionsContext: { workspaceRootPath: ws() } };
    expect(floorVerdict('Read', { file_path: join(root, 'private-real-sibling', 'hosts') }, 'default', ctx)).toBe('ALLOWED');
    expect(floorVerdict('Read', { file_path: join(root, 'outside', 'notes.txt') }, 'default', ctx)).toBe('ALLOWED');
  });
});

/**
 * UB12.60 (CRITICAL) — the floor's own base for a relative spelling, `deniedPathBase`: where the runtime's tools run,
 * which a session with no project has while it has no `workingDirectory`. It is ADDED to `workingDirectory`, never put
 * in its place, and the read fence does not take it. The no-project verdicts on both runtimes' gate inputs are
 * `session-working-folder-floor.test.ts`'s DENY/OPEN arms; these pin the option's own semantics.
 */
describe('deniedPaths floor: a relative spelling is also judged where the runtime\'s tools run (UB12.60)', () => {
  const elsewhere = () => join(root, 'private-real-sibling');

  it('resolves a relative path at deniedPathBase when there is no working directory', () => {
    expect(floorVerdict('Read', { file_path: 'settings.txt' }, 'bypassPermissions', { deniedPathBase: ws() })).toBe('REFUSED');
    expect(floorVerdict('Bash', { command: 'cat ./settings.txt' }, 'bypassPermissions', { deniedPathBase: ws() })).toBe('REFUSED');
  });

  it('adds the base rather than replacing workingDirectory: either base that reaches the secret refuses it', () => {
    expect(floorVerdict('Read', { file_path: 'settings.txt' }, 'default', { workingDirectory: elsewhere(), deniedPathBase: ws() })).toBe('REFUSED');
    expect(floorVerdict('Read', { file_path: 'settings.txt' }, 'default', { workingDirectory: ws(), deniedPathBase: elsewhere() })).toBe('REFUSED');
  });

  it('negative: a relative harmless path stays allowed at both bases, and the read fence keeps workingDirectory alone', () => {
    expect(floorVerdict('Read', { file_path: 'readme.txt' }, 'default', { workingDirectory: ws(), deniedPathBase: elsewhere() })).toBe('ALLOWED');
    const fenced = shouldAllowToolInMode('Read', { file_path: join(elsewhere(), 'hosts') }, 'default', {
      workingDirectory: ws(), deniedPathBase: elsewhere(), blockReadsOutsideWorkingDirectories: true,
    });
    // Had the fence read deniedPathBase as a root, this read inside it would pass.
    expect({ allowed: fenced.allowed, denyPathBlocked: fenced.allowed === false && fenced.denyPathBlocked === true }).toEqual({ allowed: false, denyPathBlocked: false });
  });
});
