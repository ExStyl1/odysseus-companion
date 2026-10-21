/**
 * Bash output limits (P2.355) — `tools-reference.md#timeout-and-output-limits`
 * and its `#output-limits` subsection, which had never been read on this
 * subject.
 *
 * ## Why the numbers, not just a cap
 *
 * A model reading a truncated tool result cannot tell truncation from
 * completion. It can only do so if the numbers we cut at are the numbers the
 * page promises, and if the cut announces itself. A single hard-coded ceiling
 * gets the host home safely and tells the model nothing.
 *
 * ## The documented limits, and which of them live here
 *
 * **Re-read against the live page 2026-09-03 (W3-c). Both anchors resolve on the
 * RENDERED page — `id="timeout-and-output-limits"` and `id="output-limits"` —
 * and every sentence below is byte-identical to the one it was quoted from, so
 * the page has not moved under this module.**
 *
 * **The count in this heading was FIVE and the enumeration is SIX**, which is
 * the prose-beside-a-list drift `AGENTS.md` warns about: the row that opened
 * this folded "30,000 read-back" and "roughly 30,000 characters inline for a
 * valid result" into one number because they share a value. The page says in
 * as many words that they are different limits — "It does not raise the inline
 * ceilings above: a valid result over roughly 30,000 characters arrives as a
 * file path plus preview regardless of this variable" — and the constants below
 * already keep them apart on purpose ({@link BASH_VALID_INLINE_CHARS}). Read
 * the constants, not this sentence. Six: the 5 GB stream kill, the ~30,000-char
 * valid inline ceiling, the 64 MiB working-file truncation, the ~10,000-char
 * failure inline ceiling, the 30,000-char read-back default, and its
 * 150,000-char hard ceiling.
 *
 * Two shape what the MODEL SEES and are implemented here; the rest shape what
 * the HOST SURVIVES and are deliberately deferred — see the block at the
 * bottom. Verbatim:
 *
 * > Claude Code streams a command's output to a working file as the command
 * > runs; a command whose output passes 5 GB is killed.
 *
 * > | Valid   | Inline up to roughly 30,000 characters; past that, the path of a
 * > file saved to the session directory, truncated past 64 MiB, plus a short
 * > preview from the start, and Claude reads or searches the file when it needs
 * > the rest |
 * > | Failure | Inline up to roughly 10,000 characters; past that, a
 * > head-and-tail excerpt of that size cut from the read-back window, with no
 * > file path |
 *
 * > `BASH_MAX_OUTPUT_LENGTH` sets how many characters of output Claude Code
 * > reads back from the working file into a command's result: 30,000 by default,
 * > up to a hard ceiling of 150,000.
 *
 * > Raising it enlarges the read-back window, and the window a failing command's
 * > excerpt is cut from. It does not raise the inline ceilings above: a valid
 * > result over roughly 30,000 characters arrives as a file path plus preview
 * > regardless of this variable.
 *
 * ## WIRED — the failure half, on the Pi/host Bash path (P2.366, P2.367)
 *
 * `agent/local-tools/runtime.ts`'s `bash()` calls {@link applyBashOutputLimits}
 * with the command and its exit code, which is the one place both are in hand.
 * That makes `BASH_MAX_OUTPUT_LENGTH` do something on Pi — it had been honoured
 * by the Claude subprocess (the vendored binary carries the name nine times) and
 * by nothing on the other runtime, so an operator setting it got documented
 * behaviour on one and silence on the other.
 *
 * ## What is deliberately NOT wired, and why the row's premise was wrong
 *
 * This header used to say "we have no such file, so a valid result over the
 * inline ceiling currently has nowhere to go but truncation. This is the largest
 * of the three." **Measured 2026-08-29, that is false.** `LocalToolRuntime`
 * already runs every local tool result — bash included — through
 * `guardLargeResult`, which saves an oversized result to the session's
 * `long_responses/` directory and hands the model a preview plus a path it can
 * Read or Grep. The documented file tier EXISTS; it simply uses a token
 * threshold rather than the page's character one: `tokenLimitFor`, measured, is
 * 12 000 tokens on a 262 000-window model and 4 096 on a 40 960-window one.
 *
 * Twelve thousand tokens is roughly 48 000 characters — MORE than the page's
 * 30 000-character inline ceiling. So adopting the documented number for a VALID
 * result would show the model LESS while deleting nothing that is broken, and
 * cutting at 30 000 ahead of the guard would destroy output the guard currently
 * preserves in a file. The valid row is therefore left alone on purpose. It is a
 * different tuning of a working mechanism, not a missing one.
 *
 * The failure row is the opposite case, and it is where the model was actually
 * being hurt: a failing command's message is at the END, and every cut on that
 * path was head-only. Below the guard's threshold the outer 64 KiB byte cap in
 * `tool-executor.ts` head-truncated it (and split its budget between `content`
 * and `error`, which for a bash failure hold the SAME string); above it, the
 * tail went into a file. The page's answer is a head-and-tail excerpt with no
 * file path, and that is what is wired.
 *
 * That parenthetical is CLOSED by P2.391: `boundExecutionResult` now charges a
 * duplicated payload once, so a failure gets the same byte budget a success of
 * the same size gets. It mattered here in the unit gap — 10,000 Cyrillic
 * characters are 20,000 bytes, and the halved-then-split budget was ~16 KiB, so
 * the outer cap re-cut the excerpt head-only and removed exactly the tail this
 * module had shaped it to keep.
 *
 * ## Residue, stated rather than hidden
 *
 * - A large FAILURE no longer gets a `long_responses/` file. That is what the
 *   page specifies, and the tail it buys is the half a failure's reader needs.
 * - The outer 64 KiB byte cap in `agent/pi-harness/tool-executor.ts`
 *   (`DEFAULT_TOOL_RESULT_MAX_BYTES`) still applies to every result and still
 *   counts BYTES. Failures are now cut in characters before reaching it, so the
 *   unit mismatch is narrowed rather than closed: a valid non-ASCII result can
 *   still meet a byte cap the page states in characters.
 * - The two remaining 64 KiB caps — `child-session-service.ts`
 *   (`MAX_RESULT_BYTES`) and `process-supervisor.ts`
 *   (`MAX_FOREGROUND_STREAM_BYTES`) — are not on the model's BASH-result path,
 *   which is all this sentence ever established. It also said "untouched", and
 *   both are now measured and documented by P2.393; **and "not the Bash path"
 *   is not "not a model path"** — the child-session cap bounds the string
 *   `get_subagent_result` hands the parent model.
 * - `DIRECT_SHELL_OUTPUT_LIMIT` in `SessionManager.ts` is NOT this cap. It
 *   bounds the `!` bang-command transcript a human typed. **The "which no model
 *   reads" half of that sentence is FALSE, measured and corrected at the site
 *   (P3.320):** `SessionManager` appends `formatDirectShellTranscript(...)` as a
 *   `role: 'user'` message, so it enters the conversation the model reads on its
 *   next turn. It is still not this cap — it is a different path with its own
 *   limit and its own truncation notice — but it is a MODEL-facing one, so do
 *   not reach for it as the example of a limit no model meets.
 * - P2.393 measured the other two 64 KiB caps and wrote what each protects into
 *   its own docblock. Two results worth knowing here:
 *   `ProcessSupervisor.MAX_FOREGROUND_STREAM_BYTES` bounds two result fields no
 *   production consumer reads; and `child-session-service.ts`'s cap sat on a
 *   second MODEL-facing string that was cut with no marker, which now has one.
 *   **The third claim P2.393 made here — that `output`, from
 *   `ProcessStore.readLog`, has no byte bound at all — is RETRACTED (P3.320).**
 *   Driven rather than read: 205 000 bytes appended, exactly 65 536 read back.
 *   `ProcessStore` keeps a RING at `MAX_LOG_BYTES`. What was true is the
 *   opposite and worse — the ring drops the HEAD and said nothing, the third
 *   path with this module's own defect — and P3.320 gave it a notice and wired
 *   `BASH_MAX_OUTPUT_LENGTH` to size the ring, which is the read-back window
 *   the page names. Of the six numbers only the **5 GB kill** is absent
 *   anywhere, and P2.355 closed that last one as a POSTURE rather than as a
 *   gap — the measurement is in the deferred section at the foot of this file.
 *
 * ## One documented limit that arrived AFTER this module (W3-c, 2026-09-03)
 *
 * The sibling section `tools-reference.md#memory-limit-on-linux-and-wsl` is new
 * to this module's reading: "On Linux and WSL, set `CLAUDE_CODE_TOOL_MEMORY_LIMIT`
 * to a size such as `4G` to cap the memory that Bash, PowerShell, and Monitor
 * tool commands can use" — with "Requires Claude Code v2.1.233 or later", which
 * the vendored bundle is at or past (it was EXACTLY 2.1.233 when this was
 * written; for TODAY read the two self-reports), and "Before v2.1.246,
 * Monitor tool commands ran outside the cap." It is a memory cap rather than an
 * output cap, so it is out of this module's subject; it is named here because it
 * is the operator-facing sibling of these numbers and nothing in the tree reads
 * that variable. Reported as a finding, not implemented.
 */

import { resolveNumericSetting } from './numeric-setting.ts'

export type BashOutputLimitsEnvRecord = Record<string, string | undefined>

/** The Nessy spelling of the read-back window. */
export const BASH_MAX_OUTPUT_LENGTH_ENV = 'NESSY_BASH_MAX_OUTPUT_LENGTH'

/** The documented Claude spelling, accepted as a compat alias. */
export const BASH_MAX_OUTPUT_LENGTH_COMPAT_ENV = 'BASH_MAX_OUTPUT_LENGTH'

/** "30,000 by default" — CHARACTERS, not bytes. */
export const BASH_READ_BACK_CHARS_DEFAULT = 30_000

/** "up to a hard ceiling of 150,000." */
export const BASH_READ_BACK_CHARS_MAX = 150_000

/**
 * "Inline up to roughly 30,000 characters" for a valid result.
 *
 * Equal to {@link BASH_READ_BACK_CHARS_DEFAULT} by coincidence of the page's
 * numbers, NOT by derivation — "It does not raise the inline ceilings above",
 * so raising the read-back window must leave this one where it is. Kept as its
 * own constant precisely so a future edit cannot collapse the two.
 */
export const BASH_VALID_INLINE_CHARS = 30_000

/** "Inline up to roughly 10,000 characters" for a failure. */
export const BASH_FAILURE_INLINE_CHARS = 10_000


/**
 * How many characters to read back from the working file into the result.
 *
 * Defaults to 30,000 and is CLAMPED to the documented 150,000 hard ceiling
 * rather than honoured past it — the page calls 150,000 a ceiling, not a
 * suggestion. A malformed or zero value takes the default: an operator typo must
 * not silently reduce the window to nothing.
 */
export function resolveBashReadBackChars(
  env: BashOutputLimitsEnvRecord = process.env,
): number {
  // P6.565 · GENERAL rule, routed by this key's own page row. `env-vars.md`'s
  // Variables paragraph reads *"Numeric variables such as timeouts, token
  // budgets, and retry counts accept scientific notation and digit-separator
  // spellings in addition to plain digits, except where a variable's row notes
  // it takes plain digits only"* — and `BASH_MAX_OUTPUT_LENGTH`'s row notes
  // nothing of the kind, so `2e3` and `64_000` are legal spellings here. The
  // local `/^\d+$/` this replaced was the house convention applied without
  // reading the row, which is what P6.440 corrected upstream and P6.565 finishes.
  const name = env[BASH_MAX_OUTPUT_LENGTH_ENV] !== undefined
    ? BASH_MAX_OUTPUT_LENGTH_ENV
    : BASH_MAX_OUTPUT_LENGTH_COMPAT_ENV
  const value = resolveNumericSetting(name, env[name], BASH_READ_BACK_CHARS_DEFAULT)
  // Zero keeps the default rather than emptying the window — an operator typo
  // must not silently reduce the read-back to nothing. Not a rejection, so it is
  // not reported: `0` is a value this key simply does not honour.
  if (value === 0) return BASH_READ_BACK_CHARS_DEFAULT
  // CLAMPED, not rejected: the page calls 150,000 a ceiling, not a suggestion,
  // which is why no `max` is passed to the parser.
  return Math.min(value, BASH_READ_BACK_CHARS_MAX)
}

/**
 * The commands whose exit 1 is a valid result rather than a failure, verbatim:
 *
 * > A command that exits 1 counts as a valid result for the Bash tool only when
 * > Claude Code recognizes exit code 1 as a benign outcome for that command:
 * > `grep`, `rg`, `egrep`, `fgrep`, `find`, `diff`, `test`, and `[`, plus
 * > `git diff` and `git grep`. Every other command that exits 1 counts as a
 * > failure, even when exit 1 is a benign informational outcome: no matches for
 * > `pgrep` and `jq -e`, files that differ for `cmp`.
 *
 * The list is closed on purpose. `pgrep`, `jq -e` and `cmp` are named as the
 * commands that DO count as failures despite a benign exit 1, so do not "fix"
 * them in.
 */
const BENIGN_EXIT_ONE_HEADS = new Set(['grep', 'rg', 'egrep', 'fgrep', 'find', 'diff', 'test', '['])

/** The two that need a subcommand as well: `git diff` and `git grep`. */
const BENIGN_EXIT_ONE_GIT_SUBCOMMANDS = new Set(['diff', 'grep'])

/**
 * Whether exit code 1 is a benign outcome for this command's head.
 *
 * For `git`, the subcommand is the first token that is neither a flag nor a
 * `key=value` pair, so `git -c core.pager=cat diff` is recognized as `git diff`.
 * A global option that takes a SEPARATE argument (`git -C /path diff`) is not
 * unpicked — that argument is read as the subcommand and the result classifies
 * as a failure. Over-strict, which is the safe side: a failure classification
 * gives the model the smaller excerpt, never a silently larger one.
 */
export function isBenignExitOne(command: string): boolean {
  const tokens = command.trim().split(/\s+/).filter(token => token.length > 0)
  const head = tokens[0]
  if (head === undefined) return false
  const name = head.slice(head.lastIndexOf('/') + 1)
  if (name === 'git') {
    const sub = tokens.slice(1)
      .find(token => !token.startsWith('-') && !token.includes('='))
    return sub !== undefined && BENIGN_EXIT_ONE_GIT_SUBCOMMANDS.has(sub)
  }
  return BENIGN_EXIT_ONE_HEADS.has(name)
}

/**
 * Which of the two rows in the page's table this result takes. The distinction
 * is the one that decides whether the model gets ~30,000 characters or ~10,000,
 * so it is part of the same contract as the sizes themselves.
 */
export function classifyBashResult(input: {
  command: string
  exitCode: number | null
}): 'valid' | 'failure' {
  if (input.exitCode === 0) return 'valid'
  if (input.exitCode === 1 && isBenignExitOne(input.command)) return 'valid'
  return 'failure'
}

/**
 * "a head-and-tail excerpt of that size cut from the read-back window".
 *
 * Keeps exactly {@link BASH_FAILURE_INLINE_CHARS} characters of the original —
 * the head half and the tail half — with a marker naming how many characters
 * were dropped. The marker is ADDITIONAL to that size, so the excerpt is the
 * promised size rather than the promised size minus the apology; the marker is
 * what lets a model tell truncation from completion, which is the whole point of
 * the row, so it is never the thing that gets squeezed out.
 */
export function buildBashFailureExcerpt(
  text: string,
  limit: number = BASH_FAILURE_INLINE_CHARS,
): string {
  if (limit <= 0) return ''
  if (text.length <= limit) return text
  const head = Math.ceil(limit / 2)
  const tail = limit - head
  const dropped = text.length - limit
  const marker = `\n… [${dropped} of ${text.length} characters omitted] …\n`
  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(text.length - tail) : ''}`
}

/**
 * Shape one Bash result the way `tools-reference.md#output-limits` says it is
 * shaped — the wiring P2.355 landed without and P2.366/P2.367 exist to supply.
 *
 * VALID results pass through untouched: `LocalToolRuntime.guardResult` already
 * gives them the documented file-plus-preview tier at a threshold more generous
 * than the page's, and re-cutting them here at 30 000 characters would show the
 * model less while destroying output that tier preserves. See the module header.
 *
 * FAILURES get the page's own answer:
 *
 * > | Failure | Inline up to roughly 10,000 characters; past that, a
 * > head-and-tail excerpt of that size cut from the read-back window, with no
 * > file path |
 *
 * The excerpt is cut from the READ-BACK WINDOW, not from the whole output, which
 * is the documented meaning of `BASH_MAX_OUTPUT_LENGTH` and its documented
 * reason to exist: "Raising it enlarges the read-back window, and the window a
 * failing command's excerpt is cut from." So when the output is longer than that
 * window, the excerpt's tail is the end of the WINDOW rather than the end of the
 * command — and this says so, in the result, with the variable's name in it.
 * A model that cannot tell truncation from completion is the whole defect; a
 * marker that quietly misdescribes which end it kept would be the same defect
 * wearing an apology.
 *
 * `exitCode: null` — a command killed by a signal, or one whose code never
 * arrived — classifies as a failure, which is the side that shows the tail.
 */
export function applyBashOutputLimits(input: {
  command: string
  exitCode: number | null
  text: string
  env?: BashOutputLimitsEnvRecord
}): string {
  if (classifyBashResult({ command: input.command, exitCode: input.exitCode }) === 'valid') {
    return input.text
  }
  const window = resolveBashReadBackChars(input.env)
  const readBack = input.text.slice(0, window)
  const excerpt = buildBashFailureExcerpt(readBack)
  if (input.text.length <= window) return excerpt
  return `${excerpt}\n[read back ${window} of ${input.text.length} characters; `
    + `raise ${BASH_MAX_OUTPUT_LENGTH_COMPAT_ENV} to widen the window this excerpt is cut from]`
}

/**
 * ## Deferred, deliberately — the host-survival half
 *
 * Three of the page's limits are NOT implemented here, and their absence is a
 * recorded divergence rather than an oversight. They bound what the HOST
 * survives, not what the model sees, and the difference matters: a model given
 * the wrong inline size silently misreads a result on every single call, while
 * these three only bite on an output large enough that our existing 64 KiB caps
 * have already cut it long before.
 *
 * - **5 GB kill — NOT implemented, and the reason is a mechanism rather than an
 *   omission (P2.355 closed, 2026-09-03).** "a command whose output passes 5 GB
 *   is killed." The page needs that kill because Claude Code streams a command's
 *   output to a working FILE that grows without bound; the kill is what stops a
 *   runaway command from filling a disk. **Our path has no such accumulator, so
 *   the failure the kill prevents cannot occur here.** Every place a chunk could
 *   pile up is already bounded, read from the code rather than assumed:
 *
 *     `ProcessStore.append`  ->  `writeFile(this.logPath(handle), combined.subarray(drop))`
 *     `appendBoundedStream`  ->  `if (remaining <= 0) return current`
 *
 *   The first is the RING (`MAX_LOG_BYTES`, sized by `BASH_MAX_OUTPUT_LENGTH`
 *   since P3.320): the log file is rewritten at the limit on every chunk, so a
 *   5 GB command leaves a 64 KiB file. The second bounds the foreground
 *   `stdout`/`stderr` captures at 64 KiB. The third path, `request.onStdout`, is
 *   a per-chunk callback that stores nothing — its consumer owns its own bound.
 *
 *   **So this is a product posture and it is stated rather than queued:** we do
 *   not kill a command for being loud. A build that prints 5 GB completes, its
 *   last 64 KiB reaches the model with the ring's truncation notice, and the
 *   user's own interrupt or the tool's timeout is what stops it. Adopting the
 *   page's number would mean killing work that currently succeeds, to prevent a
 *   disk fill that our own design already prevents — a behaviour change dressed
 *   as parity.
 *
 *   **The residue, named because it is real:** the ring re-reads and rewrites
 *   its whole window per chunk, so a 5 GB output costs O(n x limit) of file I/O
 *   even though it costs O(limit) of disk. That is a cost the page's design does
 *   not have, and it is the honest thing to weigh if this is ever revisited — a
 *   streaming counter is worth building for THAT reason, not for the kill.
 * - **64 MiB working-file truncation.** "truncated past 64 MiB" — needs a
 *   working file per command, which `long_responses/` is not: that file is
 *   written once from the finished result, so there is nothing to truncate
 *   while a command is still producing output.
 * - **The session-directory output file and its preview.** "the path of a file
 *   saved to the session directory … plus a short preview from the start" —
 *   **this one is NOT missing, and the claim that it was is retracted (measured
 *   2026-08-29).** `LocalToolRuntime.guardResult` → `guardLargeResult` →
 *   `saveLargeResponse` writes exactly that file, into the session's
 *   `long_responses/` directory, and returns a preview the model can follow with
 *   Read or Grep. What differs from the page is the THRESHOLD — 12 000 tokens on
 *   a 262 000-window model rather than 30 000 characters — and that difference
 *   is more generous, not less. What is genuinely absent is the STREAMING half:
 *   the page's file is written as the command runs, ours after it finishes, so a
 *   command killed mid-flight leaves nothing behind. That, not the file, is the
 *   real gap here.
 */
