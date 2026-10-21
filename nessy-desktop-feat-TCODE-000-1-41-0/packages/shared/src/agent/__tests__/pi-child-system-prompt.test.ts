/**
 * A spawned child's composed prompt — the subagent safety core, the host's
 * stable context seed, and the agent definition's own instructions — must reach
 * the model.
 *
 * Asserted at the DELIVERY boundary, not on the composition helper: the whole
 * defect was that the two were disconnected. `orchestrator/spawner.ts`
 * composed the prompt, the host forwarded it as `systemPromptPreset`, and
 * `getSystemPrompt` only ever tests that argument for `=== 'mini'` — so the
 * composed string was built and silently dropped. The boundary that matters is
 * the `{ type: 'prompt', systemPrompt }` RPC PiAgent hands to its subprocess,
 * where `applySystemPromptOverride` installs it.
 */
import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';
import { getAgentSafetyCore } from '../../prompts/system.ts';

const AGENT_DEFINITION_PROMPT = 'You are the scout. SENTINEL_SCOUT_INSTRUCTIONS';
const CONTEXT_SEED = 'Workspace root: /tmp/nessy-child-prompt. SENTINEL_CONTEXT_SEED';

/** Byte-for-byte what `orchestrator/spawner.ts:composeChildPrompt` produces. */
const COMPOSED_CHILD_PROMPT = [
  getAgentSafetyCore().trim(),
  CONTEXT_SEED,
  AGENT_DEFINITION_PROMPT,
].join('\n\n');

function createChildConfig(overrides: Partial<BackendConfig>): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-child-prompt',
      name: 'Child Prompt Workspace',
      rootPath: '/tmp/nessy-child-prompt',
      workspaceRootPath: '/tmp/nessy-child-prompt',
      sessionRootPath: '/tmp/nessy-child-prompt-sessions/ws-child-prompt',
    } as never,
    session: {
      id: 'child-session',
      workspaceRootPath: '/tmp/nessy-child-prompt',
      createdAt: 0,
      lastUsedAt: 0,
    } as never,
    isHeadless: true,
    ...overrides,
  } as BackendConfig;
}

/**
 * Drive one real turn and return the `systemPrompt` actually sent. Only the
 * subprocess, the automation bridge and the capability-runtime manifest are
 * stubbed — prompt composition itself runs for real.
 */
async function captureChildSystemPrompt(overrides: Partial<BackendConfig>): Promise<string> {
  const agent = new PiAgent(createChildConfig(overrides));
  const sent: Array<Record<string, unknown>> = [];
  const internals = agent as unknown as Record<string, never>;
  (internals as Record<string, unknown>).ensureSubprocess = async () => {};
  (internals as Record<string, unknown>).send = (message: Record<string, unknown>) => { sent.push(message); };
  (internals as Record<string, unknown>).emitAutomationEvent = async () => {};
  (internals as Record<string, unknown>).syncExecutionManifestForCurrentTurn = async () => ({
    snapshotGeneration: 'generation-1',
    manifestHash: 'hash-1',
    tools: [],
    deferredMcp: { candidatePiNames: [] },
  });
  const queue = (internals as Record<string, Record<string, unknown>>).eventQueue!;
  queue.reset = () => {};
  queue.drain = async function* () { yield { type: 'complete' }; };

  try {
    for await (const _event of (agent as unknown as {
      chatImpl(message: string): AsyncGenerator<unknown>
    }).chatImpl('do the task')) { /* drain */ }
  } finally {
    agent.destroy();
  }

  const prompt = sent.find(message => message.type === 'prompt');
  expect(prompt).toBeDefined();
  return prompt!.systemPrompt as string;
}

describe('child session system prompt delivery', () => {
  it('delivers the agent definition instructions, the safety core and the seed', async () => {
    const systemPrompt = await captureChildSystemPrompt({ childSystemPrompt: COMPOSED_CHILD_PROMPT });

    expect(systemPrompt).toContain('SENTINEL_SCOUT_INSTRUCTIONS');
    expect(systemPrompt).toContain('## Subagent Safety Core');
    // The one rule the child cannot get from the parent-shaped base prompt:
    // parent-agent instructions outrank tool-discovered content.
    expect(systemPrompt).toContain('user, developer, parent-agent, and trusted project instructions');
    expect(systemPrompt).toContain('SENTINEL_CONTEXT_SEED');
  });

  it('keeps the parent-shaped base prompt and the harness tool contract', async () => {
    const systemPrompt = await captureChildSystemPrompt({ childSystemPrompt: COMPOSED_CHILD_PROMPT });

    // Append, not replace — a child still needs the workspace/source/permission
    // sections it shares with its parent.
    expect(systemPrompt).toContain('## Safety and Engineering');
    expect(systemPrompt).toContain('You are Nessy Desktop');
  });

  it('leaves a session without a child prompt byte-identical', async () => {
    const plain = await captureChildSystemPrompt({});
    const alsoPlain = await captureChildSystemPrompt({ childSystemPrompt: '   ' });

    expect(alsoPlain).toBe(plain);
    expect(plain).not.toContain('## Subagent Safety Core');
  });

  it('still honours the mini preset, which is the only meaning of systemPromptPreset', async () => {
    const mini = await captureChildSystemPrompt({ systemPromptPreset: 'mini' });

    expect(mini).toContain('focused assistant for quick configuration edits');
    expect(mini).not.toContain('## Safety and Engineering');
  });
});
