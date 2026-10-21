/**
 * BYO endpoint form logic for the two adapter runtimes — `codex-runtime` and
 * `claude-runtime` (C3). One form, two providerTypes.
 *
 * Everything the form decides lives here as pure functions rather than in the
 * step component: the three things that can go wrong are all *decisions*, not
 * rendering, and each has already gone wrong once elsewhere in this subsystem.
 *
 * - **Edit must not convert the providerType.** `AiSettingsPage` used to route
 *   every non-Pi connection to the `anthropic_api_key` form, whose submit path
 *   attaches a `customEndpoint`; the SETUP handler forces
 *   `providerType: 'pi_compat'` whenever one is present
 *   (`server-core/handlers/rpc/llm-connections.ts:108-110`), so editing a BYO
 *   runtime connection silently stopped it being one and the local adapter
 *   never started again. `resolveConnectionEditTarget` is now the single router
 *   and `buildByoRuntimeSetup` never emits that field.
 * - **The endpoint may not be blank.** `buildCodexRuntimeUpstream` reads a
 *   missing baseUrl as "the gateway" while the model-refresh fetcher reads it as
 *   "not the gateway", so a blank-endpoint BYO codex connection would chat
 *   through the corp gateway and never refresh its catalog.
 * - **The endpoint may not be the gateway URL itself** — see
 *   {@link validateByoRuntimeForm}.
 */
import type { ModelDefinition } from '@nessy-agent/shared/config'
import type { LlmConnectionSetup } from '@nessy-agent/shared/protocol'
import type { ApiSetupMethod } from '@/components/onboarding/APISetupStep'
import { isNessyGatewayBaseUrl } from './nessy-gateway'
import { isNessyGatewayConnectionShape } from '@config/llm-connections'

/** The two providerTypes that reach their endpoint through a local adapter. */
export type ByoRuntimeProviderType = 'codex-runtime' | 'claude-runtime'

/**
 * Base slug per runtime. Distinct from the one-click cards' `codex-gateway` /
 * `claude-gateway`: those are upserted idempotently, so a shared slug would let
 * a BYO save overwrite the corp connection. Both are rows in
 * `BUILT_IN_CONNECTION_TEMPLATES` (server-core) — the only place a slug becomes
 * a providerType.
 */
export const BYO_RUNTIME_BASE_SLUG: Record<ByoRuntimeProviderType, string> = {
  'codex-runtime': 'codex-custom',
  'claude-runtime': 'claude-custom',
}

export interface ByoRuntimeFormValues {
  providerType: ByoRuntimeProviderType
  baseUrl: string
  apiKey: string
  /** Raw comma-separated model ids, as typed. */
  models: string
}

/**
 * The merged form's runtime arm.
 *
 * `'pi'` is an ARM ID, not a providerType. The server derives `pi`, `pi_compat`
 * or `anthropic` from the payload's SHAPE — whether it carries a
 * `customEndpoint`, and which preset it came from — so naming the arm after any
 * one of them would be a lie two thirds of the time.
 */
export type MergedEndpointArm = 'pi' | ByoRuntimeProviderType

/**
 * The Pi arm's endpoint preset.
 *
 * The two official ones hide the base-URL field and submit `undefined`, which
 * is what the server's reset path at `llm-connections.ts:83-88` keys on — so
 * they are not merely "a URL we prefill", and the validation matrix has to
 * exempt them from the endpoint checks rather than accept a blank as a failure.
 */
export type PiEndpointPreset = 'anthropic' | 'openai' | 'custom'

export interface MergedEndpointFormValues {
  arm: MergedEndpointArm
  /** Pi arm only; runtime arms are always the custom shape. */
  preset: PiEndpointPreset
  baseUrl: string
  apiKey: string
  /** Raw comma-separated model ids, as typed. */
  models: string
  /** The utility-model slot (E1). Blank = fall back to the heuristic. */
  miniModel?: string
}

/**
 * True when this form state submits WITHOUT a base URL — the two official Pi
 * presets. Everything the matrix does about endpoints keys off this, in one
 * place, because the exemption is the single most breakable rule here: an
 * official preset that starts sending a baseUrl silently loses the server's
 * reset semantics, and a custom arm that stops requiring one reaches the
 * `lastNonCustomPreset` fallback the merged form is supposed to make
 * unreachable.
 */
export function usesOfficialPiEndpoint(values: Pick<MergedEndpointFormValues, 'arm' | 'preset'>): boolean {
  return values.arm === 'pi' && values.preset !== 'custom'
}

/**
 * The endpoint every new personal-key connection points at (G2, owner decision
 * 2026-08-14: «фактически урл можно зашить по дефолту и скрыть поле»).
 *
 * BARE, with no `/v1` and no trailing slash — measured 2026-08-14, this exact
 * origin serves `/models`, `/chat/completions` AND `/v1/messages`, so it is the
 * one string that works for both wires. Appending a path here would break the
 * Anthropic half before G3 could use it.
 *
 * The field it replaces is HIDDEN, not deleted — the owner's «потом мы откроем
 * поле» is the plan, and every rule below is written so that opening it again
 * is a UI change and nothing more.
 */
export const DEFAULT_ENDPOINT_URL = 'https://llm-proxy.t-tech.team'

/** Trailing slashes are not a difference in identity. */
function sameEndpoint(a: string, b: string): boolean {
  return a.trim().replace(/\/+$/, '') === b.trim().replace(/\/+$/, '')
}

/**
 * How the endpoint field behaves, and what URL the form submits — ONE ordered
 * decision, because each branch below broke a different thing when it was
 * folded into the one above it.
 *
 * 1. OFFICIAL PI PRESETS submit no URL at all. The blank IS the contract: the
 *    server's reset path keys on it. This has to come first — an official
 *    connection stores no `baseUrl`, so the "foreign URL" test below would see
 *    an empty string and hide the field for the wrong reason.
 * 2. CREATE hides the field and uses the hardcoded URL.
 * 3. EDIT of a connection pointing SOMEWHERE ELSE (an old one, a CLI-written
 *    one, an Ollama loopback) shows the URL — DISABLED. Visible so the user can
 *    see where the connection points; not editable, per the owner's «нужно
 *    будет его задизеблить». The stored URL is submitted verbatim: this form
 *    cannot express a change to it, so it must not imply one.
 * 4. EDIT of a connection already on the hardcoded URL hides the field again —
 *    there is nothing to tell the user that the form does not already imply.
 */
export function resolveEndpointField(input: {
  arm: MergedEndpointArm
  preset: PiEndpointPreset
  isEditing: boolean
  storedBaseUrl?: string
}): { visible: boolean; disabled: boolean; value: string } {
  if (usesOfficialPiEndpoint(input)) return { visible: false, disabled: false, value: '' }

  const stored = input.storedBaseUrl?.trim() ?? ''
  if (!input.isEditing) return { visible: false, disabled: false, value: DEFAULT_ENDPOINT_URL }
  if (stored && !sameEndpoint(stored, DEFAULT_ENDPOINT_URL)) {
    return { visible: true, disabled: true, value: stored }
  }
  return { visible: false, disabled: false, value: stored || DEFAULT_ENDPOINT_URL }
}

/**
 * What a probe said, plus the wire it said it on.
 *
 * Mirrors `ModelProbeResult` minus the id — the form keys these by id itself.
 */
export interface ArmProbe {
  verdict: 'ok' | 'no-quota' | 'unsupported-endpoint' | 'error' | 'wrong-runtime'
  wire?: 'anthropic-messages'
}

/**
 * Project probe results onto ONE arm (G3).
 *
 * A model's availability is not a property of the model alone once two wires
 * are in play. `anthropic/claude-opus-5` answers, on this key, on this
 * endpoint — and is still unreachable from the Pi arm, which speaks one
 * protocol per connection, and from the codex arm, whose adapter is
 * chat-completions-only. Hiding that would be the same class of lie as calling
 * it `no-quota`: the reason is neither entitlement nor the endpoint, it is the
 * runtime the user picked, and `wrong-runtime` says exactly that.
 *
 * Only reshapes `ok`-on-another-wire. Every other verdict is arm-independent
 * and passes through untouched.
 */
export function resolveArmVerdicts(
  probes: Record<string, ArmProbe>,
  arm: MergedEndpointArm,
): Record<string, ArmProbe['verdict']> {
  const out: Record<string, ArmProbe['verdict']> = {}
  for (const [id, probe] of Object.entries(probes)) {
    out[id] = probe.wire === 'anthropic-messages' && arm !== 'claude-runtime'
      ? 'wrong-runtime'
      : probe.verdict
  }
  return out
}

/**
 * P6.454 — is this model served over the TRANSLATED wire?
 *
 * One `claude-runtime` connection holds two wires, per MODEL, and the
 * difference is invisible: a catalogue entry stamped `wire: 'anthropic-messages'`
 * has its body forwarded to the endpoint untranslated — the `anthropic-beta`
 * header rides along verbatim and a beta-gated field is dropped only after the
 * upstream refuses it BY NAME (`codex-responses-adapter/src/anthropic/passthrough-negotiation.ts`)
 * — while every other model goes through the OpenAI-shaped translation, which
 * carries no beta surface at all. So prompt caching, context management,
 * extended context, structured outputs and beta tool fields exist on one model
 * of a connection and not on its neighbour, and until this predicate nothing
 * told the user which one they were picking.
 *
 * Answers only for the `claude-runtime` arm, because it is the only arm with
 * two wires: `buildClaudeRuntimeWireRouter` returns a router at all only for an
 * `openai-compatible` upstream carrying at least one anthropic-wire model, and
 * the Pi and codex arms speak one protocol per connection.
 *
 * Answers only for a model that was actually PROBED. An unprobed id is
 * `undefined` rather than `true` on purpose: the wire is a fact the probe
 * discovers, and marking a model the form knows nothing about would be a guess
 * printed in the same place as a measurement. The visible consequence, stated
 * rather than left to be found: on the EDIT path the stored selection renders
 * before any fetch, so the marks appear once the catalogue has been refreshed.
 */
export function isTranslatedWireModel(
  probe: ArmProbe | undefined,
  arm: MergedEndpointArm,
): boolean {
  if (arm !== 'claude-runtime' || !probe) return false
  return probe.wire !== 'anthropic-messages'
}

export type ByoRuntimeValidationError =
  | 'endpointRequired'
  | 'endpointIsGateway'
  | 'modelRequired'
  | 'apiKeyRequired'
  | 'miniModelNotInList'

/**
 * The token → locale-key map for {@link ByoRuntimeValidationError}, and the ONE
 * copy of it — DA1.64.
 *
 * It lived in `components/onboarding/ByoRuntimeStep.tsx` until the same tokens
 * acquired a second door. DA1.60 made `setupLlmConnection` refuse a credential
 * for the gateway's own endpoint and answer with the FORM's own
 * `endpointIsGateway` token, deliberately spelled the same so one sentence can
 * serve both doors; `handlers/rpc/llm-connections.ts` says so in its
 * `GATEWAY_ENDPOINT_REFUSAL` docblock and adds the instruction this constant
 * carries out: *"A renderer that wants the sentence reuses the map it already
 * has for this exact token."* A map that sits inside a component cannot be
 * reused by a hook without pulling the component in, so it moves here, beside
 * the union it is total over.
 *
 * `Record<ByoRuntimeValidationError, string>` rather than a partial map: the
 * compiler then refuses a token added to the union with no sentence, which is
 * the quiet direction. The RPC answers only `endpointIsGateway` today — the
 * other four are the form's alone — and the whole map is still what moves,
 * because a one-entry copy beside a five-entry original is the drift this row
 * exists to remove.
 */
export const BYO_RUNTIME_ERROR_KEY: Record<ByoRuntimeValidationError, string> = {
  endpointRequired: 'onboarding.byoRuntime.errorEndpointRequired',
  endpointIsGateway: 'onboarding.byoRuntime.errorEndpointIsGateway',
  modelRequired: 'onboarding.byoRuntime.errorModelRequired',
  apiKeyRequired: 'onboarding.byoRuntime.errorApiKeyRequired',
  miniModelNotInList: 'onboarding.byoRuntime.errorMiniModelNotInList',
}

/**
 * The locale key for a refusal the SAVE path answered with, or `undefined` when
 * the string is not one of this form's tokens — DA1.64.
 *
 * `Object.hasOwn` and not `in`: the argument is a server-supplied string, and
 * `'constructor' in BYO_RUNTIME_ERROR_KEY` is `true` through the prototype, so
 * `in` would hand back a function where a key belongs. An unrecognised string
 * gets `undefined` rather than a guess, and the caller keeps showing whatever
 * the server said — a refusal we cannot translate must still be readable.
 */
export function byoRuntimeRefusalKey(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  return Object.hasOwn(BYO_RUNTIME_ERROR_KEY, raw)
    ? BYO_RUNTIME_ERROR_KEY[raw as ByoRuntimeValidationError]
    : undefined
}

export type ByoRuntimeValidationResult =
  | { valid: true; baseUrl: string; apiKey: string; models: string[] }
  | { valid: false; field: 'baseUrl' | 'models' | 'apiKey'; error: ByoRuntimeValidationError }

export type MergedEndpointValidationResult =
  | { valid: true; baseUrl: string; apiKey: string; models: string[]; miniModel?: string }
  | { valid: false; field: 'baseUrl' | 'models' | 'apiKey' | 'miniModel'; error: ByoRuntimeValidationError }

/**
 * A stored credential arrives at the Edit form MASKED — `GET_API_KEY` masks for
 * every caller, without exception (`llm-connections.ts:475-484`), so there is
 * no "give me the real one" variant to reach for.
 *
 * That makes the mask mean exactly one thing: A KEY IS STORED. It must never be
 * sent anywhere — not in a payload, not to the pre-save test — and its presence
 * must not be read as "the user left the field blank" either, or an edit would
 * demand a key that is already there.
 *
 * This is the BYO semantics, and the merged Pi arm adopts it. The legacy
 * ApiKeyInput edit path does NOT have it: `handleSubmitCredential` carries no
 * `'••'` detection at all and submits the mask verbatim to the pre-save test,
 * which is the defect this unification closes.
 */
export function isMaskedCredential(value: string | undefined): boolean {
  return !!value && value.includes('••')
}

/**
 * Whether the key field counts as filled — a real key, or the mask standing in
 * for a stored one.
 */
export function hasCredential(value: string | undefined): boolean {
  return !!value?.trim()
}

/** Comma-separated list → trimmed, blank-free ids. */
export function parseModelList(value: string): string[] {
  return value.split(',').map(entry => entry.trim()).filter(Boolean)
}

/**
 * True when a URL points at local loopback. Local endpoints may be keyless
 * (Ollama, LM Studio); remote ones may not. Mirrors the main-process
 * `setupTestRequiresApiKey` / `isLoopbackBaseUrl`
 * (server-core/domain/connection-setup-logic.ts) — the renderer cannot import
 * that module, so this is the renderer's single copy: `useOnboarding` imports it
 * from here rather than keeping its own.
 */
export function isLoopbackBaseUrl(baseUrl?: string): boolean {
  if (!baseUrl?.trim()) return false
  try {
    const hostname = new URL(baseUrl.trim()).hostname
    const h = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '::1'
  } catch {
    return false
  }
}

/**
 * DA1.11 — is this endpoint on the corporate gateway HOST while not being the
 * gateway URL?
 *
 * The leading cause of the 2026-08-23 user case, and both halves of it hang off
 * ONE predicate. A `claude-runtime`, `codex-runtime` or `pi_compat` connection
 * whose baseUrl sits on the gateway host but fails `isNessyGatewayBaseUrl`'s
 * whole-URL match silently gets NO `Nestor-Token` (it classifies BYO, Bearer
 * only) AND no forced re-mint — `SessionManager` symbol
 * `refreshGatewayAuthForRetry` computes its `gatewayBacked` from the same
 * predicate and returns early. The two failures compound, and the gateway's raw
 * token-parse 401 then reads as a credential problem.
 *
 * **The whole-URL boundary is NOT widened to repair that, and must not be.** It
 * is derived from the chat URL constant precisely so transport and
 * classification cannot disagree about which URL is the gateway. The fix is a
 * DETECTOR plus an honest sentence: name the situation where the user can see
 * it, and leave the boundary alone.
 *
 * **REUSED, not minted.** The parsed-host half is
 * `packages/shared/src/config/llm-connections.ts` symbol
 * `isNessyGatewayConnectionShape`, which already answers exactly this host
 * question (`new URL(raw).hostname.toLowerCase()` against `NESTOR_GATEWAY_HOST`)
 * and already has both arms pinned in `gateway-only-connections.test.ts`. It is
 * called with NO `providerType` on purpose: that argument exists for the native
 * cloud agent, which has no baseUrl of its own, and this question is about a URL
 * the user typed.
 *
 * And the renderer CAN import it, which re-prices the row's warning: the barrel
 * that re-exports node-only agent code is `@nessy-agent/shared/agent/backend`
 * (the home of `classifyModelTarget`), not `@config/llm-connections`, which
 * `AiSettingsPage.tsx` and `CompactModelSelector.tsx` already import as a VALUE
 * in production. So no fourth copy and no module split — for this predicate.
 */
export function isGatewayHostNonGatewayEndpoint(baseUrl?: string): boolean {
  const trimmed = baseUrl?.trim()
  if (!trimmed) return false
  if (isNessyGatewayBaseUrl(trimmed)) return false
  return isNessyGatewayConnectionShape({ baseUrl: trimmed })
}

/**
 * Validate what the user typed.
 *
 * **The exact gateway URL is rejected rather than accepted with a notice.** Two
 * concrete traps, not a style preference:
 *
 * - the key they typed would be silently ignored — a `{kind:'nestor'}` upstream
 *   authenticates with the dp JWT and never reads the connection credential
 *   (`upstream-target.ts:attachUpstreamCredential`);
 * - the connection would be un-editable the moment it was saved, because
 *   `canEditLlmConnection` classifies any runtime connection on that URL as the
 *   corp one and hides the Edit form.
 *
 * So there is no BYO use for that URL at all — the one-click card is the whole
 * feature — and the form names it instead of building a broken connection. The
 * same host on a *different* path stays allowed: per AGENTS.md that is a custom
 * endpoint with normal provider auth, and both the adapter and the refresh
 * fetcher already treat it that way.
 */
export function validateByoRuntimeForm(
  values: ByoRuntimeFormValues,
  options: { isEditing: boolean },
): ByoRuntimeValidationResult {
  const baseUrl = values.baseUrl.trim()
  if (!baseUrl) {
    return { valid: false, field: 'baseUrl', error: 'endpointRequired' }
  }
  if (isNessyGatewayBaseUrl(baseUrl)) {
    return { valid: false, field: 'baseUrl', error: 'endpointIsGateway' }
  }

  const models = parseModelList(values.models)
  if (models.length === 0) {
    return { valid: false, field: 'models', error: 'modelRequired' }
  }

  const apiKey = values.apiKey.trim()
  // Editing with a blank key means "keep the stored credential"; a fresh
  // connection needs one unless the endpoint is loopback.
  if (!apiKey && !options.isEditing && !isLoopbackBaseUrl(baseUrl)) {
    return { valid: false, field: 'apiKey', error: 'apiKeyRequired' }
  }

  return { valid: true, baseUrl, apiKey, models }
}

/**
 * The merged form's validation matrix — FIRST FAILURE WINS, in this order:
 * endpoint, models, utility model, key.
 *
 * Three rules earn their place here rather than being obvious:
 *
 * 1. THE GATEWAY URL IS REJECTED ON THE PI ARM TOO, which is new. It is not
 *    symmetry for its own sake: `NESSY_GATEWAY_PROVIDER_TYPES` includes
 *    `pi_compat`, so a Pi/Custom save on that URL produces a connection
 *    `canEditLlmConnection` classifies as the corp one — permanently
 *    un-editable, with no way back from the UI. The one-click card is the whole
 *    feature for that URL on every arm.
 * 2. THE OFFICIAL PI PRESETS ARE EXEMPT FROM THE ENDPOINT CHECKS ENTIRELY.
 *    They hide the field and submit `undefined`, and the server's reset path
 *    depends on that blank. Requiring a URL there would break the very shape it
 *    is supposed to produce.
 * 3. MODELS ARE NOT REQUIRED ON THE OFFICIAL PRESETS, for the same reason from
 *    the other side: the server installs the provider catalog itself, so an
 *    empty list is the correct payload rather than a missing one.
 *
 * `miniModel ∈ models` is checked HERE and again on the server (E1's
 * `validateMiniModel`). Deliberately both: this one gives the field-level
 * message the form can point at, and the server's is the one that holds when
 * the payload comes from anywhere else.
 */
export function validateMergedEndpointForm(
  values: MergedEndpointFormValues,
  options: { isEditing: boolean },
): MergedEndpointValidationResult {
  const official = usesOfficialPiEndpoint(values)
  const baseUrl = values.baseUrl.trim()

  if (!official) {
    if (!baseUrl) return { valid: false, field: 'baseUrl', error: 'endpointRequired' }
    if (isNessyGatewayBaseUrl(baseUrl)) return { valid: false, field: 'baseUrl', error: 'endpointIsGateway' }
  }

  const models = parseModelList(values.models)
  if (!official && models.length === 0) {
    return { valid: false, field: 'models', error: 'modelRequired' }
  }

  const miniModel = values.miniModel?.trim()
  if (miniModel && models.length > 0 && !models.includes(miniModel)) {
    return { valid: false, field: 'miniModel', error: 'miniModelNotInList' }
  }

  // A blank key on EDIT means "keep the stored credential"; the mask means the
  // same thing and arrives in the field rather than as a blank, so both count
  // as satisfied. A fresh connection needs a real key unless the endpoint is
  // loopback — the Ollama-class case — and the official presets always need
  // one, loopback being impossible there.
  const apiKey = values.apiKey.trim()
  const keyless = !official && isLoopbackBaseUrl(baseUrl)
  if (!hasCredential(apiKey) && !options.isEditing && !keyless) {
    return { valid: false, field: 'apiKey', error: 'apiKeyRequired' }
  }

  return {
    valid: true,
    baseUrl: official ? '' : baseUrl,
    apiKey,
    models,
    ...(miniModel ? { miniModel } : {}),
  }
}

/**
 * Turn picked ids into model entries, carrying whatever the form already knows.
 *
 * Same promotion shape `setModelSupportsImages` uses: the id stands in for the
 * display fields, which the catalog fills on the next sync. An id with nothing
 * known about it stays a plain string, so a connection saved without a catalog
 * looks exactly as it always did.
 */
export function promoteModels(
  ids: string[],
  meta?: Record<string, { contextWindow?: number; wire?: 'anthropic-messages' }>,
): Array<ModelDefinition | string> {
  return ids.map(id => {
    const known = meta?.[id]
    if (!known || (known.contextWindow === undefined && known.wire === undefined)) return id
    return { id, name: id, shortName: id, ...known } as unknown as ModelDefinition
  })
}

/** Reuse the edited slug; otherwise allocate a non-colliding one. */
export function resolveByoRuntimeSlug(
  providerType: ByoRuntimeProviderType,
  editingSlug: string | null,
  existingSlugs: Set<string>,
): string {
  if (editingSlug) return editingSlug
  const base = BYO_RUNTIME_BASE_SLUG[providerType]
  if (!existingSlugs.has(base)) return base
  let i = 2
  while (existingSlugs.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}

/**
 * The exact `LlmConnectionSetup` the BYO form submits.
 *
 * Same shape the one-click runtime cards send (`buildGatewaySetup`), and for the
 * same reason: **no `customEndpoint`**. That single field is what makes the
 * SETUP handler rewrite `providerType` to `pi_compat`, which would route the
 * connection through Pi and leave the local adapter unused.
 *
 * A masked credential (`GET_API_KEY` returns `sk-xxx••••••••1234` to prefill the
 * Edit form) is dropped here rather than relied on being ignored downstream —
 * the handler does skip it, but the payload should not carry a secret-shaped
 * placeholder in the first place.
 *
 * `authType` is always sent, and the form is the only place that can decide it:
 * these connections never carry a `customEndpoint`, so they never reach the
 * server's `resolveCustomEndpointSetup` — the one place every OTHER
 * custom-endpoint connection gets its keyless → `authType: 'none'` mapping.
 * Without it a keyless loopback endpoint (the Ollama-class case the form
 * explicitly allows) persists as `api_key_with_endpoint` with nothing stored,
 * which both the Test button and the credential-health check read as
 * "credentials missing". A key counts as present when the payload carries one
 * (masked means the stored one is kept) or when the Edit path knows one is
 * stored (`hasStoredKey`), so an edit that ADDS a key to a previously keyless
 * connection flips it back to `api_key_with_endpoint`.
 */
export function buildByoRuntimeSetup(args: {
  providerType: ByoRuntimeProviderType
  baseUrl: string
  apiKey: string
  models: string[]
  editingSlug: string | null
  existingSlugs: Set<string>
  /** Edit path: a credential is already stored for this slug (prefill was non-empty). */
  hasStoredKey?: boolean
  /** The utility-model slot (E1). Blank clears it back to the heuristic. */
  miniModel?: string
  /**
   * Metadata-sync enrollment (E2), TRISTATE: `undefined` leaves whatever is
   * persisted, a number enrolls, `null` withdraws. Omitted unless the user
   * actually touched the toggle — sending `false`-equivalent on an untouched
   * edit would silently un-enroll a connection nobody asked to change.
   */
  modelsSyncedAt?: number | null
  /**
   * Per-model metadata the FORM already has, promoted into the payload.
   *
   * `contextWindow` is here because of a race G2 created and this closes: the
   * create stamps `modelsSyncedAt`, and the post-create refresh then sees that
   * brand-new stamp as "fresh" and skips — always-on stamping disabled the
   * fetch it was meant to guarantee, so a saved model carried no window until
   * the 24h TTL expired. The form displayed that window; persisting what it
   * displayed removes the dependency instead of re-timing it.
   *
   * `wire` (G3) rides the same map, and only from the claude-runtime arm: Pi
   * speaks one protocol per connection and the codex adapter is
   * chat-completions-only, so recording an Anthropic wire on either would
   * describe a route that cannot be taken.
   *
   * Ids absent here stay plain strings — the shape every connection had before.
   */
  modelMeta?: Record<string, { contextWindow?: number; wire?: 'anthropic-messages' }>
}): LlmConnectionSetup {
  const credential = args.apiKey.trim()
  const masked = isMaskedCredential(credential)
  const miniModel = args.miniModel?.trim()
  return {
    slug: resolveByoRuntimeSlug(args.providerType, args.editingSlug, args.existingSlugs),
    ...(credential && !masked ? { credential } : {}),
    authType: credential || args.hasStoredKey ? 'api_key_with_endpoint' : 'none',
    baseUrl: args.baseUrl,
    defaultModel: args.models[0],
    models: promoteModels(args.models, args.modelMeta),
    // Sent even when blank, so clearing the field actually clears the slot —
    // the server maps `''` back to `undefined`.
    ...(args.miniModel !== undefined ? { miniModel: miniModel ?? '' } : {}),
    ...(args.modelsSyncedAt !== undefined ? { modelsSyncedAt: args.modelsSyncedAt } : {}),
  }
}

/** Which setup surface the settings Edit button opens for a connection. */
export type ConnectionEditTarget =
  | { form: 'byo-runtime'; providerType: ByoRuntimeProviderType }
  | { form: 'merged'; arm: 'pi'; preset: PiEndpointPreset }
  | { form: 'api-key'; method: ApiSetupMethod }

/**
 * The Pi auth flavours the merged form's Pi arm can round-trip.
 *
 * Everything else — `amazon-bedrock`, `openrouter`, `google`, and whatever else
 * `apps/cli` writes into the shared config — keeps the legacy ApiKeyInput edit
 * surface. Those arms exist in that form and nowhere else; routing such a
 * connection into the merged form would strand it, because the merged form
 * cannot express its credentials.
 */
const MERGED_PI_AUTH_PROVIDERS = new Set(['anthropic', 'openai'])

/**
 * Route a connection to its edit form — FOUR targets since the merge.
 *
 * The runtime arm stays unconditional on the endpoint: a gateway runtime
 * connection never reaches this (its Edit button is hidden by
 * `canEditLlmConnection`), and if it ever did, sending it to the
 * `anthropic_api_key` form would be the providerType conversion this function
 * exists to prevent.
 *
 * The Pi arms are new, and the split between them is the point: an exotic
 * `piAuthProvider` MUST fall through to the legacy surface rather than be
 * squeezed into the merged form. `apps/cli` writes arbitrary values there, so
 * this is not a hypothetical branch.
 */
export function resolveConnectionEditTarget(connection: {
  providerType?: string
  baseUrl?: string
  piAuthProvider?: string
  customEndpoint?: { api?: string }
}): ConnectionEditTarget {
  const providerType = connection.providerType
  if (providerType === 'codex-runtime' || providerType === 'claude-runtime') {
    return { form: 'byo-runtime', providerType }
  }
  // A custom endpoint is the merged form's Pi/Custom arm by construction —
  // `pi_compat` is precisely what the SETUP handler rewrites a
  // customEndpoint-bearing payload into.
  if (providerType === 'pi_compat') {
    return { form: 'merged', arm: 'pi', preset: 'custom' }
  }
  if (providerType === 'pi') {
    const flavour = connection.piAuthProvider
    if (flavour === undefined || MERGED_PI_AUTH_PROVIDERS.has(flavour)) {
      return { form: 'merged', arm: 'pi', preset: flavour === 'openai' ? 'openai' : 'anthropic' }
    }
    return { form: 'api-key', method: 'pi_api_key' }
  }
  // Plain `anthropic` round-trips through the merged Pi arm's Anthropic preset.
  // Its SUBMIT still maps through the `anthropic_api_key` setup shape (E5), so
  // the byte-level reset semantics at `llm-connections.ts:83-88` are preserved —
  // the router choosing the merged form does not change what gets sent.
  if (providerType === 'anthropic') {
    return { form: 'merged', arm: 'pi', preset: 'anthropic' }
  }
  return { form: 'api-key', method: 'anthropic_api_key' }
}

/** Prefill values for the Edit path, derived from the stored connection. */
export function byoRuntimeInitialValues(
  connection: { baseUrl?: string; models?: Array<string | { id: string }>; defaultModel?: string },
  apiKey?: string,
): Pick<ByoRuntimeFormValues, 'baseUrl' | 'apiKey' | 'models'> {
  const ids = (connection.models ?? [])
    .map(m => (typeof m === 'string' ? m : m.id))
    .filter(Boolean)
  return {
    baseUrl: connection.baseUrl ?? '',
    apiKey: apiKey ?? '',
    models: (ids.length ? ids : [connection.defaultModel].filter(Boolean) as string[]).join(', '),
  }
}
