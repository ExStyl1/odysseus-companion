/**
 * D1.285 (`[safety]`) — a Bash "Always Allow" can never mint a durable grant
 * for a command the dangerous list means to refuse.
 *
 * ## What was driven at HEAD before anything was built, with `rm` as the control
 *
 * ```
 * "git push origin main"  base "git"  dangerous(base)=false dangerous(head)=false  => Bash(git *)
 * "git status"            base "git"  dangerous(base)=false dangerous(head)=false  => Bash(git *)
 * "rm -rf build"          base "rm"   dangerous(base)=true  dangerous(head)=true   => refused
 * "sudo apt install x"    base "apt"  dangerous(base)=false dangerous(head)=true   => refused
 * ```
 *
 * `DANGEROUS_COMMANDS` carries four TWO-word entries (`git push`, `git reset`,
 * `git rebase`, `git checkout`) and every caller looked it up with a ONE-word
 * base command, so those four matched nowhere in the tree. Two durable grants
 * followed from the one defect, and the second is the wider one:
 *
 * 1. Always Allow on `git push origin main` wrote `Bash(git *)` into
 *    `.claude/settings.local.json` — a repository-wide, session-outliving grant
 *    covering all four operations the list calls dangerous, from one click.
 * 2. Always Allow on the harmless `git status` wrote the SAME rule, because a
 *    key of `git` covers every subcommand. That one needs no dangerous command
 *    to be approved at all.
 *
 * ## What is pinned here
 *
 * The REAL `persistBashAlwaysAllowRule` against the REAL settings writer, one
 * temp directory per case, reading the file back. `touch` is the positive
 * control (RS-54's own control: it wrote `Bash(touch *)` while `curl` wrote
 * nothing), so a build that had simply stopped writing anything fails the suite
 * instead of passing it.
 *
 * SAFETY: no real home, no real repository, no credential. Each case owns a
 * `mkdtemp` directory with no `.git` in it or above it, so
 * `resolveClaudeSettingsRoot` resolves to that directory and the write lands
 * inside the temp tree.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestSessionManager } from './test-session-manager.ts'
import { persistedRulesAllow } from './persisted-bash-rule-bound.ts'

interface Internals {
  persistBashAlwaysAllowRule(managed: unknown, command: string): void
}

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/**
 * One answer, start to finish: a session bound to its own empty directory, the
 * production method, and whatever the production writer left on disk.
 */
function allowRulesAfter(command: string): string[] {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'nessy-d1285-'))
  roots.push(workingDirectory)
  const internals = createTestSessionManager() as unknown as Internals
  internals.persistBashAlwaysAllowRule(
    {
      id: 'session-d1285',
      workspace: { id: 'workspace-d1285', rootPath: workingDirectory },
      workingDirectory,
    },
    command,
  )
  const path = join(workingDirectory, '.claude', 'settings.local.json')
  if (!existsSync(path)) return []
  const document = JSON.parse(readFileSync(path, 'utf8')) as { permissions?: { allow?: string[] } }
  return document.permissions?.allow ?? []
}

describe('D1.285 · Always Allow never mints a grant the dangerous list refuses', () => {
  test('the four two-word entries persist NOTHING — and `touch` proves the writer works', () => {
    // The positive control FIRST: without it, every assertion below passes
    // against a build that has stopped writing rules altogether. D1.404 moved
    // this expectation from `Bash(touch *)` to the prefix the card actually
    // showed — the same key the session store mints for the same click.
    // UA12.70 — `touch` is a single-purpose command keyed by NAME (upstream v0.14.0).
    expect(allowRulesAfter('touch a.txt')).toEqual(['Bash(touch *)'])

    for (const command of [
      'git push origin main',
      'git reset --hard HEAD~1',
      'git rebase main',
      'git checkout -f .',
    ]) {
      expect(allowRulesAfter(command)).toEqual([])
    }
    // The one-word floor that always worked, unchanged.
    expect(allowRulesAfter('rm -rf build')).toEqual([])
    expect(allowRulesAfter('sudo apt install ripgrep')).toEqual([])
  })

  test('a safe subcommand buys a rule NARROWED to two tokens, never the base-wide one', () => {
    // `Bash(git *)` would grant `git push` off this very approval, which is the
    // half of the defect that needs no dangerous command to be answered at all.
    expect(allowRulesAfter('git status --short')).toEqual(['Bash(git status --short)']) // UA12.84 — the exact line
    // The negative that makes the assertion above mean something.
    expect(allowRulesAfter('git status --short')).not.toContain('Bash(git *)')
    // D1.404 — this line read `expect(allowRulesAfter('npm run build'))
    // .toEqual(['Bash(npm *)'])` until 2026-09-19, and the PIN WAS THE DEFECT:
    // it recorded a durable, repository-wide, cross-session grant strictly
    // WIDER than the one the same click makes in the session store, where
    // D1.314 had already narrowed it to the leading non-flag tokens. A rule at
    // the bare base covers `npm publish` and `npm install <anything>`, both of
    // which this product's own auto classifier lists as risky.
    // UA12.70 — `npm run` is a runner, so the rule is the exact line with no ` *`:
    // `Bash(npm run build *)` covered `npm run build --delete-all` (SEC-1).
    expect(allowRulesAfter('npm run build')).toEqual(['Bash(npm run build)'])
    expect(allowRulesAfter('npm run build')).not.toContain('Bash(npm *)')
    // An interpreter's exact argv, the SEC-1 probe pair: the rule names one command.
    expect(allowRulesAfter('node -e "console.log(1)"')).toEqual(['Bash(node -e "console.log(1)")'])
    expect(allowRulesAfter('python3 script.py')).toEqual(['Bash(python3 script.py)'])
    // UA12.70 follow-up — a quoted `*` gets an exact key, but `Bash(node -e "x*")`
    // reads it as a wildcard and matched `node -e "x;<anything>"`: no durable rule.
    expect(allowRulesAfter('node -e "x*"')).toEqual([])
    expect(allowRulesAfter(`python3 -c "import glob; print(glob.glob('*.py'))"`)).toEqual([])
    // A grown DANGEROUS pair (upstream v0.14.0) persists nothing.
    expect(allowRulesAfter('git clean -n')).toEqual([])
    expect(allowRulesAfter('git branch')).toEqual([])
  })

  test('a second token that cannot narrow the key writes nothing at all — the boundary', () => {
    // `Bash(git -C *)` covers `git -C /repo push` again, so there is no honest
    // key to write here and the answer stays session-scoped.
    expect(allowRulesAfter('git -C /somewhere push origin main')).toEqual([])
    expect(allowRulesAfter('git')).toEqual(['Bash(git)']) // UA12.70 — a bare `git` is its own exact rule, never `Bash(git *)`
  })
})

/**
 * D1.402 + D1.403 + D1.404 (`[safety]`, F1.12 safety review 2026-09-19) — the
 * three other ways this one writer minted a grant wider than the card showed.
 * All three were confirmed 3/3 by adversarial verifiers driving the real method
 * at HEAD `dfc462e3c`, which answered:
 *
 * ```
 * "npm test"                     => Bash(npm *)          (D1.404)
 * "docker compose up -d"         => Bash(docker *)       (D1.404)
 * "/bin/rm -rf dist"             => Bash(/bin/rm *)      (D1.402)
 * "NODE_ENV=production rm -rf dist" => Bash(NODE_ENV=production *) (D1.402)
 * "bash -c \"rm -rf dist\""      => Bash(bash *)         (D1.403)
 * ```
 *
 * where the plain `rm -rf dist` was correctly refused — the control that says
 * the floor works and only the SPELLING was escaping it.
 */
describe('D1.402/D1.403/D1.404 · the durable rule is never wider than the session key', () => {
  test('D1.404 — a non-pair base is written at the prefix the card named', () => {
    // POSITIVE CONTROL FIRST, on the same instrument.
    expect(allowRulesAfter('touch a.txt')).toEqual(['Bash(touch *)']) // UA12.70 — keyed by name

    expect(allowRulesAfter('npm test')).toEqual(['Bash(npm test)']) // UA12.84 — a leading-words key persists as the exact line
    expect(allowRulesAfter('npm test')).not.toContain('Bash(npm *)')
    expect(allowRulesAfter('docker compose up -d')).toEqual(['Bash(docker compose up -d)'])
    expect(allowRulesAfter('docker compose up -d')).not.toContain('Bash(docker *)')
    // A FLAG ends the SESSION key, so options stay per-invocation there (D1.314);
    // the durable rule is the exact line since UA12.84, because `npm test *` also
    // admitted extra positional words in every later session.
    expect(allowRulesAfter('npm test --coverage')).toEqual(['Bash(npm test --coverage)'])
  })

  test('D1.402 — a path-qualified or assignment-prefixed dangerous head is refused', () => {
    expect(allowRulesAfter('/bin/rm -rf dist')).toEqual([])
    expect(allowRulesAfter('NODE_ENV=production rm -rf dist')).toEqual([])
    expect(allowRulesAfter('/usr/bin/sudo apt install ripgrep')).toEqual([])
    expect(allowRulesAfter('/usr/bin/git push origin main')).toEqual([])
    // The control: the plain spellings were ALWAYS refused, so this is the
    // spelling gap closing rather than a new refusal.
    expect(allowRulesAfter('rm -rf dist')).toEqual([])
    // And the other control — a path-qualified HARMLESS command still buys a
    // rule, at the spelling the card showed.
    expect(allowRulesAfter('/usr/local/bin/npm test')).toEqual(['Bash(/usr/local/bin/npm test)'])
  })

  test('D1.403 — a shell or exec wrapper is never a base', () => {
    expect(allowRulesAfter('bash -c "rm -rf dist"')).toEqual([])
    expect(allowRulesAfter('bash -c "echo hi"')).toEqual([])
    expect(allowRulesAfter('sh -c "npm test"')).toEqual([])
    expect(allowRulesAfter('zsh -lc "git push origin main"')).toEqual([])
    expect(allowRulesAfter('env FOO=1 npm test')).toEqual([])
    expect(allowRulesAfter('xargs rm -rf')).toEqual([])
    // The control on the same rig: an ordinary base still writes its rule, so
    // this is not "the writer stopped writing".
    expect(allowRulesAfter('npm test')).toEqual(['Bash(npm test)'])
  })
})

/**
 * UA12.84 `[security]` — the durable rule of a LEADING-WORDS key is the exact
 * line the card showed (controller decision (b), QUESTIONS.md "UA-cr7 / UA12.70
 * — the DURABLE rule … admits extra positional words").
 *
 * UA12.70 made the session store key-equal, but the durable rule it wrote for a
 * leading-words key was `Bash(<key> *)`, and the rule grammar has no "these words,
 * then flags only" form: `Bash(npm install lodash *)` admitted
 * `npm install lodash evil-pkg` in every later session of the repository on Pi
 * and on the codex host gate. The rule is now the approved line with no ` *`
 * (permissions.md#wildcard-patterns: "A rule with no `*` matches one exact
 * command") — the shape Claude's own dialog stores. Read back through the DSL Pi
 * and the codex host gate evaluate (`persistedRulesAllow`), never by spelling alone.
 */
describe('UA12.84 · a leading-words key persists as the exact approved line', () => {
  test('npm install lodash: the later session grants the line and cards an extra package', () => {
    const rules = allowRulesAfter('npm install lodash')
    expect(rules).toEqual(['Bash(npm install lodash)'])
    expect([persistedRulesAllow(rules, 'npm install lodash'), persistedRulesAllow(rules, 'npm install lodash evil-pkg')]).toEqual([true, false])
    // CONTROL on the same reader: the spelling written before this row admitted the extra package.
    expect(persistedRulesAllow(['Bash(npm install lodash *)'], 'npm install lodash evil-pkg')).toBe(true)
  })

  test('a flagged approval is its own exact line too — no positional word rides after the flag', () => {
    const rules = allowRulesAfter('npm install lodash --save-dev')
    expect(rules).toEqual(['Bash(npm install lodash --save-dev)'])
    expect([
      persistedRulesAllow(rules, 'npm install lodash --save-dev'),
      persistedRulesAllow(rules, 'npm install lodash --save-dev evil-pkg'),
      persistedRulesAllow(rules, 'npm install lodash evil-pkg'),
    ]).toEqual([true, false, false])
  })

  test('a no-operand key (git status) is the exact line as well: `git status -s` asks again in a later session', () => {
    const rules = allowRulesAfter('git status')
    expect(rules).toEqual(['Bash(git status)'])
    expect([persistedRulesAllow(rules, 'git status'), persistedRulesAllow(rules, 'git status -s')]).toEqual([true, false])
  })

  test('CONTROL — a by-name key keeps its class (`touch *`), and a quoted paren line reads back as itself', () => {
    const touch = allowRulesAfter('touch a.txt')
    expect(touch).toEqual(['Bash(touch *)'])
    expect(persistedRulesAllow(touch, 'touch b.txt')).toBe(true)
    const commit = allowRulesAfter('git commit -m "fix (x)"')
    expect(commit).toEqual(['Bash(git commit -m "fix (x)")'])
    expect([persistedRulesAllow(commit, 'git commit -m "fix (x)"'), persistedRulesAllow(commit, 'git commit -m y')]).toEqual([true, false])
  })

  test('BOUNDARY — a leading-words line holding a quoted `*` persists nothing (the rule would read it as a wildcard)', () => {
    expect(allowRulesAfter(`git log -- '*.ts'`)).toEqual([])
  })
})
