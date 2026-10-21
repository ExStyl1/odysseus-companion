/**
 * P6.824 — the six settings that had readers, envelopes and tests and no way for
 * a user to see or set them.
 *
 * Controller decision for the FAMILY (P6.810's recommendation, applied once):
 * they surface through the doctor and the settings reference, not through a
 * control on the AI page. Their defaults are unchanged; this is a read.
 *
 * Three things are pinned, and the third is the one this row measured rather
 * than assumed:
 *
 * - POSITIVE: a value written into `config.json` is reported with `user config`
 *   beside it and the file that carries it.
 * - NEGATIVE: an untouched machine still PRINTS every row. A section that
 *   appeared only where something had been set would answer "is anything
 *   configured?" instead of "what is in force?", and it must not move
 *   `hasFindings` — a default is not a finding.
 * - MEASURED, and then FIXED: `sessionAllowedTools` / `sessionDisallowedTools`
 *   used to be named with NO file, because `syncConfigDefaults` wrote the
 *   bundled asset over the user's `config-defaults.json` on every launch and the
 *   bundled asset shipped neither key — a feature whose input was structurally
 *   empty on every install. This section is what made that visible; P6.912 moved
 *   both keys into `config.json`, and the case below now asserts the OPPOSITE:
 *   they name the same file as their four neighbours, and a value written there
 *   is read back.
 *
 * The collector reads the REAL `CONFIG_FILE`, so this file writes the real one:
 * under `bun test` the repo's `[test].preload` has already pointed
 * `NESSY_CONFIG_DIR` at a per-run temp directory before `paths.ts` froze
 * `CONFIG_DIR` (AGENTS.md §Traps). The previous contents are restored after each
 * case so no sibling file in the same run meets a config this suite wrote.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildConfigDoctorReport } from '../config-doctor.ts'
import { CLAUDE_KNOWN_TOOL_NAMES, collectConfigOnlySettings } from '../doctor-collectors.ts'
import { CONFIG_DIR, STORAGE_LAYOUT_VERSION } from '../paths.ts'

const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

/** The managed half held constant, so what the report renders is the collector's. */
const MANAGED_INPUT = Object.freeze({
  drops: [],
  winner: 'none' as const,
  fileCarriesSettings: false,
})

/** Every key the row names, so a rename cannot quietly drop one from the list. */
const KEYS = [
  'claudeExplorePlanAgentsEnabled',
  'claudeSwitchModelsOnFlag',
  'systemPromptAppend',
  'fileCheckpointingEnabled',
  'sessionAllowedTools',
  'sessionDisallowedTools',
] as const

function validConfig(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    storageLayoutVersion: STORAGE_LAYOUT_VERSION,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    ...extra,
  })
}

let previous: string | undefined

beforeEach(() => {
  previous = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf-8') : undefined
})

afterEach(() => {
  if (previous === undefined) rmSync(CONFIG_FILE, { force: true })
  else writeFileSync(CONFIG_FILE, previous, 'utf-8')
})

describe('P6.824 — the doctor names the settings with no in-app control', () => {
  it('POSITIVE — a value set by hand is reported as user config, with its file', () => {
    writeFileSync(CONFIG_FILE, validConfig({
      claudeSwitchModelsOnFlag: false,
      systemPromptAppend: 'Answer in metric units.',
      fileCheckpointingEnabled: false,
    }), 'utf-8')

    const collected = collectConfigOnlySettings()
    expect(collected).toBeDefined()
    expect((collected?.settings ?? []).map(entry => entry.key)).toEqual([...KEYS])

    // Read each row into a LOCAL before asserting — an asymmetric matcher passed
    // into `toMatchObject` OVERWRITES the field it matched (AGENTS.md §Traps).
    const flag = collected?.settings.find(entry => entry.key === 'claudeSwitchModelsOnFlag')
    expect(flag?.value).toBe('false')
    expect(flag?.source).toBe('user')
    expect(flag?.settableIn).toBe(CONFIG_FILE)

    const append = collected?.settings.find(entry => entry.key === 'systemPromptAppend')
    expect(append?.value).toBe('Answer in metric units.')
    expect(append?.source).toBe('user')

    const report = buildConfigDoctorReport({ ...MANAGED_INPUT, configOnlySettings: collected })
    expect(report.text).toContain('Settings with no in-app control:')
    expect(report.text).toContain('  - claudeSwitchModelsOnFlag: false [user config]')
    expect(report.text).toContain('  - systemPromptAppend: Answer in metric units. [user config]')
    expect(report.text).toContain(`      set in: ${CONFIG_FILE}`)
  })

  it('NEGATIVE — an untouched machine prints every row, and none of it is a finding', () => {
    writeFileSync(CONFIG_FILE, validConfig(), 'utf-8')

    const collected = collectConfigOnlySettings()
    expect(collected).toBeDefined()
    for (const entry of collected?.settings ?? []) {
      if (entry.key.startsWith('session')) continue
      expect(entry.source).toBe('default')
    }

    const report = buildConfigDoctorReport({ ...MANAGED_INPUT, configOnlySettings: collected })
    for (const key of KEYS) expect(report.text).toContain(`  - ${key}: `)
    // Unset is not `true`, and the report says which it is — the distinction the
    // three-state readers exist for.
    expect(report.text).toContain('  - claudeExplorePlanAgentsEnabled: unset —')
    expect(report.text).toContain('  - fileCheckpointingEnabled: true (the default) [default]')
    // No managed layer and no environment override exists for any of the six;
    // the sentence says so rather than leaving a reader to assume a chain.
    expect(report.text).toContain('None of them has a managed layer or an environment')
    expect(report.hasFindings).toBe(false)
  })

  it('P6.912 — the two session-tool keys name the same file as their neighbours, and a value written there is read back', () => {
    // The negative half FIRST, because it is the state every install is in and
    // the one the old home could never leave.
    writeFileSync(CONFIG_FILE, validConfig(), 'utf-8')
    const untouched = collectConfigOnlySettings()
    for (const key of ['sessionAllowedTools', 'sessionDisallowedTools']) {
      const row = untouched?.settings.find(entry => entry.key === key)
      expect(row?.settableIn, `${key} names no file`).toBe(CONFIG_FILE)
      expect(row?.value).toBe('empty — no restriction')
      expect(row?.source).toBe('default')
    }

    // The POSITIVE half, and the whole point of the move: a value written into
    // `config.json` survives to be read. Written into the old home it did not —
    // `syncConfigDefaults` overwrote that file from the bundle on every launch.
    writeFileSync(
      CONFIG_FILE,
      JSON.stringify({ ...JSON.parse(validConfig()), sessionAllowedTools: ['Read', 'Grep'] }, null, 2),
      'utf-8',
    )
    const set = collectConfigOnlySettings()
    const allowed = set?.settings.find(entry => entry.key === 'sessionAllowedTools')
    expect(allowed?.value).toBe('Read, Grep')
    expect(allowed?.source).toBe('user')
    // …and its twin, untouched, still reads as the default rather than
    // inheriting the sibling's `user`.
    expect(set?.settings.find(entry => entry.key === 'sessionDisallowedTools')?.source).toBe('default')

    const report = buildConfigDoctorReport({ ...MANAGED_INPUT, configOnlySettings: set })
    expect(report.text).toContain('Read, Grep')
    // The sentence the old home needed has no producer any more.
    expect(report.text).not.toContain('set in: nowhere durably')
  })
})

/**
 * F1.661 — since F1.638 the whitelist reaches claude as the narrowing `tools` option, and the child ignores what is
 * not a built-in tool name (a scoped rule, an `mcp__` name, a typo) without a word — a scoped entry alone drops that
 * tool. The doctor names each such entry and why; a list of bare built-in names prints clean.
 */
describe('F1.661 — the doctor flags sessionAllowedTools entries claude ignores', () => {
  const rowsFor = (extra: Record<string, unknown>) => {
    writeFileSync(CONFIG_FILE, validConfig(extra), 'utf-8')
    const collected = collectConfigOnlySettings()
    return {
      collected,
      allowed: collected?.settings.find(entry => entry.key === 'sessionAllowedTools'),
      disallowed: collected?.settings.find(entry => entry.key === 'sessionDisallowedTools'),
    }
  }

  it('POSITIVE — a scoped rule, an mcp__ name and a typo are each named with the reason', () => {
    const { collected, allowed } = rowsFor({
      sessionAllowedTools: ['Read', 'Bash(git:*)', 'mcp__github__create_issue', 'Raed', 'Grep', 'Grep(src/**)'],
    })
    const warnings = allowed?.warnings ?? []
    expect(warnings).toHaveLength(4)
    expect(warnings[0]).toContain('"Bash(git:*)" is a permission rule, not a tool name')
    expect(warnings[0]).toContain('Bash is NOT kept on claude')
    expect(warnings[1]).toContain('"mcp__github__create_issue" is an MCP tool')
    expect(warnings[1]).toContain('MCP tools stay available')
    expect(warnings[2]).toContain('"Raed" is not a claude built-in tool name')
    // The boundary: the bare name is also listed, so the tool is kept and only the rule is ignored.
    expect(warnings[3]).toContain('(Grep is kept by its bare entry)')

    const report = buildConfigDoctorReport({ ...MANAGED_INPUT, configOnlySettings: collected })
    expect(report.text).toContain('      ! "Bash(git:*)" is a permission rule')
    expect(report.text).toContain('      ! "Raed" is not a claude built-in tool name')
    // A user-file value that does not bind is reported, not a finding — the config.json validation section's rule.
    expect(report.hasFindings).toBe(false)
  })

  it('CONTROL — bare built-in names print clean, and the blacklist may carry rules', () => {
    const { collected, allowed, disallowed } = rowsFor({
      sessionAllowedTools: ['Bash', 'Read', 'Grep', 'Agent', 'ToolSearch'],
      sessionDisallowedTools: ['Bash(rm:*)', 'mcp__github__*'],
    })
    expect(allowed?.value).toBe('Bash, Read, Grep, Agent, ToolSearch')
    expect(allowed?.warnings).toBeUndefined()
    expect(disallowed?.warnings).toBeUndefined()
    const report = buildConfigDoctorReport({ ...MANAGED_INPUT, configOnlySettings: collected })
    expect(report.text).not.toContain('      ! ')
  })

  it('PIN — every tool the vendored SDK declares is a known name, so a bump cannot over-warn silently', () => {
    const sdkTools = readFileSync(
      join(import.meta.dir, '../../../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts'),
      'utf-8',
    )
    // One `<Name>Input` per tool schema; three are spelled after the file operation, and `Mcp` is every MCP tool.
    const spelled: Record<string, string> = { FileEdit: 'Edit', FileRead: 'Read', FileWrite: 'Write' }
    const declared = [...sdkTools.matchAll(/^export interface ([A-Za-z]+)Input\b/gm)]
      .map(match => spelled[match[1]!] ?? match[1]!)
      .filter(name => name !== 'Mcp')
    // Positive control on the instrument: it reads claude's tools, not an empty or unrelated file.
    expect(declared).toContain('Bash')
    expect(declared.length).toBeGreaterThan(30)
    expect(declared.filter(name => !CLAUDE_KNOWN_TOOL_NAMES.has(name))).toEqual([])
    // Negative control: our own host tools are not claude's, so the set is not "any name at all".
    for (const ours of ['SubmitPlan', 'source_manage', 'call_llm']) expect(CLAUDE_KNOWN_TOOL_NAMES.has(ours)).toBe(false)
  })
})
