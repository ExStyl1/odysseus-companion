/**
 * The ONE rule for "is this provider card offered" — read by
 * `ProviderSelectStep`, which is the only surface that offers a card (the
 * settings page's "add connection" opens the same step), and pinned by
 * `__tests__/provider-card-flags.test.ts` so the rule has an instrument that
 * reads it rather than a render.
 *
 * Every card follows its own build-time provider flag
 * (`packages/shared/src/feature-flags.ts` `resolveProviderFlags`), with two
 * derived cards:
 *
 * - `custom_runtime` — the merged personal-key form, offered iff ANY of its
 *   three arms shipped (the reason is on the filter's old inline comment in
 *   `ProviderSelectStep`).
 * - `chatgpt_codex` — F1.202 option (a), the codex runtime on the user's
 *   ChatGPT subscription. It has NO flag of its own: it rides
 *   `NESSY_FEATURE_PROVIDER_CHATGPT` (the `chatgpt` flag, default OFF — the
 *   owner's subscription-card posture, unchanged, and none of the five flag
 *   mirrors moves) AND needs the codex runtime in the build (`nessy_codex`), so
 *   a build without codex never offers a card whose sessions could not start.
 *   So the ChatGPT flag off means no ChatGPT card of EITHER runtime, anywhere.
 */
import type { ProviderFlagId } from '@nessy-agent/shared/feature-flags'

/** The cards `ProviderSelectStep` knows. Kept here so the rule and the union cannot drift. */
export type ProviderChoice =
  | 'nessy'
  | 'nessy_cloud'
  | 'nessy_codex'
  | 'nessy_claude'
  | 'claude'
  | 'chatgpt'
  | 'chatgpt_codex'
  | 'api_key'
  | 'local'
  | 'custom_runtime'

/** The flags the main process resolves (`nessy:getProviderFlags`), by their own ids. */
export type ProviderCardFlags = Record<ProviderFlagId, boolean>

/** Is `choice` offered under `flags`? */
export function isProviderCardOffered(choice: ProviderChoice, flags: ProviderCardFlags): boolean {
  switch (choice) {
    case 'custom_runtime':
      return flags.api_key || flags.nessy_codex || flags.nessy_claude
    case 'chatgpt_codex':
      return flags.chatgpt && flags.nessy_codex
    default:
      return flags[choice]
  }
}
