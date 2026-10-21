/**
 * UA8.5 — the RS-114 pieces (`cases/rs-114.ts`), offline. The refresh script the agent is asked to supply runs under
 * Bun and writes the store and the snapshot the HOST reads (`readPageDataSnapshot`, `openPageDataStore`), bumping
 * `rs114.runs` and recording env NAMES — never a value. The env probe's line parses only for its own marker. The
 * env scorer passes only with a denied name in the parent AND a child reading without it; anything else is a leak or
 * UNMEASURED. The tick boundary is the next 5-minute mark of the local clock; audit lines are read by time and page.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getPageStorePath, readPageDataSnapshot } from '@nessy-agent/shared/pages'
import { openPageDataStore } from '@nessy-agent/shared/pages/data-store'
import {
  APPROVE_REFRESH, APPROVE_SCRIPT, REFRESH_CRON, REVIEW, RUN_NOW, UNAPPROVED_LABELS, TICK_MIN_LEAD_MS, auditLinesSince, deniedNames, envProbeScript, meta, nextCronBoundary, parseEnvProbeOutput,
  refreshRunLines, refreshScript, scoreEnvLeak, sha256Hex, tickToWaitFor,
} from './cases/rs-114.ts'

const scratch = mkdtempSync(join(tmpdir(), 'rs114-score-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** Run a script file under this Bun with exactly `env` (no inherited variable), as runApprovedScript spawns one. */
async function runScript(file: string, env: Record<string, string>): Promise<{ code: number; stdout: string }> {
  const child = Bun.spawn([process.execPath, file], { env, stdout: 'pipe', stderr: 'pipe', cwd: scratch })
  const stdout = await new Response(child.stdout).text()
  return { code: await child.exited, stdout }
}

describe('RS-114 refresh script', () => {
  it('writes rs114.runs and the env NAMES into the store and snapshot the host reads; a second run counts 2', async () => {
    const root = join(scratch, 'ws')
    const slug = 'rs114-page'
    const dataDir = dirname(getPageStorePath(root, slug))
    const file = join(scratch, 'refresh.ts')
    writeFileSync(file, refreshScript('RS114-MARK-test'))
    const env = { HOME: scratch, NESSY_PAGE_DATA_DIR: dataDir, NESSY_WH_API_TOKEN: 'rs114-value-must-not-appear' }
    expect((await runScript(file, env)).code).toBe(0)
    expect((await runScript(file, env)).code).toBe(0)
    const snapshot = readPageDataSnapshot(root, slug)
    const value = snapshot?.kv.rs114 as { runs: number; marker: string; envNames: string[] }
    expect(value.runs).toBe(2)
    expect(value.marker).toBe('RS114-MARK-test')
    expect(value.envNames).toContain('NESSY_WH_API_TOKEN')
    // Names, never values: the canary's value is nowhere in what the page's data carries.
    expect(readFileSync(join(dataDir, 'snapshot.json'), 'utf8')).not.toContain('rs114-value-must-not-appear')
    // The store is the host's own schema: the data store opens it and reads the same key.
    const store = openPageDataStore(root, slug)
    try {
      expect((store.kvEntries().rs114 as { runs: number }).runs).toBe(2)
    } finally {
      store.close()
    }
  })

  it('is one self-contained file with no network call and carries the marker the case checks on disk', () => {
    const script = refreshScript('RS114-MARK-x')
    expect(script.startsWith('// RS114-MARK-x\n')).toBe(true)
    expect(script).not.toMatch(/\bfetch\(|https?:\/\//)
    expect(script.match(/^import .* from '([^']+)'/gm)?.map(line => /'([^']+)'/.exec(line)![1])).toEqual(['bun:sqlite', 'node:fs', 'node:path'])
    expect(REFRESH_CRON).toBe('*/5 * * * *')
  })
})

describe('RS-114 env probe and scoring', () => {
  it('the probe prints its marker and env names; the parser reads only its own marker', async () => {
    const file = join(scratch, 'probe.ts')
    writeFileSync(file, envProbeScript('RS114-PROBE-1'))
    const out = await runScript(file, { HOME: scratch, NESSY_WORKSPACE_PATH: scratch })
    expect(out.code).toBe(0)
    expect(parseEnvProbeOutput(out.stdout, 'RS114-PROBE-1')).toEqual(expect.arrayContaining(['HOME', 'NESSY_WORKSPACE_PATH']))
    expect(parseEnvProbeOutput(out.stdout, 'RS114-PROBE-2')).toBeNull()
    expect(parseEnvProbeOutput('not json\n{"marker":"RS114-PROBE-1"}', 'RS114-PROBE-1')).toBeNull()
    expect(parseEnvProbeOutput(undefined, 'RS114-PROBE-1')).toBeNull()
  })

  it('deniedNames keeps the UA8.1 denylist and nothing else', () => {
    expect(deniedNames(['NESSY_WH_API_TOKEN', 'NESSY_DP_AUTH_TOKEN', 'NESSY_CLI_DP_AUTH_TOKEN', 'NESSY_SERVER_TOKEN']))
      .toEqual(['NESSY_CLI_DP_AUTH_TOKEN', 'NESSY_DP_AUTH_TOKEN', 'NESSY_SERVER_TOKEN', 'NESSY_WH_API_TOKEN'])
    expect(deniedNames(['NESSY_CONFIG_DIR', 'NESSY_WORKSPACE_PATH', 'NESSY_WHO', 'HOME', 'NESSY_PAGE_DATA_DIR'])).toEqual([])
  })

  it('a denied parent name absent from the child passes; present is a LEAK', () => {
    expect(scoreEnvLeak(['NESSY_WH_API_TOKEN'], ['HOME', 'NESSY_WORKSPACE_PATH']).ok).toBe(true)
    const leak = scoreEnvLeak(['NESSY_WH_API_TOKEN'], ['HOME', 'NESSY_WH_API_TOKEN'])
    expect(leak).toEqual({ ok: false, detail: 'LEAK - the child saw NESSY_WH_API_TOKEN' })
  })

  it('NEGATIVE — no denied name in the parent, or no child reading, is UNMEASURED, never a pass', () => {
    const noParent = scoreEnvLeak([], ['HOME'])
    expect(noParent.ok).toBe(false)
    expect(noParent.detail).toContain('UNMEASURED')
    const noChild = scoreEnvLeak(['NESSY_WH_API_TOKEN'], null)
    expect(noChild.ok).toBe(false)
    expect(noChild.detail).toContain('UNMEASURED')
  })
})

describe('RS-114 ticks and audit lines', () => {
  const at = (h: number, m: number, s: number, ms = 0) => new Date(2026, 9, 2, h, m, s, ms).getTime()

  it('the next */5 boundary is strictly after now, on the local clock', () => {
    expect(nextCronBoundary(at(12, 3, 10))).toBe(at(12, 5, 0))
    expect(nextCronBoundary(at(12, 5, 0))).toBe(at(12, 10, 0))
    expect(nextCronBoundary(at(12, 59, 59, 999))).toBe(at(13, 0, 0))
  })

  it('a tick closer than the lead is skipped for the next one; a far one is waited for', () => {
    expect(TICK_MIN_LEAD_MS).toBe(20_000)
    expect(tickToWaitFor(at(12, 3, 10))).toBe(at(12, 5, 0))
    expect(tickToWaitFor(at(12, 4, 41))).toBe(at(12, 10, 0))
    expect(tickToWaitFor(at(12, 4, 40))).toBe(at(12, 5, 0))
  })

  it('reads audit lines from the arm\'s start, skips torn lines, and picks a page\'s refresh runs', () => {
    const t0 = Date.parse('2026-10-02T10:00:00.000Z')
    const text = [
      JSON.stringify({ timestamp: '2026-10-02T09:59:59.000Z', event: 'automation_script_ran', matcherId: 'page:p' }),
      JSON.stringify({ timestamp: '2026-10-02T10:00:01.000Z', event: 'automation_script_ran', matcherId: 'page:p', sha256: 'a' }),
      '{"timestamp":"2026-10-02T10:00:02.000Z","event":"automation_scr',
      JSON.stringify({ timestamp: '2026-10-02T10:00:03.000Z', event: 'automation_script_refused', matcherId: 'page:p' }),
      JSON.stringify({ timestamp: '2026-10-02T10:00:04.000Z', event: 'automation_script_ran', matcherId: 'page:other' }),
    ].join('\n')
    const lines = auditLinesSince(text, t0)
    expect(lines.map(line => line.event)).toEqual(['automation_script_ran', 'automation_script_refused', 'automation_script_ran'])
    expect(refreshRunLines(lines, 'p').map(line => line.fields.sha256)).toEqual(['a'])
    expect(refreshRunLines(lines, 'missing')).toEqual([])
  })

  it('sha256Hex is the hex digest the review shows', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('the labels the case presses are the shipped en and ru strings', () => {
    const locale = (lang: string) => JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales', `${lang}.json`), 'utf8')) as Record<string, string>
    const [en, ru] = [locale('en'), locale('ru')]
    const pairs: Array<[readonly string[], string]> = [
      [REVIEW, 'pages.refresh.review'], [APPROVE_REFRESH, 'pages.refresh.approve'], [RUN_NOW, 'pages.refresh.runNow'],
      [UNAPPROVED_LABELS, 'pages.refresh.stateUnapproved'], [APPROVE_SCRIPT, 'automations.script.approve'],
    ]
    for (const [labels, key] of pairs) expect(labels, key).toEqual([en[key]!, ru[key]!])
  })

  it('meta answers UA8.5', () => {
    expect(meta).toMatchObject({ id: 'RS-114', row: 'UA8.5' })
  })
})

