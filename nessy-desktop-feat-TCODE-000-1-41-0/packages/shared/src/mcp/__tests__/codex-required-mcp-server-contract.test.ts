/**
 * P2.372 — the `required` MCP-server mark, from the plugin bundle that declares
 * it to the runtime that could act on it.
 *
 * ## What the row said, and what turned out to be true
 *
 * The row reads *"we never write the `required` key, so the contract cannot
 * engage"*, and treats the gap as codex-shaped: one key missing from
 * `[mcp_servers.session]` / `[mcp_servers.sources]` in the config this product
 * writes. That is true, and it is the smaller half. The larger half is one layer
 * up and lives HERE: an operator's `required` mark is imported from a plugin
 * bundle, carried through `capabilities/resolver.ts` into
 * `materializeRuntimePoolServers`, handed to `McpClientPool.sync` inside the
 * server config — and then read by NOTHING, on any of the three runtimes.
 *
 * Measured with the field declared beside it as the positive control:
 * `alwaysLoad` sits on the same three transport variants of
 * `agent/backend/types.ts` and has real readers on all three runtimes
 * (`claude-agent.ts`, `pi-agent.ts`, `deferred-mcp-tools.ts`, and
 * {@link McpClientPool.alwaysLoadProxyToolNames} here). `required` has none.
 *
 * ## The codex clause, and it is STRONG tier — measured, not read off a page
 *
 * `app-server.md`, section `#start-or-resume-a-thread`: *"If you mark an enabled
 * MCP server as `required` in config and that server fails to initialize,
 * `thread/start` and `thread/resume` fail instead of continuing without it."*
 *
 * A page alone is weak tier for codex — intent, not behaviour — so it was
 * settled against the SHIPPED binary
 * (`apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`,
 * SHA-256 `26e0c83c…a673b6b`, byte-identical to the `darwin-arm64`
 * `binarySha256` in `codex-protocol/manifest.json`, self-reporting `0.148.0`).
 * One MCP entry pointing at a path that does not exist, four runs:
 *
 * | config | `thread/start` | `thread/resume` |
 * | --- | --- | --- |
 * | broken server, no `required` | succeeds | succeeds |
 * | broken server, `required = true` | fails | fails |
 *
 * Failing verbatim: `error creating thread: Fatal error: Failed to initialize
 * session: required MCP servers failed to initialize: broken: No such file or
 * directory (os error 2)` — and the same sentence with `error resuming thread`
 * for the resume half. The two succeeding rows are the positive control on the
 * same rig, the resume pair running against one real rollout so that neither
 * verdict rests on a thread that never existed.
 *
 * So the clause is not a hypothesis: the runtime HAS the mechanism, and per the
 * native-first rule this is configuration we have not enabled, not construction.
 * What the runtime does NOT have is a soft form of it — the failure notification
 * `mcpServer/startupStatus/updated` carries `status: "failed"` and the error
 * text, and appears in this repo only inside `codex-protocol/schema`, i.e. no
 * product code listens to it. `mcpServerStatus/list` (the wire name is that, not
 * the `listMcpServerStatus` the triage note used — the generated TYPES are
 * spelled `ListMcpServerStatus…`) returns the failed server with `serverInfo:
 * null` and `tools: {}` and no failure reason at all.
 *
 * ## Per-runtime verdict for the mark itself
 *
 * - **codex** — native mechanism, measured working, NOT enabled by us.
 * - **claude / Pi** — no equivalent mechanism; a failed connect stays
 *   capability-local by construction.
 * - **host** — carries the mark and drops it, with no diagnostic anywhere the
 *   operator can see. The docblocks on `agent/backend/types.ts` and
 *   `plugins/types.ts` state the fail-soft posture to a developer reading the
 *   type; nothing states it to the person who wrote `required` into a bundle.
 *   So the residual difference is **silent**, which is the class this fork most
 *   often ships. Making it uniform (honour it everywhere) or honest (say so
 *   where the operator looks) is a product posture, stated here and left to the
 *   row that owns the surface rather than decided inside a test.
 *
 * These arms pin what is true today so that a change to any of it has to be
 * deliberate: the key still exists upstream, the mark still reaches the pool by
 * both transports, and nothing consults it yet.
 */

import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { McpClientPool } from '../mcp-pool.ts'
import { materializeRuntimePoolServers } from '../runtime-pool-servers.ts'
import type { CapabilityTurnRuntime } from '../../agent/backend/types.ts'

const SCHEMA_PATH = join(
  import.meta.dir, '..', '..', '..', '..',
  'codex-protocol', 'schema', 'config-schema.json',
)

const NO_BUILTIN_DP = { builtinDpMcpServers: false } as const

function rawMcpServerProperties(): Record<string, { type?: string; default?: unknown }> {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as {
    definitions?: Record<string, { properties?: Record<string, { type?: string; default?: unknown }> }>
  }
  const definition = schema.definitions?.RawMcpServerConfig
  if (!definition?.properties) throw new Error('config-schema.json has no RawMcpServerConfig properties')
  return definition.properties
}

function runtimeWith(view: Partial<CapabilityTurnRuntime['view']>): CapabilityTurnRuntime {
  return {
    view: {
      generation: 'g',
      sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [],
      apps: [], lspServers: [],
      ...view,
    },
    materializer: {
      assertActive: () => {},
      verifyPlugin: async () => {},
      resolvePath: async () => '/abs/path',
      readText: async () => '{}',
      resolveCredential: () => { throw new Error('credential-not-ready') },
    },
  } as unknown as CapabilityTurnRuntime
}

describe('the codex key this mark would be written as (P2.372)', () => {
  it('still declares `required` as a boolean on RawMcpServerConfig', () => {
    const properties = rawMcpServerProperties()
    // The positive control: if the probe were reading the wrong definition, or
    // an empty object, `command` would be missing too and every absence below
    // would be a dead zero rather than a measurement.
    expect(properties.command).toBeDefined()
    expect(properties.required).toEqual({ default: null, type: 'boolean' })
    // A key that cannot exist. Without it, "the schema has what we asked for"
    // would also be true of a probe that answered yes to everything.
    expect(properties.requiredd).toBeUndefined()
  })

  it('still declares the two timeout keys the triage named beside it', () => {
    const properties = rawMcpServerProperties()
    // `startup_timeout_ms` and `tool_timeout_sec` are the other two keys T2
    // found unwritten. They are pinned here rather than in a second file because
    // an upstream rename would arrive in the same commit as a rename of
    // `required`, and a reader chasing one should meet the others.
    //
    // P6.140 · `tool_timeout_sec` IS WRITTEN NOW: on `sources` for an operator
    // who set `NESSY_MCP_TOOL_TIMEOUT` (or its `MCP_TOOL_TIMEOUT` compat
    // spelling) explicitly, and ALWAYS on `session` at the UA12.24 card-window
    // floor (`CODEX_SESSION_TOOL_TIMEOUT_SEC` in the writer) — the projection,
    // its margin and the floor live in `CodexAgent.codexMcpToolTimeoutOption`
    // and `config-writer.ts`, pinned in
    // `agent/__tests__/codex-explicit-operator-ceilings.test.ts` and
    // `config-writer-session-tool-timeout.test.ts`. This pin stays
    // where it is: it is the SCHEMA half, and the writer's own nested guard
    // throws off the same property, so a rename must redden here first.
    //
    // P6.140 · the startup pair stays unwritten and that is a decision rather
    // than a leftover. P6.548 turned that sentence into a FAILING pin —
    // `codex-responses-adapter/src/__tests__/config-writer-mcp-startup-timeout.test.ts`
    // reddens the day a lane starts emitting either key — and CORRECTED the
    // reason against the shipped binary while doing it.
    //
    // The reason recorded here used to be "they bound codex's own spawn of
    // these two entries, a connect the host pool never makes". Measured
    // 2026-09-07 on `codex-app-server` (`codex-mcp/src/mcp/mod.rs:636`), the
    // pair bounds *"MCP client startup"* and the `initialize` *"handshaking with
    // MCP server"*, and it applies on BOTH transports — so it is half wrong:
    // `[mcp_servers.session]` is a stdio entry codex really does spawn itself.
    // What is true of both is that `NESSY_MCP_TIMEOUT` is a deadline about a
    // DIFFERENT connection (the host pool's own connect, one hop further out),
    // so there is nothing to project and a number here would be invented. The
    // full argument, and how to reverse it by measurement, is in that pin's
    // docblock.
    expect(properties.startup_timeout_ms?.type).toBe('integer')
    expect(properties.tool_timeout_sec?.type).toBe('number')
  })
})

describe('the mark reaches the pool by both transports (P2.372)', () => {
  // The stdio half is already pinned by `runtime-pool-servers.test.ts`, inside
  // the plugin-materialization arm. The remote half had no arm at all, and it is
  // the half a hosted MCP an operator marks essential travels on.
  it('carries a plugin-declared `required` into an http server config', async () => {
    const runtime = runtimeWith({
      mcpServers: [{
        key: 'k', wireName: 'gh',
        definition: { type: 'http', url: 'https://mcp.test/gh', required: true },
      }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
    })
    const out = await materializeRuntimePoolServers(runtime, {
      ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1',
    })
    expect(out.mergedMcpServers.gh).toEqual({ type: 'http', url: 'https://mcp.test/gh', required: true })
  })

  it('omits the key entirely when the bundle declared nothing, rather than defaulting it', async () => {
    // `required: false` and an absent key are different statements to codex —
    // its own default is null — so materialization must not manufacture one.
    const runtime = runtimeWith({
      mcpServers: [{
        key: 'k', wireName: 'gh', definition: { type: 'http', url: 'https://mcp.test/gh' },
      }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
    })
    const out = await materializeRuntimePoolServers(runtime, {
      ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1',
    })
    const materialized = out.mergedMcpServers.gh
    expect(materialized).toEqual({ type: 'http', url: 'https://mcp.test/gh' })
    expect(materialized && 'required' in materialized).toBe(false)
  })
})

describe('and nothing consults it yet (P2.372)', () => {
  it('exposes no required-aware surface, while its declared-beside sibling has one', () => {
    const members = new Set<string>()
    for (
      let prototype: object | null = McpClientPool.prototype;
      prototype && prototype !== Object.prototype;
      prototype = Object.getPrototypeOf(prototype) as object | null
    ) {
      for (const name of Object.getOwnPropertyNames(prototype)) members.add(name)
    }
    // The control that makes the list below mean something: `alwaysLoad` is
    // declared on the same three transport variants and DOES have a reader.
    expect(members.has('alwaysLoadProxyToolNames')).toBe(true)
    // Exactly one member matches the substring, and it is about a different
    // subject: `interactionRequiredProxyToolNames` reads a server's
    // `_meta["anthropic/requiresUserInteraction"]` so the permission gate can
    // prompt on every call. Server criticality has no member here at all. It is
    // asserted as a LIST rather than as empty because a substring match is not a
    // concept match — filtering it away silently is how an absence claim becomes
    // a claim about spelling.
    expect([...members].filter(name => name.toLowerCase().includes('required')).sort())
      .toEqual(['interactionRequiredProxyToolNames'])
  })
})

/**
 * P6.1066 — the drift guard on the one field that moved the premise.
 *
 * `base-agent.ts`'s {@link BaseAgent.mcpServerStatuses} records WHY codex keeps
 * the host-pool inventory instead of overriding it with its own, and one of the
 * two legs of that argument — *"no state enum"* — was true at `rust-v0.148.0`
 * and is false at `rust-v0.150.1`: `McpServerStatus` gained `runtimeStatus`.
 *
 * Driven on the shipped `0.150.1` darwin-arm64 binary against a CODEX_HOME with
 * one working stdio server and one whose command does not exist, in a single run
 * carrying its own positive and negative control: `mcpServerStatus/list` with no
 * `threadId` answered `runtimeStatus: null` for BOTH servers, and the same call
 * with the started thread's id answered `"failed"` for the broken one and
 * `"connected"` for the working one.
 *
 * The verdict survives on its other leg — codex's inventory of a Nessy session
 * is the two proxies `writeCodexConfig` emits, so an override would trade a
 * per-source list for two infrastructure rows — but the PREMISE is now pinned
 * here rather than restated in prose, because prose is what went stale. A lift
 * that removes the field, or changes its states, fails this and sends the next
 * reader to that docblock.
 */
describe('P6.1066 — `McpServerStatus.runtimeStatus`, the field that retired half the argument', () => {
  const schema = JSON.parse(readFileSync(
    join(import.meta.dir, '../../../../codex-protocol/schema/codex_app_server_protocol.v2.schemas.json'),
    'utf8',
  )) as { definitions: Record<string, Record<string, unknown>> }

  it('is declared on the list element, nullable, with the seven states measured', () => {
    const status = schema.definitions.McpServerStatus as { properties: Record<string, unknown> }
    // POSITIVE CONTROL: the definition was actually read. A miss would make
    // every absence below vacuous.
    expect(Object.keys(status.properties).sort()).toContain('name')
    const runtimeStatus = status.properties.runtimeStatus as { anyOf: Array<Record<string, string>> }
    expect(runtimeStatus.anyOf.map(member => member.$ref ?? member.type))
      .toEqual(['#/definitions/McpServerConnectionStatus', 'null'])
    expect((schema.definitions.McpServerConnectionStatus as { enum: string[] }).enum)
      .toEqual(['notStarted', 'starting', 'connected', 'authenticationRequired', 'failed', 'cancelled', 'disabled'])
  })

  it('still carries no failure REASON, which is the leg the verdict rests on', () => {
    // The half of the original argument that did NOT move: a state is not a
    // reason, and the reason channel stays `McpServerStatusUpdatedNotification`.
    const status = schema.definitions.McpServerStatus as { properties: Record<string, unknown> }
    expect(Object.keys(status.properties)).not.toContain('error')
    expect(Object.keys(status.properties)).not.toContain('failureReason')
    const notification = schema.definitions.McpServerStatusUpdatedNotification as {
      properties: Record<string, unknown>
    }
    expect(Object.keys(notification.properties).sort())
      .toEqual(['error', 'failureReason', 'name', 'status', 'threadId'])
  })
})
