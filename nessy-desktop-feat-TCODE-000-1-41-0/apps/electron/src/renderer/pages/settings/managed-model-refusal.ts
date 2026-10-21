/**
 * P2.502 — THE POSTURE THIS PAGE'S MODEL PICKERS TAKE TOWARDS THE MANAGED
 * ALLOWLIST, and the one rule that follows from it.
 *
 * WHY THIS IS A MODULE AND NOT SIX LINES INSIDE `AiSettingsPage.tsx`, which is
 * where it was first written. The same reason `advisor-consultation.ts` and
 * `activity-card-routing.ts` give for their own extractions: a rule has to be
 * assertable on VALUES, and this page cannot be imported cheaply. It reaches
 * the `@nessy-agent/ui` barrel, whose chain ends at a `?url` import of the pdf
 * worker that bun's runner cannot load, so a suite importing the page must
 * install two `mock.module` stubs and a `DOMMatrix` shim before it can load —
 * which is `mock.module` on a shared graph, the trap AGENTS.md names, entered
 * for no reason other than reaching six lines of pure logic. A suite driving
 * this module needs none of it.
 *
 * AND A CORRECTION WORTH MORE THAN THE EXTRACTION, because the extraction was
 * first justified by it and the justification was WRONG. The page-importing
 * draft was observed spending **38 seconds in its `beforeAll`**, and that was
 * attributed to the page import. A control run at the same moment refuted it:
 * `pages/settings/__tests__` takes ~57s with this suite present and ~57s with
 * it ABSENT, and a pre-existing PAIR of suites in that directory — eight tests,
 * neither of them this one — takes 55s on its own. The cost belongs to a
 * sibling's hook, not to this rule, and it appeared mid-session while other
 * lanes were landing. A timing claim without a control run at the same moment
 * invents a cause, and this one did.
 */
import type { ErrorCode } from '@nessy-agent/shared/protocol'

/**
 * P2.502 — THE POSTURE THIS PAGE'S MODEL PICKERS TAKE TOWARDS THE MANAGED
 * ALLOWLIST, and why it is this one.
 *
 * The question the row put: a picker here can either be NARROWED to the models
 * the managed allowlist permits, or it can offer the connection's catalog and
 * let the host refuse the write. **This page takes the second.** It is a
 * product posture, not an implementation detail, so it is written down here
 * rather than left to be inferred from the absence of a filter.
 *
 * FOUR REASONS, strongest first.
 *
 * 1. The host already HAS the mechanism, and it is refuse-at-write.
 *    `handlers/rpc/settings.ts` throws `MODEL_RESTRICTED_BY_POLICY` from the
 *    session model handler and `ChatPage.handleModelChange` turns it into a
 *    toast. Narrowing the list here would be a SECOND mechanism beside the
 *    native one, and two mechanisms over one policy can disagree.
 * 2. The host's own doctrine forbids projecting the policy. That handler's
 *    comment: "The refusal carries only the model id, never the allowlist …
 *    a policy's contents are the administrator's to disclose". A filtered list
 *    discloses the allowlist by construction — the user reads it off which
 *    models are missing.
 * 3. The renderer CANNOT compute the answer, and the way it fails is the
 *    dangerous kind. `isManagedModelSelectable` is importable here — its module
 *    carries zero imports precisely so it can be — but it reads a registry set
 *    once at HOST bootstrap (`createStorageRuntime`), which in the renderer
 *    process is never set, so it answers TRUE FOR EVERYTHING. A filter built on
 *    it would look like a filter and be a no-op.
 * 4. For the advisor there is no single correct list to filter. `advisorModel`
 *    is ONE GLOBAL key while the entitlement narrowing is the SESSION's
 *    connection catalog, so one stored id is permitted in one session and
 *    refused in another. (And an empty catalog is not *show nothing*: the
 *    resolver reads it as *no narrowing*, so the honest empty state is that the
 *    session's own model advises.)
 *
 * WHAT THIS COMMITS THE PAGE TO: every model write from here must surface its
 * refusal rather than swallow it, and must not leave the control showing a
 * value the host rejected. {@link describeManagedModelRefusal} is that rule.
 */
const MODEL_RESTRICTED_BY_POLICY = 'MODEL_RESTRICTED_BY_POLICY' satisfies ErrorCode

/**
 * The toast a refused model write earns, or `null` when the failure was
 * something else and belongs in the generic save-failed path.
 *
 * Branch on the wire CODE, never on the error class — the transport rebuilds a
 * plain `Error` on this side, the reason `ChatPage.handleModelChange` states
 * where this same refusal is already surfaced.
 *
 * The title is the shared sentence about managed policy, reused verbatim from
 * the session picker because it is the same fact in the same words. Its
 * companion DESCRIPTION key is not reused: it ends "Your session stays on its
 * current model", which is untrue of a settings row, so the description carries
 * the model id alone — data, not copy, and correct in every locale. A
 * setting-specific sentence would be an improvement and needs a new key.
 */
export function describeManagedModelRefusal(
  error: unknown,
  modelId: string,
): { titleKey: string; description: string } | null {
  const code = (error as { code?: unknown } | null | undefined)?.code
  if (code !== MODEL_RESTRICTED_BY_POLICY) return null
  return { titleKey: 'chat.modelPicker.restrictedByPolicy', description: modelId }
}
