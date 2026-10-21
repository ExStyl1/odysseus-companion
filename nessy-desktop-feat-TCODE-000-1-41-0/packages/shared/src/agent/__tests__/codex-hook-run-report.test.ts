/**
 * P6.449, codex arm — a codex hook run reaches the transcript, in the same
 * words a claude hook run does.
 *
 * The shared report is `agent/hook-run-report.ts` (W7-s2, `7e5b538e6`) and the
 * claude arm is its first caller. This file is the codex caller.
 *
 * ## The recorded reason for ignoring codex's channel was true of the wrong
 * thing
 *
 * `hook/started` and `hook/completed` were both classified unread with the
 * reason *"this host dispatches hooks itself and does not run codex's"*. That is
 * true of the DISPATCH and irrelevant to the REPORT: a hook codex ran is still a
 * hook whose outcome the user is entitled to see. `hook/completed` is handled
 * now; `hook/started` stays unread with a reason of its own (`status: running`,
 * no outcome, and pairing the two needs a per-session store — the VIEW half,
 * a row of its own).
 *
 * WHAT EACH TEST KILLS:
 *  - the success arm dies if a quiet hook starts costing the user a transcript
 *    line — `hooks.md#exit-code-0`'s rule, kept by the shared report.
 *  - the failure/blocked/stopped arms die if the status mapping drifts. F1.515:
 *    `blocked` maps to the `blocked` outcome — a refusal, which the report says
 *    is one, never "failed" (it mapped to `error` until then) — and codex's
 *    `statusMessage` is still put first so its own sentence says what it
 *    blocked; the `failed` arm is the CONTROL that a crashed hook still fails.
 *  - the entries arm dies if the kinds are flattened into stdout/stderr.
 *    `HookOutputEntryKind` is `warning|stop|feedback|context|error` — a
 *    classification, not a stream — so splitting it would invent a distinction
 *    codex does not publish.
 *  - the `running` arm dies if `hook/started`-shaped runs start emitting.
 *  - the classification arm dies if `hook/completed` goes back on the unread
 *    list, which is the exact regression this arm closed.
 */
import { describe, expect, it } from 'bun:test';
import {
  CODEX_HANDLED_NOTIFICATION_METHODS,
  CODEX_UNREAD_NOTIFICATION_METHODS,
} from '../codex-notification-families.ts';
import { CodexEventAdapter } from '../backend/codex/event-adapter.ts';

function completed(run: Record<string, unknown>) {
  const adapter = new CodexEventAdapter();
  adapter.startTurn();
  return adapter.adapt('hook/completed', { threadId: 't', turnId: 'u', run });
}

const BASE = {
  id: 'h1',
  eventName: 'PreToolUse',
  handlerType: 'command',
  executionMode: 'blocking',
  scope: 'session',
  sourcePath: '/Users/x/.codex/hooks/guard.sh',
  source: 'user',
  displayOrder: 0,
  startedAt: 1,
  completedAt: 2,
  durationMs: 1,
  entries: [],
  statusMessage: null,
};

describe('P6.449 · a codex hook run reaches the transcript', () => {
  it('says NOTHING for a hook that succeeded, however much it printed', () => {
    expect(completed({
      ...BASE,
      status: 'completed',
      entries: [{ kind: 'context', text: 'loaded 12 rules' }],
    })).toEqual([]);
  });

  it('names a failed hook, with its file as the label', () => {
    const events = completed({ ...BASE, status: 'failed', statusMessage: 'exit 2' });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({ type: 'info', level: 'warning' }));
    expect((events[0] as { message: string }).message).toContain('guard.sh');
    expect((events[0] as { message: string }).message).toContain('exit 2');
  });

  it('falls back to the EVENT name when there is no usable source path', () => {
    const events = completed({ ...BASE, status: 'failed', sourcePath: null });
    expect((events[0] as { message: string }).message).toContain('PreToolUse');
  });

  it('F1.515 · maps `blocked` to a refusal: the line says the hook BLOCKED the action, never that it failed, and leads with codex\'s own sentence', () => {
    const events = completed({
      ...BASE,
      status: 'blocked',
      statusMessage: 'blocked: the command writes outside the workspace',
      entries: [{ kind: 'stop', text: 'stopped before the write' }],
    });
    const message = (events[0] as { message: string }).message;
    expect(message).toContain('guard.sh blocked the action');
    expect(message).not.toContain('failed');
    expect(message).toContain('blocked: the command writes outside the workspace');
    expect(message.indexOf('blocked: the command writes'))
      .toBeLessThan(message.indexOf('stopped before the write'));
    expect(events[0]).toEqual(expect.objectContaining({ level: 'warning' }));
  });

  it('F1.515 · the floor hook\'s refusal, in the shape codex reports it (`[feedback]` only), is recorded as blocked', () => {
    const adapter = new CodexEventAdapter();
    const observed: Array<{ outcome: string }> = [];
    adapter.onHookRun = observation => observed.push(observation);
    adapter.startTurn();
    const events = adapter.adapt('hook/completed', { threadId: 't', turnId: 'u', run: {
      ...BASE, eventName: 'permissionRequest', sourcePath: '/Users/x/.codex/config.toml', status: 'blocked',
      statusMessage: 'Checking the unattended-automation floor',
      entries: [{ kind: 'feedback', text: 'this change to the automation is refused rather than reviewed' }],
    } });
    expect(observed.map(o => o.outcome)).toEqual(['blocked']);
    const message = (events[0] as { message: string }).message;
    expect(message).toContain('Hook config.toml blocked the action: Checking the unattended-automation floor');
    expect(message).not.toContain('failed');
  });

  it('F1.515 CONTROL · a hook that crashed still reads as failed', () => {
    const events = completed({
      ...BASE, status: 'failed', entries: [{ kind: 'error', text: 'hook timed out after 30s' }],
    });
    const message = (events[0] as { message: string }).message;
    expect(message).toContain('guard.sh failed');
    expect(message).not.toContain('blocked the action');
  });

  it('maps `stopped` to cancelled, which does not persist', () => {
    const events = completed({ ...BASE, status: 'stopped' });
    expect(events[0]).toEqual(expect.objectContaining({ type: 'info', level: 'info' }));
    expect((events[0] as { message: string }).message).toContain('cancelled');
  });

  it('keeps each entry\'s KIND instead of flattening it into a stream', () => {
    const events = completed({
      ...BASE,
      status: 'failed',
      entries: [
        { kind: 'warning', text: 'deprecated rule' },
        { kind: 'error', text: 'permission denied' },
        { kind: 'feedback', text: 'try --force' },
      ],
    });
    const message = (events[0] as { message: string }).message;
    for (const kind of ['[warning]', '[error]', '[feedback]']) {
      expect(message).toContain(kind);
    }
  });

  it('emits nothing for a run still going, and nothing for a malformed payload', () => {
    expect(completed({ ...BASE, status: 'running' })).toEqual([]);
    const adapter = new CodexEventAdapter();
    adapter.startTurn();
    expect(adapter.adapt('hook/completed', { threadId: 't', turnId: 'u' })).toEqual([]);
    expect(adapter.adapt('hook/completed', { threadId: 't', turnId: 'u', run: 'nope' })).toEqual([]);
  });
});

describe('P6.449 · the classification moved with the behaviour', () => {
  it('hook/completed is handled and hook/started is still unread', () => {
    expect(CODEX_HANDLED_NOTIFICATION_METHODS).toContain('hook/completed' as never);
    expect(CODEX_UNREAD_NOTIFICATION_METHODS).not.toContain('hook/completed' as never);
    // `hook/started` carries `status: running` and no outcome; pairing it with
    // its completion needs a per-session store, which is the VIEW half.
    expect(CODEX_UNREAD_NOTIFICATION_METHODS).toContain('hook/started' as never);
  });
});
