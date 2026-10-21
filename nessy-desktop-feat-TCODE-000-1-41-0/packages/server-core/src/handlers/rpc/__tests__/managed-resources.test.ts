import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ManagedResourceRef, PreviewableManagedResourceRef } from '@nessy-agent/shared/protocol'
import { DOC_REFS } from '@nessy-agent/shared/docs'
import {
  ManagedResourceError,
  previewManagedResource,
  resolveManagedEditContext,
  summarizeManagedResource,
  type ManagedResourceDeps,
} from '../../../domain/capabilities/managed-resources'

const roots: string[] = []

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  roots.push(path)
  return path
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function fixture() {
  const configRoot = temp('managed-config-')
  const workspaceRoot = temp('managed-workspace-')
  const projectRoot = temp('managed-project-')
  const pluginV1 = temp('managed-plugin-v1-')
  const pluginV2 = temp('managed-plugin-v2-')
  const globalSkillsDir = join(configRoot, 'skills')

  write(join(configRoot, 'preferences.json'), JSON.stringify({ notes: 'Concise answers' }))
  write(join(configRoot, 'permissions/default.json'), JSON.stringify({ allowedBashPatterns: ['git status'] }))
  write(join(configRoot, 'tool-icons/tool-icons.json'), JSON.stringify({ tools: [{ id: 'git', token: 'ICON_SECRET' }] }))
  write(join(globalSkillsDir, 'review/SKILL.md'), 'global skill')
  write(join(workspaceRoot, 'skills/review/SKILL.md'), 'workspace skill')
  write(join(projectRoot, '.agents/skills/review/SKILL.md'), 'project skill')
  write(join(pluginV1, 'skills/review/SKILL.md'), 'plugin v1 skill')
  write(join(pluginV2, 'skills/review/SKILL.md'), 'plugin v2 skill')
  write(join(workspaceRoot, 'permissions.json'), '{}')
  write(join(workspaceRoot, 'labels/config.json'), '{}')
  write(join(workspaceRoot, 'statuses/config.json'), '{}')
  write(join(workspaceRoot, 'views.json'), '{}')
  write(join(workspaceRoot, 'automations.json'), JSON.stringify({
    automations: {
      SchedulerTick: [{ cron: '* * * * *', webhook: 'AUTOMATION_WEBHOOK_SECRET', password: 'AUTOMATION_PASSWORD_SECRET' }],
    },
  }))
  write(join(workspaceRoot, 'sources/mcp/config.json'), JSON.stringify({
    name: 'MCP', type: 'mcp', env: { TOKEN: 'MCP_ENV_SECRET' }, headers: { Authorization: 'MCP_HEADER_SECRET' },
  }))

  const deps: ManagedResourceDeps = {
    globalConfigDir: configRoot,
    globalSkillsDir,
    resolveWorkspaceRootPath: id => id === 'ws-1' ? workspaceRoot : undefined,
    resolveProjectRootPath: (workspaceId, sessionId) =>
      workspaceId === 'ws-1' && sessionId === 'session-1' ? projectRoot : undefined,
    resolvePluginSkillResource: (instanceId, capabilityId) => {
      if (capabilityId !== 'review') return undefined
      const bundleRoot = instanceId === 'plugin-v1' ? pluginV1 : instanceId === 'plugin-v2' ? pluginV2 : undefined
      return bundleRoot
        ? { bundleRoot, relativePath: 'skills/review/SKILL.md' }
        : undefined
    },
  }
  return { deps }
}

describe('W9 managed-resource tiers', () => {
  it('previews only the explicit global/workspace allowlist', () => {
    const { deps } = fixture()
    const refs: PreviewableManagedResourceRef[] = [
      { scope: 'global', kind: 'preferences-notes' },
      { scope: 'global', kind: 'default-permissions' },
      { scope: 'workspace', workspaceId: 'ws-1', kind: 'permissions' },
      { scope: 'workspace', workspaceId: 'ws-1', kind: 'labels' },
      { scope: 'workspace', workspaceId: 'ws-1', kind: 'statuses' },
      { scope: 'workspace', workspaceId: 'ws-1', kind: 'views' },
    ]
    for (const ref of refs) expect(previewManagedResource(ref, deps).content).toBeString()

    for (const ref of [
      { scope: 'global', kind: 'tool-icons' },
      { scope: 'workspace', workspaceId: 'ws-1', kind: 'automations' },
      { scope: 'source', workspaceId: 'ws-1', sourceId: 'mcp', file: 'config' },
    ] as ManagedResourceRef[]) {
      expect(() => previewManagedResource(ref as never, deps)).toThrow()
    }
  })

  it('keeps source and automation secrets out of summaries and errors', () => {
    const { deps } = fixture()
    const summaries = [
      summarizeManagedResource({ scope: 'source', workspaceId: 'ws-1', sourceId: 'mcp', file: 'config' }, deps),
      summarizeManagedResource({ scope: 'workspace', workspaceId: 'ws-1', kind: 'automations' }, deps),
      summarizeManagedResource({ scope: 'global', kind: 'tool-icons' }, deps),
    ]
    const json = JSON.stringify(summaries)
    expect(json).not.toMatch(/MCP_ENV_SECRET|MCP_HEADER_SECRET|AUTOMATION_WEBHOOK_SECRET|AUTOMATION_PASSWORD_SECRET|ICON_SECRET/)
    expect(summaries[1]?.fields).toEqual([{ label: 'count', value: '1' }])
  })

  it('resolves all skill tiers and keeps duplicate plugin versions distinct and read-only', () => {
    const { deps } = fixture()
    const refs: PreviewableManagedResourceRef[] = [
      { scope: 'skill', tier: 'global', skillId: 'review', file: 'instructions' },
      { scope: 'skill', tier: 'workspace', workspaceId: 'ws-1', skillId: 'review', file: 'instructions' },
      { scope: 'skill', tier: 'project', session: { workspaceId: 'ws-1', sessionId: 'session-1' }, skillId: 'review', file: 'instructions' },
      { scope: 'skill', tier: 'plugin', pluginInstanceId: 'plugin-v1', capabilityId: 'review', file: 'instructions' },
      { scope: 'skill', tier: 'plugin', pluginInstanceId: 'plugin-v2', capabilityId: 'review', file: 'instructions' },
    ]
    expect(refs.map(ref => previewManagedResource(ref, deps).content)).toEqual([
      'global skill', 'workspace skill', 'project skill', 'plugin v1 skill', 'plugin v2 skill',
    ])
    expect(previewManagedResource(refs[3]!, deps).provenance).toBe('Installed plugin')
    expect(() => resolveManagedEditContext(refs[3]!, 'skill-instructions', deps))
      .toThrow(new ManagedResourceError('not-editable'))
  })

  it('rejects mismatched finite edit contexts', () => {
    const { deps } = fixture()
    expect(() => resolveManagedEditContext(
      { scope: 'workspace', workspaceId: 'ws-1', kind: 'labels' },
      'edit-statuses',
      deps,
    )).toThrow(new ManagedResourceError('invalid-edit-context'))
  })

  it('resolves tool-first guidance for every automation edit context', () => {
    const { deps } = fixture()
    const resource = {
      scope: 'workspace' as const,
      workspaceId: 'ws-1',
      kind: 'automations' as const,
    }

    for (const contextKey of [
      'automation-config',
      'add-automation',
      'add-automation-scheduled',
      'add-automation-event',
      'add-automation-agentic',
    ] as const) {
      const edit = resolveManagedEditContext(resource, contextKey, deps)
      expect(edit.agentGuidance).toContain('automation_')
      expect(edit.agentGuidance).toContain('automation_validate')
      expect(edit.agentGuidance).toContain('Do not edit automations.json directly')
    }
  })

  it('resolves creation guidance for every source kind and skills', () => {
    const { deps } = fixture()
    const sources = { scope: 'workspace' as const, workspaceId: 'ws-1', kind: 'sources-root' as const }
    for (const [contextKey, expected] of [
      ['add-source', 'MCP, REST API, or a local folder'],
      ['add-source-api', 'endpoint URL and authentication type'],
      ['add-source-mcp', 'HTTP/SSE or stdio'],
      ['add-source-local', 'local.path'],
    ] as const) {
      const edit = resolveManagedEditContext(sources, contextKey, deps)
      expect(edit.agentGuidance).toContain(expected)
      expect(edit.agentGuidance).toContain('config.json')
      expect(edit.agentGuidance).toContain('source_test')
    }

    const skill = resolveManagedEditContext(
      { scope: 'workspace', workspaceId: 'ws-1', kind: 'skills-root' },
      'add-skill',
      deps,
    )

    expect(skill.agentGuidance).toContain('skill-creator')
    expect(skill.agentGuidance).toContain('SKILL.md')
    expect(skill.agentGuidance).toContain('skill_validate')
  })

  // F1.432 — the EditPopover's own `context` text never reaches the agent
  // (getManagedEditConfig drops it; SUBMIT_MANAGED_EDIT sends only the
  // instructions plus this guidance), so F1.246's "Local Sources" pointer has to
  // live HERE to be read at all — through DOC_REFS.sources, which honours
  // NESSY_CONFIG_DIR.
  it('the add-source-local guidance points at the Local Sources section of the docs the app ships', () => {
    const { deps } = fixture()
    const sources = { scope: 'workspace' as const, workspaceId: 'ws-1', kind: 'sources-root' as const }
    const local = resolveManagedEditContext(sources, 'add-source-local', deps)
    expect(local.agentGuidance).toContain(DOC_REFS.sources)
    expect(local.agentGuidance).toContain('Local Sources')
    // Negative: the pointer is the local branch's, not every source kind's.
    const api = resolveManagedEditContext(sources, 'add-source-api', deps)
    expect(api.agentGuidance).not.toContain('Local Sources')
  })

  // F1.460 (8) — F1.246 guarded EditPopover and the bundled sources.md against
  // the dead `SearchNessyDocs` tool, and neither is what the agent receives: a
  // managed add-source popover sends the user's instructions plus THIS guidance.
  // So the guard reads the guidance as resolved, for every add-source key.
  it('no add-source guidance names SearchNessyDocs or the nessy-docs server', () => {
    const { deps } = fixture()
    const sources = { scope: 'workspace' as const, workspaceId: 'ws-1', kind: 'sources-root' as const }
    for (const contextKey of ['add-source', 'add-source-api', 'add-source-mcp', 'add-source-local'] as const) {
      const edit = resolveManagedEditContext(sources, contextKey, deps)
      // Positive control on the same value: the guidance is the real one, not empty.
      expect(edit.agentGuidance).toContain('source_test')
      expect(edit.agentGuidance).not.toContain('SearchNessyDocs')
      expect(edit.agentGuidance).not.toContain('mcp__nessy-docs__')
    }
  })
})

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
