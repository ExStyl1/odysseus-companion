import type { ComposerCapabilities } from '../../protocol/dto.ts'
import type { LlmConnection } from '../../config/llm-connections.ts'
import { isCodexChatGptSubscriptionConnection, modelSupportsImages, resolveMidStreamBehavior } from '../../config/llm-connections.ts'
import { isNessyGatewayBaseUrl } from './internal/drivers/upstream-target.ts'
import {
  PLUGIN_WORKFLOW_SLASH_COMMAND_ID_PREFIX,
  WORKFLOW_SLASH_COMMAND_ID_PREFIX,
} from '../../slash-commands/common.ts'
import { runtimeDispatchesWorkflows, runtimeForksConversations } from '../runtime-agent-support.ts'
import { PERMISSION_MODE_ORDER } from '../mode-types.ts'
import { THINKING_LEVEL_IDS, type ThinkingLevel } from '../thinking-levels.ts'; import { backgroundTasksDisabled, type EnvRecord } from '../../config/background-task-settings.ts' // UB14.34 — one line: this file is cited by line
import { modelSupportsUltracodeEffort, ultracodeMechanism } from '../ultracode-mode.ts'
import type { AgentProvider, CloudComposerModeOption } from './types.ts'

const ALL_LEVELS = [...THINKING_LEVEL_IDS] as ThinkingLevel[]
const ALL_PERMISSION_MODES = [...PERMISSION_MODE_ORDER]
const NESTOR_CLOUD_MODE_OPTIONS: NonNullable<ComposerCapabilities['permissions']['modeOptions']> = [
  {
    mode: 'plan',
    label: 'Plan',
    shortLabel: 'Plan',
    description: 'Remote planning mode. The agent develops a strategy without applying changes.',
    iconMode: 'plan',
    remoteModeId: 'plan',
  },
  {
    mode: 'default',
    label: 'Act',
    shortLabel: 'Act',
    description: 'Remote implementation mode. Nessy still asks before local tool execution.',
    iconMode: 'default',
    remoteModeId: 'act',
  },
]

/**
 * Per-runtime composer defaults — TOTAL over the runtime vocabulary (P2.124).
 *
 * It was `Partial<Record<AgentProvider, …>>` with a `?? CONSERVATIVE` fallback,
 * which is the shape P2.124's inventory found at most of the eleven sites: a
 * runtime added to the union compiled, took `CONSERVATIVE`, and reported
 * `folders: true` plus `images: 'per-model'` — which `modelSupportsImages`
 * resolves to `true` for any provider type it does not recognise. A runtime
 * nobody had described yet was therefore granted image and folder attachments
 * by DEFAULT, silently.
 *
 * `Record`, not `Partial<Record>`, is the whole fix: the compiler now refuses a
 * missing member, so a new runtime breaks the build here instead of inheriting
 * a grant. {@link CONSERVATIVE} survives only as a guard against a provider
 * string that is not in the union at all (a persisted session written by a newer
 * build, say) — it is no longer reachable for any runtime the type system knows.
 */
export const PROVIDER_DEFAULTS: Record<AgentProvider, {
  images: ComposerCapabilities['attachments']['images']
  folders: boolean
  reasoningLevels: ThinkingLevel[]
}> = {
  anthropic: { images: 'yes', folders: true, reasoningLevels: ALL_LEVELS },
  pi: { images: 'per-model', folders: true, reasoningLevels: ALL_LEVELS },
  'codex-runtime': {
    images: 'per-model',
    folders: false,
    reasoningLevels: ['off', 'low', 'medium', 'high'] as ThinkingLevel[],
  },
  'nestor-cloud-agent': {
    images: 'no',
    folders: true,
    reasoningLevels: [],
  },
}

const CONSERVATIVE = {
  images: 'per-model' as const,
  folders: true,
  reasoningLevels: [] as ThinkingLevel[],
}

/**
 * `claude-runtime` collapses onto the `anthropic` AgentProvider
 * (`providerTypeToAgentProvider`, T4), so an AgentProvider-keyed lookup alone
 * hands a Nessy Gateway session api.anthropic.com's capabilities. The composer
 * must describe the ENDPOINT the session talks to, not the SDK it uses.
 *
 * Two corrections, both narrower than `anthropic`:
 *
 * - `images: 'per-model'` — resolved against the connection catalog by
 *   {@link modelSupportsImages}. The gateway card's two models declare
 *   `supportsImages: false` (`NESSY_GATEWAY_MODELS`, and `fetchNestorModels`
 *   spreads the stored override back over every refresh), so the composer still
 *   offers no image attachment there. An UNDECLARED model is no longer defaulted
 *   to "no": that default's recorded reason — "the local adapter drops images
 *   anyway (`to-chat.ts` has no image mapping in v1)" — died with `30628c7d0`,
 *   and per the owner ruling of 2026-08-28 the host carries the modality
 *   faithfully and lets the endpoint refuse.
 * - reasoning stops at `high`. The adapter's `effortForThinkingBudget` ladder
 *   (`anthropic/inbound.ts`) maps every budget above 16 384 onto `"high"`, and
 *   `TOKEN_BUDGETS.default` puts high/xhigh/max at 20 000/26 000/32 000 — three
 *   levels the user could pick that reach the upstream as one. Same reduced list
 *   `codex-runtime` declares.
 *
 * `folders` stays true (a ClaudeAgent capability, unlike codex). Mid-stream is
 * NOT queue here: `defaultMidStreamBehavior('claude-runtime')` returns `'steer'`
 * — only `nestor-cloud-agent` defaults to `'queue'` — and both
 * `config/__tests__/midstream-behavior.test.ts` and
 * `backend/__tests__/factory.test.ts` pin that.
 */
const CLAUDE_RUNTIME_DEFAULTS = {
  images: 'per-model' as const,
  folders: true,
  reasoningLevels: ['off', 'low', 'medium', 'high'] as ThinkingLevel[],
}

/**
 * Which context-usage surface a runtime supports.
 *
 * P2.124: this was an if-chain over three providers with a CATCH-ALL return of
 * the `anthropic` shape, so a runtime added to the union silently inherited
 * `thresholdKind: 'formula-claude'` — a threshold warning computed from a window
 * only the Claude SDK reports. A fabricated number presented as a measurement is
 * the exact failure mode this plan keeps meeting, so the chain is now an
 * exhaustive `switch`: the four arms are unchanged and a fifth runtime fails the
 * typecheck at the `never` below rather than borrowing Claude's arithmetic.
 */
function resolveContextUsageCapability(provider: AgentProvider): ComposerCapabilities['contextUsage'] {
  if (provider === 'pi') {
    return {
      kind: 'fresh-local',
      refresh: true,
      compact: { manual: true, auto: true },
      // Pi's snapshot carries `autoCompactionThreshold` computed by the SDK
      // that will act on it. Nothing to derive.
      thresholdKind: 'real',
    }
  }

  if (provider === 'nestor-cloud-agent') {
    return {
      kind: 'unavailable',
      reason: 'remote-not-reported',
      refresh: false,
      compact: { manual: false, structured: false },
      // The remote sends its own threshold when it has one; an absent one means
      // there is none, not that we should invent it.
      thresholdKind: 'real',
    }
  }

  if (provider === 'codex-runtime') {
    return {
      // Codex reports token counts (`thread/tokenUsage/updated`) but no context
      // SNAPSHOT, so the composer still has no occupancy to draw and `kind`
      // stays honest — this is the value that gates the `tokenUsage` fallback.
      kind: 'unavailable',
      reason: 'unsupported',
      refresh: false,
      // Manual compaction IS available: `thread/compact/start` is in the bundled
      // app-server's client-request method table. `auto` is deliberately absent
      // rather than false — codex has an auto-compaction knob
      // (`model_auto_compact_token_limit`) that nothing here has a source to
      // derive, so we neither claim it nor deny it.
      compact: { manual: true },
      // `model_auto_compact_token_limit` exists in codex and nothing here can
      // derive it, so codex gets NO threshold warning rather than a made-up one.
      thresholdKind: 'none',
    }
  }

  if (provider === 'anthropic') {
    // `anthropic`, which `claude-runtime` also collapses onto. The SDK does not
    // report its threshold, but it derives it from the window it believes — the
    // window F2 now makes correct — so the renderer can compute the same number
    // instead of guessing at a fraction of it.
    //
    // P6.264 · `kind` was `'unavailable'` with `refresh: false`, and that was
    // true only because nothing asked. The runtime publishes the whole card as
    // data — `SDKContextUsage` is its own "structured twin of the /context
    // report" — and `ClaudeAgent.requestContextUsage` now returns it mapped
    // (`backend/claude/sdk-context-usage.ts`), so the composer has a real
    // occupancy to draw and a refresh that reaches a real reader.
    //
    // `fresh-local` and not a new arm: the value describes where the snapshot
    // comes from, and a control request to the child that owns the context is
    // the same relationship Pi's subprocess has. What stays DIFFERENT from Pi is
    // the threshold, and it keeps saying so: `formula-claude` means the renderer
    // computes the warning from the window rather than being told one.
    //
    // `compact` is deliberately left as it was — absent. Manual compaction on
    // this runtime is its own question with its own row, and claiming it here
    // because the context card arrived would be the catch-all mistake the
    // exhaustive switch above was written to end.
    return {
      kind: 'fresh-local',
      refresh: true,
      thresholdKind: 'formula-claude',
    }
  }

  // Exhaustiveness FOR THE COMPILER: a runtime added to the vocabulary makes
  // `provider` non-`never` here and fails `bun run typecheck:shared`, so it must
  // DECIDE above rather than inherit an arm written for someone else.
  const unhandled: never = provider
  void unhandled
  // ...and at RUNTIME, no claim rather than a throw or a borrowed answer. A
  // provider string outside the union reaches this line only from data (a
  // session a newer build persisted), where crashing the composer is worse than
  // saying nothing, and where the old catch-all's answer was worse than both: it
  // handed an unknown runtime `thresholdKind: 'formula-claude'`, a threshold
  // computed from a context window only the Claude SDK reports.
  return { kind: 'unavailable', reason: 'unsupported', refresh: false, thresholdKind: 'none' }
}

function resolveNestorCloudPermissions(
  cloudModes?: readonly CloudComposerModeOption[],
): ComposerCapabilities['permissions'] {
  const sourceOptions = cloudModes?.length ? cloudModes : NESTOR_CLOUD_MODE_OPTIONS
  const modeOptions = sourceOptions.map(option => ({ ...option }))
  const modes = Array.from(new Set(modeOptions.map(option => option.mode)))
  return { modes, modeOptions }
}

/**
 * Who may be offered `/quota` (T19; widened to every gateway card by F1.6).
 *
 * The remote agent always — its whole backend is that gateway. Every LOCAL
 * runtime depends on WHERE the connection points: the three one-click Nessy
 * Gateway cards (Pi, `claude-gateway`, `codex-gateway`) are metered by the same
 * per-user limiter `GET /api/v1/quota` reports (`cli_proxy_handler.go:109,:205,:286-298`),
 * and a BYO endpoint is not, so a BYO connection would answer with a budget that does not govern it.
 *
 * The discriminator is the WHOLE-URL rule every CONNECTION-level credential
 * decision in this repo already reads —
 * `backend/internal/drivers/upstream-target.ts` symbol `isNessyGatewayBaseUrl`,
 * normalised equality with the chat base. Never a second spelling of "this is
 * the gateway".
 *
 * The runtime FAMILY no longer takes part (F1.6, below): `pi_compat` still
 * collapses onto `pi` (`providerTypeToAgentProvider`), and the Claude and Codex
 * gateway cards carry the same baseUrl, but every local runtime now answers the
 * row with the same host-side read (`agent/backend/internal/nestor-quota.ts`),
 * so the URL alone is the whole question.
 *
 * ## DA1.44, corrected 2026-09-17 — the whole-URL rule, not a prefix of any width
 *
 * This gate read `isNestorCliBaseUrl`, a `startsWith` over `…/api/v1/cli/` that
 * accepts EVERY path under it, and DA1.44 moved it to
 * `auth/nestor.ts` symbol `isNestorGatewayCredentialUrl`. That was a narrowing
 * and it was NOT enough: the named-endpoint predicate answers *"may the dp JWT
 * ride on THIS REQUEST url?"*, so its third arm accepts everything UNDER the
 * chat base — which is right for a request (that is where `/chat/completions`
 * and the SDK's own `/models` live) and wrong for a CONNECTION. A BYO card whose
 * `baseUrl` is a chat-base SUBPATH was still offered `/quota` and still told by
 * DA1.17's pointer sentence (since removed, F1.6) that it spends the Gateway budget, while
 * the turn spends the user's own key — the exact disagreement DA1.44 set out to
 * close. `isNessyGatewayBaseUrl` is the rule the credential side reads on all
 * three runtimes (`pi-agent.ts` symbol `isNestorGatewayPiConnection` after
 * DA1.40; `drivers/anthropic.ts` and `drivers/codex.ts` since 2026-08-08), so
 * the budget claim and the credential can no longer disagree.
 *
 * All three one-click cards write `NESSY_GATEWAY_BASE_URL`, which IS the chat
 * base, so the narrowing loses none of them. The two `describeQuota` overrides
 * named below read the same predicate, changed in the same commit.
 *
 * NOT the same as `pi-agent.ts` symbol `describeQuota`, which still reads the
 * CLI prefix by DA1.10's written decision — the asymmetry is named in
 * `auth/nestor.ts`'s census bullet so the next reader meets it deliberately. It
 * is safe in this direction: the menu offers strictly less than the answer
 * serves.
 *
 * ## F1.6 (origin D1.77) — the exclusion DA1.17 left standing is withdrawn
 *
 * This read `provider === 'pi' && …`, and the recorded reason was that the Claude
 * and Codex cards' RUNTIMES have no `/quota` path — true of the runtime's own
 * budget surface and irrelevant to a HOST-side read: `describeNestorQuota` is
 * provider-neutral code whose URL resolver takes only the connection's origin,
 * and the budget those two cards spend IS the gateway's. DA1.17 kept the gate
 * (widening it was the owner's posture, and it was pinned as a negative control)
 * and had both cards NAME the budget through a pointer sentence instead.
 *
 * OWNER 2026-09-18 ~16:40, item 3, build (b) took that posture: a non-BYO
 * gateway card reads the gateway budget. So the gate is the connection alone;
 * `ClaudeAgent.describeQuota` and `CodexAgent.describeQuota` read the budget
 * through `agent/backend/internal/nestor-quota.ts` `NessyGatewayQuotaRead`, and
 * the pointer is gone, because a card that can SHOW the number must not also
 * point elsewhere for it. The pinned negative control flipped in the same
 * commit (`backend/__tests__/composer-capabilities.test.ts`,
 * `agent/__tests__/gateway-quota-pointer.test.ts`). Codex's OWN subscription
 * windows (F1.7) are a different read on a different surface and do not widen
 * this gate.
 *
 * What stays OUT: a BYO connection of any family, a connectionless session, a subscription card.
 */
function offersNestorQuota(provider: AgentProvider, connection?: LlmConnection): boolean {
  if (provider === 'nestor-cloud-agent') return true
  // F1.202 — the ChatGPT (Codex) card reads codex's OWN windows (F1.7's reader,
  // `backend/codex/rate-limit-windows.ts`): its session is signed in to a ChatGPT
  // account, so `CodexAgent.describeQuota` has something to read, and the row is
  // offered on the same predicate the session resolves its provider through.
  if (provider === 'codex-runtime' && isCodexChatGptSubscriptionConnection(connection)) return true
  return isNessyGatewayBaseUrl(connection?.baseUrl)
}

/**
 * The menu's own gate — ONE table, four rows, and the reason it is a table.
 *
 * Every row here answers the same question: *would the seam that executes this
 * menu row refuse it on this session?* The capability ledger calls the negative
 * answer left standing `ADVERTISED` — "the surface keeps offering what the
 * target cannot do" — and it has now been found three separate times, each by a
 * lane doing something else (P2.212 → P2.279, P3.69 → P3.71, and `/compact` on
 * the remote agent, found by this row's own enumeration). Three findings, one
 * shape, so this is one place rather than a third and fourth condition grown
 * beside the first two.
 *
 * Each row reads the SAME predicate the seam reads — never a re-spelled
 * `provider === …` — so the menu and the refusal cannot answer differently:
 *
 * - `btw`/`recap` ride the tool-less `queryLlm`/mini-completion route, and
 *   `NestorCloudAgent.queryLlm` throws by design (remote agent, no local query
 *   substrate).
 * - `quota` reads `GET /api/v1/quota`, a route only the Nessy gateway serves —
 *   the mirror image, gated on the CONNECTION (T19) because the same limiter
 *   meters the built-in Pi gateway card while a BYOK Pi connection has no
 *   Nestor budget to report.
 *
 *   **This is the ONE row where the sentence above is qualified, and it is
 *   qualified deliberately (2026-09-17).** On the Pi seam it is no longer the
 *   same predicate: this row reads {@link isNessyGatewayBaseUrl} while
 *   `agent/pi-agent.ts` symbol `describeQuota` still reads the `…/api/v1/cli/`
 *   prefix, which DA1.10's census bullet in `auth/nestor.ts` declines to narrow
 *   with its reason written out. The residue is one-directional and safe — the
 *   menu offers strictly LESS than the seam serves, never more — so it is not
 *   the ADVERTISED shape this table exists to prevent; the inverse would be.
 *   Closing it means reversing a written decision, i.e. a posture, not a sweep.
 *   The other two `describeQuota` overrides (`claude-agent.ts`,
 *   `codex-agent.ts`) DO read this row's predicate, so the sentence holds
 *   unqualified there.
 * - `subtask` needs a conversation fork, and {@link runtimeForksConversations}
 *   is the predicate `BaseAgent.canForkConversation()` is tied to (P3.71).
 * - `compact` is refused by `dispatchSlashCommandAction` itself whenever the
 *   resolved `contextUsage.compact.manual` is `false` — so the row reads that
 *   resolved value rather than naming the runtime, and the two cannot disagree.
 *   Before this row the remote agent LISTED `/compact` and the renderer's gate
 *   made picking it a silent no-op: the same lie as the other two, and quieter.
 *
 * What stays out, deliberately: the seam still answers a TYPED form on every
 * runtime — `/subtask <task>` and `/compact` reach `BaseAgent.chat` and get the
 * honest "not available on this runtime", and `/workflow-name` reaches the
 * `workflowInvocation` refusal. This decides only what the MENU advertises and
 * what a menu selection may dispatch. `sub-agents.md#fork-the-current-conversation`
 * promises the typed affordance ("You can start a fork yourself with `/subtask`
 * followed by a task, whether or not fork mode is on") and it is untouched;
 * the same Note is also upstream's own precedent for withdrawing the row when
 * the mechanism is off ("`/subtask` isn't available").
 */
function resolveExcludedCommandIds(
  input: { provider: AgentProvider; connection?: LlmConnection },
  contextUsage: ComposerCapabilities['contextUsage'],
): string[] {
  const excluded: string[] = []
  if (input.provider === 'nestor-cloud-agent') excluded.push('btw', 'recap')
  if (!offersNestorQuota(input.provider, input.connection)) excluded.push('quota')
  if (!runtimeForksConversations(input.provider)) excluded.push('subtask')
  // P2.217 — `/approve` overrules the CODEX auto-review guardian, and nothing
  // else runs one: off codex `BaseAgent.approveGuardianDenial` answers with
  // exactly that sentence. Withdrawn here rather than offered-and-refused,
  // because this table is where every other per-runtime menu gate lives and a
  // fifth condition somewhere else is the divergence it exists to prevent.
  if (input.provider !== 'codex-runtime') excluded.push('approve')
  if (contextUsage?.compact?.manual === false) excluded.push('compact')
  // P6.264 — `/context` promises a BREAKDOWN, and on codex there is nothing to
  // break down. `thread/tokenUsage/updated` reports totals and a context window;
  // there is no `thread/context/*` method in the generated client-request table,
  // so the snapshot carries no `categories` and the overlay falls through to its
  // legacy path, which on codex resolves to exactly ONE row — "unattributed",
  // holding every token. A menu entry that can only answer "all of it" is the
  // same shape as the four withdrawals above: offered, picked, and useless.
  //
  // Named rather than derived from `contextUsage.kind === 'unavailable'`, and
  // the reason is the other half of this row: the ANTHROPIC arm carries that
  // same `unavailable` today while the SDK publishes a full `SDKContextUsage`
  // that this host fetches and drops on the floor. A derivation would withdraw
  // the one runtime whose breakdown is about to become the richest.
  //
  // The TYPED form is untouched, per this table's own scope note.
  if (input.provider === 'codex-runtime') excluded.push('context')
  return excluded
}

/**
 * The same gate for the command families whose ids are minted from user data.
 *
 * A saved workflow recipe is offered as `/<name>` with the id
 * `custom:workflow:<name>`, and the names are discovered per session — so an
 * id LIST cannot name the family and a PREFIX can. This is the half of P2.212
 * that P2.279 was left holding: the `chat()` seam refuses a
 * `workflowInvocation` off Pi and the keyword route is gated
 * (`WORKFLOW_KEYWORD_DISPATCH_RUNTIMES`), while the composer went on listing
 * the command.
 *
 * The plugin family (`custom:plugin-workflow:…`) is ALREADY withheld one layer
 * up — `capabilities/resolver.ts` disables a `workflow` candidate off Pi and
 * `SessionManager.pluginPromptCommandEntries` filters on `summary.enabled`
 * (P3.34) — so listing it here is the second line, not the first, and it is
 * listed because the renderer's claim should not depend on the server having
 * remembered. Both prefixes come from the constants the id builders mint with.
 */
function resolveExcludedCommandIdPrefixes(provider: AgentProvider): string[] {
  if (runtimeDispatchesWorkflows(provider)) return []
  return [WORKFLOW_SLASH_COMMAND_ID_PREFIX, PLUGIN_WORKFLOW_SLASH_COMMAND_ID_PREFIX]
}

/**
 * UB14.34 (R4-14) — whether this runtime starts a shell command as a BACKGROUND task with its OWN tool,
 * which is what the composer's "Run in background" offer on a pasted console snippet asks it to do (the
 * offer sends `runCommandMessage`, an ordinary user message; the runtime's tool and the session's
 * permission mode decide the rest).
 *
 * Native-first, per runtime — what each one already has, read rather than assumed:
 * - claude (and `claude-runtime`, which collapses onto `anthropic`): native. `tools-reference.md`,
 *   "Background commands": "Claude can set `run_in_background: true` to start the command as a
 *   background task and continue working while it runs."
 * - Pi: our bash tool's `run_in_background` (`pi-agent-server/src/local-tools/runtime-backed-tools.ts`,
 *   the `localPort('bash', …)` row) — the host's process store runs it, and the task chip shows it.
 * - codex: NOT claimed. Whether its shell runs a command in the background without blocking the turn is
 *   UB14.19's measurement on the binary (UB14.16's stated residue); a codex page alone would be a
 *   hypothesis, so the offer stays withdrawn there until that reading exists.
 * - the remote agent: no local shell substrate.
 *
 * The background-task off switch withdraws it on both runtimes that have it: `backgroundTasksDisabled`
 * is the one predicate every detach site reads (Pi refuses `run_in_background` on it; claude receives it
 * projected as `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, `options.ts` `applyBackgroundTaskOffSwitch`).
 * Residue, stated: an operator who exports the VENDOR spelling alone in the host env is not read here,
 * so claude keeps the offer and the agent answers that it cannot background — the projection never
 * overwrites that inherited value, and this reads only our name, the one the host owns.
 */
function runtimeStartsBackgroundShell(provider: AgentProvider, env: EnvRecord): boolean {
  if (provider !== 'anthropic' && provider !== 'pi') return false
  return !backgroundTasksDisabled(env)
}

export function resolveComposerCapabilities(input: {
  provider: AgentProvider
  connection?: LlmConnection
  model?: string
  cloudModes?: readonly CloudComposerModeOption[]
  /**
   * P6.940 clause (1) — the host's `sessionAgent` key, if one is set.
   *
   * Passed in rather than read here: this function is pure over its input and
   * the key is a disk read, which P3.326 measured as 80 % of `getSessions()`
   * when it repeated per session.
   */
  sessionAgent?: string
  /**
   * UB14.34 — where the background-task off switch is read ({@link runtimeStartsBackgroundShell}).
   * Defaults to this process's env (the server's, which is what spawns every runtime); tests pass one.
   */
  env?: EnvRecord
}): ComposerCapabilities {
  const defaults = input.connection?.providerType === 'claude-runtime'
    ? CLAUDE_RUNTIME_DEFAULTS
    : PROVIDER_DEFAULTS[input.provider] ?? CONSERVATIVE
  const midStreamBehavior = input.connection ? resolveMidStreamBehavior(input.connection) : 'steer'
  const images = defaults.images === 'per-model' && input.connection && input.model
    ? (modelSupportsImages(input.connection, input.model) ? 'yes' : 'no')
    : defaults.images
  const contextUsage = resolveContextUsageCapability(input.provider)
  const excludedCommandIdPrefixes = resolveExcludedCommandIdPrefixes(input.provider)

  return {
    attachments: { files: true, images, folders: defaults.folders },
    mentions: { files: true, skills: true, sources: true },
    // Every per-command menu gate is one table — see
    // `resolveExcludedCommandIds` for the four rows and why they are not four
    // conditions. Spelled as EXCLUSIONS because `commandIds: string[]` is typed
    // and honoured but no production call site has ever passed an array; the
    // exclusion path is the one with end-to-end coverage.
    //
    // `excludedCommandIdPrefixes` is the same subtraction for the families whose
    // ids are minted per session (workflow recipes) and therefore cannot be
    // enumerated by the resolver.
    slash: {
      commandIds: 'all',
      excludedCommandIds: resolveExcludedCommandIds(input, contextUsage),
      ...(excludedCommandIdPrefixes.length ? { excludedCommandIdPrefixes } : {}),
    },
    submit: { queue: midStreamBehavior === 'queue', steer: midStreamBehavior === 'steer' },
    reasoning: { levels: defaults.reasoningLevels },
    permissions: input.provider === 'nestor-cloud-agent'
      ? resolveNestorCloudPermissions(input.cloudModes)
      : { modes: [...ALL_PERMISSION_MODES] },
    // A remote agent is not a switch target and not a switch source: it has no
    // local query substrate and its own mode options, so every tier's copy
    // would have to become conditional. Every other provider can move.
    connection: {
      switchable: input.provider !== 'nestor-cloud-agent',
      activeRuntime: input.provider,
    },
    contextMeter: true,
    contextUsage,
    // C3.163/C3.165 (QK5) — what the ultracode toggle can do here.
    //
    // Reported on EVERY runtime, `unsupported` included, and that is the point:
    // on codex the control has to be visibly unavailable with its reason, and a
    // withheld field says nothing. It is the mirror image of the exclusion table
    // above — that one withdraws a menu row a runtime cannot honour, this one
    // keeps a row and labels it, because "this runtime has no such mode" is
    // information the user wants and a missing row is not.
    //
    // `agent/ultracode-mode.ts` is the single resolver; the mechanism is derived
    // from `WORKFLOW_KEYWORD_DISPATCH_RUNTIMES`, so claude gets the vendored
    // settings key, Pi the workflow keyword path it already has, and codex and
    // the remote agent an honest `unsupported`.
    ultracode: {
      mechanism: ultracodeMechanism(input.provider),
      modelCapable: modelSupportsUltracodeEffort(input.model),
    },
    // P6.940 — reported ONLY on the runtimes that apply the pin, which is now
    // TWO of them (P6.961 turned the second one on).
    //
    // claude has a main-thread agent option and this host sets it
    // (`pinClaudeMainThreadAgent`, P6.312). Pi has no such option, so clause (2)
    // composed the projection in the host instead
    // (`resolvePiSessionAgentPin` → `piSessionAgentPrompt` + the intersected
    // tool universe + the one-shot initial prompt): a pinned Pi session now
    // BEHAVES as the agent, and until this row it said nothing about it — the
    // inverse of the advertised-and-unavailable lie the exclusion table above
    // exists to end, and just as misleading.
    //
    // codex stays off: it layers role config for SPAWNED agents only, so a badge
    // there would name an agent the session is not running as.
    //
    // The badge names the SETTING, not a resolved pin, and that is honest on
    // both runtimes for one reason: an unknown name degrades identically —
    // `pinClaudeMainThreadAgent` and `resolvePiSessionAgentPin` each emit a
    // diagnostic naming the roster and apply nothing. `claude-runtime` collapses
    // onto `anthropic`, the same way `resolveContextUsageCapability` treats it.
    //
    // The badge's own title already carries what BOTH arms withhold — the
    // connection's model is unchanged — so the projection needed no second
    // sentence (ledger K7, one session equals one upstream).
    ...(input.sessionAgent && (input.provider === 'anthropic' || input.provider === 'pi')
      ? { sessionAgent: input.sessionAgent }
      : {}),
    // P6.951 + P6.864 — reported only where an answer NOTE reaches the model.
    //
    // The DENIAL half is native on all three (below). The APPROVAL half is
    // native on none of them — no runtime's allow branch has a feedback field —
    // so P6.864 gave all three the same host queue
    // (`BaseAgent.recordPermissionAnswerNote`), which is why one boolean still
    // answers for both halves rather than splitting into two.
    //
    // claude: native. `PermissionResult`'s deny branch carries `message`, which
    // `buildClaudeCanUseTool` fills — with the declined constant until this row,
    // with the user's note now. `claude-runtime` collapses onto `anthropic`, the
    // same way the pin above and `resolveContextUsageCapability` treat it.
    //
    // codex: native and PARTIAL. `buildApprovalResponse`'s `rejection` argument
    // reaches the model on the v1 approval kinds only — its own docblock records
    // that the v2 responses have nowhere to put it — so a note on a v2-kind
    // prompt is dropped. Offered anyway, because that is the same partial the
    // host's existing refusal reason already ships on this runtime and the note
    // is additive to a card the user is answering regardless.
    //
    // Pi: HOST-SIDE, and offered since P6.963. There is nothing native to
    // enable — the prompt is raised by the host permission service
    // (`PiPermissionServicePort`), which is native-first step 2 — so the note
    // now travels the one route it has: the card's answer settles the direct
    // resolver, the resolver's `comment` becomes the deny receipt's `reason`
    // instead of the standing "Permission denied by user.", and that `reason` is
    // what `pre_tool_use_response` already carried back to the model. The
    // capability is the honest shape of that: the note reaches the model on all
    // three runtimes, by three different mechanisms.
    ...(input.provider === 'anthropic' || input.provider === 'codex-runtime' || input.provider === 'pi'
      ? { answerNote: true as const }
      : {}),
    // UB14.34 — the pasted-snippet "Run in background" offer, only where the runtime's own tool can
    // honour it; see `runtimeStartsBackgroundShell` for the per-runtime evidence and the off switch.
    ...(runtimeStartsBackgroundShell(input.provider, input.env ?? process.env)
      ? { backgroundShell: true as const }
      : {}),
    // UB12.77 — the toolbar's branch chip on every provider; the field's own docblock says why the name stayed
    // and why its unread `workingDir` half went.
    externalFooter: { gitBranch: true },
  }
}
