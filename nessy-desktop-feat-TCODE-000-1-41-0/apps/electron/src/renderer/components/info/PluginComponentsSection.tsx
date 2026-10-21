/**
 * PluginComponentsSection (U4)
 *
 * The FULL component inventory of an installed plugin on its detail page,
 * following the Codex plugin-detail IA (owner reference screenshot
 * 2026-07-19) ADAPTED to our components: one Info_Section PER KIND with a
 * count in the header (Skills · N, Hooks, Connectors, MCP servers, Commands),
 * two-line rows (icon + name + description) with a per-component enable
 * Switch where the kind carries enablement (the plugin store already models
 * this: `PluginEnabledScope.capabilities` per-capability flags), and long
 * lists collapsed after 5 rows behind a "Show N more" expander.
 * A later pass may simplify toward Codex 1:1; for now we adapt what we have.
 *
 * UB14.59 — on the redesign's info anatomy: the per-kind count is `Info_Section`'s
 * own `count` (tertiary, tabular, beside the title — v0.15.1's Tools section), rows
 * sit on the 14px card inset at the 44px row height with the role text, and a
 * disabled component reads dimmer through the tertiary name (AA, the UB14.44
 * automations pattern), with only its icon at 50%.
 *
 * Placeholder-not-hidden: undefined groups render a loading skeleton; an
 * empty inventory renders an honest placeholder — the surface never vanishes.
 *
 * TWO EMPTINESSES, TWO SENTENCES (`source`). An INSTALLED plugin's inventory is
 * MEASURED, so empty means empty. A catalogue LISTING is a declaration, and
 * both upstream loaders auto-discover from default directories when the
 * manifest is silent (`plugins-reference.md` § Plugin manifest schema: "The
 * manifest is optional. If omitted, Claude Code auto-discovers components in
 * default locations"), so an empty listing means UNKNOWN. Rendering the
 * installed sentence for a listing is the defect this prop exists to end: every
 * marketplace plugin used to read "This plugin ships no components."
 *
 * A listing can also state KINDS without names or counts — its component fields
 * are PATHS (`"skills": "./skills/"`), and nobody has read what is behind them.
 * `declaredKinds` renders exactly that and never a number.
 *
 * IPC-free + callback-driven: `onOpen` for rows that map to a capability
 * with its own detail page, `onToggle` (payload = the manifest capability id)
 * for per-component enablement via the set-capability-enabled action.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Info_Section } from './Info_Section'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

/**
 * `agent`, `lsp` and `workflow` are DECLARATION-only today: a listing can name
 * them (`plugin-marketplaces.md` § Optional plugin fields, "Component
 * configuration fields"), while the installed inventory still folds them into
 * `app` through `componentKindFor`'s catch-all. Naming an LSP server "Apps"
 * would be a worse lie than the coarse grouping it mirrors, so the declaration
 * side keeps the honest label.
 */
export type PluginComponentKind =
  | 'skill' | 'command' | 'hook' | 'connector' | 'mcp' | 'app'
  | 'agent' | 'lsp' | 'workflow'

export interface PluginComponentItem {
  /** Stable key; also the `onOpen` payload. */
  key: string
  name: string
  description?: string
  /** Row icon (mock tile in the playground; real avatar in the app). */
  icon?: React.ReactNode
  /** Row opens its own detail page (skills, sources) when true. */
  clickable?: boolean
  /**
   * Per-component enablement (kinds that carry it); absent = no switch.
   * `capabilityId` is the `onToggle` payload (the manifest capability id).
   */
  toggle?: { capabilityId: string; enabled: boolean; pending?: boolean }
  /** Render the row dimmed (component disabled): a tertiary name and a 50% icon. */
  dimmed?: boolean
  /** i18n key for the small disabled-reason line under the description. */
  disabledReasonKey?: string
}

export interface PluginComponentGroup {
  kind: PluginComponentKind
  items: PluginComponentItem[]
}

const GROUP_LABEL_KEY: Record<PluginComponentKind, string> = {
  skill: 'pluginDetail.componentsSkills',
  command: 'pluginDetail.componentsCommands',
  hook: 'pluginDetail.componentsHooks',
  connector: 'pluginDetail.componentsConnectors',
  mcp: 'pluginDetail.componentsMcpServers',
  app: 'pluginDetail.componentsApps',
  agent: 'pluginDetail.componentsAgents',
  lsp: 'pluginDetail.componentsLspServers',
  workflow: 'pluginDetail.componentsWorkflows',
}

/** Rows shown before a group collapses behind the expander. */
const COLLAPSE_AFTER = 5

export interface PluginComponentsSectionProps {
  /**
   * Grouped inventory; undefined = still loading. `[]` means "nothing" only
   * when `source` is `'installed'` — see {@link PluginComponentsSectionProps.source}.
   */
  groups?: PluginComponentGroup[]
  /**
   * Where an empty `groups` came from. `'installed'` (the default, and the
   * pre-existing caller contract) = a MEASURED inventory, so empty is empty.
   * `'listing'` = a catalogue row, so empty is UNKNOWN and the copy says so.
   */
  source?: 'installed' | 'listing'
  /** Kinds the LISTING declares (`source: 'listing'` only). Never a count. */
  declaredKinds?: PluginComponentKind[]
  /** The declaration is still being resolved; renders the same skeleton. */
  declaredPending?: boolean
  /** Open a component's own detail page (clickable rows only). */
  onOpen?: (key: string) => void
  /** Flip a component's enablement (rows with `toggle` only). */
  onToggle?: (capabilityId: string, next: boolean) => void
}

function ComponentRow({
  item,
  onOpen,
  onToggle,
}: {
  item: PluginComponentItem
  onOpen?: (key: string) => void
  onToggle?: (capabilityId: string, next: boolean) => void
}) {
  const { t } = useTranslation()
  const clickable = Boolean(item.clickable && onOpen)
  const toggle = item.toggle
  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? () => onOpen?.(item.key) : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen?.(item.key) } } : undefined}
      className={cn(
        'flex min-h-11 items-center gap-3 px-3.5 py-2 text-label',
        clickable && 'cursor-pointer transition-colors duration-micro ease-out-subtle hover:bg-fill-hover hover:duration-instant focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
      )}
      data-testid="plugin-component-row"
    >
      {item.icon && <span className={cn('shrink-0', item.dimmed && 'opacity-50')}>{item.icon}</span>}
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate font-medium', item.dimmed ? 'text-tertiary' : 'text-foreground')}>{item.name}</span>
        {item.description && (
          <span className="block truncate text-label-sm text-tertiary">{item.description}</span>
        )}
        {item.disabledReasonKey && (
          <span className="block truncate text-label-sm text-tertiary" data-testid="plugin-component-disabled-reason">
            {t(item.disabledReasonKey)}
          </span>
        )}
      </span>
      {toggle && (
        <span onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
          <Switch
            checked={toggle.enabled}
            disabled={toggle.pending}
            onCheckedChange={(next) => onToggle?.(toggle.capabilityId, next)}
            aria-label={t('pluginDetail.componentToggleLabel', { name: item.name })}
            data-testid="plugin-component-toggle"
          />
        </span>
      )}
    </div>
  )
}

function ComponentGroupSection({
  group,
  onOpen,
  onToggle,
}: {
  group: PluginComponentGroup
  onOpen?: (key: string) => void
  onToggle?: (key: string, next: boolean) => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = React.useState(false)
  const visible = expanded ? group.items : group.items.slice(0, COLLAPSE_AFTER)
  const hidden = group.items.length - visible.length

  return (
    <Info_Section
      title={t(GROUP_LABEL_KEY[group.kind])}
      count={group.items.length > 1 ? group.items.length : undefined}
    >
      <div className="divide-y divide-separator">
        {visible.map((item) => (
          <ComponentRow key={item.key} item={item} onOpen={onOpen} onToggle={onToggle} />
        ))}
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="w-full px-3.5 py-2.5 text-left text-label-sm text-tertiary transition-colors duration-micro ease-out-subtle hover:bg-fill-hover hover:text-foreground hover:duration-instant focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            data-testid="plugin-components-more"
          >
            {t('pluginDetail.componentsShowMore', { count: hidden })}
          </button>
        )}
      </div>
    </Info_Section>
  )
}

export function PluginComponentsSection({
  groups,
  source = 'installed',
  declaredKinds,
  declaredPending,
  onOpen,
  onToggle,
}: PluginComponentsSectionProps) {
  const { t } = useTranslation()
  const present = groups?.filter((group) => group.items.length > 0) ?? []
  const listing = source === 'listing'

  // Loading / empty keep a single umbrella section so the surface never
  // disappears; present inventory renders one section per kind (Codex IA).
  if (groups === undefined || present.length === 0) {
    return (
      <Info_Section title={t('pluginDetail.componentsTitle')}>
        {groups === undefined || (listing && declaredPending) ? (
          <div className="space-y-2 px-3.5 py-3" aria-busy="true" data-testid="plugin-components-loading">
            <div className="h-3 w-1/3 animate-pulse rounded-xs bg-fill-hover" />
            <div className="h-3 w-2/3 animate-pulse rounded-xs bg-fill-hover" />
          </div>
        ) : listing && declaredKinds?.length ? (
          // What the LISTING states — kinds only. No count is shown because the
          // declaration is a set of paths nobody has opened.
          <div className="space-y-2 px-3.5 py-3" data-testid="plugin-components-declared">
            <p className="text-label text-secondary">{t('pluginDetail.componentsDeclaredLead')}</p>
            <div className="flex flex-wrap gap-1.5">
              {declaredKinds.map((kind) => (
                <span
                  key={kind}
                  data-testid="plugin-components-declared-kind"
                  className="rounded-full bg-fill-hover px-2.5 py-1 text-label-sm text-foreground"
                >
                  {t(GROUP_LABEL_KEY[kind])}
                </span>
              ))}
            </div>
            <p className="text-label-sm text-tertiary">{t('pluginDetail.componentsDeclaredNote')}</p>
          </div>
        ) : listing ? (
          <p className="px-3.5 py-3 text-label text-tertiary" data-testid="plugin-components-undeclared">
            {t('pluginDetail.componentsUndeclared')}
          </p>
        ) : (
          <p className="px-3.5 py-3 text-label text-tertiary" data-testid="plugin-components-empty">
            {t('pluginDetail.componentsEmpty')}
          </p>
        )}
      </Info_Section>
    )
  }

  return (
    <>
      {present.map((group) => (
        <ComponentGroupSection key={group.kind} group={group} onOpen={onOpen} onToggle={onToggle} />
      ))}
    </>
  )
}
