import i18n from 'i18next'
import { coerceInputText } from '@/lib/input-text'
import type { PermissionMode } from '@nessy-agent/shared/agent/modes'

export interface BuildPlanApprovalMessageOptions {
  draftInput?: string
}

function normalizeDraftInput(input?: string): string {
  return coerceInputText(input).trim()
}

export function buildPlanApprovalMessage(options: BuildPlanApprovalMessageOptions = {}): string {
  const draftInput = normalizeDraftInput(options.draftInput)

  const sections: string[] = [i18n.t('plan.approved')]

  if (draftInput.length > 0) {
    sections.push(['---', `**${i18n.t('plan.additionalUserContext')}**`, draftInput].join('\n\n'))
  }

  return sections.join('\n\n')
}

/**
 * F1.106 (origin D1.431) — the permission mode approving a plan lands the
 * session in, or `null` to leave the mode exactly where it is.
 *
 * DECISION (controller, 2026-09-23, under the owner's standing delegation):
 * approving from `explore` lands in `default`, never in `bypassPermissions`.
 * `permission-modes.md#review-and-approve-a-plan` lists "Yes, manually approve
 * edits" (approve and review each edit individually) as an approve option, and
 * the page words an approval that switches to bypass ONLY "If you started the
 * session with bypass permissions enabled" — a plan approval never ENTERS
 * bypass there. Bypass is entered through its own first-activation dialog
 * (`lib/bypass-permissions-gate.ts`), which an approval must not walk around:
 * both listeners used to switch `explore → bypassPermissions`, and once the
 * install-wide acknowledgment existed that switch raised no dialog at all.
 *
 * F1.201 (WJ-w, 2026-09-23) — `plan` lands in `default` too. F1.106 kept
 * `plan → null` as D1.431's control, unmeasured; measured, the listener is the
 * only writer of the mode on the approval path (the host's `sendMessage` has no
 * plan-approval branch, and Pi's `PlanModeService.approve()` is not reached from
 * the plan card), so an approval from `plan` sent "Plan approved, please
 * execute." into a session whose gate still blocked every edit. The page:
 * "Approving a plan exits plan mode and switches the session to the permission
 * mode each approve option describes" — and the card's single Accept is the
 * manual option, as above.
 *
 * Every other starting mode answers `null` — unchanged, which is what both
 * listeners did before these rows ("if user is in the manual mode, respect their
 * choice"): `default` stays `default`, `acceptEdits` stays `acceptEdits`, `auto`
 * stays `auto`.
 *
 * F1.760 — Pi's `PlanModeService.approve()` (the agent view's `approve_plan`)
 * repeats this rule on the mode a plan was submitted from, `planApprovalLanding`
 * in `packages/server-core/src/pi-harness/plan-mode-service.ts`: change both.
 */
export function planApprovalLandingMode(current: PermissionMode | undefined): PermissionMode | null {
  return current === 'plan' ? 'default' : null // F1.1050: explore retired (read as plan)
}
