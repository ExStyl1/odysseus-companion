/**
 * The default prompt for a bare `/loop` (R39, findings f199/f200).
 *
 * Contract source, `scheduled-tasks.md` read raw:
 * - `:82`-`:88` — the built-in maintenance prompt works through, in order:
 *   continue unfinished conversation work; tend the current branch's PR
 *   ("review comments, failed CI runs, merge conflicts"); "run cleanup passes
 *   such as bug hunts or simplification when nothing else is pending". Claude
 *   "does not start new initiatives outside that scope, and irreversible
 *   actions such as pushing or deleting only proceed when they continue
 *   something the transcript already authorized."
 * - `:102` — "A `loop.md` file replaces the built-in maintenance prompt with
 *   your own instructions."
 * - `:104`-`:109` — two locations, first found wins; the project file
 *   (`.claude/loop.md`, our `.nessy-agent/loop.md`) "takes precedence when both
 *   files exist" over the user file (`~/.claude/loop.md`, our
 *   `<CONFIG_DIR>/loop.md`).
 * - `:120` — "Edits to `loop.md` take effect on the next iteration" (so the
 *   resolver is called at every DELIVERY, never cached) and "content beyond
 *   25,000 bytes is truncated".
 *
 * Host code rather than a skill-body Read instruction because the byte cap and
 * the precedence must be ENFORCED, not suggested (f200's recorded reason).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from '../config/paths.ts';
import { NESSY_AGENT_PROJECT_DIR } from '../projects/nessy-agent-layout.ts';

/** `:120` — "content beyond 25,000 bytes is truncated". Bytes, not characters. */
export const MAX_LOOP_MD_BYTES = 25_000;

/**
 * `:82`-`:88`, PARAPHRASED per AGENTS.md's prompt rule (text extracted from
 * proprietary bundles stays paraphrase-only): the three items in the documented
 * order, then the no-new-initiatives / irreversible-actions guard.
 */
export const BUILTIN_LOOP_MAINTENANCE_PROMPT = `This is a maintenance iteration of the session loop. Work through the following, in order:

1. Pick up any work this conversation left unfinished and carry it forward.
2. Look after the current branch's pull request: address new review comments, investigate failed CI runs, and resolve merge conflicts.
3. When nothing above needs attention, run a cleanup pass — hunt for bugs or simplify code already touched in this conversation.

Stay inside that scope: do not begin new initiatives. Take an irreversible action such as pushing or deleting only when it continues something this conversation already authorized. If there is nothing to do, say so in one line.`;

export interface ResolvedLoopPrompt {
  readonly prompt: string;
  /** Which authority supplied the text — the project file, the user file, or the builtin. */
  readonly source: 'project' | 'user' | 'builtin';
  /** True when a found file exceeded {@link MAX_LOOP_MD_BYTES} and was cut. */
  readonly truncated: boolean;
}

/**
 * Cut a UTF-8 string at `maxBytes` WITHOUT splitting a character: a multi-byte
 * character straddling the cap is dropped entirely, so the result is always
 * valid UTF-8 and never longer than the cap.
 */
function truncateAtByteBoundary(content: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(content, 'utf8');
  if (buffer.byteLength <= maxBytes) return { text: content, truncated: false };
  let end = maxBytes;
  // 0b10xxxxxx marks a UTF-8 continuation byte: walk back to the straddling
  // character's lead byte and exclude it.
  while (end > 0 && (buffer[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return { text: buffer.subarray(0, end).toString('utf8'), truncated: true };
}

/**
 * Resolve the default loop prompt for one delivery.
 *
 * `<projectDir>/.nessy-agent/loop.md` first, then `<configDir>/loop.md`; the
 * first file found wins (`:104`-`:109`). Call this at every delivery — never
 * cache the result — so `:120`'s "edits take effect on the next iteration"
 * stays literal. A file that is missing, unreadable, or blank falls through;
 * when neither location yields content the builtin maintenance prompt applies.
 */
export function resolveLoopPrompt(projectDir: string, configDir: string = CONFIG_DIR): ResolvedLoopPrompt {
  const candidates: { path: string; source: 'project' | 'user' }[] = [
    { path: join(projectDir, NESSY_AGENT_PROJECT_DIR, 'loop.md'), source: 'project' },
    { path: join(configDir, 'loop.md'), source: 'user' },
  ];
  for (const candidate of candidates) {
    let content: string;
    try {
      content = readFileSync(candidate.path, 'utf8');
    } catch {
      continue;
    }
    // A blank file cannot "replace" the prompt with instructions (`:102`);
    // treating it as absent beats delivering an empty iteration prompt.
    if (content.trim().length === 0) continue;
    const { text, truncated } = truncateAtByteBoundary(content, MAX_LOOP_MD_BYTES);
    return { prompt: text, source: candidate.source, truncated };
  }
  return { prompt: BUILTIN_LOOP_MAINTENANCE_PROMPT, source: 'builtin', truncated: false };
}
