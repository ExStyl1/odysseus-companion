/**
 * C3.230 — the verbs the Shortcuts page needs to be searchable, kept pure.
 * (Two when this module was written; C3.317 added a third for the entry shape
 * the registry table has no row for. The count is not written down again — the
 * exports are the list.)
 *
 * Owner answer QO2=A. Thirty actions are declared in `actions/definitions.ts`
 * and the page rendered every one of them in category order with no way to ask
 * a question of the list. The two questions a user actually has are opposite
 * directions of the same table:
 *
 * 1. "where is the shortcut for X" — a filter over the LOCALIZED label, because
 *    the label is what the user reads; the raw `definitions.ts` label is
 *    English and `ACTION_LABEL_KEYS` is what the row shows;
 * 2. "what does this chord I keep hitting do" — a reverse lookup, which this
 *    module does NOT re-implement: `findHotkeyCollisions` already answers "which
 *    other actions answer to this hotkey", and passing an id that belongs to no
 *    action turns its "other" into "every".
 *
 * React-free and DOM-free on purpose, the same discipline `hotkey-overrides.ts`
 * keeps: the page holds the state and the `t`, this module holds the answers,
 * and `__tests__/shortcuts-search.test.ts` can drive both verbs without a
 * renderer.
 */

import { findHotkeyCollisions } from '@/actions/hotkey-overrides'

/**
 * An id no action declares, handed to `findHotkeyCollisions` as the "self" it
 * must exclude — so nothing is excluded and every owner comes back.
 *
 * It carries a `#` because no id in `definitions.ts` does, and the unit test
 * asserts it is absent from the real roster rather than trusting that sentence:
 * a sentinel that collided with a real id would silently drop exactly that
 * action from every answer, which is the one failure this trick can have.
 */
export const NO_ACTION_SENTINEL = '#no-action'

/** One row of the page's table as the filter sees it. */
export interface ShortcutSearchEntry {
  id: string
  /** The label as rendered — already translated by the caller. */
  label: string
}

/**
 * C3.317 — one component-specific section as the filter sees it.
 *
 * The SECOND entry shape, and the reason it is a shape of its own rather than a
 * row of {@link ShortcutSearchEntry}: these rows have no action id, no hotkey
 * the registry knows and nothing to rebind. They are label-only.
 *
 * Generic in the row so the page keeps its own `keys` chips: this module decides
 * what matches, the page decides what a match looks like.
 */
export interface ShortcutSectionLike<R> {
  /** The section heading, already translated. */
  title: string
  shortcuts: readonly R[]
}

/**
 * Fold a query or a label to the form the filter compares.
 *
 * Case-folded and accent-stripped, because a user typing `тема` or `focus`
 * should not have to reproduce the capitalisation the label happens to use, and
 * a Russian label carrying `ё` should answer to `е`. `NFD` + combining-mark
 * strip is the standard form of that; it leaves Cyrillic and Latin alike.
 */
function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}+/gu, '').toLocaleLowerCase()
}

/** The folded terms of a query; empty means "no question asked". */
function terms(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean)
}

/** Every term present in `text`, which is what "matches" means for both verbs. */
function matchesEveryTerm(text: string, queryTerms: readonly string[]): boolean {
  const folded = fold(text)
  return queryTerms.every(term => folded.includes(term))
}

/**
 * The ids whose label matches `query`, in the order given.
 *
 * An empty or whitespace-only query matches EVERYTHING rather than nothing —
 * the page's default state is the full table, and a filter that empties the
 * page when cleared would read as a broken page.
 *
 * Every whitespace-separated term must match, so `new chat` finds "New Chat in
 * Panel" and `chat new` finds it too; a single term is the ordinary case.
 */
export function filterShortcutEntries(
  entries: readonly ShortcutSearchEntry[],
  query: string,
): string[] {
  const queryTerms = terms(query)
  if (queryTerms.length === 0) return entries.map(entry => entry.id)
  return entries
    .filter(entry => matchesEveryTerm(entry.label, queryTerms))
    .map(entry => entry.id)
}

/**
 * C3.317 — the component-specific sections, searched rather than hidden.
 *
 * **The posture, taken rather than queued** (the row is `[product]`; owner rule
 * "transparent and simple"). C3.230 gave the registry table a filter and hid
 * these three sections whenever a query was active, on the stated ground that a
 * section ignoring the query would read as a filter that had failed. Hiding is
 * the other failure: *"Enter sends the message"* is a real answer to *"enter"*,
 * and the page that knows it was the page that went blank.
 *
 * **What a row is compared against, and why it is not the description alone.**
 * `"${title} ${description}"`. These descriptions are three words long and the
 * SECTION is the only place that says where they apply — nothing in *"Navigate
 * items"* contains *"session list"*, which is exactly what a user types. The
 * registry table deliberately keeps matching its label alone: its rows carry
 * their own category in the label often enough, and widening that verb would
 * change an answer C3.230's tests pin.
 *
 * **Two residues, stated here and on the page.** These rows cannot be rebound
 * (they are not registry actions), and {@link actionsOwningHotkey} does not see
 * them — a user who records `Enter` in the by-keystroke box is told nothing is
 * bound to it while the chat input's `Enter` sends the message. Closing the
 * second would mean converting display chips (`↑`, `Home`, `Right-click`,
 * `⌥`+`Click`) into hotkey strings, and two of those four are not keystrokes at
 * all, so the honest move is to say so rather than to half-map them.
 *
 * An empty query returns every section unchanged, for {@link
 * filterShortcutEntries}'s reason: the page's default state is the full table.
 * A section left with no matching row is dropped whole rather than rendered
 * empty, which is what the registry categories already do.
 */
export function filterShortcutSections<R extends { description: string }>(
  sections: readonly ShortcutSectionLike<R>[],
  query: string,
): { title: string; shortcuts: R[] }[] {
  const queryTerms = terms(query)
  return sections
    .map(section => ({
      title: section.title,
      shortcuts: queryTerms.length === 0
        ? [...section.shortcuts]
        : section.shortcuts.filter(
          row => matchesEveryTerm(`${section.title} ${row.description}`, queryTerms),
        ),
    }))
    .filter(section => section.shortcuts.length > 0)
}

/**
 * Every action bound to `hotkey`, or `[]` when nothing is.
 *
 * `[]` is the honest answer for an unbound chord and must not be confused with
 * "not asked": the page renders a different sentence for each, because "nothing
 * runs on ⌘J" is the answer a user who pressed ⌘J and saw nothing needs.
 */
export function actionsOwningHotkey(
  hotkey: string | null,
  allActionIds: readonly string[],
  resolveHotkey: (actionId: string) => string | null,
): string[] {
  return findHotkeyCollisions(NO_ACTION_SENTINEL, hotkey, allActionIds, resolveHotkey)
}
