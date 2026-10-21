/**
 * C6 (capability-path plan, ADR § 6): the ONE panel listing ALL MCP servers —
 * plugin-owned, user-created and built-in together, mirroring Claude's `/mcp`
 * single surface. Each row: name, origin label, transport, auth state, and the
 * per-server enable toggle — for plugin rows riding the EXISTING
 * capabilityId-scoped policy records (`set-capability-enabled`), for built-in
 * dp rows (A7) riding `setBuiltinDpMcpServerEnabled`. The two writes stay
 * separate all the way down to the switch: a built-in's enablement is a user
 * preference, not a capability policy record, and a plugin server has no
 * built-in preference. That the READ side is now common — a built-in arrives as
 * an ordinary capability summary too, so its row opens a real detail page — does
 * NOT merge the writes, and the `originKind` branch at the switch is what keeps
 * them apart.
 *
 * The plugin detail page renders this same component filtered by `pluginKey` —
 * a view, not a second surface, and never a place for built-ins.
 *
 * Rows live in `EntityList` — the same container the Sources and Skills panels
 * use, and the owner of the ScrollArea that makes a 29-row list reachable. The
 * row body is `McpEntityRow` below: `EntityRow`'s markup class-for-class,
 * local only because `EntityRow`'s import graph cannot be loaded by the test
 * runner. See its own comment.
 *
 * The row's CARD is the shared one (`sourceCardSlots`, owner ruling
 * 2026-08-01, on v0.15.1's row anatomy since UB12.74): status-bearing icon,
 * name, the category as the title line's meta, the description on line 2 — and
 * NOTHING else. The earlier reading of that ruling ("a row with a control may
 * carry MORE") was NARROWED by the owner the same day: the licence covers
 * CONTROLS, not badges. So this row carries exactly the aggregate Sources row's
 * content, in the same slots.
 *
 * The origin, transport, auth-state and `Disabled` badges that used to ride the
 * card's `extras` slot are therefore gone from the row. Where each went:
 *   - origin / transport / auth-state → the detail page this row already opens.
 *   - `Disabled` → redundant beside the Switch in `overlay`, which shows the
 *     same state AND can change it.
 *   - A7's `Needs dp` → `unavailableReason` still rides the row data and is
 *     rendered by `CapabilityDetailTemplate`, so the reason survives on the
 *     detail page rather than on the row.
 *
 * The row's CONTROL is the per-server Switch, and only that. The Connect button
 * that used to sit beside it in `overlay` is GONE from the row (owner report
 * 2026-08-01): a list item states what is wrong, the ACTION lives on the detail
 * page of the server that actually needs authorising — `SourceInfoPage` via
 * `SourceDetailActions`, which reuses `PluginServerConnectButton` and
 * `capabilityConnectTarget` below rather than growing a third Connect.
 *
 * What the row keeps is the STATEMENT, saying "Sign in required" /
 * "Sign-in expired". It is deliberately silent on a healthy row — the owner
 * asked to state when sign-in IS needed, and a "Connected" chip on every row
 * would be noise on a list whose 28 built-ins carry no credential at all.
 * `mcpServers.authConnected` therefore stays unused; see `mcpRowAuthMarkerKey`.
 * It sat right-aligned in the badge row until UB12.74; on the anatomy it is
 * line 2, in place of the description, the way v0.15.1's Sources list (and so
 * our aggregate list, UB14.57) prints a source's non-connected state.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, KeyRound, Server } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { EntityList } from '@/components/ui/entity-list'
import { EntityIcon } from '@/components/ui/entity-icon'
import { EntityStatusDot } from '@/components/ui/source-avatar'
import { McpIcon } from '@/components/icons/McpIcon'
import { cn } from '@/lib/utils'
import { SourceCardRowLines, sourceCardSlots, type SourceCardSlots } from './SourceCardBadges'
import { buildMcpServerRows, type McpServerRow } from '@/lib/capability-catalog'
import {
  pluginServerAuthKind,
  type UserCapabilityCatalog,
} from '@nessy-agent/shared/protocol/capabilities'
import type { BuiltinDpMcpSettingsViewV1, McpReconnectResult, McpServerStatusLine } from '../../../shared/types'

/** The catalog slice every surface in this module reads. */
export type McpServersCatalog =
  Pick<UserCapabilityCatalog, 'installedPlugins' | 'capabilities'> | null | undefined

/** Exactly the `performOAuth` argument for one plugin MCP server. */
export interface PluginServerConnectTarget {
  workspaceId: string
  sourceSlug: string
  pluginServer: { pluginKey: string; serverName: string }
}

/**
 * B2: the sign-in target for one MCP row, or `null` when this row's sign-in
 * cannot be completed from a server list.
 *
 * `null` for a non-plugin row (a user/builtin server has no plugin credential
 * slot), for a row whose credential is already usable, and — the reason the
 * auth kind has to be joined at all — for a `bearer`/`environment`/`dp` row,
 * which `performOAuth` cannot complete. Offering Connect there would replace
 * one dead end with a failing button.
 *
 * `workspaceId` and `serverName` both come from the row's own capability
 * summary: `scope.workspaceId` is the scope the catalog was resolved at, and
 * `logicalName` is the manifest `mcp.serverName` the plugin credential slot is
 * keyed by (`row.name` is the DISPLAY name, which a manifest may override).
 */
export function pluginServerConnectTarget(
  row: McpServerRow,
  catalog: McpServersCatalog,
): PluginServerConnectTarget | null {
  if (row.originKind !== 'plugin' || !row.pluginKey || !row.capabilityKey) return null
  // The two states whose marker says a sign-in is outstanding.
  if (row.credentialState !== 'missing' && row.credentialState !== 'expired') return null
  const summary = catalog?.capabilities?.find(capability => capability.key === row.capabilityKey)
  const serverName = summary?.logicalName
  const workspaceId = summary?.scope.workspaceId
  if (!serverName || !workspaceId) return null
  const plugin = catalog?.installedPlugins?.find(entry => entry.pluginKey === row.pluginKey)
  if (pluginServerAuthKind(plugin?.authRequirements, serverName) !== 'oauth') return null
  return { workspaceId, sourceSlug: serverName, pluginServer: { pluginKey: row.pluginKey, serverName } }
}

/**
 * The same sign-in target, addressed by CAPABILITY KEY — what a DETAIL page
 * has. `SourceInfoPage` holds one capability summary and no row, so it rebuilds
 * the row set through the SAME `buildMcpServerRows` join and asks the SAME
 * predicate. Re-deriving the four fields `pluginServerConnectTarget` reads
 * (origin, pluginKey, capabilityKey, credentialState) would be a second copy of
 * the rule that decides who can be signed in from where, and the two would
 * drift.
 *
 * `null` for exactly the rows the list refuses: non-plugin, already usable, and
 * `bearer`/`environment`/`dp`, which `performOAuth` cannot complete.
 */
export function capabilityConnectTarget(
  capabilityKey: string,
  catalog: McpServersCatalog,
): PluginServerConnectTarget | null {
  const row = buildMcpServerRows(catalog ?? {}).find(entry => entry.capabilityKey === capabilityKey)
  return row ? pluginServerConnectTarget(row, catalog) : null
}

/**
 * What one row SAYS about its credential, as a translation key, or `null` for a
 * row that has nothing to report.
 *
 * `null` on `ready` and `not-required` is the owner's ruling, not an oversight:
 * the row is to state that sign-in IS needed, so a healthy server stays quiet.
 * That leaves `mcpServers.authConnected` deliberately unused by production —
 * the string stays in the locales because the DETAIL page is where a positive
 * "Connected" would belong if it is ever asked for.
 *
 * A key rather than a rendered string so the decision is testable without a
 * renderer and cannot disagree between the row and any future reader.
 */
export function mcpRowAuthMarkerKey(row: Pick<McpServerRow, 'credentialState'>): string | null {
  if (row.credentialState === 'missing') return 'mcpServers.authNeeded'
  if (row.credentialState === 'expired') return 'mcpServers.authExpired'
  return null
}

/**
 * P6.711 — the WIRE name of one row, which is what the MCP pool is keyed by.
 *
 * `row.name` is the DISPLAY name and a manifest (or a user) may override it,
 * so addressing the pool with it restarts nothing. The capability summary's
 * `logicalName` is the wire name for every catalog-backed row, `builtinDpName`
 * is it for a built-in that arrived only through the RPC half, and a plugin
 * component with no summary falls back to its component name — which is the
 * value `buildMcpServerRows` itself puts in `configuredWireNames`.
 *
 * Deliberately total: there is no such thing as a row with no address, and a
 * `null` here would only move the guess to the call site.
 */
export function mcpRowWireName(row: McpServerRow, catalog: McpServersCatalog): string {
  const summary = row.capabilityKey
    ? catalog?.capabilities?.find(capability => capability.key === row.capabilityKey)
    : undefined
  return summary?.logicalName ?? row.builtinDpName ?? row.name
}

/**
 * P6.750 — what one row SAYS about its LIVE state, or `null` when it says
 * nothing.
 *
 * The panel's rows are built from stored config, so four different broken
 * servers render exactly like a healthy one: a connection that failed, one
 * waiting on a sign-in, a connected server providing zero tools, and (F1.655) a
 * connected one whose line carries a `detail` — the pool's "N tools skipped: …"
 * (F1.643/F1.644), the only connected `detail` (the SDK documents `error` for
 * `failed` only). Those four are named, nothing else; `detail` rides as `title`.
 *
 * Silent on a healthy row, for the reason {@link mcpRowAuthMarkerKey} is: a
 * "Connected" chip on every row is noise on a list whose built-ins are almost
 * all healthy almost all of the time, and the owner asked the row to STATE what
 * is wrong rather than report what is fine. `pending` is silent too — a server
 * still coming up is not a problem, and a marker that appears for a second on
 * every panel open would be exactly the noise this rule exists to prevent.
 *
 * `needs-auth` reuses the credential vocabulary rather than minting a second
 * one: the live pool and the stored `credentialState` are two views of one fact,
 * and two spellings of "sign in" on one list is how a user learns to distrust
 * both. The live view is consulted FIRST because it is the one that can be right
 * when the stored config looks fine.
 *
 * Absent statuses (`undefined`/`null`) mean nobody has counted — no runtime yet
 * and no pool — and produce no marker at all, which is honest: an empty list
 * from a session that was never asked must not read as "no servers".
 */
export function mcpRowLiveStatusMarker(
  wireName: string,
  statuses: readonly McpServerStatusLine[] | null | undefined,
): { key: string; tone: 'auth' | 'warning'; detail?: string } | null {
  const line = statuses?.find(entry => entry.name === wireName)
  if (!line) return null
  if (line.state === 'needs-auth') return { key: 'mcpServers.authNeeded', tone: 'auth' }
  const detail = line.detail ? { detail: line.detail } : {}
  if (line.state === 'failed') return { key: 'mcpServers.statusFailed', tone: 'warning', ...detail }
  if (line.state !== 'connected') return null
  // `toolCount` is `null` for anything not connected and a NUMBER when it is,
  // so this arm fires only on a live server that really provides none (every
  // tool skipped included — the stronger finding, now with its reason).
  if (line.toolCount === 0) return { key: 'mcpServers.statusNoTools', tone: 'warning', ...detail }
  return line.detail ? { key: 'mcpServers.statusToolsSkipped', tone: 'warning', ...detail } : null
}

/**
 * The Reconnect affordance, owning only its own busy/verdict state — the same
 * shape `PluginServerConnectButton` has, for the same reason.
 *
 * **Offered on every ENABLED row — the stored flag, F1.1260 — and gated on
 * nothing else.** A switched-off server is in no pool, so its Reconnect could
 * only answer `unknown-server` (on a built-in dp row it may start a dp
 * sign-in). Live pool state (P6.750's serverStatuses) drives the row's line 2,
 * never this control: a failed-but-enabled server keeps the action exactly
 * where it is wanted, and the pool's honest `unknown-server` is what shows.
 *
 * The four refusals are NOT collapsed into one sentence: the translated line
 * says the reconnect failed, and the verdict — plus the pool's own redacted
 * `detail` when it has one — rides in the `title`, so a user can say which of
 * the four happened without a locale key per enum value.
 */
export function McpServerReconnectButton({
  wireName,
  onReconnect,
  testId,
}: {
  wireName: string
  onReconnect: (wireName: string) => Promise<McpReconnectResult>
  testId: string
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = React.useState(false)
  const [failure, setFailure] = React.useState<string | null>(null)
  const onClick = React.useCallback(() => {
    setBusy(true)
    setFailure(null)
    void onReconnect(wireName)
      .then(result => {
        setFailure(result.ok
          ? null
          : result.detail ? `${result.reason}: ${result.detail}` : result.reason)
      })
      // A rejected promise is a TRANSPORT failure, not a pool verdict — the
      // pool never throws. Named as itself so the two cannot be confused.
      .catch(() => setFailure('transport'))
      .finally(() => setBusy(false))
  }, [onReconnect, wireName])
  return (
    <span className="flex shrink-0 items-center gap-2">
      {failure && (
        <span className="text-xs text-destructive" title={failure} data-testid={`${testId}-failed`}>
          {t('mcpServers.reconnectFailed')}
        </span>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={onClick}
        data-testid={testId}
        title={wireName}
      >
        {busy ? t('mcpServers.reconnecting') : t('mcpServers.reconnect')}
      </Button>
    </span>
  )
}

/**
 * Run one plugin-server OAuth flow. The SAME `performOAuth` call
 * `PendingAuthNotice` makes for its plugin rows — the session-start notice was
 * the only surface that could act, and it is transient.
 */
export async function connectPluginServer(target: PluginServerConnectTarget): Promise<boolean> {
  try {
    const result = await window.electronAPI?.performOAuth?.(target)
    return result?.success === true
  } catch {
    return false
  }
}

/**
 * The Connect affordance itself, owning only its own busy/error state so both
 * surfaces (this panel's rows and the plugin page's authentication section)
 * render one identical control instead of two that can drift.
 *
 * Labels reuse `pendingAuth.*`, which is the same action under the same words
 * as the session-start notice.
 */
export function PluginServerConnectButton({
  target,
  testId,
}: {
  target: PluginServerConnectTarget
  testId: string
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const onClick = React.useCallback(() => {
    setBusy(true)
    setFailed(false)
    void connectPluginServer(target).then(ok => {
      setFailed(!ok)
      setBusy(false)
    })
  }, [target])
  return (
    <span className="flex shrink-0 items-center gap-2">
      {failed && <span className="text-xs text-destructive">{t('pendingAuth.error')}</span>}
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={onClick}
        data-testid={testId}
        title={target.pluginServer.serverName}
      >
        {busy ? t('pendingAuth.connecting') : t('pendingAuth.connect')}
      </Button>
    </span>
  )
}

export interface McpServersPanelProps {
  catalog: McpServersCatalog
  /**
   * The built-in dp-backed set (A7) as rows of this same list, or null before
   * the first read. Ignored while `pluginKey` filters the list: a built-in
   * belongs to no plugin.
   */
  builtinDp?: BuiltinDpMcpSettingsViewV1 | null
  /** Filter to one plugin's servers — the plugin detail page's view. */
  pluginKey?: string
  /** Per-server enable toggle target (plugin rows). */
  onToggleServer?: (row: { pluginKey: string; capabilityId: string }, next: boolean) => void
  /**
   * Persist one built-in dp server's switch. Deliberately NOT `onToggleServer`:
   * a built-in is stored as a user preference, not as a capability policy
   * record, and folding the two would write the wrong file.
   */
  onToggleBuiltinDp?: (name: string, next: boolean) => void
  /** Row whose toggle mutation is in flight (disables its switch). */
  pendingCapabilityId?: string
  /**
   * P6.711 — restart one server's connection, addressed by wire name.
   *
   * Optional because the action needs a SESSION and this panel does not have
   * one: it renders in the Sources navigation, which can be open with nothing
   * running. Absent → no Reconnect control at all, which is honest; a button
   * that could only ever answer "no session" is worse than no button.
   */
  onReconnectServer?: (wireName: string) => Promise<McpReconnectResult>
  /**
   * P6.750 — the session's LIVE MCP inventory, one line per server.
   *
   * Optional and nullable for the same reason `onReconnectServer` is optional:
   * this panel renders in the Sources navigation, which can be open with no
   * session running, and `null` from the host means nobody has counted. Either
   * way the rows render exactly as before — the marker is additive.
   */
  serverStatuses?: readonly McpServerStatusLine[] | null
  /** Open the row's detail page when it has one. */
  onOpenServer?: (capabilityKey: string) => void
  className?: string
}

/**
 * The Sources row, locally. Class-for-class the markup `EntityRow` produces
 * (`components/ui/entity-row.tsx`) for its `titleTrailing` branch: the
 * icon · title · meta line and line 2 (the shared {@link SourceCardRowLines},
 * the ONE card's own copy of that column), and the overlay slot as a SIBLING of
 * the button — a Switch nested inside a button is invalid markup and its click
 * would select the row.
 *
 * Why it is not the shared component: the Switch (and P6.711's Reconnect)
 * render in `overlay` beside a button `EntityRow` owns, with no row menu and no
 * context menu — this panel has never had either; the row's only action is the
 * switch. (The other reason this comment used to give — that `EntityRow`'s
 * import graph reached the `@nessy-agent/ui` barrel bun cannot load — no longer
 * holds: `source-card.test.tsx` renders `EntityRow` under bun since UB14.57.)
 *
 * UB12.74 — the row takes the ONE card's anatomy slots (`sourceCardSlots`): the
 * category is the title meta and line 2 the description, or the row's own
 * statement (the sign-in / live marker) in its place. The old badge row, its
 * mask and its `trailing` slot are gone.
 *
 * UB14.40 (R6-11) — re-copied from v0.15.1's mail-style `EntityRow` (UB13.13):
 * the row fills the panel edge to edge and pads the gutter, and the hairline is
 * the row's OWN (`after:` under the text column, hidden on a selected row), so
 * the separator this row used to draw ABOVE itself, and the `showSeparator`
 * flag that drove it, are gone — `EntityRow` deprecated the flag the same way.
 */
function McpEntityRow({
  icon,
  title,
  titleTrailing,
  subtitle,
  overlay,
  onClick,
  buttonClassName,
  dataTestId,
}: SourceCardSlots & {
  icon: React.ReactNode
  title: React.ReactNode
  overlay: React.ReactNode
  onClick?: () => void
  buttonClassName: string
  dataTestId: string
}) {
  return (
    <div data-testid={dataTestId}>
      <div
        className={cn(
          'relative group select-none',
          'after:pointer-events-none after:absolute after:right-0 after:bottom-0 after:h-px after:bg-separator in-data-[selected]:after:hidden',
          'after:left-[calc(var(--gutter)+26px)]',
        )}
      >
        <button
          type="button"
          className={cn(
            'entity-row-btn flex w-full items-start py-[9px] px-gutter text-left text-label -outline-offset-2',
            'transition-[background-color] duration-micro ease-out-subtle hover:duration-instant',
            'hover:bg-fill-hover',
            buttonClassName,
          )}
          onClick={onClick}
        >
          <SourceCardRowLines icon={icon} title={title} titleTrailing={titleTrailing} subtitle={subtitle} />
        </button>
        {overlay}
      </div>
    </div>
  )
}

export function McpServersPanel({
  catalog,
  builtinDp,
  pluginKey,
  onToggleServer,
  onToggleBuiltinDp,
  pendingCapabilityId,
  onReconnectServer,
  serverStatuses,
  onOpenServer,
  className,
}: McpServersPanelProps) {
  const { t } = useTranslation()
  const rows = React.useMemo(() => {
    const all = buildMcpServerRows(catalog ?? {}, pluginKey ? null : builtinDp)
    return pluginKey ? all.filter(row => row.pluginKey === pluginKey) : all
  }, [builtinDp, catalog, pluginKey])

  return (
    <EntityList<McpServerRow>
      items={rows}
      getKey={row => row.id}
      className={className}
      containerProps={{ 'data-list-role': 'mcp-servers' }}
      emptyState={
        <div className="flex flex-col items-center gap-2 p-8 text-center" data-testid="mcp-servers-empty">
          <Server className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm font-medium">{t('mcpServers.empty')}</p>
          <p className="text-xs text-muted-foreground">{t('mcpServers.emptyDescription')}</p>
        </div>
      }
      renderItem={(row) => {
        // The two write paths, kept apart at the point of use: a plugin row
        // flips a capability policy record, a built-in dp row writes the
        // user preference. A row can never be both.
        const onToggle = row.originKind === 'plugin' && row.pluginKey && row.capabilityId && onToggleServer
          ? (next: boolean) => onToggleServer({ pluginKey: row.pluginKey!, capabilityId: row.capabilityId! }, next)
          : row.builtinDpName && onToggleBuiltinDp
            ? (next: boolean) => onToggleBuiltinDp(row.builtinDpName!, next)
            : null
        // What this row SAYS about its credential — never what it does about
        // it. The Connect button moved to the server's detail page (owner
        // report 2026-08-01); `capabilityConnectTarget` is how that page finds
        // the same target this row used to compute.
        const authMarkerKey = mcpRowAuthMarkerKey(row)
        // P6.750 — the LIVE state outranks the stored one when it has something
        // to say: the pool (or, on claude, the child itself) knows a server
        // failed or came up with no tools, and stored config cannot. It falls
        // back to the credential marker, so a row with no live inventory reads
        // exactly as it did before this row.
        const liveMarker = mcpRowLiveStatusMarker(mcpRowWireName(row, catalog), serverStatuses)
        const markerKey = liveMarker?.key ?? authMarkerKey
        const slots = sourceCardSlots({ kind: 'mcp', description: row.description }, t)
        return (
          <McpEntityRow
            dataTestId={`mcp-server-row-${row.name}`}
            icon={
              // The SAME wrapper `SourceAvatar` puts around its icon, so an MCP
              // row's icon carries the status pip the ONE card calls for and the
              // same server looks identical in the aggregate Sources list.
              <span className="relative inline-flex shrink-0">
                <EntityIcon
                  size="sm"
                  fallbackIcon={McpIcon}
                  icon={row.iconUrl
                    ? { kind: 'file', value: row.iconUrl, colorable: false }
                    : { kind: 'fallback', colorable: false }}
                  alt={row.name}
                />
                <EntityStatusDot active={row.enabled} label={row.enabled ? 'active' : 'disabled'} />
              </span>
            }
            title={row.name}
            // The ONE card's slots (owner ruling 2026-08-01, NARROWING the
            // earlier "a row may carry MORE where it has a control": that
            // licence covers CONTROLS, not badges). So the content here is
            // exactly the aggregate Sources row's: the category as the title
            // meta and the description on line 2. Nothing else.
            //
            // What used to sit in `extras` and where it went: origin
            // (`Built-in`/`Plugin`/`User`) and transport (`stdio`) belong on
            // the detail page this row already opens; `Disabled` was
            // redundant beside the Switch in the overlay, which shows the
            // same state and can change it.
            titleTrailing={slots.titleTrailing}
            // Line 2: the row's statement when it has one — a sign-in is
            // outstanding, or the live pool reports a failure — in place of the
            // description, the way the aggregate list prints a non-connected
            // source (v0.15.1's rule, UB12.74). Silent on a healthy server — see
            // `mcpRowAuthMarkerKey` — so it reads the description there.
            subtitle={markerKey ? (
              <span
                // `text-destructive` is this tree's "errors, failed" red
                // (`index.css`); `text-info` is its amber, which the palette
                // comment itself labels "warnings, Ask mode" — there is no
                // `--warning` token here, as `SessionGoalBadge.tsx` records.
                // The same two colours v0.15.1's SOURCE_STATUS_CONFIG gives
                // Disconnected and Auth Required on the aggregate's line 2.
                className={liveMarker?.tone === 'warning'
                  ? 'flex min-w-0 items-center gap-1 text-destructive'
                  : 'flex min-w-0 items-center gap-1 text-info'}
                // The detail is the pool's own redacted failure reason, or its
                // skipped-tools line (F1.655); it rides the title so the row stays
                // two lines and the reason is reachable without the detail page.
                title={liveMarker?.detail}
                data-testid={liveMarker?.tone === 'warning'
                  ? `mcp-server-status-${row.name}`
                  : `mcp-server-auth-${row.name}`}
              >
                {liveMarker?.tone === 'warning'
                  ? <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                  : <KeyRound className="h-3 w-3 shrink-0" aria-hidden="true" />}
                <span className="truncate">{t(markerKey)}</span>
              </span>
            ) : slots.subtitle}
            onClick={row.capabilityKey && onOpenServer ? () => onOpenServer(row.capabilityKey!) : undefined}
            // Clearance so the title meta and line 2 never run under the
            // control. It stays the BUTTON's padding rather than the meta's
            // margin (UB12.74): the overlay is centred across both lines, so a
            // meta-only clearance would let line 2 run under the Switch.
            // Flat `pr-16` since 2026-08-01: the wider `pr-40` existed ONLY to
            // clear the Connect button that used to share this overlay, and the
            // Switch is now the whole of it — until P6.711's Reconnect shares
            // it again, which is exactly the case the wider value was for.
            buttonClassName={onReconnectServer && row.enabled ? 'pr-40' : 'pr-16'}
            overlay={
              // Sibling of the row button, never inside it: a switch nested in
              // a button is invalid markup and its click would select the row.
              <div className="absolute right-4 inset-y-0 flex items-center gap-2">
                {onReconnectServer && row.enabled && ( // F1.1260 — a switched-off server is in no pool: nothing to reconnect
                  <McpServerReconnectButton
                    wireName={mcpRowWireName(row, catalog)}
                    onReconnect={onReconnectServer}
                    testId={`mcp-server-reconnect-${row.name}`}
                  />
                )}
                {onToggle ? (
                  <Switch
                    checked={row.enabled}
                    disabled={!!row.capabilityId && pendingCapabilityId === row.capabilityId}
                    onCheckedChange={onToggle}
                    aria-label={t('mcpServers.toggleAria')}
                    data-testid={`mcp-server-toggle-${row.name}`}
                  />
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {row.enabled ? t('mcpServers.stateEnabled') : t('mcpServers.stateDisabled')}
                  </span>
                )}
              </div>
            }
          />
        )
      }}
    />
  )
}
