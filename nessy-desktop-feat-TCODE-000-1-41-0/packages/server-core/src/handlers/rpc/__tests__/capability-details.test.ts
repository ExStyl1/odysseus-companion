import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type {
  CapabilityManagedResourceRef,
  PreviewableCapabilityManagedResourceRef,
} from '@nessy-agent/shared/protocol'
import { createCapabilityResolver } from '@nessy-agent/shared/capabilities/resolver'
import type { NativeCapabilitySourceRecord } from '@nessy-agent/shared/capabilities/types'
import { ProjectHandleService } from '@nessy-agent/shared/projects/project-handle-service'
import type { HandlerFn, RequestContext, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { registerCapabilitiesHandlers } from '../capabilities'
import {
  ManagedResourceError,
  previewManagedResource,
  resolveManagedEditContext,
  resolveManagedResource,
  summarizeManagedResource,
  type ManagedResourceDeps,
} from '../../../domain/capabilities/managed-resources'

const roots: string[] = []
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}
afterEach(() => {
  while (roots.length) {
    const dir = roots.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function fixture() {
  const workspaceRoot = tmp('cd-ws-')
  const globalSkillsDir = tmp('cd-global-')
  // Workspace skill.
  mkdirSync(join(workspaceRoot, 'skills', 'myskill'), { recursive: true })
  writeFileSync(join(workspaceRoot, 'skills', 'myskill', 'SKILL.md'), '---\nname: myskill\n---\nInstructions body')
  // Source config + guide.
  mkdirSync(join(workspaceRoot, 'sources', 'mysource'), { recursive: true })
  writeFileSync(
    join(workspaceRoot, 'sources', 'mysource', 'config.json'),
    JSON.stringify({ name: 'My Source', type: 'mcp', provider: 'acme', secretToken: 'SHOULD-NOT-LEAK' }),
  )
  writeFileSync(join(workspaceRoot, 'sources', 'mysource', 'guide.md'), '# Guide\nHow to use')
  const deps: ManagedResourceDeps = {
    resolveWorkspaceRootPath: (id: string) => (id === 'ws-1' ? workspaceRoot : undefined),
    globalConfigDir: tmp('cd-config-'),
    globalSkillsDir,
  }
  return { workspaceRoot, globalSkillsDir, deps }
}

describe('managed-resource resolution', () => {
  it('previews a workspace skill body and resolves its edit context to the real file', () => {
    const { deps } = fixture()
    const ref: PreviewableCapabilityManagedResourceRef = { scope: 'skill', tier: 'workspace', workspaceId: 'ws-1', skillId: 'myskill', file: 'instructions' }
    const preview = previewManagedResource(ref, deps)
    expect(preview.content).toContain('Instructions body')
    expect(preview.contentType).toBe('markdown')

    const edit = resolveManagedEditContext(ref, 'skill-instructions', deps)
    expect(edit.filePath.endsWith(join('skills', 'myskill', 'SKILL.md'))).toBe(true)
    expect(edit.editContextKey).toBe('skill-instructions')
  })

  it('summarizes a source config with allowlisted fields only and never leaks secrets', () => {
    const { deps } = fixture()
    const ref: CapabilityManagedResourceRef = { scope: 'source', workspaceId: 'ws-1', sourceId: 'mysource', file: 'config' }
    const summary = summarizeManagedResource(ref, deps)
    expect(summary.redacted).toBe(true)
    const labels = summary.fields.map(f => f.label).sort()
    expect(labels).toEqual(['name', 'provider', 'type'])
    expect(JSON.stringify(summary)).not.toContain('SHOULD-NOT-LEAK')
  })

  it('refuses to preview a source config (summary/edit-only)', () => {
    const { deps } = fixture()
    const ref = { scope: 'source', workspaceId: 'ws-1', sourceId: 'mysource', file: 'config' } as never
    try {
      previewManagedResource(ref, deps)
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ManagedResourceError)
      expect((error as ManagedResourceError).code).toBe('not-previewable')
    }
  })

  it('previews a source guide', () => {
    const { deps } = fixture()
    const ref: PreviewableCapabilityManagedResourceRef = { scope: 'source', workspaceId: 'ws-1', sourceId: 'mysource', file: 'guide' }
    expect(previewManagedResource(ref, deps).content).toContain('How to use')
  })

  it('rejects a traversal id via contained-path validation', () => {
    const { workspaceRoot, deps } = fixture()
    // The escape target EXISTS, so an existence check cannot stand in for the
    // containment gate: replacing `resolveContainedPath` with
    // `join(...) + existsSync` kept the old bare `toThrow()` green (13/13)
    // while `skills/../escaped/SKILL.md` resolved outside the skills root.
    mkdirSync(join(workspaceRoot, 'escaped'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'escaped', 'SKILL.md'), '---\nname: escaped\n---\nBody')

    for (const skillId of ['../escaped', '../../etc']) {
      const ref: CapabilityManagedResourceRef = { scope: 'skill', tier: 'workspace', workspaceId: 'ws-1', skillId, file: 'instructions' }
      let thrown: unknown
      try {
        resolveManagedResource(ref, deps)
      } catch (error) {
        thrown = error
      }
      // The refusal must come from the containment assertion. A
      // `ManagedResourceError` here — `not-found`, `unsupported-ref` — would
      // mean the gate never ran and something downstream refused instead.
      expect(thrown).toBeInstanceOf(Error)
      expect(thrown).not.toBeInstanceOf(ManagedResourceError)
      expect((thrown as Error).message).toBe('Path escapes managed storage root')
    }
  })

  it('rejects plugin skill resources as read-only', () => {
    const { deps } = fixture()
    const pluginRef: CapabilityManagedResourceRef = { scope: 'skill', tier: 'plugin', pluginInstanceId: 'pi', capabilityId: 'c', file: 'instructions' }
    try {
      resolveManagedResource(pluginRef, deps)
      throw new Error('should have thrown')
    } catch (error) {
      expect((error as ManagedResourceError).code).toBe('unsupported-ref')
    }
  })
})

function createHarness(
  deps: ManagedResourceDeps,
  records: NativeCapabilitySourceRecord[] = [],
  sendMessage?: (sessionId: string, message: string, onAck?: (messageId: string) => void) => Promise<void>,
) {
  const handlers = new Map<string, HandlerFn>()
  const openPaths: string[] = []
  const sentMessages: string[] = []
  const logged: string[] = []
  // F1.994 — what reached the renderer-facing wire, in order, with the flush seam.
  const wire: Array<
    | { step: 'flush'; sessionId: string; workspaceId: string }
    | { step: 'push'; channel: string; target: unknown; event: unknown }
  > = []
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push(channel, target, ...args) { wire.push({ step: 'push', channel, target, event: args[0] }) },
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  const handlerDeps = {
    platform: {
      logger: {
        info() {},
        warn(...args: unknown[]) { logged.push(args.map(String).join(' ')) },
        error(...args: unknown[]) { logged.push(args.map(String).join(' ')) },
        debug() {},
      },
      async openPath(p: string) { openPaths.push(p) },
    },
    sessionManager: {
      getWorkingDirectory() { return null },
      async createSession() { return { id: 'edit-session' } },
      // The real positional shape: `onAck` is the eighth argument
      // (`SessionManager.sendMessage`), fired once the user message is persisted.
      async sendMessage(sessionId: string, message: string, ...rest: unknown[]) {
        sentMessages.push(message)
        await sendMessage?.(sessionId, message, rest[5] as ((messageId: string) => void) | undefined)
      },
      // Recorded AFTER an await, like the real seam, so a caller that forgot to
      // await it would push before the flush lands.
      async flushBeforeTurnEndEvent(sessionId: string, workspaceId: string) {
        await Promise.resolve()
        wire.push({ step: 'flush', sessionId, workspaceId })
      },
    },
  } as unknown as HandlerDeps
  const resolver = createCapabilityResolver({
    inputs: () => ({
      nativeInventory: { records, blockedLayers: [] },
      installedPlugins: [],
      activePluginInstances: {},
      pluginCandidates: [],
      resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
      resolveTrust: () => 'not-required',
    }),
  })
  const handleService = new ProjectHandleService({
    identityOptions: {
      realpathSync: p => p,
      statSync: () => ({ dev: 1n, ino: 1n }),
      processSalt: 'capability-details-test',
    },
  })
  registerCapabilitiesHandlers(server, handlerDeps, {
    managedResourceDeps: deps,
    resolver,
    handleService,
  })
  return { handlers, openPaths, sentMessages, logged, wire }
}

function ctx(): RequestContext {
  return { clientId: 'client-1', workspaceId: 'ws-1', webContentsId: 1 }
}

describe('capability-details RPC routes', () => {
  it('OPEN resolves the ref server-side and opens the contained file path', async () => {
    const { deps, workspaceRoot } = fixture()
    const { handlers, openPaths } = createHarness(deps)
    await handlers.get(RPC_CHANNELS.capabilities.OPEN)!(ctx(), { workspaceId: 'ws-1' }, {
      scope: 'skill', tier: 'workspace', workspaceId: 'ws-1', skillId: 'myskill', file: 'instructions',
    })
    expect(openPaths).toEqual([join(workspaceRoot, 'skills', 'myskill', 'SKILL.md')])
  })

  it('SUBMIT_MANAGED_EDIT keeps the path server-side and returns no path-bearing value', async () => {
    const { deps, workspaceRoot } = fixture()
    const { handlers, sentMessages } = createHarness(deps)
    const result = await handlers.get(RPC_CHANNELS.capabilities.SUBMIT_MANAGED_EDIT)!(ctx(), {
      session: { workspaceId: 'ws-1', sessionId: 'edit-session' },
      resource: { scope: 'source', workspaceId: 'ws-1', sourceId: 'mysource', file: 'config' },
      contextKey: 'source-config',
      instructions: 'Update this source configuration.',
    })
    expect(result).toBeUndefined()
    expect(JSON.stringify(result) ?? '').not.toContain(workspaceRoot)
    expect(sentMessages[0]).toContain(join(workspaceRoot, 'sources', 'mysource', 'config.json'))
  })

  it('SUBMIT_MANAGED_EDIT adds server-owned automation tool guidance', async () => {
    const { deps } = fixture()
    const { handlers, sentMessages } = createHarness(deps)

    await handlers.get(RPC_CHANNELS.capabilities.SUBMIT_MANAGED_EDIT)!(ctx(), {
      session: { workspaceId: 'ws-1', sessionId: 'edit-session' },
      resource: { scope: 'workspace', workspaceId: 'ws-1', kind: 'automations' },
      contextKey: 'add-automation-agentic',
      instructions: 'Create an automation after the agent finishes.',
    })

    expect(sentMessages[0]).toContain('automation_create')
    expect(sentMessages[0]).toContain('automation_validate')
    expect(sentMessages[0]).toContain('Do not edit automations.json directly')
  })

  it('SUBMIT_MANAGED_EDIT awaits and propagates sendMessage failures', async () => {
    const { deps } = fixture()
    let rejectSend!: (error: Error) => void
    const send = new Promise<void>((_resolve, reject) => { rejectSend = reject })
    const { handlers, wire } = createHarness(deps, [], async () => send)

    const request = handlers.get(RPC_CHANNELS.capabilities.SUBMIT_MANAGED_EDIT)!(ctx(), {
      session: { workspaceId: 'ws-1', sessionId: 'edit-session' },
      resource: { scope: 'workspace', workspaceId: 'ws-1', kind: 'automations' },
      contextKey: 'add-automation',
      instructions: 'Create an automation.',
    })
    let settled = false
    void request.finally(() => { settled = true }).catch(() => {})
    await Promise.resolve()
    expect(settled).toBe(false)

    rejectSend(new Error('agent turn failed'))
    await expect(request).rejects.toThrow('agent turn failed')
    // F1.994 boundary — a failure BEFORE the dispatch is the caller's rejection
    // and nothing else: no turn started, so no terminal event is pushed for it.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(wire).toEqual([])
  })

  // F1.754 — the request answers when the turn is DISPATCHED (the user message
  // persisted, `onAck`), the moment `sessions:sendMessage` answers at. Awaiting
  // the whole turn let any add-source turn longer than the renderer's 30 s
  // budget surface as a failed request while the agent went on working.
  it('SUBMIT_MANAGED_EDIT answers once the turn is dispatched, while the turn keeps running', async () => {
    const { deps } = fixture()
    const turn = new Promise<void>(() => {})
    const { handlers } = createHarness(deps, [], async (_sessionId, _message, onAck) => {
      onAck?.('user-message-1')
      await turn
    })

    const request = handlers.get(RPC_CHANNELS.capabilities.SUBMIT_MANAGED_EDIT)!(ctx(), {
      session: { workspaceId: 'ws-1', sessionId: 'edit-session' },
      resource: { scope: 'workspace', workspaceId: 'ws-1', kind: 'sources-root' },
      contextKey: 'add-source',
      instructions: 'Connect Linear.',
    })
    const outcome = await Promise.race([
      request.then((value: unknown) => ({ answered: true, value })),
      new Promise(resolve => setTimeout(() => resolve({ answered: false }), 50)),
    ])
    expect(outcome).toEqual({ answered: true, value: undefined })
  })

  it('SUBMIT_MANAGED_EDIT logs a turn failure after the dispatch instead of rejecting the answered request', async () => {
    const { deps } = fixture()
    let failTurn!: (error: Error) => void
    const turn = new Promise<void>((_resolve, reject) => { failTurn = reject })
    const { handlers, logged } = createHarness(deps, [], async (_sessionId, _message, onAck) => {
      onAck?.('user-message-1')
      await turn
    })

    const request = handlers.get(RPC_CHANNELS.capabilities.SUBMIT_MANAGED_EDIT)!(ctx(), {
      session: { workspaceId: 'ws-1', sessionId: 'edit-session' },
      resource: { scope: 'workspace', workspaceId: 'ws-1', kind: 'sources-root' },
      contextKey: 'add-source',
      instructions: 'Connect Linear.',
    })
    // Raced, not awaited: a request that never answers must FAIL here, not hang
    // the runner (a bare `resolves` on a never-settling promise did, on bun 1.3.14).
    const outcome = await Promise.race([
      request.then((value: unknown) => ({ answered: true, value }), (error: Error) => ({ answered: true, error: error.message })),
      new Promise(resolve => setTimeout(() => resolve({ answered: false }), 50)),
    ])
    expect(outcome).toEqual({ answered: true, value: undefined })
    expect(logged).toEqual([])

    failTurn(new Error('post-turn cleanup threw'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('post-turn cleanup threw')
  })

  // F1.994 — the request is answered at the dispatch, so a turn that fails
  // AFTER it can no longer reach the caller as a rejection. It ends the
  // caller's turn on the event stream instead, exactly as `sessions:sendMessage`'s
  // post-persist arm does (flush first, then `error` + `complete` to the calling
  // client) — otherwise the inline Add Source / Add Skill popover keeps spinning.
  it('SUBMIT_MANAGED_EDIT ends the caller’s turn with error + complete when the dispatched turn fails', async () => {
    const { deps } = fixture()
    let failTurn!: (error: Error) => void
    const turn = new Promise<void>((_resolve, reject) => { failTurn = reject })
    const { handlers, wire } = createHarness(deps, [], async (_sessionId, _message, onAck) => {
      onAck?.('user-message-1')
      await turn
    })

    await handlers.get(RPC_CHANNELS.capabilities.SUBMIT_MANAGED_EDIT)!(ctx(), {
      session: { workspaceId: 'ws-1', sessionId: 'edit-session' },
      resource: { scope: 'workspace', workspaceId: 'ws-1', kind: 'sources-root' },
      contextKey: 'add-source',
      instructions: 'Connect Linear.',
    })
    expect(wire).toEqual([])

    failTurn(new Error('post-turn cleanup threw'))
    await new Promise(resolve => setTimeout(resolve, 0))
    const toCaller = { to: 'client', clientId: 'client-1' }
    expect(wire).toEqual([
      { step: 'flush', sessionId: 'edit-session', workspaceId: 'ws-1' },
      {
        step: 'push',
        channel: RPC_CHANNELS.sessions.EVENT,
        target: toCaller,
        event: { type: 'error', sessionId: 'edit-session', error: 'post-turn cleanup threw' },
      },
      { step: 'push', channel: RPC_CHANNELS.sessions.EVENT, target: toCaller, event: { type: 'complete', sessionId: 'edit-session' } },
    ])
  })

  it('PREVIEW route returns a markdown preview for a workspace skill', async () => {
    const { deps } = fixture()
    const { handlers } = createHarness(deps)
    const preview = await handlers.get(RPC_CHANNELS.capabilities.PREVIEW)!(ctx(), { workspaceId: 'ws-1' }, {
      scope: 'skill', tier: 'workspace', workspaceId: 'ws-1', skillId: 'myskill', file: 'instructions',
    }) as { content: string }
    expect(preview.content).toContain('Instructions body')
  })

  it('PREVIEW resolves a native global skill from the snapshot binding, not a fixed root', async () => {
    const { deps } = fixture()
    // A bundled/home-style global skill whose SKILL.md lives OUTSIDE the managed
    // globalSkillsDir. The old fixed-path preview returned `not-found` for these;
    // the snapshot binding carries the real location.
    const homeRoot = tmp('cd-home-skills-')
    mkdirSync(join(homeRoot, 'find-skills'), { recursive: true })
    const skillPath = join(homeRoot, 'find-skills', 'SKILL.md')
    writeFileSync(skillPath, '---\nname: find-skills\n---\nHome skill body')
    const record: NativeCapabilitySourceRecord = {
      key: 'skill:global:find-skills',
      kind: 'skill',
      logicalName: 'find-skills',
      scope: { kind: 'global' },
      sourcePath: skillPath,
      revision: String(statSync(skillPath).mtimeMs),
      contentHash: createHash('sha256').update(readFileSync(skillPath)).digest('hex'),
      mutable: false,
    }
    const { handlers } = createHarness(deps, [record])
    const preview = await handlers.get(RPC_CHANNELS.capabilities.PREVIEW)!(ctx(), { workspaceId: 'ws-1' }, {
      scope: 'skill', tier: 'global', skillId: 'find-skills', file: 'instructions',
    }) as { content: string }
    expect(preview.content).toContain('Home skill body')
  })

  it('rejects a project edit ref bound to another session', async () => {
    const { deps } = fixture()
    const { handlers } = createHarness(deps)
    await expect(handlers.get(RPC_CHANNELS.capabilities.SUBMIT_MANAGED_EDIT)!(ctx(), {
      session: { workspaceId: 'ws-1', sessionId: 'edit-session' },
      resource: {
        scope: 'skill', tier: 'project',
        session: { workspaceId: 'ws-1', sessionId: 'other-session' },
        skillId: 'review', file: 'instructions',
      },
      contextKey: 'skill-instructions',
      instructions: 'Change it',
    })).rejects.toThrow('capability-context-workspace-mismatch')
  })
})
