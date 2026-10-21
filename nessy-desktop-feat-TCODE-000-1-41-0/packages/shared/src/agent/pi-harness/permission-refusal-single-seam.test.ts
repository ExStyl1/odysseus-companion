/**
 * P6.210 — the clause that names a rule and its layer is rendered in ONE place,
 * and no setting turns it off.
 *
 * `describeRuleAndScope`'s own docblock has claimed since P2.469 that "every
 * renderer of a readable-policy decision goes through here, so the format moves
 * in one edit or not at all". That claim was prose. It is the load-bearing half
 * of P6.210 — a suppression switch is an S only while there is exactly one
 * place to put it, and it becomes an M the moment a sixth renderer copies the
 * format — so this file makes it a red test instead.
 *
 * The five renderers are driven through the PRODUCTION compiler and the two
 * production evaluators, not hand-built literals: a match object assembled here
 * would agree with itself no matter what the compiler emits.
 *
 * Why no toggle ships with this file, measured 2026-09-07:
 * `settings-reference.md#permissionexplainerenabled` — the key P6.210 named —
 * says "Removed in v2.1.257, together with the `Ctrl+E` command explanation on
 * Bash and PowerShell permission prompts", and what it gated was "a
 * model-generated explanation of the command", not the naming of a rule. The
 * vendored 2.1.247 binary still carries it — re-measured 2026-09-12 at 3 lines
 * / 3 occurrences (C3.252), so the bundle predates the v2.1.257 removal — in its
 * per-user global-config array with
 * one reader guarding an LLM request. Different feature, deleted upstream. The
 * full reading is in the seam's docblock; whether an operator may suppress a
 * MANAGED rule's own text is a product posture and therefore the owner's.
 *
 * Nothing here executes a string; the rule patterns are matcher data.
 */

import { describe, expect, test } from 'bun:test'
import {
  cdPermissionDslDenyReason,
  compilePermissionDslV1,
  describeCdPermissionDslMatch,
  describePermissionDslMatch,
  evaluateCdPermissionDslV1,
  evaluatePermissionDslV1,
  permissionDslAskReason,
  permissionDslDenyReason,
} from './permission-dsl.ts'

const GENERATION = 'p6-210-gen'
const CWD = '/nonexistent/p6-210-cwd'

/** One workspace-scope layer, no filesystem dependence. */
function compile(rules: readonly unknown[]) {
  return compilePermissionDslV1({
    generation: GENERATION,
    projectTrusted: true,
    layers: [{
      scope: 'workspace',
      sourceDigest: 'digest',
      document: { version: 1, generation: GENERATION, rules },
    }],
    canonicalizeRoot: root => root,
  })
}

function bashCall(command: string) {
  return {
    generation: GENERATION,
    semanticId: 'Bash',
    toolName: 'Bash',
    input: { command },
    cwd: CWD,
  }
}

const BASH_TEXT = 'Bash(kubectl:*)'
const CD_TEXT = 'Cd(blocked)'

function bashRule(action: 'deny' | 'ask', text?: string) {
  return [{
    id: 'seam-bash-0',
    action,
    match: { kind: 'bash', pattern: 'kubectl *' },
    ...(text === undefined ? {} : { text }),
  }]
}

function cdRule(text?: string) {
  return [{
    id: 'seam-cd-0',
    action: 'deny',
    match: { kind: 'cdPath', pattern: 'blocked', anchor: 'relative' },
    ...(text === undefined ? {} : { text }),
  }]
}

/** The tool gate's deny/ask evaluation for a `kubectl delete`. */
function toolDecision(action: 'deny' | 'ask', text?: string) {
  return evaluatePermissionDslV1(compile(bashRule(action, text)), bashCall('kubectl delete ns prod'))
}

/** The Cd gate's evaluation for a move into the `blocked` directory. */
function cdDecision(text?: string) {
  return evaluateCdPermissionDslV1(compile(cdRule(text)), { path: `${CWD}/blocked`, cwd: CWD })
}

describe('P6.210 — one seam spells the rule-and-layer clause', () => {
  test('all five renderers emit the byte-identical clause for a named rule', () => {
    // The POSITIVE case. If a sixth renderer ever spells its own copy — the
    // P2.470 defect, a stale duplicate that looks like the real sentence — this
    // set stops being a set of one.
    const bashClause = 'rule `' + BASH_TEXT + '` (workspace scope)'
    const cdClause = 'rule `' + CD_TEXT + '` (workspace scope)'

    const deny = toolDecision('deny', BASH_TEXT)
    const ask = toolDecision('ask', BASH_TEXT)
    const cd = cdDecision(CD_TEXT)

    expect(describePermissionDslMatch(deny.match)).toBe(bashClause)
    expect(describeCdPermissionDslMatch(cd)).toBe(cdClause)

    // The three sentence-level renderers EMBED that same clause rather than
    // rebuilding it, so a divergent copy shows up here even if the two
    // describe* functions above still agree with each other.
    expect(permissionDslDenyReason(deny)).toBe(
      `Denied by readable permission policy ${bashClause}.`,
    )
    expect(permissionDslAskReason(ask)).toBe(
      `Readable permission policy ${bashClause} requires approval.`,
    )
    expect(cdPermissionDslDenyReason(cd)).toBe(
      `This directory is blocked by Cd permission ${cdClause}.`,
    )

    // The set of distinct clause spellings across the deny and ask paths is
    // exactly one — the property the seam's docblock asserts in prose.
    expect(new Set([
      describePermissionDslMatch(deny.match),
      describePermissionDslMatch(ask.match),
    ]).size).toBe(1)
  })

  test('the unnamed fallback is the same one branch, which is where a suppression would go', () => {
    // The NEGATIVE/boundary case, and it is not decoration: it pins the branch a
    // disclosure switch would return — the layer WITHOUT the operator's own
    // string — and that every caller already renders it. Ship the posture, and
    // the change is one condition inside `describeRuleAndScope`.
    const deny = toolDecision('deny')
    const cd = cdDecision()

    // No `text` on the rule, so the seam falls back to the positional id.
    expect(describePermissionDslMatch(deny.match)).toBe('rule `seam-bash-0` (workspace scope)')
    expect(describeCdPermissionDslMatch(cd)).toBe('rule `seam-cd-0` (workspace scope)')

    // ...and the truly-unnamed branch, reached when the name is empty after
    // `displaySafeName`'s control-character scrub. Measured: an empty, blank or
    // tab-only `text` is normalized away upstream and falls back to the id, so
    // a lone control character is the only input that reaches this branch —
    // written as an escape so the source stays greppable (AGENTS.md §Traps).
    const blank = toolDecision('deny', '\u0001')
    expect(describePermissionDslMatch(blank.match)).toBe('a rule (workspace scope)')
    expect(permissionDslDenyReason(blank)).toBe(
      'Denied by readable permission policy a rule (workspace scope).',
    )
  })

  test('no setting suppresses the clause today — asserted, not assumed', () => {
    // P6.210's own subject. Every environment spelling of the key the row named
    // leaves the clause intact, because there is no reader: the vendor key was
    // removed in v2.1.257 and gated an LLM command explanation, not this.
    // A future switch that lands without updating this test goes red here.
    const before = describePermissionDslMatch(toolDecision('deny', BASH_TEXT).match)
    const names = ['permissionExplainerEnabled', 'PERMISSION_EXPLAINER_ENABLED',
      'NESSY_PERMISSION_EXPLAINER_ENABLED', 'CLAUDE_PERMISSION_EXPLAINER_ENABLED']
    try {
      for (const name of names) {
        // `delete` before assign: Bun 1.3.14 leaves a pre-created slot invisible
        // to a spread otherwise (AGENTS.md §Traps).
        delete process.env[name]
        process.env[name] = 'false'
      }
      expect(describePermissionDslMatch(toolDecision('deny', BASH_TEXT).match)).toBe(before)
      expect(before).toBe('rule `' + BASH_TEXT + '` (workspace scope)')
    } finally {
      for (const name of names) delete process.env[name]
    }
  })
})
