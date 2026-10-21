/**
 * F1.703 (DN-231, 2026-09-28, the owner's option a) — the protected-path floor no
 * longer fires on the session's OWN working folders, and fires the same on both
 * data-folder layouts.
 *
 * ## The reading, taken first (host probe, both layouts)
 *
 * With the session's cwd = its own session folder (claude's no-project cwd,
 * `<data folder>/sessions/<workspace>/<session>/`), a Write into its scratch
 * `job/tmp`, `data/`, `downloads/` or the folder itself raised the NON-negotiable
 * protected-path card in `default`, `acceptEdits` and `auto` on BOTH layouts — by
 * the `.nessy-agent` segment on the default one, and on a relocated one by F1.677's
 * data-folder floor, whose carve-out covered the workspace root and not this
 * folder. The workspace root itself was floored on the default layout and carved
 * out on a relocated one.
 *
 * ## The fix
 *
 * `ownSessionWorkingFolderWrite` (`core/pre-tool-use.ts`) carves the session's own
 * folder out for file tools on both layouts, the way `permission-modes.md`'s
 * protected-paths section carves `.claude/worktrees` out of `.claude`, minus the
 * session's own records (`session.jsonl`, `attachments/`, `long_responses/`, since
 * F1.1062 `.pi-carry/` and `checkout-move.patch`, and since F1.1174 the other host and
 * runtime records — `isOwnSessionRecordName` in `session-filesystem-scope.ts`); and
 * F1.677's workspace-root carve-out is gone, so both layouts floor that root.
 *
 * F1.1098 (DN-231, DN-056) — and for a SHELL command too: the floor stays off when EVERY
 * target the three shell floors judge (each redirect target, each token; against the cwd and
 * every `cd` the command makes) lies in the session's own working folder, never a record; one
 * target that does not, or that the gate cannot resolve (a variable other than claude's
 * `$CLAUDE_JOB_DIR` where its shell defines it, a backtick, a glob), keeps the floor. RED
 * before: every SHELL case below answered `floor` in default, acceptEdits and auto. The
 * follow-up (VF-w2f, 2026-10-10) adds the brace: the token pattern reads `{`/`}` as separators,
 * so `cp q {a,../session-f1703-other/session.jsonl}` scanned as one token `a,../…` lifted in
 * acceptEdits and auto while the shell expanded the braces one level ABOVE the session folder
 * (RED again on the two brace CONTROLs: allow where floor is pinned); now any brace in the
 * scanned text keeps the floor.
 *
 * UB12.6 (2026-10-16, the controller review's w2-bk10-11-contract finding 1) adds the GLUED option: the lift
 * resolved `--target-directory=../session-f1703-other` (and `-t../…`, `dd of=../…`) as one word, whose
 * `--target-directory=..` is a literal segment below the session folder, so it counted as own while cp/mv/dd
 * wrote the value — RED before on the six glued CONTROLs (allow in default, acceptEdits and auto for five of
 * them, a rememberable Bash card for dd) where floor is pinned; and on the glued SHELL arm (`allow` in default,
 * where the scratch exemption dropped the option word and with it the `data` target). Now both read the value.
 *
 * UB12.19 (2026-10-16, the controller review's w2-bk10-11-correctness finding 1) — the probe now passes the gate inputs
 * each runtime REALLY passes for a session with no project (the fixture's `CLAUDE` and `PI`); every case used to pass
 * the session folder as `workingDirectory`, which no runtime does, so this suite was green while the lift never fired in
 * production. RED on the fixed fixture against the gate before the fix: every claude SHELL arm but one and both Pi SHELL
 * arms answered `floor` in default, acceptEdits and auto (the gate fell back to the workspace root, where every bare word
 * is a data-folder path), and the two RECORD arms — a relative climb from claude's session folder to the workspace's
 * `permissions.json` and the global `hooks.json` — answered a rememberable Bash card, and ALLOW in bypassPermissions,
 * where F1.701 refuses in every mode (CRITICAL). With the climb decline mutated away the climb CONTROL answered `allow`
 * in auto. One file-tool reading moved with the inputs: a Write into the session's `downloads/` takes the ordinary card in
 * acceptEdits and auto, because that folder is not one of the acceptEdits roots when the session has no working
 * directory (C3.362's posture) — the old pin read it as a root only because the probe made the session folder the cwd.
 *
 * UB12.60 (2026-10-16, born by L-HOST2 at UB12.19, CRITICAL) — the deniedPaths floor took `workingDirectory` as the base
 * of a relative spelling (F1.1120), and neither runtime passes one for a session with no project, so a user's deny entry
 * missed `cat ../../../secret/a.txt`: RED before on the three relative DENY arms (Pi's cat and Read from the workspace
 * root, claude's cat from the session folder), `allow` in bypassPermissions and no refusal in any mode. The gate now
 * hands the floor its own base, the directory the runtime's tools run in (`runtimeRelativeBase`, else the workspace
 * root); the read fences keep `workingDirectory`. The OPEN arms are the negative: the same climb to a folder no entry
 * names is not refused.
 */
import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { bracedRegion } from '../../testing/source-regions.ts'

// Two children, each loading the gate's module graph cold (the F1.725 suite's budget).
setDefaultTimeout(240_000)

const PROBE = join(import.meta.dir, 'fixtures', 'session-working-folder-probe.ts')
const SCRATCH = mkdtempSync(join(tmpdir(), 'f1703-layouts-'))
afterAll(() => { rmSync(SCRATCH, { recursive: true, force: true }) })

interface ProbeOut { configDir: string; session: string; verdicts: Record<string, Record<string, string>> }

async function probe(layout: 'relocated' | 'default'): Promise<ProbeOut> {
  const home = join(SCRATCH, layout, 'home')
  mkdirSync(home, { recursive: true })
  const configDir = layout === 'default' ? join(home, '.nessy-agent') : join(SCRATCH, layout, 'nessy-data')
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  env.HOME = home
  env.NESSY_CONFIG_DIR = configDir
  const child = Bun.spawn(['bun', PROBE], { env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`probe (${layout}) exited ${code}: ${stderr.slice(-2000)}`)
  const out = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as ProbeOut
  // Provenance before any verdict: the child's data folder is this scratch one, never the real one.
  expect(out.configDir).toBe(configDir)
  return out
}

const row = (d: string, a: string, au: string, dn: string, b: string) => ({ default: d, acceptEdits: a, auto: au, dontAsk: dn, bypassPermissions: b })
const FLOORED = row('floor', 'floor', 'floor', 'block', 'allow')
const OPEN_EDIT = row('card(file_write)', 'allow', 'allow', 'block', 'allow')

const layouts: Record<string, ProbeOut> = {}

describe('F1.703 — the session\'s own working folders, both data-folder layouts', () => {
  it('probes ran against scratch data folders', async () => {
    layouts.default = await probe('default')
    layouts.relocated = await probe('relocated')
    expect(layouts.default.session.startsWith(layouts.default.configDir)).toBe(true)
  })

  it('a file-tool write into the session\'s own folder takes the ordinary path, not the floor', () => {
    for (const out of Object.values(layouts)) {
      expect(out.verdicts['scratch job/tmp']).toEqual(row('allow', 'allow', 'allow', 'block', 'allow'))
      for (const label of ['data/', 'no-project cwd, relative file', 'no-project cwd, relative subfolder', 'Edit in the session folder']) {
        expect({ label, verdict: out.verdicts[label] }).toEqual({ label, verdict: OPEN_EDIT })
      }
      // UB12.19 — production inputs: no working directory, so `downloads/` is not an acceptEdits root (C3.362).
      expect(out.verdicts['downloads/']).toEqual(row('card(file_write)', 'card(file_write)', 'card(file_write)', 'block', 'allow'))
    }
  })

  // F1.1062 (DN-247) — claude's arm of the long_responses/ read: the gate allows it in every mode, so the
  // hook answers `permissionDecision: 'allow'` and the SDK opens the file with no card. Pi's arm is its scope
  // (`session-filesystem-scope.test.ts`), which reads it too since F1.1062; a write there keeps the floor (CONTROL).
  it('a Read or Grep of the session\'s own long_responses/ passes the gate in every mode', () => {
    for (const out of Object.values(layouts)) {
      for (const label of ['Read long_responses/', 'Grep long_responses/']) {
        expect({ label, verdict: out.verdicts[label] }).toEqual({ label, verdict: row('allow', 'allow', 'allow', 'allow', 'allow') })
      }
    }
  })

  it('F1.1098 — a shell command whose every target is in the session\'s own working folder takes the ordinary path, not the floor', () => {
    for (const out of Object.values(layouts)) {
      const shell = Object.keys(out.verdicts).filter(name => name.startsWith('SHELL'))
      expect(shell.length).toBe(9) // UB12.6 added the glued `--target-directory=data` arm; UB12.19 the two Pi arms
      for (const label of shell) {
        const verdict = out.verdicts[label]!
        expect({ label, floored: ['default', 'acceptEdits', 'auto'].filter(mode => verdict[mode] === 'floor') }).toEqual({ label, floored: [] })
        expect({ label, bypass: verdict.bypassPermissions }).toEqual({ label, bypass: 'allow' })
      }
      // The ordinary path: a rememberable Bash card in default (the child's empty read-only allowlist proves no
      // `echo` read-only, so P6.535's scratch exemption, which needs that proof, does not fire here).
      for (const label of shell) expect({ label, verdict: out.verdicts[label]?.default }).toEqual({ label, verdict: 'card(bash)' })
    }
  })

  it('CONTROL: the session\'s records, another session, an escape, the shell and the workspace root keep the floor', () => {
    for (const out of Object.values(layouts)) {
      for (const label of Object.keys(out.verdicts).filter(name => name.startsWith('CONTROL'))) {
        expect({ label, verdict: out.verdicts[label] }).toEqual({ label, verdict: FLOORED })
      }
    }
  })

  it('UB12.19 (CRITICAL) — a relative climb from claude\'s session folder to a control record is refused in every mode', () => {
    for (const out of Object.values(layouts)) {
      const records = Object.keys(out.verdicts).filter(name => name.startsWith('RECORD'))
      expect(records.length).toBe(2)
      for (const label of records) {
        expect({ label, verdict: out.verdicts[label] }).toEqual({ label, verdict: row('block', 'block', 'block', 'block', 'block') })
      }
    }
  })

  it('UB12.60 (CRITICAL) — a user\'s deniedPaths entry refuses a RELATIVE spelling in a no-project session, on both runtimes\' inputs', () => {
    const DENIED = row('denied', 'denied', 'denied', 'denied', 'denied')
    for (const out of Object.values(layouts)) {
      const deny = Object.keys(out.verdicts).filter(name => name.startsWith('DENY'))
      expect(deny.length).toBe(5) // two controls (absolute; relative with a working directory) + Pi cat, Pi Read, claude cat
      for (const label of deny) expect({ label, verdict: out.verdicts[label] }).toEqual({ label, verdict: DENIED })
      const open = Object.keys(out.verdicts).filter(name => name.startsWith('OPEN'))
      expect(open.length).toBe(2)
      for (const label of open) {
        const verdict = out.verdicts[label]!
        expect({ label, denied: Object.keys(verdict).filter(mode => verdict[mode] === 'denied') }).toEqual({ label, denied: [] })
        expect({ label, bypass: verdict.bypassPermissions }).toEqual({ label, bypass: 'allow' })
      }
    }
  })

  it('both layouts answer every case the same', () => {
    expect(layouts.relocated!.verdicts).toEqual(layouts.default!.verdicts)
  })
})

/**
 * UB12.19 — the wiring the probe's `CLAUDE` inputs stand for: claude's PreToolUse gate call passes the child's own spawn
 * cwd as `runtimeCwd`, the one value `resolveSpawnCwd` chose for the SDK's `cwd` option, so the gate resolves a relative
 * path where the child's shell runs. Pi passes none: its tools run in the directory the gate already falls back to.
 */
describe('UB12.19 — claude hands its gate the directory its child runs in', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'claude-agent.ts'), 'utf-8')

  it('the gate call carries runtimeCwd: resolvedCwd, the same value the spawn options use as cwd', () => {
    const call = bracedRegion(source, source.indexOf('checkResult: runPreToolUseChecks('))
    expect(call).toContain('runtimeCwd: resolvedCwd')
    expect(call).not.toContain('Blocked by a trusted PreToolUse hook') // the control: the region ends at the call
    expect(source.match(/\bresolvedCwd\s*=[^=]/g)).toEqual(['resolvedCwd = ']) // one binding, the spawn cwd's
    expect(source).toContain('const resolvedCwd = this.resolveSpawnCwd(')
    expect(source).toMatch(/^\s+cwd: resolvedCwd,$/m) // the SDK option, on a line of its own
  })
})
