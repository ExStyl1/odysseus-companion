/**
 * T7 · the Pi carry-session translator, checked against UPSTREAM'S OWN
 * projection rather than against a restatement of it.
 *
 * `buildContextEntries` and `sessionEntryToContextMessages` are the two
 * functions `SessionManager.buildSessionContext` is built out of, and they
 * became public exports in `pi-coding-agent` 0.84 (U2's note calls this the
 * correctness oracle the plan did not previously have). Running them over the
 * lines we wrote is the difference between "the file looks like what we believe
 * the format is" and "the vendor's own reader turns it into the messages we
 * meant".
 *
 * The other half of the oracle — that a REAL `AgentSession` forks this file,
 * loads it, and emits nothing while doing so — lives in
 * `packages/pi-agent-server/src/compat/pi-carry-session.test.ts`, because that
 * is where the runtime adapter is.
 */

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContextEntries, sessionEntryToContextMessages } from '@earendil-works/pi-coding-agent';

import type { RuntimeHandoffHistoryItem } from '../backend/types.ts';
import {
  PI_CARRY_PROVIDER,
  PI_SESSION_VERSION,
  buildPiCarrySessionLines,
  piCarrySessionIsLoadable,
  piCarrySessionPath,
  serializePiSession,
  verifyPiCarrySession,
  writePiCarrySession,
  type PiSessionLine,
} from '../pi-session-rebuild.ts';

const HISTORY: RuntimeHandoffHistoryItem[] = [
  { kind: 'message', role: 'user', content: 'read the build tag', timestamp: 1_000, runtime: 'anthropic' },
  { kind: 'message', role: 'assistant', content: 'Let me look.', timestamp: 2_000, runtime: 'anthropic' },
  {
    kind: 'tool',
    callId: 'nessy_handoff_row_7',
    name: 'Bash',
    input: { command: 'cat build-info.txt' },
    output: 'build tag for stage 1: bravo-77',
    timestamp: 3_000,
    runtime: 'anthropic',
  },
  { kind: 'message', role: 'assistant', content: 'The tag is bravo-77.', timestamp: 4_000, runtime: 'anthropic' },
];

function build(history: readonly RuntimeHandoffHistoryItem[] = HISTORY): PiSessionLine[] {
  let counter = 0;
  return buildPiCarrySessionLines({
    history,
    cwd: '/workspace/project',
    model: 'tgpt/qwen35-397b-a17b-fp8',
    newEntryId: () => (counter += 1).toString(16).padStart(8, '0'),
    newSessionId: () => 'carry-session-id',
    now: () => 9_000,
  });
}

/** The non-header entries, as `SessionManager.getEntries()` would hand them over. */
function entriesOf(lines: readonly PiSessionLine[]): unknown[] {
  return lines.filter(line => line.type !== 'session');
}

describe('the Pi carry session, read back through upstream’s own projection', () => {
  it('projects to the conversation it was built from, tool pair included', () => {
    const lines = build();

    // The vendor's reader: walk the parentId chain from the leaf, then turn
    // each selected entry into its context messages. `undefined` (not `null`)
    // is what makes `buildSessionPath` fall back to the last entry as the leaf,
    // which is exactly what a freshly forked session does.
    const messages = buildContextEntries(entriesOf(lines) as never, undefined)
      .flatMap(entry => sessionEntryToContextMessages(entry)) as unknown as Array<Record<string, unknown>>;

    expect(messages.map(message => message.role))
      .toEqual(['user', 'assistant', 'assistant', 'toolResult', 'assistant']);
    expect(messages[0]!.content).toEqual([{ type: 'text', text: 'read the build tag' }]);
    // The tool CALL rides an assistant message as a `toolCall` block, and the
    // result is its own `toolResult` message keyed by the same id — the pairing
    // every provider requires and the reason guard 1 upstream synthesizes a
    // result for a dangling call.
    expect(messages[2]!.content).toEqual([{
      type: 'toolCall',
      id: 'nessy_handoff_row_7',
      name: 'Bash',
      arguments: { command: 'cat build-info.txt' },
    }]);
    expect(messages[2]!.stopReason).toBe('toolUse');
    expect(messages[3]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'nessy_handoff_row_7',
      toolName: 'Bash',
      content: [{ type: 'text', text: 'build tag for stage 1: bravo-77' }],
      isError: false,
    });
    // The one fact that only exists inside a tool result — what the whole task
    // is for — survives the projection.
    expect(JSON.stringify(messages)).toContain('bravo-77');
  });

  it('writes the header Pi’s own loader validates, and nothing it would reject', () => {
    const [header, ...entries] = build();
    // `loadEntriesFromFile` returns `[]` — which `forkFrom` reports as "empty
    // or invalid" — unless the FIRST entry is exactly this shape.
    expect(header).toMatchObject({ type: 'session', version: PI_SESSION_VERSION, cwd: '/workspace/project' });
    expect(typeof (header as { id: string }).id).toBe('string');

    // Every other line is a message entry, chained, with an 8-hex id.
    expect(entries.every(entry => entry.type === 'message')).toBe(true);
    const ids = entries.map(entry => (entry as { id: string }).id);
    expect(ids.every(id => /^[0-9a-f]{8}$/.test(id))).toBe(true);
    expect(entries.map(entry => (entry as { parentId: string | null }).parentId))
      .toEqual([null, ...ids.slice(0, -1)]);
  });

  it('stamps a provider the model-restore arm cannot resurrect, and our own provenance off the message', () => {
    const assistant = build()[2] as unknown as { message: Record<string, unknown>; nessyRuntime?: string };
    expect(assistant.message.provider).toBe(PI_CARRY_PROVIDER);
    expect(assistant.message.model).toBe('tgpt/qwen35-397b-a17b-fp8');
    // D10's stamp is on the ENTRY, never on the message: the message object is
    // what `sessionEntryToContextMessages` hands onwards to a provider request.
    expect(assistant.nessyRuntime).toBe('anthropic');
    expect(assistant.message).not.toHaveProperty('nessyRuntime');
    expect(assistant.message).not.toHaveProperty('runtime');
  });

  it('round-trips through the writer and refuses a file that was tampered with', () => {
    const root = mkdtempSync(join(tmpdir(), 'nessy-pi-carry-'));
    try {
      const filePath = join(root, 'handoff.jsonl');
      const lines = build();
      const written = writePiCarrySession(filePath, lines);
      expect(written.entries).toBe(lines.length - 1);
      expect(piCarrySessionIsLoadable(filePath)).toBe(true);
      expect(readFileSync(filePath, 'utf8')).toBe(serializePiSession(lines));

      // A verifier only ever called on good input is not a verifier. Each of
      // these is a way the file could be wrong that Pi itself would NOT report:
      // it skips malformed lines in silence and validates only the header.
      const cases: Array<[string, string, string]> = [
        ['a dropped line', serializePiSession(lines.slice(0, -1)), 'expected'],
        ['a broken chain', serializePiSession([
          lines[0]!,
          { ...(lines[1] as PiSessionLine & Record<string, unknown>), parentId: 'deadbeef' } as PiSessionLine,
          ...lines.slice(2),
        ]), 'unchained'],
        ['a non-session header', serializePiSession(lines.slice(1)), 'header is not one Pi would accept'],
        ['an unparseable body', `${JSON.stringify(lines[0])}\n{oops\n`, 'not valid JSON'],
      ];
      for (const [label, payload, fragment] of cases) {
        const corrupt = join(root, 'corrupt.jsonl');
        writeFileSync(corrupt, payload);
        const count = payload.split('\n').filter(line => line.length > 0).length;
        expect(() => verifyPiCarrySession(corrupt, label === 'a dropped line' ? lines.length : count), label)
          .toThrow(fragment);
      }

      // The same predicate `PiAgent.shouldSuppressTextHandoff` reads: a file
      // whose first line is not a session header is one `forkFrom` throws on,
      // so the text handoff must deliver instead.
      const notASession = join(root, 'not-a-session.jsonl');
      writeFileSync(notASession, '{"type":"message","id":"aaaaaaaa"}\n');
      expect(piCarrySessionIsLoadable(notASession)).toBe(false);
      expect(piCarrySessionIsLoadable(join(root, 'absent.jsonl'))).toBe(false);
      writeFileSync(join(root, 'empty.jsonl'), '');
      expect(piCarrySessionIsLoadable(join(root, 'empty.jsonl'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to write a header with no conversation behind it', () => {
    const root = mkdtempSync(join(tmpdir(), 'nessy-pi-carry-empty-'));
    try {
      expect(() => writePiCarrySession(join(root, 'handoff.jsonl'), build([])))
        .toThrow('refusing to write a carry session with no entries');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('derives the same fixed path the agent re-derives after a quit', () => {
    const path = piCarrySessionPath({ workspaceId: 'ws-1', sessionId: 'sess-1' });
    expect(path.endsWith(join('.pi-carry', 'handoff.jsonl'))).toBe(true);
    // Fixed, not minted: this is what lets the arm survive a quit between the
    // switch that wrote the file and the first turn that forks it, with no
    // persisted field.
    expect(piCarrySessionPath({ workspaceId: 'ws-1', sessionId: 'sess-1' })).toBe(path);
    // And it is NOT inside `.pi-sessions`, which `continueRecent` scans.
    expect(path).not.toContain('.pi-sessions');
  });
});

/**
 * P6.604 — Pi's carry file has a native slot for reasoning, so the projection's
 * new kind lands here as a `thinking` block rather than as prose.
 */
describe('P6.604 · a reasoning entry becomes pi-ai\'s own thinking content', () => {
  it('carries the text and, when the row had one, the signature', () => {
    const lines = build([
      { kind: 'reasoning', content: 'the join is quadratic', signature: 'CAISmQIKiAEIEBgC', timestamp: 1_000 },
    ]);
    const message = lines.find(line => line.type === 'message') as { message: { content: unknown[] } };
    // `@earendil-works/pi-ai`'s `ThinkingContent`, verbatim:
    // `{ type: "thinking"; thinking: string; thinkingSignature?: string }`.
    expect(message.message.content).toEqual([
      { type: 'thinking', thinking: 'the join is quadratic', thinkingSignature: 'CAISmQIKiAEIEBgC' },
    ]);
  });

  it('an unsigned block still crosses here — pi-ai types the signature OPTIONAL', () => {
    // Deliberately NOT the claude arm's rule. There a missing signature makes
    // the block unsendable (`ThinkingBlockParam.signature` is required); here
    // the field carries a redaction payload and the block stands without it.
    const lines = build([{ kind: 'reasoning', content: 'a thought', timestamp: 1_000 }]);
    const message = lines.find(line => line.type === 'message') as { message: { content: unknown[] } };
    expect(message.message.content).toEqual([{ type: 'thinking', thinking: 'a thought' }]);
  });
});
