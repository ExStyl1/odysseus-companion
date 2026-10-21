/**
 * RS-114 (plan row UA8.5, 1.42.0 upstream adoption) - a page's scheduled refresh and a user-authored script
 * action on the shipped build: the script that runs on the user's computer is inert until a person approves its
 * digest, runs once approved (on its schedule, on "Run now", from "Run test"), stops again the moment its bytes
 * change, and never sees a secret of the app's environment.
 *
 * The case content is UA8.4's sitting ASK (1)-(5) (`work/wi16/sitting-asks.md`), arm for arm.
 *
 * ## What it proves
 *
 * A.  **An agent creates a live page with a refresh** (per runtime selected, `NESSY_CDP_RS114_RUNTIMES`, default
 *     `pi,claude,codex`; one fresh session each, `bypassPermissions` read back). The agent's `create_page` carries
 *     `refresh: { cron: "*\/5 * * * *", scriptContent }` with the case's script ({@link refreshScript}, a marker
 *     unique to the run). The HOST answers: page.json names `pages/<slug>/refresh.ts`, the file on disk carries the
 *     marker, and `pages:getRefreshStatus` reads `unapproved` with the sha256 of those bytes.
 *     B-D run on the first runtime's page; when no agent produced one, on a page the case creates through the app's
 *     own `pages:create` with the same refresh (observed as such), so the host arms stay measured on their own.
 * B.  **Unapproved means not running** (ASK 1). The open page's bar (`[data-page-refresh-state]`) reads
 *     `unapproved`, shows the schedule and the waiting label; across one real `*\/5` tick nothing runs: no history
 *     line for `page:<slug>`, no `rs114` key in the page's data, no `automation_script_ran` line for the page.
 * C.  **Review, approve, run** (ASK 2). "Review and approve" shows `pages/<slug>/refresh.ts`, `sha256 <the file's
 *     digest>` and the script; "Approve this script" turns the bar `approved`. The next real tick runs it (the
 *     scheduled path - and the positive control for B's and D's absences, on the same three instruments), then
 *     "Run now" runs it again: `rs114.runs` grows on the page's data, and each run writes an `automation_script_ran`
 *     line naming the page and the approved sha256 to `<config>/logs/privileged-actions.jsonl`.
 * D.  **An edit re-asks** (ASK 3). The case appends a comment to `refresh.ts` (an edit by anyone); the host reads
 *     `changed`, the OPEN bar turns `changed` without being reopened and offers no "Run now", `pages:runRefreshNow`
 *     refuses naming the state, and across the next real tick nothing runs.
 * E.  **A user-authored script action** (ASK 4). The case writes a script into the workspace and adds a
 *     `SchedulerTick` automation (`0 0 1 1 *`, so no tick of this run fires it) through the app's own
 *     `automations:create`. Its row reads `unapproved`; "Run test" (the `automations:test` payload the button sends:
 *     the saved automation by id, no client script action) is refused and history names the host's reason;
 *     the row's Approve turns it `approved` and "Run test" runs it; an edit of the script refuses the next test,
 *     and history names the reason again.
 * F.  **No secret in the child's environment** (ASK 5). The names the APP's own processes carry (`ps eww`, names
 *     only) from the script denylist of UA8.1 ({@link deniedNames}: `NESSY_DP_AUTH_TOKEN`,
 *     `NESSY_CLI_DP_AUTH_TOKEN`, `NESSY_SERVER_TOKEN`, `NESSY_WH_*`) must be absent from the env NAMES the refresh
 *     run (C) and the approved test (E) report. At least one such name must be present in the app, or the arm FAILS
 *     as unmeasured - an absence beside a parent that never had the name proves nothing.
 *
 * ## Why the canary is not `NESSY_DP_AUTH_TOKEN` by default
 *
 * The ASK exports `NESSY_DP_AUTH_TOKEN` into the launcher. That variable is not inert: `auth/dp/env-token.ts`
 * EXCHANGES it for gateway credentials, so a fake value breaks every gateway turn of the run (arm A), and a real
 * one is a credential this case must not ask for. The canary the case recommends is `NESSY_WH_API_TOKEN` with an
 * obviously fake value - the same denylist rule (`NESSY_WH_*`, `automations/utils.ts`), read by no code path but a
 * webhook that names it. When the rig already carries `NESSY_DP_AUTH_TOKEN`, it is checked too, by NAME.
 *
 * ## Instruments, and what each reading means
 *
 * - The host's records: `getPage`, `getPageData`, `getPageRefreshStatus`, `getAutomations`, `getAutomationHistory`
 *   (`page:<slug>` for a refresh), the `automations:test` result, and the two JSONL audit files under the config
 *   dir, read for lines stamped after the arm started. Never the model's prose.
 * - The bar and the row by their own DOM hooks (`data-page-refresh-state`, `data-script-approval`); buttons pressed
 *   as real pointer clicks at their measured rects, matched by their English or Russian label.
 * - Ticks are real: the case waits past the next 5-minute boundary of the local clock plus {@link TICK_GRACE_MS}
 *   ({@link tickToWaitFor}: a boundary under {@link TICK_MIN_LEAD_MS} away is skipped for the next, so a matcher
 *   rebuilt by the approval is in place). Three tick waits make this a ~15-minute case; arm E runs inside B's wait.
 * - Env NAMES only, on both sides: the scripts print `Object.keys(process.env)`, the parent read keeps names.
 *
 * ## What it writes
 *
 * Under the run's OWN config dir only ({@link writableConfigDir} refuses the default profile): the pages (deleted
 * through `pages:delete`), the automation (deleted through `automations:delete`), `<workspace>/rs114-<stamp>/`
 * (removed), one session per runtime (deleted). The MACed ledger keeps the approvals of the deleted page and
 * automation - a stated residue: they name a path that no longer exists and approve nothing that runs.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { sendPrompt } from '../lib/chat.ts'
import { focusWindow, type CdpSession } from '../lib/connect.ts'
import { appProcessPids, configDirScope } from '../lib/app-env.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { BlockedError, blocked, main, type CaseRun } from '../lib/report.ts'
import { listConnections, runtimeOf, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import { writableConfigDir } from '../lib/runtime-session-log.ts'
import { assertElectronApi, freshSession, transcript, waitFor, type TranscriptMessage } from '../lib/state.ts'
import { turnCalledTool, turnReply, turnRowsSince } from '../lib/turn-evidence.ts'
import { clickAt } from '../lib/viewport.ts'
import type { CaseMeta, SittingRuntime } from '../lib/sitting.ts'

const ID = 'RS-114'
const TITLE = 'Page refresh and script action: inert until the digest is approved, runs on tick, Run now and Run test, an edit re-asks, no secret env'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UA8.5',
  runtimes: ['pi', 'claude', 'codex'],
  credentials:
    'owner: one card per runtime that answers a turn (a `pi` card, a `claude-runtime` card, a `codex-runtime` card), '
    + 'already signed in; the app launched with its own NESSY_CONFIG_DIR, exported to this case too, and with a '
    + 'FAKE canary `NESSY_WH_API_TOKEN=rs114-canary-not-a-secret` in the launcher env (arm F). No key, token or '
    + 'credential file is read; env values are never read, only names.',
} as const satisfies CaseMeta

const RUNTIME_WANTED = (process.env.NESSY_CDP_RS114_RUNTIMES ?? 'pi,claude,codex')
  .split(',').map(name => name.trim()).filter(Boolean)

/** One turn's own budget; a cold codex spawn is the long one. */
const TURN_MS = 240_000
/** The fastest cron a refresh may carry (refresh.ts, the 5-minute floor). */
export const REFRESH_CRON = '*/5 * * * *'
/** How long after a 5-minute boundary a tick's run has had time to finish and be recorded. */
export const TICK_GRACE_MS = 75_000
/** A cron no tick of this run fires (arm E runs only through Run test). */
const AUTOMATION_CRON = '0 0 1 1 *'

// ============================================================================
// Pure pieces (pinned by scripts/cdp/rs-114-refresh-score.test.ts)
// ============================================================================

/**
 * The refresh script the agent is asked to supply verbatim: no network, no import outside Bun's built-ins, one
 * file (the single-file residue). Each run bumps `rs114.runs` and records the env NAMES it sees, in the store and
 * the snapshot exactly as `resources/docs/pages.md` "Scheduled refresh" tells an agent to write them.
 */
export function refreshScript(marker: string): string {
  return [
    `// ${marker}`,
    "import { Database } from 'bun:sqlite'",
    "import { mkdirSync, renameSync, writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    'const dir = process.env.NESSY_PAGE_DATA_DIR!',
    'mkdirSync(dir, { recursive: true })',
    "const db = new Database(join(dir, 'store.sqlite'))",
    "db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;')",
    "db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL); "
      + "CREATE TABLE IF NOT EXISTS timeseries (series TEXT NOT NULL, t INTEGER NOT NULL, v REAL NOT NULL, PRIMARY KEY (series, t)) WITHOUT ROWID;')",
    "const prev = db.query(\"SELECT value FROM kv WHERE key = 'rs114'\").get() as { value: string } | null",
    'const runs = (prev ? Number(JSON.parse(prev.value).runs) || 0 : 0) + 1',
    `const value = { runs, marker: ${JSON.stringify(marker)}, envNames: Object.keys(process.env).sort(), at: Date.now() }`,
    "db.run('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)', ['rs114', JSON.stringify(value), Date.now()])",
    "const kv = Object.fromEntries((db.query('SELECT key, value FROM kv').all() as { key: string; value: string }[]).map(r => [r.key, JSON.parse(r.value)]))",
    'const tmp = join(dir, `.snapshot.json.${process.pid}.tmp`)',
    'writeFileSync(tmp, JSON.stringify({ version: 1, generatedAt: Date.now(), kv, series: {} }))',
    "renameSync(tmp, join(dir, 'snapshot.json'))",
    '',
  ].join('\n')
}

/** Arm E's script: one line of JSON on stdout - the marker and the env NAMES, never a value. */
export function envProbeScript(marker: string): string {
  return [
    `// ${marker}`,
    `console.log(JSON.stringify({ marker: ${JSON.stringify(marker)}, envNames: Object.keys(process.env).sort() }))`,
    '',
  ].join('\n')
}

/** The env names an env-probe stdout reports, or null when the output is not the probe's own line for `marker`. */
export function parseEnvProbeOutput(stdout: string | undefined, marker: string): string[] | null {
  for (const line of (stdout ?? '').split('\n')) {
    try {
      const parsed = JSON.parse(line) as { marker?: unknown; envNames?: unknown }
      if (parsed.marker === marker && Array.isArray(parsed.envNames)) return parsed.envNames.map(String)
    } catch { /* not the probe's line */ }
  }
  return null
}

/** The script env denylist of UA8.1 (`automations/utils.ts` `applyPlatformEssentials`), applied to a list of names. */
export function deniedNames(names: readonly string[]): string[] {
  const exact = new Set(['NESSY_DP_AUTH_TOKEN', 'NESSY_CLI_DP_AUTH_TOKEN', 'NESSY_SERVER_TOKEN'])
  return names.filter(name => exact.has(name) || name.startsWith('NESSY_WH_')).sort()
}

/**
 * Arm F's verdict for one child reading: a leak names the denied parent names the child saw; no denied name in the
 * parent, or no child reading, is UNMEASURED (never a pass).
 */
export function scoreEnvLeak(parentDenied: readonly string[], child: readonly string[] | null): { ok: boolean; detail: string } {
  if (parentDenied.length === 0) {
    return {
      ok: false,
      detail: 'UNMEASURED - the app carries no denied name (export NESSY_WH_API_TOKEN=rs114-canary-not-a-secret in the '
        + 'launcher env); an absence beside a parent that never had the name proves nothing',
    }
  }
  if (child === null) return { ok: false, detail: 'UNMEASURED - the child reported no env names' }
  const leaked = parentDenied.filter(name => child.includes(name))
  if (leaked.length > 0) return { ok: false, detail: `LEAK - the child saw ${leaked.join(', ')}` }
  return { ok: true, detail: `none of ${parentDenied.join(', ')} reached the child (${child.length} names seen)` }
}

/** The first 5-minute boundary of the LOCAL clock strictly after `nowMs` (what `*\/5` fires on). */
export function nextCronBoundary(nowMs: number, stepMinutes = 5): number {
  const d = new Date(nowMs)
  d.setSeconds(0, 0)
  const minutes = d.getMinutes()
  d.setMinutes(minutes - (minutes % stepMinutes) + stepMinutes)
  return d.getTime()
}

/** How close a boundary may be and still be waited for: a matcher rebuilt by an approval needs a moment (C). */
export const TICK_MIN_LEAD_MS = 20_000

/** The tick an arm starting at `nowMs` waits for: the next boundary, or the one after when the next is too close. */
export function tickToWaitFor(nowMs: number): number {
  const next = nextCronBoundary(nowMs)
  return next - nowMs < TICK_MIN_LEAD_MS ? nextCronBoundary(next) : next
}

export interface AuditLine { event: string; ts: number; fields: Record<string, unknown> }

/** JSONL audit lines stamped at or after `sinceMs` (a torn or foreign line is skipped, not fatal). */
export function auditLinesSince(text: string, sinceMs: number): AuditLine[] {
  const out: AuditLine[] = []
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    try {
      const fields = JSON.parse(raw) as Record<string, unknown>
      const ts = Date.parse(String(fields.timestamp ?? ''))
      if (!Number.isFinite(ts) || ts < sinceMs) continue
      out.push({ event: String(fields.event ?? ''), ts, fields })
    } catch { /* torn line */ }
  }
  return out
}

/** A refresh's run lines for one page (`matcherId` `page:<slug>`), from {@link auditLinesSince}. */
export function refreshRunLines(lines: readonly AuditLine[], slug: string): AuditLine[] {
  return lines.filter(line => line.event === 'automation_script_ran' && line.fields.matcherId === `page:${slug}`)
}

export function sha256Hex(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

// ============================================================================
// The app's own channels
// ============================================================================

interface RefreshStatus { state: string; script?: string; sha256?: string; content?: string }
interface PageRead { slug: string; name: string; kind: string; refresh: { cron?: string; script?: string } | null }

async function activeWorkspaceId(session: CdpSession): Promise<string> {
  const id = await session.call<string | null>(`
    const ws = await window.electronAPI.getWindowWorkspace?.()
    if (typeof ws === 'string' && ws) return ws
    const all = await window.electronAPI.getSessions()
    return (all && all[0] && all[0].workspaceId) || null
  `)
  if (!id) blocked('no workspace id could be read from the window (getWindowWorkspace / getSessions)')
  return id
}

async function listPages(session: CdpSession, ws: string): Promise<PageRead[]> {
  return session.call<PageRead[]>(`
    const pages = await window.electronAPI.getPages(${JSON.stringify(ws)})
    return (pages ?? []).map(p => ({ slug: p.config.slug, name: p.config.name, kind: p.config.kind, refresh: p.config.refresh ?? null }))
  `)
}

async function refreshStatus(session: CdpSession, ws: string, slug: string): Promise<RefreshStatus | null> {
  return session.call<RefreshStatus | null>(`
    try { return await window.electronAPI.getPageRefreshStatus(${JSON.stringify(ws)}, ${JSON.stringify(slug)}) } catch (e) { return null }
  `)
}

async function rs114Data(session: CdpSession, ws: string, slug: string): Promise<{ runs: number; envNames: string[] } | null> {
  return session.call<{ runs: number; envNames: string[] } | null>(`
    const s = await window.electronAPI.getPageData(${JSON.stringify(ws)}, ${JSON.stringify(slug)})
    const v = s && s.kv ? s.kv.rs114 : null
    return v && typeof v.runs === 'number' ? { runs: v.runs, envNames: Array.isArray(v.envNames) ? v.envNames : [] } : null
  `)
}

async function history(session: CdpSession, ws: string, id: string): Promise<Array<{ ts: number; ok: boolean; error?: string }>> {
  return session.call<Array<{ ts: number; ok: boolean; error?: string }>>(`
    return (await window.electronAPI.getAutomationHistory(${JSON.stringify(ws)}, ${JSON.stringify(id)}, 20)).map(e => ({ ts: e.ts, ok: e.ok, error: e.error }))
  `)
}

async function navigateRoute(session: CdpSession, route: string): Promise<void> {
  await session.call<null>(`
    window.dispatchEvent(new CustomEvent('nessy-agent-navigate', { detail: { route: ${JSON.stringify(route)} }, bubbles: true }))
    return null
  `)
}

/** The bar's state attribute and text, or null when no bar is mounted. */
async function readBar(session: CdpSession): Promise<{ state: string; text: string } | null> {
  return session.call<{ state: string; text: string } | null>(`
    const el = document.querySelector('[data-page-refresh-state]')
    return el ? { state: el.getAttribute('data-page-refresh-state') || '', text: el.innerText || '' } : null
  `)
}

/** Click a button inside `scope` whose label is one of `labels` (en, ru); answers what was pressed. */
async function pressButton(session: CdpSession, scope: string, labels: readonly string[], label: string): Promise<string> {
  const rect = await session.call<{ x: number; y: number } | null>(`
    const root = document.querySelector(${JSON.stringify(scope)})
    if (!root) return null
    const want = ${JSON.stringify(labels)}
    const b = Array.from(root.querySelectorAll('button')).find(x => want.includes((x.innerText || '').trim()) && !x.disabled)
    if (!b) return null
    b.scrollIntoView({ block: 'center' })
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  `)
  if (!rect) return `no ${JSON.stringify(labels[0])} button in ${scope}`
  await clickAt(session, rect, label)
  return 'pressed'
}

function readAudit(configDir: string, sinceMs: number): AuditLine[] {
  const file = join(configDir, 'logs', 'privileged-actions.jsonl')
  return existsSync(file) ? auditLinesSince(readFileSync(file, 'utf8'), sinceMs) : []
}

/** Names (never values) in the environment of the app's own processes, scoped to this rig's config dir. */
function appEnvNames(): { pids: number[]; names: string[] } {
  const pids = appProcessPids(configDirScope())
  const names = new Set<string>()
  for (const pid of pids) {
    try {
      const text = Bun.spawnSync(['ps', 'eww', '-p', String(pid)]).stdout.toString()
      for (const token of text.split(/\s+/)) {
        const eq = token.indexOf('=')
        if (eq > 0 && /^[A-Z_][A-Z0-9_]*$/.test(token.slice(0, eq))) names.add(token.slice(0, eq))
      }
    } catch { /* unreadable pid: the control below reports it */ }
  }
  return { pids, names: [...names].sort() }
}

async function sleepUntil(ms: number): Promise<void> {
  const wait = ms - Date.now()
  if (wait > 0) await Bun.sleep(wait)
}

// ============================================================================
// The arms
// ============================================================================

interface Subject { slug: string; name: string; marker: string; viaAgent: boolean }

const isTool = (name: string) => (row: TranscriptMessage): boolean =>
  new RegExp(name).test(`${row.toolName ?? ''} ${row.toolDisplayName ?? ''}`)

async function armA(
  run: CaseRun, session: CdpSession, runtime: SittingRuntime, slug: string, ws: string, root: string, stamp: string,
  ownedPages: string[], ownedSessions: string[],
): Promise<Subject | null> {
  const key = await freshSession(session, `CDP ${ID} ${runtime} ${stamp}`)
  ownedSessions.push(key.sessionId)
  run.require(`${runtime}: ran in a session it created`, key.fresh, `inherited ${key.inheritedMessages} messages`)
  run.observe(`${runtime}: the session's permission mode (read back)`, key.permissionMode)
  await switchRuntime(session, key.sessionId, slug)
  run.require(`${runtime}: the session runs on ${slug}`, (await waitForConnection(session, key.sessionId, slug)) === slug, slug)
  await focusWindow(session)

  const name = `RS-114 ${runtime} ${stamp}`
  const marker = `RS114-MARK-${runtime}-${stamp}`
  const before = (await transcript(session, key)).length
  let added: TranscriptMessage[] = []
  try {
    added = (await sendPrompt(session, key,
      `Please call the create_page tool once to create a page named exactly "${name}" with kind "live", a small HTML `
      + 'document that shows the value of the kv key rs114 (its runs field) from the nessy-pages/v1 bridge, and a '
      + `refresh with cron "${REFRESH_CRON}" and scriptContent EXACTLY the following script, byte for byte:\n\n`
      + `${refreshScript(marker)}\nThen reply with the page slug.`,
      TURN_MS)).added
  } catch (error) {
    run.observe(`${runtime}/A: the send threw`, String(error).slice(0, 300))
  }
  const rows = await turnRowsSince(() => transcript(session, key), added, before)
  const page = await waitFor(() => listPages(session, ws), list => list.some(p => p.name === name), { timeoutMs: 15_000, intervalMs: 1_000 })
    .then(list => list.find(p => p.name === name) ?? null).catch(() => null)
  if (page) ownedPages.push(page.slug)
  const status = page ? await refreshStatus(session, ws, page.slug) : null
  const file = page ? join(root, 'pages', page.slug, 'refresh.ts') : ''
  const onDisk = file && existsSync(file) ? readFileSync(file) : null
  run.observe(`${runtime}/A: the turn`, {
    calls: rows.filter(isTool('create_page')).map(r => ({ status: r.toolStatus ?? null, result: (r.toolResult ?? '').slice(0, 200) })),
    page, status: status ? { state: status.state, script: status.script, sha256: status.sha256 } : null,
    reply: turnReply(rows).slice(0, 200),
  })
  run.check(`${runtime}/A: the agent called create_page`, turnCalledTool(rows, isTool('create_page')).ok, 'no create_page row in the turn')
  run.check(`${runtime}/A: page.json carries the refresh at the host-written path`,
    page?.refresh?.cron === REFRESH_CRON && page.refresh.script === `pages/${page.slug}/refresh.ts`,
    `getPages reads ${JSON.stringify(page)}`)
  run.check(`${runtime}/A: the host wrote the agent's script (marker on disk) and reads it unapproved with its digest`,
    !!onDisk && onDisk.toString('utf8').includes(marker) && status?.state === 'unapproved' && status.sha256 === sha256Hex(onDisk),
    !onDisk ? `no ${file} (the workspace root is not ${root}, or nothing was written)`
      : `state ${status?.state}; digest ${status?.sha256} vs the file's ${sha256Hex(onDisk)}; marker on disk: ${onDisk.toString('utf8').includes(marker)}`)
  if (!page || !onDisk || status?.state !== 'unapproved' || !onDisk.toString('utf8').includes(marker)) return null
  return { slug: page.slug, name, marker, viaAgent: true }
}

/** The host-side fallback subject: the same refresh through the app's own pages:create channel. */
async function caseSubject(session: CdpSession, ws: string, stamp: string, ownedPages: string[]): Promise<Subject> {
  const name = `RS-114 host ${stamp}`
  const marker = `RS114-MARK-host-${stamp}`
  const slug = await session.call<string>(`
    const created = await window.electronAPI.createPage(${JSON.stringify(ws)}, {
      name: ${JSON.stringify(name)}, kind: 'live', content: '<html><body><h1>RS-114</h1></body></html>',
      refresh: { cron: ${JSON.stringify(REFRESH_CRON)}, scriptContent: ${JSON.stringify(refreshScript(marker))} },
    })
    return created.slug
  `)
  ownedPages.push(slug)
  return { slug, name, marker, viaAgent: false }
}

export const REVIEW = ['Review and approve', 'Проверить и одобрить']
export const APPROVE_REFRESH = ['Approve this script', 'Одобрить этот скрипт']
export const RUN_NOW = ['Run now', 'Запустить сейчас']
export const UNAPPROVED_LABELS = ['Waiting for your approval — not running', 'Ждёт вашего одобрения — не запускается']
export const APPROVE_SCRIPT = ['Approve', 'Одобрить']

async function armE(
  run: CaseRun, session: CdpSession, ws: string, root: string, configDir: string, stamp: string, parentDenied: string[],
  owned: { automationId?: string },
): Promise<void> {
  const dir = `rs114-${stamp}`
  const script = `${dir}/env-probe.ts`
  const marker = `RS114-PROBE-${stamp}`
  mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, script), envProbeScript(marker))
  const startedAt = Date.now()
  const created = await session.call<{ automationId: string }>(`
    return await window.electronAPI.createAutomation(${JSON.stringify(ws)}, {
      kind: 'scheduled', name: ${JSON.stringify(`RS-114 script ${stamp}`)}, cron: ${JSON.stringify(AUTOMATION_CRON)},
      actions: [{ type: 'script', script: ${JSON.stringify(script)} }],
    })
  `)
  const id = created.automationId
  owned.automationId = id
  const approvalOf = () => session.call<{ state?: string; sha256?: string } | null>(`
    const cfg = await window.electronAPI.getAutomations(${JSON.stringify(ws)})
    for (const list of Object.values((cfg && cfg.automations) || {})) for (const m of list) if (m.id === ${JSON.stringify(id)}) {
      const a = (m.actions || []).find(x => x.type === 'script'); return a ? (a.approval || {}) : null }
    return null
  `)
  // Exactly the payload the row's "Run test" sends (useAutomations.ts handleTestAutomation): the saved automation by id.
  const test = () => session.call<{ success?: boolean; blocked?: boolean; stdout?: string; error?: string } | null>(`
    const r = await window.electronAPI.testAutomation({ workspaceId: ${JSON.stringify(ws)}, automationId: ${JSON.stringify(id)},
      automationName: ${JSON.stringify(`RS-114 script ${stamp}`)}, actions: [] })
    const a = (r.actions || []).find(x => x.type === 'script'); return a || null
  `)
  const rowState = () => session.call<string | null>(`
    const el = document.querySelector('[data-script-approval]'); return el ? el.getAttribute('data-script-approval') : null
  `)

  const initial = await approvalOf()
  await navigateRoute(session, `automations/automation/${id}`)
  const shownUnapproved = await waitFor(rowState, state => state !== null, { timeoutMs: 10_000, intervalMs: 500 }).catch(() => null)
  run.check('E: the new script action reads unapproved (host and row)', initial?.state === 'unapproved' && shownUnapproved === 'unapproved',
    `host ${JSON.stringify(initial)}; row data-script-approval ${JSON.stringify(shownUnapproved)}`)

  const refused = await test()
  const refusedHistory = (await history(session, ws, id))[0] ?? null
  run.observe('E: Run test before approval', { result: refused, history: refusedHistory })
  run.check('E: Run test is refused before approval, and history names the host\'s reason',
    refused?.success === false && refused.blocked === true && refusedHistory?.ok === false
      && typeof refusedHistory.error === 'string' && refusedHistory.error !== 'Automation failed' && refusedHistory.ts >= startedAt,
    `test ${JSON.stringify(refused)}; newest history ${JSON.stringify(refusedHistory)}`)

  // The Approve button is the state badge's SIBLING: mark the badge's row container and press inside it.
  const marked = await session.call<boolean>(`
    const el = document.querySelector('[data-script-approval]'); const box = el && el.parentElement
    if (!box) return false; box.setAttribute('data-rs114-row', '1'); return true
  `)
  const pressedRow = marked ? await pressButton(session, '[data-rs114-row]', APPROVE_SCRIPT, 'E: Approve') : 'no script row on screen'
  const approvedShown = await waitFor(rowState, state => state === 'approved', { timeoutMs: 10_000, intervalMs: 500 }).catch(() => null)
  run.check('E: Approve on the automation row turns it approved', pressedRow === 'pressed' && approvedShown === 'approved' && (await approvalOf())?.state === 'approved',
    `pressed ${pressedRow}; row ${JSON.stringify(approvedShown)}`)

  const ran = await test()
  const childNames = parseEnvProbeOutput(ran?.stdout, marker)
  run.observe('E: Run test after approval', { success: ran?.success, blocked: ran?.blocked ?? false, envNames: childNames })
  run.check('E: Run test runs the approved script', ran?.success === true && childNames !== null,
    `test ${JSON.stringify({ success: ran?.success, blocked: ran?.blocked, error: ran?.error?.slice(0, 200) })}`)
  const leak = scoreEnvLeak(parentDenied, childNames)
  run.check('F: no denied parent name reaches the Run test child', leak.ok, leak.detail)
  const ranLine = readAudit(configDir, startedAt)
    .find(line => line.event === 'automation_script_ran' && line.fields.matcherId === id)
  run.check('E: the approved run wrote automation_script_ran to privileged-actions.jsonl', ranLine !== undefined,
    'no automation_script_ran line for this automation since the arm started')

  appendFileSync(join(root, script), '// edited by RS-114\n')
  const changed = await waitFor(approvalOf, a => a?.state === 'changed', { timeoutMs: 10_000, intervalMs: 500 }).catch(() => null)
  const reRefused = await test()
  const reHistory = (await history(session, ws, id))[0] ?? null
  run.observe('E: after the edit', { approval: changed, result: reRefused, history: reHistory })
  run.check('E: an edit of the script refuses the next Run test, and history names the reason',
    changed?.state === 'changed' && reRefused?.success === false && reRefused.blocked === true
      && reHistory?.ok === false && typeof reHistory.error === 'string' && reHistory.error !== 'Automation failed',
    `approval ${JSON.stringify(changed)}; test ${JSON.stringify(reRefused)}; history ${JSON.stringify(reHistory)}`)
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  await ensureDarkTheme(session)
  run.observe('window', await focusWindow(session))
  const configDir = writableConfigDir('RS-114\'s page, automation and scripts')
  const ws = await activeWorkspaceId(session)
  const root = process.env.NESSY_CDP_RS114_WORKSPACE_ROOT?.trim() || join(configDir, 'workspaces', ws)
  if (!existsSync(root)) blocked(`the workspace root ${root} does not exist (set NESSY_CDP_RS114_WORKSPACE_ROOT)`)
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '')
  const ownedPages: string[] = []
  const ownedSessions: string[] = []
  const owned: { automationId?: string } = {}

  // F's parent half: names only, from the app's own processes.
  const parent = appEnvNames()
  const parentDenied = deniedNames(parent.names)
  run.observe('F: the app environment (names only)', {
    pids: parent.pids, controlSeen: parent.names.includes('NESSY_CONFIG_DIR'), denied: parentDenied,
    dpTokenPresent: parent.names.includes('NESSY_DP_AUTH_TOKEN'),
  })
  run.require('F: the app\'s environment was read (NESSY_CONFIG_DIR seen)', parent.names.includes('NESSY_CONFIG_DIR'),
    `no NESSY_CONFIG_DIR in ${parent.pids.length} scoped process(es) - the read saw nothing`)

  try {
    // ================= A - an agent creates the refresh, per runtime =========
    const connections = await listConnections(session)
    const cards: Array<[SittingRuntime, string | undefined]> = [
      ['pi', connections.find(row => runtimeOf(row.providerType) === 'pi')?.slug],
      ['claude', connections.find(row => runtimeOf(row.providerType) === 'anthropic')?.slug],
      ['codex', connections.find(row => runtimeOf(row.providerType) === 'codex-runtime')?.slug],
    ]
    run.observe('cards', Object.fromEntries(cards))
    const selected = cards.filter(([name]) => RUNTIME_WANTED.includes(name))
    if (selected.length === 0) blocked(`NESSY_CDP_RS114_RUNTIMES=${RUNTIME_WANTED.join(',')} names no runtime family`)
    let subject: Subject | null = null
    for (const [runtime, slug] of selected) {
      if (!slug) {
        run.check(`${runtime}: measured`, false, 'UNMEASURED - no card of this family on the host')
        continue
      }
      try {
        const made = await armA(run, session, runtime, slug, ws, root, stamp, ownedPages, ownedSessions)
        subject ??= made
      } catch (error) {
        if (error instanceof BlockedError) throw error
        run.check(`${runtime}: completed arm A`, false, String(error).slice(0, 300))
      }
    }
    subject ??= await caseSubject(session, ws, stamp, ownedPages)
    run.observe('the subject page of B-D', subject)
    const scriptFile = join(root, 'pages', subject.slug, 'refresh.ts')
    run.require('the subject\'s refresh.ts is on disk under the workspace root', existsSync(scriptFile), scriptFile)

    // ================= B - unapproved: the bar, and one tick runs nothing ===
    const bStart = Date.now()
    await navigateRoute(session, `pages/page/${subject.slug}`)
    const barB = await waitFor(() => readBar(session), bar => bar !== null && bar.state !== 'loading', { timeoutMs: 15_000, intervalMs: 500 }).catch(() => null)
    run.observe('B: the bar', barB)
    run.check('B: the bar shows the schedule and waits for approval',
      barB?.state === 'unapproved' && barB.text.includes(REFRESH_CRON) && UNAPPROVED_LABELS.some(l => barB.text.includes(l)),
      `bar ${JSON.stringify(barB)}`)
    const tickB = tickToWaitFor(Date.now())
    // E runs inside B's wait: it needs no tick.
    try {
      await armE(run, session, ws, root, configDir, stamp, parentDenied, owned)
    } catch (error) {
      if (error instanceof BlockedError) throw error
      run.check('E: completed its arms', false, String(error).slice(0, 300))
    }
    await sleepUntil(tickB + TICK_GRACE_MS)
    const bHistory = await history(session, ws, `page:${subject.slug}`)
    const bData = await rs114Data(session, ws, subject.slug)
    const bRan = refreshRunLines(readAudit(configDir, bStart), subject.slug)
    run.observe('B: across the tick', { tick: new Date(tickB).toISOString(), history: bHistory, data: bData, ranLines: bRan.length })
    run.check('B: an unapproved refresh does not run on its tick (no history, no data, no run line)',
      bHistory.length === 0 && bData === null && bRan.length === 0,
      `history ${bHistory.length}; data ${JSON.stringify(bData)}; run lines ${bRan.length}`)

    // ================= C - review, approve, the tick runs it, Run now ========
    await navigateRoute(session, `pages/page/${subject.slug}`)
    await waitFor(() => readBar(session), bar => bar?.state === 'unapproved', { timeoutMs: 10_000, intervalMs: 500 }).catch(() => null)
    const reviewPressed = await pressButton(session, '[data-page-refresh-state]', REVIEW, 'C: Review and approve')
    await Bun.sleep(800)
    const review = await readBar(session)
    const digest = sha256Hex(readFileSync(scriptFile))
    run.observe('C: the review', { pressed: reviewPressed, text: review?.text.slice(0, 600) })
    run.check('C: the review shows the host-written path, the file\'s sha256 and the script',
      reviewPressed === 'pressed' && !!review && review.text.includes(`pages/${subject.slug}/refresh.ts`)
        && review.text.includes(`sha256 ${digest}`) && review.text.includes(subject.marker),
      `pressed ${reviewPressed}; review ${JSON.stringify(review?.text.slice(0, 300))}`)
    const approvePressed = await pressButton(session, '[data-page-refresh-state]', APPROVE_REFRESH, 'C: Approve this script')
    const approved = await waitFor(() => readBar(session), bar => bar?.state === 'approved', { timeoutMs: 10_000, intervalMs: 500 }).catch(() => null)
    run.check('C: Approve turns the bar approved', approvePressed === 'pressed' && approved?.state === 'approved'
      && (await refreshStatus(session, ws, subject.slug))?.state === 'approved', `pressed ${approvePressed}; bar ${JSON.stringify(approved)}`)

    const cStart = Date.now()
    const tickC = tickToWaitFor(cStart)
    await sleepUntil(tickC + TICK_GRACE_MS)
    const cData = await rs114Data(session, ws, subject.slug)
    const cRan = refreshRunLines(readAudit(configDir, cStart), subject.slug)
    const cHistory = await history(session, ws, `page:${subject.slug}`)
    run.observe('C: across the tick', { tick: new Date(tickC).toISOString(), data: cData ? { runs: cData.runs } : null, ranLines: cRan.map(l => l.fields), history: cHistory })
    run.check('C: the approved refresh runs on its tick (data, history and a run line with the approved digest)',
      (cData?.runs ?? 0) >= 1 && cHistory.some(h => h.ok && h.ts >= cStart) && cRan.some(l => l.fields.sha256 === digest && l.fields.success === true),
      `data ${JSON.stringify(cData?.runs ?? null)}; history ${JSON.stringify(cHistory.slice(0, 2))}; run lines ${cRan.length}`)

    const runsBefore = cData?.runs ?? 0
    const nowStart = Date.now()
    const runNowPressed = await pressButton(session, '[data-page-refresh-state]', RUN_NOW, 'C: Run now')
    const afterNow = await waitFor(() => rs114Data(session, ws, subject.slug), d => (d?.runs ?? 0) > runsBefore, { timeoutMs: 60_000, intervalMs: 1_000 }).catch(() => null)
    await Bun.sleep(1_000)
    const nowRan = refreshRunLines(readAudit(configDir, nowStart), subject.slug)
    run.check('C: Run now runs it again and writes automation_script_ran with the approved digest',
      runNowPressed === 'pressed' && (afterNow?.runs ?? 0) > runsBefore && nowRan.some(l => l.fields.sha256 === digest && l.fields.trigger === 'page-refresh'),
      `pressed ${runNowPressed}; runs ${runsBefore} -> ${afterNow?.runs ?? null}; run lines ${JSON.stringify(nowRan.map(l => l.fields))}`)
    const refreshLeak = scoreEnvLeak(parentDenied, afterNow?.envNames ?? cData?.envNames ?? null)
    run.observe('F: the refresh child\'s env names', afterNow?.envNames ?? cData?.envNames ?? null)
    run.check('F: no denied parent name reaches the refresh child', refreshLeak.ok, refreshLeak.detail)

    // ================= D - an edit re-asks, and the next tick runs nothing ===
    const runsD = (await rs114Data(session, ws, subject.slug))?.runs ?? 0
    const dStart = Date.now()
    appendFileSync(scriptFile, '// edited by RS-114\n')
    const liveBar = await waitFor(() => readBar(session), bar => bar?.state === 'changed', { timeoutMs: 15_000, intervalMs: 500 }).catch(() => readBar(session))
    const hostD = await refreshStatus(session, ws, subject.slug)
    const runNowOffered = !!liveBar && RUN_NOW.some(label => liveBar.text.includes(label))
    const refusedNow = await session.call<{ started: boolean; error?: string }>(`
      return await window.electronAPI.runPageRefreshNow(${JSON.stringify(ws)}, ${JSON.stringify(subject.slug)})
    `)
    run.observe('D: after the edit', { host: hostD?.state, bar: liveBar, runNowOffered, refusedNow })
    run.check('D: the host reads the edited script changed', hostD?.state === 'changed', `getPageRefreshStatus ${JSON.stringify(hostD?.state)}`)
    run.check('D: the OPEN bar turns changed without being reopened and offers no Run now', liveBar?.state === 'changed' && !runNowOffered,
      `bar ${JSON.stringify(liveBar)}`)
    run.check('D: runPageRefreshNow refuses, naming the state', refusedNow.started === false && /changed/.test(refusedNow.error ?? ''),
      JSON.stringify(refusedNow))
    const tickD = tickToWaitFor(Date.now())
    await sleepUntil(tickD + TICK_GRACE_MS)
    const dData = await rs114Data(session, ws, subject.slug)
    const dRan = refreshRunLines(readAudit(configDir, dStart), subject.slug)
    run.observe('D: across the tick', { tick: new Date(tickD).toISOString(), runs: dData?.runs ?? null, ranLines: dRan.length })
    run.check('D: the edited refresh does not run on its tick', (dData?.runs ?? 0) === runsD && dRan.length === 0,
      `runs ${runsD} -> ${dData?.runs ?? null}; run lines since the edit ${dRan.length}`)
  } finally {
    await navigateRoute(session, 'allSessions').catch(() => undefined)
    const cleanup: Record<string, string> = {}
    if (owned.automationId) {
      cleanup[`automation ${owned.automationId}`] = await session.call<string>(`
        try { await window.electronAPI.deleteAutomation(${JSON.stringify(ws)}, ${JSON.stringify(owned.automationId)}); return 'deleted' }
        catch (e) { return 'delete failed: ' + String(e && e.message || e).slice(0, 160) }
      `).catch(error => `delete failed: ${String(error).slice(0, 160)}`)
    }
    for (const slug of ownedPages) {
      cleanup[`page ${slug}`] = await session.call<string>(`
        try { await window.electronAPI.deletePage(${JSON.stringify(ws)}, ${JSON.stringify(slug)}); return 'deleted' }
        catch (e) { return 'delete failed: ' + String(e && e.message || e).slice(0, 160) }
      `).catch(error => `delete failed: ${String(error).slice(0, 160)}`)
    }
    for (const id of ownedSessions) {
      cleanup[`session ${id}`] = await session.call<string>(`
        try { await window.electronAPI.deleteSession(${JSON.stringify(id)}); return 'deleted' }
        catch (e) { return 'delete failed: ' + String(e && e.message || e).slice(0, 160) }
      `).catch(error => `delete failed: ${String(error).slice(0, 160)}`)
    }
    rmSync(join(root, `rs114-${stamp}`), { recursive: true, force: true })
    run.observe('cleanup', cleanup)
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
