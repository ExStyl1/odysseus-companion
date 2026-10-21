/**
 * F1.287 (origin WJ-dd's F1.258 verifier, F1.258-a + P-WJ-dd-6) — a SOURCE's own
 * `allowedMcpPatterns` name the tool's LEADING VERB, the shape F1.258 gave the
 * shipped file.
 *
 * ## The defect, measured 2026-09-23 on `runPreToolUseChecks`
 *
 * `applySourceConfig` (`permissions-config.ts`) auto-scopes each pattern in a
 * source's `permissions.json` to that source, and it compiled the pattern as
 * `mcp__<slug>__.*<pattern>` — no anchor at either end, so the verb matched
 * ANYWHERE in the tool name. The in-app docs make that file a REQUIRED step and
 * tell the agent to write `list`, `get`, `search`, `find`
 * (`resources/docs/sources.md` §4), so a source configured as documented with
 * `get` + `list` admitted `mcp__linear__update_target` (`get`),
 * `mcp__linear__forget_memory` (`get`) and `mcp__linear__delete_playlist`
 * (`list`) with no card: allow / allow / allow in Explore, `default` and
 * `dontAsk`. The same three names with no source file take the write path.
 *
 * ## The decision
 *
 * The scoped form is `^mcp__<slug>__(?:<pattern>)(?:_<word>)*$`: the pattern
 * must match at the START of the tool segment and be followed by `_`-joined
 * words or the end — F1.258's shipped shape, with the source's own slug in the
 * server position. Nothing on disk is rewritten: a bare verb keeps meaning
 * "tools led by this verb", which is what the docs always described, and a
 * pattern that is already a regex keeps its own meaning inside the anchors
 * (`.*_list` still reaches `issues_list` — the author's explicit choice).
 *
 * The arms use `lookup`, a verb the shipped file does NOT carry, so a name it
 * admits is admitted by the SOURCE file and nothing else; `get`/`list` are the
 * docs' own example and the measured hole.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runPreToolUseChecks, type PermissionManagerLike } from '../core/pre-tool-use.ts'
import type { PermissionMode } from '../mode-types.ts'
import { cleanupModeState, initializeModeState } from '../mode-manager.ts'
import { getAppPermissionsDir, permissionsConfigCache } from '../permissions-config.ts'

const SHIPPED_TEXT = readFileSync(
  join(import.meta.dir, '..', '..', '..', '..', '..', 'apps', 'electron', 'resources', 'permissions', 'default.json'),
  'utf-8',
)

const KEY = { workspaceId: 'ws-f1287', sessionId: 'session-f1287' }
const SOURCE_SLUGS = ['linear', 'other']

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
}

/** Each verdict re-seeds the mode state and walks the merged config — F1.258's measured floor, same budget. */
const GATE_BUDGET_MS = 120_000

let withSourceFile: string
let bare: string
let appDefaultPath: string
let priorAppDefault: string | null = null

beforeAll(() => {
  withSourceFile = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1287-')))
  bare = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1287-bare-')))
  // The docs' own REQUIRED step: a source-level permissions.json with simple verbs.
  mkdirSync(join(withSourceFile, 'sources', 'linear'), { recursive: true })
  writeFileSync(join(withSourceFile, 'sources', 'linear', 'permissions.json'), JSON.stringify({
    allowedMcpPatterns: [
      { pattern: 'get', comment: 'All get/read operations' },
      { pattern: 'list', comment: 'All list operations' },
      { pattern: 'lookup', comment: 'Lookups (a verb the shipped file does not carry)' },
    ],
  }))
  const dir = getAppPermissionsDir()
  mkdirSync(dir, { recursive: true })
  appDefaultPath = join(dir, 'default.json')
  priorAppDefault = existsSync(appDefaultPath) ? readFileSync(appDefaultPath, 'utf-8') : null
  writeFileSync(appDefaultPath, SHIPPED_TEXT, 'utf-8')
  permissionsConfigCache.clear()
})

afterAll(() => {
  cleanupModeState(KEY)
  if (priorAppDefault === null) rmSync(appDefaultPath, { force: true })
  else writeFileSync(appDefaultPath, priorAppDefault, 'utf-8')
  permissionsConfigCache.clear()
  rmSync(withSourceFile, { recursive: true, force: true })
  rmSync(bare, { recursive: true, force: true })
})

function verdict(toolName: string, mode: PermissionMode, workspace: string): string {
  cleanupModeState(KEY)
  initializeModeState(KEY, mode)
  const result = runPreToolUseChecks({
    toolName,
    input: {},
    sessionId: KEY.sessionId,
    sessionKey: KEY,
    permissionMode: mode,
    workspaceRootPath: workspace,
    workspaceId: KEY.workspaceId,
    workingDirectory: workspace,
    activeSourceSlugs: SOURCE_SLUGS,
    allSourceSlugs: SOURCE_SLUGS,
    hasSourceActivation: false,
    permissionManager,
  })
  return result.type === 'prompt' ? `prompt:${result.promptType}` : result.type
}

const threeModes = (toolName: string, workspace: string) => ({
  plan: verdict(toolName, 'plan', workspace),
  default: verdict(toolName, 'default', workspace),
  dontAsk: verdict(toolName, 'dontAsk', workspace),
})

type Verdicts = ReturnType<typeof threeModes>
const REFUSED: Verdicts = { plan: 'block', default: 'prompt:mcp_mutation', dontAsk: 'block' }
const ALLOWED: Verdicts = { plan: 'allow', default: 'allow', dontAsk: 'allow' }
const table = (names: string[], workspace: string): Record<string, Verdicts> => Object.fromEntries(names.map(name => [name, threeModes(name, workspace)]))
const all = (names: string[], value: Verdicts): Record<string, Verdicts> => Object.fromEntries(names.map(name => [name, value]))

/** The verifier's three, each admitted at the parent by the substring named in the header, plus a `lookup` twin. */
const WRITE_NAMED = [
  'mcp__linear__update_target',
  'mcp__linear__forget_memory',
  'mcp__linear__delete_playlist',
  'mcp__linear__forget_lookup',
]

describe('F1.287 · a source\'s own read-only MCP patterns are anchored to the leading verb', () => {
  it('the write-named tools take the write path with the source file present — block / card / block', () => {
    expect(table(WRITE_NAMED, withSourceFile)).toEqual(all(WRITE_NAMED, REFUSED))
  }, GATE_BUDGET_MS)

  it('CONTROL: the same names with no source file take the same path', () => {
    expect(table(WRITE_NAMED, bare)).toEqual(all(WRITE_NAMED, REFUSED))
  }, GATE_BUDGET_MS)

  it('CONTROL: an ordinary write (`create_issue`) is refused with the file present', () => {
    expect(threeModes('mcp__linear__create_issue', withSourceFile)).toEqual(REFUSED)
  }, GATE_BUDGET_MS)

  it('what the file means is still allowed: a tool LED by the verb, alone or followed by `_` words', () => {
    const names = ['mcp__linear__get_issue', 'mcp__linear__list_issues', 'mcp__linear__lookup', 'mcp__linear__lookup_user']
    expect(table(names, withSourceFile)).toEqual(all(names, ALLOWED))
  }, GATE_BUDGET_MS)

  it('the source file speaks for its own source only, and only for what it names', () => {
    // `lookup` is not a shipped verb: with no file it is refused, and another
    // source's `lookup_user` is refused even with linear's file present.
    expect(threeModes('mcp__linear__lookup_user', bare)).toEqual(REFUSED)
    expect(threeModes('mcp__other__lookup_user', withSourceFile)).toEqual(REFUSED)
  }, GATE_BUDGET_MS)
})
