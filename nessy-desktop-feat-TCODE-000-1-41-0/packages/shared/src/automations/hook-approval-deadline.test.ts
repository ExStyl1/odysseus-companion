/**
 * D1.333 `[host]` `[pi]` — the `UserPromptSubmit` hook that hung the turn for
 * ever, its cause, and the bound that replaces it.
 *
 * ## The measurement this file pins
 *
 * RS-77's six-rung ladder, one Pi gateway card, a fresh session per rung, the
 * no-hook control FIRST and again LAST: `true`, `echo <marker>`,
 * `cat > /dev/null` and `cat` (stdin → stdout) all ANSWERED; **`cat >> <path>`
 * timed out at 60 s, then at 121 s on a re-run, and never created the file**;
 * the `cat > /dev/null` rung re-run straight after it answered in 6 s, so the
 * app had not wedged itself. The path made no difference and both spellings ran
 * in milliseconds under a plain `sh -c`.
 *
 * ## The cause, and the two things it is NOT
 *
 * It is not the hook's stdin and it is not `runHookCommand`. Driven at HEAD over
 * the same six rungs in a temp dir, `runHookCommand` answered **9 / 9 / 17 / 10
 * / 12 / 13 ms**, all exit 0, and the `cat >> <path>` rung CREATED its file.
 *
 * It is the HOST'S OWN PERMISSION GATE. `SessionManager.pluginCommandHookRunner`
 * puts every command hook through `shouldPromptInAskMode` /
 * `shouldPromptInAutoMode` and, on `ask`, raises a `permission_request` card and
 * awaits the answer — on a promise that settled only on a click or an abort.
 *
 * **The ladder is driven against the REAL RUNNER, in
 * `server-core/src/sessions/SessionManager.hook-approval-deadline.test.ts`, and
 * that placement was forced by a measurement.** A first draft called
 * `shouldPromptInAutoMode` directly with a hand-made
 * `{ workspaceRootPath, activeSourceSlugs }` context, and it answered a
 * DIFFERENT table from the one the runner produces: `cat > /dev/null` came back
 * `ALLOW` against the developer's own `~/.nessy-agent/config.json` and `ASK`
 * against an empty `NESSY_CONFIG_DIR`, while the packaged sitting — on a fresh
 * config dir — answered that rung in 6 s, twice. The runner does not pass a
 * hand-made context: it builds one with `setCapabilityPermissionLayers` and
 * `getCapabilityPermissionsContext()`, which carries the built-in layers. So a
 * raw call to the classifier is a different instrument with a different input,
 * and it disagrees with production in BOTH directions depending on whose profile
 * is on disk.
 *
 * The file is never created because the spawn sits BELOW that await: the shell
 * never ran, which is why `>>` — an operator that opens its target before the
 * command starts — left nothing on disk.
 *
 * ## What is fixed here, and what is deliberately left to the owner
 *
 * The BOUND, and the sentence. Whether a command hook should need a card at all
 * is a product posture — `hooks.md` documents a hook as simply running, and this
 * fork gates it — and a lane does not take one. What a lane may fix is the shape
 * of the failure: a hang with no diagnostic is the worst shape there is.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  hookApprovalTimeoutNotice,
  raceHookApprovalDeadline,
  runHookCommand,
} from './hook-command.ts';

async function workspace(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'd1333-')));
}

describe('D1.333 — `runHookCommand` is not the site', () => {
  test('the rung that hung on the packaged build returns here, and creates its file', async () => {
    const root = await workspace();
    const capture = join(root, 'capture.jsonl');
    expect(existsSync(capture)).toBe(false);

    const result = await runHookCommand(
      { type: 'command', command: `cat >> ${capture}` },
      {
        event: 'UserPromptSubmit',
        input: { hook_event_name: 'UserPromptSubmit', prompt: 'hello' },
        cwd: root,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.timedOut ?? false).toBe(false);
    expect(existsSync(capture)).toBe(true);
    // The payload really reached the hook's stdin — the whole point of the rung.
    expect(await readFile(capture, 'utf-8')).toContain('"hook_event_name":"UserPromptSubmit"');
  });
});

describe('D1.333 — the bound', () => {
  test('an answer that arrives wins, and the deadline never fires', async () => {
    // POSITIVE CONTROL FIRST: a bound that always expired would pass every
    // timeout assertion below.
    let expired = 0;
    const answered = await raceHookApprovalDeadline(
      Promise.resolve({ allowed: true }),
      50,
      () => { expired += 1; return { allowed: false }; },
    );
    expect(answered).toEqual({ allowed: true });
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(expired).toBe(0);
  });

  test('a wait nobody answers ends at the budget, once, and a late answer is a no-op', async () => {
    let expired = 0;
    let settleLate: ((value: { allowed: boolean }) => void) | undefined;
    const never = new Promise<{ allowed: boolean }>(resolve => { settleLate = resolve; });

    const verdict = await raceHookApprovalDeadline(never, 20, () => {
      expired += 1;
      return { allowed: false };
    });
    expect(verdict).toEqual({ allowed: false });
    expect(expired).toBe(1);

    // The click that arrives after the deadline must not produce a second
    // answer — the shape that would let an expired card still run the hook.
    settleLate?.({ allowed: true });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(expired).toBe(1);
  });

  test('a rejection still rejects, so an unreachable renderer is an error and not a silent allow', async () => {
    let expired = 0;
    await expect(raceHookApprovalDeadline(
      Promise.reject(new Error('renderer is gone')),
      1_000,
      () => { expired += 1; return { allowed: true }; },
    )).rejects.toThrow('renderer is gone');
    expect(expired).toBe(0);
  });

  test('the notice names the command, the budget and the one field that raises it', () => {
    const notice = hookApprovalTimeoutNotice('cat >> /tmp/capture.jsonl', 10_000);
    expect(notice).toContain('cat >> /tmp/capture.jsonl');
    expect(notice).toContain('10000');
    expect(notice).toContain('timeout');
    // NOT a silent success: the sentence has to say the hook did not run, or it
    // reads as a warning about a hook that did.
    expect(notice).toContain('did not run');
  });
});
