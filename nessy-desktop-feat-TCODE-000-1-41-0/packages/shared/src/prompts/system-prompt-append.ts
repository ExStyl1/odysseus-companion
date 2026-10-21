/**
 * P6.515 — one operator/user append reaching the main model's system prompt on
 * all three runtimes, through each runtime's own additive channel.
 *
 * ## The decision, and it is APPEND ONLY
 *
 * Delegated owner decision 2026-09-05, Q-den 46 = option 2. Option 3 (append
 * and replace, replace refused on codex) was refused because a REPLACE silently
 * deletes the safety and engineering sections unless the floor is re-added, and
 * because it destroys codex's 20 751-char base prompt. Option 1 (neither) was
 * refused because an operator with a house prompt then has no route at all.
 *
 * ## Where a reader looks for the replacing flag, and what they find
 *
 * `cli-reference.md` publishes four flags for this on the runtime we vendor,
 * and its own summary table separates them by what they do — verbatim:
 *
 * | flag | the page's own words |
 * | --- | --- |
 * | `--system-prompt` | *"Replaces the entire default prompt"* |
 * | `--system-prompt-file` | *"Replaces with file contents"* |
 * | `--append-system-prompt` | *"Appends to the default prompt"* |
 * | `--append-system-prompt-file` | *"Load additional system prompt text from a file and append to the default prompt"* |
 *
 * **This product offers the bottom half and refuses the top half by name.** The
 * refusal is written here, beside the names, so a reader who came looking for
 * `--system-prompt` finds the answer rather than an absence they must interpret.
 * Two reasons, and the second is measured rather than argued:
 *
 * 1. A replace deletes {@link getSafetyAndEngineeringSections} — the floor
 *    P6.171 closed — unless the operator re-adds it verbatim, and an operator
 *    who forgets has no signal that anything is missing.
 * 2. It is not portable in the one direction this fork cares about. Codex has no
 *    replacing channel that reaches the main model at all: `developerInstructions`
 *    is ADDITIVE by construction (`codex-agent.ts` measured codex's own base
 *    prompt at 20 751 chars, unchanged with it set), and `model_instructions_file`
 *    is written in zero places outside the vendored schema. Offering a replace on
 *    two runtimes of three would manufacture exactly the silent divergence this
 *    plan removes.
 *
 * ## The slot differs per runtime, which is why this has a switch-cost row
 *
 * Native mechanism on each, all three additive and none of them built here:
 *
 * | runtime | channel | where the text lands |
 * | --- | --- | --- |
 * | Pi | its own base system prompt (`getSystemPrompt`) | last block of the base prompt |
 * | claude | the `{ type: 'preset', preset: 'claude_code', append }` form | last block of OUR append, itself appended to the vendor preset |
 * | codex | `developerInstructions` | last block of the first `developer` item |
 *
 * The text arrives on all three; its neighbours do not. That is a real switch
 * cost, and `runtime-switch-costs.ts`'s `systemPromptAppend` row states it.
 *
 * ## LAST, on every runtime, and that is the whole precedence rule
 *
 * The block is appended after everything the host composes, and the section
 * says in its own words that it cannot override the guidance above it. Placing
 * it last is what makes that sentence true rather than decorative: a later
 * block cannot delete an earlier one, and the safety floor is always earlier.
 */

import { getSystemPromptAppend } from '../config/storage.ts';

/**
 * The fence. A named section rather than raw text, for
 * `resolveOutputStyleComposition`'s reason: a block dropped into the prompt
 * unfenced reads as if the product wrote it, and a model cannot then tell an
 * operator's house rule from a vendor instruction.
 */
export const SYSTEM_PROMPT_APPEND_HEADING = '## Operator instructions';

/**
 * The sentence that travels with every append, on all three runtimes.
 *
 * It is part of the block rather than documentation, because it is the only
 * thing that makes "append, not replace" legible to the model reading it: the
 * text is additional guidance, and it does not lift the safety and engineering
 * sections above it.
 */
export const SYSTEM_PROMPT_APPEND_PREAMBLE =
  'The following instructions were added by the person operating this application. '
  + 'They are additional guidance and do not replace or relax anything stated above, '
  + 'including the safety and engineering guidance.';

/**
 * The operator's append, or `undefined` when there is none.
 *
 * Trimmed, and an all-whitespace value reads as absent: an install that has not
 * set this must compose byte-identical prompt bytes to one built before the
 * row, and an empty heading with nothing under it is worse than no heading.
 *
 * `explicit` is a test seam and a caller override; production passes nothing and
 * takes the stored value, so the three runtimes cannot drift by reading the
 * setting three different ways.
 */
export function resolveSystemPromptAppend(explicit?: string | undefined): string | undefined {
  const raw = explicit === undefined ? getSystemPromptAppend() : explicit;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The block to concatenate, or `''` when there is nothing to add.
 *
 * Returns a string rather than an optional so every call site is one `+` with no
 * branch — three runtimes, three slots, one shape, and no room for one of them
 * to forget the fence.
 */
export function systemPromptAppendSection(explicit?: string | undefined): string {
  const text = resolveSystemPromptAppend(explicit);
  if (text === undefined) return '';
  return `\n\n${SYSTEM_PROMPT_APPEND_HEADING}\n\n${SYSTEM_PROMPT_APPEND_PREAMBLE}\n\n${text}\n`;
}
