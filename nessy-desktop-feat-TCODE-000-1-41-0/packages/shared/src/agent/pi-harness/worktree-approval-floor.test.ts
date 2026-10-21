/**
 * The `EnterWorktree` approval floor, composed the way production composes it.
 *
 * `worktrees.md`: "An `EnterWorktree` permission rule or choosing 'don't ask
 * again' doesn't suppress this prompt; only `bypassPermissions` mode skips it."
 *
 * The failure mode is silent in BOTH directions, which is why this file asserts
 * both halves against real code:
 *
 * 1. An `EnterWorktree` rule must genuinely match — a permission name nothing
 *    matches would make the floor look non-suppressible while actually being
 *    unreachable, and would also break a legitimate `deny EnterWorktree`.
 * 2. A matching `allow` rule must NOT clear the floor prompt. `pi-agent.ts`
 *    merges the readable-DSL decision into the gate decision, and that merge
 *    demotes an `ask` to `allow` whenever an allow rule matches. Gating it on
 *    `promptIsNonNegotiable` is the whole floor.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

import { compilePermissionDslV1, evaluatePermissionDslV1 } from './permission-dsl.ts'
import { parseClaudeRuleString } from './claude-permission-rules.ts'
import { getPiToolBinding, getHarnessToolDescriptor } from './harness-tool-descriptor.ts'
import { promptIsNonNegotiable, type PreToolUseCheckResult } from '../core/pre-tool-use.ts'
import { isInsideWorktreeNamespace, resolveWorktreeNamespace } from './worktree-layout.ts'

const GENERATION = 'generation-1'

function programFor(rules: { raw: string; action: 'allow' | 'deny' | 'ask' }[]) {
  return compilePermissionDslV1({
    generation: GENERATION,
    projectTrusted: true,
    layers: [{
      scope: 'workspace',
      sourceDigest: 'worktree-floor-test',
      document: {
        version: 1,
        rules: rules.map((rule, index) => {
          const parsed = parseClaudeRuleString(rule.raw, rule.action)
          if (!parsed.rule) throw new Error(`rule did not parse: ${rule.raw}`)
          return { id: `rule-${index}`, ...parsed.rule }
        }),
      },
    }],
  })
}

/** Exactly what pi-agent.ts presents for a session tool. */
const enterRequest = (input: Record<string, unknown>) => ({
  generation: GENERATION,
  semanticId: getHarnessToolDescriptor(getPiToolBinding('mcp__session__EnterWorktree').descriptorId).id,
  toolName: getPiToolBinding('mcp__session__EnterWorktree').permissionName,
  input,
  cwd: '/projects/app',
})

/** The gate's floor decision, in the shape `runPreToolUseChecks` returns it. */
const floorPrompt: PreToolUseCheckResult = {
  type: 'prompt',
  // Its own prompt type (R2) — never `admin_approval`, whose answers route
  // through the privileged-execution broker and fail closed unregistered.
  promptType: 'worktree_approval',
  description: 'Enter the worktree at /elsewhere?',
  nonNegotiable: 'worktreeApproval',
}

describe('the documented tool names are the permission-rule names', () => {
  test('EnterWorktree and ExitWorktree are the permission names verbatim', () => {
    expect(getPiToolBinding('mcp__session__EnterWorktree').permissionName).toBe('EnterWorktree')
    expect(getPiToolBinding('mcp__session__ExitWorktree').permissionName).toBe('ExitWorktree')
    expect(getPiToolBinding('mcp__session__EnterWorktree').bindingName).toBe('mcp__session__EnterWorktree')
    expect(getPiToolBinding('mcp__session__ExitWorktree').bindingName).toBe('mcp__session__ExitWorktree')
  })

  test('an EnterWorktree rule really matches, in both directions', () => {
    const allow = evaluatePermissionDslV1(programFor([{ raw: 'EnterWorktree', action: 'allow' }]), enterRequest({}))
    expect(allow.action).toBe('allow')

    const deny = evaluatePermissionDslV1(programFor([{ raw: 'EnterWorktree', action: 'deny' }]), enterRequest({}))
    expect(deny.action).toBe('deny')
  })
})

describe('an allow rule cannot suppress the floor prompt', () => {
  test('the floor prompt is non-negotiable even with a matching allow rule', () => {
    const decision = evaluatePermissionDslV1(
      programFor([{ raw: 'EnterWorktree', action: 'allow' }]),
      enterRequest({ path: '/elsewhere' }),
    )
    expect(decision.action).toBe('allow')
    // The merge in pi-agent.ts demotes ask → allow only when this is false.
    expect(promptIsNonNegotiable(floorPrompt)).toBe(true)
  })

  test('pi-agent gates the allow-rule demotion on promptIsNonNegotiable', () => {
    // A source pin, because the branch itself is what a future edit would drop:
    // the three functions above all keep returning the right values while the
    // demotion silently stops consulting them.
    const source = readFileSync(join(import.meta.dir, '..', 'pi-agent.ts'), 'utf8')
    expect(source).toContain(
      "} else if (readableDecision.action === 'allow' && decision.outcome === 'ask'\n"
      + '          && !promptIsNonNegotiable(checkResult)\n',
    )
    // D1 added a SECOND gate on the same branch — `autoMode.classifyAllShell`
    // suspends "every Bash and PowerShell allow rule while auto mode is active"
    // (`auto-mode-config.md:226`), and this branch is the last site where an
    // allow rule can still clear a prompt. Pinned for the same reason as the
    // line above: the branch is what a future edit would quietly drop.
    expect(source).toContain(
      "          && !(checkResult.type === 'prompt' && checkResult.shellAllowRulesSuspended)) {",
    )
  })

  test('the floor carries no remember window, so "don\'t ask again" has nothing to store', () => {
    // rememberForMinutes + commandHash ARE the don't-ask-again mechanism
    // (SessionManager.storeAdminRememberApproval keys off commandHash).
    expect('rememberForMinutes' in floorPrompt).toBe(false)
    expect('commandHash' in floorPrompt).toBe(false)
  })
})

describe('the worktree namespace is one rule', () => {
  test('the namespace is a sibling of the repository, keyed by its slug', () => {
    expect(resolveWorktreeNamespace('/projects/App Repo')).toEqual({
      repoRoot: '/projects/App Repo',
      containmentRoot: '/projects',
      namespaceRoot: '/projects/.nessy-worktrees/app-repo',
    })
  })

  test('containment is exact and fails closed', () => {
    const repo = '/projects/app'
    expect(isInsideWorktreeNamespace('/projects/.nessy-worktrees/app', repo)).toBe(true)
    expect(isInsideWorktreeNamespace('/projects/.nessy-worktrees/app/lease-1', repo)).toBe(true)
    // A sibling namespace whose name merely starts the same must not match.
    expect(isInsideWorktreeNamespace('/projects/.nessy-worktrees/app-other', repo)).toBe(false)
    expect(isInsideWorktreeNamespace('/projects/app/sub', repo)).toBe(false)
    expect(isInsideWorktreeNamespace('/projects/.nessy-worktrees/app/../../elsewhere', repo)).toBe(false)
    expect(isInsideWorktreeNamespace('', repo)).toBe(false)
    expect(isInsideWorktreeNamespace('/projects/.nessy-worktrees/app', '/')).toBe(false)
  })
})
