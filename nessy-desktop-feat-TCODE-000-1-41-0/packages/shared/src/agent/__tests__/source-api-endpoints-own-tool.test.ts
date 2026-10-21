/**
 * F1.1152 (origin DN-231, 2026-09-28) — a source's `allowedApiEndpoints` grant
 * only that source's OWN API tool.
 *
 * ## The reading, taken first (DN-280, 2026-09-29, host gate `runPreToolUseChecks`)
 *
 * A workspace with two API sources, `linear` and `other`, and one file:
 * `sources/linear/permissions.json` = `{ allowedApiEndpoints: [POST ^/issues] }`.
 * An API source's tool is `api_<slug>` (`buildApiConfig` names the config after
 * the slug; `createApiTool` names the tool `api_<config.name>`), reached as
 * `mcp__<server>__api_<slug>` through the session's MCP servers. At HEAD a
 * `POST /issues` on `other`'s tool — the bare `api_other` and
 * `mcp__other__api_other` alike — ran with NO card in `plan`, `default`,
 * `acceptEdits` and `dontAsk`, where the same call with no file asks (default)
 * or is refused (plan, dontAsk): `applySourceConfig` compiled the file's rules
 * into the ONE global `allowedApiEndpoints` list, and both checks
 * (`isApiCallAllowedWithConfig` in `mode-manager.ts`, `isApiEndpointAllowed` in
 * `core/pre-tool-use.ts`) matched method and path with no tool.
 *
 * ## The fix, and what this file pins
 *
 * The same scoping F1.287 gives a source's `allowedMcpPatterns` and F1.715 its
 * other grants: a rule compiled from a source's file carries that source's slug,
 * and applies only to the API tool whose own name is `api_<slug>`. The call with
 * no file is the control, so the equality cannot pass vacuously. CONTROLS: the
 * source's own `POST` still runs with no card; the same rule in the WORKSPACE
 * permissions still reaches every source's API tool (the route the user keeps).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runPreToolUseChecks, type PermissionManagerLike } from '../core/pre-tool-use.ts'
import type { PermissionMode } from '../mode-types.ts'
import { cleanupModeState, initializeModeState } from '../mode-manager.ts'
import { permissionsConfigCache } from '../permissions-config.ts'

/** Same cold-start budget and reason as `source-permissions-own-tools-only.test.ts` (the same static graph). */
setDefaultTimeout(120_000)

const KEY = { workspaceId: 'ws-f1152', sessionId: 'session-f1152' }
const SLUGS = ['linear', 'other']
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1152-')))
const PROJECT = join(TMP, 'project')
const GRANT = { allowedApiEndpoints: [{ method: 'POST', path: '^/issues' }] }
const POST = { method: 'POST', path: '/issues', body: {} }

let wsSourceFile: string
let wsBare: string
let wsWorkspaceLevel: string

function workspace(name: string, sourceFile?: unknown, workspaceFile?: unknown): string {
  const root = join(TMP, name)
  for (const slug of SLUGS) mkdirSync(join(root, 'sources', slug), { recursive: true })
  if (sourceFile) writeFileSync(join(root, 'sources', 'linear', 'permissions.json'), JSON.stringify(sourceFile))
  if (workspaceFile) writeFileSync(join(root, 'permissions.json'), JSON.stringify(workspaceFile))
  return root
}

beforeAll(() => {
  mkdirSync(PROJECT, { recursive: true })
  wsSourceFile = workspace('source-file', GRANT)
  wsBare = workspace('bare')
  wsWorkspaceLevel = workspace('workspace-level', undefined, GRANT)
  permissionsConfigCache.clear()
})

afterAll(() => {
  cleanupModeState(KEY)
  permissionsConfigCache.clear()
  rmSync(TMP, { recursive: true, force: true })
})

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
}

function verdict(ws: string, toolName: string, mode: PermissionMode): string {
  cleanupModeState(KEY)
  initializeModeState(KEY, mode)
  const result = runPreToolUseChecks({
    toolName, input: POST, sessionId: KEY.sessionId, sessionKey: KEY, permissionMode: mode,
    workspaceRootPath: ws, workspaceId: KEY.workspaceId, workingDirectory: PROJECT,
    activeSourceSlugs: SLUGS, allSourceSlugs: SLUGS, hasSourceActivation: false, permissionManager,
  })
  return result.type === 'prompt' ? `prompt:${result.promptType}` : result.type
}

const MODES: PermissionMode[] = ['plan', 'default', 'acceptEdits', 'dontAsk']
const byMode = (ws: string, toolName: string) => Object.fromEntries(MODES.map(mode => [mode, verdict(ws, toolName, mode)]))
const ALLOW_EVERYWHERE = Object.fromEntries(MODES.map(mode => [mode, 'allow']))

/** Both spellings the gate meets: the bare API tool and the one the session's MCP server exposes. */
const OTHER_TOOLS = ['api_other', 'mcp__other__api_other']
const OWN_TOOLS = ['api_linear', 'mcp__linear__api_linear']

describe("F1.1152 · a source's allowedApiEndpoints grant only its own API tool", () => {
  it("another source's API POST meets the same gate as with no file at all", () => {
    const control = OTHER_TOOLS.map(tool => ({ tool, verdicts: byMode(wsBare, tool) }))
    // The control refuses or asks, so the equality below cannot pass vacuously.
    for (const { verdicts } of control) {
      expect(verdicts.default).not.toBe('allow')
      expect(verdicts.dontAsk).toBe('block')
    }
    expect(OTHER_TOOLS.map(tool => ({ tool, verdicts: byMode(wsSourceFile, tool) }))).toEqual(control)
  })

  it("CONTROL: the source's own API POST still runs with no card, where no file asks", () => {
    for (const tool of OWN_TOOLS) {
      expect({ tool, verdicts: byMode(wsSourceFile, tool) }).toEqual({ tool, verdicts: ALLOW_EVERYWHERE })
      expect(verdict(wsBare, tool, 'default')).not.toBe('allow')
    }
  })

  it('CONTROL: the same rule in the WORKSPACE permissions still reaches every source API tool', () => {
    for (const tool of [...OTHER_TOOLS, ...OWN_TOOLS]) {
      expect({ tool, verdicts: byMode(wsWorkspaceLevel, tool) }).toEqual({ tool, verdicts: ALLOW_EVERYWHERE })
    }
  })
})
