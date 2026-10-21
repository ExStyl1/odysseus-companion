/**
 * C3.167 (QK6) — a plan-phase turn reasons at the operator's plan-mode level,
 * and execution returns to the session's own level.
 *
 * The two halves the row asks for are both here: the OVERRIDE is read inside
 * `chatImpl`, which is where a backend spends the level (Pi forwards
 * `set_thinking_level`, claude reads `_thinkingLevel` per turn), and the RESTORE
 * is read after `chat()` has returned, which is where `chat`'s outermost
 * `finally` has run.
 *
 * The rig is `TestAgent` driving the shared `chat()` template method rather than
 * a real `PiAgent`: the mechanism under test lives entirely in `BaseAgent`, and
 * importing `pi-agent.ts` here would spend a module graph measured in minutes to
 * read one boolean. The Pi half — that `appliesHostPlanModeEffort` is true there
 * and nowhere else — is asserted against the source text below, the same
 * instrument `config/__tests__/claude-simple-system-prompt.test.ts` uses.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent } from '@nessy-agent/core/types';
import { CapabilityMaterializationError } from '../../capabilities/materializer.ts';
import type { CapabilityTurnRuntime, ChatOptions } from '../backend/types.ts';
import { PLAN_MODE_EFFORT_ENV_VAR } from '../thinking-levels.ts';
import type { ThinkingLevel } from '../thinking-levels.ts';
import { TestAgent, createMockBackendConfig, collectEvents } from './test-utils.ts';

/**
 * A backend that needs the host to supply the plan-phase effort — Pi's answer,
 * and the only one that is `true` in the product.
 */
class HostPlanEffortAgent extends TestAgent {
  /** The level the backend would have spent, captured where a real one spends it. */
  public levelInsideTurn: ThinkingLevel | undefined;
  protected override get appliesHostPlanModeEffort(): boolean { return true; }
  protected override async *chatImpl(
    message: string,
    attachments?: unknown[],
    options?: ChatOptions,
  ): AsyncGenerator<AgentEvent> {
    this.levelInsideTurn = this.getThinkingLevel();
    yield* super.chatImpl(message, attachments, options);
  }
}

/** The same capture on a backend that has its own mechanism (codex) or none (claude). */
class NativePlanEffortAgent extends HostPlanEffortAgent {
  protected override get appliesHostPlanModeEffort(): boolean { return false; }
}

function setPlanModeEffort(value: string | undefined): void {
  // `delete` first, then assign: an assignment to a name Bun pre-created a slot
  // for stays invisible to `Object.keys`/spread, and the restore path has the
  // same defect. Cheap here and correct everywhere.
  delete process.env[PLAN_MODE_EFFORT_ENV_VAR];
  if (value !== undefined) process.env[PLAN_MODE_EFFORT_ENV_VAR] = value;
}

afterEach(() => { setPlanModeEffort(undefined); });

/**
 * The empty capability view every turn needs — `chat()` extracts skill
 * invocations before it reaches the effort seam, and refuses without one.
 */
function capabilityRuntime(): CapabilityTurnRuntime {
  return {
    view: {
      generation: 'test-generation',
      sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath(resource) {
        return 'absolutePath' in resource ? resource.absolutePath : '/test/plugin-resource';
      },
      async readText() { return ''; },
      resolveCredential() { throw new CapabilityMaterializationError('credential-not-ready'); },
    },
  };
}

function agentAt(level: ThinkingLevel, mode: 'plan' | 'default', native = false): HostPlanEffortAgent {
  const agent = native
    ? new NativePlanEffortAgent(createMockBackendConfig())
    : new HostPlanEffortAgent(createMockBackendConfig());
  agent.setCapabilityTurnRuntime(capabilityRuntime());
  agent.setThinkingLevel(level);
  agent.setPermissionMode(mode);
  return agent;
}

async function runTurn(agent: HostPlanEffortAgent): Promise<void> {
  await collectEvents(agent.chat('drive one turn'));
}

describe('C3.167 — the plan-phase effort on the runtime that has no mechanism of its own', () => {
  it('sends the plan-mode level on a plan-phase turn and the session level afterwards', async () => {
    const agent = agentAt('low', 'plan');
    setPlanModeEffort('max');

    await runTurn(agent);

    expect(agent.levelInsideTurn).toBe('max');
    // The session never moved: execution after the plan phase is the level the
    // user chose, not the level the plan phase used.
    expect(agent.getThinkingLevel()).toBe('low');
  });

  it('leaves a turn outside plan mode alone', async () => {
    const agent = agentAt('low', 'default');
    setPlanModeEffort('max');

    await runTurn(agent);

    expect(agent.levelInsideTurn).toBe('low');
    expect(agent.getThinkingLevel()).toBe('low');
  });

  it('leaves a runtime with its own plan-mode key untouched', async () => {
    // codex writes `plan_mode_reasoning_effort` from the SAME variable (P6.368),
    // so a host override there would set the level twice by two routes.
    const agent = agentAt('low', 'plan', true);
    setPlanModeEffort('max');

    await runTurn(agent);

    expect(agent.levelInsideTurn).toBe('low');
    expect(agent.getThinkingLevel()).toBe('low');
  });

  it('refuses a value that is not a level instead of defaulting', async () => {
    const agent = agentAt('low', 'plan');
    setPlanModeEffort('ultracode');

    await runTurn(agent);

    expect(agent.levelInsideTurn).toBe('low');
  });

  it('does nothing at all when the variable is unset', async () => {
    const agent = agentAt('low', 'plan');
    setPlanModeEffort(undefined);

    await runTurn(agent);

    expect(agent.levelInsideTurn).toBe('low');
  });
});

describe('C3.167 — which backends ask the host for it', () => {
  const read = (relative: string): string =>
    readFileSync(join(import.meta.dir, '..', relative), 'utf8');

  it('is Pi, and Pi alone', () => {
    expect(read('pi-agent.ts')).toContain(
      'protected override get appliesHostPlanModeEffort(): boolean { return true; }',
    );
    // The positive control for the same read: codex's own key IS written, so the
    // capability is present there by a different route and must not be doubled.
    expect(read('codex-agent.ts')).toContain('planModeThinkingLevel');
    expect(read('codex-agent.ts')).not.toContain('appliesHostPlanModeEffort');
    expect(read('claude-agent.ts')).not.toContain('appliesHostPlanModeEffort');
  });
});
