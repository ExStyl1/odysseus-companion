/**
 * D1.97 + D1.98 — the renderer half of the scheduled-work read: the rule that
 * turns one `sessions:listScheduledWork` answer into the chips the existing
 * background-task row draws.
 *
 * ## Why a pure module and not three expressions inside the component
 *
 * This renderer has no DOM harness for hooks, so a rule that is not a function
 * is a rule only a source read can check — the same argument
 * `background-task-rows.ts` and the rewind menu's decisions already make. The
 * component below it renders; every decision about WHAT is on screen is here.
 *
 * ## The owner's decision, and what it does and does not license
 *
 * *"BUILD the minimal RPC + a flat list … a flat list in the existing
 * background-task panel with no new design"* (2026-09-17, D1.97 and D1.98 in one
 * decision; the 2026-08-22 design gate is lifted for the flat list ONLY). So
 * these are the same 30px badges the running rows already are, in the same
 * container, and there is no panel, no section header and no empty state.
 *
 * ## The three answers this must not merge, and the one it deliberately does
 *
 * The page carries three distinguishable facts and the panel owes three
 * behaviours, not two:
 *
 *  - an EMPTY page — the session has nothing queued — renders NOTHING, which is
 *    what the row did before this change and why there is no `empty` locale key
 *    (a key with no reader reddens `lint:i18n:reachable`, and a permanent "there
 *    is nothing" badge in the densest surface the app has would be new design).
 *  - `unavailable` — `'not-supported'` (this host's session manager does not
 *    implement the accessor) and `'session-not-found'` (nothing owns that id) —
 *    renders ONE sentence. **The two variants are merged on purpose**: which of
 *    them it is, is an operator fact about the host, not a fact about the user's
 *    session, and the variant survives on the page for the hook to log.
 *  - a page that is not a page at all — see {@link asSessionScheduledWorkPage}.
 *
 * ## Why the running half is deduplicated rather than drawn twice
 *
 * The RPC answers with the session's WHOLE inventory, and the renderer already
 * draws part of it: `backgroundTasksAtomFamily` carries the `agent` and `shell`
 * rows the event feed mints, with their live elapsed clock and their Stop item.
 * An entry whose id is already such a row is therefore dropped here — two chips
 * for one piece of work would be two names for one fact, which is the same
 * answer D1.98 gave to its own `'watch'` type.
 *
 * What is left after that subtraction is exactly what the event feed cannot
 * produce: the cron records (D1.97) and the running work that has no renderer
 * event — `monitor` rows above all, which is D1.98's watches, under the name
 * `hooks.md`'s `background_tasks[]` contract and `BackgroundTaskType` already
 * use.
 */

import type {
  SessionScheduledPluginMonitorV1,
  SessionScheduledWorkEntryV1,
  SessionScheduledWorkPageV1,
} from '@nessy-agent/shared/protocol'

/** The i18n key of the cadence word a scheduled chip ends with. */
export type ScheduledWorkCadenceKey =
  | 'chat.backgroundTasks.scheduledRepeats'
  | 'chat.backgroundTasks.scheduledOnce'
  /** F1.508 — a scheduled plugin monitor: it reaches the agent only during a turn, an idle tick is skipped. */
  | 'chat.backgroundTasks.scheduledMonitorSkipsIdle'

/** One badge the bar draws from the RPC answer. */
export interface ScheduledWorkChip {
  readonly id: string
  /**
   * True for a cron record, which is labelled `chat.backgroundTasks.scheduled`.
   *
   * A record that will fire later is neither running nor finished — the page's
   * own `'scheduled'` status says so — and the badge must not borrow the running
   * rows' spinner for it.
   */
  readonly scheduled: boolean
  /**
   * The entry's own type, VERBATIM, for a running row (`monitor`, `MCP task`,
   * `subagent`, …).
   *
   * Not translated, and that is a decision rather than an omission: the host has
   * already mapped the raw discriminant onto `hooks.md`'s published vocabulary
   * through `friendlyBackgroundTaskType`, the same words the user meets in
   * `/tasks` and in a hook payload. A locale key per type would mint a second
   * spelling for each of them and would still fall back to the raw string for
   * the unrecognised ones that function deliberately passes through.
   */
  readonly type: string
  /** Scheduled rows only. */
  readonly cadenceKey?: ScheduledWorkCadenceKey
  /** Already capped upstream by `capHookRegistryText`; used as the badge title. */
  readonly description: string
  /** Scheduled rows only — the cron store's expression, verbatim. */
  readonly schedule?: string
}

/** What the bar needs to draw, decided once. */
export interface ScheduledWorkView {
  readonly chips: readonly ScheduledWorkChip[]
  /** Present exactly when the host could not answer. */
  readonly noticeKey?: 'chat.backgroundTasks.unavailable'
  /**
   * D1.268 — present exactly when the host DID answer and there is nothing to
   * draw: a real page, no `unavailable`, and no entry left after the ids already
   * on screen are subtracted.
   *
   * It is a FACT about the session, not a decision to show a badge. The bar
   * decides that, and it decides it by doing nothing extra — see the render for
   * the posture and for what was deliberately not built.
   */
  readonly emptyKey?: 'chat.backgroundTasks.empty'
}

const EMPTY_VIEW: ScheduledWorkView = Object.freeze({ chips: Object.freeze([]) })

/**
 * Recognise a real page, and refuse anything else.
 *
 * **Still not defensive decoration — but NOT for the reason this docblock gave
 * until D1.267, which measured the whole seam.** The preload half is real: the
 * transport resolves a failed call with `{ __nessyRpcError__: true, message }`
 * instead of rejecting it. The renderer entry then UNDOES it — `install-rpc-api`
 * is `main.tsx`'s first import, it publishes `window.electronAPI` wrapped by
 * `wrapElectronApi`, and that wrapper rehydrates the envelope into a thrown
 * `Error` for every invoke the channel map declares, this route included. So in
 * the Electron app a failed call DOES reject and the `catch` beside the read
 * does see it.
 *
 * What the refusal is for, measured rather than assumed: the surfaces that build
 * the same API WITHOUT that entry and never rehydrate — the playground's mock
 * and `apps/webui`'s adapter, which calls `buildClientApi` directly — plus any
 * answer whose shape is simply not this page.
 *
 * An unrecognised answer is `undefined` — silence — and NOT the `unavailable`
 * sentence: the sentence is the host's own answer about the session, and a
 * failed call is not that answer.
 */
export function asSessionScheduledWorkPage(value: unknown): SessionScheduledWorkPageV1 | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { schemaVersion?: unknown; entries?: unknown; unavailable?: unknown; pluginMonitors?: unknown }
  if (record.schemaVersion !== 1) return undefined
  if (!Array.isArray(record.entries)) return undefined
  if (record.pluginMonitors !== undefined && !Array.isArray(record.pluginMonitors)) return undefined // F1.508
  if (
    record.unavailable !== undefined
    && record.unavailable !== 'session-not-found'
    && record.unavailable !== 'not-supported'
  ) return undefined
  return value as SessionScheduledWorkPageV1
}

function chipFor(entry: SessionScheduledWorkEntryV1): ScheduledWorkChip {
  const scheduled = entry.status === 'scheduled'
  return Object.freeze({
    id: entry.id,
    scheduled,
    type: entry.type,
    description: entry.description,
    ...(scheduled
      ? {
        cadenceKey: (entry.recurring
          ? 'chat.backgroundTasks.scheduledRepeats'
          : 'chat.backgroundTasks.scheduledOnce') as ScheduledWorkCadenceKey,
      }
      : {}),
    ...(entry.schedule ? { schedule: entry.schedule } : {}),
  })
}

/**
 * F1.508 — a scheduled plugin monitor as a chip: the same scheduled badge a cron record is, with its schedule (and
 * time zone) as the title and the one fact the user cannot see elsewhere as its cadence word — it reaches the agent
 * only while a turn is running, and a tick at any other time is skipped, not queued (F1.502). The id is the monitor's
 * own, because the badge shows the id's head — the same short name `/tasks` prints.
 */
function monitorChipFor(monitor: SessionScheduledPluginMonitorV1): ScheduledWorkChip {
  return Object.freeze({
    id: monitor.monitorId,
    scheduled: true,
    type: 'monitor',
    description: monitor.monitorId,
    cadenceKey: 'chat.backgroundTasks.scheduledMonitorSkipsIdle' as ScheduledWorkCadenceKey,
    schedule: monitor.timezone ? `${monitor.cron} (${monitor.timezone})` : monitor.cron,
  })
}

/**
 * Decide what the bar draws beside the live rows.
 *
 * `page` is `undefined` before the first read answers, and after a read that did
 * not produce a page (see {@link asSessionScheduledWorkPage}) — both render
 * nothing, because neither is the host saying anything about this session.
 *
 * `liveRowIds` are the ids already on screen from the event feed; see the
 * header for why an entry carrying one of them is dropped rather than drawn.
 */
export function projectScheduledWorkView(
  page: SessionScheduledWorkPageV1 | undefined,
  liveRowIds: readonly string[] = [],
): ScheduledWorkView {
  if (!page) return EMPTY_VIEW
  if (page.unavailable) {
    return Object.freeze({ chips: Object.freeze([]), noticeKey: 'chat.backgroundTasks.unavailable' as const })
  }
  const live = new Set(liveRowIds)
  const chips = [
    ...page.entries.filter(entry => !live.has(entry.id)).map(chipFor),
    ...(page.pluginMonitors ?? []).map(monitorChipFor), // F1.508 — after the registry's rows, as `/tasks` lists them
  ]
  if (chips.length === 0) {
    // D1.268 — the host answered and there is nothing queued. Kept apart from
    // `noticeKey` and from the `undefined` page for the same reason those two
    // are kept apart: "nothing is scheduled", "it could not be read" and "no
    // answer yet" are three different statements, and merging any pair of them
    // is how a surface starts claiming something it does not know.
    return Object.freeze({ chips: Object.freeze([]), emptyKey: 'chat.backgroundTasks.empty' as const })
  }
  return Object.freeze({ chips: Object.freeze(chips) })
}
