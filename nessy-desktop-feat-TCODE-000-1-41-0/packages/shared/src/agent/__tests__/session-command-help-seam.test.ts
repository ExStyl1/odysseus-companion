/**
 * P3.158 · `/help` is answered at the seam, on every runtime, and never reaches
 * a model.
 *
 * The defect: `parseSessionCommand` had no `help` kind, so a typed `/help`
 * composed an ordinary turn — pinned capability block and all — and asked the
 * MODEL. On all four runtimes, which is why the per-runtime enumeration that
 * found it did not flag it: a check for divergence cannot see a gap that is the
 * same everywhere. On a fork of Claude Code the failure is a confident wrong
 * answer rather than a blank one, because the model describes the commands it
 * was trained on.
 *
 * Owner decision 2026-09-02: implement it host-side ONCE from our own command
 * table, with per-runtime unavailability marks.
 *
 * Same rig as `session-command-out-of-band-seam.test.ts` and for its reason:
 * the arm lives in `BaseAgent`, so a `TestAgent` double would pass by
 * construction. Each case instantiates the REAL backend class and replaces only
 * `chatImpl` with a recorder that throws, so a regression routing `/help` back
 * into a backend fails loudly instead of silently prompting a model.
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
import { SESSION_COMMAND_HELP_ENTRIES } from '../../slash-commands/help.ts';
import {
  collectEvents,
  createMockBackendConfig,
  createMockCapabilityTurnRuntime,
  createMockSession,
  createMockWorkspace,
} from './test-utils.ts';

const WORKSPACE_ID = 'ws-p3158-help-seam';

let sessionCounter = 0;

function backendConfig(provider: BackendConfig['provider']): BackendConfig {
  sessionCounter += 1;
  const root = mkdtempSync(join(tmpdir(), 'nessy-p3158-'));
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
      id: `session-p3158-${sessionCounter}`,
      workingDirectory: root,
    }),
  } as Partial<BackendConfig>);
}

/**
 * All four production backends, and the two capabilities each one declares —
 * transcribed from nothing: `expectedMarks` is DERIVED at test time from the
 * agent's own predicates, so this table cannot claim a runtime forks when it
 * does not. The point of listing the backends is coverage, not the values.
 */
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

describe('P3.158 · /help is answered by the host, identically on every runtime', () => {
  for (const backend of BACKENDS) {
    it(`${backend.name}: /help never reaches chatImpl and lists our own commands`, async () => {
      const { agent, reachedChatImpl } = harness(backend.make);

      const events = await collectEvents(agent.chat('/help'));
      const listing = infoMessages(events).join('\n');

      expect(reachedChatImpl).toEqual([]);
      expect(listing.length).toBeGreaterThan(0);
      // Every row of OUR table is in the answer — the whole claim of the row is
      // that the listing comes from the product's own commands and not from a
      // model's memory of a different product's.
      for (const entry of SESSION_COMMAND_HELP_ENTRIES) {
        expect(listing).toContain(entry.label);
      }
      expect(events.at(-1)?.type).toBe('complete');
    });

    it(`${backend.name}: the marks agree with the predicates the seam's own refusals read`, async () => {
      const { agent } = harness(backend.make);
      // Derived, never transcribed: whatever this runtime declares is what the
      // listing must say. A backend whose predicate changes moves both sides at
      // once, which is the property the row asked for.
      const canFork = (agent as unknown as { canForkConversation: () => boolean }).canForkConversation();
      const canCompact = (agent as unknown as { canCompactContext: () => boolean }).canCompactContext();

      const listing = infoMessages(await collectEvents(agent.chat('/help'))).join('\n');
      const markedRows = listing
        .split('\n')
        .filter(line => line.includes('unavailable on this runtime'))
        .map(line => line.trim().split(/\s+/)[0]);

      expect(markedRows.includes('/subtask')).toBe(!canFork);
      expect(markedRows.includes('/compact')).toBe(!canCompact);
    });
  }

  it('does not claim /help for prose that merely mentions it (positive control)', async () => {
    // Without this, the assertions above could be passing because the seam
    // swallows anything containing the word.
    const { agent, reachedChatImpl } = harness(BACKENDS[0]!.make);
    await collectEvents(agent.chat('what does /help do?')).catch(() => undefined);
    expect(reachedChatImpl.length).toBe(1);
  });
});
