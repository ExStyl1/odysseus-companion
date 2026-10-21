/**
 * P2.445 - a Pi permission refusal names the rule that decided and the scope
 * that rule came from.
 *
 * Before this, a DSL deny surfaced as *"Denied by readable permission policy."*
 * and an ask as *"Readable permission policy requires approval."* - neither the
 * rule nor the scope - while `evaluatePermissionDslV1` was returning both at
 * that very call site.
 *
 * Two things are carried from P6.1, which did this on codex:
 *
 * 1. **The rule is named by something the user can search for.** Here that is
 *    NOT the rule id: every id that reaches the merged program is positional
 *    and internal (`claude-settings-deny-3`, `claude-deny-0`, `session-1`), so
 *    the rule's own text rides alongside it. `parsePermissionDslV1` confirms the
 *    id was never a display string - it constrains ids to `[A-Za-z0-9._-]` and
 *    requires them unique, which no rule string satisfies.
 * 2. **The scope is only worth naming where more than one scope can produce the
 *    rule.** P2.400 measured that codex could not, and refused. Pi can: the
 *    merged policy compiles all five, and the five-scope test below drives every
 *    one of them through the production merge rather than asserting the type.
 *
 * These tests assert the RENDERED STRING, not the action enum. P2.421's lesson
 * on the advisor surface was that a mutant which changes only the enum leaves a
 * message-shaped defect invisible; for a permission surface the message is the
 * whole deliverable.
 *
 * Nothing here executes a string. The adversarial spellings (`~`, an absolute
 * root) appear only as MATCHER data, which is the spelling that matters for a
 * permission rule.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parsePermissionsJson, permissionsConfigCache } from '../permissions-config.ts'
import { parseManagedPiPolicyV1 } from './managed-policy.ts'
import {
  compilePermissionDslV1,
  describePermissionDslMatch,
  evaluatePermissionDslV1,
  parsePermissionDslV1,
  permissionDslAskReason,
  permissionDslDenyReason,
  type PermissionDslScope,
} from './permission-dsl.ts'

const GENERATION = 'p2-445-gen'

/** A one-layer program from a raw DSL document, with no filesystem dependence. */
function compile(rules: readonly unknown[], scope: PermissionDslScope = 'workspace') {
  return compilePermissionDslV1({
    generation: GENERATION,
    projectTrusted: true,
    layers: [{ scope, sourceDigest: 'digest', document: { version: 1, generation: GENERATION, rules } }],
    canonicalizeRoot: root => root,
  })
}

function bashCall(command: string) {
  return {
    generation: GENERATION,
    semanticId: 'Bash',
    toolName: 'Bash',
    input: { command },
    cwd: '/nonexistent/p2-445-cwd',
  }
}

describe('P2.445 - the rule is named by what its author wrote', () => {
  test('the rule text wins over the positional id, and the id is still the fallback', () => {
    const withText = evaluatePermissionDslV1(
      compile([{ id: 'claude-settings-deny-0', action: 'deny', match: { kind: 'bash', pattern: 'rm -rf *' }, text: 'Bash(rm -rf *)' }]),
      bashCall('rm -rf ./build'),
    )
    expect(withText.action).toBe('deny')
    expect(withText.match?.ruleText).toBe('Bash(rm -rf *)')
    expect(permissionDslDenyReason(withText)).toBe(
      'Denied by readable permission policy rule `Bash(rm -rf *)` (workspace scope).',
    )

    const withoutText = evaluatePermissionDslV1(
      compile([{ id: 'codex-execpolicy-abc123', action: 'deny', match: { kind: 'bash', pattern: 'rm -rf *' } }]),
      bashCall('rm -rf ./build'),
    )
    expect(withoutText.match?.ruleText).toBeUndefined()
    expect(permissionDslDenyReason(withoutText)).toBe(
      'Denied by readable permission policy rule `codex-execpolicy-abc123` (workspace scope).',
    )
  })

  test('a Claude settings rule string reaches the sentence verbatim, adversarial spelling included', () => {
    // `~` is MATCHER data here - never executed - and it is exactly the
    // spelling a permission rule for a home-anchored path is written in.
    const content = JSON.stringify({
      permissions: { deny: ['Bash(git push:*)', 'Read(~/.ssh)'] },
    })
    const parsed = parsePermissionsJson(content)
    const program = compilePermissionDslV1({
      generation: GENERATION,
      projectTrusted: true,
      layers: [{ ...parsed.permissionDsl!, scope: 'project' }],
      canonicalizeRoot: root => root,
    })
    const decision = evaluatePermissionDslV1(program, bashCall('git push --force'))
    expect(decision.action).toBe('deny')
    // The id the user never saw is still there; it is simply not what is shown.
    expect(decision.match?.ruleId).toBe('claude-settings-deny-0')
    expect(permissionDslDenyReason(decision)).toBe(
      'Denied by readable permission policy rule `Bash(git push:*)` (project scope).',
    )

    // The home-anchored spelling survives the whole chain as written, so the
    // day it decides a request it is the string the user can search for. Its
    // MATCHING is `permission-dsl`'s own contract and is tested there; what is
    // asserted here is that compilation did not launder the spelling away.
    expect(program.rules.map(rule => rule.text)).toEqual(['Bash(git push:*)', 'Read(~/.ssh)'])
  })

  test('a session rule is named by the raw string the user approved, not by `session-N`', () => {
    const merged = permissionsConfigCache.getMergedConfig({
      workspaceRootPath: '/nonexistent/p2-445-session',
      pinnedRevision: GENERATION,
      projectTrusted: true,
      pinnedConfigs: [],
      sessionRules: [{
        raw: 'Bash(curl:*)',
        action: 'deny',
        match: { kind: 'bash', pattern: 'curl *' },
      }],
    })
    const decision = evaluatePermissionDslV1(merged.permissionDsl!, bashCall('curl https://example.invalid'))
    expect(decision.match?.ruleId).toBe('session-0')
    expect(permissionDslDenyReason(decision)).toBe(
      'Denied by readable permission policy rule `Bash(curl:*)` (workspace scope).',
    )
  })
})

describe('P2.445 - the scope is named, and on Pi it is genuinely not a constant', () => {
  const SCOPES: readonly PermissionDslScope[] = ['managed', 'global', 'workspace', 'project', 'plugin']

  test('all five scopes the merged policy compiles reach the sentence, each naming itself', () => {
    const rendered = SCOPES.map(scope => {
      const merged = permissionsConfigCache.getMergedConfig({
        workspaceRootPath: `/nonexistent/p2-445-scope-${scope}`,
        pinnedRevision: GENERATION,
        projectTrusted: true,
        pinnedConfigs: [{
          scope,
          config: parsePermissionsJson(JSON.stringify({ permissions: { deny: ['Bash(rm -rf *)'] } })),
        }],
      })
      const decision = evaluatePermissionDslV1(merged.permissionDsl!, bashCall('rm -rf ./build'))
      expect(decision.action).toBe('deny')
      return permissionDslDenyReason(decision)
    })
    expect(rendered).toEqual([
      'Denied by readable permission policy rule `Bash(rm -rf *)` (managed scope).',
      'Denied by readable permission policy rule `Bash(rm -rf *)` (global scope).',
      'Denied by readable permission policy rule `Bash(rm -rf *)` (workspace scope).',
      'Denied by readable permission policy rule `Bash(rm -rf *)` (project scope).',
      'Denied by readable permission policy rule `Bash(rm -rf *)` (plugin scope).',
    ])
    // The negative half of P2.400's question: five DISTINCT sentences, so the
    // scope is carrying information rather than a constant.
    expect(new Set(rendered).size).toBe(5)
  })

  test("an administrator's `claudeRules` entry survives the managed loader and names itself", () => {
    // M5 of the mutation campaign survived until this existed: the test below
    // builds the managed document by hand, so it never exercised
    // `parseManagedClaudeRulesV1`, which is the loader every real managed
    // policy goes through - and which re-validates its output through the
    // strict parser, so the text has to survive TWO hops to get here.
    const policy = parseManagedPiPolicyV1({
      schemaVersion: 1,
      claudeRules: { deny: ['Bash(kubectl:*)'] },
    })
    expect(policy.permissionDsl?.rules[0]?.id).toBe('claude-deny-0')
    const merged = permissionsConfigCache.getMergedConfig({
      workspaceRootPath: '/nonexistent/p2-445-managed-loader',
      pinnedRevision: GENERATION,
      projectTrusted: true,
      pinnedConfigs: [],
      managedPermissionDsl: policy.permissionDsl,
    })
    const decision = evaluatePermissionDslV1(merged.permissionDsl!, bashCall('kubectl delete ns prod'))
    expect(decision.action).toBe('deny')
    expect(permissionDslDenyReason(decision)).toBe(
      'Denied by readable permission policy rule `Bash(kubectl:*)` (managed scope).',
    )
  })

  test('a managed policy document names the administrator rule and the managed scope', () => {
    const merged = permissionsConfigCache.getMergedConfig({
      workspaceRootPath: '/nonexistent/p2-445-managed',
      pinnedRevision: GENERATION,
      projectTrusted: true,
      pinnedConfigs: [],
      managedPermissionDsl: parsePermissionDslV1({
        version: 1,
        rules: [{ id: 'claude-deny-0', action: 'deny', match: { kind: 'bash', pattern: 'kubectl *' }, text: 'Bash(kubectl:*)' }],
      }),
    })
    const decision = evaluatePermissionDslV1(merged.permissionDsl!, bashCall('kubectl delete ns prod'))
    expect(permissionDslDenyReason(decision)).toBe(
      'Denied by readable permission policy rule `Bash(kubectl:*)` (managed scope).',
    )
  })
})

describe('P2.445 - the sentences', () => {
  test('deny, ask, and the unnamed fallback', () => {
    const ask = evaluatePermissionDslV1(
      compile([{ id: 'claude-settings-ask-2', action: 'ask', match: { kind: 'bash', pattern: 'npm test' }, text: 'Bash(npm test)' }], 'project'),
      bashCall('npm test'),
    )
    expect(ask.action).toBe('ask')
    expect(permissionDslAskReason(ask)).toBe(
      'Readable permission policy rule `Bash(npm test)` (project scope) requires approval.',
    )

    // No rule matched at all: the old unnamed sentences stand, unchanged.
    expect(permissionDslDenyReason({})).toBe('Denied by readable permission policy.')
    expect(permissionDslAskReason({})).toBe('Readable permission policy requires approval.')
    expect(describePermissionDslMatch(undefined)).toBe('')
  })

  test('a compiler diagnostic still wins over the rule name', () => {
    const stale = evaluatePermissionDslV1(compile([]), { ...bashCall('ls'), generation: 'other' })
    expect(stale.action).toBe('deny')
    expect(permissionDslDenyReason(stale)).toBe('Permission DSL generation is stale.')
  })
})

describe('P2.445 - the text is display-only and cannot weaken the policy', () => {
  test('an unusable text is ignored rather than dropping the rule it decorates', () => {
    for (const text of [42, null, {}, '', '   ']) {
      const decision = evaluatePermissionDslV1(
        compile([{ id: 'deny-0', action: 'deny', match: { kind: 'bash', pattern: 'rm -rf *' }, text }]),
        bashCall('rm -rf ./build'),
      )
      // The deny survives; only the display degrades to the id.
      expect(decision.action).toBe('deny')
      expect(permissionDslDenyReason(decision)).toBe(
        'Denied by readable permission policy rule `deny-0` (workspace scope).',
      )
    }
  })

  test('control characters in settings data never reach the sentence', () => {
    const escapeChar = String.fromCharCode(0x1B)
    const deleteChar = String.fromCharCode(0x7F)
    const newlineChar = String.fromCharCode(0x0A)
    const decision = evaluatePermissionDslV1(
      compile([{
        id: 'deny-0',
        action: 'deny',
        match: { kind: 'bash', pattern: 'rm -rf *' },
        text: `Bash(rm${deleteChar} -rf${newlineChar} *)${escapeChar}[31m`,
      }]),
      bashCall('rm -rf ./build'),
    )
    const reason = permissionDslDenyReason(decision)
    expect(reason).toContain('Bash(rm  -rf  *) [31m')
    for (const control of [escapeChar, deleteChar, newlineChar, String.fromCharCode(0x0D)]) {
      expect(reason).not.toContain(control)
    }
  })

  test('an unbounded rule string is bounded before it is stored', () => {
    const decision = evaluatePermissionDslV1(
      compile([{
        id: 'deny-0',
        action: 'deny',
        match: { kind: 'bash', pattern: 'rm -rf *' },
        text: `Bash(${'x'.repeat(4000)})`,
      }]),
      bashCall('rm -rf ./build'),
    )
    expect(decision.match?.ruleText?.length).toBe(161)
    expect(decision.match?.ruleText?.endsWith('…')).toBe(true)
    expect(permissionDslDenyReason(decision).length).toBeLessThan(240)
  })

  test('the strict parser accepts `text` and carries it, so managed rules keep their name', () => {
    const parsed = parsePermissionDslV1({
      version: 1,
      rules: [{ id: 'claude-deny-0', action: 'deny', match: { kind: 'bash', pattern: 'rm -rf *' }, text: 'Bash(rm -rf *)' }],
    })
    expect(parsed.rules[0]?.text).toBe('Bash(rm -rf *)')
    // A rule id is still a handle and not a rule string: the parser rejects one.
    expect(() => parsePermissionDslV1({
      version: 1,
      rules: [{ id: 'Bash(rm -rf *)', action: 'deny', match: { kind: 'bash', pattern: 'rm -rf *' } }],
    })).toThrow()
  })
})

describe('P2.445 - Pi actually renders it', () => {
  const source = readFileSync(new URL('../pi-agent.ts', import.meta.url), 'utf8')
  /**
   * Asserted as a BOOLEAN rather than with `toContain`. `pi-agent.ts` is over
   * ten thousand lines, and a failing `expect(source).toContain(...)` prints
   * the whole file as its `Received` value - four hundred kilobytes of noise
   * per red test, which is what a mutation run produces most of.
   */
  const holds = (needle: string) => source.includes(needle)

  test('all four readable-policy refusal sites compose the named sentence', () => {
    // A green renderer with an unwired caller is exactly the failure this row
    // exists to close, so the wiring is asserted rather than assumed. The four
    // sites are: the first-pass deny, the first-pass ask, the deny on a
    // PermissionRequest hook's `updatedInput` re-gate, and the recheck of a
    // human-approved input.
    expect(source.split('permissionDslDenyReason(').length - 1).toBe(2)
    expect(holds('permissionDslAskReason(readableDecision)')).toBe(true)
    expect(holds('describePermissionDslMatch(readableDecision.match)')).toBe(true)
    expect(holds('describePermissionDslMatch(readableRecheck.match)')).toBe(true)
  })

  test('the unnamed sentences are gone from pi-agent', () => {
    expect(holds("'Denied by readable permission policy.'")).toBe(false)
    expect(holds("'Readable permission policy requires approval.'")).toBe(false)
    // The recheck keeps its unnamed sentence only as the no-rule fallback, so
    // the assertion is that it is no longer the WHOLE message.
    expect(holds('Approved input does not satisfy readable permission policy ${namedRecheck}.')).toBe(true)
  })
})
