/**
 * Workflow governance across the three host-owned surfaces the dials touch:
 * the signed Pi execution manifest (the hard off switch), the prompt seam (the
 * size guideline, which is advice), and the managed-policy tier (the key an
 * organization actually sets — `workflows.md`: "To turn workflows off for your
 * whole organization, set `"disableWorkflows": true` in managed settings").
 *
 * The manifest assertion is the one that matters: `validateDefinitions`
 * (`pi-agent-server/src/harness/tool-manifest.ts`) throws when a manifest tool
 * has no runtime definition, so the off switch has to remove the tool HERE, in
 * the host, not inside the Pi subprocess.
 */
import { describe, expect, it } from 'bun:test'

import type { EffectiveCapabilitySnapshot } from '../../capabilities/resolver.ts'
import type { AgentRuntimeView } from '../../capabilities/views.ts'
import {
  createPiExecutionManifestSeed,
  finalizePiExecutionManifest,
} from '../pi-harness/harness-manifest.ts'
import { parseManagedPiPolicyV1 } from '../pi-harness/managed-policy.ts'
import { createMockBackendConfig, TestAgent } from './test-utils.ts'

const view: AgentRuntimeView = {
  generation: 'generation-workflow-governance',
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
  leaseId: 'lease-workflow-governance',
  entries: [],
  installedPlugins: [],
  diagnostics: [],
} as EffectiveCapabilitySnapshot

function manifest(options: { disableWorkflows?: boolean } = {}) {
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

describe('disableWorkflows removes the workflow tool from the signed manifest', () => {
  it('advertises the workflow tool by default', () => {
    expect(manifest().tools.map(tool => tool.binding.piName)).toContain('workflow')
  })

  it('drops it, and only it, when the off switch is on', () => {
    const off = manifest({ disableWorkflows: true })
    expect(off.tools.map(tool => tool.binding.piName)).not.toContain('workflow')
    // Every other orchestration tool survives — this is a workflow switch, not
    // a subagent switch.
    expect(off.tools.map(tool => tool.binding.piName)).toContain('subagent')
    expect(off.manifestHash).not.toBe(manifest().manifestHash)
  })
})

describe('the size guideline reaches the model as stable prompt advice', () => {
  it('emits nothing at the default and a guidance block otherwise', () => {
    const builder = new TestAgent(createMockBackendConfig()).getPromptBuilder()
    expect(builder.buildStableContextParts().join('\n')).not.toContain('workflow_size_guideline')

    builder.setWorkflowSizeGuideline('unrestricted')
    expect(builder.buildStableContextParts().join('\n')).not.toContain('workflow_size_guideline')

    builder.setWorkflowSizeGuideline('medium')
    const stable = builder.buildStableContextParts().join('\n')
    expect(stable).toContain('workflow_size_guideline')
    expect(stable).toContain('fewer than 15')
    expect(stable).toContain('not a cap')
  })

  it('is byte-stable across calls so it cannot re-stamp the cached system prefix', () => {
    const builder = new TestAgent(createMockBackendConfig()).getPromptBuilder()
    builder.setWorkflowSizeGuideline('small')
    expect(builder.buildStableContextParts()).toEqual(builder.buildStableContextParts())
  })
})

describe('managed policy carries the organization off switch', () => {
  it('parses a workflow layer and rejects an unknown key inside it', () => {
    const policy = parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      workflow: { disableWorkflows: true, sizeGuideline: 'small' },
    })
    expect(policy.workflow).toEqual({ disableWorkflows: true, sizeGuideline: 'small' })

    expect(() => parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      workflow: { disableWorkflow: true },
    })).toThrow('invalid workflow setting')
  })
})
