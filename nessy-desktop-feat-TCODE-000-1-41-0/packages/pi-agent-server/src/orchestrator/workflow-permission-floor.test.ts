import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentDefinition } from '../../../shared/src/agents/index.ts'
import type { PermissionMode } from '../../../shared/src/agent/mode-types.ts'
import { clampPermissionModeToParent, PERMISSION_MODE_ORDER } from '../../../shared/src/agent/mode-types.ts'
import type { PiChildSessionPort, PiChildStartInput } from '../../../shared/src/agent/pi-harness/child-session-port.ts'
import { configureSpawner } from './spawner.ts'
import { createWorkflowTool } from './workflow-tool.ts'

/**
 * `workflows.md:179` (§ *Approve the plan before it runs*), whole line verbatim:
 * "Your permission mode controls only the launch prompt above. The subagents the
 * workflow spawns always run in `acceptEdits` mode and inherit your [tool
 * allowlist](/docs/en/settings#permission-settings), regardless of your
 * session's mode. File edits are auto-approved."
 *
 * The paragraph is bounded by its two neighbours: `:181` keeps shell commands,
 * web fetches and non-allowlisted MCP tools prompting mid-run, and `:183` scopes
 * the whole thing away from `claude -p` and the Agent SDK. So the sentence is an
 * edits-only FLOOR, not a blanket elevation.
 *
 * This file measures both directions of that seam from the pi-agent-server side:
 *   - the CEILING, which is a security boundary and must hold: a workflow child
 *     can never end up broader than the session that launched it;
 *   - the FLOOR, which is finding f094 and is not built. The fix seam is
 *     `SessionManager.startPiChildRuntime` (server-core), outside this unit's
 *     zone, so what is pinned here is the orchestrator-side half the host fix
 *     will key off: a workflow stage sends NO `permissionMode` of its own, and
 *     its `ownerTaskId` carries the `owner-workflow-` prefix that is the only
 *     workflow signal reaching the host.
 */

const EDITOR: AgentDefinition = {
  name: 'editor',
  description: 'Editor',
  systemPrompt: 'Editor prompt',
  toolset: 'full',
  tools: ['read', 'edit', 'write'],
  tier: 'big',
}

function port(start: (input: PiChildStartInput) => Promise<any>): PiChildSessionPort {
  return {
    start,
    resume: async agentId => ({ agentId, status: 'completed', output: '' }),
    steer: async () => {},
    getResult: async agentId => ({ agentId, status: 'completed', output: '' }),
    stop: async () => {},
    stopTask: async () => {},
    sealOwnerTask: async () => {},
    searchOutput: async agentId => ({ agentId, cursor: 0, status: 'completed', results: [] }),
    attach: async agentId => ({ agentId, cursor: 0, output: '', status: 'completed' }),
    monitor: async agentId => ({ agentId, status: 'completed', output: 'ok', result: 'ok' }),
  }
}

/**
 * One workflow stage, driven through the REAL tool and the REAL
 * `spawnChildSession` — `createWorkflowTool` is given no `spawn` override, so
 * the agent resolution, the restriction build and the `limitScope: 'workflow'`
 * accounting all run. Only the child-session PORT is a stub, which is the
 * process boundary: past it the request is the host's to interpret.
 *
 * `makeRunId` is deliberately NOT supplied, so the run id — and therefore the
 * `owner-workflow-` prefix asserted below — is the production generator's.
 */
async function runWorkflowStage(agentDef: AgentDefinition): Promise<PiChildStartInput> {
  const captured: PiChildStartInput[] = []
  configureSpawner({
    childSessionPort: port(async input => {
      captured.push(structuredClone(input))
      return { agentId: input.requestedAgentId!, status: 'completed', output: 'ok', result: 'ok' }
    }),
    modelId: 'default-model',
    retryBaseDelayMs: () => 0,
  })

  const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-permission-floor-'))
  try {
    const tool = createWorkflowTool({
      getCwd: () => sessionPath,
      getSessionPath: () => sessionPath,
      getRuntimeAgentDefinitions: () => [agentDef],
    })
    const output = await tool.execute('call', {
      script: `return agent({ agent: '${agentDef.name}', task: 'rewrite src/index.ts' });`,
    }, new AbortController().signal, undefined, {} as never)
    expect(output.details?.result?.status).toBe('done')
  } finally {
    rmSync(sessionPath, { recursive: true, force: true })
  }

  expect(captured).toHaveLength(1)
  return captured[0]!
}

/**
 * The host's decision, restated from `SessionManager.startPiChildRuntime`
 * (packages/server-core/src/sessions/SessionManager.ts:11050-11056):
 *
 *   const parentPermissionMode = this.normalizePiPermissionMode(parent.permissionMode ?? 'default')
 *   const childPermissionMode = record.restrictions.permissionMode
 *     ? this.normalizePiPermissionMode(clampPermissionModeToParent(
 *         this.normalizePiPermissionMode(record.restrictions.permissionMode),
 *         parentPermissionMode,
 *       ))
 *     : parentPermissionMode
 *
 * `clampPermissionModeToParent` is the REAL imported function — the rule itself
 * is never reimplemented here, only the `if` around it, because SessionManager
 * is out of this unit's zone. A canonical mode needs no normalization pass, so
 * every value below is written in the canonical vocabulary.
 */
function hostChildPermissionMode(
  restrictions: { permissionMode?: PermissionMode },
  parentPermissionMode: PermissionMode,
): PermissionMode {
  return restrictions.permissionMode
    ? clampPermissionModeToParent(restrictions.permissionMode, parentPermissionMode)
    : parentPermissionMode
}

const ALL_MODES: PermissionMode[] = [...PERMISSION_MODE_ORDER]

describe('workflow child permission mode', () => {
  /**
   * THE SECURITY BOUNDARY. A workflow stage may name any agent definition,
   * including one whose frontmatter asks for `bypassPermissions`; the request is
   * forwarded verbatim by the spawner (`spawner.ts:682` — "the spawner only
   * forwards the agent-def's request") and narrowed host-side. A wrong position
   * in `PERMISSION_MODE_ORDER` would make that narrowing a widening silently, so
   * the assertion is on the RANK, not on a handful of hand-picked pairs.
   *
   * Four real spawns, one per requested mode, each evaluated against all seven
   * parent modes: the restrictions the orchestrator emits do not depend on the
   * parent's mode — the parent's mode lives host-side — so re-spawning per pair
   * would measure the same request 28 times.
   */
  it('never resolves a workflow child broader than the session that launched it', async () => {
    const requested: PermissionMode[] = ['acceptEdits', 'auto', 'bypassPermissions', 'default']

    for (const mode of requested) {
      const start = await runWorkflowStage({ ...EDITOR, permissionMode: mode })
      expect(start.restrictions.permissionMode).toBe(mode)

      for (const parent of ALL_MODES) {
        const child = hostChildPermissionMode(start.restrictions, parent)
        expect(
          PERMISSION_MODE_ORDER.indexOf(child),
          `workflow child asked for ${mode} under a ${parent} parent and resolved to ${child}`,
        ).toBeLessThanOrEqual(PERMISSION_MODE_ORDER.indexOf(parent))
      }
    }
  })

  /**
   * The same boundary spelled out on the pairs that state what a child cannot
   * do, so a regression names the behaviour rather than an index.
   */
  it('refuses the concrete escalations a workflow stage could ask for', async () => {
    const bypassing = await runWorkflowStage({ ...EDITOR, permissionMode: 'bypassPermissions' })

    // A default-mode session's workflow child cannot skip prompting.
    expect(hostChildPermissionMode(bypassing.restrictions, 'default')).toBe('default')
    // A plan-mode session's workflow child cannot acquire write capability.
    expect(hostChildPermissionMode(bypassing.restrictions, 'plan')).toBe('plan')
    // A dontAsk session's workflow child cannot acquire the ability to prompt.
    expect(hostChildPermissionMode(bypassing.restrictions, 'dontAsk')).toBe('dontAsk')
    // An acceptEdits session's workflow child cannot reach auto or bypass.
    expect(hostChildPermissionMode(bypassing.restrictions, 'acceptEdits')).toBe('acceptEdits')

    // A stricter request is honoured as-is — narrowing is never blocked.
    const planning = await runWorkflowStage({ ...EDITOR, permissionMode: 'plan' })
    expect(hostChildPermissionMode(planning.restrictions, 'auto')).toBe('plan')
  })

  /**
   * FINDING f094, pinned as the orchestrator-side half.
   *
   * A workflow stage sends no `permissionMode`, which the host reads as "inherit
   * the parent's mode verbatim" — so a `default`-mode session's workflow
   * children run in `default` and every file edit raises its own approval modal,
   * where `workflows.md:179` says they "always run in `acceptEdits` mode".
   *
   * The floor cannot be built here. The spawner's request is clamped NARROW-ONLY
   * host-side, so asking for `acceptEdits` from a `default` parent yields
   * `default` — asserted below with the real clamp, which is why sending the
   * request from this package would be inert rather than a fix. The floor has to
   * be raised at `SessionManager.startPiChildRuntime`, keyed off the
   * `owner-workflow-` prefix this test pins.
   */
  it('sends no permission mode of its own and tags the run with the owner-workflow prefix', async () => {
    const start = await runWorkflowStage(EDITOR)

    expect(start.restrictions).not.toHaveProperty('permissionMode')
    expect(hostChildPermissionMode(start.restrictions, 'default')).toBe('default')
    expect(hostChildPermissionMode(start.restrictions, 'acceptEdits')).toBe('acceptEdits')

    // The only workflow signal that reaches the host today, and the one a
    // future floor must key off. `SessionManager.ts:2257` already parses it.
    expect(start.ownerTaskId).toMatch(/^owner-workflow-/)

    // Why the floor cannot be requested from this side: even an explicit
    // `acceptEdits` request is clamped back down to a `default` parent.
    expect(clampPermissionModeToParent('acceptEdits', 'default')).toBe('default')
  })
})
