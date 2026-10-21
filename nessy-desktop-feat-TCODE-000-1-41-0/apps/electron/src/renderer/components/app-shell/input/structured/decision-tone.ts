/**
 * Source: v0.15.1:apps/electron/src/renderer/components/app-shell/input/structured/decision-tone.ts (UB14.20; ADDED in v0.15.0).
 * Verbatim (Apache-2.0) but the `@craft-agent` → `@nessy-agent` rebrand. The risk arm landed first with UB6.10
 * (c84a3dd92) while `DecisionTone` was declared here locally; UB14.20 re-homes the type in `DecisionCard.tsx`.
 * Our extra structured types (`ask_user`, `workflow_launch`) and every permission variant without risk
 * badges (outside-root, outside-read, artifact publish, reopen, worktree cleanup) resolve to `info`.
 */
import type { PermissionRisk } from '@nessy-agent/core/types'
import type { PermissionRequest } from '../../../../../shared/types'
import type { StructuredInputState } from './types'
import type { DecisionTone } from './DecisionCard'

/** Risks this client can label (a newer server may send more; those are left out, like the badges). */
const KNOWN_RISKS: ReadonlySet<PermissionRisk> = new Set<PermissionRisk>([
  'deletes', 'sends', 'publishes', 'credentials', 'system', 'spends',
])

export function knownPermissionRisks(request: Pick<PermissionRequest, 'risks'>): PermissionRisk[] {
  return (request.risks ?? []).filter((risk) => KNOWN_RISKS.has(risk))
}

/**
 * Card tone for a structured prompt. A permission request carrying decision-model risk badges
 * gets the destructive ring and tile; every other prompt "needs you" (info). Presentation only:
 * the prompt, its buttons and its outcome are unchanged.
 */
export function getDecisionTone(state: StructuredInputState | undefined): DecisionTone | null {
  if (!state) return null
  if (state.type === 'permission') {
    return knownPermissionRisks(state.data as PermissionRequest).length > 0 ? 'danger' : 'info'
  }
  return 'info'
}
