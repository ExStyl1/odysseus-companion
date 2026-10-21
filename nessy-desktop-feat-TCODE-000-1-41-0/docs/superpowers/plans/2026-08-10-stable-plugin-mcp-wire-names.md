# Stable Plugin MCP Wire Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A plugin-bundled MCP server can never take, move, or break the wire name of a built-in or user-configured server — and a wire-name mismatch degrades one tool instead of killing every chat turn.

**Architecture:** Adopt Claude Code's naming contract at our one naming authority (`applyCollisionPolicy` in the capability resolver): plugin MCP servers ALWAYS carry a stable plugin-qualified wire name (`plugin_<pluginId>_<serverName>`), bare names belong to builtin/scoped servers only. All three runtimes (Pi, Claude, Codex) consume names from this single mint via the workspace MCP pool, so no per-runtime work is needed beyond conformance tests and a Codex-path length cap. A degrade layer in the Pi manifest turns any residual name drift into a dropped tool plus a diagnostic. Plugin content that references its own servers (hook `mcpTool`, skill `allowed-tools`, agent `mcpServers`) is translated to wire names at projection/resolution; user permission patterns get a read-path alias.

**Tech Stack:** TypeScript, Bun test. No new dependencies.

## Upstream contract (verbatim, fetched 2026-08-10)

- `mcp.md:365`: "The server itself registers under the scoped name `plugin:<plugin-name>:<server-name>`" — plugin servers never own a bare name, ever (not only under contest).
- `mcp.md:357`: tools are `mcp__plugin_<plugin-name>_<server-name>__<tool-name>`, "where any character outside `A-Z`, `a-z`, `0-9`, `_`, and `-` is replaced with `_`".
- `mcp.md:363`: "A hook matcher written against the bare server key … never fires for a plugin-bundled server" — correctly-written Claude plugins already reference the full form.
- `mcp.md:449`: "When the same server is defined in more than one place, Claude Code connects to it once, using the definition from the highest-precedence source." Precedence: Local > Project > User > Plugin > connectors.
- `mcp.md:457`: "The three scopes match duplicates by name. Plugins and connectors match by endpoint."
- Codex cross-check (openai/codex `codex-rs/codex-mcp/src/catalog.rs`): one catalog, `RegistrationPrecedence { Plugin < SelectedPlugin < Config < Compatibility < Extension }`, one winner per name, conflicts surfaced as data — never a rename, never a turn failure.

## The defect being fixed

Field incident 2026-08-10: installing marketplace plugins that declare MCP servers named like built-in dp servers (`t-tracker`, …) made every chat turn throw `Pi execution manifest MCP wireName must resolve exactly once: t-tracker`. Chain:

1. All 30 built-in dp servers are always projected as capability records (`packages/server-core/src/bootstrap/storage-runtime.ts:630`), enabled or not.
2. A plugin server with the same logical name lands in the same collision bucket. When contested, `applyCollisionPolicy` strips the short name from EVERYONE — including the builtin (`packages/shared/src/capabilities/resolver.ts:2307-2318`).
3. The builtin fold still materializes the builtin under its bare `definition.name` (`packages/shared/src/mcp/builtin-dp-servers.ts:284`), so the pool serves `mcp__t-tracker__*` while the manifest seed only knows `t-tracker-<sha10>`.
4. Seed lookup misses → `throw` on every turn (`packages/shared/src/agent/pi-agent.ts:1767`, `packages/shared/src/agent/pi-harness/harness-manifest.ts:438`). Disabling servers in the UI does not help: collision buckets ignore `enabled` (`resolver.ts:2197`).

Two invariants restored by this plan:

- **N1 (naming):** a builtin/scoped MCP capability's wire name ALWAYS equals its logical name; a plugin MCP capability's wire name is ALWAYS `plugin_<pluginId>_<serverName>` — a pure function of the plugin identity, independent of what else is installed.
- **N2 (degrade):** a proxy tool whose wire name does not resolve exactly once in the manifest seed is dropped with a diagnostic; the turn proceeds.

## Owner decisions (chat, 2026-08-10)

- Adopt A′ (Claude-parity always-qualified plugin names) + B (per-tool degrade) + install/resolve-time identity dedup. Marketplace-side linting is out of scope for the app repo.
- Wire-name format follows Claude's `plugin_<plugin>_<server>` shape (not our previous `<name>-<sha10>`), so correctly-written Claude plugins' internal references match without translation.
- Bundles are immutable and hash-verified: dedup is an ACTIVATION decision (`enabled: false` + reason), never a bundle mutation.
- Fatal-throw paths for schema-version and provenance mismatches stay fatal (host-authored integrity, must be loud); ONLY wire-name resolution degrades.

## Global Constraints

- Wire names and proxy tool names must match `^[A-Za-z0-9_-]+$` end to end; segments are sanitized per `mcp.md:357` and runs of `_` are collapsed so `mcp__<wire>__<tool>` stays greedily parseable (parser splits on the LAST `__`; wire names must not contain `__`).
- OpenAI-compatible endpoints cap tool names at 64 chars (Pi → Nestor gateway path, Codex path). EVERY wire name, whatever its origin — scoped/builtin winner, shadowed entry, or plugin — is capped at 40 chars AT THE MINT (`capMcpNameSegment`, `applyCollisionPolicy`'s `byMcp` branch in `capabilities/resolver.ts`), not deeper in the pool; full proxy names then fit 64 in the pool by truncating the tool segment with a 6-hex hash tail (`buildPoolProxyBaseName`, `mcp/mcp-pool.ts`). Anthropic's 128-char limit is looser than both — no separate Claude cap.
- Several source files carry NUL bytes: use `rg -a` for every absence claim.
- `rm -rf release` before any repo-root `bun test`; never run two `bun test` processes concurrently; `bun run typecheck:all` does not cover `apps/cli`.
- `mock.module` in tests must spread the real module AND restore in `afterAll` (pattern: `claude-gateway-adapter.test.ts:79`).
- Implementation-First Verification Budget applies: focused tests + affected-package typecheck per task; the full wave runs once at close-out.
- i18n: every new user-visible string gets keys in BOTH `en.json` and `ru.json`, alphabetically sorted (`bun run lint:i18n:parity`, `bun run lint:i18n:sorted`).
- No `Co-Authored-By` trailers. One commit per task, message given in the task. Branch: `bugfix/TCODE-000`.
- Tasks T1→T4→T4b→T5 are strictly sequential (T2, T3, T4, and T4b all edit `resolver.ts`; T3 and T5 consume T2's naming module). Do not parallelize tasks that touch one file.

## File map

| File | Role in this plan |
| --- | --- |
| `packages/shared/src/capabilities/mcp-wire-name.ts` | NEW — naming mint: `pluginMcpWireName`, `capMcpNameSegment`, `pluginIdFromInstanceId`, `translatePluginMcpToolName` |
| `packages/shared/src/capabilities/resolver.ts` | byMcp branch rewrite (N1), builtin-identity dedup, skill `allowedTools` translation post-pass |
| `packages/shared/src/agent/pi-harness/harness-manifest.ts` | `tryParsePiDynamicMcpBindingName`, seed dedupe + `debug` param, `resolveDynamicTool` → nullable (N2) |
| `packages/shared/src/agent/pi-agent.ts` | proxy-def loop skips unresolvable wire names (N2); permission-pattern alias expansion |
| `packages/server-core/src/sessions/SessionManager.ts:4637` | pass `debug` into `createPiExecutionManifestSeed` |
| `packages/shared/src/mcp/mcp-pool.ts` | shared `buildPoolProxyBaseName` with 64-char cap (`:997`, `:2574`) |
| `packages/shared/src/plugins/projection.ts` | hook `mcpTool` translation post-pass |
| `packages/shared/src/agent/pi-harness/runtime-agent-definition.ts:728-737` | agent `mcpServers:` alias rows for plugin servers |
| `packages/shared/src/capabilities/views.ts` | carry `logicalName` on `RuntimeMcpServer` |
| `packages/shared/src/capabilities/types.ts` | `unavailableReason` union + `RuntimeMcpServer.logicalName` |
| `apps/electron/src/renderer/**` | display map entry for the new unavailable reason (anchor: rg `shadowed-by-mcp-precedence`) |
| `packages/shared/src/i18n/locales/{en,ru}.json` | reason string |
| docs-site, release notes, package.jsons | close-out |

---

### Task 1: N2 — a wire-name mismatch drops the tool, not the session

**Files:**
- Modify: `packages/shared/src/agent/pi-harness/harness-manifest.ts` (`:357` seed builder, `:411` resolveDynamicTool, `:469` parser, `:561` finalize)
- Modify: `packages/shared/src/agent/pi-agent.ts:1761-1790`
- Modify: `packages/server-core/src/sessions/SessionManager.ts:4637`
- Test: `packages/shared/src/agent/pi-harness/__tests__/harness-manifest-degrade.test.ts` (new)

**Interfaces:**
- Produces: `tryParsePiDynamicMcpBindingName(name: string): { wireName: string; toolName: string } | null` (exported; the throwing `parsePiDynamicMcpBindingName` stays for existing callers/tests).
- Produces: `createPiExecutionManifestSeed(input: { …, debug?: (message: string) => void })` — duplicate seed wireNames are deduped deterministically instead of throwing.
- Produces: `resolveDynamicTool` returns `ResolvedHarnessTool | null`; `finalizePiExecutionManifest` filters nulls. ONLY the `sources.length !== 1` paths degrade; schema-version and provenance throws stay.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/src/agent/pi-harness/__tests__/harness-manifest-degrade.test.ts
import { describe, expect, test } from 'bun:test'
import {
  createPiExecutionManifestSeed,
  finalizePiExecutionManifest,
  tryParsePiDynamicMcpBindingName,
} from '../harness-manifest.ts'

const sessionKey = { workspaceId: 'ws', sessionId: 's1' }

function seedInput(mcpServers: { key: string; wireName: string }[]) {
  return {
    snapshot: { generation: 1 },
    sessionKey,
    view: {
      generation: 1,
      sources: [],
      mcpServers,
    },
    // keep the managed-model seam deterministic in tests: `undefined` would
    // fall through `??` into managedModelAllowlist() and read host state
    orchestrator: { availableModels: [] },
  } as Parameters<typeof createPiExecutionManifestSeed>[0]
}

function dynamicTool(bindingName: string, capabilityKey: string) {
  return {
    bindingName,
    description: 'd',
    inputSchema: { type: 'object', properties: {} },
    modelSchemaVersion: 1 as const,
    bindingSchemaVersion: 1 as const,
    provenance: { capabilityKey, generation: 1 },
  }
}

describe('N2 degrade', () => {
  test('tryParse returns null instead of throwing', () => {
    expect(tryParsePiDynamicMcpBindingName('not-an-mcp-name')).toBeNull()
    expect(tryParsePiDynamicMcpBindingName('mcp__t-tracker__list')).toEqual({ wireName: 't-tracker', toolName: 'list' })
  })

  test('duplicate seed wireNames dedupe deterministically with a debug line', () => {
    const lines: string[] = []
    const seed = createPiExecutionManifestSeed({
      ...seedInput([
        { key: 'b-key', wireName: 't-tracker' },
        { key: 'a-key', wireName: 't-tracker' },
      ]),
      debug: line => lines.push(line),
    })
    expect(seed.mcpSources).toHaveLength(1)
    expect(seed.mcpSources[0]!.capabilityKey).toBe('a-key') // lexically-smallest key wins
    expect(lines.some(line => line.includes('t-tracker'))).toBe(true)
  })

  test('a tool whose wireName is missing from the seed is dropped, not fatal', () => {
    const seed = createPiExecutionManifestSeed(seedInput([{ key: 'k', wireName: 'present' }]))
    const manifest = finalizePiExecutionManifest(seed, [
      dynamicTool('mcp__present__list', 'k'),
      dynamicTool('mcp__absent__list', 'k'),
    ])
    const names = manifest.tools.map(tool => tool.binding.bindingName)
    expect(names).toContain('mcp__present__list')
    expect(names).not.toContain('mcp__absent__list')
  })
})
```

Adjust the two helper literals to the real input types while writing — the seed/view types are structural; copy missing required fields from `live-manifest-contract.test.ts:140` (`packages/pi-agent-server/src/harness/live-manifest-contract.test.ts`), which drives the same production builder. In particular the seed's `provenance` array must contain `{ capabilityKey, generation }` for the mcp source your dynamic tool claims, or `resolveDynamicTool` fails on the (deliberately kept) provenance throw instead of exercising the degrade path.

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/shared/src/agent/pi-harness/__tests__/harness-manifest-degrade.test.ts`
Expected: FAIL (`tryParsePiDynamicMcpBindingName` not exported; seed throws `ambiguous`).

- [ ] **Step 3: Implement in `harness-manifest.ts`**

Parser (beside `:469`):

```ts
export function tryParsePiDynamicMcpBindingName(bindingName: string): { wireName: string; toolName: string } | null {
  const match = /^mcp__([A-Za-z0-9_-]+)__([A-Za-z0-9_-]+)$/.exec(bindingName)
  if (!match) return null
  return { wireName: match[1]!, toolName: match[2]! }
}
```

Rewrite the existing throwing `parsePiDynamicMcpBindingName` body to delegate: `const parsed = tryParse…; if (!parsed) throw new Error(…same message…); return parsed`.

Seed builder (replace the throw at `:387-389`; add `debug?: (message: string) => void` to the input type):

```ts
  const sorted = [/* the existing two spreads */]
    .sort((a, b) => a.wireName.localeCompare(b.wireName) || a.capabilityKey.localeCompare(b.capabilityKey))
  const byWire = new Map<string, typeof sorted[number]>()
  for (const source of sorted) {
    const existing = byWire.get(source.wireName)
    if (!existing) { byWire.set(source.wireName, source); continue }
    input.debug?.(`pi-manifest: duplicate MCP wireName "${source.wireName}" — keeping ${existing.capabilityKey}, dropping ${source.capabilityKey}`)
  }
  const mcpSources = [...byWire.values()]
```

`resolveDynamicTool` (`:434-447`): in the `!known` branch, use `tryParse…`; return `null` when parse fails or `sources.length !== 1`. Keep the provenance-capture throw (`:441-446`) and the schema throws (`:412-420`) intact. Change the return type to `ResolvedHarnessTool | null`.

`finalizePiExecutionManifest` (`:561`):

```ts
  const dynamic = dynamicTools.map(value => resolveDynamicTool(seed, value))
    .filter((tool): tool is ResolvedHarnessTool => tool !== null)
    .filter(tool => !allowed || allowed.has(tool.binding.bindingName) || allowed.has(tool.binding.piName))
```

- [ ] **Step 4: Implement in `pi-agent.ts:1761-1790`**

Replace the `tools.map(definition => { … throw … })` with a loop that skips; keep the pushed object literal EXACTLY as today:

```ts
    const dynamicTools: PiDynamicToolDefinition[] = [];
    for (const definition of tools) {
      const known = getPiToolBindingByBindingName(definition.name);
      const parsed = known ? undefined : tryParsePiDynamicMcpBindingName(definition.name);
      const sources = parsed
        ? manifestSeed.mcpSources.filter(value => value.wireName === parsed.wireName)
        : [];
      if (!known && (!parsed || sources.length !== 1)) {
        debug(`pi-manifest: proxy tool ${definition.name} skipped — wireName resolves ${sources.length} time(s) in the seed`);
        continue;
      }
      // …existing body of the map callback, ending in dynamicTools.push({ … })…
    }
```

`pi-agent.ts` already imports a `debug` helper; if the import name differs, use that one (grep `debug(` at the top of the file). Update the `harness-manifest.ts` import list to add `tryParsePiDynamicMcpBindingName`.

- [ ] **Step 5: Pass `debug` at the seed call site**

`packages/server-core/src/sessions/SessionManager.ts:4637`: add `debug: (message) => sessionLog.debug(message),` to the `createPiExecutionManifestSeed({ … })` input (the file already has `sessionLog` in scope).

- [ ] **Step 6: Run tests + typecheck**

```bash
bun test packages/shared/src/agent/pi-harness/__tests__/harness-manifest-degrade.test.ts
bun run typecheck:shared
bun test packages/pi-agent-server/src/harness/live-manifest-contract.test.ts
```
Expected: all PASS. The live-manifest contract test proves the seed/finalize signature change broke no production shape.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/agent/pi-harness packages/shared/src/agent/pi-agent.ts packages/server-core/src/sessions/SessionManager.ts
git commit -m "fix(pi): a wireName mismatch drops the tool, not the session"
```

---

### Task 2: N1 — plugin MCP servers own stable plugin-qualified wire names

**Files:**
- Create: `packages/shared/src/capabilities/mcp-wire-name.ts`
- Test: `packages/shared/src/capabilities/__tests__/mcp-wire-name.test.ts` (new)
- Modify: `packages/shared/src/capabilities/resolver.ts:2268-2335` (byMcp branch + `qualifiedMcpWireName` retirement)
- Modify: `packages/shared/src/mcp/mcp-pool.ts:997`, `:2566-2575` (shared capped proxy-name builder)
- Modify: `packages/shared/src/capabilities/types.ts`, `views.ts` (carry `logicalName` on the server binding — consumed by T3)

**Interfaces:**
- Produces: `pluginMcpWireName(pluginId: string, serverName: string): string` — pure, deterministic, ≤40 chars, no `__` runs.
- Produces: `capMcpNameSegment(value: string, max: number): string` (truncate + `_<sha6>` tail).
- Produces: `pluginIdFromInstanceId(instanceId: string): string | null` (parses `plugin://<marketplaceId>/<pluginId>@<version>#<hash>`, the `createPluginInstanceIdV2` format — `packages/shared/src/plugins/store-v2.ts:108`).
- Produces: `buildPoolProxyBaseName(slug: string, toolName: string): string` in `mcp-pool.ts` (used by both mint and lookup).
- Produces: `RuntimeMcpServer.logicalName: string` (new required field set where the binding is built, `resolver.ts:1068-1099`).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/src/capabilities/__tests__/mcp-wire-name.test.ts
import { describe, expect, test } from 'bun:test'
import { capMcpNameSegment, pluginIdFromInstanceId, pluginMcpWireName } from '../mcp-wire-name.ts'

describe('pluginMcpWireName', () => {
  test('claude-shaped, stable, sanitized', () => {
    expect(pluginMcpWireName('figma', 't-tracker')).toBe('plugin_figma_t-tracker')
    expect(pluginMcpWireName('my plugin!', 'db.tools')).toBe('plugin_my_plugin_db_tools')
  })
  test('never contains __ and never exceeds 40 chars', () => {
    const name = pluginMcpWireName('a__very__long__plugin__name__indeed__x', 'server__with__runs')
    expect(name).not.toMatch(/__/)
    expect(name.length).toBeLessThanOrEqual(40)
  })
  test('cap is deterministic and collision-resistant', () => {
    const a = capMcpNameSegment('x'.repeat(80), 40)
    const b = capMcpNameSegment('x'.repeat(80) + 'y', 40)
    expect(a).toHaveLength(40)
    expect(a).not.toBe(b)
    expect(capMcpNameSegment('short', 40)).toBe('short')
    // A slice ending on `_` must not form `__` at the hash joint.
    expect(capMcpNameSegment(`${'a'.repeat(32)}_${'b'.repeat(40)}`, 40)).not.toMatch(/__/)
  })
  test('pluginIdFromInstanceId parses the v2 format', () => {
    expect(pluginIdFromInstanceId('plugin://registry-abc/figma@2.0.13#deadbeef')).toBe('figma')
    expect(pluginIdFromInstanceId('garbage')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/shared/src/capabilities/__tests__/mcp-wire-name.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `mcp-wire-name.ts`**

```ts
// packages/shared/src/capabilities/mcp-wire-name.ts
// Wire-name mint for plugin-bundled MCP servers. Contract: mcp.md:357/365 —
// plugin servers are ALWAYS namespaced by plugin identity; the name is a pure
// function of (pluginId, serverName) so projection, resolver, and translation
// compute it identically with no registry state.
import { createHash } from 'node:crypto'

const sha6 = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 6)

/** `mcp.md:357` sanitization + collapse `_` runs so `mcp__<wire>__<tool>` stays parseable. */
const segment = (value: string): string =>
  value.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '')

/** Truncate to `max` with a deterministic 6-hex tail when over. The slice is
 *  right-trimmed of `_` so the joint never forms a `__` run (parseability). */
export function capMcpNameSegment(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max - 7).replace(/_+$/, '')}_${sha6(value)}`
}

export function pluginMcpWireName(pluginId: string, serverName: string): string {
  const raw = `plugin_${segment(pluginId) || 'plugin'}_${segment(serverName) || 'server'}`
  return capMcpNameSegment(raw.replace(/_{2,}/g, '_'), 40)
}

export function pluginIdFromInstanceId(instanceId: string): string | null {
  const match = /^plugin:\/\/[^/]+\/([^@#/]+)@/.exec(instanceId)
  return match?.[1] ?? null
}
```

- [ ] **Step 4: Rewrite the resolver's `byMcp` branch (`resolver.ts:2268-2319`)**

Replace the whole `for (const [bucket, group] of byMcp)` body:

```ts
  for (const [bucket, group] of byMcp) {
    const [, bucketName] = bucket.split('\u0000')
    const logicalName = bucketName ?? group[0]!.summary.logicalName
    const scoped = group.filter(entry => entry.summary.origin !== 'plugin')
    const plugins = group.filter(entry => entry.summary.origin === 'plugin')

    // Scoped tier: one winner keeps the bare name; the rest are shadowed —
    // `mcp.md:449` "connects to it once, using the definition from the
    // highest-precedence source". UNCHANGED except the winner no longer
    // yields to plugin contention.
    if (scoped.length) {
      const sorted = [...scoped].sort((a, b) => {
        const pa = preference(a)
        const pb = preference(b)
        if (pa[0] !== pb[0]) return pb[0] - pa[0]
        if (pa[1] !== pb[1]) return pb[1] - pa[1]
        if (pa[2] !== pb[2]) return pb[2] - pa[2]
        return pa[3] < pb[3] ? -1 : pa[3] > pb[3] ? 1 : 0
      })
      const winner = sorted[0]!
      winner.summary.selectedAsUnqualifiedAlias = true
      setMcpWireName(winner, winner.summary.logicalName)
      for (const shadowed of sorted.slice(1)) {
        shadowed.summary.enabled = false
        shadowed.summary.unavailableReason = 'shadowed-by-mcp-precedence'
        setMcpWireName(shadowed, `${logicalName}-shadowed-${sha256Hex(shadowed.summary.key).slice(0, 10)}`)
      }
      if (sorted.length > 1) {
        diagnostics.push({
          severity: 'info',
          code: 'capability.collision.mcp-scope-precedence',
          message: `MCP server "${logicalName}" is defined in more than one scope; the highest-precedence definition is used`,
          capabilityKey: sorted[0]!.summary.key,
        })
      }
    }

    // Plugin tier: NEVER contends for the bare name (`mcp.md:365`). Stable
    // plugin-qualified wire name, contested or not.
    for (const entry of plugins) {
      const pluginId = (entry.summary.pluginInstanceId && pluginIdFromInstanceId(entry.summary.pluginInstanceId))
        || entry.summary.pluginKey || 'plugin'
      setMcpWireName(entry, pluginMcpWireName(pluginId, entry.summary.logicalName))
    }
    if (plugins.length && (scoped.length || plugins.length > 1)) {
      diagnostics.push({
        severity: 'info',
        code: 'capability.collision.mcp-wire-alias',
        message: `MCP name "${logicalName}" is also provided by a plugin; plugin servers use their qualified wire names`,
      })
    }
  }
```

Delete `qualifiedMcpWireName` (`:2330-2335`) — after this rewrite it has no callers (`rg -a qualifiedMcpWireName` must return only this definition before deleting). Import `pluginMcpWireName`/`pluginIdFromInstanceId` from `./mcp-wire-name.ts`. NOTE: shadowed scoped entries keep a qualified-but-inert name (`-shadowed-` infix) purely so catalog rows stay distinct; they are disabled and never reach the runtime view.

- [ ] **Step 5: Carry `logicalName` on the runtime server binding**

In `resolver.ts:1068-1099` (the `case 'mcp'` binding builder) add `logicalName: record.logicalName,` beside `wireName`. Add the field to the server type the binding satisfies (follow the type error: it is the `RuntimeMcpServer`-backing shape in `capabilities/types.ts` / `views.ts:144-234`; `views.ts:234` passes the binding through unchanged, so one type addition covers the view).

- [ ] **Step 6: Shared capped proxy-name builder in `mcp-pool.ts`**

Add beside `sanitizeMcpToolNameSegment` (`:617`):

```ts
/** `mcp__<slug>__<tool>`, capped at 64 chars for OpenAI-compatible endpoints
 *  by truncating the TOOL segment with a hash tail — separators survive so
 *  `tryParsePiDynamicMcpBindingName` still splits correctly. */
export function buildPoolProxyBaseName(slug: string, toolName: string): string {
  const prefix = `mcp__${slug}__`
  const toolSegment = sanitizeMcpToolNameSegment(toolName)
  if (prefix.length + toolSegment.length <= 64) return `${prefix}${toolSegment}`
  return `${prefix}${capMcpNameSegment(toolSegment, Math.max(8, 64 - prefix.length))}`
}
```

Import `capMcpNameSegment` from `../capabilities/mcp-wire-name.ts`. Use it at BOTH sites: the mint at `:997` becomes `const baseName = buildPoolProxyBaseName(slug, tool.name)`, and the lookup fallback at `:2574` becomes `return buildPoolProxyBaseName(slug, originalName)`. Mint and lookup MUST share the builder or capped names become unroutable.

- [ ] **Step 7: Update collision-policy tests**

`rg -a -l "mcp-wire-alias|qualifiedMcpWireName|only qualified wire names" packages/shared/src/capabilities/__tests__/` — update every pinned expectation to the new behavior: builtin/scoped winner keeps the bare name; plugin entries expect `plugin_<pluginId>_<serverName>`. Add one new case: builtin `t-tracker` + plugin server `t-tracker` → wire names `{'t-tracker', 'plugin_<id>_t-tracker'}`, builtin still enabled.

- [ ] **Step 8: Run tests + typecheck**

```bash
bun test packages/shared/src/capabilities/__tests__/mcp-wire-name.test.ts
bun test packages/shared/src/capabilities/__tests__/ 2>&1 | tail -20
bun test packages/shared/src/mcp/__tests__/ 2>&1 | tail -10
bun run typecheck:shared && bun run typecheck:all
```
Expected: PASS. `typecheck:all` because `views.ts`/`types.ts` shapes feed server-core and electron.

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/capabilities packages/shared/src/mcp/mcp-pool.ts
git commit -m "fix(capabilities): plugin MCP servers own stable plugin-qualified wire names"
```

---

### Task 3: Translate plugin-content MCP references to wire names

**Files:**
- Modify: `packages/shared/src/capabilities/mcp-wire-name.ts` (add `translatePluginMcpToolName`)
- Modify: `packages/shared/src/plugins/projection.ts` (hook `mcpTool` post-pass, after the capability loop `:199-252`)
- Modify: `packages/shared/src/capabilities/resolver.ts` (skill `skillAllowedTools` post-pass, after `applyCollisionPolicy(entries, diagnostics)` at `:2134`)
- Modify: `packages/shared/src/agent/pi-harness/runtime-agent-definition.ts:728-737` (agent `mcpServers:` alias rows)
- Test: extend `packages/shared/src/capabilities/__tests__/mcp-wire-name.test.ts`; extend the projection test file (`packages/shared/src/plugins/__tests__/runtime-projection.test.ts` or the file that pins `PluginHookProjectionRecord.mcpTool`)

**Interfaces:**
- Consumes: `pluginMcpWireName` (T2).
- Produces: `translatePluginMcpToolName(raw: string, pluginId: string, ownServerNames: ReadonlySet<string>): string` — rewrites `mcp__<ownServer>__<tool>` to `mcp__<wire>__<tool>`; passes through anything else (including the already-full `mcp__plugin_…` form, which equals the mint output).

- [ ] **Step 1: Failing tests**

```ts
// append to mcp-wire-name.test.ts
import { translatePluginMcpToolName } from '../mcp-wire-name.ts'

describe('translatePluginMcpToolName', () => {
  const own = new Set(['t-tracker', 'docs'])
  test('bare own-server reference is qualified', () => {
    expect(translatePluginMcpToolName('mcp__t-tracker__list', 'figma', own))
      .toBe('mcp__plugin_figma_t-tracker__list')
  })
  test('already-qualified and foreign references pass through', () => {
    expect(translatePluginMcpToolName('mcp__plugin_figma_docs__read', 'figma', own))
      .toBe('mcp__plugin_figma_docs__read')
    expect(translatePluginMcpToolName('mcp__dpJira__search', 'figma', own))
      .toBe('mcp__dpJira__search')
    expect(translatePluginMcpToolName('Bash', 'figma', own)).toBe('Bash')
  })
})
```

- [ ] **Step 2: Implement**

```ts
// mcp-wire-name.ts
export function translatePluginMcpToolName(
  raw: string,
  pluginId: string,
  ownServerNames: ReadonlySet<string>,
): string {
  const match = /^mcp__([A-Za-z0-9_-]+)__([A-Za-z0-9_-]+)$/.exec(raw)
  if (!match) return raw
  const [, serverRef, toolSegment] = match
  if (!ownServerNames.has(serverRef!)) return raw
  return `mcp__${pluginMcpWireName(pluginId, serverRef!)}__${toolSegment}`
}
```

(The greedy first group splits on the LAST `__`; wire names contain no `__` runs by T2's mint, so `mcp__plugin_figma_docs__read` parses `serverRef = plugin_figma_docs`, which is not in `ownServerNames` → pass-through. Exactly the desired behavior.)

- [ ] **Step 3: Hook `mcpTool` post-pass in `projection.ts`**

After the per-plugin capability loop has filled both `hooks` and `mcpServers` (the loop ending near `:252`), and before the return:

```ts
  // Plugin hooks reference their OWN bundled servers; qualify those references
  // to the wire names T2 mints (`mcp.md:363` — bare references never fire in
  // Claude either, so only legacy content needs this compatibility rewrite).
  const ownServersByPlugin = new Map<string, Set<string>>()
  for (const record of mcpServers) {
    const set = ownServersByPlugin.get(record.pluginInstanceId) ?? new Set<string>()
    set.add(record.serverName)
    ownServersByPlugin.set(record.pluginInstanceId, set)
  }
  for (const hook of hooks) {
    if (!hook.mcpTool) continue
    const own = ownServersByPlugin.get(hook.pluginInstanceId)
    const pluginId = pluginIdFromInstanceId(hook.pluginInstanceId)
    if (!own || !pluginId) continue
    hook.mcpTool = translatePluginMcpToolName(hook.mcpTool, pluginId, own)
  }
```

Adapt the field names to the actual projection record shapes in the file (`PluginMcpProjectionRecord.serverName` exists — `:369-371`; hook records carry `mcpTool` — `:423`; both carry a plugin instance id — verify the exact property name in their type declarations at the top of the file and use it). If hook records prove to be built as frozen/readonly, rebuild the array entries with spread instead of mutating.

- [ ] **Step 4: Skill `allowedTools` post-pass in `resolver.ts`**

Immediately after `applyCollisionPolicy(entries, diagnostics)` (`:2134`):

```ts
  // Plugin skills' `allowed-tools` may reference the plugin's own bundled
  // servers by bare name; qualify them to the wire names minted above.
  const ownMcpNamesByInstance = new Map<string, Set<string>>()
  for (const entry of entries) {
    if (entry.summary.origin !== 'plugin' || entry.summary.kind !== 'mcp' || !entry.summary.pluginInstanceId) continue
    const set = ownMcpNamesByInstance.get(entry.summary.pluginInstanceId) ?? new Set<string>()
    set.add(entry.summary.logicalName)
    ownMcpNamesByInstance.set(entry.summary.pluginInstanceId, set)
  }
  for (const entry of entries) {
    if (entry.summary.origin !== 'plugin' || !entry.summary.skillAllowedTools?.length || !entry.summary.pluginInstanceId) continue
    const own = ownMcpNamesByInstance.get(entry.summary.pluginInstanceId)
    const pluginId = pluginIdFromInstanceId(entry.summary.pluginInstanceId)
    if (!own?.size || !pluginId) continue
    entry.summary.skillAllowedTools = entry.summary.skillAllowedTools.map(pattern => {
      // Patterns may be bare (`mcp__db__*`) or exact (`mcp__db__query`).
      const wildcard = /^mcp__([A-Za-z0-9_-]+)__\*$/.exec(pattern)
      if (wildcard && own.has(wildcard[1]!)) return `mcp__${pluginMcpWireName(pluginId, wildcard[1]!)}__*`
      return translatePluginMcpToolName(pattern, pluginId, own)
    })
  }
```

- [ ] **Step 5: Agent `mcpServers:` aliases in `runtime-agent-definition.ts:728-737`**

Extend the reference table so a plugin agent naming its own server by bare name still resolves — but ONLY when the bare name is unambiguous among servers:

```ts
          [
            ...view.mcpServers.map(server => ({ key: server.key, logicalName: server.wireName, selectedAsUnqualifiedAlias: true })),
            // Bare-name aliases for plugin servers, only when unambiguous.
            ...view.mcpServers.flatMap(server => {
              if (!server.pluginInstanceId) return []
              const contenders = view.mcpServers.filter(other => other.logicalName === server.logicalName).length
              return contenders === 1 ? [{ key: server.key, logicalName: server.logicalName, selectedAsUnqualifiedAlias: false }] : []
            }),
            ...view.sources.flatMap(source => source.mcpWireName
              ? [{ key: source.key, logicalName: source.logicalName, selectedAsUnqualifiedAlias: true }]
              : []),
          ],
```

(`server.logicalName` exists after T2 Step 5.) Before wiring this, read `resolveReferences` (same file): if it filters candidates on `selectedAsUnqualifiedAlias === true`, pass `true` on the alias rows too — the `contenders === 1` guard above already makes that safe.

- [ ] **Step 6: Run + commit**

```bash
bun test packages/shared/src/capabilities/__tests__/mcp-wire-name.test.ts
bun test packages/shared/src/plugins/__tests__/ 2>&1 | tail -15
bun test packages/shared/src/agent/pi-harness/ 2>&1 | tail -10
bun run typecheck:shared
git add packages/shared/src/capabilities packages/shared/src/plugins/projection.ts packages/shared/src/agent/pi-harness/runtime-agent-definition.ts
git commit -m "fix(plugins): translate plugin-content MCP references to wire names"
```

---

### Task 4: An enabled builtin wins its identity over a plugin copy

**Files:**
- Modify: `packages/shared/src/capabilities/resolver.ts` (identity dedup pass, before `applyCollisionPolicy`)
- Modify: `packages/shared/src/capabilities/types.ts` (`unavailableReason` union + `'duplicates-builtin'`)
- Modify: `apps/electron/src/renderer/**` — the unavailable-reason display map (find with `rg -a "shadowed-by-mcp-precedence" apps/electron/src/renderer`)
- Modify: `packages/shared/src/i18n/locales/en.json`, `ru.json`
- Test: extend the resolver collision test file from T2 Step 7

**Interfaces:**
- Consumes: builtin records carry `mcpServerIdentity: { transport: 'stdio', command: ['dp','ai','mcp',<sub>] }` (`storage-runtime.ts:646-649`).
- Produces: a plugin MCP entry whose DECLARED stdio argv tail is `['ai','mcp',<sub>]` matching an ENABLED builtin's subcommand is force-disabled with `unavailableReason: 'duplicates-builtin'`.

- [ ] **Step 1: Failing test** — builtin `t-tracker` enabled + plugin server declaring `command: 'dp', args: ['ai','mcp','tracker']` → plugin entry `enabled === false`, `unavailableReason === 'duplicates-builtin'`, diagnostic `capability.dedup.builtin-identity` present; with the builtin DISABLED, the plugin entry stays enabled. Build the test on the same harness the T2 collision test uses.

- [ ] **Step 2: Implement the pass** (in `resolver.ts`, immediately BEFORE `applyCollisionPolicy(entries, diagnostics)`):

```ts
  // `mcp.md:457`: "Plugins and connectors match by endpoint" — our stdio
  // endpoint identity for the builtin set is the `dp ai mcp <sub>` argv tail.
  // An ENABLED builtin wins; the plugin copy is an activation-level duplicate.
  const enabledBuiltinSubcommands = new Map<string, string>()
  for (const entry of entries) {
    if (entry.summary.kind !== 'mcp' || entry.summary.origin !== 'builtin' || !entry.summary.enabled) continue
    const command = entry.summary.mcpServerIdentity?.command
    if (command && command[1] === 'ai' && command[2] === 'mcp' && command[3]) {
      enabledBuiltinSubcommands.set(command[3], entry.summary.logicalName)
    }
  }
  if (enabledBuiltinSubcommands.size) {
    for (const entry of entries) {
      if (entry.summary.origin !== 'plugin' || entry.summary.kind !== 'mcp' || !entry.summary.enabled) continue
      const definition = entry.runtimeBinding.kind === 'mcp' ? entry.runtimeBinding.server.definition : undefined
      if (definition?.type !== 'stdio' || !definition.args || definition.args.length < 3) continue
      const tail = definition.args.slice(-3)
      if (tail[0] !== 'ai' || tail[1] !== 'mcp') continue
      const builtinName = enabledBuiltinSubcommands.get(tail[2]!)
      if (!builtinName) continue
      entry.summary.enabled = false
      entry.summary.unavailableReason = 'duplicates-builtin'
      diagnostics.push({
        severity: 'info',
        code: 'capability.dedup.builtin-identity',
        message: `Plugin MCP server "${entry.summary.logicalName}" duplicates the enabled built-in "${builtinName}" and was not started`,
        capabilityKey: entry.summary.key,
      })
    }
  }
```

Check `mcpServerIdentity` is present on the summary type for builtin entries (it is set in `storage-runtime.ts:646`; if the resolver summary drops it, thread it through the same way `sourceEnabled` travels — follow the record→summary mapping at `resolver.ts:1820-1830`).

- [ ] **Step 3: UI string** — add the display-map entry where `shadowed-by-mcp-precedence` is rendered; i18n keys (both locales, alphabetical): `sourceInfo.unavailable.duplicatesBuiltin` = "Duplicates a built-in server; the built-in is used" / "Дублирует встроенный сервер; используется встроенный".

- [ ] **Step 4: Run + commit**

```bash
bun test packages/shared/src/capabilities/__tests__/ 2>&1 | tail -15
bun run lint:i18n:parity && bun run lint:i18n:sorted
bun run typecheck:all
git add packages/shared/src/capabilities packages/shared/src/i18n apps/electron/src/renderer
git commit -m "fix(mcp): an enabled builtin wins its identity over a plugin copy"
```

---

### Task 4b: Endpoint dedup for plugin pairs (`mcp.md:457`, second half)

**Files:**
- Modify: `packages/shared/src/capabilities/resolver.ts` (extend the T4 dedup pass)
- Modify: `packages/shared/src/capabilities/types.ts` (`unavailableReason` + `'duplicates-endpoint'`)
- Modify: the same renderer display map and both locale files as T4
- Test: extend the T4 test file

**Interfaces:**
- Consumes: T4's dedup pass location (runs in the same loop, after the builtin-identity rule).
- Produces: among entries sharing one declared endpoint identity, exactly one stays enabled; every disabled copy carries `unavailableReason: 'duplicates-endpoint'` and a diagnostic naming the winner.

**Endpoint identity — conservative by design (a false positive kills a working server; a false negative merely wastes a subprocess):**

```ts
/** Identity of a DECLARED server definition, or null when no safe identity exists.
 *  Compared BEFORE any runtime rewrite (`resolvePluginStdioExecutable` replaces
 *  plugin commands with the supervised host executable, so materialized values
 *  never compare equal). Any env/headers/credential difference → NOT a duplicate. */
function declaredEndpointIdentity(definition: SdkMcpServerConfig, envFingerprint: string): string | null {
  if (definition.type === 'http' || definition.type === 'sse') {
    if (!definition.url) return null
    const url = definition.url.trim().replace(/\/+$/, '').toLowerCase()
    return `${definition.type}:${url}:${envFingerprint}`
  }
  if (definition.type === 'stdio') {
    if (!definition.command) return null
    return `stdio:${definition.command} ${(definition.args ?? []).join(' ')}:${envFingerprint}`
  }
  return null
}
```

`envFingerprint` = stable JSON of the declared `env`/`headers` (sorted keys) — differing env means differing identity, so credentialed twins are never deduped. Winner rule: any non-plugin entry beats plugin entries; among plugins, lexically-smallest `summary.key` wins (stable across resolves).

- [ ] **Step 1: Failing tests** — (a) two plugins declaring the same `url` → one enabled, one `duplicates-endpoint`; (b) two plugins, same stdio `command+args` → dedup; (c) same argv but different `env` → BOTH stay enabled; (d) a scoped source and a plugin with one URL → the plugin copy is the disabled one.
- [ ] **Step 2: Implement** the pass beside T4's, iterating `entries` of `kind === 'mcp'` that remain enabled, grouping by `declaredEndpointIdentity` of the DECLARED definition (plugin entries: `runtimeBinding.server.definition`; source entries: skip when no declared definition is pinned — builtin entries are covered by T4 and excluded here).
- [ ] **Step 3: i18n + display map** — `sourceInfo.unavailable.duplicatesEndpoint`: "Duplicates another server's endpoint; only one copy runs" / "Дублирует endpoint другого сервера; работает одна копия".
- [ ] **Step 4: Run + commit**

```bash
bun test packages/shared/src/capabilities/__tests__/ 2>&1 | tail -15
bun run lint:i18n:parity && bun run lint:i18n:sorted
git add packages/shared/src/capabilities packages/shared/src/i18n apps/electron/src/renderer
git commit -m "fix(mcp): one server per declared endpoint — plugin duplicates stand down"
```

---

### Task 5: Permission-pattern alias for renamed plugin servers

**Files:**
- Modify: `packages/shared/src/agent/pi-agent.ts:1795-1810` (where `piAllowedTools` / `readablePolicy` capability identities are composed)
- Test: focused test beside the existing allowed-tools tests (`rg -a -l "piAllowedTools" packages/shared/src/agent/__tests__/`)

**Interfaces:**
- Consumes: `manifestSeed.mcpSources` (wire names) + `this.capabilityTurnRuntime.view.mcpServers` (`logicalName` from T2, `pluginInstanceId`).
- Produces: user-authored patterns `mcp__<logicalName>__*` (or exact) ALSO match the plugin wire name when exactly one active server carries that logical name. No expansion when ambiguous.

- [ ] **Step 1: Failing test** — configured `piAllowedTools: ['mcp__t-tracker__*']` with a single plugin server whose `logicalName === 't-tracker'`, wire `plugin_x_t-tracker` → the expanded allow-set admits `mcp__plugin_x_t-tracker__list`; with TWO servers sharing the logical name, no expansion happens.

- [ ] **Step 2: Implement** — where `allowedBindingNames`/pattern sets are built in `pi-agent.ts`, expand each `mcp__<name>__…` pattern:

```ts
    const expandMcpPatternAliases = (patterns: readonly string[]): string[] => {
      const view = this.capabilityTurnRuntime?.view
      if (!view) return [...patterns]
      const byLogical = new Map<string, string[]>()
      for (const server of view.mcpServers) {
        if (!server.pluginInstanceId) continue
        byLogical.set(server.logicalName, [...(byLogical.get(server.logicalName) ?? []), server.wireName])
      }
      const out = [...patterns]
      for (const pattern of patterns) {
        // Two accepted shapes. A single greedy regex mis-splits exact names
        // (`mcp__t-tracker__list` would capture `t-tracker__list`), so reuse
        // the manifest parser for the exact form.
        const wildcard = /^mcp__([A-Za-z0-9_-]+)__\*$/.exec(pattern)
        const exact = wildcard ? null : tryParsePiDynamicMcpBindingName(pattern)
        const name = wildcard?.[1] ?? exact?.wireName
        if (!name) continue
        const suffix = wildcard ? '__*' : `__${exact!.toolName}`
        const wires = byLogical.get(name)
        if (wires?.length === 1 && wires[0] !== name) out.push(`mcp__${wires[0]}${suffix}`)
      }
      return out
    }
```

Apply to `this.config.piAllowedTools` at its use site in `buildExecutionManifestForCurrentTurn` (and to the equivalent skill/deny pattern set ONLY if the T5 test proves it needed — do not widen scope speculatively). Document in the code that this is a one-release read-path migration alias.

- [ ] **Step 3: Run + commit**

```bash
bun test <the focused test file>
bun run typecheck:shared
git add packages/shared/src/agent
git commit -m "fix(permissions): alias legacy bare MCP patterns onto plugin wire names"
```

---

### Task 6: Three-runtime conformance + the t-tracker repro

**Files:**
- Test: `packages/shared/src/capabilities/__tests__/plugin-builtin-collision.integration.test.ts` (new — the incident repro at resolver+seed level)
- Test: extend `packages/shared/src/mcp/__tests__/` pool tests (proxy naming, 64-cap)
- Test: extend the pool-server test file (`rg -a -l "pool-server" packages/shared/src/mcp/__tests__/`) — Codex strip/re-route with qualified names
- Test: extend the claude-agent MCP options test (`rg -a -l "fullMcpServers|createSdkMcpServer" packages/shared/src/agent/__tests__/`)

**Steps:**

- [ ] **Step 1 (Pi, the incident):** integration test — capability inputs containing builtin `t-tracker` (enabled via `builtinDpMcpServers.enabled['t-tracker'] = true` record state) AND an installed plugin declaring MCP server `t-tracker`. Assert: resolved view has BOTH servers, wire names `t-tracker` and `plugin_<id>_t-tracker`; `createPiExecutionManifestSeed` + `finalizePiExecutionManifest` succeed; both tools present under distinct binding names. Then the degrade arm: hand-craft a proxy def `mcp__ghost__x` absent from the seed → dropped, manifest still builds (proves the incident state itself — stale pool vs new seed — now degrades).
- [ ] **Step 2 (Claude runtime):** pool-level test — register two servers under `t-tracker` / `plugin_x_t-tracker`; `getProxyName` returns `mcp__t-tracker__list` / `mcp__plugin_x_t-tracker__list`; both under 64 chars; assert the claude-agent option builder (or, if too heavy to instantiate, the pool contract it consumes: `getTools` + `getProxyName`) yields distinct entries for both servers.
- [ ] **Step 3 (Codex runtime):** pool-server bridge test — `tools/list` exposes `t-tracker__list` and `plugin_x_t-tracker__list` (strip `mcp__` only), `tools/call` with each routes to the right server; a long name round-trips through the 64-char cap (call with the capped name reaches the original tool — the cap happens at proxy-name MINT, so list and call agree by construction; assert equality).
- [ ] **Step 4:** run the affected suites, then commit:

```bash
bun test packages/shared/src/capabilities packages/shared/src/mcp packages/shared/src/agent/pi-harness 2>&1 | tail -15
git add packages/shared
git commit -m "test(runtimes): pin plugin-MCP naming across Pi, Claude, and Codex"
```

---

### Task 7: Close-out — docs, release notes, versions, regenerated registers

**Files:**
- Modify: root `package.json` + `apps/electron/package.json` — version → next minor from whatever both files carry at execution time (`1.24.0` if still on `1.23.x`; keep the two in lockstep and name the release-notes file after the bumped version)
- Create: `apps/electron/resources/release-notes/1.24.0.md` (append-only history; match the `1.0.2.md` style: `# Nessy Desktop 1.24.0`, a date line, `## FIXED` / `## IMPROVED`)
- Modify: `docs-site/content/sources/mcp-servers/overview.md` + `docs-site/content/ru/sources/mcp-servers/overview.md` (plugin wire-name rule, builtin identity dedup), plus the plugins page if it names MCP bundling
- Regenerate: `python3 scripts/build-parity-report.py > docs/superpowers/specs/2026-07-30-parity-report.md` and `python3 scripts/regenerate-deviation-register.py > docs/superpowers/specs/2026-07-29-deviation-register.md`

**Steps:**

- [ ] **Step 1:** docs + notes + versions (content: the three user-visible changes — stable plugin server names, chats survive name drift, duplicate-of-builtin plugins auto-disable with a visible reason).
- [ ] **Step 2:** final verification wave (the ONLY full wave in this plan):

```bash
rm -rf release
bun run typecheck:all
(cd apps/cli && bun run typecheck 2>/dev/null || bun x tsc --noEmit)
bun run lint
bun run lint:i18n:parity && bun run lint:i18n:sorted
bun run test:shared:all
bun test 2>&1 | tail -5
```

Expected: green, modulo rows already listed in `docs/superpowers/specs/2026-07-29-known-failing-tests.md` (compare against that register before recording any new failure; check nothing else is running).
- [ ] **Step 3:** regenerate the two generated registers (commands above), update this plan's Tracker, commit:

```bash
git add package.json apps/electron/package.json apps/electron/resources/release-notes docs-site docs/superpowers
git commit -m "chore(release): 1.24.0 — stable plugin MCP wire names"
```

- [ ] **Step 4 (reviewer-owned, optional live smoke):** the CDP scenario from the incident — dev app with builtin `t-tracker` enabled + a local fixture plugin bundling an MCP server named `t-tracker`; Sources shows both (plugin row under its qualified name), a chat turn completes. Precondition and driver per `scripts/cdp/README.md` (`NESSY_CDP_PORT=9223 bun run electron:dev`, bundles rebuilt first: `bun run electron:build:servers`).

---

## What this plan deliberately does NOT do

- No bundle rewriting, no `installed.json` migration — wire names are not persisted in either.
- No change to `mergeBuiltinDpMcpServers`' name/subcommand yield branches: scoped (user/project) config still beats the builtin by NAME (`mcp.md:449` order), and the fold keeps standing builtins down against non-plugin `.mcp.json` dp declarations. T4 only settles the builtin-vs-PLUGIN pair, one layer up.
- Endpoint dedup for plugin pairs is IN scope as T4b (owner decision 2026-08-10, second pass; corrected by two review-fix passes the same day — see the Tracker row and the Deviations log), with a deliberately conservative identity: declared values only (`env`/`headers`/`environmentDefaults`/`headersHelper`/`endpointAuth` in full/`credentialEnvironment`'s key set), any difference in any of them = not a duplicate. Plugin-vs-plugin only — scoped/native entries never participate. What stays out: fuzzy matching (path-resolved commands, URL query normalization beyond trailing-slash) and any dedup of credentialed twins — including two DIFFERENT plugins each holding their own OAuth/bearer grant, or their own MCPB credential-slot binding, to what looks like the same declared endpoint. The same-pluginId-from-two-marketplaces pair is handled by T4b when the two bundles declare identical endpoints; when their declared endpoints differ (different versions bundling different servers), both run under one wire name and the T1 seed dedupe picks the deterministic winner — that narrower residue stays accepted.
- No permission-DSL alias, and this is NOT Claude-runtime-only (final-branch review, Finding 2, corrected 2026-08-11): Claude SDK-side rules match the new names as-is, and so does every Pi permission surface — `permission-dsl.ts` (settings.json `permissions.allow/deny/ask`), `mode-manager.ts` globs (`deniedToolPatterns`/`allowedTools`/`disallowedTools`/`toolRules`), subagent frontmatter `disallowedTools` (`agents/definitions.ts`), and skill `disallowed-tools` (`runtime-skill-content.ts` — the resolver's translation pass touches only `skillAllowedTools`, a different field). T5's `piAllowedTools` alias in `pi-agent.ts` is a machine-derived child-session tool pool, not a user-authored permission rule, and does not cover any of these. For an ALLOW/ASK rule this is a fail-closed lapse (it just stops granting); for a DENY rule it is a WIDENING — a rule that used to block a plugin's tool silently stops blocking it once the server's wire name changes, and in `auto`/`dontAsk`/`bypassPermissions` the tool then runs unchallenged. Users re-save any manual rule against the server's new name (release note covers it, deny rules named explicitly).
- Tool names containing `__` (double underscore) inside the TOOL segment remain a pre-existing parse edge; T1's degrade turns it from fatal to a dropped tool, which is the bounded fix this plan owes.
- **No end-to-end plugin-compatibility audit across the three marketplaces and the three runtimes.** What this plan verified, and all it verified, is the NAMING axis: an MCP server's wire name, its activation (dedup), and the routing of its tools — pinned per runtime by T6 (Pi through the real seed + manifest, Claude through the pool contract `claude-agent.ts` consumes, Codex through the real `McpPoolServer` bridge). Whether a Codex plugin's hooks fire, whether a Claude plugin's LSP servers load, whether a marketplace extension's skills and commands behave — none of that is touched by this plan, so it is neither improved nor regressed here, and none of it was measured. A claim of the form "plugins from all three sources work correctly in all three runtimes" is NOT supported by this plan's evidence and needs its own live verification pass. Follow-up F1 below.
- **Two narrow paths where something now fails SILENTLY rather than loudly.** Both are disclosed rather than fixed, because each needs a design decision this plan did not take. (a) When T4b stands one plugin down as an endpoint duplicate, that plugin's OWN bundled hooks, skills and agents keep referencing its now-dead wire name and simply do not fire; the behaviour matches Claude's documented single-connection rule, but nothing tells the user which of their plugin's parts went inert. (b) `capMcpNameSegment` truncates but does not sanitize, and the `segment()` sanitizer runs only inside `pluginMcpWireName` — so a scoped `.mcp.json` server named with a space or a dot (`my server.v2`) keeps those characters in its wire name and pool slug, and `tryParsePiDynamicMcpBindingName`'s `[A-Za-z0-9_-]` regex then rejects every one of its proxy tool names. That defect predates this plan; what this plan changed is its VOLUME — before T1 it threw and was impossible to miss, now the tools are dropped with only a `debug` line. Follow-ups F2 and F3 below.

## Follow-ups this plan opens (not scheduled here)

- **F1 — live cross-marketplace, cross-runtime verification.** Install real bundles from all three sources (a marketplace extension plus a marketplace MCP server, a real Claude plugin, a real Codex plugin) into an isolated `NESSY_CONFIG_DIR`, then exercise each of the three runtimes against them and record what each one actually sees: resolved wire names, the tools reaching the model, the activation reasons on any row that stood down. This is the evidence the bullet above says this plan does not have.
- **F2 — say which parts of a stood-down plugin went inert.** A duplicate loser's hooks/skills/agents are silently dead. Minimum: name them in the capability diagnostic the dedup pass already emits, so the row's reason covers the whole blast radius rather than the server alone.
- **F4 — retire the V1 plugin path so V2 is the only one (owner request 2026-08-11).** F1's defect was not a coding slip, it was a two-paths problem: the hook `mcpTool` translation was wired into `resolvePluginProjectionPlan` (V1), while every real install resolves through `resolvePluginProjectionCandidates` (V2) — so the pass existed, was tested, was reviewed, and never ran. As long as both paths exist, that mistake stays available to the next feature. Measured surface as of 2026-08-11: V1 is `plugins/install-service.ts`, `plugins/store.ts`, `plugins/legacy-types.ts`, the V1 half of `plugins/projection.ts`, plus their users `plugin-settings.ts`, `project-config.ts`, `visibility-state.ts`, `hooks-automation.ts`, `hooks-runtime.ts`, `runtime-projection.ts` and `marketplace/registry-source.ts`. Three measured facts shape the work, and they make it smaller than "two parallel systems" suggests. (1) V1 does NOT leak outside the plugins package — `rg -a` finds no V1 registry/projection type in `server-core`, `agent`, `capabilities`, or the electron app, so the blast radius is one directory plus one marketplace file. (2) The V1 SEMANTICS are already retired: `store-v2.ts`'s own header states it is "the only production plugin store after the W10 cutover" and that the v1 store/projection/commit installer "remain private test-only compatibility modules and are not exported from the package runtime API" — and `plugins/index.ts` bears that out, exporting one type from `store.ts` and one function (`listRepositoryTags`) from `install-service.ts`, nothing else. (3) What V2 genuinely reuses is NOT V1's model but the format-agnostic ACQUISITION pipeline that happens to live in the V1-era file: `management-service-v2.ts` instantiates `PluginInstallService` for download, archive extraction (`tar`/`yauzl`), adapter normalization and semver resolution. So the job is extraction and deletion, not a rewrite: lift the acquisition pipeline into a V2-owned module, then delete the retired store/projection halves and the tests pinning them. Sequence worth following: inventory every V1 entry point and its V2 counterpart; move the borrowed install machinery under V2; convert the remaining V1 consumers one file at a time with their tests; delete `legacy-types.ts` last, since it is what proves nothing still speaks V1. Add a conformance test asserting the resolver pipeline has exactly one projection entry point, so a second path cannot reappear silently.
- **F3 — make a dropped tool visible, and stop minting unparseable names.** Two halves: emit a `capability.*` diagnostic alongside T1's `debug` line when a proxy tool is dropped, so a permanently unresolvable name is not invisible; and run the same `segment()` sanitizer over scoped/native wire names that plugin names already get, so a `.mcp.json` server with a space or a dot cannot mint a proxy name its own parser rejects. Sanitizing scoped names changes a user-visible wire name, which is why it is a follow-up with its own migration note rather than a quiet fix here.

## Tracker

| Task | Status | Commit | Note |
| --- | --- | --- | --- |
| T1 N2 degrade (manifest + pi-agent) | ✅ | `b963d44ee` | Done. `tryParsePiDynamicMcpBindingName` returns null instead of throwing; seed dedupe drops the lexically-larger duplicate wireName with a debug line; `resolveDynamicTool`/`finalizePiExecutionManifest` degrade an unresolved proxy tool to a drop instead of a fatal throw. Schema-version and provenance-capture throws stay fatal. |
| T2 N1 naming mint + resolver + pool cap | ✅ | `358931fe5` | Done. `mcp-wire-name.ts` mints `plugin_<pluginId>_<serverName>` (≤40 chars, hash-tail capped, no `__` runs); `applyCollisionPolicy`'s `byMcp` branch now qualifies EVERY plugin entry unconditionally (contested or not) while the scoped/builtin winner keeps the bare name untouched by plugin contention — the exact root cause of the `t-tracker` incident. `RuntimeMcpServer.logicalName` added (both native and plugin binding builders) for T3/T5. `buildPoolProxyBaseName` shared between the pool's mint and lookup sites. Fixed the same "uncontested plugin keeps its bare name" assumption in 3 files outside `capabilities/__tests__` that construct real plugin installs through the resolver (`capability-path-install-probe.test.ts`, `mcp-server-toggle-roundtrip.test.ts`, `unified-adapter-conformance.test.ts`) — those now compute expected wire names via the production mint rather than a hand-derived string. |
| T3 reference translation (hooks/skills/agents) | ✅ | `de0171f5e`, corrected `e272e98c6` | Done. `translatePluginMcpToolName(raw, pluginId, ownServerNames)` in `mcp-wire-name.ts` rewrites `mcp__<ownServer>__<tool>` to `mcp__<wire>__<tool>`; the greedy regex splits on the LAST `__`, so an already-qualified `mcp__plugin_x_y__tool` parses a `serverRef` never in `ownServerNames` and passes through. Three call sites wired to it: (1) `projection.ts`'s `resolvePluginProjectionPlan` rewrites a hook's `mcpTool` after the capability loop, keyed by `pluginInstanceId`; (2) `resolver.ts`'s `buildEntries` rewrites a plugin skill's `skillAllowedTools` immediately after `applyCollisionPolicy`, handling both the exact and `mcp__server__*` wildcard shapes; (3) `runtime-agent-definition.ts`'s `mcpServerKeys` reference table gains bare-name alias rows for plugin servers, added only when `contenders === 1` among `view.mcpServers` (an ambiguous bare name shared by two plugin instances stays unresolved) — `selectedAsUnqualifiedAlias: true` on those rows, since `resolveReferences` only matches a `logicalName` candidate when that flag is true. A plugin's OWN agent frontmatter never reaches this table (`sub-agents.md`'s plugin-subagent `mcpServers` exclusion, pre-existing), so the live case is a NATIVE agent naming a plugin's bundled server by its pre-T2 short name. **Correction (F1 live verification, 2026-08-10/11; fixed `e272e98c6`): (1) above described the shipped V1 hook translation, but that claim is only true for `projection.ts`'s `resolvePluginProjectionPlan` as shipped — the legacy V1 projection whose only production caller is `install-service.ts`, never read by the real capability pipeline.** The V2 hook-binding builder that production actually uses (`resolver.ts:1370`, inside `buildEntries`'s `case 'hook':` arm) copied `mcpTool` through verbatim, so a plugin hook's bare-name MCP reference reached a running session untranslated — measured live against the real installed `brand-voice` plugin (`hookRawDeclaredMcpTool === hookResolvedMcpTool === "mcp__figma__get_design_context"`, `translated: false`). Fixed by extending the SAME post-`applyCollisionPolicy` pass that already does (2) to also rewrite `runtimeBinding.hook.mcpTool`, in one loop, reusing the pass's existing `own`/`pluginId` lookups. (1)'s V1 pass was left in place, unmodified in behavior — `install-service.ts` still reads its return value — with a comment added at the site pointing at the resolver's pass as the load-bearing one. (3)'s agent-reference mechanism was checked too and found NOT to share this bug: it has exactly one implementation, already on the V2 view, with no V1 counterpart. Full accounting in the Deviations log below and in `.superpowers/sdd/f1-defect-fix-report.md`. |
| T4 builtin identity dedup | ✅ | `0d6f90364` | Done. New pass in `buildEntries`, immediately before `applyCollisionPolicy`: collects every ENABLED builtin's `dp ai mcp <sub>` subcommand from `mcpServerIdentity` (threaded onto `ResolvedCapability` — the summary type dropped it before this task, kept via `NativeCapabilitySourceRecord['mcpServerIdentity']` rather than a second declaration), then force-disables any ENABLED plugin `mcp` entry whose DECLARED stdio definition's argv tail is `['ai','mcp',<same sub>]`, setting `unavailableReason: 'duplicates-builtin'` and pushing a `capability.dedup.builtin-identity` diagnostic naming the winner. Matches on the argv TAIL only, never `command` (a plugin's command is rewritten to the supervised host executable downstream, after this pass runs, in `runtime-pool-servers.ts`/`SessionManager.ts` — never inside the resolver). A disabled builtin does not gate (checked by test). Activation-only: the plugin's own declared definition is never touched, matching bundle immutability. `sourceInfo.unavailable.duplicatesBuiltin` added to `CapabilityDetailTemplate`'s Metadata description, which is where `unavailableReason` actually renders today (raw, unmapped) — the brief's anchor `rg shadowed-by-mcp-precedence apps/electron/src/renderer` returns nothing on this branch; that reason has never had a display-map entry (`2026-07-29-deviation-unit-3.md`'s "no label for the new reason" finding), so there was no existing map to add beside. `types.ts` needed no change: `unavailableReason` is a free string everywhere (it also carries pre-worded sentences, e.g. the dp-not-installed diagnostic), never a closed union, and `mcpServerIdentity` already existed on the record type — only `ResolvedCapability` (in `resolver.ts`) needed the field. 4 resolver tests (enabled-builtin-disables, disabled-builtin-leaves-enabled, different-subcommand-untouched, name-only-collision-untouched) + 2 renderer tests (translated vs. raw-fallback), each verified RED before GREEN. |
| T4b endpoint dedup, plugin pairs | ✅ | `4ba1b8eb3` | Done (identity corrected by three same-day review-fix passes; this Note describes the shape as of fix pass 2 — see the Deviations log for what changed in each pass, and `.superpowers/sdd/task-4b-report.md`'s residual section for the current, complete list of declared fields the identity still does not fold, kept there rather than copied here since a copy drifts stale — fix pass 3 closed two of them, `forwardedEnvironmentSources`/`requiredEnvironmentNames`). New pass in `buildEntries`, beside T4's and still before `applyCollisionPolicy`: groups every ENABLED, PLUGIN-origin `kind: 'mcp'` entry by `declaredEndpointIdentity(entry)`, then within each group force-disables every member except the winner (the lexically-smallest `summary.key` wins — deterministic regardless of `entries` array order), setting `unavailableReason: 'duplicates-endpoint'` and pushing a `capability.dedup.endpoint-identity` diagnostic naming the winner. Never re-examines an entry T4 already disabled, since grouping reads `entry.summary.enabled` post-T4. The brief's illustrative `declaredEndpointIdentity(definition: SdkMcpServerConfig, envFingerprint)` doesn't typecheck against this repo's real shapes, so it was adapted, not copied: a PLUGIN entry's declared definition lives eagerly on `runtimeBinding.server.definition` (`SdkMcpServerConfigWithoutSecrets` — safe by construction, no raw env/header values), with the raw values one level up on the same server record (`descriptorEnvironment`/`descriptorHeaders`/`descriptorEnvironmentDefaults`/`descriptorHeadersHelper`/`endpointAuth`/`credentialEnvironment`, server-only, never in the safe view). SCOPED/native entries are excluded from this pass entirely, not merely outranked: a scoped entry's `runtimeBinding.server.definition` is an empty stdio placeholder at this stage ("materialized lazily by the runtime view" — resolver.ts's own comment), and its only other declared read, `summary.mcpServerIdentity`, structurally cannot carry env/headers (`native-sources.ts:mcpTransportIdentity` reads only `type`/`transport`/`url`/`command`/`args`; its type `ManagedMcpServerIdentityV1`, shared with the managed-MCP denylist, has no field for either) — so a scoped entry that DOES declare credentials could otherwise wrongly match a genuinely credential-free plugin twin at the same URL, the false-positive direction this pass exists to prevent. `declaredEnvFingerprint` sorts `env`/`headers`/`environmentDefaults` into arrays of `[key,value]` pairs before `JSON.stringify` (not a plain-object stringify, which V8 serializes in insertion order, not sorted order) and folds in `headersHelper` too — a single declared string at this layer (`RuntimeMcpServer.descriptorHeadersHelper`), so nothing to sort; a second review-fix pass (Fix 4, same day) additionally folds in `endpointAuth` — the oauth/bearer server's declared GLOBAL credential-slot identity (`pluginMcpCredentialId(authType, pluginKey, serverName)`), encoded via an explicit fixed-key object literal rather than a bare `JSON.stringify` of a value whose key order the function does not control — and `credentialEnvironment`'s key set, sorted, never its `configKey`/`credential` values (see the Deviations log for the finding that made this necessary: an OAuth/bearer plugin pair declares no literal env/headers at all, so without this fold two DIFFERENT plugins' credential slots fingerprinted identically). The stdio identity is `JSON.stringify([command, ...args])`, not a space-join — a command containing a space (a Windows `Program Files` path) could otherwise collide with a different (command, args) split that happens to space-join to the same string. `types.ts` needed no change, same as T4: `unavailableReason` stays a free string. `sourceInfo.unavailable.duplicatesEndpoint` added beside T4's entry in `CapabilityDetailTemplate`'s reason map. 12 resolver tests in `describe('T4b...')`: (a) two plugins same URL — smaller key wins; (b) two plugins same stdio argv — smaller key wins; (b2) a stdio command/args split that used to space-join identically now stays distinct; (c) same stdio argv, different `env` — both stay enabled; (c2) different `environmentDefaults` only — both stay enabled; (c3) different `headersHelper` only — both stay enabled; (c4) differing only in `endpointAuth` (different `pluginKey`, same URL/serverName, no literal env/headers/defaults/helper) — both stay enabled; (c5) identical in every folded field including `endpointAuth` — still deduped to exactly one (guards against an over-broad fix silently disabling the whole pass); (c6) differing only in `credentialEnvironment`'s key set — both stay enabled; (d)/(d, stdio variant) a scoped entry and a plugin at the same endpoint — scoped does not participate, both stay enabled; and a guard proving T4b never re-decides an entry T4 already disabled — plus 1 renderer test (translated vs. raw passthrough, mirroring T4's). Full RED/GREEN evidence for the original pass (a/b/c/d/d-stdio/guard), the first review-fix pass (b2/c2/c3 new, d/d-stdio re-verified RED against their corrected expectation), and the second review-fix pass (c4/c6 proven RED against the pre-fix identity, c5 proven pass-for-the-right-reason since two genuinely identical entries already deduped correctly even before this fix) is in `.superpowers/sdd/task-4b-report.md`. |
| T5 permission-pattern alias | ✅ | `56af61a07` | Done. New private `PiAgent.expandMcpPatternAliases(patterns)` mirrors a `piAllowedTools` pattern written against a plugin server's pre-T2 bare `logicalName` onto its current `plugin_<pluginId>_<serverName>` wire name — both the wildcard (`mcp__<name>__*`) and exact (`mcp__<name>__<tool>`, via `tryParsePiDynamicMcpBindingName` so a greedy single regex can't mis-capture the exact form) shapes, and ONLY when exactly one active PLUGIN server carries that logical name (`server.pluginInstanceId` gates entry into the `logicalName -> wireName[]` map; an ambiguous bare name shared by two plugin servers, or a bare name belonging to a non-plugin/builtin server, is left unexpanded — the safety arm that keeps a stale pattern from silently widening onto a server the user never named, or re-aliasing a name that already resolves). Applied at both `this.config.piAllowedTools` use sites inside `buildExecutionManifestForCurrentTurn` (the plain fallback `allowedBindingNames` assignment, and `configured`'s narrowing set inside the `readablePolicy` branch) — computed once into `expandedAllowedTools` and reused at both, per the brief's stated scope. Documented in the method's own doc comment as a one-release compatibility alias. `buildCurrentProxyToolDefinitions`'s OWN, separate `piAllowedTools` filter (`pi-agent.ts:1711-1716`, exact-match only, pre-existing) was deliberately left untouched — outside the brief's stated file/line scope — so a plugin MCP tool reached through the live mcpPool discovery path under a `piAllowedTools`-restricted child/subagent session is not covered by this alias; flagged as a known gap in the T5 report for a follow-up decision, not fixed here. 3 tests in new `packages/shared/src/agent/__tests__/pi-agent-mcp-pattern-alias.test.ts`: wildcard+exact expansion against a single plugin server, the combined negative arm (an ambiguous two-plugin-server bare name AND a non-plugin bare name both stay unexpanded, in one assertion), and an end-to-end `buildExecutionManifestForCurrentTurn` wiring proof (via a hand-built `seed.staticTools` capability identity, chosen so the assertion exercises exactly the brief's target block without depending on the separate mcpPool filter above) that a stale bare-name `piAllowedTools` entry admits the renamed tool. All three verified RED (method undefined; empty `manifest.tools`) before GREEN. |
| T6 three-runtime conformance + repro | ✅ | `a941f2c8e` | Done. Pure conformance tests, no production code touched. **Step 1** (new file, `capabilities/__tests__/plugin-builtin-collision.integration.test.ts`): drives the REAL resolver with capability inputs containing an enabled builtin `t-tracker` (native record, `scope: { kind: 'builtin' }`) plus an installed plugin declaring its own `t-tracker` MCP server (http transport — deliberately outside T4's builtin-identity dedup, which only fires on a declared `dp ai mcp <sub>` stdio argv tail, so both entries stay enabled and the test measures N1's naming, not T4's activation dedup), then feeds that SAME resolved view through the real `createPiExecutionManifestSeed` + `finalizePiExecutionManifest` — the one level of coverage neither `resolver.test.ts`'s "field-incident repro" (stops at wire names) nor the T1 `harness-manifest-degrade.test.ts` (hand-built fixture, not the real resolver) provides. Two tests: both servers resolve with wire names `t-tracker`/`plugin_p_t-tracker` and both mint into one manifest under distinct binding names; the degrade arm hands `finalizePiExecutionManifest` a third proxy def for a `ghost` server absent from the seed and asserts it's dropped while the two real tools survive — the stale-pool-vs-new-seed incident shape, post-T1, degrading instead of throwing. **Step 2** (extended `mcp/__tests__/proxy-tool-names.test.ts`): the brief's named location (`rg -a -l "fullMcpServers\|createSdkMcpServer" packages/shared/src/agent/__tests__/`) matches no file in this repo, and `createSourceProxyServers` (`agent/claude-agent.ts:593`) is confirmed module-private/unexported, reached only ~700 lines into a live turn-building method — instantiating `ClaudeAgent` was too heavy per the brief's own fallback, so the test asserts the pool contract that function consumes instead (`getTools` + `getProxyName`), reproducing its exact per-slug reconstruction (`toolSegment = proxyName.slice('mcp__<slug>__'.length)`, final name `mcp__<slug>__<toolSegment>`) for two servers registered under `t-tracker`/`plugin_x_t-tracker`, asserting the reconstructed name equals `getProxyName`'s own output (equality by construction) and that each routes its call to the correct underlying client. **Step 3** (same file): two tests against the real `McpPoolServer` over an in-memory transport (the "P2b" block's own wiring, duplicated locally since it's describe-scoped) — `tools/list` exposes `t-tracker__list`/`plugin_x_t-tracker__list` (`mcp__` stripped) and `tools/call` on each routes to its own server (proven via two independent call-recorder arrays, not just a non-error response); a 50-char tool name on `plugin_x_t-tracker` forces `buildPoolProxyBaseName`'s 64-char cap, and the test asserts `mcp__<name-from-tools/list>` literally equals `pool.getProxyName(...)`'s minted name (the "assert that equality" the brief asked for, not merely "some capped name exists"), then calls it and confirms the capped name reaches the original uncapped tool. Self-review before commit caught and fixed one tautological assertion (`new Set(['a','b']).size` on a literal array, not on the manifest's actual output) in the Step 1 degrade-arm test's twin — replaced with a count over `manifest.tools` that would actually go to 0 if the two wire names had collided upstream. **Step 4 gate**, all green: `bun test packages/shared/src/capabilities` (401 pass/0 fail, 23 files), `bun test packages/shared/src/mcp` (354 pass/0 fail, 25 files), `bun test packages/shared/src/agent/pi-harness` (485 pass/0 fail, 28 files), `bun run typecheck:shared` (exit 0). No production defect found. Full report: `.superpowers/sdd/task-6-report.md`. |
| T7 close-out 1.24.0 | ✅ | this commit | 1.24.0 in both package.json files; new `release-notes/1.24.0.md`; mcp-servers + plugins overview updated in both locales; parity report and deviation register regenerated; full verification wave recorded below |
| T8 post-close whole-branch review fix pass | ✅ | `c5292a488` | Done (2026-08-11, next-day review after 1.24.0 shipped). Fixed three findings from a final whole-branch review — see the Deviations log entry immediately below for the full accounting. Summary: (1) CRITICAL — T3's plugin bare-name-alias `contenders` count on the agent-reference path (`runtime-agent-definition.ts`) scanned only `view.mcpServers`, so a same-named user MCP SOURCE was invisible to it and a plugin could still win a native agent's bare `mcpServers:` reference; fixed by summing contenders across both tables. (2) IMPORTANT — the 1.24.0 release notes and this plan's own "deliberately does NOT do" section claimed permission rules keep matching (framed as Claude-runtime-only); neither is true on the Pi path, and a DENY rule silently loses its block — release notes and this plan corrected to say so plainly, deny rules named explicitly; no permission-DSL aliasing was added (out of scope, unchanged). (3) IMPORTANT — T5's `piAllowedTools` alias was computed but the subprocess init message (`pi-agent.ts:1621`) still sent the raw, un-expanded list, so the alias never reached the model for a restricted child/subagent session; and `expandMcpPatternAliases`'s ownership check was asymmetric, letting a bare name a builtin/scoped server or a source already owned outright still admit a same-named plugin's tool. Both fixed; full RED/GREEN evidence in `.superpowers/sdd/final-review-fix-report.md`. |
| F1 live cross-marketplace, cross-runtime verification | ✅ | `e272e98c6` (the defect it found) | RAN 2026-08-11 against real bundles, not fixtures: `figma` v2.0.13 from this machine's own marketplace install cache, `brand-voice` v1.1.0 from `github.com/anthropics/knowledge-work-plugins` (6 MCP servers), and `figma` from `github.com/openai/plugins` (Codex format, root `hooks.json`). Each walked the REAL production pipeline — `PluginManagementServiceV2.install()` → `resolvePluginProjectionCandidates` → `createCapabilityResolver().resolve()` → Pi's `createPiExecutionManifestSeed`/`finalizePiExecutionManifest`, the pool contract `claude-agent.ts` consumes, and the `McpPoolServer` Codex bridge over a real in-memory MCP transport. All three runtimes minted and routed the real bundles' names correctly (73 routing checks). **It found one real defect that three review rounds had missed** — a plugin hook's `mcpTool` was translated only on the retired V1 projection path, so it never ran for an actual install; fixed in `e272e98c6` with a test that goes through V2. Evidence: `.superpowers/sdd/f1-live-verification-report.md`. NOT covered and still open: any live MCP network call (every server in these bundles is OAuth-gated), two different marketplaces serving one plugin name at once, and a live model turn actually invoking a tool. |
| F2 name the inert parts of a stood-down plugin | ✅ | `a3b89d827` | EXECUTED as task G1 of `docs/superpowers/plans/2026-08-11-mcp-followups-f2-f4.md` — see that plan's tracker for the full accounting. Both dedup diagnostics (`capability.dedup.builtin-identity`, `capability.dedup.endpoint-identity`) now carry `safeArgs.inertComponents`: the stood-down plugin's OWN hooks and skills that referenced the server, as sorted `hook:<name>` / `skill:<name>` strings, surfaced in the reason text on the server's capability detail page (`CapabilityDetailTemplate.tsx:183`), which its row in the MCP servers panel opens — the row itself does not render that text. Residual, deliberate: AGENTS are not covered — a plugin agent's `mcpServers:` list resolves later in `runtime-agent-definition.ts` and never rides the capability summary, so reaching it would need new plumbing that task did not add. |
| F3 make a dropped tool visible, stop minting unparseable names | ✅ | `a2051dcb3` + fix `85e132920` | EXECUTED as task G2 of `docs/superpowers/plans/2026-08-11-mcp-followups-f2-f4.md` — see that plan's tracker and Deviations log. (b) closed at the root: `sanitizeMcpNameSegment` is exported from `mcp-wire-name.ts` and applied sanitize-THEN-cap at all three `applyCollisionPolicy` `byMcp` mint sites, so a scoped `my server.v2` now mints `my_server_v2`, and a name with NO usable character (entirely Cyrillic) mints a stable `server-<hash>` instead of an unusable empty one. (a) was answered ONE LAYER UP rather than at T1's degrade site: the new `capability.mcp.unusable-wire-name` warning (`diagnoseUnusableMcpWireNames`) names the SERVER once when its wire name cannot form parseable tool names, which is the condition that made the drops permanent. Residual, named rather than claimed: `harness-manifest.ts`'s per-drop degrade still logs only `debug` (`harness-manifest.ts:405`) — a transient stale-pool drop is still not user-visible; only the permanent unusable-name cause is. Migration consequence (a moved wire name breaks a permission rule naming the old raw string) is in that plan's Deviations log and shipped in 1.25.0's release notes. |
| F4 retire the V1 plugin path (V2 only) | ✅ | `de1bdfb1c` (move) + `74400bdb8` + fix `add6c9697` (delete) | EXECUTED as tasks G3 and G4 of `docs/superpowers/plans/2026-08-11-mcp-followups-f2-f4.md` — see that plan's tracker and its owner decisions D1–D3. G3 lifted the format-agnostic acquisition pipeline into a V2-owned `plugins/acquisition.ts` and re-pointed `management-service-v2.ts`, `index.ts` and `marketplace/registry-source.ts`, leaving `install-service.ts` with no production importer. G4 deleted `install-service.ts`, `projection.ts` and `legacy-types.ts`, plus two production-dead modules the graph map surfaced (`runtime-projection.ts`, `visibility-state.ts`) and the V1 halves of `hooks-runtime.ts` / `hooks-automation.ts` — 47 files, −5 679 lines — and added `one-projection-entry-point.test.ts`, which pins `resolvePluginProjectionCandidates` as the only projection entry point so a second path cannot reappear silently. `store.ts` survived as `marketplace-registry-store.ts` (marketplaces.json is live) and `hooks-runtime.ts`'s types as `hook-events.ts`; both renames fell under git's default 50 % follow threshold, so the recovery incantations are recorded in D1. |

## Deviations / decisions log

- 2026-08-10 — plan authored from the field incident (`must resolve exactly once: t-tracker`); owner chose A′ + B + identity dedup over Codex-style single-winner suppression (chat).
- Category: `claude-parity (mcp.md plugin server scoped names)` — the resolver previously deviated from the `mcp.md:365` rule it cites; this plan closes that deviation.
- Category: `product-fix (plugin MCP wire-name stability)` — degrade layer and identity dedup are Nessy-specific hardening beyond the Claude contract.
- 2026-08-10 — T2 review fix: the 64-char proxy-name cap this plan promised was not actually guaranteed. `buildPoolProxyBaseName` truncated only the TOOL segment with a floor of 8 chars; once a scoped/native wire name (uncapped `winner.summary.logicalName`, verbatim) exceeded ~49 chars, the budget for the tool segment went negative, the floor won, and the full proxy name exceeded 64. Considered capping the SLUG inside `buildPoolProxyBaseName` instead — rejected, because the Pi execution-manifest seed captures wire names from the same mint the pool consumes; a pool-local truncation would desync the seed's wire name from the pool's connection key/slug, and tools would silently vanish (the exact "seed and pool disagree" shape of the original field incident, one layer further in). Fixed by capping EVERY wire name assigned in `applyCollisionPolicy`'s `byMcp` branch — the scoped/builtin winner, the shadowed-entry name, and the plugin-minted name — at the MINT via `capMcpNameSegment(name, 40)`, so the cap propagates unchanged through the seed, the pool key, and the materialized server map. The plugin path's outer cap is a proven no-op (`pluginMcpWireName` already caps its own output at 40) applied only for one uniform invariant across all three sites. Added a positive control pinning every `BUILTIN_DP_MCP_SERVERS` name at ≤ 40 chars, so the mint's cap can never rename a built-in (a renamed builtin's wire name diverging from `materializeBuiltinDpMcpServers`' raw pool key is exactly the original incident).
- 2026-08-10 — T4b review fix: the shipped identity folded only `env`/`headers` into its credential fingerprint, per the brief's literal wording — T4b's own tracker note already flagged this, naming `descriptorEnvironmentDefaults` and the `descriptorHeadersHelper` shell-command string as considered-but-excluded "in case a reviewer wants either folded in." A reviewer took up that flag and found the omission too coarse: leaving a field out of an equality fingerprint makes MORE pairs compare equal, which is the dangerous direction for a deliberately conservative dedup pass (a false positive silently kills a working server; a false negative only wastes a subprocess). Both fields reach real runtime behavior — `descriptorEnvironmentDefaults` is merged into the spawn environment by `materializeMcpDescriptorEnvironment` (`mcp/server-config-values.ts`), and `descriptorHeadersHelper` is the declared dynamic-header shell command run by `resolveMcpDynamicHeaders` (`mcp/headers-helper.ts`) — so both are first-class per-server credential mechanisms, not values safe to skip. `declaredEnvFingerprint` now folds in all four declared fields (`env`, `headers`, `environmentDefaults`, `headersHelper`), with the same sorted-`[key,value]`-pairs treatment for every `Record<string,string>` field and the bare string folded in directly for `headersHelper` (nothing to sort in a single string; cwd/pluginRoot are resolved later by the runtime materializer and never reach this record). Separately hardened the stdio identity, unprompted by the brief but free: the old `stdio:${command} ${args.join(' ')}` space-join let a command containing a space (a Windows `Program Files` path) collide with an unrelated (command, args) split that happens to space-join to the same string; replaced with `stdio:${JSON.stringify([command, ...args])}`, unchanged for ordinary configs. Also investigated, per the reviewer's suspicion, whether the SCOPED/native side of `declaredEndpointIdentity` could be widened the same way: `summary.mcpServerIdentity`'s type (`ManagedMcpServerIdentityV1`) has no field for `env`/`headers` at all, and its sole producer (`native-sources.ts:mcpTransportIdentity`) reads only `type`/`transport`/`url`/`command`/`args` — by design, since the same type is shared with the managed-MCP denylist's `serverUrl`/`serverCommand` matching and was never meant to carry secrets. That means a scoped entry that DOES declare env/headers always fingerprinted as "declares nothing," so it could wrongly match a genuinely credential-free plugin twin at the same URL — exactly the false-positive direction this pass exists to prevent, and worse than the two missing fields above because it could disable a plugin with NO declared credentials at all, not just under-distinguish two that both have some. No other field pinned on a scoped entry proves it declares nothing either, so rather than widen `ManagedMcpServerIdentityV1` (shared, security-sensitive, out of this fix's scope) or guess, scoped/native entries are now excluded from T4b entirely — the pass covers plugin-vs-plugin only, which matches its own title (`describe('T4b: endpoint dedup for plugin pairs ...')`). 3 new tests (a stdio split that used to space-join identically; differing only in `environmentDefaults`; differing only in `headersHelper` — each proven RED, i.e. one entry wrongly disabled, against the pre-fix code) plus the existing scoped-vs-plugin tests (d, and its stdio variant) adapted to the corrected expectation (both stay enabled) and re-verified RED against pre-fix code before GREEN. `bun test packages/shared/src/capabilities/__tests__/`, `bun run typecheck:shared`, and `bun run typecheck:all` all green after the fix; full transcripts in `.superpowers/sdd/task-4b-report.md`.
- 2026-08-10 — T4b review fix 2 (endpointAuth): a second reviewer read the fix-1 fingerprint and found it still incomplete — `declaredEnvFingerprint` folded `env`/`headers`/`environmentDefaults`/`headersHelper`, but `RuntimeMcpServer.endpointAuth` (the oauth/bearer server's declared GLOBAL credential-slot identity, `pluginMcpCredentialId(authType, pluginKey, serverName)` in `plugins/mcp-credentials.ts`) was never read, and neither was `RuntimeMcpServer.credentialEnvironment` (the MCPB named credential-slot bindings). Concrete false positive: an oauth/bearer server declares NO literal env/headers/defaults/helper at all — the secret lives entirely in the credential-store slot — so two DIFFERENT plugins (different `pluginKey`, e.g. two marketplace publishers each bundling a connector to the same well-known third-party API) declaring `{ transport: 'http', url: <same>, authType: 'oauth' }` and nothing else used to fingerprint identically and get deduped, silently merging two different users' OAuth grants into one server; the smaller `credentialEnvironment` instance is the same root cause for MCPB-style credentials. Fixed by widening `declaredEnvFingerprint` to 6 parameters: `endpointAuth` is folded in FULL via an explicit fixed-key object literal (`authType`/`pluginKey`/`serverName`/`oauthResource`/`clientId`, the last two normalized to `null` when absent) rather than a bare `JSON.stringify(endpointAuth)`, so the fingerprint's key order is controlled by this function regardless of how the field was constructed upstream; `credentialEnvironment` is folded as its SORTED KEY SET only — `configKey` and the `RuntimeCredentialBinding` pointer are never read into the fingerprint, so no credential-store reference or value can reach a diagnostic, a log line, or a test fixture through this path. Investigated whether `RuntimeMcpServer.credential` (singular — the OTHER, generic credential-binding field, populated via `inputs.credentialRefFor`) is an independent residual gap: it is not — `server-core/src/bootstrap/storage-runtime.ts:952-960` is the only production site that ever sets it for a plugin MCP candidate, and it does so ONLY for the same `authType`-gated case `endpointAuth` already covers, deriving the same ref from the identical `(authType, pluginKey, serverName)` triple, so its information content is a strict subset of `endpointAuth` once folded. Also corrected both helpers' doc comments, which had claimed the identity folds "every declared credential-bearing field" — an unqualified claim the fix's own disclosed residual (kept current in `.superpowers/sdd/task-4b-report.md`'s residual section rather than re-enumerated here, since a copy drifts stale — confirmed 2026-08-10, when fix pass 3 closed two of the fields disclosed there, `forwardedEnvironmentSources` and `requiredEnvironmentNames`, by folding both into the fingerprint) shows was never quite true; both comments now name the closed, exact list instead. 3 new tests beside (c)/(c2)/(c3): (c4) two plugins, same URL/serverName, no literal env/headers/defaults/helper, differing only in `endpointAuth.pluginKey` — both stay enabled (proven RED against the pre-fix identity); (c5) identical in every folded field including `endpointAuth` — still deduped to exactly one (already passed pre-fix too, same as the original (c)/(c2)/(c3) pattern — proving the widened fold did not disable the pass, not proving a regression fix); (c6) two plugins, same URL/serverName, no `endpointAuth`, differing only in `credentialEnvironment`'s key set — both stay enabled (proven RED against the pre-fix identity). `bun test packages/shared/src/capabilities/__tests__/`, `bun run typecheck:shared`, and `bun run typecheck:all` all green after the fix; full transcripts and the disclosed residual-field list are in `.superpowers/sdd/task-4b-report.md`.
- 2026-08-11 — T8, post-close whole-branch review, three findings fixed:
  - **Finding 1 (CRITICAL)**: T3's agent-reference bare-name alias (`runtime-agent-definition.ts:734-750`) counted contenders for the `contenders === 1` unambiguity guard from `view.mcpServers` only. A user-created MCP SOURCE lives in `view.sources`, invisible to that count, so a plugin bundling a server with the same bare name as an EXISTING SOURCE could still add an alias row — inserted ahead of the source's own row — and `resolveReferences` returns the first match, handing a native agent's `mcpServers: [name]` reference to the plugin instead of the user's source. Direct contradiction of the plan's headline promise. Fixed by summing contenders across both `view.mcpServers` and `view.sources` (`source.mcpWireName && source.logicalName === server.logicalName`). New test in `runtime-agent-definition.test.ts` (RED confirmed: resolved to the plugin's key before the fix, the source's key after).
  - **Finding 2 (IMPORTANT)**: the 1.24.0 release notes claimed "permission rules written against a plugin server's old short name keep matching for this release" — false. The only alias (`PiAgent.expandMcpPatternAliases`) covers a machine-derived child-session tool pool (`piAllowedTools`, fed from `SessionManager.ts`'s `managed.piChildRestrictions.tools`), never a user-authored permission rule; confirmed by direct grep that `permission-dsl.ts`, `mode-manager.ts`, `agents/definitions.ts`, and `runtime-skill-content.ts` never consume either alias helper. For an allow/ask rule this is a fail-closed lapse; for a DENY rule it is a WIDENING — a blocked plugin tool becomes callable again, unchallenged in `auto`/`dontAsk`/`bypassPermissions`. This plan's own "What this plan deliberately does NOT do" section compounded the error by framing the gap as Claude-runtime-only. Both corrected: the release-notes bullet now says permission rules are NOT migrated, names allow/ask and deny separately with their distinct failure modes, and a new bullet documents the (separately introduced) 40-char cap on scoped/user-configured wire names (`resolver.ts:2410`) as an additional trigger for the same rewrite; this plan's "deliberately does NOT do" bullet now names every un-aliased Pi permission surface and states this is not Claude-runtime-only. No permission-DSL aliasing was added — out of scope per the review brief, unchanged. Docs-site (`sources/mcp-servers/overview.md` + `ru/` twin, `plugins/overview.md` + `ru/` twin) checked and found NOT to repeat the false claim — no edit made there.
  - **Finding 3 (IMPORTANT)**: two bugs in the T5 alias. (a) `pi-agent.ts:1621` sent the RAW `piAllowedTools` list as the subprocess init message's `allowedToolNames` — `resolvePiAllowedBindingNames` (pi-agent-server) matches by exact presented-name equality, so the host-computed alias never reached the subprocess's own tool ceiling for a restricted child/subagent session; fixed by expanding at that call site too. (b) `expandMcpPatternAliases`'s `byLogical` map was built from plugin servers only, so a bare name a builtin/scoped server or a source already owned outright still got looked up and, if a same-named plugin also existed, admitted that plugin's tool — a widening on a name that already resolved correctly. Fixed with an `ownedByNonPlugin` set (non-plugin `mcpServers` wireNames + source `mcpWireName`s) gating the expansion. Doc comment corrected: patterns are not user-authored (only production setter: `SessionManager.ts`'s `managed.piChildRestrictions.tools`, re-derived from the live manifest at spawn — a persisted child/fork session resumed after the T2 rename is the live case). 3 new tests in `pi-agent-mcp-pattern-alias.test.ts`: the init-message expansion (drives the real `spawnSubprocess`, mocking only process/stream edges, asserts on the literal `type: 'init'` message — not on an internal call), and two ownership-guard negatives (builtin-owned, source-owned) plus a positive control proving the alias still fires for a genuinely unowned name. All three verified RED before GREEN.
  - Gate: `bun test packages/shared/src/agent/pi-harness/` (486/0), `bun test packages/shared/src/agent/__tests__/pi-agent-mcp-pattern-alias.test.ts` (10/0), `bun test packages/shared/src/capabilities/__tests__/` (391/0), `bun test packages/shared/src/agent/__tests__/` full directory as an extra affected-package check (1612/0, 2 pre-existing skips), `bun run typecheck:shared` and `bun run typecheck:all` both exit 0. No locale file touched, i18n gates not run. Full RED/GREEN transcripts and per-finding detail: `.superpowers/sdd/final-review-fix-report.md`. Single commit `c5292a488` (`fix(mcp): a plugin can never claim a name a source or builtin already owns`); this Tracker/Deviations update is the accepted small follow-up commit.
- 2026-08-11 — F1 defect fix: T3's hook `mcpTool` translation was wired to the wrong projection path. `.superpowers/sdd/f1-live-verification-report.md`'s supplementary hook probe measured a real installed plugin's hook (`brand-voice`, `mcpTool: "mcp__figma__get_design_context"`) resolving with `hookRawDeclaredMcpTool === hookResolvedMcpTool` (`translated: false`) even though its `figma` server was already minted to `plugin_brand-voice_figma`. Root cause: there are TWO plugin-capability projection paths in this repo, and T3 only translated hooks on one of them. **V1** — `packages/shared/src/plugins/projection.ts`'s `resolvePluginProjectionPlan`, operating on the legacy `PluginInstalledRegistry`/`PluginStore` types, whose only production caller is `packages/shared/src/plugins/install-service.ts:449` (one method's return value, read by nothing else). **V2** — `packages/server-core/src/bootstrap/storage-runtime.ts:885` (`resolvePluginProjectionCandidates`) feeding `packages/shared/src/capabilities/resolver.ts`'s `createCapabilityResolver`, the real capability pipeline every runtime (Pi, Claude, Codex) actually consumes. T3 added the hook translation to V1 only (`projection.ts:263`, correctly implemented) and left V2's hook-binding builder (`resolver.ts:1370`, inside `buildEntries`'s `case 'hook':` arm) copying `runtimeDefinition.hook.mcpTool` verbatim — no translation at all on the path installs actually take. The fix belongs in the resolver, not in `projection.ts`, because the resolver is where T3's OWN skill translation already lives (the post-`applyCollisionPolicy` pass a few hundred lines below the hook-binding builder) and where every other T2/T3/T4/T4b naming decision in this plan is made — `projection.ts`'s V1 pass was never the naming authority, only a legacy compatibility surface `install-service.ts` still reads. Fixed by extending the SAME resolver post-pass that rewrites `skillAllowedTools` to also rewrite `entry.runtimeBinding.hook.mcpTool` for `kind === 'hook'` entries, in one loop, reusing the pass's existing `ownMcpNamesByInstance`/`pluginIdFromInstanceId` lookups (both branches now share one leading guard: `origin === 'plugin' && pluginInstanceId` present, `own.size` and `pluginId` resolved); the skill branch's own behavior is unchanged byte-for-byte (same map/regex/translate calls, same entries, same order — proven by re-running the pre-existing T3 skill test unmodified after the fix). The V1 pass in `projection.ts` was deliberately NOT deleted (`install-service.ts` still calls it and reads its `hooks` array) — a one-line comment was added at the site instead, saying the translation that reaches a running hook is the resolver's, not this one. New test in `resolver.test.ts` drives the real V2 path (`pluginCandidate` fixtures → `createCapabilityResolver(...).resolve(...)` → `toAgentRuntime(...)`, the same shape the pre-existing T3 skill test already uses) rather than the V1 projection, so it cannot pass for the wrong reason the way a V1-projection test would have; RED confirmed the bare name (`mcp__t-tracker__list`) surviving unchanged before the fix, GREEN after, plus a negative arm (a builtin reference the plugin does not own passes through untouched). Checked whether the same wiring mistake repeats for the other two T3 reference types (skill `allowed-tools`, agent `mcpServers:`) by enumerating every non-test call site of `translatePluginMcpToolName`/`pluginMcpWireName`: it does not — `projection.ts` has no skill-allowed-tools or agent-mcpServers translation logic at all, so those two each have exactly one implementation and it was already on the V2 path from T3's original landing. Gate: `bun test packages/shared/src/capabilities/__tests__/` (392/0), `bun test packages/shared/src/plugins/__tests__/` (737/0, 1 pre-existing unrelated skip), `bun run typecheck:shared` and `bun run typecheck:all` both exit 0. Full RED/GREEN transcripts and the other-reference-type check: `.superpowers/sdd/f1-defect-fix-report.md`. Single commit `e272e98c6` (`fix(plugins): translate a hook's MCP tool reference on the path installs actually take`); this Tracker/Deviations update is the accepted small follow-up commit.
