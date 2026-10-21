import { expect, test } from 'bun:test'
import { Type } from '@sinclair/typebox'
import { createDeferredMcpRegistrationController } from './deferred-mcp-extension.ts'
import { createToolExecutor } from '../../../shared/src/agent/pi-harness/tool-executor.ts'
import { createPiSdkToolAdapter, createPiToolExecutionPorts, createPiToolProgressBridge } from '../local-tools/tool-wrapper.ts'

test('registers only exact current-manifest deferred bindings through the session executor', async () => {
  const registered = new Map<string, any>()
  const executions: any[] = []
  const manifest = {
    sessionKey: { workspaceId: 'w', sessionId: 's' },
    snapshotGeneration: 'g', manifestHash: 'h',
    deferredMcp: { enabled: true, candidatePiNames: ['mcp__github__issue'] },
    tools: [{ binding: { piName: 'mcp__github__issue', bindingName: 'mcp__github__issue' }, descriptor: { id: 'mcp_dynamic' } }],
  } as any
  const toolExecutor = createToolExecutor({
    runtime: {} as any,
    authority: {
      sessionKey: manifest.sessionKey,
      manifestIdentity: { generation: 'g', manifestHash: 'h', responseEpoch: 2 },
      getCurrentResponseEpoch: () => 2,
    },
    ports: [{
      semanticId: 'mcp_dynamic',
      canonicalize: input => input,
      dispatch: { kind: 'semantic', execute: async (input, context) => {
        executions.push({ input, presentedName: context.request.presentedName })
        return { content: 'proxy-ok', isError: false }
      } },
    }],
    permissionBridge: async (_request, canonicalInput) => ({ allowed: true, decisionId: 'd', canonicalInput }),
  })
  const controller = createDeferredMcpRegistrationController({
    candidates: [{
      name: 'mcp__github__issue', label: 'Issue', description: 'Read issue',
      parameters: Type.Object({ id: Type.String() }), execute: async () => ({ content: [] }),
    }],
    manifest,
    responseEpoch: 2,
    toolExecutor,
    progressBridge: createPiToolProgressBridge(),
  })
  await controller.factory({ registerTool: definition => registered.set(definition.name, definition) } as any)
  expect(registered.size).toBe(0)
  controller.register('mcp__github__issue')
  expect([...registered.keys()]).toEqual(['mcp__github__issue'])
  await registered.get('mcp__github__issue').execute('e', { id: '1' }, new AbortController().signal)
  expect(executions).toEqual([{ input: { id: '1' }, presentedName: 'mcp__github__issue' }])
  expect(() => controller.register('mcp__github__other')).toThrow('deferred-mcp-binding-denied')
})

test('groups loaded and hidden MCP definitions into one executor semantic port', () => {
  const definition = (name: string) => ({
    name, label: name, description: name, parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text', text: name }] }),
  })
  const ports = createPiToolExecutionPorts(
    [definition('mcp__a__loaded'), definition('mcp__a__hidden')],
    () => 'mcp_dynamic',
  )
  expect(ports.map(port => port.semanticId)).toEqual(['mcp_dynamic'])
})

/**
 * F1.803 — `allowlistNames` is what the live Pi session adds to its `tools`
 * allowlist, so that a tool `mcp__tool_load` registers mid-request is offered at
 * the next model call instead of being filtered out by Pi's
 * `_refreshToolRegistry`. It must list ONLY the manifest's deferred candidates,
 * and a session whose tools are narrowed (`allowedBindingNames`) must gain
 * nothing by loading — the allowlist is the one place that decides it.
 */
test('allowlistNames lists only manifest deferred candidates, narrowed by the session allowlist', () => {
  const manifest = {
    sessionKey: { workspaceId: 'w', sessionId: 's' },
    snapshotGeneration: 'g', manifestHash: 'h',
    deferredMcp: { enabled: true, candidatePiNames: ['mcp__github__issue', 'notebook_edit'] },
    tools: [
      { binding: { piName: 'mcp__github__issue', bindingName: 'mcp__github__issue' }, descriptor: { id: 'mcp_dynamic' } },
      // A built-in whose piName differs from its definition name (C7).
      { binding: { piName: 'notebook_edit', bindingName: 'NotebookEdit' }, descriptor: { id: 'notebook_edit' } },
    ],
  } as any
  const candidate = (name: string) => ({
    name, label: name, description: name, parameters: Type.Object({}), execute: async () => ({ content: [] }),
  })
  const candidates = [candidate('mcp__github__issue'), candidate('NotebookEdit'), candidate('mcp__github__not_deferred')]
  const build = (allowedBindingNames?: ReadonlySet<string> | null) => createDeferredMcpRegistrationController({
    candidates, manifest, allowedBindingNames, responseEpoch: 1, toolExecutor: {} as any, progressBridge: createPiToolProgressBridge(),
  })

  // Keyed by the piName the load tool registers under, never the definition name.
  expect([...build().allowlistNames].sort()).toEqual(['mcp__github__issue', 'notebook_edit'])
  expect([...build(null).allowlistNames].sort()).toEqual(['mcp__github__issue', 'notebook_edit'])
  // BOUNDARY — the session allowlist (binding names) narrows it; an empty one leaves nothing.
  expect(build(new Set(['NotebookEdit'])).allowlistNames).toEqual(['notebook_edit'])
  expect(build(new Set()).allowlistNames).toEqual([])
})

/**
 * F1.925 — since F1.803 the controller's registered `execute` IS the live call
 * path for a tool `mcp__tool_load` loaded mid-request. It used to be a second,
 * hand-built wrapper that took no `onUpdate` and returned only content +
 * details, so the tool's progress updates and a PreToolUse hook's
 * `additionalContext` were dropped on every call of a loaded tool. Its execute
 * is now the eager path's own wrapper (`createPiSdkToolAdapter`), so a loaded
 * tool answers exactly what the same tool registered eagerly would.
 *
 * The candidate's schema is DEEP-FROZEN plain JSON on purpose: a real proxy
 * candidate's `parameters` is the frozen manifest's `modelSchema`, and taking
 * the adapter's schema widening along with its execute threw on it — every MCP
 * load failed inside `register` (measured on the real subprocess). A mutable
 * TypeBox schema here would not have seen it.
 */
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
function f1925Rig(additionalContext: string | undefined) {
  const progressBridge = createPiToolProgressBridge()
  const manifest = {
    sessionKey: { workspaceId: 'w', sessionId: 's' },
    snapshotGeneration: 'g', manifestHash: 'h',
    deferredMcp: { enabled: true, candidatePiNames: ['mcp__github__issue'] },
    tools: [{ binding: { piName: 'mcp__github__issue', bindingName: 'mcp__github__issue' }, descriptor: { id: 'mcp_dynamic' } }],
  } as any
  const toolExecutor = createToolExecutor({
    runtime: {} as any,
    authority: {
      sessionKey: manifest.sessionKey,
      manifestIdentity: { generation: 'g', manifestHash: 'h', responseEpoch: 2 },
      getCurrentResponseEpoch: () => 2,
    },
    ports: [{
      semanticId: 'mcp_dynamic',
      canonicalize: input => input,
      dispatch: { kind: 'semantic', execute: async (_input, context) => {
        context.emitProgress({ text: 'halfway' })
        return { content: 'proxy-ok', isError: false }
      } },
    }],
    onProgress: progressBridge.emit,
    permissionBridge: async (_request, canonicalInput) => ({
      allowed: true, decisionId: 'd', canonicalInput,
      ...(additionalContext !== undefined ? { additionalContext } : {}),
    }),
  })
  const schema = () => ({ type: 'object', properties: { id: { type: 'string' } } })
  const candidate = {
    name: 'mcp__github__issue', label: 'Issue', description: 'Read issue',
    parameters: deepFreeze(schema()) as any, execute: async () => ({ content: [] }),
  }
  const controller = createDeferredMcpRegistrationController({
    candidates: [candidate], manifest, responseEpoch: 2, toolExecutor, progressBridge,
  })
  const eager = createPiSdkToolAdapter({
    toolExecutor,
    sessionKey: manifest.sessionKey,
    manifestIdentity: { generation: 'g', manifestHash: 'h', responseEpoch: 2 },
    resolveSemanticId: () => 'mcp_dynamic',
    progressBridge,
  }).adaptTool({ ...candidate, parameters: schema() as any }) // the eager path adapts a fresh projected copy
  return { controller, eager, candidate }
}

async function loadAndCall(controller: ReturnType<typeof f1925Rig>['controller'], executionId: string) {
  const registered = new Map<string, any>()
  await controller.factory({ registerTool: (definition: any) => registered.set(definition.name, definition) } as any)
  controller.register('mcp__github__issue')
  const updates: unknown[] = []
  const result = await registered.get('mcp__github__issue')
    .execute(executionId, { id: '1' }, new AbortController().signal, (update: unknown) => updates.push(update))
  return { result, updates, tool: registered.get('mcp__github__issue') }
}

test('F1.925: a loaded deferred tool forwards progress and the PreToolUse hook context like an eager one', async () => {
  const { controller, eager, candidate } = f1925Rig('Remember the issue tracker is read-only.')
  const loaded = await loadAndCall(controller, 'e1')
  expect(loaded.updates).toEqual([{ content: [{ type: 'text', text: 'halfway' }], details: undefined }])
  expect(loaded.result.content).toEqual([
    { type: 'text', text: '<pre_tool_use_context>\nRemember the issue tracker is read-only.\n</pre_tool_use_context>\n\n' },
    { type: 'text', text: 'proxy-ok' },
  ])
  // CONTROL — byte-identical to the same tool registered eagerly.
  const eagerUpdates: unknown[] = []
  const eagerResult = await eager.execute('e2', { id: '1' }, new AbortController().signal, (update: unknown) => eagerUpdates.push(update), undefined as never)
  expect(JSON.stringify(loaded.result)).toBe(JSON.stringify(eagerResult))
  expect(loaded.updates).toEqual(eagerUpdates)
  // F1.1127 — the loaded tool's schema is the eager one's widened fresh copy, never the candidate's frozen object.
  expect(loaded.tool.parameters).toEqual(eager.parameters)
  expect(loaded.tool.parameters).not.toBe(candidate.parameters)
})

test('F1.925 boundary: with no hook context a loaded tool answers the bare result, and a later call is unchanged', async () => {
  const { controller } = f1925Rig('   ')
  const loaded = await loadAndCall(controller, 'e1')
  expect(loaded.result).toEqual({ content: [{ type: 'text', text: 'proxy-ok' }], details: undefined })
  const again = await loaded.tool.execute('e3', { id: '1' }, new AbortController().signal, undefined)
  expect(again).toEqual(loaded.result)
})

/**
 * F1.1127 (origin DN-124) — a tool `mcp__tool_load` registers gets the eager path's projection: a FRESH copy of its
 * schema widened for Nessy's `_intent` / `_displayName` (so a strict MCP schema, `additionalProperties: false`, does
 * not reject a call carrying them), its piName as label, and the description rewrites `projectPiToolDefinition`
 * applies. Before, `register` kept the candidate's own deep-frozen schema and took only the adapter's execute.
 */
test('F1.1127: a loaded tool is projected and widened like an eager one, and the candidate stays untouched', async () => {
  const registered = new Map<string, any>()
  const executions: any[] = []
  const manifest = {
    sessionKey: { workspaceId: 'w', sessionId: 's' },
    snapshotGeneration: 'g', manifestHash: 'h',
    deferredMcp: { enabled: true, candidatePiNames: ['mcp__github__issue'] },
    tools: [{ binding: { piName: 'mcp__github__issue', bindingName: 'mcp__github__issue' }, descriptor: { id: 'mcp_dynamic' } }],
  } as any
  const toolExecutor = createToolExecutor({
    runtime: {} as any,
    authority: {
      sessionKey: manifest.sessionKey,
      manifestIdentity: { generation: 'g', manifestHash: 'h', responseEpoch: 2 },
      getCurrentResponseEpoch: () => 2,
    },
    ports: [{
      semanticId: 'mcp_dynamic',
      canonicalize: input => input,
      dispatch: { kind: 'semantic', execute: async input => {
        executions.push(input)
        return { content: 'proxy-ok', isError: false }
      } },
    }],
    permissionBridge: async (_request, canonicalInput) => ({ allowed: true, decisionId: 'd', canonicalInput }),
  })
  const strict = Object.freeze({
    type: 'object',
    properties: Object.freeze({ id: Object.freeze({ type: 'string' }) }),
    required: Object.freeze(['id']),
    additionalProperties: false,
  })
  const controller = createDeferredMcpRegistrationController({
    candidates: [{ name: 'mcp__github__issue', label: 'Issue', description: 'Read issue', parameters: strict as any, execute: async () => ({ content: [] }) }],
    manifest,
    responseEpoch: 2,
    toolExecutor,
    progressBridge: createPiToolProgressBridge(),
  })
  await controller.factory({ registerTool: definition => registered.set(definition.name, definition) } as any)
  controller.register('mcp__github__issue')
  const tool = registered.get('mcp__github__issue')
  expect(Object.keys(tool.parameters.properties).sort()).toEqual(['_displayName', '_intent', 'id'])
  expect(tool.parameters.additionalProperties).toBe(false)
  expect(tool.label).toBe('mcp__github__issue')
  // The candidate's frozen schema is a copy's source, never the thing widened.
  expect(Object.keys(strict.properties)).toEqual(['id'])
  // The call still runs through the session executor (the host's gate strips the metadata, as for an eager call).
  await tool.execute('e', { id: '1', _intent: 'read the issue' }, new AbortController().signal)
  expect(executions).toEqual([{ id: '1', _intent: 'read the issue' }])
})
