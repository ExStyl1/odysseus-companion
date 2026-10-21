/**
 * The catalogue MOVED to `@config/nessy-gateway-models` (P6.669) and is
 * re-exported here, so every renderer import of these names is unchanged.
 *
 * Why it moved: `packages/server-core` has no path to `apps/electron`, so every
 * backend test that stood for this card restated the catalogue by hand. P3.179
 * measured the result — 32 of 34 such test files never write a tri-state field
 * the card declares, and `supportsThinking`'s documented default is the OPPOSITE
 * of what both shipped rows declare, so an omission flips the value rather than
 * clearing it. The fixture builder both sides now share
 * (`@nessy-agent/shared/config/__tests__/fixtures/gateway-connection-fixture.ts`)
 * derives from the catalogue, which it can only do from `packages/shared`.
 *
 * Nothing in this module declares the gateway's identity any more. The URL is
 * the shared derivation (DA1.28) and the two predicates are the backend's own
 * (DA1.31); what stays here is the renderer-facing NAMES those call sites use
 * and the connection-setup defaults the one-click cards submit.
 */
import type { ModelDefinition } from '@config/models'
import { NESTOR_GATEWAY_CHAT_BASE_URL } from '@nessy-agent/shared/auth/nestor'
// DA1.31 — the DEEP path, never the `agent/backend` barrel: that barrel also
// re-exports `createAgent` / `ClaudeAgent` / `PiAgent`, which are node-only
// subprocess and fs code no renderer module may pull in. This specifier is an
// exports-map wildcard key (`./agent/backend/*`), and the module's whole
// transitive closure is TWO pure files — itself and
// `@nessy-agent/codex-responses-adapter/nestor-client`, which has no imports at
// all and guards its only `process` read with `typeof process === 'undefined'`.
// `packages/shared` declares that adapter as a workspace dependency, so the
// chain electron -> shared -> adapter is declared rather than hoisted into
// existence.
import {
  isGatewayBackedConnection,
  isNessyGatewayBaseUrl,
} from '@nessy-agent/shared/agent/backend/internal/drivers/upstream-target'
// IMPORTED and then re-exported, not `export … from`: a bare re-export forwards
// the names without binding them in this module's scope, and the functions below
// read `NESSY_GATEWAY_DEFAULT_MODEL` and `NESSY_GATEWAY_MODELS` directly.
// Measured — the re-export-only form threw `ReferenceError:
// NESSY_GATEWAY_DEFAULT_MODEL is not defined` from `codexGatewayConnectionDefaults`.
import {
  NESSY_GATEWAY_CONTEXT_WINDOW,
  NESSY_GATEWAY_DECLARED_TRI_STATES,
  NESSY_GATEWAY_DEFAULT_MODEL,
  NESSY_GATEWAY_MODEL_IDS,
  NESSY_GATEWAY_MODELS,
} from '@config/nessy-gateway-models'

export {
  NESSY_GATEWAY_CONTEXT_WINDOW,
  NESSY_GATEWAY_DECLARED_TRI_STATES,
  NESSY_GATEWAY_DEFAULT_MODEL,
  NESSY_GATEWAY_MODEL_IDS,
  NESSY_GATEWAY_MODELS,
}

export const NESSY_GATEWAY_PRESET_KEY = 'nessy-gateway'

/**
 * The one-click cards' connection `baseUrl`, DERIVED rather than typed (DA1.28).
 *
 * It was the FOURTH hand-written copy of one URL. Three other modules derive
 * it: `packages/shared/src/auth/nestor.ts` symbol `NESTOR_GATEWAY_CHAT_BASE_URL`
 * from `NESTOR_CLI_BASE_PREFIX`, `packages/shared/src/agent/backend/internal/drivers/upstream-target.ts`
 * symbol `NESSY_GATEWAY_CHAT_BASE_URL` from the adapter's `NESTOR_CHAT_URL`,
 * and those two are pinned equal by
 * `packages/shared/src/auth/__tests__/nestor.test.ts`.
 * This one agreed with them by coincidence, and the docblock below used to say
 * a shared literal kept them in sync, which was false (DA1.11). Importing the
 * derivation is what makes the sentence true rather than hopeful.
 *
 * **This is not a widening** — DA1.11's constraint. Measured 2026-09-14 before
 * and after: all three spellings resolve to the identical 67-character string,
 * and every production reading downstream of this constant (both gateway
 * connection defaults, all three `buildGatewaySetup` arms, the two predicates
 * here and the driver's own) is byte-identical across the change. What moves is
 * only where the characters come from.
 *
 * **The door.** `@nessy-agent/shared/auth/nestor` is an exports-map key that
 * already exists, the module is dependency-free (its only import is its own
 * generated snapshot), and it is ALREADY in this bundle: `@config/nessy-gateway-models`
 * reaches it through `packages/shared/src/config/nestor-gateway-windows.ts`,
 * which re-exports from it and whose own docblock calls it "safe to pull into a
 * browser bundle".
 */
export const NESSY_GATEWAY_BASE_URL = NESTOR_GATEWAY_CHAT_BASE_URL

/**
 * Whether a connection is the built-in corporate Nessy Gateway one (created by
 * the one-click Pi/Codex/Claude cards). Used to hide credential-revealing UI —
 * the Edit form would show the stored Nestor JWT and gateway URL — and to
 * decide what the settings row may offer.
 *
 * **DA1.31 — this is no longer a twin. It IS the backend's predicate**,
 * `isGatewayBackedConnection`, imported and re-bound under the name every
 * renderer call site already uses. The rule it carries (providerType in the
 * three one-click types AND a WHOLE-URL match, never a host or prefix match) is
 * now stated once, in the module that also decides whether a session carries
 * `Nestor-Token`; the two can no longer disagree about a URL.
 *
 * **This docblock has been wrong in BOTH directions, which is why the dates are
 * here.** It once claimed the two predicates were "kept in sync by the shared
 * NESSY_GATEWAY_BASE_URL literal"; DA1.11 measured that on 2026-09-13 and found
 * no shared literal at all — the name was declared once, here, hand-written,
 * agreeing with the backend by coincidence. DA1.28 made the string shared and
 * DA1.13/DA1.31 made the rule shared, so the original sentence is finally true
 * — of a different mechanism than the one it was written about.
 *
 * **The STRICT/WIDE question DA1.31 raises does not reach this site.** The
 * export is deliberately stricter than `SessionManager`'s private `gatewayBacked`
 * (a blank base URL is not the gateway), and the renderer twin this replaces was
 * already strict in exactly that way — `normalized.length > 0 && normalized === …`
 * — so no call site here needs the wide arm and no behaviour changes. A BYO
 * endpoint on one of these provider types is still NOT a match: the user typed
 * that URL and key, so the Edit form reveals nothing they do not already know.
 *
 * **Imported and re-bound, not `export … from`.** Same reason the catalogue
 * names above are: `canEditLlmConnection` below calls this function, and a bare
 * re-export forwards a name without binding it in this module's scope.
 */
export const isNessyGatewayConnection = isGatewayBackedConnection

/**
 * {@link isNessyGatewayConnection}'s URL half, for the BYO endpoint form — also
 * the backend's own, re-exported under the renderer's name (DA1.31).
 */
export { isNessyGatewayBaseUrl }

export function canEditLlmConnection(connection: {
  providerType?: string
  baseUrl?: string
}): boolean {
  if (connection.providerType === 'nestor-cloud-agent') {
    return false
  }
  return !isNessyGatewayConnection(connection)
}

/**
 * Connection-setup defaults for a Codex (`providerType: 'codex-runtime'`)
 * connection. Reuses the Nessy Gateway preset verbatim — the Codex runtime
 * targets the same gateway (the local Responses adapter injects `Nestor-Token`).
 * The connection-setup UI (settings + onboarding) builds a codex connection
 * from these values; kept here so the URL/model literals are never duplicated.
 */
export function codexGatewayConnectionDefaults(): {
  providerType: 'codex-runtime'
  authType: 'api_key_with_endpoint'
  baseUrl: string
  defaultModel: string
  models: ModelDefinition[]
} {
  return {
    providerType: 'codex-runtime',
    authType: 'api_key_with_endpoint',
    baseUrl: NESSY_GATEWAY_BASE_URL,
    defaultModel: NESSY_GATEWAY_DEFAULT_MODEL,
    models: NESSY_GATEWAY_MODELS,
  }
}

/**
 * Connection-setup defaults for a Claude Code (`providerType: 'claude-runtime'`)
 * connection. Same gateway, same catalog, different runtime: the Claude Agent
 * SDK talks Anthropic Messages to a per-session loopback adapter that re-shapes
 * the turn for the gateway (T6).
 *
 * **The catalog ORDER is load-bearing.** `ClaudeAgent` seeds
 * `ANTHROPIC_DEFAULT_HAIKU_MODEL` — the model built-in SDK tools (WebFetch
 * summarization, title generation) run on — from `getMiniModel(connection)`.
 * `LlmConnection` has no `miniModel` field, so ordering is the only lever, and
 * for this provider type `findSmallModel` has nothing to match on
 * (`isAnthropicProvider` is false for `claude-runtime`, and no gateway id
 * contains 'mini'/'haiku'/'flash') — it takes the LAST entry.
 * `NESSY_GATEWAY_MODELS` therefore lists the coder model first and the fast
 * model last, and `claude-connection-setup.test.ts` pins it.
 */
export function claudeGatewayConnectionDefaults(): {
  providerType: 'claude-runtime'
  authType: 'api_key_with_endpoint'
  baseUrl: string
  defaultModel: string
  models: ModelDefinition[]
} {
  return {
    providerType: 'claude-runtime',
    authType: 'api_key_with_endpoint',
    baseUrl: NESSY_GATEWAY_BASE_URL,
    defaultModel: NESSY_GATEWAY_DEFAULT_MODEL,
    models: NESSY_GATEWAY_MODELS,
  }
}
