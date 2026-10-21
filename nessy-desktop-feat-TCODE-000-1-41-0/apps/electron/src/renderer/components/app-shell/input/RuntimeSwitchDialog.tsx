import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowLeftRight, ChevronRight } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useRegisterModal } from '@/context/ModalContext'
import { ConnectionIcon } from '@/components/icons/ConnectionIcon'
import type { LlmConnectionWithStatus } from '@config/llm-connections'
import { RuntimeBadge } from './ConnectionRow'
import { runtimeForProviderType, runtimeLabel, runtimeSwitchCopyKey } from './runtime-switch-copy'
import { runtimeSwitchCosts } from './runtime-switch-costs'
import { resolveUtilityModelChange } from './runtime-switch-utility-model'
import type { HistoryCarryPlan, HistoryCarryReason, RuntimeSwitchKind } from '@nessy-agent/shared/protocol'

export interface RuntimeSwitchPending {
  kind: RuntimeSwitchKind
  from: LlmConnectionWithStatus | null
  to: LlmConnectionWithStatus
  /**
   * The server's pre-switch carry decision (`previewRuntimeSwitch`). `null`
   * when the preview did not answer — the dialog then omits the "what will
   * cross" line rather than guessing one.
   */
  historyCarry: HistoryCarryPlan | null
  /**
   * WHY that decision (P3.266). `null` on the same terms as the plan beside it,
   * and additionally whenever the reason is not a degradation — a `native` carry
   * that fits has nothing to explain.
   */
  historyCarryReason: HistoryCarryReason | null
}

interface RuntimeSwitchDialogProps {
  /** Non-null only while a switch is awaiting confirmation. */
  pending: RuntimeSwitchPending | null
  onCancel: () => void
  onConfirm: () => void
}

/**
 * The tiered confirmation for a mid-session integration change.
 *
 * Built on `@/components/ui/dialog` — there is no `alert-dialog` component in
 * this repo, and the only `alert-dialog` string in the renderer is a CSS
 * token. Same shape as `ResetConfirmationDialog`, including `useRegisterModal`
 * so the window X / Cmd+W closes this first.
 *
 * The dialog is only ever rendered for a tier that HAS copy: a model change
 * inside one integration, and any change on a session with no transcript, are
 * silent — `runtimeSwitchCopyKey` returns `null` and the caller never sets
 * `pending`. This mirrors Claude Code's rule that the picker asks "when the
 * conversation has prior output" rather than on every pick.
 *
 * UB14.39 (R6-10) — on v0.15.1's dialog vocabulary (recipe: v0.15.1
 * `ResetConfirmationDialog.tsx` / `ui/rename-dialog.tsx`): Cancel is the ghost,
 * the switch the forward primary; the cross-runtime glyph takes the info (amber)
 * role, the copy the text roles, and the cost heading upstream's quiet section
 * label (`text-label-sm font-medium text-tertiary`, no capitals). The costs, the
 * carry lines and the switch semantics are untouched.
 */
export function RuntimeSwitchDialog({ pending, onCancel, onConfirm }: RuntimeSwitchDialogProps) {
  const { t } = useTranslation()
  const open = pending != null
  useRegisterModal(open, onCancel)

  // Resolved BEFORE the copy lookup, because T1a made the body and the carry
  // line depend on which runtime is taking over — Codex's native carry is
  // narrower than the generic `native` promise.
  const toRuntime = pending ? runtimeForProviderType(pending.to.providerType) : null
  const copy = pending
    ? runtimeSwitchCopyKey(pending.kind, true, pending.historyCarry, toRuntime, pending.historyCarryReason)
    : null
  if (!pending || !copy || !toRuntime) return null

  const crossRuntime = pending.kind === 'connection-cross-runtime'
  const fromRuntime = pending.from ? runtimeForProviderType(pending.from.providerType) : null
  const values = {
    from: pending.from?.name ?? '',
    to: pending.to.name,
    fromRuntime: fromRuntime ? runtimeLabel(fromRuntime) : '',
    toRuntime: runtimeLabel(toRuntime),
  }
  // P3.70 — the UTILITY model, which a switch silently re-resolves. The rule
  // and its three deliberate silences live in `runtime-switch-utility-model.ts`
  // (including the managed-allowlist caveat and the page sentence that licenses
  // it for a picker) so they can be driven without rendering this dialog.
  const utilityModelChange = resolveUtilityModelChange(pending.from, pending.to)

  // What this DIRECTION costs, ranked worst-first. Empty for every switch that
  // loses nothing — today only a switch that does not change runtime, since
  // W6-d gave both return legs onto Pi a row (this line said "notably any
  // return leg onto Pi" until P6.346(a)) — and the block then does not render at
  // all, so "nothing listed" is never confused with "not asked".
  const costs = fromRuntime ? runtimeSwitchCosts(fromRuntime, toRuntime) : []

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onCancel() }}>
      {/*
        Wider than the `sm:max-w-lg` default, and for a measured reason: this
        dialog grew a per-direction cost list, and the longest direction carries
        TWELVE rows on top of the paragraph and the two integration names — Pi →
        Codex, read by running `runtimeSwitchCosts` rather than by counting the
        table, since the number moved four times without this sentence moving
        (it said five). At `lg` the names truncated and the rows crowded.
      */}
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {crossRuntime
              ? <AlertTriangle className="size-5 shrink-0 text-info" />
              : <ArrowLeftRight className="size-5 shrink-0 text-tertiary" />}
            {t(copy.titleKey)}
          </DialogTitle>
          <DialogDescription asChild>
            {/*
              The BODY scrolls, not the dialog: the title says what is being
              asked and the footer carries the answer, so both must stay on
              screen no matter how many cost rows a direction has. Without the
              bound, a twelve-row list on a short window pushes Cancel and Switch
              past the edge — the user is asked a question they cannot answer.
            */}
            <div className="text-left pt-1 flex flex-col gap-3 max-h-[60dvh] overflow-y-auto">
              {/* The two integrations, each with its runtime named. Two of them
                  can carry the same vendor and the same models and still
                  answer through different runtimes — without the mark the user
                  cannot tell which of these switches costs the runtime's
                  memory. */}
              {/*
                Wraps rather than truncates. Two integrations can carry the same
                vendor and differ only by runtime, so a clipped name is exactly
                the information the user needs to tell this switch from a
                harmless one.
              */}
              <div className="flex flex-wrap items-center gap-1.5 text-label-sm">
                {pending.from && (
                  <>
                    <ConnectionIcon connection={pending.from} size={12} />
                    <span>{pending.from.name}</span>
                    {fromRuntime && <RuntimeBadge runtime={fromRuntime} />}
                    <ChevronRight className="size-3 shrink-0 text-tertiary" />
                  </>
                )}
                <ConnectionIcon connection={pending.to} size={12} />
                <span>{pending.to.name}</span>
                <RuntimeBadge runtime={toRuntime} />
              </div>
              <p className="text-label text-secondary leading-relaxed">
                {t(copy.bodyKey, values)}
              </p>
              {/*
                What will actually cross — the one thing the user is deciding
                about, and the one thing this dialog could not say until the
                server gained a pre-switch answer (`previewRuntimeSwitch`).
                Rendered only when the server answered: a missing line is
                honest, an invented one is not.
              */}
              {copy.carryKey && (
                <p className="text-label text-secondary leading-relaxed font-medium">
                  {t(copy.carryKey, values)}
                </p>
              )}
              {/*
                P3.266 — and WHY, when the answer above is a degradation.
                Directly under the carry line and deliberately quieter than it:
                the promise is what the user is deciding about, the reason is
                what tells them whether they can do anything about it. Rendered
                only when the server named one, on the same rule as the line it
                explains — a modal that invents a cause is worse than one that
                states none.
              */}
              {copy.reasonKey && (
                <p className="text-label-sm text-tertiary leading-relaxed">
                  {t(copy.reasonKey, values)}
                </p>
              )}
              {/*
                P3.70 — the side model the user never picks but pays for.
                Placed with the carry lines rather than in the cost list below:
                the costs are what the DIRECTION cannot do, this is what these
                two CONNECTIONS resolve differently, and one is not a special
                case of the other.
              */}
              {utilityModelChange && (
                <p className="text-label-sm text-tertiary leading-relaxed">
                  {t('chat.runtimeSwitch.utilityModelPreview', {
                    ...values,
                    fromUtilityModel: utilityModelChange.from,
                    toUtilityModel: utilityModelChange.to,
                  })}
                </p>
              )}
              {/* The part of the move we cannot absorb. Named here rather than
                  discovered later: the post-switch toasts report what the
                  SERVER learns while switching, and this reports what is true
                  of the two runtimes before it starts. */}
              {costs.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <div className="text-label-sm font-medium text-tertiary">
                    {t('chat.runtimeSwitch.costHeading', values)}
                  </div>
                  <ul className="flex flex-col gap-1.5 m-0 p-0 list-none">
                    {costs.map(cost => (
                      <li key={cost.id} className="flex gap-2 text-label text-secondary leading-relaxed">
                        <span aria-hidden className="select-none shrink-0 text-tertiary">—</span>
                        {/*
                          P6.562 — a row one of whose two endpoints the table has
                          never driven says so, in place. The alternative the
                          table used to force was to drop the claim entirely,
                          which the user reads as "nothing to lose here"; a
                          caution the user cannot tell from a measurement is the
                          other half of the same defect, so the marker rides
                          beside the sentence rather than replacing it.
                        */}
                        <span>
                          {t(cost.bodyKey, values)}
                          {cost.certainty === 'unmeasured' && (
                            <span className="ml-1 text-label-sm text-tertiary">
                              ({t('chat.runtimeSwitch.costNotMeasured')})
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={onConfirm}>{t(copy.confirmKey)}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
