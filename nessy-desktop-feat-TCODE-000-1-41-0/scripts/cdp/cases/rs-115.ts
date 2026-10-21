/**
 * RS-115 (plan row UA9.5, 1.42.0 upstream adoption) - a page's source actions on the shipped build: a grant asked
 * for from inside the page and approved in the host's dialog, the action it allows running through the broker and
 * leaving its audit lines, the grant going stale when the page's content changes and dead when the user revokes
 * it, and the two activation binds of UA9.3 - a timer cannot act after a click on the HOST, and a timer cannot open
 * a grant dialog at all.
 *
 * The case content is UA9.3's sitting ASK (`work/wi16/sitting-asks.md`), arm for arm.
 *
 * ## What it proves (one page, case-authored through the app's own `pages:create`)
 *
 * T.  **A timer-driven grant request opens no dialog.** The page posts a `grant-request` from a `setTimeout` on
 *     load, with no gesture anywhere. No `[role="dialog"]` appears in the watch window, and the host answers the
 *     page with its current grants instead (the refusal path of `checkPageGrantRequest`: positive evidence the
 *     request was read, not lost). The positive control is arm G: the SAME descriptor asked from a click inside
 *     the page does open the dialog. UA12.112: the refusal is audited (`page_grant_request_refused`, stage
 *     `renderer-gate`).
 * G.  **Grant.** A click on the page's "Ask" posts the request; the dialog shows the HOST's descriptor as the
 *     authority (`script bun <path>`, `sha256 <the file's digest>`) and the page's own words under their label;
 *     "Allow" issues a ledger grant (`pages:listGrants`) pinned to that sha256 and to the page's content digest.
 * A.  **Act, and the audit lines.** A click on "Act" runs the script once (its own `runs.log` gains a line), the
 *     page gets `ok: true`, `<config>/logs/page-actions.jsonl` gains `page_action_executed` (ok, the grant id) and
 *     `privileged-actions.jsonl` gains `automation_script_ran` (`trigger: page-action`, the pinned sha256).
 * F.  **A timer action after a host-toolbar click is refused** (`frame-focus-required`). A click on the page's
 *     "Arm" schedules the action 3 s later; the case then clicks the page's name in the HOST's toolbar, which
 *     takes focus off the frame while giving the host window a fresh activation. The action is refused before the
 *     broker and the script does not run. A script action is mutating like an API POST (`isMutatingInvocation`):
 *     the gate under test is the same `checkPageAction` branch, without needing an API source on the rig.
 *     UA12.112 (the row's control): the refusal reaches `page-actions.jsonl` as `page_action_rejected`,
 *     stage `renderer-gate`, with the frame's requestId.
 * S.  **A content edit makes the grant stale.** The case rewrites the page's content (`pages:setContent`, the page
 *     re-renders under a new lease); the grant now reads stale (its content digest is the old one), the page's
 *     re-sent action with the remembered grant id is refused `grant-stale`, nothing runs, and the refusal is
 *     audited (`page_action_rejected`).
 * R.  **Revoke.** A second grant (G again, on the new content) runs once; the user removes it from the page's
 *     "Approved actions" dialog (More menu); `pages:listGrants` no longer has it, the page's next action with it is
 *     refused `grant-not-found`, nothing runs, and the refusal is audited.
 *
 * ## Detectors
 *
 * - The script's own `runs.log` line count is the run count - an independent instrument beside the page's result
 *   and the two audit files.
 * - In-page readings travel by `postMessage` (protocol `rs115-probe`) to a main-world inbox that accepts them only
 *   from the page's own `<iframe>`; PageFrame ignores the foreign protocol.
 * - The dialogs, the More menu and the page's buttons are pressed as real pointer clicks at measured rects,
 *   matched by their English or Russian labels.
 *
 * ## What it writes
 *
 * Under the run's OWN config dir only ({@link writableConfigDir}): the page (grants revoked, then deleted through
 * `pages:delete`) and `<workspace>/rs115-<stamp>/` (the script and its log, removed). No session, no turn.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { focusWindow, type CdpSession } from '../lib/connect.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { writableConfigDir } from '../lib/runtime-session-log.ts'
import { assertElectronApi, waitFor } from '../lib/state.ts'
import { pressKey } from '../lib/keys.ts'
import { clickAt } from '../lib/viewport.ts'
import type { CaseMeta } from '../lib/sitting.ts'

const ID = 'RS-115'
const TITLE = 'Page actions: grant from a click, act with audit lines, a timer cannot act after a host click or open a dialog, content edit stales, revoke kills'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UA9.5',
  // No turn and no card: grants and actions are host-side and identical under every runtime (as RS-34 declares).
  runtimes: ['pi', 'claude', 'codex'],
  credentials:
    'owner: none beyond a running packaged app launched with its own NESSY_CONFIG_DIR, exported to this case too. '
    + 'No turn, no card, no key, token or credential file is read.',
} as const satisfies CaseMeta

const PROBE_PROTOCOL = 'rs115-probe'
/** The load-time grant request fires this long after `init` - no gesture anywhere in between. */
export const TIMER_REQUEST_MS = 3_000
/**
 * The armed action fires this long after "Arm": late enough that the case's host-toolbar click lands first (checked:
 * the click's main-world time precedes the send), early enough to sit inside that click's 5 s transient activation.
 */
export const TIMER_ACT_MS = 3_000
/** How long the case watches for a dialog after the timer request was sent. */
const DIALOG_WATCH_MS = 4_000

// ============================================================================
// Pure pieces (pinned by scripts/cdp/rs-115-actions-score.test.ts)
// ============================================================================

/** The granted script: appends one line to `<dir>/runs.log` in the workspace and prints a marker. */
export function actScript(dir: string): string {
  return [
    "import { appendFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    `appendFileSync(join(process.env.NESSY_WORKSPACE_PATH ?? process.cwd(), ${JSON.stringify(dir)}, 'runs.log'), \`ran \${Date.now()}\\n\`)`,
    "console.log('RS115-ACTED')",
    '',
  ].join('\n')
}

/**
 * The page. NO doctype (the builder's). `remembered` is a grant id the page acts with before any grant arrives (arm
 * S: the case writes the old id into the new content); `timerRequest` arms the load-time grant request (arm T).
 */
export function actionsPageHtml(opts: { script: string; remembered: string | null; timerRequest: boolean }): string {
  return `<html><head><meta charset="utf-8"><title>RS-115 actions</title>
<style>button { font-size: 18px; padding: 16px 24px; margin: 12px; }</style></head><body>
<h1>RS-115 actions</h1>
<button id="ask">Ask</button><button id="act">Act</button><button id="arm">Arm</button>
<script>
  const P = 'nessy-pages/v1'
  const post = (type, extra) => window.parent.postMessage(Object.assign({ protocol: '${PROBE_PROTOCOL}', type }, extra || {}), '*')
  const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
  const ACTION = { kind: 'script', script: ${JSON.stringify(opts.script)} }
  let nonce = null
  let lastGrantId = ${JSON.stringify(opts.remembered)}
  let seq = 0
  const hello = () => post('hello', { ask: rect('ask'), act: rect('act'), arm: rect('arm'), lastGrantId, hasNonce: nonce !== null })
  const adopt = grants => { const g = (grants || []).find(x => x.action && x.action.kind === 'script' && x.action.script === ACTION.script); if (g) lastGrantId = g.id }
  const act = (label) => {
    const requestId = label + '-' + (++seq) + '-' + Math.random().toString(36).slice(2, 8)
    post('act-sent', { label, requestId, grantId: lastGrantId })
    window.parent.postMessage({ protocol: P, type: 'action', requestId, nonce, grantId: lastGrantId, invocation: { kind: 'script' } }, '*')
  }
  window.addEventListener('message', (event) => {
    const msg = event.data
    if (!msg || msg.protocol !== P) return
    if (msg.type === 'init') {
      const first = nonce === null
      nonce = msg.payload.nonce
      adopt(msg.payload.grants)
      post('init', { grants: (msg.payload.grants || []).map(g => g.id) })
      hello()
      if (first && ${opts.timerRequest ? 'true' : 'false'}) {
        setTimeout(() => {
          post('timer-request-sent')
          window.parent.postMessage({ protocol: P, type: 'grant-request', nonce, requests: [{ key: 'timer', description: 'RS-115 timer request', action: ACTION }] }, '*')
        }, ${TIMER_REQUEST_MS})
      }
    }
    if (msg.type === 'grants') { adopt(msg.payload.grants); post('grants', { grants: (msg.payload.grants || []).map(g => g.id), lastGrantId }) }
    if (msg.type === 'action-result') post('result', { result: msg.payload.result })
  })
  document.getElementById('ask').addEventListener('click', () => {
    post('ask-sent')
    window.parent.postMessage({ protocol: P, type: 'grant-request', nonce, requests: [{ key: 'ask-' + (++seq), description: 'RS-115 asks to run its script', action: ACTION }] }, '*')
  })
  document.getElementById('act').addEventListener('click', () => act('act'))
  document.getElementById('arm').addEventListener('click', () => { post('armed'); setTimeout(() => act('timer'), ${TIMER_ACT_MS}) })
  window.parent.postMessage({ protocol: P, type: 'ready' }, '*')
  setTimeout(hello, 300)
</script></body></html>`
}

export interface ActionResultRead { ok?: boolean; error?: string }

/** Arm F: the refusal must be the FOCUS gate; an activation refusal means the focus gate was never reached. */
export function scoreTimerAction(result: ActionResultRead | null): { ok: boolean; detail: string } {
  if (!result) return { ok: false, detail: 'UNMEASURED - the page got no result for the timer action' }
  if (result.ok) return { ok: false, detail: 'the timer action RAN after a click on the host toolbar' }
  const error = result.error ?? ''
  if (error.startsWith('frame-focus-required')) return { ok: true, detail: error }
  if (error.startsWith('user-activation-required')) {
    return { ok: false, detail: `UNMEASURED - refused for activation, so the focus gate was never reached: ${error}` }
  }
  return { ok: false, detail: `refused for another reason: ${error}` }
}

/** Arm T: no dialog AND the host's grants reply after the request (the request was read and refused). */
export function scoreTimerGrantRequest(evidence: { dialogSeen: boolean; grantsReplyAfter: boolean }): { ok: boolean; detail: string } {
  if (evidence.dialogSeen) return { ok: false, detail: 'a dialog opened for a grant request no gesture made' }
  if (!evidence.grantsReplyAfter) {
    return { ok: false, detail: 'UNMEASURED - no dialog, but the host never answered the request either, so it may never have been read' }
  }
  return { ok: true, detail: 'no dialog; the host answered with the current grants' }
}

/**
 * UA12.112 - a refusal the RENDERER's gate decided must reach `page-actions.jsonl`: an action refusal
 * as `page_action_rejected` with `stage: 'renderer-gate'` (the requestId pins THE refusal's line), a
 * refused grant request as `page_grant_request_refused` with the same stage marker (that event can
 * only come from this path).
 */
export function scoreRendererGateAudit(
  lines: PageAuditLine[],
  want: { event: string; requestId?: string; code?: string },
): { ok: boolean; detail: string } {
  const hits = lines.filter(line => line.event === want.event && line.fields.stage === 'renderer-gate'
    && (want.requestId === undefined || line.fields.requestId === want.requestId)
    && (want.code === undefined || line.fields.code === want.code))
  if (hits.length > 0) return { ok: true, detail: JSON.stringify(hits[0]!.fields).slice(0, 300) }
  const sameEvent = lines.filter(line => line.event === want.event)
  if (sameEvent.length > 0) {
    return { ok: false, detail: `a ${want.event} line is there but not as a renderer-gate refusal: ${JSON.stringify(sameEvent.map(line => line.fields)).slice(0, 300)}` }
  }
  return { ok: false, detail: `no ${want.event} line at all in the window` }
}

/** Arm G: the dialog shows the host descriptor (path and the file's sha256) and labels the page's words. */
export function scoreGrantDialog(text: string, script: string, sha256: string): { ok: boolean; detail: string } {
  const missing = [`script bun ${script}`, `sha256 ${sha256}`, 'RS-115 asks to run its script'].filter(needle => !text.includes(needle))
  if (missing.length > 0) return { ok: false, detail: `the dialog lacks ${JSON.stringify(missing)}: ${JSON.stringify(text.slice(0, 300))}` }
  return { ok: true, detail: 'host descriptor with the pinned sha256, and the page\'s own words' }
}

export interface PageAuditLine { event: string; ts: number; fields: Record<string, unknown> }

/** The page broker's audit lines for one page at or after `sinceMs` (torn lines skipped). */
export function pageAuditLines(text: string, slug: string, sinceMs: number): PageAuditLine[] {
  const out: PageAuditLine[] = []
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    try {
      const fields = JSON.parse(raw) as Record<string, unknown>
      const ts = Date.parse(String(fields.timestamp ?? ''))
      if (!Number.isFinite(ts) || ts < sinceMs || fields.pageSlug !== slug) continue
      out.push({ event: String(fields.event ?? ''), ts, fields })
    } catch { /* torn line */ }
  }
  return out
}

export function sha256Hex(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

// ============================================================================
// The app's own channels, the inbox, clicks
// ============================================================================

interface GrantRead { id: string; script?: string; scriptSha256?: string; contentDigest: string; expiresAt: number }

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

async function grants(session: CdpSession, ws: string, slug: string): Promise<GrantRead[]> {
  return session.call<GrantRead[]>(`
    return (await window.electronAPI.listPageGrants(${JSON.stringify(ws)}, ${JSON.stringify(slug)})).map(g => ({
      id: g.id, script: g.action && g.action.script, scriptSha256: g.scriptSha256, contentDigest: g.contentDigest, expiresAt: g.expiresAt }))
  `)
}

async function contentDigest(session: CdpSession, ws: string, slug: string): Promise<string | undefined> {
  return session.call<string | undefined>(`
    return (await window.electronAPI.getPageContent(${JSON.stringify(ws)}, ${JSON.stringify(slug)})).contentDigest
  `)
}

async function navigateRoute(session: CdpSession, route: string): Promise<void> {
  await session.call<null>(`
    window.dispatchEvent(new CustomEvent('nessy-agent-navigate', { detail: { route: ${JSON.stringify(route)} }, bubbles: true }))
    return null
  `)
}

async function installInbox(session: CdpSession): Promise<void> {
  await session.call<null>(`
    if (!window.__rs115) {
      window.__rs115 = { messages: [] }
      window.addEventListener('message', event => {
        const msg = event.data
        if (!msg || msg.protocol !== ${JSON.stringify(PROBE_PROTOCOL)}) return
        const frame = Array.from(document.querySelectorAll('iframe')).find(f => f.contentWindow === event.source)
        if (!frame) return
        window.__rs115.messages.push({ page: frame.getAttribute('title'), at: Date.now(), msg })
      })
    }
    return null
  `)
}

interface InboxMessage { page: string; at: number; msg: Record<string, unknown> }

async function inbox(session: CdpSession, pageName: string, type?: string): Promise<InboxMessage[]> {
  return session.call<InboxMessage[]>(`
    return (window.__rs115 ? window.__rs115.messages : [])
      .filter(m => m.page === ${JSON.stringify(pageName)} && (${JSON.stringify(type ?? null)} === null || m.msg.type === ${JSON.stringify(type ?? null)}))
  `)
}

type Rect = { x: number; y: number; width: number; height: number }

async function clickInFrame(session: CdpSession, pageName: string, button: 'ask' | 'act' | 'arm', label: string): Promise<void> {
  const hellos = await inbox(session, pageName, 'hello')
  const rect = hellos[hellos.length - 1]?.msg[button] as Rect | undefined
  if (!rect) throw new Error(`${label}: the page never reported its buttons`)
  const frame = await session.call<{ x: number; y: number } | null>(`
    const el = document.querySelector(${JSON.stringify(`iframe[title=${JSON.stringify(pageName)}]`)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y }
  `)
  if (!frame) throw new Error(`${label}: the page's frame is not on screen`)
  await clickAt(session, { x: Math.round(frame.x + rect.x + rect.width / 2), y: Math.round(frame.y + rect.y + rect.height / 2) }, label)
}

/** The rect of the first element under `scope` matched by tag and one of `labels` (trimmed innerText), or null. */
async function rectOf(session: CdpSession, scope: string, tags: string, labels: readonly string[], exclude: readonly string[] = []): Promise<{ x: number; y: number } | null> {
  return session.call<{ x: number; y: number } | null>(`
    const roots = Array.from(document.querySelectorAll(${JSON.stringify(scope)}))
    const root = roots[roots.length - 1]
    if (!root) return null
    const want = ${JSON.stringify(labels)}
    const skip = ${JSON.stringify(exclude)}
    const el = Array.from(root.querySelectorAll(${JSON.stringify(tags)})).find(x => {
      const own = (x.innerText || '').trim()
      const ctx = (x.closest('li') || x).innerText || ''
      return want.includes(own) && !skip.some(s => ctx.includes(s)) && !x.disabled
    })
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  `)
}

async function dialogText(session: CdpSession): Promise<string | null> {
  return session.call<string | null>(`
    const d = Array.from(document.querySelectorAll('[role="dialog"]')).pop(); return d ? (d.innerText || '') : null
  `)
}

/** Wait for the result of one action the page sent with `label`, sent after `afterMs`. */
async function resultOf(
  session: CdpSession, pageName: string, label: string, afterMs: number, timeoutMs = 30_000,
): Promise<{ requestId: string; sentAt: number; result: ActionResultRead | null }> {
  const sent = await waitFor(() => inbox(session, pageName, 'act-sent'),
    rows => rows.some(r => r.at >= afterMs && r.msg.label === label), { timeoutMs: 15_000, intervalMs: 250 })
    .then(rows => rows.filter(r => r.at >= afterMs && r.msg.label === label).pop()!).catch(() => null)
  if (!sent) return { requestId: '', sentAt: 0, result: null }
  const requestId = String(sent.msg.requestId)
  const got = await waitFor(() => inbox(session, pageName, 'result'),
    rows => rows.some(r => (r.msg.result as { requestId?: string } | undefined)?.requestId === requestId), { timeoutMs, intervalMs: 250 })
    .then(rows => rows.find(r => (r.msg.result as { requestId?: string }).requestId === requestId)!.msg.result as ActionResultRead)
    .catch(() => null)
  return { requestId, sentAt: sent.at, result: got }
}

export const ALLOW = ['Allow', 'Разрешить']
export const MORE = ['More', 'Ещё']
export const MANAGE = ['Approved actions', 'Разрешённые действия']
export const REMOVE = ['Remove', 'Удалить']
export const STALE = ['For an older version of this page', 'Для прежней версии страницы']
export const RENAME = ['Rename', 'Переименовать']

// ============================================================================
// The drive
// ============================================================================

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  await ensureDarkTheme(session)
  run.observe('window', await focusWindow(session))
  const configDir = writableConfigDir('RS-115\'s page and script')
  const ws = await activeWorkspaceId(session)
  const root = process.env.NESSY_CDP_RS115_WORKSPACE_ROOT?.trim() || join(configDir, 'workspaces', ws)
  if (!existsSync(root)) blocked(`the workspace root ${root} does not exist (set NESSY_CDP_RS115_WORKSPACE_ROOT)`)
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '')
  const dir = `rs115-${stamp}`
  const script = `${dir}/act.ts`
  const runsLog = join(root, dir, 'runs.log')
  const runs = () => (existsSync(runsLog) ? readFileSync(runsLog, 'utf8').split('\n').filter(Boolean).length : 0)
  mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, script), actScript(dir))
  const scriptSha = sha256Hex(readFileSync(join(root, script)))
  const pageAudit = (since: number) => {
    const file = join(configDir, 'logs', 'page-actions.jsonl')
    return existsSync(file) ? pageAuditLines(readFileSync(file, 'utf8'), slug, since) : []
  }
  const ranLines = (since: number) => {
    const file = join(configDir, 'logs', 'privileged-actions.jsonl')
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line) as Record<string, unknown>] } catch { return [] }
    }).filter(f => Date.parse(String(f.timestamp)) >= since && f.event === 'automation_script_ran' && f.trigger === 'page-action' && f.script === script)
  }

  const name = `RS-115 actions ${stamp}`
  let slug = ''
  try {
    slug = await session.call<string>(`
      const created = await window.electronAPI.createPage(${JSON.stringify(ws)}, {
        name: ${JSON.stringify(name)}, kind: 'interactive', content: ${JSON.stringify(actionsPageHtml({ script, remembered: null, timerRequest: true }))},
      })
      return created.slug
    `)
    await installInbox(session)
    // No click of the case precedes the timer request by less than the 5 s transient activation.
    await Bun.sleep(6_000)

    // ================= T - a timer-driven grant request opens no dialog =====
    const tStart = Date.now()
    await navigateRoute(session, `pages/page/${slug}`)
    const init = await waitFor(() => inbox(session, name, 'init'), rows => rows.length > 0, { timeoutMs: 20_000, intervalMs: 250 }).catch(() => [])
    run.require('the page rendered and received init', init.length > 0, 'no init from the page within 20 s')
    const sent = await waitFor(() => inbox(session, name, 'timer-request-sent'), rows => rows.length > 0, { timeoutMs: TIMER_REQUEST_MS + 10_000, intervalMs: 200 })
      .then(rows => rows[0]!).catch(() => null)
    const activationAtSend = await session.call<boolean>('return navigator.userActivation ? navigator.userActivation.isActive : false')
    let dialogSeen = false
    const watchUntil = Date.now() + DIALOG_WATCH_MS
    while (Date.now() < watchUntil) {
      if ((await dialogText(session)) !== null) { dialogSeen = true; break }
      await Bun.sleep(200)
    }
    const replies = sent ? (await inbox(session, name, 'grants')).filter(r => r.at >= sent.at) : []
    const tScore = scoreTimerGrantRequest({ dialogSeen, grantsReplyAfter: replies.length > 0 })
    run.observe('T: the timer grant request', { sent: sent !== null, activationAtSend, dialogSeen, replies: replies.length })
    run.check('T: a timer-driven grant request opens no dialog', sent !== null && tScore.ok, sent ? tScore.detail : 'the page never sent its timer request')
    // UA12.112 - the refusal the gate decided here must be in the trail (poll bounded: the audit
    // write is fire-and-forget, and T's line is likely the file's first).
    let tAuditScore = scoreRendererGateAudit(pageAudit(tStart), { event: 'page_grant_request_refused' })
    for (let attempt = 0; attempt < 50 && !tAuditScore.ok; attempt++) {
      await Bun.sleep(200)
      tAuditScore = scoreRendererGateAudit(pageAudit(tStart), { event: 'page_grant_request_refused' })
    }
    run.observe('T: the refusal in the audit', pageAudit(tStart).map(line => line.fields))
    run.check('T: the refused grant request reaches page-actions.jsonl (page_grant_request_refused, stage renderer-gate)',
      tAuditScore.ok, tAuditScore.detail)

    // ================= G - a click asks; the dialog; Allow =================
    const grantFromClick = async (label: string): Promise<GrantRead | null> => {
      const before = (await grants(session, ws, slug)).map(g => g.id)
      await clickInFrame(session, name, 'ask', `${label}: Ask`)
      const text = await waitFor(() => dialogText(session), t => t !== null, { timeoutMs: 10_000, intervalMs: 250 }).catch(() => null)
      const score = scoreGrantDialog(text ?? '', script, scriptSha)
      run.observe(`${label}: the dialog`, text?.slice(0, 500) ?? null)
      run.check(`${label}: a click inside the page opens the dialog with the host's descriptor and pinned sha256`, text !== null && score.ok,
        text === null ? 'no dialog within 10 s of the click' : score.detail)
      const allow = text !== null ? await rectOf(session, '[role="dialog"]', 'button', ALLOW) : null
      if (allow) await clickAt(session, allow, `${label}: Allow`)
      const issued = await waitFor(() => grants(session, ws, slug), list => list.some(g => !before.includes(g.id)), { timeoutMs: 10_000, intervalMs: 500 })
        .then(list => list.find(g => !before.includes(g.id))!).catch(() => null)
      const digest = await contentDigest(session, ws, slug)
      run.observe(`${label}: the grant`, issued)
      run.check(`${label}: Allow issues a ledger grant pinned to the script's sha256 and the page's content`,
        !!allow && issued?.script === script && issued.scriptSha256 === scriptSha && issued.contentDigest === digest,
        !allow ? 'no Allow button in the dialog' : `grant ${JSON.stringify(issued)}; content digest ${digest}`)
      if (issued) await waitFor(() => inbox(session, name, 'grants'), rows => rows.some(r => r.msg.lastGrantId === issued.id), { timeoutMs: 10_000, intervalMs: 250 }).catch(() => null)
      return issued
    }
    const g1 = await grantFromClick('G')
    run.require('G: a grant to act with', g1 !== null, 'no grant was issued; A, F, S and R need one')

    // ================= A - act, and the audit lines =========================
    const aStart = Date.now()
    await clickInFrame(session, name, 'act', 'A: Act')
    const aResult = await resultOf(session, name, 'act', aStart)
    await Bun.sleep(1_000)
    const aAudit = pageAudit(aStart)
    const aRan = ranLines(aStart)
    run.observe('A: act', { result: aResult.result, runs: runs(), pageAudit: aAudit.map(l => l.fields), ran: aRan })
    run.check('A: the granted action runs once and the page gets ok', aResult.result?.ok === true && runs() === 1,
      `result ${JSON.stringify(aResult.result)}; runs.log ${runs()}`)
    run.check('A: page-actions.jsonl records the executed action with its grant',
      aAudit.some(l => l.event === 'page_action_executed' && l.fields.ok === true && l.fields.grantId === g1!.id && l.fields.requestId === aResult.requestId),
      `page audit ${JSON.stringify(aAudit.map(l => l.fields)).slice(0, 400)}`)
    run.check('A: privileged-actions.jsonl records the script run with the pinned sha256', aRan.some(f => f.sha256 === scriptSha && f.success === true),
      `run lines ${JSON.stringify(aRan).slice(0, 400)}`)

    // ================= F - a timer action after a host-toolbar click =======
    const fStart = Date.now()
    await clickInFrame(session, name, 'arm', 'F: Arm')
    await waitFor(() => inbox(session, name, 'armed'), rows => rows.some(r => r.at >= fStart), { timeoutMs: 5_000, intervalMs: 100 }).catch(() => null)
    const toolbar = await session.call<{ x: number; y: number } | null>(`
      const want = ${JSON.stringify(RENAME)}
      const el = Array.from(document.querySelectorAll('span[title]')).find(s => want.includes(s.getAttribute('title')) && (s.innerText || '').trim() === ${JSON.stringify(name)})
      if (!el) return null
      const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    `)
    if (toolbar) await clickAt(session, toolbar, 'F: the page name in the host toolbar')
    const focusAfter = await session.call<{ active: string; activation: boolean; at: number }>(`
      const a = document.activeElement
      return { active: a ? a.tagName.toLowerCase() : 'none', activation: navigator.userActivation ? navigator.userActivation.isActive : false, at: Date.now() }
    `)
    const fResult = await resultOf(session, name, 'timer', fStart)
    const fScore = scoreTimerAction(fResult.result)
    run.observe('F: timer act', { toolbar, focusAfter, result: fResult.result, runs: runs() })
    run.check('F: the host-toolbar click took focus off the frame before the timer sent its action',
      !!toolbar && focusAfter.active !== 'iframe' && fResult.sentAt > focusAfter.at,
      !toolbar ? 'UNMEASURED - the page name was not found in the host toolbar'
        : fResult.sentAt <= focusAfter.at ? `UNMEASURED - the timer sent its action (${fResult.sentAt}) before the toolbar click was read (${focusAfter.at})`
          : `activeElement ${focusAfter.active}`)
    run.check('F: a timer action after a host-toolbar click is refused frame-focus-required, and nothing runs', fScore.ok && runs() === 1,
      `${fScore.detail}; runs.log ${runs()}`)
    // UA12.112 - the row's control: the refusal, decided renderer-side, is in the trail with the
    // frame's requestId and the focus-gate code.
    const fAuditScore = scoreRendererGateAudit(pageAudit(fStart), { event: 'page_action_rejected', requestId: fResult.requestId, code: 'frame-focus-required' })
    run.observe('F: the refusal in the audit', pageAudit(fStart).map(line => line.fields))
    run.check('F: the renderer-gate refusal reaches page-actions.jsonl (page_action_rejected, stage renderer-gate, frame-focus-required)',
      fAuditScore.ok, fAuditScore.detail)

    // ================= S - a content edit makes the grant stale ============
    const sStart = Date.now()
    const initsBefore = (await inbox(session, name, 'init')).length
    await session.call<null>(`
      await window.electronAPI.setPageContent(${JSON.stringify(ws)}, ${JSON.stringify(slug)},
        ${JSON.stringify(actionsPageHtml({ script, remembered: g1!.id, timerRequest: false }))})
      return null
    `)
    const reInit = await waitFor(() => inbox(session, name, 'init'), rows => rows.length > initsBefore, { timeoutMs: 20_000, intervalMs: 250 }).then(() => true).catch(() => false)
    await Bun.sleep(1_000)
    const newDigest = await contentDigest(session, ws, slug)
    const g1Now = (await grants(session, ws, slug)).find(g => g.id === g1!.id) ?? null
    run.check('S: after the content edit the grant reads stale (bound to the old content)', reInit && !!g1Now && g1Now.contentDigest !== newDigest,
      `re-rendered ${reInit}; grant ${JSON.stringify(g1Now)}; content digest now ${newDigest}`)
    await clickInFrame(session, name, 'act', 'S: Act with the old grant')
    const sResult = await resultOf(session, name, 'act', sStart)
    await Bun.sleep(1_000)
    const sAudit = pageAudit(sStart)
    run.observe('S: act after the edit', { result: sResult.result, runs: runs(), pageAudit: sAudit.map(l => l.fields) })
    run.check('S: the stale grant is refused grant-stale, nothing runs, and the refusal is audited',
      sResult.result?.ok === false && (sResult.result.error ?? '').startsWith('grant-stale') && runs() === 1
        && sAudit.some(l => l.event === 'page_action_rejected' && l.fields.code === 'grant-stale'),
      `result ${JSON.stringify(sResult.result)}; runs.log ${runs()}; audit ${JSON.stringify(sAudit.map(l => l.fields)).slice(0, 300)}`)

    // ================= R - revoke ==========================================
    const g2 = await grantFromClick('R')
    run.require('R: a second grant on the new content', g2 !== null, 'no second grant was issued')
    const r1Start = Date.now()
    await clickInFrame(session, name, 'act', 'R: Act with the new grant')
    const r1 = await resultOf(session, name, 'act', r1Start)
    run.check('R: the new grant runs the script', r1.result?.ok === true && runs() === 2, `result ${JSON.stringify(r1.result)}; runs.log ${runs()}`)
    // The More button of THIS page's header (the row that carries the page's name), not another view's.
    const more = await session.call<{ x: number; y: number } | null>(`
      const names = ${JSON.stringify(RENAME)}
      const title = Array.from(document.querySelectorAll('span[title]')).find(s => names.includes(s.getAttribute('title')) && (s.innerText || '').trim() === ${JSON.stringify(name)})
      const header = title && title.parentElement
      const want = ${JSON.stringify(MORE)}
      const b = header && Array.from(header.querySelectorAll('button[aria-label]')).find(x => want.includes(x.getAttribute('aria-label')))
      if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    `)
    let revokePath = 'no More button'
    if (more) {
      await clickAt(session, more, 'R: More')
      const item = await waitFor(() => rectOf(session, 'body', '[role="menuitem"]', MANAGE), r => r !== null, { timeoutMs: 5_000, intervalMs: 250 }).catch(() => null)
      if (!item) revokePath = 'no Approved actions item'
      else {
        await clickAt(session, item, 'R: Approved actions')
        const remove = await waitFor(() => rectOf(session, '[role="dialog"]', 'button', REMOVE, STALE), r => r !== null, { timeoutMs: 5_000, intervalMs: 250 }).catch(() => null)
        if (!remove) revokePath = 'no Remove button on a usable grant'
        else { await clickAt(session, remove, 'R: Remove'); revokePath = 'pressed' }
      }
    }
    const gone = await waitFor(() => grants(session, ws, slug), list => !list.some(g => g.id === g2!.id), { timeoutMs: 10_000, intervalMs: 500 }).then(() => true).catch(() => false)
    await pressKey(session, 'Escape')
    await Bun.sleep(1_000)
    run.check('R: Remove in the page\'s Approved actions revokes the grant', revokePath === 'pressed' && gone, `${revokePath}; gone from listGrants: ${gone}`)
    const r2Start = Date.now()
    await clickInFrame(session, name, 'act', 'R: Act with the revoked grant')
    const r2 = await resultOf(session, name, 'act', r2Start)
    await Bun.sleep(1_000)
    const rAudit = pageAudit(r2Start)
    run.observe('R: act after revoke', { result: r2.result, runs: runs(), pageAudit: rAudit.map(l => l.fields) })
    run.check('R: the revoked grant is refused grant-not-found, nothing runs, and the refusal is audited',
      r2.result?.ok === false && (r2.result.error ?? '').startsWith('grant-not-found') && runs() === 2
        && rAudit.some(l => l.event === 'page_action_rejected' && l.fields.code === 'grant-not-found'),
      `result ${JSON.stringify(r2.result)}; runs.log ${runs()}; audit ${JSON.stringify(rAudit.map(l => l.fields)).slice(0, 300)}`)
  } finally {
    await navigateRoute(session, 'allSessions').catch(() => undefined)
    const cleanup: Record<string, string> = {}
    if (slug) {
      cleanup.grants = await session.call<string>(`
        const ws = ${JSON.stringify(ws)}, slug = ${JSON.stringify(slug)}
        try { const all = await window.electronAPI.listPageGrants(ws, slug); for (const g of all) await window.electronAPI.revokePageGrant(ws, slug, g.id); return 'revoked ' + all.length }
        catch (e) { return 'revoke failed: ' + String(e && e.message || e).slice(0, 160) }
      `).catch(error => `revoke failed: ${String(error).slice(0, 160)}`)
      cleanup.page = await session.call<string>(`
        try { await window.electronAPI.deletePage(${JSON.stringify(ws)}, ${JSON.stringify(slug)}); return 'deleted' }
        catch (e) { return 'delete failed: ' + String(e && e.message || e).slice(0, 160) }
      `).catch(error => `delete failed: ${String(error).slice(0, 160)}`)
    }
    rmSync(join(root, dir), { recursive: true, force: true })
    run.observe('cleanup', cleanup)
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
