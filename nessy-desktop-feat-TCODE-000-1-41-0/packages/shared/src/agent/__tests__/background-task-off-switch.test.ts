/**
 * R10 off switch: `NESSY_DISABLE_BACKGROUND_TASKS=1` switches off ALL
 * background-task functionality (`env-vars.md`
 * `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`). Four surfaces, one predicate:
 *
 * 1. Bash timeout auto-background — `resolveBashTimeoutBehavior` ('the disable
 *    switch forces the kill path', background-task-settings.test.ts).
 * 2. MCP auto-background — `mcpAutoBackgroundDelayMs` ('the disable switch
 *    turns it off regardless of the threshold', background-task-settings.test.ts).
 * 3. `run_in_background` — rejected with a clear result
 *    ('run_in_background is rejected when background tasks are disabled',
 *    bash-backgrounded-result.test.ts).
 * 4. The `bash_background` tool — removed from the SIGNED manifest through the
 *    production filter (asserted HERE; the R4 `disableWorkflows` precedent:
 *    removal must happen on the manifest, not in the subprocess, because
 *    `validateDefinitions` aborts a session whose manifest advertises a tool
 *    with no runtime definition).
 */
import { describe, expect, it } from 'bun:test'

import type { EffectiveCapabilitySnapshot } from '../../capabilities/resolver.ts'
import type { AgentRuntimeView } from '../../capabilities/views.ts'
import { backgroundTasksDisabled } from '../../config/background-task-settings.ts'
import {
  createPiExecutionManifestSeed,
  finalizePiExecutionManifest,
} from '../pi-harness/harness-manifest.ts'

const view: AgentRuntimeView = {
  generation: 'generation-background-off-switch',
  sources: [],
  skills: [],
  mcpServers: [],
  hooks: [],
  automations: [],
  agents: [],
  promptLayers: [],
  memory: [],
  permissionLayers: [],
  commands: [],
  promptCommands: [],
  apps: [],
}

const snapshot = {
  context: {
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    projectTrustState: 'none',
    projectTrustRevision: '',
  },
  generation: view.generation,
  leaseId: 'lease-background-off-switch',
  entries: [],
  installedPlugins: [],
  diagnostics: [],
} as EffectiveCapabilitySnapshot

function manifest(options: { disableBackgroundTasks?: boolean } = {}) {
  return finalizePiExecutionManifest(
    createPiExecutionManifestSeed({
      snapshot,
      view,
      sessionKey: { workspaceId: 'workspace-1', sessionId: 'session-1' },
    }),
    [],
    options,
  )
}

describe('NESSY_DISABLE_BACKGROUND_TASKS removes bash_background from the signed manifest', () => {
  it('advertises bash_background by default', () => {
    expect(manifest().tools.map(tool => tool.binding.piName)).toContain('bash_background')
  })

  it('drops it, and only it, when the off switch is on', () => {
    const off = manifest({ disableBackgroundTasks: true })
    expect(off.tools.map(tool => tool.binding.piName)).not.toContain('bash_background')
    // The shell tool itself survives — this kills background tasks, not bash.
    expect(off.tools.map(tool => tool.binding.piName)).toContain('bash')
    expect(off.manifestHash).not.toBe(manifest().manifestHash)
  })

  it('composes with the env predicate the host consults', () => {
    const withEnv = (env: Record<string, string>) => manifest(
      backgroundTasksDisabled(env) ? { disableBackgroundTasks: true } : {},
    )
    expect(withEnv({ NESSY_DISABLE_BACKGROUND_TASKS: '1' }).tools.map(tool => tool.binding.piName))
      .not.toContain('bash_background')
    expect(withEnv({}).tools.map(tool => tool.binding.piName)).toContain('bash_background')
  })
})
