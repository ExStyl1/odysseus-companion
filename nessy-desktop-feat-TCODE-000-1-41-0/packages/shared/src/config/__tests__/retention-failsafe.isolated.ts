/**
 * The unreadable-settings fail-safe, end to end on a real config directory.
 *
 * `CONFIG_DIR` is resolved from the environment at module load, so these run in
 * a subprocess with `NESSY_CONFIG_DIR` pointed at a temp tree. That is the only
 * way to exercise the PRODUCTION path — `runSessionRetentionSweep()` with no
 * argument, reading the real `loadStoredConfig()` and hitting its throw — rather
 * than the pure resolver the colocated suite already covers.
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const STORAGE_MODULE = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href;
const SESSIONS_MODULE = pathToFileURL(join(import.meta.dir, '..', '..', 'sessions', 'storage.ts')).href;

/**
 * Per-case budget, set against a MEASURED floor rather than left at bun's
 * 5 000 ms default (P3.354, 2026-09-04) — RE-MEASURED and RAISED to 180 000 ms
 * (P6.857, 2026-09-08), because the first derivation priced the wrong thing.
 *
 * Every case here spawns a `bun --eval` child that imports `config/storage.ts`
 * and `sessions/storage.ts` — a real runtime start over a real module graph, not
 * an in-process call. The 60 000 ms value came from happy-path per-case readings
 * (6.0-11.6 s across three whole-file runs at loads 9.6 / 17.5 / 12.2) taken at
 * roughly 5x the slowest. **What the budget actually pays for is the CHILD's
 * module-graph load, and the instrument that prices that is the zero-case
 * control** — `bun test <this file> -t '<a name nothing matches>'`, which loads
 * the graph and runs nothing: **30.97 s wall, 0 tests executed, 0.54 s user /
 * 0.19 s sys at load 13.5** (2026-09-08). Cpu under 2 % of wall, so those 31 s
 * are I/O rather than work, and every case pays a graph load of the same class
 * inside its own child.
 *
 * I/O on this tree is not stable to within a factor of five. Three whole-file
 * runs of these identical bytes on one afternoon at comparable loads:
 * **43.58 s at load 10.5, 214.78 s at load 11.2, 216.87 s at load 9.3**, all
 * `7 pass / 0 fail`, user+sys never above 2.7 % of wall — a 5x spread running
 * BACKWARDS against load. On the same file W9-ap measured `3 pass / 4 fail` at
 * load 7.04 while holding the test mutex, every failure a bare timeout at
 * `[6037x ms]` with `expect(code, out).toBe(0)` receiving `-1`: the child was
 * KILLED at this budget, so the true per-case cost of that run is unknown and
 * bounded only from below, at 60 s.
 *
 * 180 000 ms is ~6x the 31 s the zero-case control prices the graph at — the old
 * ratio applied to the cost the budget is really spent on — and it is the value
 * the register already measured green three times. It is a ceiling on a HANG,
 * not a performance assertion. Do not lower it toward the observed value: a knob
 * set at the resting state manufactures its own failure, and here that failure
 * stopped a whole gate — this is the FIRST file `test:isolated`'s `find`
 * returns and the loop is `|| exit 1`, so a red here means the other nine
 * isolated suites never run at all.
 */
const RETENTION_SUBPROCESS_BUDGET_MS = 180_000;

const DAY_MS = 24 * 60 * 60 * 1000;

function makeConfigDir(configJson: string): string {
  const root = mkdtempSync(join(tmpdir(), 'nessy-retention-failsafe-'));
  writeFileSync(join(root, 'config.json'), configJson);
  return root;
}

/** Seed one session whose transcript header is 400 days old. */
function seedOldSession(root: string, workspaceId: string, sessionId: string): string {
  const dir = join(root, 'sessions', workspaceId, sessionId);
  mkdirSync(dir, { recursive: true });
  const header = {
    id: sessionId,
    workspaceId,
    createdAt: Date.now() - (400 * DAY_MS),
    lastUsedAt: Date.now() - (400 * DAY_MS),
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  };
  writeFileSync(join(dir, 'session.jsonl'), `${JSON.stringify(header)}\n`);
  return dir;
}

/** Seed one session whose transcript header is `ageDays` old. */
function seedRecentSession(root: string, workspaceId: string, sessionId: string, ageDays: number): string {
  const dir = join(root, 'sessions', workspaceId, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.jsonl'), `${JSON.stringify(sessionHeader(workspaceId, sessionId, ageDays))}\n`);
  return dir;
}

function sessionHeader(workspaceId: string, sessionId: string, ageDays: number) {
  return {
    id: sessionId,
    workspaceId,
    createdAt: Date.now() - (ageDays * DAY_MS),
    lastUsedAt: Date.now() - (ageDays * DAY_MS),
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  };
}

/** The same seeding, as source the child process runs after its own config write. */
function seedCode(dir: string, workspaceId: string, sessionId: string, ageDays: number): string {
  const header = JSON.stringify(`${JSON.stringify(sessionHeader(workspaceId, sessionId, ageDays))}\n`);
  return `
    (await import('node:fs')).mkdirSync(${JSON.stringify(dir)}, { recursive: true });
    (await import('node:fs')).writeFileSync(${JSON.stringify(join(dir, 'session.jsonl'))}, ${header});
  `;
}

function run(root: string, body: string): { code: number; out: string } {
  const result = Bun.spawnSync([process.execPath, '--eval', `
    import { existsSync } from 'node:fs';
    import {
      getRetentionSettings,
      getRetentionSweepStatus,
      registerManagedRetentionDaysProvider,
      runSessionRetentionSweep,
      setRetentionDays,
      setRetentionSweepEnabled,
    } from '${STORAGE_MODULE}';
    import { listSessions } from '${SESSIONS_MODULE}';
    ${body}
  `], {
    env: { ...process.env, NESSY_CONFIG_DIR: root },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: result.exitCode ?? -1,
    out: `${result.stdout.toString()}\n${result.stderr.toString()}`,
  };
}

describe('retention fail-safe on a real config directory', () => {
  it('pauses the sweep and surfaces a warning when config.json cannot be parsed', () => {
    const root = makeConfigDir('{ this is not json');
    const session = seedOldSession(root, 'ws-1', 'ancient');
    try {
      const { code, out } = run(root, `
        const removed = runSessionRetentionSweep();
        console.log(JSON.stringify({
          removed,
          status: getRetentionSweepStatus(),
          settings: getRetentionSettings(),
          sessionSurvived: existsSync(${JSON.stringify(session)}),
        }));
      `);
      expect(code, out).toBe(0);
      const parsed = JSON.parse(out.split('\n').find(line => line.startsWith('{'))!);
      // It must not crash, must not sweep, and must say why.
      expect(parsed.removed).toBe(0);
      expect(parsed.status.state).toBe('paused');
      expect(parsed.status.warning).toContain('paused');
      expect(parsed.sessionSurvived).toBe(true);
      // And the warning has to reach the payload the settings card renders — a
      // pause nobody is told about is the half of the documented sweep that used
      // to be missing here. `claude-directory.md#cleaned-up-automatically`:
      // "if Claude Code can't safely determine the retention period, it pauses
      // the retention cleanup sweep", and "Claude Code also shows a warning in
      // `/status` until you fix the settings errors".
      // Asserted on the surface's DTO, not on the sweep's record: the
      // DTO is what a process that never swept can still answer with.
      expect(parsed.settings.warning).toContain('paused');
      expect(parsed.settings.effectiveDays).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, RETENTION_SUBPROCESS_BUDGET_MS);

  it('a managed cleanupPeriodDays sweeps through the same unreadable file', () => {
    const root = makeConfigDir('{ this is not json');
    const session = seedOldSession(root, 'ws-1', 'ancient');
    try {
      const { code, out } = run(root, `
        registerManagedRetentionDaysProvider(() => 30);
        const removed = runSessionRetentionSweep();
        console.log(JSON.stringify({
          removed,
          status: getRetentionSweepStatus(),
          sessionSurvived: existsSync(${JSON.stringify(session)}),
        }));
      `);
      expect(code, out).toBe(0);
      const parsed = JSON.parse(out.split('\n').find(line => line.startsWith('{'))!);
      expect(parsed.status).toMatchObject({ state: 'swept', retentionDays: 30, source: 'managed' });
      expect(parsed.removed).toBe(1);
      // The workspace list is unreadable too, so the sweep has to enumerate the
      // session root itself — otherwise the managed override would sweep nothing.
      expect(parsed.sessionSurvived).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, RETENTION_SUBPROCESS_BUDGET_MS);

  it('a persisted 0 disables cleanup and leaves an ancient session in place', () => {
    const root = makeConfigDir(JSON.stringify({
      storageLayoutVersion: 2,
      workspaceRefs: [{ id: 'ws-1', lastAccessedAt: 1 }],
      activeWorkspaceId: 'ws-1',
      activeSessionId: null,
      retentionDays: 0,
    }));
    const session = seedOldSession(root, 'ws-1', 'ancient');
    try {
      const { code, out } = run(root, `
        const removed = runSessionRetentionSweep();
        console.log(JSON.stringify({
          removed,
          status: getRetentionSweepStatus(),
          sessionSurvived: existsSync(${JSON.stringify(session)}),
        }));
      `);
      expect(code, out).toBe(0);
      const parsed = JSON.parse(out.split('\n').find(line => line.startsWith('{'))!);
      expect(parsed.status.state).toBe('disabled');
      expect(parsed.status.warning).toContain('0');
      expect(parsed.removed).toBe(0);
      expect(parsed.sessionSurvived).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, RETENTION_SUBPROCESS_BUDGET_MS);

  /**
   * The destructive consequence, stated as a test.
   *
   * The sweep DELETES the user's transcripts. Turning it off from the product
   * therefore has to mean the sweep does not run — not a window large enough
   * that nothing is old enough yet, which starts deleting the day the data ages
   * past it. So this asserts on the filesystem, not on the flag: a session 400
   * days old, well past any default, still exists after the sweep.
   */
  it('the product off switch stops the sweep and an ancient session survives it', () => {
    const root = makeConfigDir(JSON.stringify({
      storageLayoutVersion: 2,
      workspaceRefs: [{ id: 'ws-1', lastAccessedAt: 1 }],
      activeWorkspaceId: 'ws-1',
      activeSessionId: null,
      retentionDays: 7,
    }));
    const session = join(root, 'sessions', 'ws-1', 'ancient');
    try {
      // The session is seeded INSIDE the child, after the write. `saveConfig`
      // calls `ensureConfigDir`, which runs the once-per-process startup sweep,
      // so in a fresh process the first config write of any kind sweeps at the
      // OLD window. In the app that sweep has already happened at launch, long
      // before a settings page can be opened; seeding afterwards is what
      // reproduces that ordering instead of an artefact of the harness.
      const { code, out } = run(root, `
        setRetentionSweepEnabled(false);
        ${seedCode(session, 'ws-1', 'ancient', 400)}
        const removed = runSessionRetentionSweep();
        console.log(JSON.stringify({
          removed,
          status: getRetentionSweepStatus(),
          settings: getRetentionSettings(),
          sessionSurvived: existsSync(${JSON.stringify(session)}),
        }));
      `);
      expect(code, out).toBe(0);
      const parsed = JSON.parse(out.split('\n').find(line => line.startsWith('{'))!);
      expect(parsed.status.state).toBe('disabled');
      expect(parsed.removed).toBe(0);
      expect(parsed.sessionSurvived).toBe(true);
      // The window is preserved, not overwritten, so turning it back on restores
      // the user's own value rather than the packaged default.
      expect(parsed.settings).toMatchObject({ days: 7, sweepEnabled: false, effectiveDays: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, RETENTION_SUBPROCESS_BUDGET_MS);

  it('a managed cleanupPeriodDays overrides the product off switch', () => {
    const root = makeConfigDir(JSON.stringify({
      storageLayoutVersion: 2,
      workspaceRefs: [{ id: 'ws-1', lastAccessedAt: 1 }],
      activeWorkspaceId: 'ws-1',
      activeSessionId: null,
      retentionSweepEnabled: false,
    }));
    const session = seedOldSession(root, 'ws-1', 'ancient');
    try {
      const { code, out } = run(root, `
        registerManagedRetentionDaysProvider(() => 30);
        const removed = runSessionRetentionSweep();
        console.log(JSON.stringify({
          removed,
          status: getRetentionSweepStatus(),
          sessionSurvived: existsSync(${JSON.stringify(session)}),
        }));
      `);
      expect(code, out).toBe(0);
      const parsed = JSON.parse(out.split('\n').find(line => line.startsWith('{'))!);
      // `claude-directory.md#cleaned-up-automatically` makes managed
      // `cleanupPeriodDays` the tier that overrides even the unreadable-settings
      // pause — "When managed settings provide `cleanupPeriodDays`, Claude Code
      // runs the sweep at the managed value in either case" — so it overrides a
      // local off switch too.
      expect(parsed.status).toMatchObject({ state: 'swept', retentionDays: 30, source: 'managed' });
      expect(parsed.sessionSurvived).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, RETENTION_SUBPROCESS_BUDGET_MS);

  /**
   * The window is settable from the product, and the write goes through the
   * validator. `settings-reference.md#cleanupperioddays` — "**Type**: number of
   * days, a whole number, minimum `1`", and "Setting `0` fails validation, so
   * pick a large value such as `3650` for long retention."
   */
  it('a product write of the window reaches the sweep and 0 is rejected', () => {
    const root = makeConfigDir(JSON.stringify({
      storageLayoutVersion: 2,
      workspaceRefs: [{ id: 'ws-1', lastAccessedAt: 1 }],
      activeWorkspaceId: 'ws-1',
      activeSessionId: null,
    }));
    const recent = seedRecentSession(root, 'ws-1', 'recent', 3);
    try {
      const { code, out } = run(root, `
        setRetentionDays(1);
        let rejected = 'not-thrown';
        try { setRetentionDays(0); } catch (error) { rejected = error.name; }
        const removed = runSessionRetentionSweep();
        console.log(JSON.stringify({
          rejected,
          removed,
          status: getRetentionSweepStatus(),
          settings: getRetentionSettings(),
          recentSurvived: existsSync(${JSON.stringify(recent)}),
        }));
      `);
      expect(code, out).toBe(0);
      const parsed = JSON.parse(out.split('\n').find(line => line.startsWith('{'))!);
      expect(parsed.rejected).toBe('InvalidRetentionDaysError');
      // The one-day window the product wrote is the one the sweep used, and it
      // reached a session the 30-day default would have kept.
      expect(parsed.status).toMatchObject({ state: 'swept', retentionDays: 1, source: 'user' });
      expect(parsed.recentSurvived).toBe(false);
      expect(parsed.settings).toMatchObject({ days: 1, sweepEnabled: true, effectiveDays: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, RETENTION_SUBPROCESS_BUDGET_MS);

  it('a readable config with no retentionDays sweeps at the 30-day default', () => {
    const root = makeConfigDir(JSON.stringify({
      storageLayoutVersion: 2,
      workspaceRefs: [{ id: 'ws-1', lastAccessedAt: 1 }],
      activeWorkspaceId: 'ws-1',
      activeSessionId: null,
    }));
    const ancient = seedOldSession(root, 'ws-1', 'ancient');
    try {
      const { code, out } = run(root, `
        const removed = runSessionRetentionSweep();
        console.log(JSON.stringify({
          removed,
          status: getRetentionSweepStatus(),
          sessionSurvived: existsSync(${JSON.stringify(ancient)}),
          listed: listSessions('ws-1').map(entry => entry.id),
        }));
      `);
      expect(code, out).toBe(0);
      const parsed = JSON.parse(out.split('\n').find(line => line.startsWith('{'))!);
      expect(parsed.status).toMatchObject({ state: 'swept', retentionDays: 30, source: 'default' });
      expect(parsed.removed).toBe(1);
      expect(parsed.sessionSurvived).toBe(false);
      expect(parsed.listed).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, RETENTION_SUBPROCESS_BUDGET_MS);
});
