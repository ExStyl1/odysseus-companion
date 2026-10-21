/**
 * L3 — the pinned capability block is sent once per generation, not per turn.
 *
 * Measured on the real gateway before this change: with a 3736-token session
 * memory, `conversation_messages` grew by 4331 tokens on EVERY turn (4325 →
 * 8656 → 12987 → 17318) while the assistant produced ~40 tokens per turn; with
 * no memory the same sessions grew ~750/turn. The block was re-composed into
 * every user message instead of being sent once and read from cache.
 *
 * `prompt-caching.md:28` — "| Project context | CLAUDE.md, auto memory,
 * unscoped rules | Session starts, or after `/clear` or `/compact` |".
 *
 * `context-window.md:1591`-`:1592` on what a compaction does to it —
 * "| Project-root CLAUDE.md and unscoped rules | Re-injected from disk |",
 * "| Auto memory | Re-injected from disk |".
 *
 * The token assertions below use the SAME estimator the live number comes from:
 * `context-categories.ts:170` sums `estimateTokens(messageText(message))` over
 * the conversation, and `estimateTokens` is `ceil(length / 4)`
 * (`utils/large-response.ts:77`). So "tokens" here is the production metric on
 * the production composition path, not a proxy for it.
 */

import { CapabilityMaterializationError } from '../../capabilities/materializer.ts';
import { beforeEach, expect, test } from 'bun:test';
import type { CapabilityTurnRuntime } from '../backend/types.ts';
import type { NativeResourceRef } from '../../capabilities/resolver.ts';
import { estimateTokens } from '../../utils/large-response.ts';
import { TestAgent, collectEvents, createMockBackendConfig } from './test-utils.ts';

/** A session memory of the size the defect was measured with (3736 tokens). */
const MEMORY_BODY = Array.from({ length: 598 }, () => 'Remembered project fact.').join(' ');
/** What the assistant produced per turn in the measured run, in tokens. */
const ASSISTANT_TOKENS_PER_TURN = 40;

function memoryResource(): NativeResourceRef {
  return {
    source: 'project',
    scope: { kind: 'project', workspaceId: 'ws' },
    resourceId: 'MEMORY.md',
    absolutePath: '/p/.agents/MEMORY.md',
    revision: '1',
    contentHash: 'd'.repeat(64),
  };
}

/** One capability turn carrying a single memory layer with the given body. */
function runtimeWithMemory(generation: string, body: string): CapabilityTurnRuntime {
  return {
    provider: 'pi',
    view: {
      generation,
      sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [],
      memory: [{ key: 'memory::project::ws::MEMORY.md', resource: memoryResource(), readOnly: false }],
      permissionLayers: [], commands: [], promptCommands: [], apps: [], lspServers: [], monitors: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath(resource: unknown) { return (resource as NativeResourceRef).absolutePath; },
      async readText() { return body; },
      resolveCredential() { throw new CapabilityMaterializationError('credential-not-ready'); },
    },
  } as CapabilityTurnRuntime;
}

/** A backend that confirms delivery, the way `PiAgent` does at `send({type:'prompt'})`. */
function deliveringAgent(): TestAgent {
  const agent = new TestAgent(createMockBackendConfig());
  agent.confirmsPinnedCapabilityDelivery = true;
  return agent;
}

/**
 * `conversation_messages` growth per turn, in the production metric: every
 * composed user message plus the assistant reply the measured run produced.
 */
function perTurnGrowth(agent: TestAgent): number[] {
  return agent.chatCalls.map(call => estimateTokens(call.message) + ASSISTANT_TOKENS_PER_TURN);
}

let agent: TestAgent;
beforeEach(() => { agent = deliveringAgent(); });

test('the memory body is sent on the first turn and not again within one generation', async () => {
  agent.setCapabilityTurnRuntime(runtimeWithMemory('gen-1', MEMORY_BODY));

  await collectEvents(agent.chat('one'));
  await collectEvents(agent.chat('two'));
  await collectEvents(agent.chat('three'));

  expect(agent.chatCalls[0]!.message).toContain(MEMORY_BODY);
  expect(agent.chatCalls[1]!.message).not.toContain(MEMORY_BODY);
  expect(agent.chatCalls[2]!.message).not.toContain(MEMORY_BODY);
});

test('per-turn growth falls to the no-memory baseline after the first turn', async () => {
  // The gate: the measured defect was 4331 tokens of growth on EVERY turn
  // against ~750 with no memory. The first turn still pays for the memory —
  // that is the point, it is paid ONCE — and every turn after it must sit at
  // the baseline.
  agent.setCapabilityTurnRuntime(runtimeWithMemory('gen-1', MEMORY_BODY));
  for (const prompt of ['one', 'two', 'three', 'four']) await collectEvents(agent.chat(prompt));

  const growth = perTurnGrowth(agent);
  expect(growth[0]).toBeGreaterThan(3736);
  for (const later of growth.slice(1)) expect(later).toBeLessThan(750);
});

test('a memory edit still reaches the model on the NEXT turn, on content', async () => {
  // The property we are better at than upstream, which waits for `/clear`,
  // `/compact` or a restart (`prompt-caching.md:28`). Asserted on CONTENT with
  // a codeword, never on a token count.
  const codeword = 'HALCYON-PARSNIP-4417';
  agent.setCapabilityTurnRuntime(runtimeWithMemory('gen-1', MEMORY_BODY));
  await collectEvents(agent.chat('one'));
  await collectEvents(agent.chat('two'));

  // A `remember` call rewrites the file, which changes its `contentHash`, which
  // `computeGeneration` hashes (`capabilities/resolver.ts`).
  agent.setCapabilityTurnRuntime(runtimeWithMemory('gen-2', `${MEMORY_BODY}\n${codeword}`));
  await collectEvents(agent.chat('three'));

  expect(agent.chatCalls[1]!.message).not.toContain(codeword);
  expect(agent.chatCalls[2]!.message).toContain(codeword);
  // And the freshened block is not then repeated either.
  await collectEvents(agent.chat('four'));
  expect(agent.chatCalls[3]!.message).not.toContain(codeword);
});

test('a compaction re-injects the block from disk', async () => {
  agent.setCapabilityTurnRuntime(runtimeWithMemory('gen-1', MEMORY_BODY));
  await collectEvents(agent.chat('one'));
  await collectEvents(agent.chat('two'));
  expect(agent.chatCalls[1]!.message).not.toContain(MEMORY_BODY);

  agent.resetPrerequisiteState();
  await collectEvents(agent.chat('after the compaction'));

  expect(agent.chatCalls[2]!.message).toContain(MEMORY_BODY);
  // Once, not from then on.
  await collectEvents(agent.chat('and again'));
  expect(agent.chatCalls[3]!.message).not.toContain(MEMORY_BODY);
});

test('clearing the history re-injects the block', async () => {
  agent.setCapabilityTurnRuntime(runtimeWithMemory('gen-1', MEMORY_BODY));
  await collectEvents(agent.chat('one'));
  await collectEvents(agent.chat('two'));

  await agent.clearHistory();
  await collectEvents(agent.chat('after the clear'));

  expect(agent.chatCalls[2]!.message).toContain(MEMORY_BODY);
});

test('a backend that never confirms delivery keeps sending the block every turn', async () => {
  // Fail-open. Under-sending silently drops the user's instructions for the rest
  // of the generation; over-sending only costs tokens. A backend that has not
  // opted in — and any turn that dies between composition and the send — keeps
  // the previous behaviour.
  const unconfirmed = new TestAgent(createMockBackendConfig());
  unconfirmed.setCapabilityTurnRuntime(runtimeWithMemory('gen-1', MEMORY_BODY));

  await collectEvents(unconfirmed.chat('one'));
  await collectEvents(unconfirmed.chat('two'));

  expect(unconfirmed.chatCalls[1]!.message).toContain(MEMORY_BODY);
});

test('a turn that dies before the send leaves the block owed to the next turn', async () => {
  // Modelled the way it happens in production: `chatImpl` is entered, so the
  // block was composed and suppressed-or-sent, but the message never reaches
  // the model (a blocked `UserPromptSubmit` hook, a failed spawn, a pre-model
  // abort), so nothing confirms delivery.
  agent.confirmsPinnedCapabilityDelivery = false;
  agent.setCapabilityTurnRuntime(runtimeWithMemory('gen-1', MEMORY_BODY));
  await collectEvents(agent.chat('the turn that never reached the model'));

  agent.confirmsPinnedCapabilityDelivery = true;
  await collectEvents(agent.chat('the turn that did'));

  expect(agent.chatCalls[1]!.message).toContain(MEMORY_BODY);
});

test('the permission layers are still re-published on a suppressed turn', async () => {
  // The builder's side effect must not be suppressed with its text: the pinned
  // permission handoff is republished on EVERY turn, cache hit or miss.
  agent.setCapabilityTurnRuntime(runtimeWithMemory('gen-pinned', MEMORY_BODY));
  await collectEvents(agent.chat('one'));
  agent.getPermissionManager().clearCapabilityPermissionLayers();

  await collectEvents(agent.chat('two'));

  expect(agent.chatCalls[1]!.message).not.toContain(MEMORY_BODY);
  expect(agent.getPermissionManager().getCapabilityPermissionsContext()).toMatchObject({
    pinnedRevision: 'gen-pinned',
  });
});
