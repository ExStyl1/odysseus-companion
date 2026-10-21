import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectTrustStore } from '@nessy-agent/shared/capabilities/project-trust-store'
import {
  createCapabilityResolver,
  type CapabilityContext,
  type CapabilityResolutionInputs,
  type CapabilityResolver,
  type EffectiveCapabilitySnapshot,
  type InstalledPluginInput,
} from '@nessy-agent/shared/capabilities/resolver'
import { computeNormalizedBundleHash } from '@nessy-agent/shared/plugins/bundle-hash'
import { resolvePluginProjectionCandidates } from '@nessy-agent/shared/plugins/projection-candidates'
import { ProjectHandleService } from '@nessy-agent/shared/projects/project-handle-service'
import {
  pluginPromptCommandId,
  pluginWorkflowCommandId,
  skillSlashCommandId,
  workflowSlashCommandId,
} from '@nessy-agent/shared/slash-commands'
import { createManagedSession } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'nessy-custom-command-boundary-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  const projectRoot = join(root, 'project')
  mkdirSync(join(workspaceRoot, '.nessy-agent', 'commands'), { recursive: true })
  mkdirSync(join(projectRoot, '.nessy-agent', 'commands'), { recursive: true })
  writeFileSync(join(workspaceRoot, '.nessy-agent', 'commands', 'review.md'), 'Workspace command body')
  writeFileSync(join(projectRoot, '.nessy-agent', 'commands', 'review.md'), [
    '---',
    'description: Project review',
    'model: tgpt/reviewer',
    '---',
    'distinctive-project-command-body',
  ].join('\n'))

  const handles = new ProjectHandleService({
    trustStore: new ProjectTrustStore({ path: join(root, 'project-trust.json') }),
    managedRootPaths: [workspaceRoot],
    newId: () => 'project-handle',
  })
  const manager = createTestSessionManager({ projectHandleService: handles })
  const managed = createManagedSession({ id: 'session-a' }, {
    id: 'workspace-a',
    name: 'Workspace A',
    rootPath: workspaceRoot,
    createdAt: 1,
  }, {
    messagesLoaded: true,
    ephemeral: true,
    workingDirectory: projectRoot,
  })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
    'workspace-a:session-a',
    managed,
  )
  return { manager, handles, projectRoot }
}

describe('SessionManager custom slash command boundary', () => {
  it('lists and resolves a trusted saved workflow through the production slash registry', async () => {
    const { manager, handles, projectRoot } = fixture()
    const session = { workspaceId: 'workspace-a', sessionId: 'session-a' }
    mkdirSync(join(projectRoot, '.nessy-agent', 'workflows'), { recursive: true })
    writeFileSync(join(projectRoot, '.nessy-agent', 'workflows', 'audit.js'), [
      "export const meta = { name: 'audit-routes', description: 'Audit routes' }",
      "return agent({ agent: 'scout', task: args.input });",
    ].join('\n'))

    try {
      const handle = await handles.validateProjectDirectory(session.workspaceId, projectRoot)
      expect(await manager.listCustomSlashCommandSummaries(session)).not.toContainEqual(
        expect.objectContaining({ id: workflowSlashCommandId('audit-routes') }),
      )
      await handles.setProjectTrust({ workspaceId: session.workspaceId, projectHandleId: handle.id }, 'trusted')

      const summaries = await manager.listCustomSlashCommandSummaries(session)
      expect(summaries).toContainEqual({
        id: workflowSlashCommandId('audit-routes'),
        name: 'audit-routes',
        label: '/audit-routes',
        description: 'Audit routes',
      })

      const resolved = await manager.resolveCustomSlashCommand(
        session,
        workflowSlashCommandId('audit-routes'),
      )
      expect(resolved).toMatchObject({
        label: '/audit-routes',
        source: 'workflow',
        path: expect.stringContaining(join('.nessy-agent', 'workflows', 'audit.js')),
      })
      expect(resolved?.body).toContain('[workflow:audit-routes]')
    } finally {
      manager.cleanup()
    }
  })

  // workflows.md §Turn workflows off: "When workflows are disabled, the bundled
  // workflow commands are unavailable". Nessy ships no bundled workflows, so
  // the equivalent surface is every workflow-derived command in the registry —
  // and the managed tier is the one an organization actually sets.
  it('removes saved workflow commands from the registry when managed policy disables workflows', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nessy-workflow-off-switch-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const projectRoot = join(root, 'project')
    mkdirSync(join(workspaceRoot, '.nessy-agent', 'commands'), { recursive: true })
    writeFileSync(join(workspaceRoot, '.nessy-agent', 'commands', 'review.md'), 'Workspace command body')
    mkdirSync(join(projectRoot, '.nessy-agent', 'workflows'), { recursive: true })
    writeFileSync(join(projectRoot, '.nessy-agent', 'workflows', 'audit.js'), [
      "export const meta = { name: 'audit-routes', description: 'Audit routes' }",
      "return agent({ agent: 'scout', task: args.input });",
    ].join('\n'))

    const handles = new ProjectHandleService({
      trustStore: new ProjectTrustStore({ path: join(root, 'project-trust.json') }),
      managedRootPaths: [workspaceRoot],
      newId: () => 'project-handle',
    })
    const manager = createTestSessionManager({
      projectHandleService: handles,
      managedPiPolicy: {
        schemaVersion: 1,
        disabledPermissionModes: [],
        workflow: { disableWorkflows: true },
      },
    })
    const managed = createManagedSession({ id: 'session-a' }, {
      id: 'workspace-a',
      name: 'Workspace A',
      rootPath: workspaceRoot,
      createdAt: 1,
    }, { messagesLoaded: true, ephemeral: true, workingDirectory: projectRoot })
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
      'workspace-a:session-a',
      managed,
    )
    const session = { workspaceId: 'workspace-a', sessionId: 'session-a' }

    try {
      const handle = await handles.validateProjectDirectory(session.workspaceId, projectRoot)
      await handles.setProjectTrust({ workspaceId: session.workspaceId, projectHandleId: handle.id }, 'trusted')

      const summaries = await manager.listCustomSlashCommandSummaries(session)
      expect(summaries).not.toContainEqual(
        expect.objectContaining({ id: workflowSlashCommandId('audit-routes') }),
      )
      // Ordinary commands are untouched — this is a workflow switch only.
      expect(summaries).toContainEqual(expect.objectContaining({ id: 'custom:review' }))
      expect(await manager.resolveCustomSlashCommand(
        session,
        workflowSlashCommandId('audit-routes'),
      )).toBeNull()
    } finally {
      manager.cleanup()
    }
  })

  it('returns metadata only and includes project commands only after current project trust', async () => {
    const { manager, handles, projectRoot } = fixture()
    const session = { workspaceId: 'workspace-a', sessionId: 'session-a' }

    try {
      const untrusted = await manager.listCustomSlashCommandSummaries(session)
      expect(untrusted).toEqual([{
        id: 'custom:review',
        name: 'review',
        label: '/review',
        description: 'Workspace command body',
      }])

      const handle = await handles.validateProjectDirectory(session.workspaceId, projectRoot)
      await handles.setProjectTrust({ workspaceId: session.workspaceId, projectHandleId: handle.id }, 'trusted')

      const trusted = await manager.listCustomSlashCommandSummaries(session)
      expect(trusted).toEqual([{
        id: 'custom:review',
        name: 'review',
        label: '/review',
        description: 'Project review',
        model: 'tgpt/reviewer',
      }])
      expect(JSON.stringify(trusted)).not.toContain('distinctive-project-command-body')
      expect(JSON.stringify(trusted)).not.toContain(projectRoot)

      const resolved = await manager.resolveCustomSlashCommand(session, 'custom:review')
      expect(resolved?.body).toBe('distinctive-project-command-body')
      expect(resolved?.path).toContain(projectRoot)
    } finally {
      manager.cleanup()
    }
  })

  /**
   * One body for both plugin prompt-command cases: the ONLY difference between
   * them is whether the resolver's binding carries an `argumentHint` (P6.406),
   * so the summary shape is asserted by the caller.
   */
  const runPluginPromptCommandCase = async (
    argumentHint: string | undefined,
    check: (summary: Record<string, unknown>) => void,
  ): Promise<void> => {
    const root = mkdtempSync(join(tmpdir(), 'nessy-plugin-command-boundary-'))
    roots.push(root)
    const bundleRoot = join(root, 'bundle')
    mkdirSync(join(bundleRoot, 'commands'), { recursive: true })
    writeFileSync(join(bundleRoot, 'commands', 'summarize.md'), 'distinctive-plugin-command-body')
    const bundleHash = await computeNormalizedBundleHash(bundleRoot)

    const pluginInstanceId = `plugin://local/helper@1.0.0#${'a'.repeat(64)}`
    const pluginKey = 'bWFya2V0.aGVscGVy'
    let released = 0
    const resolver: CapabilityResolver = {
      resolve: async (context: CapabilityContext): Promise<EffectiveCapabilitySnapshot> => ({
        context,
        generation: 'gen-plugin-command',
        leaseId: 'lease-plugin-command',
        entries: [{
          summary: {
            key: `${pluginInstanceId}#c-prompt`,
            kind: 'prompt-command',
            logicalName: 'summarize',
            origin: 'plugin',
            pluginKey,
            pluginInstanceId,
            capabilityId: 'c-prompt',
            scope: { kind: 'global' },
            enabled: true,
            selectedAsUnqualifiedAlias: false,
            readOnly: true,
            trustState: 'not-required',
            credentialState: 'not-required',
            diagnostics: [],
          },
          runtimeBinding: {
            kind: 'prompt-command',
            promptCommand: {
              key: `${pluginInstanceId}#c-prompt`,
              resource: { pluginInstanceId, relativePath: 'commands/summarize.md', contentHash: 'b'.repeat(64) },
              pluginInstanceId,
              ...(argumentHint ? { argumentHint } : {}),
            },
          },
        }],
        installedPlugins: [{
          pluginKey,
          activeInstanceId: pluginInstanceId,
          origin: { marketplaceId: 'local', pluginId: 'helper' },
          name: 'Linear Helper',
          version: '1.0.0',
          installedAt: 1,
          lifecycleState: 'ready',
          activationEnabled: true,
          capabilityKinds: ['prompt-command'],
          bundleHash,
          bundleRootPath: bundleRoot,
        }],
        diagnostics: [],
      }),
      releaseSnapshot: () => { released += 1 },
      invalidate: () => undefined,
      isLeaseActive: () => true,
      referencedInstances: () => new Set(),
      leaseCount: () => 0,
    }

    const handles = new ProjectHandleService({
      trustStore: new ProjectTrustStore({ path: join(root, 'project-trust.json') }),
    })
    const manager = createTestSessionManager({ resolver, projectHandleService: handles })
    const managed = createManagedSession({ id: 'session-a' }, {
      id: 'workspace-a',
      name: 'Workspace A',
      rootPath: join(root, 'workspace'),
      createdAt: 1,
    }, { messagesLoaded: true, ephemeral: true })
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set('workspace-a:session-a', managed)
    const session = { workspaceId: 'workspace-a', sessionId: 'session-a' }

    try {
      const expectedId = pluginPromptCommandId(pluginKey, 'summarize')
      const summaries = await manager.listCustomSlashCommandSummaries(session)
      expect(summaries).toHaveLength(1)
      check(summaries[0] as unknown as Record<string, unknown>)

      const resolvedBefore = released
      const resolvedCommand = await manager.resolveCustomSlashCommand(session, expectedId)
      expect(resolvedCommand?.body).toBe('distinctive-plugin-command-body')
      expect(resolvedCommand?.source).toBe('plugin')
      // The fresh snapshot's lease is released after materializing the body.
      expect(released).toBeGreaterThan(resolvedBefore)
    } finally {
      manager.cleanup()
    }
  }

  it('merges runnable plugin prompt-command summaries with namespaced ids, and resolves+releases a fresh lease', async () => {
    await runPluginPromptCommandCase(undefined, summary => {
      // A binding with no hint contributes NONE, rather than an empty string a
      // surface would draw as a blank bracket.
      expect(summary).toEqual({
        id: pluginPromptCommandId('bWFya2V0.aGVscGVy', 'summarize'),
        name: 'summarize',
        label: '/linear-helper:summarize',
      })
    })
  })

  it('P6.406 — the hint the resolver already produced reaches the composer summary', async () => {
    await runPluginPromptCommandCase('[issue-url]', summary => {
      expect(summary.argumentHint).toBe('[issue-url]')
      // Nothing else moved: the id/name/label contract is untouched.
      expect(summary.name).toBe('summarize')
      expect(summary.label).toBe('/linear-helper:summarize')
    })
  })

  it('lists and resolves a plugin workflow only after the real resolver grants its exact hash', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nessy-plugin-workflow-boundary-'))
    roots.push(root)
    const bundleRoot = join(root, 'bundle')
    mkdirSync(join(bundleRoot, 'workflows'), { recursive: true })
    writeFileSync(join(bundleRoot, 'workflows', 'release.js'), [
      "export const meta = { name: 'release-audit', description: 'Audit a release' }",
      "return agent({ agent: 'scout', task: args.input });",
    ].join('\n'))
    const bundleHash = await computeNormalizedBundleHash(bundleRoot)
    const pluginInstanceId = `plugin://local/helper@1.0.0#${bundleHash}`
    const pluginKey = 'bWFya2V0.aGVscGVy'
    const installed: InstalledPluginInput = {
      pluginInstanceId,
      pluginKey,
      marketplaceId: 'local',
      pluginId: 'helper',
      version: '1.0.0',
      bundleHash,
      cacheRef: { marketplaceId: 'local', pluginId: 'helper', version: '1.0.0', bundleHash },
      manifest: {
        schemaVersion: 1,
        kind: 'plugin',
        id: 'helper',
        name: 'Linear Helper',
        version: '1.0.0',
        capabilities: [{
          id: 'workflow-release',
          kind: 'workflow',
          workflow: { name: 'release-audit', path: 'workflows/release.js' },
        }],
      },
      origin: { source: 'marketplace', resolvedAt: 0 },
      installedAt: 1,
      diagnostics: [],
    }
    const candidates = resolvePluginProjectionCandidates([installed], { kind: 'global' })
    let trusted = false
    const trustRequests: unknown[] = []
    const inputs = (): CapabilityResolutionInputs => ({
      nativeInventory: { records: [], blockedLayers: [] },
      installedPlugins: [installed],
      activePluginInstances: { [pluginKey]: pluginInstanceId },
      pluginCandidates: candidates,
      resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
      resolveTrust: key => {
        trustRequests.push(key)
        return trusted ? 'trusted' : 'review-required'
      },
      pluginRuntimeContextFor: () => ({
        rootPath: bundleRoot,
        dataPath: join(root, 'data'),
        profile: 'generic-plugin-env-v1',
      }),
    })
    const resolver = createCapabilityResolver({ inputs })
    const manager = createTestSessionManager({
      resolver,
      projectHandleService: new ProjectHandleService({
        trustStore: new ProjectTrustStore({ path: join(root, 'project-trust.json') }),
      }),
    })
    const managed = createManagedSession({ id: 'session-a' }, {
      id: 'workspace-a',
      name: 'Workspace A',
      rootPath: join(root, 'workspace'),
      createdAt: 1,
    }, { messagesLoaded: true, ephemeral: true })
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
      'workspace-a:session-a',
      managed,
    )
    const session = { workspaceId: 'workspace-a', sessionId: 'session-a' }

    try {
      const id = pluginWorkflowCommandId(pluginKey, 'release-audit')
      expect(await manager.listCustomSlashCommandSummaries(session)).not.toContainEqual(
        expect.objectContaining({ id }),
      )
      expect(await manager.resolveCustomSlashCommand(session, id)).toBeNull()

      trusted = true
      expect(await manager.listCustomSlashCommandSummaries(session)).toContainEqual({
        id,
        name: 'release-audit',
        label: '/linear-helper:release-audit',
        description: 'Audit a release',
      })
      const resolved = await manager.resolveCustomSlashCommand(session, id)
      expect(resolved?.body).toContain('[workflow:linear-helper:release-audit]')
      expect(resolved?.source).toBe('workflow')
      expect(resolved?.workflowInvocation?.script).toContain("agent({ agent: 'scout'")
      expect(trustRequests).toContainEqual({
        pluginInstanceId,
        capabilityId: 'workflow-release',
        executableHash: candidates[0]?.trust.executableHash,
        scope: { kind: 'global' },
      })

      // Same trusted plugin, same resolver, workflows off: the plugin workflow
      // is a workflow command like any other, so it leaves the registry too.
      const disabled = createTestSessionManager({
        resolver,
        projectHandleService: new ProjectHandleService({
          trustStore: new ProjectTrustStore({ path: join(root, 'project-trust-off.json') }),
        }),
        managedPiPolicy: {
          schemaVersion: 1,
          disabledPermissionModes: [],
          workflow: { disableWorkflows: true },
        },
      })
      ;(disabled as unknown as { sessions: Map<string, unknown> }).sessions.set(
        'workspace-a:session-a',
        createManagedSession({ id: 'session-a' }, {
          id: 'workspace-a',
          name: 'Workspace A',
          rootPath: join(root, 'workspace'),
          createdAt: 1,
        }, { messagesLoaded: true, ephemeral: true }),
      )
      try {
        expect(await disabled.listCustomSlashCommandSummaries(session)).not.toContainEqual(
          expect.objectContaining({ id }),
        )
        expect(await disabled.resolveCustomSlashCommand(session, id)).toBeNull()
      } finally {
        disabled.cleanup()
      }
    } finally {
      manager.cleanup()
    }
  })

  it('rejects a plugin workflow whose projected name drifts from parsed metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nessy-plugin-workflow-drift-'))
    roots.push(root)
    const bundleRoot = join(root, 'bundle')
    mkdirSync(join(bundleRoot, 'workflows'), { recursive: true })
    writeFileSync(join(bundleRoot, 'workflows', 'release.js'), [
      "export const meta = { name: 'actual-name', description: 'Actual' }",
      "return 'never-listed';",
    ].join('\n'))
    const bundleHash = await computeNormalizedBundleHash(bundleRoot)
    const pluginInstanceId = `plugin://local/helper@1.0.0#${bundleHash}`
    const pluginKey = 'bWFya2V0.ZHJpZnQ'
    const installed: InstalledPluginInput = {
      pluginInstanceId,
      pluginKey,
      marketplaceId: 'local',
      pluginId: 'helper',
      version: '1.0.0',
      bundleHash,
      cacheRef: { marketplaceId: 'local', pluginId: 'helper', version: '1.0.0', bundleHash },
      manifest: {
        schemaVersion: 1,
        kind: 'plugin',
        id: 'helper',
        name: 'Linear Helper',
        version: '1.0.0',
        capabilities: [{
          id: 'workflow-release',
          kind: 'workflow',
          workflow: { name: 'summary-name', path: 'workflows/release.js' },
        }],
      },
      origin: { source: 'marketplace', resolvedAt: 0 },
      installedAt: 1,
      diagnostics: [],
    }
    const resolver = createCapabilityResolver({
      inputs: () => ({
        nativeInventory: { records: [], blockedLayers: [] },
        installedPlugins: [installed],
        activePluginInstances: { [pluginKey]: pluginInstanceId },
        pluginCandidates: resolvePluginProjectionCandidates([installed], { kind: 'global' }),
        resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
        resolveTrust: () => 'trusted',
        pluginRuntimeContextFor: () => ({
          rootPath: bundleRoot,
          dataPath: join(root, 'data'),
          profile: 'generic-plugin-env-v1',
        }),
      }),
    })
    const manager = createTestSessionManager({ resolver })
    const managed = createManagedSession({ id: 'session-a' }, {
      id: 'workspace-a',
      name: 'Workspace A',
      rootPath: join(root, 'workspace'),
      createdAt: 1,
    }, { messagesLoaded: true, ephemeral: true })
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
      'workspace-a:session-a',
      managed,
    )
    const session = { workspaceId: 'workspace-a', sessionId: 'session-a' }
    try {
      expect(await manager.listCustomSlashCommandSummaries(session)).toEqual([])
      expect(await manager.resolveCustomSlashCommand(
        session,
        pluginWorkflowCommandId(pluginKey, 'summary-name'),
      )).toBeNull()
      expect(await manager.resolveCustomSlashCommand(
        session,
        pluginWorkflowCommandId(pluginKey, 'actual-name'),
      )).toBeNull()
    } finally {
      manager.cleanup()
    }
  })

  it('registers a /slug per user-invocable skill, skips user-invocable: false, and lets the SKILL win a shared name', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nessy-skill-command-boundary-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    mkdirSync(join(workspaceRoot, '.nessy-agent', 'commands'), { recursive: true })
    // An explicit command file with the same bare name as a skill.
    writeFileSync(join(workspaceRoot, '.nessy-agent', 'commands', 'review.md'), 'explicit-command-body')

    const skillEntry = (logicalName: string, over: Record<string, unknown> = {}) => ({
      summary: {
        key: `skill:ws:${logicalName}`,
        kind: 'skill' as const,
        logicalName,
        description: `${logicalName} description`,
        origin: 'native' as const,
        scope: { kind: 'workspace' as const, workspaceId: 'workspace-a' },
        enabled: true,
        selectedAsUnqualifiedAlias: true,
        readOnly: false,
        trustState: 'not-required' as const,
        credentialState: 'not-required' as const,
        diagnostics: [],
        ...over,
      },
      runtimeBinding: {
        kind: 'skill' as const,
        resource: {
          source: 'workspace' as const,
          scope: { kind: 'workspace' as const, workspaceId: 'workspace-a' },
          resourceId: logicalName,
          absolutePath: `/private/${logicalName}/SKILL.md`,
          revision: 'r1',
          contentHash: 'a'.repeat(64),
        },
      },
    })

    let released = 0
    const resolver: CapabilityResolver = {
      resolve: async (context: CapabilityContext): Promise<EffectiveCapabilitySnapshot> => ({
        context,
        generation: 'gen-skill-command',
        leaseId: 'lease-skill-command',
        entries: [
          skillEntry('deploy'),
          skillEntry('internal', { skillUserInvocable: false }),
          skillEntry('review'),
        ] as unknown as EffectiveCapabilitySnapshot['entries'],
        installedPlugins: [],
        diagnostics: [],
      }),
      releaseSnapshot: () => { released += 1 },
      invalidate: () => undefined,
      isLeaseActive: () => true,
      referencedInstances: () => new Set(),
      leaseCount: () => 0,
    }

    const handles = new ProjectHandleService({
      trustStore: new ProjectTrustStore({ path: join(root, 'project-trust.json') }),
      managedRootPaths: [workspaceRoot],
    })
    const manager = createTestSessionManager({ resolver, projectHandleService: handles })
    const managed = createManagedSession({ id: 'session-a' }, {
      id: 'workspace-a',
      name: 'Workspace A',
      rootPath: workspaceRoot,
      createdAt: 1,
    }, { messagesLoaded: true, ephemeral: true })
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set('workspace-a:session-a', managed)
    const session = { workspaceId: 'workspace-a', sessionId: 'session-a' }

    try {
      const summaries = await manager.listCustomSlashCommandSummaries(session)

      // `deploy` registers; `internal` is user-invocable: false so it does not;
      // `review` WINS the bare name over the command file (R75 · f144).
      // `skills.md:122` / `slash-commands.md:122`, whole line: "…but if a skill
      // and a command share a name, the skill takes precedence."
      //
      // Exactly ONE `/review` row: the assertion that matters most here, because
      // the renderer's typed dispatch matches by label with `find` over this
      // array and native rows come first — two rows would still have run the
      // command file, i.e. the bug with an extra menu entry.
      expect(summaries.map(command => command.id)).toEqual([
        skillSlashCommandId('deploy'),
        skillSlashCommandId('review'),
      ])
      expect(summaries.filter(command => command.label === '/review')).toHaveLength(1)
      expect(JSON.stringify(summaries)).not.toContain('internal')
      // Bodies and paths never reach the composer summary.
      expect(JSON.stringify(summaries)).not.toContain('[skill:')
      expect(JSON.stringify(summaries)).not.toContain('/private/')

      const resolvedBefore = released
      const resolved = await manager.resolveCustomSlashCommand(session, skillSlashCommandId('deploy'))
      // The body is the marker the ordinary user-invocation path already handles.
      expect(resolved?.body).toBe('[skill:deploy] $ARGUMENTS')
      expect(resolved?.source).toBe('skill')
      expect(released).toBeGreaterThan(resolvedBefore)

      // The end of the wire: the one `/review` row the menu shows resolves to
      // the SKILL, not to `explicit-command-body`. Precedence that only reorders
      // a listing would still run the command file.
      const resolvedReview = await manager.resolveCustomSlashCommand(session, skillSlashCommandId('review'))
      expect(resolvedReview?.body).toBe('[skill:review] $ARGUMENTS')
      expect(resolvedReview?.source).toBe('skill')

      // The shadowed command file keeps its own id resolvable: the native lookup
      // short-circuits before any capability snapshot, and making it fail would
      // mean resolving one on every native resolution. Listing-side shadowing is
      // what the doc sentence asks for, and nothing in the UI mints this id any
      // more.
      const shadowed = await manager.resolveCustomSlashCommand(session, 'custom:review')
      expect(shadowed?.body).toBe('explicit-command-body')

      // A skill hidden from the menu is not resolvable through it either.
      expect(await manager.resolveCustomSlashCommand(session, skillSlashCommandId('internal'))).toBeNull()
    } finally {
      manager.cleanup()
    }
  })

  it('keeps a workflow recipe that shares a name with a skill', async () => {
    // The negative half of the case above. No Claude page rules on
    // skill-vs-workflow — `skills.md:122` names commands only — so a workflow
    // recipe stays reserved and the skill yields, which is the behaviour that
    // was already there. Without this, "the skill takes precedence" would have
    // been widened past the sentence that licenses it.
    const root = mkdtempSync(join(tmpdir(), 'nessy-skill-workflow-collision-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const projectRoot = join(root, 'project')
    mkdirSync(join(projectRoot, '.nessy-agent', 'workflows'), { recursive: true })
    writeFileSync(join(projectRoot, '.nessy-agent', 'workflows', 'audit.js'), [
      "export const meta = { name: 'audit-routes', description: 'Audit routes' }",
      "return agent({ agent: 'scout', task: args.input });",
    ].join('\n'))

    const resolver: CapabilityResolver = {
      resolve: async (context: CapabilityContext): Promise<EffectiveCapabilitySnapshot> => ({
        context,
        generation: 'gen-skill-workflow',
        leaseId: 'lease-skill-workflow',
        entries: [{
          summary: {
            key: 'skill:ws:audit-routes',
            kind: 'skill' as const,
            logicalName: 'audit-routes',
            description: 'audit-routes description',
            origin: 'native' as const,
            scope: { kind: 'workspace' as const, workspaceId: 'workspace-a' },
            enabled: true,
            selectedAsUnqualifiedAlias: true,
            readOnly: false,
            trustState: 'not-required' as const,
            credentialState: 'not-required' as const,
            diagnostics: [],
          },
          runtimeBinding: {
            kind: 'skill' as const,
            resource: {
              source: 'workspace' as const,
              scope: { kind: 'workspace' as const, workspaceId: 'workspace-a' },
              resourceId: 'audit-routes',
              absolutePath: '/private/audit-routes/SKILL.md',
              revision: 'r1',
              contentHash: 'a'.repeat(64),
            },
          },
        }] as unknown as EffectiveCapabilitySnapshot['entries'],
        installedPlugins: [],
        diagnostics: [],
      }),
      releaseSnapshot: () => undefined,
      invalidate: () => undefined,
      isLeaseActive: () => true,
      referencedInstances: () => new Set(),
      leaseCount: () => 0,
    }

    const handles = new ProjectHandleService({
      trustStore: new ProjectTrustStore({ path: join(root, 'project-trust.json') }),
      managedRootPaths: [workspaceRoot],
    })
    const manager = createTestSessionManager({ resolver, projectHandleService: handles })
    const managed = createManagedSession({ id: 'session-a' }, {
      id: 'workspace-a',
      name: 'Workspace A',
      rootPath: workspaceRoot,
      createdAt: 1,
    }, { messagesLoaded: true, ephemeral: true, workingDirectory: projectRoot })
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set('workspace-a:session-a', managed)
    const session = { workspaceId: 'workspace-a', sessionId: 'session-a' }

    try {
      const handle = await handles.validateProjectDirectory(session.workspaceId, projectRoot)
      await handles.setProjectTrust({ workspaceId: session.workspaceId, projectHandleId: handle.id }, 'trusted')

      const summaries = await manager.listCustomSlashCommandSummaries(session)
      expect(summaries.map(command => command.id)).toEqual([workflowSlashCommandId('audit-routes')])
      expect(summaries).not.toContainEqual(
        expect.objectContaining({ id: skillSlashCommandId('audit-routes') }),
      )
    } finally {
      manager.cleanup()
    }
  })

  it('drops a skillOverrides "off" skill from the command list the RPC advertises', async () => {
    // `skills.md:676` — as of v2.1.199 `"off"` hides the skill from "the command
    // lists advertised to Remote Control clients and to Agent SDK callers, not
    // only the terminal `/` menu". In this fork those collapse to ONE surface:
    // `listCustomSlashCommandSummaries` is what `workspace:listCustomSlashCommands`
    // serves to the Electron renderer and to every remote websocket client
    // alike, so proving it here proves the whole sentence.
    const root = mkdtempSync(join(tmpdir(), 'nessy-skill-override-command-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    mkdirSync(workspaceRoot, { recursive: true })

    const skillEntry = (logicalName: string, over: Record<string, unknown> = {}) => ({
      summary: {
        key: `skill:ws:${logicalName}`,
        kind: 'skill' as const,
        logicalName,
        description: `${logicalName} description`,
        origin: 'native' as const,
        scope: { kind: 'workspace' as const, workspaceId: 'workspace-a' },
        enabled: true,
        selectedAsUnqualifiedAlias: true,
        readOnly: false,
        trustState: 'not-required' as const,
        credentialState: 'not-required' as const,
        diagnostics: [],
        ...over,
      },
      runtimeBinding: {
        kind: 'skill' as const,
        resource: {
          source: 'workspace' as const,
          scope: { kind: 'workspace' as const, workspaceId: 'workspace-a' },
          resourceId: logicalName,
          absolutePath: `/private/${logicalName}/SKILL.md`,
          revision: 'r1',
          contentHash: 'a'.repeat(64),
        },
      },
    })

    const resolver: CapabilityResolver = {
      resolve: async (context: CapabilityContext): Promise<EffectiveCapabilitySnapshot> => ({
        context,
        generation: 'gen-skill-override',
        leaseId: 'lease-skill-override',
        entries: [
          skillEntry('hidden', { skillOverrideState: 'off' }),
          skillEntry('trimmed', { skillOverrideState: 'name-only' }),
          skillEntry('useronly', { skillOverrideState: 'user-invocable-only' }),
        ] as unknown as EffectiveCapabilitySnapshot['entries'],
        installedPlugins: [],
        diagnostics: [],
      }),
      releaseSnapshot: () => undefined,
      invalidate: () => undefined,
      isLeaseActive: () => true,
      referencedInstances: () => new Set(),
      leaseCount: () => 0,
    }

    const handles = new ProjectHandleService({
      trustStore: new ProjectTrustStore({ path: join(root, 'project-trust.json') }),
      managedRootPaths: [workspaceRoot],
    })
    const manager = createTestSessionManager({ resolver, projectHandleService: handles })
    const managed = createManagedSession({ id: 'session-a' }, {
      id: 'workspace-a',
      name: 'Workspace A',
      rootPath: workspaceRoot,
      createdAt: 1,
    }, { messagesLoaded: true, ephemeral: true })
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set('workspace-a:session-a', managed)
    const session = { workspaceId: 'workspace-a', sessionId: 'session-a' }

    try {
      const summaries = await manager.listCustomSlashCommandSummaries(session)

      // Only `off` is hidden; the other two states keep their `/` entry, and
      // `name-only` keeps its description here — that state trims the MODEL's
      // listing, not this one (`skills.md:667`-`:672`).
      expect(summaries.map(command => command.id)).toEqual([
        skillSlashCommandId('trimmed'),
        skillSlashCommandId('useronly'),
      ])
      expect(JSON.stringify(summaries)).not.toContain('hidden')
      expect(summaries.find(command => command.name === 'trimmed')?.description).toBe('trimmed description')

      // And it is not reachable by id either, or the hide would be cosmetic.
      expect(await manager.resolveCustomSlashCommand(session, skillSlashCommandId('hidden'))).toBeNull()
    } finally {
      manager.cleanup()
    }
  })
})
