/** Canonical config filename */
export const AUTOMATIONS_CONFIG_FILE = 'automations.json';

/** History log filename */
export const AUTOMATIONS_HISTORY_FILE = 'automations-history.jsonl';

/** Persistent retry queue filename */
export const AUTOMATIONS_RETRY_QUEUE_FILE = 'automations-retry-queue.jsonl';

/**
 * Durable per-matcher cursor of the last scheduled OCCURRENCE that has been
 * accounted for. Sibling of automations.json in the managed workspace dir.
 *
 * Its own file rather than a reuse of automations-history.jsonl: the history
 * `ts` is the RUN time, not the occurrence, and it is compacted to
 * {@link AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER} entries per matcher — a
 * cursor read from it would double-fire or silently skip.
 */
export const AUTOMATIONS_SCHEDULE_STATE_FILE = 'automations-schedule-state.json';

/**
 * How far back a start/wake sweep looks for a missed scheduled run.
 *
 * desktop-scheduled-tasks.md:74 — "When the app starts or your computer wakes,
 * Desktop checks whether each task missed any runs in the last seven days. If it
 * did, Desktop starts exactly one catch-up run for the most recently missed time
 * and discards anything older."
 */
export const AUTOMATION_CATCHUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Default HTTP method for webhook actions */
export const DEFAULT_WEBHOOK_METHOD = 'POST';

/** Maximum length for string fields written to automations-history.jsonl (error, responseBody, prompt). */
export const HISTORY_FIELD_MAX_LENGTH = 2000;

/** Max history entries retained per automation ID. */
export const AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER = 20;

/** Max total history entries across all automations (global safety cap). */
export const AUTOMATION_HISTORY_MAX_ENTRIES = 1000;

/**
 * UB4.8 — how many sessions deep a chain of DIFFERENT automations reacting to each
 * other may run (the loop guard's cap; upstream v0.15.1 `SessionManager.ts` module
 * constant of the same name). One automation's own session never re-triggers it at
 * all. Here since UB12.20, so the host's guard and the timeline that rebuilds its
 * skip reason read ONE number: the history row carries which arm skipped, not the cap.
 */
export const MAX_AUTOMATION_CHAIN_DEPTH = 3;

/**
 * UB12.20 — which arm of the automation loop guard skipped a run, recorded on its
 * history row (`skippedLoopGuard`) so the timeline rebuilds the reason in the
 * user's language: `self-trigger` = the event is about a session this automation
 * created; `chain-depth` = the chain through other automations is deeper than
 * {@link MAX_AUTOMATION_CHAIN_DEPTH} sessions. A deviation from upstream v0.15.1,
 * which stores the English reason only.
 */
export const AUTOMATION_LOOP_GUARD_SKIPS = ['self-trigger', 'chain-depth'] as const;
export type AutomationLoopGuardSkip = typeof AUTOMATION_LOOP_GUARD_SKIPS[number];
