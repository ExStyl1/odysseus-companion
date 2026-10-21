/**
 * T5 (2026-08-20-cross-runtime-history-carry) — the renderer's per-runtime
 * restatements, asserted against the code that enforces them. The companion
 * file `packages/shared/src/agent/__tests__/runtime-capability-drift.test.ts`
 * covers the shared / session-tools axes; this one exists because its two
 * subjects are unreachable from `packages/shared`:
 *
 * - `runtimeForProviderType` (`runtime-switch-copy.ts`) — a deliberate local
 *   restatement of `providerTypeToAgentProvider` ("the two must be kept in
 *   step by hand"), un-importable there because the backend factory must not
 *   be dragged into the renderer bundle. A TEST may import both.
 * - the `runtime-switch-costs` rows — hand-measured `on` maps whose grounds
 *   live in `session-tools-core` and the backend sources. Deliberately not a
 *   NUMBER: this line said *five* from P2.315 (which made it six) until P6.52,
 *   under a green suite, and the module it describes has had the same sentence
 *   corrected twice for the same reason. A count beside a list is the AGENTS.md
 *   trap, and it fired three times inside these two files.
 *
 * THE ONE RULE OF THIS FILE: every membership below is DERIVED AT TEST TIME
 * from the enforcement site — the tool projections each backend actually
 * requests, the exported host-callback set, occurrence counts over the backend
 * sources — never transcribed as a literal count. (The review pass that
 * ordered this test hand-counted 27 `'pi-only'` hits where the file has 19;
 * a drift test seeded that way carries its own drift.) The provider-type
 * vocabulary is the one restatement, and it is exhaustiveness-checked by the
 * compiler in both directions (`satisfies Record<union, true>`); that anchor
 * binds at `bun run typecheck:electron`, since `bun test` does not typecheck.
 *
 * The two consolidation traps this plan records (key any future consolidated
 * record by `LlmProviderType`, never `AgentProvider`; a tri-state's no-claim
 * readers deliberately fail OPEN) are written out in the companion file's
 * header, next to the fail-open assertions.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  SESSION_TOOLS_REQUIRING_HOST_CALLBACK,
  SESSION_TOOLS_WITHHELD_FOR_NATIVE_EQUIVALENT,
  areTaskToolsEnabled,
  getSessionBackendToolNames,
  getSessionToolNames,
  isCronDisabled,
  CRON_TOOL_NAMES,
} from '@nessy-agent/session-tools-core'
import { providerTypeToAgentProvider } from '@nessy-agent/shared/agent/backend'
import { resolveComposerCapabilities } from '@nessy-agent/shared/agent/backend/composer-capabilities'
import type { LlmConnection } from '@nessy-agent/shared/config/llm-connections'
import {
  AGENT_PROVIDERS,
  LLM_PROVIDER_TYPES,
  nonRuntimeKeysOf,
  runtimesNotDecidedBy,
} from '@nessy-agent/shared/agent/backend/runtime-vocabulary'
import { NESTOR_CLI_BASE_PREFIX } from '@nessy-agent/shared/auth/nestor'
import { isNessyGatewayBaseUrl } from '@nessy-agent/shared/agent/backend/internal/drivers/upstream-target'
import type { ModelProvider } from '@nessy-agent/shared/config/models'

import type { SlashCommandId } from '@/components/ui/slash-command-menu'
import { dispatchSlashCommandAction } from '../slash-command-actions'
import { runtimeForProviderType, runtimeLabel } from '../runtime-switch-copy'
import { RUNTIME_SWITCH_COST_CLAIMS, runtimeSwitchCosts } from '../runtime-switch-costs'

// ============================================================
// The vocabulary — IMPORTED, no longer restated here (P2.124).
//
// This block held the same two `satisfies Record<union, true>` anchors the
// companion file held, so the two runtime unions were written out four times
// across two test files with nothing keeping them in step: the very shape
// P2.124 exists to remove, inside the drift test written to catch it. Both now
// come from `agent/backend/runtime-vocabulary.ts` — one source, checked in both
// directions, binding at `bun run typecheck:electron`.
// ============================================================

const MODEL_PROVIDERS = AGENT_PROVIDERS as readonly ModelProvider[]

// ============================================================
// `runtimeForProviderType` ↔ `providerTypeToAgentProvider`
// ============================================================

describe('runtimeForProviderType restates providerTypeToAgentProvider', () => {
  // The renderer's docblock: "The two must be kept in step by hand." This is
  // the hand, mechanised: for every member of the vocabulary the two answers
  // are equal. (Their out-of-union fallback arms differ — 'pi' here,
  // 'anthropic' behind an exhaustive-`never` in the factory — but no value of
  // the type reaches either, and the factory's is unreachable by
  // construction, so only the vocabulary is asserted.)
  it('answers identically for every LlmProviderType', () => {
    for (const providerType of LLM_PROVIDER_TYPES) {
      expect(runtimeForProviderType(providerType), providerType).toBe(
        providerTypeToAgentProvider(providerType),
      )
    }
  })

  /**
   * P2.216 — the arm this restatement FAILED OPEN through.
   *
   * It was a `switch` whose `default:` returned `'pi'`, and that arm swallowed
   * two different things: a member of `LlmProviderType` nobody had mapped (a
   * NEW RUNTIME, described to the user as Pi with nothing failing) and a string
   * in no union at all. The first is now a compile error — the mapping is a
   * `Record<LlmProviderType, …>` — and only the second keeps a fallback.
   *
   * The compiler half binds at `bun run typecheck:electron`, not here, so this
   * asserts the RUNTIME half: every vocabulary member resolves to a real
   * runtime under its own name rather than through the fallback, which is what
   * a re-introduced `default:` would silently undo for a member added later.
   */
  it('resolves every vocabulary member on its own, and falls back only for a string in no union', () => {
    for (const providerType of LLM_PROVIDER_TYPES) {
      // A member that reached the fallback would still answer `'pi'`, so
      // "not pi" alone proves nothing; assert the pairing with the factory,
      // which is compiler-total and throws on an unknown.
      expect(runtimeForProviderType(providerType), providerType)
        .toBe(providerTypeToAgentProvider(providerType))
    }
    // The out-of-union arm, driven rather than assumed: stored config gets no
    // per-field validation (P2.205), so this value really can arrive.
    expect(runtimeForProviderType('sonnet-of-nobody' as never)).toBe('pi')
    // …and the factory, whose job is construction rather than display, still
    // refuses it. The two answers differ ON PURPOSE and that is the pin.
    expect(() => providerTypeToAgentProvider('sonnet-of-nobody' as never)).toThrow()
  })

  it('labels every runtime under its own name, never through the fallback', () => {
    // `runtimeLabel`'s `default: 'Pi'` had the same shape: a new runtime would
    // have been LABELLED Pi in the badge and in every interpolated copy string.
    const labels = MODEL_PROVIDERS.map(provider => runtimeLabel(provider))
    expect(new Set(labels).size, labels.join(',')).toBe(MODEL_PROVIDERS.length)
    expect(labels.filter(label => label === 'Pi')).toHaveLength(1)
  })
})

// ============================================================
// Switch-target eligibility — the costs table refuses to speak about a
// runtime the composer does not offer switching for. Derived from the same
// resolver the composer reads (`connection.switchable`), so the two surfaces
// cannot disagree about WHO can move without failing here.
// ============================================================

describe('the costs table is silent exactly where the composer forbids switching', () => {
  const switchable = (provider: ModelProvider): boolean =>
    resolveComposerCapabilities({ provider }).connection.switchable

  it('a pair with a non-switchable end costs nothing (says nothing)', () => {
    for (const from of MODEL_PROVIDERS) {
      for (const to of MODEL_PROVIDERS) {
        if (switchable(from) && switchable(to)) continue
        expect(runtimeSwitchCosts(from, to), `${from} → ${to}`).toEqual([])
      }
    }
  })

  it('positive control: some switchable pair does cost something', () => {
    const anyCost = MODEL_PROVIDERS.some(from =>
      MODEL_PROVIDERS.some(
        to => switchable(from) && switchable(to) && runtimeSwitchCosts(from, to).length > 0,
      ),
    )
    expect(anyCost).toBe(true)
  })
})

// ============================================================
// The cost rows, re-derived from their enforcement sites — every one of them,
// with no count written down. See the header on why this line says no number.
//
// Each backend's surface is `getSessionToolNames(...)` with the exact options
// its enforcement site passes (the companion file asserts the wiring):
// Pi = `projection: 'pi'` (`agent/backend/pi/session-tool-defs.ts`), Claude =
// the default projection (`agent/session-scoped-tools.ts`), Codex =
// `externalStandaloneOnly` (`--external-standalone-only` handshake between
// `codex-agent.ts` and `session-mcp-server`).
//
// T5 — the codex spawn now also carries `--host-callback-port` whenever the
// per-session host-callback bridge started, which is every session that has a
// session and workspace id. The codex surface below is therefore the BRIDGED
// one: these rows describe what a user actually loses on a switch, and deriving
// them from a surface no shipping session runs would over-warn on five tools
// the runtime does have.
// ============================================================

const SWITCHABLE: readonly ModelProvider[] = MODEL_PROVIDERS.filter(
  provider => resolveComposerCapabilities({ provider }).connection.switchable,
)

/**
 * A derived claim — the same state the production rows carry, minus `null`.
 *
 * The test derives `null` for nothing: a runtime the rows are silent about is
 * excluded by `SWITCHABLE` before any of this runs, so the only values reachable
 * here are the two definite ones, P2.484's `'conditional'` and P6.562's
 * `'unmeasured'`.
 */
type Claim = boolean | 'conditional' | 'unmeasured'

const surfaces = (): Record<string, Set<string>> => ({
  pi: getSessionToolNames({ projection: 'pi' }),
  anthropic: getSessionToolNames(),
  'codex-runtime': getSessionToolNames({ externalStandaloneOnly: true, hostCallbackBridge: true }),
})

const sharedSource = (relative: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../../../../../../../packages/shared/src/agent/${relative}`, import.meta.url)),
    'utf8',
  )

/**
 * A source file anywhere in the repo — added by W6-d, because three of the four
 * rows it landed are enforced OUTSIDE `packages/shared/src/agent`: codex's OS
 * credential profile is written by the responses adapter, and the policy-key
 * asymmetry's enforcement site is a DOCUMENT rather than code.
 */
const repoSource = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../../../../../${relative}`, import.meta.url)), 'utf8')

const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1

/**
 * P6.597 — Claude Code's OWN built-in tool names, read from the vendored SDK.
 *
 * The derivations below enumerate the tools THIS REPO ships, which is why a row
 * whose claude tool is `pi-only` derived `anthropic: false`. P6.52 measured that
 * this is a blind spot rather than an answer: a claude session's model is also
 * handed Claude Code's own preset, so "our tool is not there" only means "the
 * capability is absent" when no built-in of the same name exists.
 *
 * Same instrument and same keying as
 * `runtime-switch-costs-native-claude-tools.test.ts` — `export interface
 * <Name>Input`, a deliberate LOWER bound, since missing a built-in
 * under-reports rather than inventing one. Kept as a second small reader rather
 * than an export, because that file's job is to pin the overlap and this one's
 * is to derive the claim; a shared helper would make one test's green depend on
 * the other's shape.
 *
 * At MODULE scope, and the reason is measured rather than assumed. The file is
 * 153 229 bytes and the read plus the regex costs ~160 ms on this tree at load
 * 11 — small, but this test derives fifteen `on` maps from source and it timed
 * out at 6 281 ms against bun's 5 s default when this reader was first added
 * inside its body.
 *
 * **The 6 281 ms was a COLD TRANSPILE CACHE, not this read and not contention,
 * and saying so matters more than the fix.** Same three files, same machine,
 * load 12 rather than 11, warm: the whole FIVE-file batch runs in 1 111 ms.
 * A cold run and a starved run present identically — a timeout with zero
 * assertion failures — and the separating control is a second run, not a
 * quieter machine. The hoist is kept anyway, because 160 ms of constant work
 * inside a timed body has no business being there; it is not what was wrong.
 */
const CLAUDE_NATIVE_TOOL_NAMES: ReadonlySet<string> = new Set(
  [...repoSource('node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts')
    .matchAll(/^export interface ([A-Za-z]+)Input\b/gm)].map(match => match[1]!),
)

describe('runtime-switch-costs rows match their enforcement sites', () => {
  it('runs with the default task/cron surface', () => {
    // Both flags shift the derived surfaces if a polluted env sets them; fail
    // naming the cause instead of deriving a different table.
    expect(areTaskToolsEnabled(), 'NESSY_ENABLE_TASKS is off in this test env').toBe(true)
    expect(isCronDisabled(), 'NESSY_DISABLE_CRON is set in this test env').toBe(false)
  })

  it('fires exactly the rows the enforcement sites imply, per direction', () => {
    const surface = surfaces()
    const has = (runtime: ModelProvider, tool: string): boolean =>
      surface[runtime]?.has(tool) ?? false

    // -- worktreeMove: EnterWorktree/ExitWorktree are advertised per surface.
    //
    //    P6.597 — and where OUR surface lacks them but Claude Code ships a
    //    built-in of the same name, the derivation yields `'unmeasured'` rather
    //    than `false`. Our surface cannot see Claude's preset, so its silence
    //    about a name Claude declares is a blind spot and not an absence.
    //
    //    C3.251 — that blind spot is RESOLVED for this row and for this row
    //    only. RS-28 drove claude's own `EnterWorktree` against a real
    //    repository at the packaged 1.36.0 sitting and it succeeded, so the
    //    claude arm below reads the checklist row instead of the tool list, with
    //    the `'unmeasured'` surface reading kept as its control. `scheduledRun`
    //    is untouched: nothing drove a notification.
    //
    //    P6.897 — the codex arm is derived from the REAL spawn's surface, for
    //    `scheduledRun`'s exact reason and by its exact method. `0f01dddeb`
    //    (P6.137) moved the row's codex cell `false` → `'conditional'` because
    //    the three worktree tools now cross the host-callback bridge behind
    //    `SessionToolFilterOptions.worktreePort`, which the shared `surfaces()`
    //    map deliberately does not model — so this derivation read `false`
    //    against a `'conditional'` cell and the row fired on
    //    `codex-runtime → anthropic` with nothing behind it.
    //
    //    The flag is applied HERE, on the one row it belongs to, and NOT folded
    //    into `surfaces()`: `bridgeTools` below is the difference between the
    //    bridged and bare codex surfaces, so widening the shared map would drop
    //    `EnterWorktree`/`ExitWorktree`/`WorktreeBatch` into that row — where
    //    claude's legitimate absence of them would read as claude losing the
    //    whole bridged set. That is the trap `notificationPort` is kept out of
    //    the map for (P6.184), one row over, and the same answer holds.
    //
    //    `'conditional'` and not `true` by the mechanism the row's own docblock
    //    names: `CodexAgent.startCallbackBridge` fails NON-FATALLY, so a session
    //    whose bridge did not start lives on the bare surface with no route to
    //    enter a worktree over. The bare surface is the control that separates
    //    the two.
    const native = CLAUDE_NATIVE_TOOL_NAMES
    // The instrument's own controls, here rather than only in the sibling file:
    // a set that matched everything would make every `'unmeasured'` below
    // vacuous, and a set that matched nothing would silently restore the `false`
    // this derivation is correcting.
    expect(native.has('PushNotification'), 'the vendored SDK is not the one measured').toBe(true)
    expect(native.has('EnterWorktree')).toBe(true)
    expect(native.has('SubmitPlan'), 'ours; the probe is matching too much').toBe(false)
    const claimForOurTools = (runtime: ModelProvider, tools: readonly string[]): Claim => {
      const absent = tools.filter(tool => !has(runtime, tool))
      if (absent.length === 0) return true
      // Every name our surface lacks is one Claude Code ships itself, so the
      // derivation is BLIND here rather than negative.
      return runtime === 'anthropic' && absent.every(tool => native.has(tool)) ? 'unmeasured' : false
    }
    // The bare codex surface — the control for every `'conditional'` codex claim
    // below. Read once here rather than three times: `worktreeMove`,
    // `bridgeTools` and `scheduledRun` all separate "advertised only with the
    // bridge" from "advertised at all" against this same set.
    const bareCodex = getSessionToolNames({ externalStandaloneOnly: true })
    const codexWorktreeSurface = getSessionToolNames({
      externalStandaloneOnly: true,
      hostCallbackBridge: true,
      worktreePort: true,
    })
    const worktreeTools = ['EnterWorktree', 'ExitWorktree'] as const
    // The port's own control: it must LIFT something here, or the arm below is
    // reading the bridged surface twice and its `'conditional'` is vacuous.
    expect(worktreeTools.filter(tool => !has('codex-runtime', tool)))
      .toEqual([...worktreeTools])
    // C3.251 — the claude arm is settled by a LIVE RUN, not by our tool list,
    // and the derivation says so rather than hard-coding a boolean.
    //
    // `claimForOurTools` answers `'unmeasured'` for claude and it is right about
    // what it can see: OUR `EnterWorktree`/`ExitWorktree` are not on that
    // surface, and the names it is blind to are ones Claude Code ships itself.
    // What the surface cannot see is whether the runtime's own tool DELIVERS —
    // and RS-28 drove exactly that at the packaged 1.36.0 sitting (arm A,
    // `EnterWorktree` against a real repository on a claude card: succeeded).
    // The checklist row is the durable record, so it is read.
    const rs28 = repoSource('docs/testing/cdp-live-checklist.md')
      .split('\n').find(line => line.startsWith('| RS-28 '))
    const worktreeOn = (runtime: ModelProvider): Claim => {
      if (runtime === 'anthropic') {
        // The control that keeps this arm a derivation: if our tools ever DO
        // cross to the claude surface, the blind spot is gone and this whole
        // paragraph has to be re-read rather than silently still returning
        // `true` for a different reason.
        expect(claimForOurTools('anthropic', worktreeTools),
          'our worktree tools reached the claude surface — re-derive this arm').toBe('unmeasured')
        expect(rs28, 'the RS-28 checklist row is gone').toBeDefined()
        return rs28!.includes('PASS') ? true : 'unmeasured'
      }
      if (runtime !== 'codex-runtime') return claimForOurTools(runtime, worktreeTools)
      if (!worktreeTools.every(tool => codexWorktreeSurface.has(tool))) return false
      return worktreeTools.every(tool => bareCodex.has(tool)) ? true : 'conditional'
    }

    // -- planApproval: SubmitPlan is advertised per surface, and its absence on
    //    Codex is the host-callback gate, not an ad-hoc choice.
    expect(SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has('SubmitPlan')).toBe(true)
    const planOn = (runtime: ModelProvider): boolean => has(runtime, 'SubmitPlan')

    // -- appActions: the tools present on the Claude surface and absent on the
    //    Codex one, minus SubmitPlan (counted by its own row). Derived as a
    //    set difference, never as a count; and every member must be excluded
    //    by a MECHANISM (the host-callback set or backend execution mode), so
    //    a tool that falls off the Codex surface for an unrelated reason
    //    cannot silently inflate this row's grounds.
    const backendTools = getSessionBackendToolNames()
    //
    //    A THIRD exclusion since `c324a0b8e` (P6.303), and it is not an app
    //    action at all: `SESSION_TOOLS_WITHHELD_FOR_NATIVE_EQUIVALENT` names a
    //    tool codex CAN run and should not, because the runtime brings its own
    //    (`TodoWrite` against codex's native `update_plan`). Measured, it is also
    //    absent from the PI projection — so counting it would make this row fire
    //    on anthropic → pi over a tool NEITHER side offers. Subtracted by the
    //    name of its mechanism rather than by name of the tool.
    const appActionTools = [...surface['anthropic'] ?? []].filter(
      tool => !has('codex-runtime', tool)
        && tool !== 'SubmitPlan'
        && !SESSION_TOOLS_WITHHELD_FOR_NATIVE_EQUIVALENT.has(tool),
    )
    expect(SESSION_TOOLS_WITHHELD_FOR_NATIVE_EQUIVALENT.size).toBeGreaterThan(0)
    expect(appActionTools.length).toBeGreaterThan(0)
    expect(
      appActionTools.filter(
        tool => !SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has(tool) && !backendTools.has(tool),
      ),
    ).toEqual([])
    const appActionsOn = (runtime: ModelProvider): boolean =>
      appActionTools.every(tool => has(runtime, tool))

    // -- bridgeTools (P2.484): the tools a codex session gets ONLY over the
    //    per-session host-callback bridge. Derived as the difference between
    //    the two codex surfaces — bridged minus bare — so the membership comes
    //    from `getSessionToolNames` and never from the row's own prose. The
    //    claim is TRI-STATE here and boolean everywhere else: a runtime that
    //    advertises all of them bare `has` them, one that advertises them only
    //    with the bridge flag has them CONDITIONALLY, and the dialog cannot tell
    //    which it will get because it is drawn before the session exists.
    //    `bareCodex` is read once, up beside `worktreeMove` — the first row that
    //    needs it — because three rows separate bridged from bare against it.
    const bridgeTools = [...surface['codex-runtime'] ?? []].filter(tool => !bareCodex.has(tool))
    // Positive control: an empty difference would make the row vacuously true on
    // every runtime and this whole derivation a no-op.
    expect(bridgeTools.length).toBeGreaterThan(0)
    // Every member must be excluded from the bare surface by the host-callback
    // MECHANISM, not by an unrelated filter — the same guard `appActions` runs.
    expect(bridgeTools.filter(tool => !SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has(tool))).toEqual([])
    const bridgeToolsOn = (runtime: ModelProvider): Claim => {
      if (!bridgeTools.every(tool => has(runtime, tool))) return false
      // Only codex has a second, barer surface to compare against; for the two
      // host-side runtimes the bridged and bare answers are the same object.
      if (runtime !== 'codex-runtime') return true
      return bridgeTools.every(tool => bareCodex.has(tool)) ? true : 'conditional'
    }

    // -- scheduledRun: the arm-now-be-told-later tools. The cron four come from
    //    the exported set the `NESSY_DISABLE_CRON` filter reads; Monitor and
    //    PushNotification are the row's two named non-cron members.
    //
    //    P6.597 — same correction as `worktreeMove`, and here it turns on ONE
    //    name. T3/T5 projected the cron four and `Monitor` onto both vendor
    //    surfaces, so `PushNotification` is the only member our claude surface
    //    lacks, and Claude Code declares a `PushNotification` of its own. The
    //    row's `anthropic` claim is therefore blind, not negative.
    const deferredTools = [...CRON_TOOL_NAMES, 'Monitor', 'PushNotification']
    //
    //    P6.184 — the codex arm is derived from the REAL spawn's surface, and
    //    the shared `surfaces()` map deliberately does not model it.
    //    `PushNotification` is gated a SECOND time by
    //    `SessionToolFilterOptions.notificationPort`, and folding that flag into
    //    the shared map would drop the name into `bridgeTools` above — where
    //    claude's legitimate absence of it would read as claude losing the whole
    //    bridged set. So the flag is applied here, on the one row it belongs to.
    //
    //    `'conditional'` for `bridgeTools`' reason and by its mechanism: the
    //    route lives on the host-callback bridge, `startCallbackBridge` fails
    //    NON-FATALLY, and a session whose bridge did not start has no route to
    //    notify over. The bare surface is the control that separates the two.
    const codexNotifiedSurface = getSessionToolNames({
      externalStandaloneOnly: true,
      hostCallbackBridge: true,
      notificationPort: true,
    })
    const scheduledOn = (runtime: ModelProvider): Claim => {
      if (runtime !== 'codex-runtime') return claimForOurTools(runtime, deferredTools)
      if (!deferredTools.every(tool => codexNotifiedSurface.has(tool))) return false
      return deferredTools.every(tool => bareCodex.has(tool)) ? true : 'conditional'
    }

    // -- preToolCheck: who sees a tool call before the runtime runs it. The
    //    measurement is `runPreToolUseChecks` occurrence counts over the
    //    backend sources (occurrences, not grep line counts — the miscount
    //    this file's header records). Positive control: the probe finds the
    //    call on the two runtimes that do check, so codex's zero is measured.
    //
    //    The needle is `runPreToolUseChecks(` — CALL-SHAPED, and this file's own
    //    warning about greps is why. `9d76ef12e` (wave 4) added a PROSE mention
    //    to `codex-agent.ts` — *"`runPreToolUseChecks` has zero call sites in
    //    this file (grep at HEAD: every hit is `pi-agent.ts`)"* — and the bare
    //    identifier probe read that sentence as an enforcement site, derived
    //    `preToolCheck` as present on codex, and dropped the row from
    //    `anthropic → codex-runtime`. This test has been red on that since, and
    //    the failure named a row nobody had touched. Measured at HEAD:
    //    bare 10/3/1, call-shaped 6/1/0 — and the codex comment is the whole
    //    difference in the third column, which is the one the row turns on.
    const preToolCounts = {
      pi: occurrences(sharedSource('pi-agent.ts'), 'runPreToolUseChecks('),
      anthropic: occurrences(sharedSource('claude-agent.ts'), 'runPreToolUseChecks('),
      'codex-runtime': occurrences(sharedSource('codex-agent.ts'), 'runPreToolUseChecks('),
    } as const
    // The prose mention really is there, so the correction above is measured
    // rather than defensive: without this the call-shaped needle could be
    // narrowing for no reason and nobody would know when it stopped mattering.
    expect(occurrences(sharedSource('codex-agent.ts'), 'runPreToolUseChecks')).toBeGreaterThan(0)
    expect(preToolCounts.pi).toBeGreaterThan(0)
    expect(preToolCounts.anthropic).toBeGreaterThan(0)
    const preToolOn = (runtime: ModelProvider): boolean =>
      (preToolCounts as Record<string, number>)[runtime]! > 0

    // -- guardianJudge (P2.315): OUR Guardian safety judge, the classifier that
    //    runs after the deterministic gate above. Same probe shape and same
    //    reason as `preToolCheck`: `consultGuardian` occurrence counts over the
    //    three backend sources, with a positive control on Pi so the other two
    //    zeros are measured rather than assumed. The needle is the CONSULT and
    //    not the word "guardian" deliberately — `codex-agent.ts` carries 26
    //    "guardian" hits and none of them is ours: they relay an override to
    //    Codex's own auto-review guardian (`thread/approveGuardianDeniedAction`),
    //    a vendor feature this row makes no claim about.
    const guardianCounts = {
      pi: occurrences(sharedSource('pi-agent.ts'), 'consultGuardian'),
      anthropic: occurrences(sharedSource('claude-agent.ts'), 'consultGuardian'),
      'codex-runtime': occurrences(sharedSource('codex-agent.ts'), 'consultGuardian'),
    } as const
    expect(guardianCounts.pi).toBeGreaterThan(0)
    const guardianOn = (runtime: ModelProvider): boolean =>
      (guardianCounts as Record<string, number>)[runtime]! > 0

    // -- outputStyleTiming (P3.227) — RETIRED by UB12.63 (2026-10-17).
    //
    //    It was derived by slicing each agent's source at its own `chatImpl` and
    //    asking whether the style COMPOSITION is resolved inside the turn: Pi
    //    and claude did, codex resolved it only at thread start. UB12.63 put a
    //    switched style's block on codex's next turn through
    //    `core/output-style-switch.ts` (claude's UB12.21 mechanism, behind the
    //    same `activeOutputStyle()` call, so this slice would have kept reading
    //    codex `false` after the fix: a stale pin that stays GREEN, AGENTS.md
    //    §Traps). All three runtimes now apply a mid-session pick to the next
    //    message, a row whose three cells are `true` can never fire, and the
    //    row is gone (P6.896's rule). The behaviour is pinned where it runs:
    //    `packages/shared/src/agent/__tests__/codex-output-style.test.ts`
    //    drives two codex turns across a switch, and
    //    `claude-output-style-switch.test.ts` does the same for claude.

    // -- autoCompactionOff (P3.234/P3.286): can the runtime be told to STOP
    //    auto-compacting? Two-sided, because the interesting answer is an
    //    absence and this row's own history is a claim that was measured false.
    //
    //    Control: all three backends READ the host's one policy
    //    (`BackendConfig.autoCompaction`), so a zero on the mechanism side is
    //    about the MECHANISM and not about the setting failing to reach the
    //    runtime. Codex is the case that makes the control necessary — it reads
    //    the off state and its entire response is a debug line saying it has no
    //    off-switch, so a probe that only asked "does this backend read the
    //    setting" would answer yes for all three and derive no row at all.
    //
    //    The mechanism side is a MATRIX rather than one needle per runtime:
    //    every source is probed with every off-switch name, so a runtime that
    //    adopted a sibling's mechanism would show rather than being scored
    //    absent by a needle chosen for someone else. Pi sends
    //    `set_auto_compaction` to the subprocess (`requestSetAutoCompaction`);
    //    Claude sets `DISABLE_AUTO_COMPACT` into `envOverrides`; codex scores
    //    zero on all of them.
    //
    //    Residual, stated rather than papered over: a source probe in a renderer
    //    test cannot re-drive a binary. Codex's "cannot" is settled by
    //    `ConfigToml` at `rust-v0.148.0` and by driving the shipped
    //    `codex-app-server`, both recorded on the row in `runtime-switch-costs.ts`
    //    and pinned by `config-writer-auto-compaction.test.ts`. This probe
    //    grounds the HOST's three-way claim; it does not restate that binary
    //    measurement.
    const compactionSources = {
      pi: sharedSource('pi-agent.ts'),
      anthropic: sharedSource('claude-agent.ts'),
      'codex-runtime': sharedSource('codex-agent.ts'),
    } as const
    for (const [runtime, source] of Object.entries(compactionSources)) {
      expect(
        occurrences(source, 'autoCompaction'),
        `${runtime} never reads the host auto-compaction policy`,
      ).toBeGreaterThan(0)
    }
    const offSwitchNeedles = [
      'requestSetAutoCompaction',
      'set_auto_compaction',
      'DISABLE_AUTO_COMPACT',
    ] as const
    const autoCompactionOffOn = (runtime: ModelProvider): boolean => {
      const source = (compactionSources as Record<string, string | undefined>)[runtime]
      if (source === undefined) return false
      return offSwitchNeedles.some(needle => occurrences(source, needle) > 0)
    }

    // 10. P3.342's `web_search` derivation was DELETED here by P6.896, not
    //     lost: the `webSearch` row it derived is retired, because P6.148
    //     built the host's own `web_search` on both runtimes that lacked one
    //     and a row whose three cells are all `true` can never fire. The two
    //     facts this derivation was carrying are kept where they still bind:
    //     the DEFAULT claude surface must NOT contain `web_search` (a
    //     passthrough session keeps the vendor's native tool and must not be
    //     shown two) — pinned by `agent/__tests__/session-scoped-host-web-search.test.ts`
    //     over `withHostPortGate`'s own default — and codex's offer rides
    //     `externalStandaloneOnly`, pinned by the same file. Re-adding a row
    //     here needs a NEW set difference, not this one.

    // 11. P6.65 — the OS-enforced credential exclusion, the FIRST row in this
    //     table whose capability belongs to codex rather than to Pi.
    //
    //     All three enforce the same 19 `deniedPaths` entries; what differs is
    //     the LAYER. Codex mirrors them into its own `[permissions.<profile>]`
    //     filesystem block (`resolveCodexRuntimePathPolicy`, emitted for every
    //     real session), which the OS applies to everything the app-server does
    //     — its `shell` included. Ours is tool-mediated on both other runtimes,
    //     so a `Bash` command walking a directory ABOVE a denied entry names no
    //     denied path, matches nothing, and returns the contents whole.
    //
    //     The two `false`s therefore need a control of their own, and it is the
    //     assertion below this one: they must not read as "no floor here".
    const codexConfigWriter = repoSource('packages/codex-responses-adapter/src/config-writer.ts')
    const credentialShellFloorOn = (runtime: ModelProvider): Claim =>
      runtime === 'codex-runtime'
        && occurrences(codexConfigWriter, 'resolveCodexRuntimePathPolicy') > 0

    // 12. P6.128 — a subagent's OWN worktree, decided by the host before the
    //     subagent runs. Not `worktreeMove`, which is the model asking
    //     mid-session through `EnterWorktree`.
    //
    //     `piRuntimeAgentWorktreePolicy` is the whole enforcement site and it
    //     exists on the Pi side alone: claude forwards the DECLARATION and never
    //     applies the tools rule, and codex has no worktree wire at all.
    //
    //     THE NEEDLE CARRIES A PAREN, and that is not tidiness: the bare name
    //     scores 1 in `claude-runtime-agents.ts`, inside the comment that says
    //     the rule is deliberately NOT mirrored there. A substring probe read
    //     that as claude HAVING it and the derivation fired the row on Claude →
    //     Codex, where nothing is lost. A name in a comment is not a call — the
    //     same class of mistake this file's header records for counts.
    const worktreePolicySources: Record<string, string | undefined> = {
      pi: sharedSource('pi-harness/runtime-agent-definition.ts'),
      anthropic: sharedSource('claude-runtime-agents.ts'),
      'codex-runtime': sharedSource('codex-agent.ts'),
    }
    const subagentWorktreeOn = (runtime: ModelProvider): Claim => {
      const source = worktreePolicySources[runtime]
      return source !== undefined && occurrences(source, 'piRuntimeAgentWorktreePolicy(') > 0
    }

    // 13. P6.124 — a subagent starting subagents of its own. The claim is about
    //     the UNSET default, so the discriminator is codex's own defaults, which
    //     the config writer records verbatim from `rust-v0.148.0`:
    //     `DEFAULT_AGENT_MAX_THREADS = Some(6)` and `DEFAULT_AGENT_MAX_DEPTH = 1`
    //     against three layers on the other two. Derived from that sentence
    //     rather than from the KNOB, because both knobs bind on all three when an
    //     operator sets them and a knob probe would score codex `true`.
    //     F1.1132: one of the TWO claims that read a comment on purpose (the other
    //     is reasoningCarry's codex gateway leg) — the writer records codex's upstream
    //     default there, and no code here states it (`max_depth` is emitted only when set).
    const subagentNestingOn = (runtime: ModelProvider): Claim =>
      runtime === 'codex-runtime'
        ? !(occurrences(codexConfigWriter, 'DEFAULT_AGENT_MAX_DEPTH = 1') > 0)
        : true

    // 14. P6.170 — the 32 documented Claude policy and security switches.
    //
    //     THE ENFORCEMENT SITE IS A DOCUMENT, and saying so is more honest than
    //     inventing a code probe: these are names the vendored `claude` binary
    //     reads and nothing in this tree does, so there is no host-side site to
    //     grep. `runtime-capability-gaps.md`'s tiered table is where they are
    //     counted, and the parity suite compares that count against the shipped
    //     sentence. Here the derivation only has to agree about WHO honours
    //     them, and the document's own rank-2 row is read for it.
    const gapsDoc = repoSource('docs/architecture/runtime-capability-gaps.md')
    const policyKeysOn = (runtime: ModelProvider): Claim =>
      runtime === 'anthropic'
        && occurrences(gapsDoc, '32 documented Claude policy and security switches') > 0

    // 15. P6.346(a) — the operator's tool memory cap.
    //
    //     THE ENFORCEMENT SITE IS THE VENDORED BINARY, and the honest derivation
    //     says so: `CLAUDE_CODE_TOOL_MEMORY_LIMIT` is read by the shipped
    //     `claude` on Linux and WSL and by nothing in this tree, so the host-side
    //     probe can only establish the two ABSENCES. It does that BY PATH, never
    //     by a grep count (P6.598 — the grep matches prose about the name, so a
    //     count includes the sentence that states it): the one load-bearing site
    //     under `packages/`/`apps/` is the ceiling test's `OTHER_CEILINGS`
    //     PASS-THROUGH list, which asserts the name reaches the child's env and
    //     not that anything here interprets it. The claude arm is derived from
    //     the same document that carries the binary's verbatim platform gate, as
    //     `'unmeasured'` rather than as a yes.
    const toolMemoryCapOn = (runtime: ModelProvider): Claim =>
      runtime === 'anthropic'
        && occurrences(gapsDoc, 'if(e!=="linux"&&e!=="wsl")') > 0
        ? 'unmeasured'
        : false

    // 16. P6.382 — a subagent's own OUTPUT, while the child is still working.
    //
    //     The row's premise inverted under it: it was born saying claude could
    //     not stream a subagent's text, and `forwardSubagentText` is the SDK's
    //     own option, set by `claude-agent.ts` since `a8377a7fb`. Pi is the
    //     runtime that only counts — `subagent-tool.ts` raises `toolCalls` and
    //     writes `event.type` into `lastActivity`, and forwards the child's text
    //     on no branch. So Pi's arm is an ABSENCE and gets the control this file
    //     gives every absence: `lastActivity` must be found in the same file, or
    //     a renamed path would read as "Pi does not forward" for the wrong
    //     reason. Codex is `'unmeasured'` deliberately — K5's codex arm was
    //     refuted twice (P3.294/P3.295), so deriving a `false` here would repeat
    //     that error inside the guard built to catch it.
    const piSubagentTool = repoSource('packages/pi-agent-server/src/orchestrator/subagent-tool.ts')
    expect(occurrences(piSubagentTool, 'lastActivity')).toBeGreaterThan(0)
    const subagentOutputTextOn = (runtime: ModelProvider): Claim =>
      runtime === 'codex-runtime'
        ? 'unmeasured'
        : occurrences(
          runtime === 'anthropic' ? sharedSource('claude-agent.ts') : piSubagentTool,
          'forwardSubagentText',
        ) > 0

    // 17. P6.296 — the THIRD answer a `PreToolUse` hook can give: hold the call
    //     and resume it later, rather than allow or deny it.
    //
    //     Each arm reads the runtime's own event surface for the wire name.
    //     Codex's arm is the ABSENCE, so it gets the control this file gives
    //     every absence, and a second one a level up: its event adapter scores 0
    //     for the wire name while scoring 7 for `Approval` in CODE (F1.1132, the
    //     control below: the file is read and it does carry an approval
    //     vocabulary), and the generated protocol's own barrel — 638 exports on
    //     2026-10-09 — scores 0 for `Defer` against 40 for `Approval`. So the zero is a
    //     measurement of a tree that was read, not of a path that moved.
    const codexProtocolBarrel = repoSource('packages/codex-protocol/generated/v2/index.ts')
    expect(occurrences(codexProtocolBarrel, 'Approval')).toBeGreaterThan(0)
    expect(occurrences(codexProtocolBarrel, 'Defer')).toBe(0)
    const deferSourceOf: Record<string, string> = {
      pi: sharedSource('pi-agent.ts'),
      anthropic: sharedSource('backend/claude/event-adapter.ts'),
      'codex-runtime': sharedSource('backend/codex/event-adapter.ts'),
    }
    // F1.1132: both needles are CODE. The control's lower-case `approval` and
    // Pi's `deferred_tool_use` matched only comments (5 and 2 hits, 0 in code),
    // so Pi scored `true` off prose; `deferredToolUse` is the binding Pi and the claude adapter
    // read (code hits: pi-agent.ts 4, two inside `deferredToolUsePayload`; claude 3), codex 0.
    expect(occurrences(deferSourceOf['codex-runtime']!, 'Approval')).toBeGreaterThan(0)
    const preToolDeferOn = (runtime: ModelProvider): Claim =>
      occurrences(deferSourceOf[runtime] ?? '', 'deferredToolUse') > 0

    // -- readFence (P6.928): the operator's fence on reads outside the working
    //    directories, and the one runtime it has no subject on.
    //
    //    Two arms measured at DIFFERENT sites, because the fence has two halves
    //    and either alone is satisfiable by a rename.
    //
    //    Pi and claude are PRESENCES with both halves required. The fence's own
    //    vocabulary — `READS_OUTSIDE_WORKING_DIRECTORIES_TOOLS` in
    //    `agent/mode-manager.ts` — must contain the runtime's read tool names,
    //    read out of the SET LITERAL rather than out of the file, because the
    //    comment above that set spells `Read, Grep, Glob` in prose and an
    //    unquoted needle would be satisfied by the sentence explaining the
    //    vocabulary instead of by the vocabulary. And the runtime must reach a
    //    gate that passes the setting, which is the call-shaped
    //    `runPreToolUseChecks(` count `preToolCheck` above already measures —
    //    for exactly the reason recorded there, that the bare identifier reads a
    //    comment in `codex-agent.ts` as an enforcement site.
    //
    //    Codex is the ABSENCE, and it gets a control of its own rather than the
    //    shared gate count, because the REASON is different: no host gate can
    //    fire because codex raises no read approval at all.
    //    `codex-protocol/generated/ServerRequest.ts` is the complete set of
    //    requests codex initiates toward this client — it scores 0 for `Read`
    //    while scoring 3 for `requestApproval`, so the zero is a measurement of a
    //    union that WAS read and that demonstrably carries an approval
    //    vocabulary, rather than of a path that moved.
    const modeManagerSource = sharedSource('mode-manager.ts')
    const readFenceVocabulary = ((): string => {
      const at = modeManagerSource.indexOf('READS_OUTSIDE_WORKING_DIRECTORIES_TOOLS = new Set([')
      const end = at < 0 ? -1 : modeManagerSource.indexOf('])', at)
      return at < 0 || end < 0 ? '' : modeManagerSource.slice(at, end)
    })()
    // The slice really is the set, so an empty-slice pass is impossible.
    expect(readFenceVocabulary.length, 'the read fence vocabulary moved').toBeGreaterThan(40)
    const codexServerRequests = repoSource('packages/codex-protocol/generated/ServerRequest.ts')
    expect(
      occurrences(codexServerRequests, 'requestApproval'),
      'the codex request union is not the one measured',
    ).toBeGreaterThan(0)
    const READ_TOOLS_OF: Record<string, readonly string[]> = {
      pi: ["'Find'", "'Ls'"],
      anthropic: ["'Read'", "'Grep'", "'Glob'"],
    }
    const readFenceOn = (runtime: ModelProvider): Claim => {
      if (runtime === 'codex-runtime') return occurrences(codexServerRequests, 'Read') > 0
      // Unreachable: `SWITCHABLE` is the only thing that calls this, and the
      // three runtimes in it are all covered above. `false` rather than `null`
      // because `Claim` here is the EMITTED vocabulary and carries no `null` —
      // a runtime the table declines to describe is excluded upstream by
      // `isSwitchableRuntime`, not answered here.
      const names = READ_TOOLS_OF[runtime]
      if (!names) return false
      return names.every(name => occurrences(readFenceVocabulary, name) > 0)
        && (preToolCounts as Record<string, number>)[runtime]! > 0
    }

    // 18. P6.696 — an operator's background-task off switch, and the one
    //     runtime with nothing to project it onto.
    //
    //     Two arms are PRESENCES read at their own enforcement sites:
    //     `backgroundTasksDisabled()` is the single predicate every detach site
    //     consults, and the claude arm is the projection of it onto the child's
    //     own `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` (`6981d9950`), so each is
    //     read in the file that performs it rather than from a list.
    //
    //     The codex arm is the ABSENCE, and it gets the control this file gives
    //     every absence: codex's own config schema is the denominator, it is
    //     searched for a disabling key and scores zero, while
    //     `background_terminal_max_timeout` in the same file scores non-zero —
    //     so the zero is a measurement of a schema that WAS read, and of a
    //     runtime that demonstrably has background terminals, rather than of a
    //     path that moved.
    const codexConfigSchema = repoSource('packages/codex-protocol/schema/config-schema.json')
    expect(
      occurrences(codexConfigSchema, 'background_terminal_max_timeout'),
      'the codex config schema is not the one measured',
    ).toBeGreaterThan(0)
    const backgroundTaskOffSwitchOn = (runtime: ModelProvider): Claim =>
      runtime === 'codex-runtime'
        ? occurrences(codexConfigSchema, 'disable_background') > 0
        : occurrences(
          runtime === 'anthropic'
            ? sharedSource('options.ts')
            : repoSource('packages/pi-agent-server/src/orchestrator/spawner.ts'),
          'backgroundTasksDisabled',
        ) > 0

    // 19. P6.96 — an operator's auto-compaction WINDOW and THRESHOLD.
    //
    //     A DIFFERENT question from row 9 above (`autoCompactionOff`, whether
    //     compaction can be turned off at all): this one is about WHEN it fires.
    //
    //     THE OBVIOUS INSTRUMENT GETS TWO OF THREE CELLS BACKWARDS, and that is
    //     why each runtime is read at the site that CONSUMES the values rather
    //     than by grepping the two field names on each agent. Measured at HEAD:
    //     `pi-agent.ts` names NEITHER field — it forwards the whole policy with
    //     a spread (`this.send({ type: 'set_auto_compaction', id, ...policy })`),
    //     so a field grep scores 0 and reads as "Pi ignores them"; and
    //     `codex-agent.ts` names `thresholdPercent` THREE times, all of them
    //     inside the operator notice that says the knobs do nothing, so the same
    //     grep scores non-zero and reads as "codex honours them". Both inverted.
    //
    //     - **Pi — `true`.** `packages/pi-agent-server/src/auto-compaction-settings.ts`
    //       reads `policy.contextWindow` and `policy.thresholdPercent` and computes
    //       the trigger from them.
    //     - **Claude — `true`.** `claude-auto-compaction-knobs.ts` projects them onto
    //       `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. (The SDK's 100 000 floor is reported on
    //       that session's own transcript; the knob IS read, which is what this row
    //       claims — see the row's own docblock for why `'conditional'` would be worse
    //       in both directions.)
    //     - **Codex — `false`, and the ABSENCE gets the control this file gives every
    //       absence.** `codex-agent.ts` is measured to announce the inertness itself
    //       (the operator notice), and `config-writer.ts` to compute codex's trigger
    //       from the host constant INSTEAD of the settings (F1.1132) — so the zero is a
    //       reading of files that were read, and of a runtime that demonstrably has a trigger.
    const piCompactionConsumer = repoSource('packages/pi-agent-server/src/auto-compaction-settings.ts')
    const claudeCompactionKnobs = sharedSource('claude-auto-compaction-knobs.ts')
    const codexAgentSource = sharedSource('codex-agent.ts')
    // F1.1132: the constant is read where codex's trigger is COMPUTED, in the
    // config writer; `codex-agent.ts` names it only in a comment.
    const codexCompactTrigger = 'contextWindow * AUTO_COMPACT_WINDOW_FRACTION'
    expect(
      occurrences(codexConfigWriter, codexCompactTrigger),
      'codex no longer computes its trigger from the host constant — re-read the row before trusting the false',
    ).toBeGreaterThan(0)
    expect(
      occurrences(codexAgentSource, 'has no effect on codex'),
      'the codex operator notice that states the knobs are inert has moved — the false is unsupported',
    ).toBeGreaterThan(0)
    const autoCompactionKnobsOn = (runtime: ModelProvider): Claim => {
      if (runtime === 'pi') {
        return occurrences(piCompactionConsumer, 'policy.contextWindow') > 0
          && occurrences(piCompactionConsumer, 'policy.thresholdPercent') > 0
      }
      if (runtime === 'anthropic') return occurrences(claudeCompactionKnobs, 'CLAUDE_CODE_AUTO_COMPACT_WINDOW') > 0
      // Codex: the two knob NAMES appear only in the notice, so the claim is read
      // off the knob the runtime actually triggers on — a constant, not a setting.
      return runtime === 'codex-runtime'
        ? occurrences(codexConfigWriter, codexCompactTrigger) === 0
        : false
    }

    // 20. P6.157 — a tool call filling in on screen while the model writes it.
    //
    //     One mechanism, one module, three adapters: `partial-tool-input.ts`
    //     re-emits `tool_start` for the same `toolUseId` with a growing `input`.
    //     Whether an adapter IMPORTS it is the whole claim, so the needle is the
    //     module path and it is identical for all three — no per-runtime spelling
    //     to get wrong, and a rename breaks every cell at once rather than
    //     silently flipping one.
    //
    //     The codex zero is an absence, so it carries its own control: the codex
    //     adapter is read (it has content and handles its own deltas) and the
    //     module it does not import is read too.
    const partialToolInputModule = sharedSource('backend/partial-tool-input.ts')
    expect(
      occurrences(partialToolInputModule, 'parsePartialToolInput'),
      'the partial-tool-input module is not the one measured',
    ).toBeGreaterThan(0)
    const liveToolInputSources: Record<string, string> = {
      pi: sharedSource('backend/pi/event-adapter.ts'),
      anthropic: sharedSource('backend/claude/event-adapter.ts'),
      'codex-runtime': sharedSource('backend/codex/event-adapter.ts'),
    }
    for (const [runtime, source] of Object.entries(liveToolInputSources)) {
      // F1.1132: `toolUseId`, not `tool_start` — codex's adapter names the event
      // only in comments (3 hits, 0 in code), so that control read prose.
      expect(occurrences(source, 'toolUseId'), `${runtime}'s event adapter is not the one measured`)
        .toBeGreaterThan(0)
    }
    const liveToolInputOn = (runtime: ModelProvider): Claim => {
      const source = liveToolInputSources[runtime]
      if (source === undefined) return false
      return occurrences(source, 'partial-tool-input') > 0
    }

    // 21. P6.391 — instructions that depend on WHICH FILE is being touched.
    //
    //     One gate, named once: `BaseAgent.deliversPathScopedActivations` is
    //     `false` by default and overridden in exactly the two agents that
    //     deliver them. So the needle is that identifier, read on each agent's
    //     own source, with `base-agent.ts` as the control that the identifier
    //     still exists at all — a rename would otherwise zero all three cells and
    //     read as "nobody delivers them".
    //
    //     NOT probed on `runPreToolUseChecks`, which the row's docblock also
    //     names: measured at HEAD, that identifier occurs TWICE in
    //     `codex-agent.ts` and both are COMMENTS saying it has no call sites
    //     there — so a raw occurrence count reads the explanation as the
    //     capability. The same shape AGENTS.md records for a shape assertion that
    //     reads the docblock quoting the defect it removed.
    const pathScopedGate = 'deliversPathScopedActivations'
    expect(
      occurrences(sharedSource('base-agent.ts'), pathScopedGate),
      'the path-scoped activation gate has been renamed — every cell below would read false',
    ).toBeGreaterThan(0)
    const pathScopedInstructionsOn = (runtime: ModelProvider): Claim => {
      const source = runtime === 'pi'
        ? sharedSource('pi-agent.ts')
        : runtime === 'anthropic'
          ? sharedSource('claude-agent.ts')
          : runtime === 'codex-runtime' ? codexAgentSource : undefined
      if (source === undefined) return false
      return occurrences(source, pathScopedGate) > 0
    }

    // ============================================================
    // P6.683 — the seven rows the guard did not ground.
    //
    // `expect` throws on the FIRST mismatched pair, so "three rows short" was a
    // floor and not a count: W8-td grounded three and seven more surfaced behind
    // them. Each of the seven gets a probe on the source that decides it and a
    // control that fails when the probe stops measuring anything — a needle that
    // matches nothing zeroes a row silently, which is the failure mode a drift
    // test exists to prevent.
    // ============================================================

    const piAgentSource = sharedSource('pi-agent.ts')
    const claudeAgentSource = sharedSource('claude-agent.ts')
    const agentSourceFor = (runtime: ModelProvider): string | undefined =>
      runtime === 'pi'
        ? piAgentSource
        : runtime === 'anthropic'
          ? claudeAgentSource
          : runtime === 'codex-runtime' ? codexAgentSource : undefined

    // 22. P6.201 — a run of refused actions ends Auto mode BY ITSELF.
    //
    //     `autoClassifierBlocks` is Pi's session-scoped counter, and the thing
    //     this row prices is the MODE change it makes at 3-in-a-row or 20.
    //
    //     The two `false`s mean "no mode change", never "nothing counts", and
    //     the control says so: the shared per-turn breaker exists and codex's own
    //     is report-only. Without it a reader takes the `false`s for "this
    //     runtime has no denial accounting at all", which is the opposite of true.
    expect(
      occurrences(sharedSource('mode-manager.ts'), 'formatAutoDenialBreakerClause'),
      'the model-facing half of the breaker clause has moved — the pi cell is unsupported',
    ).toBeGreaterThan(0)
    expect(
      occurrences(sharedSource('core/guardian-consult.ts'), 'GUARDIAN_CONSECUTIVE_DENY_LIMIT'),
      'the shared per-turn breaker is gone — the two falses would then mean something else',
    ).toBeGreaterThan(0)
    const autoDenialBreakerOn = (runtime: ModelProvider): Claim =>
      occurrences(agentSourceFor(runtime) ?? '', 'autoClassifierBlocks') > 0

    // 23. P6.262 — codex's own approval reviewer, and the policy text it reads.
    //
    //     The reviewer is a codex CONFIG-FILE key, so the site that decides it is
    //     the config writer and not an agent file. The needle is the whole WRITE
    //     (F1.1132, below), not the bare TOML key `auto_review`, measured: that
    //     scores 1 in `pi-agent.ts` and the hit is PROSE about codex's blob — the
    //     same shape the `runPreToolUseChecks` note above records, where a
    //     docblock explaining an absence reads as the capability.
    const reviewerWriter = repoSource('packages/codex-responses-adapter/src/config-writer.ts')
    expect(
      occurrences(repoSource('packages/shared/src/config/config-defaults-schema.ts'), 'codexAutoReviewEnabled'),
      'the reviewer setting has been renamed — every cell below would read false',
    ).toBeGreaterThan(0)
    // F1.1132: the setting name reached the writer only in its docblock (1 hit,
    // 0 in code), so codex scored `true` off prose. The needle is now the WRITE
    // itself — the whole TOML line as the writer emits it, which no prose spells
    // and no other runtime's source carries — and the pi-agent prose control
    // that guarded the bare `auto_review` is retired with it.
    // Joined so the source holds no literal `${` inside a plain string.
    const reviewerWrite = ['approvals_reviewer = ', '$', "{tomlString('auto_review')}"].join('')
    const codexReviewerOn = (runtime: ModelProvider): Claim =>
      occurrences(
        runtime === 'codex-runtime' ? reviewerWriter : (agentSourceFor(runtime) ?? ''),
        reviewerWrite,
      ) > 0

    // 24. P6.262, ledger D5 — the claude GATEWAY child runs off the vendor's
    //     network, so its own feature flags, telemetry and discovery stop.
    //
    //     INVERTED: the presence of the write is the ABSENCE of the capability.
    //     And the needle carries its colon on purpose — the bare name scores 1 in
    //     `codex-agent.ts` and that hit is a COMMENT, so a plain count would
    //     report codex as losing a flag it never sets. Both halves are asserted,
    //     so the day the prose moves the trap is re-read rather than inherited.
    const nonEssentialWrite = 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '
    expect(
      occurrences(codexAgentSource, 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'),
      'the codex prose hit is gone — the colon in the needle is no longer load-bearing',
    ).toBeGreaterThan(0)
    expect(occurrences(codexAgentSource, nonEssentialWrite), 'codex now WRITES the flag').toBe(0)
    expect(
      occurrences(claudeAgentSource, nonEssentialWrite),
      'the gateway env override has moved — the anthropic false is unsupported',
    ).toBeGreaterThan(0)
    const gatewayFeatureFlagsOn = (runtime: ModelProvider): Claim =>
      occurrences(agentSourceFor(runtime) ?? '', nonEssentialWrite) === 0

    // 25. P6.262, ledger D6 — codex ships two builtin agents of its own.
    //
    //     THE ENFORCEMENT SITE IS AN UNTRACKED VENDORED BINARY. The measurement
    //     was taken on `resources/bin/codex/darwin-arm64/codex-app-server`, which
    //     is 178 MB, is not in `git ls-files`, and exists on no CI machine — so it
    //     cannot be probed here at all. Derived from the DOCUMENT that carries the
    //     verbatim measurement instead, which is exactly what `toolMemoryCap` does
    //     three rows above for the same reason, and what `repoSource`'s own header
    //     records as a supported shape.
    expect(
      occurrences(gapsDoc, 'codex-app-server'),
      'the gaps document no longer names the artifact the measurement was taken on',
    ).toBeGreaterThan(0)
    const codexBuiltinAgentsOn = (runtime: ModelProvider): Claim =>
      runtime === 'codex-runtime'
      && occurrences(gapsDoc, 'explorer.toml') > 0
      && occurrences(gapsDoc, 'awaiter.toml') > 0

    // 26. P6.506, ledger H28 — a subagent that inherits the conversation and its
    //     prompt cache, BY DEFAULT.
    //
    //     One host setting, and who READS it decides the row: the default is
    //     resolved host-side and travels on the Pi execution manifest, and neither
    //     vendor agent reads it. Codex's `thread/fork` forks a THREAD and is not a
    //     subject for this row at all, which is why its `false` needs no needle of
    //     its own.
    const sessionManagerSource = repoSource('packages/server-core/src/sessions/SessionManager.ts')
    expect(
      occurrences(repoSource('packages/shared/src/config/background-task-settings.ts'), 'forkSubagentModeEnabled'),
      'the fork-mode default has moved out of the settings module',
    ).toBeGreaterThan(0)
    expect(
      occurrences(sessionManagerSource, 'piExecutionManifestSeed'),
      'the Pi execution manifest is no longer built here — the pi cell is unsupported',
    ).toBeGreaterThan(0)
    const forkSubagentOn = (runtime: ModelProvider): Claim =>
      runtime === 'pi'
        ? occurrences(sessionManagerSource, 'forkSubagent: true as const') > 0
        : occurrences(agentSourceFor(runtime) ?? '', 'forkSubagentModeEnabled') > 0

    // 27. RETIRED — `subagentModelOrder` (P6.309/P6.364), F1.588 (2026-09-24).
    //
    //     Its claude cell was derived from the FORCE gate in `options.ts` being
    //     present, INVERTED — and the derivation would have stayed `false` after the
    //     gate went, because the docblock still names the variable: a default flip
    //     whose stale pin goes GREEN (AGENTS.md §Traps). The 0.3.267 lift brought
    //     the documented order (driven on the vendored 2.1.267: a definition's
    //     `model` beats `CLAUDE_CODE_SUBAGENT_MODEL`), claude now projects the
    //     Nessy value as a default, and all three runtimes agree — so the row is
    //     gone and `claude-subagent-model.test.ts` pins the projection instead.
    const piSpawnerSource = repoSource('packages/pi-agent-server/src/orchestrator/spawner.ts')

    // 28. P6.309 arm (3), ledger H23 — an agent that learned on Pi starts empty
    //     after a switch.
    //
    //     The capability is not "has a memory" but "reads the memory it wrote
    //     HERE", so both vendor cells are derived from the presence of the thing
    //     that makes the store a DIFFERENT one — claude forwards `memory` to the
    //     SDK, whose store is `.claude/agent-memory/<name>/`, and codex names
    //     `memory` among the fields it drops per definition. Both are therefore
    //     INVERTED probes, and a reader who took the `false`s for "no memory
    //     anywhere" would have the claude half exactly backwards.
    expect(
      occurrences(repoSource('packages/shared/src/agent/memory/agent-memory.ts'), 'prepareAgentMemoryDirectory'),
      'the host memory provisioner has moved — the pi cell is unsupported',
    ).toBeGreaterThan(0)
    const subagentMemoryOn = (runtime: ModelProvider): Claim =>
      runtime === 'pi'
        ? occurrences(sessionManagerSource, 'prepareAgentMemoryDirectory') > 0
        : runtime === 'anthropic'
          ? occurrences(repoSource('packages/shared/src/agent/claude-runtime-agents.ts'), 'memory') === 0
          : occurrences(codexAgentSource, 'reportUnexpressibleCodexAgentFields') === 0

    // 29. P6.340, denominator J18 — a project's own `.mcp.json` servers, approved
    //     by three documented keys on claude alone.
    //
    //     An EIGHTH ungrounded row, and it arrived after the seven above were
    //     enumerated — which is the standing argument for grounding every row
    //     rather than the known-missing ones: this map is the only thing that
    //     notices a row shipped without recorded grounds.
    //
    //     Claude reads the keys through the settings tiers we pass; our own MCP
    //     pool has a consent model of its own and has never heard of them. The
    //     probe is therefore asymmetric on purpose: a code literal on the claude
    //     side, and the ABSENCE of all three names on the other, with the pool's
    //     own file asserted non-empty so the zeros mean "not read here".
    //
    //     The claude literal is the CODE fallback in `buildClaudeTurnShapeOptions`
    //     (`settingSources: input.settingSources === undefined ? [triple]`). The
    //     needle was once a docblock sentence spelling the triple, and F1.790's
    //     comment correction removed it, which turned this cell `false` with no
    //     behaviour change. Since F1.768 that fallback is reached for a TRUSTED
    //     project only (`claudeSettingSourcesForProjectTrust`); whether the row
    //     should then read `'conditional'` is the row's product call, not a probe's.
    const projectMcpKeys = [
      'enabledMcpjsonServers',
      'disabledMcpjsonServers',
      'enableAllProjectMcpServers',
    ] as const
    const mcpProjectConfigSource = repoSource('packages/shared/src/mcp/project-config.ts')
    expect(
      occurrences(mcpProjectConfigSource, 'mcpServers'),
      'the project MCP config module is not the one measured',
    ).toBeGreaterThan(0)
    const projectMcpApprovalOn = (runtime: ModelProvider): Claim =>
      runtime === 'anthropic'
        ? /settingSources: input\.settingSources === undefined\s+\? \['user', 'project', 'local'\]/
          .test(claudeAgentSource)
        : projectMcpKeys.some(key =>
          occurrences(agentSourceFor(runtime) ?? '', key) > 0
          || occurrences(mcpProjectConfigSource, key) > 0)

    // 30. P6.690 — a `cd` that persists across Bash calls.
    //
    //     THE ENFORCEMENT SITE IS THE VENDORED BINARY on the claude side: the
    //     persistence is the shipped `claude`'s documented default and
    //     `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` is read by nothing in this
    //     tree, so this derives the claude arm from the same document that
    //     carries the binary probe (6 occurrences of the flag, 4 of its
    //     `Shell cwd was reset to` notice, control 0) — exactly as `policyKeys`
    //     above does and for exactly the same reason.
    //
    //     The two absences are stated in the same document with their own
    //     sources: Pi's cwd is bound at `createBashToolDefinition(cwd, options)`
    //     construction, and codex's is a per-call `ExecParams.cwd` read from
    //     `rust-v0.148.0`. Neither carries a directory between calls, and codex's
    //     `workdir` argument is a SUBSTITUTE rather than the same capability.
    //     The codex sentence is asserted present as this pair's control: if the
    //     document ever stops carrying it, the two `false`s below would be a
    //     guess wearing a measurement's clothes.
    expect(
      occurrences(gapsDoc, 'ExecParams { command, cwd'),
      'the gaps document no longer carries codex\'s per-call cwd measurement',
    ).toBeGreaterThan(0)
    const bashWorkingDirOn = (runtime: ModelProvider): Claim =>
      runtime === 'anthropic'
        && occurrences(gapsDoc, 'CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR') > 0

    // 31. P6.200, denominator A24 — the untrusted-text scan over a delegated
    //     agent's report, which is the one place text a child READ gets to
    //     address the parent model.
    //
    //     Three runtimes, three sources, and one of them is a DOCUMENT for the
    //     same reason `policyKeys` and `toolMemoryCap` are: claude's scan is the
    //     vendored binary's own, gated on a version floor no host code reads, so
    //     there is no in-tree site to grep and the gaps document carries the
    //     verbatim page sentence.
    //
    //     The codex arm is INVERTED, and that is the strongest form available
    //     for it. The absence is STRUCTURAL — the subagent thread returns to the
    //     parent inside the app-server — so there is no scan identifier whose
    //     absence could be measured; a bare `=== 0` on one would also pass in a
    //     tree where `codex-agent.ts` had been deleted. What IS present is the
    //     notice `c4f76a752` added to SAY the scan is missing, so the derivation
    //     reads that, and a notice that stops being emitted goes red here.
    //
    //     `piSubagentTool` is entry 16's read of the same file, reused rather
    //     than re-read; its `lastActivity` control above is this arm's too.
    expect(
      occurrences(piSubagentTool, 'subagentReportMarkerLine'),
      'the Pi subagent tool no longer prepends the marker line',
    ).toBeGreaterThan(0)
    const subagentReportScanOn = (runtime: ModelProvider): Claim =>
      runtime === 'pi'
        ? occurrences(piSubagentTool, 'scanSubagentOutput') > 0
        : runtime === 'anthropic'
          ? occurrences(gapsDoc, 'requires Claude Code v2.1.210 or later') > 0
          : occurrences(codexAgentSource, 'subagentUnscannedNoticeEmitted') === 0

    // 32. P6.481, ledger D3 — whether the model's own reasoning survives a
    //     handoff, and the SECOND `'conditional'` this table has ever carried.
    //
    //     Each arm reads the replay file for its own runtime, because each
    //     runtime's answer is its own documented format and nothing is shared:
    //     Pi's `ThinkingContent` carries `thinkingSignature`, claude's
    //     `ThinkingBlockParam` requires `signature` so the rebuild emits
    //     `type: 'thinking'` (and strips an unsigned block rather than degrading
    //     it), and codex writes its own `{type:'reasoning', …}` item.
    //
    //     The codex arm is a CONJUNCTION and both halves are the claim: the
    //     Responses leg carries it, and the gateway leg drops it at a branch
    //     that says so in its own words. Reading only the first half would score
    //     codex `true` and lose exactly the per-MODEL distinction the cell
    //     exists for; reading only the second would score it `false` and lose
    //     the connection that works.
    const piSessionRebuild = repoSource('packages/shared/src/agent/pi-session-rebuild.ts')
    const claudeRebuild = repoSource('packages/shared/src/agent/claude-transcript-rebuild.ts')
    const codexHandoffItems = repoSource('packages/shared/src/agent/codex-handoff-items.ts')
    // F1.1132: the gateway half is a deliberate PROSE read — its needle is the
    // comment under to-chat.ts's `default:` branch, and no code token there says
    // reasoning is dropped. A comment-stripped run of this suite cannot see it:
    // codex's cell moves only from 'conditional' to false, and neither fires a row.
    const codexGatewayLeg = repoSource('packages/codex-responses-adapter/src/to-chat.ts')
    const reasoningCarryOn = (runtime: ModelProvider): Claim =>
      runtime === 'pi'
        ? occurrences(piSessionRebuild, 'thinkingSignature') > 0
        : runtime === 'anthropic'
          ? occurrences(claudeRebuild, "type: 'thinking'") > 0
          : occurrences(codexHandoffItems, "type: 'reasoning'") > 0
            && occurrences(codexGatewayLeg, 'reasoning items and other input types are not replayed') > 0
            ? 'conditional'
            : false

    // 33. P6.743 — whether a model REFUSING TOOLS moves the fallback chain.
    //
    //     Pi's arm is a CONJUNCTION and both halves are the claim: the code is in
    //     the trigger set AND the classifier that feeds Pi's `typed_error` can
    //     mint it. The set alone would score `true` for a code nothing emits,
    //     which is the exact question the row was opened to settle — so reading
    //     only the constant would have answered it by assuming it.
    //
    //     Codex's arm is an ABSENCE and gets this file's absence control: the
    //     ladder's own first member has to be found in the same file, or a
    //     renamed constant would read as "codex does not switch" for the wrong
    //     reason.
    //
    //     Claude's is `'unmeasured'`, derived from the gaps document that carries
    //     the reading — the ladder runs inside the closed binary, we hand it the
    //     whole chain as one `--fallback-model` string, and the page's trigger
    //     sentence names a tool-support refusal in neither of its two lists.
    const hostErrorClassifier = sharedSource('errors.ts')
    const toolSupportFallbackOn = (runtime: ModelProvider): Claim =>
      runtime === 'pi'
        ? occurrences(piAgentSource, "'model_no_tool_support',") > 0
          && occurrences(hostErrorClassifier, "code = 'model_no_tool_support'") > 0
        : runtime === 'anthropic'
          ? (occurrences(gapsDoc, 'a tool-support refusal is in neither of the page') > 0
            ? 'unmeasured'
            : false)
          : !(occurrences(codexAgentSource, "'serverOverloaded',") > 0
            && occurrences(codexAgentSource, 'model_no_tool_support') === 0)

    // 34. P6.596 / P6.852 — whether a SESSION-LEVEL tool restriction narrows the
    //     built-in tool set. One setting with two halves, and each runtime takes
    //     a different number of them, which is why no arm is a single grep.
    //
    //     Claude is a CONJUNCTION over the two SDK options that enforce it: the
    //     whitelist narrows `tools` (F1.638 — P6.217 put it on `allowedTools`,
    //     which only pre-approves), and `disallowedTools` came from a host
    //     constant. Reading only one would score `true` for a half-built feature.
    //     `tools` covers BUILT-INS only, while Pi's allow list also removes MCP
    //     tools — a meaning the cells cannot carry, so the copy names it and the
    //     F1.662 block at the end of this file pins both the premise and the copy.
    //
    //     Pi is the `'conditional'`, derived as "the allow half arrives AND the
    //     deny half has no carrier": `piAllowedTools` is fed from the resolver,
    //     and `piDisallowedTools` exists nowhere. If a Pi denial list is ever
    //     built, the second occurrence flips this arm to `true` and the row's own
    //     cell has to follow — which is the drift this file exists to catch.
    //
    //     Codex is an ABSENCE with a POSITIVE CONTROL: the `enabled_tools` key
    //     must still be FOUND in codex's config schema (F1.1132) — it is real and
    //     MCP-server-scoped — while the host resolver must reach the config writer
    //     ZERO times. Without the control, a renamed key would read as "codex cannot
    //     restrict tools" for the wrong reason; with it, the day someone writes
    //     the universe into the codex config the arm flips to `true` and the
    //     row's cell has to follow.
    //     The schema is the `codexConfigSchema` this body already read (backgroundTaskOffSwitch).
    const toolRestrictionOn = (runtime: ModelProvider): Claim =>
      runtime === 'anthropic'
        ? occurrences(claudeAgentSource, 'sessionAllowedTools: sessionToolUniverse.allowed') > 0
          && occurrences(claudeAgentSource, 'sessionToolUniverse.disallowed') > 0
        : runtime === 'pi'
          ? (occurrences(sessionManagerSource, 'piAllowedTools: provider === ') > 0
            && occurrences(sessionManagerSource, 'getSessionToolUniverse()') > 0
            && occurrences(sessionManagerSource, 'piDisallowedTools') === 0
            ? 'conditional'
            : occurrences(sessionManagerSource, 'piDisallowedTools') > 0)
          // F1.1132: the key's reality is read off codex's own config SCHEMA; the
          // writer names `enabled_tools` only in a comment (1 hit, 0 in code).
          : !(occurrences(codexConfigSchema, 'enabled_tools') > 0
            && occurrences(codexConfigWriter, 'getSessionToolUniverse') === 0)

    // P6.312 — a session that RUNS AS one of its agents.
    //
    //     Claude is the only positive, and it is derived from BOTH ends of the
    //     seam rather than from one: the pin itself
    //     (`pinClaudeMainThreadAgent`, which is what deletes the agent's model
    //     so the session keeps one upstream) AND the turn path passing a name
    //     into it. Either half alone is a mechanism nothing reaches.
    //
    //     PI IS A POSITIVE TOO since P6.940 clause (2), and P6.1018 is what that
    //     cost. This arm used to derive Pi as an ABSENCE — the host key's reader
    //     exists in `storage.ts` and neither the Pi turn path nor
    //     `SessionManager.ts` names it — and it was RIGHT: `fb011ffcb` made
    //     `SessionManager.ts` name `getSessionAgentName`, the derivation flipped
    //     to `true`, and the cost row still said `pi: false`. This file did
    //     exactly its job and went red on the FIRST pair it compares
    //     (`anthropic → pi`), masking every later pair for a day.
    //
    //     So Pi is now derived from BOTH ends of ITS seam, the same shape as
    //     claude's: the host's composer (`resolvePiSessionAgentPin`, which
    //     resolves the pinned name against THIS session's roster) AND
    //     `SessionManager.ts` handing it the key's value. Either half alone is a
    //     mechanism nothing reaches. Deliberately NOT derived from the Pi
    //     harness — Pi has no main-session-agent option of its own and never
    //     will have one here; the capability is the host's, and the cell tracks
    //     what the user gets rather than who provides it.
    //
    //     Codex stays an ABSENCE WITH A POSITIVE CONTROL, because an absence
    //     derived from a name is otherwise satisfied by renaming the reader: the
    //     host key's own reader must still EXIST in `storage.ts`, and neither
    //     the codex turn path nor its config writer may name it. The day either
    //     starts reading it, the arm flips and the row's cell has to follow —
    //     which is the drift this file exists to catch.
    const sessionAgentOn = (runtime: ModelProvider): Claim =>
      runtime === 'anthropic'
        ? occurrences(sharedSource('claude-runtime-agents.ts'), 'pinClaudeMainThreadAgent') > 0
          && occurrences(claudeAgentSource, 'mainThreadAgent:') > 0
        : runtime === 'pi'
          ? occurrences(sharedSource('pi-harness/runtime-agent-definition.ts'), 'export function resolvePiSessionAgentPin') > 0
            && occurrences(sessionManagerSource, 'resolvePiSessionAgentPin(') > 0
            && occurrences(sessionManagerSource, 'getSessionAgentName()') > 0
          : occurrences(repoSource('packages/shared/src/config/storage.ts'), 'export function getSessionAgentName') > 0
            && occurrences(codexAgentSource, 'getSessionAgentName') === 0
            && occurrences(codexConfigWriter, 'getSessionAgentName') === 0
            ? false
            : true

    // C3.98 — the five security-guidance variables, derived from the two sites
    //     that decide the answer rather than from the plugin.
    //
    //     claude is `true` because its hooks run inside the SDK child, which
    //     inherits the ambient environment: the derivation reads the `query`
    //     call that builds that child. Pi and codex are `false` because their
    //     host-run command hooks pass through `SAFE_INHERITED_ENV_KEYS`, and the
    //     whitelist is asserted to be the six-name one it claims to be — a
    //     widened list would make the `false` wrong, and nothing else here would
    //     notice.
    const hookCommandSource = repoSource('packages/shared/src/automations/hook-command.ts')
    expect(occurrences(hookCommandSource, "'HOME', 'PATH', 'SHELL', 'TMPDIR', 'TEMP', 'TMP'")).toBe(1)
    const securityPluginEnvOn = (runtime: ModelProvider): Claim =>
      runtime === 'anthropic'
        ? occurrences(sharedSource('claude-agent.ts'), 'SAFE_INHERITED_ENV_KEYS') === 0
        : occurrences(hookCommandSource, 'SAFE_INHERITED_ENV_KEYS') === 0

    // C3.219 — the subagent attribution header, derived from its ONLY writer.
    //
    //     `gatewaySessionFetch` lifts `scope.agentId` out of an inbound
    //     `x-claude-code-agent-id`, which only the claude runtime's own child
    //     sends; nothing mints one. So claude is `true` on the presence of that
    //     rename pair and the other two are `false` on the absence of any
    //     producer — asserted as an absence with its own positive control, the
    //     way this file treats every absence.
    const gatewayHeaders = repoSource('packages/shared/src/telemetry/gateway-headers.ts')
    expect(occurrences(gatewayHeaders, 'NESSY_AGENT_ID_HEADER')).toBeGreaterThan(0)
    const subagentAgentIdHeaderOn = (runtime: ModelProvider): Claim =>
      runtime === 'anthropic' && occurrences(gatewayHeaders, "'x-claude-code-agent-id'") > 0

    // C3.64 — the claude runtime's own Explore and Plan, the MIRROR of row 25.
    //
    //     Row 25 derives codex's pair from the document that carries the binary
    //     measurement, because its enforcement site is an untracked 178 MB
    //     artifact. This one has a real site: the vendor publishes a per-pair
    //     deny and we spell it, so claude is `true` on the presence of that
    //     constant. Pi and codex are `false` as an ABSENCE with its own positive
    //     control — neither the Pi spawner nor codex's config writer knows the
    //     name, and the control is the constant being present in the claude
    //     module on the same rig, so an absence caused by a rename reads as a
    //     red rather than as a `false`.
    const claudeBuiltinAgentEnv = sharedSource('claude-runtime-builtin-agent-env.ts')
    expect(
      occurrences(claudeBuiltinAgentEnv, "'CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS'"),
      'the claude per-pair deny has been renamed — every cell of this row is unsupported',
    ).toBe(1)
    expect(occurrences(piSpawnerSource, 'EXPLORE_PLAN')).toBe(0)
    expect(occurrences(codexConfigWriter, 'EXPLORE_PLAN')).toBe(0)
    const claudeBuiltinAgentsOn = (runtime: ModelProvider): Claim =>
      runtime === 'anthropic'
      && occurrences(claudeBuiltinAgentEnv, 'CLAUDE_DISABLE_EXPLORE_PLAN_AGENTS_ENV') > 0

    // C3.290 / C4.24 — skills that live in a folder ADDED to the session.
    //
    //     Three runtimes, three different sites, because the mechanism is a
    //     different thing on each: claude takes the roots as the SDK's
    //     `additionalDirectories` option, codex takes them over its own
    //     `skills/extraRoots/set`, and Pi takes them as a SETTING that loads no
    //     skills. The Pi `false` is an absence with its own positive control —
    //     the host scan walks nested roots under the project and never reads the
    //     configured added directories, and `nestedSkillDirectories` being
    //     present on the same rig is what makes that absence a reading.
    const nativeSourcesSource = repoSource('packages/shared/src/capabilities/native-sources.ts')
    expect(
      occurrences(nativeSourcesSource, 'nestedSkillDirectories'),
      'the host skill scan has moved — the pi false is unsupported',
    ).toBeGreaterThan(0)
    expect(occurrences(nativeSourcesSource, 'getConfiguredAdditionalDirectories')).toBe(0)
    const addedFolderSkillsOn = (runtime: ModelProvider): Claim =>
      runtime === 'anthropic'
        ? occurrences(
            sharedSource('claude-agent.ts'),
            'buildClaudeAdditionalDirectoriesOptions(getConfiguredAdditionalDirectories())',
          ) > 0
        : runtime === 'codex-runtime'
          && occurrences(codexAgentSource, "request('skills/extraRoots/set'") > 0

    // C3.285 — which SUBJECTS a permission rule may name and still be consulted.
    //
    //     INVERTED on the codex side, like `gatewayFeatureFlags` above, and for
    //     the same kind of reason: what makes the codex cell `false` is the
    //     PRESENCE of a narrow projection, not the absence of a mechanism. The
    //     needle is the projection's own vocabulary constant, so a widening — a
    //     fourth tool name, a third input field — flips the derivation and
    //     reddens this row rather than leaving the table asserting a loss that
    //     has been closed. Pi and claude reuse `preToolCounts` above: on both,
    //     every tool call reaches the host gate, so a rule may name any subject.
    const codexRuleSupport = sharedSource('codex-permission-rule-support.ts')
    expect(
      occurrences(codexRuleSupport, "CODEX_APPROVAL_RULE_TOOL_NAMES: readonly string[] = ['Bash', 'Write', 'Edit']"),
      'the codex approval vocabulary has moved — the codex false is unsupported',
    ).toBe(1)
    const ruleSubjectsOn = (runtime: ModelProvider): Claim =>
      runtime === 'codex-runtime'
        ? occurrences(codexRuleSupport, "['Bash', 'Write', 'Edit']") === 0
        : preToolOn(runtime)

    // C3.310 — a rule about an MCP tool or a network HOST, which is the row
    // above's sibling and the claim it used to deny.
    //
    //     F1.368 — SPLIT, because since F1.272 the two halves are lost for two
    //     different reasons and the copy has to say each. The codex cell is
    //     `true` only when BOTH halves bind.
    //
    //     HOST: unbound, from the SAME two facts C3.310 derived the whole row
    //     from, because this half really is their conjunction: codex's own
    //     approval projection carries no host subject (the vocabulary constant
    //     just asserted — its command and file-change requests carry `command`
    //     and `file_path`, never the `host`/`url` a Host matcher reads), AND no
    //     host-run tool reaches the rule gate on a codex session —
    //     `preToolCounts['codex-runtime']`, already measured above as the count
    //     of `runPreToolUseChecks` CALL SITES. One alone would not make it true:
    //     if the host gate ran there, a `Host(...)` rule would bind the tools
    //     this app runs, which is what `ruleSubjects` claimed before C3.298.
    //
    //     MCP: BOUND WHEN CODEX ASKS since F1.272 — an MCP tool-call approval is
    //     routed to `codexMcpToolCallRuleRequests`, which names the call the way
    //     Pi and claude record it, so the old derivation's "no `mcp__` subject"
    //     is false and is asserted false here. The RESIDUE is what keeps this
    //     half lost: codex asks nothing for a tool its server marks
    //     `readOnlyHint` (`requires_mcp_tool_approval`, measured by F1.218);
    //     F1.378 carries an exact-name rule into codex's own per-tool levers and
    //     F1.482 (2) a whole-server or pattern one, enumerated at runtime build,
    //     leaving a source still connecting then (the function below names it).
    //     TRIPWIRE for that remainder: the copy (`costHostMcpRules`, en + ru)
    //     names it, so a commit that narrows it amends the copy and this line.
    //
    //     Pi and claude take `preToolOn` unchanged: every tool call reaches the
    //     host gate on both, so a rule may name a host or an MCP tool and be
    //     evaluated.
    const codexHostRulesUnbound =
      occurrences(codexRuleSupport, "['Bash', 'Write', 'Edit']") === 1 && !preToolOn('codex-runtime')
    const codexMcpRulesConsultedWhenAsked =
      occurrences(codexAgentSource, "return kind === 'elicitation' ? codexMcpToolCallRuleRequests(p, cwd) : [];") === 1
    expect(codexMcpRulesConsultedWhenAsked,
      'F1.272\'s MCP arm left the codex rule projection — the copy\'s "still answers codex\'s approval" is unsupported').toBe(true)
    const codexMcpReadOnlyResidue = occurrences(codexRuleSupport, 'export function describeCodexMcpRuleCatalogueGap(') === 1
    expect(codexMcpReadOnlyResidue,
      'the enumeration no longer leaves a still-connecting source uncovered — '
      + 'amend chat.runtimeSwitch.costHostMcpRules and this line together').toBe(true)
    const hostMcpRulesOn = (runtime: ModelProvider): Claim =>
      runtime === 'codex-runtime'
        ? !codexHostRulesUnbound && codexMcpRulesConsultedWhenAsked && !codexMcpReadOnlyResidue
        : preToolOn(runtime)

    // C3.256 — does the auto-memory FOLDER setting cover everything this session
    // writes as memory?
    //
    //     Derived from the one site that could carry it and does not. The host's
    //     own memory index reads `getAutoMemoryDirectory` in
    //     `memory/memory-store.ts` symbol `getUserMemoryRoot`, which is the
    //     POSITIVE CONTROL: without it, the zero below would be a probe that
    //     matches nothing rather than a projection that is absent. `options.ts`
    //     is where a claude child's env is built, and the setting reaches it in
    //     no code line — its four occurrences of the name are the docblock that
    //     records the refusal, so the instrument is the CALL, `getAutoMemoryDirectory(`.
    //
    //     Pi and codex are `true` because they have no second store to leave
    //     behind: the host index is the only auto-memory either of them writes,
    //     and that is what the setting moves.
    expect(occurrences(repoSource('packages/shared/src/agent/memory/memory-store.ts'), 'getAutoMemoryDirectory()'),
      'the host index stopped reading the setting — the probe below would be vacuous').toBeGreaterThan(0)
    const autoMemoryDirectoryScopeOn = (runtime: ModelProvider): Claim =>
      runtime !== 'anthropic' || occurrences(sharedSource('options.ts'), 'getAutoMemoryDirectory(') > 0

    // C3.276 — is a project `.claude/commands/<name>.md` a `/command` here?
    //
    //     TWO halves and the derivation reads each where it lives. The HOST half
    //     is source-derivable and is what makes Pi and codex `false`:
    //     `custom-commands.ts` constant `COMMAND_DIRS` names
    //     `.nessy-agent/commands` and `.agents/commands` and scores ZERO for the
    //     claude directory — with those two spellings as the positive control,
    //     so the zero is an absence in a file this probe is really reading.
    //
    //     The CLAUDE half is a live measurement (C3.183, 2026-09-11): the child's
    //     own `system/init` names the file and its body reaches the turn. No
    //     source read can see that, so the ledger row that records it is read
    //     instead — the same instrument the `worktreeMove` arm uses for RS-28,
    //     and for the same reason: a blind spot resolved by a run is still
    //     resolved.
    const customCommands = repoSource('packages/shared/src/slash-commands/custom-commands.ts')
    expect(occurrences(customCommands, "join('.agents', 'commands')"),
      'COMMAND_DIRS has moved — this probe is reading the wrong constant').toBeGreaterThan(0)
    const l67 = repoSource('docs/superpowers/specs/2026-08-28-capability-ledger.md')
      .split('\n').find(line => line.startsWith('| L67 '))
    const claudeProjectCommandsOn = (runtime: ModelProvider): Claim => {
      // The host loader supplies it on NO runtime, which is the half that makes
      // the two `false` cells measurements rather than assumptions.
      const hostSupplies = occurrences(customCommands, "join('.claude', 'commands')") > 0
      if (runtime !== 'anthropic') return hostSupplies
      expect(l67, 'the L67 ledger row is gone').toBeDefined()
      return hostSupplies || l67!.includes('C3.183')
    }

    // -- nestedProtectedPaths (C3.377): the DEPTH of the protected-path floor,
    //    which is a different question from whether the floor exists. Codex HAS
    //    one — C3.343 projected the host's own list onto it — so a derivation
    //    that measured presence would return `true` for all three and the row
    //    would fire nowhere.
    //
    //    Pi and claude are a PRESENCE with two halves, either alone satisfiable
    //    by a rename. The matcher must slide a WINDOW over the target's
    //    segments, which is what makes `.git` fire at any depth; it is read out
    //    of `matchesDirectory`'s own body rather than out of the file, because
    //    the exported reader's docblock two functions below says "the match is
    //    on segments" in prose and an unquoted needle would be satisfied by that
    //    sentence instead of by the loop. And the runtime must reach the gate
    //    that consults it, which is the same call-shaped `runPreToolUseChecks(`
    //    count `preToolCheck` above already measures.
    //
    //    Codex is the ABSENCE and gets its own control, because the reason is
    //    neither a missing gate nor a missing list: what travels is a
    //    `":workspace_roots"` SUBPATH, and the projection pushes the
    //    `PROTECTED_DIRECTORIES` entry unmodified — no `*`, so nothing that
    //    could match below a root. Measured on the method's own slice, with the
    //    slice's length and its reading of the shared list as the controls that
    //    prove the projection was read rather than a moved path.
    const protectedPathsSource = sharedSource('pi-harness/protected-paths.ts')
    const segmentWindowLoop = ((): string => {
      const at = protectedPathsSource.indexOf('function matchesDirectory(')
      const end = at < 0 ? -1 : protectedPathsSource.indexOf('\n}', at)
      return at < 0 || end < 0 ? '' : protectedPathsSource.slice(at, end)
    })()
    expect(segmentWindowLoop.length, 'the protected-path matcher moved').toBeGreaterThan(80)
    const codexProjection = ((): string => {
      const source = sharedSource('codex-agent.ts')
      const at = source.indexOf('private codexProtectedWorkspaceSubpaths(')
      const end = at < 0 ? -1 : source.indexOf('\n  }', at)
      return at < 0 || end < 0 ? '' : source.slice(at, end)
    })()
    expect(codexProjection.length, 'the codex protected-path projection moved').toBeGreaterThan(80)
    expect(
      occurrences(codexProjection, 'PROTECTED_DIRECTORIES'),
      'the codex projection no longer reads the shared list',
    ).toBeGreaterThan(0)
    const nestedProtectedPathsOn = (runtime: ModelProvider): Claim => {
      if (runtime === 'codex-runtime') return occurrences(codexProjection, '*') > 0
      return occurrences(segmentWindowLoop, 'index + entrySegments.length <= segments.length') > 0
        && (preToolCounts as Record<string, number>)[runtime]! > 0
    }

    // -- protectedFilesUnprojected (C4.49): whether a write to one of the 37
    //    protected FILES is CONFIRMED with you. Not the same question as
    //    `nestedProtectedPaths` above, which is about the DEPTH of the
    //    protected DIRECTORIES, and deliberately not derived the same way.
    //
    //    Pi and claude are the presence: the basename half of the floor is
    //    reachable from BOTH paths since C4.50 — `findProtectedFileWrite` is
    //    exported out of `protected-paths.ts` for the shell gate and called by
    //    `pre-tool-use.ts` — and the runtime must reach the gate that consults
    //    it, which is the `runPreToolUseChecks(` count `preToolCheck` already
    //    measures.
    //
    //    Codex needs BOTH halves and the conjunction is the point. Projecting
    //    the list alone would NOT give codex this capability: a projected entry
    //    is `read`, and `FileSystemAccessMode` is exactly `read | write | deny`,
    //    so a projection buys a REFUSAL where this row's copy promises a prompt.
    //    A derivation that flipped on the projection alone would therefore call
    //    a refusal a confirmation — which is precisely the overshoot the owner's
    //    option A declined. So codex holds it only when its filesystem
    //    vocabulary can express a prompt AND the files travel; the generated
    //    enum is read off disk with its own three members as the control.
    const fileSystemAccessMode = repoSource('packages/codex-protocol/generated/v2/FileSystemAccessMode.ts')
    expect(occurrences(fileSystemAccessMode, '"deny"'), 'the codex filesystem enum moved').toBeGreaterThan(0)
    const protectedFilesUnprojectedOn = (runtime: ModelProvider): Claim => {
      if (runtime === 'codex-runtime') {
        const codexCanPrompt = occurrences(fileSystemAccessMode, '"prompt"') > 0
          || occurrences(fileSystemAccessMode, '"ask"') > 0
        return codexCanPrompt && occurrences(codexProjection, 'PROTECTED_FILES') > 0
      }
      return occurrences(protectedPathsSource, 'export function findProtectedFileWrite(') > 0
        && occurrences(sharedSource('core/pre-tool-use.ts'), 'findProtectedFileWrite') > 0
        && (preToolCounts as Record<string, number>)[runtime]! > 0
    }

    // -- codexDetachedReview (C4.42's residue): a backgrounded `/code-review`
    //    that keeps running on a thread the RUNTIME owns, which only codex has.
    //    On Pi and claude a backgrounded review is a subagent of this session,
    //    inside the host's own process tree; on codex it is a `review/start`
    //    with `delivery: "detached"` returning a `reviewThreadId`, and the
    //    thread does not survive the session moving elsewhere.
    //
    //    Derived from the mechanism rather than from the review: every runtime
    //    reviews, so a derivation on the review itself would be `true` three
    //    times and the row would fire nowhere. `startDetachedReview` is codex's
    //    alone — scored on all three agent modules, so the two zeroes are an
    //    absence with a positive control on the same instrument — and the DEFAULT
    //    is read off the bridge predicate C4.42 flipped, because a mechanism that
    //    only the model can reach is not one an ordinary user loses.
    const codexDetachedReviewOn = (runtime: ModelProvider): Claim => {
      const agentFile = runtime === 'codex-runtime'
        ? 'codex-agent.ts'
        : runtime === 'pi' ? 'pi-agent.ts' : 'claude-agent.ts'
      if (occurrences(sharedSource(agentFile), 'startDetachedReview') === 0) return false
      return occurrences(
        sharedSource('backend/codex/session-callback-bridge.ts'),
        'record.background !== false',
      ) > 0
    }

    const derivedOn: Record<string, (runtime: ModelProvider) => Claim> = {
      securityPluginEnv: securityPluginEnvOn,
      protectedFilesUnprojected: protectedFilesUnprojectedOn,
      codexDetachedReview: codexDetachedReviewOn,
      subagentAgentIdHeader: subagentAgentIdHeaderOn,
      preToolCheck: preToolOn,
      preToolDefer: preToolDeferOn,
      readFence: readFenceOn,
      guardianJudge: guardianOn,
      worktreeMove: worktreeOn,
      planApproval: planOn,
      appActions: appActionsOn,
      bridgeTools: bridgeToolsOn,
      scheduledRun: scheduledOn,
      autoCompactionOff: autoCompactionOffOn,
      credentialShellFloor: credentialShellFloorOn,
      subagentWorktree: subagentWorktreeOn,
      subagentNesting: subagentNestingOn,
      policyKeys: policyKeysOn,
      toolMemoryCap: toolMemoryCapOn,
      subagentOutputText: subagentOutputTextOn,
      backgroundTaskOffSwitch: backgroundTaskOffSwitchOn,
      autoCompactionKnobs: autoCompactionKnobsOn,
      liveToolInput: liveToolInputOn,
      pathScopedInstructions: pathScopedInstructionsOn,
      autoDenialBreaker: autoDenialBreakerOn,
      codexReviewer: codexReviewerOn,
      gatewayFeatureFlags: gatewayFeatureFlagsOn,
      codexBuiltinAgents: codexBuiltinAgentsOn,
      claudeBuiltinAgents: claudeBuiltinAgentsOn,
      addedFolderSkills: addedFolderSkillsOn,
      ruleSubjects: ruleSubjectsOn,
      claudeProjectCommands: claudeProjectCommandsOn,
      autoMemoryDirectoryScope: autoMemoryDirectoryScopeOn,
      hostMcpRules: hostMcpRulesOn,
      forkSubagent: forkSubagentOn,
      subagentMemory: subagentMemoryOn,
      projectMcpApproval: projectMcpApprovalOn,
      bashWorkingDir: bashWorkingDirOn,
      subagentReportScan: subagentReportScanOn,
      reasoningCarry: reasoningCarryOn,
      toolSupportFallback: toolSupportFallbackOn,
      toolRestriction: toolRestrictionOn,
      sessionAgent: sessionAgentOn,
      nestedProtectedPaths: nestedProtectedPathsOn,
    }

    // The control for `credentialShellFloor`'s two `false`s. They mean "not
    // enforced by the OS", never "no credential floor here" — Pi withholds
    // denied paths from its own search and listing RESULTS and claude does the
    // same for `Grep`/`Glob` since P6.63. A reader who took the `false`s at face
    // value would conclude the opposite of what is true.
    expect(occurrences(repoSource('packages/shared/src/agent/local-tools/runtime.ts'), 'filterDeniedResultPaths'))
      .toBeGreaterThan(0)
    expect(occurrences(sharedSource('claude-agent.ts'), 'rewriteClaudeSearchOutput')).toBeGreaterThan(0)

    // A row fires when the source DEFINITELY has the capability and the target
    // does not definitely have it — `!== true` rather than `=== false`, so a
    // `'conditional'` target fires (P2.484: the user cannot be told they keep
    // something that depends on a precondition nobody can evaluate yet) and a
    // `'conditional'` source does not (there is no definite loss to name).
    //
    // P6.562 widened it by one arm and the widening is restated here rather than
    // imported, which is the whole point of a drift test: an `'unmeasured'`
    // endpoint fires wherever a definite one would, because the alternative is
    // the silence that row exists to end. A source that CANNOT have the
    // capability still fires nothing.
    // Set-compared per ordered pair (rank order inside a pair is the existing
    // costs test's subject, not re-proven here). An id the derivation map does
    // not know — a row added to production without grounds recorded here —
    // fails the comparison rather than passing silently.
    for (const from of SWITCHABLE) {
      for (const to of SWITCHABLE) {
        if (from === to) continue
        const fires = (source: Claim, target: Claim): boolean =>
          source === 'unmeasured' || target === 'unmeasured'
            ? source !== false && target !== true
            : source === true && target !== true
        const expected = Object.entries(derivedOn)
          .filter(([, on]) => fires(on(from), on(to)))
          .map(([id]) => id)
          .sort()
        const actual = runtimeSwitchCosts(from, to)
          .map(cost => cost.id)
          .sort()
        expect(actual, `${from} → ${to}`).toEqual(expected)
      }
    }
  // An EXPLICIT budget, set against the measured floor rather than left at the
  // 5 s default (P6.683). This case reads twenty-odd source files, one of them
  // `SessionManager.ts`, and splits each of them several times: it was measured
  // at 24.3 s at load 16 and at well under a second at load 1.5, so the default
  // makes its verdict a function of what the rest of the machine is doing. 60 s
  // is 2.5x the worst measurement, which is the honest shape — never zero.
  }, 60_000)
})

// ============================================================
// The slash gate, from the resolver to the renderer that enforces it (T17,
// 2026-08-22-nestor-cloud-contract-fix).
//
// `ComposerCapabilities.slash` is computed in `packages/shared` and enforced
// HERE, by `dispatchSlashCommandAction`'s `isCommandAllowed`. `/quota` is the
// first command gated in the positive direction (only the Nessy gateway serves
// `GET /api/v1/quota`), so a resolver change that stops excluding it must not
// be able to pass while the renderer still refuses it, or vice versa. Both
// sides are read at test time from their own enforcement site.
//
// T19 — the gate became CONNECTION-shaped (the built-in Pi Nessy Gateway card
// is metered by the same limiter; a BYOK Pi connection is not), so the grid
// below crosses the provider vocabulary with the connection shapes and each
// cell is compared against the rule taken from its own authority
// (`isNessyGatewayBaseUrl` since F1.6), never against a transcribed membership list.
// ============================================================

describe('the renderer dispatches exactly the slash commands the resolver allows', () => {
  const dispatches = (
    provider: ModelProvider,
    commandId: SlashCommandId,
    connection?: LlmConnection,
  ): boolean => {
    const slash = resolveComposerCapabilities({ provider, ...(connection ? { connection } : {}) }).slash
    return dispatchSlashCommandAction(commandId, {
      allowedCommandIds: slash.commandIds,
      excludedCommandIds: slash.excludedCommandIds,
      submitCommand: () => {},
      openSideQuestionOverlay: () => {},
      requestRecap: () => {},
    })
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

  it('quota dispatches on exactly the sessions whose capabilities offer it', () => {
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
      expect(dispatches(provider, 'quota', connection), `${provider}/${shape}`)
        .toBe(ruleSaysOffered(provider, connection))
    }
    // Both answers occur, so the row is a partition and not a constant — and
    // the Pi family is split by the CONNECTION, which is the widening itself.
    expect(cells.some(cell => dispatches(cell.provider, 'quota', cell.connection))).toBe(true)
    expect(cells.some(cell => !dispatches(cell.provider, 'quota', cell.connection))).toBe(true)
    expect(dispatches('pi', 'quota', CONNECTION_SHAPES.gateway)).toBe(true)
    expect(dispatches('pi', 'quota', CONNECTION_SHAPES.byok)).toBe(false)
    // F1.6 — the claude and codex gateway cards are offered it too, and a BYO
    // connection of either family is not.
    for (const provider of ['anthropic', 'codex-runtime'] as const) {
      expect(dispatches(provider, 'quota', CONNECTION_SHAPES.gateway), provider).toBe(true)
      expect(dispatches(provider, 'quota', CONNECTION_SHAPES.byok), provider).toBe(false)
    }
  })

  it('btw/recap dispatch everywhere except the runtime that excludes them', () => {
    // Negative control: the subtractive gate partitions the same vocabulary
    // the other way, so a renderer that allowed (or refused) everything cannot
    // satisfy both rows.
    for (const commandId of ['btw', 'recap'] as const) {
      const dispatching = MODEL_PROVIDERS.filter(provider => dispatches(provider, commandId))
      expect(dispatching, commandId).not.toContain('nestor-cloud-agent')
      expect(dispatching.length, commandId).toBe(MODEL_PROVIDERS.length - 1)
    }
  })
})

// ============================================================
// P2.124 · the property, swept over this file's per-runtime site.
//
// `runtime-switch-costs.ts` was one of the eleven, and it held its truth the way
// most of them do: a hand-written `SWITCHABLE_RUNTIMES = ['pi','anthropic',
// 'codex-runtime']` with every row total over THAT narrower list. A runtime
// added to `ModelProvider` was silently not switchable and every row kept
// compiling — two lists, and the narrower one hid the wider one's growth.
//
// P2.485 — this said "the five rows", which was TRUE when it was written
// (measured: five rows at `e0a64da64`, the commit that added this paragraph) and
// reads today as a claim about a table that has since grown past it. Past-tense
// accuracy is not enough for a number sitting beside a live list: a reader
// checking it counts the rows there are now. The count is dropped rather than
// updated, for the reason the header of this file already gives — "a count
// beside a list is the AGENTS.md trap, and it fired three times inside these two
// files."
//
// The list is gone. Each row is now total over the vocabulary with a tri-state
// claim (`null` = no claim, the omnigent reference's `None`), and which runtimes
// are switch ENDPOINTS is derived from the rows rather than declared beside
// them. What follows is the property that keeps it that way.
// ============================================================

describe('P2.124 · every cost row decides every runtime', () => {
  it('is total over the vocabulary, in both directions', () => {
    for (const [id, claims] of Object.entries(RUNTIME_SWITCH_COST_CLAIMS)) {
      expect(runtimesNotDecidedBy(claims), `${id} leaves a runtime undecided`).toEqual([])
      expect(nonRuntimeKeysOf(claims), `${id} decides a key that is not a runtime`).toEqual([])
    }
    // Positive control for both helpers, and for the sweep being non-empty.
    expect(runtimesNotDecidedBy({ pi: true }).length).toBe(MODEL_PROVIDERS.length - 1)
    expect(nonRuntimeKeysOf({ 'pi-native': true })).toEqual(['pi-native'])
    expect(Object.keys(RUNTIME_SWITCH_COST_CLAIMS).length).toBeGreaterThan(1)
  })

  it('a runtime is claimed by every row or by none — never half-described', () => {
    // The cross-row half of the property, and the one that makes "endpoint"
    // derivable: `isSwitchableRuntime` asks whether EVERY row makes a concrete
    // claim, so a runtime concrete in three rows and `null` in two would be a
    // non-endpoint whose rows still carry answers nobody reads. Half-described
    // is the state that reads like a decision and is not one.
    const rows = Object.entries(RUNTIME_SWITCH_COST_CLAIMS)
    for (const runtime of MODEL_PROVIDERS) {
      const claimed = rows.filter(([, claims]) => claims[runtime] !== null).map(([id]) => id)
      expect(
        claimed.length === 0 || claimed.length === rows.length,
        `${runtime} is claimed by ${claimed.length} of ${rows.length} rows: ${claimed.join(',')}`,
      ).toBe(true)
    }
    // Positive control: both states actually occur, so this is a partition and
    // not a vacuous truth met by an all-concrete or all-null table.
    const fullyClaimed = MODEL_PROVIDERS.filter(
      runtime => rows.every(([, claims]) => claims[runtime] !== null),
    )
    expect(fullyClaimed.length).toBeGreaterThan(0)
    expect(fullyClaimed.length).toBeLessThan(MODEL_PROVIDERS.length)
  })

  it('the endpoints the rows imply are exactly the ones the composer allows', () => {
    // The two sources of "who can move" — the rows here and
    // `ComposerCapabilities.connection.switchable` in `packages/shared` — must
    // agree. They are computed independently, so this is the drift check the
    // deleted `SWITCHABLE_RUNTIMES` list used to make impossible.
    const rows = Object.values(RUNTIME_SWITCH_COST_CLAIMS)
    const impliedEndpoints = MODEL_PROVIDERS.filter(
      runtime => rows.every(claims => claims[runtime] !== null),
    ).sort()
    const composerEndpoints = MODEL_PROVIDERS.filter(
      provider => resolveComposerCapabilities({ provider }).connection.switchable,
    ).sort()
    expect(impliedEndpoints).toEqual(composerEndpoints)
  })

  it('a runtime outside the vocabulary costs nothing rather than guessing', () => {
    // The `?? CONSERVATIVE` shape's failure mode, refused explicitly: a provider
    // string a newer build persisted must not index a row and read `undefined`
    // as "does not have the capability", which would manufacture a full list of
    // costs for a runtime nobody has described.
    const stranger = 'pi-native' as unknown as ModelProvider
    expect(runtimeSwitchCosts(stranger, 'pi')).toEqual([])
    expect(runtimeSwitchCosts('pi', stranger)).toEqual([])
    // Positive control on the same rig: a real pair still costs something.
    expect(runtimeSwitchCosts('pi', 'codex-runtime').length).toBeGreaterThan(0)
  })
})

/**
 * F1.368 (origin WJ-hh P-WJ-hh-2, merged with its verifier's finding on F1.272) —
 * the `hostMcpRules` copy says WHICH half is lost on codex, in both locales.
 *
 * Until F1.272 the sentence was right that "rules written about an MCP tool or a
 * network host stop binding anything" there. F1.272 made codex's MCP tool-call
 * approval consult the user's `mcp__` rules, so that clause became false for
 * every tool codex asks about, and what is still lost is narrower: a HOST rule
 * (codex's command and file-change approvals carry no host) and an MCP rule about
 * a tool its server marks read-only (codex asks nothing for one). The derivation
 * above is the source-side half; this is the copy's.
 */
describe('F1.368 — the hostMcpRules copy names the host half and the read-only residue', () => {
  const localeValue = (locale: 'en' | 'ru'): string =>
    (JSON.parse(repoSource(`packages/shared/src/i18n/locales/${locale}.json`)) as Record<string, string>)[
      'chat.runtimeSwitch.costHostMcpRules'
    ]!

  it('en: the host half is unbound, and an MCP rule\'s read-only residue is named apart from it', () => {
    const en = localeValue('en')
    expect(en).not.toContain('MCP tool or a network host stop binding anything')
    expect(en).toContain('network host')
    expect(en).toContain('MCP tool')
    expect(en).toContain('read-only')
    expect(en).toContain('{{toRuntime}}')
  })

  it('ru: the same three facts, in Russian', () => {
    const ru = localeValue('ru')
    expect(ru).not.toContain('MCP-инструмент или сетевой хост, перестают что-либо ограничивать')
    expect(ru).toContain('сетевой хост')
    expect(ru).toContain('MCP-инструмент')
    expect(ru).toContain('только для чтения')
    expect(ru).toContain('{{toRuntime}}')
  })
})

/**
 * F1.662 (origin WJ-crit-b P-WJcritb-2) — the `toolRestriction` copy says the
 * ALLOWED list means different things on claude and on Pi.
 *
 * F1.638 put claude's half of `sessionAllowedTools` on `Options.tools`, which
 * narrows BUILT-IN tools only — `cli-reference.md#cli-flags`, `--tools`:
 * "doesn't affect MCP tools" (measured: 47 MCP tools before and after). Pi's
 * `piAllowedTools` is the whole tool universe and filters the MCP proxy
 * definitions with the same list. Projecting the MCP half onto claude deny rules
 * instead would be a product decision — our own `mcp__session__*` tools carry
 * host features — and is not taken, so the difference is a switch cost and the
 * copy states it (arm 34 above derives the cells; this is the copy's half).
 *
 * The premise is pinned on both seams: the day the host writes the whitelist's
 * MCP half into claude's deny list (a second read of the resolver's `allowed`),
 * or Pi stops filtering MCP definitions by it, this goes red and the copy has to
 * follow.
 */
describe('F1.662 — the toolRestriction copy names the MCP half of the allowed list', () => {
  const localeValue = (locale: 'en' | 'ru'): string =>
    (JSON.parse(repoSource(`packages/shared/src/i18n/locales/${locale}.json`)) as Record<string, string>)[
      'chat.runtimeSwitch.costToolRestriction'
    ]!

  it('premise: claude reads the whitelist once, into `tools`; Pi filters its MCP definitions by it', () => {
    const claudeAgentSource = sharedSource('claude-agent.ts')
    expect(occurrences(claudeAgentSource, 'sessionToolUniverse.allowed')).toBe(1)
    expect(occurrences(claudeAgentSource, 'const toolsValue = buildClaudeSessionToolsOption({')).toBe(1)
    const piAgentSource = sharedSource('pi-agent.ts')
    expect(occurrences(piAgentSource, '...mcpToolDefs,')).toBeGreaterThan(0)
    expect(occurrences(piAgentSource, 'if (!this.config.piAllowedTools) return tools;')).toBe(1)
    expect(occurrences(piAgentSource, 'const allowed = new Set(this.expandMcpPatternAliases(this.config.piAllowedTools));')).toBe(1)
  })

  it('en: claude\'s allowed list narrows built-in tools only, Pi\'s includes MCP tools', () => {
    const en = localeValue('en')
    expect(en).not.toContain('Claude applies both the allowed list and the disallowed one;')
    expect(en).toContain('narrows only the built-in tools')
    expect(en).toContain('MCP tools included')
    expect(en).toContain('silently ignores the disallowed')
    expect(en).toContain('{{toRuntime}}')
  })

  it('ru: the same facts, in Russian', () => {
    const ru = localeValue('ru')
    expect(ru).not.toContain('Claude применяет и разрешающий список, и запрещающий;')
    expect(ru).toContain('только встроенные инструменты')
    expect(ru).toContain('включая MCP-инструменты')
    expect(ru).toContain('молча игнорирует')
    expect(ru).toContain('{{toRuntime}}')
  })
})
