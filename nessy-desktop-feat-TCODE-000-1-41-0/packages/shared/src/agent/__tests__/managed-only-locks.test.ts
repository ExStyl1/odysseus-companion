/**
 * The managed-only admin locks.
 *
 * `settings-reference.md#allowmanagedhooksonly` — the effect list is
 * `#what-runs-under-allowmanagedhooksonly`: "**Managed and SDK hooks run**",
 * "**Force-enabled plugin hooks run**", and "**Everything else is blocked**:
 * user, project, and local hooks, hooks from other plugins, and hooks declared
 * in agent frontmatter".
 *
 * `settings-reference.md#allowmanagedpermissionrulesonly` — "Make managed
 * settings the only settings source of permission rules. Claude Code then
 * ignores `allow`, `ask`, and `deny` rules in user, project, local, and
 * `--settings` files, ignores `--allowedTools`, hides the always-allow choices
 * in permission prompts, and stops saving new rules."
 *
 * `settings-reference.md#strictpluginonlycustomization` — "Block skills, agents,
 * hooks, and MCP servers from user and project sources, so they can come only
 * from plugins or managed settings", **Scope**: `Managed`. Its PARSE is
 * here; its four enforcement sites are covered by
 * `server-core/src/bootstrap/__tests__/storage-runtime-policy.test.ts`.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parsePermissionsJson,
  permissionsConfigCache,
  type PermissionsContext,
} from '../permissions-config.ts'
import {
  areVettedPluginHooksAllowed,
  isManagedHooksOnly,
  isManagedPermissionRulesOnly,
  isStrictPluginOnlyCustomizationLocked,
  normalizeManagedPermissionMode,
  parseManagedPiPolicyTolerantV1,
  parseManagedPiPolicyV1,
  STRICT_CUSTOMIZATION_SURFACES,
} from '../pi-harness/managed-policy.ts'

const workspaceRootPath = mkdtempSync(join(tmpdir(), 'nessy-managed-lock-'))

const MANAGED_RULE = {
  version: 1,
  rules: [{ id: 'managed-1', action: 'deny' as const, match: { kind: 'tool', semanticId: 'bash' } }],
}

/** One settings-derived layer carrying an allow rule the user wrote. */
const USER_LAYER = JSON.stringify({
  permissionDsl: {
    version: 1,
    rules: [{ id: 'user-1', action: 'allow', match: { kind: 'tool', semanticId: 'read' } }],
  },
})

function compile(context: Partial<PermissionsContext>): readonly { id: string }[] {
  const merged = permissionsConfigCache.getMergedConfig({
    workspaceRootPath,
    pinnedRevision: 'gen-1',
    pinnedConfigs: [{ config: parsePermissionsJson(USER_LAYER), scope: 'workspace' }],
    managedPermissionDsl: MANAGED_RULE,
    ...context,
  } as PermissionsContext)
  return merged.permissionDsl?.rules ?? []
}

describe('allowManagedPermissionRulesOnly (settings-reference.md#allowmanagedpermissionrulesonly)', () => {
  it('without the lock, a user layer and the managed document both compile', () => {
    const ids = compile({}).map(rule => rule.id)
    expect(ids).toContain('managed-1')
    expect(ids).toContain('user-1')
  })

  it('with the lock, only the managed document survives', () => {
    const ids = compile({ managedPermissionRulesOnly: true }).map(rule => rule.id)
    expect(ids).toContain('managed-1')
    expect(ids).not.toContain('user-1')
  })

  it('a session rule from a PermissionRequest hook is not a settings file and survives', () => {
    // `:229` names user and project SETTINGS. A session rule is a hook's
    // in-memory grant for this turn; dropping it here would silently break the
    // R15 `updatedPermissions` band under an unrelated lock.
    const ids = compile({
      managedPermissionRulesOnly: true,
      sessionRules: [{ raw: 'allow Grep', action: 'allow', match: { kind: 'tool', semanticId: 'grep' } }],
    } as Partial<PermissionsContext>).map(rule => rule.id)
    expect(ids).toContain('session-0')
    expect(ids).not.toContain('user-1')
  })

  it('the lock is part of the cache key, so a locked context cannot be served an unlocked entry', () => {
    const base = {
      workspaceRootPath,
      pinnedRevision: 'gen-1',
      pinnedConfigs: [{ config: parsePermissionsJson(USER_LAYER), scope: 'workspace' as const }],
      managedPermissionDsl: MANAGED_RULE,
    }
    const open = permissionsConfigCache.getMergedConfig(base as PermissionsContext).permissionDsl?.rules ?? []
    const locked = permissionsConfigCache.getMergedConfig({
      ...base,
      managedPermissionRulesOnly: true,
    } as PermissionsContext).permissionDsl?.rules ?? []
    expect(open.map(rule => rule.id)).toContain('user-1')
    expect(locked.map(rule => rule.id)).not.toContain('user-1')
  })
})

describe('the lock keys parse at the managed tier', () => {
  it('accepts both keys and exposes them through named predicates', () => {
    const policy = parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      allowManagedHooksOnly: true,
      allowManagedPermissionRulesOnly: true,
      allowedPluginKeys: ['acme.vetted-hooks'],
    })
    expect(isManagedHooksOnly(policy)).toBe(true)
    expect(isManagedPermissionRulesOnly(policy)).toBe(true)
    // An allowlist entry does NOT vet a plugin's hooks — see the blocks below.
    expect(areVettedPluginHooksAllowed(policy)).toBe(false)
  })

  it('reads an invalid value at the enforcing pole and records the drop', () => {
    // Deliberate, and HALF of it is now documented. When this was written,
    // neither key sat on the fail-closed table, so the documented outcome for
    // both was a strip. Re-read 2026-09-10:
    // `managed-settings.md#keys-that-fail-closed` now carries
    // `allowManagedHooksOnly` — "Treated as `true` until fixed" — which is
    // exactly what this asserts, while `allowManagedPermissionRulesOnly` is
    // still absent from that table (it appears only under "Keys only a managed
    // source can set"). A lock a typo switches OFF is the failure this series
    // exists to remove, and the `tightened` drop makes the reading visible in
    // `nessy-general-agent doctor` instead of silent.
    const { policy, drops } = parseManagedPiPolicyTolerantV1(
      { schemaVersion: 1, disabledPermissionModes: [], allowManagedHooksOnly: 'yes', allowManagedPermissionRulesOnly: 1 },
      { source: 'test' },
    )
    expect(isManagedHooksOnly(policy)).toBe(true)
    expect(isManagedPermissionRulesOnly(policy)).toBe(true)
    expect(drops.map(drop => [drop.field, drop.disposition])).toEqual([
      ['allowManagedHooksOnly', 'tightened'],
      ['allowManagedPermissionRulesOnly', 'tightened'],
    ])
  })

  it('no plugin allowlist can vet plugin hooks — only the force-enabled set does', () => {
    // `settings-reference.md#what-runs-under-allowmanagedhooksonly` keeps hooks
    // from plugins FORCE-ENABLED in managed `enabledPlugins`. THIS is the
    // assertion that keeps the reopened carve-out
    // honest, so it is written as an exclusion rather than as a happy path.
    //
    // The first implementation substituted `allowedPluginKeys` for that set.
    // That is wider than the document: the allowlist means "these plugins may
    // be used", and an administrator writing it under that reading would be
    // granting in-process hook execution to every plugin on an organisation
    // allowlist without ever saying so. Two lists that differ in meaning must
    // not be merged because they are the only two we have.
    for (const policy of [
      { schemaVersion: 1, disabledPermissionModes: [], allowManagedHooksOnly: true },
      { schemaVersion: 1, disabledPermissionModes: [], allowedPluginKeys: [] },
      { schemaVersion: 1, disabledPermissionModes: [], allowedPluginKeys: ['acme.vetted-hooks'] },
      { schemaVersion: 1, disabledPermissionModes: [], allowManagedHooksOnly: true, allowedPluginKeys: ['acme.one', 'acme.two'] },
      // An allowlist AND an empty force-enable map: still nothing vetted.
      { schemaVersion: 1, disabledPermissionModes: [], allowedPluginKeys: ['acme.one'], enabledPlugins: {} },
      // A BLOCKED entry names a plugin without force-enabling it. Reading the
      // map's keys instead of its `true` values would vet a plugin the
      // administrator just switched off.
      { schemaVersion: 1, disabledPermissionModes: [], allowManagedHooksOnly: true, enabledPlugins: { 'acme.blocked': false } },
    ]) {
      expect(areVettedPluginHooksAllowed(parseManagedPiPolicyV1(policy))).toBe(false)
    }
  })

  it('a force-enabled plugin reopens the carve-out — its documented subject', () => {
    // `settings-reference.md#what-runs-under-allowmanagedhooksonly` —
    // "**Force-enabled plugin hooks run**: hooks from plugins your managed
    // settings force-enable through `enabledPlugins`. … This lets you distribute
    // vetted hooks through an organization marketplace while blocking everything
    // else".
    const policy = parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      allowManagedHooksOnly: true,
      enabledPlugins: { 'acme.vetted-hooks': true, 'acme.blocked': false },
    })
    expect(isManagedHooksOnly(policy)).toBe(true)
    expect(areVettedPluginHooksAllowed(policy)).toBe(true)
  })

  it('strictPluginOnlyCustomization locks exactly the surfaces it names', () => {
    // `settings-reference.md#strictpluginonlycustomization` — "**Type**: `true`
    // to lock all four kinds of customization, or an array naming the kinds to
    // lock, from `"skills"`, `"agents"`, `"hooks"`, and `"mcp"`". `true` is
    // NORMALIZED to the four so no reader downstream sees a `true | array` union.
    const subset = parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      strictPluginOnlyCustomization: ['skills', 'hooks'],
    })
    expect(subset.strictPluginOnlyCustomization).toEqual(['skills', 'hooks'])
    expect(isStrictPluginOnlyCustomizationLocked(subset, 'skills')).toBe(true)
    expect(isStrictPluginOnlyCustomizationLocked(subset, 'hooks')).toBe(true)
    // The two it did NOT name stay open — the whole point of the array form.
    expect(isStrictPluginOnlyCustomizationLocked(subset, 'agents')).toBe(false)
    expect(isStrictPluginOnlyCustomizationLocked(subset, 'mcp')).toBe(false)

    const all = parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      strictPluginOnlyCustomization: true,
    })
    expect(all.strictPluginOnlyCustomization).toEqual(STRICT_CUSTOMIZATION_SURFACES)
    for (const surface of STRICT_CUSTOMIZATION_SURFACES) {
      expect(isStrictPluginOnlyCustomizationLocked(all, surface)).toBe(true)
    }

    // Absent stays absent, and nothing is locked by omission.
    const none = parseManagedPiPolicyV1({ schemaVersion: 1, disabledPermissionModes: [] })
    expect(none.strictPluginOnlyCustomization).toBeUndefined()
    expect(isStrictPluginOnlyCustomizationLocked(none, 'skills')).toBe(false)
  })

  it('ignores an unrecognised surface NAME silently and strips a malformed entry with a warning', () => {
    // `settings-reference.md#strictpluginonlycustomization` in full: "Claude Code
    // ignores surface names it doesn't recognize rather than failing the settings
    // file, so you can add new surface names before every client has updated."
    // The second half
    // is why an unknown NAME records no drop — an admin writing tomorrow's
    // surface name is doing the documented thing and `doctor` must stay quiet.
    const forward = parseManagedPiPolicyTolerantV1(
      { schemaVersion: 1, disabledPermissionModes: [], strictPluginOnlyCustomization: ['skills', 'rules'] },
      { source: 'test' },
    )
    expect(forward.policy.strictPluginOnlyCustomization).toEqual(['skills'])
    expect(forward.drops).toEqual([])

    // A number is not a surface NAME, so `:186`'s general managed rule applies
    // instead: "strips that entry, records a warning, and enforces every
    // remaining valid policy".
    const malformed = parseManagedPiPolicyTolerantV1(
      { schemaVersion: 1, disabledPermissionModes: [], strictPluginOnlyCustomization: ['agents', 7] },
      { source: 'test' },
    )
    expect(malformed.policy.strictPluginOnlyCustomization).toEqual(['agents'])
    expect(malformed.drops.map(drop => [drop.field, drop.disposition])).toEqual([
      ['strictPluginOnlyCustomization', 'stripped'],
    ])

    // A wholly invalid VALUE is STRIPPED, never read at the enforcing pole the
    // way the two boolean locks above are. Nothing documented asks for it, and
    // this key's enforcing pole would withdraw every user and project skill,
    // agent and MCP server across a fleet out of one typo.
    const invalid = parseManagedPiPolicyTolerantV1(
      { schemaVersion: 1, disabledPermissionModes: [], strictPluginOnlyCustomization: 'skills' },
      { source: 'test' },
    )
    expect(invalid.policy.strictPluginOnlyCustomization).toBeUndefined()
    expect(invalid.drops.map(drop => [drop.field, drop.disposition])).toEqual([
      ['strictPluginOnlyCustomization', 'stripped'],
    ])
  })

  it('the strict tier still refuses a malformed lock outright', () => {
    // `managed-settings.md#keys-that-fail-closed` — the user/project/local tier
    // is not tolerant ("a file whose JSON or top-level shape fails validation is
    // rejected as a whole and reported"), and the enforcing-pole reading must not
    // leak into it.
    expect(() => parseManagedPiPolicyV1({ schemaVersion: 1, disabledPermissionModes: [], allowManagedHooksOnly: 'yes' }))
      .toThrow('invalid managed Pi policy allowManagedHooksOnly')
  })
})

/**
 * `settings-reference.md#permissions-defaultmode` — "Set the permission mode
 * new sessions start in."
 */
describe('managed defaultMode (settings-reference.md#permissions-defaultmode)', () => {
  it('parses our own mode names, the same vocabulary disabledPermissionModes uses', () => {
    expect(parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      defaultMode: 'plan',
    }).defaultMode).toBe('plan')
    expect(parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      defaultMode: 'allow-all',
    }).defaultMode).toBe('bypassPermissions')
  })

  it('strips an unknown value rather than guessing a tighter one', () => {
    // There is no tighter reading of a DEFAULT. Guessing `plan` from a typo
    // takes a fleet out of the mode its administrator chose, and
    // `disabledPermissionModes` is still the key that forbids. (The unknown
    // sample used to be `bypassPermissions`, which the alias table now
    // resolves — a real typo stands in for it.)
    const { policy, drops } = parseManagedPiPolicyTolerantV1(
      { schemaVersion: 1, disabledPermissionModes: [], defaultMode: 'bypass-typo' },
      { source: 'test' },
    )
    expect(policy.defaultMode).toBeUndefined()
    expect(drops.map(drop => [drop.field, drop.disposition])).toEqual([['defaultMode', 'stripped']])
  })

  it('is a default, not a ceiling: disabledPermissionModes still clamps it', () => {
    // The two keys compose — `normalizeManagedPermissionMode` is what every
    // session-construction path runs the resolved mode through.
    const policy = parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: ['allow-all'],
      defaultMode: 'allow-all',
    })
    expect(normalizeManagedPermissionMode(policy.defaultMode!, policy.disabledPermissionModes))
      .toBe('auto')
  })
})

/**
 * D2 — the lock has to close every door, not just the readable-rule one.
 *
 * `settings-reference.md#allowmanagedpermissionrulesonly` gates
 * `addPermissionDsl`, and three appliers ran
 * unconditionally beside it, so a workspace or source `permissions.json` could
 * still add an allowed tool, a write root and an `allowedApiEndpoints` EGRESS
 * target under a lock the administrator had set.
 *
 * Direction, not field count, is the rule. The three SIBLING managed-only locks
 * in `permissions.md`'s "Managed-only settings" table all say the same thing in
 * their own words:
 *
 *   "`allowManagedMcpServersOnly` | When `true`, only `allowedMcpServers` from
 *   managed settings are respected. `deniedMcpServers` still merges from all
 *   sources."
 *   "`sandbox.filesystem.allowManagedReadPathsOnly` | When `true`, only
 *   `filesystem.allowRead` paths from managed settings are respected.
 *   `denyRead` still merges from all sources"
 *   "`sandbox.network.allowManagedDomainsOnly` | When `true`, only
 *   `allowedDomains` and `WebFetch(domain:...)` allow rules from managed
 *   settings are respected. Non-allowed domains are blocked automatically
 *   without prompting the user. Denied domains still merge from all sources"
 *
 * A lock that also dropped the deny half would be a way to make the product
 * LESS safe than with the lock off, which is the one outcome an admin control
 * must never have.
 */
describe('the managed-only lock covers the widening appliers (D2)', () => {
  /** A workspace layer that widens in every allow direction, and denies in two. */
  const WIDENING_LAYER = JSON.stringify({
    allowedBashPatterns: ['^curl .*$'],
    allowedMcpPatterns: ['deleteEverything'],
    allowedApiEndpoints: [{ method: 'POST', path: '^/exfiltrate$' }],
    allowedWritePaths: ['/etc/**'],
    allowedTools: ['Bash'],
    disallowedTools: ['NetworkTool'],
    deniedPaths: ['**/.ssh/**'],
    deniedToolPatterns: ['DangerousTool'],
    blockedTools: ['BlockedTool'],
    toolRules: [
      { pattern: 'Bash', action: 'allow' },
      { pattern: 'Write', action: 'deny' },
      { pattern: 'Edit', action: 'ask' },
    ],
  })

  function mergedWith(
    context: Partial<PermissionsContext>,
    scope: 'workspace' | 'plugin' | 'managed' | 'global' = 'workspace',
  ) {
    return permissionsConfigCache.getMergedConfig({
      workspaceRootPath,
      pinnedRevision: `gen-${scope}-${context.managedPermissionRulesOnly === true ? 'locked' : 'open'}`,
      pinnedConfigs: [{
        config: parsePermissionsJson(WIDENING_LAYER),
        scope,
        ...(scope === 'plugin' ? { sourceSlug: 'acme' } : {}),
      }],
      ...context,
    } as PermissionsContext)
  }

  it('without the lock nothing changes — every contribution lands', () => {
    const merged = mergedWith({})
    expect(merged.allowedTools).toContain('Bash')
    expect(merged.allowedWritePaths).toContain('/etc/**')
    expect(merged.allowedApiEndpoints.some(rule => rule.pathPattern.test('/exfiltrate'))).toBe(true)
    expect(merged.readOnlyBashPatterns.some(pattern => pattern.source === '^curl .*$')).toBe(true)
    expect(merged.readOnlyMcpPatterns.some(pattern => pattern.test('deleteEverything'))).toBe(true)
    expect(merged.toolRules.filter(rule => rule.action === 'allow').map(rule => rule.pattern)).toContain('Bash')
  })

  it('under the lock a workspace layer contributes NO allow-direction entry', () => {
    const merged = mergedWith({ managedPermissionRulesOnly: true })
    expect(merged.allowedTools).not.toContain('Bash')
    expect(merged.allowedWritePaths).not.toContain('/etc/**')
    // Egress. This is the row the group is ordered around.
    expect(merged.allowedApiEndpoints.some(rule => rule.pathPattern.test('/exfiltrate'))).toBe(false)
    expect(merged.readOnlyBashPatterns.some(pattern => pattern.source === '^curl .*$')).toBe(false)
    expect(merged.readOnlyMcpPatterns.some(pattern => pattern.test('mcp__acme__deleteEverything'))).toBe(false)
    expect(merged.toolRules.filter(rule => rule.action === 'allow').map(rule => rule.pattern)).not.toContain('Bash')
  })

  it('under the lock every DENY-direction contribution from the same layer still applies', () => {
    const merged = mergedWith({ managedPermissionRulesOnly: true })
    expect(merged.deniedPaths).toContain('**/.ssh/**')
    expect(merged.deniedToolPatterns).toContain('DangerousTool')
    expect(merged.disallowedTools).toContain('NetworkTool')
    // `blockedTools` joined this family with P2.39; it extends SAFE_MODE_CONFIG's
    // four rather than replacing them, so it denies and the lock leaves it alone.
    expect([...merged.blockedTools]).toContain('BlockedTool')
    // A single `toolRules` array carrying BOTH directions is split entry by
    // entry: the allow goes, the deny and the ask stay.
    const kept = merged.toolRules.filter(rule => rule.pattern === 'Write' || rule.pattern === 'Edit')
    expect(kept.map(rule => rule.action).sort()).toEqual(['ask', 'deny'])
  })

  it('under the lock the app\'s own read-only defaults are untouched', () => {
    // The app ships its read-only classification in
    // `~/.nessy-agent/permissions/default.json` — 196 bash patterns and 15 MCP
    // patterns — and `native-sources.ts:940` registers that file at GLOBAL
    // scope, which is how it reaches this function in the real capability path.
    // Those patterns are what make `ls` and `git status` read-only; dropping
    // them under the lock would make every command in `safe`, `plan` and `auto`
    // prompt, and an administrator would switch the lock back off.
    const locked = mergedWith({ managedPermissionRulesOnly: true }, 'global')
    expect(locked.readOnlyBashPatterns.some(pattern => pattern.regex.test('curl https://example.test'))).toBe(true)
    expect(locked.readOnlyMcpPatterns.some(pattern => pattern.test('deleteEverything'))).toBe(true)
    // Its GRANTS still drop. The shipped file declares none, so this costs the
    // product nothing and closes the path a user editing that file would keep.
    expect(locked.allowedTools).not.toContain('Bash')
    expect(locked.allowedWritePaths).not.toContain('/etc/**')
    expect(locked.allowedApiEndpoints.some(rule => rule.pathPattern.test('/exfiltrate'))).toBe(false)
  })

  it('the lock can never erase SAFE_MODE_CONFIG — the hardcoded floor is not a scope', () => {
    const open = mergedWith({})
    const locked = mergedWith({ managedPermissionRulesOnly: true })
    expect([...locked.blockedTools]).toEqual([...open.blockedTools])
    expect(locked.deniedPaths).toEqual(expect.arrayContaining(
      open.deniedPaths.filter(path => path !== '**/.ssh/**'),
    ))
  })

  it('a source (plugin) layer is locked exactly like the workspace one', () => {
    const merged = mergedWith({ managedPermissionRulesOnly: true }, 'plugin')
    expect(merged.allowedTools).not.toContain('Bash')
    expect(merged.allowedWritePaths).not.toContain('/etc/**')
    expect(merged.allowedApiEndpoints.some(rule => rule.pathPattern.test('/exfiltrate'))).toBe(false)
    // The source applier auto-scopes MCP patterns; the scoped form must go too.
    expect(merged.readOnlyMcpPatterns.some(pattern => pattern.test('mcp__acme__deleteEverything'))).toBe(false)
    // …and its deny half survives.
    expect(merged.deniedPaths).toContain('**/.ssh/**')
  })

  it('a MANAGED layer keeps everything — the lock says "only rules in managed settings apply"', () => {
    const merged = mergedWith({ managedPermissionRulesOnly: true }, 'managed')
    expect(merged.allowedTools).toContain('Bash')
    expect(merged.allowedWritePaths).toContain('/etc/**')
    expect(merged.allowedApiEndpoints.some(rule => rule.pathPattern.test('/exfiltrate'))).toBe(true)
    expect(merged.readOnlyBashPatterns.some(pattern => pattern.source === '^curl .*$')).toBe(true)
    expect(merged.toolRules.filter(rule => rule.action === 'allow').map(rule => rule.pattern)).toContain('Bash')
  })
})
