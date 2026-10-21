import { WORKFLOW_TRIGGER_KEYWORD } from '@nessy-agent/shared/workflows/workflow-keyword'

/**
 * C3.351 — the composer's auto-capitalisation, and the words it must not touch.
 *
 * ## What was measured
 *
 * The composer rewrites the first character of a prompt to upper case whenever
 * the `autoCapitalisation` setting is on, which it is by default
 * (`apps/electron/resources/config-defaults.json`). C3.262's rig typed a prompt
 * beginning `ultrathink …` on the packaged 1.37.0 build and the composer held
 * `Ultrathink …` before the send — caught by the harness's own read-back as a
 * `composer-mismatch`, not by a person. The cause is this app's own feature and
 * not the platform's text substitution: the rewrite is one branch in
 * `FreeFormInput.handleRichInput`, and the two other text transforms at that
 * site (`applySmartTypography`, the inline menus) leave the first word alone.
 *
 * ## Why a keyword is different from a sentence
 *
 * A prompt is prose and capitalising its first letter is a courtesy. A KEYWORD
 * is a token some reader matches, and the reader is not always in this repo:
 * `ultrathink` has no reader here at all (C3.262 measured `git grep -a
 * ultrathink -- packages apps` = 0 files), so the only way it can ever take
 * effect is by reaching the runtime's own binary exactly as it was typed. A
 * transform that silently edits a token on its way to another program is the
 * shape this fork's largest defect class takes, and it costs one predicate to
 * remove the question.
 *
 * **The cost measured TODAY is zero and the fix is kept anyway, deliberately.**
 * On the default gateway card `resolveClaudeThinkingOptions` sends a disabled
 * thinking block, so there is no budget for the keyword to raise and its case
 * cannot matter (C3.262, three arms with controls). What was NOT driven is a
 * true Anthropic-model card, which takes the other branch of that resolver —
 * so the claim this module makes is the narrow one: the composer does not
 * decide the case of a word the product treats as a token. Whether a given
 * runtime matches that token case-sensitively is the runtime's business and is
 * not asserted here.
 *
 * ## The set, and why it is two words rather than a scheme
 *
 * {@link WORKFLOW_TRIGGER_KEYWORD} is imported rather than spelled, so a
 * rename moves both halves at once; `ultrathink` is Claude's own, documented at
 * `model-config.md#use-ultrathink-for-one-off-deep-reasoning` ("Include
 * `ultrathink` anywhere in your prompt to request deeper reasoning on that turn
 * without changing your session effort setting."). Nothing else in this product
 * is matched as a bare first word — slash commands, mentions and labels carry a
 * sigil and are already exempt below — so a broader rule (never capitalise a
 * lower-case identifier, say) would be a guess about prompts nobody has
 * measured. POSTURE, stated: the setting stays ON by default and keeps
 * capitalising ordinary prose; only the token set is exempt.
 */
export const COMPOSER_CASE_SENSITIVE_KEYWORDS: readonly string[] = Object.freeze([
  WORKFLOW_TRIGGER_KEYWORD,
  'ultrathink',
])

/**
 * The sigils that already opted a line out before this row existed: a slash
 * command, an `@` mention, a `#` label and a `!` shell line. Kept as data so the
 * component has no list of its own to drift from.
 */
export const COMPOSER_NO_CAPITALISE_PREFIXES: readonly string[] = Object.freeze(['/', '@', '#', '!'])

/**
 * True when the composer may upper-case the first character of `text`.
 *
 * Total on the empty string (`false` — there is nothing to capitalise) so the
 * caller needs no length branch of its own. The keyword test reads the FIRST
 * WORD only, because the transform this guards touches character 0 alone: a
 * keyword later in the prompt was never at risk and excluding it here would be
 * a claim this module cannot keep.
 */
export function shouldAutoCapitaliseFirstCharacter(text: string): boolean {
  if (text.length === 0) return false
  if (COMPOSER_NO_CAPITALISE_PREFIXES.includes(text.charAt(0))) return false
  return !firstWordIsCaseSensitiveKeyword(text)
}

/**
 * F1.460 (5) — the rewrite itself: `text` with its first character upper-cased
 * when {@link shouldAutoCapitaliseFirstCharacter} allows it, else `text`
 * unchanged. `FreeFormInput.handleRichInput` compares the result with its input
 * to decide whether it rewrote anything, so a character with no upper-case form
 * (a committed CJK first character — '你', 'こ', '안') comes back IDENTICAL and
 * the composer leaves the value alone. Pure, so that is testable without the
 * component; the `autoCapitalisation` setting stays the caller's.
 *
 * Same transform as before the extraction, character for character:
 * `charAt(0).toUpperCase()` plus the rest.
 */
export function autoCapitaliseFirstCharacter(text: string): string {
  if (!shouldAutoCapitaliseFirstCharacter(text)) return text
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * Whether the prompt OPENS with one of {@link COMPOSER_CASE_SENSITIVE_KEYWORDS}.
 *
 * The boundary is "not a letter, digit or underscore", the same shape
 * `detectWorkflowKeywordTrigger` uses for its own match, so `ultracodex` is an
 * ordinary word and `ultracode:` is the keyword. Compared case-INSENSITIVELY on
 * purpose: a user who typed `Ultrathink` meant the keyword, and re-capitalising
 * it would be this transform firing on the very word it is here to leave alone.
 */
function firstWordIsCaseSensitiveKeyword(text: string): boolean {
  const firstWord = /^[\p{L}\p{N}_]+/u.exec(text)?.[0]
  if (firstWord === undefined) return false
  const folded = firstWord.toLowerCase()
  return COMPOSER_CASE_SENSITIVE_KEYWORDS.some(keyword => keyword.toLowerCase() === folded)
}
