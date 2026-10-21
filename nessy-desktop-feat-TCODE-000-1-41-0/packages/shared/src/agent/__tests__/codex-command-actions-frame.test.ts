/**
 * D1.350 — codex's own `commandActions` reaches the host frame, and the TWO
 * readers of it cannot disagree.
 *
 * ## Where these fixtures come from
 *
 * Every `commandActions` array below is VERBATIM from a real turn driven
 * 2026-09-18 against the staged `codex-app-server` (`rust-v0.154.0`,
 * darwin-arm64) over the loopback stub Responses adapter on a fake key, in an
 * isolated `CODEX_HOME` and a `git init`'d temp workspace with the product's
 * real permission profile — never a packaged app and never anybody's session.
 * Only the absolute `path` values are re-pointed at this suite's own directory.
 * Twelve commands, twelve turns, each its own boot.
 *
 * The table is codex's classifier being ACCURATE and DISCRIMINATING, which is
 * what makes it worth reading at all: `grep` comes back `search` and a two-file
 * `cat` comes back `unknown`, so a suite that only ever saw `read` would be
 * pinning a constant.
 *
 * ## What each case kills
 *
 *  - "publishes …" dies if `CodexEventAdapter` goes back to dropping the field,
 *    which is the whole of the row.
 *  - "omits the key …" is the negative control AND the compatibility pin: a
 *    command codex did not classify must produce the byte-identical
 *    `{ command }` input the transcript had before this row.
 *  - "the two readers agree …" is the row's own invariant. It is anchored to
 *    the measured table rather than to itself: the adapter's published list is
 *    compared BOTH to what codex sent and to what the credit's reader returns,
 *    so neither reader can drift without failing.
 *  - the validation cases are the boundary: an entry whose discriminant is not
 *    one of the four the generated union declares, an entry with no `command`,
 *    and a non-array are each DROPPED rather than admitted untyped — because
 *    the credit acts on what it reads.
 */
import { describe, expect, it } from 'bun:test';
import {
  CodexEventAdapter,
  readCodexCommandActions,
  type CodexCommandAction,
} from '../backend/codex/event-adapter.ts';

/** The workspace path codex resolved for itself, re-pointed at a stable stand-in. */
const WS = '/var/folders/tmp/d1350-ws/target.txt';

/**
 * The twelve measured turns: the command the model sent, the LOGIN-SHELL form
 * codex re-spells it as on the wire, the `commandActions` it published, and the
 * exit code it finished with.
 */
const MEASURED: ReadonlyArray<{
  sent: string;
  wire: string;
  actions: readonly CodexCommandAction[];
  exitCode: number;
}> = [
  {
    sent: 'cat target.txt',
    wire: "/bin/zsh -lc 'cat target.txt'",
    actions: [{ type: 'read', command: 'cat target.txt', name: 'target.txt', path: WS }],
    exitCode: 0,
  },
  {
    sent: 'cat ./target.txt',
    wire: "/bin/zsh -lc 'cat ./target.txt'",
    // Codex resolves the relative operand to an ABSOLUTE path itself — one of
    // the two things the host cannot get right on its own.
    actions: [{ type: 'read', command: 'cat ./target.txt', name: 'target.txt', path: WS }],
    exitCode: 0,
  },
  {
    sent: 'nl target.txt',
    wire: "/bin/zsh -lc 'nl target.txt'",
    actions: [{ type: 'read', command: 'nl target.txt', name: 'target.txt', path: WS }],
    exitCode: 0,
  },
  {
    sent: 'head -n 1 target.txt',
    wire: "/bin/zsh -lc 'head -n 1 target.txt'",
    // A PARTIAL read codex still calls `read` — which is why the credit still
    // puts the action's own command through `bareFileViewerOperand`.
    actions: [{ type: 'read', command: 'head -n 1 target.txt', name: 'target.txt', path: WS }],
    exitCode: 0,
  },
  {
    sent: 'tail -n 1 target.txt',
    wire: "/bin/zsh -lc 'tail -n 1 target.txt'",
    actions: [{ type: 'read', command: 'tail -n 1 target.txt', name: 'target.txt', path: WS }],
    exitCode: 0,
  },
  {
    sent: 'sed -n 1,1p target.txt',
    wire: "/bin/zsh -lc 'sed -n 1,1p target.txt'",
    // Codex re-quotes the script operand in the action's own command.
    actions: [{ type: 'read', command: "sed -n '1,1p' target.txt", name: 'target.txt', path: WS }],
    exitCode: 0,
  },
  {
    sent: 'grep sable target.txt',
    wire: "/bin/zsh -lc 'grep sable target.txt'",
    // THE FIRST CONTROL: the classifier discriminates rather than answering
    // `read` to everything that names a file. Note the `path`: RELATIVE here,
    // where every `read` row above carries an absolute one. Verbatim, and the
    // reason nothing in this tree may assume a `CommandAction.path` is absolute
    // — only the `read` variant's is, which is the one the credit resolves.
    actions: [{ type: 'search', command: 'grep sable target.txt', query: 'sable', path: 'target.txt' }],
    exitCode: 0,
  },
  {
    sent: 'cat target.txt other.txt',
    wire: "/bin/zsh -lc 'cat target.txt other.txt'",
    // THE SECOND CONTROL.
    actions: [{ type: 'unknown', command: 'cat target.txt other.txt' }],
    exitCode: 1,
  },
  {
    sent: 'cat target.txt | grep sable',
    wire: "/bin/zsh -lc 'cat target.txt | grep sable'",
    // TWO actions — the shape the union's own doc comment exists for, and the
    // reason the credit requires exactly one.
    actions: [
      { type: 'read', command: 'cat target.txt', name: 'target.txt', path: WS },
      { type: 'search', command: 'grep sable', query: 'sable', path: null },
    ],
    exitCode: 0,
  },
  {
    sent: 'cat target.txt && echo done',
    wire: "/bin/zsh -lc 'cat target.txt && echo done'",
    actions: [{ type: 'unknown', command: 'cat target.txt && echo done' }],
    exitCode: 0,
  },
  {
    sent: 'bat target.txt',
    wire: "/bin/zsh -lc 'bat target.txt'",
    // A `read` action that showed nobody anything: no `bat` on the rig.
    actions: [{ type: 'read', command: 'bat target.txt', name: 'target.txt', path: WS }],
    exitCode: 127,
  },
  {
    sent: 'cat missing.txt',
    wire: "/bin/zsh -lc 'cat missing.txt'",
    actions: [{ type: 'read', command: 'cat missing.txt', name: 'missing.txt', path: '/var/folders/tmp/d1350-ws/missing.txt' }],
    exitCode: 1,
  },
];

/** The `commandExecution` item shape codex sends, around one measured row. */
function commandItem(row: (typeof MEASURED)[number], phase: 'started' | 'completed') {
  return {
    type: 'commandExecution',
    id: 'call_resp_1',
    pluginId: null,
    scriptPath: null,
    command: row.wire,
    cwd: '/var/folders/tmp/d1350-ws',
    processId: '99595',
    source: 'unifiedExecStartup',
    status: phase === 'started' ? 'inProgress' : row.exitCode === 0 ? 'completed' : 'failed',
    commandActions: row.actions,
    aggregatedOutput: phase === 'started' ? null : 'sable-harbour-41\n',
    exitCode: phase === 'started' ? null : row.exitCode,
    durationMs: phase === 'started' ? null : 0,
  };
}

function startFrame(item: unknown): { toolName?: string; input?: Record<string, unknown> } {
  const adapter = new CodexEventAdapter();
  adapter.startTurn('turn-1');
  const [event] = adapter.adapt('item/started', { item });
  return (event ?? {}) as { toolName?: string; input?: Record<string, unknown> };
}

describe('D1.350 — the codex frame carries codex\'s own commandActions', () => {
  it('publishes them on the Bash tool_start beside the login-shell command', () => {
    const row = MEASURED[0]!;
    const frame = startFrame(commandItem(row, 'started'));
    // Read into locals BEFORE asserting a shape: `toMatchObject` with an
    // asymmetric matcher OVERWRITES the key it matched (AGENTS.md).
    const input = frame.input ?? {};
    expect(frame.toolName).toBe('Bash');
    expect(input.command).toBe(row.wire);
    expect(input.commandActions).toEqual(row.actions);
  });

  it('omits the key entirely when codex classified nothing — the pre-row shape', () => {
    // The negative control AND the compatibility pin. `ls -la` with no
    // `commandActions` is what every other codex suite in this tree sends.
    const frame = startFrame({ type: 'commandExecution', id: 'c1', command: 'ls -la' });
    expect(frame.input).toEqual({ command: 'ls -la' });
    expect(Object.keys(frame.input ?? {})).toEqual(['command']);
  });

  it('the two readers agree on every one of the twelve measured commands', () => {
    for (const row of MEASURED) {
      const started = commandItem(row, 'started');
      const completed = commandItem(row, 'completed');
      // (a) what the ADAPTER publishes on the frame is what codex sent…
      const published = startFrame(started).input?.commandActions;
      expect(published).toEqual(row.actions);
      // (b) …and it is identical to what the CREDIT's reader returns from the
      // item it is handed at `item/completed`, which is the other phase.
      expect(readCodexCommandActions(completed)).toEqual(row.actions);
      expect(readCodexCommandActions(started)).toEqual(published as CodexCommandAction[]);
    }
  });

  it('is populated at item/started as well as item/completed', () => {
    // The reading the adapter's placement rests on: if codex only filled this
    // in at completion, putting it on `tool_start` would publish nothing.
    for (const row of MEASURED) {
      expect(readCodexCommandActions(commandItem(row, 'started'))).toEqual(row.actions);
    }
  });
});

describe('D1.350 — readCodexCommandActions validates rather than trusting', () => {
  it('drops an entry whose discriminant is not one the generated union declares', () => {
    const actions = readCodexCommandActions({
      commandActions: [
        { type: 'read', command: 'cat a.txt', name: 'a.txt', path: '/a.txt' },
        { type: 'teleport', command: 'cat a.txt' },
      ],
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]?.type).toBe('read');
  });

  it('drops an entry with no command, and one that is not an object', () => {
    const actions = readCodexCommandActions({
      commandActions: [{ type: 'read', path: '/a.txt' }, { type: 'read', command: '' }, 'read', null, []],
    });
    expect(actions).toEqual([]);
  });

  it('returns [] for a non-array, a missing field and a non-object item', () => {
    expect(readCodexCommandActions({ commandActions: 'read' })).toEqual([]);
    expect(readCodexCommandActions({ type: 'commandExecution' })).toEqual([]);
    expect(readCodexCommandActions(undefined)).toEqual([]);
    expect(readCodexCommandActions('commandExecution')).toEqual([]);
  });

  it('keeps the variant fields the credit and the transcript read', () => {
    // `path` is what the credit resolves and `query` is what a search row would
    // show; a parser that rebuilt only `{type, command}` would type-check and
    // silently un-credit every read.
    const [action] = readCodexCommandActions({
      commandActions: [{ type: 'read', command: 'cat a.txt', name: 'a.txt', path: '/abs/a.txt' }],
    });
    expect(action).toEqual({ type: 'read', command: 'cat a.txt', name: 'a.txt', path: '/abs/a.txt' });
  });
});
