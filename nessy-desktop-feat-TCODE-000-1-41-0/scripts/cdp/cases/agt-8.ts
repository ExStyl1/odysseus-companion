/**
 * AGT-8 — a managed model allowlist refuses visibly, and withdrawing it restores
 * the full list.
 *
 * Before `7d2bd2db` the allowlist enforced nothing at all. Three halves that
 * fail differently:
 *
 *   enforcement  selecting a model outside `availableModels` is refused. The
 *                backend rejects with `MODEL_RESTRICTED_BY_POLICY`
 *                (`packages/server-core/src/handlers/rpc/settings.ts`).
 *   explanation  the refusal SAYS it is a managed policy. That is a sonner toast
 *                fired from `ChatPage`, text `chat.modelPicker.restrictedByPolicy`
 *                = "This model is restricted by your organization's managed
 *                policy". A refusal a user cannot explain becomes a support
 *                ticket reading "the app broke".
 *   withdrawal   removing the policy gives the model back. This is the DATA-LOSS
 *                guard: enforcement deliberately never writes a narrowed list
 *                back, so a withdrawn policy must restore, not resurrect.
 *
 * ## Why this case is run TWICE, and why that is not a workaround
 *
 * The allowlist is fixed for the process lifetime —
 * `packages/shared/src/config/managed-model-allowlist.ts`, verbatim: "Nothing
 * recomposes the policy after bootstrap." The harness ATTACHES to a running app
 * (`lib/connect.ts`) and never launches one, so no single run can both enforce a
 * policy and observe it withdrawn. `NESSY_CDP_POLICY_WITHDRAWN` is which sitting
 * this is:
 *
 *   unset  sitting 1 — a policy is in force. Drive enforcement, then BLOCK
 *          naming sitting 2. The block is genuine: the relaunch has not
 *          happened, and no amount of harness work can make it have happened.
 *   `1`    sitting 2 — the policy was withdrawn and the app relaunched. Drive
 *          the withdrawal half instead, which can reach PASS.
 *
 * This replaces an UNCONDITIONAL terminal `blocked()` that no operator input
 * could satisfy, and which therefore made the row permanently non-green even
 * with the policy deployed.
 *
 * ## The toast half stays an opportunistic read, and says so
 *
 * `setSessionModel` is the backend seam; the toast is raised by the renderer's
 * own handler around the model picker, which this case does not click. Any toast
 * already on screen is captured and asserted on; its ABSENCE is recorded as
 * un-driven rather than as a failure of enforcement. That is the one half of
 * this row that is still a UI drive, and it is deliberately not folded into a
 * terminal block, because doing so hid two halves that CAN be measured.
 *
 * ## The fixture route, for the record
 *
 * The FILE managed source needs root (`config/managed-system-paths.ts`, uid-0
 * enforced in `managed-policy-loader.ts`). The DELIVERED source does not:
 * `<configDir>/managed-delivery.json` (`config/managed-delivery.ts`), and an
 * `availableModels`-only payload raises no approval item —
 * `classifyManagedApproval` (`config/managed-approval.ts`) raises items only for
 * sandbox, allow-rule and env categories. `bun run
 * scripts/cdp/fixtures/agent-surfaces.ts` writes that file into a scratch config
 * dir; withdrawing the policy is deleting it and relaunching.
 */

import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { listConnections } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, selectorText, waitFor, type SessionKey } from '../lib/state.ts'

const ID = 'AGT-8'
const TITLE = 'A managed model allowlist refuses visibly and withdrawing it restores the full list'

/** A model id that the deployed managed policy does NOT allow. */
const BLOCKED_MODEL = process.env.NESSY_CDP_BLOCKED_MODEL?.trim()
/** Sitting 2: the policy has been withdrawn and the app relaunched. */
const WITHDRAWN = process.env.NESSY_CDP_POLICY_WITHDRAWN?.trim() === '1'
const TOAST = '[data-sonner-toast]'

interface ModelAttempt {
  rejected: boolean
  message: string
}

async function trySetModel(session: CdpSession, key: SessionKey, model: string): Promise<ModelAttempt> {
  return session.call<ModelAttempt>(`
    try {
      await window.electronAPI.setSessionModel(${JSON.stringify(key.sessionId)}, ${JSON.stringify(key.workspaceId)}, ${JSON.stringify(model)})
      return { rejected: false, message: '' }
    } catch (e) {
      return { rejected: true, message: String((e && (e.message || e.code)) || e) }
    }
  `)
}

async function sessionModel(session: CdpSession, key: SessionKey): Promise<string | undefined> {
  return session.call<string | undefined>(`
    const all = await window.electronAPI.getSessions()
    const s = (all ?? []).find(x => x.id === ${JSON.stringify(key.sessionId)})
    return s ? s.model : undefined
  `)
}

/** Every model id the app currently offers, across every connection. */
async function offeredModels(session: CdpSession): Promise<string[]> {
  const rows = await listConnections(session)
  return rows.flatMap(row => (row.models ?? []).map(m => m.id))
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', { workspaceId: key.workspaceId, sessionId: key.sessionId })
  run.observe('session-origin', key.fresh ? 'created by this run' : `CONTAMINATED: ${key.reason}`)
  run.check('the case ran in a session it created', key.fresh, key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)
  run.observe('sitting', WITHDRAWN ? '2 — the policy is withdrawn and the app was relaunched' : '1 — a policy is in force')

  if (!BLOCKED_MODEL) {
    blocked(
      'set NESSY_CDP_BLOCKED_MODEL to a model id the deployed managed policy does NOT list in `availableModels`, and '
      + 'deploy that policy first. Without a policy in force the refusal cannot be distinguished from an ordinary error. '
      + 'The delivered route needs no root: write `<configDir>/managed-delivery.json` with an `availableModels`-only '
      + 'payload (`bun run scripts/cdp/fixtures/agent-surfaces.ts` does it) and relaunch the app against that config dir.',
    )
  }

  const offered = await offeredModels(session)
  run.observe('models the app offers', offered.length > 40 ? `${offered.length} ids` : offered)
  run.observe('is the blocked model in the offered list', offered.includes(BLOCKED_MODEL))

  // ---- sitting 2: the withdrawal half -------------------------------------
  if (WITHDRAWN) {
    // The model must be selectable again. This is the whole data-loss claim:
    // enforcement narrowed nothing on disk, so removing the policy restores the
    // full list rather than leaving a permanently narrowed one behind.
    run.check(
      'the previously blocked model is offered again',
      offered.includes(BLOCKED_MODEL),
      `${BLOCKED_MODEL} ${offered.includes(BLOCKED_MODEL) ? 'is' : 'is NOT'} among the ${offered.length} ids the app lists — `
      + 'absent here means the withdrawn policy left a narrowed list behind, which is the data-loss defect',
    )
    const attempt = await trySetModel(session, key, BLOCKED_MODEL)
    run.observe('set-model-result', attempt)
    run.check(
      'selecting it is accepted now that the policy is gone',
      !attempt.rejected,
      attempt.rejected
        ? `still refused with ${attempt.message.slice(0, 200)} — the policy is still in force, so this is sitting 1 `
          + 'mislabelled, or the app was not relaunched after the file was removed'
        : 'accepted',
    )
    const landed = await sessionModel(session, key)
    run.observe('session-model-after-withdrawal', landed)
    run.check(
      'the session actually moved onto it',
      landed === BLOCKED_MODEL,
      `model=${landed} — an accepted call that did not land is a silent refusal`,
    )
    return
  }

  // ---- sitting 1: enforcement ---------------------------------------------
  const attempt = await trySetModel(session, key, BLOCKED_MODEL)
  run.observe('set-model-result', attempt)
  run.check('the disallowed model was refused', attempt.rejected, attempt.message.slice(0, 200))
  run.check(
    'the refusal names the managed policy',
    /MODEL_RESTRICTED_BY_POLICY|managed policy|restricted/i.test(attempt.message),
    attempt.message.slice(0, 200),
  )

  // ---- the session kept its own model, nothing was narrowed on disk --------
  const stillOn = await sessionModel(session, key)
  run.observe('session-model-after-refusal', stillOn)
  run.check('the session stayed on its current model', stillOn !== BLOCKED_MODEL, `model=${stillOn}`)

  // ---- explanation ---------------------------------------------------------
  // A direct RPC call bypasses the renderer handler that raises the toast, so
  // the visible half is read opportunistically: any toast already on screen from
  // a UI attempt is captured, and its absence is reported as unproven rather
  // than as a failure of enforcement.
  const toasts = await waitFor(() => selectorText(session, TOAST), t => t.length > 0, { timeoutMs: 5_000, intervalMs: 500, label: 'a policy toast' })
    .catch(() => [] as string[])
  run.observe('toasts', toasts)
  if (toasts.length > 0) {
    run.check(
      'the visible refusal explains the managed policy',
      toasts.some(t => /managed policy|restricted/i.test(t)),
      JSON.stringify(toasts).slice(0, 300),
    )
  } else {
    run.observe(
      'the VISIBLE refusal was not driven',
      'this case calls setSessionModel directly, which bypasses the renderer handler that raises the toast. '
      + 'Repeat the selection by hand through the model picker and confirm the text reads "This model is restricted '
      + 'by your organization\'s managed policy". Recorded as un-driven, NOT as a failure: the enforcement checks '
      + 'above stand on their own.',
    )
  }

  blocked(
    'enforcement is measured; the WITHDRAWAL half needs a second sitting and cannot be reached from here. '
    + 'The allowlist is fixed for the process lifetime ("Nothing recomposes the policy after bootstrap", '
    + 'managed-model-allowlist.ts) and this harness attaches to a running app rather than launching one. '
    + 'To finish the row: withdraw the managed policy (delete <configDir>/managed-delivery.json, or the '
    + 'root-owned managed-policy.json), RELAUNCH the app against the same config dir, and re-run this case with '
    + 'NESSY_CDP_POLICY_WITHDRAWN=1 — that arm asserts the model is offered again and selectable, and can PASS.',
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
