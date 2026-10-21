/**
 * F1.242 — the host's wire credential, adapted to a shape Pi's credential
 * resolver accepts, BEFORE Pi stores it.
 *
 * pi-ai 0.84.4 `dist/auth/resolve.js` `resolveProviderAuthWithSignal` (read
 * 2026-09-23): a STORED credential owns its provider — ambient env ("env vars,
 * AWS profiles, ADC files") is consulted only when nothing is stored — and it
 * resolves a stored `oauth` only through `provider.auth.oauth`, a stored
 * `api_key` only through `provider.auth.apiKey`, and every other case is
 * `return undefined`. Two shapes `getPiAuth` (`packages/shared/src/agent/pi-agent.ts`)
 * sends trip over that:
 *
 * - ChatGPT Plus/Pro (`openai-codex`) declares only `auth.oauth`, but the host
 *   runs the OAuth exchange itself and ships the bearer access token as
 *   `api_key`. Stored verbatim it resolves to nothing. It is REWRAPPED as
 *   `oauth` with a far-future `expires`, which keeps pi-ai's own refresh path
 *   (`resolveStoredOAuth`, due when less than five minutes remain) unreachable:
 *   the host owns the refresh and re-sends a fresh token by `token_update`.
 * - Bedrock `iam` matches no handler (`amazon-bedrock` declares only
 *   `auth.apiKey`), and stored it SHADOWS the ambient AWS env the host injects
 *   at spawn (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, and
 *   `applyRotatedAwsEnv` on rotation) — `bedrockAuth.resolve`'s "AWS access
 *   keys" branch. So it is NOT stored at all, and resolution falls to that env.
 *
 * Everything else passes through as the same object. The OAuth-only set is
 * DERIVED from pi-ai's own `builtinProviders()` — `auth.oauth` present and
 * `auth.apiKey` absent — never a hand list, so a Pi lift (F1.255 takes Pi to
 * 0.85.x) that changes a provider's declared handlers moves the set with it;
 * `adapt-credential.test.ts` resolves through the production registry seam so
 * a changed resolver rule is a red test rather than a silent regression.
 * Measured on 0.84.4: the set is exactly `openai-codex`.
 *
 * Adapted from craft-agents-oss v0.13.4
 * `packages/pi-agent-server/src/adapt-credential.ts` (`adaptCredentialForPiSdk`),
 * Apache-2.0.
 */

import type { Credential as PiStoredCredential } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'

/**
 * The credential union the host sends in `init` and `token_update`. The same
 * shape as `index.ts`'s own `PiCredential`; the two are structurally identical
 * and every call site passes one to the other, so a member added to one and not
 * the other is a type error at that call rather than a silent drift.
 */
export type PiWireCredential =
  | { type: 'api_key'; key: string }
  | { type: 'oauth'; access: string; refresh: string; expires: number }
  | { type: 'iam'; accessKeyId: string; secretAccessKey: string; region?: string; sessionToken?: string }

let oauthOnlyProviderIdsCache: ReadonlySet<string> | undefined

/** Builtin provider ids whose catalogue entry declares `auth.oauth` and no `auth.apiKey`. */
function oauthOnlyProviderIds(): ReadonlySet<string> {
  oauthOnlyProviderIdsCache ??= new Set(
    builtinProviders()
      .filter(provider => provider.auth.oauth && !provider.auth.apiKey)
      .map(provider => provider.id),
  )
  return oauthOnlyProviderIdsCache
}

/**
 * The credential to store under `provider`, or `null` when nothing must be
 * stored and the provider resolves ambiently. See the module note.
 */
export function adaptCredentialForPiSdk(
  provider: string,
  credential: PiWireCredential,
): PiStoredCredential | null {
  if (credential.type === 'api_key' && oauthOnlyProviderIds().has(provider)) {
    return { type: 'oauth', access: credential.key, refresh: '', expires: Number.MAX_SAFE_INTEGER }
  }
  if (credential.type === 'iam') return null
  return credential
}
