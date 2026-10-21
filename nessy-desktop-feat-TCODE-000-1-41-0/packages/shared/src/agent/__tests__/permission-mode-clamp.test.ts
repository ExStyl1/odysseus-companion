import { describe, expect, it } from 'bun:test'

import { clampPermissionModeToParent, normalizeManagedPermissionMode, PERMISSION_MODE_ORDER, type PermissionMode } from '../mode-types.ts'

// Write-axis capability table, driven from the SAME semantics as
// `mode-manager.ts`: `plan` grants scoped writes (its .md plan file and, since
// F1.1050 folded the retired `explore` into it, the session data folder);
// `dontAsk` blocks them. `default`/`acceptEdits`/`auto`/`bypassPermissions` allow
// writes broadly, but the containment invariant below only cares that a child
// never GAINS a write capability its parent lacks — so we model the full
// capability. F1.1050 (DN-272) deleted this file's explore arms with the mode.
//
// The legacy spellings this block used to use (`safe`, `ask`, `allow-all`) are
// permanent READ-PATH aliases and are not what the code compares any more, so
// they are written in the current vocabulary here; `mode-types.ts`'s alias table
// is untouched.
const ALLOWS_ANY_WRITE: Record<PermissionMode, boolean> = {
  dontAsk: false,    // never prompts; only rule-pre-approved tools run
  plan: true,        // scoped writes: its .md plan and the session data folder
  default: true,     // interactive writes anywhere
  acceptEdits: true,
  auto: true,
  bypassPermissions: true,
}

// Strictness ordering (index 0 = strictest):
// dontAsk < plan < default < acceptEdits < auto < bypassPermissions.
describe('clampPermissionModeToParent (A1 narrow-only clamp)', () => {
  it('honors a stricter-or-equal request unchanged', () => {
    // Parent = auto; a stricter request (default) is kept as-is.
    expect(clampPermissionModeToParent('default', 'auto')).toBe('default')
    // Equal request is kept.
    expect(clampPermissionModeToParent('plan', 'plan')).toBe('plan')
    // Strictest request under any parent is kept.
    expect(clampPermissionModeToParent('dontAsk', 'bypassPermissions')).toBe('dontAsk')
    expect(clampPermissionModeToParent('plan', 'bypassPermissions')).toBe('plan')
  })

  it('clamps a broader request down to the parent (never broadens)', () => {
    // Parent = default; a broader request (bypassPermissions) clamps to the parent.
    expect(clampPermissionModeToParent('bypassPermissions', 'default')).toBe('default')
    // Parent = dontAsk (strictest); every request clamps to dontAsk.
    for (const requested of PERMISSION_MODE_ORDER) {
      expect(clampPermissionModeToParent(requested, 'dontAsk')).toBe('dontAsk')
    }
    // Parent = plan; every mode broader than it clamps to plan.
    for (const requested of PERMISSION_MODE_ORDER.slice(PERMISSION_MODE_ORDER.indexOf('plan'))) {
      expect(clampPermissionModeToParent(requested, 'plan')).toBe('plan')
    }
  })

  it('F1.1050: no incomparable pair remains — explore left the order, and the other five kept their positions', () => {
    // This arm pinned the explore/plan write-axis special case (explore under a plan parent resolved to plan).
    expect(PERMISSION_MODE_ORDER).toEqual(['dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'])
  })

  it('never grants a child a write capability the parent lacks (36-pair containment)', () => {
    // Capability-containment invariant on the WRITE axis: for every
    // (requested, parent) pair, if the parent cannot write, the resolved child
    // mode must not be able to write either. This replaces the fragile
    // index-rank assertion (which was blind to the explore/plan incomparability).
    for (const requested of PERMISSION_MODE_ORDER) {
      for (const parent of PERMISSION_MODE_ORDER) {
        const result = clampPermissionModeToParent(requested, parent)
        if (!ALLOWS_ANY_WRITE[parent]) {
          expect(ALLOWS_ANY_WRITE[result]).toBe(false)
        }
      }
    }
  })

  it('never resolves above the parent on the strictness order (no exception since F1.1050)', () => {
    // The (explore requested, plan parent) exception left with explore; the rank invariant now holds everywhere.
    for (const requested of PERMISSION_MODE_ORDER) {
      for (const parent of PERMISSION_MODE_ORDER) {
        const result = clampPermissionModeToParent(requested, parent)
        expect(PERMISSION_MODE_ORDER.indexOf(result))
          .toBeLessThanOrEqual(PERMISSION_MODE_ORDER.indexOf(parent))
      }
    }
  })

  it('falls back to the parent for an unknown requested mode (defensive)', () => {
    expect(clampPermissionModeToParent('bogus' as PermissionMode, 'plan')).toBe('plan')
  })
})

/**
 * P6.496 — the clamp runs NARROWER than the page, and that is the decision.
 *
 * `agent-sdk/permissions.md#available-modes`, the Subagent-inheritance warning,
 * verbatim: *"Subagents inherit the parent session's permission mode. An
 * `AgentDefinition`'s `permissionMode` can override it, except when the parent
 * uses `bypassPermissions`, `acceptEdits`, or `auto`: those modes apply to every
 * subagent and can't be overridden per subagent."*
 *
 * Upstream therefore DISCARDS a child's declared mode under those three parents,
 * including one that is stricter. We keep it. Delegated decision 2026-09-05
 * (Q-den 5) took option A — record, pin, document — and refused option B
 * (match the page) because matching it would LOOSEN what a subagent may do, on
 * the three broadest parents there are.
 *
 * This block exists so the next reader of that warning cannot silently align us
 * with it: every assertion here FAILS the moment the child's declared mode stops
 * being honoured under those parents.
 */
describe('P6.496 — the documented three parents do NOT discard a stricter declared mode', () => {
  const PAGE_OVERRIDE_PROOF_PARENTS = ['bypassPermissions', 'acceptEdits', 'auto'] as const

  it('honours every stricter declared mode under all three, where the page ignores it', () => {
    for (const parent of PAGE_OVERRIDE_PROOF_PARENTS) {
      const parentRank = PERMISSION_MODE_ORDER.indexOf(parent)
      for (const requested of PERMISSION_MODE_ORDER.slice(0, parentRank)) {
        // The page: "those modes apply to every subagent and can't be
        // overridden per subagent" — i.e. the answer would be `parent`.
        expect(clampPermissionModeToParent(requested, parent), `${requested} under ${parent}`)
          .toBe(requested)
      }
    }
  })

  it('the row\'s own named case: plan under a bypassPermissions parent stays plan', () => {
    expect(clampPermissionModeToParent('plan', 'bypassPermissions')).toBe('plan')
  })

  it('NEGATIVE CONTROL: the deviation is one-directional — a BROADER declared mode is still clamped', () => {
    // Narrower-than-the-page must not be read as "the declaration wins". A
    // definition asking for MORE than its parent is refused exactly as before,
    // which is the half where we and the page agree.
    for (const parent of PAGE_OVERRIDE_PROOF_PARENTS) {
      expect(clampPermissionModeToParent('bypassPermissions', parent), parent).toBe(parent)
    }
    expect(clampPermissionModeToParent('auto', 'acceptEdits')).toBe('acceptEdits')
  })
})

describe('normalizeManagedPermissionMode', () => {
  it('uses the exact fallback table and leaves plan intact', () => {
    expect(normalizeManagedPermissionMode('bypassPermissions', ['bypassPermissions'])).toBe('auto')
    expect(normalizeManagedPermissionMode('bypassPermissions', ['bypassPermissions', 'auto'])).toBe('acceptEdits')
    expect(normalizeManagedPermissionMode('auto', ['auto'])).toBe('acceptEdits')
    expect(normalizeManagedPermissionMode('acceptEdits', ['acceptEdits'])).toBe('default')
    expect(normalizeManagedPermissionMode('default', ['default'])).toBe('plan')
    expect(normalizeManagedPermissionMode('plan', ['bypassPermissions'])).toBe('plan')
  })
})
