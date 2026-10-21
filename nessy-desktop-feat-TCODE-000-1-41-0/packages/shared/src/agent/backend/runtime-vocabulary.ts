/**
 * The runtime vocabulary — the ONE source every per-runtime capability site
 * should be keyed by (P2.124).
 *
 * ## Why this file exists, stated as the defect it removes
 *
 * Eleven sites in this repo hold per-runtime capability truth, and an inventory
 * taken for P2.124 measured how they hold it: SIX are compiler-total over a
 * runtime union — a new member breaks the build there — and every other one is
 * a `Set`, an array, a `Partial<Record<…>>` or an if/else chain with a catch-all
 * arm, so a new member is silently DEFAULTED. Eight of the fifteen partial
 * dispatch sites in `factory.ts` default OPEN, i.e. a runtime nobody has
 * described yet is granted the capability.
 *
 * The obvious repair — one more list, enumerating what each runtime can do — is
 * the twelfth list, and this plan has met the two-lists-must-agree failure six
 * times already (`Task`→`Agent`, `lsp` vs `lspServers`, the workflow `meta`
 * allow-list, the iOS enum mirror, the RPC channel block, a model display map
 * where 16 of 41 ids mapped to themselves). So this file deliberately declares
 * NO capability. It declares only the DOMAIN — which runtimes exist — because
 * that domain is the thing every one of the eleven sites is a function of, and
 * because until now it existed only as a TypeScript union with no runtime value
 * anywhere in the tree. That absence is the mechanical cause of the sprawl: a
 * site that wants to iterate providers has no list to read, so it writes one.
 *
 * ## The property this makes enforceable
 *
 * > A per-runtime capability site must be TOTAL over this vocabulary: adding a
 * > runtime must BREAK THE BUILD at the site, never inherit a silent default.
 *
 * Totality is checked two ways, and both are cheap because the vocabulary is
 * one value:
 *
 *  - by the COMPILER, wherever a site is `Record<AgentProvider, …>` — the
 *    strongest form, since it fails before a test runs;
 *  - at TEST TIME, by comparing a site's own key set against
 *    {@link AGENT_PROVIDERS} — which also catches a record whose type was
 *    widened to `Partial` or to `string`.
 *
 * ## The anchors below are the only permitted restatement, and they are
 * ## checked in BOTH directions
 *
 * `satisfies Record<Union, true>` rejects a MISSING member. It does not reject
 * an INVENTED one on its own, so each vocabulary also carries an assignability
 * anchor that fails when a key is not in the union. Both bind at
 * `bun run typecheck:shared`, not at `bun test` — `bun test` does not typecheck,
 * and a vocabulary anchor that binds nowhere is the shape this repo has already
 * shipped three times.
 *
 * `AgentProvider` and `ModelProvider` are the SAME union (`types.ts:205` —
 * `export type AgentProvider = ModelProvider`), which is why one list serves
 * both names. `LlmProviderType` is a WIDER vocabulary that collapses onto it
 * (`pi_compat`→`pi`, `claude-runtime`→`anthropic`), and P2.124's recorded trap
 * (a) is that a consolidated capability record must be keyed by the wider one
 * wherever the two members it collapses have deliberately different
 * capabilities — `CLAUDE_RUNTIME_DEFAULTS` in `composer-capabilities.ts` is
 * exactly that case. Both lists are therefore exported, and a site picks the one
 * its capability actually varies over.
 */
import type { LlmProviderType } from '../../config/llm-connections.ts'
import type { AgentProvider } from './types.ts'

const AGENT_PROVIDER_VOCABULARY = {
  anthropic: true,
  pi: true,
  'codex-runtime': true,
  'nestor-cloud-agent': true,
} as const satisfies Record<AgentProvider, true>

const LLM_PROVIDER_TYPE_VOCABULARY = {
  anthropic: true,
  pi: true,
  pi_compat: true,
  'codex-runtime': true,
  'claude-runtime': true,
  'nestor-cloud-agent': true,
} as const satisfies Record<LlmProviderType, true>

/**
 * The other half of each anchor.
 *
 * `satisfies` catches a member the vocabulary FORGOT. These catch a member the
 * vocabulary INVENTED: a key that is not in the union makes the constant's type
 * `never` and fails the typecheck gate. Without them a stale spelling left
 * behind by a rename would sit in the list forever, iterated by every site.
 */
type KeysAreInUnion<K extends string, Union extends string> = [K] extends [Union] ? true : never

const agentProviderVocabularyIsExact: KeysAreInUnion<
  keyof typeof AGENT_PROVIDER_VOCABULARY,
  AgentProvider
> = true

const llmProviderTypeVocabularyIsExact: KeysAreInUnion<
  keyof typeof LLM_PROVIDER_TYPE_VOCABULARY,
  LlmProviderType
> = true

/** Proof for a reader that both anchors are live values, not dead types. */
export const RUNTIME_VOCABULARY_ANCHORED =
  agentProviderVocabularyIsExact && llmProviderTypeVocabularyIsExact

/**
 * Every runtime a session can run on. Iteration source for any site that needs
 * to answer a question "for each runtime".
 *
 * `AgentProvider` and `ModelProvider` are the same union, so this list is the
 * value form of both.
 */
export const AGENT_PROVIDERS: readonly AgentProvider[] =
  Object.freeze(Object.keys(AGENT_PROVIDER_VOCABULARY) as AgentProvider[])

/** Every connection provider type. Collapses onto {@link AGENT_PROVIDERS}. */
export const LLM_PROVIDER_TYPES: readonly LlmProviderType[] =
  Object.freeze(Object.keys(LLM_PROVIDER_TYPE_VOCABULARY) as LlmProviderType[])

/**
 * Is `record` total over the runtime vocabulary — does it decide every runtime?
 *
 * The runtime half of P2.124's property. A `Record<AgentProvider, …>` satisfies
 * it by construction and this call is then a belt on the braces; a `Set`, an
 * array or a `Partial<Record<…>>` does not, and that is the shape the inventory
 * found at most of the eleven sites.
 *
 * Returns the runtimes the record fails to decide, so a failure message names
 * them instead of printing `false`.
 */
export function runtimesNotDecidedBy(record: Readonly<Record<string, unknown>>): AgentProvider[] {
  return AGENT_PROVIDERS.filter(provider => !Object.hasOwn(record, provider))
}

/**
 * Is `value` a runtime this build knows? The type-guard form of
 * {@link AGENT_PROVIDERS}, for a site handed a string off the wire or off disk.
 *
 * `getLlmConnections()` returns `config.llmConnections` straight out of the
 * stored config with no per-field validation (`config/storage.ts`), so an
 * unknown `providerType` really can reach a dispatch site — this is not a
 * defensive-programming flourish. P2.205 measured what happened next:
 * `providerTypeToAgentProvider` answered `'anthropic'` and
 * `resolveModelForProvider` handed back `claude-opus-4-8`, an
 * api.anthropic.com model id, for a runtime nobody described.
 */
export function isAgentProvider(value: unknown): value is AgentProvider {
  return typeof value === 'string' && Object.hasOwn(AGENT_PROVIDER_VOCABULARY, value)
}

/** The same guard for the wider connection vocabulary. */
export function isLlmProviderType(value: unknown): value is LlmProviderType {
  return typeof value === 'string' && Object.hasOwn(LLM_PROVIDER_TYPE_VOCABULARY, value)
}

/**
 * The error a per-runtime site raises for a runtime it does not decide.
 *
 * One message shape for every site, and it NAMES the site: P2.205's inventory
 * had to run each of `factory.ts`'s fifteen dispatch sites by hand to learn
 * which one had answered, because a silent default leaves no trace at all. A
 * thrown error naming `resolveModelForProvider` is the difference between a
 * bug report and an archaeology session.
 */
export function unknownRuntimeError(site: string, value: unknown): Error {
  return new Error(
    `${site}: no arm for runtime ${JSON.stringify(String(value))} — `
    + `known runtimes are ${LLM_PROVIDER_TYPES.join(', ')}`,
  )
}

/**
 * The exhaustive-switch terminator for a per-runtime `switch`.
 *
 * Two jobs, and the first is the one P2.124's property is about: the parameter
 * is `never`, so ADDING a member to the runtime union makes this call a type
 * error at the site that forgot it — the build breaks instead of the member
 * inheriting whatever the `default:` arm used to hand out. The second is the
 * runtime half, for a value that was never in the union to begin with: it
 * THROWS rather than returning a plausible-looking answer.
 *
 * Use it only where throwing is the right arm. A site that must keep answering
 * (a validation surface, a capability read that resolves before any session
 * exists) needs a typed "unsupported" instead — see `validateConnection`.
 */
export function unreachableRuntime(value: never, site: string): never {
  throw unknownRuntimeError(site, value)
}

/**
 * Keys of `record` that are not runtimes at all — the other direction.
 *
 * A record can be total and still wrong: a member left behind by a rename is
 * decided for a runtime that no longer exists, and every consumer iterating the
 * record's keys then iterates a ghost.
 */
export function nonRuntimeKeysOf(record: Readonly<Record<string, unknown>>): string[] {
  const known = new Set<string>(AGENT_PROVIDERS)
  return Object.keys(record).filter(key => !known.has(key)).sort()
}
