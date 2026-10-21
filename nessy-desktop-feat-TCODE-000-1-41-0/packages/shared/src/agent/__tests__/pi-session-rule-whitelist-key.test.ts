/**
 * D1.305 `[safety]` — a MODEL-supplied session rule was stored under a key that
 * does not say what the rule asked for.
 *
 * `PiAgent.applyPermissionRequestUpdates` is the one path where something other
 * than a human answer can change a permission rule — a hook's stdout, which the
 * method's own docblock calls attacker-influenceable. Its `addRules` arm
 * compiled `{ toolName: 'Bash', ruleContent: 'git push:*' }` into
 * `whitelistCommand(getBaseCommand('git push'))`, i.e. the key `git`: it tested
 * only the BASE against the dangerous list, and the list's four two-word entries
 * can never match a base.
 *
 * ## What was and was not at risk, measured
 *
 * Since D1.291 both consult sites test the WHOLE command line, so a `git` key
 * could not reach `git push`, `git reset`, `git rebase` or `git checkout` — the
 * stored grant was wider than the rule but bounded by the reader. What changes
 * here is the MODEL-FACING contract: the rule is now refused by name, and a rule
 * that IS allowed is stored at a key that means what it says.
 *
 * ## Three outcomes, not two
 *
 *  - `Bash(git status:*)` — allowed, and stored NARROWED at `git status`, the
 *    same key a human's Always Allow on `git status` stores.
 *  - `Bash(git push:*)` — REFUSED, because the whole prefix is on the list.
 *  - `Bash(git:*)` — allowed and stored at `git`, because a bare one-token
 *    prefix IS what the rule asked for and D1.291's consults bound it. The
 *    un-narrowable middle case (`Bash(git -C /repo push:*)`, whose second token
 *    is a flag) is refused rather than stored at the base, which would be the
 *    grant this row exists to stop.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'
import { createMockBackendConfig, createMockSession, createMockWorkspace } from './test-utils.ts'

interface Internals {
  applyPermissionRequestUpdates: (
    entries: unknown,
    toolName: string,
    offeredSuggestions?: Array<Record<string, unknown>>,
  ) => void
  permissionManager: { getWhitelistedCommands: () => Set<string> }
  debug: (message: string) => void
}

let counter = 0

describe('D1.305 — a model-supplied Bash session rule is stored at the key it names', () => {
  const agents: PiAgent[] = []
  afterEach(() => { for (const agent of agents.splice(0)) agent.destroy() })

  /**
   * Drive the REAL private method on a REAL `PiAgent`, and read both halves of
   * its answer: the whitelist it wrote and the `__PERMISSION_UPDATE__` receipts
   * it emitted, which are the model-facing contract this row changes.
   */
  function applyRule(
    ruleContent: string | undefined,
    ruleToolName = 'Bash',
  ): { stored: string[]; receipts: Array<Record<string, unknown>> } {
    counter += 1
    const root = mkdtempSync(join(tmpdir(), 'd1305-'))
    const agent = new PiAgent(createMockBackendConfig({
      provider: 'pi',
      isHeadless: true,
      skipConfigWatcher: true,
      workspace: createMockWorkspace({
        id: 'ws-d1305', workspaceRootPath: root, sessionRootPath: join(root, 'sessions'),
      }),
      session: createMockSession({ id: `sess-d1305-${counter}`, workingDirectory: root }),
    } as Partial<BackendConfig>))
    agents.push(agent)
    const internals = agent as unknown as Internals
    const receipts: Array<Record<string, unknown>> = []
    internals.debug = (message: string) => {
      const at = message.indexOf('__PERMISSION_UPDATE__')
      if (at < 0) return
      receipts.push(JSON.parse(message.slice(at + '__PERMISSION_UPDATE__'.length)) as Record<string, unknown>)
    }
    internals.applyPermissionRequestUpdates(
      [{
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: ruleToolName, ...(ruleContent === undefined ? {} : { ruleContent }) }],
      }],
      ruleToolName,
    )
    return { stored: [...internals.permissionManager.getWhitelistedCommands()], receipts }
  }

  it('narrows a pair-heading rule to the two tokens it names', () => {
    const { stored, receipts } = applyRule('git status:*')

    expect(stored).toEqual(['git status'])
    // The receipt reports the key it actually wrote, because that is what the
    // model is being told it got.
    expect(receipts.some(r => JSON.stringify(r.applied ?? '').includes('git status'))).toBe(true)
  })

  it('REFUSES a rule whose whole prefix is on the dangerous list', () => {
    const { stored, receipts } = applyRule('git push:*')

    expect(stored).toEqual([])
    expect(receipts.map(r => r.code)).toContain('updated_permissions_refused')
    // The refusal NAMES the rule, which is the half a model can act on.
    expect(receipts.some(r => typeof r.message === 'string' && r.message.includes('git push:*'))).toBe(true)
  })

  it('REFUSES a rule whose key cannot be narrowed without widening it', () => {
    // `git -C /repo push` is not caught by the list (its second token is a flag),
    // and storing it at `git` would be the grant this row stops.
    expect(applyRule('git -C /repo push:*').stored).toEqual([])
  })

  it('UA12.70 — REFUSES a BARE one-token wildcard rule: its key would be wider than any click', () => {
    // It stored `git` until UA12.70, and `git` covered `git clean -fdx` and
    // `git branch -D main` (SEC-1/SEC-2). A bare CLI name is its own exact argv now,
    // so a wildcard over it names no key at all.
    expect(applyRule('git:*').stored).toEqual([])
  })

  it('the controls: an ordinary rule is unchanged, and a one-word dangerous name is still refused', () => {
    // POSITIVE CONTROL that the rig writes at all — without it every absence
    // above would pass on an agent that stopped applying rules entirely.
    expect(applyRule('npm test:*').stored).toEqual(['npm test']) // UA12.70 — a leading-words key (bare `npm:*` stores nothing)
    // `rm` was ALWAYS caught, because it is a one-word entry and the old check
    // tested the base. It is the control that says what this row did and did not
    // change.
    expect(applyRule('rm:*').stored).toEqual([])
    expect(applyRule('rm -rf build:*').stored).toEqual([])
  })

  it('D1.315 — a BARE api_* rule reaches the store, and the API consult now reads it', () => {
    // The WRITER half of D1.315, end to end: the bare-tool arm stores the tool
    // name, and `shouldPromptInAskMode`'s API arm reads that key since D1.315.
    // Before it, this rule was applied, receipted as applied, and inert.
    const { stored, receipts } = applyRule(undefined, 'api_linear')

    expect(stored).toEqual(['api_linear'])
    expect(receipts.some(r => JSON.stringify(r.applied ?? '').includes('api_linear'))).toBe(true)
  })

  it('D1.314 — a NON-pair prefix is stored at the prefix the rule NAMED', () => {
    // This case was born asserting `npm`, with the reason recorded: the ask-mode
    // consult looked a non-pair command up by its BASE, so a key of `npm test`
    // would have been one no reader finds. D1.314 taught that consult to look up
    // leading-token PREFIXES longest first, which is what makes the narrow key
    // findable — so the limit this case recorded is closed and it now pins the
    // width the rule asked for.
    expect(applyRule('npm test:*').stored).toEqual(['npm test'])
    // UA12.70 — `npm run` is a runner (exact argv): a wildcard over it stores nothing, the exact rule its own key.
    expect([applyRule('npm run build:*').stored, applyRule('npm run build').stored]).toEqual([[], ['exact:["npm","run","build"]']])
  })
  it('D1.412 — an INTERPRETER rule mints nothing, even as a bare one-token prefix', () => {
    // D1.403 taught `bashSessionWhitelistKey` to refuse a head that runs its own
    // argument, and this arm walked straight past it: the refusal is the FIRST
    // half of `bashSessionWhitelistKey(...) ?? (oneToken ? baseCommand : null)`,
    // so the fallback handed back the very key the first half had just declined.
    // Measured at HEAD `4333cd155` through this arm's own expression:
    //
    //   bash:*  -> key "bash"  refused false
    //   sh:*    -> key "sh"    refused false
    //   env:*   -> key "env"   refused false
    //
    // and with `bash` stored, `bash -c "rm -rf x"` passes the ask-mode consult —
    // one segment, matched at width 1, and the floor's head is `bash`, which is
    // not on the dangerous list. So a model could ask for, and be granted, a key
    // that means every shell script for the rest of the session.
    for (const rule of ['bash:*', 'sh:*', 'zsh:*', 'env:*', 'xargs:*', 'eval:*', 'fish:*']) {
      expect([rule, applyRule(rule).stored]).toEqual([rule, []])
    }
    // The receipt must SAY so rather than applying silently — a model that is
    // refused and not told will ask again in a loop.
    const { receipts } = applyRule('bash:*')
    expect(JSON.stringify(receipts)).toContain('updated_permissions_refused')
  })

  it('D1.412 — the controls: ordinary one-token rules are untouched', () => {
    // POSITIVE CONTROL on the same instrument: the arm is live, so the absences
    // above are a refusal and not a rig that stopped writing.
    // UA12.70 — the positive controls are leading-words keys now (a bare `npm:*`/`git:*`/`docker:*` stores nothing).
    expect(applyRule('npm test:*').stored).toEqual(['npm test'])
    expect(applyRule('docker compose ps:*').stored).toEqual(['docker compose ps'])
    // The two-token path already refused before this row, and still does.
    expect(applyRule('bash -c:*').stored).toEqual([])
    // A name that merely CONTAINS an interpreter name is not one: its exact rule keys its exact argv.
    expect(applyRule('bashfoo --help').stored).toEqual(['exact:["bashfoo","--help"]'])
    expect(applyRule('shellcheck x.sh').stored).toEqual(['exact:["shellcheck","x.sh"]'])
  })
})
