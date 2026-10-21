/**
 * CapabilityMcpToolsSection (U3)
 *
 * MCP-source kind-specific section: the list of tools a connected MCP server
 * reports (name + description). LAZY — collapsed by default with a "Load tools"
 * affordance; the tools list is fetched only when the user expands it (the
 * caller wires `onLoad` to the `capabilities.listMcpTools` RPC), so a detail
 * mount never reconnects a pool.
 *
 * Placeholder-not-hidden (U1 principle): the section ALWAYS renders for an MCP
 * source. Its states:
 *   - collapsed:    idle, before first load (Load button)
 *   - loading:      skeleton rows
 *   - ok:           tools table (name / description) at Info_Table density
 *   - empty:        "No tools reported." (ok with zero tools)
 *   - error:        fail-soft placeholder + retry
 *   - disabled:     source not active → explanatory placeholder (no retry)
 *   - disconnected: source active but not connected in this chat → placeholder
 *   - no-session:   opened without a live chat → placeholder
 *
 * IPC-free + callback-driven so it is exercised in the playground and unit
 * tests without touching window.electronAPI; SourceInfoPage owns the RPC.
 *
 * UB14.59 — v0.15.1 `pages/SourceInfoPage.tsx`'s Tools section look: the count beside
 * the title once the list has loaded (never while collapsed, loading, failed or
 * refused, where there is no count to state), the failure as a plain message in the
 * card (`px-3.5 py-3`, `text-label text-secondary`), the name in mono and the
 * description on the secondary role. Ours has no raw transport text to put under
 * Technical details (`{ status: 'error' }` carries none), so the well keeps its retry.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { RotateCw } from 'lucide-react'
import { Info_Section } from './Info_Section'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { SafeMcpTool, SafeMcpToolsRefusalCode } from '@nessy-agent/shared/protocol/capabilities'

/** UI state of the tools section, decoupled from the RPC result shape. */
export type CapabilityMcpToolsState =
  | { status: 'collapsed' }
  | { status: 'loading' }
  | { status: 'ok'; tools: SafeMcpTool[] }
  | { status: 'error' }
  | { status: 'refused'; reason: SafeMcpToolsRefusalCode }

export interface CapabilityMcpToolsSectionProps {
  state: CapabilityMcpToolsState
  /** Expand + load trigger (collapsed state's Load button). */
  onLoad?: () => void
  /** Retry trigger (error state). */
  onRetry?: () => void
}

function SkeletonBar({ className }: { className?: string }) {
  return <div className={cn('h-3 animate-pulse rounded-xs bg-fill-hover', className)} />
}

/** Localized placeholder copy for a fail-soft refusal reason. */
function refusalMessageKey(reason: SafeMcpToolsRefusalCode): string {
  switch (reason) {
    case 'disabled':
      return 'sourceInfo.toolsDisabledPlaceholder'
    case 'disconnected':
      return 'sourceInfo.toolsDisconnected'
    // A recorded connect failure, not a cold server: retrying yields the same
    // outcome until the source's config changes, so say so rather than offering
    // a Load button that will fail again.
    case 'failed':
      return 'sourceInfo.toolsFailed'
    case 'no-session':
      return 'sourceInfo.toolsNoSession'
    // 'not-mcp' should not reach this section (only rendered for MCP sources),
    // and 'error' is handled as its own state; both fall back to the generic
    // error copy so the section never renders blank.
    default:
      return 'sourceInfo.toolsError'
  }
}

export function CapabilityMcpToolsSection({ state, onLoad, onRetry }: CapabilityMcpToolsSectionProps) {
  const { t } = useTranslation()

  const actions =
    state.status === 'collapsed' && onLoad ? (
      <Button variant="ghost" size="sm" onClick={onLoad} data-testid="mcp-tools-load">
        {t('sourceInfo.loadTools')}
      </Button>
    ) : undefined

  return (
    <Info_Section
      title={t('sourceInfo.tools')}
      count={state.status === 'ok' ? state.tools.length : undefined}
      description={t('sourceInfo.toolsDesc')}
      actions={actions}
    >
      {state.status === 'collapsed' && (
        <p className="px-3.5 py-3 text-label text-tertiary" data-testid="mcp-tools-collapsed">
          {t('sourceInfo.toolsDesc')}
        </p>
      )}

      {state.status === 'loading' && (
        <div className="space-y-3 p-3.5" aria-busy="true" data-testid="mcp-tools-loading">
          <SkeletonBar className="w-1/3 h-4" />
          <SkeletonBar className="w-full" />
          <SkeletonBar className="w-4/5" />
        </div>
      )}

      {state.status === 'error' && (
        <div className="flex flex-col items-start gap-2 px-3.5 py-3" data-testid="mcp-tools-error">
          <p className="text-label text-secondary">{t('sourceInfo.failedToLoadTools')}</p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-label-sm text-secondary transition-colors duration-micro ease-out-subtle hover:bg-fill-hover hover:text-foreground hover:duration-instant focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              data-testid="mcp-tools-retry"
            >
              <RotateCw className="size-3.5" aria-hidden />
              {t('capabilityDetail.retry')}
            </button>
          )}
        </div>
      )}

      {state.status === 'refused' && (
        <p className="px-3.5 py-3 text-label text-tertiary" data-testid="mcp-tools-refused">
          {t(refusalMessageKey(state.reason))}
        </p>
      )}

      {state.status === 'ok' &&
        (state.tools.length === 0 ? (
          <p className="px-3.5 py-3 text-label text-tertiary" data-testid="mcp-tools-empty">
            {t('sourceInfo.noToolsReported')}
          </p>
        ) : (
          <div className="py-1">
            {/* No inner frame: Info_Section is the single surface layer
                (reviewer feedback 2026-07-19, same as the U2 tables). */}
            <div className="overflow-hidden">
              <table className="w-full text-label">
                <thead>
                  {/* The data tables' header role (`INFO_TABLE_HEADER_CLASS` in Info_DataTable.tsx), written
                      out: importing it would pull @tanstack/react-table into this section's graph. */}
                  <tr className="border-b border-subtle text-left text-label-sm text-tertiary">
                    <th className="w-[220px] px-3.5 py-2.5 font-medium">{t('common.name')}</th>
                    <th className="px-3.5 py-2.5 font-medium">{t('common.description')}</th>
                  </tr>
                </thead>
                <tbody>
                  {state.tools.map((tool, index) => (
                    <tr
                      key={`${tool.name}:${index}`}
                      className={index < state.tools.length - 1 ? 'border-b border-subtle' : undefined}
                      data-testid="mcp-tool-row"
                    >
                      <td className="px-3.5 py-2.5 align-top">
                        <code className="break-all font-mono text-mono-ui font-medium text-foreground">{tool.name}</code>
                      </td>
                      <td className="px-3.5 py-2.5 align-top text-secondary">
                        {displayMcpToolDescription(tool.description)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
    </Info_Section>
  )
}

/**
 * F1.1259 — the built-in dp MCP servers lead every tool description with an
 * attestation envelope, `|mcp-tool-attestation|<base64>|/mcp-tool-attestation|`,
 * which is the server's own text and meant for the model's side. The Tools
 * table drops a LEADING envelope (and the whitespace after it) for display
 * only; anything else, an envelope later in the text included, is shown as
 * written, and nothing the runtime sends the model changes.
 */
const MCP_TOOL_ATTESTATION_PREFIX = /^\s*\|mcp-tool-attestation\|[^|]*\|\/mcp-tool-attestation\|\s*/

export function displayMcpToolDescription(description: string | undefined): string {
  return (description ?? '').replace(MCP_TOOL_ATTESTATION_PREFIX, '')
}
