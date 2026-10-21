/**
 * UA9.1 — the freestanding source action policy (`agent/source-policy.ts`), extracted from
 * `shouldPromptInAskMode`'s MCP and API arms so the Pages action broker (UA9.2) evaluates the
 * same rules the pre-tool hook does.
 *
 * Arms: GET is allowed (positive); a mutation outside the allowed endpoints requires approval
 * (negative); an allowlisted mutation is allowed, and a SOURCE's own rule reaches only its own
 * `api_<slug>` tool — a caller naming no tool gets the workspace rules alone (F1.1152, fail
 * closed); an MCP read is allowed and an MCP write requires approval; and the AGREEMENT arm —
 * over one matrix, the hook asks exactly when the policy says `requires-approval`, with the
 * same description — which is what fails if the hook stops delegating and the two drift.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { shouldPromptInAskMode, type PermissionManagerLike } from '../core/pre-tool-use.ts'
import { permissionsConfigCache, type PermissionsContext } from '../permissions-config.ts'
import { evaluateApiEndpointPolicy, evaluateMcpToolPolicy } from '../source-policy.ts'

/** The pre-tool-use static graph is a cold start of tens of seconds (same budget as F1.1152's file). */
setDefaultTimeout(120_000)

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-ua91-')))
const GRANT = { allowedApiEndpoints: [{ method: 'POST', path: '^/issues' }] }
let bare: PermissionsContext
let workspaceRule: PermissionsContext
let sourceRule: PermissionsContext

function workspace(name: string, sourceFile?: unknown, workspaceFile?: unknown): PermissionsContext {
  const root = join(TMP, name)
  for (const slug of ['linear', 'other']) mkdirSync(join(root, 'sources', slug), { recursive: true })
  if (sourceFile) writeFileSync(join(root, 'sources', 'linear', 'permissions.json'), JSON.stringify(sourceFile))
  if (workspaceFile) writeFileSync(join(root, 'permissions.json'), JSON.stringify(workspaceFile))
  return { workspaceRootPath: root, activeSourceSlugs: ['linear', 'other'] }
}

beforeAll(() => {
  permissionsConfigCache.clear()
  bare = workspace('bare')
  workspaceRule = workspace('workspace-rule', undefined, GRANT)
  sourceRule = workspace('source-rule', GRANT)
})

afterAll(() => {
  permissionsConfigCache.clear()
  rmSync(TMP, { recursive: true, force: true })
})

describe('UA9.1 · evaluateApiEndpointPolicy', () => {
  it('GET is allowed as read-only — named, lower-case, or absent', () => {
    for (const method of ['GET', 'get', undefined, '']) {
      expect(evaluateApiEndpointPolicy(method, '/issues', bare, 'api_linear')).toEqual({ decision: 'allow', reason: 'read-only' })
    }
  })

  it('a mutation outside the allowed endpoints requires approval, described as the card names it', () => {
    expect(evaluateApiEndpointPolicy('post', '/issues', bare, 'api_linear'))
      .toEqual({ decision: 'requires-approval', description: 'POST /issues' })
    // The workspace rule allows POST ^/issues only: another path and another method still ask.
    expect(evaluateApiEndpointPolicy('POST', '/projects', workspaceRule, 'api_linear'))
      .toEqual({ decision: 'requires-approval', description: 'POST /projects' })
    expect(evaluateApiEndpointPolicy('DELETE', '/issues', workspaceRule, 'api_linear'))
      .toEqual({ decision: 'requires-approval', description: 'DELETE /issues' })
    expect(evaluateApiEndpointPolicy('PATCH', undefined, bare)).toEqual({ decision: 'requires-approval', description: 'PATCH ' })
  })

  it('an allowlisted mutation is allowed; a workspace rule reaches every API tool', () => {
    for (const tool of ['api_linear', 'api_other', 'mcp__other__api_other', undefined]) {
      expect(evaluateApiEndpointPolicy('POST', '/issues', workspaceRule, tool))
        .toEqual({ decision: 'allow', reason: 'endpoint-allowlisted' })
    }
  })

  it("a source's own rule reaches only its own api_<slug> tool; naming no tool fails closed (F1.1152)", () => {
    expect(evaluateApiEndpointPolicy('POST', '/issues', sourceRule, 'api_linear'))
      .toEqual({ decision: 'allow', reason: 'endpoint-allowlisted' })
    expect(evaluateApiEndpointPolicy('POST', '/issues', sourceRule, 'mcp__linear__api_linear'))
      .toEqual({ decision: 'allow', reason: 'endpoint-allowlisted' })
    for (const tool of ['api_other', 'mcp__other__api_other', undefined]) {
      expect(evaluateApiEndpointPolicy('POST', '/issues', sourceRule, tool))
        .toEqual({ decision: 'requires-approval', description: 'POST /issues' })
    }
  })
})

describe('UA9.1 · evaluateMcpToolPolicy', () => {
  it('a read-only MCP call is allowed', () => {
    expect(evaluateMcpToolPolicy('mcp__x__Read', {}, { permissionsContext: bare })).toEqual({ decision: 'allow', reason: 'read-only' })
    expect(evaluateMcpToolPolicy('mcp__x__api_items', { method: 'GET', path: '/items' }))
      .toEqual({ decision: 'allow', reason: 'read-only' })
  })

  it('an MCP mutation requires approval, described as server/tool', () => {
    expect(evaluateMcpToolPolicy('mcp__linear__create_issue', {}, { permissionsContext: bare }))
      .toEqual({ decision: 'requires-approval', description: 'MCP: linear/create_issue' })
    expect(evaluateMcpToolPolicy('mcp__x__api_items', { method: 'POST', path: '/items' }))
      .toEqual({ decision: 'requires-approval', description: 'MCP: x/api_items' })
  })
})

describe('UA9.1 · the pre-tool hook delegates: it asks exactly when the policy requires approval', () => {
  const nothingWhitelisted: PermissionManagerLike = {
    isCommandWhitelisted: () => false,
    isDangerousCommand: () => false,
    getBaseCommand: command => command.split(/\s+/)[0] || command,
    extractDomainFromNetworkCommand: () => null,
    isDomainWhitelisted: () => false,
  }
  const POST = { method: 'POST', path: '/issues' }
  const GET = { method: 'GET', path: '/issues' }

  it('API arm: same verdict and same description over contexts, tools and methods', () => {
    let asked = 0
    let allowed = 0
    for (const context of [bare, workspaceRule, sourceRule]) {
      for (const tool of ['api_linear', 'api_other']) {
        for (const input of [POST, GET, { method: 'DELETE', path: '/issues' }]) {
          const policy = evaluateApiEndpointPolicy(input.method, input.path, context, tool)
          const card = shouldPromptInAskMode(tool, input, nothingWhitelisted, context)
          // The agreement, stated unconditionally (check-conditional-expect asserts the
          // discriminator outside the `if`): the hook allows EXACTLY when the policy
          // allows. The arms below pin the asked card's shape and the allowed identity.
          expect(policy.decision === 'allow').toBe(card === null)
          if (policy.decision === 'allow') {
            allowed++
            expect({ context: context.workspaceRootPath, tool, input, card }).toEqual({ context: context.workspaceRootPath, tool, input, card: null })
          } else {
            asked++
            expect(card).toMatchObject({ promptType: 'api_mutation', description: `API: ${policy.description}`, command: policy.description })
          }
        }
      }
    }
    // Both arms were exercised, so neither equality above held vacuously.
    expect({ asked: asked > 0, allowed: allowed > 0 }).toEqual({ asked: true, allowed: true })
  })

  it('MCP arm: same verdict and same description', () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ['mcp__linear__create_issue', {}],
      ['mcp__slack__post_message', {}],
      ['mcp__x__Read', {}],
      ['mcp__x__api_items', POST],
      ['mcp__x__api_items', GET],
    ]
    for (const [tool, input] of calls) {
      const policy = evaluateMcpToolPolicy(tool, input, { permissionsContext: bare })
      const card = shouldPromptInAskMode(tool, input, nothingWhitelisted, bare)
      if (policy.decision === 'allow') expect({ tool, card }).toEqual({ tool, card: null })
      else expect(card).toMatchObject({ promptType: 'mcp_mutation', description: policy.description, command: tool })
    }
  })

  it("CONTROL: a session whitelist entry stays the hook's — the policy still says requires-approval", () => {
    const whitelisted: PermissionManagerLike = { ...nothingWhitelisted, isCommandWhitelisted: key => key === 'POST /issues' || key === 'mcp__linear__create_issue' }
    expect(shouldPromptInAskMode('api_linear', POST, whitelisted, bare)).toBeNull()
    expect(evaluateApiEndpointPolicy('POST', '/issues', bare, 'api_linear').decision).toBe('requires-approval')
    expect(shouldPromptInAskMode('mcp__linear__create_issue', {}, whitelisted, bare)).toBeNull()
    expect(evaluateMcpToolPolicy('mcp__linear__create_issue', {}, { permissionsContext: bare }).decision).toBe('requires-approval')
  })
})
