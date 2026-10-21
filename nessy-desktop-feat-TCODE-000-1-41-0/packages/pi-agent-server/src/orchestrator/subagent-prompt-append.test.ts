/**
 * P6.314 (H34), the Pi arm — one operator knob appends text to every subagent's
 * system prompt.
 *
 * NATIVE-FIRST, measured before anything was built. No runtime offers a single
 * append-to-all knob: the vendored 2.1.247 binary has the CLI flag
 * `--append-subagent-system-prompt` — re-measured 2026-09-12 (C3.252) with the
 * instrument named on both sides, because on a minified artefact they disagree
 * (C3.294): 5 lines (`grep -acF`) / 6 occurrences (`grep -aoF … | wc -l`),
 * positive control `ultracode` 43/156, negative control `nessyNotARealSdkKey`
 * 0/0. (The superseded reading was "7 occurrences, control `ultracode` -> 135"
 * at `2.1.233`.) There is still NO environment spelling for it — re-measured on
 * the same bundle, `CLAUDE_CODE_APPEND_SUBAGENT_SYSTEM_PROMPT` and
 * `APPEND_SUBAGENT_SYSTEM_PROMPT` both 0 lines / 0 occurrences, against the
 * flag's own internal identifier `appendSubagentSystemPrompt` at 15/51 as the
 * positive control that proves the probe reads the
 * file; codex's `MultiAgentV2ConfigToml.subagent_developer_instructions`
 * belongs to a V2 surface this build does not enable; Pi has nothing, because
 * subagent prompts are composed by our own spawner. So the host is the seam —
 * step 2 — and the variable name is ours, the same position `NESSY_PLAN_MODE_EFFORT`
 * was in for the same reason.
 *
 * The assertions read `PiChildStartInput.restrictions.prompt` as it reaches the
 * port, not the composer's return value: a knob that composes correctly and is
 * then dropped on the way to the child is precisely the defect class this plan
 * keeps finding.
 */
import { afterEach, describe, expect, it } from 'bun:test'

import type { PiChildSessionPort, PiChildStartInput } from '../../../shared/src/agent/pi-harness/child-session-port.ts'
import type { AgentDefinition } from '../../../shared/src/agents/index.ts'
import { FORK_AGENT_DEFINITION } from '../../../shared/src/agents/index.ts'
import { configureSpawner, spawnChildSession } from './spawner.ts'
import { SUBAGENT_PROMPT_APPEND_ENV_VAR } from '../../../shared/src/config/subagent-prompt-append.ts'

const worker: AgentDefinition = {
  name: 'worker', description: 'Worker', systemPrompt: 'Worker prompt', toolset: 'full',
  tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'], tier: 'big',
}

/**
 * `delete` FIRST, then assign — AGENTS.md's measured Bun trap. Unconditional
 * rather than gated on a name list, because that list cannot be complete and an
 * operator's variable is arbitrary by definition.
 */
function setEnv(value: string | undefined): void {
  delete process.env[SUBAGENT_PROMPT_APPEND_ENV_VAR]
  if (value !== undefined) process.env[SUBAGENT_PROMPT_APPEND_ENV_VAR] = value
}

const saved = process.env[SUBAGENT_PROMPT_APPEND_ENV_VAR]
afterEach(() => { setEnv(saved) })

function capturingPort(captured: PiChildStartInput[]): PiChildSessionPort {
  return {
    start: async input => {
      captured.push(structuredClone(input))
      return { agentId: input.requestedAgentId ?? 'child', status: 'completed', output: '', result: '' }
    },
    resume: async agentId => ({ agentId, status: 'completed', output: '' }),
    steer: async () => {}, getResult: async agentId => ({ agentId, status: 'completed', output: '' }),
    stop: async () => {}, stopTask: async () => {}, sealOwnerTask: async () => {},
    searchOutput: async agentId => ({ agentId, cursor: 0, status: 'completed', results: [] }),
    attach: async agentId => ({ agentId, cursor: 0, output: '', status: 'completed' }),
    monitor: async agentId => ({ agentId, status: 'completed', output: '', result: '' }),
  }
}

async function promptFor(agentDef: AgentDefinition): Promise<string> {
  const captured: PiChildStartInput[] = []
  configureSpawner({
    childSessionPort: capturingPort(captured),
    modelId: 'default-model',
    retryBaseDelayMs: () => 0,
    sessionToolNames: ['read', 'bash'],
  })
  await spawnChildSession({ agentDef, task: 'work', cwd: '/tmp', background: false })
  expect(captured.length).toBe(1)
  return captured[0]!.restrictions.prompt
}

describe('P6.314 the operator append on a Pi subagent prompt', () => {
  it('appends the operator text to a named subagent, after the agent’s own prompt', async () => {
    setEnv('House rule: never rewrite history.')
    const prompt = await promptFor(worker)

    expect(prompt).toContain('House rule: never rewrite history.')
    // AFTER, because "append" is the contract the claude flag's own name states:
    // the operator's sentence is the most recent instruction the child reads.
    expect(prompt.indexOf('Worker prompt')).toBeLessThan(prompt.indexOf('House rule'))
  })

  /**
   * THE CONTROL, and it is what makes every absence below mean anything: with
   * the knob unset the composed prompt is unchanged, and the two parts that were
   * always there are still there.
   */
  it('changes nothing when the operator set nothing', async () => {
    setEnv(undefined)
    const prompt = await promptFor(worker)

    expect(prompt).toContain('Worker prompt')
    expect(prompt).not.toContain('House rule')
    expect(prompt.length).toBeGreaterThan(0)
  })

  it('reads an exported-but-blank value as unset, the rule every explicit-only reader follows', async () => {
    setEnv('   \n  ')
    const before = await promptFor(worker)
    setEnv(undefined)
    const unset = await promptFor(worker)

    expect(before).toBe(unset)
  })

  /**
   * The safety core is not displaced, and that is not decoration: an operator
   * append that landed first would put arbitrary prose ahead of the one block
   * this host composes for every child.
   */
  it('never displaces the safety core, which stays first', async () => {
    setEnv('House rule: never rewrite history.')
    const prompt = await promptFor(worker)

    expect(prompt.indexOf('House rule')).toBeGreaterThan(0)
    expect(prompt.startsWith('House rule')).toBe(false)
  })

  /**
   * THE FORK CARVE-OUT, which `done_means` names by hand: `sub-agents.md`
   * requires a fork's system prompt to be "Same as main session", so a fork
   * reuses the parent's conversation prompt and must not receive the append a
   * second time. Here it receives it zero times, by construction —
   * `composeForkRestrictions` returns `prompt: ''` and never reaches the
   * composer — which is the same answer the page's carve-out gives: a fork is
   * the conversation continuing, not a subagent being briefed.
   */
  it('leaves a fork’s empty prompt empty, so the append cannot arrive twice', async () => {
    setEnv('House rule: never rewrite history.')
    const prompt = await promptFor(FORK_AGENT_DEFINITION)

    expect(prompt).toBe('')
  })
})
