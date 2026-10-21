/**
 * T5 (2026-08-20-cross-runtime-history-carry) — every declared per-runtime fact
 * on the shared / session-tools axes, asserted against the code that enforces it.
 *
 * Eleven sites hold per-runtime capability truth. Five derive from one another
 * (`ComposerCapabilities` → `resolveComposerCapabilities` →
 * `resolveManagedComposerCapabilities` → `filterAttachmentsForModelInput` →
 * `renormalizeForRuntime`) and need no drift test. The rest are independent
 * hand-maintained lists, and this file covers the ones reachable from
 * `packages/shared`; the renderer's two restatements (`runtimeForProviderType`,
 * the `runtime-switch-costs` rows) live in
 * `apps/electron/src/renderer/components/app-shell/input/__tests__/runtime-capability-drift.test.ts`
 * because the renderer is unreachable from this package.
 *
 * THE ONE RULE OF THIS FILE: every count and every membership is DERIVED AT TEST
 * TIME from the enforcement site — `getSessionToolNames(...)`, the exported
 * sets, the backend sources on disk — and never transcribed as a literal. (The
 * review pass that ordered this test reported 27 `visibility: 'pi-only'` hits
 * where the file has 19, because `grep -ac` counts lines and `grep -ao | wc -l`
 * counts occurrences. A drift test seeded from a hand-counted number is a drift
 * test with its own drift.) The single exception is the provider-type
 * vocabulary itself, which exists only as a TypeScript union — and since P2.124
 * it is not restated here either: both unions come from
 * `agent/backend/runtime-vocabulary.ts`, the one source, whose anchors are
 * exhaustiveness-checked BY THE COMPILER in both directions. Their drift fails
 * `bun run typecheck:shared` — note that `bun test` alone does not typecheck,
 * so the vocabulary anchors bind at the typecheck gate, not here.
 *
 * ## Two traps for a later, larger consolidation (out of scope here, recorded
 * ## so they are not rediscovered)
 *
 * (a) Any future consolidated per-runtime capability record must be keyed by
 *     `LlmProviderType`, NOT `AgentProvider`: `claude-runtime` and `anthropic`
 *     collapse onto one AgentProvider (`providerTypeToAgentProvider`) while
 *     having deliberately different capabilities — the exact bug
 *     `CLAUDE_RUNTIME_DEFAULTS` in `composer-capabilities.ts` exists to fix
 *     (gateway sessions must not inherit api.anthropic.com's image support or
 *     its full reasoning ladder).
 *
 * (b) A tri-state capability claim's UI rule cannot be "no claim hides the
 *     control": both of Nessy's existing no-claim readers deliberately fail
 *     OPEN, with recorded reasons — `runtimeDispatchesAgentDefinitions` and
 *     `runtimeRunsPluginMonitors` both answer `true` for an UNDEFINED
 *     provider, because a workspace-scoped capability read resolves before any
 *     session exists and "reporting a definite unavailability from an
 *     indefinite input" is the trap in the other direction
 *     (`runtime-agent-support.ts`, and `storage-runtime.ts` for the managed
 *     activation twin). The fail-open behaviour is asserted below so a
 *     consolidation that flips it fails loudly.
 */

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  LEGACY_TASK_TOOL_NAMES,
  SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK,
  SESSION_TOOLS_REQUIRING_HOST_CALLBACK,
  SESSION_TOOLS_WITHHELD_FOR_NATIVE_EQUIVALENT,
  areTaskToolsEnabled,
  getSessionRegistryToolNames,
  getSessionToolNames,
  isCronDisabled,
} from '@nessy-agent/session-tools-core'
import type { MessageRuntimeProvider } from '@nessy-agent/core/types'
import type { ModelProvider } from '../../config/models.ts'
import type { LlmConnection, LlmProviderType } from '../../config/llm-connections.ts'
import { NESTOR_CLI_BASE_PREFIX } from '../../auth/nestor.ts'
import { isNessyGatewayBaseUrl } from '../backend/internal/drivers/upstream-target.ts'
import { BACKEND_CAPABILITIES, providerTypeToAgentProvider } from '../backend/factory.ts'
import { PROVIDER_DEFAULTS, resolveComposerCapabilities } from '../backend/composer-capabilities.ts'
import { buildClaudeRuntimeAgentOptions } from '../claude-runtime-agents.ts'
import { buildCodexAgentRoles, writeCodexConfig } from '@nessy-agent/codex-responses-adapter/config-writer'
import {
  AGENT_PROVIDERS,
  LLM_PROVIDER_TYPES,
  nonRuntimeKeysOf,
  runtimesNotDecidedBy,
} from '../backend/runtime-vocabulary.ts'
import {
  AGENT_DEFINITION_DISPATCH,
  AGENT_DEFINITION_RUNTIMES,
  HOST_EDIT_TOOLING_RUNTIMES,
  HOST_EDIT_TOOLING_SUPPORT,
  MCP_CHANNEL_PUSH_RUNTIMES,
  MCP_CHANNEL_PUSH_SUPPORT,
  PLUGIN_HOOK_ACTION_KINDS,
  PLUGIN_HOOK_ACTION_RUNNERS,
  PLUGIN_LSP_RUNTIMES,
  PLUGIN_LSP_SUPPORT,
  PLUGIN_MONITOR_RUNTIMES,
  PLUGIN_MONITOR_SUPPORT,
  SESSION_BRANCHING_RUNTIMES,
  SESSION_BRANCHING_SUPPORT,
  WORKFLOW_DISPATCH_RUNTIMES,
  WORKFLOW_DISPATCH_SUPPORT,
  pluginHookActionRunnersFor,
  runtimeDispatchesAgentDefinitions,
  runtimeDispatchesWorkflows,
  runtimeProvisionsPluginLsp,
  runtimeReceivesMcpChannelPush,
  runtimeRunsHostEditTooling,
  runtimeRunsPluginMonitors,
} from '../runtime-agent-support.ts'
import { ANCHORED_PROVIDERS, RUNTIME_ANCHOR_SUPPORT } from '../../sessions/runtime-anchors.ts'

// ============================================================
// The vocabulary — IMPORTED, no longer restated here (P2.124).
//
// This block used to hold two `satisfies Record<union, true>` anchors, and its
// twin in the renderer held the same two again: four hand-written copies of the
// two runtime unions, in two files, kept in step by nothing. That is the shape
// P2.124 is about, reproduced inside the drift test written to catch it.
//
// Both now come from `agent/backend/runtime-vocabulary.ts`, which is the ONE
// source and declares no capability at all — only which runtimes exist. Its
// anchors are checked in BOTH directions (a missing member fails `satisfies`, an
// invented one fails an assignability constant), and both bind at
// `bun run typecheck:shared` rather than here, because `bun test` does not
// typecheck.
// ============================================================

const MODEL_PROVIDERS = AGENT_PROVIDERS as readonly ModelProvider[]

// ============================================================
// `MessageRuntimeProvider` ↔ `ModelProvider`
//
// `packages/core/src/types/message.ts` restates `ModelProvider` because the
// base type layer must not depend on `shared`, and its docblock says "The two
// unions must be kept in step by hand; a member added there belongs here too."
// This is the mechanical check behind that sentence: mutual assignability,
// enforced by the compiler. A member added to either union alone turns the
// constant's type into `never` and fails the typecheck gate.
// ============================================================

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

const messageRuntimeProviderRestatesModelProvider: MutuallyAssignable<
  MessageRuntimeProvider,
  ModelProvider
> = true

describe('MessageRuntimeProvider restates ModelProvider', () => {
  it('is the same vocabulary (compile-time; this run only proves the anchor exists)', () => {
    expect(messageRuntimeProviderRestatesModelProvider).toBe(true)
  })
})

// ============================================================
// Per-runtime session-tool surfaces — derived from the one function every
// backend consults, with the exact options each enforcement site passes:
//
// - Pi: `projection: 'pi'` — `agent/backend/pi/session-tool-defs.ts`
//   (`getSessionToolProxyDefs` passes `projection: 'pi'`).
// - Claude: the default projection — `agent/session-scoped-tools.ts` calls
//   `getSessionToolDefs({ includeDeveloperFeedback: ... })` with NO projection.
// - Codex: `externalStandaloneOnly` — `codex-agent.ts` spawns the session MCP
//   server with `--external-standalone-only`, which `session-mcp-server` maps
//   onto the same option. T5 added a SECOND argument on that spawn,
//   `--host-callback-port`, present whenever the per-session host-callback
//   bridge started — it maps onto `hostCallbackBridge` and is what a shipping
//   codex session actually runs with. `codexSurface` below stays the
//   bridge-less one because the rows that read it are about what the
//   `externalStandaloneOnly` filter withholds STRUCTURALLY; the bridged surface
//   has its own name.
// ============================================================

const piSurface = () => getSessionToolNames({ projection: 'pi' })
const claudeSurface = () => getSessionToolNames()
const codexSurface = () => getSessionToolNames({ externalStandaloneOnly: true })
const codexBridgedSurface = () => getSessionToolNames({ externalStandaloneOnly: true, hostCallbackBridge: true })

/**
 * A tool can be gated by a HOST PORT rather than by a projection, and a probe
 * that omits the port reads a live tool as a stale name.
 *
 * The first was `reviewDiffPort`: `ReviewDiff` is advertised by that
 * option and by nothing else (`isOfferedByHostPorts`, `tool-defs.ts`, whose own
 * comment beside `SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK` says the gate applies
 * "on every projection, so the route and the tool can never come apart"). So the
 * two rows below that ask *is every member of the set a live tool* and *does the
 * bridge carry what it claims* must ask the surface WITH the port bound.
 *
 * Deliberately NOT folded into `claudeSurface()`/`piSurface()`: the containment
 * and subset rows compare PROJECTIONS against each other, and a port mixed into
 * those probes would change what those rows mean rather than fix them.
 */
/**
 * Every per-session host-port OFFER flag, so "widest" really is widest.
 *
 * P6.137 — this held `reviewDiffPort` alone, and the omission was NOT harmless:
 * P6.184 put `PushNotification` into `SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK`
 * without adding its flag here, so the positive control at the bottom of "a
 * bridged codex advertises only the host-callback tools the bridge carries" was
 * RED from that commit — the derived surface could not contain a tool whose gate
 * was never opened. Found and fixed while landing the worktree three, which
 * would have reddened it a second time for the same reason.
 *
 * The rule this constant now carries: a new `SessionToolFilterOptions` OFFER
 * flag belongs here in the same commit that adds it, or the widest surface stops
 * being the widest and every bound derived from it quietly narrows.
 *
 * UB12.71 — and it was broken a second time the same way: UB6.11 (`c9a724544`)
 * made `decide` port-gated on `SessionToolFilterOptions.decidePort`
 * (`isOfferedByHostPorts`) without adding the flag here, so both rows below
 * read the live `decide` as a stale name. The rule is no longer prose alone:
 * "HOST_PORT_OPTIONS names every `*Port` offer flag of SessionToolFilterOptions"
 * derives the flag list from `tool-defs.ts` and fails on the next one left out,
 * and "dropping a host port from the widest probes loses its tool" proves each
 * flag here opens something the two rows can see.
 */
const HOST_PORT_OPTIONS = {
  reviewDiffPort: true,
  decidePort: true,
  notificationPort: true,
  worktreePort: true,
} as const
type HostPortOptions = { [K in keyof typeof HOST_PORT_OPTIONS]: boolean }
const widestSurface = (ports: HostPortOptions = HOST_PORT_OPTIONS) => new Set([
  ...getSessionToolNames({ projection: 'pi', ...ports }),
  ...getSessionToolNames(ports),
])
const codexBridgedWidestSurface = (ports: HostPortOptions = HOST_PORT_OPTIONS) =>
  getSessionToolNames({ externalStandaloneOnly: true, hostCallbackBridge: true, ...ports })

describe('session-tool surfaces (env preconditions)', () => {
  // Both flags are read from process.env INSIDE getSessionToolDefs, so a
  // polluted test environment would silently shift every derived set. Fail
  // loudly instead, naming the cause.
  it('runs with the default task/cron surface', () => {
    expect(areTaskToolsEnabled(), 'NESSY_ENABLE_TASKS is off in this test env').toBe(true)
    expect(isCronDisabled(), 'NESSY_DISABLE_CRON is set in this test env').toBe(false)
  })
})

describe('the Codex split — SESSION_TOOLS_REQUIRING_HOST_CALLBACK is enforced, not decorative', () => {
  // tool-defs.ts calls the set the "single source of truth for the split".
  // Derivation from two independent routes through the same registry: the codex
  // surface must be EXACTLY the default registry surface minus the set. An
  // entry added to the set without the filter honouring it — or a tool that
  // slips past the filter — breaks the equality from one side or the other.
  it('codex surface = default registry tools minus the host-callback set and the native-equivalent set', () => {
    // TWO subtractions since `c324a0b8e` (P6.303), and they are different
    // decisions rather than one list in two halves: the host-callback set names
    // tools codex CANNOT run, and `SESSION_TOOLS_WITHHELD_FOR_NATIVE_EQUIVALENT`
    // names tools it can run and should not, because the runtime brings its own
    // (`TodoWrite` against codex's native `update_plan`). Both are read from
    // their own exported set, never transcribed.
    const expected = [...getSessionRegistryToolNames()]
      .filter(name =>
        !SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has(name)
        && !SESSION_TOOLS_WITHHELD_FOR_NATIVE_EQUIVALENT.has(name))
      .sort()
    expect([...codexSurface()].sort()).toEqual(expected)
    // Positive control: the split actually removes something.
    expect(expected.length).toBeLessThan(getSessionRegistryToolNames().size)
    // And each subtraction removes something OF ITS OWN, so a set that emptied
    // could not hide behind the other one.
    expect(SESSION_TOOLS_WITHHELD_FOR_NATIVE_EQUIVALENT.size).toBeGreaterThan(0)
    for (const name of SESSION_TOOLS_WITHHELD_FOR_NATIVE_EQUIVALENT) {
      expect(SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has(name), name).toBe(false)
      expect(codexSurface().has(name), name).toBe(false)
    }
  })

  // The set is hand-maintained by NAME. A tool rename that misses the set
  // would silently stop gating the renamed tool — every member must still name
  // a live tool on the surface that advertises the widest projection.
  it('every member of the set names a live tool', () => {
    const advertised = widestSurface()
    const stale = [...SESSION_TOOLS_REQUIRING_HOST_CALLBACK].filter(name => !advertised.has(name))
    expect(stale).toEqual([])
    // Positive control: the probe set is non-trivial.
    expect(SESSION_TOOLS_REQUIRING_HOST_CALLBACK.size).toBeGreaterThan(0)
  })

  it('codex never advertises a host-callback tool', () => {
    const leaked = [...codexSurface()].filter(name => SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has(name))
    expect(leaked).toEqual([])
  })

  /**
   * T5 — the one exception, and it is bounded by a second set rather than by a
   * hole in the first. A bridged codex session may advertise a host-callback
   * tool ONLY if the bridge has a route for it, which is what
   * `SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK` enumerates.
   */
  it('a bridged codex advertises only the host-callback tools the bridge carries', () => {
    // The BOUND is asked of the port-free surface — a tool must not leak without
    // its port — and the positive control of the port-bound one, because a
    // port-gated member cannot appear on a surface that never bound the port.
    const leaked = [...codexBridgedSurface(), ...codexBridgedWidestSurface()].filter(
      name => SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has(name)
        && !SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK.has(name),
    )
    expect(leaked).toEqual([])
    // Positive control: it really does advertise some of them, so the row above
    // is a bound and not an empty set met by an unchanged surface.
    expect([...codexBridgedWidestSurface()].filter(name => SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has(name)).sort())
      .toEqual([...SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK].sort())
  })

  /**
   * UB12.71 — the control for the two rows above. A widest probe that drops a
   * host port must lose that port's tool from what those rows read, or they
   * could never have caught `decide` going stale. Asked of EVERY flag, so a
   * flag that opens nothing either row can see fails here too: `decidePort`
   * and `reviewDiffPort` show on both probes, `notificationPort` and
   * `worktreePort` only on the bridged one (the Pi projection offers their
   * tools without the port).
   */
  it('dropping a host port from the widest probes loses its tool (decidePort → decide)', () => {
    const missingWithout = (port: keyof typeof HOST_PORT_OPTIONS) => {
      const ports: HostPortOptions = { ...HOST_PORT_OPTIONS, [port]: false }
      const widest = widestSurface(ports)
      const bridged = codexBridgedWidestSurface(ports)
      return {
        stale: [...SESSION_TOOLS_REQUIRING_HOST_CALLBACK].filter(name => !widest.has(name)).sort(),
        unbridged: [...SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK].filter(name => !bridged.has(name)).sort(),
      }
    }
    // The row's negative: without decidePort the stale list names `decide`,
    // and the bridged codex probe loses exactly that tool too.
    expect(missingWithout('decidePort')).toEqual({ stale: ['decide'], unbridged: ['decide'] })
    for (const port of Object.keys(HOST_PORT_OPTIONS) as (keyof typeof HOST_PORT_OPTIONS)[]) {
      const { stale, unbridged } = missingWithout(port)
      expect(stale.length + unbridged.length, port).toBeGreaterThan(0)
    }
    // Positive control: with every port bound, nothing is missing from either.
    const bound = widestSurface()
    const boundBridged = codexBridgedWidestSurface()
    expect([...SESSION_TOOLS_REQUIRING_HOST_CALLBACK].filter(name => !bound.has(name))).toEqual([])
    expect([...SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK].filter(name => !boundBridged.has(name))).toEqual([])
  })

  // UB12.71 — the rule on HOST_PORT_OPTIONS, derived rather than remembered:
  // every `<name>Port?: boolean` field of `SessionToolFilterOptions` is a key of
  // the constant, and nothing else is. Read from `tool-defs.ts` as text because
  // an interface has no runtime keys.
  it('HOST_PORT_OPTIONS names every *Port offer flag of SessionToolFilterOptions', () => {
    const toolDefs = repoFile('../../../../session-tools-core/src/tool-defs.ts')
    const body = toolDefs.match(/export interface SessionToolFilterOptions \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const portFlags = [...body.matchAll(/^\s+(\w+Port)\?: boolean;/gm)].map(match => match[1]).sort()
    // Positive control: the reader finds the two flags this row is about, so a
    // moved or renamed interface reads empty and fails instead of passing.
    expect(portFlags).toContain('reviewDiffPort')
    expect(portFlags).toContain('decidePort')
    expect(portFlags).toEqual(Object.keys(HOST_PORT_OPTIONS).sort())
  })
})

describe('surface containment', () => {
  // The Pi projection is "common tools plus pi-only" MINUS the legacy checklist
  // pair (`TodoWrite`/`Task` leave the pi surface when the task tools are on,
  // and ONLY the pi surface — tool-defs.ts scopes the suppression to the pi
  // projection because the four replacement tools are pi-only). So the honest
  // relation is: pi ⊇ (default \ LEGACY_TASK_TOOL_NAMES), not pi ⊇ default.
  it('pi advertises everything Claude does, except the legacy checklist pair', () => {
    const pi = piSurface()
    const missing = [...claudeSurface()].filter(
      name => !pi.has(name) && !LEGACY_TASK_TOOL_NAMES.has(name),
    )
    expect(missing).toEqual([])
  })

  /**
   * `caadb12e4` (P6.148, 2026-09-08) ended the nesting, on purpose and in one
   * place: codex's OWN `web_search` is written `disabled` (bar one card, F1.570), so
   * the host offers its own to that projection and to no other — Pi registers
   * one of its own, and claude has the native tool. The two surfaces are
   * therefore overlapping rather than nested, and the delta is exactly that one
   * name; `session-tools-core`'s `scheduling-projection.test.ts` pins the same
   * fact from the registry side.
   */
  it('codex adds exactly one name to the Claude surface, and is otherwise inside it', () => {
    const claude = claudeSurface()
    expect([...codexSurface()].filter(name => !claude.has(name))).toEqual(['web_search'])
    // Still far smaller, which is the containment claim that survives — and a
    // positive control that the two projections were really both built.
    expect(codexSurface().size).toBeLessThan(claude.size)
    // The other direction of the same fact, so this case cannot be satisfied by
    // a surface that simply lost the tool: the host's `web_search` is offered to
    // codex BECAUSE the runtime withholds its own.
    expect(codexSurface().has('web_search')).toBe(true)
    expect(claude.has('web_search')).toBe(false)
  })
})

// ============================================================
// Wiring probes — the surface options above are only honest if the three
// backends actually pass them. Source reads, not imports, because two of the
// three sites are reachable only as text from here (and `readFileSync` sees
// NUL-carrying files that plain grep skips silently — the AGENTS.md trap).
// Every probe carries a positive control so an emptied or moved file cannot
// read as a pass.
// ============================================================

const repoFile = (relativeToThisFile: string): string =>
  readFileSync(fileURLToPath(new URL(relativeToThisFile, import.meta.url)), 'utf8')

const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1

/**
 * P2.122 · the same source with its COMMENTS and STRING LITERALS removed.
 *
 * `occurrences` is a raw substring count, and the row measured what that costs:
 * `pi`'s membership in `AGENT_DEFINITION_RUNTIMES` was being held by a COMMENT.
 * Deleting both of Pi's real uses of `this.config.piRuntimeAgentDefinitions`
 * (`pi-agent.ts:2017`, `:2455`) leaves one hit — the comment at `:2438` — so the
 * derived set kept `pi`, the drift row stayed GREEN, and Pi dispatched nothing.
 * A grep that can be satisfied by prose is not evidence of a dispatch.
 *
 * String literals go too, for the same reason in a different costume: a needle
 * that survives only inside a log message or a test fixture is not a call
 * either.
 *
 * A hand-rolled scanner rather than a regex, because a regex cannot tell `//`
 * inside a URL from the start of a comment, and the natural repair — dropping
 * everything after the first `//` on a line — would silently DELETE real code
 * containing a URL and shrink the derived set. This one tracks the three string
 * forms and the two comment forms in one pass. Its errors, if any, are in the
 * loud direction: removing too much makes a membership disappear and fails the
 * equality, it never invents one.
 *
 * ## `${…}` IS CODE, and reading it as literal text cost two false reds (O31)
 *
 * A template literal's interpolations hold real calls, so the scan DESCENDS into
 * each `${…}` instead of running to the next backtick. Tracking that depth is
 * not a refinement — the version that looked for the next backtick ended the
 * literal at the first NESTED one, and an apostrophe in the prose that followed
 * (`app's`) then opened a phantom `'…'` string that swallowed live code until the
 * next apostrophe. Measured on `codex-agent.ts` twice, in OPPOSITE directions:
 * `writeCodexConfig({` (`:2207`) read as absent, and
 * `this.config.piRuntimeAgentDefinitions` (`:2124`, `:2277`) read as absent so
 * `codex-runtime` dropped out of the derived set while the constant admits it.
 * Both were live code the whole time. O31 of the out-of-scope register bisected
 * the first to `bbda4b303` and predicted the recurrence; this is the fix it
 * asked for, and the fixture in "the stripper drops comments and literals and
 * keeps code" pins both halves so the next nested template cannot re-open it.
 */
function stripCommentsForCounting(source: string): string {
  let out = ''
  let i = 0
  const n = source.length
  /**
   * One frame per template literal we are inside, innermost last. `braces` is
   * `null` while we are in that template's TEXT and a `{`-nesting depth while we
   * are inside one of its `${…}` interpolations — which is ordinary code and is
   * scanned as such, nested templates included.
   */
  const frames: Array<{ braces: number | null }> = []
  while (i < n) {
    const frame = frames.length > 0 ? frames[frames.length - 1]! : undefined
    const ch = source[i]!
    const next = source[i + 1]
    if (frame !== undefined && frame.braces === null) {
      // Template TEXT: dropped like any literal's content, and a comment or a
      // quote in it is text, not syntax.
      if (ch === '\\') { i += 2; continue }
      if (ch === '`') { frames.pop(); out += ' '; i += 1; continue }
      if (ch === '$' && next === '{') { frame.braces = 0; i += 2; continue }
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (ch === '`') {
      frames.push({ braces: null })
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      const quote = ch
      i += 1
      while (i < n) {
        if (source[i] === '\\') { i += 2; continue }
        if (source[i] === quote) { i += 1; break }
        i += 1
      }
      // The literal's CONTENT is dropped; a space keeps tokens either side apart.
      out += ' '
      continue
    }
    if (frame !== undefined && ch === '{') frame.braces = (frame.braces ?? 0) + 1
    if (frame !== undefined && ch === '}') {
      if (frame.braces === 0) { frame.braces = null; i += 1; continue }
      frame.braces = (frame.braces ?? 0) - 1
    }
    out += ch
    i += 1
  }
  return out
}

/** {@link occurrences}, counting only hits that are live code. */
const codeOccurrences = (haystack: string, needle: string): number =>
  occurrences(stripCommentsForCounting(haystack), needle)

describe('the three surface options are the ones the backends pass', () => {
  it('Pi passes the pi projection', () => {
    const source = repoFile('../backend/pi/session-tool-defs.ts')
    expect(source).toContain('export function getSessionToolProxyDefs')
    expect(source).toContain("projection: 'pi'")
  })

  it('Claude passes no projection (the default surface)', () => {
    const source = repoFile('../session-scoped-tools.ts')
    // Matched across the line break rather than as one line: `e21e4a46b` added
    // the `reviewDiffPort` spread and the call became multi-line, which broke a
    // pin whose subject had not moved at all. Same shape as the three
    // `pi-harness-baseline.test.ts` pins in the known-failing register — a pin on
    // a FORMATTING accident reports a contract change that did not happen.
    expect(source).toMatch(/getSessionToolDefs\(\{\s*includeDeveloperFeedback/)
    expect(source).not.toContain("projection: 'pi'")
    expect(source).not.toContain('externalStandaloneOnly')
  })

  // The flag crosses a process boundary as a literal string, so the two halves
  // can only drift apart silently — unless both are pinned to one spelling.
  it('Codex and the session MCP server agree on the flag spelling', () => {
    const codexAgent = repoFile('../codex-agent.ts')
    const mcpServer = repoFile('../../../../session-mcp-server/src/index.ts')
    expect(codexAgent).toContain("'--external-standalone-only'")
    expect(mcpServer).toContain("'--external-standalone-only'")
    // ...and the server maps the flag onto the same tool-defs option the codex
    // surface above derives from.
    expect(mcpServer).toContain('externalStandaloneOnly = true')
    expect(mcpServer).toContain('externalStandaloneOnly,')
  })

  /**
   * T5 — the SECOND string that crosses the same process boundary, and the one
   * that decides whether the codex surface is the 18 or the 23. Same failure
   * mode as the row above (a rename on one side is silent), same fix.
   */
  it('Codex and the session MCP server agree on the bridge-port flag spelling', () => {
    const codexAgent = repoFile('../codex-agent.ts')
    const mcpServer = repoFile('../../../../session-mcp-server/src/index.ts')
    expect(codexAgent).toContain("'--host-callback-port'")
    expect(mcpServer).toContain("'--host-callback-port'")
    // The server maps it onto the tool-defs option `codexBridgedSurface` reads.
    expect(mcpServer).toContain('hostCallbackBridge,')
    // It must NOT be the `--callback-port` name: that was the older `/call-llm`
    // channel, gone whole (F1.710 removed its env fallback, F1.1135 its argv
    // branch), and no port reads the environment. Pin all three absences.
    expect(mcpServer).not.toContain("'--callback-port'")
    expect(mcpServer).not.toContain('process.env.NESSY_LLM_CALLBACK_PORT')
    expect(mcpServer).not.toContain('hostCallbackPort: hostCallbackPort || process.env')
  })
})

// ============================================================
// `runtime-agent-support` — the two hand-maintained sets, derived from the
// mechanism that makes membership true.
// ============================================================

describe('AGENT_DEFINITION_RUNTIMES matches the backends that consume definitions', () => {
  // Membership is "by MECHANISM, not by ambition" (the module's own words), and
  // the mechanism has one carrier: `BackendConfig.piRuntimeAgentDefinitions`.
  // SessionManager builds it behind `runtimeDispatchesAgentDefinitions(provider)`
  // and each member backend CONSUMES `this.config.piRuntimeAgentDefinitions`
  // (Pi hands it to the harness, Claude to the SDK `agents` option via
  // `buildClaudeRuntimeAgentOptions`, Codex to the config-writer's
  // `[agents.<role>]` layer). A backend that never reads the field dispatches
  // nothing, whatever the set says. The probe is self-controlling in the safe
  // direction: if the field is renamed, the derived set collapses to empty and
  // the equality fails — it cannot rot into a silent pass.
  const backendSourceByProvider = {
    pi: '../pi-agent.ts',
    anthropic: '../claude-agent.ts',
    'codex-runtime': '../codex-agent.ts',
    'nestor-cloud-agent': '../nestor-cloud-agent.ts',
  } as const satisfies Record<ModelProvider, string>

  it('a provider is in the set iff its backend consumes piRuntimeAgentDefinitions IN CODE', () => {
    // P2.122 — `codeOccurrences`, not `occurrences`. The raw count let a comment
    // hold `pi`'s membership; the block below measures that difference directly
    // rather than trusting this line to have fixed it.
    const derived = MODEL_PROVIDERS.filter(
      provider =>
        codeOccurrences(repoFile(backendSourceByProvider[provider]), 'this.config.piRuntimeAgentDefinitions') > 0,
    ).sort()
    expect([...AGENT_DEFINITION_RUNTIMES].sort()).toEqual(derived)
    // Positive control for the absence half: the probe does find the field in
    // at least one backend, so nestor's zero is a measured zero, not a wrong
    // needle.
    expect(derived.length).toBeGreaterThan(0)
  })

  it('both catalog readers consume the shared helper instead of restating the condition', () => {
    // The module exists precisely because "the two readers are in different
    // packages and a drift between them is silent". server-core is reachable
    // from here only as text.
    const sessionManager = repoFile('../../../../server-core/src/sessions/SessionManager.ts')
    expect(sessionManager).toContain('class SessionManager') // control: right file
    expect(sessionManager).toContain(
      "from '@nessy-agent/shared/agent/runtime-agent-support'",
    )
    expect(occurrences(sessionManager, 'runtimeDispatchesAgentDefinitions(')).toBeGreaterThan(0)
    expect(occurrences(sessionManager, 'runtimeRunsPluginMonitors(')).toBeGreaterThan(0)
    expect(occurrences(sessionManager, 'runtimeProvisionsPluginLsp(')).toBeGreaterThan(0)

    const resolver = repoFile('../../capabilities/resolver.ts')
    expect(resolver).toContain("from '../agent/runtime-agent-support.ts'") // control: right file
    expect(occurrences(resolver, 'runtimeDispatchesAgentDefinitions(')).toBeGreaterThan(0)
    expect(occurrences(resolver, 'runtimeRunsPluginMonitors(')).toBeGreaterThan(0)
    expect(occurrences(resolver, 'runtimeProvisionsPluginLsp(')).toBeGreaterThan(0)
  })
})

describe('the split peripheral records match the wiring (P6.175)', () => {
  // Until P6.175 ONE record decided three unrelated things, and the drift this
  // file exists to catch was already inside it: the monitors, the language
  // servers and MCP channel push all read `runtimeRunsPluginPeripherals`. What
  // IS asserted here: the arming call exists, each group sits behind ITS OWN
  // helper, and each set stays inside the agent-definition set (a runtime that
  // runs peripherals but dispatches no definitions would be a new architecture,
  // not a drift).
  it('SessionManager arms each peripheral behind its own helper', () => {
    const sessionManager = repoFile('../../../../server-core/src/sessions/SessionManager.ts')
    expect(occurrences(sessionManager, 'armPluginPeripherals')).toBeGreaterThan(1) // declaration + call
    expect(sessionManager).toContain(
      'this.armPluginPeripherals(managed, capabilityRuntime, provider)',
    )
    expect(sessionManager).toContain(
      'if (runtimeRunsPluginMonitors(provider)) void this.ensurePluginCommandMonitors(',
    )
    expect(sessionManager).toContain(
      'if (runtimeReceivesMcpChannelPush(provider) && managed.mcpPool && managed.mcpLeaserId) {',
    )
    // The old single gate is GONE, not merely joined: a re-introduction would
    // arm all three off one answer again, which is the defect itself. Asserted
    // at the DEFINITION rather than by counting mentions — both files carry
    // paragraphs about the predicate that used to exist, and a comment is not a
    // reader.
    expect(repoFile('../runtime-agent-support.ts'))
      .not.toContain('export function runtimeRunsPluginPeripherals')
  })

  it('each set is contained in AGENT_DEFINITION_RUNTIMES and non-empty', () => {
    for (const set of [PLUGIN_MONITOR_RUNTIMES, PLUGIN_LSP_RUNTIMES, MCP_CHANNEL_PUSH_RUNTIMES]) {
      expect([...set].filter(p => !AGENT_DEFINITION_RUNTIMES.has(p))).toEqual([])
      expect(set.size).toBeGreaterThan(0)
    }
  })

  it('the three records no longer answer identically', () => {
    // The point of the split, asserted as a property rather than as prose: if
    // someone re-merges them, this is the line that says why they cannot.
    expect(PLUGIN_MONITOR_SUPPORT.anthropic).toBe(true)
    // P6.176 — codex's own `turn/steer`, already driven.
    expect(PLUGIN_MONITOR_SUPPORT['codex-runtime']).toBe(true)
    expect(PLUGIN_LSP_SUPPORT.anthropic).toBe(false)
    expect(PLUGIN_LSP_SUPPORT['codex-runtime']).toBe(false)
    // P6.74's two managed-key verdicts rested on this one staying false until a
    // row of its own moved it. P6.341 is that row: our own pool arms the
    // dispatcher on claude and codex behind the server's `claude/channel`
    // handshake declaration, and both verdicts moved to `host-gate` in the same
    // commit. `PLUGIN_LSP_SUPPORT` above is what keeps this test from becoming
    // "all three records answer true" — it is the surviving divergence, so the
    // split's own property still has a carrier.
    expect(MCP_CHANNEL_PUSH_SUPPORT.anthropic).toBe(true)
    expect(MCP_CHANNEL_PUSH_SUPPORT['codex-runtime']).toBe(true)
    // The remote agent runs no local pool, so it is the one arm that stays off
    // on all three records.
    expect(MCP_CHANNEL_PUSH_SUPPORT['nestor-cloud-agent']).toBe(false)
  })

  /**
   * The negative case the widening owes: a monitor delivery must never ABORT the
   * user's turn.
   *
   * `ClaudeAgent.redirect` falls back to `forceAbort(AbortReason.Redirect)` when
   * the slot is settled, and that arm is unreachable from the monitor path — but
   * only because two conditions are literally the same predicate:
   * `armPluginPeripherals`'s `canDeliver()` demands `agent.isProcessing?.()`, and
   * `ClaudeAgent.isProcessing()` IS `openSlot !== null && !openSlot.settled`,
   * which is exactly what `redirect` tests before falling back. They are read in
   * one synchronous expression, so nothing can interleave between them.
   *
   * That is an argument, not a mechanism, so it is pinned: if either side is
   * rewritten, a plugin monitor firing at a turn boundary starts killing turns,
   * and the failure would look like a user complaint rather than a test.
   */
  it('the claude steer path cannot reach its abort fallback from a monitor delivery', () => {
    const claudeAgent = repoFile('../claude-agent.ts')
    expect(claudeAgent).toContain('class ClaudeAgent') // control: right file
    expect(claudeAgent).toContain('return this.openSlot !== null && !this.openSlot.settled;')
    expect(claudeAgent).toContain('if (!this.openSlot || this.openSlot.settled) {')

    const sessionManager = repoFile('../../../../server-core/src/sessions/SessionManager.ts')
    expect(sessionManager).toContain('!agent.isProcessing?.()')
    // F1.343 — the delivery names its origin, so a hand-back is not queued as a user message.
    expect(sessionManager).toContain("canDeliver()?.redirect(framed, { origin: 'monitor', messageId }) ?? false") // F1.485 — framed; F1.496 — the live line's id rides the steer
  })

  it('the hook ACTION runners are their own record, and the delta subtracts from it', () => {
    // `inertHookKinds` used to read the PERIPHERAL predicate — a fourth rider on
    // the same answer. It reads the builder's own record now.
    const sessionManager = repoFile('../../../../server-core/src/sessions/SessionManager.ts')
    expect(sessionManager).toContain('const runnersAfter = new Set(pluginHookActionRunnersFor(to))')
    expect([...pluginHookActionRunnersFor(undefined)].sort()).toEqual([...PLUGIN_HOOK_ACTION_KINDS].sort())
    for (const kinds of Object.values(PLUGIN_HOOK_ACTION_RUNNERS)) {
      expect(kinds.filter(kind => !PLUGIN_HOOK_ACTION_KINDS.includes(kind))).toEqual([])
    }
    // Non-vacuous in both directions: Pi gets all four, and at least one runtime
    // is given strictly fewer.
    expect([...PLUGIN_HOOK_ACTION_RUNNERS.pi].sort()).toEqual([...PLUGIN_HOOK_ACTION_KINDS].sort())
    expect(Object.values(PLUGIN_HOOK_ACTION_RUNNERS)
      .some(kinds => kinds.length < PLUGIN_HOOK_ACTION_KINDS.length)).toBe(true)

    // P6.117 gave the three cheap runners to both other coding runtimes;
    // P6.590 gave them `agent` as well, once the child-session port stopped
    // being assigned only where the Pi permission band exists. Explicit rather
    // than derived: the rows are about WHICH kinds, and a derivation would
    // restate the record instead of pinning it.
    for (const provider of ['anthropic', 'codex-runtime'] as const) {
      expect([...PLUGIN_HOOK_ACTION_RUNNERS[provider]].sort()).toEqual(['agent', 'http', 'mcp', 'prompt'])
    }
    // P6.590 — pinned at the SOURCE too, because the record being right while
    // the port stayed Pi-gated is exactly the shape this row was born from: a
    // catalogue advertising a hook that dies at `agent-unavailable`.
    const manager = repoFile('../../../../server-core/src/sessions/SessionManager.ts')
    expect(manager).toContain('const piChildSessionPort = managed.piChildSessionPort ??= this.createPiDelegatingChildSessionPort(')
    expect(manager).not.toContain('const piChildSessionPort = piPermissionService')
    // The builder spreads from the record — asserted at the source, because a
    // reverted wiring would leave the record right and the product wrong.
    const builder = repoFile('../../../../server-core/src/sessions/SessionManager.ts')
    expect(builder).toContain('const runners = new Set(pluginHookActionRunnersFor(provider))')
    for (const [kind, option] of [
      ['agent', 'pluginAgentHookRunner'],
      ['mcp', 'pluginMcpToolHookRunner'],
      ['http', 'pluginHttpHookRunner'],
      ['prompt', 'pluginPromptHookRunner'],
    ] as const) {
      expect(builder).toContain(`...(runners.has('${kind}')`)
      expect(builder).toContain(`{ ${option}: this.${option}(managed, capabilityRuntime) }`)
    }
  })
})

/**
 * P3.340 · the post-edit diagnostics and the `format` tool.
 *
 * The fifth record, and the first whose subject is not a plugin: both are HOST
 * runners `SessionManager` builds and assigns onto the backend, so the only
 * thing that ever said they were Pi-only was the injection condition itself —
 * no catalogue row, no switch notice, and a `sessionLog.debug` that reaches
 * nobody on a packaged build.
 *
 * Derived from the enforcement site in both directions, never transcribed: a
 * backend is in the set iff it DECLARES the two runner fields, because
 * `acceptsEditFeedbackRunner` / `acceptsFormatRunner` duck-type on exactly
 * those. That is also why the record could not be replaced by deleting the
 * provider test: with the duck-type in place, deleting it changes no behaviour
 * at all, which is precisely what made the claim invisible.
 */
describe('HOST_EDIT_TOOLING_RUNTIMES matches the backends that declare the runners', () => {
  const backendSourceByProvider = {
    pi: '../pi-agent.ts',
    anthropic: '../claude-agent.ts',
    'codex-runtime': '../codex-agent.ts',
    'nestor-cloud-agent': '../nestor-cloud-agent.ts',
  } as const satisfies Record<ModelProvider, string>

  it('a provider is in the set iff its backend declares both runner fields IN CODE', () => {
    const declares = MODEL_PROVIDERS.filter(provider => {
      const source = repoFile(backendSourceByProvider[provider])
      return codeOccurrences(source, 'editFeedbackRunner') > 0 && codeOccurrences(source, 'formatRunner') > 0
    }).sort()
    expect([...HOST_EDIT_TOOLING_RUNTIMES].sort()).toEqual(declares)
    // Positive control for the absence half: the probe does find both fields in
    // at least one backend, so the three zeros are measured zeros and not a
    // pair of needles that stopped matching.
    expect(declares.length).toBeGreaterThan(0)
    // …and a PROPER subset, so the row keeps a negative side to fail on.
    expect(declares.length).toBeLessThan(MODEL_PROVIDERS.length)
  })

  it('SessionManager injects both runners behind the helper, not a restated provider test', () => {
    const sessionManager = repoFile('../../../../server-core/src/sessions/SessionManager.ts')
    expect(sessionManager).toContain('class SessionManager') // control: right file
    // Two injection sites, one predicate. The count is the assertion: a second
    // condition added beside one of them, or one site reverted to a literal,
    // moves this number.
    expect(occurrences(sessionManager, 'runtimeRunsHostEditTooling(provider)')).toBe(2)
    expect(sessionManager).toContain('AGENT_FLAGS.editFeedbackEnabled')
    expect(sessionManager).toContain('AGENT_FLAGS.formatterEnabled')
  })

  it('the switch notice is derived from the same record', () => {
    // The user-visible half. Without it the record would be honest and unread,
    // which is the state the four records above were built to end.
    const sessionManager = repoFile('../../../../server-core/src/sessions/SessionManager.ts')
    expect(sessionManager).toContain('runtimeRunsHostEditTooling(from) && !runtimeRunsHostEditTooling(to)')
    const chatPage = repoFile('../../../../../apps/electron/src/renderer/pages/ChatPage.tsx')
    expect(chatPage).toContain('delta.hostEditToolingLost') // control: right file and right field
    expect(chatPage).toContain("t('chat.runtimeSwitch.capabilityEditTooling')")
  })

  it('is contained in AGENT_DEFINITION_RUNTIMES and non-empty', () => {
    expect([...HOST_EDIT_TOOLING_RUNTIMES].filter(p => !AGENT_DEFINITION_RUNTIMES.has(p))).toEqual([])
    expect(HOST_EDIT_TOOLING_RUNTIMES.size).toBeGreaterThan(0)
  })
})

describe('the no-claim readers fail OPEN (consolidation trap (b), asserted)', () => {
  // See the file header. A consolidation that makes "no claim" hide a control
  // flips these to false and must fail here, against the recorded reason.
  it('an undefined provider answers true on both readers', () => {
    expect(runtimeDispatchesAgentDefinitions(undefined)).toBe(true)
    expect(runtimeRunsPluginMonitors(undefined)).toBe(true)
    expect(runtimeProvisionsPluginLsp(undefined)).toBe(true)
    expect(runtimeReceivesMcpChannelPush(undefined)).toBe(true)
    expect(runtimeRunsHostEditTooling(undefined)).toBe(true)
  })

  it('the sets themselves stay decisive for a defined provider', () => {
    // Negative control for the fail-open case: `undefined → true` must not mean
    // "always true".
    expect(runtimeDispatchesAgentDefinitions('nestor-cloud-agent')).toBe(false)
    expect(runtimeRunsPluginMonitors('nestor-cloud-agent')).toBe(false)
    expect(runtimeProvisionsPluginLsp('anthropic')).toBe(false)
    expect(runtimeRunsHostEditTooling('codex-runtime')).toBe(false)
  })
})

// ============================================================
// The per-provider slash gate (T17, 2026-08-22-nestor-cloud-contract-fix).
//
// `/quota` is the first command whose availability is positive-shaped: it reads
// `GET /api/v1/quota`, a Nestor-gateway route, so `resolveComposerCapabilities`
// excludes it wherever that gateway is not behind the session.
//
// T19 widened it from a PROVIDER question to a CONNECTION one — the built-in Pi
// Nessy Gateway card is metered by the same limiter and answers the command,
// while a BYOK Pi connection is not and does not. So the partition below runs
// over the whole grid (compiler-checked provider vocabulary × connection
// shapes) and compares each cell against the RULE, taken from its own authority
// (`isNessyGatewayBaseUrl`, `drivers/upstream-target.ts`) rather than re-spelled here — never a
// transcribed membership list. A provider added to `ModelProvider`, or a change
// to what counts as the gateway, must land on one side of this partition or
// fail here rather than silently inheriting whichever default it hits.
// ============================================================

describe('the slash gate partitions providers by who can answer the command', () => {
  const offers = (provider: ModelProvider, commandId: string, connection?: LlmConnection): boolean => {
    const slash = resolveComposerCapabilities({ provider, ...(connection ? { connection } : {}) }).slash
    if (slash.commandIds !== 'all' && !slash.commandIds.includes(commandId)) return false
    return !slash.excludedCommandIds?.includes(commandId)
  }

  const CONNECTION_SHAPES: Record<string, LlmConnection | undefined> = {
    none: undefined,
    gateway: {
      slug: 'nessy-gateway',
      name: 'Nessy Gateway',
      providerType: 'pi_compat',
      authType: 'api_key_with_endpoint',
      baseUrl: `${NESTOR_CLI_BASE_PREFIX}openai-like/v1`,
      createdAt: 1,
    },
    byok: {
      slug: 'byok',
      name: 'BYOK',
      providerType: 'pi_compat',
      authType: 'api_key_with_endpoint',
      baseUrl: 'https://api.deepseek.com/v1',
      createdAt: 1,
    },
  }

  it('quota is offered by exactly the sessions whose connection is behind that quota endpoint', () => {
    const ruleSaysOffered = (provider: ModelProvider, connection?: LlmConnection): boolean =>
      provider === 'nestor-cloud-agent'
      // F1.6 — every LOCAL runtime answers on the gateway connection, so the
      // family no longer takes part; the authority is the whole-URL rule
      // `offersNestorQuota` and both non-Pi overrides read.
      || isNessyGatewayBaseUrl(connection?.baseUrl)

    const cells = MODEL_PROVIDERS.flatMap(provider =>
      Object.entries(CONNECTION_SHAPES).map(([shape, connection]) => ({ provider, shape, connection })),
    )
    for (const { provider, shape, connection } of cells) {
      expect(offers(provider, 'quota', connection), `${provider}/${shape}`)
        .toBe(ruleSaysOffered(provider, connection))
    }
    // The grid is a real partition and not a constant: both answers occur.
    expect(cells.some(cell => offers(cell.provider, 'quota', cell.connection))).toBe(true)
    expect(cells.some(cell => !offers(cell.provider, 'quota', cell.connection))).toBe(true)
    // …and the Pi family really is split BY THE CONNECTION, which is the whole
    // widening: same provider, opposite answers.
    expect(offers('pi', 'quota', CONNECTION_SHAPES.gateway)).toBe(true)
    expect(offers('pi', 'quota', CONNECTION_SHAPES.byok)).toBe(false)
    // F1.6 — the claude and codex gateway cards are offered it too, and a BYO
    // connection of either family is not.
    for (const provider of ['anthropic', 'codex-runtime'] as const) {
      expect(offers(provider, 'quota', CONNECTION_SHAPES.gateway), provider).toBe(true)
      expect(offers(provider, 'quota', CONNECTION_SHAPES.byok), provider).toBe(false)
    }
  })

  it('btw/recap are excluded by exactly the runtime whose queryLlm throws', () => {
    // Negative control for the row above: the pre-existing SUBTRACTIVE gate
    // partitions the same vocabulary the other way round, so "every provider
    // agrees on everything" cannot pass both.
    for (const commandId of ['btw', 'recap']) {
      const offering = MODEL_PROVIDERS.filter(provider => offers(provider, commandId))
      expect(offering, commandId).not.toContain('nestor-cloud-agent')
      expect(offering.length, commandId).toBe(MODEL_PROVIDERS.length - 1)
    }
  })
})

// ============================================================
// `scripts/cdp/lib/runtime-switch.ts` `runtimeOf` — the third hand restatement
// of `providerTypeToAgentProvider`, the only one WITHOUT a "kept in step by
// hand" note. Reachable: its module graph is innocuous (fixtures and case
// boilerplate are gated behind `import.meta.main`; `connect.ts` imports
// nothing). Imported through a COMPUTED specifier so this package's typecheck
// does not adopt the cdp harness's sources into its own program.
// ============================================================

describe('cdp runtimeOf restates providerTypeToAgentProvider', () => {
  const cdpModulePath = fileURLToPath(
    new URL('../../../../../scripts/cdp/lib/runtime-switch.ts', import.meta.url),
  )

  it('agrees on every provider type the harness can meet', async () => {
    const { runtimeOf } = (await import(cdpModulePath)) as {
      runtimeOf: (providerType: string) => string
    }
    for (const providerType of LLM_PROVIDER_TYPES) {
      // KNOWN DRIFT, found by the T5 review and confirmed live 2026-08-20:
      // `runtimeOf('nestor-cloud-agent')` answers 'remote' (its unknown-input
      // fallback arm doing double duty) where `providerTypeToAgentProvider`
      // answers 'nestor-cloud-agent'. The harness never switches onto nestor,
      // so the two have not collided in a live run — but nothing records the
      // divergence as intended, so it is excluded here and tracked by the
      // `.todo` below rather than baked in as truth.
      if (providerType === 'nestor-cloud-agent') continue
      expect(runtimeOf(providerType), providerType).toBe(providerTypeToAgentProvider(providerType))
    }
  })

  // Un-skip once the drift is resolved either way: `runtimeOf` learns
  // 'nestor-cloud-agent', or its docblock records 'remote' as the deliberate
  // spelling for the non-switchable remote runtime and this test learns THAT.
  // The body holds the assertion that fails today, so `bun test --todo` shows
  // the drift as still-open rather than silently green.
  it.todo(
    "nestor-cloud-agent: runtimeOf answers 'remote', providerTypeToAgentProvider answers 'nestor-cloud-agent'",
    async () => {
      const { runtimeOf } = (await import(cdpModulePath)) as {
        runtimeOf: (providerType: string) => string
      }
      expect(runtimeOf('nestor-cloud-agent')).toBe(
        providerTypeToAgentProvider('nestor-cloud-agent'),
      )
    },
  )
})

// ============================================================
// P2.122 · the same claim, measured instead of read.
//
// The block above derives `AGENT_DEFINITION_RUNTIMES` from a source token. That
// is a grep, and the omnigent reference (`.references/omnigent`, Apache-2.0)
// records this exact class of check MEASURED WRONG in its own tree —
// `designs/harness-capabilities-bench-seam.md` requires a declaration to come
// "only from a live observation of 0 deltas" because "a static 'the forwarder
// posts no delta' grep is not sufficient (pi-native has no delta-posting
// forwarder yet streams live)".
//
// It is wrong-capable HERE too, and this is measured, not argued. Classifying
// every hit in the four backend sources:
//
//   pi-agent.ts     3 hits — :2017 CODE, :2455 CODE, :2438 **COMMENT**
//   claude-agent.ts 2 hits — both CODE
//   codex-agent.ts  2 hits — both CODE
//   nestor-cloud-agent.ts 0
//
// Delete BOTH of Pi's real uses and the raw count is still 1, because the
// comment at :2438 spells the needle. `pi` stays in the derived set, the row
// above stays GREEN, and Pi dispatches nothing. The grep was not merely fragile
// in principle; it was holding a membership on a comment.
//
// TWO REPAIRS, and they are complementary rather than alternatives:
//
//  1. The derivation now counts CODE ONLY (`codeOccurrences`). Prose can no
//     longer hold a membership, which is asserted below against pi-agent.ts
//     itself rather than assumed of the stripper.
//  2. Where a dispatch mechanism is REACHABLE, the question is asked
//     behaviourally — does a definition handed to this runtime's mechanism come
//     out the other side as something that runtime will actually run — and the
//     answer is reconciled against the declaration with the reference's rule:
//     DRIFT when two CONCRETE facts disagree, in either direction.
//
// ## What it reaches, stated at the strength it is measured (P2.135)
//
// P2.135 is the correction to this block's first write-up, which claimed the
// probes prove a definition "comes out the other side as something that runtime
// will actually run". That is true of the BUILDER. It was not true of the
// AGENT→builder hop: `probeAnthropic` called `buildClaudeRuntimeAgentOptions`
// directly while production reaches it from `claude-agent.ts:3348`, and
// `probeCodex` called `buildCodexAgentRoles` directly while production reaches
// it via `codex-agent.ts:754 → writeCodexConfig → codexAgentRolesFor`. If either
// agent stopped feeding its own builder, both probes stayed green.
//
// So the claim is split into two dimensions, reconciled separately:
//
//  - `dispatch` — the builder, DRIVEN. For codex the probe now enters one hop
//    higher, at the exported `writeCodexConfig` the agent itself calls, and
//    reads the config it writes to disk; the builder is no longer called
//    directly at all. For anthropic the builder is the highest reachable entry:
//    its only caller is an expression inside `ClaudeAgent.chatImpl`, which needs
//    a live SDK subprocess.
//  - `agentFeedsBuilder` — the last hop, which no reachable code can DRIVE from
//    here, asserted as a code-only occurrence in the agent's own source with a
//    positive control. It is a grep, and it is labelled a grep. A grep that
//    stands in for a behaviour is the defect P2.122 names; a grep that pins the
//    one hop a driven probe cannot enter, next to the driven probe, is a
//    disclosure of the boundary rather than a substitute for crossing it.
//
// The third member has no reachable builder at all:
//   - `pi` → its only carrier is the payload built inside
//     `PiAgent.spawnSubprocess` (`pi-agent.ts:1836`, the object at :2017), which
//     needs a live subprocess. It is SKIPPED with that reason, and the skip is
//     listed explicitly below so it is a disclosure rather than a silence.
// `nestor-cloud-agent` has no carrier at all, which is the claim — an absence
// this layer cannot observe, so it too is skipped rather than asserted.
//
// The reconcile core this mirrors lives at
// `packages/server-core/src/__tests__/conformance/verdict.ts`. It is restated
// in four lines here rather than imported: `packages/shared` must not depend on
// `packages/server-core` (the dependency runs the other way), and a
// cross-package test import has already cost this repo one tsc surprise.
// ============================================================

describe('P2.122 · a grep that prose can satisfy is not evidence', () => {
  it('the stripper drops comments and literals and keeps code', () => {
    const fixture = [
      "const url = 'https://example.test/needle'",
      '// needle in a line comment',
      '/* needle in a block comment */',
      'call(needle)',
      'const tpl = `needle in a template`',
    ].join('\n')
    const stripped = stripCommentsForCounting(fixture)
    // The `//` inside the URL must NOT start a comment — the failure mode a
    // regex has, and the reason this is a scanner.
    expect(occurrences(fixture, 'needle')).toBe(5)
    expect(occurrences(stripped, 'needle')).toBe(1)
    expect(stripped).toContain('call(needle)')
  })

  // O31, and the exact shape that cost two false reds on `codex-agent.ts`: a
  // NESTED template inside a `${…}`, followed by an apostrophe in prose. The
  // pre-fix scanner ended the outer literal at the inner backtick and then read
  // `app's … 'kept(needle)` as one string literal, deleting live code — so this
  // asserts BOTH directions on one fixture.
  it('descends into `${…}` and survives a nested template followed by an apostrophe', () => {
    const fixture = [
      'const outer = `head ${inner(`deep ${call(needle)} tail`)} rest`',
      "// the app's own note mentioning needle",
      'kept(needle)',
    ].join('\n')
    const stripped = stripCommentsForCounting(fixture)
    // POSITIVE: the interpolated call is code and is kept, at both depths.
    expect(stripped).toContain('call(needle)')
    expect(stripped).toContain('inner(')
    // ...and the code AFTER the phantom-string window is still there.
    expect(stripped).toContain('kept(needle)')
    // NEGATIVE: template TEXT and the comment are still dropped, so the
    // descent did not turn the stripper into an identity function.
    expect(stripped).not.toContain('head')
    expect(stripped).not.toContain("app's")
    expect(occurrences(fixture, 'needle')).toBe(3)
    expect(occurrences(stripped, 'needle')).toBe(2)
  })

  it("pi's membership is held by CODE, and was held by prose before this", () => {
    const piSource = repoFile('../pi-agent.ts')
    const needle = 'this.config.piRuntimeAgentDefinitions'
    const raw = occurrences(piSource, needle)
    const code = codeOccurrences(piSource, needle)
    // The measured gap itself: the raw count sees one hit the code count does
    // not, and that hit is the comment the row named. This is the assertion
    // that fails if someone reverts the derivation to the raw counter and
    // believes the two are equivalent.
    expect(raw).toBeGreaterThan(code)
    // ...and the code hits are real, so `pi` is in the set on its own merits.
    expect(code).toBeGreaterThan(0)
    // Positive control for the stripper on this very file: it did not simply
    // return the input, and it did not empty it.
    const stripped = stripCommentsForCounting(piSource)
    expect(stripped.length).toBeLessThan(piSource.length)
    expect(stripped).toContain('class PiAgent')
  })

  it('the comment alone would NOT hold the membership (the row, simulated)', () => {
    // The row's mutation, run against the real comment text instead of against
    // a shared source file two other lanes are live in: take the lines of
    // pi-agent.ts that mention the needle, keep only the ones the stripper
    // removes, and ask the counter what it sees. That is exactly the state
    // "both real uses deleted" leaves behind.
    const needle = 'this.config.piRuntimeAgentDefinitions'
    const mentioning = repoFile('../pi-agent.ts')
      .split('\n')
      .filter(line => line.includes(needle))
    // Positive control: the file really does mention it on several lines, and at
    // least one of them is prose.
    expect(mentioning.length).toBeGreaterThan(1)
    const proseOnly = mentioning.filter(line => !stripCommentsForCounting(line).includes(needle))
    expect(proseOnly.length).toBeGreaterThan(0)
    const survivingSource = proseOnly.join('\n')
    // The raw counter — the one that shipped — still finds it, which is how the
    // membership was held by prose.
    expect(occurrences(survivingSource, needle)).toBe(proseOnly.length)
    // The counter the derivation now uses finds nothing, so `pi` would leave the
    // derived set and the drift row would go RED, which is the whole repair.
    expect(codeOccurrences(survivingSource, needle)).toBe(0)
  })
})

describe('AGENT_DEFINITION_RUNTIMES, measured through the dispatch mechanism (P2.122, P2.135)', () => {
  type Verdict = 'supported' | 'unsupported' | 'skipped'
  const CONCRETE: ReadonlySet<Verdict> = new Set<Verdict>(['supported', 'unsupported'])
  /** DRIFT only when both sides assert a fact and the facts differ. */
  const reconcile = (observed: Verdict, declared: Verdict): Verdict | 'drift' =>
    CONCRETE.has(observed) && CONCRETE.has(declared) && observed !== declared ? 'drift' : observed

  const SENTINEL = {
    schemaVersion: 2,
    key: 'p2122-sentinel',
    name: 'p2122-sentinel',
    description: 'A definition that exists only to be looked for on the other side.',
    selectedAsUnqualifiedAlias: false,
    systemPrompt: 'Answer with the word sentinel.',
    sha256: 'x'.repeat(64),
    provenance: 'test',
    capabilityGeneration: 'gen-1',
    definitionDigest: 'd'.repeat(64),
  } as const

  /** anthropic — the SDK `agents` option is the mechanism. */
  const probeAnthropic = (): { verdict: Verdict; note: string } => {
    const withDefinition = buildClaudeRuntimeAgentOptions({ definitions: [SENTINEL], mini: false })
    const withNothing = buildClaudeRuntimeAgentOptions({ definitions: undefined, mini: false })
    // Negative control in the same breath: no definitions must produce no
    // `agents`, so a builder that hard-codes a key cannot read as a pass.
    if (Object.keys(withNothing).length) return { verdict: 'unsupported', note: 'builder emits agents with no definitions' }
    const names = Object.keys(withDefinition.agents ?? {})
    return names.includes(SENTINEL.key)
      ? { verdict: 'supported', note: `SDK agents option carries ${names.join(',')}` }
      : { verdict: 'unsupported', note: `SDK agents option carries ${names.join(',') || '<nothing>'}` }
  }

  /**
   * codex-runtime — driven at `writeCodexConfig`, ONE HOP HIGHER than the
   * builder (P2.135).
   *
   * `writeCodexConfig` is the exported function `CodexAgent.createRuntime` calls
   * (`codex-agent.ts:754`); it reaches `buildCodexAgentRoles` through the
   * module-private `codexAgentRolesFor`. Driving it means the probe now covers
   * the writer→builder hop AND the file layout a codex process actually reads:
   * the `[agents.<role>]` block in `config.toml` plus the role's own config file
   * under `agent-roles/`. What it still cannot enter is the agent→writer hop,
   * which `agentFeedsBuilder` pins instead.
   */
  const probeCodex = (): { verdict: Verdict; note: string } => {
    const home = mkdtempSync(join(tmpdir(), 'p2122-codex-'))
    try {
      const withNothing = writeCodexConfig({ codexHome: home, model: 'gpt-5-codex', adapterPort: 1 })
      // Negative control, on the same rig: with no definitions the writer must
      // emit no role block and no role directory, so a writer that hard-codes
      // one cannot read as a pass.
      if (readFileSync(withNothing, 'utf8').includes('[agents.')) {
        return { verdict: 'unsupported', note: 'writer emits an agents block with no definitions' }
      }
      const configPath = writeCodexConfig({
        codexHome: home,
        model: 'gpt-5-codex',
        adapterPort: 1,
        agents: [SENTINEL],
      })
      const toml = readFileSync(configPath, 'utf8')
      const roleDir = readdirSync(home).includes('agent-roles')
        ? readdirSync(join(home, 'agent-roles'))
        : []
      // A role that carries no developer instructions is not a dispatch.
      const carriesPrompt = roleDir.some(
        file => readFileSync(join(home, 'agent-roles', file), 'utf8').includes('developer_instructions'),
      )
      return toml.includes(`[agents.${SENTINEL.key}]`) && carriesPrompt
        ? { verdict: 'supported', note: `codex config carries [agents.${SENTINEL.key}] + ${roleDir.join(',')}` }
        : { verdict: 'unsupported', note: `codex role files: ${roleDir.join(',') || '<none>'} (prompt=${carriesPrompt})` }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  const PROBES: Partial<Record<ModelProvider, () => { verdict: Verdict; note: string }>> = {
    anthropic: probeAnthropic,
    'codex-runtime': probeCodex,
  }

  /**
   * The LAST hop, the one nothing here can drive: does the agent still feed its
   * own builder? (P2.135.)
   *
   * Each entry names the agent source and the call it must still contain, and
   * the count is CODE-ONLY — a commented-out call must not hold this hop, which
   * is the same lesson P2.122 measured one layer down.
   */
  const AGENT_HOPS: Partial<Record<ModelProvider, { source: string; call: string; control: string }>> = {
    anthropic: {
      source: '../claude-agent.ts',
      call: 'buildClaudeRuntimeAgentOptions({',
      control: 'class ClaudeAgent',
    },
    'codex-runtime': {
      source: '../codex-agent.ts',
      call: 'writeCodexConfig({',
      control: 'class CodexAgent',
    },
  }

  const probeAgentHop = (provider: ModelProvider): { verdict: Verdict; note: string } => {
    const hop = AGENT_HOPS[provider]
    if (!hop) return { verdict: 'skipped', note: 'no agent hop recorded' }
    const source = repoFile(hop.source)
    // Positive control: the right file, and the needle is being counted against
    // a source the stripper did not eat.
    if (!source.includes(hop.control)) {
      return { verdict: 'unsupported', note: `${hop.source} is not the file it should be` }
    }
    const calls = codeOccurrences(source, hop.call)
    return calls > 0
      ? { verdict: 'supported', note: `${hop.source} calls ${hop.call} ${calls}x in code` }
      : { verdict: 'unsupported', note: `${hop.source} no longer calls ${hop.call} in code` }
  }

  /**
   * The dimensions this block is ALLOWED to leave unmeasured, each with the
   * mechanism that blocks it. Anything not on this list must produce a concrete
   * verdict — a probe that silently stopped running fails rather than passes.
   */
  const DECLARED_SKIPS: Readonly<Record<string, string>> = {
    pi: 'the carrier is the payload built inside PiAgent.spawnSubprocess; it needs a live subprocess',
    'nestor-cloud-agent': 'no dispatch builder exists, which is the claim; absence is not observable here',
  }

  it('every member that has a reachable dispatch builder really dispatches', () => {
    const results = MODEL_PROVIDERS.map(provider => {
      const declared: Verdict = AGENT_DEFINITION_RUNTIMES.has(provider) ? 'supported' : 'unsupported'
      const probe = PROBES[provider]
      const observed = probe
        ? probe()
        : { verdict: 'skipped' as Verdict, note: DECLARED_SKIPS[provider] ?? 'no probe' }
      return { provider, declared, ...observed, verdict: reconcile(observed.verdict, declared) }
    })
    expect(results.filter(row => row.verdict === 'drift')).toEqual([])
    // ARMED: only the two providers named above may be skipped, and they are
    // named with a reason. This is the assertion the omnigent bench lacks —
    // theirs exits 0 when every probe skipped for want of credentials.
    expect(
      results.filter(row => row.verdict === 'skipped' && !(row.provider in DECLARED_SKIPS)),
    ).toEqual([])
    // …and the probes that DID run must actually be two, so a rename that
    // empties `PROBES` reads as a failure rather than as a clean sweep.
    expect(results.filter(row => row.verdict === 'supported').map(row => row.provider).sort())
      .toEqual(['anthropic', 'codex-runtime'])
  })

  it('the agent still feeds the builder each probe drives (P2.135)', () => {
    // The hop a driven probe cannot enter, reconciled as its own dimension so
    // the two facts are separable: "the builder dispatches" and "the agent
    // still calls the builder" fail with different messages.
    const results = MODEL_PROVIDERS.map(provider => {
      const declared: Verdict = AGENT_DEFINITION_RUNTIMES.has(provider) ? 'supported' : 'unsupported'
      const observed = provider in AGENT_HOPS
        ? probeAgentHop(provider)
        : { verdict: 'skipped' as Verdict, note: DECLARED_SKIPS[provider] ?? 'no agent hop recorded' }
      return { provider, declared, ...observed, verdict: reconcile(observed.verdict, declared) }
    })
    expect(results.filter(row => row.verdict === 'drift')).toEqual([])
    expect(
      results.filter(row => row.verdict === 'skipped' && !(row.provider in DECLARED_SKIPS)),
    ).toEqual([])
    // ARMED: the same shape as the row above — an emptied `AGENT_HOPS` must read
    // as a failure, not as a clean sweep.
    expect(results.filter(row => row.verdict === 'supported').map(row => row.provider).sort())
      .toEqual(['anthropic', 'codex-runtime'])
  })

  it('the behavioural answer and the source-derived answer agree where both exist', () => {
    // Two instruments, one claim. While the grep survives (it is the only
    // signal for `pi`), a disagreement between them is itself a finding.
    const behavioural = (Object.keys(PROBES) as ModelProvider[])
      .filter(provider => PROBES[provider]!().verdict === 'supported')
      .sort()
    const sourceDerived = (Object.keys(PROBES) as ModelProvider[])
      .filter(provider => AGENT_DEFINITION_RUNTIMES.has(provider))
      .sort()
    expect(behavioural).toEqual(sourceDerived)
  })
})

// ============================================================
// P2.124 · the property, instead of a twelfth list.
//
// An inventory taken for this row measured how the eleven sites hold their
// truth: SIX are compiler-total over a runtime union — a new member breaks the
// build there — and every other one is a `Set`, an array, a `Partial<Record>` or
// an if/else chain with a catch-all arm, so a new runtime is silently DEFAULTED.
// Eight of the fifteen per-provider dispatch sites in `factory.ts` default OPEN:
// a runtime nobody has described yet is GRANTED the capability.
//
// The obvious repair is a twelfth list enumerating what each runtime can do, and
// this plan has met the two-lists-must-agree failure six times. So the repair is
// the other one the row allows: ONE SOURCE, and a PROPERTY over it.
//
// The source is `agent/backend/runtime-vocabulary.ts` — the domain only, no
// capability claim anywhere in it. The property is:
//
//     A per-runtime capability site must be TOTAL over the vocabulary. Adding a
//     runtime must BREAK THE BUILD at the site, never inherit a default.
//
// It binds twice. The compiler enforces it wherever a site is
// `Record<AgentProvider, …>` — the strong form, since it fails before a test
// runs. This block enforces the runtime half, which catches what the compiler
// cannot: a record whose type was later widened to `Partial<Record>` or to
// `string`, and a key left behind by a rename that is decided for a runtime no
// longer in the union.
//
// Only the record-shaped sites reachable from `packages/shared` are here; the
// renderer's `runtime-switch-costs` rows are swept by the same property in the
// companion file.
//
// P2.283 · THIS PARAGRAPH USED TO EXEMPT THREE SITES, AND THE EXEMPTION WAS THE
// BUG. It read: the sites that are still SET-shaped
// (`AGENT_DEFINITION_RUNTIMES`, the peripheral runtime sets,
// `ANCHORED_PROVIDERS`) "are reported as row text rather than converted here:
// their fail-open/fail-closed behaviour is deliberate and separately asserted
// above, and flipping a `Set` to a `Record` changes what an unknown runtime
// gets." The first clause is what let P2.124 close claiming a TOTAL property
// while three of its own sites were exempt from it — a partial totality, which
// is worse than none because it is trusted. And the justification was false:
// each `Set` is now DERIVED from a total `Record`, the readers still call
// `.has()`, and an unknown runtime gets precisely what it got before.
//
// Measured rather than argued (isolated clone at `f58f66a36`): with a fifth
// member added to `ModelProvider`, `runtime-agent-support.ts` and
// `runtime-anchors.ts` compiled CLEAN while six other sites failed. They are in
// the sweep below now, and they fail the build first.
// ============================================================

describe('P2.124 · every per-runtime record decides every runtime', () => {
  const RECORD_SITES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
    'composer-capabilities.ts PROVIDER_DEFAULTS': PROVIDER_DEFAULTS,
    'factory.ts BACKEND_CAPABILITIES': BACKEND_CAPABILITIES,
    // P2.283 — the three the paragraph above used to exempt.
    'runtime-agent-support.ts AGENT_DEFINITION_DISPATCH': AGENT_DEFINITION_DISPATCH,
    // P6.175 — one record became three, and each joins the sweep the day it is
    // born. The fourth, `PLUGIN_HOOK_ACTION_RUNNERS`, is array-valued and total
    // over the same vocabulary.
    'runtime-agent-support.ts PLUGIN_MONITOR_SUPPORT': PLUGIN_MONITOR_SUPPORT,
    'runtime-agent-support.ts PLUGIN_LSP_SUPPORT': PLUGIN_LSP_SUPPORT,
    'runtime-agent-support.ts MCP_CHANNEL_PUSH_SUPPORT': MCP_CHANNEL_PUSH_SUPPORT,
    'runtime-agent-support.ts PLUGIN_HOOK_ACTION_RUNNERS': PLUGIN_HOOK_ACTION_RUNNERS,
    // P3.340 — the fifth record joins the sweep the day it is born, not a wave
    // later: the whole property is that a NEW runtime cannot inherit an answer.
    'runtime-agent-support.ts HOST_EDIT_TOOLING_SUPPORT': HOST_EDIT_TOOLING_SUPPORT,
    // P6.101 — the sixth record, joining the sweep the day it is born. It is
    // the first whose absence was visible in the SESSION LIST rather than in a
    // menu: the cold fallback answered `true` for every backend.
    'runtime-agent-support.ts SESSION_BRANCHING_SUPPORT': SESSION_BRANCHING_SUPPORT,
    'runtime-anchors.ts RUNTIME_ANCHOR_SUPPORT': RUNTIME_ANCHOR_SUPPORT,
  }

  it('is total over the vocabulary, in both directions', () => {
    for (const [name, site] of Object.entries(RECORD_SITES)) {
      expect(runtimesNotDecidedBy(site), `${name} leaves a runtime undecided`).toEqual([])
      expect(nonRuntimeKeysOf(site), `${name} decides a key that is not a runtime`).toEqual([])
    }
    // Positive control for both helpers on this rig: they are not constant-empty.
    expect(runtimesNotDecidedBy({ pi: 1 }).sort()).toEqual(
      [...MODEL_PROVIDERS].filter(provider => provider !== 'pi').sort(),
    )
    expect(nonRuntimeKeysOf({ 'pi-native': 1 })).toEqual(['pi-native'])
    // …and the sweep is non-empty, so an emptied registry cannot read as a pass.
    expect(Object.keys(RECORD_SITES).length).toBeGreaterThan(1)
  })

  // P2.283 · the three converted sites still export the SET/ARRAY shape their
  // readers use, and a derived collection is only worth the record behind it.
  // If someone re-transcribes one — the cheapest possible regression, since the
  // literal would be right on the day it was written — these fail.
  it('the exported collections are derived from the records, not transcribed', () => {
    const trueKeys = (record: Record<string, boolean>): ModelProvider[] =>
      Object.entries(record)
        .filter(([, value]) => value)
        .map(([key]) => key as ModelProvider)
        .sort()

    expect([...AGENT_DEFINITION_RUNTIMES].sort()).toEqual(trueKeys(AGENT_DEFINITION_DISPATCH))
    expect([...PLUGIN_MONITOR_RUNTIMES].sort()).toEqual(trueKeys(PLUGIN_MONITOR_SUPPORT))
    expect([...PLUGIN_LSP_RUNTIMES].sort()).toEqual(trueKeys(PLUGIN_LSP_SUPPORT))
    expect([...MCP_CHANNEL_PUSH_RUNTIMES].sort()).toEqual(trueKeys(MCP_CHANNEL_PUSH_SUPPORT))
    expect([...HOST_EDIT_TOOLING_RUNTIMES].sort()).toEqual(trueKeys(HOST_EDIT_TOOLING_SUPPORT))
    expect([...SESSION_BRANCHING_RUNTIMES].sort()).toEqual(trueKeys(SESSION_BRANCHING_SUPPORT))
    expect([...ANCHORED_PROVIDERS].sort()).toEqual(trueKeys(RUNTIME_ANCHOR_SUPPORT))

    // Boundary, and the one the old exemption paragraph claimed a conversion
    // would break: a record decides every runtime, so each collection must be a
    // PROPER subset — a `false` arm has to actually exclude. All three have at
    // least one, so none of these is a vacuous pass.
    for (const [collection, record] of [
      [AGENT_DEFINITION_RUNTIMES, AGENT_DEFINITION_DISPATCH],
      [PLUGIN_MONITOR_RUNTIMES, PLUGIN_MONITOR_SUPPORT],
      [PLUGIN_LSP_RUNTIMES, PLUGIN_LSP_SUPPORT],
      [MCP_CHANNEL_PUSH_RUNTIMES, MCP_CHANNEL_PUSH_SUPPORT],
      [HOST_EDIT_TOOLING_RUNTIMES, HOST_EDIT_TOOLING_SUPPORT],
      [SESSION_BRANCHING_RUNTIMES, SESSION_BRANCHING_SUPPORT],
      [new Set(ANCHORED_PROVIDERS), RUNTIME_ANCHOR_SUPPORT],
    ] as const) {
      expect(Object.values(record).filter(value => !value).length).toBeGreaterThan(0)
      expect(collection.size).toBeLessThan(Object.keys(record).length)
    }
  })

  it('the vocabulary is the one both unions come from', () => {
    // The value lists are the only runtime source; `LLM_PROVIDER_TYPES` is the
    // wider one and every member of it collapses onto a member of the narrower.
    expect([...AGENT_PROVIDERS].sort()).toEqual([...MODEL_PROVIDERS].sort())
    const collapsed = LLM_PROVIDER_TYPES.map(providerType => providerTypeToAgentProvider(providerType))
    expect(collapsed.filter(provider => !AGENT_PROVIDERS.includes(provider))).toEqual([])
    // Positive control: the collapse really is many-to-one, which is why trap
    // (a) in this file's header exists at all.
    expect(new Set(collapsed).size).toBeLessThan(LLM_PROVIDER_TYPES.length)
  })
})

// ============================================================
// P2.212 — the workflow-command dispatch claim.
//
// A saved workflow recipe is offered as `/name` on EVERY runtime, and its
// resolution carries a structured `workflowInvocation` in `ChatOptions`
// alongside the expanded `[workflow:<name>]` marker. Exactly one backend reads
// that option; on the others the option was ignored and the marker went to the
// model as prose. `BaseAgent.canDispatchWorkflowCommands()` is the claiming arm
// (`/approve`, P3.25, in shape and in reason), and this is its drift row: the
// claim must be held by the backends that hold the MECHANISM, never by a set
// someone remembered to update.
// ============================================================

describe('P2.212 · a backend claims workflow dispatch iff it consumes the invocation', () => {
  const backendSourceByProvider = {
    pi: '../pi-agent.ts',
    anthropic: '../claude-agent.ts',
    'codex-runtime': '../codex-agent.ts',
    'nestor-cloud-agent': '../nestor-cloud-agent.ts',
  } as const satisfies Record<ModelProvider, string>

  it('the claim and the consumption are the same set', () => {
    // `codeOccurrences`, not `occurrences`, for P2.122's recorded reason: in
    // `pi-agent.ts` the identifier ALSO appears inside the string literal
    // `ChatOptions['workflowInvocation']`, and a needle satisfied by a type
    // index is not a dispatch.
    const consumes = MODEL_PROVIDERS.filter(
      provider => codeOccurrences(repoFile(backendSourceByProvider[provider]), '.workflowInvocation') > 0,
    ).sort()
    const claims = MODEL_PROVIDERS.filter(
      provider => codeOccurrences(repoFile(backendSourceByProvider[provider]), 'canDispatchWorkflowCommands') > 0,
    ).sort()

    expect(claims).toEqual(consumes)
    // Positive control for both halves: an emptied registry, or a needle that
    // stopped matching anything, must not read as agreement-by-vacuum.
    expect(consumes.length).toBeGreaterThan(0)
    // …and it is a PROPER subset, so the row still has a negative side to fail
    // on. If every runtime ever claims dispatch, this line is the one to revisit
    // deliberately rather than the biconditional above going quietly green.
    expect(consumes.length).toBeLessThan(MODEL_PROVIDERS.length)
  })

  it('the base answer is fail-closed and the seam reads it before chatImpl', () => {
    const base = repoFile('../base-agent.ts')
    // Concrete, not abstract: a backend that overrides nothing still ANSWERS the
    // command. `false` is the safe default because the other default fails
    // silently — the marker reaches the model and reads as an ordinary prompt.
    expect(base).toContain('protected canDispatchWorkflowCommands(): boolean')
    // The gate is at the `chat()` seam, so `chatImpl` is never entered. Pinned
    // as source because the alternative — asserting no send happened — is what
    // `workflow-command-runtime-gate.test.ts` does behaviourally, and the two
    // together are what make a re-break visible from either direction.
    expect(base).toContain('options?.workflowInvocation && !this.canDispatchWorkflowCommands()')
  })

  /**
   * P3.34 · the CATALOG's copy of the same claim.
   *
   * The refusal above was correct and the row above pinned it — and the command
   * went on appearing in the menu anyway, so the only thing a user could do
   * with it was be told it is unavailable. `WORKFLOW_DISPATCH_SUPPORT` is the
   * third arm, read by `capabilities/resolver.ts`; it must answer exactly what
   * the backends do, or the catalog and the seam disagree again in the
   * direction that hurt before.
   */
  it('the catalog record claims dispatch for exactly those backends too', () => {
    const consumes = MODEL_PROVIDERS.filter(
      provider => codeOccurrences(repoFile(backendSourceByProvider[provider]), '.workflowInvocation') > 0,
    ).sort()
    const recordClaims = MODEL_PROVIDERS
      .filter(provider => WORKFLOW_DISPATCH_SUPPORT[provider])
      .sort()

    expect(recordClaims).toEqual(consumes)
    // Totality is a compile error for a MISSING arm; this catches the record
    // being widened to `Partial` or keyed by `string`, which compiles.
    expect(Object.keys(WORKFLOW_DISPATCH_SUPPORT).sort()).toEqual([...MODEL_PROVIDERS].sort())
    // The derived set and the predicate agree with the record they come from —
    // the resolver reads the predicate, not the record.
    expect([...WORKFLOW_DISPATCH_RUNTIMES].sort()).toEqual(recordClaims)
    for (const provider of MODEL_PROVIDERS) {
      expect(runtimeDispatchesWorkflows(provider)).toBe(WORKFLOW_DISPATCH_SUPPORT[provider])
    }
    // `undefined` is the workspace-scoped read, which has no session and
    // therefore no runtime: it must NOT report a definite unavailability, the
    // trap the two sibling predicates record at length.
    expect(runtimeDispatchesWorkflows(undefined)).toBe(true)
    // Positive controls, both directions: neither side may be vacuous, and the
    // set must keep a negative side to fail on.
    expect(recordClaims.length).toBeGreaterThan(0)
    expect(recordClaims.length).toBeLessThan(MODEL_PROVIDERS.length)
  })
})
