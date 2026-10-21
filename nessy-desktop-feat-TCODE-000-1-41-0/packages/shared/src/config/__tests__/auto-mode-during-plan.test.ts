/**
 * P6.68 — `useAutoModeDuringPlan` tightens from a lower scope, and only ever
 * tightens.
 *
 * Shaped after `cross-session-inbound.test.ts`, the sibling exception key that
 * already resolves at the strict pole in this fork: one positive per direction
 * and one negative per direction, so neither "the file always wins" nor "the
 * operator always wins" can pass this suite.
 *
 * The asymmetry under test is the page's own
 * (`settings.md#exceptions-to-managed-settings-precedence`): a `false` from
 * `.claude/settings.local.json` is honoured, a `false` from
 * `.claude/settings.json` is **ignored**, and a `true` from either can lift
 * nothing.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AUTO_MODE_DURING_PLAN_SETTING_KEY,
  AUTO_MODE_DURING_PLAN_SETTINGS_FILES,
  resolveUseAutoModeDuringPlanWithScopes,
} from '../auto-mode-during-plan.ts';

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A project directory carrying whichever of the two files was named. */
function project(files: { project?: string; local?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'p6068-'));
  created.push(dir);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  if (files.project !== undefined) {
    writeFileSync(join(dir, AUTO_MODE_DURING_PLAN_SETTINGS_FILES.project), files.project);
  }
  if (files.local !== undefined) {
    writeFileSync(join(dir, AUTO_MODE_DURING_PLAN_SETTINGS_FILES.local), files.local);
  }
  return dir;
}

const ON = { operatorEnabled: true } as const;
const OFF = { operatorEnabled: false } as const;

describe('P6.68 · the honoured direction — a local `false` tightens', () => {
  it('a `false` in .claude/settings.local.json beats an operator `true`', () => {
    const workingDirectory = project({ local: '{ "useAutoModeDuringPlan": false }' });
    expect(resolveUseAutoModeDuringPlanWithScopes({ ...ON, workingDirectory }))
      .toEqual({ enabled: false, tightenedBy: 'local' });
  });

  it('and it is read through the jsonc reader the sibling files use', () => {
    // POSITIVE CONTROL on the parse path: comments and a trailing comma are what
    // a real co-owned `.claude` file contains, and a strict `JSON.parse` here
    // would fail open and silently drop the user's stricter value.
    const workingDirectory = project({
      local: '{\n  // the user turned the plan classifier off\n  "useAutoModeDuringPlan": false,\n}',
    });
    expect(resolveUseAutoModeDuringPlanWithScopes({ ...ON, workingDirectory }))
      .toEqual({ enabled: false, tightenedBy: 'local' });
  });
});

describe('P6.68 · the refused direction — nothing can loosen', () => {
  /** KILLS: treating the exception as a plain override. */
  it('a `true` in the local file does NOT lift an operator `false`', () => {
    const workingDirectory = project({ local: '{ "useAutoModeDuringPlan": true }' });
    expect(resolveUseAutoModeDuringPlanWithScopes({ ...OFF, workingDirectory }))
      .toEqual({ enabled: false });
  });

  /** KILLS: honouring the repository-owned file, which the page excludes. */
  it('a `false` in .claude/settings.json is IGNORED, and the refusal is REPORTED', () => {
    const workingDirectory = project({ project: '{ "useAutoModeDuringPlan": false }' });
    // The value does not move — and `ignoredProjectFalse` is what lets a caller
    // say so, because a silent refusal reads to everyone as a defect.
    expect(resolveUseAutoModeDuringPlanWithScopes({ ...ON, workingDirectory }))
      .toEqual({ enabled: true, ignoredProjectFalse: true });
  });

  it('a `true` in the project file lifts nothing either', () => {
    const workingDirectory = project({ project: '{ "useAutoModeDuringPlan": true }' });
    expect(resolveUseAutoModeDuringPlanWithScopes({ ...OFF, workingDirectory }))
      .toEqual({ enabled: false });
  });

  /**
   * BOTH files at once, in the one combination where the asymmetry is the whole
   * answer: the repository says off, the user says on. The repository is ignored
   * AND the user's `true` cannot loosen the operator, so an operator `false`
   * survives both.
   */
  it('the two files together cannot produce a value laxer than the operator asked for', () => {
    const workingDirectory = project({
      project: '{ "useAutoModeDuringPlan": false }',
      local: '{ "useAutoModeDuringPlan": true }',
    });
    expect(resolveUseAutoModeDuringPlanWithScopes({ ...OFF, workingDirectory }))
      .toEqual({ enabled: false, ignoredProjectFalse: true });
    // …and with the operator ON, the same pair still only reports the refusal.
    expect(resolveUseAutoModeDuringPlanWithScopes({ ...ON, workingDirectory }))
      .toEqual({ enabled: true, ignoredProjectFalse: true });
  });
});

describe('P6.68 · absence, malformation and the no-directory case all fail OPEN', () => {
  it('no working directory leaves the operator value exactly as it was', () => {
    expect(resolveUseAutoModeDuringPlanWithScopes(ON)).toEqual({ enabled: true });
    expect(resolveUseAutoModeDuringPlanWithScopes(OFF)).toEqual({ enabled: false });
  });

  it.each([
    ['both files absent', {}],
    ['the key absent', { local: '{ "somethingElse": false }' }],
    ['a non-boolean value', { local: '{ "useAutoModeDuringPlan": "false" }' }],
    ['an unparseable document', { local: '{ this is not settings' }],
    ['an array at the root', { local: '[false]' }],
  ] as const)('%s contributes nothing', (_name, files) => {
    const workingDirectory = project(files);
    expect(resolveUseAutoModeDuringPlanWithScopes({ ...ON, workingDirectory }))
      .toEqual({ enabled: true });
  });

  it('the key is spelled exactly as the page spells it', () => {
    // A rename here silently disconnects the exception from the files real
    // Claude Code writes, and nothing else in the suite would notice.
    expect(AUTO_MODE_DURING_PLAN_SETTING_KEY).toBe('useAutoModeDuringPlan');
    expect(AUTO_MODE_DURING_PLAN_SETTINGS_FILES.local).toBe('.claude/settings.local.json');
    expect(AUTO_MODE_DURING_PLAN_SETTINGS_FILES.project).toBe('.claude/settings.json');
  });
});

describe('P6.68 · the resolver carries no provider term, which is why one site serves three', () => {
  /**
   * The switch verdict is `UNIFORM` AT THE RESOLVER and unchanged at behaviour —
   * `getUseAutoModeDuringPlan` has one production caller and it is `PiAgent`'s.
   * This asserts the first half mechanically: no runtime name appears anywhere in
   * the module, so it cannot grow a per-runtime branch without failing here.
   */
  it('names no runtime anywhere in its source', async () => {
    const source = await Bun.file(new URL('../auto-mode-during-plan.ts', import.meta.url)).text();
    // The docblock DISCUSSES all three by name, so the check is on code only.
    const code = source.slice(source.indexOf("import { readFileSync }"));
    for (const runtime of ['claude-runtime', 'codex-runtime', 'providerType', 'AgentProvider']) {
      expect(code, `${runtime} appears in the resolver's code`).not.toContain(runtime);
    }
    // POSITIVE CONTROL: the read did land on the right file.
    expect(code).toContain('resolveUseAutoModeDuringPlanWithScopes');
  });
});
