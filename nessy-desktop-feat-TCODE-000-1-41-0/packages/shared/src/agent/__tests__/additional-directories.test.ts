/**
 * Configured additional filesystem roots.
 *
 * `shouldAllowToolInMode` has accepted `options.additionalDirectories` and
 * implemented containment against it from the start, and no production caller
 * ever passed it. These tests drive a REAL production call site
 * (`PermissionManager.evaluateToolCall`), so a fix that only touches the
 * already-working function cannot make them pass.
 *
 * `CONFIG_DIR` is frozen at import time and already pointed at a private temp
 * directory by `tests/setup/isolate-shared-config-dir.ts` (bunfig `[test].preload`),
 * so the persisted setting is written into that isolated config dir and restored
 * afterwards rather than re-pointing the env var, which no longer takes effect.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CONFIG_DIR } from '../../config/paths.ts';
import { claudeLiveSessionSignature } from '../backend/claude/live-session.ts';
import { getConfiguredAdditionalDirectories, resolveAdditionalDirectories } from '../additional-directories.ts';
import { PermissionManager } from '../core/permission-manager.ts';
import { cleanupModeState, initializeModeState } from '../mode-manager.ts';

const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const KEY = { workspaceId: 'ws-additional-directories', sessionId: 'session-additional-directories' };

let sandbox: string;
let extraRoot: string;
let workspaceRoot: string;
let outsideRoot: string;
let previousConfig: string | null = null;

beforeAll(() => {
  // realpath so the fixture paths match what the resolver canonicalizes to;
  // macOS puts mkdtemp under /var, which is itself a symlink to /private/var.
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-additional-dirs-')));
  extraRoot = join(sandbox, 'other-repo');
  workspaceRoot = join(sandbox, 'workspace');
  outsideRoot = join(sandbox, 'somewhere-else');
  for (const dir of [join(extraRoot, 'src'), workspaceRoot, outsideRoot]) {
    mkdirSync(dir, { recursive: true });
  }

  previousConfig = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf-8') : null;
  const base = previousConfig
    ? JSON.parse(previousConfig)
    : { storageLayoutVersion: 2, workspaceRefs: [], activeWorkspaceId: null, activeSessionId: null };
  writeFileSync(CONFIG_FILE, JSON.stringify({ ...base, additionalDirectories: [extraRoot] }), 'utf-8');
});

afterAll(() => {
  if (previousConfig === null) {
    rmSync(CONFIG_FILE, { force: true });
  } else {
    writeFileSync(CONFIG_FILE, previousConfig, 'utf-8');
  }
  cleanupModeState(KEY);
  rmSync(sandbox, { recursive: true, force: true });
});

/** F1.1192 — turns the operator's read fence on in the isolated `config.json` for `run`, then writes the file back. */
function withReadFence(run: () => void): void {
  const saved = readFileSync(CONFIG_FILE, 'utf-8');
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify({ ...JSON.parse(saved), blockReadsOutsideWorkingDirectories: true }), 'utf-8');
    run();
  } finally {
    writeFileSync(CONFIG_FILE, saved, 'utf-8');
  }
}

function safeModePermissionManager(): PermissionManager {
  cleanupModeState(KEY);
  initializeModeState(KEY, 'plan');
  return new PermissionManager({
    workspaceId: KEY.workspaceId,
    sessionId: KEY.sessionId,
    workspaceRootPath: workspaceRoot,
    workingDirectory: workspaceRoot,
    plansFolderPath: join(workspaceRoot, 'plans'),
  });
}

describe('configured additional directories reach the permission gate', () => {
  // F1.1050 (DN-272): two arms here drove the retired explore, the one read-only mode that let a Write land in a
  // configured additional directory ("allows a write inside a configured additional directory", and the Pi
  // `path` spelling of it). Plan does not inherit that grant, so both became refusals, pinned below.
  it('F1.1050: plan refuses a write inside a configured additional directory, in both spellings', () => {
    const manager = safeModePermissionManager();
    expect(manager.evaluateToolCall('Write', { file_path: join(extraRoot, 'src/a.ts'), content: 'x' }).allowed).toBe(false);
    expect(manager.evaluateToolCall('Write', { path: join(extraRoot, 'src/pi.ts'), content: 'x' }).allowed).toBe(false);
  });

  it('still refuses a write outside every configured root', () => {
    const result = safeModePermissionManager()
      .evaluateToolCall('Write', { file_path: join(outsideRoot, 'a.ts'), content: 'x' });
    expect(result.allowed).toBe(false);
  });

  // F1.1192 — the two refusals above hold whether or not the roots reach the gate (plan refuses every Write outside the
  // plans and data folders), so they cannot catch a dropped `additionalDirectories` argument. Its live consumer is the
  // operator's read fence (`blockReadsOutsideWorkingDirectories`), which exempts a configured root in every mode: a Read
  // there is allowed only if the gate was handed the roots.
  it('F1.1192: with the read fence on, a Read inside a configured additional directory is allowed through the gate', () => {
    withReadFence(() => {
      const manager = safeModePermissionManager();
      expect(manager.evaluateToolCall('Read', { file_path: join(extraRoot, 'src/a.ts') })).toMatchObject({ allowed: true });
      expect(manager.evaluateToolCall('Grep', { pattern: 'x', path: join(extraRoot, 'src') })).toMatchObject({ allowed: true });
    });
  });

  it('F1.1192 BOUNDARY: with the read fence on, a Read outside every root is refused by the fence', () => {
    withReadFence(() => {
      const result = safeModePermissionManager().evaluateToolCall('Read', { file_path: join(outsideRoot, 'a.ts') });
      expect(result.allowed).toBe(false);
      expect(result.allowed ? '' : result.reason).toContain('Read blocked outside the working directories');
    });
  });

  it('reads the roots from the persisted setting', () => {
    expect(getConfiguredAdditionalDirectories()).toEqual([extraRoot]);
  });

  it('resolves a relative entry in the real config file against the config directory', () => {
    // The production caller's base, exercised through the production caller: the
    // one settings file that reaches this resolver is `<CONFIG_DIR>/config.json`.
    const sibling = join(CONFIG_DIR, 'relative-additional-root');
    mkdirSync(sibling, { recursive: true });
    const saved = readFileSync(CONFIG_FILE, 'utf-8');
    try {
      writeFileSync(
        CONFIG_FILE,
        JSON.stringify({ ...JSON.parse(saved), additionalDirectories: ['relative-additional-root'] }),
        'utf-8',
      );
      expect(getConfiguredAdditionalDirectories()).toEqual([realpathSync(sibling)]);
    } finally {
      writeFileSync(CONFIG_FILE, saved, 'utf-8');
      rmSync(sibling, { recursive: true, force: true });
    }
  });

});

describe('resolveAdditionalDirectories', () => {
  it('resolves a relative entry against the directory of the settings file that declared it', () => {
    // The documented shape (`large-codebases.md` shows `"../shared"`) was refused
    // outright until P6.516, so an author following the page lost the entry.
    const result = resolveAdditionalDirectories(['other-repo'], { settingsFileDirectory: sandbox });
    expect(result.roots).toEqual([extraRoot]);
    expect(result.diagnostics).toEqual([]);
  });

  it('still refuses a relative entry when no declaring file is known', () => {
    // The base, not the resolving, is what made the cwd unusable: with no file
    // there is nothing stable to resolve against, so the old refusal stands.
    const result = resolveAdditionalDirectories(['other-repo']);
    expect(result.roots).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toContain('other-repo');
  });

  it('names the RESOLVED path when a relative entry lands on nothing', () => {
    // Quoting the entry alone leaves the reader unable to see WHERE it went.
    const entry = '../nessy-no-such-additional-root';
    const result = resolveAdditionalDirectories([entry], { settingsFileDirectory: sandbox });
    expect(result.roots).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toContain(entry);
    expect(result.diagnostics[0]).toContain(resolve(sandbox, entry));
  });

  it('reports a missing entry rather than dropping it silently', () => {
    const missing = join(sandbox, 'no-such-root');
    const result = resolveAdditionalDirectories([missing]);
    expect(result.roots).toEqual([]);
    expect(result.diagnostics[0]).toContain(missing);
  });

  it('canonicalizes through realpath so a symlink cannot smuggle a root', () => {
    const link = join(sandbox, 'link-to-other-repo');
    symlinkSync(extraRoot, link);
    const result = resolveAdditionalDirectories([link]);
    expect(result.roots).toEqual([extraRoot]);
    expect(result.diagnostics).toEqual([]);
  });
});


/**
 * P6.394 (L41) — a directory added MID-SESSION takes effect on all three
 * runtimes without a restart, and this block exists because every one of the
 * three mechanisms is silent when it breaks.
 *
 * Measured at HEAD 2026-09-08 (W9-p2) and the row's remaining clause is
 * REFUTED: all three arms already work, by three different routes, and nothing
 * pinned any of them together. A lane that deleted the hash line in
 * `claudeLiveSessionSignature`, or the `codexAdditionalWritableRoots()` spread
 * in the codex re-fork override, would leave a running session on the old roots
 * with no test and no diagnostic to say so.
 */
describe('P6.394 · a directory added mid-session takes effect without a restart', () => {
  it('HOST + Pi — the gate answers from the persisted setting on the next call', () => {
    // The behavioural arm, driven through the real production caller: a root
    // that is refused, added to the file, then allowed — one process, no
    // restart, no re-import. The Pi backend's own `addDirectories` grant is the
    // second Pi route and is unioned on top of this list by
    // `SessionManager.sessionAdditionalDirectories`.
    const newRoot = join(sandbox, 'added-mid-session');
    mkdirSync(newRoot, { recursive: true });
    const saved = readFileSync(CONFIG_FILE, 'utf-8');
    try {
      // F1.1050: the gate half of this arm drove the retired explore's additional-directory Write; plan refuses
      // that Write before and after. F1.1192: the gate half is back through the read fence, which exempts a root.
      const read = () => safeModePermissionManager().evaluateToolCall('Read', { file_path: join(newRoot, 'a.ts') }).allowed;
      expect(getConfiguredAdditionalDirectories()).toEqual([extraRoot]);
      withReadFence(() => expect(read()).toBe(false));
      writeFileSync(
        CONFIG_FILE,
        JSON.stringify({ ...JSON.parse(saved), additionalDirectories: [extraRoot, newRoot] }),
        'utf-8',
      );
      expect(getConfiguredAdditionalDirectories()).toEqual([extraRoot, realpathSync(newRoot)]);
      withReadFence(() => expect(read()).toBe(true));
    } finally {
      writeFileSync(CONFIG_FILE, saved, 'utf-8');
      rmSync(newRoot, { recursive: true, force: true });
    }
  });

  it('CLAUDE — the option is hashed into the live-session signature, so a changed list RESPAWNS', () => {
    // The SDK has no setter that moves a directory root (the option is spent
    // once, in the argv builder, before the child starts), so respawn is the
    // only route and hashing it is what buys it. P6.34's line.
    const options = (roots: string[]) =>
      ({ cwd: '/tmp/x', additionalDirectories: roots }) as unknown as Parameters<typeof claudeLiveSessionSignature>[0];
    const base = options(['/a']);
    const added = options(['/a', '/b']);
    const reordered = options(['/b', '/a']);
    expect(claudeLiveSessionSignature(base)).not.toBe(claudeLiveSessionSignature(added));
    // UNSORTED on purpose: two added roots defining the same command name are
    // resolved by order, so a reorder is a real change of what the child loads.
    expect(claudeLiveSessionSignature(base)).not.toBe(claudeLiveSessionSignature(reordered));
    // Control: the signature is not simply different for every input.
    expect(claudeLiveSessionSignature(base)).toBe(claudeLiveSessionSignature(options(['/a'])));
  });

  it('CODEX — the added roots ride the hashed re-fork override', () => {
    // A SOURCE anchor, and deliberately so: the value is assembled inside a
    // private method on a class that needs an app-server subprocess to build,
    // and the thing that can break is the WIRING — the same instrument
    // `claude-add-dir-roots.test.ts` uses for the claude call site, for the same
    // reason. `codexThreadConfigSignature` hashes the object this spread lands
    // in, so losing the spread silently strands a running thread on old roots.
    const source = readFileSync(
      new URL('../codex-agent.ts', import.meta.url),
      'utf-8',
    );
    // F1.1003 — the spread now goes through `codexWritablePaths`, which is the
    // added roots plus (plan and explore only) the session's plans/data folders;
    // the second anchor pins that the added roots are still its first input.
    expect(source).toMatch(
      /writablePaths:\s*\[\.\.\.new Set\(\[\.\.\.pluginRuntime\.writablePaths, \.\.\.this\.codexWritablePaths\(\)\]\)\]\.sort\(\)/,
    );
    expect(source).toMatch(
      /private codexWritablePaths\(\): string\[\] \{ return codexModeWritablePaths\(this\.getPermissionMode\(\), this\.codexAdditionalWritableRoots\(\),/,
    );
    // The positive control the anchor needs: the signature function it feeds
    // still exists and still reads the whole object.
    expect(source).toMatch(/const signature = codexThreadConfigSignature\(config\)/);
  });
});
