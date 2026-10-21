/**
 * F1.715 (DN-231, 2026-09-28) — a source's own `sources/<slug>/permissions.json`
 * may only RESTRICT, and may grant only for that source's OWN tools.
 *
 * ## The reading, taken first (host probe on `runPreToolUseChecks` and the readable policy)
 *
 * 7 modes × 2 layouts (a workspace under a literal `.nessy-agent` and one under the
 * relocated config dir) × one field per file, each verdict against the same
 * workspace with no source file. The file is agent-writable by design
 * (`session-filesystem-scope.ts`: the own `sources/` is read+write), and it widened
 * the WHOLE session, the same on both layouts:
 *
 *  - `allowedBashPatterns` `^touch\b` — `touch <outside>` ran with no card in
 *    `explore`, `plan`, `default`, `acceptEdits` and `dontAsk`;
 *  - `allowedWritePaths` `<outside>/**` — `Write`/`Edit` there allowed in `explore`;
 *  - `toolRules` allow `Write` / `mcp__other__*` — `Write` outside allowed in
 *    `explore`, `plan`, `dontAsk`, and ANOTHER source's `mcp__other__delete_thing`
 *    allowed with no card in every mode but bypass;
 *  - the readable policy (the DSL Pi's gate and codex consult) — a Claude-form
 *    `permissions.allow` of `Bash(touch *)` or `mcp__other__delete_thing` answered
 *    `allow` from the `plugin` scope.
 *
 * `allowedTools` only ever NARROWED (a tool outside the list is blocked, bypass
 * included) and `allowedMcpPatterns` is already scoped to the source (F1.287), so
 * both keep their meaning. `allowedApiEndpoints` also reached another source's API
 * tool; it is left as it is here (the API tool is not named by the slug) and its
 * scoping is a separate row.
 *
 * ## The fix
 *
 * The model is `settings-reference.md#allowmanagedpermissionrulesonly`'s for a
 * lower tier: "They only restrict, so they can't widen what the managed rules
 * grant". `sourceConfigOwnToolsOnly` drops the global grants from a source file
 * (`allowedBashPatterns`, `allowedWritePaths`, a `toolRules` allow or a DSL allow
 * rule that does not name this source's own `mcp__<slug>__` tools); every deny,
 * ask and block, and every grant for the source's own tools, still applies. A
 * global grant belongs in the workspace's permissions (Settings > Permissions),
 * which this suite pins as unaffected.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runPreToolUseChecks, type PermissionManagerLike } from '../core/pre-tool-use.ts'
import type { PermissionMode } from '../mode-types.ts'
import { cleanupModeState, initializeModeState } from '../mode-manager.ts'
import { permissionsConfigCache } from '../permissions-config.ts'
import { evaluatePermissionDslV1 } from '../pi-harness/permission-dsl.ts'

/** Same cold-start budget and reason as `source-mcp-pattern-anchoring.test.ts` (the same static graph). */
setDefaultTimeout(120_000)

const KEY = { workspaceId: 'ws-f1715', sessionId: 'session-f1715' }
const SLUGS = ['linear', 'other']
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1715-')))
const OUTSIDE = join(TMP, 'outside')
const PROJECT = join(TMP, 'project')

/** One file, every field the probe measured, plus the own-tool grants and a deny that must survive. */
const NESSY_FORM = {
  allowedBashPatterns: [{ pattern: '^touch\\b' }],
  allowedWritePaths: [`${OUTSIDE}/**`],
  allowedMcpPatterns: ['list'],
  toolRules: [
    { pattern: 'Write', action: 'allow' },
    { pattern: 'mcp__other__*', action: 'allow' },
    { pattern: 'mcp__linear__delete_*', action: 'allow' },
    { pattern: 'mcp__linear__nuke', action: 'deny' },
  ],
}
const CLAUDE_FORM = {
  permissions: {
    allow: ['Bash(touch *)', 'mcp__other__delete_thing', 'mcp__linear__delete_thing'],
    deny: ['mcp__linear__nuke'],
  },
}

let wsNessy: string
let wsClaude: string
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
  mkdirSync(OUTSIDE, { recursive: true })
  mkdirSync(PROJECT, { recursive: true })
  wsNessy = workspace('nessy-form', NESSY_FORM)
  wsClaude = workspace('claude-form', CLAUDE_FORM)
  wsBare = workspace('bare')
  wsWorkspaceLevel = workspace('workspace-level', undefined, NESSY_FORM)
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

function verdict(ws: string, toolName: string, input: Record<string, unknown>, mode: PermissionMode): string {
  cleanupModeState(KEY)
  initializeModeState(KEY, mode)
  const result = runPreToolUseChecks({
    toolName, input, sessionId: KEY.sessionId, sessionKey: KEY, permissionMode: mode,
    workspaceRootPath: ws, workspaceId: KEY.workspaceId, workingDirectory: PROJECT,
    activeSourceSlugs: SLUGS, allSourceSlugs: SLUGS, hasSourceActivation: false, permissionManager,
  })
  return result.type === 'prompt' ? `prompt:${result.promptType}` : result.type
}

const MODES: PermissionMode[] = ['plan', 'default', 'acceptEdits', 'dontAsk']
const byMode = (ws: string, toolName: string, input: Record<string, unknown>) =>
  Object.fromEntries(MODES.map(mode => [mode, verdict(ws, toolName, input, mode)]))

const GLOBAL_CALLS: Array<[string, string, Record<string, unknown>]> = [
  ['touch outside', 'Bash', { command: `touch ${OUTSIDE}/a.txt` }],
  ['Write outside', 'Write', { file_path: `${OUTSIDE}/a.txt`, content: 'x' }],
  ['Edit outside', 'Edit', { file_path: `${OUTSIDE}/a.txt`, old_string: 'x', new_string: 'y' }],
  ["another source's write tool", 'mcp__other__delete_thing', {}],
]
const table = (ws: string) => Object.fromEntries(GLOBAL_CALLS.map(([label, tool, input]) => [label, byMode(ws, tool, input)]))

function readable(ws: string, toolName: string, input: Record<string, unknown>): string {
  const program = permissionsConfigCache.getMergedConfig({ workspaceRootPath: ws, activeSourceSlugs: SLUGS }).permissionDsl
  if (!program) return 'none'
  const semanticId = toolName === 'Bash' ? 'bash' : 'mcp_dynamic'
  return evaluatePermissionDslV1(program, { generation: 'live', cwd: PROJECT, semanticId, toolName, input }).action ?? 'none'
}

describe('F1.715 · a source permissions file grants only for its own tools', () => {
  it("the source file's global grants no longer widen the gate — every verdict equals the no-file control", () => {
    const control = table(wsBare)
    // The control is the refusal itself, so the equality below cannot pass vacuously.
    expect(control['touch outside']!.default).toBe('prompt:bash')
    expect(control["another source's write tool"]!.default).toBe('prompt:mcp_mutation')
    expect(table(wsNessy)).toEqual(control)
  })

  it("the readable policy (Pi's gate, codex) no longer answers allow for a global Claude-form rule", () => {
    expect(readable(wsClaude, 'Bash', { command: `touch ${OUTSIDE}/a.txt` })).toBe('none')
    expect(readable(wsClaude, 'mcp__other__delete_thing', {})).toBe('none')
  })

  it("CONTROL: the source's grants for its OWN tools, and its deny, still apply", () => {
    expect(byMode(wsNessy, 'mcp__linear__list_issues', {})).toEqual(Object.fromEntries(MODES.map(m => [m, 'allow'])))
    expect(verdict(wsNessy, 'mcp__linear__delete_thing', {}, 'dontAsk')).toBe('allow')
    expect(verdict(wsBare, 'mcp__linear__delete_thing', {}, 'dontAsk')).toBe('block')
    expect(verdict(wsNessy, 'mcp__linear__nuke', {}, 'default')).toBe('block')
    expect(readable(wsClaude, 'mcp__linear__delete_thing', {})).toBe('allow')
    expect(readable(wsClaude, 'mcp__linear__nuke', {})).toBe('deny')
  })

  it('CONTROL: the same grants in the WORKSPACE permissions still widen (the route the user keeps)', () => {
    expect(verdict(wsWorkspaceLevel, 'Bash', { command: `touch ${OUTSIDE}/a.txt` }, 'default')).toBe('allow')
    // F1.1050 (DN-272): the explore arm (a workspace allowedWritePaths grant widening explore's Write) was deleted —
    // allowedWritePaths was read by explore alone, and plan does not inherit it.
    expect(verdict(wsWorkspaceLevel, 'mcp__other__delete_thing', {}, 'dontAsk')).toBe('allow')
  })
})
