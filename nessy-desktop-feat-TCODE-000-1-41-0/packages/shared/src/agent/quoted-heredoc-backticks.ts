/**
 * F1.761 — a QUOTED heredoc body is text, and a backtick in it is a character.
 * F1.1081 — so is a quoted heredoc opened inside `$(…)`, and so is a
 * single-quoted string.
 *
 * ## What went wrong
 *
 * The `deniedPaths` floor's shell reader (`extractShellPathTokens` in
 * `mode-manager.ts`) tokenises the WHOLE command string, heredoc bodies
 * included. Since P6.673 a token carrying a backtick is an unreadable command
 * substitution, and a substitution can stand for any segment a denied pattern
 * spells — so a markdown plan written with `cat > plan.md <<'EOF'`, whose body
 * puts a path in backticks the way markdown does, was refused by the
 * double-star dot-env entry ("Sensitive path blocked"). Met by the 1.41.0
 * sittings SIT-f and SIT-g; re-measured by DN-029 on 2026-09-26 in all four
 * quoted spellings, with the same body minus its backticks allowed.
 *
 * F1.761 fixed the top-level heredoc only, because the P3.329 model it reused
 * skips a heredoc opened inside `$(…)` or a quote. That left the commit recipe
 * agents use every day — `git commit -m "$(cat <<'EOF' … EOF)"` with a
 * backticked path in the message — refused, and with it a single-quoted
 * `git commit -m 'fix …'` or `echo 'see …'` carrying one (DN-029's residue,
 * re-measured REFUSED at 17acba032 by DN-278 on 2026-09-29).
 *
 * ## The shell's rule
 *
 * bash(1), "Here Documents": "If any characters in word are quoted, the
 * delimiter is the result of quote removal on word, and the lines in the
 * here-document are not expanded. If word is unquoted, all lines of the
 * here-document are subjected to parameter expansion, command substitution,
 * and arithmetic expansion." bash(1), QUOTING: "Enclosing characters in single
 * quotes preserves the literal value of each character within the quotes."
 * And a `$(…)` opens a fresh command, so both rules hold inside it — even when
 * the `$(…)` itself sits in a double quote. A backtick in a double quote, in an
 * unquoted heredoc body or in plain command text really is a substitution.
 *
 * ## What this does, and deliberately does not do
 *
 * It rewrites each LITERAL backtick — one inside a single-quoted string, or in
 * a non-expanding heredoc body, at the top level or inside `$(…)` — to a space,
 * and leaves every other character where it was (the length is unchanged). The
 * text is still read: a literal path in it keeps the verdict it had, and so
 * does a `$HOME` or `$(…)` spelling. It is NOT dropped, because quoted text is
 * not always inert data — `bash <<'EOF'` runs its body — and HEAD refused
 * `bash <<'EOF'` + `cat ~/.aws/credentials`, a refusal dropping the body would
 * have given up. Only the backtick changes meaning, because it is the one
 * character markdown puts around nearly every path.
 *
 * Which bodies count as heredocs, and which of them expand, is the P3.329 model
 * in `pi-harness/claude-bash-rule.ts` ({@link readHeredocDelimiter},
 * {@link consumeHeredocBody}, and for the fallback {@link findHeredocBodySpans}
 * and {@link heredocOpenerExpands}) — one heredoc reading for the rule splitter
 * and this floor, not two. What this file adds is only WHERE a `<<` counts: at
 * the top level or directly inside one `$(…)`, never inside a nested
 * parenthesis or `$((…))`, where `<<` may be a left shift.
 *
 * ## When the reader is unsure, it changes nothing
 *
 * Rewriting a backtick can only ever REMOVE a refusal, so every construct the
 * reader does not model returns the old reading rather than a guess: an
 * unterminated quote, backtick or `$(…)`, a `)` with nothing open (a `case`
 * arm), a `<<` inside a nested parenthesis, a heredoc delimiter the model cannot
 * read, a newline that could start a body queued in another frame. Then the
 * F1.761 top-level pass runs alone, which is exactly what HEAD did. A backtick
 * inside a real substitution (a backtick span, a `$'…'` string) is never
 * rewritten either.
 *
 * ## Residue, stated
 *
 * Quoted text fed to an inner shell (`bash <<'EOF'`, `ssh host <<'EOF'`,
 * `bash -c '…'`, `eval '…'`) does run its backticks there. After F1.761 and
 * F1.1081 a name the inner shell SPLICES together from backtick substitutions —
 * and never spells between them — is no longer refused inside such text. The
 * text between the backticks is still read as paths, and `$`-spelled
 * expansions are untouched. This matches the floor's documented reach:
 * `permissions.md#read-and-edit` says deny rules "don't apply to arbitrary
 * subprocesses that read or write files indirectly", and the OS-level answer is
 * the sandbox, which is off by owner decision.
 */
import {
  consumeHeredocBody,
  findHeredocBodySpans,
  heredocOpenerExpands,
  readHeredocDelimiter,
} from './pi-harness/claude-bash-rule.ts';

export function neutralizeQuotedHeredocBackticks(command: string): string {
  if (!command.includes('`')) return command;
  return neutralizeLiteralBackticks(command) ?? neutralizeTopLevelQuotedHeredocBodies(command);
}

/** A heredoc opened on the current line, waiting for the newline that starts its body. */
interface PendingHeredoc {
  readonly delimiter: string;
  readonly stripTabs: boolean;
  readonly expands: boolean;
}

/** The top level or the inside of one `$(…)` (`cmd`), or a double quote (`dq`). */
interface Frame {
  readonly kind: 'cmd' | 'dq';
  /** Plain parentheses open in this command frame (a subshell, a `$((…))` operand). */
  parens: number;
  /** False inside `$((…))`, where `<<` is a left shift and opens nothing. */
  readonly heredocs: boolean;
  pending: PendingHeredoc[];
}

/** Characters after which an unquoted `#` starts a comment (bash(1), COMMENTS: "a word beginning with #"). */
const WORD_BREAK = /[\s;&|()<>]/;

/**
 * The command with every literal backtick replaced by a space, or `null` when
 * the reader met something it does not model (see the module docblock).
 */
function neutralizeLiteralBackticks(command: string): string | null {
  const literalSpans: Array<readonly [start: number, end: number]> = [];
  const stack: Frame[] = [{ kind: 'cmd', parens: 0, heredocs: true, pending: [] }];
  let wordStart = true;
  let index = 0;
  while (index < command.length) {
    const frame = stack[stack.length - 1]!;
    const current = command[index]!;
    if (current === '\\') { index += 2; wordStart = false; continue; }
    if (current === '`') {
      // A real substitution in either frame; its text keeps its reading.
      const close = closingBacktick(command, index + 1);
      if (close === -1) return null;
      index = close + 1;
      wordStart = false;
      continue;
    }
    if (current === '$' && command[index + 1] === '(') {
      stack.push({ kind: 'cmd', parens: 0, heredocs: command[index + 2] !== '(', pending: [] });
      index += 2;
      wordStart = true;
      continue;
    }
    if (frame.kind === 'dq') {
      if (current === '"') stack.pop();
      index += 1;
      continue;
    }
    if (current === '$' && command[index + 1] === "'") {
      // ANSI-C quoting: `\'` does not close it. Skipped, not rewritten.
      const close = closingAnsiCQuote(command, index + 2);
      if (close === -1) return null;
      index = close + 1;
      wordStart = false;
      continue;
    }
    if (current === "'") {
      const close = command.indexOf("'", index + 1);
      if (close === -1) return null;
      literalSpans.push([index + 1, close]);
      index = close + 1;
      wordStart = false;
      continue;
    }
    if (current === '"') {
      stack.push({ kind: 'dq', parens: 0, heredocs: false, pending: [] });
      index += 1;
      wordStart = false;
      continue;
    }
    if (current === '#' && wordStart) {
      const newline = command.indexOf('\n', index);
      index = newline === -1 ? command.length : newline;
      continue;
    }
    if (current === '(') { frame.parens += 1; index += 1; wordStart = true; continue; }
    if (current === ')') {
      if (frame.parens > 0) {
        frame.parens -= 1;
      } else {
        // A `)` with nothing open is a `case` arm (or a typo): not modelled.
        if (stack.length === 1 || frame.pending.length > 0) return null;
        stack.pop();
      }
      index += 1;
      wordStart = true;
      continue;
    }
    if (current === '<' && command[index + 1] === '<') {
      if (command[index + 2] === '<') { index += 3; wordStart = true; continue; }
      if (!frame.heredocs) { index += 2; wordStart = true; continue; }
      if (frame.parens > 0) return null;
      const opener = readHeredocDelimiter(command, index + 2);
      if (opener === null) return null;
      frame.pending.push({ delimiter: opener.delimiter, stripTabs: opener.stripTabs, expands: opener.expands });
      index = opener.next;
      wordStart = false;
      continue;
    }
    if (current === '\n') {
      if (stack.some(other => other !== frame && other.pending.length > 0)) return null;
      let cursor = index + 1;
      for (const doc of frame.pending) {
        const end = consumeHeredocBody(command, cursor, doc);
        // An expanding body is skipped whole: its quotes are text, and its
        // backticks and `$(…)` are the substitutions they look like.
        if (!doc.expands) literalSpans.push([cursor, end]);
        cursor = end;
      }
      frame.pending = [];
      index = cursor;
      wordStart = true;
      continue;
    }
    wordStart = WORD_BREAK.test(current);
    index += 1;
  }
  if (stack.length > 1) return null;
  return rewriteBackticks(command, literalSpans);
}

/** The offset of the backtick that closes a backtick span opened before `from`, or -1. */
function closingBacktick(command: string, from: number): number {
  for (let index = from; index < command.length; index++) {
    if (command[index] === '\\') { index += 1; continue; }
    if (command[index] === '`') return index;
  }
  return -1;
}

/** The offset of the `'` that closes a `$'…'` string whose text starts at `from`, or -1. */
function closingAnsiCQuote(command: string, from: number): number {
  for (let index = from; index < command.length; index++) {
    if (command[index] === '\\') { index += 1; continue; }
    if (command[index] === "'") return index;
  }
  return -1;
}

/** Length-preserving, so every span offset still holds after the ones before it. */
function rewriteBackticks(command: string, spans: ReadonlyArray<readonly [number, number]>): string {
  let out = command;
  for (const [start, end] of spans) {
    out = out.slice(0, start) + out.slice(start, end).replace(/`/g, ' ') + out.slice(end);
  }
  return out;
}

/**
 * F1.761's top-level pass, kept as the fallback for a command the reader above
 * is unsure of — that is, exactly what HEAD did before F1.1081.
 */
function neutralizeTopLevelQuotedHeredocBodies(command: string): string {
  let out = command;
  for (const span of findHeredocBodySpans(command)) {
    // One span can hold every body opened on one line; if ANY of them expands,
    // the whole span keeps its reading (the model's own conservative rule).
    if (heredocOpenerExpands(command, span)) continue;
    out = out.slice(0, span.start) + out.slice(span.start, span.end).replace(/`/g, ' ') + out.slice(span.end);
  }
  return out;
}
