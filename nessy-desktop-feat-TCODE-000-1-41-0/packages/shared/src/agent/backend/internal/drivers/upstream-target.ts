/**
 * The gateway-vs-BYO classification shared by every provider that reaches its
 * endpoint through the local `codex-responses-adapter`: `claude-runtime`
 * (drivers/anthropic.ts) and `codex-runtime` (drivers/codex.ts).
 *
 * It lives in one module because the rule it encodes is a governance boundary,
 * not a formatting detail — `Nestor-Token` may be attached to exactly one URL —
 * and two drivers each carrying their own copy of "which URL is the gateway" is
 * precisely how such a boundary drifts.
 */
import { NESTOR_CHAT_URL, type UpstreamTarget } from '@nessy-agent/codex-responses-adapter/nestor-client';
import type { CredentialManager } from '../../../../credentials/manager.ts';
import { createLogger } from '../../../../utils/debug.ts';

/**
 * The one endpoint that may be served with `Nestor-Token`, derived from the URL
 * the adapter's `kind: 'nestor'` mode actually posts to. Deriving it (rather
 * than re-declaring the literal) makes the classification below and the
 * transport physically incapable of disagreeing about which host+path is "the
 * gateway".
 *
 * AGENTS.md: "Custom endpoints, even on the same host with a different path,
 * must retain normal provider auth semantics" — hence a whole-URL match, not a
 * host or `…/api/v1/cli/` prefix match. `isNestorCliBaseUrl` (auth/nestor.ts) is
 * deliberately NOT reused here: it accepts every path under the CLI prefix.
 */
export const NESSY_GATEWAY_CHAT_BASE_URL = NESTOR_CHAT_URL.replace(/\/chat\/completions$/, '');

/** Trim surrounding space and trailing slashes so `…/v1` and `…/v1/` compare equal. */
export function normalizeUpstreamBaseUrl(baseUrl?: string): string {
  return (baseUrl ?? '').trim().replace(/\/+$/, '');
}

/** Whole-URL match against {@link NESSY_GATEWAY_CHAT_BASE_URL}. Blank is never the gateway. */
export function isNessyGatewayBaseUrl(baseUrl?: string): boolean {
  const normalized = normalizeUpstreamBaseUrl(baseUrl);
  return normalized.length > 0 && normalized === NESSY_GATEWAY_CHAT_BASE_URL;
}

/**
 * DA1.13 — is this one of the one-click Nessy Gateway cards, whose credential of
 * record is the shared dp JWT in `~/.nessy/dp_auth_creds.json` rather than
 * anything stored per connection?
 *
 * ## The written rule this predicate exists to carry
 *
 * A gateway card's credential is **created** by `dp` and lives in one file;
 * it is **read** live, per turn, by whichever runtime is serving the card
 * (`pi-agent.ts` symbol `resolveNestorGatewayJwtForPi`,
 * `codex-responses-adapter` symbol `readNestorCreds`, and this module's
 * `kind: 'nestor'` arm, which never reaches a connection credential at all);
 * it is **refreshed** by a forced re-mint on the auth retry
 * (`packages/server-core/src/sessions/SessionManager.ts` symbol
 * `refreshGatewayAuthForRetry`) and by the Reconnect item; and it is
 * **discarded** by signing out of dp. At no point in that lifecycle is a
 * per-connection copy consulted — so the card must not keep one, and the setup
 * RPC deletes any that an older install wrote.
 *
 * ## Why this is the fourth spelling, and how it differs from the other three
 *
 * The same three-provider-types-plus-this-URL rule is already spelled inside
 * `packages/server-core/src/sessions/SessionManager.ts` symbol
 * `refreshGatewayAuthForRetry` (a private method), in
 * `apps/electron/src/main/handlers/nessy-auth.ts` symbol
 * `isNessyGatewayConnection` (whose docblock says the two are kept in sync BY
 * HAND because the SessionManager one is not an export), and in the renderer
 * twin `apps/electron/src/renderer/components/apisetup/nessy-gateway.ts`. This
 * one is EXPORTED from the module that already owns "which URL is the gateway"
 * so the next lane can delete copies instead of adding a fifth.
 *
 * It is the **strict** form, and the difference is deliberate: a BLANK base URL
 * does NOT count here, where `refreshGatewayAuthForRetry`'s copy accepts one.
 * That copy decides whether to attempt a re-mint, which is cheap and harmless
 * when it guesses wide. This one decides whether to DELETE a stored credential
 * and whether to skip a store check, where guessing wide would drop a BYO
 * connection's real key or report an unconfigured card as authenticated. All
 * three one-click cards always carry `NESSY_GATEWAY_BASE_URL`
 * (`codexGatewayConnectionDefaults` / `claudeGatewayConnectionDefaults`, and the
 * Pi card through `buildGatewaySetup`), so the strict form loses none of them.
 *
 * ## Deliberately NOT `isNessyGatewayConnectionShape`
 *
 * `packages/shared/src/config/llm-connections.ts` symbol
 * `isNessyGatewayConnectionShape` matches the gateway HOST on any path, which is
 * right for the operator's gateway-only lock and WRONG here: DA1.10 measured
 * that a BYO `pi_compat` connection on a gateway-host path that is not a named
 * gateway endpoint no longer receives the dp JWT at all
 * (`packages/shared/src/auth/nestor.ts` symbol `isNestorGatewayCredentialUrl`).
 * Such a connection keeps a real user key of its own, and classifying it here
 * would delete it. The whole-URL match is the conservative direction: a
 * misclassified BYO card keeps working, where a misclassified gateway card
 * would lose a credential it needs.
 *
 * A caller that does not know the connection's endpoint passes none and gets
 * `false` — the store-only answer, which is what every path did before this row.
 */
export function isGatewayBackedConnection(connection: {
  providerType?: string | null;
  baseUrl?: string | null;
}): boolean {
  if (
    connection.providerType !== 'pi_compat'
    && connection.providerType !== 'claude-runtime'
    && connection.providerType !== 'codex-runtime'
  ) {
    return false;
  }
  return isNessyGatewayBaseUrl(connection.baseUrl ?? undefined);
}

/**
 * Attach the connection credential to a BYO target, read through the same seam
 * `resolveAuthEnvVars` uses (`getLlmApiKey`).
 *
 * The gateway mode never reads it: `Nestor-Token` comes from
 * `~/.nessy/dp_auth_creds.json` inside the adapter, and this path must not
 * acquire a second reader of that file. A keyless BYO endpoint (Ollama and
 * friends, `authType: 'none'`) yields a target with no `apiKey`, which the
 * transport turns into "no Authorization header".
 *
 * A BYO target with **no slug** throws instead (C3). C1 left it as a silent
 * keyless fallback because BYO connections could not be created; now that the
 * endpoint form makes them user-creatable, that fallback would send an
 * unauthenticated request to the user's own endpoint and surface its 401 as
 * "your key is wrong" — the one failure mode where our plumbing is blamed on
 * their credential. Every caller passes a slug (`codex-agent.resolveUpstream`
 * forwards `config.connectionSlug`; `resolveClaudeRuntimeUpstream` takes a
 * required `slug`), so this fails closed on a bug, not on a supported shape.
 */
export async function attachUpstreamCredential(args: {
  target: UpstreamTarget;
  slug?: string;
  /**
   * A thunk, not an instance: `getCredentialManager()` throws when the
   * credential store has not been initialized, and gateway mode must keep
   * working without one because it reads no connection credential at all.
   */
  credentialManager: () => Pick<CredentialManager, 'getLlmApiKey'>;
}): Promise<UpstreamTarget> {
  if (args.target.kind !== 'openai-compatible') return args.target;
  if (!args.slug) {
    throw new Error(
      `Cannot resolve credentials for custom endpoint ${args.target.baseUrl}: connection slug missing`,
    );
  }
  const apiKey = await args.credentialManager().getLlmApiKey(args.slug);
  return apiKey ? { ...args.target, apiKey } : args.target;
}

/**
 * ---------------------------------------------------------------------------
 * P3.363 - WHICH MODEL TARGET this session's tool schemas are about to reach.
 * ---------------------------------------------------------------------------
 *
 * MEASURED 2026-09-04, four arms against a stub that logged the request bodies
 * (the codex `/v1/responses` wire; the claude `/v1/messages` wire, translated;
 * the same route on the `anthropic-messages` passthrough; the Pi reasoning
 * proxy): every one forwards the whole `tools` array - `mcp__dpGitlab__*`,
 * `mcp__session__*`, names, descriptions AND JSON schemas - verbatim to the
 * upstream. No layer of this host consults WHICH model is on the other end
 * before doing so, on any runtime.
 *
 * This module answers only the first half of that: **which class of target is
 * it**. It withholds nothing, and it must not start withholding anything by
 * accident, because *what* to withhold from *whom* is a product posture the
 * owner has not settled (the source plan's DP-5 exempts BYO endpoints, and the
 * one host its W1 wanted to call "corporate" is also a BYO card's endpoint - an
 * unresolved collision recorded on the row). A DISCLOSURE is free of that
 * collision: telling a user their MCP tool schemas are leaving for an external
 * vendor is right under either resolution, and DP-5's "deliberate consequence,
 * recorded consciously" is not a consequence anybody consented to while nothing
 * said it out loud.
 *
 * `restricted` was therefore ADVISORY when this was written. Since DA2.14 it is
 * also the predicate the MCP withholding reads (see
 * {@link ModelTargetVerdict.restricted}); this module still withholds nothing
 * itself. The name is the vocabulary the parity row asks for, kept so the
 * enforcement lane inherited one predicate rather than minting a second.
 *
 * Two documented constraints on any future ENFORCEMENT, both from Claude's own
 * gateway contract, because the obvious place to put a filter is the wire and
 * the page says not to:
 *
 * - `llm-gateway-protocol.md#feature-pass-through`: "A gateway that rewrites or
 *   redacts request bodies for content inspection breaks the pairing the same
 *   way stripping does, so inspect without modifying."
 * - `llm-gateway-protocol.md#forward-as-open-lists`: "When forwarding to an
 *   Anthropic-format upstream, pass `anthropic-*` request headers and request
 *   body fields through unchanged rather than allowlisting the ones you see
 *   today." Quote the CONDITION with it, because the same section then says
 *   "The exception is a non-Anthropic upstream such as Amazon Bedrock or Google
 *   Cloud's Agent Platform, where bridging the schema difference is the
 *   gateway's job" - and that exception is precisely our translated arm, where
 *   the body is being rewritten anyway. It is NOT our `anthropic-messages`
 *   passthrough arm, which is the arm both sentences are literally about. A
 *   filter written to the wire is therefore defensible on one of the two claude
 *   routes and contradicts the page on the other; a filter written to the
 *   host's own tool set contradicts neither.
 *
 * So the honest seam for a filter is the host's own tool set, not the adapter's
 * outbound body - and the honest seam for OBSERVATION is here, before either.
 *
 * ---------------------------------------------------------------------------
 * DA2.1 - the DP-5 collision is RESOLVED: namespace-only, permanently.
 * ---------------------------------------------------------------------------
 *
 * The alternative on the table was a connection KIND (gateway, BYO,
 * subscription, loopback) as a first axis beside host and namespace. It is
 * REFUSED, and not on grounds of cost. Four readings, each nameable in code:
 *
 * 1. **DP-5 governs a WITHHOLDING; this flag is a DISCLOSURE.** Its sentence is
 *    "the whitelist restricts ONLY the corporate proxy channel ... BYO endpoints
 *    and the future subscription cards are NOT restricted". A whitelist takes a
 *    tool away. `restricted` here takes nothing away and says so three
 *    paragraphs above. They are two questions and DP-5 answers one of them.
 *
 * 2. **A kind axis cannot separate the two populations DP-5 names, because at
 *    HEAD they are the SAME connections.**
 *    `apps/electron/src/renderer/components/apisetup/byo-runtime.ts` symbol
 *    `DEFAULT_ENDPOINT_URL` is the llm-proxy host, and the endpoint field it
 *    backs is hidden, so every BYO card submits the corporate proxy channel
 *    unless the user already had a foreign URL stored. Exempting "BYO" would
 *    therefore exempt precisely the channel DP-5 restricts. That is the
 *    collision itself, not a way out of it.
 *
 * 3. **Two of the four kinds are already axes here, and the other two are not
 *    fields of this tree.** `nessy-gateway` is the whole-URL match and
 *    `loopback` is the parsed host - both decided below, before any namespace is
 *    read. BYO and subscription are not values of anything:
 *    `packages/shared/src/config/llm-connections.ts` symbol `LlmProviderType`
 *    has six members and none of them is either word, and a subscription card is
 *    distinguishable only by its `authType`. So the axis would have to be
 *    SYNTHESIZED, and what it would synthesize is "neither the gateway nor
 *    loopback" - which is exactly the set that reaches the namespace test below.
 *    Adding it would make `restricted` unreachable: it would not re-scope the
 *    disclosure, it would delete it.
 *
 * 4. **What the classifier answers is WHERE the schemas go, never WHOSE
 *    credential paid for them.** A user who points their own key at an external
 *    vendor consented to the credential, which is DP-5's point; nothing about
 *    that consent is a statement about their MCP tool SCHEMAS, which is this
 *    module's. DP-5's own "deliberate consequence, recorded consciously" is only
 *    recorded if something records it.
 *
 * **The consequence, stated rather than left to be discovered.** The kind axis
 * is not wrong, it is in the wrong module: it belongs to the INPUT of an
 * enforcement arm, if one is ever built (DA2.3), where "may this tool be
 * withheld from this connection" is the actual question and BYO is the actual
 * exemption. It must not be added here, because here it has no question to
 * answer. A lane that disagrees changes this paragraph in the same commit as the
 * code, and the test table below pins the resolution: a BYO endpoint at a vendor
 * and the BYO card's own default corporate-proxy endpoint reach the SAME verdict
 * for the same model, because the connection is not an axis.
 *
 * **The REFERENCE agrees on the axis and disagrees on the exemption, and the
 * second half is what blocks DA2.2 (read 2026-09-14 at nessy-cli `9d94ec5d4`,
 * evidence not authority).** Their allow-check is
 * `packages/core/src/config/config.ts` symbol `isMcpServerAllowedForModel`,
 * which passes a server when `contentGeneratorConfig.internal === true` OR the
 * name is in `packages/core/src/core/openaiContentGenerator/constants.ts` symbol
 * `EXTERNAL_MODEL_MCP_WHITELIST` (eight names). That `internal` flag is NOT the
 * catalogue's `is_internal`: their models client reads that field, and
 * `packages/core/src/models/modelRegistry.ts` overwrites it one hop later with
 * `isInternalModel(config.id)`, which
 * `packages/core/src/utils/configResolver.ts` symbol `isInternalModel` defines
 * as a bare model-id PREFIX test. So the only separator in the donor is the
 * model NAMESPACE - the same axis kept above, reached independently - and it
 * carries no connection kind and no host list either.
 *
 * What it also carries is NO BYO EXEMPTION: their rule is "internal model, or a
 * whitelisted server", for every connection. DP-5 exempted BYO and subscription
 * by name, so porting the donor verbatim would have breached DP-5, and
 * honouring DP-5 needed a BYO-vs-corp-channel signal that reading 2 shows this
 * tree does not have. That was an OWNER decision, not a lane's.
 *
 * **It has since been taken, and this paragraph no longer describes an open
 * question (DA2.14, 2026-09-17): option (a), NAMESPACE-ONLY.** DP-5's exemption
 * is amended away - a BYO endpoint at a vendor is restricted exactly as the
 * corporate proxy channel is - and DA2.2 half A ships as the donor's rule, with
 * the seed and its own reasoning in `external-model-mcp-whitelist.ts` beside
 * this file. Reading 3's "adding a kind axis would DELETE the disclosure" is
 * what makes the amendment cheap rather than lossy: nothing about the four
 * readings above changes, only what the `restricted` flag now authorises.
 */

/**
 * What kind of endpoint+model pair a session is pointed at.
 *
 * `unclassified` is not a failure mode, it is the fail-CLOSED arm: an id whose
 * namespace this host does not recognise discloses exactly as a known external
 * vendor does. That is what makes the vendor list below affect only the WORDING
 * of the notice and never whether one is emitted - a list that cannot be
 * complete must not be load-bearing.
 */
export type ModelTargetClass =
  /** The verified Nessy Gateway, whole-URL match. Its catalogue is internal. */
  | 'nessy-gateway'
  /** A loopback endpoint (Ollama and friends): the weights run on this machine. */
  | 'loopback'
  /** A `tgpt/` id: deployed inside the bank's perimeter, wherever it is proxied. */
  | 'vendor-internal'
  /** A namespace that names an external model vendor. */
  | 'external-vendor'
  /** An endpoint or namespace this host cannot place. Fail-closed: discloses. */
  | 'unclassified'
  /** No endpoint configured; the provider's own default applies (see below). */
  | 'provider-default';

export interface ModelTargetVerdict {
  class: ModelTargetClass;
  /**
   * True means "a disclosure is owed", and SINCE DA2.14 (owner decision
   * 2026-09-17) it also means "the MCP withholding applies".
   *
   * It was ADVISORY - "never a tool was withheld" - for as long as the owner
   * question behind DA2.2 half A was open. It is no longer: the policy that
   * reads this flag is `external-model-mcp-whitelist.ts` and the enforcement is
   * in `mcp/runtime-pool-servers.ts`. This module still withholds nothing
   * itself and still classifies for both consumers at once, which is the
   * property worth keeping - a class added below lands on whichever side its
   * author puts it, for the notice and the filter together.
   */
  restricted: boolean;
  /**
   * The endpoint HOST, never the path, query or credential.
   * `network-address-guard.ts`'s own rule - a reason line must not carry a URL
   * that may embed a secret - applies here for the same reason.
   */
  host: string;
  reason: string;
}

/**
 * Namespaces that name a model vendor OUTSIDE the perimeter, from the source
 * plan's W1 ("`anthropic/`, `gemini/`, `azure/`, `openai/` = proxied to the
 * external vendor's API"). Extended only with namespaces someone has actually
 * seen; an unlisted one lands in `unclassified` and discloses anyway, so this
 * list is a vocabulary, not a gate.
 */
const EXTERNAL_VENDOR_NAMESPACES: readonly string[] = Object.freeze([
  'anthropic', 'openai', 'gemini', 'google', 'azure', 'xai', 'mistral', 'cohere',
]);

/**
 * Hosts that ARE a model vendor's own API - D1.191.
 *
 * Read ONLY in the fallback arm below, after both namespace tests, so it moves
 * no verdict that the namespace axis already decided: it splits the
 * `unclassified` tail into "at a vendor we can name" and "somewhere this host
 * cannot place", and `restricted` is true on both sides. Wording, never a gate -
 * the same property `EXTERNAL_VENDOR_NAMESPACES` has, for the same reason.
 *
 * Why it was needed: an endpoint-less SUBSCRIPTION card carries no vendor
 * namespace in its model id (`claude-opus-4-8`, `gpt-5-codex`), so the Claude
 * Pro/Max card was disclosing with the reason *"the model id carries no vendor
 * namespace"* about `api.anthropic.com` - a "could not be classified" sentence
 * about the vendor's own front door (measured by WI-e, A3.14 item 4).
 *
 * Each entry has a source and none is guessed: `api.anthropic.com` is the SDK's
 * own default for a direct anthropic connection (the factory substitutes it and
 * says so); `chatgpt.com` is Pi's own `DEFAULT_CODEX_BASE_URL`
 * (`https://chatgpt.com/backend-api`, read out of the vendored
 * `@earendil-works/pi-coding-agent` bundle at 0.84.4); `api.openai.com` is the
 * OpenAI default the same bundle carries beside it.
 */
const EXTERNAL_VENDOR_HOSTS: readonly string[] = Object.freeze([
  'api.anthropic.com', 'chatgpt.com', 'api.openai.com',
]);

/** `tgpt/` - "deployed inside the bank's perimeter (incl. Qwen, DeepSeek hosted on T-GPT)". */
const INTERNAL_VENDOR_NAMESPACES: readonly string[] = Object.freeze(['tgpt']);

/** The part before the first `/`, lowercased. Empty for an unprefixed id. */
function modelNamespace(model?: string): string {
  const trimmed = (model ?? '').trim();
  const slash = trimmed.indexOf('/');
  return slash > 0 ? trimmed.slice(0, slash).toLowerCase() : '';
}

/**
 * The endpoint host, PARSED - never a substring test. nessy-cli's
 * `baseUrl.includes('llm-proxy')` matches an attacker path segment on any host,
 * and that class of bug is why this returns `null` rather than guessing.
 */
function upstreamHost(baseUrl: string): string | null {
  try {
    const hostname = new URL(baseUrl).hostname;
    const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    return bare.toLowerCase() || null;
  } catch {
    return null;
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Classify the endpoint+model pair a session will send its tool schemas to.
 *
 * Pure and synchronous: it resolves no DNS and reads no settings, so it can run
 * on the session-creation path without adding a failure mode to it.
 */
export function classifyModelTarget(
  input: { baseUrl?: string; model?: string; providerType?: string },
): ModelTargetVerdict {
  const baseUrl = normalizeUpstreamBaseUrl(input.baseUrl);
  if (baseUrl.length === 0) {
    // D1.221 — `provider-default` is FAIL-CLOSED, with one measured exception.
    //
    // PRODUCT POSTURE, stated here because since DA2.14 this flag withholds MCP
    // servers rather than only wording a notice. D1.191 settled the two
    // SUBSCRIPTION cards by naming their vendor defaults (`api.anthropic.com`,
    // `chatgpt.com/backend-api`); every OTHER endpoint-less connection kept
    // `restricted: false` and disclosed nothing, although a Pi card on
    // `openai`, `anthropic` or `github-copilot` is sent by Pi to that vendor's
    // own API. The row offered two fixes and this is the smaller: a
    // per-provider default-endpoint map would be a vocabulary that CANNOT be
    // complete — `LlmConnection.piAuthProvider` is typed `string`, not a union —
    // and a class that cannot be complete must not decide whether a disclosure
    // is owed. So an endpoint this host cannot NAME is treated as one it cannot
    // VOUCH for, which is what `unclassified` already does one arm down.
    //
    // THE EXCEPTION IS MEASURED, NOT ASSUMED. The row's own worry — "an
    // endpoint-less connection whose egress is INSIDE the perimeter" — is real
    // and has exactly one instance today: the Nessy Cloud Agent is created with
    // no `baseUrl` at all (`connection-setup-logic.ts`, preset
    // `nessy-cloud-agent`), and `isNessyGatewayConnectionShape` already declares
    // that providerType internal unconditionally, without consulting a URL. It
    // is carved out by that same declaration rather than by a guess, and it is
    // the ONLY carve-out: anything else with no endpoint is a vendor default.
    if (input.providerType === 'nestor-cloud-agent') {
      return {
        class: 'provider-default',
        restricted: false,
        host: '',
        reason: 'the Nessy Cloud Agent runs inside the perimeter and configures no endpoint of its own',
      };
    }
    // A CALLER THAT NAMES NO PROVIDER GETS THE PRE-D1.221 ANSWER, and this is a
    // stated residue with an owner rather than a design. There is exactly one
    // such caller today — `apps/electron/src/renderer/lib/model-target-disclosure.ts`,
    // the model picker's helper, whose `ModelTargetFacts` carry `baseUrl` and
    // `model` only. That surface ALREADY under-discloses for an endpoint-less
    // connection and did so before this row: the two named provider defaults
    // D1.191 added live in `backend/factory.ts`, so the picker never sees them
    // either, and both subscription cards render there as if no endpoint were
    // in play. Fixing it needs a third fact on those facts plus a sentence for
    // an endpoint that has no host to name — a locale key, so the renderer lane
    // owns it. Withholding is unaffected: `mcp/runtime-pool-servers.ts` reads
    // the verdict on the BACKEND CONFIG, which is always classified with the
    // provider named.
    if (input.providerType === undefined) {
      return {
        class: 'provider-default',
        restricted: false,
        host: '',
        reason: 'no endpoint configured; the provider default applies',
      };
    }
    return {
      class: 'provider-default',
      restricted: true,
      host: '',
      reason: 'no endpoint is configured, so the provider\'s own default applies and this host cannot name it',
    };
  }
  if (isNessyGatewayBaseUrl(baseUrl)) {
    return {
      class: 'nessy-gateway',
      restricted: false,
      host: upstreamHost(baseUrl) ?? '',
      reason: 'the verified Nessy Gateway',
    };
  }
  const host = upstreamHost(baseUrl);
  if (host === null) {
    return {
      class: 'unclassified',
      restricted: true,
      host: '',
      reason: 'the endpoint URL could not be parsed',
    };
  }
  if (LOOPBACK_HOSTS.has(host)) {
    return { class: 'loopback', restricted: false, host, reason: 'a loopback endpoint' };
  }
  return classifyHostedModelTarget(host, input.model);
}

/**
 * The MODEL-SENSITIVE tail of {@link classifyModelTarget}, extracted for
 * {@link modelTargetForModel} (D1.425) so a mid-session model change re-runs
 * THIS code rather than a second copy of it.
 *
 * Everything above the call site is decided by the ENDPOINT alone — no
 * endpoint, the verified gateway, an unparseable URL, a loopback host — and a
 * model change cannot move any of those. From here down the answer is a
 * function of `(host, model)` and nothing else, which is the property
 * `modelTargetForModel` needs and the reason this is a split rather than a new
 * rule: `host` is already on the verdict, and it is the one endpoint fact this
 * module is allowed to keep (see {@link ModelTargetVerdict.host} — never the
 * path, query or credential).
 */
function classifyHostedModelTarget(host: string, model?: string): ModelTargetVerdict {
  const namespace = modelNamespace(model);
  if (INTERNAL_VENDOR_NAMESPACES.includes(namespace)) {
    return {
      class: 'vendor-internal',
      restricted: false,
      host,
      reason: `the "${namespace}" namespace is served inside the perimeter`,
    };
  }
  if (EXTERNAL_VENDOR_NAMESPACES.includes(namespace)) {
    return {
      class: 'external-vendor',
      restricted: true,
      host,
      reason: `the "${namespace}" namespace names an external model vendor`,
    };
  }
  if (EXTERNAL_VENDOR_HOSTS.includes(host)) {
    return {
      class: 'external-vendor',
      restricted: true,
      host,
      reason: `"${host}" is a model vendor's own API`,
    };
  }
  return {
    class: 'unclassified',
    restricted: true,
    host,
    reason: namespace.length > 0
      ? `the "${namespace}" namespace is not one this host can place`
      : 'the model id carries no vendor namespace',
  };
}

/**
 * D1.425 — the verdict for the model this session is ABOUT TO SEND WITH.
 *
 * `classifyModelTarget` runs ONCE, in `createBackendFromResolvedContext`, and
 * two of the three runtimes OUTLIVE it: a mid-session model pick reaches
 * `BaseAgent.setModel` (and, on pi and codex, `updateRuntimeConfig`) without
 * the agent ever being rebuilt — `buildRestartRequiredSignature` hashes no
 * model — so the construction-time verdict goes stale in BOTH directions. A
 * session that started on a `tgpt/` model and switched to an external one kept
 * every MCP server `external-model-mcp-whitelist.ts` withholds, while the model
 * picker's own disclosure had already told the user they would be withheld; and
 * a session that switched BACK to an internal model stayed locked out of its
 * own servers until it was restarted. claude was never affected: it declares no
 * `updateRuntimeConfig`, so it is disposed and rebuilt through the factory.
 *
 * NOT a second derivation, and that is the whole design: for a class the
 * ENDPOINT decided, the verdict is returned untouched, and otherwise the same
 * `classifyHostedModelTarget` the classifier itself ends on is re-run against
 * the verdict's own `host`. `upstream-target.test.ts` pins the equivalence
 * (`modelTargetForModel(classify(url, A), B)` deep-equals `classify(url, B)`)
 * over the whole table rather than asserting it here.
 *
 * It never MINTS a verdict: `undefined` in, `undefined` out, so a backend built
 * outside the factory keeps withholding nothing, exactly as
 * `BackendConfig.modelTarget`'s own contract says.
 */
export function modelTargetForModel(
  verdict: ModelTargetVerdict | undefined,
  model: string | undefined,
): ModelTargetVerdict | undefined {
  if (!verdict) return undefined;
  // Decided by the endpoint alone: no endpoint at all (`provider-default`), the
  // verified gateway, or a loopback host. The model is not an input to any of
  // the three, so re-running would answer the same thing at best and lose the
  // providerType carve-outs at worst.
  if (verdict.class === 'provider-default' || verdict.class === 'nessy-gateway' || verdict.class === 'loopback') {
    return verdict;
  }
  // The OTHER `unclassified` — an endpoint URL that could not be parsed. It has
  // no host to re-classify against and the model never entered into it.
  if (verdict.host.length === 0) return verdict;
  return classifyHostedModelTarget(verdict.host, model);
}

/**
 * The endpoint a session's tool schemas are actually sent to - the THREE-TERM
 * derivation `createBackendFromResolvedContext` has always carried, extracted
 * because F1.110 gave it a second reader.
 *
 * Extracted rather than copied, and that is the whole of the row: the factory's
 * own comment says the value is "read ONCE and used twice, by the disclosure
 * below and by the verdict on the config", because "two derivations of which
 * endpoint is this session pointed at is how the line a user is shown and the
 * servers actually withheld would come to disagree". A THIRD reader on the
 * mid-session edit path (`PiAgent.updateRuntimeConfig`) is that same hazard one
 * layer along, so it reads this function rather than a third spelling of the
 * same chain.
 *
 * The two named defaults are D1.191's and neither is guessed: `api.anthropic.com`
 * is the SDK's own default for a direct `anthropic` connection, and
 * `chatgpt.com/backend-api` is Pi's own `DEFAULT_CODEX_BASE_URL`. Every other
 * endpoint-less connection returns `undefined` and lands in `provider-default`,
 * which is the posture the factory states at length and this move does not
 * change.
 */
export function modelTargetBaseUrlForConnection(connection: {
  baseUrl?: string;
  providerType?: string;
  piAuthProvider?: string;
  codexModelProvider?: string;
}): string | undefined {
  return connection.baseUrl?.trim()
    || (connection.providerType === 'anthropic' ? 'https://api.anthropic.com' : undefined)
    || (connection.piAuthProvider === 'openai-codex' ? 'https://chatgpt.com/backend-api' : undefined)
    // F1.202 — the ChatGPT (Codex) card: codex's own `CHATGPT_CODEX_BASE_URL`
    // (`codex-rs/model-provider-info/src/lib.rs` at `rust-v0.156.1`), where the
    // declared `openai` provider sends a ChatGPT-authenticated session. Spelled
    // as the literal `CODEX_CHATGPT_MODEL_PROVIDER` holds because this leaf
    // imports no config; `codex-chatgpt-subscription.test.ts` pins the two together.
    || (connection.providerType === 'codex-runtime' && connection.codexModelProvider === 'openai'
      ? 'https://chatgpt.com/backend-api/codex'
      : undefined);
}

/**
 * F1.110 - the verdict for an endpoint that MOVED under a live session.
 *
 * D1.425 closed the MODEL half: {@link modelTargetForModel} re-runs the
 * model-sensitive tail against the verdict's own `host`. It cannot close the
 * ENDPOINT half, because the verdict deliberately keeps no URL - only the host,
 * never the path, query or credential (see {@link ModelTargetVerdict.host}) - so
 * a whole-URL rule like the gateway's cannot be re-decided from a verdict alone.
 *
 * Pi is the one runtime that outlives an endpoint change: `updateRuntimeConfig`
 * re-points the upstream IN PLACE and `buildRestartRequiredSignature`
 * (`packages/server-core/src/sessions/runtime-config.ts`) hashes no `baseUrl`,
 * so the agent is never rebuilt. codex refuses any update that is not model-only
 * and is disposed and recreated instead; claude declares no `updateRuntimeConfig`
 * at all.
 *
 * It takes the endpoint on BOTH sides and re-classifies only when the derived
 * URL actually moved. That guard is not a micro-optimisation, it is what keeps
 * the other inputs out of the answer: `classifyModelTarget`'s `provider-default`
 * arm is decided by `providerType`, and the value a LIVE agent carries
 * (`BackendConfig.providerType`, already defaulted by the factory) is not always
 * the value the factory classified with (`connection?.providerType`, which is
 * `undefined` for a connection-less build). An unmoved endpoint therefore hands
 * back the construction verdict untouched rather than a freshly derived one that
 * could differ for a reason having nothing to do with the edit.
 *
 * It never MINTS a verdict - `undefined` in, `undefined` out - for the reason
 * {@link modelTargetForModel} gives: a backend built outside the factory keeps
 * withholding nothing, which is `BackendConfig.modelTarget`'s own contract.
 */
export function modelTargetForEndpoint(
  verdict: ModelTargetVerdict | undefined,
  previous: { baseUrl?: string; providerType?: string; piAuthProvider?: string },
  next: { baseUrl?: string; providerType?: string; piAuthProvider?: string },
  model: string | undefined,
): ModelTargetVerdict | undefined {
  if (!verdict) return undefined;
  const before = normalizeUpstreamBaseUrl(modelTargetBaseUrlForConnection(previous));
  const after = normalizeUpstreamBaseUrl(modelTargetBaseUrlForConnection(next));
  if (before === after) return verdict;
  return classifyModelTarget({ baseUrl: after, model, providerType: next.providerType });
}

/** How many tool names one notice may carry before it summarises the tail. */
const NOTICE_TOOL_NAME_LIMIT = 20;

/**
 * The one line a reader gets. `null` when nothing is owed.
 *
 * NAMES ONLY, and only `mcp__` ones: a description or a JSON schema is the
 * payload under discussion and must not be copied into a log to describe
 * itself. Sorted, deduplicated and capped so the line is stable enough to diff
 * across runs.
 *
 * `toolNames` is optional because the seam that knows the target (session
 * creation) and the seam that knows the tool array (the wire) are not the same
 * seam in this tree - measured, and stated on the parity row. Passing none
 * yields the honest weaker sentence rather than a fabricated list.
 *
 * F1.908 (origin SIT-aa F7) - the tail says what the host DOES. Until that row
 * it ended "sent to it unfiltered - no host control exists yet (P3.363)", which
 * was true when P3.363 wrote it and false since DA2.14: on this same
 * `restricted` flag `mcp/runtime-pool-servers.ts` withholds every MCP and
 * api-transport server outside `EXTERNAL_MODEL_MCP_WHITELIST`, and the
 * `external_model_mcp.withheld` receipt printed on the next line named them. The
 * sentence therefore points at that receipt rather than listing servers itself -
 * this seam holds no server list, and the receipt is the one computation of it -
 * and names the residue the pool cannot reach (`mcp__session__*`). A NAMED
 * notice's names come off the outbound body, i.e. after the withholding, so they
 * are what is sent and are no longer called "unfiltered".
 */
export function modelTargetToolEgressNotice(
  verdict: ModelTargetVerdict,
  options?: { toolNames?: readonly string[] },
): string | null {
  if (!verdict.restricted) return null;
  // D1.221 — a restricted `provider-default` has no host to name, and calling
  // it "an unparseable endpoint" would be false: the URL was not unparseable,
  // there was none. Its own sentence, so the reader is told what is actually
  // known about the target.
  const where = verdict.host.length > 0 ? verdict.host : 'an unparseable endpoint';
  const head = verdict.class === 'provider-default'
    ? `model target is this provider's own default endpoint (${verdict.reason})`
    : verdict.class === 'external-vendor'
      ? `model target ${where} is an external model vendor (${verdict.reason})`
      : `model target ${where} could not be classified (${verdict.reason})`;
  const mcpNames = [...new Set((options?.toolNames ?? []).filter(name => name.startsWith('mcp__')))].sort();
  const withholding = 'MCP servers outside the external-model allow list are withheld from it (each withheld server is named on an external_model_mcp.withheld line)';
  if (mcpNames.length === 0) {
    return `${head}; ${withholding}, and the MCP tool schemas of the allowed servers and of mcp__session__* are still sent`;
  }
  const shown = mcpNames.slice(0, NOTICE_TOOL_NAME_LIMIT);
  const tail = mcpNames.length > shown.length ? ` (+${mcpNames.length - shown.length} more)` : '';
  return `${head}; ${mcpNames.length} MCP tool schemas are sent to it: ${shown.join(', ')}${tail} - ${withholding}`;
}

/**
 * One notice per distinct (class, host, namespace, HAS-TOOL-NAMES) per process —
 * FOUR terms, not three. The fourth is the ` +tools` tier `89f28509e` added, and
 * it is what makes a NAMED notice reachable at all; the key is built in
 * {@link noteModelTargetToolEgress}, whose own inline comment carries the
 * measurement. This docblock said three terms until DA2.6 (2026-09-14), which is
 * how a second module came to describe the codex disclosure as permanently
 * suppressed.
 *
 * A per-session line would be per-turn noise on a long-running app, and the
 * fact being reported does not change between two sessions on the same
 * connection. Keyed on the CLASS as well as the host so a connection that later
 * runs an unclassified id says so again.
 */
const emittedModelTargetNotices = new Set<string>();

/** Test-only: the dedup above is process-wide and would leak between cases. */
export function _resetModelTargetNoticesForTesting(): void {
  emittedModelTargetNotices.clear();
}

/**
 * F1.111 / F1.143 - the operator channel a PACKAGED build actually carries.
 *
 * Measured, not assumed: `apps/electron/src/main/logger.ts` sets both
 * `log.transports.file.level` and `log.transports.console.level` to `false`
 * whenever `isDebugMode` is false, and a packaged build always is - so every
 * `platform.logger` call in the Electron host (including `SessionManager`'s
 * `sessionLog`, which is that logger scoped) writes NOTHING there. That file's
 * own comment names the sink that survives: `createLogger`
 * (`@nessy-agent/shared/utils`), stderr under `NESSY_DEBUG=1` and mirrored into
 * electron-log for a dev build - the channel `[ws-rpc-server]`, `[dp-auth]` and
 * `[ConfigWatcher]` are on, and the stream SIT-10 already had open when it read
 * that run's `[PERF]` lines and found ZERO withholding receipts (P-SIT10-6).
 *
 * Declared HERE and imported by `external-model-mcp-whitelist.ts` so the
 * disclosure and the withholding receipt share ONE scope name: an operator
 * greps `[model-target]` once and gets both halves of the same decision.
 */
export const modelTargetOperatorLog = createLogger('model-target');

/**
 * The dedupe key - (class, host, model-namespace, HAS-TOOL-NAMES).
 *
 * The tools tier is what makes a NAMED notice reachable at all. Measured by
 * W5-b (2026-09-04): `backend/factory.ts` claims this exact key at BACKEND
 * CONSTRUCTION - before any turn, with no tool names - so the adapter's later
 * `onOutboundTools` call, which is the one that can name them, was deduped away
 * and the sink read as wired while being permanently silent. One strictly-
 * more-informative notice per target is the intent: the unnamed one once, the
 * named one once.
 *
 * Shared by the two entry points below rather than spelled in each, because a
 * second copy of this rule is how the construction notice and the mid-session
 * one would come to dedupe against different keys and both fire.
 */
function modelTargetNoticeKey(
  verdict: ModelTargetVerdict,
  model: string | undefined,
  toolNames: readonly string[] | undefined,
): string {
  return `${verdict.class} ${verdict.host} ${modelNamespace(model)}${toolNames?.length ? ' +tools' : ''}`;
}

/**
 * F1.111 - disclose a verdict the session ALREADY holds, once per process.
 *
 * {@link noteModelTargetToolEgress} classifies from a URL and a model, which is
 * what the three CONSTRUCTION call sites have. A session that moves mid-flight
 * has something better and something less: it has the freshened verdict itself
 * (from {@link modelTargetForModel} or {@link modelTargetForEndpoint}) and it
 * does NOT have the endpoint, because the verdict deliberately keeps no URL. So
 * this entry point takes the verdict, and the two share the dedupe set and the
 * key above rather than two copies of either.
 *
 * ## ONE sink, the same contract as its sibling (F1.908)
 *
 * `emit` REPLACES the fallback here exactly as it does on
 * {@link noteModelTargetToolEgress}; with no host port the line goes to
 * {@link modelTargetOperatorLog}, the channel a packaged build keeps.
 *
 * F1.111 wrote to BOTH, because the one host port was then bound to
 * `sessionLog.warn`, which a packaged build drops. F1.177 re-bound that port
 * (`SessionManager`'s `onModelTargetDisclosure`) to `createLogger('model-target')`
 * - this very scope - so from then on one decision reached the same stream twice
 * in the same millisecond, which is what SIT-aa read on a packaged build. The
 * reason for the second copy expired with F1.177; the port's own contract
 * (`CoreBackendConfig.onModelTargetDisclosure`: "Log it on a channel a packaged
 * build keeps, then forward") is what keeps the operator line alive.
 *
 * Best-effort by contract, like its sibling: a disclosure that can fail a
 * session is worse than a disclosure nobody reads.
 */
export function noteModelTargetVerdictEgress(input: {
  verdict: ModelTargetVerdict;
  model?: string;
  toolNames?: readonly string[];
  emit?: (line: string) => void;
}): string | null {
  try {
    const notice = modelTargetToolEgressNotice(input.verdict, { toolNames: input.toolNames });
    if (!notice) return null;
    const key = modelTargetNoticeKey(input.verdict, input.model, input.toolNames);
    if (emittedModelTargetNotices.has(key)) return null;
    emittedModelTargetNotices.add(key);
    (input.emit ?? ((line: string) => modelTargetOperatorLog.warn(line)))(notice);
    return notice;
  } catch {
    return null;
  }
}

/**
 * Classify, disclose once, and hand the line back so a caller can render it.
 *
 * Best-effort by contract: this runs on the session-creation path and a
 * diagnostic that can fail a session is worse than no diagnostic.
 */
export function noteModelTargetToolEgress(input: {
  baseUrl?: string;
  model?: string;
  /**
   * D1.221 — carried through to {@link classifyModelTarget}, which needs it for
   * exactly one verdict: an endpoint-less `nestor-cloud-agent`, whose egress is
   * internal by declaration. Every other caller may leave it unset and gets the
   * same answer it got before.
   */
  providerType?: string;
  toolNames?: readonly string[];
  /**
   * The HOST's sink, and in tests an injection point. Defaults to `console.warn`,
   * this directory's convention.
   *
   * DA2.15 — until that row this said "injected in tests" and nothing else,
   * which was an accurate description of every caller: all THREE
   * (`backend/factory.ts`, `claude-agent.ts`, `codex-agent.ts`) left it unset, so
   * the `console.warn` below was the only channel and a packaged Electron build
   * disables the transports that would carry it. The disclosure DA2.6 shipped the
   * copy for was therefore being written where nobody could read it. The three
   * now pass `CoreBackendConfig.onModelTargetDisclosure` — one optional port, the
   * host supplies it once, and the fallback here is what keeps an unset host on
   * exactly the old path.
   *
   * A caller that supplies this REPLACES the `console.warn`; it does not add to
   * it. A host sink that only forwards to a renderer therefore drops the operator
   * line, which is why the port's own docblock tells a host to log and then
   * forward.
   */
  emit?: (line: string) => void;
}): string | null {
  try {
    const verdict = classifyModelTarget(input);
    const notice = modelTargetToolEgressNotice(verdict, { toolNames: input.toolNames });
    if (!notice) return null;
    // The key rule moved to `modelTargetNoticeKey` when F1.111 gave it a second
    // reader; its measurement moved with it, and this site is unchanged.
    const key = modelTargetNoticeKey(verdict, input.model, input.toolNames);
    if (emittedModelTargetNotices.has(key)) return null;
    emittedModelTargetNotices.add(key);
    (input.emit ?? ((line: string) => console.warn(`[model-target] ${line}`)))(notice);
    return notice;
  } catch {
    return null;
  }
}
