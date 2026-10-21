/**
 * P6.636 · `/config` is answered at the seam, on every runtime, and never
 * reaches a model.
 *
 * The defect: P6.410 built the classifier kind (`ParsedConfigCommand`) and the
 * command itself (`runSessionConfigCommand`), and the kind's own docblock says
 * it is "Answered at the `BaseAgent.chat` seam like `/help`, `/quota` and
 * `/advisor`". The arm was never written. Measured 2026-09-07,
 * `git grep -an runSessionConfigCommand -- packages apps` returned only its own
 * test and its definition — zero production callers — so a typed `/config` fell
 * through to `chatImpl` and reached the MODEL as prose, on all four backends.
 * Same shape as P3.158's `/help`, and invisible for the same reason: a check
 * for divergence cannot see a gap that is identical everywhere.
 *
 * Same rig as `session-command-help-seam.test.ts` and for its reason: the arm
 * lives in `BaseAgent`, so a `TestAgent` double would pass by construction.
 * Each case instantiates the REAL backend class and replaces only `chatImpl`
 * with a recorder that throws, so a regression routing `/config` back into a
 * backend fails loudly instead of silently prompting a model.
 *
 * The bare form is the one driven here: it READS the settings store and writes
 * nothing, so the assertion is about the seam rather than about storage layout.
 * The write path has its own coverage over a substitute table in
 * `slash-commands/config-command.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig } from '../backend/types.ts';
import { ClaudeAgent } from '../claude-agent.ts';
import { CodexAgent } from '../codex-agent.ts';
import { NestorCloudAgent } from '../nestor-cloud-agent.ts';
import { PiAgent } from '../pi-agent.ts';
import type { BaseAgent } from '../base-agent.ts';
import { SESSION_CONFIG_KEYS } from '../../slash-commands/config-command.ts';
import {
  collectEvents,
  createMockBackendConfig,
  createMockCapabilityTurnRuntime,
  createMockSession,
  createMockWorkspace,
} from './test-utils.ts';

const WORKSPACE_ID = 'ws-p6636-config-seam';

let sessionCounter = 0;

function backendConfig(provider: BackendConfig['provider']): BackendConfig {
  sessionCounter += 1;
  const root = mkdtempSync(join(tmpdir(), 'nessy-p6636-'));
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
      id: `session-p6636-${sessionCounter}`,
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

describe('P6.636 · /config is answered by the host, identically on every runtime', () => {
  for (const backend of BACKENDS) {
    it(`${backend.name}: /config never reaches chatImpl and lists the reachable keys`, async () => {
      const { agent, reachedChatImpl } = harness(backend.make);

      const events = await collectEvents(agent.chat('/config'));
      const listing = infoMessages(events).join('\n');

      expect(reachedChatImpl).toEqual([]);
      // Derived from the allowlist itself, never transcribed: a key added or
      // removed there moves this assertion with it.
      for (const entry of SESSION_CONFIG_KEYS) {
        expect(listing).toContain(entry.key);
      }
      expect(events.at(-1)?.type).toBe('complete');
    });
  }

  it('answers an unknown key at the seam rather than handing it to the model (boundary)', async () => {
    const { agent, reachedChatImpl } = harness(BACKENDS[0]!.make);

    const listing = infoMessages(await collectEvents(agent.chat('/config sandbox'))).join('\n');

    expect(reachedChatImpl).toEqual([]);
    expect(listing).toContain('is not reachable from the prompt');
  });

  it('does not claim /config for prose that merely mentions it (positive control)', async () => {
    // Without this, the assertions above could be passing because the seam
    // swallows anything containing the word.
    const { agent, reachedChatImpl } = harness(BACKENDS[0]!.make);
    await collectEvents(agent.chat('what does /config do?')).catch(() => undefined);
    expect(reachedChatImpl.length).toBe(1);
  });
});
