import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';

/**
 * D1.332 — read-before-write, the one rule and the one sentence, for every
 * runtime that can reach a write seam this host owns.
 *
 * ## Why this module exists at all
 *
 * The rule was born on Pi alone (P6.558, `local-tools/runtime.ts`) and RS-76
 * measured what that costs: the SAME instruction, in one profile, in one run,
 * over one directory — a seeded file the session had never read, asked to be
 * REPLACED — was **refused on Pi and performed on claude and codex**, with a
 * NEW file created on all three as the control that proves the workspace was
 * writable and each session was bound where the case thought it was. A user who
 * switches runtimes mid-task therefore switches safety rules without being told,
 * which is the largest defect class this fork has.
 *
 * Native-first was asked first and answered: claude's SDK HAS this rule —
 * `tools-reference.md#edit-tool-behavior`, verbatim: *"**Read-before-edit**:
 * Claude reads the file in the current conversation before editing it"*, with
 * the page's own model gate, *"Claude Opus 4.6, Claude Haiku 4.5, and older
 * models always require the read. Newer models can edit an unread file when
 * reading it wouldn't need a permission prompt and the Read tool is
 * available."* On the gateway card it did not fire, so the host is the seam.
 * Codex publishes no such rule at all.
 *
 * ## One writer, not three copies
 *
 * The sentence, the predicate and the Bash-viewer credit live HERE and are
 * imported by every seam, so the three runtimes cannot drift apart again by a
 * reworded refusal or a fifth viewer credited on one of them. Pi's runtime keeps
 * its own field name and its own docblock — the four decisions recorded there
 * are about how Pi RECORDS a read, which is runtime-shaped — and delegates the
 * rule itself to {@link SessionFileReadLedger}.
 *
 * Deliberately tiny: `node:fs` and nothing else. It is imported by
 * `local-tools/runtime.ts`, which Pi's every tool call goes through, and a
 * module graph is what a per-test timer is spent on in this tree.
 */

/**
 * The refusal, verbatim. It names the remedy because its reader is a model that
 * can act on it in the next tool call, and it is the SAME sentence on all three
 * runtimes so that a user who switches cannot tell which one refused.
 *
 * English and never localized: this is tool-result contract text, the same rule
 * the missing-ripgrep result in `local-tools/runtime.ts` follows.
 */
export function readBeforeWriteRefusal(path: string): string {
  return `${path} exists and has not been read in this session. `
    + 'Read it first, then write to it — an overwrite of a file nobody looked at destroys content '
    + 'the conversation never saw.';
}

/** The subset of the page's eleven viewers that take a file and nothing else. */
const BARE_FILE_VIEWERS = new Set(['cat', 'nl', 'bat', 'batcat']);

/**
 * P6.558 — the file a Bash command viewed, when the command is unambiguously a
 * bare single-file viewer, and `undefined` otherwise.
 *
 * The page credits eleven commands (`cat`, `nl`, `bat`, `batcat`, `head`,
 * `tail`, `sed -n 'X,Yp'`, `grep`, `egrep`, `fgrep`, `rg`). This function
 * credits **four**, and the omission is deliberate rather than partial work:
 * the other seven take their subject as an operand that a whitespace split
 * cannot tell from an option VALUE or a pattern — `head -n 5 f`, `grep pat f`,
 * `sed -n '1,5p' f` — so identifying "the single file" needs a real shell
 * parser. Getting that wrong in the permissive direction marks a file as seen
 * that nobody saw, which silently weakens a safety gate; getting it wrong in the
 * restrictive direction costs one refusal that names its own remedy. The four
 * below take a file and nothing else, so they cannot be misread.
 *
 * Any shell metacharacter disqualifies the command outright — the page says
 * *"with no pipes or redirects"*, and a command joined with `&&`, `;` or a
 * substitution is not the single viewer invocation the sentence is about.
 *
 * Moved here from `local-tools/runtime.ts` by D1.332, unchanged, so the credit
 * is the same four on every runtime rather than four on one and none on two.
 */
export function bareFileViewerOperand(command: string): string | undefined {
  if (/[|&;<>$`\n()]/.test(command)) return undefined;
  const tokens = command.trim().split(/\s+/);
  if (tokens.length !== 2) return undefined;
  const [viewer, operand] = tokens;
  if (viewer === undefined || operand === undefined) return undefined;
  if (!BARE_FILE_VIEWERS.has(viewer)) return undefined;
  if (operand.startsWith('-')) return undefined;
  const unquoted = operand.replace(/^(['"])(.*)\1$/, '$2');
  return unquoted.length > 0 ? unquoted : undefined;
}

/**
 * F1.96 (origin D1.410) — did the tool call that just finished actually READ the
 * file, so that a viewer's path may be credited?
 *
 * ## Why this question exists at all
 *
 * Pi credits a viewer AFTER the command, on exit code 0; codex credits from the
 * item it gets back, on a non-error return. Claude credited from its PreToolUse
 * hook — before the gate had decided and before the child executed, on
 * `existsSync` alone — so a viewer that was DENIED, or that exited non-zero
 * (`bat` not installed, exit 127), still marked the file as seen and unlocked an
 * overwrite of a file nobody looked at. That is the cross-runtime divergence
 * D1.332 exists to remove, in the one direction that weakens a safety gate.
 *
 * ## What this predicate is, and what it deliberately is not
 *
 * On claude the credit now runs from the PostToolUse hook, and the EVENT is most
 * of the answer: `hooks.md`'s event table reads *"`PostToolUse` | After a tool
 * call succeeds"* with *"`PostToolUseFailure` | After a tool call fails"* on the
 * line below, so a failing call is routed to a different event this fork does
 * not credit from. This function is the second, defensive half — the shapes a
 * tool result uses to say "I ran and it went wrong" even when the runtime still
 * calls the call a success.
 *
 * F1.187 MEASURED that routing rather than trusting it: driven through the
 * vendored 2.1.251's real hook dispatch
 * (`claude-post-tool-use-failure-e2e.test.ts`), `cat` and `nl` that exit 0 fire
 * `PostToolUse`, while `cat` of a missing file (`Exit code 1`), `false`
 * (`Exit code 1`), an absent binary and an absent `bat` (`Exit code 127`) each
 * fire `PostToolUseFailure` and never `PostToolUse`. So on claude the EVENT is
 * what tells a failed viewer apart, and `ClaudeAgent.declineBashViewerCredit`
 * is the twin's handler.
 *
 * It reads THREE fields and invents none: `is_error` (the SDK's own tool-result
 * spelling), `isError` (the same flag in this fork's camelCase surfaces), and
 * `interrupted`, which a Bash result sets when the user stopped the command —
 * an interrupted `cat` printed nothing worth crediting. Anything else is treated
 * as a success, which is the event's own contract; a non-object response (a
 * bare string) is a success for the same reason.
 *
 * RESIDUE, narrowed by that measurement and stated rather than papered over:
 * the runtime DOES report some non-zero exits as an ordinary success — measured
 * in the same run, `grep` with no match exits 1 and fires `PostToolUse` — so a
 * command in that class would reach the credit with nothing in its payload to
 * say so. None of the four viewers this rule credits (`cat`, `nl`, `bat`,
 * `batcat`) was in it: the three driven here fired the failing twin, and
 * `batcat` was NOT driven — absent it is the absent-binary class measured
 * above, present it is `bat` under Debian's name. Closing it for a command
 * outside the viewer set would need an exit code this hook's payload does not
 * carry, and no such command is credited today.
 */
export function readCreditingToolResultSucceeded(toolResponse: unknown): boolean {
  if (!toolResponse || typeof toolResponse !== 'object') return true;
  const result = toolResponse as Record<string, unknown>;
  return result.is_error !== true && result.isError !== true && result.interrupted !== true;
}

/**
 * The tool names that MUTATE a file's content on the two runtimes this host
 * gates from outside.
 *
 * `Write`, `Edit` and `MultiEdit` are claude's own spellings and the two codex
 * publishes through `codexApprovalFloorSubjects` (`CODEX_FILE_CHANGE_TOOL_NAMES`
 * is `['Write', 'Edit']`, so a file-change approval renders as both).
 * `NotebookEdit` is here because the SDK's own `#write-tool-behavior` sentence
 * is about overwriting an existing file and a notebook cell edit is exactly
 * that; its path arrives under a third spelling, which {@link writeTargetPath}
 * reads.
 *
 * Pi is NOT a consumer of this set: its gate sits inside the tool runtime, on
 * `write_file` / `edit_file` / `replace_in_file`, which is the same three acts
 * under the names that runtime uses.
 */
export const READ_BEFORE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);

/**
 * The file a write call targets, in every spelling this rule can meet.
 *
 * `file_path` is claude's, `path` is Pi's and codex's, `notebook_path` is
 * `NotebookEdit`'s. Reading only the first would answer `undefined` on the other
 * two and a gate that reads `undefined` allows — which is the shape
 * `toolTargetPath`'s own docblock records as a shipped defect once already.
 */
export function writeTargetPath(input: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

/**
 * The canonical paths whose content one session has already seen, and the rule
 * that reads them.
 *
 * `add`/`has` are named after `Set`'s on purpose: this class replaced a bare
 * `Set<string>` inside `LocalToolRuntime` and the call sites are unchanged, so
 * the move cannot have altered Pi's behaviour by a renamed method.
 *
 * ONE instance per session on every runtime — `LocalToolRuntime` is constructed
 * once per Pi session, and the claude and codex agents each hold one for the
 * life of the agent — so its lifetime IS *"the current conversation"* the page's
 * rule is written against.
 */
export class SessionFileReadLedger {
  private readonly seen = new Set<string>();

  add(path: string): void {
    this.seen.add(path);
  }

  has(path: string): boolean {
    return this.seen.has(path);
  }

  /** How many paths are credited — for a test that has to prove the set moved. */
  get size(): number {
    return this.seen.size;
  }

  /**
   * The rule: a path this session has seen may be written; a path that does not
   * exist may be written (`#write-tool-behavior`: *"This constraint doesn't
   * apply to new files."*); anything else is refused with
   * {@link readBeforeWriteRefusal}.
   *
   * Async because Pi's every write goes through it and the existence probe is
   * the only I/O the gate does.
   */
  async refuseUnseenWrite(path: string): Promise<string | undefined> {
    if (this.seen.has(path)) return undefined;
    const exists = await stat(path).then(() => true, () => false);
    return exists ? readBeforeWriteRefusal(path) : undefined;
  }

  /**
   * The same rule where the caller cannot await.
   *
   * codex's approval answer path (`CodexAgent.handleServerRequest`) returns the
   * response frame from a synchronous notification handler, beside
   * `floorVerdict` and `deniedPathVerdict`, both of which are sync for the same
   * reason. One `existsSync` per approval is the whole cost, and an approval is
   * already a round trip to a human.
   */
  refuseUnseenWriteSync(path: string): string | undefined {
    if (this.seen.has(path)) return undefined;
    return existsSync(path) ? readBeforeWriteRefusal(path) : undefined;
  }
}
