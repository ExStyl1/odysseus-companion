/**
 * F1.788 (origin WJ-crit-ff P-WJcritff-2, 2026-09-25) — codex's own collaboration mode for one `turn/start`.
 *
 * Native first, asked: codex has the mechanism. `turn/start` accepts `collaborationMode: { mode, settings: { model,
 * reasoning_effort, developer_instructions } }` (experimental; the product already declares `experimentalApi: true`),
 * and the mode is sticky ("for this turn and subsequent turns"), so every turn says it again. Until this row the host
 * sent none, every codex session ran in codex's Default mode, and in Plan codex's own Plan rules never reached the
 * model and `request_user_input` refused.
 *
 * - `mode` — `plan` in the host's Plan mode, `default` in every other mode. codex's Plan mode is prompt-level, not a
 *   safety layer: what Plan may do is still decided by the approval policy and sandbox the turn carries.
 * - `developer_instructions: null` — codex fills in its own preset text: `normalize_collaboration_mode`
 *   (`codex-rs/app-server/src/request_processors/turn_processor.rs`, `rust-v0.159.3`, the bundled binary's version)
 *   copies the built-in preset's instructions when the client sends none, so no codex prompt is restated here.
 * - `model` and `reasoning_effort` — a complete collaboration mode "takes precedence over model and effort edits"
 *   (`codex-rs/core/src/session/step_settings.rs`), so they must be the turn's own model and effort. In Plan the
 *   operator's plan-phase effort (P6.368, `NESSY_PLAN_MODE_EFFORT`) replaces the effort; codex reads its own
 *   `plan_mode_reasoning_effort` key in the TUI only (`core/src/config/mod.rs`: "Plan-mode-specific reasoning effort
 *   override used by the TUI"), so the app-server client is the one that applies it. Unset, a Plan turn keeps the
 *   session's effort, the level the user picked — a stated choice: codex's TUI would fall back to its Plan preset's
 *   `medium`, which the host's effort picker would then not show.
 *
 * `settings.model` is required on the wire, so a turn with no model sends no collaboration mode.
 */
export interface CodexCollaborationModeWire {
  mode: 'plan' | 'default';
  settings: { model: string; reasoning_effort: string | null; developer_instructions: null };
}

export function codexTurnCollaborationMode(input: {
  permissionMode: string;
  model: string | undefined;
  effort: string | undefined;
  planEffort?: string;
}): { collaborationMode: CodexCollaborationModeWire } | Record<string, never> {
  if (!input.model) return {};
  const plan = input.permissionMode === 'plan';
  return {
    collaborationMode: {
      mode: plan ? 'plan' : 'default',
      settings: {
        model: input.model,
        reasoning_effort: (plan && input.planEffort) || input.effort || null,
        developer_instructions: null,
      },
    },
  };
}
