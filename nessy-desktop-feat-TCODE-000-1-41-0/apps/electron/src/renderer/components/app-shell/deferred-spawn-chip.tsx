/**
 * P6.334 — out-of-scope work the agent notices becomes a CHIP, not a session.
 *
 * The row's `done_means`, verbatim: *"the agent proposes work, NOTHING runs
 * until the user clicks, and the clicked session starts isolated in its own
 * worktree."* All three clauses are the whole subject here, and each is a
 * separate property of this file:
 *
 *  1. **Nothing runs until the click.** This component has no effect of any
 *     kind on mount. It renders a proposal the agent made and stops. The tool
 *     that made it is `spawn_session` in its DEFERRED form — everything else
 *     that tool needs (`prompt`, `permissionMode`, `workingDirectory`,
 *     `labels`, `safeMode: 'block'`) already exists; the deferral is the one
 *     missing piece, and its declaration is another package's file (see this
 *     row's report).
 *  2. **The click is the only thing that starts anything**, and it starts it
 *     the same way the user's own New Chat in Worktree does.
 *  3. **Isolated, by the host's own port.** The click is
 *     `navigate(routes.action.newSession({ input, name, worktree: true, send:
 *     true }))` — P6.133's route, whose handler sets `createOptions.worktree`
 *     only for a TRUSTED in-app navigation (`NavigationContext.tsx`, the
 *     `link.trusted && parsed.params.worktree === 'true'` guard). That guard is
 *     why this must be a `navigate` and not a deep link: creating a worktree
 *     runs git and takes a host lease, so an untrusted page must not be able to
 *     cause one with a single click. The port refuses rather than falling back —
 *     a session that asked for isolation and got the live checkout is the one
 *     outcome the request rules out — and the refusal is already named by
 *     `describeSessionCreateFailure`.
 *
 * ## Why the isolation note is on the chip and not only in a doc
 *
 * The chip is asking for a click that runs a git command and starts an agent.
 * What bounds that is the worktree, so the sentence saying so is part of the
 * affordance rather than a footnote: a user who reads "starts in its own git
 * worktree" knows what a wrong proposal can cost before clicking, and a user who
 * does not read it is not worse off than they are with New Chat in Worktree.
 *
 * ## What is deliberately absent
 *
 * No "run all", no auto-accept, and no timer. Every one of those turns a
 * proposal back into the immediate spawn this row exists to stop.
 *
 * ## Look (UB14.18)
 *
 * Each proposal is a sunken well (`PreviewBlockFrame`'s material, the plate
 * stack's other wells beside it): the branch icon in the 16px row slot, the
 * caption in the tertiary ink, the name in the foreground, the isolation note
 * under it, then Start as a secondary `Button` — an offer, not the screen's one
 * forward action — and dismiss as a named icon button.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { GitBranchPlus, X } from 'lucide-react'
import { Button, IconButton } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { routes } from '../../../shared/routes'
import { CARD_WELL_FRAME, ROW_ICON_SIZE, ROW_ICON_SLOT } from './transcript-card-chrome'

/** One piece of work the agent proposed and did not start. */
export interface DeferredSpawnProposal {
  /** Stable id, so dismissing one chip does not disturb its siblings. */
  id: string
  /** The one-line name the session would take. */
  name: string
  /** The prompt the spawned session would receive. */
  prompt: string
}

/**
 * The route ONE accepted proposal navigates to — exported so the isolation
 * claim can be asserted as a string rather than inferred from a rendered chip.
 *
 * `worktree: true` is the whole point and the route builder drops the parameter
 * unless it is exactly that, so a boolean that arrives as a string, or as
 * `undefined` from a spread, silently produces a session in the LIVE checkout.
 * That is the one outcome this row rules out, which is why it has its own test.
 */
export function deferredSpawnRoute(proposal: DeferredSpawnProposal): string {
  return routes.action.newSession({
    input: proposal.prompt,
    name: proposal.name,
    worktree: true,
    send: true,
  })
}

export interface DeferredSpawnChipsProps {
  proposals: readonly DeferredSpawnProposal[]
  /**
   * Navigates to the route one accepted proposal produces.
   *
   * Injected rather than taken from `useNavigation` inside this file: the
   * navigation context is what makes a chat component untestable on its own,
   * and `ChatDisplay` — the only mount — already holds `navigate`. It must be a
   * `navigate` and NOT a deep link: the handler honours `worktree` only for a
   * trusted in-app route, because creating one runs git and takes a host lease.
   */
  onStart?: (route: string) => void
  /** Called after a proposal is started or dismissed, so it stops being offered. */
  onResolve?: (id: string) => void
}

export function DeferredSpawnChips({ proposals, onStart, onResolve }: DeferredSpawnChipsProps) {
  const { t } = useTranslation()

  const start = React.useCallback((proposal: DeferredSpawnProposal) => {
    onStart?.(deferredSpawnRoute(proposal))
    onResolve?.(proposal.id)
  }, [onStart, onResolve])

  if (proposals.length === 0) return null

  return (
    <div className="flex flex-col gap-1.5" data-testid="deferred-spawn-chips">
      {proposals.map(proposal => (
        <div
          key={proposal.id}
          data-testid="deferred-spawn-chip"
          className={cn(CARD_WELL_FRAME, 'flex items-start gap-2 px-3 py-2 text-label')}
        >
          <span className={cn(ROW_ICON_SLOT, 'h-5 text-tertiary')}>
            <GitBranchPlus aria-hidden className={ROW_ICON_SIZE} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-label-sm text-tertiary">
              {t('chat.spawnProposal.title')}
            </div>
            <div className="truncate text-foreground">{proposal.name}</div>
            <div className="text-label-sm text-tertiary">
              {t('chat.spawnProposal.isolatedNote')}
            </div>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => start(proposal)}
          >
            {t('chat.spawnProposal.start')}
          </Button>
          <IconButton
            size="sm"
            aria-label={t('chat.spawnProposal.dismiss')}
            title={t('chat.spawnProposal.dismiss')}
            icon={<X className={ROW_ICON_SIZE} />}
            onClick={() => onResolve?.(proposal.id)}
          />
        </div>
      ))}
    </div>
  )
}
