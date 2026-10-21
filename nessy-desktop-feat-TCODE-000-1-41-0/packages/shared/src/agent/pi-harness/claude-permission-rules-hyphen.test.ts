/**
 * F1.367 (origin WJ-hh P-WJ-hh-1) — a HYPHEN in a tool name is part of the
 * documented rule grammar, and the parser refused it on every runtime.
 *
 * ## What the page says (read 2026-09-23, before widening)
 *
 * - `mcp.md` § "Plugin-provided MCP servers": the callable name is
 *   `mcp__plugin_<plugin-name>_<server-name>__<tool-name>`, "where any character
 *   outside `A-Z`, `a-z`, `0-9`, `_`, and `-` is replaced with `_`", with the
 *   worked example `mcp__plugin_my-plugin_database-tools__query` — and "Use this
 *   full name when referencing the tool in permission rules".
 * - `mcp.md`: "Server names added through `claude mcp` commands can contain only
 *   letters, numbers, hyphens, and underscores."
 * - `permissions.md` § MCP: "MCP rules use the server name as configured in
 *   Claude Code, optionally followed by the name of a tool from that server."
 *
 * So the documented character set of a tool name is `A-Z a-z 0-9 _ -`, and the
 * old `RULE_SHAPE` (`[A-Za-z*][A-Za-z0-9_*]*`) dropped every kebab-case source
 * slug and every plugin wire name as `claude_rule.invalid`.
 *
 * ## Why every positive arm EVALUATES the rule, not only parses it
 *
 * AGENTS.md-class trap measured by WJ-hh on this very grammar: a "the rule does
 * not answer" arm written with a hyphenated rule passes VACUOUSLY while the rule
 * never compiled. So each arm below compiles the parsed rule into a DSL program
 * and asserts the ACTION it returns for a matching request, and the negative
 * arms assert the diagnostic code rather than the absence of a match.
 */
import { describe, expect, test } from 'bun:test'
import { parseClaudeRuleString, type ClaudeRuleAction } from './claude-permission-rules.ts'
import { compilePermissionDslV1, evaluatePermissionDslV1 } from './permission-dsl.ts'

function actionFor(rule: string, action: ClaudeRuleAction, toolName: string): string | undefined {
  const parsed = parseClaudeRuleString(rule, action)
  // The rule COMPILED — the assertion that keeps every arm below non-vacuous.
  expect(parsed.warning?.code).not.toBe('claude_rule.invalid')
  expect(parsed.rule).toBeDefined()
  const program = compilePermissionDslV1({
    generation: 'g1',
    projectTrusted: true,
    layers: [{
      scope: 'workspace',
      sourceDigest: 'd1',
      document: { version: 1, rules: [{ id: 'r', ...parsed.rule! }] },
    }],
  })
  return evaluatePermissionDslV1(program, {
    generation: 'g1', semanticId: 'mcp_dynamic', toolName, input: {}, cwd: '/workspace',
  }).action
}

describe('F1.367 · a hyphenated tool name is a rule', () => {
  test('a kebab-case source slug compiles to the mcp matcher and answers its tool', () => {
    expect(parseClaudeRuleString('mcp__google-drive__search', 'allow')).toEqual({
      rule: { action: 'allow', match: { kind: 'mcp', server: 'google-drive', tool: 'search' } },
    })
    expect(actionFor('mcp__google-drive__search', 'allow', 'mcp__google-drive__search')).toBe('allow')
  })

  test("the page's own plugin example compiles, and a deny glob on a hyphenated server answers", () => {
    expect(actionFor('mcp__plugin_my-plugin_database-tools__query', 'allow',
      'mcp__plugin_my-plugin_database-tools__query')).toBe('allow')
    expect(actionFor('mcp__google-drive__*', 'deny', 'mcp__google-drive__search')).toBe('deny')
    expect(actionFor('mcp__google-drive', 'ask', 'mcp__google-drive__search')).toBe('ask')
  })

  test('BOUNDARY: a compiled hyphenated rule still names only its own server', () => {
    // The rule compiled (asserted inside `actionFor`), so this undefined is a
    // real non-match and not the vacuous one.
    expect(actionFor('mcp__google-drive__search', 'deny', 'mcp__google_drive__search')).toBeUndefined()
    expect(actionFor('mcp__google-drive__search', 'deny', 'mcp__linear__search')).toBeUndefined()
  })

  test('NEGATIVE: characters outside the documented set, and a leading hyphen, stay invalid', () => {
    const codes = ['mcp__google.drive__search', 'mcp__google drive__search', '-mcp__x__y']
      .map(raw => parseClaudeRuleString(raw, 'deny').warning?.code)
    expect(codes).toEqual(['claude_rule.invalid', 'claude_rule.invalid', 'claude_rule.invalid'])
    // A trailing hyphen on a built-in is not that built-in: it parses as an
    // UNKNOWN tool and says so, exactly as any other unknown bare name does.
    expect(parseClaudeRuleString('Bash-', 'deny', { knownToolNames: ['Bash'] }).warning?.code)
      .toBe('claude_rule.unknown_tool')
  })

  test('CONTROL: the hyphen-free rule that always compiled still compiles and answers', () => {
    expect(actionFor('mcp__linear__create_issue', 'allow', 'mcp__linear__create_issue')).toBe('allow')
  })
})
