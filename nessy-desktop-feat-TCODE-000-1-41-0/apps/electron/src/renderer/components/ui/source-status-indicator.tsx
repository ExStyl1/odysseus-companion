/**
 * SourceStatusIndicator - Shows connection status for sources
 *
 * A small colored dot that indicates the source's connection status:
 * - Green: Connected/tested successfully
 * - Blue: Requires authentication
 * - Red: Failed to connect
 * - Gray, FILLED: Untested — nobody has tried it yet
 * - Gray, HOLLOW: switched off — local MCP disabled in Settings, or (UB12.87)
 *   a source the user turned off
 *
 * Hovering shows a tooltip with the status label and description.
 *
 * ## P6.681 — it rendered the right five statuses and could not be used
 *
 * Two defects, and each on its own was enough to keep every caller away. The
 * label/description pairs were HARDCODED ENGLISH, so mounting it on a
 * translated page put untranslated text there (`ClaudeImportPanel` says exactly
 * that beside the card that declined to use it). And it rendered a raw Radix
 * `Tooltip` root, which THROWS without a `TooltipProvider` ancestor — so it
 * worked only where somebody else had already mounted one, and failed at render
 * time rather than at review time everywhere else.
 *
 * Both are fixed here. The strings are `sourceStatus.*` keys read through
 * `useTranslation`, and the component carries its OWN `TooltipProvider`.
 * Nesting a provider inside the app's is legal in Radix and is the smaller of
 * the two honest options: the alternative — every call site remembering to wrap
 * it — is the arrangement that produced zero call sites.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
// P6.837 — the TOOLTIP SUBPATH, deliberately, not the `@nessy-agent/ui` barrel.
//
// This file is imported by `source-avatar.tsx`, which sixteen renderer files
// import. The barrel's own module graph reaches `PDFPreviewOverlay` and through
// it the Vite-only specifier `pdfjs-dist/build/pdf.worker.min.mjs?url`, which
// bun cannot resolve — so a Tooltip import here made the whole leaf
// un-loadable under `bun test`, and two suites ran ZERO tests while reporting
// one failure each (`Ran 1 test across 1 file` for a 34-case suite). Reading
// the fail count says one broken test; reading the FILE/case count says the
// suite is gone. `@nessy-agent/ui/ui/tooltip` resolves to
// `packages/ui/src/components/tooltip.tsx`, whose graph is react + Radix +
// clsx/tailwind-merge and nothing else.
//
// Keep it a subpath import. Restoring the barrel here re-breaks every suite
// that transitively renders a source avatar.
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@nessy-agent/ui/ui/tooltip'
import type { SourceConnectionStatus } from '@nessy-agent/shared/sources/types'
import type {
  SafeCapabilityAvailabilityState,
  SafeCapabilitySummary,
  SafeCredentialAvailabilityState,
} from '@nessy-agent/shared/protocol/capabilities'

export interface SourceStatusIndicatorProps {
  /**
   * Connection status — the five-status vocabulary plus UB12.87's `disabled`
   * ({@link SourceDisplayStatus}), so the pip says what line 2 and the pill say.
   */
  status?: SourceDisplayStatus
  /** Error message (shown in tooltip if status is 'failed') */
  errorMessage?: string
  /** Size variant */
  size?: 'xs' | 'sm' | 'md'
  /**
   * P6.745 — whether a `connected` dot animates.
   *
   * Default `true`, which is what every caller before P6.745 got. It is a
   * prop because the first LIST caller arrived: one ping beside one card
   * draws the eye to the card, and twenty pings down a Sources list draw it
   * nowhere. The pip on `SourceAvatar` therefore passes `false`, and the
   * colour still carries the whole verdict.
   */
  pulse?: boolean
  /** Additional className */
  className?: string
}

/**
 * Status configurations — colour here, WORDS in the locale files.
 *
 * The keys are written out as whole literals rather than composed from the
 * status name, because `check-i18n-reachable` counts a key as reached only when
 * it appears as a quoted literal in tracked source: a `sourceStatus.${status}`
 * template would mark the namespace reachable through a PREFIX verdict that has
 * to be classified by hand, and would report every one of these ten as dead the
 * day the prefix rule changed. (Twelve since UB12.87's `disabled` pair.)
 */
export const STATUS_CONFIG: Record<SourceDisplayStatus, {
  color: string
  pulseColor: string
  labelKey: string
  descriptionKey: string
}> = {
  connected: {
    color: 'bg-success',
    pulseColor: 'bg-success/80',
    labelKey: 'sourceStatus.connected.label',
    descriptionKey: 'sourceStatus.connected.description',
  },
  needs_auth: {
    color: 'bg-info',
    pulseColor: 'bg-info/80',
    labelKey: 'sourceStatus.needsAuth.label',
    descriptionKey: 'sourceStatus.needsAuth.description',
  },
  failed: {
    color: 'bg-destructive',
    pulseColor: 'bg-destructive/80',
    labelKey: 'sourceStatus.failed.label',
    descriptionKey: 'sourceStatus.failed.description',
  },
  untested: {
    color: 'bg-foreground/40',
    pulseColor: 'bg-foreground/30',
    labelKey: 'sourceStatus.untested.label',
    descriptionKey: 'sourceStatus.untested.description',
  },
  /**
   * P6.774 — the one status whose mark is a SHAPE, and why.
   *
   * Until this row `local_disabled` was `bg-foreground/30` against `untested`'s
   * `bg-foreground/40`: one opacity step, and nothing else. The playground entry
   * that renders all five at once said so in as many words, and the two dots are
   * the same grey to a sighted user at every size this component offers (6, 8
   * and 10 CSS pixels). The distinction P6.769 built — a server the user
   * switched off versus one nobody has tried — lived only in the tooltip and the
   * accessible name, which is to say only for a reader who hovers or uses a
   * screen reader.
   *
   * So the mark moved off the colour channel entirely: `local_disabled` is a
   * HOLLOW RING, every other status stays a filled dot (UB12.87: except
   * `disabled`, the other switched-off status, which wears the same ring — see
   * its entry). Chosen over a strike
   * because it needs no second element and no absolute positioning at three
   * sizes — the ring is the same two utilities at 6px as at 10px — and because
   * hollow reads as *nothing is there* while filled reads as *something is there,
   * unverified*, which is exactly the pair being separated.
   *
   * The ring is a full opacity step STRONGER than the fill it replaces
   * (`/50` against `/40`), deliberately: a 1px ring at 6px shows less ink than a
   * filled dot, so matching the opacity would have made the new mark read as
   * fainter-grey — another opacity difference, which is the defect.
   *
   * Tooltip and accessible name are UNCHANGED. The ring is a second channel for
   * the same verdict, not a replacement for the words.
   *
   * `border-solid` is not written: Tailwind v4's preflight sets `border: 0 solid`
   * on every element, so a width utility alone draws a solid ring, and this app
   * imports the full `tailwindcss` on the first line of `renderer/index.css`.
   * `bg-transparent` IS written, because `color` is the only slot this map has
   * for the fill and an unset one would inherit nothing predictable.
   */
  local_disabled: {
    color: 'bg-transparent border border-foreground/50',
    pulseColor: 'bg-foreground/20',
    labelKey: 'sourceStatus.localDisabled.label',
    descriptionKey: 'sourceStatus.localDisabled.description',
  },
  /**
   * UB12.87 — a source the user switched off (`state: 'disabled'`), the one
   * entry upstream v0.15.1 has no row for (its `SourceConnectionStatus` has no
   * per-source switch state). Until this row the pip read
   * {@link capabilitySummaryConnectionStatus}, whose rule 4 puts this state in
   * `untested`, so its tooltip and accessible name said "Not Tested" while the
   * Sources list's line 2 and the detail pill said "Disabled" (UB12.75).
   *
   * Decided: the mark is P6.774's HOLLOW RING, not `untested`'s filled grey.
   * P6.774 gave the ring to the pair it separates — *switched off* against
   * *nobody has tried it* — and this source is switched off. It also keeps the
   * mark aligned with the words: line 2 and the pill print `local_disabled` and
   * `disabled` with the one word "Disabled" in the one `off`/tertiary tone, so
   * the ring now means "Disabled" on every surface, and the tooltip says which
   * switch (Settings, or the source's own). The label is the Sources list's
   * word (`sourcesList.statusDisabled`: "Disabled" / «Отключён»); it is its own
   * `sourceStatus.*` key because this map's description sits under it.
   */
  disabled: {
    color: 'bg-transparent border border-foreground/50',
    pulseColor: 'bg-foreground/20',
    labelKey: 'sourceStatus.disabled.label',
    descriptionKey: 'sourceStatus.disabled.description',
  },
}

// Size configurations
const SIZE_CONFIG: Record<'xs' | 'sm' | 'md', string> = {
  xs: 'h-1.5 w-1.5',
  sm: 'h-2 w-2',
  md: 'h-2.5 w-2.5',
}

export function SourceStatusIndicator({
  status = 'untested',
  errorMessage,
  size = 'sm',
  pulse = true,
  className,
}: SourceStatusIndicatorProps) {
  const { t } = useTranslation()
  const config = STATUS_CONFIG[status]
  const sizeClass = SIZE_CONFIG[size]
  const description = t(config.descriptionKey)

  // Build tooltip description. The join is a colon rather than an eleventh
  // locale key: both locales punctuate a reason after a statement the same way,
  // and the two halves are already translated on their own.
  const tooltipDescription = status === 'failed' && errorMessage
    ? `${description}: ${errorMessage}`
    : description

  return (
    <TooltipProvider>
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          // A bare coloured dot has no accessible name, and the only text this
          // component owns lives in a tooltip that a screen reader never opens.
          // The localized LABEL is therefore also the element's own name.
          aria-label={t(config.labelKey)}
          data-source-status={status}
          className={cn(
            'relative inline-flex shrink-0',
            className
          )}
        >
          {/* Pulse animation for connected status */}
          {status === 'connected' && pulse && (
            <span
              className={cn(
                'absolute inline-flex rounded-full opacity-75 animate-ping',
                config.pulseColor,
                sizeClass
              )}
              style={{ animationDuration: '2s' }}
            />
          )}
          {/* Status dot */}
          <span
            className={cn(
              'relative inline-flex rounded-full',
              config.color,
              sizeClass
            )}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{t(config.labelKey)}</span>
          <span className="text-foreground/60">{tooltipDescription}</span>
        </div>
      </TooltipContent>
    </Tooltip>
    </TooltipProvider>
  )
}

/**
 * P6.745 — the same five-status verdict, read from the SAFE row the renderer
 * actually holds.
 *
 * There used to be a second mapping below this one, `deriveConnectionStatus`,
 * which read a source's CONFIG (`isAuthenticated`, `mcp.authType`,
 * `mcp.transport`, …). **P6.768 deleted it, and this is the record.** It had no
 * caller anywhere in `apps` or `packages` — the declaration and one mention in
 * this comment were the only two occurrences in the tree, untracked files
 * included — and it could not acquire one: no renderer surface holds that
 * shape. The Sources list, the management rows and the source detail page all
 * render `SafeCapabilitySummary`, which is path- and secret-free by
 * construction. That mismatch is why this component had no Sources-page caller
 * and why the pip on `SourceAvatar` was a BOOLEAN — green for
 * `state === 'active'`, grey for every other state, with the raw untranslated
 * state string as its accessible name. A source awaiting authorisation was
 * therefore indistinguishable from one that is simply switched off, and P6.745
 * had to write THIS function beside it rather than call it.
 *
 * It was also wrong where it was reachable: `if (!isAuthenticated) return
 * 'needs_auth'` followed by `if (isAuthenticated) return 'connected'` left its
 * `type === 'local'` and `untested` branches unreachable, so two of the five
 * statuses it named could never come out of it. Keeping a defective mapping
 * that nothing calls, against the day a surface with the wrong shape appears,
 * is how a second vocabulary gets born; the fix is this one function.
 *
 * One clause of it was worth keeping: a stdio server is `local_disabled` when
 * local MCP servers are switched off for the workspace. P6.769 kept it, on this
 * function's second parameter — a workspace setting belongs in a signature, not
 * inside a reader of a config the renderer never sees — reading the transport
 * half off `SafeCapabilitySummary.mcpTransport`.
 *
 * The mapping, and why each line is what it is:
 *
 * 1. **Credential first, before any state.** `views.ts:availabilityState` already
 *    folds a missing/expired credential into `state: 'missing-credential'`, so
 *    the state alone would answer most cases — but NOT the one that matters
 *    most. `resolver.ts` keeps a plugin http/sse server with DECLARED endpoint
 *    auth ENABLED while its credential slot is empty (the dp model; the comment
 *    there says in as many words that "credentialState still reports
 *    'missing'/'expired' for the UI"). Such a server is `state: 'active'` and
 *    awaiting sign-in, and reading the state first would paint it green.
 * 2. `'invalid'` is the trust-blocked row, which is a connection that will not
 *    be made — `failed`.
 * 3. `'active'` with a credential that is ready or not required is `connected`.
 * 4. **Everything else is `untested`, deliberately.** `disabled`, `shadowed`,
 *    `review-required` and `unsupported-runtime` are statements about
 *    availability, not about a connection ever having been attempted; calling
 *    any of them `failed` would invent a verdict. They stay grey, exactly as
 *    they were before this row. (UB12.75: the WORDS the Sources list's line 2
 *    and the detail pill print split one state out of it — see
 *    {@link capabilitySummaryDisplayStatus}; UB12.87: `SourceAvatar`'s pip
 *    reads that display status too. This function's verdict is unchanged.)
 *
 * **P6.769 gives `local_disabled` its producer, and it is the SECOND parameter.**
 * The status means "local MCP servers are off in Settings", which is a
 * workspace setting and a transport — two halves, and the summary carries only
 * the transport (`mcpTransport`). `SourcesListPanel` has held the other half as
 * a declared-but-never-destructured `localMcpEnabled` prop since before P6.745,
 * with `AppShell` dutifully passing it, so the setting reached the list and
 * stopped there. It now reaches here.
 *
 * Two things about that clause, both decided rather than inherited:
 *
 * - **It is tested FIRST, ahead of the credential.** `mcp-pool.ts` filters a
 *   stdio connection out entirely when the setting is off and marks it failed
 *   with "Local MCP servers are disabled for this workspace." — the server is
 *   never started, so a credential it would have needed is not the user's next
 *   move. Painting `needs_auth` there would name a remedy that changes nothing.
 * - **It is scoped to `stdio`.** The setting is `settings.workspace.localMcpServersDesc`,
 *   "Enable stdio subprocess servers", and `mcp-pool` gates exactly
 *   `config.type === 'stdio'`. An http/sse/ws server is untouched by it, and
 *   greying one out would invent a cause.
 *
 * The parameter DEFAULTS to `true`, so every caller that does not know the
 * setting — the mention menu, the selector popovers, the detail page — keeps the
 * verdict it had before this row rather than being told the servers are off.
 *
 * **UB14.48 (v0.15.0, "A failed source test shows in the list") gives `failed`
 * its stored producer.** `source_test` writes `connectionStatus: 'error'` (or
 * `'disconnected'` on a soft failure) into the source's config.json, and until
 * this row nothing the renderer holds carried it, so a source whose last test
 * failed painted green. The host now reads it into
 * `SafeCapabilitySummary.lastTestStatus`, already normalised by upstream's
 * `normalizeStoredStatus` (`packages/shared/src/sources/connection-status.ts`).
 * Its place in the order, stated rather than inherited:
 *
 * - **after `local_disabled` and `needs_auth`**, as the row orders it: a server
 *   that is switched off or awaiting sign-in names a remedy a stored verdict
 *   does not, and a failure recorded before either is stale against it;
 * - **before every state reading**, upstream's precedence (a stored status wins
 *   over the derived one): `source_test` refuses to auto-enable a source whose
 *   test failed, so the commonest failed source is a `disabled` one, and rule 4
 *   above would paint it grey — the defect itself.
 *
 * Only `failed` is read. A stored `connected`, `untested` or `needs_auth` keeps
 * today's verdict: rule 1's credential state is the authority for `needs_auth`
 * (P6.745), and a stored `connected` must not paint a disabled source green.
 * A later passing `source_test` stores `connected` and clears the error, which
 * returns the row to its state verdict.
 */
export function capabilitySummaryConnectionStatus(summary: {
  state: SafeCapabilityAvailabilityState
  credentialState: SafeCredentialAvailabilityState
  mcpTransport?: SafeCapabilitySummary['mcpTransport']
  lastTestStatus?: SafeCapabilitySummary['lastTestStatus']
}, localMcpEnabled = true): SourceConnectionStatus {
  if (summary.mcpTransport === 'stdio' && !localMcpEnabled) return 'local_disabled'
  if (summary.credentialState === 'missing' || summary.credentialState === 'expired') return 'needs_auth'
  if (summary.state === 'missing-credential') return 'needs_auth'
  if (summary.lastTestStatus === 'failed') return 'failed'
  if (summary.state === 'invalid') return 'failed'
  if (summary.state === 'active') return 'connected'
  return 'untested'
}

/**
 * UB12.75 — what a surface that PRINTS the verdict says: the pip's {@link capabilitySummaryConnectionStatus}, with
 * one state taken back out of rule 4's bucket.
 *
 * Upstream's `untested` (v0.15.1 `source-connection-status.ts` `deriveConnectionStatus`) means exactly one thing:
 * no check has been stored. Ours is wider by design (rule 4: `disabled`, `shadowed`, `review-required` and
 * `unsupported-runtime` all land there so no verdict is invented), and while it was only a grey dot that cost
 * nothing. UB14.57 (the Sources list's line 2) and UB14.59 (the detail page's state pill) made it TEXT, and a source
 * the user switched off — a built-in dp MCP, a plugin MCP — read "Not Tested" where its description used to be,
 * which is false for a source that was tested before it was switched off.
 *
 * Decided (row UB12.75): `state: 'disabled'` reads `'disabled'`, which both surfaces print as
 * `sourcesList.statusDisabled` ("Disabled" / «Отключён») in the same tertiary/off tone `untested` had. The word is
 * upstream's own label from the same table, and it is true of a source switched off for any reason, so no key is
 * added. Keeping the description instead was the other option; it was not taken because the detail pill has no
 * description to fall back to, and the two surfaces must say the same thing.
 *
 * Scope, stated rather than inherited:
 * - ONLY the `untested` outcome is refined. A disabled source whose last test failed still reads `failed`
 *   (UB14.48: the commonest failed source is a disabled one), and one with a missing credential still reads
 *   `needs_auth` (rule 1); `local_disabled` still wins first (P6.769).
 * - `shadowed`, `review-required` and `unsupported-runtime` keep "Not Tested" — none of them is a switch the user
 *   turned, and naming each would need its own words.
 * - The pip itself is unchanged: {@link STATUS_CONFIG} has no `disabled` entry, so its tooltip still names the
 *   grey dot "Not Tested" (P6.745). Its colour and the pill's `off` tone agree; the tooltip's words are the residue.
 *
 * **UB12.87 closes that residue.** {@link STATUS_CONFIG} now has a `disabled` entry (P6.774's hollow ring, with
 * `sourceStatus.disabled.*` words) and `SourceAvatar` passes THIS function's verdict to the pip, so the pip, line 2
 * and the pill name a switched-off source the same way. The other three rule-4 states still read "Not Tested" on
 * all three surfaces, as the bullet above decided.
 */
export type SourceDisplayStatus = SourceConnectionStatus | 'disabled'

export function capabilitySummaryDisplayStatus(
  summary: Parameters<typeof capabilitySummaryConnectionStatus>[0],
  localMcpEnabled = true,
): SourceDisplayStatus {
  const status = capabilitySummaryConnectionStatus(summary, localMcpEnabled)
  return status === 'untested' && summary.state === 'disabled' ? 'disabled' : status
}
