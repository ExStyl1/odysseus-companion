/**
 * F1.296 (origin WJ-dd P-WJ-dd-3) — deferred-tool DISCOVERY passes in the
 * asking modes as a NAMED plumbing rule.
 *
 * ## The defect
 *
 * `mcp__tool_search` returns deferred tools' names and descriptions and loads
 * nothing. Until F1.258 it passed `default` with no card by accident — the
 * shipped `search` pattern was an unanchored substring of every tool name, its
 * own included. F1.258 anchored the patterns, and the accident ended: on a real
 * install `default` (and `acceptEdits`/`auto`) raised a card for every discovery
 * call, because `shouldPromptInAskMode` (`core/pre-tool-use.ts`) asks whenever an
 * Explore PROBE of the tool refuses, and F1.199's Explore allowance is keyed to
 * the model's own gate, not to the probe.
 *
 * ## The decision (controller, 2026-09-23)
 *
 * Discovery is read-only plumbing and passes in the asking modes, by a rule that
 * NAMES it — `isDeferredToolDiscovery` (`mode-manager.ts`) — not by a pattern.
 * `plan` (a stored Explore reads as it) and `dontAsk` keep their own branches.
 *
 * ## F1.997 (owner, 2026-09-26) — a deferred-tool LOAD passes the asking modes too
 *
 * Until F1.997 `mcp__tool_load` kept a card in the asking modes (F1.144, F1.296).
 * The owner aligned it with Claude's own `ToolSearch`, which `tools-reference.md`
 * lists as "Searches for and loads deferred tools when tool search is enabled",
 * Permission required "No": a load registers a schema and runs nothing, and the
 * LOADED tool's own call still meets the gate. The rule is `isDeferredToolLoad`
 * (`mode-manager.ts`), an exact name like discovery's; F1.199 still rules
 * `plan`, and `dontAsk` still refuses. Because the rule sits in
 * `shouldPromptInAskMode`, `auto`'s band (which calls it) no longer sends a load
 * to the classifier either — the first F1.997 arm's `auto` reading pins that.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runPreToolUseChecks, type PermissionManagerLike } from '../core/pre-tool-use.ts'
import type { PermissionMode } from '../mode-types.ts'
import * as modeManager from '../mode-manager.ts'
import { cleanupModeState, initializeModeState } from '../mode-manager.ts'
import { getAppPermissionsDir, permissionsConfigCache } from '../permissions-config.ts'

const SHIPPED_TEXT = readFileSync(
  join(import.meta.dir, '..', '..', '..', '..', '..', 'apps', 'electron', 'resources', 'permissions', 'default.json'),
  'utf-8',
)

const KEY = { workspaceId: 'ws-f1296', sessionId: 'session-f1296' }
const SOURCES = ['acme']

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
}

/** F1.258's measured floor for gate arms, same budget. */
const GATE_BUDGET_MS = 120_000

let workspace: string
let appDefaultPath: string
let priorAppDefault: string | null = null

beforeAll(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1296-')))
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
  rmSync(workspace, { recursive: true, force: true })
})

function verdict(toolName: string, input: Record<string, unknown>, mode: PermissionMode): string {
  cleanupModeState(KEY)
  initializeModeState(KEY, mode)
  const result = runPreToolUseChecks({
    toolName,
    input,
    sessionId: KEY.sessionId,
    sessionKey: KEY,
    permissionMode: mode,
    workspaceRootPath: workspace,
    workspaceId: KEY.workspaceId,
    workingDirectory: workspace,
    activeSourceSlugs: SOURCES,
    allSourceSlugs: SOURCES,
    hasSourceActivation: false,
    permissionManager,
  })
  return result.type === 'prompt' ? `prompt:${result.promptType}` : result.type
}

const SEARCH = { query: 'issues' }
const LOAD_UNMARKED = { name: 'mcp__acme__create_issue' }

describe('F1.296 · deferred-tool discovery passes the asking modes by a named rule', () => {
  it('mcp__tool_search raises no card in default, acceptEdits or auto', () => {
    expect({
      default: verdict('mcp__tool_search', SEARCH, 'default'),
      acceptEdits: verdict('mcp__tool_search', SEARCH, 'acceptEdits'),
      auto: verdict('mcp__tool_search', SEARCH, 'auto'),
    }).toEqual({ default: 'allow', acceptEdits: 'allow', auto: 'allow' })
  }, GATE_BUDGET_MS)

  it('discovery passes plan and dontAsk too (F1.1097; mcp__tool_load moved to the F1.997 block below)', () => {
    // RED before F1.1097: dontAsk answered `block`.
    expect({
      searchPlan: verdict('mcp__tool_search', SEARCH, 'plan'),
      searchDontAsk: verdict('mcp__tool_search', SEARCH, 'dontAsk'),
    }).toEqual({ searchPlan: 'allow', searchDontAsk: 'allow' })
  }, GATE_BUDGET_MS)

  it('the rule is named, not a pattern: it matches the discovery tool exactly and nothing that merely contains its name', () => {
    const isDeferredToolDiscovery = (modeManager as unknown as { isDeferredToolDiscovery?: (name: string) => boolean }).isDeferredToolDiscovery
    expect(typeof isDeferredToolDiscovery).toBe('function')
    expect(['mcp__tool_search', 'mcp__tool_load', 'mcp__acme__tool_search', 'mcp__tool_search_x']
      .map(name => isDeferredToolDiscovery?.(name))).toEqual([true, false, false, false])
  })
})

describe('F1.997 · a deferred-tool LOAD passes the asking modes, as Claude\'s own ToolSearch does', () => {
  it('mcp__tool_load of an unmarked tool raises no card in default, acceptEdits or auto, in both input spellings', () => {
    // RED before F1.997: every arm answered `prompt:mcp_mutation`.
    expect({
      default: verdict('mcp__tool_load', LOAD_UNMARKED, 'default'),
      defaultNames: verdict('mcp__tool_load', { names: ['mcp__acme__create_issue', 'mcp__acme__delete_issue'] }, 'default'),
      acceptEdits: verdict('mcp__tool_load', LOAD_UNMARKED, 'acceptEdits'),
      auto: verdict('mcp__tool_load', LOAD_UNMARKED, 'auto'),
    }).toEqual({ default: 'allow', defaultNames: 'allow', acceptEdits: 'allow', auto: 'allow' })
  }, GATE_BUDGET_MS)

  it('CONTROL: the LOADED tool\'s own call still asks, a source tool that merely carries the name still asks; plan and dontAsk pass the load (F1.1097)', () => {
    expect({
      loadedCallDefault: verdict('mcp__acme__create_issue', { title: 'x' }, 'default'),
      loadedCallAuto: verdict('mcp__acme__create_issue', { title: 'x' }, 'auto'),
      lookalike: verdict('mcp__acme__tool_load', { name: 'mcp__acme__create_issue' }, 'default'),
      loadPlan: verdict('mcp__tool_load', LOAD_UNMARKED, 'plan'),
      loadDontAsk: verdict('mcp__tool_load', LOAD_UNMARKED, 'dontAsk'),
    }).toEqual({
      loadedCallDefault: 'prompt:mcp_mutation',
      loadedCallAuto: 'prompt:mcp_mutation',
      lookalike: 'prompt:mcp_mutation',
      loadPlan: 'allow',
      loadDontAsk: 'allow',
    })
  }, GATE_BUDGET_MS)

  it('the rule is named, not a pattern: it matches the loader exactly and nothing that merely contains its name', () => {
    const isDeferredToolLoad = (modeManager as unknown as { isDeferredToolLoad?: (name: string) => boolean }).isDeferredToolLoad
    expect(typeof isDeferredToolLoad).toBe('function')
    expect(['mcp__tool_load', 'mcp__tool_search', 'mcp__acme__tool_load', 'mcp__tool_load_x', 'tool_load']
      .map(name => isDeferredToolLoad?.(name))).toEqual([true, false, false, false, false])
  })
})
