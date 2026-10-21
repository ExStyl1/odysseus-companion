/**
 * RS-116 (plan row UA5.11, 1.42.0 upstream adoption) - Projects on the shipped
 * build: a project bound to a folder raises the trust card for that folder, the
 * session list groups by project, a project's own board columns persist, a
 * renamed folder keeps the project's identity and trust, and a replaced folder
 * (or a `config.json` edited to another folder) is refused. With the UA5.3,
 * UA5.5 and UA5.6 sitting ASKs folded in (`work/wi16/sitting-asks.md`): the
 * delete cascade, and the project context and asset manifest reaching a turn on
 * Pi, Claude Code and Codex.
 *
 * ## What it proves, one arm each
 *
 * Arms are chosen by `NESSY_CDP_RS116_ARMS` (default `T,G,C,R,X,D,K`). G, C, R,
 * X and D build on T's project, so T always runs when any of them is chosen.
 *
 * T.  **A project from a folder shows the trust card.** A case-minted folder
 *     that declares one skill (a folder that declares nothing raises no card -
 *     `lib/runtime-switch.ts`, SIT-6a) is bound to project P1 through an issued
 *     handle (`validateProjectDirectory` + `setProjectFolder`, the calls the
 *     page's folder picker makes; the picker's own native dialog cannot be
 *     driven). The host reads it `trusted: false`. P1's page button "New session
 *     in P1" opens a session whose working directory IS the folder, and the trust
 *     dialog comes up naming THAT folder, titled with the folder wording UA5.7
 *     gave it (`projectTrust.title`). Trust is answered from the dialog; the host
 *     then reads the project's folder `trusted: true`.
 * T'. **The control on the same instrument.** A second "New session in P1"
 *     raises NO dialog (the folder is decided) and lands in the same folder.
 * G.  **Grouping.** With the All Sessions list grouped by Project (written to the
 *     per-viewer view-filters map, restored after), P1's session sits under P1's
 *     header and a fresh unbound session U under "No project". P2 CARRIES a
 *     folder of its own (`folder-p2`, bound through an issued handle exactly as
 *     P1's folder was) so the no-move check can fail — binding to a FOLDERLESS
 *     project cannot adopt what is not there. `setProjectId` binds U to P2: U
 *     moves under P2 live (no reload) while its working directory does not move
 *     — binding never ADOPTS the project's folder (UA5.3 ASK 3, one window; the
 *     guard scored by {@link bindingKeepsFolderVerdict}). Unbinding returns U
 *     to "No project".
 * C.  **Columns persist.** The board, focused on P1 through its project filter,
 *     offers the column editor's "Add column" (never while unfocused: the
 *     control); one press writes P1's `kanbanColumns` (the three built-ins seeded
 *     plus the new one, read on the host); P1's session dragged into the new
 *     column gets `kanbanColumn` = that id. After a renderer reload the host
 *     still reads the set and the placement, and the board focused on P1 again
 *     renders the four columns with the tile under the new one. Unfocused
 *     ("All Projects") the board shows the three built-ins only.
 * R.  **A renamed folder keeps the binding.** R0: renaming the PROJECT keeps its
 *     slug, its folder and its sessions. R1: the FOLDER renamed on disk leaves the
 *     project bound to it, reporting `project-folder-unavailable` - never silently
 *     dropped or retargeted - and its sessions keep `projectId`. R2: the renamed
 *     folder, picked again, is the SAME identity: its handle is already
 *     `trusted` (trust follows the inode, `project-identity.ts`), binding it
 *     clears the problem, and a new session opens in it with no trust card.
 * X.  **A replaced folder is refused.** X2 (UA5.3 ASK 2): P1's `config.json`
 *     edited on disk to point at another TRUSTED folder reads
 *     `project-folder-identity-changed` and `createSession({projectId})` is
 *     refused with that code; the original bytes put back read clean again (the
 *     control). X1: the folder deleted and recreated at the same path (a new
 *     inode, the same skill) reads `project-folder-identity-changed`, and the
 *     page's "New session in P1" is refused with a toast naming the code and no
 *     new session bound to P1.
 * D.  **Delete** (UA5.3 ASK 4). Deleting P1 unbinds every one of its sessions,
 *     leaves its folder on disk, and leaves P2 in place.
 * K.  **Context and assets reach a turn** (UA5.5 ASK 1-2, UA5.6), per runtime
 *     (`NESSY_CDP_RS116_RUNTIMES`, default `pi,claude,codex`): a folderless
 *     project PK whose details name a codename and whose asset `rs116-ref.txt`
 *     starts with a marker line; a fresh session bound to PK by `setProjectId` is
 *     asked for both and must answer both markers; the details are edited and the
 *     SAME session asked again must answer the new codename on the next message.
 *
 * ## The detectors
 *
 * - Folder state, bindings, columns and placements: the HOST's own answers
 *   (`getProject`, `getSessions`), polled. The trust card: the dialog's own
 *   folder field (`TRUST_DIALOG_PATH_SELECTOR`) and its heading, answered only
 *   through `answerTrustGate` (which trusts only a folder the harness made).
 * - Grouping: the group a session row is rendered in - the header that opens the
 *   row's group block in `entity-list.tsx` (a `div` per group inside the list's
 *   `pt-1` container; premise pinned by `rs-116-projects-score.test.ts`), scored
 *   by {@link groupVerdict}, which refuses a header that merely STARTS with the
 *   wanted name ("P1 renamed" is not "P1").
 * - Board: `data-kanban-column` / `data-kanban-task` (UA2.7's hooks); the editor's
 *   add control by its own copy (`kanban.column.add`) as its `aria-label` (UB14.52:
 *   v0.15.1's IconButton names it there, no longer in a title); the project filter by
 *   its own copy (`kanban.allProjects`) and the project's name.
 * - Turns: the reply text against markers minted for this run. A reply without
 *   them is a FAIL, and a model that declines to read the file FAILS as
 *   unmeasured - never a pass.
 *
 * ## What it writes
 *
 * Projects named `CDP RS-116 …` (deleted in the `finally`), sessions it creates
 * (deleted) — every one NAMED at creation (`CDP RS-116 …`, the page-created
 * ones too: an unnamed, message-less session is deleted by the app's
 * empty-draft sweep the moment it leaves the panel stack, SIT-B FAILS #1,
 * UA12.147), one temp root under the OS temp dir holding the folders (removed),
 * and the per-viewer `nessy-view-filters:<workspaceId>` map (restored to its prior
 * bytes). Trust is granted only to folders under that temp root. Not here (manual
 * add-ons, see the checklist row): two windows (UA5.3 ASK 3's second window),
 * Claude `spawn_session` with a `projectId` (UA5.3 ASK 5), project memory
 * (UA5.5 ASK 3), a tampered `context.md` and its `project-context-tampered`
 * server-log line (UA5.5 ASK 4).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'

import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import { focusWindow, type CdpSession } from '../lib/connect.ts'
import { pressKey } from '../lib/keys.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { BlockedError, blocked, main, type CaseRun } from '../lib/report.ts'
import {
  answerTrustGate, listConnections, runtimeOf, switchRuntime, TRUST_DIALOG_PATH_SELECTOR, TRUST_GATE_HEADING_IN_PAGE, waitForConnection,
} from '../lib/runtime-switch.ts'
import {
  assertElectronApi, createSessionDirectly, ensureSessionName, freshSession, sessionCommand, waitFor, type SessionKey,
} from '../lib/state.ts'
import { assertInViewport, clickSelector, getViewport, type Point } from '../lib/viewport.ts'
import type { CaseMeta, SittingRuntime } from '../lib/sitting.ts'

const ID = 'RS-116'
const TITLE = 'Projects: the trust card for a project folder, grouping by project, per-project board columns that persist, a renamed folder keeping its identity, a replaced folder refused, the delete cascade, and the project context and assets in a turn on Pi, Claude Code and Codex'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UA5.11',
  runtimes: ['pi', 'claude', 'codex'],
  credentials:
    'owner: one card per runtime that answers a turn (a `pi` card, a `claude-runtime` card, a `codex-runtime` card), '
    + 'already signed in, for arm K only; the card is named in the run notes. No key, token or credential file is read. '
    + 'English UI (the trust helper reads the dialog\'s English heading). A desktop-width window, so the session list '
    + 'header and the board header show their controls.',
} as const satisfies CaseMeta

/**
 * The copy this case finds controls by, as the live locale spells it - pinned by
 * `harness.test.ts` ("a case's quoted copy against the live locale").
 */
export const QUOTED_COPY = {
  'sidebar.noProject': { en: 'No project', ru: 'Без проекта' },
  'kanban.allProjects': { en: 'All Projects', ru: 'Все проекты' },
  'kanban.column.add': { en: 'Add column', ru: 'Добавить колонку' },
  'projectInfo.newSessionButton': { en: 'New session in {{name}}', ru: 'Новая сессия в {{name}}' },
  'projectTrust.title': { en: 'Trust this folder?', ru: 'Доверять этой папке?' },
} as const

/** The per-viewer view-filters map's BASE key (`local-storage.ts`: prefix `nessy-` + `KEYS.viewFilters`), pinned by the score test. */
export const VIEW_FILTERS_STORAGE_KEY = 'nessy-view-filters'

/**
 * The key AppShell actually reads and persists the map under: the base key
 * scoped to the workspace (`buildKey` appends `:<workspaceId>`). The bare key
 * is read once by the `useState` initialiser and then replaced by the scoped
 * read on mount, so a write to it never reaches the list. No workspace id
 * names no key the app reads, so it throws rather than fall back to the bare one.
 */
export function viewFiltersKey(workspaceId: string): string {
  if (!workspaceId) throw new Error('viewFiltersKey: no workspace id, so no key the app reads')
  return `${VIEW_FILTERS_STORAGE_KEY}:${workspaceId}`
}

/** The board's built-in column ids in board order (`status-column.ts` `KANBAN_COLUMNS`), pinned by the score test. */
export const BUILT_IN_COLUMNS = ['todo', 'in-progress', 'done'] as const

/** `ProjectFolderView['problem']` (`packages/shared/src/protocol/dto.ts`), pinned by the score test. */
export const FOLDER_PROBLEM = {
  identityChanged: 'project-folder-identity-changed',
  unavailable: 'project-folder-unavailable',
} as const

const ARMS = new Set((process.env.NESSY_CDP_RS116_ARMS ?? 'T,G,C,R,X,D,K')
  .split(',').map(arm => arm.trim().toUpperCase()).filter(Boolean))
const RUNTIME_WANTED = (process.env.NESSY_CDP_RS116_RUNTIMES ?? 'pi,claude,codex')
  .split(',').map(name => name.trim()).filter(Boolean)

const TURN_MS = 300_000
/** How long a dialog that should NOT come is waited for. The positive arm sees it in under 2 s (SIT-6a). */
const NO_DIALOG_MS = 8_000

export interface Verdict {
  ok: boolean
  detail: string
}

/** The project's folder as the host reports it (`ProjectFolderView`), or `present: false` when it has none. */
export interface FolderReading {
  present: boolean
  displayPath: string | null
  trusted: boolean
  problem: string | null
  handleId: string | null
}

/** One directory, one spelling: realpathed when it exists, macOS's `/private/` prefix dropped. */
export function samePlace(path: string): string {
  let real = resolvePath(path)
  try { real = realpathSync(real) } catch { /* a folder that is gone keeps its resolved spelling */ }
  return real.replace(/^\/private\//, '/')
}

/**
 * The group header a row is rendered under, against the label wanted. A row the
 * list does not render, or renders in no group, FAILS. A header that only starts
 * with the label ("P1 renamed" for "P1") FAILS: what may follow the label is the
 * group's count, never more name. Case is folded: v0.15.1's headers in
 * `entity-list.tsx` (UB13.13) render the label as the locale spells it, but the
 * pre-v0.15.1 headers were `uppercase` and `innerText` applies `text-transform`,
 * so folding keeps "No project" and "NO PROJECT" one reading whichever the list
 * renders (the cru-3.ts `fold` precedent; premise pinned by
 * `rs-116-projects-score.test.ts`, UB12.25).
 */
export function groupVerdict(header: string | null, label: string): Verdict {
  if (header === null) return { ok: false, detail: 'row-not-grouped: the session row is not rendered under any group header' }
  const text = header.replace(/\s+/g, ' ').trim()
  const folded = text.toLocaleLowerCase()
  const want = label.toLocaleLowerCase()
  if (!folded.startsWith(want)) return { ok: false, detail: `under ${JSON.stringify(text)}, not ${JSON.stringify(label)}` }
  const rest = folded.slice(want.length)
  if (/\p{L}/u.test(rest)) return { ok: false, detail: `under ${JSON.stringify(text)}, a different group whose name starts with ${JSON.stringify(label)}` }
  return { ok: true, detail: `under ${JSON.stringify(text)}` }
}

/** Score the host's folder reading; every wanted field is compared, and a project with no folder fails a folder want. */
export function folderVerdict(
  folder: FolderReading | null,
  want: { trusted?: boolean; problem?: string | null; displayPath?: string },
): Verdict {
  if (folder === null) return { ok: false, detail: 'project-not-found: the host has no such project' }
  if (!folder.present) return { ok: false, detail: 'the project has no folder bound' }
  const misses: string[] = []
  if (want.trusted !== undefined && folder.trusted !== want.trusted) misses.push(`trusted ${folder.trusted}, not ${want.trusted}`)
  if (want.problem !== undefined && folder.problem !== want.problem) misses.push(`problem ${JSON.stringify(folder.problem)}, not ${JSON.stringify(want.problem)}`)
  if (want.displayPath !== undefined && (folder.displayPath === null || samePlace(folder.displayPath) !== samePlace(want.displayPath))) {
    misses.push(`folder ${JSON.stringify(folder.displayPath)}, not ${JSON.stringify(want.displayPath)}`)
  }
  return { ok: misses.length === 0, detail: misses.length === 0 ? 'as wanted' : misses.join('; ') }
}

/**
 * G's folder guard (UA12.120): binding a session to a project leaves its working
 * directory unchanged — and the project it binds to CARRIES a folder, so a
 * binding that adopted it would fail here. Either side unread is UNMEASURED,
 * never a pass; pinned by `rs-116-projects-score.test.ts`.
 */
export function bindingKeepsFolderVerdict(before: string | null, after: string | null): Verdict {
  if (before === null || after === null) {
    const which = before === null ? 'before' : 'after'
    return { ok: false, detail: `UNMEASURED - the working directory ${which} the binding is unread` }
  }
  return before === after
    ? { ok: true, detail: 'working directory unchanged by the binding' }
    : { ok: false, detail: `binding moved the working directory ${JSON.stringify(before)} → ${JSON.stringify(after)}` }
}

/** A refusal must be one and name its code: a success FAILS, and so does a refusal for another reason. */
export function refusalVerdict(error: string | undefined, code: string): Verdict {
  if (error === undefined) return { ok: false, detail: `not refused: the call succeeded where ${code} was wanted` }
  return error.includes(code)
    ? { ok: true, detail: `refused: ${error.slice(0, 160)}` }
    : { ok: false, detail: `refused for another reason: ${error.slice(0, 200)} (wanted ${code})` }
}

/** Every marker must be in the reply; an empty reply FAILS as unmeasured. */
export function replyVerdict(reply: string, markers: readonly string[]): Verdict {
  if (reply.trim().length === 0) return { ok: false, detail: 'UNMEASURED - no assistant reply' }
  const missing = markers.filter(marker => !reply.includes(marker))
  return missing.length === 0
    ? { ok: true, detail: 'every marker answered' }
    : { ok: false, detail: `missing ${missing.join(', ')} in ${JSON.stringify(reply.slice(0, 240))}` }
}

/** The board's column ids against the set wanted, in order. */
export function columnsVerdict(columns: readonly string[], want: readonly string[]): Verdict {
  const same = columns.length === want.length && columns.every((id, index) => id === want[index])
  return { ok: same, detail: same ? 'as wanted' : `columns ${JSON.stringify(columns)}, not ${JSON.stringify(want)}` }
}

/**
 * The view-filters map with All Sessions grouped by Project and its filters
 * cleared (so the case's sessions are not filtered away); every other view is
 * kept as it was. An unreadable map is replaced by one holding this view only.
 */
export function withProjectGrouping(raw: string | null): string {
  let map: Record<string, unknown> = {}
  try {
    const parsed: unknown = raw === null ? {} : JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed as Record<string, unknown>
  } catch { /* an unreadable map is replaced */ }
  return JSON.stringify({ ...map, allSessions: { statuses: {}, labels: {}, projects: {}, groupingMode: 'project' } })
}

/** The page button's copy for one project, in every locale the case knows. */
function newSessionLabels(name: string): string[] {
  return Object.values(QUOTED_COPY['projectInfo.newSessionButton']).map(template => template.replace('{{name}}', name))
}

// ─────────────────────────────── page reads ───────────────────────────────

interface SessionRecord {
  found: boolean
  projectId: string | null
  workingDirectory: string | null
  kanbanColumn: string | null
}

async function readSession(session: CdpSession, sessionId: string): Promise<SessionRecord> {
  return session.call<SessionRecord>(`
    const s = ((await window.electronAPI.getSessions()) ?? []).find(row => row.id === ${JSON.stringify(sessionId)})
    if (!s) return { found: false, projectId: null, workingDirectory: null, kanbanColumn: null }
    return {
      found: true,
      projectId: typeof s.projectId === 'string' ? s.projectId : null,
      workingDirectory: typeof s.workingDirectory === 'string' ? s.workingDirectory : null,
      kanbanColumn: typeof s.kanbanColumn === 'string' ? s.kanbanColumn : null,
    }
  `)
}

async function settledSession(session: CdpSession, sessionId: string, accept: (record: SessionRecord) => boolean, timeoutMs = 15_000): Promise<SessionRecord> {
  try {
    return await waitFor(() => readSession(session, sessionId), accept, { timeoutMs, intervalMs: 500 })
  } catch {
    return readSession(session, sessionId)
  }
}

async function sessionIdsOfProject(session: CdpSession, projectId: string): Promise<string[]> {
  return session.call<string[]>(`
    return ((await window.electronAPI.getSessions()) ?? []).filter(s => s.projectId === ${JSON.stringify(projectId)}).map(s => s.id)
  `)
}

interface ProjectReading {
  found: boolean
  id: string | null
  slug: string | null
  name: string | null
  folderPath: string | null
  kanbanColumns: string[]
  folder: FolderReading
}

async function readProject(session: CdpSession, workspaceId: string, idOrSlug: string): Promise<ProjectReading> {
  return session.call<ProjectReading>(`
    const p = await window.electronAPI.getProject(${JSON.stringify(workspaceId)}, ${JSON.stringify(idOrSlug)})
    const none = { present: false, displayPath: null, trusted: false, problem: null, handleId: null }
    if (!p) return { found: false, id: null, slug: null, name: null, folderPath: null, kanbanColumns: [], folder: none }
    const f = p.config.folder
    return {
      found: true,
      id: p.config.id,
      slug: p.config.slug,
      name: p.config.name,
      folderPath: p.folderPath ?? null,
      kanbanColumns: (p.config.kanbanColumns ?? []).map(c => c.id),
      folder: f ? { present: true, displayPath: f.displayPath ?? null, trusted: f.trusted === true, problem: f.problem ?? null, handleId: f.handleId ?? null } : none,
    }
  `)
}

async function settledProject(
  session: CdpSession, workspaceId: string, idOrSlug: string, accept: (project: ProjectReading) => boolean, timeoutMs = 15_000,
): Promise<ProjectReading> {
  try {
    return await waitFor(() => readProject(session, workspaceId, idOrSlug), accept, { timeoutMs, intervalMs: 500 })
  } catch {
    return readProject(session, workspaceId, idOrSlug)
  }
}

async function createProject(session: CdpSession, workspaceId: string, input: Record<string, unknown>): Promise<{ id: string; slug: string }> {
  return session.call<{ id: string; slug: string }>(`
    const p = await window.electronAPI.createProject(${JSON.stringify(workspaceId)}, ${JSON.stringify(input)})
    return { id: p.id, slug: p.slug }
  `)
}

/** Issue a handle for a path - the one raw-path ingress, the call the folder picker's result comes from. */
async function issueHandle(session: CdpSession, workspaceId: string, dir: string): Promise<{ id?: string; trustState?: string; error?: string }> {
  return session.call<{ id?: string; trustState?: string; error?: string }>(`
    try {
      const h = await window.electronAPI.validateProjectDirectory({ workspaceId: ${JSON.stringify(workspaceId)}, candidatePath: ${JSON.stringify(dir)} })
      return { id: h.id, trustState: h.trustState }
    } catch (e) { return { error: String((e && (e.code || e.message)) || e) } }
  `)
}

async function bindFolder(session: CdpSession, workspaceId: string, slug: string, handleId: string): Promise<string> {
  return session.call<string>(`
    try { await window.electronAPI.setProjectFolder(${JSON.stringify(workspaceId)}, ${JSON.stringify(slug)}, ${JSON.stringify(handleId)}); return 'bound' }
    catch (e) { return 'failed: ' + String((e && (e.code || e.message)) || e).slice(0, 200) }
  `)
}

async function navigateRoute(session: CdpSession, route: string): Promise<void> {
  await session.call<null>(`
    window.dispatchEvent(new CustomEvent('nessy-agent-navigate', { detail: { route: ${JSON.stringify(route)} }, bubbles: true }))
    return null
  `)
}

/** Mark the one element matching `selector` whose own text is one of `labels`; the count of matches. */
async function markByText(session: CdpSession, selector: string, labels: readonly string[], mark: string): Promise<number> {
  return session.call<number>(`
    document.querySelectorAll('[data-rs116-target]').forEach(el => el.removeAttribute('data-rs116-target'))
    const labels = ${JSON.stringify(labels)}
    const hits = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
      .filter(el => labels.includes((el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()))
    if (hits[0]) hits[0].setAttribute('data-rs116-target', ${JSON.stringify(mark)})
    return hits.length
  `)
}

async function pressByText(session: CdpSession, selector: string, labels: readonly string[], timeoutMs = 15_000): Promise<string> {
  try {
    await waitFor(() => markByText(session, selector, labels, 'press'), count => count > 0, { timeoutMs, intervalMs: 300 })
  } catch {
    return `not-found: no ${selector} reading ${JSON.stringify(labels)}`
  }
  await clickSelector(session, '[data-rs116-target="press"]')
  return 'pressed'
}

/** The trust dialog as it stands: its heading and the folder it names, or `present: false`. */
async function readTrustDialog(session: CdpSession): Promise<{ present: boolean; heading?: string; path?: string }> {
  return session.call<{ present: boolean; heading?: string; path?: string }>(`
    const titles = ${JSON.stringify(Object.values(QUOTED_COPY['projectTrust.title']))}
    const heading = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]'))
      .find(el => { const t = (el.textContent || '').trim(); return titles.includes(t) || ${TRUST_GATE_HEADING_IN_PAGE}(el) })
    if (!heading) return { present: false }
    const root = heading.closest('[role="dialog"]') ?? document.body
    const field = root.querySelector(${JSON.stringify(TRUST_DIALOG_PATH_SELECTOR)})
    return { present: true, heading: (heading.textContent || '').trim(), path: field ? String(field.textContent || '').trim() : '' }
  `)
}

/** Wait for the dialog (`want: true`) or for `NO_DIALOG_MS` of its absence (`want: false`); the last reading. */
async function watchTrustDialog(session: CdpSession, want: boolean): Promise<{ present: boolean; heading?: string; path?: string }> {
  const deadline = Date.now() + (want ? 20_000 : NO_DIALOG_MS)
  let last = await readTrustDialog(session)
  while (Date.now() < deadline) {
    if (last.present) return last
    await Bun.sleep(400)
    last = await readTrustDialog(session)
  }
  return last
}

/**
 * Open a project's page and press "New session in <name>"; the id of the session it created, or why not.
 *
 * UA12.147 — the session is NAMED (and the name read back) before this helper
 * returns. `NavigationContext`'s empty-session sweep deletes a session the
 * moment it leaves the visible panel set while it has no final message, no
 * NAME, is not processing and holds no draft — which is every session this
 * button creates. SIT-B measured the sweep eating RS-116's unnamed
 * page-created sessions three times (the delete hook firing, the session dirs
 * gone, six arms failing on features named-session supplements then passed);
 * a name is exactly what exempts a session (the harness README's rule).
 * `named` carries {@link ensureSessionName}'s sentence when the name did not
 * take, so the caller can refuse rather than watch the sweep eat the row it
 * is measuring.
 */
async function newSessionFromPage(
  session: CdpSession, workspaceId: string, project: { id: string; slug: string }, name: string,
  sessionName: string,
): Promise<{ sessionId?: string; pressed: string; named?: string }> {
  const before = new Set(await sessionIdsOfProject(session, project.id))
  await navigateRoute(session, `projects/project/${project.slug}`)
  const pressed = await pressByText(session, 'button', newSessionLabels(name), 20_000)
  if (pressed !== 'pressed') return { pressed }
  try {
    const ids = await waitFor(
      () => sessionIdsOfProject(session, project.id),
      list => list.some(id => !before.has(id)),
      { timeoutMs: 20_000, intervalMs: 500 },
    )
    const sessionId = ids.find(id => !before.has(id))!
    const named = await ensureSessionName(session, { workspaceId, sessionId }, sessionName)
    return { pressed, sessionId, ...(named ? { named } : {}) }
  } catch {
    return { pressed }
  }
}

async function readToasts(session: CdpSession): Promise<string[]> {
  return session.call<string[]>(`
    return Array.from(document.querySelectorAll('[data-sonner-toast]')).map(el => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim())
  `)
}

/** The header of the group block a session row is rendered in (`entity-list.tsx`), or `null`. */
async function readGroupHeader(session: CdpSession, sessionId: string): Promise<string | null> {
  return session.call<string | null>(`
    const item = document.querySelector('.session-item[data-session-id=' + ${JSON.stringify(JSON.stringify(sessionId))} + ']')
    if (!item) return null
    let el = item
    const isGroupList = node => node && node.classList && node.classList.contains('pt-1')
      && node.parentElement && node.parentElement.classList.contains('pb-2')
    while (el && el.parentElement && !isGroupList(el.parentElement)) el = el.parentElement
    if (!el || !isGroupList(el.parentElement)) return null
    const header = el.firstElementChild
    if (!header || header.contains(item)) return null
    return (header.innerText || header.textContent || '').replace(/\\s+/g, ' ').trim()
  `)
}

/** The verdict against whichever of `labels` (one per locale) the header carries; the first label's when none. */
export function groupVerdictAny(header: string | null, labels: readonly string[]): Verdict {
  const verdicts = labels.map(label => groupVerdict(header, label))
  return verdicts.find(verdict => verdict.ok) ?? verdicts[0] ?? { ok: false, detail: 'no label to compare' }
}

async function settledGroup(session: CdpSession, sessionId: string, labels: readonly string[]): Promise<Verdict> {
  let header: string | null
  try {
    header = await waitFor(() => readGroupHeader(session, sessionId), read => groupVerdictAny(read, labels).ok, { timeoutMs: 15_000, intervalMs: 500 })
  } catch {
    header = await readGroupHeader(session, sessionId)
  }
  return groupVerdictAny(header, labels)
}

async function reloadRenderer(session: CdpSession): Promise<void> {
  await session.send('Page.reload', {})
  await waitFor(
    () => session.call<boolean>(`return typeof window.electronAPI?.getSessions === 'function'`).catch(() => false),
    ready => ready,
    { timeoutMs: 30_000, intervalMs: 500 },
  ).catch(() => undefined)
  await Bun.sleep(2_000)
  await focusWindow(session)
}

// ─────────────────────────────── board ───────────────────────────────

const tileSelector = (sessionId: string): string => `[data-kanban-task=${JSON.stringify(sessionId)}]`
const columnSelector = (columnId: string): string => `[data-kanban-column=${JSON.stringify(columnId)}]`
const ADD_COLUMN_SELECTOR = Object.values(QUOTED_COPY['kanban.column.add']).map(label => `button[aria-label=${JSON.stringify(label)}]`).join(', ')

async function boardColumns(session: CdpSession): Promise<string[]> {
  return session.call<string[]>(`
    return Array.from(document.querySelectorAll('[data-kanban-column]')).map(el => el.getAttribute('data-kanban-column') ?? '')
  `)
}

async function settledColumns(session: CdpSession, accept: (columns: string[]) => boolean, timeoutMs = 15_000): Promise<string[]> {
  try {
    return await waitFor(() => boardColumns(session), accept, { timeoutMs, intervalMs: 500 })
  } catch {
    return boardColumns(session)
  }
}

async function tileColumn(session: CdpSession, sessionId: string): Promise<string | null> {
  return session.call<string | null>(`
    const tile = document.querySelector(${JSON.stringify(tileSelector(sessionId))})
    const column = tile ? tile.closest('[data-kanban-column]') : null
    return column ? column.getAttribute('data-kanban-column') : null
  `)
}

async function addColumnOffered(session: CdpSession): Promise<boolean> {
  return session.call<boolean>(`return document.querySelector(${JSON.stringify(ADD_COLUMN_SELECTOR)}) !== null`)
}

/** Pick one project in the board's project filter (or "All Projects" with `null`), then close the menu. */
async function focusBoardProject(session: CdpSession, current: readonly string[], name: string | null): Promise<string> {
  const opened = await pressByText(session, 'button[aria-haspopup="menu"]', current, 10_000)
  if (opened !== 'pressed') return `trigger ${opened}`
  const item = name === null
    ? await pressByText(session, '[role="menuitem"]', Object.values(QUOTED_COPY['kanban.allProjects']), 8_000)
    : await pressByText(session, '[role="menuitemcheckbox"]', [name], 8_000)
  await pressKey(session, 'Escape').catch(() => undefined)
  return item === 'pressed' ? 'picked' : `item ${item}`
}

/** A real pointer drag of a tile into a column (RS-110's instrument). */
async function dragTile(session: CdpSession, sessionId: string, toColumn: string): Promise<string> {
  const geometry = await session.call<{ start?: Point; end?: Point; why?: string }>(`
    const tile = document.querySelector(${JSON.stringify(tileSelector(sessionId))})
    const column = document.querySelector(${JSON.stringify(columnSelector(toColumn))})
    if (!tile) return { why: 'tile-not-rendered' }
    if (!column) return { why: 'column-not-rendered' }
    tile.scrollIntoView({ block: 'center' })
    const t = tile.getBoundingClientRect()
    const c = column.getBoundingClientRect()
    let start
    for (const [fx, dy] of [[0.25, 18], [0.2, 30], [0.4, 18], [0.3, 44]]) {
      const x = t.x + t.width * fx
      const y = t.y + Math.min(dy, t.height / 2)
      const el = document.elementFromPoint(x, y)
      if (el && tile.contains(el) && !el.closest('[data-no-dnd="true"]')) { start = { x: Math.round(x), y: Math.round(y) }; break }
    }
    if (!start) return { why: 'no grab point on the tile is free of data-no-dnd controls' }
    return { start, end: { x: Math.round(c.x + c.width / 2), y: Math.round(c.y + Math.min(c.height / 2, 220)) } }
  `)
  if (!geometry.start || !geometry.end) return `not-dragged: ${geometry.why ?? 'no geometry'}`
  const viewport = await getViewport(session)
  assertInViewport(viewport, geometry.start, 'drag start')
  assertInViewport(viewport, geometry.end, 'drag end')
  const mouse = async (type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', point: Point, buttons: number): Promise<void> => {
    await session.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 })
  }
  const { start, end } = geometry
  await mouse('mouseMoved', start, 0)
  await mouse('mousePressed', start, 1)
  for (let step = 1; step <= 8; step += 1) {
    await mouse('mouseMoved', { x: Math.round(start.x + ((end.x - start.x) * step) / 8), y: Math.round(start.y + ((end.y - start.y) * step) / 8) }, 1)
    await Bun.sleep(40)
  }
  await Bun.sleep(150)
  await mouse('mouseReleased', end, 0)
  return 'dragged'
}

// ─────────────────────────────── the arms ───────────────────────────────

/** A folder that declares one skill, so its trust card is reachable (SIT-6a). */
function plantFolder(dir: string): string {
  const skillDir = join(dir, '.agents', 'skills', 'cdp-rs-116')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'),
    '---\nname: cdp-rs-116\ndescription: the contribution that makes this project folder\'s trust card reachable (RS-116)\n---\nnothing to run\n', 'utf8')
  writeFileSync(join(dir, 'README.md'), 'RS-116 scratch project folder\n', 'utf8')
  return realpathSync(dir)
}

interface ProjectsState {
  workspaceId: string
  root: string
  stamp: string
  /** Every project this case created: id → slug (deleted in the `finally`). */
  projects: Map<string, string>
  owned: string[]
  p1?: { id: string; slug: string; name: string }
  p2?: { id: string; slug: string; name: string }
  dirA?: string
  /** P1's sessions, in creation order. */
  p1Sessions: string[]
  unbound?: SessionKey
}

async function ownProject(session: CdpSession, state: ProjectsState, name: string, extra: Record<string, unknown> = {}): Promise<{ id: string; slug: string; name: string }> {
  const created = await createProject(session, state.workspaceId, { name, ...extra })
  state.projects.set(created.id, created.slug)
  return { ...created, name }
}

async function driveTrust(run: CaseRun, session: CdpSession, state: ProjectsState): Promise<void> {
  state.p1 = await ownProject(session, state, `CDP RS-116 P1 ${state.stamp}`)
  state.p2 = await ownProject(session, state, `CDP RS-116 P2 ${state.stamp}`)
  const p1 = state.p1
  state.dirA = plantFolder(join(state.root, 'folder-a'))
  const dirA = state.dirA
  const handle = await issueHandle(session, state.workspaceId, dirA)
  run.observe('T: the handle issued for folder A', handle)
  run.require('T: folder A is a fresh folder the profile has no trust decision for', handle.trustState === 'unknown',
    JSON.stringify(handle))
  run.require('T: folder A binds to P1 through its handle', (await bindFolder(session, state.workspaceId, p1.slug, handle.id!)) === 'bound', p1.slug)
  const before = await settledProject(session, state.workspaceId, p1.id, project => project.folder.present)
  const beforeVerdict = folderVerdict(before.folder, { trusted: false, problem: null, displayPath: dirA })
  run.check('T: the host reads P1\'s folder as folder A, not yet trusted', beforeVerdict.ok, beforeVerdict.detail)

  // ============ T - New session in P1 raises the trust card for folder A ============
  const first = await newSessionFromPage(session, state.workspaceId, p1, p1.name, `CDP ${ID} page trust ${state.stamp}`)
  run.observe('T: "New session in P1" from the project page', first)
  run.require('T: the page\'s button created a session bound to P1', first.sessionId !== undefined, first.pressed)
  run.require('T: the page-created session is NAMED before anything navigates away (the empty-draft sweep cannot take it; UA12.147)',
    first.named === undefined, first.named ?? 'the name is in place')
  state.owned.push(first.sessionId!)
  state.p1Sessions.push(first.sessionId!)
  const s1 = await readSession(session, first.sessionId!)
  run.check('T: the session opens in the project\'s folder', s1.workingDirectory !== null && samePlace(s1.workingDirectory) === samePlace(dirA),
    `workingDirectory ${JSON.stringify(s1.workingDirectory)}, not ${dirA}`)
  const dialog = await watchTrustDialog(session, true)
  run.observe('T: the trust dialog', dialog)
  run.check('T: the trust dialog comes up for the new session', dialog.present, 'no trust dialog in 20 s')
  run.check('T: the dialog names folder A', dialog.present && !!dialog.path && samePlace(dialog.path) === samePlace(dirA),
    `the dialog names ${JSON.stringify(dialog.path)}`)
  run.check('T: the dialog asks about the FOLDER (UA5.7\'s copy)',
    dialog.present && (Object.values(QUOTED_COPY['projectTrust.title']) as string[]).includes(dialog.heading ?? ''),
    `heading ${JSON.stringify(dialog.heading)}`)
  const answered = await answerTrustGate(session, dirA, 'trust', 20_000)
  run.check('T: trust is answered from the dialog', answered === 'answered', answered)
  const after = await settledProject(session, state.workspaceId, p1.id, project => project.folder.trusted)
  const afterVerdict = folderVerdict(after.folder, { trusted: true, problem: null, displayPath: dirA })
  run.check('T: the host then reads P1\'s folder trusted', afterVerdict.ok, afterVerdict.detail)

  // ============ T' - the decided folder raises no card (the control) ==================
  const second = await newSessionFromPage(session, state.workspaceId, p1, p1.name, `CDP ${ID} page trust2 ${state.stamp}`)
  run.observe('T\': a second "New session in P1"', second)
  if (second.sessionId) {
    state.owned.push(second.sessionId); state.p1Sessions.push(second.sessionId)
    run.require('T\': the page-created session is NAMED before anything navigates away (UA12.147)',
      second.named === undefined, second.named ?? 'the name is in place')
  }
  const silent = await watchTrustDialog(session, false)
  run.check('T\': a second session in the trusted folder raises no trust dialog', second.sessionId !== undefined && !silent.present,
    second.sessionId ? `dialog ${JSON.stringify(silent)}` : second.pressed)
  if (silent.present) await answerTrustGate(session, dirA, 'trust', 10_000).catch(() => undefined)
  if (second.sessionId) {
    const s2 = await readSession(session, second.sessionId)
    run.check('T\': it opens in folder A too', s2.workingDirectory !== null && samePlace(s2.workingDirectory) === samePlace(dirA),
      `workingDirectory ${JSON.stringify(s2.workingDirectory)}`)
  }
}

async function driveGrouping(run: CaseRun, session: CdpSession, state: ProjectsState): Promise<void> {
  const p1 = state.p1!
  const p2 = state.p2!
  const u = state.unbound!
  const s1 = state.p1Sessions[0]!
  const noProject = Object.values(QUOTED_COPY['sidebar.noProject'])
  const filtersKey = viewFiltersKey(state.workspaceId)
  const filtersBefore = await session.call<string | null>(`return window.localStorage.getItem(${JSON.stringify(filtersKey)})`)
  run.observe(`G: the view-filters map (${filtersKey}) before the arm`, filtersBefore)
  try {
    await session.call<null>(`window.localStorage.setItem(${JSON.stringify(filtersKey)}, ${JSON.stringify(withProjectGrouping(filtersBefore))}); return null`)
    await reloadRenderer(session)
    await navigateRoute(session, 'allSessions')

    const s1Group = await settledGroup(session, s1, [p1.name])
    run.check('G: P1\'s session is listed under P1', s1Group.ok, s1Group.detail)
    const uGroup = await settledGroup(session, u.sessionId, noProject)
    run.check('G: an unbound session is listed under "No project"', uGroup.ok, uGroup.detail)

    // UA12.120 — P2 must CARRY a folder, or the no-move check below cannot fail:
    // driveTrust creates P2 folderless, and binding to a folderless project
    // cannot adopt what is not there. `folder-p2` is its own scratch folder
    // (arm X owns `folder-b`), bound exactly as driveTrust binds P1's folder.
    const dirP2 = plantFolder(join(state.root, 'folder-p2'))
    const p2Handle = await issueHandle(session, state.workspaceId, dirP2)
    run.observe('G: the handle issued for P2\'s folder', p2Handle)
    run.require('G: P2\'s folder binds through its handle', p2Handle.id !== undefined
      && (await bindFolder(session, state.workspaceId, p2.slug, p2Handle.id)) === 'bound', p2.slug)
    const p2Folder = await settledProject(session, state.workspaceId, p2.id, project => project.folder.present)
    const p2FolderVerdict = folderVerdict(p2Folder.folder, { displayPath: dirP2 })
    run.require('G: P2 carries a bound folder (the precondition the no-move check can fail)', p2FolderVerdict.ok, p2FolderVerdict.detail)

    const uBefore = await readSession(session, u.sessionId)
    await sessionCommand(session, u.sessionId, { type: 'setProjectId', projectId: p2.id })
    const bound = await settledSession(session, u.sessionId, record => record.projectId === p2.id)
    run.check('G: setProjectId binds U to P2 on the host', bound.projectId === p2.id, JSON.stringify(bound))
    const moved = await settledGroup(session, u.sessionId, [p2.name])
    run.check('G: U moves under P2 in the open list, with no reload', moved.ok, moved.detail)
    const kept = bindingKeepsFolderVerdict(uBefore.workingDirectory, bound.workingDirectory)
    run.check('G: binding U to a FOLDERED project does not adopt its folder', kept.ok, kept.detail)

    await sessionCommand(session, u.sessionId, { type: 'setProjectId', projectId: null })
    const unbound = await settledSession(session, u.sessionId, record => record.projectId === null)
    const back = await settledGroup(session, u.sessionId, noProject)
    run.check('G: unbinding returns U to "No project"', unbound.projectId === null && back.ok, `${JSON.stringify(unbound.projectId)}; ${back.detail}`)
  } finally {
    const restored = await session.call<string>(`
      const raw = ${JSON.stringify(filtersBefore)}
      if (raw === null) window.localStorage.removeItem(${JSON.stringify(filtersKey)})
      else window.localStorage.setItem(${JSON.stringify(filtersKey)}, raw)
      return String(window.localStorage.getItem(${JSON.stringify(filtersKey)}))
    `).catch(error => `restore failed: ${String(error).slice(0, 200)}`)
    run.observe('G: the view-filters map restored', restored)
    await reloadRenderer(session)
  }
}

async function driveColumns(run: CaseRun, session: CdpSession, state: ProjectsState): Promise<void> {
  const p1 = state.p1!
  const s1 = state.p1Sessions[0]!
  const allProjects = Object.values(QUOTED_COPY['kanban.allProjects'])
  const builtIns = [...BUILT_IN_COLUMNS]
  await navigateRoute(session, 'board')
  const unfocused = await settledColumns(session, columns => builtIns.every(id => columns.includes(id)), 20_000)
  run.require('C: the board is mounted', builtIns.every(id => unfocused.includes(id)), JSON.stringify(unfocused))
  run.check('C: the unfocused board offers no column editor (the control)', !(await addColumnOffered(session)), 'an "Add column" control is shown with no project focused')

  const focused = await focusBoardProject(session, allProjects, p1.name)
  const offered = await waitFor(() => addColumnOffered(session), shown => shown, { timeoutMs: 10_000, intervalMs: 300 }).catch(() => false)
  run.require('C: focusing P1 in the board\'s project filter offers the column editor', offered, focused)

  await clickSelector(session, ADD_COLUMN_SELECTOR)
  const written = await settledProject(session, state.workspaceId, p1.id, project => project.kanbanColumns.length === builtIns.length + 1)
  const added = written.kanbanColumns[written.kanbanColumns.length - 1]
  run.observe('C: P1\'s columns after one "Add column"', written.kanbanColumns)
  const seeded = columnsVerdict(written.kanbanColumns.slice(0, builtIns.length), builtIns)
  run.check('C: the first edit seeds the built-ins and appends the new column on the host',
    written.kanbanColumns.length === builtIns.length + 1 && seeded.ok, `${JSON.stringify(written.kanbanColumns)}; ${seeded.detail}`)
  if (!added || builtIns.includes(added as typeof builtIns[number])) {
    run.check('C: completed its arms', false, 'no new column id was written')
    return
  }
  const want = [...builtIns, added]
  const shown = await settledColumns(session, columns => columnsVerdict(columns, want).ok)
  const shownVerdict = columnsVerdict(shown, want)
  run.check('C: the focused board renders P1\'s four columns', shownVerdict.ok, shownVerdict.detail)

  const drag = await dragTile(session, s1, added)
  const placed = await settledSession(session, s1, record => record.kanbanColumn === added)
  run.check('C: P1\'s session dragged into the new column is placed there on the host', drag === 'dragged' && placed.kanbanColumn === added,
    `${drag}; kanbanColumn ${JSON.stringify(placed.kanbanColumn)}`)

  await reloadRenderer(session)
  await navigateRoute(session, 'board')
  await settledColumns(session, columns => builtIns.every(id => columns.includes(id)), 30_000)
  const hostAfter = await readProject(session, state.workspaceId, p1.id)
  const sessionAfter = await readSession(session, s1)
  run.check('C: after a reload the host still reads P1\'s columns', columnsVerdict(hostAfter.kanbanColumns, want).ok, JSON.stringify(hostAfter.kanbanColumns))
  run.check('C: after a reload the session is still placed in the new column', sessionAfter.kanbanColumn === added, JSON.stringify(sessionAfter.kanbanColumn))
  // The board's project filter is in-memory per window (upstream's `kanbanProjectFilterAtom`), so a reload clears it.
  const refocused = await focusBoardProject(session, allProjects, p1.name)
  const reshown = await settledColumns(session, columns => columnsVerdict(columns, want).ok)
  const reshownVerdict = columnsVerdict(reshown, want)
  run.check('C: the reloaded board focused on P1 renders the four columns', reshownVerdict.ok, `${refocused}; ${reshownVerdict.detail}`)
  const tile = await waitFor(() => tileColumn(session, s1), column => column === added, { timeoutMs: 10_000, intervalMs: 500 }).catch(() => null)
  run.check('C: the reloaded board renders the session under the new column', tile === added, `tile under ${JSON.stringify(tile ?? await tileColumn(session, s1))}`)

  const cleared = await focusBoardProject(session, [p1.name], null)
  const plain = await settledColumns(session, columns => columnsVerdict(columns, builtIns).ok)
  const plainVerdict = columnsVerdict(plain, builtIns)
  run.check('C: unfocused ("All Projects") the board shows the built-in columns only', plainVerdict.ok, `${cleared}; ${plainVerdict.detail}`)
}

async function driveRename(run: CaseRun, session: CdpSession, state: ProjectsState): Promise<string | undefined> {
  const p1 = state.p1!
  const dirA = state.dirA!
  // ============ R0 - the project renamed keeps its folder and sessions ================
  const renamedName = `${p1.name} renamed`
  await session.call<null>(`await window.electronAPI.updateProject(${JSON.stringify(state.workspaceId)}, ${JSON.stringify(p1.slug)}, { name: ${JSON.stringify(renamedName)} }); return null`)
  const r0 = await settledProject(session, state.workspaceId, p1.id, project => project.name === renamedName)
  const r0Folder = folderVerdict(r0.folder, { trusted: true, problem: null, displayPath: dirA })
  run.check('R0: the renamed project keeps its slug and its trusted folder', r0.name === renamedName && r0.slug === p1.slug && r0Folder.ok,
    `name ${JSON.stringify(r0.name)}, slug ${JSON.stringify(r0.slug)}; ${r0Folder.detail}`)
  const r0Bound = await sessionIdsOfProject(session, p1.id)
  run.check('R0: the renamed project keeps its sessions', state.p1Sessions.every(id => r0Bound.includes(id)), JSON.stringify(r0Bound))
  p1.name = renamedName

  // ============ R1 - the folder renamed on disk: the binding stays and says so ========
  const dirA2 = join(state.root, 'folder-a-renamed')
  renameSync(dirA, dirA2)
  const r1 = await settledProject(session, state.workspaceId, p1.id, project => project.folder.problem !== null)
  run.observe('R1: P1 after its folder was renamed on disk', r1.folder)
  const r1Folder = folderVerdict(r1.folder, { problem: FOLDER_PROBLEM.unavailable, displayPath: dirA })
  run.check('R1: the project stays bound to its folder and reports it unavailable (never dropped, never retargeted)', r1Folder.ok, r1Folder.detail)
  const r1Bound = await sessionIdsOfProject(session, p1.id)
  run.check('R1: the project\'s sessions keep their binding', state.p1Sessions.every(id => r1Bound.includes(id)), JSON.stringify(r1Bound))

  // ============ R2 - the renamed folder picked again is the same identity ===============
  const handle = await issueHandle(session, state.workspaceId, dirA2)
  run.check('R2: the renamed folder is already trusted (trust follows the folder, not its path)', handle.trustState === 'trusted', JSON.stringify(handle))
  if (!handle.id) return dirA2
  run.check('R2: the renamed folder binds to P1', (await bindFolder(session, state.workspaceId, p1.slug, handle.id)) === 'bound', p1.slug)
  const r2 = await settledProject(session, state.workspaceId, p1.id, project => project.folder.problem === null && project.folder.trusted)
  const r2Folder = folderVerdict(r2.folder, { trusted: true, problem: null, displayPath: dirA2 })
  run.check('R2: P1 reads the renamed folder, trusted, with no problem', r2Folder.ok, r2Folder.detail)
  const next = await newSessionFromPage(session, state.workspaceId, p1, p1.name, `CDP ${ID} page renamed ${state.stamp}`)
  if (next.sessionId) {
    state.owned.push(next.sessionId); state.p1Sessions.push(next.sessionId)
    run.require('R2: the page-created session is NAMED before anything navigates away (UA12.147)',
      next.named === undefined, next.named ?? 'the name is in place')
  }
  const silent = await watchTrustDialog(session, false)
  const nextRecord = next.sessionId ? await readSession(session, next.sessionId) : null
  run.check('R2: a new session opens in the renamed folder with no trust card',
    nextRecord !== null && nextRecord.workingDirectory !== null && samePlace(nextRecord.workingDirectory) === samePlace(dirA2) && !silent.present,
    `${next.pressed}; workingDirectory ${JSON.stringify(nextRecord?.workingDirectory)}; dialog ${JSON.stringify(silent)}`)
  if (silent.present) await answerTrustGate(session, dirA2, 'trust', 10_000).catch(() => undefined)
  return dirA2
}

async function driveReplace(run: CaseRun, session: CdpSession, state: ProjectsState, folder: string): Promise<void> {
  const p1 = state.p1!
  // ============ X2 - config.json edited to another TRUSTED folder =====================
  const dirB = plantFolder(join(state.root, 'folder-b'))
  const handleB = await issueHandle(session, state.workspaceId, dirB)
  const trustedB = handleB.id
    ? await session.call<string>(`
        try {
          const h = await window.electronAPI.setProjectTrust({ workspaceId: ${JSON.stringify(state.workspaceId)}, projectHandleId: ${JSON.stringify(handleB.id)}, state: 'trusted' })
          return String(h && h.trustState)
        } catch (e) { return 'failed: ' + String((e && (e.code || e.message)) || e).slice(0, 200) }
      `)
    : `no handle: ${handleB.error ?? '?'}`
  run.require('X2: folder B (the edit\'s target) is trusted', trustedB === 'trusted', trustedB)
  const loaded = await readProject(session, state.workspaceId, p1.id)
  const configPath = loaded.folderPath ? join(loaded.folderPath, 'config.json') : ''
  run.require('X2: P1\'s config.json is where the host says the project lives', configPath !== '' && existsSync(configPath), configPath)
  const original = readFileSync(configPath, 'utf8')
  try {
    const parsed = JSON.parse(original) as { folder?: { workingDirectory?: string } }
    run.require('X2: config.json carries the bound folder', typeof parsed.folder?.workingDirectory === 'string', original.slice(0, 200))
    parsed.folder!.workingDirectory = dirB
    writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
    const edited = await settledProject(session, state.workspaceId, p1.id, project => project.folder.problem !== null)
    const editedVerdict = folderVerdict(edited.folder, { problem: FOLDER_PROBLEM.identityChanged })
    run.check('X2: a config.json pointed at another trusted folder reads project-folder-identity-changed', editedVerdict.ok, editedVerdict.detail)
    const refused = await createSessionDirectly(session, state.workspaceId, { projectId: p1.id }, 'case-default')
    if (refused.sessionId) state.owned.push(refused.sessionId)
    const refusedVerdict = refusalVerdict(refused.error, FOLDER_PROBLEM.identityChanged)
    run.check('X2: createSession({projectId}) is refused with project-folder-identity-changed', refusedVerdict.ok, refusedVerdict.detail)
  } finally {
    writeFileSync(configPath, original, 'utf8')
  }
  const restored = await settledProject(session, state.workspaceId, p1.id, project => project.folder.problem === null)
  const restoredVerdict = folderVerdict(restored.folder, { problem: null, displayPath: folder })
  run.check('X2: the original config.json reads clean again (the control)', restoredVerdict.ok, restoredVerdict.detail)

  // ============ X1 - the folder deleted and recreated at the same path ================
  rmSync(folder, { recursive: true, force: true })
  plantFolder(folder)
  const replaced = await settledProject(session, state.workspaceId, p1.id, project => project.folder.problem !== null)
  const replacedVerdict = folderVerdict(replaced.folder, { problem: FOLDER_PROBLEM.identityChanged, displayPath: folder })
  run.check('X1: a replaced folder reads project-folder-identity-changed', replacedVerdict.ok, replacedVerdict.detail)
  const before = await sessionIdsOfProject(session, p1.id)
  await navigateRoute(session, `projects/project/${p1.slug}`)
  const pressed = await pressByText(session, 'button', newSessionLabels(p1.name), 20_000)
  const toasts = await waitFor(() => readToasts(session), list => list.some(text => text.includes(FOLDER_PROBLEM.identityChanged)), { timeoutMs: 15_000, intervalMs: 400 })
    .catch(() => readToasts(session))
  const after = await sessionIdsOfProject(session, p1.id)
  const created = after.filter(id => !before.includes(id))
  state.owned.push(...created)
  run.observe('X1: "New session in P1" on the replaced folder', { pressed, toasts, created })
  run.check('X1: the page\'s "New session" is refused with a toast naming project-folder-identity-changed',
    pressed === 'pressed' && toasts.some(text => text.includes(FOLDER_PROBLEM.identityChanged)), `${pressed}; toasts ${JSON.stringify(toasts)}`)
  run.check('X1: no session is bound to P1 by the refused press', created.length === 0, JSON.stringify(created))
}

async function driveDelete(run: CaseRun, session: CdpSession, state: ProjectsState, folder: string | undefined): Promise<void> {
  const p1 = state.p1!
  const p2 = state.p2!
  const bound = await sessionIdsOfProject(session, p1.id)
  const projectDir = (await readProject(session, state.workspaceId, p1.id)).folderPath
  const deleted = await session.call<string>(`
    try { await window.electronAPI.deleteProject(${JSON.stringify(state.workspaceId)}, ${JSON.stringify(p1.slug)}); return 'deleted' }
    catch (e) { return 'failed: ' + String((e && (e.code || e.message)) || e).slice(0, 200) }
  `)
  run.require('D: P1 is deleted', deleted === 'deleted', deleted)
  state.projects.delete(p1.id)
  const unbound: Record<string, string | null> = {}
  for (const id of bound) unbound[id] = (await settledSession(session, id, record => record.projectId === null)).projectId
  run.observe('D: P1\'s sessions after the delete', unbound)
  run.check('D: every one of P1\'s sessions is unbound', bound.length > 0 && Object.values(unbound).every(value => value === null),
    bound.length === 0 ? 'P1 had no session to unbind - the arm measured nothing' : JSON.stringify(unbound))
  run.check('D: the project\'s own directory is gone', projectDir !== null && !existsSync(projectDir), String(projectDir))
  if (folder) run.check('D: the folder P1 was bound to is untouched on disk', existsSync(folder), folder)
  const other = await readProject(session, state.workspaceId, p2.id)
  run.check('D: the other project is untouched', other.found, JSON.stringify(other))
}

async function driveContext(
  run: CaseRun, session: CdpSession, state: ProjectsState, runtime: SittingRuntime, slug: string,
  pk: { id: string; slug: string },
): Promise<void> {
  const mint = (): string => Math.random().toString(16).slice(2, 10).toUpperCase()
  const codename1 = `RS116-${runtime.toUpperCase()}-${mint()}`
  const codename2 = `RS116-${runtime.toUpperCase()}-${mint()}`
  const assetLine = `RS116-ASSET-${mint()}`
  const filename = `rs116-${runtime}.txt`
  await session.call<null>(`
    await window.electronAPI.updateProject(${JSON.stringify(state.workspaceId)}, ${JSON.stringify(pk.slug)}, { details: ${JSON.stringify(`The project's codename is ${codename1}.`)} })
    await window.electronAPI.uploadProjectAsset(${JSON.stringify(state.workspaceId)}, ${JSON.stringify(pk.slug)}, { filename: ${JSON.stringify(filename)}, text: ${JSON.stringify(`${assetLine}\nsecond line\n`)} })
    return null
  `)
  const key = await freshSession(session, `CDP ${ID} ${runtime} context ${new Date().toISOString().slice(11, 19)}`)
  run.require(`K/${runtime}: ran in a session it created`, key.fresh, `inherited ${key.inheritedMessages} messages; reason: ${key.reason ?? '(none given)'}`)
  state.owned.push(key.sessionId)
  await switchRuntime(session, key.sessionId, slug)
  run.require(`K/${runtime}: the session runs on ${slug}`, (await waitForConnection(session, key.sessionId, slug)) === slug, slug)
  await ensureSessionName(session, key, `CDP ${ID} ${runtime} context`)
  await sessionCommand(session, key.sessionId, { type: 'setProjectId', projectId: pk.id })
  const bound = await settledSession(session, key.sessionId, record => record.projectId === pk.id)
  run.require(`K/${runtime}: the session is bound to PK`, bound.projectId === pk.id, JSON.stringify(bound))

  const first = await sendPrompt(session, key,
    `Use your project context and the project's reference files. What codename do this project's details give, and what is the first line of the project file ${filename}? Reply with the codename and that first line.`,
    TURN_MS)
  const reply1 = lastAssistantText(first.added)
  run.observe(`K/${runtime}: the first reply`, reply1.slice(0, 400))
  const v1 = replyVerdict(reply1, [codename1, assetLine])
  run.check(`K/${runtime}: the turn carries the project's details and its asset manifest (both markers answered)`, v1.ok, v1.detail)

  await session.call<null>(`await window.electronAPI.updateProject(${JSON.stringify(state.workspaceId)}, ${JSON.stringify(pk.slug)}, { details: ${JSON.stringify(`The project's codename is ${codename2}.`)} }); return null`)
  const second = await sendPrompt(session, key,
    'The project details were just edited. Read your project context again: what codename do the project details give now? Reply with the codename only.',
    TURN_MS)
  const reply2 = lastAssistantText(second.added)
  run.observe(`K/${runtime}: the reply after the edit`, reply2.slice(0, 400))
  const v2 = replyVerdict(reply2, [codename2])
  run.check(`K/${runtime}: the edited details reach the same session on the next message`, v2.ok, v2.detail)
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  await ensureDarkTheme(session)
  run.observe('window', await focusWindow(session))
  run.observe('arms', [...ARMS])
  const chain = ['T', 'G', 'C', 'R', 'X', 'D'].some(arm => ARMS.has(arm))
  if (!chain && !ARMS.has('K')) blocked(`NESSY_CDP_RS116_ARMS=${[...ARMS].join(',')} names no arm`)

  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-cdp-rs116-')))
  const state: ProjectsState = { workspaceId: '', root, stamp, projects: new Map(), owned: [], p1Sessions: [] }
  run.observe('the temp root this case minted', root)
  try {
    const u = await freshSession(session, `CDP ${ID} unbound ${stamp}`)
    run.require('a session it created (U, never bound)', u.fresh, `inherited ${u.inheritedMessages} messages; reason: ${u.reason ?? '(none given)'}`)
    state.owned.push(u.sessionId)
    state.unbound = u
    state.workspaceId = u.workspaceId

    if (chain) {
      try {
        await driveTrust(run, session, state)
        if (ARMS.has('G')) await driveGrouping(run, session, state)
        if (ARMS.has('C')) await driveColumns(run, session, state)
        let folder: string | undefined = state.dirA
        if (ARMS.has('R')) folder = await driveRename(run, session, state)
        if (ARMS.has('X') && folder) await driveReplace(run, session, state, folder)
        if (ARMS.has('D')) await driveDelete(run, session, state, folder)
      } catch (error) {
        if (error instanceof BlockedError) throw error
        run.check('projects: completed its arms', false, String(error).slice(0, 300))
      }
    }

    if (ARMS.has('K')) {
      const connections = await listConnections(session)
      const cards: Array<[SittingRuntime, string | undefined]> = [
        ['pi', connections.find(row => runtimeOf(row.providerType) === 'pi')?.slug],
        ['claude', connections.find(row => runtimeOf(row.providerType) === 'anthropic')?.slug],
        ['codex', connections.find(row => runtimeOf(row.providerType) === 'codex-runtime')?.slug],
      ]
      run.observe('cards', Object.fromEntries(cards))
      const pk = await ownProject(session, state, `CDP RS-116 PK ${stamp}`)
      for (const [runtime, slug] of cards.filter(([name]) => RUNTIME_WANTED.includes(name))) {
        if (!slug) {
          run.check(`K/${runtime}: measured`, false, 'UNMEASURED - no card of this family on the host; the context arm names all three runtimes, so a missing card is a FAIL here, never a pass')
          continue
        }
        try {
          await driveContext(run, session, state, runtime, slug, pk)
        } catch (error) {
          if (error instanceof BlockedError) throw error
          run.check(`K/${runtime}: completed its arms`, false, String(error).slice(0, 300))
        }
      }
    }
  } finally {
    const deleted: Record<string, string> = {}
    for (const id of state.owned) {
      deleted[id] = await session.call<string>(`
        try { await window.electronAPI.deleteSession(${JSON.stringify(id)}); return 'deleted' }
        catch (e) { return 'delete failed: ' + String(e && e.message || e).slice(0, 160) }
      `).catch(error => `delete failed: ${String(error).slice(0, 160)}`)
    }
    const projects: Record<string, string> = {}
    for (const [id, slug] of state.projects) {
      projects[id] = state.workspaceId === ''
        ? 'no workspace'
        : await session.call<string>(`
            try { await window.electronAPI.deleteProject(${JSON.stringify(state.workspaceId)}, ${JSON.stringify(slug)}); return 'deleted' }
            catch (e) { return 'delete failed: ' + String(e && e.message || e).slice(0, 160) }
          `).catch(error => `delete failed: ${String(error).slice(0, 160)}`)
    }
    rmSync(root, { recursive: true, force: true })
    run.observe('cleanup', { sessions: deleted, projects, tempRootRemoved: !existsSync(root) })
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
