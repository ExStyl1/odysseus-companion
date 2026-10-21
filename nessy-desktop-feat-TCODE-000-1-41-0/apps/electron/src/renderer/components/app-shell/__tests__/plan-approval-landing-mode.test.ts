/**
 * F1.106 (origin D1.431) — which permission mode approving a plan lands in.
 *
 * ## The defect
 *
 * Both plan-approval listeners in `FreeFormInput.tsx` — the plain Accept
 * (`nessy:approve-plan`) and Accept & Compact (`nessy:approve-plan-with-compact`)
 * — switched a session in `explore` straight to `bypassPermissions`. The
 * responsibility dialog that is supposed to stand in front of bypass
 * (`lib/bypass-permissions-gate.ts`) is raised only on the FIRST activation per
 * install, so once that acknowledgment exists — likelier since D1.369 put bypass
 * in the default rotation — accepting a plan silently turned every later card
 * off for the rest of the session.
 *
 * ## The decision (controller, 2026-09-23, under the owner's delegation)
 *
 * **Land in `default`.** `permission-modes.md#review-and-approve-a-plan`: the
 * page's approve options are "Yes, and use auto mode", "Yes, manually approve
 * edits" (approve and review each edit individually) and "No, keep planning";
 * the bypass wording appears ONLY "If you started the session with bypass
 * permissions enabled". So a plan approval never ENTERS bypass on the page —
 * bypass is entered through its own first-activation dialog — and the
 * least-privileged documented landing that still lets the plan execute is the
 * manual one, our `default`. Every other starting mode is left exactly as it
 * was (the controls below), which is what the listeners did before this row.
 *
 * ## How it is driven
 *
 * `bun test` has no DOM in this repo (the renderer's component tests are
 * `renderToStaticMarkup`-only and run no effects), so the decision is a pure
 * function the listeners delegate to, and the source-read arm pins that BOTH
 * listeners delegate to it and that neither spells a bypass switch any more.
 * Without that arm the pure arm would be a parallel model of the composer
 * rather than a test of it (the shape `input/__tests__/double-escape.test.ts`
 * settled on).
 *
 * ## F1.201 — the same landing from `plan` (WJ-w, 2026-09-23)
 *
 * F1.106 kept `plan → null` as D1.431's control, "unverified". MEASURED: the
 * listener is the ONLY writer of the mode on the approval path — the host's
 * `sendMessage` carries no plan-approval branch, and the Pi harness's
 * `PlanModeService.approve()` is reached only from Pi's `approve_plan` action in
 * `controlPiHarnessRuntime` (a callerless host twin was deleted by F1.259), never from the plan
 * card's Accept, which dispatches `nessy:approve-plan` and nothing else. So an
 * approval from `plan` sent "Plan approved, please execute." into a session
 * whose gate still blocked every edit. The page settles it:
 * `permission-modes.md#review-and-approve-a-plan` — "Approving a plan exits plan
 * mode and switches the session to the permission mode each approve option
 * describes". The plan card's single Accept is the page's "Yes, manually
 * approve edits", exactly as F1.106 read it for `explore`, so `plan` lands in
 * `default` too — never bypass, never `auto`.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import * as planApproval from '../plan-approval-message'
import { bracedRegion } from '@nessy-agent/shared/testing/source-regions'
import { PERMISSION_MODE_ORDER, type PermissionMode } from '@nessy-agent/shared/agent/modes'

const FREE_FORM_INPUT = fileURLToPath(new URL('../input/FreeFormInput.tsx', import.meta.url))
/** The switch both listeners spelled before F1.106. */
const BYPASS_SWITCH = "onPermissionModeChange?.('bypassPermissions')"

describe('F1.106 · a plan approval lands in the documented execution mode', () => {
  it('the export exists (F1.1050 deleted this test\'s explore → default arm with the retired mode)', () => {
    // A namespace read rather than a named import: before the fix the export did
    // not exist, and a named import would have died at link time instead of
    // failing this assertion — an import death is not a reading of the defect.
    expect(typeof planApproval.planApprovalLandingMode).toBe('function')
  })

  it('F1.201 — plan → default: an approval exits plan mode, into the manual landing', () => {
    // RED before F1.201: `null`, so the setter was never called and the session
    // stayed in `plan` with the approval message already sent.
    expect(planApproval.planApprovalLandingMode('plan')).toBe('default')
  })

  it('CONTROL — every other starting mode is left exactly where it was', () => {
    // Today's behaviour, read at HEAD and kept: the listeners switch ONLY a
    // read-only planning mode (`explore`, and `plan` since F1.201) — "if user is
    // in the manual mode, respect their choice". So `default` stays `default`,
    // `acceptEdits` stays `acceptEdits`, `auto` stays `auto`. `null` means "do
    // not call the mode setter at all", which is what the listeners did for these.
    const untouched = PERMISSION_MODE_ORDER.filter(mode => mode !== 'plan')
    const landings = Object.fromEntries(
      untouched.map(mode => [mode, planApproval.planApprovalLandingMode?.(mode as PermissionMode) ?? null]),
    )
    expect(landings).toEqual(Object.fromEntries(untouched.map(mode => [mode, null])))
  })

  it('no starting mode can be promoted INTO bypassPermissions by an approval', () => {
    const promotedToBypass = PERMISSION_MODE_ORDER.filter(
      mode => planApproval.planApprovalLandingMode?.(mode) === 'bypassPermissions',
    )
    expect(promotedToBypass).toEqual([])
  })
})

describe('F1.106 · both composer listeners delegate to the decision', () => {
  const src = readFileSync(FREE_FORM_INPUT, 'utf-8')

  const plain = bracedRegion(src, src.indexOf('const handleApprovePlan = ('))
  const withCompact = bracedRegion(src, src.indexOf('const handleApprovePlanWithCompact = async ('))

  it('the plain Accept listener asks the decision and spells no bypass switch', () => {
    expect(plain).toContain('planApprovalLandingMode(permissionMode)')
    // A negative CLAIM, read as a boolean on purpose: written as a `not.toContain`
    // on the region, `lint:braced-region-controls` would take it for a boundary
    // control, and after the fix its needle occurs nowhere in the file — the
    // temporal shape AGENTS.md records (2026-09-20, F1.172).
    expect(plain.includes(BYPASS_SWITCH)).toBe(false)
    // Boundary control: a declaration BELOW the region. A runaway brace scan
    // would reach it; the real region cannot.
    expect(plain).not.toContain('const handleApprovePlanWithCompact')
  })

  it('the Accept & Compact listener asks the same decision and spells no bypass switch', () => {
    expect(withCompact).toContain('planApprovalLandingMode(permissionMode)')
    expect(withCompact.includes(BYPASS_SWITCH)).toBe(false)
    // Boundary control: the listener registration below the handler (F1.241 deleted the old recovery sender).
    expect(withCompact).not.toContain("window.addEventListener('nessy:approve-plan-with-compact'")
  })

  it('no bypass switch survives anywhere in the composer', () => {
    // The whole-file negative, so a third listener cannot reintroduce the switch
    // outside the two regions above.
    expect(src.includes(BYPASS_SWITCH)).toBe(false)
  })
})
