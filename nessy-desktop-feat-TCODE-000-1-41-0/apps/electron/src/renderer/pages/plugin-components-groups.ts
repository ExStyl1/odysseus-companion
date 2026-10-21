/**
 * Pure grouping for the plugin-detail component inventory (U4).
 *
 * Extracted from PluginInfoPage so tests import it WITHOUT pulling the
 * `@/components/info` barrel (→ Info_Markdown → pdfjs worker URLs bun cannot
 * resolve). Maps the path-free `SafePluginComponent[]` onto
 * PluginComponentsSection groups: one group per kind, each row clickable only
 * when it carries a capability key (skills / sources / connectors route to
 * their own detail page). Runtime-backed toggleable kinds emit a `toggle`
 * bound to the manifest capability id. Plain `command` metadata is retained
 * for compatibility reporting but has no runnable Nessy runtime;
 * `prompt-command` is the executable command surface.
 */

import type {
  PluginComponentGroup,
  PluginComponentItem,
  PluginComponentKind,
} from '@/components/info/PluginComponentsSection'
import type {
  SafeCapabilityKind,
  SafePluginComponent,
} from '@nessy-agent/shared/protocol/capabilities'

/**
 * Declared-kind tokens a LISTING can carry, in display order. Mirrors
 * `plugins/declared-components.ts` `PLUGIN_DECLARED_COMPONENT_KINDS` by VALUE:
 * the renderer must not import the plugins barrel (it reaches `node:fs`), and
 * the RPC has already filtered the wire list down to these tokens.
 */
const DECLARED_KIND_ORDER: readonly PluginComponentKind[] = [
  'skill', 'command', 'agent', 'workflow', 'hook', 'mcp', 'lsp', 'app',
]

const DECLARED_KINDS: ReadonlySet<string> = new Set(DECLARED_KIND_ORDER)

/**
 * The declared kinds inside a row's free-form `capabilities` list, deduplicated
 * and ordered. Skills Market rows put MCP server names and hook ids in that
 * same field, so anything that is not a kind token is dropped rather than shown.
 */
export function toDeclaredKinds(
  capabilities: readonly string[] | undefined,
): PluginComponentKind[] {
  if (!capabilities?.length) return []
  const present = new Set(capabilities.filter(value => DECLARED_KINDS.has(value)))
  return DECLARED_KIND_ORDER.filter(kind => present.has(kind))
}

/** Map a resolved capability kind onto a PluginComponentsSection group kind. */
export function componentKindFor(kind: SafeCapabilityKind): PluginComponentKind {
  switch (kind) {
    case 'skill': return 'skill'
    case 'command':
    case 'prompt-command': return 'command'
    case 'hook': return 'hook'
    case 'mcp': return 'mcp'
    case 'source': return 'connector'
    default: return 'app'
  }
}

/**
 * Kinds whose rows carry a per-capability switch (agents/instructions and
 * connector-materialized sources stay read-only for now).
 */
const TOGGLEABLE_KINDS: ReadonlySet<SafeCapabilityKind> = new Set([
  'mcp', 'skill', 'hook', 'prompt-command', 'output-style',
])

const DISABLED_REASON_KEYS: Readonly<Record<string, string>> = {
  'capability-disabled': 'pluginDetail.componentCapabilityDisabled',
  'unsupported-runtime': 'pluginDetail.componentUnsupportedRuntime',
  // `plugins/components.md#monitors` — a project-scope plugin's background monitors do
  // not load. Named rather than left as a bare dimmed row, because "my monitor
  // is not running" is otherwise indistinguishable from a broken monitor.
  'project-scope-monitor': 'pluginDetail.componentProjectScopeMonitor',
}

/** Group the flat component list into PluginComponentsSection groups by kind. */
export function toGroups(
  components: SafePluginComponent[],
  options: { pendingCapabilityId?: string } = {},
): PluginComponentGroup[] {
  const byKind = new Map<PluginComponentKind, PluginComponentItem[]>()
  for (const component of components) {
    const kind = componentKindFor(component.kind)
    const toggleable = TOGGLEABLE_KINDS.has(component.kind)
      && component.capabilityId !== undefined
      && component.enabled !== undefined
    const item: PluginComponentItem = {
      key: component.capabilityKey ?? `${component.kind}:${component.name}`,
      name: component.name,
      ...(component.description ? { description: component.description } : {}),
      // Rows with a capability key (skills / sources / connectors) route to
      // their own detail page.
      ...(component.capabilityKey ? { clickable: true } : {}),
      ...(toggleable
        ? {
            toggle: {
              capabilityId: component.capabilityId!,
              enabled: component.enabled!,
              ...(options.pendingCapabilityId === component.capabilityId ? { pending: true } : {}),
            },
          }
        : {}),
      // Dim any disabled row; name the reason only for the per-capability case.
      ...(component.enabled === false ? { dimmed: true } : {}),
      ...(component.enabled === false && component.unavailableReason
        && DISABLED_REASON_KEYS[component.unavailableReason]
        ? { disabledReasonKey: DISABLED_REASON_KEYS[component.unavailableReason] }
        : {}),
    }
    const existing = byKind.get(kind)
    if (existing) existing.push(item)
    else byKind.set(kind, [item])
  }
  return [...byKind.entries()].map(([kind, items]) => ({ kind, items }))
}
