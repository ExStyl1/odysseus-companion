/**
 * Tests for AutomationSystem facade
 */

import { describe, it, expect, beforeEach, afterEach, spyOn, setSystemTime } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { AutomationSystem } from './automation-system.ts';
import { WORKSPACES_DIR } from '../workspaces/paths.ts';
import type { PendingPrompt, ScriptActionResult, WebhookActionResult } from './types.ts';
import { AUTOMATIONS_CONFIG_FILE } from './constants.ts';
import { readScheduleState, writeScheduleState } from './schedule-state.ts';
import { HOOKS_CONFIG_FILE, getUserGlobalHooksConfigPath } from './hooks-config.ts';

describe('AutomationSystem', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'automation-system-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should create an AutomationSystem without automations.json', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      expect(system.isDisposed()).toBe(false);
      expect(system.getConfig()).toEqual({ automations: {} });

      await system.dispose();
    });

    it('should load automations.json if present', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          LabelAdd: [
            {
              matcher: 'test',
              actions: [{ type: 'prompt', prompt: 'echo hello' }],
            },
          ],
        },
      }));

      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const config = system.getConfig();
      expect(config?.automations.LabelAdd).toHaveLength(1);

      await system.dispose();
    });

    it('should handle invalid automations.json gracefully', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), 'invalid json');

      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      expect(system.getConfig()).toEqual({ automations: {} });

      await system.dispose();
    });

    // F1.10 (origin D1.366) — four constructor cases stood here and are DELETED,
    // each with its reason:
    //  - "cannot run a command hook at all": the method it called is gone, so
    //    "nothing spawns" is structural now; the F1.10 block at the end of this
    //    file asserts the surface absent and the marker file unwritten, and the
    //    fail-closed arm lives on the executor a session runs
    //    (`plugins/__tests__/host-hook-runs-production-executor.test.ts`).
    //  - "disableAllHooks silences agent lifecycle hooks and keeps App
    //    automations": the App half is the F1.10 CONTROL's (`disableAllHooks` set,
    //    every App automation still fires); the agent half is honoured where hooks
    //    run, `capabilities/__tests__/runtime-automations.test.ts` › disableAllHooks.
    //  - "without disableAllHooks the same configuration still executes hooks":
    //    it asserted only `executeAgentEvent`'s matched count.
    //  - "merges lifecycle hooks from hooks.json": INVERTED by F1.10 — the first
    //    case of the F1.10 block asserts the hook documents' matchers are NOT held.

    it('should preserve thinkingLevel on prompt actions through load', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          LabelAdd: [
            {
              matcher: 'review',
              actions: [{
                type: 'prompt',
                prompt: 'Audit changes',
                llmConnection: 'anthropic',
                model: 'claude-opus-4-7',
                thinkingLevel: 'high',
              }],
            },
          ],
        },
      }));

      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const config = system.getConfig();
      const action = config?.automations.LabelAdd?.[0]?.actions[0];
      expect(action).toMatchObject({
        type: 'prompt',
        thinkingLevel: 'high',
      });

      await system.dispose();
    });

    it('should reject semantically invalid conditions at load time', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          LabelAdd: [
            {
              conditions: [{ condition: 'time', after: '25:99' }],
              actions: [{ type: 'prompt', prompt: 'echo hello' }],
            },
          ],
        },
      }));

      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      expect(system.getConfig()).toEqual({ automations: {} });

      await system.dispose();
    });
  });

  describe('reloadConfig', () => {
    it('should reload automations.json', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      expect(system.getConfig()).toEqual({ automations: {} });

      // Create automations.json
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          LabelAdd: [
            {
              matcher: 'test',
              actions: [{ type: 'prompt', prompt: 'echo hello' }],
            },
          ],
        },
      }));

      const result = system.reloadConfig();
      expect(result.success).toBe(true);
      expect(result.automationCount).toBe(1);
      expect(system.getConfig()?.automations.LabelAdd).toHaveLength(1);

      await system.dispose();
    });

    it('should return errors for invalid config', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      // Invalid JSON structure (actions must have at least one action)
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          LabelAdd: [
            { matcher: 'test', actions: 'not-an-array' }, // Invalid: actions should be an array
          ],
        },
      }));

      const result = system.reloadConfig();
      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);

      await system.dispose();
    });

    it('should return errors for semantically invalid conditions', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          LabelAdd: [
            {
              conditions: [{ condition: 'time', before: '99:00' }],
              actions: [{ type: 'prompt', prompt: 'echo hello' }],
            },
          ],
        },
      }));

      const result = system.reloadConfig();
      expect(result.success).toBe(false);
      expect(result.errors.some(e => e.includes('Invalid time value'))).toBe(true);

      await system.dispose();
    });

    /**
     * C3.284 — the defect this row closes, asserted where it bit.
     *
     * `parseHooksConfig` pushed two genuinely NON-FATAL notes into
     * `HooksLoadResult.errors` — an event this fork does not emit, and P6.293's
     * Notification matcher naming a type with no emitter — and `reloadConfig`
     * reads a non-empty `errors` as "apply nothing". So a portable hook that
     * merely has no producer here turned EVERY automation in the workspace off
     * on the next reload, including the ones in `automations.json` that had
     * nothing to do with it.
     *
     * The positive arm is the automation that must survive; the control below
     * is a genuinely invalid hooks document, which must still fail the reload.
     */
    it('C3.284: a hook this fork cannot emit is a note, and the reload still applies everything else', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          LabelAdd: [{ matcher: 'test', actions: [{ type: 'prompt', prompt: 'echo hello' }] }],
        },
      }));
      writeFileSync(join(tempDir, HOOKS_CONFIG_FILE), JSON.stringify({
        hooks: {
          // Documented, and deliberately never emitted here.
          Setup: [{ actions: [{ type: 'command', command: './install-deps.sh' }] }],
          Notification: [{
            matcher: 'quota_auto_resume_fired',
            actions: [{ type: 'command', command: 'echo hi' }],
          }],
        },
      }));

      const result = system.reloadConfig();
      expect({ success: result.success, errors: result.errors }).toEqual({ success: true, errors: [] });
      // The unrelated automation survived, which is the whole of the defect.
      expect(system.getConfig()?.automations.LabelAdd).toHaveLength(1);
      // And the Notification hook is not REJECTED — it is portable and correct;
      // it simply has no producer here. F1.10: nor is it HELD here — this class
      // runs no agent event, and the hook registers where hooks run
      // (`capabilities/runtime-automations.ts`).
      expect(system.getConfig()?.automations.Notification).toBeUndefined();

      await system.dispose();
    });

    it('C3.284 CONTROL, re-pinned by F1.229: an invalid automations.json still fails the reload', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      // `actions` must be an array: a structural failure of the document this
      // class RUNS — the one refusal F1.229 keeps (a hook document's is a note).
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: { LabelAdd: [{ matcher: 'test', actions: 'not-an-array' }] },
      }));
      // A VALID hook document beside it: the verdict is automations.json's own.
      writeFileSync(join(tempDir, HOOKS_CONFIG_FILE), JSON.stringify({
        hooks: { SessionStart: [{ actions: [{ type: 'command', command: 'echo hi' }] }] },
      }));

      const result = system.reloadConfig();
      expect(result.success).toBe(false);
      expect(result.errors.some(error => error.includes('actions'))).toBe(true);

      await system.dispose();
    });

    /**
     * C3.307 — the notes C3.284 moved onto `warnings` are RETAINED, so a host
     * seam can show them to the person who wrote the document.
     *
     * `AutomationSystem.warnConfig`'s only outlet was `console.warn`, which for
     * a hand-authored `hooks.json` is the one place its author never looks. The
     * array is what the RUNNING system produced, not a second read of the files,
     * and it is reset per read so a fixed document stops reporting.
     */
    it('C3.307: the non-fatal notes are retained for a surface to read', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      writeFileSync(join(tempDir, HOOKS_CONFIG_FILE), JSON.stringify({
        hooks: {
          // Documented, and deliberately never emitted here.
          Setup: [{ actions: [{ type: 'command', command: './install-deps.sh' }] }],
          Notification: [{
            matcher: 'quota_auto_resume_fired',
            actions: [{ type: 'command', command: 'echo hi' }],
          }],
        },
      }));

      expect(system.reloadConfig().success).toBe(true);
      const notes = system.configWarnings;
      expect(notes).toHaveLength(2);
      // Each note names its own source and its own reason: the lead-in the host
      // wraps them in deliberately claims less than any of them.
      expect(notes.join('\n')).toContain(HOOKS_CONFIG_FILE);
      expect(notes.some(note => note.includes('Setup'))).toBe(true);
      expect(notes.some(note => note.includes('quota_auto_resume_fired'))).toBe(true);
      // And they are notes, not errors — the whole point of C3.284. F1.10: the
      // matcher is not held HERE; it runs where hooks run (runtime-automations).
      expect(system.getConfig()?.automations.Notification).toBeUndefined();

      await system.dispose();
    });

    it('C3.307 CONTROL: a clean document retains nothing, and a fix clears a note', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      // NEGATIVE first: a document with no notes must not produce one, or the
      // surface becomes a banner every session shows.
      writeFileSync(join(tempDir, HOOKS_CONFIG_FILE), JSON.stringify({
        hooks: { SessionStart: [{ actions: [{ type: 'command', command: 'echo hi' }] }] },
      }));
      expect(system.reloadConfig().success).toBe(true);
      expect(system.configWarnings).toEqual([]);

      // Now earn a note, then fix it: a stale warning is the same defect as a
      // missing one, one direction over.
      writeFileSync(join(tempDir, HOOKS_CONFIG_FILE), JSON.stringify({
        hooks: { Setup: [{ actions: [{ type: 'command', command: './install-deps.sh' }] }] },
      }));
      expect(system.reloadConfig().success).toBe(true);
      expect(system.configWarnings).toHaveLength(1);

      writeFileSync(join(tempDir, HOOKS_CONFIG_FILE), JSON.stringify({
        hooks: { SessionStart: [{ actions: [{ type: 'command', command: 'echo hi' }] }] },
      }));
      expect(system.reloadConfig().success).toBe(true);
      expect(system.configWarnings).toEqual([]);

      await system.dispose();
    });

    it('should ignore unknown event types with warning', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      // Unknown events are filtered out with a warning, not an error
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          UnknownEvent: [
            { matcher: 'test', actions: [{ type: 'prompt', prompt: 'echo test' }] },
          ],
        },
      }));

      const result = system.reloadConfig();
      expect(result.success).toBe(true); // Unknown events are ignored, not errors
      expect(result.automationCount).toBe(0); // No valid actions

      await system.dispose();
    });
  });

  describe('getMatchersForEvent', () => {
    it('should return matchers for configured events', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          LabelAdd: [
            { matcher: 'test1', actions: [{ type: 'prompt', prompt: 'echo 1' }] },
            { matcher: 'test2', actions: [{ type: 'prompt', prompt: 'echo 2' }] },
          ],
        },
      }));

      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const matchers = system.getMatchersForEvent('LabelAdd');
      expect(matchers).toHaveLength(2);
      expect(matchers[0]?.matcher).toBe('test1');

      await system.dispose();
    });

    it('should return empty array for unconfigured events', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const matchers = system.getMatchersForEvent('LabelAdd');
      expect(matchers).toEqual([]);

      await system.dispose();
    });
  });

  describe('updateSessionMetadata', () => {
    it('should emit PermissionModeChange event', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const emitSpy = spyOn(system.eventBus, 'emit');

      const events = await system.updateSessionMetadata('session-1', {
        permissionMode: 'execute',
      });

      expect(events).toContain('PermissionModeChange');
      expect(emitSpy).toHaveBeenCalledWith('PermissionModeChange', expect.objectContaining({
        sessionId: 'session-1',
        oldMode: '',
        newMode: 'execute',
      }));

      await system.dispose();
    });

    it('should emit LabelAdd event for new labels', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const emitSpy = spyOn(system.eventBus, 'emit');

      const events = await system.updateSessionMetadata('session-1', {
        labels: ['label-1', 'label-2'],
      });

      expect(events).toContain('LabelAdd');
      expect(emitSpy).toHaveBeenCalledWith('LabelAdd', expect.objectContaining({
        label: 'label-1',
      }));
      expect(emitSpy).toHaveBeenCalledWith('LabelAdd', expect.objectContaining({
        label: 'label-2',
      }));

      await system.dispose();
    });

    it('should emit LabelRemove event for removed labels', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      // Set initial state
      system.setInitialSessionMetadata('session-1', {
        labels: ['label-1', 'label-2'],
      });

      const emitSpy = spyOn(system.eventBus, 'emit');

      const events = await system.updateSessionMetadata('session-1', {
        labels: ['label-1'], // label-2 removed
      });

      expect(events).toContain('LabelRemove');
      expect(emitSpy).toHaveBeenCalledWith('LabelRemove', expect.objectContaining({
        label: 'label-2',
      }));

      await system.dispose();
    });

    it('should emit FlagChange event', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const emitSpy = spyOn(system.eventBus, 'emit');

      const events = await system.updateSessionMetadata('session-1', {
        isFlagged: true,
      });

      expect(events).toContain('FlagChange');
      expect(emitSpy).toHaveBeenCalledWith('FlagChange', expect.objectContaining({
        isFlagged: true,
      }));

      await system.dispose();
    });

    it('should emit SessionStatusChange event', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      system.setInitialSessionMetadata('session-1', {
        sessionStatus: 'todo',
      });

      const emitSpy = spyOn(system.eventBus, 'emit');

      const events = await system.updateSessionMetadata('session-1', {
        sessionStatus: 'done',
      });

      expect(events).toContain('SessionStatusChange');
      expect(emitSpy).toHaveBeenCalledWith('SessionStatusChange', expect.objectContaining({
        oldState: 'todo',
        newState: 'done',
      }));

      await system.dispose();
    });

    it('should not emit events when metadata unchanged', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      system.setInitialSessionMetadata('session-1', {
        permissionMode: 'plan',
        labels: ['label-1'],
        isFlagged: false,
      });

      const emitSpy = spyOn(system.eventBus, 'emit');

      const events = await system.updateSessionMetadata('session-1', {
        permissionMode: 'plan',
        labels: ['label-1'],
        isFlagged: false,
      });

      expect(events).toEqual([]);
      expect(emitSpy).not.toHaveBeenCalled();

      await system.dispose();
    });

    it('should update stored metadata', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      await system.updateSessionMetadata('session-1', {
        permissionMode: 'execute',
        labels: ['label-1'],
      });

      const stored = system.getSessionMetadata('session-1');
      expect(stored?.permissionMode).toBe('execute');
      expect(stored?.labels).toEqual(['label-1']);

      await system.dispose();
    });
  });

  describe('removeSessionMetadata', () => {
    it('should remove stored metadata', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      system.setInitialSessionMetadata('session-1', {
        permissionMode: 'plan',
      });

      expect(system.getSessionMetadata('session-1')).toBeDefined();

      system.removeSessionMetadata('session-1');

      expect(system.getSessionMetadata('session-1')).toBeUndefined();

      await system.dispose();
    });
  });

  describe('emitLabelConfigChange', () => {
    it('should emit LabelConfigChange event', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const emitSpy = spyOn(system.eventBus, 'emit');

      await system.emitLabelConfigChange();

      expect(emitSpy).toHaveBeenCalledWith('LabelConfigChange', expect.objectContaining({
        workspaceId: 'test-workspace',
      }));

      await system.dispose();
    });
  });

  /**
   * F1.10 (origin D1.366) — the `executeAgentEvent`, `executeAgentEvent webhook
   * execution` and `buildSdkHooks` describes that stood here are GONE with the
   * three methods they drove, which no production caller reached (D1.351). Each
   * case, and where it went:
   *  - the matcher-and-conditions pair, the PreToolUse `decision` action,
   *    PermissionDenied as observational, TaskCreated/TaskCompleted as canonical
   *    and observational → RE-HOMED, one for one, onto the executor a workspace
   *    `automations.json` agent-event entry really reaches:
   *    `plugins/__tests__/workspace-agent-event-cases.test.ts`.
   *  - the two agent-event WEBHOOK cases → DELETED: on that executor a `webhook`
   *    action is the `http` hook, fired only through an injected runner under the
   *    network permission contract `plugins/__tests__/hooks-automation.test.ts`
   *    and `hook-runner-authority-notices.test.ts` already drive; the removed
   *    delivery went to this system's `onWebhookResults`, reached by no caller.
   *  - `buildSdkHooks` returning `{}` → DELETED: the method is gone, and the F1.10
   *    block at the end of this file asserts the whole agent-event surface absent.
   *
   * The two D1.354 notes below, on the describes that moved before it, stay true
   * as history.
   */
  /**
   * D1.354 — the three describes that stood here have MOVED, and the move is
   * the row.
   *
   * They drove the command-hook reduction through this class's
   * `commandHookRunner`, on the premise that it is the seam the host injects
   * in production. D1.351 measured that premise false: no production caller
   * sets either of this class's command authorities and
   * `buildPinnedAgentAutomationSystem` never passes `nativeSystem`, so
   * `executeAgentEvent` here had no production caller at all. A workspace
   * `hooks.json` or `config.json` hooks block reaches a session through
   * `runtime-automations.ts` and `executePluginHookAutomations` instead.
   *
   * So every observation they asserted now runs against that executor, with
   * no assertion dropped and no wall-clock assumption added:
   *  - P6.828 (a clean run recorded, a failing run recorded exactly once, an
   *    event that ran no command hook reporting no list) →
   *    `plugins/__tests__/host-hook-runs-production-executor.test.ts`, which
   *    also carries the two-tier merge arm and the end-to-end reader arm.
   *  - C3.334 (the background branch and its blocking control) and C3.350
   *    (the timeout block reason naming the hook) →
   *    `plugins/__tests__/settings-tier-command-hook-dispatch.test.ts`.
   */
  /**
   * D1.354 — the `executeAgentEvent command hooks` describe that stood here
   * has MOVED to `plugins/__tests__/settings-tier-command-hook-dispatch.test.ts`,
   * with the same three cases and the same real spawns.
   *
   * Its three systems set `allowDirectCommandHooks`, the ungated half of a
   * command authority no production caller ever reaches (D1.351). The
   * production executor has the same opt-in under a name a shipped session
   * really passes — `allowDirectCommandRunner`, which
   * `buildPinnedAgentAutomationSystem` sets for the non-Pi providers — so the
   * env the hook sees, the redaction of what it prints and the stdout decision
   * contract are now asserted on a path that runs.
   */

  describe('auto-memory cleanup', () => {
    const tickPayload = (workspaceId: string) => ({
      workspaceId,
      timestamp: Date.now(),
      localTime: '12:00',
      utcTime: new Date().toISOString(),
    });

    it('runs a daily-throttled cleanup of marked entries only on SchedulerTick', async () => {
      const workspaceId = `memory-clean-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const projectMemory = join(tempDir, 'MEMORY.md');
      writeFileSync(projectMemory, [
        '# Memory',
        '',
        '- Human note stays.',
        '',
        '- Old agent note. <!-- nessy:auto:2020-01-01 -->',
        '',
      ].join('\n'), 'utf-8');

      const system = new AutomationSystem({ workspaceRootPath: tempDir, workspaceId });
      try {
        await system.emit('SchedulerTick', tickPayload(workspaceId));

        const after = readFileSync(projectMemory, 'utf-8');
        expect(after).toContain('- Human note stays.');
        expect(after).not.toContain('Old agent note.');
        expect(existsSync(join(WORKSPACES_DIR, workspaceId, 'memory-cleanup.json'))).toBe(true);

        // Second tick in the same daily window is throttled: a freshly
        // re-appended stale entry survives until the next window.
        writeFileSync(projectMemory, `${after.trimEnd()}\n\n- Another old note. <!-- nessy:auto:2020-01-01 -->\n`, 'utf-8');
        await system.emit('SchedulerTick', tickPayload(workspaceId));
        expect(readFileSync(projectMemory, 'utf-8')).toContain('Another old note.');
      } finally {
        await system.dispose();
        rmSync(join(WORKSPACES_DIR, workspaceId), { recursive: true, force: true });
      }
    });

    it('logs and no-ops the tick when cleanup fails', async () => {
      // '/' fails workspace storage-ID validation -> stamp path resolution throws.
      const system = new AutomationSystem({ workspaceRootPath: tempDir, workspaceId: 'bad/workspace-id' });
      const projectMemory = join(tempDir, 'MEMORY.md');
      const stale = '# Memory\n\n- Old agent note. <!-- nessy:auto:2020-01-01 -->\n';
      writeFileSync(projectMemory, stale, 'utf-8');
      try {
        await system.emit('SchedulerTick', tickPayload('bad/workspace-id'));
        // Tick resolved, nothing was rewritten.
        expect(readFileSync(projectMemory, 'utf-8')).toBe(stale);
      } finally {
        await system.dispose();
      }
    });
  });

  describe('missed-run sweep (desktop-scheduled-tasks.md:74)', () => {
    const NOW = Date.parse('2026-08-07T11:23:45.000Z');
    const TODAY_9AM = Date.parse('2026-08-07T09:00:00.000Z');
    const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;

    function writeDailyAutomation(): void {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          SchedulerTick: [{
            id: 'abc123',
            cron: '0 9 * * *',
            timezone: 'UTC',
            worktree: true,
            actions: [{ type: 'prompt', prompt: 'daily review' }],
          }],
        },
      }));
    }

    function readCursors(): Record<string, number> {
      return readScheduleState(tempDir);
    }

    it('seeds the cursor on first sight and fires nothing', async () => {
      writeDailyAutomation();
      const prompts: PendingPrompt[][] = [];
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
        onPromptsReady: batch => { prompts.push(batch); },
      });

      expect(await system.runMissedRunSweep(NOW)).toEqual({ fired: 0 });
      expect(prompts).toEqual([]);
      expect(readCursors()).toEqual({ abc123: TODAY_9AM });

      await system.dispose();
    });

    it('starts exactly one catch-up run for a task that missed six days', async () => {
      writeDailyAutomation();
      writeScheduleState(tempDir, { abc123: TODAY_9AM - SIX_DAYS_MS });
      const prompts: PendingPrompt[][] = [];
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
        onPromptsReady: batch => { prompts.push(batch); },
      });

      expect(await system.runMissedRunSweep(NOW)).toEqual({ fired: 1 });
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toHaveLength(1);
      expect(prompts[0]![0]!.prompt).toBe('daily review');
      expect(prompts[0]![0]!.matcherId).toBe('abc123');
      // The matcher's isolation flag rides the same envelope.
      expect(prompts[0]![0]!.worktree).toBe(true);
      // The missed time, not the sweep time.
      expect(prompts[0]![0]!.catchUpForOccurrenceAt).toBe(TODAY_9AM);
      expect(readCursors()).toEqual({ abc123: TODAY_9AM });

      // "discards anything older": a second sweep at the same instant is a no-op.
      expect(await system.runMissedRunSweep(NOW)).toEqual({ fired: 0 });
      expect(prompts).toHaveLength(1);

      await system.dispose();
    });

    // UA12.32 — the row's decision arm: the guide (automations overview, Cron
    // Matching › "Missed runs", both locales, plus the shipped resources doc)
    // states the start/wake catch-up carries PROMPT actions only. This pins the
    // behaviour the sentence promises: a missed script or webhook matcher is
    // skipped on the sweep and its cursor is still accounted for, so the same
    // occurrence can never come back as a later catch-up.
    it('skips a missed script or webhook action on the sweep, its cursor still accounted for', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          SchedulerTick: [
            {
              id: 'script-daily',
              cron: '0 9 * * *',
              timezone: 'UTC',
              actions: [{ type: 'script', script: 'scripts/daily.ts' }],
            },
            {
              id: 'webhook-daily',
              cron: '0 9 * * *',
              timezone: 'UTC',
              actions: [{ type: 'webhook', url: 'https://nessy.invalid/hook' }],
            },
            // The every-minute matcher is the sharpest arm: its missed
            // occurrence is ONE minute old — the freshest miss possible — and
            // the sweep still must not run its script.
            {
              id: 'script-now',
              cron: '* * * * *',
              timezone: 'UTC',
              actions: [{ type: 'script', script: 'scripts/tick.ts' }],
            },
          ],
        },
      }));
      const stale = TODAY_9AM - SIX_DAYS_MS;
      writeScheduleState(tempDir, { 'script-daily': stale, 'webhook-daily': stale, 'script-now': stale });
      const prompts: PendingPrompt[][] = [];
      const scriptResults: ScriptActionResult[] = [];
      const webhookResults: WebhookActionResult[] = [];
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
        onPromptsReady: batch => { prompts.push(batch); },
        onScriptResults: results => { scriptResults.push(...results); },
        onWebhookResults: results => { webhookResults.push(...results); },
      });

      expect(await system.runMissedRunSweep(NOW)).toEqual({ fired: 0 });
      expect(prompts).toEqual([]);
      expect(scriptResults).toEqual([]);
      expect(webhookResults).toEqual([]);
      // The skipped occurrences ARE accounted for (the guide's "not replayed
      // later" half): a next start re-plans nothing for them.
      expect(readCursors()).toEqual({
        'script-daily': TODAY_9AM,
        'webhook-daily': TODAY_9AM,
        'script-now': Date.parse('2026-08-07T11:23:00.000Z'),
      });

      // Control, same instrument: the script collector is live — a LIVE
      // SchedulerTick of the same workspace delivers a run result (here a
      // refusal: the script file does not exist), so the empty arrays above
      // mean "the sweep delivered nothing", not "the collector is deaf".
      // UA12.32 follow-up: matchesCron reads the WALL clock, so pin it to NOW (11:23:45 UTC) — only
      // `* * * * *` matches then; at 09:00 UTC the two daily matchers fired too (2 results, a POST).
      setSystemTime(new Date(NOW));
      try {
        await system.eventBus.emit('SchedulerTick', {
          workspaceId: 'test-workspace',
          timestamp: NOW,
          localTime: new Date(NOW).toTimeString().slice(0, 5),
          utcTime: new Date(NOW).toISOString(),
        });
      } finally {
        setSystemTime();
      }
      expect(scriptResults).toHaveLength(1);
      expect(scriptResults[0]!.blocked).toBe(true);
      expect(webhookResults).toEqual([]); // the daily webhook matcher did not fire on the control tick

      await system.dispose();
    });

    it('advanceScheduleCursors accounts for the occurrence without firing', async () => {
      writeDailyAutomation();
      writeScheduleState(tempDir, { abc123: TODAY_9AM - SIX_DAYS_MS });
      const prompts: PendingPrompt[][] = [];
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
        onPromptsReady: batch => { prompts.push(batch); },
      });

      system.advanceScheduleCursors(NOW);

      expect(prompts).toEqual([]);
      expect(readCursors()).toEqual({ abc123: TODAY_9AM });
      // ":70 — If your computer sleeps through a scheduled time, the run is
      // skipped." A tick that accounted for the occurrence must not leave a
      // catch-up behind for the next start.
      expect(await system.runMissedRunSweep(NOW)).toEqual({ fired: 0 });

      await system.dispose();
    });

    it('a corrupt cursor file reads as empty and seeds instead of firing everything', async () => {
      writeDailyAutomation();
      writeFileSync(join(tempDir, 'automations-schedule-state.json'), '{ truncated');
      const prompts: PendingPrompt[][] = [];
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
        onPromptsReady: batch => { prompts.push(batch); },
      });

      expect(await system.runMissedRunSweep(NOW)).toEqual({ fired: 0 });
      expect(prompts).toEqual([]);

      await system.dispose();
    });

    it('does nothing when the workspace has no scheduled automations', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      expect(await system.runMissedRunSweep(NOW)).toEqual({ fired: 0 });
      expect(existsSync(join(tempDir, 'automations-schedule-state.json'))).toBe(false);

      await system.dispose();
    });
  });

  describe('dispose', () => {
    it('should clean up all resources', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      system.setInitialSessionMetadata('session-1', { permissionMode: 'plan' });

      await system.dispose();

      expect(system.isDisposed()).toBe(true);
      expect(system.eventBus.isDisposed()).toBe(true);
      expect(system.getSessionMetadata('session-1')).toBeUndefined();
    });

    it('should be idempotent', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      await system.dispose();
      await system.dispose(); // Should not throw
      expect(system.isDisposed()).toBe(true);
    });
  });

  /**
   * F1.10 (origin D1.366) — the class is the scheduler and handler system it is
   * used as, and nothing a reader could mistake for a hook dispatch.
   *
   * The one production `new AutomationSystem` is `SessionManager`'s
   * per-workspace system, built for the scheduler and the prompt, webhook and
   * event-log handlers. Its agent-event half — `executeAgentEvent`,
   * `hasAgentEventMatchers`, `buildSdkHooks` — had no production caller (D1.351
   * measured it; `buildPinnedAgentAutomationSystem` never passes `nativeSystem`),
   * yet the class still parsed the workspace `hooks.json` and the `config.json`
   * hooks block INTO its matcher map and answered the predicate from them. The
   * hooks a session really runs are read by `capabilities/runtime-automations.ts`
   * from the capability view and dispatched by `executePluginHookAutomations`.
   */
  describe('F1.10 — a scheduler and handler system, not a hook dispatcher', () => {
    function writeHookDocuments(): void {
      writeFileSync(join(tempDir, HOOKS_CONFIG_FILE), JSON.stringify({
        hooks: { PreToolUse: [{ matcher: '^Bash$', actions: [{ type: 'command', command: 'touch must-not-run' }] }] },
      }));
      writeFileSync(join(tempDir, 'config.json'), JSON.stringify({
        hooks: { SessionStart: [{ actions: [{ type: 'command', command: 'touch must-not-run-either' }] }] },
      }));
    }

    it('holds no hook document in its matchers and carries no agent-event dispatch', async () => {
      writeHookDocuments();
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: { LabelAdd: [{ matcher: 'review', actions: [{ type: 'prompt', prompt: 'Audit changes' }] }] },
      }));
      const system = new AutomationSystem({ workspaceRootPath: tempDir, workspaceId: 'test-workspace' });
      try {
        // The matcher map is automations.json's, and only automations.json's —
        // at load AND at reload, which is the config watcher's path.
        expect(Object.keys(system.getConfig()?.automations ?? {})).toEqual(['LabelAdd']);
        expect(system.getMatchersForEvent('PreToolUse')).toEqual([]);
        expect(system.getMatchersForEvent('SessionStart')).toEqual([]);
        const reload = system.reloadConfig();
        expect({ success: reload.success, automationCount: reload.automationCount }).toEqual({ success: true, automationCount: 1 });
        expect(Object.keys(system.getConfig()?.automations ?? {})).toEqual(['LabelAdd']);
        // And nothing on the object answers for an agent event.
        const surface = system as unknown as Record<string, unknown>;
        expect(['executeAgentEvent', 'hasAgentEventMatchers', 'buildSdkHooks'].filter(name => name in surface)).toEqual([]);
      } finally {
        await system.dispose();
      }
      expect(existsSync(join(tempDir, 'must-not-run'))).toBe(false);
      expect(existsSync(join(tempDir, 'must-not-run-either'))).toBe(false);
    });

    /**
     * CONTROL — the one production site's behaviour, with the hook documents
     * beside it (and `disableAllHooks` set, which never touched App events): a
     * label prompt, a label webhook, a scheduled prompt and the event log. Green
     * before the change and after it; a removal that reached the App-event
     * pipeline fails here.
     */
    it('CONTROL: the scheduler and the prompt, webhook and event-log handlers run exactly as before', async () => {
      writeHookDocuments();
      writeFileSync(join(tempDir, HOOKS_CONFIG_FILE), JSON.stringify({
        disableAllHooks: true,
        hooks: { PreToolUse: [{ matcher: '^Bash$', actions: [{ type: 'command', command: 'touch must-not-run' }] }] },
      }));
      const { createServer } = await import('node:http');
      let hits = 0;
      const server = createServer((_req, res) => {
        hits++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address();
      const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/label`;
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          LabelAdd: [
            { id: 'lblprm', matcher: 'review', actions: [{ type: 'prompt', prompt: 'Audit changes' }] },
            { id: 'lblhok', matcher: 'review', actions: [{ type: 'webhook', url, method: 'POST' }] },
          ],
          SchedulerTick: [{ id: 'tick01', cron: '* * * * *', timezone: 'UTC', actions: [{ type: 'prompt', prompt: 'every minute' }] }],
        },
      }));

      const prompts: string[] = [];
      const webhookResults: Array<{ success: boolean }> = [];
      let resolveDelivered!: () => void;
      const delivered = new Promise<void>((resolve) => { resolveDelivered = resolve; });
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
        onPromptsReady: batch => { prompts.push(...batch.map(pending => pending.prompt)); },
        onWebhookResults: results => { webhookResults.push(...results); resolveDelivered(); },
      });
      try {
        expect(await system.updateSessionMetadata('session-1', { labels: ['review'] })).toEqual(['LabelAdd']);
        await delivered;
        await system.emit('SchedulerTick', {
          workspaceId: 'test-workspace',
          timestamp: Date.now(),
          localTime: '12:00',
          utcTime: new Date().toISOString(),
        });
        expect(prompts.sort()).toEqual(['Audit changes', 'every minute']);
        expect({ hits, results: webhookResults.map(result => result.success) }).toEqual({ hits: 1, results: [true] });
      } finally {
        await system.dispose();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      const logged = readFileSync(join(tempDir, 'events.jsonl'), 'utf-8');
      expect(logged).toContain('"LabelAdd"');
      expect(logged).toContain('"SchedulerTick"');
      expect(existsSync(join(tempDir, 'must-not-run'))).toBe(false);
    });
  });

  /**
   * F1.229 (WJ-r P-WJ-r-1, decided 2026-09-23) — a hook DOCUMENT no longer
   * stops an `automations.json` reload.
   *
   * After F1.10 this class runs no hook: it reads the workspace `hooks.json` and
   * the `config.json` hooks block for their diagnostics only. C3.284 had kept a
   * genuinely invalid hook document's `errors` in the reload verdict, so a broken
   * `hooks.json` still made `reloadConfig` apply NOTHING — every scheduled and
   * App-event automation of the workspace held at its old configuration by a
   * document this class never runs. The error is now a NOTE on `configWarnings`,
   * the array `SessionManager.warnHooksConfigNotes` raises on the session's
   * warning seam; before, it reached only the log (the reload's `errors`, and
   * `loadConfig`'s `console.warn`).
   *
   * Red at HEAD in every row: the reload refused (`success: false`) and the note
   * array never held the error. The CONTROL is the re-pinned C3.284 case above —
   * an invalid `automations.json` still refuses.
   */
  describe('F1.229 — a broken hook document keeps its diagnostic and stops blocking the reload', () => {
    const labelAutomations = (prompts: string[]) => JSON.stringify({
      automations: { LabelAdd: prompts.map(prompt => ({ matcher: 'test', actions: [{ type: 'prompt', prompt }] })) },
    });
    const brokenHookDocuments: Array<{ name: string; file: string; body: string; source: string }> = [
      {
        name: 'hooks.json, structurally invalid',
        file: HOOKS_CONFIG_FILE,
        body: JSON.stringify({ hooks: { SessionStart: [{ actions: 'not-an-array' }] } }),
        source: `${HOOKS_CONFIG_FILE}: `,
      },
      { name: 'hooks.json, not JSON at all', file: HOOKS_CONFIG_FILE, body: '{ "hooks": ', source: `${HOOKS_CONFIG_FILE}: ` },
      {
        name: 'the config.json hooks block, structurally invalid',
        file: 'config.json',
        body: JSON.stringify({ hooks: { SessionStart: [{ actions: 'not-an-array' }] } }),
        source: 'config.json hooks: ',
      },
    ];

    for (const broken of brokenHookDocuments) {
      it(`${broken.name}: the reload applies automations.json, and the error is a note`, async () => {
        writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), labelAutomations(['first']));
        writeFileSync(join(tempDir, broken.file), broken.body);
        const system = new AutomationSystem({ workspaceRootPath: tempDir, workspaceId: 'test-workspace' });
        try {
          // At LOAD (the constructor's read) the error is already a note.
          const loadNotes = system.configWarnings.filter(note => note.startsWith(broken.source)).length;
          // The config watcher's path: the edited automations.json is APPLIED,
          // and the hook document's failure stays visible on the one array the
          // host surfaces — once, naming its source.
          writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), labelAutomations(['first', 'second']));
          const result = system.reloadConfig();
          const notes = system.configWarnings.filter(note => note.startsWith(broken.source));
          expect({
            loadNotes,
            success: result.success,
            automationCount: result.automationCount,
            errors: result.errors,
            applied: system.getConfig()?.automations.LabelAdd?.length,
            reloadNotes: notes.length,
          }).toEqual({ loadNotes: 1, success: true, automationCount: 2, errors: [], applied: 2, reloadNotes: 1 });
          // And the note says what it costs, so the person can act on it.
          expect(notes[0]).toContain('will not run until it is fixed');
        } finally {
          await system.dispose();
        }
      });
    }

    it('a fixed hook document stops reporting its error on the next reload', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), labelAutomations(['first']));
      writeFileSync(join(tempDir, HOOKS_CONFIG_FILE), '{ "hooks": ');
      const system = new AutomationSystem({ workspaceRootPath: tempDir, workspaceId: 'test-workspace' });
      try {
        expect(system.configWarnings).toHaveLength(1);
        writeFileSync(join(tempDir, HOOKS_CONFIG_FILE), JSON.stringify({
          hooks: { SessionStart: [{ actions: [{ type: 'command', command: 'echo hi' }] }] },
        }));
        expect(system.reloadConfig().success).toBe(true);
        expect(system.configWarnings).toEqual([]);
      } finally {
        await system.dispose();
      }
    });
  });

  /**
   * F1.459 (origin WJ-ii verifier on F1.269, F1.269d; F1.229/C3.307 residue) — a
   * REFUSED reload keeps the hook documents' notes. An invalid `automations.json`
   * made `readMergedConfig` return before the hook documents were read, and the
   * notes array had already been reset for that read, so a still-broken
   * `hooks.json` note vanished from the one surface that shows it (measured: one
   * note before, `success: false`, none after). The refused reload applies
   * nothing — the running configuration is the previous one — but the hook
   * documents are read for their diagnostics either way, so their notes stand.
   */
  describe('F1.459 — a refused reload keeps the hook documents\' notes', () => {
    it('an invalid automations.json refuses, and the broken hooks.json note is still reported', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: { LabelAdd: [{ matcher: 'test', actions: [{ type: 'prompt', prompt: 'first' }] }] },
      }));
      writeFileSync(join(tempDir, HOOKS_CONFIG_FILE), '{ "hooks": ');
      const system = new AutomationSystem({ workspaceRootPath: tempDir, workspaceId: 'test-workspace' });
      try {
        const before = system.configWarnings.filter(note => note.startsWith(`${HOOKS_CONFIG_FILE}: `));
        writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
          automations: { LabelAdd: [{ matcher: 'test', actions: 'not-an-array' }] },
        }));
        const result = system.reloadConfig();
        const after = system.configWarnings.filter(note => note.startsWith(`${HOOKS_CONFIG_FILE}: `));
        expect({ before: before.length, success: result.success, applied: system.getConfig()?.automations.LabelAdd?.length, after: after.length })
          .toEqual({ before: 1, success: false, applied: 1, after: 1 });
        expect(after[0]).toContain('did not load');
      } finally {
        await system.dispose();
      }
    });

    it('the same refusal on unparseable JSON keeps the note too', async () => {
      writeFileSync(join(tempDir, HOOKS_CONFIG_FILE), '{ "hooks": ');
      const system = new AutomationSystem({ workspaceRootPath: tempDir, workspaceId: 'test-workspace' });
      try {
        writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), '{ "automations": ');
        expect(system.reloadConfig().success).toBe(false);
        expect(system.configWarnings.filter(note => note.startsWith(`${HOOKS_CONFIG_FILE}: `))).toHaveLength(1);
      } finally {
        await system.dispose();
      }
    });

    it('CONTROL: a refused reload beside a VALID hook document reports no hook note', async () => {
      writeFileSync(join(tempDir, HOOKS_CONFIG_FILE), JSON.stringify({
        hooks: { SessionStart: [{ actions: [{ type: 'command', command: 'echo hi' }] }] },
      }));
      const system = new AutomationSystem({ workspaceRootPath: tempDir, workspaceId: 'test-workspace' });
      try {
        writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), '{ "automations": ');
        expect(system.reloadConfig().success).toBe(false);
        expect(system.configWarnings.map(n => n.startsWith(`${AUTOMATIONS_CONFIG_FILE} did not load (`))).toEqual([true]); // F1.494: its own note, no hook note
      } finally {
        await system.dispose();
      }
    });
  });

  /**
   * F1.1093 (origin DN-051) — a user-global `hooks.json` that does not load is a
   * note on the same array, as a workspace one is (F1.229). Before, its errors were
   * dropped by the builder that runs it (`capabilities/runtime-automations.ts`) and
   * this class read the workspace documents alone, so the user's own global guard
   * hooks stopped with no chat note and no diagnostic. Red at the parent: 0 notes.
   *
   * The path is the TEST config dir (the root preload, or `NESSY_CONFIG_DIR`
   * exported before bun starts); `config/paths.ts` refuses the real one here.
   */
  describe('F1.1093 — a broken user-global hooks.json is a note, as a workspace one is', () => {
    const globalHooksPath = getUserGlobalHooksConfigPath();
    const home = homedir();
    const shownPath = globalHooksPath.startsWith(home + sep) ? `~${globalHooksPath.slice(home.length)}` : globalHooksPath;
    afterEach(() => {
      rmSync(globalHooksPath, { force: true });
    });

    it('one note naming the file and its first error, never its content; a fix clears it with no reload', async () => {
      writeFileSync(globalHooksPath, '{ "hooks": keptoutofthenote }');
      const system = new AutomationSystem({ workspaceRootPath: tempDir, workspaceId: 'test-workspace' });
      try {
        const notes = system.configWarnings.filter(note => note.startsWith(`${shownPath}: `));
        expect(notes).toHaveLength(1);
        expect(notes[0]).toContain('this hook document did not load as written, so the hooks it affects will not run until it is fixed');
        expect(notes[0]).not.toContain('keptoutofthenote');
        // The watcher's global arm rebuilds runtimes and reloads no workspace
        // system, so the next read — not a reload — must see the fix.
        writeFileSync(globalHooksPath, JSON.stringify({
          hooks: { PreToolUse: [{ matcher: 'Bash', actions: [{ type: 'command', command: 'echo guard' }] }] },
        }));
        expect(system.configWarnings).toEqual([]);
      } finally {
        await system.dispose();
      }
    });

    it('CONTROL: a valid global file adds no note, and a broken workspace hooks.json keeps its own note unchanged', async () => {
      writeFileSync(globalHooksPath, JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', actions: [{ type: 'command', command: 'echo guard' }] }] },
      }));
      writeFileSync(join(tempDir, HOOKS_CONFIG_FILE), '{ "hooks": ');
      const system = new AutomationSystem({ workspaceRootPath: tempDir, workspaceId: 'test-workspace' });
      try {
        expect(system.configWarnings).toHaveLength(1);
        expect(system.configWarnings[0]!.startsWith(`${HOOKS_CONFIG_FILE}: `)).toBe(true);
        expect(system.configWarnings[0]).toContain('this hook document did not load as written');
      } finally {
        await system.dispose();
      }
    });
  });
});
