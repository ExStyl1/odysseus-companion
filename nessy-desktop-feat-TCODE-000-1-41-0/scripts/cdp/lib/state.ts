/**
 * State reads.
 *
 * Every assertion in this harness that CAN read the app's own state does. The
 * renderer already exposes everything the cases need through `window.electronAPI`:
 *
 *   - `getSessions()` returns the protocol `Session` DTO — `id`, `workspaceId`,
 *     `isProcessing`, `lastMessageAt`, `permissionMode` and the whole
 *     `messages: Message[]` transcript, each with `role` (`user` | `assistant` |
 *     `tool` | `info` | `error` | …) and `content`.
 *   - `getPiHarnessRuntime({workspaceId, sessionId})` returns the snapshot whose
 *     `childState.children` is the exact array `useAgentPanel` maps into rows.
 *
 * Reading those beats scraping the DOM, and both beat reading pixels. A pixel
 * assertion is the last resort and is marked as such wherever one is used.
 */

import { reassertWindowFocus, type CdpSession } from './connect.ts'
import { readComposer } from './composer.ts'
import { currentCaseId, resolveCasePermissionMode } from './permission-mode.ts'
import { blocked } from './report.ts'
import { clickSelector } from './viewport.ts'

export interface SessionKey {
  workspaceId: string
  sessionId: string
}

/**
 * One transcript message, with the TOOL fields carried.
 *
 * `content` is not where a tool's answer lives. `Message` (core/types/message.ts)
 * keeps a tool call's output in `toolResult`, keyed by `toolUseId` — and a
 * settled `/subtask` fork is written into the parent transcript as exactly that:
 * a `subagent` tool pair with `toolUseId = "subtask-<agentId>"` and
 * `toolDisplayName = "Fork"` (`SessionManager.recordForkResultInTranscript`).
 *
 * The 2026-07-30 run read the fork's answer with `lastAssistantText` and got the
 * parent's own third-turn reply, because a fork adds no assistant message at all.
 * Dropping these fields is what made that misread possible.
 */
export interface TranscriptMessage {
  id: string
  role: string
  content: string
  toolName?: string
  toolUseId?: string
  /**
   * The tool's arguments. Load-bearing for any isolation control: when the
   * PARENT composes a delegate's prompt, it can put the very secret the control
   * is testing into it, and then the delegate answering proves nothing.
   */
  toolInput?: Record<string, unknown>
  toolResult?: string
  toolStatus?: string
  toolDisplayName?: string
  timestamp: number
}

export interface SessionSummary {
  id: string
  workspaceId: string
  name?: string
  isProcessing?: boolean
  lastMessageAt?: number
  permissionMode?: string
  /** The session's cwd — the root a project-scope MEMORY.md would sit in. */
  workingDirectory?: string
  messageCount: number
}

export interface PiChild {
  agentId: string
  agent: string
  status: string
  background: boolean
  ownerTaskId?: string
  error?: string
  /**
   * The reasoning effort this child is RUNNING at, and the model it runs on.
   *
   * Both are on the wire (`protocol/pi-harness-runtime.ts`, the child record's
   * `exact()` key list ends `…, 'error', 'effort', 'model'`) and both are
   * populated (`SessionManager.ts` — `...(child.restrictions?.thinkingLevel ?
   * { effort: child.restrictions.thinkingLevel } : {})`). This projection used
   * to drop them, which is the whole reason AGT-5's terminal `blocked()` said
   * the effort "is not exposed to the renderer" — it was exposed and this
   * helper threw it away.
   *
   * APPLIED, NOT CONFIGURED (`core/types/pi-harness-runtime.ts`, verbatim: "A
   * row whose purpose is telling the user what RAN must not report a level that
   * did not run, so the clamped value is what ships"). So a child whose
   * definition asks for a level its MODEL cannot run reports the clamped level,
   * not the declared one — an assertion of strict equality against the
   * frontmatter is wrong, an assertion of ordering against the parent is not.
   *
   * Both are optional on the wire so a host predating them keeps parsing;
   * `undefined` here therefore means "this host does not send it", never
   * "the child has no effort".
   */
  effort?: string
  model?: string
}

export interface PendingPermission {
  requestId: string
  type?: string
}

export interface PiRuntime {
  available: boolean
  unavailableReason?: string
  /**
   * D1.265 — the READ itself threw, and that is not the same fact as
   * `available: false`.
   *
   * {@link piRuntime} catches the RPC and returns a total value, so an
   * unreadable snapshot and a session that spawned nothing were both
   * `{ children: [] }` at every call site. The fourth measure sitting met the
   * consequence: `AGT-5` reported *"no new child registered for cdp-deep"* over a
   * turn whose own transcript carried the child's answer, because
   * `getPiHarnessRuntime` throws `pi-harness-runtime-invalid` on that packaged
   * build after the session's first turn. The field that would have said so —
   * `available` — was already returned and no case observed it.
   *
   * `available: false` is NOT this: it is the ordinary answer before a session's
   * first turn (`unavailableReason: 'pi-runtime-not-started'`), and the baseline
   * reads every spawn case takes rely on it. Only a THROW sets this.
   */
  readFailed?: boolean
  provider?: string
  children: PiChild[]
  childRevision?: number
  /**
   * `security.pendingPermissions` — what the BACKEND still considers unanswered.
   *
   * The only read that separates "the card on screen was already answered and
   * the renderer did not remove it" from "this is a second, genuinely pending
   * request that happens to look identical". Both leave a card up; only one is a
   * defect, and the card's text cannot tell them apart.
   */
  pendingPermissions: PendingPermission[]
  raw: Record<string, unknown>
}

/** Assert the preload surface is present before anything else runs. */
export async function assertElectronApi(session: CdpSession): Promise<string[]> {
  const missing = await session.call<string[]>(`
    const api = window.electronAPI
    if (!api) return ['window.electronAPI']
    return ['getSessions', 'getPiHarnessRuntime', 'sendMessage'].filter(k => typeof api[k] !== 'function')
  `)
  if (missing.length > 0) {
    throw new Error(`electron-api-incomplete: missing ${missing.join(', ')} — the preload did not finish, or the page is not the app window`)
  }
  return missing
}

export async function listSessions(session: CdpSession): Promise<SessionSummary[]> {
  return session.call<SessionSummary[]>(`
    const all = await window.electronAPI.getSessions()
    return (all ?? []).map(s => ({
      id: s.id,
      workspaceId: s.workspaceId,
      name: s.name,
      isProcessing: s.isProcessing,
      lastMessageAt: s.lastMessageAt,
      permissionMode: s.permissionMode,
      workingDirectory: s.workingDirectory,
      messageCount: Array.isArray(s.messages) ? s.messages.length : 0,
    }))
  `)
}

/**
 * The session the UI currently has open.
 *
 * Read from the selected session row (`SessionItem` sets `data-session-id`,
 * `EntityRow` sets `data-selected` when selected), then joined against
 * `getSessions()` for the workspace id. Falls back to the most recently used
 * session only when no row is marked, and says which path it took so a case can
 * refuse an ambiguous answer.
 */
export async function activeSession(session: CdpSession): Promise<SessionKey & { via: 'dom' | 'most-recent' }> {
  const domId = await session.call<string | null>(`
    const rows = document.querySelectorAll('.session-item[data-selected]')
    if (rows.length > 1) throw new Error('ambiguous-active-session: ' + rows.length + ' session rows are marked selected (multi-panel layout?)')
    return rows[0] ? rows[0].getAttribute('data-session-id') : null
  `)
  const sessions = await listSessions(session)
  if (sessions.length === 0) throw new Error('no-sessions: the app has no sessions; open or create one before running a case')
  if (domId) {
    const match = sessions.find(s => s.id === domId)
    if (!match) throw new Error(`active-session-unknown: the selected row is ${domId} but getSessions() does not list it`)
    return { workspaceId: match.workspaceId, sessionId: match.id, via: 'dom' }
  }
  const newest = [...sessions].sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))[0]!
  return { workspaceId: newest.workspaceId, sessionId: newest.id, via: 'most-recent' }
}

/**
 * A session the case created for itself.
 *
 * `fresh: false` means the harness fell back to whatever was already open, and
 * `inheritedMessages` says how much history the case is therefore measuring on
 * top of. Cases assert on `fresh`, so a contaminated run cannot pass quietly —
 * the first AGT-1 run attached to a real 86-message conversation and every read
 * in it was a read of the operator's own history.
 */
export interface FreshSession extends SessionKey {
  fresh: boolean
  /** Why the harness could not create one. Absent when `fresh`. */
  reason?: string
  inheritedMessages: number
  /**
   * The session was created and opened but its NAME did not take, after a
   * read-back and one retry — see the rename block in {@link freshSession}.
   * Absent in the ordinary case. A case that finds its own sessions by name
   * across a relaunch must refuse on this rather than measure an empty profile.
   */
  nameDropped?: string
  /**
   * UB12.2 — the views whose persisted label filters {@link freshSession}
   * dropped (and reloaded for) before creating the session. Absent when there
   * was nothing persisted. A case measuring the FILTER UI itself must read
   * this: its fixture filter will not have survived the creation.
   */
  clearedLabelFilters?: string
  /**
   * What {@link applyCasePermissionMode} actually achieved on this session —
   * the mode read BACK, never the mode asked for.
   *
   * Required, and deliberately: the one case that creates a session by hand
   * (`q6-live.ts`) is made to say what mode it has rather than silently keeping
   * the app's, which is the divergence D1.385 exists to close. The checklist's
   * `Note` gets its mode from this field, so a run's recorded mode has a source
   * rather than an assumption.
   */
  permissionMode: string
}

const NEW_SESSION_ROUTE = 'action/new-session'
/** `renderer/lib/navigate.ts` — the event NavigationContext listens for. */
const NAVIGATE_EVENT = 'nessy-agent-navigate'

/** One persisted per-view filter entry (`renderer/lib/local-storage.ts` KEYS.viewFilters). */
type ViewFiltersEntry = {
  statuses?: Record<string, string>
  labels?: Record<string, string>
} & Record<string, unknown>

/**
 * UB12.2 — drop every view's persisted LABEL filters from a `viewFiltersMap`
 * snapshot, naming the views touched. Pure on purpose: the harness suite pins
 * the transform, and {@link freshSession} applies it to the live
 * `nessy-view-filters` localStorage entry and reloads.
 *
 * The `statuses` and `projects` entries are deliberately untouched: the
 * measured mechanism (b33203609) is the board click's live LABEL include
 * (UA5.10's `withTaskScopeFilters`), whose carriers a cleanup can delete — a
 * statuses include hiding a created row is a different posture question
 * (UB12.3's), not this fix's.
 */
export function clearLabelFiltersInViewFilters(
  map: Record<string, ViewFiltersEntry>,
): { map: Record<string, ViewFiltersEntry>; touched: string[] } | undefined {
  const touched: string[] = []
  const next: Record<string, ViewFiltersEntry> = { ...map }
  for (const key of Object.keys(next)) {
    const entry = next[key]
    if (entry && typeof entry === 'object' && entry.labels && Object.keys(entry.labels).length > 0) {
      next[key] = { ...entry, labels: {} }
      touched.push(key)
    }
  }
  return touched.length > 0 ? { map: next, touched } : undefined
}

/**
 * UB12.2 — make the session-creation path immune to a persisted label filter.
 *
 * A board click's task-scope jump persists an All-Sessions label include naming
 * a LIVE task label; when the labelled sessions are deleted the include stays
 * and the sidebar correctly renders the empty filtered set — and a session
 * created NOW carries no labels, so its row is hidden: the selection read
 * answers none/ambiguous and {@link freshSession} falls back to a contaminated
 * session (the 7 dead case starts of the RC4 sitting, reproduced offline at
 * `b33203609`).
 *
 * The write alone is not enough: AppShell reads the map ONCE in its
 * `useState` initializer, so the live renderer never sees a localStorage
 * change — the same reason `ensureDarkTheme` (mcp-fixture.ts) writes the
 * preference and THEN reloads. Returns the names of the views whose label
 * filters were dropped, or undefined when there was nothing to clear (the
 * ordinary case: no reload, no cost).
 */
async function clearPersistedLabelFilters(session: CdpSession): Promise<string | undefined> {
  const raw = await session.call<string | null>(`return localStorage.getItem('nessy-view-filters')`)
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const cleared = clearLabelFiltersInViewFilters(parsed as Record<string, ViewFiltersEntry>)
  if (!cleared) return undefined
  const serialized = JSON.stringify(cleared.map)
  await session.call<null>(`
    localStorage.setItem('nessy-view-filters', ${JSON.stringify(serialized)})
    return null
  `)
  await session.send('Page.reload', {})
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await Bun.sleep(500)
    const missing = await session.call<string[]>(`
      const api = window.electronAPI
      if (!api) return ['window.electronAPI']
      return ['getSessions', 'getPiHarnessRuntime', 'sendMessage'].filter(k => typeof api[k] !== 'function')
    `).catch(() => ['remount-pending'])
    if (missing.length === 0) return cleared.touched.join(',')
  }
  throw new Error('label-filter-clear-reload-timeout: the app did not remount after the nessy-view-filters write')
}

/**
 * Re-apply a session's name and verify it, for a case that has just SWITCHED the
 * session's runtime.
 *
 * **`sessionCommand({type:'switchRuntime'})` clears the name**, measured twice on
 * the packaged 1.37.0 build (RV, 2026-09-12, HEAD `10c12eb65`): immediately after
 * {@link freshSession} returns the name reads back correctly, and after one
 * `switchRuntime` to a `claude-runtime` card the same read is `undefined` — in
 * memory AND on disk, since the rename issued at creation never reaches disk on
 * its own. `freshSession` cannot know a switch is coming, so the re-apply belongs
 * with the caller that switches.
 *
 * It matters to any case that finds its own sessions BY NAME after a relaunch
 * (`rs-38`'s four arms), and it matters to the auto-delete protection the name
 * exists for. The PRODUCT half — a rename applied and then dropped by a runtime
 * switch, with nothing on the wire to say so — is RV's proposed row.
 *
 * Returns `undefined` when the name is in place, or a sentence naming what the
 * app reports instead, so a case can refuse rather than measure nothing.
 *
 * One caveat, measured in the same probe: the app DE-DUPLICATES a name it has
 * seen before by appending a slug (`… after the turn-tidy-quokka`), so a caller
 * whose names can collide must compare with `startsWith` rather than equality.
 * Every caller today stamps a time into the name.
 */
export async function ensureSessionName(
  session: CdpSession,
  key: SessionKey,
  name: string,
  attempts = 3,
): Promise<string | undefined> {
  let reported: string | undefined
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    reported = (await listSessions(session)).find(s => s.id === key.sessionId)?.name
    if (reported === name) return undefined
    await sessionCommand(session, key.sessionId, { type: 'rename', name }).catch(() => undefined)
    await Bun.sleep(1_500)
  }
  reported = (await listSessions(session)).find(s => s.id === key.sessionId)?.name
  return reported === name
    ? undefined
    : `rename-not-applied: ${key.sessionId} reports ${JSON.stringify(reported ?? null)} after ${attempts} `
      + `attempt(s), not ${JSON.stringify(name)}`
}

/**
 * Create a session through the app's OWN path and open it.
 *
 * `NavigationContext.handleActionNavigation` case `new-session` is what the
 * sidebar's New Chat runs: it calls `onCreateSession(workspaceId)` and then
 * routes the focused panel at the result. Driving that event rather than
 * `electronAPI.createSession` keeps the renderer's selection in step, which is
 * what every DOM read in this harness (composer, palette, panel) depends on.
 *
 * Throws in one situation only. A case that cannot get a clean session still
 * runs, against the open one, and reports `fresh: false` so the contamination is
 * in the result — unless that open session is not in the mode this case runs in,
 * which BLOCKS the case instead of changing the mode (F1.775,
 * {@link foreignFallbackMode}).
 */
export async function freshSession(session: CdpSession, name?: string): Promise<FreshSession> {
  // UB12.2 — FIRST, before anything reads the list or the rows: a persisted
  // label include hides the session this helper is about to create (the
  // none/ambiguous mechanism of b33203609). Ordinary case: no-op, no reload.
  const clearedLabelFilters = await clearPersistedLabelFilters(session)
  const before = await listSessions(session)
  const known = new Set(before.map(s => s.id))
  let created: SessionSummary | undefined
  let reason: string | undefined
  let nameDropped: string | undefined
  try {
    await session.call<null>(`
      window.dispatchEvent(new CustomEvent(${JSON.stringify(NAVIGATE_EVENT)}, {
        detail: { route: ${JSON.stringify(NEW_SESSION_ROUTE)} },
        bubbles: true,
      }))
      return null
    `)
    created = await waitFor(
      async () => (await listSessions(session)).find(s => !known.has(s.id)),
      value => value !== undefined,
      { timeoutMs: 20_000, intervalMs: 500, label: 'a newly created session to appear in getSessions()' },
    )
  } catch (cause) {
    reason = `session-create-failed: ${cause instanceof Error ? cause.message : String(cause)}`
  }

  if (created) {
    // The renderer selects it asynchronously; the composer belongs to whichever
    // session the panel shows, so a case must not type until the row is current.
    const selected = await waitFor(
      () => session.call<string | null>(`
        const rows = document.querySelectorAll('.session-item[data-selected]')
        return rows.length === 1 ? rows[0].getAttribute('data-session-id') : null
      `),
      value => value === created!.id,
      { timeoutMs: 20_000, intervalMs: 500, label: `the new session ${created.id} to become the selected row` },
    ).catch(() => null)
    if (selected === created.id) {
      // **Name it FIRST, before anything can navigate away from it.**
      // `NavigationContext` auto-deletes a session the moment it leaves the
      // visible set while `!lastFinalMessageId && !name && !isProcessing` and it
      // has no draft — which is every session this helper has just created. The
      // resync click below is a click, and a click can land on the wrong row;
      // when it did, the app quietly deleted the session out from under the
      // case, and the next read failed with `session-not-found` two steps later
      // with nothing pointing at the cause. A name makes it ineligible.
      // **AND THE NAME DOES NOT SURVIVE THIS WINDOW, so it is re-applied after
      // the resync click and verified there.** Measured on the packaged 1.37.0
      // build (RV, 2026-09-12, HEAD `10c12eb65`), four probes:
      //
      //  1. of the twelve sessions RS-13's two runs created, SIX carry their
      //     `CDP RS-13 …` name in the persisted meta and SIX have no `name` key;
      //  2. this rename READS BACK as applied and is `undefined` again a moment
      //     later, after the resync click below — so it is applied and then lost,
      //     not refused (nothing errors: `sessionCommand` resolves with nothing);
      //  3. a rename issued AFTER this helper returns takes and REACHES DISK,
      //     even on a session with zero messages (`msgs: 0`, name on disk);
      //  4. a rename after the session's first turn takes in memory and on disk.
      //
      // So the early rename still happens — it is what makes this session
      // ineligible for `NavigationContext`'s auto-delete while the click that
      // follows can land on the wrong row — and the name is then re-applied and
      // VERIFIED after the pane is ready, which is the position probe 3 shows
      // sticks. A name that still will not take is returned as `nameDropped`
      // rather than hidden, so a case that finds its own sessions by name across
      // a relaunch can refuse instead of measuring an empty profile.
      //
      // The PRODUCT half — a rename accepted, applied and then dropped with
      // nothing on the wire to say so — is RV's proposed row, not this helper's.
      if (name) await sessionCommand(session, created.id, { type: 'rename', name }).catch(() => undefined)

      // **The selected row is not the pane.** The checklist records this as a
      // standing gotcha: after New Session the route and the sidebar row update
      // while the content pane keeps showing the PREVIOUS session, and the
      // documented remedy is to click the row to resync. It is not cosmetic —
      // the composer belongs to whichever session the pane shows, so a case that
      // types here sends its prompt into the wrong conversation. AGT-3 did
      // exactly that and then timed out waiting 180s for its own empty session
      // to gain a message.
      await clickSelector(session, `.session-item[data-session-id="${created.id}"]`).catch(() => undefined)
      // A session created seconds ago has no draft, so a composer still holding
      // text is the stale pane still on screen — a functional check on the very
      // surface the case is about to drive, rather than a guess at a delay.
      const paneReady = await waitFor(
        () => readComposer(session),
        text => text.trim().length === 0,
        { timeoutMs: 10_000, intervalMs: 500, label: `the pane to switch to the empty composer of ${created.id}` },
      ).then(() => true).catch(() => false)
      if (paneReady) {
        // The name, re-applied where it sticks (probe 3 above) and VERIFIED.
        if (name) {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const current = (await listSessions(session)).find(s => s.id === created!.id)?.name
            if (current === name) { nameDropped = undefined; break }
            nameDropped = `rename-not-applied: ${created.id} reports ${JSON.stringify(current ?? null)} `
              + `after ${attempt + 1} attempt(s), not ${JSON.stringify(name)}`
            await sessionCommand(session, created.id, { type: 'rename', name }).catch(() => undefined)
            await Bun.sleep(1_500)
          }
        }
        // F1.120 / D1.395 — the window, re-asserted. The focus emulation does
        // not survive a navigation, and SIT-7 measured that it has to be put
        // back after `freshSession()` and after every reload; `rs-100.ts`,
        // `rs-103.ts` and `rs-104.ts` each carried that call by hand. It honours
        // an attachment that opted out and never throws (`lib/connect.ts`).
        await reassertWindowFocus(session)
        // D1.385 — the mode, before the case sends anything. `claude-agent.ts`
        // reads `config.session?.permissionMode` at spawn, so a mode set on the
        // session record before its first message is the mode the child starts
        // in, which is the row's "before the model's first turn".
        return {
          workspaceId: created.workspaceId,
          sessionId: created.id,
          fresh: true,
          inheritedMessages: 0,
          permissionMode: await applyCasePermissionMode(session, created.id),
          ...(clearedLabelFilters ? { clearedLabelFilters } : {}),
          ...(nameDropped ? { nameDropped } : {}),
        }
      }
      reason = `session-created-but-pane-is-stale: the sidebar row is ${created.id} but the composer still holds `
        + `${JSON.stringify((await readComposer(session)).slice(0, 60))} — the pane is showing another session`
    } else {
      reason = `session-created-but-not-opened: ${created.id} exists but the selected row is ${selected ?? 'none/ambiguous'}`
    }
  }

  const fallback = await activeSession(session)
  const fallbackSummary = (await listSessions(session)).find(s => s.id === fallback.sessionId)
  const inherited = fallbackSummary?.messageCount ?? -1
  // The window is re-asserted on the FALLBACK path too: this path has already
  // dispatched the navigation event, and a case measuring a contaminated session
  // still measures it on a window the OS is showing.
  await reassertWindowFocus(session)
  const fellBack = `${reason ?? 'unknown'} — fell back to the open session (${fallback.via})`
  return {
    workspaceId: fallback.workspaceId,
    sessionId: fallback.sessionId,
    fresh: false,
    reason: fellBack,
    inheritedMessages: inherited,
    // UB12.2 — the clear ran before the create attempt; a case that fell back
    // anyway reads WHY here alongside the reason.
    ...(clearedLabelFilters ? { clearedLabelFilters } : {}),
    // The mode is applied on the fallback path too, but ONLY to the session this
    // call created (the stale-pane path lands on it). Every case asserts `fresh`,
    // so the readings are already discredited — but the drive still happens, and
    // an unattended drive that cannot answer a card hangs. A session the case did
    // NOT create is never written: see {@link foreignFallbackMode} (F1.775).
    permissionMode: fallback.sessionId === created?.id
      ? await applyCasePermissionMode(session, fallback.sessionId)
      : foreignFallbackMode(fallback.sessionId, fallbackSummary?.permissionMode, created?.permissionMode, fellBack),
  }
}

/**
 * F1.775 (SIT-k, 2026-09-25) — the mode of a fallback session this case did NOT
 * create: read, never written, and refused when it is not the case's own.
 *
 * Under load {@link freshSession} created its session, could not see it become
 * the selected row, fell back to the OPEN session — the operator's, or the
 * previous arm's — and wrote `bypassPermissions` onto it, changing a session
 * nobody asked it to touch. And since every session the harness makes is in
 * bypass, an opt-out ([DEFAULT]) arm that fell back the same way ran silently in
 * bypass with nothing but `fresh: false` to say so. The sitting recorded the
 * arms that hit this fallback INVALID by hand.
 *
 * So the harness leaves another session's mode alone and compares it with the
 * mode this case runs in: the harness default, or — for an opt-out — the mode
 * the app gave the session this call created (`created.permissionMode`, read
 * before anything wrote to it). A match returns the same string
 * {@link applyCasePermissionMode} would have, and the case goes on exactly as it
 * did before (contaminated, `fresh: false`). A mismatch — or an opt-out whose
 * create failed, so there is no creation mode to compare with — is a precondition
 * the harness cannot satisfy, so the case is BLOCKED rather than measured in a
 * mode it did not ask for. This is the one way `freshSession` throws.
 */
function foreignFallbackMode(
  sessionId: string,
  reported: string | undefined,
  creationMode: string | undefined,
  fellBack: string,
  caseId: string | undefined = currentCaseId(),
): string {
  const wanted = resolveCasePermissionMode(caseId)
  const expected = wanted ?? creationMode
  if (reported !== undefined && reported === expected) {
    return wanted === undefined ? `opt-out: kept ${reported}` : reported
  }
  const want = wanted !== undefined
    ? JSON.stringify(wanted)
    : creationMode !== undefined
      ? `the mode the app created this case's session in (${JSON.stringify(creationMode)})`
      : 'the mode the app creates a session in, which no created session was there to read'
  blocked(
    `fallback-session-mode: ${fellBack}; ${sessionId} is a session this case did not create and it reports `
    + `${JSON.stringify(reported ?? null)}, not ${want}. The harness does not change another session's mode, `
    + 'so this arm cannot run in the mode it needs (F1.775)',
  )
}

/** What `createSession` answered, and what mode the new session ended up in. */
export interface DirectSessionResult {
  /** Absent when the RPC refused — then {@link DirectSessionResult.error} says why. */
  sessionId?: string
  workspaceId?: string
  /** First line of the refusal (its `code` when it has one). Absent on success. */
  error?: string
  /**
   * The mode the session is in, READ BACK off `getSessions()`.
   *
   * `case-default` answers exactly what {@link applyCasePermissionMode} returns;
   * `from-options` answers `from-options: <mode>`, so a report can never confuse
   * a mode the harness applied with one the caller asked the app for.
   */
  permissionMode?: string
}

/**
 * Mint a session through `electronAPI.createSession` — the ONE place that call
 * is spelled, F1.173 (origin WJ-e's P-WJ-e-3).
 *
 * {@link freshSession} is how a case gets a session, and it drives the
 * renderer's own New Chat path. Two cases cannot use it and must not:
 * `q6-live.ts` needs a session CREATED on a given connection (a remote card
 * cannot be switched INTO an existing session — `switchSessionRuntime` refuses
 * a `nestor-cloud-agent` target with `CONNECTION_NOT_SWITCHABLE`), and
 * `rs-36.ts` needs the product's own BRANCH, which is `createSession` with
 * `branchFromMessageId` and the parent's settings (`ChatDisplay.tsx`'s
 * `onBranch`). Both were spelling the RPC themselves, so every harness-wide
 * default — F1.86's `bypassPermissions` among them — needed two extra edits and
 * the compiler could only ask the question while `FreshSession` had a required
 * field.
 *
 * **The mode is a REQUIRED argument, not a default.** `case-default` applies
 * what this case runs in, the same write `freshSession` makes. `from-options`
 * applies NOTHING because the caller put a `permissionMode` in `options` on
 * purpose: `rs-36`'s branch inherits the parent's mode because that is the
 * product's own branch behaviour AND the case's subject — a harness default
 * written over it would destroy the card the arm exists to see. Making the
 * caller say which is the point; a default here would have picked wrong for one
 * of exactly two callers.
 *
 * It never navigates. The renderer does not follow `createSession` (measured on
 * `rs-36`'s first four runs, where every prompt meant for the branch went into
 * the parent), so opening the session is the caller's step.
 */
export async function createSessionDirectly(
  session: CdpSession,
  workspaceId: string,
  options: Record<string, unknown>,
  mode: 'case-default' | 'from-options',
): Promise<DirectSessionResult> {
  const created = await session.call<{ id?: string; workspaceId?: string; error?: string }>(`
    try {
      const s = await window.electronAPI.createSession(
        ${JSON.stringify(workspaceId)},
        ${JSON.stringify(options)},
      )
      return { id: s && s.id, workspaceId: (s && s.workspaceId) || ${JSON.stringify(workspaceId)} }
    } catch (e) {
      return { error: String((e && (e.code || e.message)) || e) }
    }
  `)
  if (!created.id) {
    return {
      ...(created.workspaceId ? { workspaceId: created.workspaceId } : {}),
      error: created.error ?? 'createSession returned no id',
    }
  }
  const settled = created.id
  const readMode = async (): Promise<string> =>
    (await listSessions(session)).find(s => s.id === settled)?.permissionMode ?? 'unknown'
  return {
    sessionId: settled,
    workspaceId: created.workspaceId ?? workspaceId,
    permissionMode: mode === 'case-default'
      ? await applyCasePermissionMode(session, settled)
      : `from-options: ${await readMode().catch(() => 'unknown')}`,
  }
}

/** Full transcript for one session. `getSessionMessages` loads it without the DOM. */
export async function transcript(session: CdpSession, key: SessionKey): Promise<TranscriptMessage[]> {
  return session.call<TranscriptMessage[]>(`
    const s = await window.electronAPI.getSessionMessages(${JSON.stringify(key.sessionId)})
    if (!s) throw new Error('session-not-found: ' + ${JSON.stringify(key.sessionId)})
    return (s.messages ?? []).map(m => ({
      id: m.id, role: m.role, content: typeof m.content === 'string' ? m.content : '',
      toolName: m.toolName, toolUseId: m.toolUseId,
      toolInput: m.toolInput && typeof m.toolInput === 'object' ? m.toolInput : undefined,
      toolResult: typeof m.toolResult === 'string' ? m.toolResult : undefined,
      toolStatus: m.toolStatus, toolDisplayName: m.toolDisplayName,
      timestamp: m.timestamp,
    }))
  `)
}

/**
 * Session-scoped control commands. `sessionCommand` is the renderer's own
 * channel (`dto.ts` SessionCommand union), so setting the permission mode or the
 * thinking level is a state write rather than a menu click that may or may not
 * have landed.
 */
export async function sessionCommand(session: CdpSession, sessionId: string, command: Record<string, unknown>): Promise<void> {
  await session.call<null>(`
    await window.electronAPI.sessionCommand(${JSON.stringify(sessionId)}, ${JSON.stringify(command)})
    return null
  `)
}

/**
 * The same channel, keeping what the command RETURNED.
 *
 * Several commands answer with a result a case has no other way to see —
 * `rewindToMessage` returns `ConversationRewindResult`, whose
 * `restoredCheckpoints` is the app's own account of which file checkpoints it
 * reverted. Reading it separates "the rewind reverted nothing" from "the rewind
 * reverted something and the file assertion below is measuring the wrong file",
 * which a `void` call cannot.
 */
export async function sessionCommandResult<T>(
  session: CdpSession,
  sessionId: string,
  command: Record<string, unknown>,
): Promise<T> {
  return session.call<T>(`
    return await window.electronAPI.sessionCommand(${JSON.stringify(sessionId)}, ${JSON.stringify(command)})
  `)
}

/**
 * The six effort levels, weakest first (`agent/thinking-levels.ts`).
 *
 * Exported as an ORDER rather than a set because every assertion worth making
 * about effort is comparative: a subagent that "thinks harder than its parent"
 * is a `>` on this list. An equality against a frontmatter value would be the
 * wrong assertion — the level a child reports has already been clamped to its
 * own model.
 */
export const EFFORT_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** Position on {@link EFFORT_LEVELS}, or `-1` for anything not on it. */
export function effortRank(level: string | undefined): number {
  return level === undefined ? -1 : (EFFORT_LEVELS as readonly string[]).indexOf(level)
}

export async function setPermissionMode(session: CdpSession, sessionId: string, mode: string): Promise<void> {
  await sessionCommand(session, sessionId, { type: 'setPermissionMode', mode })
}

/**
 * D1.385 — put a session into the mode THIS case runs in, and report what took.
 *
 * The owner's rule is that every automated drive runs in `bypassPermissions`,
 * because an unattended run cannot answer a card and a card nobody answers is a
 * hang. `lib/permission-mode.ts` holds the default, the per-case opt-outs and
 * the reasoning; this is the one place that writes it.
 *
 * **It reads the mode BACK rather than trusting the write.** `sessionCommand`
 * resolves with nothing whether the command took or not — the same property that
 * made the rename above need a read-back and a retry — so the returned string is
 * what `getSessions()` reports, and a write that did not take is returned as a
 * sentence naming what the app says instead. Never a boolean: a case's Note in
 * the checklist has to say which mode the run used, and "false" does not.
 *
 * An OPT-OUT applies nothing at all and returns the mode the app created the
 * session in, prefixed so the two are never confused in a report.
 */
export async function applyCasePermissionMode(
  session: CdpSession,
  sessionId: string,
  caseId: string | undefined = currentCaseId(),
): Promise<string> {
  const read = async (): Promise<string | undefined> =>
    (await listSessions(session)).find(s => s.id === sessionId)?.permissionMode
  const wanted = resolveCasePermissionMode(caseId)
  if (wanted === undefined) {
    const kept = await read().catch(() => undefined)
    return `opt-out: kept ${kept ?? 'unknown'}`
  }
  await sessionCommand(session, sessionId, { type: 'setPermissionMode', mode: wanted }).catch(() => undefined)
  const took = await waitFor(
    read,
    value => value === wanted,
    { timeoutMs: 20_000, intervalMs: 1_000, label: `${wanted} to take on ${sessionId}` },
  ).catch(() => undefined)
  return took === wanted
    ? wanted
    : `not-applied: ${sessionId} reports ${JSON.stringify(took ?? null)}, not ${JSON.stringify(wanted)}`
}

export async function setThinkingLevel(session: CdpSession, sessionId: string, level: string): Promise<void> {
  await sessionCommand(session, sessionId, { type: 'setThinkingLevel', level })
}

export async function isProcessing(session: CdpSession, key: SessionKey): Promise<boolean> {
  const sessions = await listSessions(session)
  return sessions.find(s => s.id === key.sessionId)?.isProcessing === true
}

/** The Pi harness runtime snapshot — the same read `useAgentPanel` performs. */
export async function piRuntime(session: CdpSession, key: SessionKey): Promise<PiRuntime> {
  return session.call<PiRuntime>(`
    const api = window.electronAPI
    let result
    try {
      result = await api.getPiHarnessRuntime({ workspaceId: ${JSON.stringify(key.workspaceId)}, sessionId: ${JSON.stringify(key.sessionId)} })
    } catch (e) {
      return { available: false, readFailed: true, unavailableReason: 'read-threw: ' + String(e && e.message || e), children: [], pendingPermissions: [], raw: {} }
    }
    const snap = result.snapshot ?? {}
    const cs = snap.childState
    const pending = snap.security && Array.isArray(snap.security.pendingPermissions) ? snap.security.pendingPermissions : []
    return {
      available: snap.available === true,
      unavailableReason: snap.unavailableReason,
      provider: snap.provider,
      childRevision: cs ? cs.revision : undefined,
      pendingPermissions: pending.map(p => ({ requestId: p.requestId, type: p.type })),
      children: cs && Array.isArray(cs.children) ? cs.children.map(c => ({
        agentId: c.agentId, agent: c.agent, status: c.status, background: c.background,
        ownerTaskId: c.ownerTaskId, error: c.error, effort: c.effort, model: c.model,
      })) : [],
      raw: snap,
    }
  `)
}

/**
 * D1.287 — the two empty lists a failed read produces, and what each one is NOT.
 *
 * `piRuntime()`'s catch returns `children: []` AND `pendingPermissions: []`, so
 * the same swallowed read tells two different lies depending on which list the
 * caller reads. The block sentence has to name the caller's own claim, or it
 * teaches the next reader the misreading it exists to prevent: *"no child
 * registered"* and *"no card was raised"* are different findings and would send
 * a reader to different code.
 */
const UNREADABLE_CLAUSE = {
  children:
    'Its empty child list is the read failing, not the session spawning nothing',
  'pending-permissions':
    'Its empty pending-permission list is the read failing, not the backend reporting '
    + 'that no card is unanswered',
} as const

export type UnreadableClaim = keyof typeof UNREADABLE_CLAUSE

/**
 * D1.265 — the snapshot, or a BLOCK naming the read that failed.
 *
 * A case that requires a CHILD cannot tell {@link piRuntime}'s swallowed
 * `{ children: [] }` from a session that spawned nothing, and the two deserve
 * opposite verdicts: a spawn that did not happen is a FAIL of the claim, an
 * unreadable snapshot is a precondition the harness could not satisfy. This
 * turns the second into `BLOCKED`, which `runCase` already scores separately —
 * and, per its own rule, only while no check has failed, so a real failure
 * measured earlier in the same case still wins.
 *
 * Deliberately NOT gated on `available`: a baseline read before the first turn
 * answers `available: false` with `pi-runtime-not-started` and an empty list,
 * legitimately, and every spawn case takes one.
 *
 * D1.287 — `claim` picks which of the two empty lists the sentence is about; it
 * defaults to `children` because that is what every D1.265 call site reads.
 */
export function requireReadablePiRuntime(
  runtime: PiRuntime,
  what: string,
  claim: UnreadableClaim = 'children',
): PiRuntime {
  if (runtime.readFailed === true) {
    blocked(
      `${what}: the pi-harness runtime snapshot could not be READ `
      + `(${runtime.unavailableReason ?? 'no reason reported'}). ${UNREADABLE_CLAUSE[claim]} `
      + '— see `rs-56.ts` for the packaged-build defect.',
    )
  }
  return runtime
}

/**
 * D1.310 — the read's own verdict, for a site that OBSERVES rather than claims.
 *
 * {@link requireReadablePiRuntime} is for a site whose CHECK depends on the
 * snapshot; blocking is right there. Five sites do not check on it at all —
 * `agt-4`'s named-child list, `q6-live`'s three settlement reads, `pkg-1`'s
 * post-turn note, `mcp-auth`'s pool health and `agt-3`'s `moved` wait — and
 * D1.265 deliberately refused to convert them, because a block raised for an
 * observation discards the run.
 *
 * What they were missing is smaller than a block and is the whole risk: an
 * empty list in a narrative reads as an ANSWER. On the packaged 1.39.0 every one
 * of them would have recorded `[]` for a session that had children
 * (`pi-harness-runtime-invalid`, D1.264), and nothing in the observation said
 * the read had thrown.
 *
 * `available: false` is deliberately NOT collapsed into `readFailed`: it is the
 * ordinary answer before a session's first turn AND between turns (`pkg-1`'s own
 * comment records a case where a check on it reported *"Pi never ran"* about a Pi
 * that had just answered), so the note carries both and lets the reader tell
 * them apart.
 */
export function piReadNote(runtime: PiRuntime): {
  readFailed: boolean
  available: boolean
  unavailableReason?: string
} {
  return {
    readFailed: runtime.readFailed === true,
    available: runtime.available,
    ...(runtime.unavailableReason === undefined ? {} : { unavailableReason: runtime.unavailableReason }),
  }
}

/**
 * The child list, with the unreadable-snapshot case separated out.
 *
 * `what` names the assertion the children are for, so the BLOCK sentence says
 * which claim went unmeasured rather than only that a read failed.
 */
export async function piChildren(
  session: CdpSession,
  key: SessionKey,
  what: string,
): Promise<PiChild[]> {
  return requireReadablePiRuntime(await piRuntime(session, key), what).children
}

/**
 * D1.287 — the BACKEND's unanswered-request list, with the unreadable snapshot
 * separated out.
 *
 * `pendingPermissions` is the read three cases use to decide whether a card was
 * RAISED (`rts-10`, `rts-5`) or whether an already-answered card is still on
 * screen (`agt-3`), because the DOM cannot tell those apart. A swallowed read
 * reports zero pending requests, which reads as "the product did not ask" — and
 * on `rts-10` that is the WORST direction available: its subject check is
 * `afterSwitch.pending > 0`, so an unreadable snapshot manufactures the product
 * finding *"an always-allow given on Pi is being honoured on a runtime the user
 * never authorised"* out of an instrument failure.
 *
 * `what` names the claim the list is for, so the BLOCK says which question went
 * unmeasured. Not used where the value only LABELS an already-failing check —
 * see `agt-3.ts`, which fails with an honest sentence instead, because a block
 * raised before the check would discard the observation that a card remained
 * (`runCase`'s own rule is that a failed check beats a block).
 */
export async function piPendingPermissions(
  session: CdpSession,
  key: SessionKey,
  what: string,
): Promise<PendingPermission[]> {
  return requireReadablePiRuntime(
    await piRuntime(session, key),
    what,
    'pending-permissions',
  ).pendingPermissions
}

export interface ElementDescription {
  index: number
  text: string
  width: number
  height: number
  /** Zero-sized, `display:none`, or `visibility:hidden` — present but not shown. */
  hidden: boolean
}

/**
 * Every match with its size and text, so a case can tell "the surface is gone"
 * from "a zero-sized copy of it is still in the tree".
 *
 * `selectorCount` alone cannot: a hidden duplicate keeps the count above zero
 * forever, and a case waiting for the count to reach 0 after answering a prompt
 * reports that the prompt never cleared while the user is looking at a screen
 * with no prompt on it.
 */
export async function describeElements(session: CdpSession, selector: string): Promise<ElementDescription[]> {
  return session.call<ElementDescription[]>(`
    return Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map((el, index) => {
      const rect = el.getBoundingClientRect()
      const style = window.getComputedStyle(el)
      const rendered = (el.innerText ?? '').replace(/\\s+/g, ' ').trim()
      const text = rendered || (el.textContent ?? '').replace(/\\s+/g, ' ').trim()
      return {
        index,
        text,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        hidden: rect.width === 0 || rect.height === 0 || style.display === 'none' || style.visibility === 'hidden',
      }
    })
  `)
}

/** Matches that are actually on screen. */
export async function visibleElements(session: CdpSession, selector: string): Promise<ElementDescription[]> {
  return (await describeElements(session, selector)).filter(el => !el.hidden)
}

export interface ChildTranscriptRead {
  ok: boolean
  output: string
  nextCursor?: number
  error?: string
}

/**
 * A child's OWN transcript, through the app's own control action.
 *
 * `useAgentPanel.openTranscript` issues exactly this request; the panel's pane is
 * a render of its `output`. Reading it here is how a case answers "did the fork
 * inherit the parent conversation" from the CHILD's side rather than by scraping
 * the parent's DOM, which is what made the first answer unusable.
 *
 * `cursor` is a byte offset into the child's output: a second call with the
 * returned `nextCursor` returns only what arrived since.
 */
export async function readChildTranscript(
  session: CdpSession,
  key: SessionKey,
  agentId: string,
  cursor = 0,
): Promise<ChildTranscriptRead> {
  return session.call<ChildTranscriptRead>(`
    const api = window.electronAPI
    try {
      const result = await api.controlPiHarnessRuntime({
        schemaVersion: 1,
        session: { workspaceId: ${JSON.stringify(key.workspaceId)}, sessionId: ${JSON.stringify(key.sessionId)} },
        action: 'read_child',
        agentId: ${JSON.stringify(agentId)},
        cursor: ${JSON.stringify(cursor)},
      })
      return {
        ok: result.ok === true,
        output: typeof result.output === 'string' ? result.output : '',
        nextCursor: result.nextCursor,
        error: result.error,
      }
    } catch (e) {
      return { ok: false, output: '', error: 'control-threw: ' + String(e && e.message || e) }
    }
  `)
}

export interface WaitOptions {
  timeoutMs?: number
  intervalMs?: number
  label?: string
}

/** Poll until `predicate` accepts the probe's value, or throw with the last one. */
export async function waitFor<T>(probe: () => Promise<T>, predicate: (value: T) => boolean, options: WaitOptions = {}): Promise<T> {
  const timeout = options.timeoutMs ?? 60_000
  const interval = options.intervalMs ?? 1_000
  const label = options.label ?? 'condition'
  const deadline = Date.now() + timeout
  let last: T | undefined
  for (;;) {
    last = await probe()
    if (predicate(last)) return last
    if (Date.now() >= deadline) {
      throw new Error(`wait-timeout: ${label} still false after ${timeout}ms; last value ${JSON.stringify(last)?.slice(0, 600)}`)
    }
    await Bun.sleep(interval)
  }
}

/**
 * What a session looked like BEFORE a send — the baseline a turn is measured
 * against (F1.491).
 *
 * `count` is the transcript's length. `lastMessageAt` is the host's own stamp:
 * `SessionManager.sendMessage` writes it on the line before the one that raises
 * `isProcessing`, and `SessionManager.heapdump` (`/heapdump`, which bypasses
 * `sendMessage` and never raises `isProcessing`) writes it beside the one row it
 * appends — so a value past the baseline says the send took effect even when no
 * poll caught `isProcessing` true. Read the baseline BEFORE the send, never
 * after: one read after the rising edge is already past it and proves nothing.
 */
export interface TurnBaseline {
  count: number
  lastMessageAt?: number
}

/** The baseline {@link waitForTurn} measures a send against — read it immediately before the send. */
export async function turnBaseline(session: CdpSession, key: SessionKey): Promise<TurnBaseline> {
  const count = (await transcript(session, key)).length
  const lastMessageAt = (await listSessions(session)).find(s => s.id === key.sessionId)?.lastMessageAt
  return typeof lastMessageAt === 'number' ? { count, lastMessageAt } : { count }
}

export interface TurnWaitOptions {
  /**
   * How long the turn may take to show ANY sign of having started before the
   * wait gives up with {@link TurnNotStartedError}, counted from the call and
   * bounded by the turn's own timeout. The host raises `isProcessing` after its
   * disk flushes and before the runtime is asked anything, so this is a window
   * for the host, never for the model — 60 s by default.
   */
  startWindowMs?: number
  /** Poll interval, 1.5 s by default. */
  intervalMs?: number
}

/**
 * The turn never showed a sign of having started (F1.491). Its own class and
 * its own `turn-not-started:` prefix, because it is a different fact from a
 * `wait-timeout:` — a turn that started and ran long — and a case that catches
 * a wait's error to read the transcript anyway must be able to tell them apart.
 */
export class TurnNotStartedError extends Error {
  override name = 'TurnNotStartedError'
}

const TURN_START_WINDOW_MS = 60_000

/**
 * Wait until a turn has STARTED and then ended, and return the transcript.
 *
 * F1.491. The predicate this replaced — the transcript grew and nothing is
 * processing — accepted the user's OWN row as a finished turn:
 * `SessionManager.sendMessage` appends that row and flushes it BEFORE it raises
 * `isProcessing`, and a poll landing between the two returned at once. F1.260
 * was that: QL9 read a codex turn as done 10 ms after its user row and then
 * uninstalled the plugin under the turn that was only starting.
 *
 * So a turn counts as finished only once it has shown it started, by any one of:
 *   - `isProcessing` read true at some poll of this wait;
 *   - a row that is not the user's, past `sinceCount` — a turn quick enough to
 *     start and end between two polls still leaves its reply;
 *   - `lastMessageAt` past the baseline's, when the caller read one before the
 *     send ({@link turnBaseline}) — the one trace a command answered with no
 *     turn leaves (`/heapdump` appends one user row, the summary, and never
 *     raises `isProcessing`; no reply follows);
 * and then the transcript has grown past `sinceCount` and a poll reads `isProcessing`
 * false. A turn that shows none of the three within `startWindowMs` throws
 * {@link TurnNotStartedError}; one that started and outlives `timeoutMs` throws
 * the `wait-timeout:` it always did, its last value still led by `count` and
 * `processing`.
 *
 * What it still cannot tell apart (stated, not solved): a session ALREADY busy
 * at the send — a queued message, a steer — shows `isProcessing` and fresh reply
 * rows from the turn that was running, so the wait can end with that turn and
 * before the queued one begins; and a row or a `lastMessageAt` stamp some other
 * producer writes between the baseline and the send (a late task notification)
 * reads as this turn's start.
 *
 * And `/clear` is not a turn this can wait on at all: the host EMPTIES the live
 * transcript when it completes, so the count never grows past the baseline.
 * Send it with `noWait` and wait for the emptying (`clearConversation` in
 * `claude-child.ts`; NCA-5).
 */
export async function waitForTurn(
  session: CdpSession,
  key: SessionKey,
  sinceCount: number | TurnBaseline,
  timeoutMs = 180_000,
  options: TurnWaitOptions = {},
): Promise<TranscriptMessage[]> {
  const baseline: TurnBaseline = typeof sinceCount === 'number' ? { count: sinceCount } : sinceCount
  const startWindowMs = Math.min(options.startWindowMs ?? TURN_START_WINDOW_MS, timeoutMs)
  const startDeadline = Date.now() + startWindowMs
  let sawProcessing = false
  await waitFor(
    async () => {
      const messages = await transcript(session, key)
      const summary = (await listSessions(session)).find(s => s.id === key.sessionId)
      const processing = summary?.isProcessing === true
      sawProcessing ||= processing
      const addedRoles = messages.slice(baseline.count).map(m => m.role)
      const lastMessageAt = summary?.lastMessageAt
      const stampMoved = baseline.lastMessageAt !== undefined && typeof lastMessageAt === 'number'
        && lastMessageAt > baseline.lastMessageAt
      const started = sawProcessing || addedRoles.some(role => role !== 'user') || stampMoved
      return { count: messages.length, processing, started, addedRoles, lastMessageAt }
    },
    v => {
      if (v.started) return v.count > baseline.count && !v.processing
      if (Date.now() < startDeadline) return false
      throw new TurnNotStartedError(
        `turn-not-started: no sign within ${startWindowMs}ms that the turn began (had ${baseline.count} messages; `
        + `rows added since the send: [${v.addedRoles.join(', ')}]; isProcessing never read true; `
        + (baseline.lastMessageAt === undefined
          ? 'no lastMessageAt baseline was read before the send'
          : `lastMessageAt ${String(v.lastMessageAt)} against the baseline ${baseline.lastMessageAt}`)
        + ') — a turn that never started is not a finished turn',
      )
    },
    { timeoutMs, intervalMs: options.intervalMs ?? 1_500, label: `a turn to complete (had ${baseline.count} messages)` },
  )
  return transcript(session, key)
}

/** Text of every message with a given role, newest last. */
export function textOfRole(messages: TranscriptMessage[], role: string): string[] {
  return messages.filter(m => m.role === role).map(m => m.content)
}

/** Presence of a DOM selector — a structural read, not a pixel read. */
export async function selectorCount(session: CdpSession, selector: string): Promise<number> {
  return session.call<number>(`return document.querySelectorAll(${JSON.stringify(selector)}).length`)
}

/**
 * Visible text of every match.
 *
 * `innerText` is LAYOUT-dependent: an element inside a container that has not
 * sized yet returns `''`, not `undefined` — so `el.innerText ?? el.textContent`
 * never falls back, because `'' ?? x` is `''`. That combination reported "the
 * permission card does not name the requesting agent" about a card that named it
 * perfectly well, and no amount of waiting fixed it because the empty string was
 * a real answer to the wrong question.
 *
 * `textContent` is layout-independent and is the fallback whenever `innerText`
 * comes back blank. It is preferred second, not first, because it also returns
 * text from genuinely hidden nodes — which is why the emptiness is tested rather
 * than the property's existence.
 */
export async function selectorText(session: CdpSession, selector: string): Promise<string[]> {
  return session.call<string[]>(`
    return Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(el => {
      const rendered = (el.innerText ?? '').replace(/\\s+/g, ' ').trim()
      if (rendered) return rendered
      return (el.textContent ?? '').replace(/\\s+/g, ' ').trim()
    })
  `)
}
