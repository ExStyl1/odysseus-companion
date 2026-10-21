import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWorkspaceConfig, saveWorkspaceConfig } from '../storage.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors in tests
    }
  }
});

describe('workspace storage: canonical config values', () => {
  it('preserves defaults.permissionMode and cyclablePermissionModes on read', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ws-mode-map-'));
    tempDirs.push(workspaceRoot);

    const rawConfig = {
      id: 'ws_123',
      name: 'Test Workspace',
      slug: 'test-workspace',
      defaults: {
        permissionMode: 'safe',
        cyclablePermissionModes: ['safe', 'ask', 'allow-all'],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify(rawConfig, null, 2), 'utf-8');

    const loaded = loadWorkspaceConfig(workspaceRoot);
    expect(loaded).not.toBeNull();
    // F1.1050: `safe` (explore's old spelling) reads as plan — the retired explore is never read back.
    expect(loaded?.defaults?.permissionMode).toBe('plan');
    expect(loaded?.defaults?.cyclablePermissionModes).toEqual(['plan', 'default', 'bypassPermissions']);
  });

  it('preserves a configured canonical permission cycle', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ws-mode-invalid-'));
    tempDirs.push(workspaceRoot);

    const rawConfig = {
      id: 'ws_456',
      name: 'Broken Modes',
      slug: 'broken-modes',
      defaults: {
        permissionMode: 'allow-all',
        cyclablePermissionModes: ['safe', 'plan', 'ask', 'acceptEdits', 'auto', 'allow-all'],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify(rawConfig, null, 2), 'utf-8');

    const loaded = loadWorkspaceConfig(workspaceRoot);
    expect(loaded).not.toBeNull();
    expect(loaded?.defaults?.permissionMode).toBe('bypassPermissions');
    // F1.1050: `safe` and `plan` both read as plan, and the cycle keeps ONE of them (deduped, order kept) —
    // a stored [explore, plan] must not put plan in the SHIFT+TAB cycle twice.
    expect(loaded?.defaults?.cyclablePermissionModes).toEqual(['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions']);
  });

  it('preserves a canonical thinking level on read', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ws-thinking-legacy-'));
    tempDirs.push(workspaceRoot);

    const rawConfig = {
      id: 'ws_789',
      name: 'Legacy Thinking',
      slug: 'legacy-thinking',
      defaults: {
        thinkingLevel: 'medium',
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify(rawConfig, null, 2), 'utf-8');

    const loaded = loadWorkspaceConfig(workspaceRoot);
    expect(loaded).not.toBeNull();
    expect(loaded?.defaults?.thinkingLevel).toBe('medium');
  });
});

describe('workspace storage: F1.1053 — a stored explore default', () => {
  it('reads explore as plan (the cycle keeps one plan) and the saved config.json never says explore', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ws-mode-retired-'));
    tempDirs.push(workspaceRoot);
    const configPath = join(workspaceRoot, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      id: 'ws_f1053',
      name: 'Retired Mode',
      slug: 'retired-mode',
      defaults: { permissionMode: 'explore', cyclablePermissionModes: ['explore', 'plan', 'default', 'acceptEdits'] },
      createdAt: 1,
      updatedAt: 1,
    }, null, 2), 'utf-8');
    expect(readFileSync(configPath, 'utf-8')).toContain('"explore"'); // the needle below is spellable in this file

    const loaded = loadWorkspaceConfig(workspaceRoot);
    expect(loaded?.defaults?.permissionMode).toBe('plan');
    expect(loaded?.defaults?.cyclablePermissionModes).toEqual(['plan', 'default', 'acceptEdits']);

    saveWorkspaceConfig(workspaceRoot, loaded!);
    expect(readFileSync(configPath, 'utf-8')).not.toContain('"explore"');
    expect(loadWorkspaceConfig(workspaceRoot)?.defaults?.permissionMode).toBe('plan');
  });
});
