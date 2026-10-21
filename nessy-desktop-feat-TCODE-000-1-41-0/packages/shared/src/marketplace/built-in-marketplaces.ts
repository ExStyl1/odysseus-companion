/**
 * Marketplaces this product KNOWS ABOUT and does not enable.
 *
 * P6.518 (Q-den 51 = B) and P6.517 (Q-den 49 = B) both asked the same question
 * about a different catalog — deliver it, or leave it invisible — and the owner
 * gave both the same answer: PRESENT BUT DISABLED, one click to enable. Option A
 * (default on) was refused for each because a default-on connection from a
 * T-Bank-internal fork to a vendor-hosted catalog makes the reserved-name
 * protections load-bearing before anyone has asked for the catalog; option C
 * (decline) was refused because the documented default then reaches nobody.
 *
 * So this file is a CATALOG OF OFFERS, not of registrations. Nothing here is
 * fetched, cloned or read until a user enables an entry, and enabling it goes
 * through `PluginRegistrySource.add` unchanged — the same managed allowlist,
 * blocklist and reserved-name gates any hand-typed source meets.
 *
 * WHY A PINNED SOURCE AND NOT A PARAMETER. `enableBuiltInMarketplace` takes a
 * NAME from this list and reads the source here; it never accepts a source from
 * its caller. A "one click to enable" affordance whose source travels with the
 * click is an affordance an untrusted surface can aim, which is the same
 * property `deep-link-policy.ts` protects on the other side of the app.
 *
 * Native mechanism, asked: the vendored runtime auto-registers the official
 * marketplace, but it acts on ITS OWN `known_marketplaces.json` inside the child,
 * not on our registry — so there is nothing of ours to enable or configure, and
 * nothing of theirs being suppressed. The host already owns the delivery
 * mechanism (`ensureDeliveredMarketplaces` for the managed tier); this is the
 * same shape one tier down, for the tier nobody administers.
 */

/** One offer: a catalog the product can add, and has not. */
export interface BuiltInMarketplaceEntry {
  /**
   * The stable id of the offer, and the display name the row is registered
   * under. For the official Anthropic marketplace this is the name the pages
   * publish, which is also a RESERVED name — `add()` exempts it because the
   * source below is the one official source this fork can recognise.
   */
  readonly name: string;
  /** The pinned source. Never supplied by a caller. */
  readonly source: string;
  /** One line, in English: these are product names, which i18n keeps in English. */
  readonly description: string;
  /** The page this entry is transcribed from, for whoever audits the list. */
  readonly documentation: string;
}

/**
 * The entries, each transcribed from its own page.
 *
 * `learn.chatgpt.com/docs/open-source.md`, fetched 2026-09-06, the Skills row of
 * its component table: "Skills | openai/skills | Reusable skills that extend
 * ChatGPT and Codex". Read from the `.md` and not from the rendered page, which
 * is the right route for THAT host: its pages are client-rendered, so the
 * `curl`-and-grep-for-heading-ids rule that is correct for `code.claude.com` is
 * wrong here.
 *
 * The name is `openai-skills` and NOT `openai/skills`: a registry row's name is
 * its display name and its reserved-name subject, and a slash in it would read
 * as a path. The source keeps the slug.
 *
 * `plugins/anthropic-marketplaces.md#find-plugins-in-the-official-marketplace`, fetched 2026-09-06:
 * "Claude Code adds the official Anthropic marketplace (`claude-plugins-official`)
 * automatically the first time you start it interactively." We deliberately do
 * NOT do that — see the file header — so the same catalog is offered instead,
 * from the source that page names for a manual add:
 * "add it yourself with `/plugin marketplace add anthropics/claude-plugins-official`".
 */
export const BUILT_IN_MARKETPLACES: readonly BuiltInMarketplaceEntry[] = Object.freeze([
  Object.freeze({
    name: 'claude-plugins-official',
    source: 'anthropics/claude-plugins-official',
    description: 'The official Anthropic plugin marketplace.',
    documentation: 'plugins/anthropic-marketplaces.md#find-plugins-in-the-official-marketplace',
  }),
  Object.freeze({
    name: 'openai-skills',
    source: 'openai/skills',
    description: 'Reusable skills that extend ChatGPT and Codex.',
    documentation: 'learn.chatgpt.com/docs/open-source.md',
  }),
]);

/** The offer with this name, or undefined. */
export function builtInMarketplaceEntry(name: string): BuiltInMarketplaceEntry | undefined {
  return BUILT_IN_MARKETPLACES.find(entry => entry.name === name);
}
