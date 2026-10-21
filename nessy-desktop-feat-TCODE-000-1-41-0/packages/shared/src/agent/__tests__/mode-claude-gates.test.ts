/**
 * Claude's mode gates (permission-modes.md), items 1 and 3 of the vocabulary
 * migration's gate task:
 *
 * 1. `bypassPermissions` is IN the DEFAULT cycle since D1.369 (owner,
 *    2026-09-18: *"нужно не скрывать, он должен быть доступен"*). It used to be
 *    out, on permission-modes.md's "can only be set at startup" — a CLI launch
 *    flag this product does not have. What the desktop has instead is the
 *    first-activation responsibility dialog, and that is where the gate lives.
 * 3. `auto`'s write auto-approval binds to the workspace roots — the same
 *    roots `acceptEdits` already uses. It used to pass
 *    `autoAllowFileWrites: true` with NO roots, and the roots check returned
 *    true unconditionally: a write anywhere on disk was auto-approved.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'bun:test';
import { DEFAULT_CYCLABLE_PERMISSION_MODES, PERMISSION_MODE_ORDER } from '../mode-types.ts';
import { buildClaudePermissionModeOptions } from '../claude-permission-mode.ts';
import { claudeLiveSessionSignature } from '../backend/claude/live-session.ts';
import { cleanupModeState, initializeModeState } from '../mode-manager.ts';
import { runPreToolUseChecks, type PermissionManagerLike } from '../core/pre-tool-use.ts';

const workspaceRootPath = mkdtempSync(join(tmpdir(), 'auto-roots-ws-'));
const outsideDir = mkdtempSync(join(tmpdir(), 'auto-roots-outside-'));
const extraDir = mkdtempSync(join(tmpdir(), 'auto-roots-extra-'));

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
};

describe('bypassPermissions is in the default cycle (D1.369)', () => {
  it('is present in DEFAULT_CYCLABLE_PERMISSION_MODES; only dontAsk is out', () => {
    expect(DEFAULT_CYCLABLE_PERMISSION_MODES).toContain('bypassPermissions');
    // The decision D1.369 deliberately does NOT touch. `dontAsk` stays out for
    // its own reason — it silently denies and never prompts — and it is the
    // control that keeps the line above from reading as "the filter is gone".
    expect(DEFAULT_CYCLABLE_PERMISSION_MODES).not.toContain('dontAsk');
    expect(DEFAULT_CYCLABLE_PERMISSION_MODES)
      .toEqual(['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions']);
    // Derived, not hand-listed: the cycle is PERMISSION_MODE_ORDER minus the one
    // picker-hidden mode, so a mode added to the vocabulary joins the cycle by
    // construction instead of being forgotten here.
    expect(DEFAULT_CYCLABLE_PERMISSION_MODES)
      .toEqual(PERMISSION_MODE_ORDER.filter(mode => mode !== 'dontAsk'));
  });

  it('is present in the shipped config-defaults cycle, which must agree with it', () => {
    // THE PAIR. `syncConfigDefaults()` rewrites the user's copy from this asset
    // on every launch and `FALLBACK_CONFIG_DEFAULTS` covers the broken install,
    // so a one-place flip makes the app's rotation depend on the shape of the
    // install — the drift `default-permission-mode.test.ts` was written for.
    const bundled = JSON.parse(readFileSync(
      resolve(import.meta.dir, '../../../../../apps/electron/resources/config-defaults.json'),
      'utf-8',
    )) as { workspaceDefaults: { cyclablePermissionModes: string[] } };
    expect(bundled.workspaceDefaults.cyclablePermissionModes).toContain('bypassPermissions');
    expect(bundled.workspaceDefaults.cyclablePermissionModes)
      .toEqual([...DEFAULT_CYCLABLE_PERMISSION_MODES]);
  });

  it('the Claude child is RE-LAUNCHED with the bypass flag rather than told to switch', () => {
    // What "available in the picker" costs on this runtime, measured at the one
    // seam that decides it. The shipped CLI refuses the live transition by name
    // — *"Cannot set permission mode to bypassPermissions because the session
    // was not launched with --dangerously-skip-permissions"*, which the vendored
    // darwin-arm64 binary spells verbatim (`grep -aoF` → 2 on 2026-09-18) — and
    // `claudeLiveSessionSignature` hashes `allowDangerouslySkipPermissions` for
    // exactly that reason, so crossing the boundary drifts the signature and
    // `ensureLiveSession` respawns with `--permission-mode bypassPermissions`
    // AND `--allow-dangerously-skip-permissions`. No start-option change is owed
    // in `claude-agent.ts`: the mechanism predates this row.
    const bypass = buildClaudePermissionModeOptions('bypassPermissions');
    expect(bypass.permissionMode).toBe('bypassPermissions');
    expect(bypass.allowDangerouslySkipPermissions).toBe(true);
    // ...and no OTHER mode carries the flag, so the drift is the boundary and
    // not a flag set for everyone.
    for (const mode of PERMISSION_MODE_ORDER.filter(m => m !== 'bypassPermissions')) {
      expect({ mode, flag: buildClaudePermissionModeOptions(mode).allowDangerouslySkipPermissions })
        .toEqual({ mode, flag: undefined });
    }
    const signature = (mode: 'auto' | 'bypassPermissions') =>
      claudeLiveSessionSignature(buildClaudePermissionModeOptions(mode));
    expect(signature('bypassPermissions')).not.toBe(signature('auto'));
    // POSITIVE CONTROL on the same instrument: two modes on the SAME side of the
    // boundary do NOT drift it, so the line above is the flag and not "every
    // mode respawns".
    expect(claudeLiveSessionSignature(buildClaudePermissionModeOptions('auto')))
      .toBe(claudeLiveSessionSignature(buildClaudePermissionModeOptions('acceptEdits')));
  });
});

describe("auto's write auto-approval binds to the workspace roots", () => {
  // The gate resolves the EFFECTIVE mode from the mode-state store, so each
  // case initializes its own session key in auto.
  let sequence = 0;
  const baseInput = (overrides: Record<string, unknown>) => {
    sequence += 1;
    const sessionKey = { workspaceId: 'auto-roots', sessionId: `auto-roots-${sequence}` };
    initializeModeState(sessionKey, 'auto');
    return {
      sessionId: sessionKey.sessionId,
      sessionKey,
      permissionMode: 'auto' as const,
      workspaceRootPath,
      workingDirectory: workspaceRootPath,
      permissionManager,
      permissionsContext: { workspaceRootPath },
      ...overrides,
    };
  };
  afterAll(() => {
    for (let index = 1; index <= sequence; index += 1) {
      cleanupModeState({ workspaceId: 'auto-roots', sessionId: `auto-roots-${index}` });
    }
  });

  it('a write outside every root prompts instead of auto-running', () => {
    const outcome = runPreToolUseChecks(baseInput({
      toolName: 'Write',
      input: { file_path: join(outsideDir, 'outside.txt'), content: 'value' },
    }) as never);
    expect(outcome.type).toBe('prompt');
  });

  it('a write inside the working directory still auto-runs', () => {
    const outcome = runPreToolUseChecks(baseInput({
      toolName: 'Write',
      input: { file_path: join(workspaceRootPath, 'src/out.txt'), content: 'value' },
    }) as never);
    expect(outcome.type).toBe('allow');
  });

  it('a session-granted additional directory is a root too, same as acceptEdits', () => {
    const outcome = runPreToolUseChecks(baseInput({
      toolName: 'Write',
      input: { file_path: join(extraDir, 'file.txt'), content: 'value' },
      sessionAdditionalDirectories: [extraDir],
    }) as never);
    expect(outcome.type).toBe('allow');
  });
});
