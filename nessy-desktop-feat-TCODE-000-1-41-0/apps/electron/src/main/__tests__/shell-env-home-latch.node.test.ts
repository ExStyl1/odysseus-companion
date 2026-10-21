/**
 * P3.361 — Arm A of the end-to-end proof that a login shell cannot move the
 * running session's credential source.
 *
 * ## Why this file exists beside `shell-env-home.test.ts`
 *
 * Its sibling tests the FILTER and says so in its own header: under `bun test`
 * a mutated `process.env.HOME` does not move `os.homedir()` at all, because
 * **Bun 1.3.14 latches homedir at startup** (`packages/shared/src/config/home-latch.ts`
 * carries the three-runtime table). So a bun-hosted end-to-end assertion passes
 * with the fix REMOVED — it is a dead control, not a proof.
 *
 * The process that matters is the Electron main process, which is **Node**, and
 * on Node `os.homedir()` FOLLOWS a mid-process `process.env.HOME`. So the
 * decisive assertion is made in a Node child here; this bun-hosted wrapper only
 * builds the rig, hands the child a selection computed by the production filter,
 * and reads the child's verdict back.
 *
 * ## The park this un-blocks
 *
 * P3.191 was parked waiting on a Windows build. It needs no Windows:
 * `loadShellEnv()` returns immediately on non-darwin and again under
 * `VITE_DEV_SERVER_URL`, so the defect class cannot exist on the platform the
 * park was waiting for. It needs **darwin**, which is this rig.
 *
 * ## Controls, both mandatory
 *
 * - **Positive:** the same `.zprofile` exports a probe variable that MUST arrive
 *   in the selection. Without it, a login shell that was never sourced at all
 *   would satisfy "HOME did not move" trivially.
 * - **Negative:** the same Node child is then handed the UNFILTERED dump — which
 *   is exactly what `loadShellEnv` did before the `key === 'HOME'` clause — and
 *   `os.homedir()` must MOVE. Reverting the clause as DATA rather than by
 *   editing a scratch copy of the source keeps the two arms in one process pair
 *   and leaves nothing to restore.
 *
 * Arm B (a packaged `.app` launched from Finder, where `loadShellEnv` really
 * runs) is an operator row in `docs/testing/cdp-live-checklist.md`.
 */
import { describe, expect, it } from 'bun:test'
import { execFileSync, execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selectShellEnvVars } from '../shell-env'

const PROBE_VAR = 'NESSY_SHELL_ENV_PROFILE_PROBE'
const PROBE_VALUE = 'sourced-by-zprofile'

/** darwin-only by construction — `loadShellEnv` returns early everywhere else. */
const onDarwin = process.platform === 'darwin'

/**
 * The Node child. It receives a scratch `HOME` at LAUNCH, applies a map to
 * `process.env` exactly the way `loadShellEnv`'s write loop does, and reports
 * what `os.homedir()` answers afterwards. Nothing here reads the repo.
 */
const CHILD = `
const applied = JSON.parse(process.argv[1])
const before = require('node:os').homedir()
for (const [key, value] of Object.entries(applied)) process.env[key] = value
process.stdout.write(JSON.stringify({
  before,
  after: require('node:os').homedir(),
  probe: process.env[${JSON.stringify(PROBE_VAR)}] ?? null,
}))
`

function runChild(home: string, applied: Record<string, string>) {
  // `node`, never `process.execPath`: under `bun test` that is bun, which
  // latches homedir at startup and would make this assertion vacuous.
  const out = execFileSync('node', ['-e', CHILD, JSON.stringify(applied)], {
    encoding: 'utf8',
    timeout: 20_000,
    // A clean launch environment: only what the child needs, so nothing the
    // test runner carries can decide the answer.
    env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' },
  })
  return JSON.parse(out) as { before: string; after: string; probe: string | null }
}

describe.if(onDarwin)('the login shell cannot move a running session\'s home (Node-hosted)', () => {
  const root = mkdtempSync(join(tmpdir(), 'nessy-shell-env-latch-'))
  const launchHome = join(root, 'launch-home')
  const profileHome = join(root, 'reassigned-by-zprofile')
  mkdirSync(launchHome, { recursive: true })
  mkdirSync(profileHome, { recursive: true })
  writeFileSync(
    join(launchHome, '.zprofile'),
    `export HOME=${JSON.stringify(profileHome)}\nexport ${PROBE_VAR}=${PROBE_VALUE}\n`,
    'utf8',
  )

  // The production command, verbatim from `loadShellEnv`, against the scratch
  // home. `-l` sources `.zprofile`, which is where a real user reassigns HOME.
  let dump = ''
  try {
    dump = execSync("/bin/zsh -l -i -c 'echo __ENV_START__ && env'", {
      encoding: 'utf8',
      timeout: 15_000,
      env: { HOME: launchHome, SHELL: '/bin/zsh', TERM: 'xterm-256color' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (error) {
    dump = `__ENV_START__\n__PROFILE_FAILED__=${String(error).slice(0, 120)}\n`
  }

  it('sourced the profile at all — the positive control', () => {
    // Without this the assertions below are satisfied by a shell that never ran.
    const selected = selectShellEnvVars(dump)
    expect(selected[PROBE_VAR]).toBe(PROBE_VALUE)
  })

  it('proves the rig can move homedir at all — the negative control', () => {
    // The pre-P3.181 behaviour, expressed as data: every key the shell printed,
    // `HOME` included. On Node this MOVES `os.homedir()`, which is the defect.
    const unfiltered: Record<string, string> = {}
    for (const line of dump.slice(dump.indexOf('__ENV_START__')).split('\n').slice(1)) {
      const eq = line.indexOf('=')
      if (eq > 0) unfiltered[line.slice(0, eq)] = line.slice(eq + 1)
    }
    expect(unfiltered.HOME).toBe(profileHome)
    const result = runChild(launchHome, unfiltered)
    expect(result.before).toBe(launchHome)
    expect(result.after).toBe(profileHome)
  })

  it('does not move homedir through the shipped filter', () => {
    const result = runChild(launchHome, selectShellEnvVars(dump))
    expect(result.probe).toBe(PROBE_VALUE)   // the shell really was sourced
    expect(result.before).toBe(launchHome)
    expect(result.after).toBe(launchHome)    // and HOME did not follow it
  })

  it('cleans up its scratch tree', () => {
    // Only ever a `mkdtemp` path under the OS temp dir; no real home is named.
    rmSync(root, { recursive: true, force: true })
    expect(root.startsWith(tmpdir())).toBe(true)
  })
})
