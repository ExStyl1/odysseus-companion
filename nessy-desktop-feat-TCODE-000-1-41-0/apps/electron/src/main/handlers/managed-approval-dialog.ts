/**
 * The desktop surface for `server-managed-settings.md#security-approval-dialogs`
 * and its `#approval-memory` subsection.
 *
 * A native modal, not a renderer view: the dialog has to be answerable before
 * the first window exists, because the page says settings that could pose
 * security risks "require explicit user approval before Claude Code applies them
 * in an interactive session" and the delivered `env` block is applied at
 * startup. A React surface would have to wait for a window, which is
 * `#approval-memory`'s "An interactive session that can't show the dialog"
 * state — there "Claude Code doesn't apply the delivered settings and keeps the
 * last-approved settings" — a fallback, not the design.
 *
 * Nothing here renders a delivered VALUE. `renderManagedApprovalSummary`
 * produces field names, categories and counts, and the reason is that a
 * managed `env` block routinely carries an API key: a dialog that printed it
 * would put a credential on screen and into every screenshot of that screen.
 */

import {
  managedPayloadDigest,
  renderManagedApprovalSummary,
  resolveManagedApproval,
  type ManagedApprovalModeV1,
  type ManagedApprovalRequestV1,
  type ManagedApprovalResolutionV1,
} from '@nessy-agent/shared/config/managed-approval'
import type {
  ManagedDeliveryGateResultV1,
  ManagedDeliverySalvageV1,
} from '@nessy-agent/shared/config/managed-delivery'

export interface ManagedApprovalHostDeps {
  /** `dialog.showMessageBox`-shaped. Returns the index of the chosen button. */
  showMessageBox: (options: {
    type: 'warning'
    title: string
    message: string
    detail: string
    buttons: string[]
    defaultId: number
    cancelId: number
    noLink: boolean
  }) => Promise<{ response: number }>
  /** Called when the user rejects: `:216` — Claude Code exits. */
  onReject: () => void
  /**
   * `:218` vs `:221`. A headless run is `non-interactive`; a windowed app that
   * cannot put a modal up right now is `interactive-unavailable`.
   */
  mode: ManagedApprovalModeV1
}

const TITLE = 'Approve managed settings'
const MESSAGE = (
  'Your organization delivered settings that can execute commands, set '
  + 'environment variables, or change how this app runs. They are not applied '
  + 'until you approve them.'
)

export function buildManagedApprovalPrompt(
  deps: ManagedApprovalHostDeps,
): (request: ManagedApprovalRequestV1) => Promise<boolean> {
  return async (request) => {
    const { response } = await deps.showMessageBox({
      type: 'warning',
      title: TITLE,
      message: MESSAGE,
      detail: renderManagedApprovalSummary(request),
      buttons: ['Approve', 'Reject and quit'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    return response === 0
  }
}

/**
 * The `approve` callback `refreshManagedDelivery` takes. Returns the
 * apply/persist verdict and quits the app on rejection.
 */
export function createManagedApprovalGate(
  deps: ManagedApprovalHostDeps,
): (
  salvage: ManagedDeliverySalvageV1,
  context: { approvedDigest?: string | undefined },
) => Promise<ManagedDeliveryGateResultV1> {
  const prompt = buildManagedApprovalPrompt(deps)
  return async (salvage, context) => {
    const resolution: ManagedApprovalResolutionV1 = await resolveManagedApproval({
      policy: salvage.policy,
      payload: salvage.payload,
      mode: deps.mode,
      approvedDigest: context.approvedDigest,
      ...(deps.mode === 'interactive' ? { prompt } : {}),
    })
    if (resolution.exit) deps.onReject()
    return {
      apply: resolution.apply,
      persist: resolution.persist,
      ...(resolution.approvedDigest === undefined
        ? {}
        : { approvedDigest: resolution.approvedDigest }),
    }
  }
}

export { managedPayloadDigest }
