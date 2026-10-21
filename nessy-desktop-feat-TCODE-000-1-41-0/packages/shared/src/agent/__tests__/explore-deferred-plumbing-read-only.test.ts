/**
 * F1.199 (origin WJ-q P-WJ-q-2) — in Explore, a deferred MCP tool the workspace
 * marks read-only must be reachable: the two discovery tools may not refuse it
 * first.
 *
 * ## Measured before the change (WJ-w, 2026-09-23, on `runPreToolUseChecks`)
 *
 * A workspace `permissions.json` carrying `allowedMcpPatterns:
 * ["mcp__linear__team_roster"]` makes that tool itself `allow` in Explore — the
 * marking works — while `mcp__tool_load {name: "mcp__linear__team_roster"}`
 * answered "MCP write operations are blocked in Explore". So a DEFERRED tool the
 * person marked read-only could never be loaded in Explore, and without the load
 * it can never be called: the marking was unreachable for exactly the tools the
 * deferral hides. The same reading on both install shapes — without the app's
 * `permissions/default.json`, and with the shipped one copied into place.
 *
 * `mcp__tool_search` is the other half and it measured DIFFERENTLY per install:
 * refused in Explore without `default.json`, and ALLOWED in every mode with the
 * shipped file — not by any rule about discovery, but because the shipped
 * `allowedMcpPatterns` entry `search` is an unanchored regex that happens to
 * match the name `mcp__tool_search`. WJ-q's reading ("refused in Explore, a card
 * in default") was taken on the first shape. The accident is recorded as its
 * own row; this change does not lean on it.
 *
 * ## The change (Explore only; `shouldAllowToolInMode`, mode-manager.ts)
 *
 * Both plumbing tools load a schema or read a catalogue — they do not act — so
 * in Explore they now pass exactly when what they serve is marked read-only:
 * `mcp__tool_load` when EVERY name it asks for is a read-only MCP tool under the
 * session's merged config (the same `readOnlyMcpPatterns` the tool's own call
 * will meet), and `mcp__tool_search` when the config marks any MCP tool
 * read-only at all (with nothing marked, nothing it finds could be used here).
 * Every other mode is untouched — `default` keeps its card (F1.144's decision),
 * and `plan`/`dontAsk` kept today's refusal, stated as the row's residue. F1.858
 * (SIT-y, 2026-09-25) closed the `plan` half: plan takes the same allowance,
 * pinned in its own block below; `dontAsk` keeps the refusal. F1.997 (owner,
 * 2026-09-26) removed `default`'s load card by a named rule checked ahead of the
 * probe, so the default arm below now reads `allow` and no longer discriminates
 * the keying described next; the keying stays (only the model's own gate gets it).
 *
 * The allowance is keyed on the MODEL's own gate (the `allowPlanShellReview`
 * option only `runPreToolUseChecks` passes), because `shouldPromptInAskMode`
 * reuses `shouldAllowToolInMode(…, 'plan')` as its "is this a mutation?"
 * probe: the first draft keyed on the mode alone and the default-mode control
 * below went red (`allow` where the card must stay).
 *
 * F1.1097 (2026-10-09) supersedes the marking rule: the loader and the search pass `plan` and `dontAsk` whatever
 * they name, as Claude's `ToolSearch` does, so the arms below that pinned a refusal now read `allow`; the loaded
 * tool's own call keeps its verdict, and the F1.1097 block at the end pins the built-in and dontAsk halves.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runPreToolUseChecks, type PermissionManagerLike } from '../core/pre-tool-use.ts'
import type { PermissionMode } from '../mode-types.ts'
import { cleanupModeState, initializeModeState } from '../mode-manager.ts'
import { permissionsConfigCache } from '../permissions-config.ts'

const KEY = { workspaceId: 'ws-f1199', sessionId: 'session-f1199' }
/** A name no pattern in the shipped `default.json` matches, so the marking is the only thing that can admit it. */
const MARKED = 'mcp__linear__team_roster'
const UNMARKED = 'mcp__linear__create_issue'

let markedRoot: string
let plainRoot: string

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
}

beforeAll(() => {
  markedRoot = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1199-marked-')))
  plainRoot = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1199-plain-')))
  writeFileSync(join(markedRoot, 'permissions.json'), JSON.stringify({ allowedMcpPatterns: [MARKED] }))
  permissionsConfigCache.clear()
})

afterAll(() => {
  cleanupModeState(KEY)
  permissionsConfigCache.clear()
  rmSync(markedRoot, { recursive: true, force: true })
  rmSync(plainRoot, { recursive: true, force: true })
})

/** The gate as Pi calls it; the mode is read from the mode-state singleton, so it is seeded per call. */
function verdict(root: string, toolName: string, input: Record<string, unknown>, mode: PermissionMode): string {
  cleanupModeState(KEY)
  initializeModeState(KEY, mode)
  const result = runPreToolUseChecks({
    toolName,
    input,
    sessionId: KEY.sessionId,
    sessionKey: KEY,
    permissionMode: mode,
    workspaceRootPath: root,
    workspaceId: KEY.workspaceId,
    workingDirectory: root,
    activeSourceSlugs: ['linear'],
    allSourceSlugs: ['linear'],
    hasSourceActivation: false,
    permissionManager,
  })
  return result.type === 'prompt' ? `prompt:${result.promptType}` : result.type
}

describe('F1.199 · plan reaches a deferred MCP tool the workspace marked read-only', () => {
  it('POSITIVE CONTROL: the marked tool itself is allowed in plan — the marking works', () => {
    expect(verdict(markedRoot, MARKED, {}, 'plan')).toBe('allow')
  })

  it('mcp__tool_load of a marked tool is allowed in plan, in both of its input spellings', () => {
    // RED before F1.199: both answered `block` ("MCP write operations are blocked in Explore").
    expect({
      name: verdict(markedRoot, 'mcp__tool_load', { name: MARKED }, 'plan'),
      names: verdict(markedRoot, 'mcp__tool_load', { names: [MARKED] }, 'plan'),
    }).toEqual({ name: 'allow', names: 'allow' })
  })

  it('mcp__tool_search is allowed in plan when the workspace marks a tool read-only', () => {
    expect(verdict(markedRoot, 'mcp__tool_search', { query: 'roster' }, 'plan')).toBe('allow')
  })

  it('F1.1097: an unmarked tool loads too — alone, beside a marked one, or with nothing named; its own CALL stays refused', () => {
    // RED before F1.1097: the four loads answered `block`.
    expect({
      unmarked: verdict(markedRoot, 'mcp__tool_load', { name: UNMARKED }, 'plan'),
      mixed: verdict(markedRoot, 'mcp__tool_load', { names: [MARKED, UNMARKED] }, 'plan'),
      empty: verdict(markedRoot, 'mcp__tool_load', {}, 'plan'),
      unmarkedWorkspace: verdict(plainRoot, 'mcp__tool_load', { name: MARKED }, 'plan'),
      unmarkedCall: verdict(markedRoot, UNMARKED, {}, 'plan'),
    }).toEqual({ unmarked: 'allow', mixed: 'allow', empty: 'allow', unmarkedWorkspace: 'allow', unmarkedCall: 'block' })
  })

  it('default passes the load by F1.997\'s named rule (no longer a card, F1.144), and dontAsk passes it too (F1.1097)', () => {
    // RED before F1.1097: dontAsk answered `block`.
    expect({
      default: verdict(markedRoot, 'mcp__tool_load', { name: MARKED }, 'default'),
      dontAsk: verdict(markedRoot, 'mcp__tool_load', { name: MARKED }, 'dontAsk'),
    }).toEqual({ default: 'allow', dontAsk: 'allow' })
  })
})

/**
 * F1.858 (origin SIT-y, 2026-09-25) — the same defect in `plan`. Measured on the
 * packaged Pi build: `mcp__tool_load` and `mcp__tool_search` answered "MCP write
 * operations are blocked in Plan…", so no deferred tool could be loaded while
 * planning. Claude's plan mode is the contract ("Claude reads files, runs shell
 * commands to explore, and writes a plan", `permission-modes.md`), and its own
 * `ToolSearch` needs no permission (`tools-reference.md`), so plan now takes
 * F1.199's Explore allowance unchanged: the plumbing passes exactly when what it
 * serves is marked read-only, and the loaded tool's call meets its own verdict.
 */
describe('F1.858 · plan reaches a deferred MCP tool the workspace marked read-only', () => {
  it('POSITIVE CONTROL: the marked tool itself is allowed in plan', () => {
    expect(verdict(markedRoot, MARKED, {}, 'plan')).toBe('allow')
  })

  it('mcp__tool_load of a marked tool and mcp__tool_search are allowed in plan', () => {
    // RED before F1.858: all three answered `block` ("MCP write operations are blocked in Plan").
    expect({
      name: verdict(markedRoot, 'mcp__tool_load', { name: MARKED }, 'plan'),
      names: verdict(markedRoot, 'mcp__tool_load', { names: [MARKED] }, 'plan'),
      search: verdict(markedRoot, 'mcp__tool_search', { query: 'roster' }, 'plan'),
    }).toEqual({ name: 'allow', names: 'allow', search: 'allow' })
  })

  it('F1.1097: an unmarked tool loads in plan too — alone, beside a marked one, or in an unmarked workspace', () => {
    // RED before F1.1097: all three answered `block`.
    expect({
      unmarked: verdict(markedRoot, 'mcp__tool_load', { name: UNMARKED }, 'plan'),
      mixed: verdict(markedRoot, 'mcp__tool_load', { names: [MARKED, UNMARKED] }, 'plan'),
      unmarkedWorkspace: verdict(plainRoot, 'mcp__tool_load', { name: MARKED }, 'plan'),
    }).toEqual({ unmarked: 'allow', mixed: 'allow', unmarkedWorkspace: 'allow' })
  })
})

/**
 * F1.1097 (origin DN-056 / DN-099, SIT-y) — the loader passes EVERY mode, as Claude's own `ToolSearch` does
 * (`tools-reference.md`: "Searches for and loads deferred tools when tool search is enabled", Permission required
 * "No"; `permission-modes.md#allow-only-pre-approved-tools-with-dontask-mode`: dontAsk "still runs actions that need
 * no approval"). Before it, a BUILT-IN deferred tool (`get_subagent_result`, the call SIT-y made) could never be
 * loaded in plan — a built-in name never matches a read-only MCP pattern — and no load passed dontAsk. A load
 * registers a schema and runs nothing; the LOADED tool's own call meets the gate as before, and a deny rule that
 * names the loader still refuses it.
 */
describe('F1.1097 · a deferred-tool load passes plan and dontAsk', () => {
  it('a built-in deferred tool loads in plan and dontAsk, and discovery passes dontAsk', () => {
    // RED before F1.1097: every arm answered `block`.
    expect({
      planBuiltin: verdict(plainRoot, 'mcp__tool_load', { name: 'get_subagent_result' }, 'plan'),
      dontAskBuiltin: verdict(plainRoot, 'mcp__tool_load', { names: ['get_subagent_result', 'list_subagents'] }, 'dontAsk'),
      dontAskSearch: verdict(plainRoot, 'mcp__tool_search', { query: 'subagent' }, 'dontAsk'),
    }).toEqual({ planBuiltin: 'allow', dontAskBuiltin: 'allow', dontAskSearch: 'allow' })
  })

  it('CONTROL: a server tool that merely carries the loader\'s name, and the loaded tool\'s own write call, stay refused', () => {
    expect({
      lookalikePlan: verdict(plainRoot, 'mcp__linear__tool_load', { name: UNMARKED }, 'plan'),
      lookalikeDontAsk: verdict(plainRoot, 'mcp__linear__tool_load', { name: UNMARKED }, 'dontAsk'),
      loadedCallDontAsk: verdict(markedRoot, UNMARKED, {}, 'dontAsk'),
    }).toEqual({ lookalikePlan: 'block', lookalikeDontAsk: 'block', loadedCallDontAsk: 'block' })
  })

  it('CONTROL: a workspace deny rule naming the loader still refuses it, in every mode', () => {
    const denyRoot = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1097-deny-')))
    try {
      writeFileSync(join(denyRoot, 'permissions.json'), JSON.stringify({ deniedToolPatterns: ['mcp__tool_load'] }))
      permissionsConfigCache.clear()
      expect({
        plan: verdict(denyRoot, 'mcp__tool_load', { name: 'get_subagent_result' }, 'plan'),
        dontAsk: verdict(denyRoot, 'mcp__tool_load', { name: 'get_subagent_result' }, 'dontAsk'),
      }).toEqual({ plan: 'block', dontAsk: 'block' })
    } finally {
      permissionsConfigCache.clear()
      rmSync(denyRoot, { recursive: true, force: true })
    }
  })
})
