import type {
  NessyCoreSettingsScopeState,
  NessyCoreSettingsSnapshot,
  NessyExtensionSettingsEntry,
} from '@craft-agent/shared/protocol'

type PartialScopeState = Partial<NessyCoreSettingsScopeState>

type PartialSnapshot = Partial<Omit<NessyCoreSettingsSnapshot, 'merged'>> & {
  merged?: Partial<NessyCoreSettingsSnapshot['merged']>
  extensions?: Partial<NessyExtensionSettingsEntry>[]
  isTrusted?: boolean
}

function arrayOrEmpty<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : []
}

function normalizeScopeState(
  state: PartialScopeState | undefined,
): NessyCoreSettingsScopeState {
  return {
    path: state?.path ?? '',
    values: state?.values ?? {},
    mcpServers: arrayOrEmpty(state?.mcpServers),
    hooks: arrayOrEmpty(state?.hooks),
  }
}

function normalizeExtension(
  extension: Partial<NessyExtensionSettingsEntry>,
): NessyExtensionSettingsEntry {
  return {
    id: extension.id ?? extension.name ?? '',
    name: extension.name ?? extension.id ?? '',
    displayName: extension.displayName,
    version: extension.version,
    isActive: extension.isActive,
    path: extension.path,
    commands: arrayOrEmpty(extension.commands),
    skills: arrayOrEmpty(extension.skills),
    mcpServers: arrayOrEmpty(extension.mcpServers),
    settings: arrayOrEmpty(extension.settings),
  }
}

export function normalizeNessySettingsSnapshot(
  snapshot: NessyCoreSettingsSnapshot | null,
): NessyCoreSettingsSnapshot | null {
  if (!snapshot) return null

  const partial = snapshot as PartialSnapshot
  const extensions = partial.merged?.extensions ?? partial.extensions

  return {
    user: normalizeScopeState(partial.user),
    workspace: normalizeScopeState(partial.workspace),
    merged: {
      values: partial.merged?.values ?? {},
      mcpServers: arrayOrEmpty(partial.merged?.mcpServers),
      hooks: arrayOrEmpty(partial.merged?.hooks),
      extensions: arrayOrEmpty(extensions).map(normalizeExtension),
    },
    workspaceTrusted: partial.workspaceTrusted ?? partial.isTrusted ?? false,
  }
}
