import { describe, it, expect } from 'bun:test';
import {
  cleanupModeState,
  formatSessionState,
  getPermissionModeDiagnostics,
  hydratePreviousPermissionMode,
  initializeModeState,
  setPermissionMode,
} from '../mode-manager.ts';
import { PERMISSION_MODE_AGENT_LABELS, PERMISSION_MODE_ORDER } from '../mode-types.ts';
import { getSystemPrompt } from '../../prompts/system.ts';
import type { SessionKey } from '../../sessions/session-key.ts';

// All mode-state singletons are keyed by the composite {workspaceId, sessionId}.
const k = (sessionId: string): SessionKey => ({ workspaceId: 'ws-mode-state', sessionId });

describe('mode transition session_state context', () => {
  it('includes explicit transition metadata after a mode change', () => {
    const key = k(`mode-transition-${Date.now()}`);

    initializeModeState(key, 'plan');
    setPermissionMode(key, 'bypassPermissions', {
      changedBy: 'user',
      changedAt: '2026-03-02T08:00:00.000Z',
    });

    const diagnostics = getPermissionModeDiagnostics(key);
    expect(diagnostics.permissionMode).toBe('bypassPermissions');
    expect(diagnostics.previousPermissionMode).toBe('plan');
    expect(diagnostics.transitionDisplay).toBe('Plan -> Bypass permissions');

    const stateBlock = formatSessionState(key, {
      plansFolderPath: '/tmp/plans',
      dataFolderPath: '/tmp/data',
    });

    expect(stateBlock).toContain('permissionMode: bypassPermissions');
    expect(stateBlock).toContain('modeTransition: Plan -> Bypass permissions');
    expect(stateBlock).toContain('modeChangedBy: user');
    expect(stateBlock).toContain('modeChangedAt: 2026-03-02T08:00:00.000Z');
    expect(stateBlock).toContain('modeVersion: 2');
    expect(stateBlock).toContain('modeChangeSummary: Last mode change by user at 2026-03-02T08:00:00.000Z (Plan -> Bypass permissions, modeVersion=2)');
    expect(stateBlock).toContain('modeChangeUserSignal: The user changed mode manually. Apply this mode immediately for this turn.');

    cleanupModeState(key);
  });

  it('omits modeTransition when no previous mode exists', () => {
    const key = k(`mode-no-transition-${Date.now()}`);

    const stateBlock = formatSessionState(key, {
      plansFolderPath: '/tmp/plans',
    });

    expect(stateBlock).toContain('permissionMode: default');
    expect(stateBlock).not.toContain('modeTransition:');
    expect(stateBlock).toContain('modeVersion: 0');
    expect(stateBlock).toContain('modeChangeSummary: Last mode change by');
    expect(stateBlock).not.toContain('modeChangeUserSignal:');

    cleanupModeState(key);
  });

  it('does not emit a synthetic modeTransition on initial restore', () => {
    const key = k(`mode-restore-${Date.now()}`);

    initializeModeState(key, 'plan');

    const diagnostics = getPermissionModeDiagnostics(key);
    expect(diagnostics.permissionMode).toBe('plan');
    expect(diagnostics.transitionDisplay).toBeUndefined();

    const stateBlock = formatSessionState(key);
    expect(stateBlock).toContain('permissionMode: plan');
    expect(stateBlock).not.toContain('modeTransition:');
    expect(stateBlock).toContain('modeChangedBy: restore');
    expect(stateBlock).toContain('modeChangeSummary: Last mode change by restore');
    expect(stateBlock).not.toContain('modeChangeUserSignal:');

    cleanupModeState(key);
  });

  it('restores modeTransition after rehydrating persisted previous mode', () => {
    const key = k(`mode-rehydrate-${Date.now()}`);

    // Simulate restored current mode after app restart.
    setPermissionMode(key, 'bypassPermissions', { changedBy: 'restore' });
    hydratePreviousPermissionMode(key, 'plan');

    const diagnostics = getPermissionModeDiagnostics(key);
    expect(diagnostics.permissionMode).toBe('bypassPermissions');
    expect(diagnostics.previousPermissionMode).toBe('plan');
    expect(diagnostics.transitionDisplay).toBe('Plan -> Bypass permissions');

    const stateBlock = formatSessionState(key);
    expect(stateBlock).toContain('permissionMode: bypassPermissions');
    expect(stateBlock).toContain('modeTransition: Plan -> Bypass permissions');
    expect(stateBlock).toContain('modeChangeSummary: Last mode change by restore');
    expect(stateBlock).not.toContain('modeChangeUserSignal:');

    cleanupModeState(key);
  });

  it('emits modeChangeUserSignal once when consume option is enabled', () => {
    const key = k(`mode-consume-once-${Date.now()}`);

    initializeModeState(key, 'plan');
    setPermissionMode(key, 'bypassPermissions', {
      changedBy: 'user',
      changedAt: '2026-03-02T09:00:00.000Z',
    });

    const first = formatSessionState(key, {
      consumeModeChangeUserSignal: true,
    });
    expect(first).toContain('modeChangeUserSignal: The user changed mode manually. Apply this mode immediately for this turn.');

    const second = formatSessionState(key, {
      consumeModeChangeUserSignal: true,
    });
    expect(second).not.toContain('modeChangeUserSignal:');

    cleanupModeState(key);
  });
});

describe('mode-scoped permission + behavior guidance (P1 + F1 volatile injection)', () => {
  // After F1, every mode emits exactly one coherent modeGuidance line merging
  // the active mode's permission facts (freely/approval/blocked) with its
  // autonomy/persistence or plan persona. Each mode renders ONLY its own line.
  // F1.1050 (DN-272) deleted the "injects Explore permission facts in safe mode (explore)" arm with the retired
  // mode; plan's own facts are pinned by the plan arm in this describe.
  it('injects Ask permission facts in ask mode', () => {
    const key = k(`mode-guidance-ask-${Date.now()}`);
    initializeModeState(key, 'default');

    const stateBlock = formatSessionState(key);
    expect(stateBlock).toContain('permissionMode: default');
    expect(stateBlock).toContain('modeGuidance: Manual mode — read operations run freely');
    expect(stateBlock).toContain('edits and other mutating actions prompt for approval');
    // Cross-mode negatives.
    expect(stateBlock).not.toContain('Full autonomy');
    expect(stateBlock).not.toContain('Explore mode');
    expect(stateBlock).not.toContain('Planning is not doing');

    cleanupModeState(key);
  });

  it('injects full-autonomy guidance in allow-all mode (execute)', () => {
    const key = k(`mode-guidance-execute-${Date.now()}`);
    initializeModeState(key, 'bypassPermissions');

    const stateBlock = formatSessionState(key);
    expect(stateBlock).toContain('permissionMode: bypassPermissions');
    expect(stateBlock).toContain('modeGuidance: Bypass permissions mode — full autonomy, no approval prompts');
    expect(stateBlock).toContain('Persist until the task is fully handled end-to-end this turn');
    expect(stateBlock).toContain('Make sensible assumptions and state them instead of pausing to ask');
    // Finding 3: the irreversible-action safety clause resolves the tension with
    // Interaction Guideline #3 without weakening the persist directive.
    expect(stateBlock).toContain('Destructive or irreversible actions still follow the safety rules');
    expect(stateBlock).not.toContain('Planning is not doing');
    // The gated-mode caveat must NOT leak into allow-all, where no prompts exist.
    expect(stateBlock).not.toContain('still prompt for approval');

    cleanupModeState(key);
  });

  it('injects gate-aware autonomy guidance in auto and acceptEdits modes', () => {
    // Unlike allow-all, these modes still prompt for gated actions, so the
    // guidance must tell the model to request approvals rather than route
    // around them or claim full "no prompts" autonomy. Each keeps its own
    // permission-facts lead (file edits auto-accept vs low-risk actions auto-run).
    const leads: Record<'auto' | 'acceptEdits', string> = {
      auto: 'modeGuidance: Auto mode — low-risk actions auto-run; risky shell, network, MCP, and API mutations still prompt for approval',
      acceptEdits: 'modeGuidance: Accept edits mode — file edits auto-accept; shell, network, and MCP mutations still prompt for approval',
    };
    for (const mode of ['auto', 'acceptEdits'] as const) {
      const key = k(`mode-guidance-${mode}-${Date.now()}`);
      initializeModeState(key, mode);

      const stateBlock = formatSessionState(key);
      expect(stateBlock).toContain(leads[mode]);
      expect(stateBlock).toContain('when a gated action is needed, request it');
      expect(stateBlock).toContain('do not narrow the task or route around the gates');
      expect(stateBlock).toContain('Persist and make sensible assumptions');
      // These modes are NOT full autonomy — the allow-all "no prompts" framing
      // must never appear here.
      expect(stateBlock).not.toContain('Bypass permissions mode — full autonomy');

      cleanupModeState(key);
    }
  });

  it('injects plan-mode persona guidance in plan mode', () => {
    const key = k(`mode-guidance-plan-${Date.now()}`);
    initializeModeState(key, 'plan');

    const stateBlock = formatSessionState(key);
    expect(stateBlock).toContain('permissionMode: plan');
    expect(stateBlock).toContain('modeGuidance: Plan mode — read-only planning');
    expect(stateBlock).toContain('Planning is not doing');
    expect(stateBlock).toContain('refines the plan rather than ending plan mode');
    expect(stateBlock).toContain('The deliverable is the plan itself');
    expect(stateBlock).not.toContain('Persist until the task is fully handled');

    cleanupModeState(key);
  });

  it('every modeGuidance line opens with the pinned agent-facing label', () => {
    // The mode name the model reads comes from PERMISSION_MODE_AGENT_LABELS
    // (byte-equal to the en locale via mode-label-source.test.ts) — never an
    // inline literal. Re-inlining an old word ("Ask mode", "Execute mode")
    // goes red here.
    for (const mode of PERMISSION_MODE_ORDER) {
      const key = k(`mode-guidance-label-${mode}-${Date.now()}`);
      initializeModeState(key, mode);

      const stateBlock = formatSessionState(key);
      expect(stateBlock, mode).toContain(
        `modeGuidance: ${PERMISSION_MODE_AGENT_LABELS[mode]} mode — `,
      );

      cleanupModeState(key);
    }
  });

  it('renders exactly one modeGuidance line per mode (no cross-mode bleed)', () => {
    // Positive-per-mode / negative-cross-mode: switching modes replaces the
    // whole volatile line, never accumulating a second mode's guidance.
    const modes = ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'] as const;
    for (const mode of modes) {
      const key = k(`mode-guidance-single-${mode}-${Date.now()}`);
      initializeModeState(key, mode);

      const stateBlock = formatSessionState(key);
      const guidanceLines = stateBlock.split('\n').filter(line => line.startsWith('modeGuidance:'));
      expect(guidanceLines).toHaveLength(1);

      cleanupModeState(key);
    }
  });

  it('a mode switch changes only the volatile modeGuidance line', () => {
    const key = k(`mode-guidance-switch-${Date.now()}`);
    initializeModeState(key, 'plan');
    // The static system prompt is mode-independent; capture it before the switch.
    const staticBefore = getSystemPrompt(
      undefined,
      undefined,
      '/tmp/workspace',
      '/tmp/workspace',
      undefined,
      'Nessy Backend',
      false,
    );
    const before = formatSessionState(key);
    expect(before).toContain('modeGuidance: Plan mode — read-only planning.');

    setPermissionMode(key, 'bypassPermissions', { changedBy: 'user' });
    const after = formatSessionState(key);
    expect(after).toContain('modeGuidance: Bypass permissions mode — full autonomy, no approval prompts');
    expect(after).not.toContain('modeGuidance: Plan mode — read-only planning.');

    // The switch moves only the volatile line — the cache-stable static prompt
    // is byte-identical across the mode change (matches the test name).
    const staticAfter = getSystemPrompt(
      undefined,
      undefined,
      '/tmp/workspace',
      '/tmp/workspace',
      undefined,
      'Nessy Backend',
      false,
    );
    expect(staticAfter).toBe(staticBefore);

    cleanupModeState(key);
  });
});
