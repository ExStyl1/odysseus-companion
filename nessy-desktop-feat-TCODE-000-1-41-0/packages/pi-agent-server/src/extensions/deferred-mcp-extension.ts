import type { ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { PiExecutionManifestV2 } from '../../../shared/src/agent/pi-harness/harness-manifest.ts'
import type { ToolExecutor } from '../../../shared/src/agent/pi-harness/tool-executor.ts'
import { createPiSdkToolAdapter, type PiToolProgressBridge } from '../local-tools/tool-wrapper.ts'
import { projectPiManifestTool } from '../harness/tool-manifest.ts'

export const PI_DEFERRED_MCP_COMPONENT_ID = 'nessy.deferred-mcp-extension' as const

export function createDeferredMcpRegistrationController(options: {
  candidates: readonly ToolDefinition<any, any>[]
  manifest: PiExecutionManifestV2
  /** `resolvePiAllowedBindingNames`' answer for the session; `null` or absent narrows nothing. */
  allowedBindingNames?: ReadonlySet<string> | null
  toolExecutor: ToolExecutor
  /** The session's bridge, the one the eager adapter binds — without it a loaded tool's progress has nowhere to go. */
  progressBridge: PiToolProgressBridge
  responseEpoch: number
}): { factory: ExtensionFactory; register(name: string): void; allowlistNames: readonly string[] } {
  const allowed = new Set(options.manifest.deferredMcp.candidatePiNames)
  // Keyed by the piName, because `register` is called with the semantic ids the
  // load tool returns from the capability catalogue — while a DEFINITION is
  // named by its bindingName. The two agree for every MCP proxy tool and differ
  // for two of C7's deferrable built-ins (`NotebookEdit`/`notebook_edit`,
  // `stopTask`/`stop_task`), where keying by `candidate.name` would make the
  // lookup below miss and the registration throw `deferred-mcp-binding-denied`
  // for a tool that is perfectly legitimate.
  const candidates = new Map(options.candidates.map(candidate => [
    options.manifest.tools.find(tool => tool.binding.bindingName === candidate.name)?.binding.piName
      ?? candidate.name,
    candidate,
  ]))
  // F1.803 — the piNames this controller may register, for the live session's
  // `tools` allowlist. Pi's `_refreshToolRegistry` filters every
  // extension-registered tool through that allowlist, so a name absent from it
  // was registered and then never offered: `mcp__tool_load` answered "loaded"
  // and the next call answered `Tool … not found` (SIT-p, `web_search`).
  // Listing a name here activates nothing by itself — Pi offers only what is
  // ALSO in its registry, and a candidate enters the registry only through
  // `register` below, after `mcp__tool_load` accepted it. Every candidate is
  // `mcp__`-prefixed or one of the eight deferrable Nessy built-ins, so none
  // shadows a Pi base tool (`read`, `bash`, `grep`, …) that would otherwise
  // become active from the first call.
  const allowlistNames = [...candidates.entries()]
    .filter(([piName, candidate]) => allowed.has(piName)
      && (!options.allowedBindingNames || options.allowedBindingNames.has(candidate.name)))
    .map(([piName]) => piName)
  const registered = new Set<string>()
  let registerTool: ((definition: ToolDefinition<any, any>) => void) | undefined

  const register = (name: string) => {
    if (registered.has(name)) return
    const candidate = candidates.get(name)
    const manifestTool = options.manifest.tools.find(tool => tool.binding.piName === name)
    if (!registerTool || !candidate || !allowed.has(name) || !manifestTool
      || manifestTool.binding.bindingName !== candidate.name) {
      throw new Error(`deferred-mcp-binding-denied:${name}`)
    }
    // F1.925 — the execute is the EAGER path's own wrapper, not a second
    // hand-built one. Since F1.803 it is the live call path for a tool
    // `mcp__tool_load` loaded mid-request, and the hand-built copy took no
    // `onUpdate` and returned only content + details: the tool's progress
    // (heartbeats included) and a PreToolUse hook's `additionalContext` were
    // dropped on every call of a loaded tool. The adapter's execute binds Pi's
    // `onUpdate` to the session's progress bridge, appends the receipt's hook
    // context and carries `isError`, exactly as for an eagerly registered tool.
    // The semantic id stays the manifest's own, checked above; the identity is
    // the eager one's (`manifestIdentity` in index.ts, the same three values).
    //
    // F1.1127 — and the DEFINITION is the eager path's too: the candidate's `parameters` IS the deep-frozen manifest's
    // `modelSchema` (`buildProxyTools` in index.ts), which the adapter's `_intent`/`_displayName` widening cannot take
    // (measured: widening it in place made every load throw here), so the tool used to keep its own strict schema and
    // a call carrying Nessy's metadata could be refused by it. `projectPiManifestTool` makes the fresh copy (name,
    // label, description rewrites, model-contract check) `projectPiManifestTools` makes for an eager tool, and the
    // adapter widens that copy, exactly as `adaptTools` does on the eager path.
    const adapted = createPiSdkToolAdapter({
      toolExecutor: options.toolExecutor,
      sessionKey: options.manifest.sessionKey,
      manifestIdentity: {
        generation: options.manifest.snapshotGeneration,
        manifestHash: options.manifest.manifestHash,
        responseEpoch: options.responseEpoch,
      },
      resolveSemanticId: () => manifestTool.descriptor.id,
      progressBridge: options.progressBridge,
    }).adaptTool(projectPiManifestTool(options.manifest, manifestTool, candidate))
    registerTool(adapted)
    registered.add(name)
  }

  return {
    factory: api => {
      registerTool = definition => api.registerTool(definition)
    },
    register,
    allowlistNames,
  }
}
