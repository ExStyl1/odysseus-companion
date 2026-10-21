/**
 * **P6.63 — the RESULTS half of the sensitive-files contract, on claude.**
 *
 * `settings-reference.md#exclude-sensitive-files` promises three things of a
 * denied path, verbatim: *"Claude Code excludes matching files from file
 * discovery and search results, denies reads of them, and blocks the Edit and
 * Write tools on the matching paths."* P3.147/P3.174 measured the shipped binary
 * at 2.1.223, 2.1.233 and 2.1.247 and the FIRST clause did not hold: with
 * `Read(//**\/.env)` compiled and the `Read` genuinely refused in the same run,
 * `Grep` still returned the denied file's line — secret value included — and
 * `Glob` still listed it. Clauses two and three held throughout. **The vendor
 * repaired the first clause at 2.1.251** (driven 2026-09-13 on C3.380's lift;
 * all four exclusion facts inverted in one bump), so this module is no longer
 * the only thing performing it on claude. Both readings are pinned in
 * `claude-denied-path-search-results-e2e.test.ts`, the second as an INVERTED
 * assertion.
 *
 * ## D1.163 — the posture, DECIDED: this module STAYS on claude
 *
 * The sentence above used to end *"a switch verdict for the owner, not a
 * version bump's consequence"*, which was right and left the verdict untaken.
 * Taken now, under the wave's delegated owner criterion (a `[product]` posture
 * is stated in code and in the report, and the default is kept), for three
 * reasons in descending weight:
 *
 * 1. **One user-owned setting must not mean different things per runtime.**
 *    This module is what makes Pi, codex and claude answer a denied-path search
 *    the same way. Retiring it on claude alone would make `permissions.deny`
 *    cover search results by the VENDOR's rules there and by ours elsewhere,
 *    and a user switching runtimes would have no way to know which they were
 *    getting — the divergence class this fork has paid for most often.
 * 2. **The SDK's own rewrite fails OPEN, so our gated arm is the only proof the
 *    shape we send is still ACCEPTED.** Delete the filter and the next time the
 *    vendor changes a `tool_response` shape nothing tells us; the rewrite simply
 *    stops happening, silently, which is the exact failure mode the "fails open"
 *    section below exists to guard.
 * 3. **The vendor's repair is ONE reading, on ONE version, taken once.** It was
 *    driven at 2.1.251 and the bundle moves every few weeks. Keeping a
 *    belt-and-braces filter costs one `PostToolUse` rewrite per search; removing
 *    it bets a secret on a behaviour nobody re-drives per bump.
 *
 * COST, stated rather than hidden: one `PostToolUse` hook round trip per `Grep`
 * or `Glob` on claude, doing work the binary has already done since 2.1.251. The
 * cheapest honest way to revisit this is a driven re-measurement at a later
 * bundle, not a code reading — and the version tripwire in the e2e file is what
 * makes that re-measurement fall due.
 *
 * ## Native mechanism, asked and answered — and the answer is a HOST seam the
 * ## runtime hands us
 *
 * Tier 1 is not "enable `permissions.deny`": that is already adopted, already
 * mirrored, and already measured NOT to cover this clause. What the runtime does
 * offer is the `PostToolUse` hook's `updatedToolOutput` —
 * `hooks.md#posttooluse-decision-control`, verbatim: *"`updatedToolOutput` —
 * Replaces the tool's output with the provided value before it is sent to
 * Claude. The value must match the tool's output shape"*, and *"Prefer
 * `updatedToolOutput`, which works for all tools"*. The vendored types carry it
 * (`sdk.d.ts` `PostToolUseHookSpecificOutput`), and P3.340 already ruled the
 * seam *"EXISTS and is deliberately unused … the honest verdict for both is
 * 'never wired', not 'cannot'."* So this is the runtime's own mechanism,
 * configured — the filtering decision was ours because the vendor's was absent
 * up to 2.1.247, and since 2.1.251 the two agree rather than only ours acting.
 *
 * ## It FAILS OPEN, which is why a rejected rewrite must be diagnosed
 *
 * The same page: *"For built-in tools, a value that doesn't match the tool's
 * output schema is ignored and the original output is used"*, and the shipped
 * binary carries the validator's own sentence — *"…does not match ${e.name}'s
 * output shape; using original output."* A rewrite we get wrong is therefore
 * not an error, it is a SILENT non-event that leaks exactly what it was written
 * to withhold. So this module never guesses: it returns `unsupported` with a
 * reason for any shape it does not recognise, and the caller says so out loud.
 *
 * ## The shapes, MEASURED rather than assumed (2026-09-05)
 *
 * They are undocumented, so they were read off the vendored binary through a
 * `PostToolUse` probe on the P3.147 rig — the same fixture, the same stub
 * upstream, the same pinned executable:
 *
 * | Call | `tool_response` |
 * | --- | --- |
 * | `Grep`, `output_mode: content` | `{ mode: 'content', numFiles, filenames: [], content: "<path>:<line>:<text>\n…", numLines, totalLines }` |
 * | `Grep`, `output_mode: files_with_matches` | `{ mode: 'files_with_matches', filenames: [...], numFiles, totalFiles }` |
 * | `Glob` | `{ filenames: [...], durationMs, numFiles, truncated, totalMatches, countIsComplete }` |
 *
 * Every other shape — `Grep`'s `count` mode, a future field, a string payload —
 * is `unsupported` by construction rather than by omission. The counts are
 * rewritten alongside the lists, because a payload whose `numFiles` disagrees
 * with its `filenames` is the kind of inconsistency the validator may reject
 * (fail-open again) and the model will certainly notice.
 *
 * ## What is withheld is SAID, without saying what
 *
 * A search that returns fewer rows and says nothing teaches the reader the file
 * does not exist. The notice rides `additionalContext` — the sibling field on
 * the same hook output — rather than being spliced into the payload, because
 * two of the three shapes are arrays of paths and a sentence inside one would
 * read as a filename. It names a COUNT OF FILES and never a path, for the reason
 * `local-tools/denied-result-filter.ts` gives: "17 matches withheld" leaks how
 * many lines of a credential file contain the query.
 *
 * ## Residue, stated
 *
 * A `Bash` command whose OUTPUT carries denied content without naming the path
 * is not covered — path TOKENS in a Bash command are already gated on the
 * request side, but a command that reaches a denied file through shell
 * indirection (a glob expanded by the shell, a path assembled from variables)
 * is a different row. The example is written in words on purpose: a literal
 * star-slash inside a block comment CLOSES it, which cost this file nine hard
 * parse errors on its first write.
 * The line-attribution rules, the fail-open batch contract and the
 * withheld-notice wording are all reused from
 * `local-tools/denied-result-filter.ts` rather than re-derived: a second
 * matcher was refused outright on P3.105 (four defects out of one compiler in a
 * single day) and a second line parser would inherit the same class.
 */

import {
  deniedResultsWithheldNotice,
  withholdDeniedEntries,
  withholdDeniedMatchLines,
  type DeniedResultPathFilter,
} from './local-tools/denied-result-filter.ts';

/** The two search tools whose RESULTS carry paths the request gate cannot see. */
export const CLAUDE_SEARCH_RESULT_TOOLS = ['Grep', 'Glob'] as const;

export type ClaudeSearchResultTool = (typeof CLAUDE_SEARCH_RESULT_TOOLS)[number];

/**
 * What to do with one tool's output.
 *
 * `unsupported` is a first-class outcome rather than an error: the rewrite fails
 * OPEN in the runtime, so an unrecognised shape must be REPORTED, never guessed
 * at. `unchanged` and `unsupported` are deliberately different — the first means
 * nothing was denied, the second means we could not tell.
 */
export type ClaudeSearchOutputRewrite =
  | { kind: 'unchanged' }
  | { kind: 'rewritten'; output: Record<string, unknown>; withheldFiles: number; notice: string }
  | { kind: 'unsupported'; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every entry is a string, or the list is not one we understand. */
function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every(entry => typeof entry === 'string') ? [...value as string[]] : null;
}

/**
 * Filter one `Grep`/`Glob` result against the `deniedPaths` floor, preserving
 * the payload's measured shape.
 *
 * `searchRoot` is the tool's own `path` argument (or the session cwd), because
 * the binary may print a relative path and the deny list is asked about an
 * absolute one — the same `absoluteAgainst` rule the Pi-side filter uses.
 */
export async function rewriteClaudeSearchOutput(input: {
  toolName: string;
  toolResponse: unknown;
  searchRoot: string;
  filter: DeniedResultPathFilter | undefined;
}): Promise<ClaudeSearchOutputRewrite> {
  const { toolName, toolResponse, searchRoot, filter } = input;
  if (!(CLAUDE_SEARCH_RESULT_TOOLS as readonly string[]).includes(toolName)) return { kind: 'unchanged' };
  // No floor configured is not an unknown shape: it is nothing to do.
  if (!filter) return { kind: 'unchanged' };
  if (!isRecord(toolResponse)) {
    return { kind: 'unsupported', reason: `${toolName} returned a ${typeof toolResponse}, not an object` };
  }

  if (toolName === 'Glob') {
    const filenames = stringList(toolResponse.filenames);
    if (filenames === null) {
      return { kind: 'unsupported', reason: 'Glob returned no string `filenames` array' };
    }
    const { entries, withheldFiles } = await withholdDeniedEntries(
      filenames,
      entry => absoluteEntry(searchRoot, entry),
      filter,
    );
    if (withheldFiles === 0) return { kind: 'unchanged' };
    return {
      kind: 'rewritten',
      // Spread first so every field we did NOT measure survives untouched; a
      // dropped field is a shape mismatch and a shape mismatch fails open.
      output: {
        ...toolResponse,
        filenames: entries,
        ...(typeof toolResponse.numFiles === 'number' ? { numFiles: entries.length } : {}),
        ...(typeof toolResponse.totalMatches === 'number' ? { totalMatches: entries.length } : {}),
      },
      withheldFiles,
      notice: deniedResultsWithheldNotice(withheldFiles),
    };
  }

  const mode = toolResponse.mode;
  if (mode === 'files_with_matches') {
    const filenames = stringList(toolResponse.filenames);
    if (filenames === null) {
      return { kind: 'unsupported', reason: 'Grep files_with_matches returned no string `filenames` array' };
    }
    const { entries, withheldFiles } = await withholdDeniedEntries(
      filenames,
      entry => absoluteEntry(searchRoot, entry),
      filter,
    );
    if (withheldFiles === 0) return { kind: 'unchanged' };
    return {
      kind: 'rewritten',
      output: {
        ...toolResponse,
        filenames: entries,
        ...(typeof toolResponse.numFiles === 'number' ? { numFiles: entries.length } : {}),
        ...(typeof toolResponse.totalFiles === 'number' ? { totalFiles: entries.length } : {}),
      },
      withheldFiles,
      notice: deniedResultsWithheldNotice(withheldFiles),
    };
  }

  if (mode === 'content') {
    const content = toolResponse.content;
    if (typeof content !== 'string') {
      return { kind: 'unsupported', reason: 'Grep content mode returned no string `content`' };
    }
    const { text, withheldFiles } = await withholdDeniedMatchLines(content, searchRoot, filter);
    if (withheldFiles === 0) return { kind: 'unchanged' };
    // `numLines`/`totalLines` count RESULT lines, so they are re-derived from
    // what survived — an empty result is zero lines, not one empty one.
    const keptLines = text.length === 0 ? 0 : text.split('\n').length;
    return {
      kind: 'rewritten',
      output: {
        ...toolResponse,
        content: text,
        ...(typeof toolResponse.numLines === 'number' ? { numLines: keptLines } : {}),
        ...(typeof toolResponse.totalLines === 'number' ? { totalLines: keptLines } : {}),
      },
      withheldFiles,
      notice: deniedResultsWithheldNotice(withheldFiles),
    };
  }

  // `count` and anything a later version adds. Reported, never guessed: a
  // rewrite of a shape we do not know fails open and leaks what it was written
  // to withhold.
  return {
    kind: 'unsupported',
    reason: `Grep output_mode ${JSON.stringify(mode)} has no measured shape on this surface`,
  };
}

/**
 * The absolute path the deny list is asked about.
 *
 * The binary printed absolute paths in every arm of the 2026-09-05 measurement,
 * so this is the belt for a relative one rather than the observed case — and it
 * is deliberately `searchRoot`-relative, because that is the directory the tool
 * was pointed at.
 */
function absoluteEntry(searchRoot: string, entry: string): string {
  if (entry.startsWith('/') || /^[A-Za-z]:[\\/]/.test(entry)) return entry;
  if (!searchRoot) return entry;
  return searchRoot.endsWith('/') ? `${searchRoot}${entry}` : `${searchRoot}/${entry}`;
}
