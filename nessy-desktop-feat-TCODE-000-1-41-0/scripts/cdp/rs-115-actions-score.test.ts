/**
 * UA9.5 — the RS-115 pieces (`cases/rs-115.ts`), offline. The case-authored page compiles in both variants, carries
 * no doctype, and embeds its script path and remembered grant id as JSON; the granted script appends one line per
 * run where the case counts them. The timer-action scorer passes only for the FOCUS refusal (an activation refusal
 * never reached that gate); the timer grant-request scorer needs the host's grants reply beside the missing dialog;
 * the dialog scorer needs the host descriptor with the pinned sha256 in the shape grant-visuals renders it. Audit
 * lines are read by page and time. The labels the case presses are the shipped en and ru strings.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ALLOW, MANAGE, MORE, REMOVE, RENAME, STALE, TIMER_ACT_MS, actScript, actionsPageHtml, meta, pageAuditLines,
  scoreGrantDialog, scoreRendererGateAudit, scoreTimerAction, scoreTimerGrantRequest, sha256Hex,
  type PageAuditLine,
} from './cases/rs-115.ts'

const scratch = mkdtempSync(join(tmpdir(), 'rs115-score-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const repo = join(import.meta.dir, '..', '..')

function inlineScript(html: string): string {
  return /<script>([\s\S]*)<\/script>/.exec(html)![1]!
}

describe('RS-115 page and script', () => {
  it('the page has no doctype, compiles in both variants, and embeds path and remembered id as JSON', () => {
    const first = actionsPageHtml({ script: 'rs115-1/act.ts', remembered: null, timerRequest: true })
    const edited = actionsPageHtml({ script: 'rs115-1/act.ts', remembered: 'g"1', timerRequest: false })
    for (const html of [first, edited]) {
      expect(html.startsWith('<html>')).toBe(true)
      expect(() => new Function(inlineScript(html))).not.toThrow()
      expect(html).toContain(`const ACTION = { kind: 'script', script: ${JSON.stringify('rs115-1/act.ts')} }`)
    }
    expect(first).toContain('let lastGrantId = null')
    expect(edited).toContain(`let lastGrantId = ${JSON.stringify('g"1')}`)
    expect(first).toContain('if (first && true)')
    expect(edited).toContain('if (first && false)')
    expect(first).toContain(`act('timer'), ${TIMER_ACT_MS})`)
    // The armed action must fire inside the host click's 5 s transient activation, or F reads the activation gate.
    expect(TIMER_ACT_MS).toBeGreaterThanOrEqual(2_000)
    expect(TIMER_ACT_MS).toBeLessThan(5_000)
  })

  it('the granted script appends one line per run under the workspace and prints its marker', async () => {
    const dir = 'rs115-t'
    mkdirSync(join(scratch, dir), { recursive: true })
    const file = join(scratch, 'act.ts')
    writeFileSync(file, actScript(dir))
    for (let i = 0; i < 2; i++) {
      const child = Bun.spawn([process.execPath, file], { env: { HOME: scratch, NESSY_WORKSPACE_PATH: scratch }, cwd: tmpdir(), stdout: 'pipe' })
      expect((await new Response(child.stdout).text()).trim()).toBe('RS115-ACTED')
      expect(await child.exited).toBe(0)
    }
    expect(readFileSync(join(scratch, dir, 'runs.log'), 'utf8').split('\n').filter(Boolean)).toHaveLength(2)
  })
})

describe('RS-115 scoring', () => {
  it('a timer action passes only when refused frame-focus-required', () => {
    expect(scoreTimerAction({ ok: false, error: 'frame-focus-required: mutating actions need a gesture inside the page' }).ok).toBe(true)
  })

  it('NEGATIVE — a run, an activation refusal, another refusal or no result never passes', () => {
    expect(scoreTimerAction({ ok: true })).toEqual({ ok: false, detail: 'the timer action RAN after a click on the host toolbar' })
    const activation = scoreTimerAction({ ok: false, error: 'user-activation-required: mutating actions need a fresh user gesture' })
    expect(activation.ok).toBe(false)
    expect(activation.detail).toContain('UNMEASURED')
    expect(scoreTimerAction({ ok: false, error: 'grant-not-found: x' }).ok).toBe(false)
    expect(scoreTimerAction(null).detail).toContain('UNMEASURED')
  })

  it('a timer grant request passes with no dialog AND the host\'s reply; a dialog fails; silence is unmeasured', () => {
    expect(scoreTimerGrantRequest({ dialogSeen: false, grantsReplyAfter: true }).ok).toBe(true)
    expect(scoreTimerGrantRequest({ dialogSeen: true, grantsReplyAfter: true }).ok).toBe(false)
    const silent = scoreTimerGrantRequest({ dialogSeen: false, grantsReplyAfter: false })
    expect(silent.ok).toBe(false)
    expect(silent.detail).toContain('UNMEASURED')
  })

  it('the dialog must show the host descriptor with the pinned sha256, in the shape grant-visuals renders', () => {
    const sha = sha256Hex('x')
    const text = `Page requests access\nRun script “a/act.ts” on your computer\nscript bun a/act.ts\nsha256 ${sha}\nThe page says (not verified): RS-115 asks to run its script`
    expect(scoreGrantDialog(text, 'a/act.ts', sha).ok).toBe(true)
    expect(scoreGrantDialog(text.replace(`sha256 ${sha}`, ''), 'a/act.ts', sha).ok).toBe(false)
    expect(scoreGrantDialog(text, 'b/act.ts', sha).ok).toBe(false)
    // The needles are the renderer's own lines: describeGrantTarget joins `<runtime ?? 'bun'> <script>` and `sha256 <digest>`.
    const visuals = readFileSync(join(repo, 'apps', 'electron', 'src', 'renderer', 'components', 'pages', 'grant-visuals.tsx'), 'utf8')
    expect(visuals).toContain("[action.runtime ?? 'bun', action.script, ...(action.args ?? [])].join(' ')")
    expect(visuals).toContain('[`script ${command}`, `sha256 ${scriptSha256}`]')
  })

  it('page audit lines are read by page and time, torn lines skipped', () => {
    const since = Date.parse('2026-10-02T10:00:00.000Z')
    const text = [
      JSON.stringify({ timestamp: '2026-10-02T09:00:00.000Z', event: 'page_action_executed', pageSlug: 'p' }),
      JSON.stringify({ timestamp: '2026-10-02T10:00:01.000Z', event: 'page_action_executed', pageSlug: 'p', ok: true }),
      '{"timestamp":"2026-10-02T10:00:02.000Z","event":"page_act',
      JSON.stringify({ timestamp: '2026-10-02T10:00:03.000Z', event: 'page_action_rejected', pageSlug: 'q', code: 'grant-stale' }),
      JSON.stringify({ timestamp: '2026-10-02T10:00:04.000Z', event: 'page_action_rejected', pageSlug: 'p', code: 'grant-not-found' }),
    ].join('\n')
    expect(pageAuditLines(text, 'p', since).map(line => line.event)).toEqual(['page_action_executed', 'page_action_rejected'])
    expect(pageAuditLines(text, 'none', since)).toEqual([])
  })

  it('UA12.112: the renderer-gate audit scorer passes on the stage-marked refusal line and fails without it', () => {
    const line = (fields: Record<string, unknown>): PageAuditLine => ({ event: String(fields.event), ts: 0, fields })
    // F's shape: the focus refusal, the frame's requestId, the stage marker.
    const action = line({ event: 'page_action_rejected', stage: 'renderer-gate', pageSlug: 'p', code: 'frame-focus-required', requestId: 'r1' })
    expect(scoreRendererGateAudit([action], { event: 'page_action_rejected', requestId: 'r1', code: 'frame-focus-required' }).ok).toBe(true)
    // A broker-side rejection (no stage) is NOT the renderer's line.
    const brokered = line({ event: 'page_action_rejected', pageSlug: 'p', code: 'frame-focus-required', requestId: 'r1' })
    const notStage = scoreRendererGateAudit([brokered], { event: 'page_action_rejected', requestId: 'r1', code: 'frame-focus-required' })
    expect(notStage.ok).toBe(false)
    expect(notStage.detail).toContain('not as a renderer-gate refusal')
    // Another request's line does not pass for this one.
    expect(scoreRendererGateAudit([action], { event: 'page_action_rejected', requestId: 'other', code: 'frame-focus-required' }).ok).toBe(false)
    // T's shape: the grant-request refusal event (no requestId to pin), silence is a plain no.
    const request = line({ event: 'page_grant_request_refused', stage: 'renderer-gate', pageSlug: 'p', code: 'no-user-activation' })
    expect(scoreRendererGateAudit([request], { event: 'page_grant_request_refused' }).ok).toBe(true)
    const absent = scoreRendererGateAudit([], { event: 'page_grant_request_refused' })
    expect(absent.ok).toBe(false)
    expect(absent.detail).toContain('no page_grant_request_refused line')
  })

  it('the labels the case presses are the shipped en and ru strings', () => {
    const locale = (lang: string) => JSON.parse(readFileSync(join(repo, 'packages', 'shared', 'src', 'i18n', 'locales', `${lang}.json`), 'utf8')) as Record<string, string>
    const [en, ru] = [locale('en'), locale('ru')]
    const pairs: Array<[readonly string[], string]> = [
      [ALLOW, 'pages.grants.approve'], [MORE, 'common.more'], [MANAGE, 'pages.grants.manage'], [REMOVE, 'pages.grants.remove'],
      [STALE, 'pages.grants.statusStale'], [RENAME, 'pages.renamePage'],
    ]
    for (const [labels, key] of pairs) expect(labels, key).toEqual([en[key]!, ru[key]!])
  })

  it('meta answers UA9.5', () => {
    expect(meta).toMatchObject({ id: 'RS-115', row: 'UA9.5' })
  })
})
