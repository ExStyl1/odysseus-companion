/**
 * The classifier and the settings renormaliser behind a runtime switch.
 *
 * The VOCABULARY (`RuntimeSwitchKind`, `RuntimeSwitchResult`) lives in
 * `@nessy-agent/shared/protocol` — the renderer needs it for the confirmation
 * copy and the renderer cannot import server-core. Only the decisions live
 * here.
 */

import {
  resolveBackendRuntimePaths,
  resolveCodexBinaryPath,
  resolveModelForProvider,
  type AgentProvider,
  type BackendHostRuntimeContext,
} from '@nessy-agent/shared/agent/backend'
import { isNessyGatewayBaseUrl } from '@nessy-agent/shared/agent/backend'
// The spawn-window classifier, exported for P6.10. Not a fourth copy of a
// `claude-` prefix test — the ONE function that already decides which window a
// Claude subprocess spawns with, so the carry planner and the spawn path can
// never answer that question differently. Costs nothing to import: the barrel
// already sits in this module's graph through `agent/backend` → `factory.ts`
// → `claude-agent.ts` (measured 2026-09-01: 0 ms incremental).
import { resolveClaudeSpawnContextWindow } from '@nessy-agent/shared/agent'
import { normalizeManagedPermissionMode, PERMISSION_MODE_ORDER, type PermissionMode } from '@nessy-agent/shared/agent/mode-types'
import { getValidCreds } from '@nessy-agent/shared/auth/dp'
// P2.521 · the gateway window table the two spawn paths already read. Imported
// rather than re-tabled: `nestorGatewayModelWindow` is the ONE reader of
// `NESTOR_GATEWAY_MODEL_WINDOWS`, and a second copy of a window per model id is
// how the planner and the spawn it promises for come to disagree.
import { nestorGatewayModelWindow } from '@nessy-agent/shared/auth/nestor'
import type { ThinkingLevel } from '@nessy-agent/shared/agent/thinking-levels'
import { resolveContextWindow, type LlmConnection, type ResolvedContextWindow } from '@nessy-agent/shared/config'
import { getCredentialManager } from '@nessy-agent/shared/credentials'
import { isAnthropicBackendEnabled, isClaudeRuntimeEnabled, isCodexRuntimeEnabled } from '@nessy-agent/shared/feature-flags'
import type { ComposerCapabilities, HistoryCarryPlan, HistoryCarryReason, RuntimeSwitchKind } from '@nessy-agent/shared/protocol'
import { estimateTokensDensityAware } from '@nessy-agent/shared/utils'

/**
 * How much a connection change costs the session.
 *
 * The three tiers are not cosmetic — they decide whether the runtime's own
 * conversation survives:
 *
 * - `model`: same connection, different model. The runtime keeps its thread.
 * - `connection-same-runtime`: different connection, same `AgentProvider`. The
 *   backend is recreated (credentials/endpoint changed) but the runtime anchor
 *   is still valid, because both Pi's `.pi-sessions` sidecar and Claude's SDK
 *   transcript are keyed by session/workspace, never by connection.
 * - `connection-cross-runtime`: different `AgentProvider`. The target runtime
 *   has no anchor for this session; context can only be handed over as text.
 */
export function classifyRuntimeSwitch(
  from: { slug?: string; provider: AgentProvider },
  to: { slug: string; provider: AgentProvider },
): RuntimeSwitchKind {
  if (from.slug === to.slug) return 'model'
  return from.provider === to.provider ? 'connection-same-runtime' : 'connection-cross-runtime'
}

/** Which precondition failed. Carried into the `RUNTIME_UNHOSTABLE` message. */
export type RuntimeUnhostableReason =
  | 'runtime-disabled'
  | 'runtime-binary-missing'
  | 'credentials-missing'

export type CanHostSessionVerdict = { ok: true } | { ok: false; code: RuntimeUnhostableReason }

/**
 * Whether the TARGET of a runtime switch can actually start on this host.
 *
 * The switch's teardown is irreversible — `exitWorktreeBeforeRuntimeSwitch`
 * leaves the worktree and the strict drain releases every lease — and without
 * this check nothing asks the question until AFTER it: Claude fails at
 * `getOrCreateAgent` (`factory.ts`'s `CLAUDE_RUNTIME_DISABLED_ERROR`), Codex
 * only at the first turn's `ensureRuntime` → `resolveBinaryPath`
 * (`codex-agent.ts`). So `switchSessionRuntime` calls this BEFORE any teardown.
 *
 * Deterministic and LOCAL only — no network, no spawn. NOT
 * `validateStoredBackendConnection`: its anthropic arm goes to the network
 * (`getValidClaudeOAuthToken`). And per `drivers/codex.ts`'s own rule — "A real
 * turn is the true test; do not spawn app-server just to validate" — the binary
 * arm checks for the file on disk, never runs it. Three arms:
 *
 * 1. FLAG — the target runtime is compiled into this build. `pi`/`pi_compat`
 *    carry no arm here: the Pi backend has no runtime flag (the provider flags
 *    gate setup cards, not the backend), so for Pi "can start" is the binary
 *    and credential arms alone.
 * 2. BINARY — the runtime's own executable resolves on disk. For Pi that is
 *    the `pi-agent-server` bundle: `pi-agent.ts` refuses to spawn without it
 *    ("piServerPath not configured"), which makes it Pi's exact analogue of
 *    the Codex/Claude binaries.
 * 3. CREDENTIAL — a credential record EXISTS for the target connection and,
 *    when it carries `expiresAt`, is not expired (`hasLlmCredentials`, the
 *    same existence test `validateStoredBackendConnection` runs before its
 *    network arm) — OR, for a card whose base URL is the VERIFIED Nessy
 *    Gateway, a valid dp token sits in `~/.nessy/dp_auth_creds.json`
 *    ({@link gatewayDpCredentialsPresent}; the dp flow never writes the LLM
 *    store, so a store-only arm refused every one-click gateway card on a
 *    signed-in machine — found live by the CDP wave 2026-08-21). Residual,
 *    named: the store leg still accepts a present, unexpired-but-malformed
 *    api_key row (the dp leg, by contrast, is JWT-shape-validated). Both legs
 *    are read-only; `~/.nessy/dp_auth_creds.json` stays read-only outside
 *    `packages/shared/src/auth/dp`.
 */
export async function canHostSession(
  target: LlmConnection,
  hostRuntime: BackendHostRuntimeContext,
): Promise<CanHostSessionVerdict> {
  const type = target.providerType

  // Remote sessions are hosted remotely — there is no local flag, binary or
  // credential to check, and `switchSessionRuntime` refuses the providerType
  // as a switch target (`CONNECTION_NOT_SWITCHABLE`) before this runs.
  if (type === 'nestor-cloud-agent') return { ok: true }

  if (type === 'codex-runtime' && !isCodexRuntimeEnabled()) {
    return { ok: false, code: 'runtime-disabled' }
  }
  if (type === 'claude-runtime' && !isClaudeRuntimeEnabled()) {
    return { ok: false, code: 'runtime-disabled' }
  }
  // Plain 'anthropic' (Claude Pro/Max) ships under EITHER Claude flag — the
  // subscription card implies the runtime it needs. `claude-runtime` above is
  // deliberately stricter: it requires its own flag (factory.ts's
  // `claudeBuildGateError` draws the same line).
  if (type === 'anthropic' && !isAnthropicBackendEnabled()) {
    return { ok: false, code: 'runtime-disabled' }
  }

  if (type === 'codex-runtime') {
    if (!resolveCodexBinaryPath(hostRuntime)) return { ok: false, code: 'runtime-binary-missing' }
  } else if (type === 'claude-runtime' || type === 'anthropic') {
    // `resolveClaudeBinaryPath` is module-private; the resolved-paths record
    // is the exported surface that carries its answer.
    if (!resolveBackendRuntimePaths(hostRuntime).claudeCliPath) {
      return { ok: false, code: 'runtime-binary-missing' }
    }
  } else if (!resolveBackendRuntimePaths(hostRuntime).piServerPath) {
    return { ok: false, code: 'runtime-binary-missing' }
  }

  // `hasLlmCredentials` returns true for authTypes that need none
  // ('none'/'environment'), so no separate guard here.
  //
  // The SINGLETON, though, can be absent: `getCredentialManager` throws until
  // storage layout v2 is bound. This arm therefore fails OPEN — an unbound
  // store means "not asked", never "refused". A precondition whose own
  // dependency turns a legitimate switch into an uncoded crash would be worse
  // than the late failure it exists to prevent, and skipping the arm only
  // restores the pre-T4 outcome (the switch proceeds and any credential
  // problem surfaces where it always did). Measured: without this the
  // five `context-usage-after-switch` rows and this helper's own unit cases
  // all threw out of `switchSessionRuntime`.
  let credentialManager: ReturnType<typeof getCredentialManager> | null = null
  try {
    credentialManager = getCredentialManager()
  } catch {
    credentialManager = null
  }
  if (credentialManager) {
    const hasCredentials = await credentialManager
      .hasLlmCredentials(target.slug, target.authType, type)
    if (!hasCredentials && !gatewayDpCredentialsPresent(target)) {
      return { ok: false, code: 'credentials-missing' }
    }
  }

  return { ok: true }
}

/**
 * The credential arm's second leg: the one-click Nessy Gateway cards.
 *
 * The dp sign-in flow writes ONLY `~/.nessy/dp_auth_creds.json` — nothing in
 * `packages/shared/src/auth/dp` touches the LLM credential store — so for a
 * gateway-backed card `hasLlmCredentials` is false on a perfectly signed-in
 * machine. **Found live 2026-08-21 by the CDP wave, on the first run after T4
 * landed**: every switch onto a gateway card refused `credentials-missing`
 * while its turns would have authenticated fine, because T4's own healthy-arm
 * unit test seeded the store directly and masked exactly this. The check is
 * scoped to the VERIFIED gateway base URL (`isNessyGatewayBaseUrl`, the same
 * rule that scopes the Nestor request rewriting) and reads the dp file through
 * `getValidCreds` — read-only, JWT-shape-validated, expiry-checked, no
 * network, which keeps `canHostSession`'s deterministic-and-local contract.
 */
export function gatewayDpCredentialsPresent(
  target: Pick<LlmConnection, 'baseUrl'>,
  credsPath?: string,
): boolean {
  if (!isNessyGatewayBaseUrl(target.baseUrl)) return false
  return getValidCreds(...(credsPath === undefined ? [] : [credsPath])) !== null
}

// ---------------------------------------------------------------------------
// P3 · what a switch will carry, decided BEFORE the switch runs
// ---------------------------------------------------------------------------

/**
 * Whether a runtime's NATIVE history carry is actually implemented.
 *
 * **This map is the single source of truth for the `native` tier.** That is the
 * whole point: P3 landed before any native carry existed, so a modal that
 * promised "full history, tool calls included" would have been lying at every
 * commit between P3 and the tasks that build the mechanism. Keeping the promise
 * honest costs one map.
 *
 * **The lines that flip, and who flips them:**
 *
 * - `'codex-runtime'` → **T1a**, LANDED (`feat(codex): deliver the runtime
 *   handoff through thread/inject_items`) of
 *   `docs/superpowers/plans/2026-08-20-cross-runtime-history-carry.md`. Codex
 *   takes the missed span as model-visible history over `thread/inject_items`
 *   between turns. **The `true` here is the whole licence** — `CodexAgent`
 *   injects only when the plan this map helped decide came back `native`, so
 *   flipping it back to `false` disarms the native path without touching the
 *   agent.
 *   Bounded by T1a's own scope: user/assistant TEXT crosses; tool calls and
 *   their results are T1b's, and the modal's Codex body says so.
 * - `'anthropic'` → **T2**, LANDED (`feat(claude): rebuild the SDK session
 *   transcript on a switch into Claude`). One entry covers BOTH Claude cards:
 *   the `claude-runtime` and plain `anthropic` providerTypes collapse onto the
 *   same `AgentProvider`, and D8 records that T2's rebuild fires on
 *   providerType and therefore covers both without touching the classifier.
 *   The mechanism is different from Codex's and the licence is the same: a
 *   `native` plan is what lets `switchSessionRuntime` write the SDK's own
 *   transcript and set the anchor, and `ClaudeAgent.shouldSuppressTextHandoff`
 *   refuses to suppress the text block on any other plan.
 *   **P3's narrowing is GONE as of P6.10, and the sentence that described it was
 *   still literally true when it was removed.** Until then the arm below tested
 *   `modelId.startsWith('claude-')` and answered `text`, so a switch onto a real
 *   Claude model (Pro/Max, or a BYO key on `claude-sonnet-…`) never rebuilt —
 *   only a gateway id did. The arm now asks
 *   `resolveClaudeSpawnContextWindow`, whose three-way answer separates the two
 *   situations the prefix test had merged, and a `claude-*` id reaches the fit
 *   arithmetic like any other. The arm's own note carries the measurement and
 *   the documented sentence behind it.
 * - `'pi'` → **T7**, LANDED (`feat(pi): rebuild a Pi session file on a first
 *   switch into Pi`), after owner gate G2 was answered 2026-08-21. A switch
 *   into Pi that finds no Pi anchor synthesizes a v3 session file and the
 *   subprocess forks from it (`SessionManager.forkFrom`), so the whole
 *   conversation — tool calls, their results, and the model's own
 *   between-call commentary — arrives as Pi's own history. The licence works
 *   the same way as the other two: `SessionManager` writes the carry file only
 *   on a `native` plan, and `PiAgent.shouldSuppressTextHandoff` refuses to
 *   suppress the text block on any other.
 *   **This entry covers a FIRST entry only, and that is not a narrowing** —
 *   `'pi'` is in `ANCHORED_PROVIDERS`, so a RETURN leg is answered `anchor` by
 *   the tier above this map and resumes its own `.pi-sessions` sidecar, which
 *   already carries everything Pi did before it left.
 *
 * Keyed on `AgentProvider` and not on `LlmProviderType` deliberately: the carry
 * is a property of the RUNTIME that receives the conversation, not of the card
 * that addresses it.
 */
const NATIVE_HISTORY_CARRY_IMPLEMENTED: Record<AgentProvider, boolean> = {
  pi: true,
  anthropic: true,
  'codex-runtime': true,
  // Remote — refused as a switch target before this is ever consulted
  // (`CONNECTION_NOT_SWITCHABLE`). Listed so the record stays exhaustive.
  'nestor-cloud-agent': false,
}

/**
 * Can this runtime take a conversation as native, model-visible history?
 *
 * See {@link NATIVE_HISTORY_CARRY_IMPLEMENTED} — `true` for `codex-runtime`
 * since T1a, for `anthropic` since T2 and for `pi` since T7. The only `false`
 * left is the remote agent, which is refused as a switch target long before
 * this is consulted.
 */
export function supportsNativeHistoryCarry(provider: AgentProvider): boolean {
  return NATIVE_HISTORY_CARRY_IMPLEMENTED[provider]
}

/**
 * A session's context floor: system prompt plus the pinned capability layer,
 * before a single conversation row is added.
 *
 * Measured at ~46 000 tokens and written down here because AGENTS.md records
 * what happens when a threshold is sized against zero instead: a knob set below
 * the floor the session can ever reach compacts after every turn forever and
 * reads exactly like a broken feature.
 */
export const SESSION_RESTING_CONTEXT_TOKENS = 46_000

/**
 * How much of the estimate is treated as slack rather than as truth.
 *
 * The estimator below is a heuristic, not a tokenizer, and this repo has
 * already paid for trusting one: `large-response.ts` records a session poisoned
 * by a 56 KB result that "estimated to ~14k tokens via the 4-chars/token
 * heuristic but cost far more in the real tokenizer". `estimateTokensDensityAware`
 * corrects the base64 case that caused it; this margin covers the rest —
 * dense code, JSON, and Cyrillic, which tokenizes at roughly half the
 * chars-per-token of English prose and is a first-class case for this product.
 *
 * A silent ratio is how a seatbelt becomes a false promise, so both numbers are
 * declared here and asserted in `runtime-switch.test.ts` against the measured
 * corpus rather than left to a reader to infer.
 */
export const HISTORY_CARRY_TOKEN_MARGIN = 1.25

/**
 * One transcript row, as much of it as a converter would actually send.
 *
 * Structural on purpose: the planner is pure and its tests build rows by hand.
 * `Message` (`@nessy-agent/core`) satisfies it.
 */
export interface HistoryCarryRow {
  role: string
  content?: string
  isIntermediate?: boolean
  toolInput?: Record<string, unknown>
  toolResult?: string
  /** P1's raw pair — what the runtime actually saw, before the display rewrite. */
  rawToolInput?: Record<string, unknown>
  rawToolResult?: string
}

export interface HistoryCarryDecision {
  plan: HistoryCarryPlan
  /**
   * Why the plan is what it is.
   *
   * **This field's own comment used to end *"Not rendered — logged"*, and that
   * was the whole of P3.266.** The value had zero readers outside this module,
   * so a switch that fell back to the 24 × 1200 text tail shortened the user's
   * conversation and told them nothing — while the modal that asked them to
   * approve it was on screen with the answer available. The vocabulary now lives
   * in `@nessy-agent/shared/protocol` ({@link HistoryCarryReason}, where each
   * member is documented for the renderer that renders it), and
   * `previewRuntimeSwitch` carries it onto `RuntimeSwitchPreview`. It is
   * still logged, and the close-out question it was written for — "how often
   * does the `text` tier fire, and for which reason" — is unchanged.
   *
   * READ from the shared union rather than restated here: a second copy of six
   * string literals is exactly how a wire vocabulary and its renderer drift, and
   * the two `context-window-*` members are the pair a reader is most likely to
   * conflate. The distinction that matters, kept here because it is about THIS
   * planner's arms: `context-window-unenforced` is a window that resolved while
   * nothing will enforce it — the Claude target's id is one
   * `resolveClaudeSpawnContextWindow` answers `missing` for, so we declare no
   * window to the subprocess and its proactive compaction stays off. NOT the
   * `claude-*` case, which is `sdk-owned` and takes the fit arithmetic (P6.10).
   * `context-window-unknown` is `resolveContextWindow` answering
   * `{contextWindow: null, source: 'unavailable'}` — no window at all.
   */
  reason: HistoryCarryReason
  /** Estimated tokens of the convertible payload, before the margin. */
  estimatedTokens: number
  /** Estimated tokens plus the margin, plus the resting context. */
  requiredTokens: number
  /** The window the fit was judged against, or `null` when it is unknown. */
  contextWindow: number | null
  /** Which tier of `resolveContextWindow` answered. */
  windowSource: ResolvedContextWindow['source']
  /** The model the window was resolved for — the TARGET's, never the source's. */
  modelId: string
}

/**
 * Everything that would cross, measured the way it would cross.
 *
 * Counts user and assistant `content` plus each tool row's `content`,
 * `toolInput` and `toolResult` — the same shape the plan's corpus measurement
 * used (median 0.7 KB, p95 41 KB, p99 484 KB, max 528 KB over 677 sessions).
 * Prefers P1's raw pair where it exists, because the raw pair is what a
 * converter feeds; the display projections are the degraded fallback for rows
 * persisted before P1.
 */
function estimateCarryPayloadTokens(rows: readonly HistoryCarryRow[]): number {
  const parts: string[] = []
  for (const row of rows) {
    if (row.content) parts.push(row.content)
    const input = row.rawToolInput ?? row.toolInput
    if (input) parts.push(JSON.stringify(input))
    const result = row.rawToolResult ?? row.toolResult
    if (result) parts.push(result)
  }
  // ONE pass over the whole payload, not a per-row sum: the base64-density
  // correction in `estimateTokensDensityAware` has a 20 000-char floor and a
  // whole-text ratio, so summing per row would silently skip it on exactly the
  // shape that motivates it — the largest session in the corpus is 528 KB
  // across 25 rows, i.e. one huge tool result, not a long conversation.
  return estimateTokensDensityAware(parts.join('\n'))
}

/**
 * Decide what a cross-runtime switch will carry, BEFORE anything is torn down.
 *
 * **Owner decision 2026-08-20:** size is never a reason to refuse a switch. If
 * the conversation does not fit, we carry today's text handoff and *say so in
 * the confirmation modal*. The only refusal is T4's "the target cannot start".
 *
 * The five outcomes, in the order they are decided. Four were listed here until
 * P6.10; the Claude spawn-window arm has been decided in this function since P3
 * and was simply never written into the list, which is part of why its own
 * comment could go stale unnoticed:
 *
 * 1. `anchor` — the target already holds its own anchor (D7). It resumes its
 *    OWN transcript and the trimmed text tail carries what it missed; nothing
 *    is rebuilt. Decided FIRST because it is true regardless of size, and
 *    because the modal must not promise "full history" for a returning leg.
 * 2. `text` — no native carry is implemented for the target runtime. Since T7
 *    this is true only of the remote agent, which never reaches here anyway
 *    (`CONNECTION_NOT_SWITCHABLE` refuses it first): `codex-runtime` (T1a),
 *    `anthropic` (T2) and `pi` (T7) all carry natively. See
 *    {@link supportsNativeHistoryCarry}. The arm stays because the map is what
 *    keeps the modal's promise honest, and a runtime added later starts here.
 * 3. `text` — the target's context window is UNKNOWN. Not optional, and not
 *    conservatism for its own sake: the gateway's over-limit 400 does not
 *    present as `prompt_too_long`, so the SDK's own safety net never fires and
 *    an overflow reads to the user as a silent conversation reset rather than
 *    as an error (`claude-agent.ts`, the `pY_` note around :1005-1010).
 *    Degrading is worse than nothing; sending blind is worse than degrading.
 * 4. `text` — the target is the Claude runtime and the window that resolved is
 *    one nothing will enforce (`resolveClaudeSpawnContextWindow` → `missing`):
 *    we declare no window to the subprocess, so its proactive compaction never
 *    arms and the same silent-reset argument as (3) applies, one step later.
 * 5. `native` if the payload plus the resting context fits the window with the
 *    declared margin, `text` if it does not.
 *
 * **Deliberately NOT trimming to fit** — documented, not implemented, and
 * recorded here so the omission is not read as an oversight and "finished"
 * later: a trimmed native history reads to the model as COMPLETE. It sees a
 * file's read result with none of the turns that explain why, and nothing marks
 * the gap. The text handoff is honest by construction —
 * `buildRuntimeHandoffContext` frames itself as a prior transcript and tells
 * the model to re-check anything it depends on. If trim is ever added, that
 * same framing has to lead it.
 *
 * **The escalation was considered and declined (D9).** The closed
 * runtime-switching plan reserved `transferredSessionSummary` for exactly this
 * trigger; its budget is 500 chars per message and 12 000 total against the
 * text tail's 24 × 1200 = 28 800, so escalating on overflow would REDUCE
 * fidelity while adding a metered gateway call to the switch path.
 *
 * Pure: no I/O, no clock, no globals. The caller loads the transcript first —
 * see the call site's own note on why that ordering is load-bearing.
 */
export function planHistoryCarry(input: {
  /** The session transcript, ALREADY LOADED. An empty array estimates zero. */
  rows: readonly HistoryCarryRow[]
  /** The runtime taking over. */
  targetProvider: AgentProvider
  /** The connection taking over — its `models` is the only tier that can carry a window for a gateway id. */
  targetConnection: LlmConnection
  /**
   * The model the session will be on AFTER the switch — never `managed.model`,
   * which still holds the SOURCE model at the call site.
   */
  targetModel: string | undefined
  /** Whether the target runtime already holds an anchor for this session (D7). */
  targetHasAnchor: boolean
  /**
   * TEST SEAM — production never passes it.
   *
   * {@link NATIVE_HISTORY_CARRY_IMPLEMENTED} stays the single source of truth
   * and is the one place T1a and T2 flip a line. It was `false` for every
   * runtime when P3 landed, which left the window resolution and the fit
   * arithmetic below as branches no test could reach — and A3 of the plan is
   * precisely the finding that an untestable `native` arm ships untested. This
   * makes the arm reachable from a test without making it reachable from the
   * product.
   *
   * **Still needed after T1a flipped `codex-runtime`.** The arm is now
   * reachable through that one provider, but the rows that assert the arm for a
   * runtime whose real answer is `false` (and the rows that must keep passing
   * when the map changes again) would otherwise be re-keyed on whichever
   * provider happens to be implemented — which is how a suite comes to test the
   * map instead of the arithmetic.
   */
  nativeCarrySupportedOverride?: boolean
}): HistoryCarryDecision {
  const estimatedTokens = estimateCarryPayloadTokens(input.rows)
  const modelId = input.targetModel ?? ''
  // `resolveContextWindow` needs a model id to look anything up. With none, the
  // window is unknown by definition — the same arm as `'unavailable'`.
  //
  // **P2.521 — the `gatewayPresetWindow` tier is passed here because the SPAWN
  // paths pass it and this planner did not**, so the two ends of one switch
  // answered "how big is the target's window" differently. Measured at HEAD
  // 2026-09-03 on a gateway card whose stored window was lost (the `models`
  // entry is present, its `contextWindow` is not — a refresh that predates
  // `NESTOR_GATEWAY_MODEL_WINDOWS`, or a hand-edited connection): all three
  // target providers answered `contextWindow: null`, `source: 'unavailable'`,
  // `plan: 'text'`, `reason: 'context-window-unknown'` — including a
  // 179-estimated-token conversation — while the table holds **262 000** for
  // `tgpt/qwen35-397b-a17b-fp8`. That is exactly the case
  // {@link HistoryCarryReason}'s `context-window-unenforced` docblock exists
  // for, degrading on *window unknown* while the classifier answers *resolved*.
  //
  // Reusing the SPAWN path's reader rather than threading a second source, as
  // the row asked: `resolveContextWindow`'s own `preset` tier is what
  // `pi-agent.ts`'s `refreshCatalogContextWindow` passes, and
  // `resolveClaudeSpawnContextWindow`'s `gateway-preset` tier reads the same
  // `nestorGatewayModelWindow` table with the same `isNessyGatewayBaseUrl`
  // gate — so all three now consult one table through one boundary rule.
  //
  // Ranking is unchanged and that is the point: the tier sits BELOW
  // `connection_override`/`provider_catalog` (the live value still wins, so a
  // connection whose window is intact behaves exactly as before) and ABOVE
  // `static_registry`. Gated on the WHOLE-URL `isNessyGatewayBaseUrl`, never
  // `isNestorCliBaseUrl`'s prefix: a BYO endpoint on the same host under
  // another path may serve a same-named id with a different real window, and
  // promising a fit against someone else's number is the failure this tier
  // exists to prevent. Same rule, same reason, as the one deciding whether
  // `Nestor-Token` may be attached.
  const gatewayPreset = isNessyGatewayBaseUrl(input.targetConnection.baseUrl)
    ? nestorGatewayModelWindow(modelId)
    : undefined
  const resolved: ResolvedContextWindow = modelId
    ? resolveContextWindow({
        modelId,
        connection: input.targetConnection,
        ...(gatewayPreset === undefined ? {} : { gatewayPresetWindow: gatewayPreset }),
      })
    : { modelId: '', contextWindow: null, source: 'unavailable' }
  const requiredTokens = SESSION_RESTING_CONTEXT_TOKENS
    + Math.ceil(estimatedTokens * HISTORY_CARRY_TOKEN_MARGIN)

  const base = {
    estimatedTokens,
    requiredTokens,
    contextWindow: resolved.contextWindow,
    windowSource: resolved.source,
    modelId,
  }

  if (input.targetHasAnchor) {
    return { plan: 'anchor', reason: 'target-already-anchored', ...base }
  }
  const nativeCarrySupported = input.nativeCarrySupportedOverride
    ?? supportsNativeHistoryCarry(input.targetProvider)
  if (!nativeCarrySupported) {
    return { plan: 'text', reason: 'no-native-carry-implemented', ...base }
  }
  if (resolved.contextWindow === null) {
    return { plan: 'text', reason: 'context-window-unknown', ...base }
  }
  // Will the TARGET actually enforce the window we just resolved?
  //
  // For the Claude runtime the authority on that is
  // {@link resolveClaudeSpawnContextWindow} — the same function the spawn path
  // uses to decide `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and
  // `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. It answers THREE ways, and only one of
  // them is a reason to degrade:
  //
  // - `resolved` — we declare the window to the subprocess ourselves. The fit
  //   is judged against the number the SDK is told to act on.
  // - `sdk-owned` — a `claude-*` id. We deliberately abstain, and the page says
  //   why the override would be inert anyway. `model-config.md`, section
  //   `#correct-the-window-for-a-gateway-or-custom-model-id`, third of its three
  //   cases, verbatim: "If the ID starts with `claude-` in any casing or
  //   resolves to a Claude model, the variable takes effect only when
  //   `DISABLE_COMPACT` is also set, which disables all compaction." We never
  //   set `DISABLE_COMPACT`, so the binary keeps the model's own boundary —
  //   `model-config.md`, section `#default-auto-compact-thresholds`: "Sonnet 4.6
  //   and Opus 4.6 without extended context compact at the 200K boundary".
  //   **The window is enforced here, by a better authority than ours.** That is
  //   what makes the fit arithmetic safe on this arm and unsafe on `missing`.
  // - `missing` — a real id nothing can size. This is the defect state, and it
  //   is the one the paragraph below is about.
  //
  // **Until P6.10 this arm was an inline `modelId.startsWith('claude-')`, which
  // collapsed `sdk-owned` and `missing` into one verdict and answered `text` for
  // BOTH.** Its comment argued that "the cost of being wrong the other way is a
  // silent conversation reset" — true of `missing`, and backwards for
  // `sdk-owned`, where over-estimating the fit costs a COMPACTION the SDK
  // performs by itself. The cost of the collapse was not theoretical: a
  // `claude-sonnet-4-6` target resolved 200 000 from `MODEL_REGISTRY` then (1M
  // since F1.1221), so every conversation under ~123 200 estimated tokens passed
  // the fit test and was handed the 24×1200 text tail anyway.
  //
  // `missing` still short-circuits, and the reason name still fits: the window
  // `resolveContextWindow` found is one nothing will enforce. Worse than
  // unenforced, in fact — `buildClaudeContextWindowWarning` warns the user that
  // proactive compaction is OFF for such a session, and the gateway's over-limit
  // 400 does not present as `prompt_too_long`, so an overflow reads as a silent
  // conversation reset rather than as an error.
  //
  // Gated on the provider, because the classifier only speaks for the Claude
  // subprocess. Pi and Codex size themselves from the same catalogue
  // `resolveContextWindow` just read, so asking a Claude-specific resolver about
  // them would degrade switches that are fine today.
  if (
    input.targetProvider === 'anthropic'
    && resolveClaudeSpawnContextWindow(input.targetConnection, modelId).kind === 'missing'
  ) {
    return { plan: 'text', reason: 'context-window-unenforced', ...base }
  }
  return requiredTokens <= resolved.contextWindow
    ? { plan: 'native', reason: 'fits', ...base }
    : { plan: 'text', reason: 'does-not-fit', ...base }
}

/**
 * The model the session lands on after a switch — carried when the target can
 * serve it, and the target's own default otherwise.
 *
 * **Why this is not just `target.defaultModel`.** All three gateway cards are
 * seeded from the identical `NESSY_GATEWAY_MODELS` catalogue against the
 * identical base URL (`apps/electron/src/renderer/components/apisetup/nessy-gateway.ts`
 * — `codexGatewayConnectionDefaults()` and `claudeGatewayConnectionDefaults()`
 * both read it), so a user who picked the `fast`-aliased gateway model (its shortName was "Qwen Fast" until P6.1080) on Pi was silently returned
 * to the coder default on Claude Code and Codex. The target can serve that id;
 * nothing but the assignment said otherwise.
 *
 * **And it is not just `resolveModelForProvider` either — three of its inputs
 * produce something the old line never did, and every one of them is a
 * REGRESSION rather than a carry.** The rule for all three is A10's: preserve
 * the outcome the user sees today. Never refuse (a switch is never refused over
 * a model), never invent.
 *
 * 1. **A target whose `models` is empty or unfetched.** The resolver's own
 *    catalogue filter lives inside `if (connection?.models?.length)`
 *    (`factory.ts:759`), so with no catalogue there is nothing to check a
 *    foreign id against and it CARRIES THROUGH — a `tgpt/…` gateway id would
 *    reach a BYO Anthropic connection that has never heard of it. With no
 *    catalogue we cannot establish "the target can serve it", so we do not
 *    carry: the answer is the connection's own default, exactly as before T3.
 * 2. **A `pi` target whose `defaultModel` is off-catalogue.** The resolver
 *    substitutes `connectionModelIds[0]` (`factory.ts:778-780`). That is left
 *    to stand deliberately: `resolveBackendContext` already runs the same
 *    resolver at agent construction (`factory.ts:426`), so the substitution was
 *    ALREADY the model that ran — `managed.model` merely disagreed with it.
 *    Refusing here would be a second refusal path, which contradicts the
 *    answered decision that a switch is never refused over sizing.
 * 3. **A `codex-runtime` or plain `anthropic` target with NO `defaultModel`.**
 *    Those fall to `default: return managedModel || connectionDefault ||
 *    DEFAULT_MODEL` (`factory.ts:797-798`) and `DEFAULT_MODEL` is an **Opus**
 *    id — so a Codex session would come out of the switch holding a Claude
 *    model where today the field goes `undefined`. Clamped below: with no
 *    declared default, only a genuine carry survives.
 *
 * **Reads the connection; never writes it.** `2026-07-29-inert-worklist.md`
 * §3.2 is the standing decision that model filtering happens at the READ
 * boundary and NOT at the persistence boundary — "filtering there would
 * round-trip through `updateLlmConnection` … and permanently destroy a user's
 * model list". `resolveModelForProvider` cites it in its own body, and this
 * helper inherits it: T3 persists `managed.model` and nothing else.
 * `connection.models` and `connection.defaultModel` are byte-identical after a
 * switch, which `runtime-switch-session.test.ts` asserts directly.
 */
export function resolveCarriedModel(
  targetProvider: AgentProvider,
  sourceModel: string | undefined,
  target: LlmConnection,
): string | undefined {
  // Guard 1. No catalogue → no way to establish that the target serves the
  // carried id, and the resolver would wave it through. Today's outcome.
  if (!target.models?.length) return target.defaultModel

  const resolved = resolveModelForProvider(targetProvider, sourceModel, target) || undefined
  if (!resolved) return target.defaultModel

  // Guard 3. With no declared default the resolver's `default:` arm answers
  // `DEFAULT_MODEL`. Only the user's own id may survive that arm; anything else
  // is the resolver inventing a model for a connection that named none, and the
  // field stays `undefined` exactly as it does today.
  if (!target.defaultModel && resolved !== sourceModel) return undefined

  // Guard 2 lands here unmodified: the pi substitution is a model this
  // connection lists, and the resolver is the one authority on that.
  return resolved
}

/**
 * Clamp session settings the TARGET runtime cannot honour.
 *
 * Codex's own `/model` resets reasoning effort to the new model's default
 * rather than carrying the prior level over; we do the narrower, less
 * surprising thing and clamp to the highest level the target still offers.
 * A setting silently retained but unreachable is how a user comes to believe
 * they are in a mode they are not in.
 *
 * The permission half owns NO policy of its own. It folds "the target host
 * disables it" and "the target does not offer it at all" into one unavailable
 * list and hands that to {@link normalizeManagedPermissionMode}, the repo's
 * single graded chain. That chain lands a no-write mode (`plan`, `explore`,
 * `dontAsk`) on the `plan` floor "rather than to a mode that could prompt";
 * the earlier draft of this helper fell back to `default` instead, which turns
 * a no-write session into a write-capable one on a switch. Every fallback in
 * the chain is narrower than the mode it replaces, so this can only clamp.
 */
export function renormalizeForRuntime(input: {
  permissionMode?: PermissionMode
  thinkingLevel?: ThinkingLevel
  capabilities: ComposerCapabilities
  disabledPermissionModes: readonly PermissionMode[]
}): { permissionMode?: PermissionMode; thinkingLevel?: ThinkingLevel } {
  const levels = input.capabilities.reasoning.levels
  const thinkingLevel = input.thinkingLevel === undefined || levels.includes(input.thinkingLevel)
    ? input.thinkingLevel
    : (levels[levels.length - 1] ?? 'off')

  const offered = new Set(input.capabilities.permissions.modes)
  const unavailable = PERMISSION_MODE_ORDER.filter(
    mode => !offered.has(mode) || input.disabledPermissionModes.includes(mode),
  )
  const permissionMode = input.permissionMode === undefined
    ? undefined
    : normalizeManagedPermissionMode(input.permissionMode, unavailable)

  return {
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  }
}
