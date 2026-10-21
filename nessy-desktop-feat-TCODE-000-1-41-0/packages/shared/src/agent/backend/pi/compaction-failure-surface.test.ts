/**
 * P7.9 — where Pi's compaction-failure signal actually lives, pinned against the
 * INSTALLED runtime rather than against a changelog line.
 *
 * The row arrived as "adopt `session_compact_failed`; keep the inference only as
 * the fallback for an older runtime". Read at 0.84.3, both halves of that premise
 * are wrong in the same direction, and this file is what stops the next reader
 * re-opening it from the changelog alone:
 *
 *  - The event is on the EXTENSION `SessionEvent` surface
 *    (`dist/core/extensions/types.d.ts`, reachable through `on(...)`), emitted by
 *    `_emitSessionCompactFailed` → `extensionRunner.emit`. It is NOT in
 *    `AgentSessionEvent`, which is the union `backend/pi/event-adapter.ts`
 *    consumes and `pi-agent-server` forwards. The adapter structurally cannot
 *    receive it.
 *  - There is no failure INFERENCE to replace. `compaction_end` already declares
 *    `result`, `aborted` and `errorMessage`, and those are exactly what the
 *    adapter branches on. The one inference on that path is the auto-compaction
 *    RACE signature, and `session_compact_failed` carries the same `errorMessage`
 *    string, so it could not replace that either.
 *
 * The single field the new event adds over `compaction_end` is `fromExtension`.
 * Adopting it would cost a wire event to carry one boolean nothing reads — which
 * is why the answer is "no", and why the reason is a test instead of a sentence.
 * (This sentence priced "an extension handler in `pi-agent-server`" too, until
 * 2026-09-11: W13-g measured that the lifecycle bridge already receives
 * `on(event: "session_compact_failed", …)` — the handler is free, only the wire
 * event would cost; P6.1078 records why no terminal hook event is minted there.)
 *
 * THE DAY THIS SHOULD GO RED is the day upstream moves the event into
 * `AgentSessionEvent`, because then it reaches the adapter for free and the row is
 * worth re-opening. That is what the first case below asserts.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const piPackageRoot = dirname(
  Bun.resolveSync('@earendil-works/pi-coding-agent/package.json', import.meta.dir),
);
const agentSessionTypes = readFileSync(join(piPackageRoot, 'dist', 'core', 'agent-session.d.ts'), 'utf8');
const extensionTypes = readFileSync(join(piPackageRoot, 'dist', 'core', 'extensions', 'types.d.ts'), 'utf8');
const agentSessionImpl = readFileSync(join(piPackageRoot, 'dist', 'core', 'agent-session.js'), 'utf8');

/** The `AgentSessionEvent` declaration alone — the file also declares unrelated types. */
function agentSessionEventSlice(): string {
  const start = agentSessionTypes.indexOf('export type AgentSessionEvent =');
  expect(start).toBeGreaterThan(-1);
  const end = agentSessionTypes.indexOf('\nexport ', start + 1);
  return agentSessionTypes.slice(start, end === -1 ? undefined : end);
}

describe('P7.9 Pi 0.84.3 session_compact_failed is an extension event, not a session event', () => {
  it('is ABSENT from the AgentSessionEvent union the host adapter consumes', () => {
    const slice = agentSessionEventSlice();
    // Positive control on the same rig: the slice really is the union, and it
    // really does carry the arm the adapter branches on. Without this, a renamed
    // declaration would make the absence assertion below pass vacuously.
    expect(slice).toContain('type: "compaction_end"');
    expect(slice).toContain('type: "compaction_start"');
    expect(slice).not.toContain('session_compact_failed');
  });

  it('IS on the extension surface, with the one field compaction_end lacks', () => {
    expect(extensionTypes).toContain('type: "session_compact_failed"');
    expect(extensionTypes).toContain('on(event: "session_compact_failed"');
    // `fromExtension` is the entire delta. Named here so a future reader can see
    // what adopting the event would actually buy, rather than re-deriving it.
    const start = extensionTypes.indexOf('interface SessionCompactFailedEvent');
    const declaration = extensionTypes.slice(start, extensionTypes.indexOf('}', start));
    for (const field of ['reason', 'errorMessage', 'aborted', 'willRetry', 'fromExtension']) {
      expect(declaration).toContain(field);
    }
  });

  it('never fires without a compaction_end beside it', () => {
    // The load-bearing measurement: if one emit site existed WITHOUT a sibling
    // `compaction_end`, there would be a failure the host genuinely cannot see
    // and the row would be real. Every site pairs them, so the host loses
    // nothing by consuming the session event alone.
    const emits = agentSessionImpl.split('_emitSessionCompactFailed({').length - 1;
    expect(emits).toBeGreaterThan(0);
    expect(agentSessionImpl.split('type: "compaction_end"').length - 1).toBeGreaterThanOrEqual(emits);
    // And it reaches extension handlers only — never the session's own listeners.
    expect(agentSessionImpl).toContain('_extensionRunner.emit({ type: "session_compact_failed"');
  });

  it('carries the upstream race FIX: the clear is conditional, the unguarded read is gone', () => {
    // `SDK_AUTOCOMPACT_RACE_SIGNATURE` in `event-adapter.ts` used to turn one
    // upstream crash into a friendly retry hint, and its docblock said "remove
    // once the upstream fix ships". The fix shipped in 0.87.1: the `finally`
    // clears the field only while it still holds THIS call's controller, and
    // every `.signal` access goes through the local `abortController`, so the
    // field is never read back unguarded. The inference is removed (TFP1,
    // 2026-10-10); this pin is what makes its removal a decision instead of an
    // accident, and what turns a regression upstream red here first.
    expect(agentSessionImpl).toContain('this._autoCompactionAbortController = undefined;');
    expect(agentSessionImpl).toContain('if (this._autoCompactionAbortController === abortController)');
    expect(agentSessionImpl).not.toContain('this._autoCompactionAbortController.signal');
  });
});
