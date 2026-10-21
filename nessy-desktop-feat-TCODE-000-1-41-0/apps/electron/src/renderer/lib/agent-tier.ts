/**
 * Who owns a SUBAGENT the app cannot change — and the sentence that says so.
 *
 * P6.633, the agents-list half of P2.439. The administrator subagent root has
 * been emitted since P6.239 (`native-sources.ts` walks `<systemDir>/agents` and
 * pushes each definition at `builtin` scope with `mutable: false`), and it
 * reached the agents overlay carrying nothing but its raw scope word: the list
 * printed `builtin` twice, once as a badge and once as the "Tier" value. A user
 * reading `builtin` beside a subagent they did not write, in a list with no way
 * to edit it, is told neither who owns it nor why they cannot.
 *
 * ## One spelling, and it is P2.439's
 *
 * The sentence is *Managed by your administrator*, and the key is the one the
 * skills list already uses — `skillsList.managedByAdministrator`. This module
 * delegates to {@link skillOwnerLabelKey} rather than restating the table, so
 * there is exactly one place where a tier gets a name and exactly one string per
 * tier in the locales. The `skillsList.` prefix is inherited rather than chosen;
 * a parallel `agentsList.managedBy*` family would be five new keys per locale
 * saying the same five things, and the second spelling is the failure P2.439's
 * own header warns about. That header also carries the two decisions this
 * inherits whole: the label never says *system* (codex's `System` scope is the
 * user's own home cache and its machine-wide one is `Admin`), and the label is
 * on the TIER, never on the runtime — all three runtimes reach the same tier
 * from three different paths, and branching on the runtime would give one fact
 * three names.
 *
 * ## Why `readOnly` decides whether there is a sentence at all
 *
 * The skills list shows the owner label EXACTLY where the Delete affordance
 * would otherwise be (`hooks/useSkillActions.ts` `skillMenuProps`, shared since
 * UB12.80 by the list row and the detail page's "⋯": `deletable ? deleteSkill :
 * skillOwnerLabelKey(skill)`), so the sentence is an answer to *why can I not
 * change this?* — a claim about an affordance, not about a directory. Ported
 * faithfully: a row the user CAN change is owed no such sentence, and gets
 * `undefined` here so the list keeps showing its ordinary scope. Reading
 * `readOnly` rather than re-deriving it from the scope is the point — the two
 * are decided in different places, and a row that is `builtin` but writable
 * would be a bug worth seeing rather than a label worth faking.
 *
 * ## No edit affordance — VERIFIED, not built (P6.633)
 *
 * The row asked for "the managed label and no edit affordance". The second half
 * needed no code: the agents overlay in `ChatDisplay.tsx` is read-only by
 * construction — it renders a name, a description, a scope badge, a tier line
 * and a tools line, and carries no rename, delete, edit or toggle control for
 * any row at any tier. So there is nothing to disable for the administrator
 * tier, and adding a disabled control in order to have one to disable would be
 * inventing an affordance to take it away. If an edit control is ever added
 * there, it owes a `readOnly` gate, and this function is what already answers it.
 */

import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'

import { skillOwnerLabelKey } from './skill-tier'

/** The subset of a catalog row that decides whether an owner is named, and who. */
export type AgentOwnership = Pick<SafeCapabilitySummary, 'origin' | 'scope' | 'readOnly'>

/**
 * The i18n key naming who owns `agent`, or `undefined` when the user owns it and
 * no such sentence is owed.
 */
export function agentOwnerLabelKey(agent: AgentOwnership): string | undefined {
  if (!agent.readOnly) return undefined
  return skillOwnerLabelKey(agent)
}
