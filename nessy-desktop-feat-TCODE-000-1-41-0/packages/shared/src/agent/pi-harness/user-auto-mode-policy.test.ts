/**
 * P6.493 — the user scope's `autoMode` block is READ, and can only narrow.
 *
 * `e473ec877` landed the trust boundary inside `resolveAutoMode`: a `user`
 * scope contributes `hard_deny`/`soft_deny` and nothing else. W8-j measured
 * that nothing built such a block — the one production caller passes `managed`
 * alone — so the boundary guarded a path no document could reach. This pins the
 * reader that reaches it, end to end: a real settings file on disk, through
 * `resolveAutoMode`, into the composed policy the judge is handed.
 *
 * Every arm has its control. A narrowing that "works" is indistinguishable from
 * a reader that returns nothing at all unless the same file's `allow` entry is
 * shown NOT to arrive.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAutoMode } from './managed-policy.ts';
import { describeRefusedUserAutoModeKeys, readUserScopeAutoModePolicy } from './user-auto-mode-policy.ts';

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'nessy-user-automode-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function writeSettings(document: unknown): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify(document), 'utf-8');
}

function read() {
  return readUserScopeAutoModePolicy({ claudeConfigDirectory: configDir });
}

describe('the user scope may tighten the judge and may never widen it', () => {
  it('carries hard_deny and soft_deny through, and refuses allow and environment by name', () => {
    writeSettings({
      autoMode: {
        hard_deny: ['never touch production'],
        soft_deny: ['ask before deleting'],
        allow: ['anything at all'],
        environment: ['this is a laptop'],
      },
    });

    const result = read();
    expect(result.policy?.hard_deny).toEqual(['never touch production']);
    expect(result.policy?.soft_deny).toEqual(['ask before deleting']);
    // The control, and the whole point of the row: the two widening keys are
    // gone from what is handed on, not merely ignored downstream.
    expect(result.policy?.allow).toBeUndefined();
    expect(result.policy?.environment).toBeUndefined();
    expect(result.refusedKeys).toEqual(['environment', 'allow']);
  });

  it('composes with the managed scope so the user entry is ADDED, never substituted', () => {
    writeSettings({ autoMode: { soft_deny: ['ask before deleting'], allow: ['anything at all'] } });

    const resolved = resolveAutoMode(
      { managed: { soft_deny: ['no force pushes'], allow: ['git status'] }, user: read().policy },
      { environment: [], hard_deny: [], soft_deny: [], allow: [] },
    );

    expect(resolved.soft_deny).toEqual(['no force pushes', 'ask before deleting']);
    // The user's `allow` reached neither the reader nor the composer: the
    // managed allow set is exactly what it was.
    expect(resolved.allow).toEqual(['git status']);
  });

  it('names an empty managed-only set too, because writing one is a statement', () => {
    // `"allow": []` is not silence — it says "no allow rules" — and answering a
    // statement with nothing is the same defect as dropping a populated set.
    writeSettings({ autoMode: { hard_deny: ['x'], allow: [] } });
    const result = read();
    expect(result.refusedKeys).toEqual(['allow']);
    expect(describeRefusedUserAutoModeKeys(result)).toContain('autoMode.allow');
    expect(describeRefusedUserAutoModeKeys(result)).toContain('Managed settings are the only home');
  });

  it('refuses the band control, which is resolved from the managed scope alone', () => {
    // `classifyAllShell` changes which actions reach the judge rather than what
    // the judge is told, and `SessionManager` reads it from `managed` only.
    // Handing it on here would be a promise this module cannot keep.
    writeSettings({ autoMode: { hard_deny: ['x'], classifyAllShell: true } });
    const result = read();
    expect(result.policy?.classifyAllShell).toBeUndefined();
    expect(result.refusedKeys).toEqual(['classifyAllShell']);
  });
});

describe('a file that says nothing contributes nothing, and says why when it tried to', () => {
  it('reads no file at all without failing', () => {
    const result = read();
    expect(result.policy).toBeUndefined();
    expect(result.refusedKeys).toEqual([]);
    expect(result.invalidReason).toBeUndefined();
    expect(result.path).toBe(join(configDir, 'settings.json'));
  });

  it('reads a settings file with no autoMode block', () => {
    writeSettings({ permissions: { deny: ['Bash(rm -rf *)'] } });
    const result = read();
    expect(result.policy).toBeUndefined();
    expect(result.invalidReason).toBeUndefined();
  });

  it('refuses a malformed block WHOLESALE and names the refusal', () => {
    // Strict is this parser's own recorded posture for the user tier: the
    // tolerant sink exists for the managed document, where dropping one key and
    // enforcing the rest is what the invalid-entries rule requires.
    writeSettings({ autoMode: { hard_deny: 'not-a-list' } });
    const result = read();
    expect(result.policy).toBeUndefined();
    expect(result.invalidReason).toBe('autoMode block is not valid');
  });

  it('refuses a settings file that is not JSON', () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'settings.json'), '{ this is not json', 'utf-8');
    const result = read();
    expect(result.policy).toBeUndefined();
    expect(result.invalidReason).toBe('settings file is not valid JSON');
  });

  it('says nothing when there is nothing to say', () => {
    writeSettings({ autoMode: { hard_deny: ['x'] } });
    expect(describeRefusedUserAutoModeKeys(read())).toBeUndefined();
  });
});
