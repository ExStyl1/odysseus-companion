/**
 * DA2.6 — what the user is told when this session's MCP tool schemas are about
 * to leave for a model target outside the corporate gateway.
 *
 * ## What this is NOT
 *
 * It is not a filter. Under DA2.1's resolution
 * (`packages/shared/src/agent/backend/internal/drivers/upstream-target.ts`)
 * `restricted` means **a disclosure is owed**; this module classifies and
 * withholds nothing, and DA2.3's refusal of the WIRE filter stands.
 *
 * **What changed on 2026-09-17, and it inverts the paragraph that stood here:**
 * DA2.14 answered the owner question this file recorded as open, and DA2.2's
 * POOL filter landed — `applyExternalModelMcpWhitelist`
 * (`packages/shared/src/mcp/runtime-pool-servers.ts`) really does drop every
 * non-whitelisted MCP and api-transport server before `pool.sync` when
 * `modelTargetWithholdsMcpServers` says so, over the same
 * `verdict.restricted` this module reads. So the withholding is now a state
 * that EXISTS, and the superseded half was dropped for a reason that has
 * expired.
 *
 * It was still right to drop the COUNTING form of it: the copy lives where no
 * server list does, so an "N servers hidden" line would need a count threaded
 * from both pickers out of a source neither holds. DA1.69's replacement is
 * count-free and says what is withheld rather than how many
 * (`chat.modelPicker.toolEgressWithholding`), which is why the guard in
 * `lib/__tests__/model-target-disclosure.test.ts` still binds the two SEND
 * sentences and cannot be satisfied by a new key.
 *
 * ## Why the renderer classifies instead of subscribing
 *
 * `noteModelTargetToolEgress` in that same module already emits a line, and the
 * obvious wiring would be to render it. Measured by WB-b at `d5db8105d` and
 * recorded here because it is the trap: that function DEDUPES per process on
 * `(class, host, namespace, has-tool-names)`, so a surface driven off its
 * emissions would show at most two lines for the life of the host process and
 * NOTHING for every session after the first. It also runs in the server
 * process, so reaching it would need a new wire event.
 *
 * `classifyModelTarget` is the honest half for a surface: pure, synchronous,
 * cannot throw, no dedup, no wire. The renderer already holds both inputs — the
 * connection's `baseUrl` and the model id — so it classifies for itself and
 * `noteModelTargetToolEgress` keeps its own job (the once-per-process log line).
 *
 * ## The host, and nothing but the host
 *
 * The verdict's `host` is a PARSED hostname; the classifier's own tests pin that
 * a `?key=…` cannot reach it. Nothing here ever renders a path, a query or a
 * credential, and the verdict's `reason` — an English clause with no locale
 * twin — is deliberately not rendered either.
 */
import { classifyModelTarget, modelTargetBaseUrlForConnection } from '@nessy-agent/shared/agent/backend/internal/drivers/upstream-target'

/** A structural subset of `LlmConnection`, so a test needs no fixture. */
export interface ModelTargetFacts {
  readonly baseUrl?: string
  readonly model?: string
  /**
   * D1.246 — the THIRD fact, and the picker under-disclosed without it.
   *
   * `classifyModelTarget` became fail-closed for an endpoint-less connection in
   * D1.221 — an endpoint this host cannot NAME is one it cannot VOUCH for — but
   * it keeps the old silent verdict for a caller that names no provider at all,
   * which was this module. So the backend withheld MCP servers from a
   * subscription card while the picker showed no mark at all for the same
   * connection: the two surfaces disagreed about the same session.
   */
  readonly providerType?: string
  /**
   * F1.572 — the two facts that name a SUBSCRIPTION card's endpoint, which the
   * card never stores as a `baseUrl`: the Pi ChatGPT card's `openai-codex`
   * sign-in and the ChatGPT (Codex) card's declared `openai` provider. Without
   * them this surface printed the host-free sentence while the backend named
   * and withheld against chatgpt.com — D1.221's under-disclosure residue.
   */
  readonly piAuthProvider?: string
  readonly codexModelProvider?: string
}

/**
 * The disclosure owed for this endpoint+model pair, or `null` when none is.
 *
 * `null` for the verified Nessy Gateway, for a loopback adapter, for a model in
 * a namespace served inside the perimeter, and for the Nessy Cloud Agent, which
 * runs inside the perimeter and configures no endpoint of its own — the classes
 * `classifyModelTarget` marks unrestricted.
 *
 * **A connection with no endpoint is no longer one of them** (D1.246): it is the
 * vendor default, and the backend has failed closed on it since D1.221.
 */
export interface ModelTargetDisclosure {
  /**
   * The parsed hostname the schemas are sent to.
   *
   * EMPTY has two causes and one meaning for a surface: the connection names no
   * endpoint (the vendor default — there is no host to print), or the stored URL
   * did not parse. Both owe the disclosure and neither can name a host, so a
   * surface renders the host-free sentence
   * (`chat.modelPicker.toolEgressProviderDefault`) rather than interpolating an
   * empty string into the one that promises a name.
   */
  readonly host: string
  /**
   * `true` when the model id names a known external vendor namespace, `false`
   * when the target simply could not be placed. Both owe the same disclosure;
   * the flag exists so a surface can choose a shorter word for the known case
   * rather than invent a verdict the classifier did not reach.
   */
  readonly knownExternalVendor: boolean
}

export function modelTargetDisclosure(facts: ModelTargetFacts): ModelTargetDisclosure | null {
  const verdict = classifyModelTarget({
    // F1.572 — the endpoint through the BACKEND's own derivation
    // (`modelTargetBaseUrlForConnection`, which the factory reads for the
    // verdict that withholds), so the line shown and the servers withheld
    // cannot name two different hosts. A stored `baseUrl` still wins.
    baseUrl: modelTargetBaseUrlForConnection(facts),
    model: facts.model,
    // ALWAYS named, even when the caller does not know it. `classifyModelTarget`
    // keeps the pre-D1.221 silent verdict for `providerType === undefined`
    // alone, so forwarding an absent fact as absent would put this surface back
    // in the arm D1.246 exists to leave — and it would do it silently, for
    // exactly the connections the backend fails closed on. The empty string is
    // "a provider I cannot name", which is what that arm means; no provider is
    // spelled that way, so it can never collide with the one carve-out.
    providerType: facts.providerType ?? '',
  })
  if (!verdict.restricted) return null
  return { host: verdict.host, knownExternalVendor: verdict.class === 'external-vendor' }
}
