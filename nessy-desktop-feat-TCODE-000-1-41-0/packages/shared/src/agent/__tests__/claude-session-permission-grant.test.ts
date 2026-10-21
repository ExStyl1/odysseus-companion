/**
 * C3.279 + C3.278 — the privilege boundary, and the one seam that may produce an
 * `updatedPermissions` on the claude runtime.
 *
 * The boundary exists BEFORE its first producer on purpose. C3.85 drove all six
 * update kinds against all five destinations on the vendored `2.1.247` and every
 * one succeeded — `userSettings` writing `<CLAUDE_CONFIG_DIR>/settings.json`,
 * `projectSettings` writing a file a repository checks in, `removeRules`
 * emptying `permissions.allow` — so this runtime shares none of the refusals
 * `PiAgent.applyPermissionRequestUpdates` makes by name. Harmless while nothing
 * returns updates; a defect the moment something does.
 *
 * The seam is `buildClaudeCanUseTool`'s `sessionPermissionGrant`, and C3.7
 * measured what it is for: a session-scoped `addDirectories` returned from that
 * callback applies to the rest of the running turn with no respawn and writes
 * nothing anywhere.
 *
 * **C3.314 adds the third block below.** C3.281's measurement — the runtime
 * answers `success` for a `setMode: bypassPermissions` it does not apply — was
 * written into a comment and the refusals it justifies reached `debug` alone,
 * which a packaged build never prints. The notice is the user-facing half, and
 * the arm that matters most is the DISCRIMINATOR: a refusal that is not about
 * `setMode` must not carry the bypass sentence, or the one fact worth a sentence
 * becomes boilerplate the user learns to skip.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { i18n, setupI18n } from '../../i18n/index.ts'

import {
  buildClaudeCanUseTool,
  claudeSessionPermissionUpdateBoundary,
  formatClaudeSessionGrantRefusalNotice,
  type ClaudeToolApprovalAnswer,
} from '../claude-agent.ts'

const OFFERED = [{
  type: 'addRules',
  behavior: 'allow',
  destination: 'session',
  rules: [{ toolName: 'Bash', ruleContent: 'echo c3279:*' }],
}]

/**
 * ENGLISH IS PINNED, and awaited, because this suite asserts English copy.
 *
 * The i18n instance is a module-scope SINGLETON shared by every file in a
 * `bun test` process, and sibling suites in this very directory switch it to
 * `ru` on purpose (`base-agent-budget-i18n.test.ts`, whose own docblock records
 * that an un-awaited restore once cost CI eight unrelated reds). This file
 * passed ALONE and failed in the whole-repo run on CI job 630520568, receiving
 * Russian where it expected English — a contamination no per-package split of
 * the job can fix, since the amputator and the victim are siblings.
 *
 * Pinning on the VICTIM rather than chasing the amputator is deliberate: it is
 * one awaited line, it holds against any future suite that switches the
 * language, and it cannot be defeated by hook-ordering between files.
 */
beforeAll(async () => {
  if (!i18n.isInitialized) setupI18n()
  await i18n.changeLanguage('en')
})

describe('C3.279 — the boundary', () => {
  it('ALLOWS a session-scoped addDirectories on its own merit', () => {
    const verdict = claudeSessionPermissionUpdateBoundary([
      { type: 'addDirectories', destination: 'session', directories: ['/srv/data'] },
    ])

    expect(verdict.allowed).toHaveLength(1)
    expect(verdict.allowed[0]!.directories).toEqual(['/srv/data'])
    expect(verdict.refusals).toHaveLength(0)
  })

  it('REFUSES every settings destination, including the one that writes nothing', () => {
    // `cliArg` is in this list deliberately: C3.85 measured it writing nothing
    // at all, and an entry that silently does nothing is a grant a user may
    // believe in.
    for (const destination of ['userSettings', 'projectSettings', 'localSettings', 'cliArg']) {
      const verdict = claudeSessionPermissionUpdateBoundary([
        { type: 'addDirectories', destination, directories: ['/srv/data'] },
      ])
      expect({ destination, allowed: verdict.allowed.length }).toEqual({ destination, allowed: 0 })
      expect(verdict.refusals.join(' ')).toContain(destination)
    }
  })

  it('REFUSES every removal and replacement, at session scope too', () => {
    for (const type of ['removeRules', 'replaceRules', 'removeDirectories']) {
      const verdict = claudeSessionPermissionUpdateBoundary([
        { type, destination: 'session', directories: ['/srv/data'], rules: [{ toolName: 'Bash' }] },
      ])
      expect({ type, allowed: verdict.allowed.length }).toEqual({ type, allowed: 0 })
      expect(verdict.refusals.join(' ')).toContain('did not add')
    }
  })

  it('REFUSES setMode, which the runtime accepts and then silently drops', () => {
    const verdict = claudeSessionPermissionUpdateBoundary([
      { type: 'setMode', destination: 'session', mode: 'bypassPermissions' },
    ])

    expect(verdict.allowed).toHaveLength(0)
    expect(verdict.refusals.join(' ')).toContain('setMode')
  })

  it('accepts addRules ONLY when it echoes what the runtime offered for this call', () => {
    const echoed = claudeSessionPermissionUpdateBoundary(
      [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'echo c3279:*' }] }],
      { offeredSuggestions: OFFERED },
    )
    expect(echoed.allowed).toHaveLength(1)

    // The discriminator: a rule nobody offered is not an echo of a user's
    // choice, it is a rule invented downstream. Same shape, one character
    // different, and the same call's suggestions in hand.
    const invented = claudeSessionPermissionUpdateBoundary(
      [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf:*' }] }],
      { offeredSuggestions: OFFERED },
    )
    expect(invented.allowed).toHaveLength(0)
    expect(invented.refusals.join(' ')).toContain('echo a suggestion')

    // …and with nothing offered at all, the echo test cannot pass vacuously.
    const nothingOffered = claudeSessionPermissionUpdateBoundary(
      [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'echo c3279:*' }] }],
    )
    expect(nothingOffered.allowed).toHaveLength(0)
  })

  it('refuses junk without throwing, so a refused entry cannot cost the approval', () => {
    const verdict = claudeSessionPermissionUpdateBoundary([
      null,
      'a string',
      { type: 'addDirectories', destination: 'session', directories: [] },
      { type: 'somethingNew', destination: 'session' },
      { type: 'addDirectories', destination: 'session', directories: ['/srv/ok'] },
    ])

    expect(verdict.allowed).toHaveLength(1)
    expect(verdict.refusals).toHaveLength(4)
  })
})

function canUseTool(
  overrides: Partial<Parameters<typeof buildClaudeCanUseTool>[0]> = {},
  answer: ClaudeToolApprovalAnswer = { allowed: true },
) {
  return buildClaudeCanUseTool({
    askUser: async () => { throw new Error('not used') },
    askPermission: async () => answer,
    alreadyApprovedByGate: () => false,
    permissionMode: () => 'default',
    ...overrides,
  })
}

const CALL_OPTIONS = {
  signal: new AbortController().signal,
  suggestions: OFFERED,
  blockedPath: '/srv/data/notes.md',
} as never

describe('C3.278 — the seam', () => {
  it('with NO host callback the result is byte-identical to HEAD', async () => {
    const result = await canUseTool()('Read', { file_path: '/srv/data/notes.md' }, CALL_OPTIONS)

    expect(result).toEqual({ behavior: 'allow' })
    // `CanUseTool` may answer `null`, which the SDK's own comment calls
    // fail-closed; every assertion below therefore says so rather than letting
    // the optionality hide a path that never returned.
    expect(result).not.toBeNull()
    expect('updatedPermissions' in result!).toBe(false)
  })

  it('hands the host the runtime\'s own suggestions and blocked path, after the allow', async () => {
    const seen: unknown[] = []
    await canUseTool({
      sessionPermissionGrant: input => { seen.push(input); return undefined },
    })('Read', { file_path: '/srv/data/notes.md' }, CALL_OPTIONS)

    expect(seen).toHaveLength(1)
    const input = seen[0] as { toolName: string; blockedPath?: string; suggestions?: unknown[]; answer: ClaudeToolApprovalAnswer }
    expect(input.toolName).toBe('Read')
    expect(input.blockedPath).toBe('/srv/data/notes.md')
    expect(input.suggestions).toEqual(OFFERED)
    // The answer rides with it: a grant that outlives one call needs the answer
    // that granted it, which is why the seam runs after the ask and not before.
    expect(input.answer.allowed).toBe(true)
  })

  it('is NOT consulted when the user declined', async () => {
    let calls = 0
    const result = await canUseTool(
      { sessionPermissionGrant: () => { calls += 1; return [] } },
      { allowed: false, comment: 'no' },
    )('Read', { file_path: '/srv/data/notes.md' }, CALL_OPTIONS)

    expect(calls).toBe(0)
    expect(result).not.toBeNull()
    expect(result!.behavior).toBe('deny')
  })

  it('passes what the host returns through the boundary, and drops what it refuses', async () => {
    const result = await canUseTool({
      sessionPermissionGrant: () => [
        { type: 'addDirectories', destination: 'session', directories: ['/srv/data'] },
        { type: 'addDirectories', destination: 'userSettings', directories: ['/srv/data'] },
      ],
    })('Read', { file_path: '/srv/data/notes.md' }, CALL_OPTIONS)

    expect(result).not.toBeNull()
    expect(result!.behavior).toBe('allow')
    const updates = (result as { updatedPermissions?: unknown[] }).updatedPermissions
    expect(updates).toHaveLength(1)
    expect((updates![0] as { destination: string }).destination).toBe('session')
  })

  it('returns a plain allow when the boundary refuses everything', async () => {
    const debug: string[] = []
    const result = await canUseTool({
      debug: message => debug.push(message),
      sessionPermissionGrant: () => [{ type: 'setMode', destination: 'session', mode: 'bypassPermissions' }],
    })('Read', { file_path: '/srv/data/notes.md' }, CALL_OPTIONS)

    // The approval the user gave survives a refused grant — the whole reason the
    // boundary reports rather than throws.
    expect(result).toEqual({ behavior: 'allow' })
    expect(debug.join(' ')).toContain('grant refused')
  })
})

describe('C3.314 — the refusal a user can read', () => {
  it('says nothing at all when nothing was refused', () => {
    const verdict = claudeSessionPermissionUpdateBoundary([
      { type: 'addDirectories', destination: 'session', directories: ['/srv/data'] },
    ])

    // The control without which every arm below is "this formatter always talks".
    expect(verdict.refusals).toHaveLength(0)
    expect(formatClaudeSessionGrantRefusalNotice({ toolName: 'Read', verdict })).toBeUndefined()
  })

  it('names the tool, the count, and the refusal itself', () => {
    const verdict = claudeSessionPermissionUpdateBoundary([
      { type: 'addDirectories', destination: 'session', directories: ['/srv/data'] },
      { type: 'addDirectories', destination: 'userSettings', directories: ['/srv/data'] },
    ])
    const notice = formatClaudeSessionGrantRefusalNotice({ toolName: 'Read', verdict })!

    expect(notice).toContain('Read')
    // The approval is named as surviving: a refused grant must not read as a
    // refused approval, which is the whole reason the boundary reports.
    expect(notice).toContain('stands')
    expect(notice).toContain('userSettings')
  })

  it('carries the measured bypass sentence for setMode, and NOT for anything else', () => {
    const withSetMode = formatClaudeSessionGrantRefusalNotice({
      toolName: 'Bash',
      verdict: claudeSessionPermissionUpdateBoundary([
        { type: 'setMode', destination: 'session', mode: 'bypassPermissions' },
      ]),
    })!
    // The discriminator's negative arm is a refusal of a DIFFERENT kind at the
    // same scope — so the two notices differ by the sentence and by nothing else
    // structural.
    const withoutSetMode = formatClaudeSessionGrantRefusalNotice({
      toolName: 'Bash',
      verdict: claudeSessionPermissionUpdateBoundary([
        { type: 'removeRules', destination: 'session', rules: [{ toolName: 'Bash' }] },
      ]),
    })!

    expect({
      setModeSaysWhy: withSetMode.includes('reports SUCCESS'),
      otherSaysWhy: withoutSetMode.includes('reports SUCCESS'),
    }).toEqual({ setModeSaysWhy: true, otherSaysWhy: false })
    // Both are still one line each — the notice is a sentence, not a log dump.
    expect(withSetMode.includes('\n') || withoutSetMode.includes('\n')).toBe(false)
  })

  it('reaches the user channel ONCE through the seam, with debug still carrying every line', async () => {
    const warnings: string[] = []
    const debug: string[] = []
    const result = await canUseTool({
      warn: message => warnings.push(message),
      debug: message => debug.push(message),
      sessionPermissionGrant: () => [
        { type: 'setMode', destination: 'session', mode: 'bypassPermissions' },
        { type: 'addDirectories', destination: 'userSettings', directories: ['/srv/data'] },
      ],
    })('Bash', { command: 'ls' }, CALL_OPTIONS)

    // ONE user-facing sentence for TWO refusals: the machine-readable half stays
    // on `debug`, per refusal, exactly as it did at HEAD.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('reports SUCCESS')
    expect(debug.filter(line => line.includes('grant refused'))).toHaveLength(2)
    // And the approval the user gave is untouched.
    expect(result).toEqual({ behavior: 'allow' })
  })

  it('is silent on the seam when the grant passes the boundary whole', async () => {
    const warnings: string[] = []
    const result = await canUseTool({
      warn: message => warnings.push(message),
      sessionPermissionGrant: () => [
        { type: 'addDirectories', destination: 'session', directories: ['/srv/data'] },
      ],
    })('Read', { file_path: '/srv/data/notes.md' }, CALL_OPTIONS)

    expect(warnings).toEqual([])
    expect((result as { updatedPermissions?: unknown[] }).updatedPermissions).toHaveLength(1)
  })

  it('with NO warn callback the seam behaves exactly as it did before', async () => {
    // Absent is HEAD: the row must not make the diagnostic load-bearing.
    const result = await canUseTool({
      sessionPermissionGrant: () => [{ type: 'setMode', destination: 'session', mode: 'bypassPermissions' }],
    })('Bash', { command: 'ls' }, CALL_OPTIONS)

    expect(result).toEqual({ behavior: 'allow' })
  })
})
