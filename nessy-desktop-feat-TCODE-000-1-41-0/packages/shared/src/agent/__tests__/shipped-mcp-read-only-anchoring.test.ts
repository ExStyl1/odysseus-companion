/**
 * F1.258 (origin WJ-w P-WJ-w-3) — the SHIPPED read-only MCP patterns name a
 * tool's LEADING VERB, and an installed copy is migrated off the old strings.
 *
 * ## The defect, measured 2026-09-23 on `runPreToolUseChecks` with the shipped file
 *
 * `apps/electron/resources/permissions/default.json` shipped fifteen
 * `allowedMcpPatterns` — `search`, `list`, `get`, `read`, … — and
 * `applyDefaultConfig` compiles each one as-is (`new RegExp(pattern)`), so each
 * was an UNANCHORED SUBSTRING of the whole tool name. A write-named tool was
 * therefore "read-only" whenever a verb happened to appear anywhere in it:
 * `mcp__acme__update_issue_status` (`status`), `delete_account` (`count`),
 * `execute_query` (`query`), `spreadsheet_update` (`read`), `update_user_info`
 * (`info`), `review_approve` (`view`), `forget_memory` (`get`) and
 * `thread_create` (`read`) all answered `allow` in Explore, `default` and
 * `dontAsk` — no card, no refusal. `mcp__tool_search` (the deferred-tool
 * catalogue) passed the same way, by the accident of containing `search`.
 *
 * ## The decision (controller, 2026-09-23) and what it narrows on purpose
 *
 * Every shipped pattern names the verb at the START of the tool segment, followed
 * by `_` or the end: `^mcp__<server>__<verb>(_<word>)*$`, the server segment
 * being `_`-joined words with no `__` run (the wire contract,
 * `capabilities/mcp-wire-name.ts`). The verbs are exactly the old file's fifteen
 * — none invented. Names the substrings used to admit that are NOT a leading
 * verb followed by `_` now take the ordinary MCP path (card in `default`,
 * refusal in Explore/`dontAsk`): a trailing noun (`user_info`), camelCase
 * (`getIssue`), a hyphen (`list-issues`), and a `__`-namespaced tool
 * (`mcp__srv__ns__get_issue`, the nestor-cloud spelling of `ns/get_issue`). The
 * arm below pins that narrowing so it reads as a decision, not a regression.
 *
 * `mcp__tool_search` no longer passes by accident: it meets F1.296's NAMED rule
 * (discovery passes `default`, a rule that names it, not a pattern) and F1.199's
 * Explore allowance (the config still marks tools read-only); `dontAsk` refuses.
 *
 * ## The migration
 *
 * `ensureDefaultPermissions` only ever APPENDED new bundled patterns, so an
 * installed `default.json` would have kept the fifteen substrings forever beside
 * the anchored successors — and any one of them re-opens the hole. Crossing the
 * bundle version that retired them, the installed copy loses exactly those
 * fifteen strings (exact match on the pattern string), every other entry — the
 * user's own — survives byte for byte, and one diagnostic line per retired
 * string goes to the permissions debug stream.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { runPreToolUseChecks, type PermissionManagerLike } from '../core/pre-tool-use.ts'
import type { PermissionMode } from '../mode-types.ts'
import { cleanupModeState, initializeModeState } from '../mode-manager.ts'
import { getAppPermissionsDir, permissionsConfigCache } from '../permissions-config.ts'
import { SHIPPED_READ_ONLY_MCP_VERBS } from '../mcp-tool-name-verbs.ts'

const SHIPPED_PATH = join(import.meta.dir, '..', '..', '..', '..', '..', 'apps', 'electron', 'resources', 'permissions', 'default.json')
const SHIPPED_TEXT = readFileSync(SHIPPED_PATH, 'utf-8')
const shipped = JSON.parse(SHIPPED_TEXT) as {
  version: string
  allowedMcpPatterns: Array<{ pattern: string; comment?: string }>
}
const PERMISSIONS_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'permissions-config.ts')).href

/**
 * The fifteen entries every bundle shipped from the seed through `2026-09-06`,
 * read from the file's history (`git show <sha>:<path>` at aadf3a052,
 * 845cf0a41, 64c6a8391, feea4b1b9, 7b7582387, e6296c0f7, 04e335f1e — the
 * `allowedMcpPatterns` block is identical in all of them). This is what an
 * installed `default.json` carries today.
 */
const PREVIOUS_SHIPPED_MCP_ENTRIES = [
  { pattern: 'search', comment: 'Search operations across MCP sources' },
  { pattern: 'list', comment: 'Generic list operations' },
  { pattern: 'get', comment: 'Generic get/read operations' },
  { pattern: 'read', comment: 'Generic read operations' },
  { pattern: 'info', comment: 'Information/metadata retrieval' },
  { pattern: 'describe', comment: 'Describe resources' },
  { pattern: 'show', comment: 'Show resource details' },
  { pattern: 'view', comment: 'View resource contents' },
  { pattern: 'find', comment: 'Find/locate resources' },
  { pattern: 'query', comment: 'Query operations' },
  { pattern: 'count', comment: 'Count resources' },
  { pattern: 'exists', comment: 'Check existence' },
  { pattern: 'status', comment: 'Status checks' },
  { pattern: 'inspect', comment: 'Inspect resource details' },
  { pattern: 'fetch', comment: 'Fetch/retrieve data' },
] as const
const PREVIOUS_VERBS: readonly string[] = PREVIOUS_SHIPPED_MCP_ENTRIES.map(entry => entry.pattern)

/** WJ-w's eight, each allowed at the parent commit by the substring named beside it in the header. */
const WRITE_NAMED = [
  'mcp__acme__update_issue_status',
  'mcp__acme__delete_account',
  'mcp__acme__execute_query',
  'mcp__acme__spreadsheet_update',
  'mcp__acme__update_user_info',
  'mcp__acme__review_approve',
  'mcp__acme__forget_memory',
  'mcp__acme__thread_create',
]

const KEY = { workspaceId: 'ws-f1258', sessionId: 'session-f1258' }

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
}

/** The spawn arm's budget — the same measured floor as `permissions-config-migration.test.ts` (a child importing the module graph). */
const SUBPROCESS_MIGRATION_TIMEOUT_MS = 120_000

/**
 * The gate arms' budget, set against a MEASURED floor: each verdict re-seeds
 * the mode state and walks the merged config, and on this rig 225 verdicts took
 * 21.4 s at the parent commit (24 took 2.8 s) — past bun's 5 s default, which
 * then reports a timeout rather than a verdict. Generous on purpose; a floor on
 * the machine, never a bound on the assertion.
 */
const GATE_BUDGET_MS = 120_000

/**
 * Every server segment the arms below use is an ACTIVE source, so the verdict
 * is the read-only classification and never `source_activation_needed` (the
 * first draft measured exactly that on the three non-`acme` servers).
 */
const SOURCE_SLUGS = ['acme', 'plugin_acme_tracker', 'acme-cloud', 'srv']

let root: string
let appDefaultPath: string
let priorAppDefault: string | null = null

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1258-')))
  // The app-level file is where the shipped patterns live on a real install. The
  // test preload gives this process a private config dir; anything already there
  // (another file in the same process) is put back afterwards.
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
  rmSync(root, { recursive: true, force: true })
})

/** The gate as Pi calls it; the mode is read from the mode-state singleton, so it is seeded per call. */
function verdict(toolName: string, mode: PermissionMode): string {
  cleanupModeState(KEY)
  initializeModeState(KEY, mode)
  const result = runPreToolUseChecks({
    toolName,
    input: {},
    sessionId: KEY.sessionId,
    sessionKey: KEY,
    permissionMode: mode,
    workspaceRootPath: root,
    workspaceId: KEY.workspaceId,
    workingDirectory: root,
    activeSourceSlugs: SOURCE_SLUGS,
    allSourceSlugs: SOURCE_SLUGS,
    hasSourceActivation: false,
    permissionManager,
  })
  return result.type === 'prompt' ? `prompt:${result.promptType}` : result.type
}

const threeModes = (toolName: string) => ({
  plan: verdict(toolName, 'plan'),
  default: verdict(toolName, 'default'),
  dontAsk: verdict(toolName, 'dontAsk'),
})

const REFUSED = { plan: 'block', default: 'prompt:mcp_mutation', dontAsk: 'block' }
const ALLOWED = { plan: 'allow', default: 'allow', dontAsk: 'allow' }

describe('F1.258 · the shipped read-only MCP patterns are anchored', () => {
  it('every shipped pattern is anchored at BOTH ends of the tool name', () => {
    const loose = shipped.allowedMcpPatterns
      .map(entry => entry.pattern)
      .filter(pattern => !pattern.startsWith('^mcp__') || !pattern.endsWith('$'))
    expect(loose).toEqual([])
  })

  it('the shipped verbs are exactly the old file\'s fifteen — none invented, none lost', () => {
    // F1.288 added one EXACT-NAME entry per builtin dp server beside the verb rules
    // (`builtin-dp-read-only-names.test.ts` pins those); this arm reads the verb rules,
    // the entries whose server segment is the generic one.
    const verbRules = shipped.allowedMcpPatterns.filter(entry => entry.pattern.startsWith('^mcp__[^_]+(?:_[^_]+)*__'))
    expect(shipped.allowedMcpPatterns.length - verbRules.length).toBe(7)
    const verbs = verbRules.map(entry => {
      for (const verb of PREVIOUS_VERBS) if (new RegExp(entry.pattern).test(`mcp__acme__${verb}`)) return verb
      return `<no verb: ${entry.pattern}>`
    })
    expect(verbs).toEqual([...PREVIOUS_VERBS])
    // F1.295 — the one table the gate's write-token rule and the Pi catalogue read.
    expect(verbs).toEqual([...SHIPPED_READ_ONLY_MCP_VERBS])
  })

  it('CONTROL: an ordinary write (`create_issue`) meets the MCP write path in all three modes', () => {
    expect(threeModes('mcp__acme__create_issue')).toEqual(REFUSED)
  }, GATE_BUDGET_MS)

  it('the eight write-named tools meet the same write path — block / card / block', () => {
    const verdicts = Object.fromEntries(WRITE_NAMED.map(name => [name, threeModes(name)]))
    expect(verdicts).toEqual(Object.fromEntries(WRITE_NAMED.map(name => [name, REFUSED])))
  }, GATE_BUDGET_MS)

  it('every name the old file meant to allow — the verb leading the tool — is still allowed in all three modes', () => {
    const names = PREVIOUS_VERBS.flatMap(verb => [`mcp__acme__${verb}`, `mcp__acme__${verb}_open_items`])
    // The server segment's shapes: a plugin wire name (`_`-joined) and a hyphenated slug.
    names.push('mcp__plugin_acme_tracker__get_items', 'mcp__acme-cloud__list_items', 'mcp__acme__search_issues')
    const verdicts = Object.fromEntries(names.map(name => [name, threeModes(name)]))
    expect(verdicts).toEqual(Object.fromEntries(names.map(name => [name, ALLOWED])))
  }, GATE_BUDGET_MS)

  it('the DECIDED narrowing: a verb not leading the tool, or not followed by `_`, takes the write path', () => {
    const names = [
      'mcp__acme__user_info',
      'mcp__acme__getIssue',
      'mcp__acme__list-issues',
      'mcp__acme__getter',
      'mcp__acme__get__delete_all',
      'mcp__srv__ns__get_issue',
    ]
    const verdicts = Object.fromEntries(names.map(name => [name, threeModes(name)]))
    expect(verdicts).toEqual(Object.fromEntries(names.map(name => [name, REFUSED])))
  }, GATE_BUDGET_MS)

  it('`mcp__tool_search` meets the decided plumbing posture (F1.296 named rule, F1.1097 every mode), not the accident', () => {
    expect(threeModes('mcp__tool_search')).toEqual({ plan: 'allow', default: 'allow', dontAsk: 'allow' })
  }, GATE_BUDGET_MS)
})

// ------------------------------------------------------------------ migration

interface ChildRun {
  merged: { version: string; allowedMcpPatterns: Array<string | { pattern: string; comment?: string }>; [key: string]: unknown }
  stderr: string
  fileText: string
}

/**
 * `ensureDefaultPermissions` in a fresh child with `NESSY_CONFIG_DIR` exported
 * before bun starts (the only isolation form that works — the migration test's
 * own header), the REAL shipped file as the bundle, and `NESSY_DEBUG=1` so the
 * permissions debug stream (the diagnostic channel) reaches stderr.
 */
function migrateInChild(installed: unknown): ChildRun {
  const tempRoot = mkdtempSync(join(tmpdir(), 'nessy-f1258-bundle-'))
  const tempConfig = mkdtempSync(join(tmpdir(), 'nessy-f1258-config-'))
  try {
    const bundledDir = join(tempRoot, 'resources', 'permissions')
    mkdirSync(bundledDir, { recursive: true })
    writeFileSync(join(bundledDir, 'default.json'), SHIPPED_TEXT, 'utf-8')
    const installedDir = join(tempConfig, 'permissions')
    mkdirSync(installedDir, { recursive: true })
    writeFileSync(join(installedDir, 'default.json'), JSON.stringify(installed, null, 2), 'utf-8')

    const run = Bun.spawnSync([
      process.execPath,
      '--eval',
      `import { ensureDefaultPermissions } from '${PERMISSIONS_MODULE_PATH}'; ensureDefaultPermissions();`,
    ], {
      cwd: tempRoot,
      env: { ...process.env, NESSY_CONFIG_DIR: tempConfig, NESSY_DEBUG: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stderr = run.stderr.toString()
    if (run.exitCode !== 0) throw new Error(`subprocess failed (exit ${run.exitCode}):\n${stderr}`)
    const fileText = readFileSync(join(installedDir, 'default.json'), 'utf-8')
    return { merged: JSON.parse(fileText), stderr, fileText }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
    rmSync(tempConfig, { recursive: true, force: true })
  }
}

const patternOf = (entry: string | { pattern: string }): string => (typeof entry === 'string' ? entry : entry.pattern)

/** A user's own additions: an object entry with a comment and a bare string, one of each unanchored. */
const USER_OBJECT_ENTRY = { pattern: 'roster', comment: 'mine: the team roster reads' }
const USER_STRING_ENTRY = 'mcp__linear__team_status'

describe('F1.258 · an installed default.json is migrated off the old substrings', () => {
  it('crossing the retiring version drops exactly the fifteen old strings and keeps every user entry byte for byte', () => {
    const installed = {
      ...(JSON.parse(SHIPPED_TEXT) as Record<string, unknown>),
      version: '2026-09-06',
      allowedMcpPatterns: [USER_OBJECT_ENTRY, ...PREVIOUS_SHIPPED_MCP_ENTRIES, USER_STRING_ENTRY],
    }
    const { merged, stderr } = migrateInChild(installed)

    expect(merged.version).toBe(shipped.version)
    const patterns = merged.allowedMcpPatterns.map(patternOf)
    expect(patterns.filter(pattern => PREVIOUS_VERBS.includes(pattern))).toEqual([])
    // Every anchored successor is there exactly once.
    for (const entry of shipped.allowedMcpPatterns) {
      expect(patterns.filter(pattern => pattern === entry.pattern)).toHaveLength(1)
    }
    // The user's own entries, untouched and still in their places relative to each other.
    expect(merged.allowedMcpPatterns[0]).toEqual(USER_OBJECT_ENTRY)
    expect(merged.allowedMcpPatterns[1]).toBe(USER_STRING_ENTRY)
    // One diagnostic line per retired string, on the permissions debug stream.
    const lines = stderr.split('\n').filter(line => line.includes('[Permissions] Retired the shipped unanchored MCP pattern'))
    expect(lines).toHaveLength(PREVIOUS_VERBS.length)
    for (const verb of PREVIOUS_VERBS) expect(lines.some(line => line.includes(`"${verb}"`))).toBe(true)
  }, SUBPROCESS_MIGRATION_TIMEOUT_MS)

  it('CONTROL: a file already at the retiring version is not touched — a user who re-adds `status` keeps it', () => {
    const installed = {
      ...(JSON.parse(SHIPPED_TEXT) as Record<string, unknown>),
      allowedMcpPatterns: [...shipped.allowedMcpPatterns, { pattern: 'status', comment: 'mine, on purpose' }],
    }
    const { fileText, stderr } = migrateInChild(installed)
    expect(fileText).toBe(JSON.stringify(installed, null, 2))
    expect(stderr).not.toContain('Retired the shipped unanchored MCP pattern')
  }, SUBPROCESS_MIGRATION_TIMEOUT_MS)

  it('F1.294 · a file already PAST the retiring version, migrating to a LATER bundle, keeps a re-added `status`', () => {
    // The CONTROL above cannot fail on the retirement's own crossing guard: its
    // installed and bundled versions are equal, so `ensureDefaultPermissions`
    // returns before `retireShippedPatterns` runs, and a mutant that drops
    // `installedVersion < retirement.version` survives it. Here the bundle is
    // LATER than the retiring version (F1.290 moved it past `2026-09-23`), the
    // migration RUNS, and only that comparison keeps the retirement from taking
    // the user's own `status` a second time.
    const installed = {
      ...(JSON.parse(SHIPPED_TEXT) as Record<string, unknown>),
      version: '2026-09-23',
      allowedMcpPatterns: [...shipped.allowedMcpPatterns, { pattern: 'status', comment: 'mine, on purpose' }],
    }
    expect(installed.version < shipped.version).toBe(true)
    const { merged, stderr } = migrateInChild(installed)
    expect(merged.version).toBe(shipped.version)
    expect(merged.allowedMcpPatterns.map(patternOf)).toContain('status')
    expect(stderr).not.toContain('Retired the shipped unanchored MCP pattern')
  }, SUBPROCESS_MIGRATION_TIMEOUT_MS)
})
