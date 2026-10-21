/**
 * Which tier owns a skill the app cannot delete — and the sentence that says so.
 *
 * P2.439, the renderer residue of P6.8. The machine-wide, administrator-owned
 * skill tier is the one tier a user cannot edit from inside the app, so it is
 * exactly the one they need to recognise before wondering why the Delete item
 * is greyed out. Until this file, the skills list answered that question with a
 * single blanket string: `origin === 'plugin' ? managedByPlugin : managedByProject`
 * (`SkillsListPanel.tsx`), which told a user with a skill in their PERSONAL
 * global folder that it was "Managed by project" — a sentence that is simply
 * false and sends them looking in the wrong place.
 *
 * ## Two choices made rather than guessed
 *
 * **1. The label never says *system*.** P6.8 measured, at `openai/codex`
 * `rust-v0.148.0`, that codex's two privileged-sounding scope names are
 * inverted relative to the obvious reading: `SkillScope::System` is
 * `$CODEX_HOME/skills/.system`, the cache codex preinstalls into the user's OWN
 * home, while the machine-wide administrator-owned one is `SkillScope::Admin`
 * (`ext/skills/src/host_roots.rs:114`, the only construction site). A UI that
 * called the machine-wide tier "System" would therefore name, to a codex user,
 * the precise opposite of what it means in their own runtime. The word both
 * sources do support is the administrator: codex calls the scope `admin`, and
 * Claude's `skills.md#remove-a-skill` describes the tier as the one where "an
 * administrator deletes the skill's directory". So: administrator.
 *
 * **2. The label is on the TIER, not on the runtime.** All three runtimes now
 * resolve the same tier — Pi through the host loader P6.8 added, codex through
 * its System config layer, Claude through its managed settings directory — from
 * three different paths. Branching on the runtime would produce three labels for
 * one fact, which is the switch-safety defect this fork keeps re-shipping. There
 * is deliberately no provider argument here.
 *
 * ## Not a badge, and that is an owner ruling rather than an omission
 *
 * The obvious home for this would be a second badge on the row. It cannot be:
 * `SourceCardBadges.tsx` and `lib/source-card.ts` carry the owner's 2026-08-01
 * decision that the Sources card names EXACTLY one category — since UB12.74 the
 * title meta, "never plural" — and that the narrowed licence to carry more
 * "covers CONTROLS", never more content. The disabled Delete item is a
 * control, it is where the user is standing when the question occurs to them,
 * and it already carried (wrongly) the answer. So it is the control that learns
 * to name the tier.
 *
 * ## What is live — all five tiers, since P2.449 (`3288b115c`)
 *
 * This section used to say `administrator` did NOT reach the skills list and
 * that its producer belonged to a row of its own. That row landed:
 * `packages/shared/src/capabilities/native-sources.ts` now walks
 * `getAdminAgentSkillsDirs()` and pushes each admin skill with
 * `{ kind: 'builtin' }` and `mutable: false`, so the branch below is fed and
 * *Managed by your administrator* is a sentence a user actually reads.
 * `plugin`, `global`, `workspace` and `project` were already live and are
 * unchanged.
 *
 * The `LoadedSkill` zero-count this paragraph used to cite as evidence was
 * true then and is true now, and it never measured what it was asked to: the
 * renderer never sees `LoadedSkill` at all, because the catalog projects
 * {@link SafeCapabilitySummary}. A count of a type the consumer does not
 * import cannot tell you whether the consumer receives the rows.
 *
 * So, written to decay loudly rather than to be believed: the symbol that makes
 * the paragraph above true is `getAdminAgentSkillsDirs`, called by BOTH loaders
 * — the agent-side `loadAllSkills` and the catalog — which is also why one
 * operator lever (`NESSY_ADMIN_SKILLS_DIR=''`) turns the tier off in both
 * places at once. If that call leaves `native-sources.ts`, this branch is
 * unreachable again; grep for it rather than trusting this.
 *
 * `builtin` is the representation, deliberately not a fifth scope kind —
 * `native-sources.ts` records the choice at both of its sites ("`builtin`
 * rather than a fifth scope kind… a new kind would cross the wire boundary to
 * buy a label").
 */

import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'

/** The subset of a catalog row that decides which tier owns it. */
type SkillOwnership = Pick<SafeCapabilitySummary, 'origin' | 'scope'>

/**
 * The i18n key naming the tier that owns `item`.
 *
 * Total over `SafeCapabilityScopeKind`, deliberately: an "unknown owner" string
 * would be a worse answer than the wrong one it replaces, and the switch below
 * stops compiling if a fifth scope kind ever lands.
 */
export function skillOwnerLabelKey(item: SkillOwnership): string {
  // Plugin ownership wins over scope: a plugin-provided skill is registered at
  // whatever scope its plugin instance sits at, and the plugin is the thing the
  // user has to uninstall to be rid of it.
  if (item.origin === 'plugin') return 'skillsList.managedByPlugin'

  switch (item.scope.kind) {
    // The machine-wide, administrator-owned tier — see the header. Not "system".
    case 'builtin': return 'skillsList.managedByAdministrator'
    case 'global': return 'skillsList.managedByGlobal'
    case 'workspace': return 'skillsList.managedByWorkspace'
    case 'project': return 'skillsList.managedByProject'
  }
}
