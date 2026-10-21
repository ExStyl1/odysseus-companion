/**
 * D1.97 + D1.98 — ONE flat, typed list of everything a session has queued:
 * the cron records it will run later, and the background work (watches
 * included) it is running now.
 *
 * ## Why one list and not two
 *
 * The owner's decision of 2026-09-17 on both rows is *"the minimal RPC + a flat
 * list … a flat list in the existing background-task panel with no new design"*,
 * and the 2026-08-22 design gate is lifted for the flat list only. Two rows,
 * one channel, one shape — a panel that had to join a cron list to a task list
 * would be the new design the gate still holds.
 *
 * ## Native-first: what codex's own vocabulary gave us, and what it could not
 *
 * codex ships `ScheduledTaskSummary { key, name, prompt, schedule }` with
 * `ScheduledTaskSchedule` a tagged union (`hourly` / `daily` / `weekdays` /
 * `weekly`) in `packages/codex-protocol/generated/v2/`, and it was read before
 * this shape was written rather than after. What transferred, and what did not:
 *
 *  - `key` → {@link SessionScheduledWorkEntryV1.id}. The same fact under the
 *    spelling every existing caller in this repo already uses.
 *  - `prompt` → {@link SessionScheduledWorkEntryV1.description}. Already capped
 *    upstream of here by `capHookRegistryText`, so this module never re-caps.
 *  - `name` → **NOT carried.** No host structure holds one; the background-task
 *    projection says so about its own `name` field for the same reason. A
 *    synthesized name would be a second spelling of the description.
 *  - `schedule` → **the store's own STRING, verbatim, not codex's union.** Our
 *    cron store persists an expression; parsing it into four cases we have no
 *    contract for would invent the mapping, and adopting the union would mean
 *    re-deriving the store. `recurring` is carried separately because our store
 *    holds it explicitly where codex's union encodes it implicitly.
 *
 * ## The WATCH question (D1.98), answered by reading rather than by adding
 *
 * The row's build line asks for watches to *"join the background-task chips as
 * type `watch`"*. There is no `watch` type at HEAD and there must not be one:
 * `SessionMonitorService.buildEntry` files every watch — `command` and `ws`
 * alike — under `type: 'monitor'`, which is the spelling `hooks.md`'s own
 * `background_tasks[]` contract uses and which `BackgroundTaskType` already
 * declares. Minting `watch` beside it would be two names for one fact, which is
 * the divergence class this plan keeps closing. So the watches are in this list
 * already, under the documented name, and a surface that wants only them
 * filters on it.
 *
 * ## Pure on purpose
 *
 * Nothing here reads a session. `SessionManager` supplies the two arrays it
 * already builds for the `background_tasks` / `session_crons` hook payload, so
 * a hook that listed the work, a user who typed `/tasks` and a panel that draws
 * the chips are looking at ONE inventory and cannot word it three ways.
 */

import type { BackgroundTaskEntryV1, SessionCronEntryV1 } from '../automations/index.ts';

/**
 * `'scheduled'` is the cron rows' own state and is deliberately not one of the
 * background statuses: a record that will fire later is neither running nor
 * finished, and forcing it into `running` would make the panel claim work that
 * has not started.
 */
export type SessionScheduledWorkStatus = 'scheduled' | 'running' | 'completed' | 'failed' | 'stopped';

/** One row of the flat list. */
export interface SessionScheduledWorkEntryV1 {
  readonly id: string;
  /**
   * `'scheduled'` for a cron record; otherwise the background registry's own
   * type VERBATIM — `'monitor'` is a watch (D1.98), and an unrecognised runtime
   * discriminant survives as itself exactly as `friendlyBackgroundTaskType`
   * leaves it.
   */
  readonly type: string;
  readonly status: SessionScheduledWorkStatus;
  /** Already capped by the producing projection. */
  readonly description: string;
  /** Scheduled rows only — the cron store's expression, verbatim. */
  readonly schedule?: string;
  /** Scheduled rows only. */
  readonly recurring?: boolean;
  /** Monitor and MCP-task rows only. */
  readonly server?: string;
  /** Monitor and MCP-task rows only. */
  readonly tool?: string;
  /** Subagent rows only. */
  readonly agentType?: string;
  /** Shell rows only. */
  readonly command?: string;
}

/**
 * The answer to one read.
 *
 * {@link unavailable} exists because an EMPTY list and a list this host cannot
 * produce are different facts, and a panel that drew them the same way would
 * tell a user "nothing is running" about a session it never asked. `'not-supported'`
 * is the honest answer from a host whose session manager does not implement the
 * accessor at all.
 */
export interface SessionScheduledWorkPageV1 {
  readonly schemaVersion: 1;
  readonly entries: readonly SessionScheduledWorkEntryV1[];
  readonly unavailable?: 'session-not-found' | 'not-supported';
  /**
   * F1.508 (origin WJ-ak P-WJak-1) — the SCHEDULED plugin monitors the session's latest turn armed, for the
   * background-task panel only. OPTIONAL and absent when there are none, so every page that carried no monitor is
   * byte-identical to before. Deliberately NOT an entry in {@link entries} and NOT part of
   * {@link SessionScheduledWorkSources}: those two arrays are also the hooks' `background_tasks` / `session_crons`
   * payload, a documented contract this row must not change. A scheduled monitor reaches the agent only while a turn
   * is running — an idle tick is skipped, not queued (F1.502) — which is what the panel says beside it.
   */
  readonly pluginMonitors?: readonly SessionScheduledPluginMonitorV1[];
}

/** F1.508 — one armed scheduled plugin monitor, as the panel names it. */
export interface SessionScheduledPluginMonitorV1 {
  readonly monitorId: string;
  /** The monitor's cron expression, verbatim. */
  readonly cron: string;
  readonly timezone?: string;
}

/** The two arrays `SessionManager` already builds for the hook payload. */
export interface SessionScheduledWorkSources {
  readonly crons: readonly SessionCronEntryV1[];
  readonly tasks: readonly BackgroundTaskEntryV1[];
}

/**
 * Flatten the two inventories into one list.
 *
 * Running work FIRST and scheduled records after it, because the panel this
 * feeds is the background-task panel: what is happening now is what the user
 * opened it for, and what will happen later is context. Within each half the
 * producer's own order is preserved — `projectBackgroundTasks` already merges
 * its four producers in a stated order and deduplicates by id, and re-sorting
 * here would be a second opinion about a decision that has one.
 */
export function projectSessionScheduledWork(
  sources: SessionScheduledWorkSources,
): readonly SessionScheduledWorkEntryV1[] {
  const entries: SessionScheduledWorkEntryV1[] = [];
  for (const task of sources.tasks) {
    entries.push(Object.freeze({
      id: task.id,
      type: String(task.type),
      status: task.status,
      description: task.description,
      ...(task.server ? { server: task.server } : {}),
      ...(task.tool ? { tool: task.tool } : {}),
      // The registry's field is snake_case because it is hook WIRE shape
      // (`:2205`); this list is our own protocol, so it is renamed once, here,
      // rather than leaking the hook contract's spelling into the renderer.
      ...(task.agent_type ? { agentType: task.agent_type } : {}),
      ...(task.command ? { command: task.command } : {}),
    }));
  }
  for (const cron of sources.crons) {
    entries.push(Object.freeze({
      id: cron.id,
      type: 'scheduled',
      status: 'scheduled' as const,
      description: cron.prompt,
      schedule: cron.schedule,
      recurring: cron.recurring,
    }));
  }
  return Object.freeze(entries);
}

/**
 * The sentence a session with nothing queued answers.
 *
 * A constant rather than prose inside the formatter for
 * `SESSION_COMMAND_HELP_UNTOLD_LINE`'s reason: its presence and its absence are
 * both asserted, and a report that stopped printing it would be silence where
 * an answer is owed — the failure `stopAllBackgroundWork`'s own
 * `nothing-to-stop` refusal exists to avoid.
 */
export const SESSION_SCHEDULED_WORK_EMPTY_LINE =
  'This session is holding no background work and has nothing scheduled.';

/** Printed instead of a listing when the host cannot produce one. */
export const SESSION_SCHEDULED_WORK_UNAVAILABLE_LINE =
  'This session\'s background work could not be read here.';

/**
 * Render one page as the text `/tasks` puts in the transcript.
 *
 * Plain English literals, no `t()`, for the measured reason every other
 * seam-adjacent answer in this product uses them: the headless `nessy-server`
 * entry never calls `setupI18n()` and an uninitialised `t()` returns
 * `undefined`, which is an empty line and indistinguishable from a command that
 * did nothing.
 */
export function formatSessionScheduledWorkReport(page: SessionScheduledWorkPageV1): string {
  if (page.unavailable) return SESSION_SCHEDULED_WORK_UNAVAILABLE_LINE;
  if (page.entries.length === 0) return SESSION_SCHEDULED_WORK_EMPTY_LINE;

  const running = page.entries.filter(entry => entry.status !== 'scheduled');
  const scheduled = page.entries.filter(entry => entry.status === 'scheduled');
  const lines: string[] = [];

  if (running.length > 0) {
    lines.push('Background work in this session right now:');
    for (const entry of running) {
      lines.push(`  ${entry.type} ${entry.id} — ${entry.status} — ${entry.description}`);
    }
  }
  if (scheduled.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Scheduled to run later:');
    for (const entry of scheduled) {
      // `recurring` is spelled out rather than left to the schedule string: our
      // store holds it as its own field precisely because the expression does
      // not always say so, and a one-shot read as recurring is the wrong way
      // round for a user deciding whether to cancel it.
      lines.push(`  ${entry.id} — ${entry.schedule ?? 'unknown schedule'}${entry.recurring ? ' (repeats)' : ' (once)'} — ${entry.description}`);
    }
  }
  return lines.join('\n');
}
