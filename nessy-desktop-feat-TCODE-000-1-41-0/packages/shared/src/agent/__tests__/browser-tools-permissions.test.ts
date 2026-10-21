/**
 * Tests for browser tool permission handling across permission modes.
 *
 * chrome.md ("Browser tools in plan mode") binds plan mode to a per-CALL
 * split, not a per-tool-name verdict:
 * - :106 — "browser tool calls that only read the page or browser state run
 *   without a permission prompt, and calls that change state prompt for
 *   approval."
 * - :108-109 — read-only calls are reading the page tree / console messages /
 *   network requests and taking a screenshot; state-changing calls are clicks,
 *   typing, navigation, and tab and window management.
 * - :111 — "an otherwise read-only call that sets a state-changing input flag,
 *   such as … `clear` on the console and network readers, or `save_to_disk`
 *   on a screenshot, also prompts for approval. A `browser_batch` call runs
 *   without a prompt only when every action inside it is read-only."
 */
import { describe, it, expect } from 'bun:test';
import { shouldAllowToolInMode } from '../../agent/mode-manager.ts';

const browserToolNames = [
  'browser_tool',
  'mcp__session__browser_tool',
  // Legacy alias compatibility (older sessions/tests)
  'browser_snapshot',
  'browser_open',
  'mcp__session__browser_snapshot',
  'mcp__session__browser_open',
] as const;

const planBand = { allowPlanShellReview: true } as const;

describe('browser tools permission mode handling', () => {
  it('plan mode runs read-only browser commands without a prompt (chrome.md:106,108)', () => {
    for (const command of ['snapshot', 'find login button', 'screenshot', 'screenshot --annotated --png', 'console 50 error', 'network 20 4xx', 'windows', 'wait network-idle 2000', 'downloads list', 'get-clipboard', 'help', '--help']) {
      const result = shouldAllowToolInMode('browser_tool', { command }, 'plan', planBand);
      expect(result, command).toEqual({ allowed: true });
    }
  });

  it('plan mode prompts for state-changing browser commands (chrome.md:106,109)', () => {
    for (const command of ['click @e1', 'type hi', 'navigate https://example.com', 'evaluate document.title = "x"', 'window-resize 1 1', 'open', 'close', 'focus', 'set-clipboard boo', 'upload @e3 /tmp/x.pdf']) {
      const result = shouldAllowToolInMode('browser_tool', { command }, 'plan', planBand);
      expect(result, command).toMatchObject({
        allowed: true,
        requiresPermission: true,
        planShellReview: true,
      });
    }
  });

  it('plan mode prompts for a batch unless EVERY action is read-only (chrome.md:111)', () => {
    const mixed = shouldAllowToolInMode('browser_tool', { command: 'snapshot; click @e1' }, 'plan', planBand);
    expect(mixed).toMatchObject({ allowed: true, requiresPermission: true, planShellReview: true });

    const allReadOnly = shouldAllowToolInMode('browser_tool', { command: 'snapshot; console 10; network 10' }, 'plan', planBand);
    expect(allReadOnly).toEqual({ allowed: true });
  });

  it('plan mode prompts for a read-only verb carrying a state-changing input flag (chrome.md:111)', () => {
    for (const command of ['console clear', 'network --clear', 'screenshot save_to_disk', 'screenshot-region --ref @e1 --save-to-disk']) {
      const result = shouldAllowToolInMode('browser_tool', { command }, 'plan', planBand);
      expect(result, command).toMatchObject({ allowed: true, requiresPermission: true, planShellReview: true });
    }
  });

  it('plan mode classifies the array form as one command and prompts on state change', () => {
    const stateChanging = shouldAllowToolInMode('browser_tool', { command: ['evaluate', 'x=1'] }, 'plan', planBand);
    expect(stateChanging).toMatchObject({ allowed: true, requiresPermission: true, planShellReview: true });

    const readOnly = shouldAllowToolInMode('browser_tool', { command: ['screenshot', '--annotated'] }, 'plan', planBand);
    expect(readOnly).toEqual({ allowed: true });
  });

  it('plan mode fails closed on unknown verbs', () => {
    const result = shouldAllowToolInMode('browser_tool', { command: 'defenestrate @e1' }, 'plan', planBand);
    expect(result).toMatchObject({ allowed: true, requiresPermission: true, planShellReview: true });
  });

  it('every browser tool spelling reaches the same command-level decision site', () => {
    for (const toolName of browserToolNames) {
      const readOnly = shouldAllowToolInMode(toolName, { command: 'snapshot' }, 'plan', planBand);
      expect(readOnly, toolName).toEqual({ allowed: true });

      const stateChanging = shouldAllowToolInMode(toolName, { command: 'click @e1' }, 'plan', planBand);
      expect(stateChanging, toolName).toMatchObject({
        allowed: true,
        requiresPermission: true,
        planShellReview: true,
      });
    }
  });

  it('plan mode without the shell-review band blocks state-changing browser commands (host-side callers)', () => {
    const result = shouldAllowToolInMode('browser_tool', { command: 'click @e1' }, 'plan');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('click @e1');
    }
  });

  it('a missing or empty command classifies read-only (the runtime throws before touching the page)', () => {
    for (const toolInput of [{}, { command: '' }, { command: '   ' }, { command: [] }]) {
      const result = shouldAllowToolInMode('browser_tool', toolInput, 'plan', planBand);
      expect(result).toEqual({ allowed: true });
    }
  });

  it('the MCP mutation probe keeps explore\'s historical allow for both command classes (chrome.md binds plan mode only)', () => {
    // Deliberately narrow: denying state-changing browser commands in the probe
    // would also flip default/acceptEdits into prompting through
    // pre-tool-use's MCP mutation oracle — that widening is its own decision,
    // recorded in mode-manager.ts. F1.1050: this arm drove the retired explore;
    // the oracle now asks plan with `mutationProbe` (mcp-mutation-probe.test.ts).
    for (const toolName of browserToolNames) {
      expect(shouldAllowToolInMode(toolName, { command: 'snapshot' }, 'plan', { mutationProbe: true }).allowed).toBe(true);
      expect(shouldAllowToolInMode(toolName, { command: 'click @e1' }, 'plan', { mutationProbe: true }).allowed).toBe(true);
    }
  });

  it('allows browser_tool in ask mode without requiring permission', () => {
    for (const toolName of browserToolNames) {
      const result = shouldAllowToolInMode(toolName, { command: 'click @e1' }, 'default');
      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.requiresPermission).toBeFalsy();
      }
    }
  });

  it('allows browser_tool in allow-all mode', () => {
    for (const toolName of browserToolNames) {
      const result = shouldAllowToolInMode(toolName, {}, 'bypassPermissions');
      expect(result.allowed).toBe(true);
    }
  });
});
