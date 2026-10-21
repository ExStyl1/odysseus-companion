/**
 * ScriptHandler - Processes script actions for App events (UA8.1).
 *
 * Adapted from craft-agents-oss v0.13.4:packages/shared/src/automations/handlers/script-handler.ts (Apache-2.0).
 * Upstream called its raw executor; ours runs every action through `runApprovedScript` (the only script entry:
 * the managed-policy check at use time, containment, the host-approvals ledger, the verified bytes from a private
 * copy, the audit port) with the allowlisted env of `buildScriptEnv`. A refused run (unapproved, changed, managed
 * policy) is a `blocked` result and is recorded in automation history like any other run — an unattended trigger
 * cannot show a card, so history is where the refusal surfaces.
 *
 * App events only, as upstream: an agent event (PreToolUse, Stop, …) never reaches this handler, and the runtime
 * hook dispatch (`plugins/hooks-automation.ts`) runs no `script` action either — validation warns the author.
 *
 * Concurrency (upstream): runs of the SAME matcher never overlap. A tick that fires while the matcher's previous
 * run is still in flight is skipped and recorded in history (a hanging script surfaces as a run of skips instead
 * of silently piling up processes). Actions within one matcher run sequentially; distinct matchers run
 * independently. A page refresh is also locked per page inside `runApprovedScript` (UA8.3 follow-up), so a
 * "Run now" (`pages:runRefreshNow`) and a scheduled tick of the same page cannot overlap either.
 */

import { createLogger } from '../../utils/debug.ts';
import type { EventBus, BaseEventPayload } from '../event-bus.ts';
import type { AutomationHandler, AutomationsConfigProvider } from './types.ts';
import { APP_EVENTS, type AutomationEvent, type ScriptAction, type ScriptActionResult, type AppEvent } from '../types.ts';
import { matcherMatches, buildScriptEnv } from '../utils.ts';
import { runApprovedScript, createScriptHistoryEntry, SCRIPT_RUN_IN_PROGRESS_REASON, type ScriptAuditPort } from '../script-executor.ts';
import { appendAutomationHistoryEntry } from '../history-store.ts';
import type { HostApprovalsKeyProvider } from '../../approvals/host-approvals.ts';
import { isPageRefreshMatcherId, pageRefreshApprovalSubject, REFRESH_APPROVAL_KIND } from '../../pages/refresh.ts';

const log = createLogger('script-handler');

// ============================================================================
// Types
// ============================================================================

export interface ScriptHandlerOptions {
  /** Workspace ID */
  workspaceId: string;
  /** Workspace root path (scripts live and run here) */
  workspaceRootPath: string;
  /** Called when script results are available */
  onScriptResults?: (results: ScriptActionResult[]) => void;
  /** Called when a script execution fails unexpectedly */
  onError?: (event: AutomationEvent, error: Error) => void;
  /** The audit sink every run and refusal is reported to (`SessionManager` → `PrivilegedExecutionBroker.auditEvent`). */
  audit?: ScriptAuditPort;
  /** The ledger key's provider; default: the host-installed one. Tests inject theirs. */
  keyProvider?: HostApprovalsKeyProvider;
}

/** Script actions of one matched matcher, executed sequentially under its lock */
interface MatcherScripts {
  matcherId: string;
  actions: ScriptAction[];
}

// ============================================================================
// ScriptHandler Implementation
// ============================================================================

export class ScriptHandler implements AutomationHandler {
  private readonly options: ScriptHandlerOptions;
  private readonly configProvider: AutomationsConfigProvider;
  /** Per-matcher concurrency locks: present key = run in flight */
  private readonly inFlight = new Map<string, Promise<void>>();
  private bus: EventBus | null = null;
  private boundHandler: ((event: AutomationEvent, payload: BaseEventPayload) => Promise<void>) | null = null;

  constructor(options: ScriptHandlerOptions, configProvider: AutomationsConfigProvider) {
    this.options = options;
    this.configProvider = configProvider;
  }

  /**
   * Subscribe to App events on the bus.
   */
  subscribe(bus: EventBus): void {
    this.bus = bus;
    this.boundHandler = this.handleEvent.bind(this);
    bus.onAny(this.boundHandler);
    log.debug(`[ScriptHandler] Subscribed to event bus`);
  }

  /**
   * Handle an event by executing matching script actions.
   */
  private async handleEvent(event: AutomationEvent, payload: BaseEventPayload): Promise<void> {
    // Only process App events for script actions
    if (!APP_EVENTS.includes(event as AppEvent)) {
      return;
    }

    const matchers = this.configProvider.getMatchersForEvent(event);
    if (matchers.length === 0) return;

    const matched: MatcherScripts[] = [];
    for (const matcher of matchers) {
      if (!matcherMatches(matcher, event, payload as unknown as Record<string, unknown>)) continue;

      const actions = matcher.actions.filter((a): a is ScriptAction => a.type === 'script');
      if (actions.length > 0) {
        matched.push({ matcherId: matcher.id ?? 'unknown', actions });
      }
    }

    if (matched.length === 0) return;

    log.debug(`[ScriptHandler] Processing ${matched.length} matchers with script actions for ${event}`);

    const results: ScriptActionResult[] = [];

    await Promise.all(
      matched.map(async ({ matcherId, actions }) => {
        // Per-matcher concurrency lock: skip (and record) instead of piling up.
        if (this.inFlight.has(matcherId)) {
          log.debug(`[ScriptHandler] Skipping ${matcherId}: previous run still in progress`);
          for (const action of actions) {
            const skipped: ScriptActionResult = {
              type: 'script',
              script: action.script,
              success: false,
              exitCode: null,
              skipped: true,
              stdout: '',
              stderr: SCRIPT_RUN_IN_PROGRESS_REASON,
              durationMs: 0,
              page: action.page,
            };
            results.push(skipped);
            await this.appendHistory(matcherId, skipped);
          }
          return;
        }

        const run = (async () => {
          for (const action of actions) {
            try {
              const env = buildScriptEnv(event, payload, {
                workspaceRootPath: this.options.workspaceRootPath,
                page: action.page,
              });
              const result = await runApprovedScript({
                action,
                workspaceRootPath: this.options.workspaceRootPath,
                env,
                trigger: 'automation',
                // UA8.2 — a synthetic page-refresh matcher (`pages/refresh.ts`) runs under the page's REFRESH
                // approval (`refresh-approval` / `page:<slug>`), the one PageView records, never a script approval.
                // UA12.96 — the door is keyed on the ID alone, so a USER automations.json matcher with id
                // `page:<slug>` and `page` set takes it too: the same ledger entry gates the run, and
                // `runApprovedScript`'s binding check means only the approved bytes, path, args and runtime can
                // run (anything else is refused) — plus the page's own refresh lock applies. Stated and pinned in
                // `handlers/script-handler.test.ts` (UA12.96); refused-as-reserved was declined: the approval
                // already binds the script and not the schedule.
                ...(isPageRefreshMatcherId(matcherId) && action.page !== undefined
                  ? { trigger: 'page-refresh' as const, approval: { kind: REFRESH_APPROVAL_KIND, subject: pageRefreshApprovalSubject(action.page) } }
                  : {}),
                workspaceId: this.options.workspaceId,
                matcherId,
                ...(this.options.audit ? { audit: this.options.audit } : {}),
                ...(this.options.keyProvider ? { keyProvider: this.options.keyProvider } : {}),
              });

              if (!result.success) {
                log.debug(`[ScriptHandler] ${action.script} → ${result.stderr.slice(0, 200)}`);
              }
              results.push(result);
              await this.appendHistory(matcherId, result);
            } catch (error) {
              // runApprovedScript folds failures into its result; this is a
              // true unexpected error (e.g. history I/O) — report, keep going.
              const err = error instanceof Error ? error : new Error(String(error));
              log.error(`[ScriptHandler] Error executing ${action.script}:`, err);
              this.options.onError?.(event, err);
            }
          }
        })();

        this.inFlight.set(matcherId, run);
        try {
          await run;
        } finally {
          this.inFlight.delete(matcherId);
        }
      })
    );

    if (results.length > 0 && this.options.onScriptResults) {
      log.debug(`[ScriptHandler] Delivering ${results.length} script results`);
      this.options.onScriptResults(results);
    }
  }

  /**
   * Append a history entry. Await for durability, but keep failures non-fatal.
   */
  private async appendHistory(matcherId: string, result: ScriptActionResult): Promise<void> {
    try {
      await appendAutomationHistoryEntry(
        this.options.workspaceRootPath,
        createScriptHistoryEntry({ matcherId, result }),
      );
    } catch (e) {
      log.debug(`[ScriptHandler] Failed to write history: ${e}`);
    }
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    if (this.bus && this.boundHandler) {
      this.bus.offAny(this.boundHandler);
      this.boundHandler = null;
    }
    this.bus = null;
    this.inFlight.clear();
    log.debug(`[ScriptHandler] Disposed`);
  }
}
