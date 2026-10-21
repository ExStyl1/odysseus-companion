/**
 * [nessy-fork] desktop-pet-session-aggregation
 *
 * Unified push event describing the coarse phase of an EXTERNAL Nessy CLI
 * session (terminal TUI or ACP/IDE), aggregated in the Electron main
 * process from the per-session runtime.json sidecars and pushed on
 * `pet:sessionUpdate` so the Desktop Pet sees sessions beyond the ones
 * launched inside the app (those keep arriving via `session:event`).
 */

/** Coarse session lifecycle, mirrors the CLI's runtime.json `state.phase`. */
export type PetSessionPhase =
  | 'idle'
  | 'working'
  | 'waiting_input'
  | 'done'
  /** Synthetic terminal state: the owning CLI process died. */
  | 'gone'

/** One answerable choice of a pending request. */
export interface PetSessionOption {
  /** runtime.json `option_id` (e.g. `proceed_once`, `q0_opt1`). */
  optionId: string
  /** Human-readable label. */
  name: string
  /** Optional long-form hint (desktop AskUserQuestionOption carries one). */
  description?: string
}

/**
 * A normalized external-session snapshot. Field names follow the shared
 * ElectronAPI conventions (camelCase), values follow runtime.json.
 */
export interface PetSessionUpdate {
  /**
   * Renderer-facing key with the `terminal:` prefix so external sessions
   * can never collide with desktop session ids on notification cards.
   */
  sessionId: string
  /** Which external channel reported the session. */
  source: 'terminal' | 'acp'
  phase: PetSessionPhase
  /** Project title (workDir basename) for the notification card header. */
  title?: string
  /** Working directory — used by the terminal-focus handler. */
  workDir?: string
  /** Owning CLI process — used by the terminal-focus handler. */
  pid?: number
  requestId?: string
  toolName?: string
  summary?: string
  options?: PetSessionOption[]
  /**
   * The pending ask is a questionnaire (multi-question/multiSelect) —
   * a single remote answer cannot resolve it; render display-only.
   */
  questionnaire?: boolean
  /**
   * Absolute path of the MR2 input channel (~/.nessy/ctl/<id>/input.jsonl);
   * present only for terminal sessions that advertise `state.control`.
   * Validated by the answer handler before any write.
   */
  controlInputFile?: string
  /** Epoch seconds from runtime.json `state.updated_at`. */
  updatedAt?: number
}
