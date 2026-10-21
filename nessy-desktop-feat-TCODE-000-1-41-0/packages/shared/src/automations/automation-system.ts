/**
 * AutomationSystem - Unified Facade for the Automations System
 *
 * Single entry point that:
 * - Creates EventBus instance (per workspace)
 * - Creates and registers all handlers
 * - Loads automations.json configuration
 * - Manages scheduler service
 * - Provides diffing for session metadata changes
 * - Provides dispose() for cleanup
 *
 * Benefits:
 * - No global state - each AutomationSystem instance is self-contained
 * - Easy to create for testing
 * - SessionManager uses ~30 lines instead of ~300
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolveAutomationsConfigPath, generateShortId } from './resolve-config-path.ts';
import { compactAutomationHistorySync } from './history-store.ts';
import { createLogger } from '../utils/debug.ts';
import { WorkspaceEventBus, type EventPayloadMap } from './event-bus.ts';
import { PromptHandler, EventLogHandler, WebhookHandler, ScriptHandler, buildPendingPromptsForMatchers, type AutomationsConfigProvider } from './handlers/index.ts';
import { planCatchupFires } from './catchup-planner.ts';
import { mergeScheduleState, readScheduleState } from './schedule-state.ts';
import { AUTOMATION_CATCHUP_WINDOW_MS, AUTOMATIONS_CONFIG_FILE } from './constants.ts';
import type { AgentAutomationSystem, AutomationsConfig, AutomationEvent, AutomationMatcher, PendingPrompt, WebhookActionResult, AppEvent, AgentEventExecutionResult } from './types.ts';
import { validateAutomationsConfig } from './validation.ts';
// F1.10 (D1.366) — the agent-event dispatch left this class, and with it the
// matcher adapter, the webhook retry, the SDK-input env builder and the
// agent-event set its `disableAllHooks` filter read. What remains is the
// scheduler and the App-event handlers; an agent event runs through
// `executePluginHookAutomations` (see the class docblock).
import { SchedulerService, type SchedulerTickPayload } from '../scheduler/scheduler-service.ts';
import { getUserGlobalHooksConfigPath, loadHooksConfigFile, loadLifecycleHooksConfig } from './hooks-config.ts';
import { getMemoryEnabled } from '../config/storage.ts';
import { runScheduledAutoMemoryCleanup } from '../agent/memory/memory-cleanup.ts';

const log = createLogger('automation-system');

// Re-export SessionMetadataSnapshot from types (single source of truth)
export type { SessionMetadataSnapshot } from './types.ts';
import type { SessionMetadataSnapshot } from './types.ts';

/*
 * F1.230 (WJ-r P-WJ-r-2) — `mergePreToolUseDecisions` does not live here any
 * more. It was exported from this file and its one production caller was the
 * agent-event dispatch F1.10 (D1.366) took out of this class. The hooks a
 * session really runs go through `executePluginHookAutomations`, which called a
 * byte-identical PRIVATE copy in `plugins/hooks-automation.ts` — so the two
 * suites that pinned the merge (`hook-command.test.ts` and
 * `hook-decision-contract.test.ts`) were pinning the copy nothing ran. That
 * production copy is now the one export; both suites import it from there.
 *
 * P3.194's history went with it and is on that export: this WAS a second
 * decision merge, ~30 lines of near-copy of `hook-decision-contract.ts`'s, wrong
 * in four ways the canonical merge handled, and it became a two-line adapter
 * from the action shape so that the ordering lives in exactly one place
 * (`mergePreToolUseDecisionObjects`).
 *
 * A comment of the same height as what it replaced, deliberately: the plans
 * cite this file by LINE (the C3.90 `warnConfig` docblock further down is one
 * such anchor), and a deletion here would have moved every one of them.
 * `toPreToolUseDecision` and the two decision types it needed left with it.
 *
 * Nothing else in this class reads a hook decision: it runs the scheduler and
 * the App-event handlers only (see the class docblock).
 */

// ============================================================================
// AutomationSystem Options
// ============================================================================

export interface AutomationSystemOptions {
  /** Workspace root path (where automations.json lives) */
  workspaceRootPath: string;
  /** Workspace ID for logging and events */
  workspaceId: string;
  /** Working directory for command execution */
  workingDir?: string;
  /** Active source slugs for permission rules */
  activeSourceSlugs?: string[];
  /**
   * D1.354 — THE TWO COMMAND AUTHORITIES THAT STOOD HERE ARE GONE, and F1.10
   * (D1.366) then removed the rest of the agent-event half they served.
   *
   * `commandHookRunner` (a host-injected process/isolation owner) and
   * `allowDirectCommandHooks` (the ungated direct-spawn opt-in) were both
   * TEST-ONLY. D1.351 measured it: the only production `new AutomationSystem`
   * — `SessionManager`'s per-workspace system — passed neither, and
   * `buildPinnedAgentAutomationSystem` never passes `nativeSystem`, so
   * `PluginScopedAutomationSystem` is the whole production agent-event path
   * and this class's `executeAgentEvent` had no production caller AT ALL.
   *
   * The obvious tidy — delete the injected runner and keep the opt-in — was
   * REFUSED and is worth knowing, because it inverts the safety: the
   * direct-spawn opt-in runs a command hook with no permission gate, no receipt
   * and no isolation profile, so removing the injected runner alone would have
   * removed the SAFER of two dead authorities and left the dangerous one as the
   * only way this class could run a hook. Both, or neither. Both.
   *
   * F1.10 took what that left: `executeAgentEvent` (its `decision` actions and
   * webhooks), the `hasAgentEventMatchers` predicate and the empty
   * `buildSdkHooks`, none reached by any production caller, plus the hook
   * documents' matchers they answered from. The class is no longer an
   * `AgentAutomationSystem`, so nothing that expects one can be handed it.
   *
   * Where the hooks a user writes really run: `executePluginHookAutomations`
   * (`plugins/hooks-automation.ts`), fed from the capability view by
   * `capabilities/runtime-automations.ts`, with BOTH command authorities under
   * names a shipped session passes — `runner`, filled by
   * `SessionManager.pluginCommandHookRunner`, and `allowDirectCommandRunner`,
   * which `buildPinnedAgentAutomationSystem` sets for the non-Pi providers. The
   * cases that drove this class's agent-event branch run there now; the
   * test file's F1.10 block names where each one went.
   */
  /** Whether to start the scheduler service (default: false) */
  enableScheduler?: boolean;
  /** Called when prompts are ready to be executed */
  onPromptsReady?: (prompts: PendingPrompt[]) => void;
  /** Called when webhook results are available */
  onWebhookResults?: (results: WebhookActionResult[]) => void;
  /** Called when an error occurs during automation execution */
  onError?: (event: AutomationEvent, error: Error) => void;
  /** Called when events are lost after retries */
  onEventLost?: (events: string[], error: Error) => void;
}

// ============================================================================
// AutomationSystem Implementation
// ============================================================================

/**
 * The workspace's automation system: the scheduler, the prompt/webhook/event-log
 * handlers for App events, the session-metadata diffing that emits them, and
 * the config watcher's reader of `automations.json`. Nothing else.
 *
 * **It is not a hook dispatcher, and F1.10 (D1.366) is why.** Its agent-event
 * half had no production caller (D1.351; the options interface carries the
 * measurement), yet it parsed the workspace `hooks.json` and the `config.json`
 * hooks block INTO its matcher map and answered a matcher predicate from them —
 * a parse that read like a dispatch nothing performed. The documents are still
 * READ, for their DIAGNOSTICS only: C3.307's notes surface
 * (`SessionManager.warnHooksConfigNotes` reads {@link configWarnings}) has no
 * other producer, and since F1.229 a broken hook document's ERROR rides it as a
 * note too, never a reload refusal. Their matchers are dropped in `readMergedConfig`.
 *
 * A user's hooks — `hooks.json`, the workspace `config.json` hooks block, an
 * `automations.json` agent-event entry, a project's, a plugin's, a skill's
 * frontmatter — are read from the capability view by
 * `capabilities/runtime-automations.ts` and dispatched by
 * `executePluginHookAutomations` (`plugins/hooks-automation.ts`), which every
 * tier of a real session goes through and which owns the permission-gated and
 * direct-spawn authorities alike.
 */
export class AutomationSystem implements AutomationsConfigProvider {
  readonly eventBus: WorkspaceEventBus;

  private readonly options: AutomationSystemOptions;
  private config: AutomationsConfig | null = null;
  private promptHandler: PromptHandler | null = null;
  private webhookHandler: WebhookHandler | null = null; private scriptHandler: ScriptHandler | null = null;
  private eventLogHandler: EventLogHandler | null = null;
  private scheduler: SchedulerService | null = null;
  private disposed = false;

  // Session metadata tracking (moved from SessionManager)
  private readonly lastKnownMetadata: Map<string, SessionMetadataSnapshot> = new Map();

  constructor(options: AutomationSystemOptions) {
    this.options = options;
    this.eventBus = new WorkspaceEventBus(options.workspaceId);

    // Load configuration
    this.loadConfig();

    // Create handlers
    this.createHandlers();

    // Direct SchedulerTick subscriber: deterministic auto-memory cleanup
    this.registerAutoMemoryCleanup();

    // Start scheduler if enabled
    if (options.enableScheduler) {
      this.startScheduler();
    }

    log.debug(`[AutomationSystem] Created for workspace: ${options.workspaceId}`);
  }

  // ============================================================================
  // Configuration
  // ============================================================================

  /**
   * Read, parse, and validate automations.json. Shared pipeline for loadConfig/reloadConfig.
   * Returns the raw parsed JSON alongside validation results (avoids re-reading for backfillIds).
   */
  private readAndValidateConfig(configPath: string): { raw: unknown; validation: import('./types.ts').AutomationsValidationResult } {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    const validation = validateAutomationsConfig(raw);
    return { raw, validation };
  }

  /**
   * C3.90 — one place that prints non-fatal config diagnostics, reached from
   * both `loadConfig` and `reloadConfig`, and deliberately NOT the `errors`
   * array: a reload with a non-empty `errors` applies no automations at all.
   *
   * C3.307 — and it RETAINS them, because `console.warn` is the one place a
   * hand-authoring user never looks. This channel carries every validation
   * warning of `automations.json` and the hook documents (a matcher divergence,
   * an event never emitted, a Notification type with no emitter, a cron off
   * SchedulerTick …), a hook document's load ERROR (F1.229) and `automations.json`'s
   * own (F1.494) — not one kind of note (F1.458), each a sentence a person acts on.
   *
   * Retained rather than pushed through a callback: this object is built once
   * per WORKSPACE, inside its own constructor, so at the moment `loadConfig`
   * runs there is no session to send an event to, and `reloadConfig` fires from
   * a file watcher that knows nothing about which session is in front. The host
   * reads {@link configWarnings} at its own per-session warning seam instead —
   * `packages/server-core/src/sessions/SessionManager.ts` symbol
   * `warnHooksConfigNotes` — so the notes reach whoever opens a session next and
   * no broadcast rule has to be invented for a workspace with four of them.
   */
  private warnConfig(warnings: readonly string[] | undefined): void {
    if (warnings && warnings.length > 0) {
      this.lastConfigWarnings.push(...warnings);
      console.warn('[AutomationSystem] Automation/hook config warnings:', warnings);
    }
  }

  /**
   * The config notes of the most recent load or reload, in the order they were
   * produced — a refused read's own among them (F1.494) — then F1.1093's note for a
   * user-global hooks.json that does not load, read NOW ({@link withUserGlobalHookDocumentNote}).
   * C3.307. Reset at the top of every {@link readMergedConfig} so a reload that
   * FIXES a note stops reporting it — a stale warning is the same defect as a
   * missing one, one direction over.
   */
  get configWarnings(): readonly string[] {
    return withUserGlobalHookDocumentNote(this.lastConfigWarnings);
  }

  private lastConfigWarnings: string[] = [];

  private readMergedConfig(options: { tolerateErrors: boolean }): {
    config: AutomationsConfig;
    actionCount: number;
    errors: string[];
    backfill?: { configPath: string; raw: unknown };
  } {
    const configPath = resolveAutomationsConfigPath(this.options.workspaceRootPath);
    let baseConfig: AutomationsConfig = { automations: {} };
    let backfill: { configPath: string; raw: unknown } | undefined;
    const errors: string[] = [];
    // C3.307 — the retained notes belong to THIS read. F1.459 — the hook documents
    // are read FIRST, so a refused read below still reports their notes.
    this.lastConfigWarnings = [];
    const hooks = loadLifecycleHooksConfig(this.options.workspaceRootPath);

    if (existsSync(configPath)) {
      try {
        const { raw, validation } = this.readAndValidateConfig(configPath);
        if (!validation.valid || !validation.config) {
          errors.push(...validation.errors);
          if (!options.tolerateErrors) {
            return refusedReadWithHookNotes(hooks, errors, notes => this.warnConfig(notes));
          }
        } else {
          baseConfig = validation.config;
          backfill = { configPath, raw };
        }
        // C3.90 — matcher warnings are REPORTED, never counted. They go to the
        // channel `loadConfig` already labels "config warnings" rather than into
        // `errors`, because `reloadConfig` treats a non-empty `errors` as a
        // failed reload and drops every automation: a comma in a matcher must
        // not be able to do that.
        this.warnConfig(validation.warnings);
      } catch (e) {
        errors.push(`Failed to parse JSON: ${e instanceof Error ? e.message : 'Unknown error'}`);
        if (!options.tolerateErrors) {
          return refusedReadWithHookNotes(hooks, errors, notes => this.warnConfig(notes));
        }
      }
    } else {
      log.debug(`[AutomationSystem] No automations config found at ${configPath}`);
    }

    // F1.10 (D1.366) — the hook documents are read for their DIAGNOSTICS only,
    // and their matchers are dropped here: no caller of this class runs an
    // agent event (the class docblock has the measurement).
    // F1.229 — and so a hook document's ERROR is a note, not a reload verdict.
    // C3.284 had kept it in `errors`, which `reloadConfig` reads as "apply
    // nothing": a broken `hooks.json` held every scheduled and App-event
    // automation of the workspace at its old configuration, over a document this
    // class never runs. It rides C3.307's channel instead — the one array the
    // host raises on a session (`SessionManager.warnHooksConfigNotes` reads
    // `configWarnings`) — where before it reached only the log. An invalid
    // `automations.json` still refuses above: that is the document this runs.
    // Same channel, same reason as the automations warnings above: a hooks
    // document is authored by hand, so its matcher diagnostics have to reach
    // someone without being fatal. C3.307's surface has no other producer.
    // F1.459/F1.494 — ONE helper with the refusal; `errors` reach HERE only at load.
    noteReadDocuments(hooks, errors, 'load', notes => this.warnConfig(notes));
    // hooks.md:612 — the `disableAllHooks` filter that stood here left with the
    // agent-event dispatch it served: it removed agent-lifecycle matchers only
    // (App events, everything this class runs, were never in its reach), and
    // the switch is honoured where hooks do run, in
    // `capabilities/runtime-automations.ts`. An `automations.json` agent-event
    // entry therefore stays in the map it is counted and listed from, exactly
    // as it does when the switch is off.
    const config = baseConfig;
    const actionCount = Object.values(config.automations).reduce(
      (sum, matchers) => sum + (matchers?.reduce((s, m) => s + m.actions.length, 0) ?? 0),
      0
    );

    if (hooks.sources.length > 0) {
      log.debug(`[AutomationSystem] Read hook documents for their diagnostics only: ${hooks.sources.join(', ')}`);
    }

    return { config, actionCount, errors, ...(backfill ? { backfill } : {}) };
  }

  /**
   * Load automations configuration from automations.json (the hook documents for their notes only).
   */
  private loadConfig(): void {
    const result = this.readMergedConfig({ tolerateErrors: true });
    if (result.errors.length > 0) {
      console.warn('[AutomationSystem] Automation/hook config warnings:', result.errors);
    }

    this.config = result.config;
    if (result.backfill) {
      this.backfillIds(result.backfill.configPath, result.backfill.raw);
    }
    this.rotateHistory();
    log.debug(`[AutomationSystem] Loaded ${result.actionCount} automation actions`);
  }

  /**
   * Reload automations configuration.
   * Call this when automations.json changes.
   *
   * Refuses — `success: false`, nothing applied — only for an invalid
   * `automations.json`, and says so on {@link configWarnings} (F1.494). F1.229: a
   * hook document's error is a note there, never a refusal: this class runs no hook.
   */
  reloadConfig(): { success: boolean; automationCount: number; errors: string[] } {
    const result = this.readMergedConfig({ tolerateErrors: false });
    if (result.errors.length > 0) {
      return { success: false, automationCount: 0, errors: result.errors };
    }

    this.config = result.config;
    if (result.backfill) {
      this.backfillIds(result.backfill.configPath, result.backfill.raw);
    }
    log.debug(`[AutomationSystem] Reloaded ${result.actionCount} automation actions`);
    return { success: true, automationCount: result.actionCount, errors: [] };
  }

  /**
   * Backfill missing IDs on matchers in the raw config.
   * Operates on the already-parsed raw JSON to avoid re-reading from disk.
   * Only writes if IDs were actually missing — no-op on subsequent loads.
   */
  private backfillIds(configPath: string, raw: unknown): void {
    try {
      const obj = raw as Record<string, unknown>;
      const eventMap = (obj.automations ?? obj.tasks ?? obj.hooks) as Record<string, unknown[]> | undefined;
      if (!eventMap) return;

      let changed = false;
      for (const matchers of Object.values(eventMap)) {
        if (!Array.isArray(matchers)) continue;
        for (const m of matchers as Record<string, unknown>[]) {
          if (!m.id) { m.id = generateShortId(); changed = true; }
        }
      }

      if (changed) {
        writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
        log.debug('[AutomationSystem] Backfilled missing matcher IDs');
      }
    } catch {
      // Non-critical — IDs will be backfilled on next mutation via IPC
    }
  }

  /**
   * Compact automations-history.jsonl on startup: two-tier retention.
   * 1) Keep only the last N entries per automation ID.
   * 2) If total still exceeds the global cap, drop oldest globally.
   * Runs synchronously during init — single-threaded, no race with concurrent appends.
   */
  private rotateHistory(): void {
    try {
      compactAutomationHistorySync(this.options.workspaceRootPath);
    } catch {
      // Non-critical — compaction failure doesn't affect functionality
    }
  }

  // ============================================================================
  // AutomationsConfigProvider Implementation
  // ============================================================================

  getConfig(): AutomationsConfig | null {
    return this.config;
  }

  getMatchersForEvent(event: AutomationEvent): AutomationMatcher[] {
    return withPageRefreshMatchers(this, event, this.config?.automations[event] ?? []); // UA8.2 — v0.13.4 L247–L249
  }

  // ============================================================================
  // Handlers
  // ============================================================================

  /**
   * Create and register all handlers.
   */
  private createHandlers(): void {
    // Prompt handler
    // P3.189 — three of the five options this call used to pass were read
    // NOWHERE in `PromptHandler` (`workspaceId`, `workspaceRootPath`,
    // `onError`); see `PromptHandlerOptions` for where each concern actually
    // lives. The two that remain are the two the handler reads.
    this.promptHandler = new PromptHandler(
      {
        onPromptsReady: this.options.onPromptsReady,
      },
      this
    );
    this.promptHandler.subscribe(this.eventBus);

    // Webhook handler
    this.webhookHandler = new WebhookHandler(
      {
        workspaceId: this.options.workspaceId,
        workspaceRootPath: this.options.workspaceRootPath,
        onWebhookResults: this.options.onWebhookResults,
        onError: this.options.onError,
      },
      this
    );
    this.webhookHandler.subscribe(this.eventBus); this.scriptHandler = createScriptHandler(this, this.options); // UA8.1

    // Event log handler
    this.eventLogHandler = new EventLogHandler({
      workspaceRootPath: this.options.workspaceRootPath,
      workspaceId: this.options.workspaceId,
      onEventLost: this.options.onEventLost,
    });
    this.eventLogHandler.subscribe(this.eventBus);

    log.debug(`[AutomationSystem] Handlers created and subscribed`);
  }

  // ============================================================================
  // Scheduler
  // ============================================================================

  /**
   * Start the scheduler service.
   */
  private startScheduler(): void {
    if (this.scheduler) return;

    // "When the app starts […] Desktop checks whether each task missed any runs
    // in the last seven days" (desktop-scheduled-tasks.md:74). This is the
    // "app starts" half; the wake half is the host's, through the same public
    // method. It runs BEFORE the first aligned tick so a miss cannot be
    // overtaken by an ordinary run of the same occurrence.
    void this.runMissedRunSweep().catch(error => {
      log.warn(`[AutomationSystem] Missed-run sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    });

    this.scheduler = new SchedulerService(async (payload: SchedulerTickPayload) => {
      const tickAt = Date.parse(payload.timestamp);
      this.advanceScheduleCursors(Number.isFinite(tickAt) ? tickAt : Date.now());
      await this.eventBus.emit('SchedulerTick', {
        workspaceId: this.options.workspaceId,
        timestamp: Date.now(),
        localTime: payload.localTime,
        utcTime: payload.timestamp,
      });
    });

    this.scheduler.start();
    log.debug(`[AutomationSystem] Scheduler started`);
  }

  /**
   * Move every scheduled matcher's cursor up to the current minute WITHOUT
   * firing anything — the in-session half of the contract.
   *
   * desktop-scheduled-tasks.md:70 — "If your computer sleeps through a
   * scheduled time, the run is skipped." While the minute tick is running, every
   * occurrence gets its own tick, so an occurrence the tick did not act on was
   * skipped on purpose (disabled, condition failed, tick overrun) and must never
   * come back as a catch-up on the next start.
   *
   * Called on every tick rather than only on a match, so the cursor also covers
   * occurrences whose prompt did not run.
   */
  advanceScheduleCursors(now: number = Date.now()): void {
    try {
      const plan = planCatchupFires({
        matchers: this.getMatchersForEvent('SchedulerTick'),
        state: readScheduleState(this.options.workspaceRootPath),
        now,
        // No window ⇒ advance only. The absence IS the "never fire here" flag.
      });
      mergeScheduleState(this.options.workspaceRootPath, plan.cursors);
    } catch (error) {
      log.warn(`[AutomationSystem] Cursor advance failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The start/wake missed-run sweep (desktop-scheduled-tasks.md:74).
   *
   * "If it did, Desktop starts exactly one catch-up run for the most recently
   * missed time and discards anything older. A daily task that missed six days
   * runs once on wake."
   *
   * Not a replayed `SchedulerTick`: `matchesBasePredicate` evaluates a matcher's
   * cron against the CURRENT minute, so a synthetic tick for a past occurrence
   * would match nothing. The sweep selects matchers from the persisted cursor
   * and hands them to the same prompt builder the event path uses.
   *
   * The cursors are persisted BEFORE the prompts are delivered: a delivery that
   * throws halfway must not leave the sweep able to fire the same occurrence
   * again on the next wake.
   */
  async runMissedRunSweep(now: number = Date.now()): Promise<{ fired: number }> {
    if (this.disposed) return { fired: 0 };
    const matchers = this.getMatchersForEvent('SchedulerTick');
    if (matchers.length === 0) return { fired: 0 };

    const plan = planCatchupFires({
      matchers,
      state: readScheduleState(this.options.workspaceRootPath),
      now,
      windowMs: AUTOMATION_CATCHUP_WINDOW_MS,
    });
    mergeScheduleState(this.options.workspaceRootPath, plan.cursors);
    if (plan.fires.length === 0) return { fired: 0 };

    const byId = new Map(matchers.filter(matcher => matcher.id).map(matcher => [matcher.id!, matcher]));
    const pendingPrompts: PendingPrompt[] = [];
    for (const fire of plan.fires) {
      const matcher = byId.get(fire.matcherId);
      if (!matcher) continue;
      const occurrence = new Date(fire.occurrenceAt);
      pendingPrompts.push(...buildPendingPromptsForMatchers({
        sessionId: undefined,
        event: 'SchedulerTick',
        // The env describes the MISSED time, not the sweep time — a catch-up
        // prompt that reads ${NESSY_LOCAL_TIME} must see 9am, not 11pm.
        payload: {
          workspaceId: this.options.workspaceId,
          timestamp: fire.occurrenceAt,
          localTime: occurrence.toTimeString().slice(0, 5),
          utcTime: occurrence.toISOString(),
        } as EventPayloadMap['SchedulerTick'],
        sources: [{ matcher, catchUpForOccurrenceAt: fire.occurrenceAt }],
      }));
    }

    if (pendingPrompts.length === 0) return { fired: 0 };
    log.debug(`[AutomationSystem] Missed-run sweep starting ${pendingPrompts.length} catch-up run(s)`);
    this.options.onPromptsReady?.(pendingPrompts);
    return { fired: pendingPrompts.length };
  }

  /**
   * Scheduled auto-memory cleanup ("dream" pass): a direct SchedulerTick
   * subscriber that rewrites ONLY marker-stamped agent-written memory entries
   * (duplicate collapse + age expiry) across the user/project/session scopes
   * of this workspace. Deterministic code — never an agent run. Throttled to
   * daily via a persisted last-run stamp; failures log and no-op.
   */
  private registerAutoMemoryCleanup(): void {
    this.eventBus.on('SchedulerTick', () => {
      try {
        let memoryEnabled = true;
        try {
          memoryEnabled = getMemoryEnabled();
        } catch {
          // Default on, matching memory prompt loading.
        }
        if (!memoryEnabled) return;

        const result = runScheduledAutoMemoryCleanup({
          workspaceId: this.options.workspaceId,
          workingDirectory: this.options.workingDir ?? this.options.workspaceRootPath,
        });
        if (result.ran && result.filesChanged > 0) {
          log.debug(
            `[AutomationSystem] Auto-memory cleanup rewrote ${result.filesChanged} file(s) (expired: ${result.removedExpired}, duplicates: ${result.removedDuplicates})`
          );
        }
      } catch (error) {
        log.warn(
          `[AutomationSystem] Auto-memory cleanup failed (no-op): ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  /**
   * Stop the scheduler service.
   */
  stopScheduler(): void {
    if (this.scheduler) {
      this.scheduler.stop();
      this.scheduler = null;
      log.debug(`[AutomationSystem] Scheduler stopped`);
    }
  }

  // ============================================================================
  // Session Metadata Diffing
  // ============================================================================

  /**
   * Update session metadata and emit events for changes.
   *
   * This replaces the diffing logic that was in SessionManager.
   * Call this whenever session metadata changes.
   *
   * @param sessionId - The session ID
   * @param next - The new metadata snapshot
   * @returns The events that were emitted
   */
  async updateSessionMetadata(
    sessionId: string,
    next: SessionMetadataSnapshot
  ): Promise<AppEvent[]> {
    const prev = this.lastKnownMetadata.get(sessionId) ?? {};
    const emittedEvents: AppEvent[] = [];
    const timestamp = Date.now();

    // Common fields for all events
    const sessionName = next.sessionName;
    const labels = next.labels ?? [];

    // Permission mode change
    if (prev.permissionMode !== next.permissionMode) {
      await this.eventBus.emit('PermissionModeChange', {
        sessionId,
        sessionName,
        workspaceId: this.options.workspaceId,
        timestamp,
        labels,
        oldMode: prev.permissionMode ?? '',
        newMode: next.permissionMode ?? '',
      });
      emittedEvents.push('PermissionModeChange');
    }

    // Labels (array diff)
    const prevLabels = new Set(prev.labels ?? []);
    const nextLabels = new Set(next.labels ?? []);

    for (const label of nextLabels) {
      if (!prevLabels.has(label)) {
        await this.eventBus.emit('LabelAdd', {
          sessionId,
          sessionName,
          workspaceId: this.options.workspaceId,
          timestamp,
          labels: [...nextLabels],
          label,
        });
        emittedEvents.push('LabelAdd');
      }
    }

    for (const label of prevLabels) {
      if (!nextLabels.has(label)) {
        await this.eventBus.emit('LabelRemove', {
          sessionId,
          sessionName,
          workspaceId: this.options.workspaceId,
          timestamp,
          labels: [...nextLabels],
          label,
        });
        emittedEvents.push('LabelRemove');
      }
    }

    // Flag change
    const wasFlagged = prev.isFlagged ?? false;
    const isFlagged = next.isFlagged ?? false;
    if (wasFlagged !== isFlagged) {
      await this.eventBus.emit('FlagChange', {
        sessionId,
        sessionName,
        workspaceId: this.options.workspaceId,
        timestamp,
        labels,
        isFlagged,
      });
      emittedEvents.push('FlagChange');
    }

    // Session status change
    if (prev.sessionStatus !== next.sessionStatus) {
      await this.eventBus.emit('SessionStatusChange', {
        sessionId,
        sessionName,
        workspaceId: this.options.workspaceId,
        timestamp,
        labels,
        oldState: prev.sessionStatus ?? '',
        newState: next.sessionStatus ?? '',
      });
      emittedEvents.push('SessionStatusChange');
    }

    // Update stored metadata
    this.lastKnownMetadata.set(sessionId, { ...next });

    if (emittedEvents.length > 0) {
      log.debug(`[AutomationSystem] Emitted ${emittedEvents.length} events for session ${sessionId}: ${emittedEvents.join(', ')}`);
    }

    return emittedEvents;
  }

  /**
   * Remove session metadata tracking.
   * Call this when a session is deleted.
   */
  removeSessionMetadata(sessionId: string): void {
    this.lastKnownMetadata.delete(sessionId);
    log.debug(`[AutomationSystem] Removed metadata for session ${sessionId}`);
  }

  /**
   * Get stored metadata for a session.
   */
  getSessionMetadata(sessionId: string): SessionMetadataSnapshot | undefined {
    return this.lastKnownMetadata.get(sessionId);
  }

  /**
   * Set initial metadata for a session (without emitting events).
   * Call this when loading existing sessions.
   */
  setInitialSessionMetadata(sessionId: string, metadata: SessionMetadataSnapshot): void {
    this.lastKnownMetadata.set(sessionId, { ...metadata });
  }

  // ============================================================================
  // Direct Event Emission
  // ============================================================================

  /**
   * Emit a LabelConfigChange event.
   * Call this when labels/config.json changes.
   */
  async emitLabelConfigChange(): Promise<void> {
    await this.eventBus.emit('LabelConfigChange', {
      workspaceId: this.options.workspaceId,
      timestamp: Date.now(),
    });
  }

  /**
   * Emit an event directly (for edge cases).
   */
  async emit<T extends AutomationEvent>(event: T, payload: EventPayloadMap[T]): Promise<void> {
    await this.eventBus.emit(event, payload);
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * Whether this system's scheduler is running RIGHT NOW.
   *
   * D1.409 — the receipt for the managed local-automation gate. When a codex
   * deployment's `[features] in_app_local_automation = false` lands mid-process
   * the host stops the schedulers of systems that were built before it, and its
   * operator notice has to say how many it really stopped: `stopScheduler()` is
   * idempotent and reports nothing, so a count taken from the number of
   * workspaces would name systems that were already off. Read rather than
   * derived, because `enableScheduler` is a construction ARGUMENT and this is
   * the state — the gap between those two is the whole of D1.409.
   */
  get schedulerRunning(): boolean {
    return this.scheduler !== null;
  }

  /**
   * Check if the system has been disposed.
   */
  isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Dispose the automation system, cleaning up all resources.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;

    log.debug(`[AutomationSystem] Disposing for workspace: ${this.options.workspaceId}`);

    // Stop scheduler
    this.stopScheduler();

    // Dispose handlers
    this.promptHandler?.dispose();
    this.webhookHandler?.dispose(); this.scriptHandler?.dispose();
    await this.eventLogHandler?.dispose();

    // Dispose event bus
    this.eventBus.dispose();

    // Clear metadata
    this.lastKnownMetadata.clear();

    this.disposed = true;
    log.debug(`[AutomationSystem] Disposed`);
  }
}

/**
 * P2.496 — the automation system a user who turned ALL hooks off still gets.
 *
 * `buildPinnedAgentAutomationSystem` answers `undefined` when nothing is
 * configured, and a user-tier `disableAllHooks` empties every tier it reaches —
 * so the two states arrive at the registration site looking identical, and the
 * host cannot tell "no hooks were configured" from "the user turned hooks off".
 * That is the whole reason the switch could not reach anything we register
 * ourselves. This object is the difference: inert in every direction, and
 * carrying the one bit that distinguishes them.
 *
 * INERT IS THE CONTRACT, and it is why this is a purpose-built object rather
 * than an empty `PluginScopedAutomationSystem`. Its `executeAgentEvent` returns
 * `{ matchedCount: 0 }`, which is exactly what the pipeline in `claude-agent.ts`
 * derives from the `automationSystem === undefined` branch it used to take
 * (`hookResult` undefined -> no `decision` -> no block, no ask, no
 * `updatedInput`): existing behaviour is unchanged at every consumer, and the
 * only observable difference is that the flag can now be read. A real system
 * built with no configs would bring `assertActive` and `verifyPluginIntegrity`
 * with it, either of which can THROW — a switch that turns hooks off must not
 * add a failure mode.
 *
 * No `buildSdkHooks`: absent leaves `claude-agent.ts`'s `?? {}` as before. An
 * EMPTY listing, though (F1.222): `/hooks` must say "No hooks will run", which
 * is true, rather than "does not publish a hook listing", which reads as unknown.
 * Frozen: it holds no state, and a mutable surface would be a needless one.
 */
export function createUserDisabledAutomationSystem(): UserDisabledAutomationSystem {
  return Object.freeze({
    userTierDisableAllHooks: true,
    executeAgentEvent: async (): Promise<AgentEventExecutionResult> => ({ matchedCount: 0 }),
    hasAgentEventMatchers: () => false,
    describeHookBindings: () => [],
  });
}

/**
 * F1.229 — a hook document's error, worded as the note it now is.
 *
 * The loader's message already names its source (`hooks.json: …`,
 * `config.json hooks: …`) and what is wrong with it; this adds what it COSTS,
 * because the surface that raises it (`SessionManager.warnHooksConfigNotes`)
 * otherwise carries notes about hooks that are correct and merely have no
 * producer here. On the path that runs hooks (`capabilities/runtime-automations.ts`
 * → `parseHooksConfigContent`) an unparseable or invalid document registers
 * nothing and an unknown event key is skipped, so "will not run" is exact for
 * every error the loader raises. The source prefix stays first, so a note still
 * reads as belonging to its document.
 *
 * P-WJ-ae-1 — the error is shown through {@link shownNoteError}, as F1.494's
 * `automations.json` note is: the loader's error is `JSON.parse`'s message, which
 * echoes an unquoted value, and it reached the surface whole and uncapped.
 */
function hookDocumentErrorNote(error: string): string {
  return `${shownNoteError(error)} — this hook document did not load as written, so the hooks it affects will not run until it is fixed (automations.json is not affected)`;
}

/**
 * F1.278 — the inert system {@link createUserDisabledAutomationSystem} returns,
 * NAMED so the pinned builder's return type can list it.
 * `PinnedAgentAutomationSystem` (`capabilities/runtime-automations.ts`) is the
 * closed list of what `buildPinnedAgentAutomationSystem` can hand the host, and
 * `automation-wrapper-forwarding.test.ts` derives the wrapper's member table
 * from that list — so this shape's members are placed there by construction.
 */
export type UserDisabledAutomationSystem = AgentAutomationSystem & { readonly userTierDisableAllHooks: true };

/**
 * F1.459 (origin WJ-ii verifier on F1.269, F1.269d; the F1.229/C3.307 residue) —
 * the hook documents' notes, in the order the full read gives them: the load
 * ERRORS as F1.229's notes first, then the matcher warnings.
 *
 * Shared by the full read and the refused one. A reload refused for an invalid
 * `automations.json` returned before the hook documents were read, AFTER the
 * notes array had been reset for that read — so a still-broken `hooks.json`'s
 * note vanished from `SessionManager.warnHooksConfigNotes`, the one surface that
 * shows it, while the refusal reached only the watcher's log. The documents are
 * read for their diagnostics whatever `automations.json` holds, so their notes
 * describe them now; the refused reload still applies nothing.
 */
function noteHookDocuments(
  hooks: ReturnType<typeof loadLifecycleHooksConfig>,
  warn: (notes: readonly string[] | undefined) => void,
): void {
  warn(hooks.errors.map(hookDocumentErrorNote));
  warn(hooks.warnings);
}

/**
 * F1.459 — a refused read's result, with the documents' notes taken first.
 * F1.494 — among them the refusal's own: only a RELOAD refuses (`loadConfig`
 * tolerates), so the automations that stay in effect are the previous ones.
 */
function refusedReadWithHookNotes(
  hooks: ReturnType<typeof loadLifecycleHooksConfig>,
  errors: string[],
  warn: (notes: readonly string[] | undefined) => void,
): { config: AutomationsConfig; actionCount: number; errors: string[] } {
  noteReadDocuments(hooks, errors, 'reload', warn);
  return { config: { automations: {} }, actionCount: 0, errors };
}

/**
 * F1.494 (origin WJ-vv P-WJ-vv-1) — every note one read produces, in one order
 * for the full read and the refused one: an `automations.json` that did not load
 * first, then the hook documents' (F1.459). `errors` is that document's own list.
 */
function noteReadDocuments(
  hooks: ReturnType<typeof loadLifecycleHooksConfig>,
  errors: readonly string[],
  when: 'load' | 'reload',
  warn: (notes: readonly string[] | undefined) => void,
): void {
  if (errors.length > 0) warn([automationsNotLoadedNote(errors[0]!, when)]);
  noteHookDocuments(hooks, warn);
}

/**
 * F1.494 — an `automations.json` that did not load, worded as the note it now is.
 *
 * Before, a reload refused for it reached only the config watcher's
 * `sessionLog.error`, and the load-time read only `console.warn`: the person who
 * edited the file had no surface, while the previous automations kept running
 * (reload) or none ran (load). The note rides C3.307's channel, so
 * `SessionManager.warnHooksConfigNotes` raises it under F1.456's lead-in.
 *
 * The FIRST error only — the full list stays on the reload's `errors` and the
 * logs — shown through {@link shownNoteError}.
 */
function automationsNotLoadedNote(firstError: string, when: 'load' | 'reload'): string {
  const effect = when === 'load' ? 'no automations from it are in effect' : 'the previous automations stay in effect';
  return `${AUTOMATIONS_CONFIG_FILE} did not load (${shownNoteError(firstError)}); ${effect}`;
}

/**
 * F1.494, P-WJ-ae-1 — a document's error as a note shows it: masked by the
 * tool-result secret table and capped. Measured under bun 1.3.14: `JSON.parse`
 * echoes an unquoted identifier (`Unexpected identifier "<value>"`), and a
 * validation error echoes a hand-written value (`Invalid timezone: <value>`), so
 * an error CAN carry file bytes. The full error stays in the logs. The WARNINGS
 * beside these notes pass through as written: they quote a matcher, an event, a
 * label or a model name the person wrote as such, never a parser's echo.
 *
 * F1.501 (origin WJ-ae) — a PARSE error's echo is dropped before the mask, by
 * {@link withoutJsonParseEcho}, so a value outside the secret table no longer
 * reaches the note. What stays masked-and-capped rather than dropped is the
 * VALIDATION error: it names the field it quotes (`Invalid timezone: …`), the
 * value is what the person must fix, and a field value is not a parser's
 * window onto the file.
 */
export function shownNoteError(error: string): string {
  const maxErrorChars = 160;
  const masked = scanToolResultForSecrets(withoutJsonParseEcho(error)).text;
  return masked.length > maxErrorChars ? `${masked.slice(0, maxErrorChars)}…` : masked;
}

/**
 * F1.501 — a JSON parse error without the file text the engine echoes; any other
 * error unchanged. The two engines this module runs on phrase it differently,
 * measured 2026-09-24 over sixteen malformed documents each
 * (`work/wjax/probe-json-messages.js`):
 *
 *   - bun 1.3.14 (JavaScriptCore; the headless server): ONE form carries a value,
 *     `JSON Parse error: Unexpected identifier "<value>"`, and no form carries a
 *     position. The others name one character at most (`Unrecognized token '@'`,
 *     `Invalid escape character q`) or none (`Unexpected EOF`).
 *   - V8 (Node 24.4.1; the desktop's main process runs the same engine family):
 *     `Unexpected token '<c>', <the document, or ~20 characters of it around the
 *     token> is not valid JSON` — a window onto the FILE, every byte of it, where
 *     bun shows one identifier. Its other forms carry no text and do carry the
 *     position, `in JSON at position 13 (line 1 column 14)`, and are kept whole.
 *
 * So the note keeps the parser's own words, drops the echo, and shows the line
 * and column wherever the engine gives them — V8's positional forms. bun gives
 * none on any form, and a note cannot compute one without the document, which
 * the loaders do not pass here; that is the residue, stated. A parse message in
 * a shape neither rule recognises still goes through the mask and the cap.
 */
export function withoutJsonParseEcho(error: string): string {
  return error
    .replace(/(JSON Parse error: Unexpected identifier) "[^"]*"/, '$1 (its value is not shown here)')
    .replace(/(Unexpected token '[\s\S]*?'), [\s\S]* is not valid JSON$/, '$1 in JSON (the text around it is not shown here)');
}

// F1.494 — imported HERE, not beside the others: the plans cite this file by
// LINE, and an import line at the top would have moved every anchor below it.
import { scanToolResultForSecrets } from '../agent/tool-result-secret-scan.ts';

/**
 * F1.1093 (origin DN-051) — the user-global `hooks.json` (`<config dir>/hooks.json`,
 * `~/.nessy-agent/hooks.json` unless `NESSY_CONFIG_DIR` moves it) that does not
 * load, as F1.229's note: {@link hookDocumentErrorNote}'s wording over its FIRST
 * error, the file named by its path (`~/…` under the home directory) and never by
 * its content, which that wording's {@link shownNoteError} keeps out.
 *
 * That document's hooks run in every session of every workspace, on every runtime:
 * `capabilities/runtime-automations.ts` parses it from the capability view with
 * `parseHooksConfigContent`, keeps the config and drops the `errors`, so a broken
 * one registers nothing. Its failure reached no surface, while a workspace
 * `hooks.json` had F1.229's note and a project `.nessy-agent/hooks.json` the
 * `plugin.project_hooks.invalid_config` diagnostic — the user's own global guard
 * hooks stopped silently. The note rides this array because it is the one the
 * host raises on a session (`SessionManager.warnHooksConfigNotes`); the workspace
 * document has no Settings diagnostics entry, so neither does this one.
 *
 * Read at each {@link AutomationSystem.configWarnings} read rather than in
 * `readMergedConfig`: the config watcher's global arm
 * (`onUserGlobalHooksConfigChange`) rebuilds the session runtimes and reloads no
 * workspace's system, so a note taken at load would miss a file broken later and
 * outlive its fix. The host reads the array once per agent build, which follows
 * that rebuild. The first error only, as F1.494's note does. Residue: this
 * document's WARNINGS (a comma in a matcher, an event with no producer here) and
 * the administrator's builtin hooks document still reach no surface.
 */
function withUserGlobalHookDocumentNote(notes: readonly string[]): readonly string[] {
  const path = getUserGlobalHooksConfigPath();
  const firstError = loadHooksConfigFile(path, shownUserGlobalHooksPath(path)).errors[0];
  return firstError === undefined ? notes : [...notes, hookDocumentErrorNote(firstError)];
}

/** F1.1093 — the file as its owner knows it: `~/…` under the home directory, else its path. */
function shownUserGlobalHooksPath(path: string): string {
  const home = homedir();
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

// F1.1093 — imported here for the reason F1.494 gives above.
import { homedir } from 'node:os';
import { sep } from 'node:path';

// ============================================================================
// UA8.1 — the script action's handler (craft-agents-oss v0.13.4's `createHandlers` hunk, adapted)
// ============================================================================

/*
 * Kept OUTSIDE the class body on purpose: the docs cite this file by line up to 871, past the class's closing brace,
 * so the class gains one field and two calls on existing lines (line for line) and the rest lives here.
 */
export interface AutomationSystemOptions {
  /** Called when script results are available (upstream's `onScriptResults`). */
  onScriptResults?: (results: ScriptActionResult[]) => void;
  /**
   * The audit sink for every script run and refusal. `SessionManager` wires it to
   * `PrivilegedExecutionBroker.auditEvent` (`logs/privileged-actions.jsonl`); `shared` cannot import `server-core`.
   */
  scriptAudit?: ScriptAuditPort;
  /** The ledger key's provider for script approvals; default: the host-installed one. Tests inject theirs. */
  scriptApprovalsKeyProvider?: HostApprovalsKeyProvider;
}

/**
 * The App-event script handler, subscribed to the system's bus. Its managed-policy check is at USE time inside
 * `runApprovedScript`, so a policy that turns on after this system was built stops the next run (spec §6) — the
 * `enableScheduler` construction gate alone could not, and App events other than `SchedulerTick` never pass the
 * scheduler at all.
 */
function createScriptHandler(system: AutomationSystem, options: AutomationSystemOptions): ScriptHandler {
  // UA8.2 — the class calls this once, from its constructor; the page-refresh reload reads these options.
  pageRefreshOptions.set(system, options);
  void system.reloadPageRefreshMatchers(); // v0.13.4 L93
  const handler = new ScriptHandler(
    {
      workspaceId: options.workspaceId,
      workspaceRootPath: options.workspaceRootPath,
      onScriptResults: options.onScriptResults,
      onError: options.onError,
      ...(options.scriptAudit ? { audit: options.scriptAudit } : {}),
      ...(options.scriptApprovalsKeyProvider ? { keyProvider: options.scriptApprovalsKeyProvider } : {}),
    },
    system
  );
  handler.subscribe(system.eventBus);
  return handler;
}

import type { ScriptActionResult } from './types.ts';
import type { ScriptAuditPort } from './script-executor.ts';
import type { HostApprovalsKeyProvider } from '../approvals/host-approvals.ts';

// ============================================================================
// UA8.2 — scheduled page refresh (craft-agents-oss v0.13.4 automation-system.ts L26, L80, L93, L247–L270, adapted)
// ============================================================================

/*
 * Outside the class body for the reason above. The synthetic `page:<slug>` matchers (`pages/refresh.ts`) join the
 * configured SchedulerTick matchers in `getMatchersForEvent`, so a refresh rides the scheduler, the ScriptHandler
 * (which passes the refresh approval to `runApprovedScript`) and history exactly as upstream. NESSY: a matcher exists
 * only for an APPROVED refresh at its current bytes, so building them needs the ledger key — the reload is async, and a
 * key the host cannot load builds none (closed).
 */
const pageRefreshOptions = new WeakMap<AutomationSystem, AutomationSystemOptions>();
const pageRefreshMatchers = new WeakMap<AutomationSystem, AutomationMatcher[]>();
const pageRefreshReloads = new WeakMap<AutomationSystem, number>();

function withPageRefreshMatchers(system: AutomationSystem, event: AutomationEvent, configured: AutomationMatcher[]): AutomationMatcher[] {
  if (event !== 'SchedulerTick') return configured;
  const synthetic = pageRefreshMatchers.get(system);
  return synthetic && synthetic.length > 0 ? [...configured, ...synthetic] : configured;
}

export interface AutomationSystem {
  /**
   * Rebuild the synthetic page-refresh matchers from `pages/{slug}/page.json` and the host ledger (v0.13.4
   * `reloadPageRefreshMatchers`, async here: the approval check needs the ledger key). Resolves to the count.
   * `SessionManager` calls it from the config watcher's pages branch; `pages:approveRefresh` after an approval.
   */
  reloadPageRefreshMatchers(): Promise<number>;
}

AutomationSystem.prototype.reloadPageRefreshMatchers = async function reloadPageRefreshMatchers(this: AutomationSystem): Promise<number> {
  const options = pageRefreshOptions.get(this);
  if (!options || this.isDisposed()) return 0;
  const generation = (pageRefreshReloads.get(this) ?? 0) + 1;
  pageRefreshReloads.set(this, generation);
  let matchers: AutomationMatcher[];
  try {
    matchers = await loadPageRefreshMatchers(options.workspaceRootPath, options.scriptApprovalsKeyProvider ?? getHostApprovalsKeyProvider());
  } catch (error) {
    log.warn(`[AutomationSystem] Failed to load page refresh matchers: ${error instanceof Error ? error.message : String(error)}`);
    matchers = [];
  }
  // A slower, older reload must not overwrite a newer one's reading.
  if (pageRefreshReloads.get(this) !== generation) return pageRefreshMatchers.get(this)?.length ?? 0;
  pageRefreshMatchers.set(this, matchers);
  if (matchers.length > 0) {
    log.debug(`[AutomationSystem] ${matchers.length} page refresh matcher(s) active`);
  }
  return matchers.length;
};

import { loadPageRefreshMatchers } from '../pages/refresh.ts';
import { getHostApprovalsKeyProvider } from '../approvals/host-approvals.ts';
