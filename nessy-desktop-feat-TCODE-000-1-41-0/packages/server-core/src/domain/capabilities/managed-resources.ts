import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  getWorkspaceSkillsPath,
  getWorkspaceSourcesPath,
  resolveContainedPath,
} from '@nessy-agent/shared/workspaces'
import { DOC_REFS } from '@nessy-agent/shared/docs'
import type {
  ManagedEditContextKey,
  ManagedResourcePreview,
  ManagedResourceRef,
  PreviewableManagedResourceRef,
  SafeManagedResourceSummary,
} from '@nessy-agent/shared/protocol'

export type ManagedResourceErrorCode =
  | 'unsupported-ref'
  | 'not-found'
  | 'not-previewable'
  | 'not-editable'
  | 'invalid-edit-context'
  | 'workspace-not-found'

export class ManagedResourceError extends Error {
  override readonly name = 'ManagedResourceError'
  constructor(readonly code: ManagedResourceErrorCode, message?: string) {
    super(message ?? code)
  }
}

export interface PluginSkillResourceLocation {
  bundleRoot: string
  relativePath: string
}

export interface ManagedResourceDeps {
  resolveWorkspaceRootPath: (workspaceId: string) => string | undefined
  resolveProjectRootPath?: (workspaceId: string, sessionId: string) => string | undefined
  resolvePluginSkillResource?: (
    pluginInstanceId: string,
    capabilityId: string,
    file: 'manifest' | 'instructions',
  ) => PluginSkillResourceLocation | undefined
  globalConfigDir: string
  globalSkillsDir: string
}

export interface ResolvedManagedResource {
  absolutePath: string
  title: string
  contentType: 'text' | 'markdown'
  previewable: boolean
  editable: boolean
  provenance?: string
}

function workspaceRootOrThrow(deps: ManagedResourceDeps, workspaceId: string): string {
  const root = deps.resolveWorkspaceRootPath(workspaceId)
  if (!root) throw new ManagedResourceError('workspace-not-found')
  return root
}

export function resolveManagedResource(
  ref: ManagedResourceRef,
  deps: ManagedResourceDeps,
): ResolvedManagedResource {
  if (ref.scope === 'global') {
    const paths = {
      'preferences-notes': ['preferences.json', true],
      'tool-icons': ['tool-icons/tool-icons.json', false],
      'default-permissions': ['permissions/default.json', true],
    } as const
    const [relativePath, previewable] = paths[ref.kind]
    return {
      absolutePath: resolveContainedPath(deps.globalConfigDir, relativePath),
      title: ref.kind,
      contentType: 'text',
      previewable,
      editable: true,
    }
  }

  if (ref.scope === 'workspace') {
    const root = workspaceRootOrThrow(deps, ref.workspaceId)
    const paths = {
      permissions: ['permissions.json', true],
      labels: ['labels/config.json', true],
      statuses: ['statuses/config.json', true],
      views: ['views.json', true],
      automations: ['automations.json', false],
      'sources-root': ['sources', false],
      'skills-root': ['skills', false],
    } as const
    const [relativePath, previewable] = paths[ref.kind]
    return {
      absolutePath: resolveContainedPath(root, relativePath),
      title: ref.kind,
      contentType: 'text',
      previewable,
      editable: true,
    }
  }

  if (ref.scope === 'skill') {
    if (ref.tier === 'plugin') {
      const location = deps.resolvePluginSkillResource?.(
        ref.pluginInstanceId,
        ref.capabilityId,
        ref.file,
      )
      if (!location) throw new ManagedResourceError('unsupported-ref', 'Plugin resource resolver unavailable')
      return {
        absolutePath: resolveContainedPath(location.bundleRoot, location.relativePath),
        title: ref.capabilityId,
        contentType: 'markdown',
        previewable: true,
        editable: false,
        provenance: 'Installed plugin',
      }
    }
    const skillsDir = ref.tier === 'global'
      ? deps.globalSkillsDir
      : ref.tier === 'workspace'
        ? getWorkspaceSkillsPath(workspaceRootOrThrow(deps, ref.workspaceId))
        : join(
            deps.resolveProjectRootPath?.(ref.session.workspaceId, ref.session.sessionId)
              ?? (() => { throw new ManagedResourceError('not-found', 'Project session has no active directory') })(),
            '.agents',
            'skills',
          )
    return {
      absolutePath: resolveContainedPath(skillsDir, ref.skillId, 'SKILL.md'),
      title: ref.skillId,
      contentType: 'markdown',
      previewable: true,
      editable: true,
    }
  }

  const sourcesDir = getWorkspaceSourcesPath(workspaceRootOrThrow(deps, ref.workspaceId))
  const fileName = ref.file === 'config' ? 'config.json' : ref.file === 'guide' ? 'guide.md' : 'permissions.json'
  return {
    absolutePath: resolveContainedPath(sourcesDir, ref.sourceId, fileName),
    title: ref.sourceId,
    contentType: ref.file === 'guide' ? 'markdown' : 'text',
    previewable: ref.file !== 'config',
    editable: true,
  }
}

export function previewManagedResource(
  ref: PreviewableManagedResourceRef,
  deps: ManagedResourceDeps,
): ManagedResourcePreview {
  const resolved = resolveManagedResource(ref, deps)
  if (!resolved.previewable) throw new ManagedResourceError('not-previewable')
  if (!existsSync(resolved.absolutePath)) throw new ManagedResourceError('not-found')
  return {
    title: resolved.title,
    content: readFileSync(resolved.absolutePath, 'utf-8'),
    contentType: resolved.contentType,
    ...(resolved.provenance ? { provenance: resolved.provenance } : {}),
  }
}

export function summarizeManagedResource(
  ref: ManagedResourceRef,
  deps: ManagedResourceDeps,
): SafeManagedResourceSummary {
  const resolved = resolveManagedResource(ref, deps)
  const fields: Array<{ label: string; value: string }> = []
  let redacted = !resolved.previewable

  if (ref.scope === 'source' && ref.file === 'config') {
    redacted = true
    const parsed = safeReadJson(resolved.absolutePath)
    for (const key of ['name', 'provider', 'type'] as const) {
      const value = parsed?.[key]
      if (typeof value === 'string' && value) fields.push({ label: key, value })
    }
  } else if (ref.scope === 'workspace' && ref.kind === 'automations') {
    const parsed = safeReadJson(resolved.absolutePath)
    const automations = parsed?.automations
    const count = automations && typeof automations === 'object'
      ? Object.values(automations).reduce((total, value) => total + (Array.isArray(value) ? value.length : 0), 0)
      : 0
    fields.push({ label: 'count', value: String(count) })
  } else if (ref.scope === 'workspace' && (ref.kind === 'sources-root' || ref.kind === 'skills-root')) {
    fields.push({ label: 'count', value: String(countDirectories(resolved.absolutePath)) })
  } else if (ref.scope === 'global' && ref.kind === 'tool-icons') {
    const parsed = safeReadJson(resolved.absolutePath)
    fields.push({ label: 'count', value: String(Array.isArray(parsed?.tools) ? parsed.tools.length : 0) })
  }

  return { title: resolved.title, fields, redacted }
}

export interface ManagedEditContext {
  filePath: string
  editContextKey: ManagedEditContextKey
  label: string
  agentGuidance: string
}

export function resolveManagedEditContext(
  ref: ManagedResourceRef,
  editContextKey: ManagedEditContextKey,
  deps: ManagedResourceDeps,
): ManagedEditContext {
  const resolved = resolveManagedResource(ref, deps)
  if (!resolved.editable) throw new ManagedResourceError('not-editable')
  if (!isAllowedEditContext(ref, editContextKey)) {
    throw new ManagedResourceError('invalid-edit-context')
  }
  return {
    filePath: resolved.absolutePath,
    editContextKey,
    label: resolved.title,
    agentGuidance: getManagedEditAgentGuidance(ref, editContextKey),
  }
}

function getManagedEditAgentGuidance(
  ref: ManagedResourceRef,
  key: ManagedEditContextKey,
): string {
  if (ref.scope === 'workspace' && ref.kind === 'automations') {
    const operation = key === 'automation-config'
      ? 'Call automation_list first, then use automation_update for an existing automation or automation_create for a new one.'
      : 'Use automation_create to create the requested automation.'
    const kind = key === 'add-automation-scheduled'
      ? ' Create a scheduled automation.'
      : key === 'add-automation-event'
        ? ' Create an event automation.'
        : key === 'add-automation-agentic'
          ? ' Create an agentic automation.'
          : ''
    return `${operation}${kind} Call automation_validate after the mutation. Do not edit automations.json directly.`
  }

  if (ref.scope === 'workspace' && ref.kind === 'labels') {
    // UB4.12 — upstream carries the value rule in EditPopover's SENT context; our managed popover
    // sends only its instructions plus THIS guidance (F1.432), so the sentence lives here too.
    return key === 'edit-auto-rules'
      ? 'Edit only the resolved managed resource and confirm clearly when done. Values (valueTemplate) are stored only on labels with a valueType; on a plain label a rule just applies the label.'
      : 'Edit only the resolved managed resource and confirm clearly when done.'
  }

  if (ref.scope === 'workspace' && ref.kind === 'sources-root') {
    const sourceType = key === 'add-source-api'
      ? 'Create a REST API source. Ask for the endpoint URL and authentication type when either is missing.'
      : key === 'add-source-mcp'
        ? 'Create an MCP source using HTTP/SSE or stdio transport. Ask whether the service uses a remote URL or a local command.'
        : key === 'add-source-local'
          // F1.432 — the pointer F1.246 put in EditPopover never reaches the agent (a managed popover sends only its instructions plus THIS guidance), so it lives here; DOC_REFS honours NESSY_CONFIG_DIR.
          ? `Create a local-folder source with type "local" and local.path; no MCP server is needed. First, read the "Local Sources" section of ${DOC_REFS.sources}. Ask for the folder path when it is missing.`
          : 'Infer whether the requested source is MCP, REST API, or a local folder and ask one concise clarification when it cannot be inferred.'
    return `${sourceType} Create the source folder and config.json under the managed sources directory, then call source_test with the source slug.`
  }

  if (ref.scope === 'workspace' && ref.kind === 'skills-root') {
    return 'Use the bundled skill-creator skill as the authoring guide. Interview the user when the purpose or trigger is unclear, create the skill folder and SKILL.md under the managed skills directory, then call skill_validate with the skill slug.'
  }

  return 'Edit only the resolved managed resource and confirm clearly when done.'
}

function isAllowedEditContext(ref: ManagedResourceRef, key: ManagedEditContextKey): boolean {
  if (ref.scope === 'global') {
    return key === ({
      'preferences-notes': 'preferences-notes',
      'tool-icons': 'edit-tool-icons',
      'default-permissions': 'default-permissions',
    } as const)[ref.kind]
  }
  if (ref.scope === 'workspace') {
    const allowed: Record<typeof ref.kind, readonly ManagedEditContextKey[]> = {
      permissions: ['workspace-permissions'],
      labels: ['edit-labels', 'edit-auto-rules', 'add-label'],
      statuses: ['edit-statuses'],
      views: ['edit-views'],
      automations: ['automation-config', 'add-automation', 'add-automation-scheduled', 'add-automation-event', 'add-automation-agentic'],
      'sources-root': ['add-source', 'add-source-api', 'add-source-mcp', 'add-source-local'],
      'skills-root': ['add-skill'],
    }
    return allowed[ref.kind].includes(key)
  }
  if (ref.scope === 'source') {
    if (ref.file === 'config') return key === 'source-config'
    if (ref.file === 'guide') return key === 'source-guide'
    return key === 'source-permissions' || key === 'source-tool-permissions'
  }
  return key === (ref.file === 'manifest' ? 'skill-metadata' : 'skill-instructions')
}

function safeReadJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function countDirectories(path: string): number {
  try {
    return readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).length
  } catch {
    return 0
  }
}
