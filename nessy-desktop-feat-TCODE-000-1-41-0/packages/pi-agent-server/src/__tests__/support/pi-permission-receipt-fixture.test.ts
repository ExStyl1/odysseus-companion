/**
 * The first test in this repo that exercises a Pi permission receipt as
 * BEHAVIOUR rather than as source text.
 *
 * `pi-runtime-protocol.test.ts` asserts that `permissionBridge` contains the
 * right lines. That catches a deleted call and cannot catch a receipt that
 * parses cleanly and then fails one of the fourteen expectation comparisons —
 * which is the failure a real-server test actually hits, and which is why
 * driving a tool through permissions was avoided rather than fixed.
 */
import { describe, expect, it } from 'bun:test'

import type { AgentRuntimeView } from '../../../../shared/src/capabilities/views.ts'
import type { EffectiveCapabilitySnapshot } from '../../../../shared/src/capabilities/resolver.ts'
import {
  createPiExecutionManifestSeed,
  finalizePiExecutionManifest,
} from '../../../../shared/src/agent/pi-harness/harness-manifest.ts'
import { parseAndFreezePiPermissionReceipt } from '../../../../shared/src/agent/pi-harness/permission-receipt.ts'
import { isPiPreToolUseRequest, mintPiPermissionReceipt, piPreToolUseResponse } from './pi-permission-receipt-fixture.ts'

const view: AgentRuntimeView = {
  generation: 'generation-1',
  sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
  promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
}
const snapshot = {
  context: { workspaceId: 'w', sessionId: 's', projectTrustState: 'none', projectTrustRevision: '' },
  generation: view.generation,
  leaseId: 'lease',
  entries: [], installedPlugins: [], diagnostics: [],
} as EffectiveCapabilitySnapshot

const capabilityKey = 'native:workspace:mcp:bulk'
const manifest = finalizePiExecutionManifest(
  {
    ...createPiExecutionManifestSeed({ snapshot, view, sessionKey: { workspaceId: 'w', sessionId: 's' } }),
    provenance: [{ capabilityKey, generation: view.generation }],
    mcpSources: [{ wireName: 'bulk', capabilityKey, generation: view.generation }],
  },
  [],
  { deferredMcpEnabled: true },
)

/** The subprocess's own expectation, built the way `permissionBridge` builds it. */
function expectationFor(piName: string, responseEpoch: number) {
  const tool = manifest.tools.find(value => value.binding.piName === piName)!
  return {
    sessionKey: manifest.sessionKey,
    provider: 'pi' as const,
    surfaceVersion: manifest.surfaceVersion,
    piName: tool.binding.piName,
    bindingName: tool.binding.bindingName,
    semanticId: tool.descriptor.id,
    descriptorId: tool.binding.descriptorId,
    manifestGeneration: manifest.snapshotGeneration,
    manifestHash: manifest.manifestHash,
    manifestProvenance: manifest.provenance.map(value => `${value.capabilityKey}@${value.generation}`),
    responseEpoch,
    contextProfile: 'bare' as const,
    sandboxRequirement: tool.descriptor.sandboxProfile,
  }
}

function requestFor(piName: string, requestId = `pi-ptu-${piName}`) {
  const tool = manifest.tools.find(value => value.binding.piName === piName)!
  return {
    type: 'pre_tool_use_request',
    requestId,
    toolName: tool.binding.permissionName,
    semanticId: tool.descriptor.id,
    piName: tool.binding.piName,
    surfaceVersion: manifest.surfaceVersion,
    manifestResponseEpoch: 7,
    manifestGeneration: manifest.snapshotGeneration,
    manifestHash: manifest.manifestHash,
    // Deliberately the request's OWN spelling — `[capabilityKey]` or `[]` —
    // which is NOT what the receipt must carry. See the negative control below.
    manifestProvenance: [],
    input: { file_path: '/tmp/x' },
  }
}

describe('the Pi permission receipt fixture', () => {
  it('mints a receipt the real parser accepts against the real expectation', () => {
    const request = requestFor('read')
    const receipt = mintPiPermissionReceipt({ manifest, request })

    const parsed = parseAndFreezePiPermissionReceipt(receipt, expectationFor('read', 7))
    expect(parsed.outcome).toBe('allow')
    expect(parsed.binding.provider).toBe('pi')
    expect(parsed.canonicalInput).toEqual({ file_path: '/tmp/x' })
  })

  it('resolves bindingName from the manifest for a tool whose piName differs', () => {
    // The whole reason this cannot be an echo of the request: the request never
    // carries `bindingName`, and `notebook_edit`/`NotebookEdit` is one of the two
    // places where guessing it from `piName` would be wrong. C7's deferral work
    // was silently deferring seven tools of nine on exactly this split.
    const receipt = mintPiPermissionReceipt({ manifest, request: requestFor('notebook_edit') })
    expect((receipt.binding as { bindingName: string }).bindingName).toBe('NotebookEdit')
    expect(() => parseAndFreezePiPermissionReceipt(receipt, expectationFor('notebook_edit', 7))).not.toThrow()
  })

  it('carries the manifest provenance, not the request field of the same name', () => {
    // The near-miss the fixture exists to stop each caller rediscovering: the
    // request's `manifestProvenance` is `[capabilityKey]` or `[]`, while the
    // receipt must carry `capabilityKey@generation`. A straight copy parses and
    // then fails with `manifestProvenance mismatch`.
    const receipt = mintPiPermissionReceipt({ manifest, request: requestFor('read') })
    expect(receipt.manifest).toMatchObject({ provenance: [`${capabilityKey}@${view.generation}`] })

    // NEGATIVE CONTROL: the copy that looks right is rejected, so the assertion
    // above is not merely restating whatever the fixture happened to produce.
    const naive = { ...receipt, manifest: { ...(receipt.manifest as object), provenance: [] } }
    expect(() => parseAndFreezePiPermissionReceipt(naive, expectationFor('read', 7)))
      .toThrow('manifestProvenance mismatch')
  })

  it('rejects a receipt minted against the wrong response epoch', () => {
    // A stale epoch is the shape a replayed or misrouted approval takes, so the
    // fixture must not be able to paper over it.
    const receipt = mintPiPermissionReceipt({ manifest, request: requestFor('read') })
    expect(() => parseAndFreezePiPermissionReceipt(receipt, expectationFor('read', 8)))
      .toThrow('responseEpoch mismatch')
  })

  it('gives each request its own decisionId, because the bridge refuses a replay', () => {
    const first = piPreToolUseResponse({ manifest, request: requestFor('read', 'pi-ptu-a') })
    const second = piPreToolUseResponse({ manifest, request: requestFor('read', 'pi-ptu-b') })
    expect(first.receipt.decisionId).not.toBe(second.receipt.decisionId)
    expect(first.type).toBe('pre_tool_use_response')
    expect(first.requestId).toBe('pi-ptu-a')
  })

  it('refuses to invent a receipt for a tool the manifest does not carry', () => {
    // Loud beats plausible: a fallback here would answer with something the
    // subprocess rejects, and the caller would read a permission mismatch where
    // the real fault is that the tool never reached the manifest.
    expect(() => mintPiPermissionReceipt({
      manifest,
      request: { ...requestFor('read'), piName: 'not_a_tool' },
    })).toThrow('No manifest tool for piName not_a_tool')
  })

  it('recognises a pre_tool_use_request and nothing else', () => {
    expect(isPiPreToolUseRequest(requestFor('read'))).toBe(true)
    expect(isPiPreToolUseRequest({ type: 'post_tool_use_request', requestId: 'x', piName: 'read' })).toBe(false)
    expect(isPiPreToolUseRequest({ type: 'pre_tool_use_request' })).toBe(false)
  })
})
