/**
 * `tools-reference.md`: "When Monitor runs a command, it uses the same
 * permission rules as Bash, so `allow` and `deny` patterns you have set for
 * Bash apply here too."
 *
 * The rules and the matcher are Bash's; only the identity presented at the gate
 * differs. These tests pin the identity link (binding → descriptor id) and then
 * the matcher behaviour under that identity, because the failure mode here is
 * silent: a `deny Bash(curl *)` rule compiles fine and then never matches.
 */
import { describe, expect, test } from 'bun:test'

import { compilePermissionDslV1, evaluatePermissionDslV1 } from './permission-dsl.ts'
import { parseClaudeRuleString } from './claude-permission-rules.ts'
import { getHarnessToolDescriptor, getPiToolBinding } from './harness-tool-descriptor.ts'

const GENERATION = 'generation-1'

function programFor(rules: { raw: string; action: 'allow' | 'deny' | 'ask' }[]) {
  return compilePermissionDslV1({
    generation: GENERATION,
    projectTrusted: true,
    layers: [{
      scope: 'workspace',
      sourceDigest: 'monitor-test',
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

const monitorRequest = (input: Record<string, unknown>) => ({
  generation: GENERATION,
  // Exactly what pi-agent.ts presents for a session tool: the descriptor id as
  // semanticId, the binding's permissionName as toolName.
  semanticId: getHarnessToolDescriptor(getPiToolBinding('mcp__session__Monitor').descriptorId).id,
  toolName: getPiToolBinding('mcp__session__Monitor').permissionName,
  input,
  cwd: '/workspace',
})

const bashRequest = (command: string) => ({
  generation: GENERATION,
  semanticId: 'bash',
  toolName: 'Bash',
  input: { command },
  cwd: '/workspace',
})

describe('Monitor presents the identity the Bash matchers need', () => {
  test('the binding keeps its own permission name and resolves to the monitor descriptor', () => {
    const binding = getPiToolBinding('mcp__session__Monitor')
    expect(binding.permissionName).toBe('Monitor')
    expect(binding.bindingName).toBe('mcp__session__Monitor')
    expect(getHarnessToolDescriptor(binding.descriptorId).id).toBe('monitor')
  })
})

describe('Bash rules apply to a Monitor command', () => {
  test('a deny Bash(curl *) rule denies the same command inside a Monitor, with the same outcome as a direct Bash call', () => {
    const program = programFor([{ raw: 'Bash(curl *)', action: 'deny' }])
    const direct = evaluatePermissionDslV1(program, bashRequest('curl https://example.test'))
    const monitored = evaluatePermissionDslV1(program, monitorRequest({ command: 'curl https://example.test', description: 'd' }))
    expect(direct.action).toBe('deny')
    expect(monitored.action).toBe('deny')
    expect(monitored.match?.ruleId).toBe(direct.match!.ruleId)
  })

  test('an allow Bash rule permits a Monitor command outright', () => {
    const program = programFor([{ raw: 'Bash(tail:*)', action: 'allow' }])
    expect(evaluatePermissionDslV1(program, monitorRequest({ command: 'tail -f app.log', description: 'd' })).action)
      .toBe('allow')
  })

  test('an exact-argument Bash rule matches through a Monitor too', () => {
    const program = programFor([{ raw: 'Bash(rm -rf /)', action: 'deny' }])
    expect(evaluatePermissionDslV1(program, monitorRequest({ command: 'rm -rf /', description: 'd' })).action).toBe('deny')
    expect(evaluatePermissionDslV1(program, monitorRequest({ command: 'rm -rf ./build', description: 'd' })).action)
      .toBeUndefined()
  })

  test('a Bash command rule never reaches the ws source, which carries no command', () => {
    const program = programFor([{ raw: 'Bash(curl *)', action: 'deny' }])
    expect(evaluatePermissionDslV1(program, monitorRequest({ ws: { url: 'wss://example.test' }, description: 'd' })).action)
      .toBeUndefined()
  })

  test('Monitor keeps a name of its own: a bare deny Monitor rule still matches', () => {
    const program = programFor([{ raw: 'Monitor', action: 'deny' }])
    expect(evaluatePermissionDslV1(program, monitorRequest({ ws: { url: 'wss://example.test' }, description: 'd' })).action)
      .toBe('deny')
    // ...and it does not spill onto ordinary Bash calls.
    expect(evaluatePermissionDslV1(program, bashRequest('echo hi')).action).toBeUndefined()
  })
})
