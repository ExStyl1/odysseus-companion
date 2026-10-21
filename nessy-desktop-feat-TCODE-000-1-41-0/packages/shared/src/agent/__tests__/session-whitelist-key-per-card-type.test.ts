/**
 * D1.306 `[safety]` — the session whitelist was WRITTEN under one key and READ
 * under another, for two of the four card types.
 *
 * `ClaudeAgent.respondToPermission` stored `getBaseCommand(card.command)` for
 * every card, and the consults in `shouldPromptInAskMode` look something else
 * up. Driven at HEAD through the real classes, with an unwhitelisted run of each
 * as the control that says the instrument reads:
 *
 * ```
 * file_write  card.command "/tmp/…/notes.md"        stored "/tmp/…/notes.md"  next identical Write  prompt=true
 * mcp         card.command "mcp__linear__createIssue" stored the same          next identical call   prompt=false
 * api         card.command "POST /v1/x"             stored "POST"             next identical POST   prompt=true
 * ```
 *
 * So Always Allow on a file write or an API mutation bought NOTHING and said
 * nothing. The MCP card is the control in both directions: it stored and
 * consulted the same tool name, it worked, and this row does not change it.
 *
 * ## The per-path key is a decision, not a transcription
 *
 * "Store the key the consult uses" has two readings for a file write, because
 * the consult reads the bare TOOL NAME. Storing that would make one approval of
 * one file a session-wide write grant — D1.285's "wider half" one surface over.
 * So the human's click stores `Write:/path` and the consult accepts BOTH
 * spellings: the bare name is what a model-supplied session rule writes
 * (`pi-agent.ts`'s `addRules` bare-tool arm) and legitimately means every write
 * this session. Both arms are pinned below, because a fix that closed the
 * silent-grant defect by deleting the broad rule's meaning would look identical
 * in a diff.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ClaudeAgent } from '../claude-agent.ts'
import type { BackendConfig } from '../backend/types.ts'
import { PermissionManager } from '../core/permission-manager.ts'
import { shouldPromptInAskMode, sessionWhitelistKeyForApproval } from '../core/pre-tool-use.ts'

const WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'd1306-ws-'))
const WRITE_TARGET = join(WORKSPACE_ROOT, 'notes.md')
const OTHER_TARGET = join(WORKSPACE_ROOT, 'other.md')

function permissionManager(): PermissionManager {
  return new PermissionManager({
    workspaceId: 'ws-d1306',
    sessionId: 'sess-d1306',
    workspaceRootPath: WORKSPACE_ROOT,
  })
}

const context = { workspaceRootPath: WORKSPACE_ROOT, activeSourceSlugs: [] }

function asks(manager: PermissionManager, toolName: string, input: Record<string, unknown>): boolean {
  return shouldPromptInAskMode(toolName, input, manager, context) !== null
}

describe('D1.306 — the writer and the consult agree, per card type', () => {
  const agents: ClaudeAgent[] = []
  afterEach(() => { for (const agent of agents.splice(0)) agent.destroy() })

  interface Internals {
    respondToPermission: (requestId: string, allowed: boolean, alwaysAllow?: boolean) => void
    pendingPermissions: Map<string, Record<string, unknown>>
    permissionManager: {
      getWhitelistedCommands: () => Set<string>
      getBaseCommand: (command: string) => string
    }
  }

  /**
   * One Always-Allow click on a card of the given type, through the REAL branch.
   *
   * The pending record is built exactly as `claude-agent.ts`'s PreToolUse
   * producer builds it — `{ resolve, toolName, command, baseCommand }`, the base
   * from the agent's own `getBaseCommand` — because that producer lives inside
   * the SDK query loop and cannot be reached without a running child. The branch
   * under test, `respondToPermission`, is the real one.
   */
  function clickAlwaysAllow(toolName: string, command: string): string[] {
    const root = mkdtempSync(join(tmpdir(), 'd1306-agent-'))
    const agent = new ClaudeAgent({
      provider: 'anthropic',
      providerType: 'anthropic',
      model: 'claude-sonnet-4-6',
      isHeadless: true,
      skipConfigWatcher: true,
      workspace: {
        id: 'ws-d1306', name: 'D1306', rootPath: root,
        workspaceRootPath: root, sessionRootPath: join(root, 'sessions'),
      } as never,
      session: { id: 'sess-d1306', createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: root } as never,
    } as BackendConfig)
    agents.push(agent)
    const internals = agent as unknown as Internals
    internals.pendingPermissions.set('perm-d1306', {
      resolve: () => {},
      toolName,
      command,
      baseCommand: internals.permissionManager.getBaseCommand(command),
    })
    internals.respondToPermission('perm-d1306', true, true)
    return [...internals.permissionManager.getWhitelistedCommands()]
  }

  it('stores a key each card type CAN be read back under', () => {
    // The MCP card FIRST: it is the arm that already agreed, so it is both the
    // control that the rig writes at all and the one this row must not move.
    expect(clickAlwaysAllow('mcp__linear__createIssue', 'mcp__linear__createIssue'))
      .toEqual(['mcp__linear__createissue'])
    expect(clickAlwaysAllow('Write', WRITE_TARGET)).toEqual([`write:${WRITE_TARGET}`.toLowerCase()])
    expect(clickAlwaysAllow('api_linear', 'POST /v1/x')).toEqual(['post /v1/x'])
  })

  it('and the key is NOT the base command any more, which is what bought nothing', () => {
    // `getBaseCommand` is what the branch used for every card: the whole file
    // path for a write (a key no consult looks up) and one token for an API
    // description (a key that would have covered every path under that method).
    const stored = clickAlwaysAllow('api_linear', 'POST /v1/x')
    expect(stored).not.toContain('post')
    expect(clickAlwaysAllow('Write', WRITE_TARGET)).not.toContain(WRITE_TARGET.toLowerCase())
  })
})

describe('D1.306 — what each stored key then buys', () => {
  it('a file-write approval covers THAT file, and not another file or another tool', () => {
    const manager = permissionManager()
    manager.whitelistCommand(sessionWhitelistKeyForApproval('Write', WRITE_TARGET, WRITE_TARGET)!)

    expect(asks(manager, 'Write', { file_path: WRITE_TARGET, content: 'x' })).toBe(false)
    expect(asks(manager, 'Write', { file_path: OTHER_TARGET, content: 'x' })).toBe(true)
    // A different write TOOL on the same path is a different card, and the key
    // carries the tool for that reason.
    expect(asks(manager, 'Edit', { file_path: WRITE_TARGET })).toBe(true)
  })

  it('a BARE tool rule still means every write this session — the model-supplied half', () => {
    // `pi-agent.ts`'s `addRules` bare-tool arm writes this key on purpose. If
    // the per-path key had replaced the consult rather than joining it, this
    // would be silently dead and the diff would look the same.
    const manager = permissionManager()
    manager.whitelistCommand('Write')

    expect(asks(manager, 'Write', { file_path: WRITE_TARGET, content: 'x' })).toBe(false)
    expect(asks(manager, 'Write', { file_path: OTHER_TARGET, content: 'x' })).toBe(false)
  })

  it('an API approval covers exactly that method and path', () => {
    const manager = permissionManager()
    manager.whitelistCommand(sessionWhitelistKeyForApproval('api_linear', 'POST /v1/x', 'POST')!)

    expect(asks(manager, 'api_linear', { method: 'POST', path: '/v1/x' })).toBe(false)
    expect(asks(manager, 'api_linear', { method: 'DELETE', path: '/v1/x' })).toBe(true)
    expect(asks(manager, 'api_linear', { method: 'POST', path: '/v1/y' })).toBe(true)
  })

  it('a BARE api_* rule is honoured, at parity with the MCP and file-write arms (D1.315)', () => {
    // `pi-agent.ts`'s `addRules` bare-tool arm writes this key and its own
    // comment called it the key "the MCP-mutation and tool-level prompts
    // consult". Measured at HEAD that was true of two of the three surfaces:
    // the bare `api_*` rule was applied, receipted, and read by nobody.
    const manager = permissionManager()
    manager.whitelistCommand('api_linear')

    expect(asks(manager, 'api_linear', { method: 'POST', path: '/v1/x' })).toBe(false)
    // It is a TOOL-wide key, so every non-GET call on that source is covered —
    // exactly as wide as the bare `Write` key above, which is the parity.
    expect(asks(manager, 'api_linear', { method: 'DELETE', path: '/v1/y' })).toBe(false)
    // The negative that bounds it: another API source is a different tool.
    expect(asks(manager, 'api_github', { method: 'POST', path: '/v1/x' })).toBe(true)
  })

  it('a HUMAN api approval is still per-call — parity widened the MODEL rule only', () => {
    // D1.315 must not turn D1.306's per-call key into a tool-wide one. The card
    // stores `${method} ${path}`, so the click still buys exactly what it showed.
    const manager = permissionManager()
    manager.whitelistCommand(sessionWhitelistKeyForApproval('api_linear', 'POST /v1/x', 'POST')!)

    expect(asks(manager, 'api_linear', { method: 'POST', path: '/v1/x' })).toBe(false)
    expect(asks(manager, 'api_linear', { method: 'DELETE', path: '/v1/x' })).toBe(true)
  })

  it('the MCP card is unchanged, and a sibling tool is not covered — the control', () => {
    const manager = permissionManager()
    manager.whitelistCommand(
      sessionWhitelistKeyForApproval('mcp__linear__createIssue', 'mcp__linear__createIssue', 'mcp__linear__createIssue')!,
    )

    expect(asks(manager, 'mcp__linear__createIssue', { title: 'x' })).toBe(false)
    expect(asks(manager, 'mcp__linear__deleteIssue', { id: 'x' })).toBe(true)
  })

  it('the Bash arm still answers D1.291', () => {
    expect(sessionWhitelistKeyForApproval('Bash', 'git commit -m x', 'git')).toBe('git commit')
    // What this function refuses is a key it cannot NARROW. D1.291's refusal of
    // a DANGEROUS line is the call site's and deliberately not this one's:
    // `respondToPermission` tests `isDangerousCommand(pending.command)` before
    // asking for a key at all, and `bash-session-whitelist-dangerous-prefix.test.ts`
    // drives that through the real agent (a `git push` card stores nothing). The
    // first draft of this case asserted the refusal here and went red, which is
    // the separation stating itself.
    expect(sessionWhitelistKeyForApproval('Bash', 'git -C /repo push', 'git')).toBeNull()
    expect(sessionWhitelistKeyForApproval('Bash', 'git push origin main', 'git')).toBeNull() // UA12.70 — the key refuses a dangerous line too (upstream isDangerousArgv); the call site's test stays
  })
})

/**
 * F1.936 `[permissions]` — the fallback arm stored the first word of the card's
 * `command` for every tool that is not Bash, a file write, `mcp__` or `api_`.
 * No consult reads a key for those tools (`shouldPromptInAskMode` has no arm for
 * them), and the one that CAN match such a key is the Bash consult, which reads
 * it as a granted command prefix: Always Allow on a browser card `click @e1`
 * stored `click`, and a later Bash `click …` ran with no card for the session.
 * Red at HEAD `fd0a5b78f`: the real branch stored `["click"]` and the Bash
 * `click --force x` below did not ask.
 */
describe('F1.936 — a card with no consult of its own stores no key a Bash consult can read', () => {
  const agents: ClaudeAgent[] = []
  afterEach(() => { for (const agent of agents.splice(0)) agent.destroy() })

  function clickAlwaysAllow(toolName: string, command: string): string[] {
    const root = mkdtempSync(join(tmpdir(), 'f1936-agent-'))
    const agent = new ClaudeAgent({
      provider: 'anthropic',
      providerType: 'anthropic',
      model: 'claude-sonnet-4-6',
      isHeadless: true,
      skipConfigWatcher: true,
      workspace: {
        id: 'ws-f1936', name: 'F1936', rootPath: root,
        workspaceRootPath: root, sessionRootPath: join(root, 'sessions'),
      } as never,
      session: { id: 'sess-f1936', createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: root } as never,
    } as BackendConfig)
    agents.push(agent)
    const internals = agent as unknown as {
      respondToPermission: (requestId: string, allowed: boolean, alwaysAllow?: boolean) => void
      pendingPermissions: Map<string, Record<string, unknown>>
      permissionManager: { getWhitelistedCommands: () => Set<string>; getBaseCommand: (command: string) => string }
    }
    internals.pendingPermissions.set('perm-f1936', {
      resolve: () => {},
      toolName,
      command,
      baseCommand: internals.permissionManager.getBaseCommand(command),
    })
    internals.respondToPermission('perm-f1936', true, true)
    return [...internals.permissionManager.getWhitelistedCommands()]
  }

  it('Always Allow on a browser card stores nothing, so a Bash line with the same first word still asks', () => {
    const stored = clickAlwaysAllow('browser_tool', 'click @e1')
    expect(stored).toEqual([])
    const manager = permissionManager()
    for (const key of stored) manager.whitelistCommand(key)
    expect(asks(manager, 'Bash', { command: 'click --force x' })).toBe(true)
    // Every tool the fallback serves, including a shell-carrying one (`Monitor`):
    // the Bash consult is the only reader such a key could reach.
    expect(sessionWhitelistKeyForApproval('browser_tool', 'click @e1', 'click')).toBeNull()
    expect(sessionWhitelistKeyForApproval('Monitor', 'tail -f build.log', 'tail')).toBeNull()
    expect(sessionWhitelistKeyForApproval('SomeFutureTool', 'whatever it carries', 'whatever')).toBeNull()
    expect(sessionWhitelistKeyForApproval('SomeFutureTool', '', '')).toBeNull()
  })

  it('the Bash, file-write, MCP and API cards store the keys they stored before — the control', () => {
    expect(clickAlwaysAllow('Bash', 'npm test')).toEqual(['npm test'])
    expect(clickAlwaysAllow('Write', WRITE_TARGET)).toEqual([`write:${WRITE_TARGET}`.toLowerCase()])
    expect(clickAlwaysAllow('mcp__session__browser_tool', 'click @e1')).toEqual(['mcp__session__browser_tool'])
    expect(clickAlwaysAllow('api_linear', 'POST /v1/x')).toEqual(['post /v1/x'])
    // And the Bash key is still read back by the Bash consult.
    const manager = permissionManager()
    manager.whitelistCommand(sessionWhitelistKeyForApproval('Bash', 'npm test', 'npm')!)
    expect(asks(manager, 'Bash', { command: 'npm test' })).toBe(false)
  })
})
