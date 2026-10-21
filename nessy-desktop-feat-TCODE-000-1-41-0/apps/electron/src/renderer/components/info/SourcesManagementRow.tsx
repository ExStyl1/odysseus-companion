/**
 * SourcesManagementRow (U4)
 *
 * A single row of the Sources MANAGEMENT panel (R2: Sources = the management
 * panel — inventory, origin, description, state, enable/disable), and the body
 * of the Plugins subsection. Built ON `EntityRow` — the exact row the real
 * Sources list (`SourcesListPanel` → `EntityPanel`) renders — with enablement
 * surfaced the AutomationsListPanel way (owner decision 2026-07-19): NO inline
 * switch — Enable/Disable lives in the row's "…" / right-click MENU (`menu`
 * prop), and a disabled row reads dimmer through its tertiary title (UB14.59:
 * the AutomationsListPanel pattern since UB14.44 — the solved tertiary text is
 * AA, a 50% row was not).
 *
 * WHO RENDERS IT, measured 2026-09-08 (P6.778) — because the list below is the
 * shape this row was DESIGNED for and not the shape it is USED in:
 *   - `PluginsManagementPanel` (the `sources/plugins` subsection) is the only
 *     production caller. Its rows come from `pluginRowSummary`, so every one of
 *     them is `kind: 'app'`, `origin: 'plugin'`, with no `mcpTransport` and no
 *     `sourceType`.
 *   - the playground entry (`playground/registry/sources-management.tsx`) and
 *     the tests are what exercise the other four kinds.
 *
 * So a STATUS AFFORDANCE added here that needs a transport or a source type
 * (P6.745's five-status pip, P6.773's `local_disabled`) cannot fire on any row
 * the shipped app renders: it reads as wired and is unreachable until a
 * management panel renders those kinds. Stated here rather than discovered a
 * third time.
 *
 * One row shape serves every source-panel kind:
 *   - plugin        installed plugin (enablement via menu) — the live one
 *   - mcp-native    native `.mcp.json` MCP server (enablement via menu)
 *   - connector     plugin connector (kind:'mcp' + connectorOrigin provenance)
 *   - api           API source (display-only — enablement governed elsewhere)
 *   - local         local-folder source (display-only)
 *
 * Its CARD is the shared one (`sourceCardSlots`, owner report 2026-08-01, on
 * v0.15.1's row anatomy since UB12.74): status-bearing icon, name, the category
 * as the title meta, the description on line 2 — and NOTHING else beside the
 * name. The acquisition badge that used to sit there ("Figma  ⊙ External
 * marketplace", above a second `Plugin` badge) is gone: the owner's ruling is
 * that acquisition belongs in the badge row or nowhere, and the 2026-08-01 card
 * already ruled provenance off the row. It stays on the detail page, which is
 * where the row click goes. The category is DERIVED from the summary rather
 * than passed in, so a row cannot be labelled something other than what it is.
 *
 * Slot mapping onto EntityRow:
 *   - icon/title/titleTrailing/subtitle: identical to the real source rows
 *     (the category meta; line 2 the description).
 *   - menuContent: the caller-provided menu (Enable/Disable with scope
 *     clarity, Open Details, Remove, …) — content must use useMenuComponents().
 *   - overlay: passive state area — display-only state chip (api/local) or an
 *     in-flight spinner while an enablement mutation runs.
 *   - subtitle, when the row has notes: awaiting-auth / failed-action / update
 *     notes (placeholder-not-hidden) take line 2 IN PLACE of the description —
 *     v0.15.1's rule for a state on line 2 (UB12.74), and INSIDE the row
 *     surface, so the hover/background covers them.
 *
 * IPC-free + callback-driven: the caller wires the menu items to the real
 * enablement mutations later; the playground + tests drive it with mock state.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, CircleArrowUp, Loader2, KeyRound } from 'lucide-react'
import { EntityRow } from '@/components/ui/entity-row'
import { SourceAvatar } from '@/components/ui/source-avatar'
import { sourceCardSlots } from '@/components/app-shell/SourceCardBadges'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'

/** Activation scope the row's enablement acts in (workspace vs project). */
export type SourceManagementScope = 'workspace' | 'project'

/**
 * Enablement STATE for a row whose enable/disable lives in the row menu.
 * Absent = display-only row (api / local): the row shows a state chip instead.
 */
export interface SourceManagementEnablement {
  /** Current enabled state — a disabled row dims (the Automations pattern). */
  enabled: boolean
  /** Scope the menu's Enable/Disable acts in (surfaced in the menu label). */
  scope: SourceManagementScope
  /** Enablement mutation in flight — show an in-flight spinner. */
  pending?: boolean
  /**
   * The last enable/disable failed — render an inline error note. Localized
   * message (already resolved by the caller) or `true` for the generic copy.
   */
  error?: string | true
  /**
   * The source is installed/active but needs sign-in before it can be used
   * (connector `authTiming` not yet satisfied). Renders an awaiting-auth note.
   */
  awaitingAuth?: boolean
}

export interface SourcesManagementRowProps {
  /** Path-free capability summary driving avatar / name / description / category. */
  summary: SafeCapabilitySummary
  /** Already-resolved display name. */
  displayName: string
  /** Avatar element (real SourceAvatar in the app; a mock tile in the playground). */
  avatar?: React.ReactNode
  /**
   * Enablement state. Present → the row dims when disabled and shows the
   * pending/error/awaiting-auth surfaces; the ACTION lives in `menu`.
   * Absent → a display-only state chip (management identity only).
   */
  enablement?: SourceManagementEnablement
  /**
   * R83 — the version the wire advertises as available for this row's source
   * (`SafeInstalledPluginSummary.availableUpdateVersion`, projected by
   * `plugin-management-rows.ts`). Absent → nothing renders, which is the case
   * for almost every row and for R81's dependency-held plugin, whose version is
   * withheld server-side.
   *
   * It renders as a NOTE, not a badge: the card (`sourceCardSlots`) has no
   * extension slot on purpose (owner ruling 2026-08-01 — "badges are the
   * shape", and the licence to carry more covers controls, not badges), and the
   * note family beside it already exists for exactly this class of thing — a
   * state of this row worth telling the user about, on its line 2.
   */
  updateAvailableVersion?: string
  /**
   * Row menu (EntityRow "…" + right-click context menu — the SourceMenu /
   * AutomationMenu pattern). Enable/Disable lives HERE; content must use
   * useMenuComponents().
   */
  menu?: React.ReactNode
  /** Row click (opens the detail template). */
  onClick?: () => void
  /**
   * This row is the one whose detail page is open. Computed by
   * `SourcesManagementRowList` from its `selectedId`, exactly as
   * `showSeparator` is — the list owns both. Reaches `EntityRow`'s own
   * `isSelected`, so the highlight is the SAME accent bar + tinted background
   * every other list in the app draws, never a second selected look.
   */
  isSelected?: boolean
  /** Hairline separator above this row (list rows after the first). */
  showSeparator?: boolean
  /**
   * P6.773 — the workspace's "Enable stdio subprocess servers" setting, for the
   * one `local_disabled` verdict `SafeCapabilitySummary` alone cannot reach.
   * `mcp-pool.ts` refuses to start a stdio server while it is off ("Local MCP
   * servers are disabled for this workspace."), and without this the row wears
   * the dot of a server nobody has tested yet.
   *
   * A PROP and not a read, because this component is IPC-free by contract (see
   * the file docblock) — the same shape `SourcesListPanel` uses for its own
   * rows, and defaulting to `true` for the same reason: a caller that does not
   * know the setting keeps the verdict it had rather than being told the
   * servers are off.
   *
   * `SourcesManagementRowEntry extends SourcesManagementRowProps` and the list
   * spreads its entries, so it needs no change to reach a row. What is still
   * owed is a CALLER that supplies it: today the only production one is
   * `PluginsManagementPanel`, whose rows come from `pluginRowSummary` —
   * `kind: 'app'`, no `mcpTransport` — so the verdict cannot fire there at all.
   * The day a management panel renders `mcp-native` rows (this row's docblock
   * lists that kind), that panel passes the setting in.
   */
  localMcpEnabled?: boolean
  className?: string
}

export function SourcesManagementRow({
  summary,
  displayName,
  avatar,
  enablement,
  updateAvailableVersion,
  menu,
  onClick,
  isSelected = false,
  showSeparator = false,
  localMcpEnabled = true,
  className,
}: SourcesManagementRowProps) {
  const { t } = useTranslation()
  const hasNotes = Boolean(enablement?.awaitingAuth || enablement?.error || updateAvailableVersion)
  // The ONE card: the whole summary goes in, and the card decides what reaches
  // the markup (the category meta + the description). Nothing sits beside the
  // name — the acquisition badge that did was the owner's 2026-08-01 report.
  const card = sourceCardSlots(summary, t)

  return (
    <EntityRow
      // Disabled rows read dimmer through the tertiary title (AA) — the AutomationsListPanel pattern.
      className={className}
      titleClassName={enablement && !enablement.enabled ? 'text-tertiary' : undefined}
      dataAttributes={{ 'data-testid': 'sources-management-row' }}
      isSelected={isSelected}
      showSeparator={showSeparator}
      separatorClassName="pl-10 pr-4"
      icon={avatar ?? <SourceAvatar source={summary} size="sm" showStatus localMcpEnabled={localMcpEnabled} />}
      title={displayName}
      titleTrailing={card.titleTrailing}
      // Line 2: the notes when the row has any (they are its state, and a state
      // takes the description's place — v0.15.1, UB12.74), else the
      // description. Notes live INSIDE the row surface, never below it — the
      // row keeps one hover/background box (owner feedback 2026-07-19).
      subtitle={
        hasNotes ? (
          <span className="flex flex-col gap-0.5">
            {enablement?.awaitingAuth && (
              <span className="flex items-center gap-1.5 text-info" data-testid="row-awaiting-auth">
                <KeyRound className="size-3 shrink-0" aria-hidden />
                <span>{t('sourcesManagement.awaitingAuth')}</span>
              </span>
            )}
            {enablement?.error && (
              <span className="flex items-center gap-1.5 text-destructive" data-testid="row-enablement-error">
                <AlertCircle className="size-3 shrink-0" aria-hidden />
                <span>{enablement.error === true ? t('sourcesManagement.toggleFailed') : enablement.error}</span>
              </span>
            )}
            {updateAvailableVersion && (
              // The same sentence the marketplace detail badge shows — the row
              // has the width for it, so the version is named rather than
              // hinted at.
              <span className="flex items-center gap-1.5 text-info" data-testid="row-update-available">
                <CircleArrowUp className="size-3 shrink-0" aria-hidden />
                <span>{t('plugins.updateAvailable', { version: updateAvailableVersion })}</span>
              </span>
            )}
          </span>
        ) : card.subtitle
      }
      onClick={onClick}
      menuContent={menu}
      // Clearance so the title meta and line 2 never run under the passive
      // state area / hover "…" button. The button's padding, not the meta's
      // margin (UB12.74): the state area is centred across both lines.
      buttonProps={{ className: enablement ? 'pr-16' : 'pr-24' }}
      overlay={
        // Passive state area — never intercepts clicks (row click + menu work
        // through/beside it).
        <div className="absolute right-10 inset-y-0 flex items-center gap-2 pointer-events-none">
          {enablement?.pending && (
            <Loader2 className="size-3.5 animate-spin text-tertiary" data-testid="row-enablement-pending" aria-hidden="true" />
          )}
          {!enablement && (
            // Display-only kinds: management state chip, no affordance.
            <span className="text-label-sm text-tertiary" data-testid="row-display-only-state">
              {t(summary.state === 'active' ? 'sourcesManagement.stateEnabled' : 'sourcesManagement.stateDisabled')}
            </span>
          )}
        </div>
      }
    />
  )
}
