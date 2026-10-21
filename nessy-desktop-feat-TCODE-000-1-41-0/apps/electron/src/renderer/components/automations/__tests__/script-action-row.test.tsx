/**
 * UA8.3 — the script action row and the page refresh bar (ours; upstream v0.13.4 shows neither).
 *
 * - positive: a script action renders its command line, runtime and approval state; an unapproved one offers
 *   "Approve", and approving calls the host with the digest the row SHOWED (the host refuses a swap since —
 *   `automations-approve-script.test.ts` records the ledger entry; the click path is read from source); an approved
 *   one offers no approval; a saved
 *   script-only automation is listed (it used to be filtered out); a refresh bar shows its schedule and state,
 *   and an approved refresh offers "Run now";
 * - negative: a refused (blocked) run's timeline line names the host's reason; a skipped one too; a plain
 *   failure names no reason; an unapproved refresh offers no "Run now", a paused one neither review nor run.
 *
 * UA12.97 — a `pages:runRefreshNow` that answers { started } leaves the run in the background, so the bar shows
 * the running state until `lastRefresh.at` moves (the completion push), never the bare approved state with a
 * live Run now: positive (the running render), negative (running={false} stays the ledger state), and the click
 * path read from source (the arm/clear/disable needles, with a planted control).
 *
 * Rendered with `renderToStaticMarkup` (this repo's `bun test` has no DOM); the approve click is driven through the
 * component's own handler prop. Labels render as their KEYS: the suite mounts its OWN resource-less i18next
 * instance (UA12.167 — react-i18next's `setI18n` is a process global, so a suite that merely relied on i18n being
 * uninitialised went red whenever an earlier suite in the same batch ran `.use(initReactI18next).init()`; measured
 * and registered in docs/superpowers/specs/2026-07-29-known-failing-tests.md).
 */
import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { AutomationActionRow } from '../AutomationActionRow'
import { parseAutomationsConfig, scriptHistorySummary, type ScriptAction } from '../types'
import { PageRefreshStatusView } from '../../pages/PageRefreshBar'

const SHA = 'a'.repeat(64)
const unapproved: ScriptAction = { type: 'script', script: 'scripts/report.ts', args: ['--daily'], approval: { state: 'unapproved', sha256: SHA } }

let i18n: I18nInstance
beforeAll(async () => {
  // UA12.167 — the suite's own instance, deliberately with NO resources: `t` returns the key, which is what the
  // assertions below read. The provider overrides react-i18next's process-global default, so the render is the
  // same alone or after any other suite has initialised the global.
  i18n = createInstance()
  await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en' })
})

/** Every render goes through the suite's own provider — never the process-global default instance. */
const render = (element: React.ReactElement) => renderToStaticMarkup(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>)

describe('the script action row (UA8.3)', () => {
  it('positive: renders the command line, runtime and the unapproved state, with an Approve button naming the shown digest', () => {
    const html = render(<AutomationActionRow action={unapproved} index={0} onApproveScript={async () => ({ state: 'approved', sha256: SHA })} />)
    expect(html).toContain('scripts/report.ts --daily')
    expect(html).toContain('>bun<')
    expect(html).toContain('data-script-approval="unapproved"')
    expect(html).toContain('automations.script.unapproved')
    expect(html).toContain('automations.script.approve')
    expect(html).toContain(`sha256 ${SHA}`)
  })

  it('positive: approving sends the row index and the SHOWN digest, and the info page forwards them to the host channel', () => {
    // Read from source: the click handler needs a DOM this runner does not have (module header).
    const row = readFileSync(join(import.meta.dir, '..', 'AutomationActionRow.tsx'), 'utf8')
    expect(row).toContain('await onApproveScript(index, approval.sha256)')
    const page = readFileSync(join(import.meta.dir, '..', 'AutomationInfoPage.tsx'), 'utf8')
    expect(page).toContain('window.electronAPI.approveAutomationScript(workspace.id, automation.id, actionIndex, sha256)')
    expect(page).toContain('onApproveScript={approveScript}')
  })

  it('an approved script offers no approval; a row with no ledger reading says so and offers none', () => {
    const approved = render(<AutomationActionRow action={{ ...unapproved, approval: { state: 'approved', sha256: SHA } }} index={0} onApproveScript={async () => undefined} />)
    expect(approved).toContain('data-script-approval="approved"')
    expect(approved).not.toContain('automations.script.approve<')
    const unknown = render(<AutomationActionRow action={{ type: 'script', script: 'x.ts' }} index={0} onApproveScript={async () => undefined} />)
    expect(unknown).toContain('data-script-approval="unknown"')
    expect(unknown).not.toContain('automations.script.approve<')
  })

  it('a saved script-only automation is listed (no longer filtered out)', () => {
    const items = parseAutomationsConfig({ version: 2, automations: { SchedulerTick: [{ id: 'm1', cron: '0 9 * * *', actions: [unapproved] }] } })
    expect(items.map(item => [item.id, item.name, item.actions[0]?.type])).toEqual([['m1', 'Script scripts/report.ts', 'script']])
  })

  it('negative: a refused or skipped run names the host\'s reason in the timeline; a plain failure names none', () => {
    expect(scriptHistorySummary({ script: 'x.ts', blocked: true }, 'Script not approved: x.ts — approve it before it can run'))
      .toBe('Script x.ts — Script not approved: x.ts — approve it before it can run')
    expect(scriptHistorySummary({ script: 'x.ts', skipped: true }, 'Skipped: previous run of this automation is still in progress'))
      .toContain('Skipped: previous run')
    expect(scriptHistorySummary({ script: 'x.ts' }, 'Automation failed')).toBe('Script x.ts')
    expect(scriptHistorySummary({ script: 'x.ts', timedOut: true }, 'Automation failed')).toBe('Script x.ts (timed out)')
  })
})

describe('the page refresh bar (UA8.3)', () => {
  const refresh = { cron: '*/15 * * * *', script: 'pages/p/refresh.ts' }

  it('positive: an approved refresh shows its schedule and state and offers Run now; an unapproved one offers review, not Run now', () => {
    const approved = render(<PageRefreshStatusView refresh={refresh} status={{ state: 'approved', sha256: SHA }} reviewing={false} busy={false} />)
    expect(approved).toContain('data-page-refresh-state="approved"')
    expect(approved).toContain('pages.refresh.runNow')
    expect(approved).not.toContain('pages.refresh.review<')
    const waiting = render(<PageRefreshStatusView refresh={refresh} status={{ state: 'unapproved', sha256: SHA, script: refresh.script, content: 'console.log(1)' }} reviewing busy={false} />)
    expect(waiting).toContain('data-page-refresh-state="unapproved"')
    expect(waiting).not.toContain('pages.refresh.runNow')
    expect(waiting).toContain('console.log(1)')
    expect(waiting).toContain(`sha256 ${SHA}`)
    expect(waiting).toContain('pages.refresh.approve<')
  })

  it('negative: a paused refresh offers neither review nor Run now; a changed one is not offered Run now', () => {
    const paused = render(<PageRefreshStatusView refresh={{ ...refresh, enabled: false }} status={{ state: 'none' }} reviewing={false} busy={false} />)
    expect(paused).toContain('data-page-refresh-state="paused"')
    expect(paused).not.toContain('pages.refresh.runNow')
    expect(paused).not.toContain('pages.refresh.review')
    const changed = render(<PageRefreshStatusView refresh={refresh} status={{ state: 'changed', sha256: SHA }} reviewing={false} busy={false} />)
    expect(changed).toContain('pages.refresh.stateChanged')
    expect(changed).not.toContain('pages.refresh.runNow')
  })

  // UA8.3 follow-up 2: the approval binds the args and runtime too, so the review shows them as a command line.
  it('the review shows the command line the approval binds: runtime, path and every arg; no args shows the bare command', () => {
    const command = (html: string) => html.match(/data-page-refresh-command="[^"]*">([^<]*)</)?.[1]
    const withArgs = render(<PageRefreshStatusView refresh={refresh} status={{ state: 'changed', sha256: SHA, script: refresh.script, content: 'x', args: ['--to', 'https://unseen.invalid/x'], runtime: 'bun' }} reviewing busy={false} />)
    expect(command(withArgs)).toBe('bun pages/p/refresh.ts --to https://unseen.invalid/x')
    const bare = render(<PageRefreshStatusView refresh={refresh} status={{ state: 'unapproved', sha256: SHA, script: refresh.script, content: 'x', args: [], runtime: 'bun' }} reviewing busy={false} />)
    expect(command(bare)).toBe('bun pages/p/refresh.ts')
  })

  // UA12.97 — pages:runRefreshNow answers { started } while the run continues in the background (its outcome lands
  // on page.json `lastRefresh` last and pokes pages:changed), so an armed bar shows "running…" with Run now
  // disabled until lastRefresh.at moves — not the bare approved state.
  it('UA12.97: an armed refresh shows the running state with a disabled Run now; running={false} keeps the ledger state', () => {
    const armed = render(<PageRefreshStatusView refresh={refresh} status={{ state: 'approved', sha256: SHA }} reviewing={false} busy={false} running />)
    expect(armed).toContain('data-page-refresh-state="running"')
    expect(armed).toContain('pages.refresh.stateRunning')
    expect(armed).toMatch(/<button(?=[^>]* disabled="")[^>]*><svg/)
    const idle = render(<PageRefreshStatusView refresh={refresh} status={{ state: 'approved', sha256: SHA }} reviewing={false} busy={false} running={false} />)
    expect(idle).toContain('data-page-refresh-state="approved"')
    expect(idle).not.toContain('pages.refresh.stateRunning')
    expect(idle).toMatch(/<button(?![^>]* disabled="")[^>]*><svg/)
  })

  it('UA12.97 (click path, read from source): a started answer arms the state from the pre-run lastRefresh.at, the same stamp clears it, and Run now is disabled while armed', () => {
    const bar = readFileSync(join(import.meta.dir, '..', '..', 'pages', 'PageRefreshBar.tsx'), 'utf8')
    expect(bar).toMatch(/const atBefore = lastRefreshAt/)
    expect(bar).toMatch(/if \(result\.started\) \{\s*setArmedAt\(atBefore \?\? undefined\)/)
    expect(bar).toContain('const running = armedAt !== null && (lastRefreshAt ?? undefined) === armedAt')
    expect(bar).toContain('disabled={busy || running}')
    // control on the same scanner: without the arming call the arm pin cannot hold
    const unarmed = bar.replace('setArmedAt(atBefore ?? undefined)', '')
    expect(unarmed).not.toBe(bar)
    expect(unarmed).not.toMatch(/if \(result\.started\) \{\s*setArmedAt\(atBefore \?\? undefined\)/)
  })
})
