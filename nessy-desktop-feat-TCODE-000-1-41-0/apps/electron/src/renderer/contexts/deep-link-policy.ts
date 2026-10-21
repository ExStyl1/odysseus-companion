/**
 * Deep Link Policy
 *
 * What a deep link is allowed to do, decided from its origin alone.
 *
 * A link Nessy did not produce is inert: it may choose a directory and fill the
 * prompt box, and nothing reaches the model until the user reads the prefill and
 * presses Enter. Since P6.512 it may also fill the plugin INSTALL dialog, on the
 * same terms — the dialog opens with a plugin and a marketplace named, and
 * nothing is installed until the user presses the button. Everything else in the
 * `action/...` vocabulary — deleting a session or a source, renaming, flagging,
 * starting a sign-in flow, flipping a permission mode — is refused, and the
 * link's mode/model/systemPrompt are ignored so a single click cannot escalate a
 * session's privileges.
 *
 * Kept pure (no React, no window access) so the inertness contract is unit
 * testable; `handleActionNavigation` in NavigationContext is the only caller.
 */

export type DeepLinkOrigin = 'external' | 'internal'

/**
 * Actions a link from outside the app may NOT trigger. Each mutates state on
 * its own. `new-session` and `copy` stay reachable — `new-session` is clamped
 * by the rest of this policy instead.
 */
const EXTERNAL_BLOCKED_ACTIONS = new Set<string>([
  'rename-session',
  'delete-session',
  'flag-session',
  'unflag-session',
  'oauth',
  'delete-source',
  'set-mode',
])

/**
 * P6.512 — the install deep link, and why this set does NOT grow for it.
 *
 * A marketplace publishes an install link and every runtime we ship ignores it:
 * codex answers `codex://plugins/install/<id>?marketplace=<m>` with a one-click
 * install, and a user of this fork hand-copies the plugin id instead. Owner
 * decision Q-den 43 took option 2 — accept the link, but only to PRE-FILL the
 * install dialog. Option 3 (a mutating verb for allowlisted marketplaces) was
 * refused because it would let an external origin install software and turn the
 * allowlist into a security boundary it was never designed to be.
 *
 * So this action mutates nothing BY CONSTRUCTION: it navigates and fills a
 * dialog, and the install runs when the human presses the button, exactly as if
 * they had found the plugin by browsing. That is why it is absent from the set
 * above rather than present-and-allowed — there is no verb here to block, and a
 * reader checking whether this fork can be made to install software from a link
 * should find the answer in the shape of the action, not in a list membership.
 *
 * **The stated divergence from codex, since native-first asks for it:** codex's
 * affordance is one click and ours is two. We do not match it, deliberately.
 * Codex's scheme carries the same information; what differs is that our final
 * step is a person.
 */
export const INSTALL_PLUGIN_ACTION = 'install-plugin'

/**
 * Bound on a name an install link may carry. Long enough for every plugin and
 * marketplace name this fork accepts (`MANAGED_MARKETPLACE_NAME` caps at 128),
 * short enough that a link cannot push a wall of text into a dialog.
 */
export const INSTALL_PLUGIN_LINK_MAX_NAME_CHARS = 128

/**
 * The name shape an install link may carry, mirroring `DOCUMENTED_SEGMENT` in
 * `packages/shared/src/plugins/managed-plugin-key.ts` — the rule that already
 * governs the vendor's documented `plugin-name@marketplace-name` spelling: no
 * whitespace, no `@`, no path separator, no control character.
 *
 * Spelled here rather than imported because `plugins/managed-plugin-key` is not
 * an exported subpath of `@nessy-agent/shared` and this module is deliberately
 * dependency-free (that is what makes the inertness contract unit-testable).
 * The two are pinned to each other by a test that reads the shared file's own
 * source, so the copy cannot drift silently.
 */
const INSTALL_LINK_NAME = /^[^\s@/\\\x00-\x1f\x7f]+$/

export interface InstallPluginLinkTarget {
  /** The plugin to show. UNTRUSTED text until the dialog resolves it. */
  pluginName: string
  /** The marketplace it was named in, when the link named one and it is registered. */
  marketplaceName?: string
}

export type InstallPluginLinkRefusal =
  /** The link named no plugin at all. */
  | 'missing-plugin'
  /** A name carrying whitespace, `@`, a path separator, a control character, or over the cap. */
  | 'unsafe-name'
  /** The link named a marketplace in both spellings at once, and they cannot both be right. */
  | 'ambiguous-marketplace'
  /** The link named a marketplace this machine has not registered. */
  | 'unknown-marketplace'

export type InstallPluginLinkVerdict =
  | { ok: true; target: InstallPluginLinkTarget }
  | { ok: false; reason: InstallPluginLinkRefusal }

/**
 * What an `install-plugin` link may pre-fill, decided from the link's own text
 * and the marketplaces this machine has ALREADY registered.
 *
 * Two spellings are accepted and they must not be mixed:
 *  - our own action format, `nessy://action/install-plugin/{plugin}?marketplace={name}`;
 *  - the vendor's documented `plugin-name@marketplace-name`, in the id, because
 *    that is the string a user reads on a marketplace page and pastes.
 *
 * **The marketplace name is checked against the REGISTERED set and never
 * against a pattern**, which is the half that makes a hostile parameter
 * harmless: a link naming a marketplace this machine does not have is refused
 * outright, and no marketplace is ever added, allowlisted or fetched on a link's
 * say-so. A link that names none is accepted — the dialog then searches the
 * marketplaces the user already has, which is what a bare plugin name means
 * everywhere else in this fork.
 */
export function resolveInstallPluginLink(
  params: Record<string, string>,
  id: string | undefined,
  registeredMarketplaceNames: readonly string[],
): InstallPluginLinkVerdict {
  const raw = (id ?? params.plugin ?? '').trim()
  if (!raw) return { ok: false, reason: 'missing-plugin' }
  if (raw.length > INSTALL_PLUGIN_LINK_MAX_NAME_CHARS) return { ok: false, reason: 'unsafe-name' }

  const at = raw.indexOf('@')
  const suffixed = at > 0 && at === raw.lastIndexOf('@')
  const pluginName = suffixed ? raw.slice(0, at) : raw
  const suffixMarketplace = suffixed ? raw.slice(at + 1) : undefined
  // A bare `@` anywhere else (leading, doubled) is not the documented spelling
  // and is not a plugin name either.
  if (!suffixed && raw.includes('@')) return { ok: false, reason: 'unsafe-name' }
  if (!INSTALL_LINK_NAME.test(pluginName)) return { ok: false, reason: 'unsafe-name' }

  const paramMarketplace = params.marketplace?.trim() || undefined
  if (suffixMarketplace && paramMarketplace && suffixMarketplace !== paramMarketplace) {
    return { ok: false, reason: 'ambiguous-marketplace' }
  }
  const marketplaceName = suffixMarketplace ?? paramMarketplace
  if (marketplaceName === undefined) return { ok: true, target: { pluginName } }

  if (marketplaceName.length > INSTALL_PLUGIN_LINK_MAX_NAME_CHARS
    || !INSTALL_LINK_NAME.test(marketplaceName)) {
    return { ok: false, reason: 'unsafe-name' }
  }
  if (!registeredMarketplaceNames.includes(marketplaceName)) {
    return { ok: false, reason: 'unknown-marketplace' }
  }
  return { ok: true, target: { pluginName, marketplaceName } }
}

/** Documented cap on a prompt an external link may prefill. */
export const EXTERNAL_INPUT_MAX_CHARS = 5000

/**
 * Length past which the disclosure line also reports the prefill's size.
 *
 * deep-links.md: "For prompts over 1,000 characters, the warning includes the
 * character count and tells you to scroll and review the full text before
 * pressing Enter, since long prompts can push instructions off screen."
 */
export const EXTERNAL_INPUT_REVIEW_CHARS = 1000

export interface DeepLinkActionPolicy {
  /** Refuse the action outright (caller shows the invalid-link toast). */
  blocked: boolean
  /**
   * Whether the link's own parameters may be honoured: `send`, `mode`, `model`
   * and `systemPrompt`. False for anything delivered from outside the app.
   */
  trusted: boolean
  /** The prompt to seed, clamped for an external link. */
  input?: string
  /** Whether that prompt goes straight to the model. */
  send: boolean
}

/**
 * Resolve what an `action/...` deep link may do.
 *
 * `origin` is undefined for every in-app navigation, which is why absent means
 * internal here. The wire is the opposite: the deep-link listener reads a
 * missing `DeepLinkNavigation.origin` as 'external' before calling navigate.
 */
export function resolveDeepLinkAction(
  action: string,
  params: Record<string, string>,
  origin?: DeepLinkOrigin,
): DeepLinkActionPolicy {
  const trusted = origin !== 'external'

  if (!trusted && EXTERNAL_BLOCKED_ACTIONS.has(action)) {
    return { blocked: true, trusted: false, send: false }
  }

  const raw = params.input
  const input = raw === undefined
    ? undefined
    : trusted ? raw : raw.slice(0, EXTERNAL_INPUT_MAX_CHARS)

  return {
    blocked: false,
    trusted,
    input,
    send: trusted && params.send === 'true',
  }
}

/** The disclosure line the composer draws under the input box. */
export interface ExternalPromptNotice {
  /** i18n key for the line. */
  key: 'chat.externalLinkPrompt' | 'chat.externalLinkPromptLong'
  /** Prefill length; interpolated into the long variant only. */
  count?: number
}

/**
 * Pick the disclosure line for a composer whose draft an external link filled.
 *
 * deep-links.md: "When the session opens, a warning line below the input box
 * reads `Prompt from an external link` and stays visible until you send or
 * clear the prompt."
 *
 * Empty text is the "cleared" half of that sentence — and also the "sent" half,
 * because sending empties the composer.
 */
export function resolveExternalPromptNotice(
  input: string,
  fromExternalLink: boolean,
): ExternalPromptNotice | null {
  if (!fromExternalLink || input.length === 0) return null

  return input.length > EXTERNAL_INPUT_REVIEW_CHARS
    ? { key: 'chat.externalLinkPromptLong', count: input.length }
    : { key: 'chat.externalLinkPrompt' }
}
