import {
  isLocalConnection,
  type LlmConnection,
} from '@config/llm-connections'
import {
  THINKING_LEVELS,
  type ThinkingLevel,
  type ThinkingLevelDefinition,
} from '@nessy-agent/shared/agent/thinking-levels'

/**
 * UB14.30 — the effort levels THIS session's runtime honours, in `THINKING_LEVELS` order with their display keys.
 *
 * `levels` is `ComposerCapabilities.reasoning.levels`, the server's answer per runtime (all six on Pi and
 * api.anthropic.com, `off`–`high` on codex and on the `claude-runtime` gateway adapter, none on nestor-cloud and on
 * an older server). v0.15.1's `ComposerModelMenu` and `CompactModelSelector` list the global six on every runtime;
 * both of ours ask this one function, so the two pickers cannot offer different levels for one session (D1.214's
 * defect class) and neither offers a level the server would clamp away on the next switch (`renormalizeForRuntime`
 * walks the same list). An empty answer offers nothing: no effort rows and no effort pill.
 */
export function offeredThinkingLevels(levels: readonly ThinkingLevel[]): readonly ThinkingLevelDefinition[] {
  return THINKING_LEVELS.filter(level => levels.includes(level.id))
}

/**
 * Format token count for display (e.g., 1500 -> "1.5k", 200000 -> "200k").
 * Shared by the desktop model dropdown and the compact (drawer) model picker.
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k`
  }
  return tokens.toString()
}

/**
 * Strip the "pi/" prefix from model IDs/display names so the user sees a
 * provider-agnostic label in the picker (e.g., "pi/claude-opus" → "claude-opus").
 */
export function stripPiPrefixForDisplay(value: string): string {
  return value.startsWith('pi/') ? value.slice(3) : value
}

/**
 * Whether picking this model on THIS connection routes through the
 * OpenAI-shaped translation rather than reaching the endpoint natively.
 *
 * P6.454's session half. The BYO form already answers this at setup time
 * (`apisetup/byo-runtime.ts`'s `isTranslatedWireModel`) and marks the model
 * there; nothing said it again where the user actually switches models, so a
 * session could move onto a translated model with the cost stated only on a
 * form seen once, months ago. Same two locale keys, deliberately — the row asks
 * for "identical text wherever the router decides".
 *
 * ONE connection holds both wires: `buildClaudeRuntimeWireRouter` decides per
 * REQUEST, from the model's own `wire`, so this is a property of the model and
 * not of the connection.
 *
 * The absence rule differs from the form's, and the difference is not an
 * oversight. On a PROBE, `wire` absent means "not probed", so the form marks
 * nothing rather than guessing. On a STORED model entry, `models.ts` settles it:
 * "Absent means chat-completions, which is every model that existed before this
 * field" — so here absence is an answer, and withholding the mark would be the
 * guess.
 */
export function isTranslatedWireSessionModel(
  // DA2.25 — a STRUCTURAL subset, not `Pick<LlmConnection, 'providerType'>`.
  // The predicate moved behind `ModelListDisclosures`, which holds the same
  // narrow `ModelListConnectionFacts` shape every line under a model list reads
  // (`providerType?: string`), deliberately so a test needs no fixture. This
  // body only compares the field to one literal, so the widening is
  // behaviour-identical and strictly more permissive; every existing caller
  // still passes a whole connection.
  connection: { providerType?: string } | null | undefined,
  model: { wire?: 'anthropic-messages' } | string | null | undefined,
): boolean {
  if (connection?.providerType !== 'claude-runtime') return false
  if (!model) return false
  // A bare id carries no wire, and on this connection that is the same answer
  // the stored entry's absent `wire` gives.
  if (typeof model === 'string') return true
  return model.wire !== 'anthropic-messages'
}

export type ConnectionGroup = [groupName: string, connections: LlmConnection[]]

/**
 * Group connections by provider type for hierarchical picker rendering.
 * Each provider section can contain multiple connections (API Key, OAuth, …).
 * Order is significant for UI: Anthropic, Local, Nessy Backend, Nessy Cloud,
 * Codex, Claude Code.
 * Every providerType must map to a bucket — an unhandled provider silently
 * vanishes from the switcher (regression that hid the Nessy Cloud connection,
 * and again the Claude Code gateway connection when its card landed).
 * `claude-runtime` gets its OWN bucket rather than joining 'Anthropic': that
 * group is direct api.anthropic.com connections, a different product.
 * Empty groups are dropped.
 */
export function groupConnectionsByProvider<T extends LlmConnection>(
  connections: readonly T[],
): Array<[string, T[]]> {
  const groups: Record<string, T[]> = {
    'Anthropic': [],
    'Local': [],
    'Nessy Backend': [],
    'Nessy Cloud': [],
    'Codex': [],
    'Claude Code': [],
  }
  for (const conn of connections) {
    const provider = conn.providerType || 'anthropic'
    if (provider === 'anthropic') {
      groups['Anthropic'].push(conn)
    } else if (provider === 'pi_compat' && isLocalConnection(conn)) {
      groups['Local'].push(conn)
    } else if (provider === 'pi' || provider === 'pi_compat') {
      groups['Nessy Backend'].push(conn)
    } else if (provider === 'nestor-cloud-agent') {
      groups['Nessy Cloud'].push(conn)
    } else if (provider === 'codex-runtime') {
      groups['Codex'].push(conn)
    } else if (provider === 'claude-runtime') {
      groups['Claude Code'].push(conn)
    }
  }
  return Object.entries(groups).filter(([, conns]) => conns.length > 0)
}

/**
 * D1.162 — the provenance label, PER ENTRY.
 *
 * ## Why a per-row mark exists beside a per-list sentence
 *
 * C3.346 built the one-line form: `ModelListDisclosures` says where the LIST
 * came from (`This list comes from <host>. Last read <when> ago.`). Ledger K34
 * cannot move off `partial` on that alone, because the page's rule is per ENTRY
 * and a list sentence cannot answer the question a mixed list raises — *which of
 * these did the provider actually publish?* A connection's stored models survive
 * a refresh that no longer lists them, so a list "from the endpoint" can contain
 * rows the endpoint has never heard of.
 *
 * ## THREE values, and the third is the one to get right
 *
 * `catalogueListed` (`config/models.ts`, written by `server-core`'s model
 * fetchers) is `true` when the upstream catalogue carried the entry, `false`
 * when a refresh ran and did NOT carry it, and `undefined` when nobody ever
 * asked — a built-in list, a connection that has never refreshed, a host with no
 * fetcher for that provider. Rendering `undefined` as `false` would mark every
 * model on a never-refreshed connection as missing from a catalogue that was
 * never read, which is the opposite of the fact.
 *
 * ## Why only the `false` arm gets a mark
 *
 * A mark on every listed model is noise on the ordinary list and says nothing —
 * the list sentence above it already said where the list came from. The
 * discriminating case is the row the provider did not publish, so that is the
 * one that carries text. `null` here means *render nothing*, and it covers both
 * the listed case and the unasked one, which the caller must not distinguish.
 */
export function modelCatalogueMark(
  model: { catalogueListed?: boolean } | string | null | undefined,
): 'unlisted' | null {
  // A bare id is a model with no stored entry at all, so there is nothing that
  // could have been compared against a catalogue.
  if (!model || typeof model === 'string') return null
  return model.catalogueListed === false ? 'unlisted' : null
}
