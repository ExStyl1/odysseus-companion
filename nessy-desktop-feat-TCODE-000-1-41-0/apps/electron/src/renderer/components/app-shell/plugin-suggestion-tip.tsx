/**
 * P6.424 — the plugin SPINNER TIP, the third of the page's three suggestion
 * surfaces and the last one this fork was missing.
 *
 * Contract, `plugin-relevance.md` § What the user sees, verbatim: "**Spinner
 * tip**: a "Working with *topic*? Install the *plugin* plugin" message with the
 * `/plugin install` command appears below the spinner while Claude is
 * responding."
 *
 * Two substitutions, both deliberate and both already made by this row's
 * siblings:
 *
 *  - **BELOW the spinner, never instead of it.** The cycling label is the
 *    session telling the user it is still working; replacing it would trade a
 *    live signal for an advertisement. So this renders as a second line under
 *    `ProcessingIndicator`'s own, indented to sit under the label rather than
 *    under the spinner glyph, so the eye reads one block.
 *  - **No `/plugin install` command line.** This fork registers no `/plugin`
 *    slash command — `git grep` over `packages/shared/src/slash-commands/`
 *    returns zero at HEAD — so printing one would name a command that does not
 *    exist. The sentence names the Plugins page instead, which is the same
 *    substitution `chat.pluginSuggestion.sessionStart` made for the
 *    session-start notice.
 *
 * ## Why this is its own file rather than a block inside `ChatDisplay`
 *
 * `ChatDisplay.tsx` is three thousand lines and every lane that has needed a
 * line of it has had to render the whole chat to see one. A separate component
 * is testable on its own and has a playground entry, which is the design
 * surface for it; `ProcessingIndicator` mounts it and passes nothing else.
 *
 * ## What fills it — and why it is empty on a default install
 *
 * `selectPluginSuggestion` (`shared/marketplace/plugin-suggestion.ts`) is the
 * ONE host-side decision behind all three surfaces, and `topic` and `reference`
 * are its own output fields, so the tip, the session-start notice and the
 * Discover pin can never name different plugins. That decision is reached
 * session-side, because the candidate feed is the marketplace catalog cache and
 * because the documented limits ("at most once every three sessions", "stops
 * appearing after the suggestion has been shown twice") are BETWEEN sessions and
 * live in a record only the session writes (`recordPluginSuggestionShown`).
 *
 * On the shipped default there is nothing to show at all: the allowlist key
 * `pluginSuggestionMarketplaces` is managed-settings-only, so a machine with no
 * managed policy has no suggestion-allowed marketplace and every one of the
 * three surfaces is silent. That is the page's own design, not a gap here.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'

export interface PluginSuggestionTipData {
  /** The phrase that fills "Working with *topic*?" — never the plugin's id. */
  topic: string
  /** `<name>@<marketplace>`, the id every suggestion surface prints. */
  reference: string
}

export function PluginSuggestionTip({ topic, reference }: PluginSuggestionTipData) {
  const { t } = useTranslation()
  return (
    <div
      data-testid="plugin-suggestion-spinner-tip"
      // UB14.15 — under v0.15.1's live line the label starts after the 16px spinner slot and the
      // 8px gap, so the tip indents 24px to stay "under the label"; label-sm in tertiary like the
      // line's elapsed time (was `pl-5 text-[12px] text-muted-foreground/70` on the 12px slot).
      className="pl-6 pt-0.5 text-label-sm text-tertiary"
    >
      {t('chat.pluginSuggestion.spinnerTip', { topic, reference })}
    </div>
  )
}
