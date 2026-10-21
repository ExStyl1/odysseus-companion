import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, ChevronRight, Lock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ConnectionIcon } from '@/components/icons/ConnectionIcon'
import { modelTargetDisclosure } from '@/lib/model-target-disclosure'
import type { LlmConnectionWithStatus } from '@config/llm-connections'
import type { ModelProvider } from '@config/models'
import { RuntimeSwitchDialog, type RuntimeSwitchPending } from './RuntimeSwitchDialog'
import {
  classifyConnectionSwitch,
  runtimeForProviderType,
  runtimeLabel,
  runtimeSwitchCopyKey,
} from './runtime-switch-copy'
import type { RuntimeSwitchPreview } from '@nessy-agent/shared/protocol'

/**
 * The half of `previewRuntimeSwitch` the dialog actually renders (P3.266).
 *
 * A `Pick` of the wire type rather than two loose parameters, because the plan
 * and its reason are one decision: `planHistoryCarry` returns them together, and
 * a caller that could supply one without the other could make the modal explain
 * a promise it is not making. Derived from `RuntimeSwitchPreview` so a rename on
 * the wire breaks the build here rather than silently answering `undefined`.
 *
 * The `-?` is not tidying. On the wire both fields are OPTIONAL, because a
 * server that predates either omits it; in the renderer both are REQUIRED and
 * explicitly `null`, because "the preview did not answer" is a state every
 * consumer here has to handle and an optional field lets it be forgotten. The
 * mapped form converts one convention to the other while keeping the field names
 * and their value types derived rather than restated.
 */
export type RuntimeSwitchPreviewAnswer = {
  [K in keyof Pick<RuntimeSwitchPreview, 'historyCarry' | 'historyCarryReason'>]-?:
    NonNullable<RuntimeSwitchPreview[K]> | null
}

/**
 * The runtime is named on every integration row, always.
 *
 * Two integrations can look identical — same vendor, same models — and answer
 * through completely different agents. Without the mark the user has no way to
 * know that one of these switches costs them the runtime's working memory and
 * the other does not.
 */
export function RuntimeBadge({ runtime, className }: { runtime: ModelProvider; className?: string }) {
  // UB14.30 — on v0.15.1's role tokens: the composer's quiet row badge (the mode menu's, UB14.29).
  return (
    <span
      data-runtime-badge={runtime}
      className={cn(
        'rounded-xs bg-fill-hover px-1.5 py-0.5 text-caption text-secondary',
        'select-none shrink-0',
        className,
      )}
    >
      {runtimeLabel(runtime)}
    </span>
  )
}

/**
 * DA2.6 — the mark on an integration whose target is outside the gateway.
 *
 * PLACEMENT AND GLYPH ARE READ, NOT DRAFTED (ODR-2). nessy-cli marks exactly
 * this at HEAD — `packages/cli/src/ui/components/mcp/steps/ServerListStep.tsx`
 * appends a lock glyph plus a short label to a list row, and its own locale file
 * carries the pair (`for external models` / `для внешних моделей`). What differs
 * is the CLAIM, and it differs because the mechanisms differ: theirs marks a
 * server it BLOCKS, and this product blocks nothing (DA2.1's resolution, DA2.3's
 * refusal of the wire filter). So the label says what leaves rather than what is
 * held back, and the full sentence with the host rides the title.
 *
 * A lucide `Lock` rather than the donor's emoji: every other mark in this picker
 * is a lucide glyph, and one emoji among them reads as a different system.
 *
 * Classified per CONNECTION, on its own default model — the row is a choice of
 * integration, and the endpoint is the dominant term: a namespace can only ever
 * move the verdict toward *not* disclosing (`tgpt/…` is inside the perimeter),
 * so a row with no default model discloses rather than stays silent. The picker
 * re-states the verdict for the model actually selected, once, under the list.
 */
function TargetDisclosureMark({ connection }: { connection: LlmConnectionWithStatus }) {
  const { t } = useTranslation()
  // D1.246 — the providerType is passed so this mark sees what the backend sees:
  // without it an endpoint-less connection kept the pre-D1.221 silent verdict
  // here while the host withheld MCP servers from the same session.
  const owed = modelTargetDisclosure({
    baseUrl: connection.baseUrl,
    model: connection.defaultModel,
    providerType: connection.providerType,
    // F1.572 — a subscription card's endpoint, derived as the backend derives it.
    codexModelProvider: connection.codexModelProvider,
    piAuthProvider: connection.piAuthProvider,
  })
  if (!owed) return null
  return (
    <span
      data-testid="connection-target-disclosure"
      // An empty host is a connection with no endpoint of its own (or a stored
      // URL that did not parse): there is no name to print, so the sentence that
      // promises one is not the sentence to use. Both keys spelled as LITERALS —
      // a composed key is invisible to `check-i18n-reachable`.
      title={owed.host
        ? t('chat.modelPicker.toolEgressDisclosure', { host: owed.host })
        : t('chat.modelPicker.toolEgressProviderDefault')}
      className="flex items-center gap-1 text-caption font-normal text-tertiary shrink-0"
    >
      <Lock className="size-2.5" />
      {t('chat.modelPicker.toolEgressBadge')}
    </span>
  )
}

interface ConnectionRowProps {
  /** Every configured connection, in the order the picker should list them. */
  connections: LlmConnectionWithStatus[]
  /** The connection this session is on, resolved. */
  activeConnection: LlmConnectionWithStatus | null
  /** `ComposerCapabilities.connection.switchable` — the SERVER's answer. */
  switchable: boolean
  /** Whether the session has a transcript; decides if the switch is confirmed. */
  hasHistory: boolean
  /** A turn is in flight: the backend cannot be replaced under a running stream. */
  busy?: boolean
  /** The session's connection has been deleted. */
  unavailable?: boolean
  onSwitch: (connectionSlug: string) => void
  /**
   * Ask the server what a switch to this connection WOULD carry, before the
   * confirmation dialog opens. Read-only; see `previewRuntimeSwitch`.
   *
   * Optional, and a rejection is not fatal: without an answer the dialog simply
   * omits its "what will cross" line. The switch itself never depends on it.
   */
  onPreviewSwitch?: (connectionSlug: string) => Promise<RuntimeSwitchPreviewAnswer | null>
  /**
   * Start with the target list open. The playground's "integration list open" state and the menu's render test use
   * it (UB14.30); the composer never passes it, so the list still opens on a click only.
   */
  defaultExpanded?: boolean
}

/**
 * The integration control, rendered ABOVE the model list and never interleaved
 * with it.
 *
 * This is the whole point of the two-control shape. The picker used to render
 * a provider → connection → model tree, so a tap on a model nested under
 * another integration changed the integration AND the model in one gesture —
 * which is why "did you mean to change runtime?" had to be inferred from where
 * the tap landed. With the integration on its own row, the model list only
 * ever shows the ACTIVE integration's models, a model tap can never move a
 * session, and the confirmation attaches to exactly one control and therefore
 * fires once per real decision.
 *
 * `nestor-cloud-agent` is filtered out of the target list: it is out of scope
 * as a switch target and as a source (the server refuses it too, with
 * `CONNECTION_NOT_SWITCHABLE`).
 */
export function ConnectionRow({
  connections,
  activeConnection,
  switchable,
  hasHistory,
  busy = false,
  unavailable = false,
  onSwitch,
  onPreviewSwitch,
  defaultExpanded = false,
}: ConnectionRowProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = React.useState(defaultExpanded)
  const [pending, setPending] = React.useState<RuntimeSwitchPending | null>(null)
  /**
   * Slug whose carry plan is being fetched, or `null`.
   *
   * The smallest honest pending state: `pick` now awaits a server round trip on
   * the ONE tier that needs it (cross-runtime), and a control that starts work
   * has to say so. Every other tier — a model change, a same-runtime switch, an
   * empty session — takes exactly the path it took before, with no await and no
   * spinner, so the common gestures are unchanged.
   */
  const [previewing, setPreviewing] = React.useState<string | null>(null)

  const targets = React.useMemo(
    () => connections.filter(c => c.providerType !== 'nestor-cloud-agent'),
    [connections],
  )

  const activeRuntime = activeConnection ? runtimeForProviderType(activeConnection.providerType) : null
  const canOpen = switchable && !busy && !previewing && targets.length > 1

  const pick = React.useCallback(async (target: LlmConnectionWithStatus) => {
    setExpanded(false)
    if (target.slug === activeConnection?.slug) return
    // A second pick while the first is still being previewed would open the
    // dialog twice. The list is already collapsed, so this only guards a
    // double-fire.
    if (previewing) return
    const kind = classifyConnectionSwitch(
      {
        ...(activeConnection?.slug ? { slug: activeConnection.slug } : {}),
        runtime: activeRuntime ?? 'pi',
      },
      { slug: target.slug, runtime: runtimeForProviderType(target.providerType) },
    )
    // No copy for this tier means no question: a model change, or a session
    // with nothing to lose. Do it.
    if (!runtimeSwitchCopyKey(kind, hasHistory)) {
      onSwitch(target.slug)
      return
    }
    // Only the cross-runtime tier has a carry to promise, so only it pays for
    // the round trip. A same-runtime switch opens the dialog synchronously,
    // exactly as before.
    if (kind !== 'connection-cross-runtime' || !onPreviewSwitch) {
      setPending({ kind, from: activeConnection, to: target, historyCarry: null, historyCarryReason: null })
      return
    }
    setPreviewing(target.slug)
    // A preview that fails must never block a switch: the dialog opens with no
    // carry line, which is the same modal the user saw before this existed.
    //
    // P3.266 · the plan and its reason travel as ONE answer rather than two
    // awaited values. They are decided together by one call to
    // `planHistoryCarry`, and a shape that lets them arrive separately is a
    // shape in which the dialog can explain a promise it is not making.
    const preview = await onPreviewSwitch(target.slug).catch(() => null)
    setPreviewing(null)
    setPending({
      kind,
      from: activeConnection,
      to: target,
      historyCarry: preview?.historyCarry ?? null,
      historyCarryReason: preview?.historyCarryReason ?? null,
    })
  }, [activeConnection, activeRuntime, hasHistory, onSwitch, onPreviewSwitch, previewing])

  // UB14.30 — v0.15.1's menu vocabulary (`ComposerModelMenu`'s group label and rows, `bg-fill-selected`,
  // `text-disabled`, `size-* text-secondary` glyphs), so the integration rows read as rows of the same menu in both
  // pickers; the row stays ours (upstream has no runtime switch).
  return (
    <>
      <div className="px-2 pt-2 pb-1 text-label-sm font-medium text-tertiary select-none">
        {t('chat.runtimeSwitch.integration')}
      </div>
      <div>
        <button
          type="button"
          disabled={!canOpen}
          aria-expanded={expanded}
          onClick={() => setExpanded(prev => !prev)}
          className={cn(
            'flex min-h-row-menu w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:duration-instant',
            canOpen ? 'hover:bg-fill-hover active:bg-fill-pressed' : 'cursor-default',
            busy && 'opacity-60',
          )}
        >
          {unavailable || !activeConnection ? (
            <div className="flex size-4 shrink-0 items-center justify-center rounded-xs bg-destructive-tint">
              <AlertTriangle className="size-2.5 text-destructive" />
            </div>
          ) : (
            <ConnectionIcon connection={activeConnection} size={16} />
          )}
          <div className="flex-1 min-w-0">
            <div className={cn('text-label font-medium truncate', (unavailable || !activeConnection) && 'text-destructive')}>
              {activeConnection && !unavailable
                ? activeConnection.name
                : t('chat.connectionUnavailable')}
            </div>
            {busy && (
              <div className="text-label-sm text-tertiary">{t('chat.runtimeSwitch.busy')}</div>
            )}
            {/* The pick is committed and the server is being asked what it
                would carry. Named on the control that was clicked, because the
                list has already collapsed and nothing else on screen moves. */}
            {!busy && previewing && (
              <div className="text-label-sm text-tertiary">{t('chat.runtimeSwitch.checking')}</div>
            )}
          </div>
          {activeConnection && !unavailable && <TargetDisclosureMark connection={activeConnection} />}
          {activeRuntime && !unavailable && <RuntimeBadge runtime={activeRuntime} />}
          {canOpen && (
            <ChevronRight
              className={cn('size-3.5 shrink-0 text-tertiary transition-transform', expanded && 'rotate-90')}
            />
          )}
        </button>

        {expanded && (
          <div className="flex flex-col gap-0.5 pb-1">
            {targets.map(conn => {
              const isCurrent = conn.slug === activeConnection?.slug
              const runtime = runtimeForProviderType(conn.providerType)
              return (
                <button
                  key={conn.slug}
                  type="button"
                  disabled={!conn.isAuthenticated}
                  onClick={() => { void pick(conn) }}
                  className={cn(
                    'flex min-h-row-menu w-full items-center gap-2 rounded-md py-1.5 pl-6 pr-2 text-left transition-colors hover:duration-instant',
                    !conn.isAuthenticated && 'cursor-not-allowed text-disabled',
                    conn.isAuthenticated && 'hover:bg-fill-hover active:bg-fill-pressed',
                    isCurrent && 'bg-fill-selected',
                  )}
                >
                  <ConnectionIcon connection={conn} size={14} />
                  <div className="flex-1 min-w-0">
                    <div className="text-label font-medium truncate">{conn.name}</div>
                    {!conn.isAuthenticated && (
                      <div className="text-label-sm text-tertiary">{t('settings.ai.notAuthenticated')}</div>
                    )}
                  </div>
                  <TargetDisclosureMark connection={conn} />
                  <RuntimeBadge runtime={runtime} />
                  {isCurrent && <Check className="size-3.5 shrink-0 text-secondary" />}
                </button>
              )
            })}
          </div>
        )}
      </div>
      <div className="my-1 h-px bg-separator" />

      <RuntimeSwitchDialog
        pending={pending}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const target = pending?.to.slug
          setPending(null)
          if (target) onSwitch(target)
        }}
      />
    </>
  )
}
