/**
 * Context-checkpoint compaction handoff prompt (plan: prompt-and-review-parity
 * K1). Instructs the summarizing model to write a handoff for the model that
 * resumes the session after compaction, rather than a generic recap.
 *
 * The prompt body is adapted VERBATIM from the openai/codex compaction template
 * (`codex-rs/prompts/templates/compact/prompt.md`, Apache-2.0). See
 * `docs/architecture/pi-extension-adoption-scorecard.md` for the source +
 * license record. Cursor's near-identical variant is proprietary and is NOT a
 * source here.
 *
 * Wiring: the Pi backend routes this through the existing single compaction
 * owner. `composePiCompactionInstructions` (agent/pi-harness/prompt-composer.ts)
 * uses it as the base instructions for `session.compact(instructions)`, so no
 * second compaction lifecycle is introduced. The Claude Agent SDK owns its own
 * compaction prompt internally (host `/compact` is forwarded straight to the
 * SDK subprocess), so there is no host seam to inject this prompt there.
 */

/**
 * Handoff instructions for the summarizing model. Adapted verbatim from the
 * openai/codex compaction template (Apache-2.0).
 */
export const COMPACTION_HANDOFF_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

/**
 * Marker line prepended to the compaction instructions so the produced summary,
 * once it re-enters the resumed context, is framed as a prior-model handoff
 * checkpoint rather than as new user input.
 */
export const COMPACTION_HANDOFF_MARKER =
  'The summary you produce re-enters the conversation as a prior-model handoff checkpoint (not as user input); write it accordingly.';

/**
 * The full compaction instructions the Pi compaction owner feeds to
 * `session.compact()`: the handoff prompt followed by the resume-prefix marker.
 */
export const COMPACTION_HANDOFF_INSTRUCTIONS = `${COMPACTION_HANDOFF_PROMPT}\n\n${COMPACTION_HANDOFF_MARKER}`;

/**
 * Truncation marker for any bounded block folded into the compaction prompt.
 *
 * Exported so the two things that fold user- or project-authored text into that
 * prompt — `capPiCompactionCustomInstructions` (an explicit `/compact <focus>`)
 * and {@link composeProjectCompactSteering} (a project's standing section) —
 * cut with the same visible mark. A model that meets one cut sentence and one
 * silently-cut sentence in the same prompt cannot tell which was complete.
 */
export const COMPACTION_TRUNCATION_MARKER = '… [truncated]';

/**
 * The section heading a project uses to steer what compaction preserves.
 *
 * `how-claude-code-works.md#when-context-fills-up`, verbatim: "To control what's
 * preserved during compaction, add a \"Compact Instructions\" section to
 * CLAUDE.md or run `/compact` with a focus (like `/compact focus on the API
 * changes`)."
 *
 * Matched case-INSENSITIVELY and at any heading level, because the page fixes
 * the section's NAME and says nothing about its depth or its capitalisation, and
 * a reader stricter than the contract would silently ignore a file the user
 * wrote correctly.
 */
export const COMPACT_INSTRUCTIONS_SECTION_TITLE = 'Compact Instructions';

/**
 * Upper bound on the project steering folded into one compaction prompt.
 *
 * Same number and same reason as `PI_COMPACTION_CUSTOM_INSTRUCTIONS_MAX`: the
 * steering must not crowd out the handoff prompt or the summarizer's own budget.
 * A project file is if anything MORE able to run long than a typed `/compact`
 * focus, so the bound is not optional here.
 */
export const PROJECT_COMPACT_STEERING_MAX = 8192;

/**
 * The label that introduces the steering inside the compaction prompt.
 *
 * It names the source, because the summarizing model is being handed two kinds
 * of instruction at once — a one-shot focus the user typed for THIS compaction,
 * and the project's standing policy — and an unlabelled second block reads as a
 * contradiction rather than as a second authority.
 */
export const PROJECT_COMPACT_STEERING_LABEL =
  `Standing compaction instructions from this project's instruction files`
  + ` (\`${COMPACT_INSTRUCTIONS_SECTION_TITLE}\` section) — preserve what they name:`;

/**
 * The two fields this module reads off a delivered instruction resource.
 *
 * `PiContextResourceDescriptor` (`agent/pi-harness/context-resource.ts`)
 * satisfies it structurally, so the reader takes what the HOST already composed
 * — one pass of the `@path` expansion, the block-HTML-comment strip and the
 * index caps — instead of re-reading CLAUDE.md off disk and re-deriving three
 * rules that already have an owner.
 */
export interface CompactInstructionsSource {
  readonly kind: string;
  readonly content: string;
  readonly provenance: string;
}

function normalizeHeadingText(text: string): string {
  return text
    // ATX headings may be closed: `## Compact Instructions ##`.
    .replace(/\s+#+\s*$/, '')
    .replace(/[*_`]/g, '')
    .replace(/:\s*$/, '')
    .trim()
    .toLowerCase();
}

/**
 * The body of a markdown file's `Compact Instructions` section, or `undefined`
 * when it has none.
 *
 * The section ends at the next heading of the SAME OR HIGHER level, which is
 * what makes a `### Compact Instructions` nested under `## Context` behave the
 * way its author sees it on the page: its own `####` subsections belong to it,
 * and the next `##` ends it.
 *
 * Fenced code blocks are tracked, so a `# ...` line inside a ``` fence is not
 * read as a heading. Instruction files are full of shell and markdown samples;
 * without this a sample would either invent a section or truncate a real one.
 */
export function extractCompactInstructionsSection(markdown: string): string | undefined {
  const target = COMPACT_INSTRUCTIONS_SECTION_TITLE.toLowerCase();
  const lines = markdown.split(/\r?\n/);
  const collected: string[] = [];
  let sectionLevel = 0;
  let fence: string | null = null;

  for (const line of lines) {
    const fenceMatch = /^\s{0,3}(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? '';
      if (fence === null) fence = marker[0] ?? null;
      else if (marker[0] === fence) fence = null;
      if (sectionLevel > 0) collected.push(line);
      continue;
    }
    const heading = fence === null ? /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line) : null;
    if (heading) {
      const level = (heading[1] ?? '').length;
      if (sectionLevel > 0) {
        if (level <= sectionLevel) break;
        collected.push(line);
        continue;
      }
      if (normalizeHeadingText(heading[2] ?? '') === target) sectionLevel = level;
      continue;
    }
    if (sectionLevel > 0) collected.push(line);
  }

  const body = collected.join('\n').trim();
  return body.length > 0 ? body : undefined;
}

/**
 * The steering block for one session, composed from the instruction resources
 * the host already delivered, or `undefined` when no file carries the section.
 *
 * Two filters, both deliberate:
 *
 * - only `agent-instruction` resources are read. Those are the instruction files
 *   the page is about (CLAUDE.md / AGENTS.md and the nested ones). Memory files
 *   arrive as `context` and MCP prompts as `prompt`; neither is what the page
 *   names, and widening to them would let a section title in an unrelated file
 *   steer compaction.
 * - anything whose provenance is `mcp:` is dropped even if it were to arrive
 *   under another kind. MCP content is server-controlled; letting a connected
 *   server decide what survives compaction is a channel nobody asked for.
 *
 * Multiple files may each carry a section — nested instruction files are a
 * documented shape — so they are joined in delivery order and the whole is
 * bounded once, at the end, where the total is actually known.
 */
export function composeProjectCompactSteering(
  resources: readonly CompactInstructionsSource[] | undefined,
): string | undefined {
  const sections: string[] = [];
  for (const resource of resources ?? []) {
    if (resource.kind !== 'agent-instruction') continue;
    if (resource.provenance.startsWith('mcp:')) continue;
    const section = extractCompactInstructionsSection(resource.content);
    if (section) sections.push(section);
  }
  if (sections.length === 0) return undefined;

  const body = sections.join('\n\n');
  const bounded = body.length <= PROJECT_COMPACT_STEERING_MAX
    ? body
    : `${body.slice(0, PROJECT_COMPACT_STEERING_MAX - COMPACTION_TRUNCATION_MARKER.length)}`
      + COMPACTION_TRUNCATION_MARKER;
  return `${PROJECT_COMPACT_STEERING_LABEL}\n\n${bounded}`;
}

/**
 * Fold a project's standing `Compact Instructions` into compaction instructions
 * the host already composed.
 *
 * **An ADDITION, never a replacement**, and the guard is the whole point: an
 * absent or empty `instructions` is returned untouched. On the Pi auto path an
 * absent value is the signal that our summary replacement is off for this turn
 * (`session_before_compact` returns early on it and Pi's own summarizer runs);
 * turning that into a steering-only string would newly activate the replacement
 * for sessions that had it disabled, which is a different change than this one.
 * On the manual path it would drop the SDK's default compaction prompt and send
 * the steering alone.
 *
 * The steering goes LAST because it is standing policy, while everything before
 * it is specific to this compaction — the handoff prompt, then any `/compact
 * <focus>` the user typed for this one, then the bounded reference reinjection.
 * Order is the only precedence signal a prompt has, and the more specific
 * instruction keeps its place next to the task description.
 */
export function withProjectCompactSteering(
  instructions: string | undefined,
  resources: readonly CompactInstructionsSource[] | undefined,
): string | undefined {
  if (!instructions) return instructions;
  const steering = composeProjectCompactSteering(resources);
  return steering ? `${instructions}\n\n${steering}` : instructions;
}
