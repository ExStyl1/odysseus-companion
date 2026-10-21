/**
 * P3.308 — codex accepts a permission profile and then cannot build a sandbox
 * from it, so every command in the session dies and nothing said so.
 *
 * ## The measurement these fixtures come from
 *
 * `scripts/platform-rig/run-linux-codex-probe.mjs` — the REAL
 * `codex-app-server` at `rust-v0.148.0`, aarch64-unknown-linux-musl, inside
 * `docker run --network none`, 2026-09-03. Four arms, two of them controls:
 *
 * | arm | `permissionProfile/list` | read the decoy `.env` | read a plain file |
 * | --- | --- | --- | --- |
 * | no profile (CONTROL) | absent | exit 0, `SECRET=decoy-value` — leaks | exit 0, content |
 * | deny on something else (CONTROL) | `allowed: true` | exit 0, `SECRET=decoy-value` — leaks | exit 0, content |
 * | root-anchored deny glob | **`allowed: true`** | exit 1, `error building bubblewrap command` | **exit 1, the SAME error** |
 * | `:workspace_roots` (P3.175) | `allowed: true` | exit 0, **empty stdout — denied** | exit 0, content |
 *
 * Both controls leak the decoy, which is what makes the third row a reading and
 * not a dead rig. The third row's LAST column is the finding: a plain read of a
 * non-secret file dies too, so this is the sandbox failing to exist rather than
 * a deny doing its job. The startup detector sees `allowed: true` and is right;
 * the failure is one layer down.
 *
 * WHAT EACH TEST KILLS:
 *  - "reports the construction failure" dies if the recogniser is removed — the
 *    shipped state, where the session silently cannot run anything.
 *  - "says it is the session and not the command" dies if the message degrades
 *    to a generic tool error: a per-command reading is the wrong repair and
 *    sends the model into retrying a command that can never run.
 *  - "names the pattern codex could not expand" dies if the glob is dropped, and
 *    with it the only thing that says WHICH deny to respell.
 *  - "reports once per session, not once per command" dies if the flag is
 *    cleared per turn — measured, EVERY command fails, so that is one line per
 *    tool call for the rest of the session.
 *  - "keeps the tool result" dies if the notice replaces the row rather than
 *    joining it: the transcript must still show what was attempted.
 *  - "stays silent on an ordinary failure" dies if the signature is widened to
 *    any nonzero exit or any stderr.
 *  - "stays silent on the LINUX DENIAL shape" is the one that would have been
 *    missed by writing this from darwin: a denied read there is exit 0 + EMPTY
 *    stdout, and a recogniser reaching for error text would either miss it or
 *    misfire on it.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { CodexEventAdapter } from '../backend/codex/event-adapter.ts';

/** Verbatim from the rig's `root-anchored` arm (truncated there at 120 chars). */
const BUBBLEWRAP_FAILURE =
  'error building bubblewrap command: Fatal error: unreadable glob `/**/.env` cannot be safely expanded; use a pattern with';

function execCompleted(id: string, output: string, exitCode: number) {
  return {
    threadId: 't', turnId: 'cx-1',
    item: { type: 'commandExecution', id, command: 'cat a/b/c/plain.txt', aggregatedOutput: output, exitCode },
  };
}

type Info = { type: string; message?: string; level?: string };

describe('P3.308 · a session that cannot build a sandbox says so', () => {
  let adapter: CodexEventAdapter;
  beforeEach(() => {
    adapter = new CodexEventAdapter();
    adapter.startTurn('turn-1');
  });

  it('reports the construction failure, durably', () => {
    const events = adapter.adapt('item/completed', execCompleted('c1', BUBBLEWRAP_FAILURE, 1)) as Info[];
    const notice = events.find(event => event.type === 'info');
    expect(notice).toBeDefined();
    // `info` + `warning` is the one family the session layer persists, so a
    // session that can run nothing does not scroll away.
    expect(notice!.level).toBe('warning');
  });

  it('says it is the SESSION and not the command', () => {
    const [, notice] = adapter.adapt('item/completed', execCompleted('c1', BUBBLEWRAP_FAILURE, 1)) as Info[];
    expect(notice!.message).toContain('every command in this session fails before it starts');
    expect(notice!.message).toContain('this is not one command failing');
    // And why the startup check did not catch it, because that is the question
    // a reader will ask next.
    expect(notice!.message).toContain('the profile was accepted');
  });

  it('names the pattern codex could not expand, and the portable spelling', () => {
    const [, notice] = adapter.adapt('item/completed', execCompleted('c1', BUBBLEWRAP_FAILURE, 1)) as Info[];
    expect(notice!.message).toContain('`/**/.env`');
    expect(notice!.message).toContain(':workspace_roots');
  });

  it('degrades to a glob-less sentence when codex named none', () => {
    const [, notice] = adapter.adapt('item/completed',
      execCompleted('c1', 'error building bubblewrap command: something else entirely', 1)) as Info[];
    expect(notice).toBeDefined();
    expect(notice!.message).not.toContain('The pattern codex could not expand');
  });

  it('reports once per session, not once per command or once per turn', () => {
    const first = adapter.adapt('item/completed', execCompleted('c1', BUBBLEWRAP_FAILURE, 1)) as Info[];
    const second = adapter.adapt('item/completed', execCompleted('c2', BUBBLEWRAP_FAILURE, 1)) as Info[];
    adapter.startTurn('turn-2');
    const nextTurn = adapter.adapt('item/completed', execCompleted('c3', BUBBLEWRAP_FAILURE, 1)) as Info[];
    expect(first.filter(e => e.type === 'info')).toHaveLength(1);
    expect(second.filter(e => e.type === 'info')).toHaveLength(0);
    expect(nextTurn.filter(e => e.type === 'info')).toHaveLength(0);
  });

  it('keeps the tool result beside the notice', () => {
    const events = adapter.adapt('item/completed', execCompleted('c1', BUBBLEWRAP_FAILURE, 1)) as Array<{ type: string }>;
    expect(events[0]!.type).toBe('tool_result');
    expect(events).toHaveLength(2);
  });

  it('stays silent on an ordinary command failure', () => {
    const events = adapter.adapt('item/completed',
      execCompleted('c1', 'cat: nope.txt: No such file or directory', 1)) as Info[];
    expect(events.filter(e => e.type === 'info')).toHaveLength(0);
    expect(events).toHaveLength(1);
  });

  it("stays silent on the LINUX DENIAL shape, which is exit 0 and empty output", () => {
    // The arm a darwin-written recogniser gets wrong in both directions: there
    // is no `Operation not permitted` here, and nothing to key on but silence.
    const events = adapter.adapt('item/completed', execCompleted('c1', '', 0)) as Info[];
    expect(events.filter(e => e.type === 'info')).toHaveLength(0);
  });

  it("stays silent on the WARNING every Linux `**` glob produces, including the one that works", () => {
    // Measured on all three profile arms, the portable one included: codex logs
    // an ERROR about unbounded `**` and the deny still works. A recogniser that
    // fired on it would call a working session broken.
    const warning = 'ERROR codex_app_server: Filesystem deny-read glob `:workspace_roots/**/.env` uses `**`. '
      + 'Non-macOS sandboxing does not support unbounded `**` natively; set `glob_scan_max_depth` ...';
    const events = adapter.adapt('item/completed', execCompleted('c1', warning, 0)) as Info[];
    expect(events.filter(e => e.type === 'info')).toHaveLength(0);
  });
});
