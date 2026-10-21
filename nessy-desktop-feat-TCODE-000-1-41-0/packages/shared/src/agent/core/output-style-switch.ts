/**
 * UB12.21 — an output-style switch in the middle of a conversation whose system
 * prompt is RECORDED reaches the model as a message.
 *
 * ## The gap this closes
 *
 * Claude records its system prompt once per SDK session (UB2.13 pins
 * `snapshot: true`; UB5.1 measured recording active on 0.3.280 / 2.1.280). The
 * vendored `sdk.d.ts` (`Options.systemPrompt`, the `snapshot` paragraph): "a
 * different `append` or `prompt` passed on a later launch of the same session
 * is ignored until compaction or a new session". Our output-style prose rides
 * that append, so a style picked mid-session never reached the model: the
 * recorded prompt kept the session-start style (or none), and the per-turn
 * reminder named the new label while pointing at the old prose.
 *
 * ## What Claude Code does, and what we copy
 *
 * `prompt-caching.md#changing-output-style`: "When you switch output styles
 * mid-session … Claude uses the new style starting with your next message.
 * Claude Code delivers the new style's instructions as a message in the
 * conversation, so that request still reads the system prompt and the earlier
 * conversation from the cache." So on the first turn that continues a recorded
 * prompt under a different style, the host puts the new style's instructions on
 * that turn's message, once. The text is the same block the system prompt would
 * have carried for a fresh session, so a switch and a new session give the model
 * the same words.
 *
 * ## Why the host and not Claude Code's own `outputStyle` setting
 *
 * Native-first was asked first. The runtime has the mechanism (`outputStyle`,
 * live through `applyFlagSettings`; `output-styles.md#change-your-output-style`
 * says the switch works in Agent SDK sessions). It cannot carry OUR styles:
 * - It resolves names in Claude Code's own catalog: four built-ins, plus
 *   `~/.claude/output-styles`, a project's `.claude/output-styles`, the managed
 *   directory and plugins. Ours adds `reviewer`, and our custom styles live in
 *   `<CONFIG_DIR>/output-styles` and `<project>/.nessy-agent/output-styles`, which
 *   the CLI never reads.
 * - Even the four built-ins with matching names have different prose. Explanatory
 *   is the clearest case: Claude Code's version adds `★ Insight` blocks, and ours
 *   explains tradeoffs. Mapping them would give a Claude session different style
 *   text from a Pi or codex session with the same selection. That is a silent
 *   per-runtime divergence, not a parity fix.
 * So the host stays the seam: one catalog for three runtimes, plus this notice
 * where one runtime freezes the prompt.
 *
 * ## Codex freezes it too (UB12.63)
 *
 * Codex's style prose rides `developerInstructions`, which a thread takes when
 * it opens; `turn/start` has no field that replaces them (`rust-v0.162.0`). So
 * `CodexAgent.chatImpl` runs this same plan on every non-command turn, seeds
 * `delivered` from a `thread/start`, and keeps it across a resume or a fork.
 * Pi composes its system prompt in each turn from that turn's style, so it
 * needs no notice.
 *
 * ## The state, and the one case it cannot know
 *
 * `delivered` is the style block (the composition's `prompt`, `''` for none) the
 * model currently holds. It is set without a notice when the turn renders the
 * prompt FRESH (a new SDK session, or `/compact`, which re-renders from the
 * current append), and set by the notice otherwise.
 *
 * `undefined` means unknown. That happens on the first turn of a new agent
 * instance that resumes an SDK session: after an app restart, an agent
 * re-creation, or a branch fork. The recorded prompt was rendered by an earlier
 * instance, and nothing persists which style it carried. Then a style WITH prose
 * is delivered once (at worst a repeat of what the prompt already says), and
 * Default delivers nothing. The residue: a session recorded under a style and
 * resumed by a new instance after the user picked Default keeps that recorded
 * prose until compaction, and no reminder names it. A notice saying "no style"
 * on every resumed session would put output-style text in sessions that never
 * used a style. Persisting the delivered block per session would close this,
 * and is not done here.
 *
 * The notice carries the style's prose only. A switch to or from a style with
 * `keep-coding-instructions: false` leaves the recorded prompt's engineering
 * bullets as they were rendered, until compaction renders the new append.
 */
import type { OutputStyleComposition } from '../../prompts/output-styles.ts';
import { neutralizeHarnessMarkers } from '../../prompts/untrusted-text.ts';

/** What one turn delivers, and what the model holds once that turn's message is sent. */
export interface OutputStyleSwitchPlan {
  /** The one-shot block for this turn's message tail, or `null` when nothing is owed. */
  notice: string | null;
  /** The style block the model holds after this turn (`''` when none). */
  delivered: string;
}

export interface OutputStyleSwitchInput {
  /** The style block the model holds now; `undefined` when this instance cannot know. */
  delivered: string | undefined;
  /** This turn's resolved style; `undefined` (or an empty `prompt`) when none is active. */
  current: Pick<OutputStyleComposition, 'prompt' | 'label'> | undefined;
  /**
   * True when this turn continues a conversation whose system prompt is
   * already recorded, so the turn's append does not reach the model. False for
   * a fresh SDK session and for `/compact`, which render from the current append.
   */
  continuesRecordedPrompt: boolean;
}

export function planOutputStyleSwitch(input: OutputStyleSwitchInput): OutputStyleSwitchPlan {
  const current = input.current?.prompt ?? '';
  if (!input.continuesRecordedPrompt || input.delivered === current) {
    return { notice: null, delivered: current };
  }
  // Unknown and no style: say nothing (the residue in the header).
  if (input.delivered === undefined && current === '') {
    return { notice: null, delivered: current };
  }
  return { notice: formatOutputStyleSwitchNotice(input.current), delivered: current };
}

/**
 * The notice itself. Worded so it is true in both cases that produce it: a real
 * switch, and the unknown case where the style may be unchanged.
 *
 * The style block is author-controlled text for a custom or plugin style, and
 * here it sits inside the host's own `<system-reminder>` fence, so the whole
 * body is defanged. In the system prompt the same block is not fenced, and needs
 * no defang there.
 */
export function formatOutputStyleSwitchNotice(
  current: Pick<OutputStyleComposition, 'prompt' | 'label'> | undefined,
): string {
  const block = current?.prompt.trim() ?? '';
  const body = block
    ? `Active output style: '${current?.label ?? ''}'. The instructions below replace any`
      + ' "Output Style:" section in your system prompt and any earlier output-style notice;'
      + ' follow them for this and every later reply in this conversation.\n\n'
      + block
    : 'Active output style: none. Disregard any "Output Style:" section in your system prompt'
      + ' and any earlier output-style notice, and use your standard response style for this'
      + ' and every later reply in this conversation.';
  return `<system-reminder>\n${neutralizeHarnessMarkers(body)}\n</system-reminder>`;
}
