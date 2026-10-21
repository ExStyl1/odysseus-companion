/**
 * P6.106 · `/clear` offers the session it set aside, and `/resume` takes it
 * back — at the seam, on every runtime, never reaching a model.
 *
 * The defect: `parseSessionCommand` had no `resume` kind at all, so the
 * `/resume <session-id> (previous session)` the rewind menu documents composed
 * an ordinary turn — pinned capability block and all — and asked the MODEL. On
 * all four backends, so a per-runtime divergence check could not see it. And
 * there was nothing to name even if the command had existed: nothing kept a
 * record of the runtime session `/clear` dropped.
 *
 * Same rig as `session-command-help-seam.test.ts` and for its reason: the arms
 * live in `BaseAgent`, so a `TestAgent` double would pass by construction. Each
 * case instantiates the REAL backend class and replaces only `chatImpl` with a
 * recorder that throws, so a regression routing either command back into a
 * backend fails loudly instead of silently prompting a model.
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig } from '../backend/types.ts';
import { ClaudeAgent } from '../claude-agent.ts';
import { CodexAgent } from '../codex-agent.ts';
import { NestorCloudAgent } from '../nestor-cloud-agent.ts';
import { PiAgent } from '../pi-agent.ts';
import type { BaseAgent } from '../base-agent.ts';
import { getSessionDirPath } from '../../sessions/storage.ts';
import { parseSessionCommand } from '../../slash-commands/session-command.ts';
import {
  collectEvents,
  createMockBackendConfig,
  createMockCapabilityTurnRuntime,
  createMockSession,
  createMockWorkspace,
} from './test-utils.ts';

const WORKSPACE_ID = 'ws-p6106-resume-seam';

let sessionCounter = 0;

function backendConfig(provider: BackendConfig['provider'], captured: string[]): BackendConfig {
  sessionCounter += 1;
  const root = mkdtempSync(join(tmpdir(), 'nessy-p6106-'));
  return createMockBackendConfig({
    provider,
    isHeadless: true,
    skipConfigWatcher: true,
    onSdkSessionIdUpdate: (id: string) => { captured.push(id); },
    workspace: createMockWorkspace({
      id: WORKSPACE_ID,
      workspaceRootPath: root,
      sessionRootPath: join(root, 'sessions'),
    }),
    session: createMockSession({
      id: `session-p6106-${sessionCounter}`,
      workingDirectory: root,
    }),
  } as Partial<BackendConfig>);
}

interface Harness {
  agent: BaseAgent;
  reachedChatImpl: string[];
  /** Ids the agent re-published to the host through `onSdkSessionIdUpdate`. */
  republished: string[];
}

function harness(make: (captured: string[]) => BaseAgent): Harness {
  const republished: string[] = [];
  const agent = make(republished);
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
  return { agent, reachedChatImpl, republished };
}

/**
 * The three backends that publish a resumable anchor, each with the field its
 * own resume path reads — set directly so the case does not need a live
 * runtime, and named individually because "which field is the anchor" is the
 * whole thing this row had to establish. `prepareResume` is what the adopting
 * arm runs after `/clear`: UA12.217 made Pi's adoption HONEST — the host
 * resolves the id to its own `.pi-sessions` sidecar and refuses when the file
 * is gone — so Pi's case plants that sidecar (and removes it after), while the
 * other runtimes adopt the anchor by id alone and need nothing on disk.
 */
const ANCHORED: ReadonlyArray<{ name: string; make: (c: string[]) => BaseAgent; anchor: (a: BaseAgent, id: string) => void; prepareResume?: (a: BaseAgent, id: string) => () => void }> = [
  {
    name: 'Pi',
    make: c => new PiAgent(backendConfig('pi', c)) as unknown as BaseAgent,
    anchor: (agent, id) => { (agent as unknown as { piSessionId: string | null }).piSessionId = id; },
    prepareResume: (agent, id) => {
      const piSessionsDir = join(
        getSessionDirPath(WORKSPACE_ID, agent['config'].session!.id),
        '.pi-sessions',
      );
      mkdirSync(piSessionsDir, { recursive: true });
      const sidecar = join(piSessionsDir, `20260101T000000_${id}.jsonl`);
      writeFileSync(sidecar, '{}\n');
      return () => {
        rmSync(sidecar, { force: true });
        rmSync(piSessionsDir, { force: true, recursive: true });
      };
    },
  },
  {
    name: 'Claude',
    make: c => new ClaudeAgent(backendConfig('anthropic', c)) as unknown as BaseAgent,
    anchor: (agent, id) => { (agent as unknown as { sessionId: string | null }).sessionId = id; },
  },
  {
    name: 'Codex',
    make: c => new CodexAgent(backendConfig('codex-runtime', c)) as unknown as BaseAgent,
    anchor: (agent, id) => { (agent as unknown as { threadId: string | null }).threadId = id; },
  },
];

function infoMessages(events: AgentEvent[]): string[] {
  return events
    .filter((event): event is Extract<AgentEvent, { type: 'info' }> => event.type === 'info')
    .map(event => event.message);
}

describe('P6.106 · the classifier claims /resume, whole-message only', () => {
  it('reads both forms', () => {
    expect(parseSessionCommand('/resume')).toEqual({ kind: 'resume' });
    expect(parseSessionCommand('  /RESUME  ')).toEqual({ kind: 'resume' });
    expect(parseSessionCommand('/resume thread_abc-123')).toEqual({ kind: 'resume', sessionId: 'thread_abc-123' });
  });

  it('leaves prose to the model (positive control for every case below)', () => {
    expect(parseSessionCommand('/resume the conversation about caching')).toBeNull();
    expect(parseSessionCommand('what does /resume do?')).toBeNull();
  });
});

describe('P6.106 · /clear offers the session it set aside, and /resume takes it', () => {
  for (const backend of ANCHORED) {
    it(`${backend.name}: /clear names the runtime anchor it just dropped`, async () => {
      const { agent, reachedChatImpl } = harness(backend.make);
      backend.anchor(agent, 'anchor-before-clear');

      const said = infoMessages(await collectEvents(agent.chat('/clear'))).join('\n');

      expect(reachedChatImpl).toEqual([]);
      expect(said).toContain('Context cleared');
      expect(said).toContain('/resume anchor-before-clear');
    });

    it(`${backend.name}: /resume adopts it and re-publishes it to the host`, async () => {
      const { agent, reachedChatImpl, republished } = harness(backend.make);
      backend.anchor(agent, 'anchor-before-clear');
      await collectEvents(agent.chat('/clear'));
      // UA12.217 — Pi's adoption resolves the id to its sidecar before it
      // answers; the case plants that file so the honest adopt path (not the
      // gone-file refusal) is the path under test.
      const cleanup = backend.prepareResume?.(agent, 'anchor-before-clear');

      try {
        const said = infoMessages(await collectEvents(agent.chat('/resume'))).join('\n');

        expect(reachedChatImpl).toEqual([]);
        expect(said).toContain('Resuming anchor-before-clear');
        // The host half. Without it the persisted anchor and the live one
        // disagree, and the next process starts the conversation over.
        expect(republished).toEqual(['anchor-before-clear']);
        if (backend.name === 'Pi') {
          // UA12.217 — the adopted sidecar is armed for the next spawn, so the
          // subprocess opens the NAMED file instead of the directory's newest.
          expect(
            (agent as unknown as { piResumeSessionFile: string | null }).piResumeSessionFile,
          ).toContain(`_anchor-before-clear.jsonl`);
        }
      } finally {
        cleanup?.();
      }
    });

    it(`${backend.name}: an id this session never set aside is refused, naming the one it holds`, async () => {
      const { agent, republished } = harness(backend.make);
      backend.anchor(agent, 'anchor-before-clear');
      await collectEvents(agent.chat('/clear'));

      const said = infoMessages(await collectEvents(agent.chat('/resume typo-999'))).join('\n');

      expect(said).toContain('anchor-before-clear');
      expect(said).not.toContain('Resuming');
      // Nothing adopted: a typo must not open an empty conversation that looks
      // resumed.
      expect(republished).toEqual([]);
    });
  }

  it('Nestor Cloud: publishes no anchor, so /clear offers nothing and /resume says so', async () => {
    // The negative control for the whole feature. This backend's
    // `getSessionId()` answers the HOST session id, and an arm built on that
    // accessor would have printed a command that cannot resume anything.
    const { agent, republished } = harness(c => new NestorCloudAgent(backendConfig('nestor-cloud-agent', c)) as unknown as BaseAgent);

    const cleared = infoMessages(await collectEvents(agent.chat('/clear'))).join('\n');
    const resumed = infoMessages(await collectEvents(agent.chat('/resume'))).join('\n');

    expect(cleared).toContain('Context cleared');
    expect(cleared).not.toContain('/resume');
    expect(resumed).toContain('no previous session to resume');
    expect(republished).toEqual([]);
  });
});
