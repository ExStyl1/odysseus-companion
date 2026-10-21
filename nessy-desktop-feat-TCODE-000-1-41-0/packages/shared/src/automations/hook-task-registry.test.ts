import { describe, expect, it } from 'bun:test';
import {
  HOOK_REGISTRY_TEXT_CAP,
  capHookRegistryText,
  friendlyBackgroundTaskType,
} from './hook-task-registry.ts';

describe('capHookRegistryText (hooks.md :2203, :2217)', () => {
  it('leaves anything at or under the cap alone', () => {
    expect(capHookRegistryText('short')).toBe('short');
    expect(capHookRegistryText('x'.repeat(HOOK_REGISTRY_TEXT_CAP)))
      .toBe('x'.repeat(HOOK_REGISTRY_TEXT_CAP));
  });

  it('clips with the documented in-string marker and the exact dropped count', () => {
    // The marker text `… [+N chars]` is part of the contract — a plain
    // truncation is a different string and a hook parsing it sees nothing.
    const capped = capHookRegistryText('x'.repeat(1500));
    expect(capped.length).toBe(HOOK_REGISTRY_TEXT_CAP);
    expect(capped).toBe(`${'x'.repeat(986)}… [+514 chars]`);
    // N counts the characters the cap actually dropped, not `length - 1000`:
    // the marker occupies part of the budget, so it must account for itself.
    expect(1500 - 986).toBe(514);
  });

  it('settles N when the marker width changes with N', () => {
    // 1010 chars: a naive N of 10 gives a 13-char marker, which drops 23 — and
    // 23 is still 13 characters wide, so the fixed point holds at the second
    // pass rather than reporting the wrong count.
    const capped = capHookRegistryText('y'.repeat(1010));
    expect(capped).toBe(`${'y'.repeat(987)}… [+23 chars]`);
    expect(capped.length).toBe(HOOK_REGISTRY_TEXT_CAP);
  });

  it('is idempotent — a string already at the cap comes back unchanged', () => {
    const capped = capHookRegistryText('z'.repeat(4000));
    expect(capHookRegistryText(capped)).toBe(capped);
  });
});

describe('friendlyBackgroundTaskType (hooks.md :2201)', () => {
  it.each([
    ['bash_background', 'shell'],
    ['monitor', 'monitor'],
    ['subagent', 'subagent'],
    ['workflow', 'workflow'],
    ['mcp', 'MCP task'],
    ['cloud_session', 'cloud session'],
    // A caller that already speaks the documented vocabulary is a no-op.
    ['MCP task', 'MCP task'],
  ] as const)('maps %s onto the friendly label %s', (raw, label) => {
    expect(friendlyBackgroundTaskType(raw)).toBe(label);
  });

  it('falls back to the raw discriminant for an unrecognized type', () => {
    // ":2201 — Falls back to the raw discriminant for unrecognized types."
    // Dropping the entry would under-report what the session is waiting on;
    // forcing it into a documented label would misdescribe it.
    expect(friendlyBackgroundTaskType('quantum_evaluator')).toBe('quantum_evaluator');
  });
});
