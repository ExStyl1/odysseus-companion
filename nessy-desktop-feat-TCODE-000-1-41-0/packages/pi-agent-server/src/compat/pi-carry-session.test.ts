/**
 * T7 · the positive control the plan requires before the Pi carry can be
 * believed, run against the REAL Pi runtime on this disk.
 *
 * The plan quotes omnigent's `pi_native_resume.py`: *"Pi only fires
 * `message_start` / `message_end` / `tool_call` events for messages produced
 * inside a live agent loop (after `agent_start`) — NOT for entries loaded from
 * a session file on `session_start`."* That claim is load-bearing for us —
 * if a load DID emit, every carried message would be re-appended to the Nessy
 * transcript through `handleSessionEvent`, and the user would see the whole
 * conversation twice — and the plan is explicit that it must be MEASURED, not
 * cited.
 *
 * **The measurement needs a positive control or it proves nothing.** "No events
 * arrived" is the same observation whether nothing emits or the listener is not
 * wired up, so this test provokes the very events it asserts the absence of,
 * on the SAME session and through the SAME listener: `sendCustomMessage` with
 * no `triggerTurn` appends to state and emits `message_start` + `message_end`
 * synchronously, with no model, no network and no agent loop.
 *
 * Everything here runs the production path — `createPiRuntimeAdapter()` with
 * the default public surface, so `SessionManager.forkFrom` and
 * `createAgentSession` are the vendor's own — minus the subprocess boundary.
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RuntimeHandoffHistoryItem } from '../../../shared/src/agent/backend/types.ts';
import {
  buildPiCarrySessionLines,
  writePiCarrySession,
} from '../../../shared/src/agent/pi-session-rebuild.ts';
import { createPiRuntimeAdapter } from './pi-runtime-adapter.ts';

const CARRIED: RuntimeHandoffHistoryItem[] = [
  { kind: 'message', role: 'user', content: 'what is the build tag?', timestamp: 1_000 },
  { kind: 'message', role: 'assistant', content: 'Reading the file.', timestamp: 2_000 },
  {
    kind: 'tool',
    callId: 'nessy_handoff_row_3',
    name: 'Bash',
    input: { command: 'cat build-info.txt' },
    output: 'build tag for stage 1: carry-control-77',
    timestamp: 3_000,
  },
  { kind: 'message', role: 'assistant', content: 'It is carry-control-77.', timestamp: 4_000 },
];

describe('a forked Pi carry session', () => {
  it('loads the carried conversation and emits nothing while doing it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nessy-pi-carry-live-'));
    const cwd = join(root, 'workspace');
    const agentDir = join(root, '.pi-agent');
    const sessionDir = join(root, '.pi-sessions');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    const carryFile = join(root, '.pi-carry', 'handoff.jsonl');
    writePiCarrySession(carryFile, buildPiCarrySessionLines({ history: CARRIED, cwd, model: 'test-model' }));

    const adapter = createPiRuntimeAdapter();
    const handle = await adapter.createSession({
      cwd,
      agentDir,
      registry: await adapter.createRegistry(),
      strategy: { kind: 'fork', parentSessionFile: carryFile, sessionDir },
      sessionOptions: { tools: [] },
    });

    try {
      // The fork really happened: a NEW file in the session dir, and the
      // session is holding the carried conversation rather than starting
      // empty. Without this the absence measured below would be vacuous.
      expect(readdirSync(sessionDir).filter(name => name.endsWith('.jsonl'))).toHaveLength(1);
      expect(handle.session.messages.map(message => (message as { role: string }).role))
        .toEqual(['user', 'assistant', 'assistant', 'toolResult', 'assistant']);
      // The fact that exists ONLY inside a carried tool result.
      expect(JSON.stringify(handle.session.messages)).toContain('carry-control-77');

      const seen: string[] = [];
      const unsubscribe = handle.session.subscribe(event => { seen.push(event.type); });
      // Give anything deferred a chance to arrive — a load that emitted on a
      // microtask or a timer would show up here.
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(seen.filter(type => type === 'message_start' || type === 'message_end' || type === 'tool_call'))
        .toEqual([]);

      // POSITIVE CONTROL, same session, same listener: prove those event names
      // CAN reach it, so the empty list above is a property of loading and not
      // of the wiring.
      await handle.session.sendCustomMessage({
        customType: 'nessy-carry-control',
        content: 'control',
        display: false,
      });
      expect(seen.filter(type => type === 'message_start' || type === 'message_end'))
        .toEqual(['message_start', 'message_end']);
      unsubscribe();
    } finally {
      handle.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
