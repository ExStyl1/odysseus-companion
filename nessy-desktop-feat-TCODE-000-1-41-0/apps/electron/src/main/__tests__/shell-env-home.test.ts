/**
 * The login shell may not re-import `HOME` over the latch — P3.181 — and may not
 * re-import its own bookkeeping about itself at all — P3.192.
 *
 * `latchedHomeDir()` captures `homedir()` at module import so the session's
 * credential source cannot move mid-session. `loadShellEnv()` runs in the
 * bundle's ENTRY BODY, after every module initializer, and used to copy the
 * login shell's whole environment — `HOME` included — over `process.env`. For a
 * user whose profile reassigns `HOME`, the credential source then read the
 * launchd home while every other `os.homedir()` caller in the same process read
 * the shell home.
 *
 * ## What these tests can and cannot prove
 *
 * They test the FILTER, which is the mechanism this file owns. They do not, and
 * cannot, prove the end-to-end claim here: under `bun test` a mutated
 * `process.env.HOME` does not move `os.homedir()` at all — Bun latches it at
 * startup, measured in `packages/shared/src/config/home-latch.ts`'s runtime
 * table — so an end-to-end assertion would pass no matter what the filter did.
 * The end-to-end claim needs a Node-hosted or PACKAGED check: `loadShellEnv()`
 * returns early whenever `VITE_DEV_SERVER_URL` is set, so `electron:dev` cannot
 * show it either.
 *
 * The last test asserts against this module's SOURCE, in the shape
 * `packaged-env-spelling.test.ts` established for the same reason: nothing at
 * runtime catches a future edit that writes `process.env` around the filter
 * instead of through it.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { selectShellEnvVars, shouldSkipEnvVar } from '../shell-env'

/** A login shell's `env` output, in the shape `loadShellEnv` actually receives. */
const DUMP = [
  'some zsh startup chatter that is not environment at all',
  '__ENV_START__',
  'HOME=/Users/someone/reassigned-by-zprofile',
  'PATH=/opt/homebrew/bin:/usr/bin:/bin',
  'HOMEBREW_PREFIX=/opt/homebrew',
  'HOMEBREW_CELLAR=/opt/homebrew/Cellar',
  'JAVA_HOME=/Library/Java/Home',
  'VITE_DEV_SERVER_URL=http://localhost:5173',
  'HTTPS_PROXY=http://proxy.corp:3128',
  'LS_COLORS=di=1;36:ln=35:so=32',
  'SOME_SCRIPT=export HOME=/tmp/not-a-key',
  // P3.192's eight, in the shape a real login shell prints them. The four
  // self-description keys are dropped; the four with readers survive.
  'PWD=/Users/someone',
  'OLDPWD=/Users/someone/elsewhere',
  'SHLVL=1',
  '_=/usr/bin/env',
  'USER=someone',
  'LOGNAME=someone',
  'TERM=xterm-256color',
  'TMPDIR=/var/folders/xx/T/',
].join('\n')

describe('shouldSkipEnvVar', () => {
  it('skips HOME, which is the whole point of P3.181', () => {
    expect(shouldSkipEnvVar('HOME')).toBe(true)
  })

  it('still skips the VITE_* family it was written for', () => {
    // A positive control for the test above: if the predicate had been replaced
    // by a constant `true`, every "is skipped" assertion would pass alone.
    expect(shouldSkipEnvVar('VITE_DEV_SERVER_URL')).toBe(true)
    expect(shouldSkipEnvVar('PATH')).toBe(false)
    expect(shouldSkipEnvVar('HTTPS_PROXY')).toBe(false)
  })

  it('matches HOME exactly and never as a prefix or a suffix', () => {
    // `HOMEBREW_PREFIX` and `HOMEBREW_CELLAR` are in every Homebrew user's real
    // environment, and `JAVA_HOME`/`CARGO_HOME` are in the supervisor's own
    // restricted allowlist. A `startsWith`/`includes` spelling of this rule would
    // silently delete the toolchain discovery this module exists to provide.
    for (const key of ['HOMEBREW_PREFIX', 'HOMEBREW_CELLAR', 'JAVA_HOME', 'CARGO_HOME', 'HOMEPAGE', 'HOM']) {
      expect(shouldSkipEnvVar(key), `${key} must survive`).toBe(false)
    }
  })
})

describe('the four shell self-description keys (P3.192)', () => {
  // The login shell's bookkeeping about ITSELF — the directory it stood in, how
  // deeply it was nested, the last command it ran (always this loader's own
  // `env`). It exits microseconds later, so copying them makes `process.env`
  // describe a dead process, and every spawn site in this tree builds a child
  // env by spreading `process.env`.
  const DROPPED = ['PWD', 'OLDPWD', 'SHLVL', '_'] as const

  // The other four of the eight P3.192 named. Each HAS a reader, and none of
  // them is greppable by name, which is why the row's own "zero readers" was
  // right for the first list and wrong for this one:
  //   USER / LOGNAME / TERM — `RESTRICTED_HOST_ENVIRONMENT` in
  //     `server-core/src/pi-harness/process-supervisor.ts` forwards all three
  //     into the agent's Bash child under the shipped default profile.
  //   TMPDIR — `os.tmpdir()` follows a mid-process `process.env.TMPDIR` on
  //     POSIX; driven on both Bun and Node rather than read.
  const KEPT = ['USER', 'LOGNAME', 'TERM', 'TMPDIR'] as const

  it('drops every one of the four', () => {
    for (const key of DROPPED) {
      expect(shouldSkipEnvVar(key), `${key} must be dropped`).toBe(true)
    }
  })

  it('keeps the four that have a reader — the negative control for the rule above', () => {
    // Without this the rule above is satisfiable by a predicate that drops
    // everything, which is exactly the shape that would silently delete the
    // toolchain discovery this module exists to provide.
    for (const key of KEPT) {
      expect(shouldSkipEnvVar(key), `${key} must survive`).toBe(false)
    }
  })

  it('matches each name exactly, never as a prefix or a substring', () => {
    // `_` is the dangerous one: a `includes('_')` spelling of this rule would
    // delete every `HOMEBREW_PREFIX`-shaped name in the dump, i.e. most of it.
    for (const key of ['PWD_HOME', 'MY_PWD', 'SHLVL_MAX', 'OLDPWDX', '_FOO', 'FOO_', 'HOMEBREW_PREFIX']) {
      expect(shouldSkipEnvVar(key), `${key} must survive`).toBe(false)
    }
  })
})

describe('selectShellEnvVars', () => {
  it('drops HOME from a real dump while keeping everything the loader exists for', () => {
    const selected = selectShellEnvVars(DUMP)
    expect(Object.keys(selected)).not.toContain('HOME')
    // End to end through the parser, not just through the predicate: the four
    // self-description keys never reach the caller that writes `process.env`.
    for (const key of ['PWD', 'OLDPWD', 'SHLVL', '_']) {
      expect(Object.keys(selected), `${key} must not survive the dump`).not.toContain(key)
    }
    expect(selected.USER).toBe('someone')
    expect(selected.TMPDIR).toBe('/var/folders/xx/T/')
    expect(selected.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin')
    expect(selected.HOMEBREW_PREFIX).toBe('/opt/homebrew')
    expect(selected.HTTPS_PROXY).toBe('http://proxy.corp:3128')
  })

  it('drops VITE_*, HOME and the four shell self-description keys, and nothing else', () => {
    const selected = selectShellEnvVars(DUMP)
    expect(Object.keys(selected).sort()).toEqual([
      'HOMEBREW_CELLAR', 'HOMEBREW_PREFIX', 'HTTPS_PROXY', 'JAVA_HOME',
      'LOGNAME', 'LS_COLORS', 'PATH', 'SOME_SCRIPT', 'TERM', 'TMPDIR', 'USER',
    ])
  })

  it('splits on the FIRST `=` only, so a value may contain one', () => {
    const selected = selectShellEnvVars(DUMP)
    expect(selected.LS_COLORS).toBe('di=1;36:ln=35:so=32')
    // The key is what is filtered, never the value: a variable whose value
    // happens to spell `HOME=` is not the variable `HOME`.
    expect(selected.SOME_SCRIPT).toBe('export HOME=/tmp/not-a-key')
  })

  it('ignores everything the shell printed before the marker', () => {
    expect(Object.keys(selectShellEnvVars(DUMP))).not.toContain('some zsh startup chatter that is not environment at all')
    expect(selectShellEnvVars('no marker here at all')).toEqual({})
  })
})

describe('the loader writes process.env only through the filter', () => {
  const source = readFileSync(new URL('../shell-env.ts', import.meta.url), 'utf8')
  const indexedWrites = [...source.matchAll(/process\.env\[[^\]]*\]\s*=/g)]

  it('still writes the imported environment at all', () => {
    // Positive control: an empty match list would let the assertion below pass
    // while proving nothing about where the values come from.
    expect(indexedWrites.length).toBe(1)
  })

  it('feeds that write from selectShellEnvVars and nothing else', () => {
    expect(source).toContain('const selected = selectShellEnvVars(output)')
    expect(source).toContain('for (const [key, value] of Object.entries(selected))')
  })
})
