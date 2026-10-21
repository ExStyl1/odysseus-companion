/**
 * P2.320 · a session command carrying an attachment is REFUSED, by name, on
 * every runtime — instead of dropping the file or prompting the model with it.
 *
 * The row is the one corner the P2.292/P2.298/P2.299 seam work could not reach,
 * and it was wrong in two different directions at once:
 *
 *  - **Claude prompted the model.** `ClaudeAgent.chatImpl`'s `isSlashCommand`
 *    requires `!attachments?.length`, so a `/compact` CARRYING a file failed
 *    that test, fell through to `buildTextPrompt`, and reached the model as
 *    prose — the exact failure the classifier exists to prevent, surviving in
 *    the one case nobody sent.
 *  - **Pi dropped the file.** `PiAgent.runSessionCommand` reads the parsed
 *    command and never the attachments, so the compaction happened and the
 *    attachment went nowhere, silently.
 *
 * The owner decided the answer on 2026-09-02: *"refuses, naming the reason — the
 * P3.242 shape; never drop the file, never redefine the ask silently."* Both of
 * the plausible alternatives were behaviour changes to a working path, and
 * picking one quietly is how a user loses a file they meant to send.
 *
 * ## Why the real backend classes and not a BaseAgent double
 *
 * The arm lives in `BaseAgent`, so a `TestAgent` would pass by construction and
 * prove nothing about the runtimes the defect was measured on — the rig note
 * from `session-command-out-of-band-seam.test.ts`, whose harness this file
 * reuses. Each case instantiates the REAL backend and replaces only `chatImpl`
 * with a recorder that THROWS, so a regression routing the command back into a
 * backend fails loudly here rather than silently prompting a model.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { FileAttachment } from '../../utils/files.ts';
import type { BackendConfig } from '../backend/types.ts';
import { ClaudeAgent } from '../claude-agent.ts';
import { CodexAgent } from '../codex-agent.ts';
import { NestorCloudAgent } from '../nestor-cloud-agent.ts';
import { PiAgent } from '../pi-agent.ts';
import type { BaseAgent } from '../base-agent.ts';
import {
  collectEvents,
  createMockBackendConfig,
  createMockCapabilityTurnRuntime,
  createMockSession,
  createMockWorkspace,
} from './test-utils.ts';

const WORKSPACE_ID = 'ws-p2320-attachment-refusal';

let sessionCounter = 0;

function backendConfig(provider: BackendConfig['provider']): BackendConfig {
  sessionCounter += 1;
  const root = mkdtempSync(join(tmpdir(), 'nessy-p2320-'));
  return createMockBackendConfig({
    provider,
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: createMockWorkspace({
      id: WORKSPACE_ID,
      workspaceRootPath: root,
      sessionRootPath: join(root, 'sessions'),
    }),
    session: createMockSession({
      id: `session-p2320-${sessionCounter}`,
      workingDirectory: root,
    }),
  } as Partial<BackendConfig>);
}

const BACKENDS: ReadonlyArray<{ name: string; make: () => BaseAgent }> = [
  { name: 'Pi', make: () => new PiAgent(backendConfig('pi')) as unknown as BaseAgent },
  { name: 'Claude', make: () => new ClaudeAgent(backendConfig('anthropic')) as unknown as BaseAgent },
  { name: 'Codex', make: () => new CodexAgent(backendConfig('codex-runtime')) as unknown as BaseAgent },
  {
    name: 'Nestor Cloud',
    make: () => new NestorCloudAgent(backendConfig('nestor-cloud-agent')) as unknown as BaseAgent,
  },
];

/**
 * The commands to send with a file. `/compact` is the row's own case — the one
 * measured reaching Claude's model as prose. The other three cover the arms
 * that sit at different depths of the seam: `/clear` executes immediately,
 * `/subtask` is per-runtime, `/btw` is answered out-of-band. All four must
 * refuse, because the refusal is BEFORE every arm.
 */
// P6.830 — `/mcp` and `/status` join this table because the merge put them in
// `ParsedSessionCommand`, and that is what makes them inherit this refusal.
// Before it they were classified by a parallel parser ABOVE this gate, so a
// `/mcp` carrying a file answered the command and dropped the file without a
// word — the exact silent drop P2.320 closed for every other session command.
const COMMANDS = [
  '/compact', '/clear', '/subtask do the thing', '/btw where is the config?', '/mcp', '/status',
] as const;

function attachment(): FileAttachment {
  return {
    type: 'text',
    path: '/tmp/nessy-p2320-fixture.txt',
    name: 'nessy-p2320-fixture.txt',
    mimeType: 'text/plain',
    text: 'the file the user meant to send',
    size: 31,
  };
}

interface Harness {
  agent: BaseAgent;
  reachedChatImpl: string[];
}

function harness(make: () => BaseAgent): Harness {
  const agent = make();
  const reachedChatImpl: string[] = [];
  (agent as unknown as { chatImpl: (message: string) => AsyncGenerator<AgentEvent> }).chatImpl =
    async function* (message: string) {
      reachedChatImpl.push(message);
      throw new Error(`chatImpl must not run: ${message}`);
    };
  agent.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime({
    workspaceId: WORKSPACE_ID,
    sessionId: agent['config'].session!.id,
  }));
  return { agent, reachedChatImpl };
}

function infoMessages(events: AgentEvent[]): string[] {
  return events
    .filter((event): event is Extract<AgentEvent, { type: 'info' }> => event.type === 'info')
    .map(event => event.message);
}

describe('P2.320 · a session command with an attachment refuses, naming the command', () => {
  for (const backend of BACKENDS) {
    for (const typed of COMMANDS) {
      it(`${backend.name}: ${typed.split(' ')[0]} with a file never reaches chatImpl`, async () => {
        const { agent, reachedChatImpl } = harness(backend.make);

        const events = await collectEvents(agent.chat(typed, [attachment()]));
        const info = infoMessages(events);

        // The model never sees it — the half that was broken on Claude.
        expect(reachedChatImpl).toEqual([]);
        // And the refusal is spoken, not silent — the half that was broken on Pi.
        expect(info.length).toBeGreaterThan(0);
        expect(info[0]).toContain(typed.split(' ')[0]);
        expect(info[0]).toContain('takes no attachment');
        // The reason is named and the file's fate is stated, so the user is not
        // left guessing whether it went through (P3.242 shape).
        expect(info[0]).toContain('was not read');
        expect(events.at(-1)?.type).toBe('complete');
      });
    }
  }

  it('leaves the SAME commands working when no attachment rides along (positive control)', async () => {
    // Without this, every assertion above could be passing because the seam
    // refuses these commands unconditionally.
    const { agent, reachedChatImpl } = harness(BACKENDS[0]!.make);
    const events = await collectEvents(agent.chat('/clear'));

    expect(reachedChatImpl).toEqual([]);
    expect(infoMessages(events).join('\n')).toContain('Context cleared');
  });

  it('lets an ordinary prompt carry its attachment through to the backend (positive control)', async () => {
    // The refusal must be scoped to session commands. A normal message with a
    // file is the whole reason attachments exist, and it still reaches
    // `chatImpl` — asserted by the recorder throwing on arrival.
    const agent = BACKENDS[0]!.make();
    const reached: string[] = [];
    (agent as unknown as { chatImpl: (message: string) => AsyncGenerator<AgentEvent> }).chatImpl =
      async function* (message: string) {
        reached.push(message);
        yield { type: 'complete' } as AgentEvent;
      };
    agent.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime({
      workspaceId: WORKSPACE_ID,
      sessionId: agent['config'].session!.id,
    }));

    await collectEvents(agent.chat('please read the attached file', [attachment()]));
    expect(reached.length).toBe(1);
  });
});
