import {
  DEFAULT_PI_ORCHESTRATOR_CONFIG,
  finalizePiExecutionManifest,
  type PiExecutionManifestSeedV2,
  type PiExecutionManifestV2,
} from '../../../shared/src/agent/pi-harness/harness-manifest.ts'
import {
  PI_STATIC_MODEL_CONTRACT_HASHES,
  PI_TOOL_BINDINGS,
  getHarnessToolDescriptor,
} from '../../../shared/src/agent/pi-harness/harness-tool-descriptor.ts'
import type { SessionKey } from '../../../shared/src/sessions/session-key.ts'
import type { PiPermissionReceiptV1 } from '../../../shared/src/agent/pi-harness/permission-receipt.ts'

export function createRealServerExecutionManifest(sessionKey: SessionKey): PiExecutionManifestV2 {
  const snapshotGeneration = `real-server:${sessionKey.workspaceId}:${sessionKey.sessionId}`
  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration,
    sessionKey,
    provenance: [],
    mcpSources: [],
    // Must match the subprocess's normalized orchestrator: these real-server
    // inits omit `orchestrator`, so the server normalizes to the defaults.
    orchestrator: { ...DEFAULT_PI_ORCHESTRATOR_CONFIG },
    staticTools: PI_TOOL_BINDINGS
      .filter(binding => PI_STATIC_MODEL_CONTRACT_HASHES[binding.bindingName] !== undefined)
      .map(binding => ({
        descriptor: getHarnessToolDescriptor(binding.descriptorId),
        binding,
        source: { kind: 'piBuiltin' as const, bindingId: binding.bindingName },
        modelContractHash: PI_STATIC_MODEL_CONTRACT_HASHES[binding.bindingName]!,
      })),
  }
  return finalizePiExecutionManifest(seed, [])
}

export function createRealServerAllowPermissionReceipt(
  manifest: PiExecutionManifestV2,
  // F1.1137: the epoch is the REQUEST's, echoed as `support/pi-permission-receipt-fixture.ts` does — a default
  // of 1 held only while no real-server test rebuilt its session (a false "responseEpoch mismatch" after).
  request: { requestId: string; piName: string; semanticId: string; input: Record<string, unknown>; manifestResponseEpoch: number },
): PiPermissionReceiptV1 {
  const tool = manifest.tools.find(candidate => candidate.binding.piName === request.piName)
  if (!tool) throw new Error(`Unknown real-server fixture tool: ${request.piName}`)
  if (tool.descriptor.id !== request.semanticId) {
    throw new Error(`Real-server fixture semantic mismatch: ${request.semanticId}`)
  }
  return {
    version: 1,
    sessionKey: manifest.sessionKey,
    binding: {
      provider: 'pi',
      surfaceVersion: manifest.surfaceVersion,
      piName: tool.binding.piName,
      bindingName: tool.binding.bindingName,
      semanticId: tool.descriptor.id,
      descriptorId: tool.binding.descriptorId,
    },
    manifest: {
      generation: manifest.snapshotGeneration,
      hash: manifest.manifestHash,
      provenance: manifest.provenance.map(value => `${value.capabilityKey}@${value.generation}`),
      responseEpoch: request.manifestResponseEpoch,
    },
    decisionId: `real-server-allow:${request.requestId}`,
    outcome: 'allow',
    canonicalInput: request.input,
    contextProfile: 'bare',
    sandboxRequirement: tool.descriptor.sandboxProfile,
  }
}
