import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { SourceAvatar } from '@/components/ui/source-avatar'
import {
  CapabilityDetailTemplate,
  connectionStatePill,
  CapabilityMcpToolsSection,
  CapabilityPermissionsSection,
  CapabilityResources,
  Info_Section,
  useCapabilityMcpTools,
  useCapabilityPrimaryContent,
} from '@/components/info'
import { buildSourceMetadata } from './capability-info-metadata'
import { SourceDetailConnect, SourceDetailMenu } from '@/components/app-shell/SourceDetailActions'
import { capabilitySummaryDisplayStatus } from '@/components/ui/source-status-indicator'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import { capabilityContext, capabilityDisplayName, capabilityKeyFromRoute, isSafeSourceRow, sourceTypeFor } from '@/lib/capability-catalog'
import type { SafeCapabilityDetail } from '@nessy-agent/shared/protocol/capabilities'

interface SourceInfoPageProps {
  sourceSlug: string
  workspaceId: string
}

export default function SourceInfoPage({ sourceSlug, workspaceId }: SourceInfoPageProps) {
  const { t } = useTranslation()
  const app = useOptionalAppShellContext()
  const context = React.useMemo(
    () => app?.capabilityContext ?? capabilityContext(workspaceId),
    [app?.capabilityContext, workspaceId],
  )
  const capabilityKey = capabilityKeyFromRoute(sourceSlug)
  const [detail, setDetail] = React.useState<SafeCapabilityDetail | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      setError(null)
      setDetail(await window.electronAPI.capabilities.getDetail(context, capabilityKey))
    } catch {
      setDetail(null)
      setError(t('sourceInfo.failedToLoad'))
    }
  }, [capabilityKey, context, t])

  React.useEffect(() => { void load() }, [load])
  React.useEffect(() => window.electronAPI.capabilities.onChanged((event) => {
    if (event.workspaceId === workspaceId) void load()
  }), [load, workspaceId])

  // P6.773 — the workspace's "Enable stdio subprocess servers" setting, which
  // is the one input `local_disabled` needs and the one thing a
  // `SafeCapabilityDetail` does not carry. `mcp-pool.ts` refuses to start a
  // stdio server while it is off ("Local MCP servers are disabled for this
  // workspace."), so without this the detail page shows the pip of a server
  // nobody has tested yet for one the user deliberately switched off.
  //
  // Read here rather than taken as a prop: this page already owns
  // `workspaceId` and already runs its own effects against `window.electronAPI`
  // (the two above), and `getWorkspaceSettings` is exactly how `AppShell` and
  // `WorkspaceSettingsPage` read the same value — no new mechanism, and no
  // dependence on being mounted inside the app shell, which this page is not
  // guaranteed to be (`useOptionalAppShellContext`).
  //
  // It stays `true` when the read fails, matching `SourceAvatar`'s own default:
  // saying "switched off" on the strength of not knowing is a worse answer than
  // the one the page had.
  const [localMcpEnabled, setLocalMcpEnabled] = React.useState(true)
  React.useEffect(() => {
    let cancelled = false
    window.electronAPI.getWorkspaceSettings(workspaceId).then((settings) => {
      if (!cancelled && settings) setLocalMcpEnabled(settings.localMcpEnabled ?? true)
    }).catch((err) => {
      console.error('[SourceInfoPage] Failed to load workspace settings:', err)
    })
    return () => { cancelled = true }
  }, [workspaceId])

  const summary = detail?.summary
  const displayName = summary ? capabilityDisplayName(summary) : capabilityKey
  const content = useCapabilityPrimaryContent(context, detail)
  // U3b finding 1: gate on the effective source type, not the raw `sourceType`
  // field. Native `.mcp.json` records (kind:'mcp') and plugin connectors leave
  // `sourceType` unset, so `sourceTypeFor` (which maps kind:'mcp' → 'mcp') is
  // the correct predicate — otherwise those never show the Tools section
  // despite full backend support.
  const isMcpSource = !!summary && isSafeSourceRow(summary) && sourceTypeFor(summary) === 'mcp'
  // Auto-peek the tools list on open, but only for an MCP source (known once
  // the detail loads) so a non-MCP detail never fires a pointless RPC.
  const mcpTools = useCapabilityMcpTools(context, capabilityKey, { enabled: isMcpSource })

  const metadata = React.useMemo(
    () => (detail ? buildSourceMetadata(detail, t) : []),
    [detail, t],
  )

  // UB14.59 — the hero of v0.15.1 `pages/SourceInfoPage.tsx`: a state pill on the meta line (the
  // same verdict the avatar's pip shows, `localMcpEnabled` included) and the type sharing one text
  // run with the tagline ("MCP · …") so a wrap never strands the dot. UB12.75: a source the user
  // switched off reads "Disabled", as its Sources-list row does, not rule 4's "Not Tested".
  const sourceRow = summary && isSafeSourceRow(summary) ? summary : null
  const statePill = sourceRow
    ? connectionStatePill(capabilitySummaryDisplayStatus(sourceRow, localMcpEnabled), t)
    : undefined
  const typeLabelKey = sourceRow ? SOURCE_TYPE_LABEL_KEYS[sourceTypeFor(sourceRow)] : undefined
  const tagline = [typeLabelKey ? t(typeLabelKey) : null, summary?.description].filter(Boolean).join(' · ') || null

  return (
    <CapabilityDetailTemplate
      loading={!detail && !error}
      error={error ?? undefined}
      summary={summary ?? EMPTY_SUMMARY}
      displayName={displayName}
      avatar={summary ? <SourceAvatar source={summary} fluid showStatus localMcpEnabled={localMcpEnabled} /> : null}
      statePill={statePill}
      tagline={tagline}
      // The same single Enable/Disable the row's "…" menu offers, for the same
      // kinds (owner decision 2026-08-01), as the header's "⋯" (UB14.59), and
      // Connect beside the name. Mounted only inside the app shell — they read
      // the catalog and the built-in dp view from there — and each renders
      // nothing at all when it has nothing to offer.
      {...(app && sourceRow
        ? {
            headerActions: <SourceDetailMenu source={sourceRow} />,
            actions: <SourceDetailConnect source={sourceRow} />,
          }
        : {})}
      content={{
        status: content.status,
        markdown: content.markdown,
        errorMessage: content.errorMessage,
        fileRefs: content.fileRefs,
        onOpenFileRef: content.onOpenFileRef,
        onRetry: content.retry,
      }}
      metadata={metadata}
      diagnostics={detail?.diagnostics}
      kindSections={
        detail ? (
          <>
            {/* MCP-transport sources: lazy tools list (collapsed until loaded).
                Only for the mcp source kind — other source kinds expose no
                MCP tools, so the section does not apply to them. */}
            {isMcpSource && (
              <CapabilityMcpToolsSection
                state={mcpTools.state}
                onLoad={mcpTools.load}
                onRetry={mcpTools.retry}
              />
            )}
            {/* Permissions apply to the source kind: always render, with a
                placeholder inside when the source carries no permission rules. */}
            <CapabilityPermissionsSection permissions={detail.permissions} />
            {detail.resources.length > 0 && (
              <Info_Section
                title={t('sourceInfo.documentation')}
                description={summary?.readOnly ? t('sourceInfo.managedByPlugin') : undefined}
              >
                <CapabilityResources context={context} detail={detail} />
              </Info_Section>
            )}
          </>
        ) : undefined
      }
    />
  )
}

/** v0.15.1 `pages/SourceInfoPage.tsx` `SOURCE_TYPE_LABEL_KEYS`: the type named on the hero's meta line. */
const SOURCE_TYPE_LABEL_KEYS: Record<ReturnType<typeof sourceTypeFor>, string> = {
  mcp: 'sourcesList.typeMcp',
  api: 'sourcesList.typeApi',
  local: 'sourcesList.typeLocal',
}

// CapabilityDetailTemplate requires a summary; during the initial load/error
// states it is gated behind `loading`/`error` and never rendered, so a minimal
// placeholder satisfies the type without ever reaching the DOM.
const EMPTY_SUMMARY = {} as SafeCapabilityDetail['summary']
