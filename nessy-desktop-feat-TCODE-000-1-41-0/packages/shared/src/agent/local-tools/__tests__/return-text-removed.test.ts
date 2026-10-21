import { describe, expect, test } from 'bun:test';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalToolRuntime, type LocalToolCall, type LocalToolOperation } from '../index.ts';

// `return_text` was the operation the two terminal tools (`ask_followup_question`,
// `plan_mode_respond`) used to map to: it echoed the model's own question back as
// the tool result, so the user never saw the question and the model answered
// itself (T9/F5). Its last producers are gone; the operation must be gone too,
// because a dead member of a shared vocabulary invites a new wrong producer.
describe('the return_text local-tool operation is gone', () => {
  test('the operation union no longer admits it', () => {
    // The assertion IS the `@ts-expect-error`: it fails the typecheck the moment
    // the kind becomes assignable again, which is the only way this operation can
    // come back.
    // @ts-expect-error - `return_text` is not a LocalToolOperation kind any more.
    const dead: LocalToolOperation = { kind: 'return_text', text: 'echoed' };
    expect(dead).toBeDefined();
  });

  test('the runtime does not echo a return_text payload back as a successful result', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'nessy-return-text-')));
    const runtime = new LocalToolRuntime({
      filesystemScope: {
        session: { workspaceId: 'ws-test', sessionId: 'session-test' },
        primaryRoot: workspace,
        cwd: workspace,
        additionalRoots: [],
        managedExclusions: [],
        generation: 'g-test',
      },
      permissionManager: { evaluateToolCall: () => ({ allowed: true }) },
    });

    const call = {
      id: 'call-dead',
      displayName: 'ReturnText',
      operation: { kind: 'return_text', text: 'echoed' },
      permission: { toolName: 'ReturnText', input: {} },
    } as unknown as LocalToolCall;

    // The invariant is that the payload never comes back as the tool's answer.
    // HOW the dispatch declines it (no arm, so no result) is deliberately not
    // asserted: `executeAuthorized` returns `this.guardResult(...)` without
    // awaiting it, so the shape of the decline depends on whether the large-result
    // guard is active — an unrelated seam this test must not pin down.
    //
    // Both outcomes are named explicitly rather than laundered through a
    // `.catch(() => null)`: swallowing the rejection into `undefined` made the
    // assertion pass for ANY outcome, including the pre-removal one, if the
    // dispatch had ever thrown. Pre-removal the call RESOLVED with
    // `content: 'echoed'`, so the resolved branch below is what fails then.
    const settled = await runtime.executeAuthorized(call).then(
      // The declared return type is not honoured on an unhandled kind — the
      // dispatch falls out of the switch — so the test reads it as optional.
      (result: { content?: string; isError?: boolean } | undefined) => ({ status: 'resolved' as const, result }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );

    if (settled.status === 'resolved') {
      // Pre-removal this resolved `{ content: 'echoed', isError: false }`: both
      // assertions below fail against that, which is what makes them a guard.
      expect(settled.result?.content).not.toBe('echoed');
      expect(settled.result?.isError ?? true).toBe(true);
    } else {
      // A refusal is fine; a refusal that somehow carried the payload is not.
      expect(String((settled.error as Error | undefined)?.message ?? settled.error))
        .not.toContain('echoed');
    }
  });
});
