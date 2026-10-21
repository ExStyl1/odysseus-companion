/**
 * Claude Bash permission-rule matching (permissions.md § Bash, hooks.md § if).
 *
 * Pure string semantics, no I/O. The contract source is
 * `code.claude.com/docs/en/permissions.md` (re-fetched 2026-07-26) plus the
 * hook `if` matching table in `hooks.md`; the distilled record is
 * `docs/superpowers/specs/2026-07-26-r-queue-doc-verification.md` § R1.
 *
 * The deliberate fail-closed choices that go beyond the documented text, in no
 * particular order and DELIBERATELY UNCOUNTED — this header said "Three" over
 * four bullets, and the count had been wrong since the fourth was added (P2.90;
 * `tokenizePowerShell`'s "Both scans" over three is the same class). A header
 * that enumerates its own body goes stale the moment the body grows, and
 * nothing checks it, so this one no longer tries:
 * - An allow rule containing a glob never matches a subcommand that carries
 *   command substitution (`$(…)` or backticks outside single quotes) — a
 *   prefix rule must not auto-approve embedded command execution. A glob-free
 *   exact rule still matches its literal string, mirroring the documented
 *   exec-wrapper exact-match escape hatch. The veto covers command execution
 *   only: ARITHMETIC expansion `$((…))` runs nothing, so it is not vetoed
 *   (a substitution nested inside it, `$(( $(id -u) ))`, still is).
 * - A DENY or ASK rule matches inside command-substitution spans, while an
 *   allow rule keeps the top-level view. permissions.md's § Compound commands
 *   names separators only (`&&`, `||`, `;`, `|`, `|&`, `&`, newlines) and never
 *   says what a rule sees inside `$(…)`, so this is our choice — but it is the
 *   direction the page's own asymmetry points: "A deny or ask rule matches past
 *   any leading assignment, so `Bash(rm *)` in deny still matches
 *   `FOO=bar rm -rf tmp/`" (§ Wrappers), and for paths "**Deny and ask rules**:
 *   `Read(secrets/**)` matches a directory named `secrets` at any depth". The
 *   inverse would be the vulnerability: `deny Bash(rm:*)` missed
 *   `echo $(rm -rf ./x)` until 2026-08-21, so wrapping a denied command in a
 *   substitution walked through the deny floor. Allow must NOT gain the same
 *   reach — an allow match on one span would not establish the whole call is
 *   safe, which is the reason the page itself gives for allow's narrower
 *   parameter matching.
 * - Anything the scanner cannot balance (quotes, `$(`, backticks, parens) and
 *   anything over 10 000 characters is `'unparseable'`; the caller decides the
 *   posture. Both documented postures are a non-deny: the DSL prompts
 *   (permissions.md:210 — an unparseable command, and anything past 10 000
 *   characters, "asks for approval"), and the hook `if` consumer fails fully
 *   open per hooks.md.
 * - Three shell FORMS a glob allow rule refuses outright, the same way it
 *   refuses an exec wrapper: descriptor redirects beyond the standard streams,
 *   Zsh variable subscripts inside `[[ ]]`, and `help`/`man` carrying an option
 *   that is not known-inert. See `unsafeShellForm`.
 *
 * One further choice runs the OTHER way and is documented at `scanCommand`: a `#`
 * COMMENT TAIL is prose, not command text, so no rule matches through one —
 * EXCEPT in a command carrying `$'` or `<<`, where two guards switch the comment
 * rule off entirely rather than trust this scanner's quote state. That is a
 * narrowing of what every `Bash(...)` rule sees, so the rule this module applies
 * is deliberately a strict subset of the shell's own — read the argument there
 * before widening it, and read the guards before assuming a comment is excised.
 */

export type ClaudeBashMatchResult = 'match' | 'no-match' | 'unparseable'
export type ClaudeBashRuleAction = 'allow' | 'deny' | 'ask'

const MAX_COMMAND_LENGTH = 10_000

/**
 * permissions.md: "Claude Code also strips a leading assignment of certain
 * known-safe environment variables". Only `NODE_ENV` is documented; the rest
 * are display/locale variables that cannot redirect what a command does.
 * Deliberately small — an allow rule refuses to cross anything else.
 */
const KNOWN_SAFE_ENV_VARS = new Set([
  'NODE_ENV', 'LANG', 'LC_ALL', 'TZ', 'NO_COLOR', 'FORCE_COLOR', 'COLUMNS', 'LINES',
])

/** Wrappers stripped before matching; each runs its argument as the command. */
const SIMPLE_WRAPPERS = new Set(['nohup', 'builtin', 'noglob'])
/** Exec wrappers: always prompt, never approvable by a prefix (glob) rule. */
const EXEC_WRAPPERS = new Set(['watch', 'setsid', 'ionice', 'flock'])
const FIND_EXEC_FLAGS = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete'])
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * Shells whose `-c` operand is a COMMAND LINE rather than a filename.
 *
 * `sh -c 'rm -rf ~'` runs `rm`, exactly as `env -S "rm -rf ~"` does and as
 * `echo $(rm -rf ~)` does — and both of those were deny-floor bypasses that had
 * to be closed (`env`/`sudo`/`watch` in `4af8bd1e` per `whats-new/2026-w16.md`;
 * command substitution on 2026-08-21). This one is the same class and was
 * measured open on 2026-08-24: `findRootOrHomeRemoval` returned null for
 * `/bin/zsh -lc 'rm -rf ~'` while firing on the bare, `sudo`- and
 * substitution-wrapped spellings.
 *
 * It is not an exotic spelling either — it is codex's DEFAULT transport. The
 * bundled `codex-app-server`'s `shell_command` tool takes "Shell script to run
 * in the user's default shell" plus `login` ("True runs with login shell
 * semantics … Defaults to true"), so every command a codex turn runs reaches
 * our matcher as `<user shell> -lc '<script>'` (T6 live, 2026-08-23).
 *
 * Names are compared LOWERCASED and without a `.exe` suffix, because that is
 * how the platforms this ships on resolve a command name: `SH -c 'rm -rf ~'`
 * and `Bash -c 'rm -rf ~'` both RUN on the case-insensitive APFS default
 * (measured 2026-08-25 with a `touch` payload), and `bash.exe` is the same
 * program on win32. `csh` and `tcsh` are here because both ship with macOS and
 * both were measured running their `-c` operand. D1.413 — measuring on THIS host
 * is why `fish` was missing (`removal-circuit-breaker.test.ts`); F1.99 added seven more beside it.
 *
 * The set is a list and cannot be anything else — no property of a TOKEN says
 * "shell" — so the class fix is around it, not in it: {@link namesAShell}
 * resolves the spelling (path, case, `.exe`, unresolvable expansion) and
 * {@link shellScriptOperand} reads the option syntax, so adding a name is a
 * one-line change whose effect is pinned in both directions (a real name is
 * recognised; a name that merely CONTAINS one is not — `zshfoo`, `mybash`,
 * `shell`). Before those tests existed, a substring-match mutant of this gate
 * passed the entire suite (P2.152).
 */
const SHELL_INTERPRETERS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', 'nu', 'elvish', 'xonsh', 'ash', 'mksh', 'yash', 'oksh',
])

/**
 * The name a shell would resolve this head to, or null if it cannot be known.
 *
 * Null means UNRESOLVABLE, not "not a shell": a head carrying a parameter
 * expansion or a command substitution (`$SHELL -c …`, `${SHELL} -c …`,
 * `"$SHELL" -c …`) names whatever that expands to, and this module never
 * expands anything.
 *
 * The separator split happens BEFORE {@link literalText}, and that order is
 * load-bearing rather than incidental: `literalText` reads a backslash as an
 * escape and drops it, so literalising first turned
 * `C:\Windows\System32\bash.exe` into `cwindowssystem32bash.exe` — one segment,
 * no separator left to split on, and a win32 shell path resolved to nothing.
 * Splitting first leaves `bash.exe'`-style quoting for `literalText` to strip
 * from the last segment, which is the only place it is still needed.
 */
function resolvedCommandName(token: string): string | null {
  if (DYNAMIC_CONTENT.test(token)) return null
  const base = literalText(token.split(/[\\/]/).at(-1) ?? '')
  if (!base) return null
  const lower = base.toLowerCase()
  return lower.endsWith('.exe') ? lower.slice(0, -4) : lower
}

/**
 * Whether this head may run its `-c` operand as a command line.
 *
 * An UNRESOLVABLE head answers yes, and that is deliberate: `$SHELL -c 'rm -rf
 * ~'` is not an exotic spelling but the phrasing in codex's own `shell_command`
 * tool description, and no amount of static reading can expand a variable. The
 * floor's failure direction is toward FIRING — offering text to a scan that
 * still demands `rm`/`rmdir`/`find` PLUS an exact root-or-home target can only
 * ever add a refusal, never remove one — so a head we cannot prove is not a
 * shell is treated as one. The alternative was matching variable NAMES that
 * look shell-ish, which is the hand-maintained list this change exists to
 * delete.
 */
function namesAShell(token: string): boolean {
  const name = resolvedCommandName(token)
  return name === null || SHELL_INTERPRETERS.has(name)
}

/**
 * The reserved words after which a NEW COMMAND begins.
 *
 * `bash(1)` § Reserved Words lists 22: `! { } case do done elif else esac fi
 * for function if in select then time until while [[ ]] coproc`. They are not
 * commands and they are not separators, which is why the splitter never saw
 * past one: `if true; then rm -rf ~; fi` splits on its `;` into `if true`,
 * `then rm -rf ~` and `fi`, and the middle subcommand's HEAD is `then`, so the
 * removal circuit breaker looked at a head that is not `rm` and returned null.
 * MEASURED OPEN on 2026-08-24 with `true && rm -rf ~` firing as the positive
 * control and `echo hello` quiet as the negative: `if true; then rm -rf ~; fi`
 * and `for i in 1; do rm -rf ~; done` both returned null from
 * `findRootOrHomeRemoval`, and `deny Bash(rm:*)` missed both. A `nonNegotiable`
 * floor was therefore cleared by ordinary shell control flow, on every runtime.
 *
 * Only ELEVEN of the 22 are here, and the split is the fix for a measured FALSE
 * POSITIVE (2026-08-25). The first version of this set took "every reserved
 * word" as the rule, on the argument that a rule with exceptions is a rule to
 * get wrong. But `in` does not introduce a command — its operand is a WORD
 * LIST — so `for opt in rm -rf ~; do echo $opt; done` offered `rm -rf ~` to the
 * scan and fired `home` on a command that removes NOTHING (executed: the loop
 * prints `rm`, `-rf` and the path, and creates and deletes nothing). An
 * un-suppressible prompt on a harmless command is the "floor that cries wolf"
 * failure the module header argues against, so the distinction is not an
 * exception to the rule — it IS the rule, and it is `bash(1)`'s own: a word is
 * followed by a command, by a WORD, or by nothing. See
 * {@link CONSTRUCT_HEADER_WORDS} for the second class and
 * {@link compoundKeywordBodies} for the walk that uses both.
 *
 * `time` is here for uniformity only — {@link stripSubcommand} already strips it
 * as a documented wrapper.
 */
const COMMAND_OPENING_WORDS = new Set([
  '!', '{', 'do', 'elif', 'else', 'if', 'then', 'time', 'until', 'while',
  'coproc',
])

/**
 * The reserved words that open a construct whose next words are NOT a command.
 *
 * `for`/`select` take a NAME then a word list, `case` takes a subject then a
 * pattern, `in` takes a word list, `function` takes a name, `[[` takes a
 * conditional expression. Nothing after them is a command until a
 * {@link COMMAND_OPENING_WORDS} token or a {@link COMPOUND_PATTERN_LABEL}
 * arrives — but reserved words ARE still recognised meanwhile, which is what
 * lets `for ((i=0;i<1;i++)) do …` reach its `do` with no separator in between.
 *
 * So these do not open a body, and they do not end the walk either: they hold
 * it open across their operands. That is the whole difference between them and
 * an ordinary command name, which ends it (see {@link compoundKeywordBodies}).
 *
 * The four CLOSERS (`}`, `fi`, `done`, `esac`, `]]`) are in neither set. No
 * command can follow one without a separator first, and a separator has already
 * split the subcommand — `fi rm -rf ~`, `done rm -rf ~` and `} rm -rf ~` are
 * all rejected by `bash -n` (measured 2026-08-25).
 */
const CONSTRUCT_HEADER_WORDS = new Set(['case', 'for', 'function', 'in', 'select', '[['])

/**
 * A `case` pattern label, after which — exactly like a reserved word — a new
 * command begins.
 *
 * Deliberately the narrowest shape that cannot be anything else: at most one
 * `(`, exactly one `)` at the end, and no quote, `$`, backtick or whitespace
 * anywhere. That admits `(a)`, `a)`, `*)` and `(*.log)` — a command NAME can
 * never be spelled any of those ways — and excludes `$(date)`, `` `id` `` and a
 * subshell like `(rm -rf ~)`, all three of which the substitution-span walk
 * already reaches on its own terms.
 *
 * It does NOT exclude PROCESS SUBSTITUTION on its own: `>(cat)` and 43 sibling
 * spellings satisfy this shape, and the shell reads every one of them as a WORD
 * that becomes the command name. `opensCompoundCommand` rejects them before
 * testing this regex — see {@link opensProcessSubstitution} (P2.180).
 *
 * A function definition's `()` used to ride on this regex, and that was the
 * whole of P2.142's HIGH-1: it matched only when `tokenize` happened to glue
 * the name and the parens into one token that ENDS in `)`. See
 * {@link FUNCTION_DEFINITION_PARENS}, which handles all four spellings instead.
 */
const COMPOUND_PATTERN_LABEL = /^[^()$`'"\s]*\(?[^()$`'"\s]*\)$/

/**
 * A function definition's `()`, with an optional glued NAME before it and an
 * optional glued body after it.
 *
 * `tokenize` keeps `(`…`)` inside one token, so ONE construct — `name ()
 * compound-command`, `bash(1)` § Shell Function Definitions — arrives in four
 * different token shapes depending only on where the author put spaces:
 *
 * | written | tokens |
 * | --- | --- |
 * | `wipe() { … }` | `wipe()`, `{`, … |
 * | `wipe(){ … }` | `wipe(){`, … |
 * | `wipe () { … }` | `wipe`, `()`, `{`, … |
 * | `wipe ( ) { … }` | `wipe`, `( )`, `{`, … |
 *
 * MEASURED 2026-08-25: all four are `bash -n` clean and all four RUN their body
 * in `bash` and in `/bin/sh`, but only the first fired the floor — the other
 * three (plus `function wipe(){ … }`) returned null from `findRootOrHomeRemoval`
 * AND `no-match` from `deny Bash(rm:*)`, so no `'unparseable'` prompt caught them
 * either. This regex normalises all four into the same three tokens before the
 * walk begins, so the spelling stops deciding anything.
 *
 * Captures the name and the glued remainder; anchored on a MANDATORY `(`…`)`
 * pair so a `case` label (`a)`, no `(`) and a subshell (`(ls)`, text inside the
 * parens) both fail it.
 */
const FUNCTION_DEFINITION_PARENS = /^([^()$`'"\s]*)\(\s*\)(.*)$/

interface ScanCallbacks {
  /** Called for each top-level separator; return the number of chars it spans. */
  onSeparator?: (index: number) => number
  /** Called when an outermost `$(`/backtick span closes, with its inner text. */
  onSubstitutionSpan?: (inner: string) => void
  /** Called at the `#` that opens a top-level comment tail; see {@link scanCommand}. */
  onComment?: (index: number) => void
}

/**
 * One open bracket span.
 *
 * `sub` is command substitution (`$(…)`, or a subshell `(…)` at the top level).
 * `arith` is ARITHMETIC EXPANSION `$((…))`, which expands to a number and runs
 * no command — the shell evaluates the expression itself. `paren` is a plain
 * nested group, which never was a span of its own.
 */
type BracketSpan = { kind: 'sub' | 'arith' | 'paren'; start: number }

/**
 * Walks a command respecting single/double quotes, escapes, backtick spans,
 * `$(`/`$((`/`(`…`)` nesting and `#` COMMENT TAILS. Returns false when the input
 * cannot be balanced.
 *
 * A span is reported to `onSubstitutionSpan` when it closes with no enclosing
 * `sub` — arithmetic and plain groups do NOT suppress a substitution nested
 * inside them, so `$(( $(id -u) + 1 ))` still reports `id -u`.
 *
 * ## The comment rule, and why it is DELIBERATELY narrower than the shell's
 *
 * sh comments are not PowerShell's: `#` opens one only at the start of a WORD,
 * so `echo a#b` prints `a#b` while `echo a #b` prints `a`, and a comment ends at
 * the next NEWLINE rather than at end of input. Everything from the `#` to that
 * newline is prose the shell never runs — not a separator, not a substitution,
 * not a redirect (measured 2026-08-23 through `/bin/sh -lc`, the shell the Bash
 * tool actually spawns: `echo x # $(echo BAD)` and ``echo x # `echo BAD` ``
 * print `x`, and `echo x # > /tmp/f` creates no file).
 *
 * What counts as a word start HERE is the SHELL'S blank set, not JavaScript's:
 * space, tab and LF — bash's in-line blanks plus its line terminator, the three
 * things after which bash opens a `#` comment (measured 2026-08-24 through
 * `/bin/sh` and `/bin/bash`, C and en_US.UTF-8: only SP, TAB and a line-leading
 * `#` after LF open a comment). A comment opens only after one of those or
 * start-of-input. Two classes JS `/\s/` matches are DELIBERATELY excluded, both
 * P2.99 holes: VT, FF and a dozen Unicode blanks (NBSP, U+2000–200A, U+3000, the
 * BOM, …) that bash keeps INSIDE a word (`a<NBSP>#` is one word), and a bare CR,
 * which bash does NOT treat as a line terminator (`echo a\r#x ; rm -rf ~` is the
 * word `a\r#x` then a REAL `;` that runs `rm -rf ~`). Opening a comment after any
 * of them excised the real subcommand behind the `#` — a deny that stopped
 * matching a command the shell runs in full. CR is still a separator on the
 * `onSeparator` path (a documented over-fire); it just does not open a comment.
 *
 * Where this rule and the shell's still differ, it opens FEWER comments, never
 * more in the direction that hides text. The shell also opens one after an
 * operator, so `echo a;#b` is a comment to sh and ordinary text to this scanner:
 * `echo one;#rm -rf /` splits to `['echo one', '#rm -rf /']`, whose head is the
 * token `#rm`, so `deny Bash(rm:*)` returns `no-match` — the text is offered to
 * the matcher but no prefix rule can match it. A bare `*` rule does match it.
 * Either way nothing is HIDDEN, which is the property that matters.
 *
 * ## The word-start rule is not enough: THE QUOTE MODEL IS NOT THE SHELL'S
 *
 * A comment rule is only as good as the scanner's idea of what is QUOTED, and
 * this scanner's is not bash's. It does not model **ANSI-C quoting** (`$'…'`),
 * where a backslash escapes and `\'` is a literal quote that does NOT close the
 * string. A scanner that closes there sits at top level while bash is still
 * inside a word; the next blank-preceded `#` reads as a comment and — since a
 * comment runs to end of line — SWALLOWS the real closing quote, which is the
 * very thing that used to make the scanner notice it had lost its place. A parse
 * that failed safe as `'unparseable'` becomes a confident parse of half the
 * command. Measured through `/bin/sh -lc`:
 * `echo $'a\'b # c ; rm -rf /' ; rm -rf /tmp/x \'` prints the whole ANSI-C
 * string and RUNS its second command, and an unguarded comment rule dropped that
 * second command from the split entirely — `deny Bash(rm:*)` went match →
 * no-match, and `allow Bash(git commit:*)` turned a prompt into an approval on
 * `git commit -m $'don\'t # ship'; rm -rf ~`.
 *
 * **The guard, not a model: any command containing `$'` gets NO comment rule at
 * all** and is scanned byte-identically to how it was before comments existed
 * here. This is a deliberate standing choice for this splitter (owner ruling,
 * 2026-08-23): it should be DUMBER, not smarter. Anything we are unsure of falls
 * to `'unparseable'` and prompts, which is what the DSL does with that verdict.
 * The defect above exists precisely BECAUSE the splitter was taught to
 * understand something; a splitter that shrugs and prompts would have been safe.
 *
 * A correct `$'…'` model was built and measured green against the shell before
 * this guard replaced it, and the sweep is why it was replaced rather than kept:
 * modelling produced hundreds of `unparseable -> …` transitions, including nine
 * `allow unparseable -> match` — a prompt becoming an approval, the direction
 * that matters most. The guard produces ZERO transitions on the same inputs.
 * That is the whole argument for dumber: the accurate parser had a strictly
 * larger blast radius than the one that declines to parse.
 *
 * **The second construct of the same class in this file — third in the wave,
 * after PowerShell's `<#` in `claude-powershell-rule.ts` — is sh HEREDOCS.**
 * `cmd <<EOF … EOF` feeds a body to stdin, and every character of that body is
 * inert text to the shell: a quote in it opens nothing. This scanner has no
 * heredoc model, so an apostrophe in the BODY flips `singleQuote` and desyncs it
 * exactly the way `$'` did: it then reads a later REAL opening quote as a CLOSE,
 * sees the `#` inside what bash knows is a quoted word as a top-level word-start
 * `#`, and the comment rule eats the rest of the command — the real closing
 * quote and the subcommand behind it. Measured 2026-08-24 on
 * `cat <<EOF\ndon't\nEOF\necho 'a # b' \' ; rm -rf ~`: the split lost
 * `rm -rf ~` entirely, `deny Bash(rm:*)` went match → no-match, and
 * `findRootOrHomeRemoval` went `{target:'home'}` → null. A QUOTED delimiter
 * (`<<'EOF'`) changes nothing, because the desync is in the body, not the
 * delimiter.
 *
 * **The same guard, not a model: any command containing `<<` gets NO comment
 * rule at all.** Not a heredoc model, deliberately — same owner ruling, and the
 * measurement above is the reason: the accurate parser had the strictly larger
 * blast radius than the one that declines to parse. `<<` also matches two
 * constructs that are not heredocs at all, HERE-STRINGS (`<<<`) and ARITHMETIC
 * left-shift (`$((1<<2))`), and both lose the comment rule too. That direction
 * is the safe one: with the rule off, comment text is scanned as COMMAND text,
 * so every rule sees more than the shell would run, never less. Measured, in
 * both ways it can move: `allow Bash(echo:*)` on `echo <<< hi # $(rm -rf /)`
 * goes match → no-match, because the substitution sitting in the comment is
 * vetoed again — a prompt where there was an approval; and the P2.71 shape comes
 * back for `<<` commands only, where a `#` tail naming `~` re-raises a
 * home-removal prompt for a command that removes one file. Over-firing and
 * `'unparseable'`, never a rescued parse.
 *
 * **THE RULING WAS LIFTED FOR HEREDOCS ON 2026-09-05, AND ONLY FOR HEREDOCS
 * (owner sitting §1.5 = (A); P3.329).** This paragraph's guard is untouched and
 * still correct — a command containing `<<` still gets no comment rule here.
 * What changed is upstream of this scanner: {@link stripHeredocBodies} removes
 * the inert BODY before the text reaches it, because the guard never addressed
 * the body itself. `["cat <<EOF", "rm -rf ~", "EOF"]` was what remained — the
 * non-negotiable removal breaker firing on a heredoc that removes nothing.
 *
 * The lift carried a precondition and the precondition was met: the sitting
 * required §1.6's read-only corpus copy to land first (P2.389) so the change
 * could be WEIGHTED on real traffic rather than argued from an adversarial set.
 * Measured over 19 619 real agent-issued commands
 * (`bun scripts/command-corpus.ts split-diff`): **0 moves on a command with no
 * `<<`**, **0 invented segments** — every string the new reading offers a rule
 * already existed inside a string the old one offered — 3 343 commands whose
 * body lines stopped being read as commands, and 944 rescued from
 * `'unparseable'` (1 012 of the corpus's 1 038 unparseable commands were
 * heredocs). This is therefore the one place in this file where a MODEL beat
 * the guard on measured blast radius, which is the only argument the ruling
 * ever accepted.
 *
 * The dumber-not-smarter posture survives inside it: an unquoted delimiter's
 * body can be expanded by the shell, so a body carrying `$(…)` or a backtick is
 * left exactly where it is rather than excised, and anything the model is not
 * sure of — a heredoc inside a quote, a backtick or a bracket span, a `<<` with
 * no delimiter word — keeps this paragraph's reading untouched.
 *
 * With both guards, AND the shell's blank set (not JS's `/\s/`) driving
 * word-start, the word-start rule stands on lexical facts it can actually reach.
 * Not hiding from a deny rule text the shell would execute is the property this
 * pass targets — and it is one this file has had to earn back more than once: the
 * ANSI-C and heredoc quote desyncs broke it, and so did the word-boundary set —
 * first Unicode blanks, then a bare CR (P2.99) — each letting the comment rule
 * swallow a real subcommand. The claim is scoped to lexical hiding via the comment rule; it is
 * NOT a general statement that this scanner's quoting matches bash's, because it
 * does not.
 *
 * The same subset argument covers the three deliberate non-coverages:
 * - **Top level only.** A `#` inside `$(…)`, a backtick span or a subshell is
 *   scanned exactly as before. Real sh comments there too, and eats the closing
 *   `)` doing it — `echo $(echo a # b)` is `unexpected EOF` and never runs — so
 *   the old behaviour is over-firing on a command the shell refuses outright.
 * - **A lone `\r` ends the comment**, though sh keeps commenting through one
 *   (measured: `echo a # n\recho SECOND` prints only `a`). This splitter already
 *   treats a bare `\r` as a separator; resuming there scans more, never less.
 * - **A comment never crosses a newline**, which is what keeps a following line
 *   visible: `rm ./ok.txt # note\nrm -rf /` still yields `rm -rf /` as its own
 *   subcommand. Swallowing to end-of-input instead would have been the one way
 *   to turn this into a security defect.
 *
 * ## `honourComments`: the knob that lets the two guards be MEASURED (P2.363)
 *
 * Both guards above leave this scanner reporting a subcommand list that
 * disagrees with what the shell executes, and the disagreement was silent —
 * two rows (P2.329, P2.350) were spent on symptoms downstream of it. Setting
 * `honourComments` runs the comment rule IN SPITE of both guards, so the
 * guarded reading and the shell's reading can be compared.
 *
 * That second reading is never TRUSTED as a parse — the desyncs documented
 * above are exactly why it cannot be — it is only ever compared against the
 * guarded one, by {@link splitCompoundCommand}, which refuses the whole command
 * when they differ. Nothing here learns any shell grammar it did not already
 * have; the knob only stops one rule from being switched off.
 */
function scanCommand(
  command: string,
  callbacks: ScanCallbacks,
  ansiCQuotes = false,
  honourComments = false,
): boolean {
  let singleQuote = false
  let doubleQuote = false
  let escaped = false
  let backtickStart = -1
  // Whether the currently open single quote was introduced by `$`. Only ever
  // true when `ansiCQuotes` is set — see {@link splitOnSeparators} for why that
  // is opt-in and which pass opts in (P2.179).
  let ansiCSpan = false
  // The `atWordStart` idiom: a `$` seen on the PREVIOUS iteration, at top level
  // and unescaped, which is the only position where a following `'` opens an
  // ANSI-C literal. Tracked rather than read back from `command[index - 1]` so
  // `\$'…'` — a literal dollar followed by an ordinary quote — is not mistaken
  // for one.
  let pendingDollar = false
  // A word boundary, not the previous character: an escaped or quoted blank
  // keeps the word open, so `echo a\ #b` and `echo a" "#b` both print `a #b`.
  let wordStart = true
  // The ANSI-C guard. See the docstring: this scanner's quote model is not the
  // shell's, so it refuses to reason about comments at all in these commands.
  const ansiCQuoting = command.includes("$'")
  // The heredoc guard, same posture and same reason: a quote character in a
  // heredoc BODY is inert text to the shell and a state change to this scanner.
  const heredocMarker = command.includes('<<')
  // Whether either guard actually silences the comment rule on this pass.
  // `honourComments` overrides both — see the docstring: that pass exists to
  // MEASURE the guards' cost, never to be believed on its own.
  const commentRuleOff = !honourComments && (ansiCQuoting || heredocMarker)
  const spans: BracketSpan[] = []
  const insideSubstitution = () => spans.some(span => span.kind === 'sub')
  for (let index = 0; index < command.length; index++) {
    const current = command[index]!
    const atWordStart = wordStart
    wordStart = false
    const afterDollar = pendingDollar
    pendingDollar = false
    if (escaped) { escaped = false; continue }
    // Inside `$'…'` a backslash ESCAPES, and `\'` is a literal quote that does
    // NOT close the string (`bash(1)`, QUOTING). Inside an ordinary `'…'`
    // nothing escapes, which is why this is conditional on the span.
    if (current === '\\' && (!singleQuote || ansiCSpan)) { escaped = true; continue }
    if (singleQuote) {
      if (current === "'") { singleQuote = false; ansiCSpan = false }
      continue
    }
    if (backtickStart >= 0) {
      if (current === '`') {
        if (!insideSubstitution()) callbacks.onSubstitutionSpan?.(command.slice(backtickStart, index))
        backtickStart = -1
      }
      continue
    }
    if (current === "'" && !doubleQuote) {
      singleQuote = true
      ansiCSpan = ansiCQuotes && afterDollar
      continue
    }
    if (current === '"') { doubleQuote = !doubleQuote; continue }
    if (current === '`') { backtickStart = index + 1; continue }
    if (current === '$' && command[index + 1] === '(') {
      // `$((` opens arithmetic, which executes nothing. Anything that DOES
      // execute inside it (`$(( $(id -u) ))`) still opens its own `sub` span.
      const arithmetic = command[index + 2] === '('
      spans.push({ kind: arithmetic ? 'arith' : 'sub', start: index + (arithmetic ? 3 : 2) })
      index += arithmetic ? 2 : 1
      continue
    }
    // A plain `$`, so the NEXT iteration can tell `$'` from `'`. Assignment
    // only: control flow is untouched, because `onSeparator` answers 0 for `$`
    // and `wordStart` is already false, so this cannot move an existing verdict.
    if (current === '$') pendingDollar = true
    if (current === '(') {
      if (spans.length > 0) spans.push({ kind: 'paren', start: index + 1 })
      else if (!doubleQuote) spans.push({ kind: 'sub', start: index + 1 })
      continue
    }
    if (current === ')') {
      const span = spans.at(-1)
      if (!span) {
        if (!doubleQuote) return false // stray close paren
        continue
      }
      if (span.kind === 'arith') {
        if (command[index + 1] === ')') { spans.pop(); index++; continue }
        // A `$((` that closes on a single `)` was not arithmetic: the shell
        // re-reads it as `$( (…)…)`, two opens. Demote the entry to the outer
        // substitution — this `)` closed the inner group, and the outer one
        // stays open (so `$((1+2)` is still unbalanced).
        spans[spans.length - 1] = { kind: 'sub', start: span.start - 1 }
        continue
      }
      spans.pop()
      if (span.kind === 'sub' && !insideSubstitution()) {
        callbacks.onSubstitutionSpan?.(command.slice(span.start, index))
      }
      continue
    }
    if (doubleQuote || spans.length > 0) continue
    // Opt-in: only `splitCompoundCommand` passes `onComment`, so the balance
    // pass below and `substitutionSpans` keep the parent's exact reading.
    if (current === '#' && atWordStart && !commentRuleOff && callbacks.onComment) {
      callbacks.onComment(index)
      // Skip to just BEFORE the line ending, so the newline still separates.
      let end = index + 1
      while (end < command.length && command[end] !== '\n' && command[end] !== '\r') end++
      index = end - 1
      continue
    }
    // The blank set is the SHELL'S, not JavaScript's, and it is space, tab and LF
    // only. bash's in-line blanks are space and tab; LF is the line terminator,
    // and a `#` at the head of the next line after it IS a comment. Everything
    // else JS `/\s/` matches is EXCLUDED, in two groups, both measured 2026-08-24
    // through `/bin/sh` and `/bin/bash` (C and en_US.UTF-8), each running the tail
    // of `echo a<WS># note ; echo SECOND`:
    //  - VT, FF and a dozen Unicode blanks (NBSP, U+2000–200A, U+3000, the BOM, …)
    //    are ordinary word characters to bash — `a<WS>#` is one word — so opening a
    //    comment there excised the real subcommand behind it (P2.99).
    //  - a bare CR is NOT a shell line terminator: `echo a\r#x ; rm -rf ~` is the
    //    single word `a\r#x` and then a REAL `;` that runs `rm -rf ~`. Treating CR
    //    as word-start opened a comment the shell does not, and the run-to-EOL skip
    //    then ate the `;` and the subcommand behind it. CR IS still a separator on
    //    the `onSeparator` path — a deliberate over-fire, left untouched — it just
    //    must not, on its own, open a comment.
    if (current === ' ' || current === '\t' || current === '\n') wordStart = true
    const consumed = callbacks.onSeparator?.(index)
    if (consumed && consumed > 1) index += consumed - 1
  }
  return !singleQuote && !doubleQuote && backtickStart < 0 && !escaped && spans.length === 0
}

/**
 * Splits a compound command on the documented separators — `&&`, `||`, `;`,
 * `|`, `|&`, `&`, and newlines — at the top nesting level only (permissions.md
 * § Compound commands), with each subcommand's `#` COMMENT TAIL removed.
 * Returns null when the command cannot be parsed.
 *
 * A comment always runs to the end of its line and every line ending is itself a
 * separator, so a comment is always a SUFFIX of the segment it opens in — which
 * is why one `commentStart` mark is enough to excise it. Excising rather than
 * merely suppressing the split inside it is what the sh side needs: the removal
 * circuit breaker tokenizes these segments through `stripSubcommand`, which has
 * no comment rule of its own, so `rm ./one.txt # also clears ~` reached it with
 * the `~` still attached and raised a home-removal prompt for a command that
 * removes one file (P2.71).
 *
 * Blast radius, MEASURED rather than argued (2026-08-23), because this splitter
 * is what every `Bash(...)` rule in the product parses with: 21 382 string
 * literals harvested from the whole permission surface (its sources, its tests,
 * every rule fixture and shipped policy) crossed with the 127 `Bash(...)`/
 * `PowerShell(...)` patterns the repo carries, in all three rule actions —
 * **zero** `match -> no-match` transitions, i.e. no rule anywhere matched a
 * command BECAUSE its comment tail was scanned. The detector is live: the same
 * comparison reports `deny Bash(rm:*)` vs `echo hi # note | rm -rf /` moving
 * `match -> no-match`, which is exactly the class the sweep found none of in
 * the repo. Two classes DO move, both toward the truth and both pinned in the
 * test file: a command that is ONLY a comment now parses to nothing and is
 * `'unparseable'` (which the DSL prompts on, as it does for an empty command),
 * and a glob allow rule stops vetoing a substitution that sits inside a comment.
 *
 * TWO LIMITS OF THAT SWEEP, both of which cost something and are recorded so the
 * next one is designed better:
 * - Its taxonomy treated `match -> no-match` as the dangerous transition. For an
 *   ALLOW rule the dangerous direction is `-> match`, and `'unparseable' -> …`
 *   is dangerous in BOTH directions, because `permission-dsl.ts` enters that
 *   verdict as `ask` — a losable prompt. The ANSI-C hole (see `scanCommand`) was
 *   an `unparseable -> match` on allow, and no row of the taxonomy named it.
 * - The corpus must be harvested from the PARENT tree. Harvesting from a tree
 *   that already carries the change folds this file's own new test fixtures into
 *   the corpus and manufactures phantom transitions.
 *
 * ## ITS READING IS NOT ALWAYS THE SHELL'S, AND SINCE P2.363 SOMETHING ASKS
 *
 * The two comment guards on {@link scanCommand} do not merely narrow the parse:
 * with the comment rule off, an apostrophe inside a REAL comment opens a quote
 * span, the newline behind it stops separating, and a two-command shell script
 * arrives here as ONE subcommand. That silent disagreement is the root cause
 * beneath P2.329 and P2.350, both of which were fixed at the MATCHER while the
 * disagreement itself stayed. MEASURED on the parent tree, `/bin/sh` and
 * `/bin/bash` agreeing (with a non-destructive stand-in verb in place of the
 * removal): `cat <<< 'x' # don't`+LF+`rm -rf ~ #'` runs TWO commands, this
 * function returns ONE subcommand, `deny Bash(rm:*)` answered `no-match` and
 * `findRootOrHomeRemoval` answered null — so P2.350's allow-side fix was the
 * only thing standing, exactly as its own test note said.
 *
 * **This function still returns that reading, byte for byte.** The refusal
 * lives at the two places that must not be misled by it, and nowhere else:
 * {@link commentReadingAgrees}, which {@link matchClaudeBashRule} consults on
 * the ALLOW branch, and {@link splitWithSubstitutions}, which keeps this
 * reading and ADDS the comment-honouring one for deny/ask. Keeping the split
 * itself unchanged is deliberate — the deny side WANTS these exact bytes, and
 * every pin that records what the guards cost is written against them.
 */
export function splitCompoundCommand(command: string): string[] | null {
  return splitOnSeparators(command, false)
}

/**
 * The reading this function had BEFORE the heredoc model (P3.329).
 *
 * **Nothing in the product calls this.** It exists so the two readings can be
 * diffed — by `scripts/command-corpus.ts split-diff` over the real corpus, and
 * by this module's own tests — because the claim the row has to earn is not
 * *"the new split is right"* but *"the new split changes nothing outside a
 * heredoc body"*. A diff needs both sides, and reconstructing the old side from
 * memory is how a differential ends up measuring itself.
 */
export function splitCompoundCommandWithoutHeredocModel(command: string): string[] | null {
  return splitOnSeparators(command, false, false, false)
}

/**
 * Whether either comment guard is silencing the comment rule on a command that
 * actually carries a `#`.
 *
 * A COST GATE, not a semantic one, and the same shape as the `$'` gate in
 * {@link splitWithSubstitutions}: with no `#` in the command the two readings
 * are the same string list by construction, because the only thing
 * `honourComments` changes is whether a `#` opens a comment. So a command
 * without one pays a substring test and nothing else.
 */
function commentGuardArmed(command: string): boolean {
  return command.includes('#') && (command.includes("$'") || command.includes('<<'))
}

/**
 * Whether {@link splitCompoundCommand}'s reading of this command is
 * CORROBORATED — the P2.363 check, and the reason it is a separate question
 * rather than part of the split.
 *
 * Parses a second time with {@link scanCommand}'s `honourComments` overriding
 * both comment guards, and answers whether that reading is the same string
 * list. It is the shape {@link splitPowerShellCommand} has carried since P2.75
 * — parse twice, refuse on disagreement — applied to its sibling rather than
 * invented, and it is DUMBER rather than smarter (owner ruling 2026-08-23):
 * neither pass learns any shell grammar it did not have, and the second is
 * never believed on its own. Its own desyncs are why the guards exist; it is
 * only ever asked whether it AGREES.
 *
 * **It is a question about the ALLOW reading only, which is why it is not
 * inside the split.** Both readings are wanted on the deny/ask side —
 * {@link splitWithSubstitutions} offers them both — and refusing there would
 * downgrade a matching deny to an `ask`. Only {@link matchClaudeBashRule}'s
 * allow branch consults it, where an `'unparseable'` verdict is a prompt and
 * refusing can therefore only approve LESS.
 */
function commentReadingAgrees(command: string, guarded: readonly string[]): boolean {
  if (!commentGuardArmed(command)) return true
  const honoured = splitOnSeparators(command, false, true)
  return honoured !== null
    && honoured.length === guarded.length
    && honoured.every((segment, index) => segment === guarded[index])
}

/**
 * The same question about the ANSI-C reading, and the hole it closes was LIVE.
 *
 * P2.100's differential fuzz found it on its first thousand cases, which is the
 * whole argument for building that instrument. Measured, on strings only:
 *
 *     echo a $'a\'b' && rmdir zzz $'a'b # don't
 *
 * `splitCompoundCommand` returned ONE subcommand — the entire text — and
 * `allow Bash(echo:*)` answered `'match'` on it, while `/bin/bash` runs two
 * commands. `deny Bash(rmdir:*)` answered `'no-match'` on the same string. Both
 * floors walked through, and an allow rule naming `echo` auto-approved an
 * `rmdir`.
 *
 * The mechanism is the one {@link splitOnSeparators} already documents and had
 * only half-closed. With `ansiCQuotes` off, `\'` CLOSES the ANSI-C string, so
 * `$'a\'` ends and `b'` opens a fresh quote span that swallows the `&&`. P2.179
 * fixed that for the enforcement pass and deliberately left the allow pass
 * alone, on the ground that the correct model would APPROVE more. That ground
 * is sound and this does not disturb it: no model is switched on here. The
 * second reading is only ever asked whether it AGREES, exactly as
 * {@link commentReadingAgrees} asks the comment reading, and a disagreement
 * yields `'unparseable'` — a PROMPT. So this can only ever approve LESS, which
 * is the direction the owner's dumber-not-smarter ruling points.
 *
 * Why a disagreement is the right trigger rather than "contains `\'`": the two
 * models differ only about where an ANSI-C string ENDS, so when they produce
 * the same segments the question is moot however many escapes are present —
 * which is what keeps this off the ordinary `$'…'` command.
 *
 * The cost gate is the same shape as {@link commentGuardArmed}'s: without `$'`
 * there is no ANSI-C span for the flag to change, so such a command pays one
 * substring test.
 */
function ansiCReadingAgrees(command: string, guarded: readonly string[]): boolean {
  if (!command.includes("$'")) return true
  const enforcing = splitOnSeparators(command, true)
  return enforcing !== null
    && enforcing.length === guarded.length
    && enforcing.every((segment, index) => segment === guarded[index])
}

/**
 * {@link splitCompoundCommand}'s body, with the ANSI-C quoting rule as a knob.
 *
 * ## Why the knob exists, and why the ALLOW path does not turn it on
 *
 * The scanner's quote model reads `\'` inside `$'…'` as CLOSING the string, so
 * it splits at separators that are INSIDE it: `echo $'a\'b # c ; rm -rf /' ;
 * rm -rf ~ \'` parsed to `["echo $'a\'b # c", "rm -rf /' ; rm -rf ~ \'"]`, and
 * the floor read a second subcommand whose only operand token was `/'` — not a
 * root-or-home target. The shell runs `echo` and then `rm -rf ~` (measured
 * through `/bin/sh -lc`; the docstring on {@link scanCommand} records it). This
 * is a MIS-parse, not a lost parse: the command balances, so the
 * `'unparseable'` prompt never fires and the textual fallback — which by
 * contract runs only on text the structured scan could not read — never sees it
 * either. P2.179.
 *
 * The fix is confined to the ENFORCEMENT pass, and that placement is the whole
 * design rather than a convenience:
 *
 * - This module's standing rule is that extra reach may REFUSE more and never
 *   APPROVE more — the same asymmetry {@link stripSubcommand} draws for `sudo`
 *   and `env`, and that {@link removeLineContinuations} draws for `\`+newline.
 *   Teaching the ALLOW splitter this rule would turn `allow Bash(echo:*)` on
 *   `echo $'a\'b ; rm -rf ~'` from a prompt into an approval.
 * - That is not a hypothetical: `scanCommand`'s docstring records a full,
 *   correct `$'…'` MODEL that was built, measured green against the shell, and
 *   then REPLACED by the deliberately dumber comment guard — because a corpus
 *   sweep found it produced hundreds of `unparseable -> …` transitions including
 *   nine `allow unparseable -> match`. The owner ruling behind that ("dumber,
 *   not smarter") is still in force for the allow path, and this knob does not
 *   reopen it: `splitCompoundCommand` passes `false` and stays byte-identical,
 *   which a corpus differential re-measured rather than asserted.
 * - The COMMENT guard is untouched in both passes. `ansiCQuoting` still
 *   suppresses the comment rule for any command containing `$'`, so the only
 *   thing this knob changes is WHERE THE STRING ENDS.
 */
/* ------------------------------------------------------------------------- *
 * The heredoc model (P3.329)
 * ------------------------------------------------------------------------- */

/**
 * One heredoc BODY, as a half-open span of the command text.
 *
 * The span runs from the first character of the line AFTER the line that opened
 * the heredoc, through the newline that ends the terminator line — so both the
 * opening line and everything after the terminator are outside it.
 */
export interface HeredocBodySpan {
  readonly start: number
  readonly end: number
}

/**
 * Find the heredoc bodies in a command, conservatively.
 *
 * ## Why this exists, and why the standing ruling was lifted for it
 *
 * `scanCommand`'s docstring records an owner ruling that this splitter should be
 * DUMBER, not smarter, and names heredocs as the second construct it refuses to
 * model. That ruling was **lifted for this one construct** by the owner sitting
 * of 2026-09-05 (§1.5 = (A)), on the evidence of the corpus §1.6 released:
 * `["cat <<EOF", "rm -rf ~", "EOF"]` — the non-negotiable removal breaker fires
 * on a heredoc that removes nothing, because a heredoc body's newlines are
 * separators to this splitter and its lines are therefore read as commands.
 * Measured over the 19 619-command corpus that lift releases: **1 012 of the
 * 1 038 unparseable commands carry a heredoc**, so this is the dominant shape in
 * the band, not an edge case.
 *
 * ## Why EXCISING the body is the safe shape, and merging would not be
 *
 * A heredoc body always occupies WHOLE LINES, and a newline is a separator here,
 * so every body line is already its own segment in today's reading. Deleting the
 * body therefore yields a segment list that is an order-preserving SUBSEQUENCE
 * of today's — every string a rule is offered was already offered, so no rule
 * can match text it could not match before. Merging the body into the opening
 * command instead would synthesise a subcommand string that never existed, which
 * is the one thing this module's *refuse more, never approve more* rule forbids.
 *
 * The visible effect is on the other side: with the body gone, an allow rule can
 * approve `cat <<EOF` without being asked about the body, and the breaker no
 * longer sees a removal that the shell never runs. That is the row's whole
 * point, and it is confined to heredoc bodies by construction.
 *
 * ## The one body this does NOT touch, and why
 *
 * With an UNQUOTED delimiter bash expands the body, so `$(…)` and backticks in
 * it really are executed. A body carrying one is therefore left exactly where it
 * is — today's reading, unchanged — rather than excised, because excising it
 * would hide a command the shell genuinely runs. A quoted or backslash-escaped
 * delimiter (`<<'EOF'`, `<<"EOF"`, `<<\EOF`) suppresses every expansion, so such
 * a body is inert text and is always excised.
 *
 * ## Deliberate non-coverage
 *
 * - **Not inside a bracket span, a quote, or a backtick.** `$((1<<2))` is an
 *   arithmetic left shift, `'a <<b'` is a literal, and a heredoc inside `$(…)`
 *   or backticks keeps today's reading. All four are skipped, which leaves the
 *   old behaviour rather than guessing.
 * - **`<<<` is a here-STRING**, not a heredoc, and carries no body.
 * - **An unterminated heredoc runs to end of input**, which is what bash does
 *   with it (it warns and feeds what it got). Those lines are body, not
 *   commands, and dropping them is the same subsequence move.
 */
export function findHeredocBodySpans(command: string): HeredocBodySpan[] {
  // Cost gate: no `<<`, no heredoc, and the ordinary command pays one substring
  // test. Same shape as `commentGuardArmed`'s.
  if (!command.includes('<<')) return []
  const spans: HeredocBodySpan[] = []
  let pending: Array<{ delimiter: string; stripTabs: boolean; expands: boolean }> = []
  let singleQuote = false
  let doubleQuote = false
  let backtick = false
  let depth = 0
  let index = 0
  while (index < command.length) {
    const current = command[index]!
    if (current === '\\' && !singleQuote) {
      index += 2
      continue
    }
    if (singleQuote) {
      if (current === "'") singleQuote = false
      index += 1
      continue
    }
    if (backtick) {
      if (current === '`') backtick = false
      index += 1
      continue
    }
    if (doubleQuote) {
      if (current === '"') doubleQuote = false
      index += 1
      continue
    }
    if (current === "'") { singleQuote = true; index += 1; continue }
    if (current === '"') { doubleQuote = true; index += 1; continue }
    if (current === '`') { backtick = true; index += 1; continue }
    if (current === '(') { depth += 1; index += 1; continue }
    if (current === ')') { if (depth > 0) depth -= 1; index += 1; continue }
    if (current === '\n' && pending.length > 0 && depth === 0) {
      const bodyStart = index + 1
      let cursor = bodyStart
      for (const doc of pending) {
        cursor = consumeHeredocBody(command, cursor, doc)
      }
      // One span covers every body queued on this line: they are contiguous.
      spans.push({ start: bodyStart, end: cursor })
      pending = []
      index = cursor
      continue
    }
    if (current === '<' && command[index + 1] === '<' && depth === 0) {
      if (command[index + 2] === '<') { index += 3; continue }
      const opener = readHeredocDelimiter(command, index + 2)
      if (opener === null) { index += 2; continue }
      pending.push({ delimiter: opener.delimiter, stripTabs: opener.stripTabs, expands: opener.expands })
      index = opener.next
      continue
    }
    index += 1
  }
  return spans
}

/** The characters an unquoted heredoc delimiter may be spelled with. */
const HEREDOC_WORD = /[A-Za-z0-9_.+:@/=-]/

/**
 * Read the delimiter that follows a `<<`.
 *
 * Returns `null` when what follows is not a delimiter this model recognises —
 * an empty word, or a quoted word that never closes — which leaves the command
 * with today's reading rather than a guess.
 */
export function readHeredocDelimiter(
  command: string,
  from: number,
): { delimiter: string; stripTabs: boolean; expands: boolean; next: number } | null {
  let index = from
  let stripTabs = false
  if (command[index] === '-') { stripTabs = true; index += 1 }
  while (command[index] === ' ' || command[index] === '\t') index += 1
  const quote = command[index]
  if (quote === "'" || quote === '"') {
    const close = command.indexOf(quote, index + 1)
    if (close === -1) return null
    const delimiter = command.slice(index + 1, close)
    if (delimiter.length === 0) return null
    // A quoted delimiter suppresses every expansion in the body (`bash(1)`,
    // Here Documents), so the body is inert text.
    return { delimiter, stripTabs, expands: false, next: close + 1 }
  }
  let delimiter = ''
  let escapedAnywhere = false
  while (index < command.length) {
    const current = command[index]!
    if (current === '\\') {
      // `<<\EOF` is the third way to quote a delimiter.
      escapedAnywhere = true
      index += 1
      if (index >= command.length) break
      delimiter += command[index]
      index += 1
      continue
    }
    if (!HEREDOC_WORD.test(current)) break
    delimiter += current
    index += 1
  }
  if (delimiter.length === 0) return null
  return { delimiter, stripTabs, expands: !escapedAnywhere, next: index }
}

/**
 * Consume one heredoc body starting at `from`, returning the offset just past
 * its terminator line — or the end of the command when the terminator never
 * arrives, which is what bash reads too.
 */
export function consumeHeredocBody(
  command: string,
  from: number,
  doc: { delimiter: string; stripTabs: boolean },
): number {
  let cursor = from
  while (cursor <= command.length) {
    const newline = command.indexOf('\n', cursor)
    const lineEnd = newline === -1 ? command.length : newline
    let line = command.slice(cursor, lineEnd)
    if (line.endsWith('\r')) line = line.slice(0, -1)
    // `<<-` strips LEADING TABS from the terminator (and from the body, which we
    // do not care about because we are deleting it).
    if (doc.stripTabs) line = line.replace(/^\t+/, '')
    if (line === doc.delimiter) return newline === -1 ? command.length : newline + 1
    if (newline === -1) return command.length
    cursor = newline + 1
  }
  return command.length
}

/**
 * The command with its inert heredoc body text removed, or the command itself
 * when it has none. See {@link findHeredocBodySpans} for why removal is the safe
 * direction.
 *
 * ## What happens to an EXPANDING body (P6.716)
 *
 * P3.329 left such a body exactly where it was, because excising it would hide a
 * command the shell genuinely runs — and said so as its stated residue. That is
 * an over-blocking reading rather than a wrong one: with an unquoted delimiter
 * bash runs only the `$(…)` and backtick spans in the body, and every OTHER line
 * of it is data fed to stdin. Leaving the whole body in kept the
 * `["cat <<EOF", "rm -rf ~", "EOF"]` shape alive for exactly the bodies that
 * happened to carry one substitution somewhere.
 *
 * So the body is now replaced by its substitution spans, one per line, and the
 * rest of it goes the way every inert body goes. The breaker is offered what
 * bash executes and nothing else.
 *
 * The *refuse more, never approve more* rule still holds in the shape the
 * corpus instrument checks: every span emitted is a VERBATIM SUBSTRING of the
 * body it came from, so no rule is shown text that was not already in the old
 * reading — `scripts/command-corpus.ts split-diff` classifies such a command
 * `dropped` or `recut` and fails on an `invented` segment.
 *
 * A body whose `$(` or backtick turns out to be escaped or otherwise unreadable
 * yields NO span, and then the body is left in place — today's reading, which is
 * the conservative direction when the scanner is unsure.
 */
function stripHeredocBodies(command: string): string {
  const spans = findHeredocBodySpans(command)
  if (spans.length === 0) return command
  let out = ''
  let cursor = 0
  for (const span of spans) {
    const body = command.slice(span.start, span.end)
    out += command.slice(cursor, span.start)
    if (heredocBodyIsExecutable(command, span, body)) {
      const substitutions = commandSubstitutionSpans(body)
      if (substitutions.length === 0) {
        // Unsure: keep the body, which is the reading this command had before.
        out += body
      } else {
        // Each span on its own line, because a newline is this splitter's
        // separator: a span becomes its own segment, and a span carrying its own
        // newlines keeps them, so each of its lines stays the substring of an old
        // segment that it already was.
        out += `${substitutions.map(sub => body.slice(sub.start, sub.end)).join('\n')}\n`
      }
    }
    cursor = span.end
  }
  return out + command.slice(cursor)
}

/** One `$(…)` or backtick span inside a heredoc body, as a half-open range. */
interface SubstitutionSpan {
  readonly start: number
  readonly end: number
}

/**
 * The command-substitution spans of a heredoc body.
 *
 * Quoting is NOT tracked, deliberately, and that is the difference from every
 * other scanner in this file: inside a heredoc body a quote character is
 * ordinary text (`bash(1)`, Here Documents — only `$`, a backtick and `\` keep
 * their meaning with an unquoted delimiter). A scanner that honoured quotes here
 * would miss `echo "$(id)"`.
 *
 * Over-offers rather than under-offers wherever it is unsure, because the
 * offered text is what the breaker gets to refuse:
 *
 * - an UNTERMINATED span runs to the end of the body;
 * - `$((…))` is arithmetic and runs nothing, and is still emitted — telling the
 *   two apart needs a real parser and the cost of being wrong is asymmetric;
 * - `\$` and ``\` `` are literal and produce no span, which is the one place
 *   this reads LESS: an escaped marker is not a substitution in any shell.
 */
function commandSubstitutionSpans(body: string): SubstitutionSpan[] {
  const spans: SubstitutionSpan[] = []
  let index = 0
  while (index < body.length) {
    const current = body[index]!
    if (current === '\\') { index += 2; continue }
    if (current === '$' && body[index + 1] === '(') {
      let depth = 0
      let cursor = index + 1
      while (cursor < body.length) {
        const character = body[cursor]!
        if (character === '\\') { cursor += 2; continue }
        if (character === '(') depth += 1
        else if (character === ')') {
          depth -= 1
          if (depth === 0) { cursor += 1; break }
        }
        cursor += 1
      }
      const end = Math.min(cursor, body.length)
      spans.push({ start: index, end })
      index = Math.max(end, index + 1)
      continue
    }
    if (current === '`') {
      let cursor = index + 1
      while (cursor < body.length) {
        const character = body[cursor]!
        if (character === '\\') { cursor += 2; continue }
        if (character === '`') { cursor += 1; break }
        cursor += 1
      }
      const end = Math.min(cursor, body.length)
      spans.push({ start: index, end })
      index = Math.max(end, index + 1)
      continue
    }
    index += 1
  }
  return spans
}

/**
 * Whether the delimiter that opened this body leaves the body EXPANDING.
 *
 * It is the last one read before `span.start`, so re-read the opener line rather
 * than threading state. Every heredoc on that line must be non-expanding for the
 * whole span to be inert — the span covers all of their bodies at once.
 */
export function heredocOpenerExpands(command: string, span: HeredocBodySpan): boolean {
  const openerLineEnd = span.start - 1
  const openerLineStart = command.lastIndexOf('\n', Math.max(openerLineEnd - 1, 0))
  const opener = command.slice(openerLineStart + 1, openerLineEnd)
  let index = opener.indexOf('<<')
  while (index !== -1) {
    if (opener[index + 2] !== '<') {
      const read = readHeredocDelimiter(opener, index + 2)
      if (read === null || read.expands) return true
    }
    index = opener.indexOf('<<', index + 2)
  }
  return false
}

/**
 * Whether the shell can run something out of this body.
 *
 * Only command substitution qualifies. `$var` and `${var}` expand to a VALUE
 * that is fed to the command's stdin as data; `$(…)` and a backtick span are
 * commands the shell executes while building the body.
 */
function heredocBodyIsExecutable(command: string, span: HeredocBodySpan, body: string): boolean {
  if (!body.includes('$(') && !body.includes('`')) return false
  return heredocOpenerExpands(command, span)
}

/**
 * The STRUCTURAL shape of a command's heredocs — counts only, never text.
 *
 * P6.717's unit. `split-diff` is the heredoc model's only weighting and it runs
 * only on the machine holding the corpus copy, which lives outside the
 * repository because transcripts are untrusted data. Counts are not transcript
 * text, so a derived slice of THESE can be committed and pinned in CI.
 *
 * Every field is a non-negative integer and no field can be inverted back into a
 * command. `bodySpans` counts spans rather than `<<` operators because several
 * heredocs opened on one line share one contiguous body span.
 */
export interface HeredocShapeV1 {
  /** Contiguous body spans found. `0` means the command carries no heredoc. */
  readonly bodySpans: number
  /** Lines of body text across those spans. */
  readonly bodyLines: number
  /** Spans whose opener leaves the body expanding (an unquoted delimiter). */
  readonly expandingBodies: number
  /** Expanding spans that carry at least one substitution the shell would run. */
  readonly executableBodies: number
  /** Substitution spans across those bodies — what P6.716 re-offers. */
  readonly substitutionSpans: number
}


/**
 * The four shapes a command's heredocs can have, in increasing order of what
 * the shell would run out of a body. Exhaustive and closed: every command lands
 * in exactly one.
 *
 * P6.717's vocabulary. The committed slice is keyed by these names, and
 * `claude-bash-rule.test.ts` asserts the slice's key set IS this tuple — so
 * renaming or adding a class turns CI red until the slice is regenerated on the
 * machine that holds the corpus, which is the whole point of committing it.
 */
export const HEREDOC_SHAPE_CLASSES = [
  /** No heredoc body at all — the ordinary command. */
  'noHeredoc',
  /** Every body inert: a quoted or backslash-escaped delimiter suppresses expansion. */
  'inertBody',
  /** An expanding body (unquoted delimiter) that carries no substitution. */
  'expandingWithoutSubstitution',
  /** An expanding body carrying a substitution the shell runs — P6.716's shape. */
  'expandingWithSubstitution',
] as const

export type HeredocShapeClass = typeof HEREDOC_SHAPE_CLASSES[number]

/** Which of {@link HEREDOC_SHAPE_CLASSES} this command is. Counts in, name out. */
export function classifyHeredocShape(shape: HeredocShapeV1): HeredocShapeClass {
  if (shape.bodySpans === 0) return 'noHeredoc'
  if (shape.expandingBodies === 0) return 'inertBody'
  return shape.executableBodies === 0 ? 'expandingWithoutSubstitution' : 'expandingWithSubstitution'
}

/** {@link HeredocShapeV1} for one command. Reads the text; returns only counts. */
export function describeHeredocShape(command: string): HeredocShapeV1 {
  const spans = findHeredocBodySpans(command)
  let bodyLines = 0
  let expandingBodies = 0
  let executableBodies = 0
  let substitutionSpans = 0
  for (const span of spans) {
    const body = command.slice(span.start, span.end)
    if (body.length > 0) {
      bodyLines += body.split('\n').length - (body.endsWith('\n') ? 1 : 0)
    }
    if (!heredocOpenerExpands(command, span)) continue
    expandingBodies += 1
    const substitutions = commandSubstitutionSpans(body)
    if (substitutions.length === 0) continue
    executableBodies += 1
    substitutionSpans += substitutions.length
  }
  return {
    bodySpans: spans.length,
    bodyLines,
    expandingBodies,
    executableBodies,
    substitutionSpans,
  }
}

function splitOnSeparators(
  command: string,
  ansiCQuotes: boolean,
  honourComments = false,
  heredocModel = true,
): string[] | null {
  if (command.length > MAX_COMMAND_LENGTH) return null
  // P3.329: a heredoc BODY is data, not commands. Excised BEFORE the scan, so
  // an apostrophe in a body can no longer desync the quote state either — which
  // is why 1 012 of the corpus's 1 038 unparseable commands were heredocs. The
  // length cap is still measured against the ORIGINAL text, so nothing is
  // rescued into the parseable band by shrinking it.
  const text = heredocModel ? stripHeredocBodies(command) : command
  // THE COMMENT RULE MAY NARROW A PARSE, NEVER RESCUE ONE. This pass reads the
  // command exactly as the parent did, and its verdict is final: a comment can
  // contain an apostrophe (`rm ./a.txt # don't`), and skipping the text would
  // hide the unbalanced quote that made the command `'unparseable'` — turning a
  // prompt into an `allow` on a rule like `Bash(rm:*)`. Same shape as the
  // ANSI-C hole, same posture: when in doubt, refuse to parse and let the user
  // decide.
  if (!scanCommand(text, {}, ansiCQuotes, honourComments)) return null
  const segments: string[] = []
  let segmentStart = 0
  let commentStart = -1
  const balanced = scanCommand(text, {
    onComment: index => { commentStart = index },
    onSeparator: index => {
      const current = text[index]!
      const next = text[index + 1]
      let width = 0
      if (current === '\n' || current === '\r') width = next === '\n' && current === '\r' ? 2 : 1
      else if (current === '&' && next === '&') width = 2
      else if (current === '|' && (next === '|' || next === '&')) width = 2
      else if (current === ';') width = 1
      else if (current === '|') width = 1
      else if (current === '&') {
        // `2>&1` duplicates a descriptor and `&>` redirects; neither separates.
        if (text[index - 1] === '>' || next === '>') return 0
        width = 1
      }
      if (width === 0) return 0
      segments.push(text.slice(segmentStart, commentStart >= 0 ? commentStart : index))
      commentStart = -1
      segmentStart = index + width
      return width
    },
  }, ansiCQuotes, honourComments)
  if (!balanced) return null
  segments.push(text.slice(segmentStart, commentStart >= 0 ? commentStart : undefined))
  const trimmed = segments.map(segment => segment.trim()).filter(segment => segment.length > 0)
  return trimmed.length > 0 ? trimmed : null
}

/** Extracts the inner text of top-level `$(…)` and backtick spans. */
function substitutionSpans(text: string): string[] {
  const spans: string[] = []
  scanCommand(text, { onSubstitutionSpan: inner => { spans.push(inner) } })
  return spans
}

/** Whether the text carries command substitution outside single quotes. */
function hasCommandSubstitution(text: string): boolean {
  return substitutionSpans(text).length > 0
}

/**
 * The shell's LINE-CONTINUATION rule, applied to a subcommand's TEXT before it
 * is tokenized: a backslash immediately followed by a newline is "removed from
 * the input stream and effectively ignored" (`bash(1)`, QUOTING) — outside
 * single quotes, and inside double quotes too, where a backslash keeps its
 * special meaning before `$`, `` ` ``, `"`, `\` and newline.
 *
 * {@link tokenize} is deliberately VERBATIM, so it glues the pair onto the
 * following word: `true && \`+newline+`rm -rf ~` arrived here as the single
 * token `\<newline>rm`, whose basename is not `rm`, and the floor returned null
 * — measured before and after both 2026-08-24/25 floor commits (P2.157). The
 * same shape reaches every construct whose body starts on the next line.
 *
 * It runs in the ENFORCEMENT pass ONLY, which is the asymmetry this module
 * already draws for `sudo`, `env` and head resolution (see
 * {@link stripSubcommand}): teaching the ALLOW pass the same rule would let
 * `allow Bash(rm:*)` approve strings it does not approve today, and this
 * module's rule is that extra reach may refuse more and never approve more.
 * Keeping it out of {@link tokenize} also keeps that function byte-identical,
 * which is what two earlier commits used as their "allow untouched" evidence.
 *
 * Only `\` + LF is a continuation. `\` + CR is NOT — a bare CR is an ordinary
 * word character to bash (the same measurement that produced `scanCommand`'s CR
 * rule), so removing it would invent a rule the shell does not have.
 */
function removeLineContinuations(text: string): string {
  if (!text.includes('\\')) return text
  let out = ''
  let singleQuote = false
  for (let index = 0; index < text.length; index++) {
    const current = text[index]!
    if (singleQuote) {
      out += current
      if (current === "'") singleQuote = false
      continue
    }
    if (current === "'") { singleQuote = true; out += current; continue }
    if (current === '\\') {
      if (text[index + 1] === '\n') { index++; continue }
      out += current
      // Any OTHER escape stays verbatim, pair included, so the escaped
      // character can never be re-read as syntax on the next iteration.
      if (index + 1 < text.length) { out += text[index + 1]!; index++ }
      continue
    }
    out += current
  }
  return out
}

/** Splits one subcommand into verbatim whitespace-separated tokens. */
function tokenize(subcommand: string): string[] {
  const tokens: string[] = []
  let singleQuote = false
  let doubleQuote = false
  let backtick = false
  let escaped = false
  let depth = 0
  let token = ''
  for (const current of subcommand) {
    if (!escaped && current === '\\' && !singleQuote) { escaped = true; token += current; continue }
    if (escaped) { escaped = false; token += current; continue }
    if (singleQuote) { token += current; if (current === "'") singleQuote = false; continue }
    if (backtick) { token += current; if (current === '`') backtick = false; continue }
    if (current === "'" && !doubleQuote) { singleQuote = true; token += current; continue }
    if (current === '"') { doubleQuote = !doubleQuote; token += current; continue }
    if (current === '`') { backtick = true; token += current; continue }
    if (current === '(') depth++
    else if (current === ')') depth = Math.max(0, depth - 1)
    if (/\s/.test(current) && !doubleQuote && depth === 0) {
      if (token) { tokens.push(token); token = '' }
      continue
    }
    token += current
  }
  if (token) tokens.push(token)
  return tokens
}

/**
 * A redirection operator in COMMAND POSITION, with the descriptor forms the
 * shell accepts in front of it (`2>`, `{fd}<`).
 *
 * The shell lets redirections appear anywhere in a simple command, the head
 * included: `> /tmp/x rm -rf ~` runs `rm`. Both enforcement readers asked the
 * FIRST token for the command name, so a leading redirection hid the head as
 * completely as a line continuation did — `bash -n` clean, executed, floor
 * null, `deny Bash(rm:*)` no-match (P2.157).
 */
const LEADING_REDIRECTION =
  /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?(?:<<<|<<-|<<|>>|>\||<>|>&|<&|&>>|&>|>|<)/

/**
 * Drops leading redirections so the token after them is read as the head.
 *
 * A token that IS just the operator takes the next word as its target (`> out`);
 * a token that carries its target does not (`>out`, `2>&1`). An operator
 * immediately followed by `(` is process substitution — `>(cat)` is a WORD and
 * becomes the command name — so it is left alone.
 */
function stripLeadingRedirections(tokens: readonly string[]): readonly string[] {
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]!
    const operator = LEADING_REDIRECTION.exec(token)?.[0]
    if (!operator || token[operator.length] === '(') break
    index += token.length === operator.length ? 2 : 1
  }
  return index > 0 ? tokens.slice(index) : tokens
}

/**
 * Whether a token's parens are PROCESS SUBSTITUTION rather than a label.
 *
 * A redirection operator immediately followed by `(` is `bash(1)`'s process
 * substitution: the construct expands to a `/dev/fd/N` PATH and the whole token
 * becomes a WORD. {@link stripLeadingRedirections} has said so since P2.157 and
 * acts on it; the two label readers did not, and that was P2.180.
 *
 * **Both label regexes accepted the whole family.** A sweep of every redirection
 * prefix the shell accepts (`>`, `<`, `>>`, `&>`, `2>`, `3<`, `{fd}>`, `>&`,
 * `<&`, `<>`, `>|`) crossed with the paren forms found **44** tokens accepted by
 * {@link COMPOUND_PATTERN_LABEL} or {@link FUNCTION_DEFINITION_PARENS} whose
 * parens are process substitution — so `>(cat)` in the row that raised this was
 * one spelling of a class, and the class straddled BOTH readers rather than the
 * one the row named.
 *
 * MEASURED 2026-08-25 with a `touch` payload in the removal's position and a
 * `:` control: `>(cat) <payload>`, `<(cat) <payload>` and `2>(cat) <payload>`
 * reach their payload in NONE of `bash`, `/bin/sh`, `dash`, `zsh` or `ksh` —
 * exit 126/127, because the shell tries to EXECUTE `/dev/fd/63` and the words
 * after it are its arguments. So the floor was reporting `home` for
 * `>(cat) rm -rf ~`, a command that removes nothing, and a `nonNegotiable`
 * floor is a block the user cannot override.
 *
 * This narrows the two label readers and nothing else. A removal INSIDE the
 * parens — `cat >(rm -rf ~)` — is a substitution SPAN that `scanCommand` walks
 * on its own terms (`<(`/`>(` are in {@link SUBSTITUTION_OPENERS}), so it still
 * fires; that is pinned by a test, because it is the one way this change could
 * have opened a hole instead of closing a false positive.
 */
function opensProcessSubstitution(token: string): boolean {
  const operator = LEADING_REDIRECTION.exec(token)?.[0]
  return operator !== undefined && token[operator.length] === '('
}

export interface StrippedSubcommand {
  /** Reconstructed subcommand after assignment/wrapper stripping. */
  text: string
  /**
   * The same subcommand as verbatim tokens, quotes still attached. `text` is
   * these joined by a single space, so a caller that needs the argument
   * boundaries (a path containing a space survives only here) reads this.
   */
  tokens: string[]
  /** A leading assignment named a variable outside the known-safe set. */
  crossedUnknownVar: boolean
  /** watch/setsid/ionice/flock, or find with -exec/-delete forms. */
  execWrapper: boolean
  /**
   * One of the three `w30.md:85` shell forms — a descriptor redirect beyond the
   * standard streams, a zsh subscript inside `[[ ]]`, or `help`/`man` carrying a
   * non-inert option. See `unsafeShellForm`.
   */
  unsafeShellForm: boolean
}

function consumeFlags(tokens: string[], index: number, valueFlags: ReadonlySet<string>): number {
  while (index < tokens.length && tokens[index]!.startsWith('-')) {
    const flag = tokens[index]!
    index++
    if (valueFlags.has(flag) && index < tokens.length) index++
  }
  return index
}

const TIMEOUT_VALUE_FLAGS = new Set(['-k', '--kill-after', '-s', '--signal'])
const NICE_VALUE_FLAGS = new Set(['-n', '--adjustment'])
const STDBUF_VALUE_FLAGS = new Set(['-i', '-o', '-e'])
const NO_VALUE_FLAGS = new Set<string>([])

/**
 * Wrappers a DENY or ASK rule must see through, but an ALLOW rule must not.
 *
 * `whats-new/2026-w16.md`: "deny rules now match through `env`/`sudo`/`watch`
 * wrappers". Measured before this existed: a `deny: Bash(rm:*)` rule returned
 * `no-match` for `sudo rm -rf …`, `env rm -rf …` and `watch rm -rf …`, so
 * prefixing any of three words defeated it. A managed policy denying `curl` was
 * bypassed by `env curl`.
 *
 * The asymmetry is the point and inverting it would be a vulnerability: an
 * allow rule that saw through `sudo` would let `Bash(rm:*)` auto-approve
 * `sudo rm`, escalating the rule to root. `stripSubcommand` therefore leaves
 * these in place, and only the deny/ask pass strips them.
 */
const PRIVILEGE_WRAPPERS = new Set(['sudo', 'doas'])
/** `sudo -u user cmd`, `sudo -g group cmd`, … — flags that consume a value. */
const SUDO_VALUE_FLAGS = new Set([
  '-u', '--user', '-g', '--group', '-p', '--prompt', '-C', '--close-from',
  '-h', '--host', '-r', '--role', '-t', '--type', '-U', '--other-user',
])
/**
 * `-S`/`--split-string` is deliberately ABSENT: its value is the command line
 * itself, so consuming it would delete the very text a deny rule needs to see.
 * Left unconsumed, `env -S "rm -rf /"` keeps `rm -rf /` in the matched text.
 */
const ENV_VALUE_FLAGS = new Set(['-u', '--unset', '-C', '--chdir'])

const SPLIT_STRING_FLAGS = new Set(['-S', '--split-string'])

function unquote(token: string): string {
  const first = token[0]
  return (first === '"' || first === "'") && token.endsWith(first) && token.length > 1
    ? token.slice(1, -1)
    : token
}

/**
 * A token's LITERAL text: quoting removed, quoted CONTENT kept.
 *
 * The other two readers each lose the content for some spelling. `unquote`
 * strips one matched outer pair, so `''3''` reads back as `'3'`; `unquotedText`
 * DROPS single-quoted spans in both its modes, so `'3'` reads back as empty.
 * A redirection operand can afford neither loss: the shell resolves `1>& 3`,
 * `1>& "3"`, `1>& '3'`, `1>& ''3''` and `1>& '3'""` to the same descriptor
 * (measured 2026-08-23, bash 3.2.57 and zsh 5.9 — each wrote through fd 3's
 * target after `exec 3>/tmp/f`, and none created a file named `3`), so the
 * digits have to survive however they were quoted.
 */
function literalText(token: string): string {
  let literal = ''
  let singleQuote = false
  let doubleQuote = false
  let escaped = false
  for (const current of token) {
    if (escaped) { escaped = false; literal += current; continue }
    if (current === '\\' && !singleQuote) { escaped = true; continue }
    if (current === "'" && !doubleQuote) { singleQuote = !singleQuote; continue }
    if (current === '"' && !singleQuote) { doubleQuote = !doubleQuote; continue }
    literal += current
  }
  return literal
}

/**
 * Drops a leading `env` and its flags for the deny/ask pass.
 *
 * `-S`/`--split-string` is the case that needs real work rather than flag
 * skipping: its value IS a command line, so `env -S "rm -rf /"` runs `rm`. The
 * value is unquoted and spliced back into the token stream so the deny rule
 * sees the command it will actually run. Both spellings occur, separated
 * (`-S "cmd"`) and joined (`--split-string=cmd`).
 */
function stripEnvWrapper(tokens: string[]): string[] {
  let index = 1
  while (index < tokens.length && tokens[index]!.startsWith('-')) {
    const flag = tokens[index]!
    const joined = flag.indexOf('=')
    if (joined > 0 && SPLIT_STRING_FLAGS.has(flag.slice(0, joined))) {
      return [...tokenize(unquote(flag.slice(joined + 1))), ...tokens.slice(index + 1)]
    }
    index++
    if (SPLIT_STRING_FLAGS.has(flag) && index < tokens.length) {
      return [...tokenize(unquote(tokens[index]!)), ...tokens.slice(index + 1)]
    }
    if (ENV_VALUE_FLAGS.has(flag) && index < tokens.length) index++
  }
  return tokens.slice(index)
}

/**
 * Drops the quoted spans of ONE token, leaving the shell-syntax remainder.
 *
 * `keepDoubleQuoted` is the difference between the two callers and it is a
 * shell fact, not a knob: a redirection operator inside double quotes is a
 * literal character (`echo "2>&1"` writes text), while a parameter expansion
 * inside them still expands (`[[ x == "${arr[i]}" ]]` still evaluates the
 * subscript). Single quotes suppress both, so they are always dropped.
 */
function unquotedText(token: string, keepDoubleQuoted: boolean): string {
  let bare = ''
  let singleQuote = false
  let doubleQuote = false
  let escaped = false
  for (const current of token) {
    if (escaped) { escaped = false; continue }
    if (current === '\\' && !singleQuote) { escaped = true; continue }
    if (singleQuote) { if (current === "'") singleQuote = false; continue }
    if (current === "'" && !doubleQuote) { singleQuote = true; continue }
    if (current === '"') { doubleQuote = !doubleQuote; continue }
    if (doubleQuote && !keepDoubleQuoted) continue
    bare += current
  }
  return bare
}

/** `3>file`, `4<file`, `3<>file`, `10>>file` — an explicit descriptor number. */
const EXPLICIT_DESCRIPTOR = /^(\d+)(?:<>|>>|>|<)/
/** `>&3`, `<&4`, `1>&3` — duplicating onto a descriptor number. */
const DUPLICATED_DESCRIPTOR = /[<>]&(\d+)/g
/** A token ENDING in `>&`/`<&` — the descriptor number is the next token. */
const TRAILING_DUPLICATION = /[<>]&$/
/** `{fd}>file`, `{fd}<>file` — a descriptor bound to a shell variable. */
const VARIABLE_DESCRIPTOR = /\{[A-Za-z_][A-Za-z0-9_]*\}(?:<>|>>|>|<)/

/**
 * Whether one token redirects a descriptor the command never named.
 *
 * THE BOUNDARY, and it is ours. `w30.md:85` says Bash permission checks "fail
 * closed on more shell forms, including file-descriptor redirects" and carves
 * nothing out, but descriptors `0`/`1`/`2` are stdin/stdout/stderr — every
 * subcommand already has all three open, and `2>&1`, `1>&2`, `> log`,
 * `2> err`, `< in` and `&> all` only move text between streams the rule text
 * can already see. `2>&1` appears in a large share of allow-listed commands, so
 * vetoing it would prompt on rules that work today (the pin is the
 * `standardStreamRedirects` table in the test file).
 *
 * A descriptor numbered 3 or higher, or one bound to a variable, is the form
 * that actually defeats a rule: `cmd 3>&1 1>/dev/null` matches an allow rule on
 * its visible head while parking that head's output on a channel the rule never
 * mentioned, and `exec 3<>file` opens a read-write handle for later segments.
 * Those fail closed.
 */
function redirectsUnnamedDescriptor(token: string): boolean {
  const bare = unquotedText(token, false)
  if (VARIABLE_DESCRIPTOR.test(bare)) return true
  const explicit = EXPLICIT_DESCRIPTOR.exec(bare)
  // Anchored: bash reads a leading digit run as a descriptor only when it is
  // the whole word before the operator, so `echo a3>b` redirects stdout.
  if (explicit && Number(explicit[1]) >= 3) return true
  for (const match of bare.matchAll(DUPLICATED_DESCRIPTOR)) {
    if (Number(match[1]!) >= 3) return true
  }
  return false
}

/**
 * The SPACED spelling of the same duplication, which is a cross-token fact.
 *
 * `DUPLICATED_DESCRIPTOR` looks inside one token, but `tokenize` splits on
 * whitespace, so `1>& 3` arrives as `1>&` + `3` and was auto-approved while
 * `1>&3` was vetoed. Bash reads the two identically — measured 2026-08-23 on
 * bash 3.2.57: `bash -c 'exec 3>/tmp/f; echo hello 1>& 3'` wrote through fd
 * 3's target and created no file named `3`, and a bare `>& 3` behaved the same.
 *
 * Only a next token that is a PURE decimal number is a descriptor. `>& out.log`
 * is a file redirect — a form this file already classifies deliberately — and
 * keeps its classification. The number may be QUOTED, in any spelling, and
 * still duplicates: `1>& "3"`, `1>& '3'`, `1>& ''3''` and `1>& '3'""` all wrote
 * through fd 3's target on the same probe, creating no file named `3`. That is
 * why the operand is read with `literalText` — quoting removed, content kept.
 * Either narrower reader leaves part of that set auto-approved: `unquotedText`
 * lets `'3'` and `'3'""` through, and `unquote` would let `''3''` through.
 * Single quotes are the blind spot they share. The OPERATOR token keeps its
 * `unquotedText` read, where a quote makes `>&` literal text rather than syntax.
 *
 * The boundary is `redirectsUnnamedDescriptor`'s, unchanged: veto iff an
 * involved descriptor is 3 or higher, so `2>& 1` and `1>& 2` stay classified.
 * A left-hand descriptor of 3 or higher (`3>& 1`) needs no check here — the
 * token `3>&` already trips `EXPLICIT_DESCRIPTOR` on its own.
 */
function duplicatesDescriptorAcrossTokens(tokens: readonly string[]): boolean {
  for (let index = 0; index + 1 < tokens.length; index++) {
    if (!TRAILING_DUPLICATION.test(unquotedText(tokens[index]!, false))) continue
    const operand = literalText(tokens[index + 1]!)
    if (/^\d+$/.test(operand) && Number(operand) >= 3) return true
  }
  return false
}

/**
 * `${arr[…]}`, `$arr[…]`, and the two prefixes zsh allows between `${` and the
 * identifier: `#` for a length (`${#arr[idx]}`) and parameter-expansion flags
 * (`${(f)arr[idx]}`). The subscript inside a prefixed expansion is evaluated
 * exactly like a bare one, so requiring an identifier immediately after `$`/`${`
 * let `[[ ${#arr[idx]} -gt 0 ]]` through. Both prefixes are legal only after
 * `{`, which is why they sit inside that optional group.
 */
const ZSH_SUBSCRIPT = /\$(?:\{(?:#|\([^)]*\))?)?[A-Za-z_][A-Za-z0-9_]*\[/

/**
 * Whether a `[[ … ]]` condition carries a variable subscript (`w30.md:85`,
 * "Zsh variable subscripts in `[[ ]]` comparisons").
 *
 * zsh EVALUATES a subscript, so the text between the brackets is code rather
 * than an index — `[[ ${arr[$(payload)]} ]]` runs `payload`. The substitution
 * veto never saw this class, because the dangerous spelling needs no `$(` and
 * no backtick at all: the subscript is itself an evaluation context.
 *
 * Scoped to `[[ ]]` exactly as the changelog line scopes it — a subscript in an
 * ordinary argument (`echo ${arr[0]}`) keeps its classification.
 */
function hasZshSubscriptInCondition(tokens: readonly string[]): boolean {
  let inCondition = false
  for (const token of tokens) {
    if (token === '[[') { inCondition = true; continue }
    if (token === ']]') { inCondition = false; continue }
    if (!inCondition) continue
    if (ZSH_SUBSCRIPT.test(unquotedText(token, true))) return true
  }
  return false
}

/**
 * Options that leave `man`/`help` a pure lookup. Everything else fails closed.
 *
 * `w30.md:85` names "`help` and `man` invocations that could run unsafe
 * options". The set that CAN run something is open-ended — `-P`/`--pager` runs
 * its argument as the pager, `-H`/`--html` runs a browser, `--preprocessor`
 * runs filters — and a fail-open denylist would have to stay ahead of every
 * implementation, so the allowlist is the small inert half and an unrecognized
 * option is refused. A plain `man foo`/`help foo` carries no option at all and
 * is unaffected, which is the row's own requirement.
 */
const MAN_INERT_OPTIONS = new Set([
  '-a', '--all', '-f', '--whatis', '-k', '--apropos',
  '-w', '--where', '--location', '--path', '-h', '--help', '-V', '--version',
])
const HELP_INERT_OPTIONS = new Set(['-d', '-m', '-s', '-h', '--help'])
const DOCUMENTATION_COMMANDS = new Map<string, ReadonlySet<string>>([
  ['man', MAN_INERT_OPTIONS],
  ['help', HELP_INERT_OPTIONS],
])

function carriesUnsafeDocumentationOption(tokens: readonly string[]): boolean {
  const head = tokens[0]
  if (!head) return false
  const inert = DOCUMENTATION_COMMANDS.get(unquote(head))
  if (!inert) return false
  for (const token of tokens.slice(1)) {
    if (token === '--') break // end of options; the rest are operands
    if (!token.startsWith('-') || token === '-') continue
    const joined = token.indexOf('=')
    if (!inert.has(joined > 0 ? token.slice(0, joined) : token)) return true
  }
  return false
}

/**
 * The three forms of `w30.md:85` a glob allow rule must refuse to classify.
 *
 * `original` is the subcommand's tokens BEFORE wrapper stripping and `stripped`
 * is the tokens after: a redirect or a condition survives stripping either way,
 * so those two read the wider view, while `man`/`help` must be recognized as
 * the command a wrapper runs (`timeout 5 man -P id ls`) and reads the narrow
 * one.
 *
 * Refusal is ALLOW-side only, exactly like `execWrapper` and the substitution
 * veto — the caller gates it on `hasGlob` and deny/ask never consult it.
 * Routing these through `'unparseable'` instead would have been a widening
 * dressed as hardening: `permission-dsl.ts:669` turns that verdict into
 * `PROMPT_ANYWAY` for EVERY action, so `deny Bash(rm:*)` would have stopped
 * denying `rm -rf / 3>&1` and started prompting on it.
 */
function unsafeShellForm(original: readonly string[], stripped: readonly string[]): boolean {
  return original.some(redirectsUnnamedDescriptor)
    || duplicatesDescriptorAcrossTokens(original)
    || hasZshSubscriptInCondition(original)
    || carriesUnsafeDocumentationOption(stripped)
}

/**
 * Strips leading env assignments and the documented wrapper set
 * (permissions.md § Wrappers): `timeout` (plus its duration), `time`, `nice`,
 * `nohup`, `stdbuf`, `command`, `builtin`, `noglob`, and flagless `xargs`.
 * `command -v` and `nocorrect` are NOT stripped; exec wrappers stop the loop
 * and are flagged instead.
 *
 * Exported for the removal circuit breaker (`removal-circuit-breaker.ts`),
 * which needs the same enforcement-pass view of a command: the floor has to
 * see `rm` through `sudo`, `doas`, `env -S` and the exec wrappers, and there
 * must be exactly one stripper doing that.
 */
export function stripSubcommand(
  subcommand: string,
  throughEnforcementWrappers = false,
): StrippedSubcommand {
  let tokens = tokenize(
    throughEnforcementWrappers ? removeLineContinuations(subcommand) : subcommand,
  )
  const original = tokens
  let crossedUnknownVar = false
  let execWrapper = false
  let changed = true
  while (changed && tokens.length > 0) {
    changed = false
    if (throughEnforcementWrappers) {
      // Before the assignment loop, and inside the same `changed` cycle, because
      // the shell accepts either order: `> out FOO=bar rm …` and
      // `FOO=bar > out rm …` are both this command.
      const withoutRedirections = stripLeadingRedirections(tokens)
      if (withoutRedirections !== tokens) {
        tokens = withoutRedirections as string[]
        changed = true
        continue
      }
    }
    while (tokens[0] && ENV_ASSIGNMENT.test(tokens[0])) {
      const name = tokens[0].slice(0, tokens[0].indexOf('='))
      if (!KNOWN_SAFE_ENV_VARS.has(name)) crossedUnknownVar = true
      tokens = tokens.slice(1)
      changed = true
    }
    const head = tokens[0]
    if (!head) break
    // The name a wrapper test compares against. The ENFORCEMENT pass resolves
    // the spelling — path, case, `.exe` — because every other head test in this
    // subsystem already does (`shellScriptOperand`, and the floor's own
    // `unquotePath(head).split('/').pop()`), and the two halves disagreeing is
    // the whole defect: this pass read the RAW head, so `/usr/bin/sudo sh -c
    // 'rm -rf ~'` and `/usr/bin/env sh -c 'rm -rf ~'` were invisible to a
    // comment that claimed to see through exactly those two wrappers, and
    // `/usr/bin/sudo rm -rf ~` and `/usr/bin/nohup rm -rf ~` were invisible to
    // the floor. An unresolvable head (`$SUDO rm …`) falls back to the raw
    // token, so a variable is never mistaken for a wrapper NAME.
    //
    // The ALLOW pass deliberately keeps comparing the raw head. Resolving it
    // there would widen allow — `allow Bash(rm:*)` would start approving
    // `/usr/bin/nohup rm -rf …` — and this pass is the one whose extra reach can
    // only ever refuse more (module header, third bullet).
    const name = throughEnforcementWrappers ? resolvedCommandName(head) ?? head : head
    if (EXEC_WRAPPERS.has(name)) {
      execWrapper = true
      // An allow rule stops here — it must never approve what runs inside an
      // exec wrapper. A deny rule keeps going, because the whole point is to
      // reach the command the wrapper would run.
      if (!throughEnforcementWrappers) break
      tokens = tokens.slice(1)
      changed = true
      continue
    }
    if (throughEnforcementWrappers && PRIVILEGE_WRAPPERS.has(name)) {
      tokens = tokens.slice(consumeFlags(tokens, 1, SUDO_VALUE_FLAGS))
      changed = true
      continue
    }
    if (throughEnforcementWrappers && name === 'env') {
      tokens = stripEnvWrapper(tokens)
      changed = true
      continue
    }
    if (SIMPLE_WRAPPERS.has(name)) { tokens = tokens.slice(1); changed = true; continue }
    if (name === 'timeout') {
      let next = consumeFlags(tokens, 1, TIMEOUT_VALUE_FLAGS)
      if (tokens[next] && /^[0-9]/.test(tokens[next]!)) next++
      tokens = tokens.slice(next)
      changed = true
      continue
    }
    if (name === 'time') { tokens = tokens.slice(consumeFlags(tokens, 1, NO_VALUE_FLAGS)); changed = true; continue }
    if (name === 'nice') { tokens = tokens.slice(consumeFlags(tokens, 1, NICE_VALUE_FLAGS)); changed = true; continue }
    if (name === 'stdbuf') { tokens = tokens.slice(consumeFlags(tokens, 1, STDBUF_VALUE_FLAGS)); changed = true; continue }
    if (name === 'command') {
      // The query form `command -v` looks a command up rather than running it.
      if (tokens[1] === '-v' || tokens[1] === '-V') break
      tokens = tokens.slice(consumeFlags(tokens, 1, NO_VALUE_FLAGS))
      changed = true
      continue
    }
    if (name === 'xargs') {
      // Stripping applies only when xargs has no flags (permissions.md).
      if (tokens[1] && !tokens[1].startsWith('-')) { tokens = tokens.slice(1); changed = true }
      break
    }
    break
  }
  if (tokens[0] === 'find' && tokens.some(token => FIND_EXEC_FLAGS.has(token))) execWrapper = true
  return {
    text: tokens.join(' '),
    tokens,
    crossedUnknownVar,
    execWrapper,
    unsafeShellForm: unsafeShellForm(original, tokens),
  }
}

/**
 * The four line terminators JavaScript's `.` refuses without the `s` flag, and
 * the first entry on the shell's own separator list
 * (permissions.md#compound-commands). One constant, exported, because the whole
 * point of {@link compileBashPattern}'s asymmetry is that the deny/ask flag and
 * the allow branch's refusal name the SAME character class — and
 * `claude-powershell-rule.ts` draws the identical line, so a second copy there
 * is the drift that produced this bug in the first place.
 */
export const LINE_TERMINATOR = /[\n\r\u2028\u2029]/u

/**
 * Compiles one Bash rule pattern into TWO regexes that differ only in `s`.
 * `:*` is recognized at the pattern end only and equals a trailing ` *`; a
 * trailing ` *` enforces a word boundary — the prefix must be followed by a
 * space or end-of-string. `*` is the only metacharacter.
 *
 * ## THE `s` FLAG IS ASYMMETRIC ON PURPOSE, AND BOTH HALVES ARE MEASURED
 *
 * `*` compiles to `.`, and in JavaScript `.` does not match a line terminator
 * unless the regex carries `s`.
 *
 * **`regex` (deny and ask) carries `s`, and its absence was a DENY BYPASS
 * (P2.329).** Without it every `*` pattern silently returned `no-match` for any
 * command carrying one of the four terminators JS recognizes anywhere in its
 * text. Measured at `0d7af52cd^`: `deny Bash(rm *)` matched `rm -rf ~` and
 * `rm -rf ~ 'x'` and returned `no-match` on `rm -rf ~ 'a<LF>b'`, so an
 * administrator's deny was evadable by quoting a newline into any argument. At
 * DSL level the rule did not merely miss, it produced NO ACTION AT ALL. Over
 * 18,272 real agent-issued commands, 1,698 (rule, command) pairs go
 * `no-match` → `match` on a deny and ZERO go the other way.
 *
 * **`allowRegex` (allow) does NOT carry `s`, and giving it one was a worse
 * regression than the bug it fixed (P2.350).** `0d7af52cd` applied `s` to all
 * three permission compilers on the argument that a terminator surviving into
 * the regex must be INSIDE a quoted token, so widening `*` "can only ever
 * refuse more, never approve more". **That argument is false, and this docblock
 * used to assert it.** It assumes {@link scanCommand}'s quote model agrees with
 * the shell's, and `scanCommand` disables its comment rule outright whenever the
 * command contains `$'` or `<<` — at which point an apostrophe inside a REAL
 * comment opens a quote span the shell never opened, and swallows the newline
 * behind it. Measured end-to-end against both trees:
 *
 * ```
 * cat <<< 'x' # don't
 * rm -rf ~ #'
 * ```
 *
 * `/bin/sh` and `/bin/bash` both run TWO commands here (verified: the second
 * line executes). This splitter yields ONE subcommand, and with `s` on the
 * allow branch `allow Bash(cat *)` matched the whole two-line text — auto-
 * approved, no prompt, and `deny Bash(rm:*)` never fired either because the
 * head of the single subcommand is `cat`. At `0d7af52cd^` the same input was
 * `no-match` and the user was PROMPTED. So the child auto-approved `rm -rf ~`
 * where its parent asked.
 *
 * ## Why the asymmetry is the contract, not a hedge
 *
 * permissions.md#compound-commands: "The recognized command separators are
 * `&&`, `||`, `;`, `|`, `|&`, `&`, and newlines. A rule must match each
 * subcommand independently." A PERMISSIVE pattern that spans a separator has by
 * definition not matched each subcommand independently, so `s` on an allow
 * contradicts the page. A PROHIBITIVE one that spans it only ever fires on a
 * superset, which is the reading settings-reference.md#sandbox-excludedcommands
 * states for the same `Bash(...)` syntax: "When any part of a compound command
 * matches an entry, Claude Code runs the whole command unsandboxed."
 *
 * The page does not say in so many words whether `*` crosses a newline, so the
 * DIRECTION is ours to choose; both halves resolve toward asking rather than
 * approving. permissions.md#wildcard-patterns — "A `*` in a Bash rule matches
 * any text, including spaces, so one rule covers a family of commands."
 */
function compileBashPattern(rawPattern: string): {
  regex: RegExp
  allowRegex: RegExp
  hasGlob: boolean
} {
  let pattern = rawPattern.trim()
  if (pattern.endsWith(':*')) pattern = `${pattern.slice(0, -2)} *`
  const hasGlob = pattern.includes('*')
  const glob = (part: string) =>
    part.split('*').map(chunk => chunk.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  const source = pattern.endsWith(' *')
    ? `${glob(pattern.slice(0, -2))}(?: .*)?`
    : glob(pattern)
  return {
    regex: new RegExp(`^${source}$`, 'us'),
    allowRegex: new RegExp(`^${source}$`, 'u'),
    hasGlob,
  }
}

/**
 * The subcommand slot of a `Bash(...)` pattern, and whether the rule's first
 * `*` sits in front of it.
 *
 * `errors.md#has-a-wildcard-before-the-rest-of-the-command`, verbatim: *"Claude
 * Code found a `Bash` allow rule whose `*` comes before a later word that
 * determines which command it is, such as `Bash(git * main)` or
 * `Bash(git -C * status *)` … The `*` matches any text, including options
 * inserted at that position: `Bash(git * main)` also approves
 * `git -c core.fsmonitor=<script> diff main`, where `-c` makes git run a
 * program the command names."* The page names the word:
 * `permissions.md#wildcard-patterns` — *"In `git log --oneline main`, `git` is
 * the program and `log` is the subcommand, the word that determines what the
 * program does."*
 *
 * So the test is a POSITION test on the same whitespace split
 * {@link compileBashPattern} globs, and the page states its own exclusions,
 * each of which this function reproduces rather than approximates:
 * - *"rules whose subcommand comes before the first `*`, such as
 *   `Bash(git commit *)`"* — the subcommand index is compared against the first
 *   globbed WORD, so a `*` inside a later argument (`Bash(git commit -m '* x')`)
 *   is behind the subcommand and stays silent.
 * - *"rules in which no word other than an option follows the `*`, such as
 *   `Bash(git *)`"* — an option (a `-`-leading word) and a bare wildcard both
 *   fail to fill the subcommand slot, so `Bash(* --help *)` is silent too.
 * - *"`:*` prefix rules such as `Bash(git:*)`"* — normalised to a trailing
 *   ` *` first, exactly as `compileBashPattern` does, which leaves no word in
 *   the subcommand slot.
 *
 * Returns the deciding word when the rule warns, `null` when it does not. This
 * is a DIAGNOSTIC only: the page says *"Claude Code keeps the rule and changes
 * nothing about how it matches"*, so no caller may make a match decision from
 * it. The fork's own runtime guards (`execWrapper`, `unsafeShellForm`,
 * `crossedUnknownVar`) already refuse SOME of what such a rule spans — silently,
 * while the rule stays as written, which is the second half of why the warning
 * is worth emitting here.
 */
export function bashPatternWildcardBeforeSubcommand(
  rawPattern: string,
): { program: string; subcommand: string } | null {
  let pattern = rawPattern.trim()
  if (pattern.endsWith(':*')) pattern = `${pattern.slice(0, -2)} *`
  const words = pattern.split(/\s+/u).filter(word => word.length > 0)
  const firstGlob = words.findIndex(word => word.includes('*'))
  if (firstGlob < 0) return null
  const subcommandIndex = words.findIndex(
    (word, index) => index > 0 && !word.startsWith('-') && !/^\*+$/u.test(word),
  )
  if (subcommandIndex < 0 || subcommandIndex < firstGlob) return null
  return { program: words[0]!, subcommand: words[subcommandIndex]! }
}

/**
 * UA12.196 — a pure stderr merge at the END of a subcommand (` 2>&1`), the one
 * fd-form the Always Allow key side strips (`bashLineWithoutPlumbing`,
 * core/dangerous-commands.ts, UA12.87): spaces before it, nothing after it, and the
 * character before the spaces neither a space nor a `\` (an escaped space would join
 * `2` to the previous word, so `a\ 2>&1` is `'a 2' >&1`, not a merge).
 */
const FD_FORM_STDERR_MERGE_SUFFIX = /(?<=[^\\\s]) +2>&1$/

/**
 * F1.1143 (origin DN-196 proposed row 3) — the subcommand written the way the
 * SHELL reads its head: quotes and backslash-escapes dropped from the head
 * word, and a bare reserved-word `exec` head dropped. `'touch' x`, `"touch" x`,
 * `\touch x`, `'tou'"ch" x` and `exec touch x` all run the program `touch`,
 * while the deny reading compared the head AS WRITTEN, so each spelling was
 * `no-match` where the bare form was a match — measured at HEAD 2026-10-09
 * (probe in work/bk-18/), for `Bash(…)` denies directly and, since F1.816, for
 * structural denies inside compounds, whose seam
 * (`structuralSubcommandVerdict`, `permission-dsl.ts`) asks this same
 * function. The ENFORCEMENT wrapper pass already resolves the head for
 * WRAPPER-NAME tests ({@link resolvedCommandName}); the compiled rule regexes
 * are tested against the text with the quotes still in it, and that gap is
 * this row.
 *
 * Returns `null` when the head already reads clean and carries no `exec` —
 * there is nothing to add, and the caller keeps its existing tests.
 *
 * - Quotes and escapes are dropped with {@link literalText}, which mirrors the
 *   shell's own word construction: single-quoted text keeps its backslashes,
 *   outside quotes `\x` yields `x`. The head WORD only — arguments keep their
 *   spelling, so a quoted argument (`echo 'touch'`) never becomes a head.
 * - `exec` is dropped only when the RAW token is exactly `exec` and the next
 *   token is not a flag: a quoted or escaped head is NOT the reserved word
 *   (`'exec'` and `\exec` look a command named exec up in `$PATH`). STATED
 *   RESIDUES, measured 2026-10-10: `exec -a name touch` rewrites argv[0]; and
 *   ONE head is resolved, not a chain — after the bare `exec` drops, the head
 *   of the remainder is the wrapper itself (`sudo`, already clean; the strip
 *   loop breaks at `exec`, which is no wrapper's name), so the quoted program
 *   behind it is never re-resolved and `exec sudo 'touch' x` stays `no-match`
 *   while `sudo 'touch' x` matches. A bare `exec` runs nothing.
 *
 * DENY-side only by construction (the caller gates it): an extra reading can
 * only turn a `no-match` into a `match` — refuse more, never approve more,
 * the module header's third bullet. The ASK reading is deliberately NOT
 * widened (DN-196 proposed row 2 owns an ask widening; an extra card is a
 * product posture, not this row's).
 */
function headResolvedForm(subcommand: string): string | null {
  const tokens = stripSubcommand(subcommand, true).tokens
  let rest = tokens
  let changed = false
  if (rest[0] === 'exec' && rest.length > 1 && !rest[1]!.startsWith('-')) {
    rest = rest.slice(1)
    changed = true
  }
  if (rest.length === 0) return null
  const head = rest[0]!
  const name = literalText(head)
  if (name && name !== head) {
    rest = [name, ...rest.slice(1)]
    changed = true
  }
  return changed ? rest.join(' ') : null
}

function subcommandMatches(
  subcommand: string,
  compiled: { regex: RegExp; allowRegex: RegExp; hasGlob: boolean },
  ruleAction: ClaudeBashRuleAction,
): boolean {
  // UA12.196 — permissions.md#redirections: "Targets with no file behind them aren't
  // checked: `/dev/null`, file-descriptor forms such as `2>&1` and `<&3`", and "A rule
  // such as `Bash(git commit *)` allows the command, not the target". An Always Allow
  // on `npm test 2>&1` writes `Bash(npm test)` (UA12.87), which this matcher then read
  // against the whole text, so a later session asked again. The rule is also tried
  // against the subcommand without that one suffix; the floors below run on it again.
  // Deny and ask read it too, so a narrowing rule never misses what an allow reaches.
  // Only ` 2>&1`, as the key side: `> out.txt` keeps its target and still asks.
  const withoutMerge = LINE_TERMINATOR.test(subcommand) ? subcommand : subcommand.replace(FD_FORM_STDERR_MERGE_SUFFIX, '')
  if (withoutMerge !== subcommand && withoutMerge.trim() !== '' && subcommandMatches(withoutMerge, compiled, ruleAction)) return true
  const { regex, allowRegex, hasGlob } = compiled
  const stripped = stripSubcommand(subcommand)
  if (ruleAction === 'allow') {
    if (stripped.crossedUnknownVar) return false
    if (hasGlob && stripped.execWrapper) return false
    if (hasGlob && stripped.unsafeShellForm) return false
    if (hasGlob && hasCommandSubstitution(subcommand)) return false
    // The SECOND floor under P2.350, on the same footing as the three above:
    // a glob allow never approves a subcommand that still carries a line
    // terminator. `allowRegex` alone already refuses every such subcommand
    // whose PATTERN is terminator-free, so this line is what covers the
    // remaining case — a pattern that spells a terminator out literally, e.g.
    // `Bash(git commit -m 'a<LF>*')`, which `allowRegex` would happily match.
    // It is also the guard that survives someone "restoring symmetry" to the
    // flag lists, which is precisely how this hole was opened. An EXACT rule
    // (no `*`) still matches such a command: that is the admin naming the whole
    // text, not a family, and permissions.md#wildcard-patterns says "A rule
    // with no `*` matches one exact command."
    //
    // Tested against `stripped.text` rather than the raw subcommand, so the
    // allow side stays byte-for-byte the parent's behaviour on everything else:
    // a terminator inside a stripped-away known-safe assignment (`NODE_ENV=
    // 'a<LF>b' npm test`) is inert data the regex never sees.
    //
    // Named rather than buried: this makes `allow Bash(*)` refuse a
    // terminator-carrying command, and permissions.md#match-all-uses-of-a-tool
    // says "`Bash(*)` is equivalent to `Bash` and matches all Bash commands."
    // The divergence is not new and not this line's: a glob allow ALREADY
    // refuses exec wrappers, the `unsafeShellForm` classes and substitution, so
    // `Bash(*)` has never approved every command here (measured across all
    // three trees). A bare `Bash` rule is a `tool` matcher that never reaches
    // this function and still approves everything, which is where an
    // administrator who means "no Bash prompts" ends up.
    if (hasGlob && LINE_TERMINATOR.test(stripped.text)) return false
    return allowRegex.test(stripped.text)
  }
  // Deny and ask match on EITHER form. Testing only the wrapper-stripped text
  // would lose a rule that names a wrapper itself — `deny: Bash(sudo:*)` must
  // still match `sudo rm`, and it cannot once `sudo` has been stripped away.
  // F1.1143 — DENY gains ONE more candidate: the head-resolved spelling
  // ({@link headResolvedForm}), asked raw and behind the enforcement pass, so
  // `sudo 'touch' x` and `exec sudo touch x` compose. It can only turn a no-match
  // into a match — refuse more, never approve more — and the ask reading
  // deliberately keeps today's reach; see the helper for its stated residues.
  if (ruleAction === 'deny') {
    const headResolved = headResolvedForm(subcommand)
    if (headResolved && (regex.test(headResolved) || regex.test(stripSubcommand(headResolved, true).text))) return true
  }
  return regex.test(stripped.text)
    || regex.test(stripSubcommand(subcommand, true).text)
}

/**
 * Matches one Claude `Bash(prefix)` rule against a command.
 *
 * The subcommand list differs by action, and the difference is the security
 * property (module header, third bullet):
 * - ALLOW sees the TOP-LEVEL subcommands only (`splitCompoundCommand`) and
 *   requires EVERY one of them to match. A glob allow additionally refuses any
 *   subcommand carrying substitution outright, so it never gains this reach —
 *   and refuses the three `unsafeShellForm` classes on the same footing, and a
 *   subcommand still carrying a LINE TERMINATOR (P2.350), which is a separator
 *   this splitter did not get to split on. It also matches through the `u`-only
 *   `allowRegex`, so its `*` cannot cross one either; see
 *   {@link compileBashPattern} for why the flag is asymmetric.
 * - DENY and ASK also see inside `$(…)`, backtick and subshell spans
 *   (`splitWithSubstitutions`, recursively, to its budget) and match when ANY
 *   entry does — so `deny Bash(rm:*)` catches `echo $(rm -rf ./x)`. Past the
 *   budget the descent stops and deeper spans are simply not offered; that
 *   degrades to the pre-2026-08-21 top-level reach rather than to a hang. The
 *   ONE body that degradation can hide — the bottom of a chain of wrapper-only
 *   spans — is recovered separately and unconditionally, because a 140-character
 *   command could reach past the budget (`innermostWrappedCommand`, P2.156).
 *
 * The `'unparseable'` contract is IDENTICAL either way, which is what lets the
 * splitter vary by action: `splitWithSubstitutions` starts by calling
 * `splitCompoundCommand` and returns null exactly when it does, and a nested
 * span that fails to parse on its own is skipped rather than nulling the whole
 * list. The caller owns the posture for `'unparseable'` (the permission DSL
 * prompts anyway; see `permission-dsl.ts`).
 */
export function matchClaudeBashRule(
  pattern: string,
  command: string,
  options: { ruleAction: ClaudeBashRuleAction },
): ClaudeBashMatchResult {
  const subcommands = options.ruleAction === 'allow'
    ? splitCompoundCommand(command)
    : splitWithSubstitutions(command)
  if (!subcommands) return 'unparseable'
  // P2.363 — the ALLOW reading must be CORROBORATED before any pattern sees it.
  // This is above the exact/glob distinction on purpose: the question is not
  // what the rule says, it is whether the subcommand list is a reading of this
  // command at all. Measured on the parent: with a comment guard armed,
  // `cat <<< 'x' # don't`+LF+`rm -rf ~ #'` was ONE subcommand here and is TWO
  // commands to `/bin/sh` and `/bin/bash`, so a glob allow was the only thing
  // standing and an EXACT rule naming the whole text approved it outright.
  if (options.ruleAction === 'allow' && !commentReadingAgrees(command, subcommands)) return 'unparseable'
  // The ANSI-C half of the same question (P2.100). Separate call rather than one
  // combined predicate, because the two guards fire on disjoint commands and a
  // reader chasing an unexpected prompt needs to know WHICH reading disagreed.
  if (options.ruleAction === 'allow' && !ansiCReadingAgrees(command, subcommands)) return 'unparseable'
  const compiled = compileBashPattern(pattern)
  const matches = subcommands.map(subcommand =>
    subcommandMatches(subcommand, compiled, options.ruleAction))
  if (options.ruleAction === 'allow') return matches.every(Boolean) ? 'match' : 'no-match'
  return matches.some(Boolean) ? 'match' : 'no-match'
}

/**
 * Splits a command and recursively appends `$(…)`/backtick span contents.
 *
 * `scanCommand` opens a span for a top-level `(` too, so PROCESS substitution
 * (`<(…)`) and subshells are walked by the same pass. Exported for the removal
 * circuit breaker, whose contract is "the removal … inside the substitution …
 * or elsewhere in the same command" — which is exactly this list.
 *
 * It is also the deny/ask subcommand list in `matchClaudeBashRule`, so the two
 * enforcement floors reach the same distance by construction. Returns null on
 * exactly the inputs `splitCompoundCommand` does — a nested span that cannot be
 * parsed on its own is dropped, never propagated as a whole-command null — which
 * is what keeps the `'unparseable'` SPLIT action-independent.
 *
 * The verdict is not, since P2.363, and the asymmetry is the module's standing
 * rule rather than an exception to it: `matchClaudeBashRule`'s ALLOW branch
 * additionally refuses a command whose reading is uncorroborated, while this
 * side keeps every reading it had and GAINS one. Refusing here instead would
 * downgrade a matching deny to an `ask` — on the P2.350 fixture the guarded
 * reading is the only thing that ever showed a deny rule the `cat`, and the
 * comment-honouring one is what now shows it the `rm`. Where the two verdicts
 * differ the DSL takes the safer: a deny outranks an `ask` by `ACTION_WEIGHT`,
 * and a winning allow downgrades to `ask` on an unparseable command.
 *
 * A `sh -c '…'` SCRIPT is offered on the same footing as a substitution span,
 * for the same reason and with the same budget: it is command text this
 * subcommand will run. The subcommand itself is still yielded first, so
 * `deny Bash(zsh:*)` keeps matching the wrapper it names. Because only the
 * deny/ask side reads this list (allow uses {@link splitCompoundCommand}), the
 * extra reach can only ever refuse more — never approve more, which is the
 * asymmetry `stripSubcommand`'s enforcement pass already draws for `sudo`.
 *
 * So is the body behind a COMPOUND-COMMAND KEYWORD — see
 * {@link compoundKeywordBodies}. A separator ends a command but a reserved word
 * does not, so `if true; then rm -rf ~; fi` reached this function as three
 * subcommands whose middle HEAD was `then`, and both floors read a head that was
 * not `rm` (P2.142, measured open 2026-08-24). The `-c` extraction therefore
 * runs per FORM rather than per subcommand: a keyword head hid the wrapper as
 * thoroughly as it hid a bare removal.
 */
export function splitWithSubstitutions(
  command: string,
  budget = 32,
  unparsed?: string[],
): string[] | null {
  const subcommands = splitCompoundCommand(command)
  if (!subcommands) return null
  // P2.363, ENFORCEMENT ONLY: with a comment guard armed, the guarded reading
  // above disagrees with what the shell runs — `cat <<< 'x' # don't`+LF+`rm -rf ~ #'`
  // is ONE subcommand here and TWO to `/bin/sh`, so a `deny Bash(rm:*)` and the
  // removal floor both saw only `cat`. The comment-honouring reading is ADDED,
  // never substituted, so this can only ever refuse more; `splitCompoundCommand`
  // owns the refusal for the allow side, where approving less is the safe move.
  const commentForms = commentGuardArmed(command)
    ? (splitOnSeparators(command, false, true) ?? []).filter(form => !subcommands.includes(form))
    : []
  // P2.179, ENFORCEMENT ONLY: the shared splitter mis-reads `\'` inside an
  // ANSI-C `$'…'` literal and splits INSIDE the string, so a removal after the
  // real closing quote arrived as part of one wrong token. The ANSI-C-aware
  // reading is ADDED to the list rather than replacing it — both readings are
  // offered, so this can only ever refuse more, and the allow splitter above
  // keeps the exact bytes it always produced. Gated on `$'` so a command
  // without one pays a substring test and contributes nothing new.
  const forms = command.includes("$'")
    ? (splitOnSeparators(command, true) ?? []).filter(form => !subcommands.includes(form))
    : []
  const collected: string[] = []
  // Order is the contract: the bytes a deny rule already matched come first,
  // then P2.179's ANSI-C reading, then P2.363's comment-honouring one. Appending
  // rather than interleaving is what keeps every earlier pin on this list true.
  for (const subcommand of [...subcommands, ...forms, ...commentForms.filter(form => !forms.includes(form))]) {
    // The subcommand itself first, then the body behind each reserved word it
    // carries — so `deny Bash(then:*)` (or `Bash(zsh:*)`) still matches the
    // text as written, and the removal behind the keyword is offered too.
    const forms = [subcommand, ...compoundKeywordBodies(subcommand)]
    collected.push(...forms)
    if (budget <= 0) continue
    for (const inner of substitutionSpans(subcommand)) {
      const nested = splitWithSubstitutions(inner, budget - 1, unparsed)
      if (nested) collected.push(...nested)
      else unparsed?.push(inner)
    }
    // The enforcement-pass tokens, so the script is still found through the
    // wrappers that pass already sees through (`sudo sh -c …`, `env sh -c …`).
    // Run per FORM, because a keyword head hid the wrapper as thoroughly as it
    // hid a bare `rm`: `if true; then zsh -lc 'rm -rf ~'; fi` was null too.
    for (const form of forms) {
      const script = shellScriptOperand(stripSubcommand(form, true).tokens)
      if (script) {
        const nested = splitWithSubstitutions(script, budget - 1, unparsed)
        if (nested) collected.push(...nested)
        else unparsed?.push(script)
      }
    }
    // The one body the DEPTH budget above can drop, recovered in linear time.
    // See {@link innermostWrappedCommand}.
    const innermost = innermostWrappedCommand(subcommand)
    if (innermost !== null) {
      const nested = splitWithSubstitutions(innermost, budget, unparsed)
      if (nested === null) unparsed?.push(innermost)
      // Deduplicated against what the budgeted descent already reached, so a
      // chain that fits INSIDE the budget contributes nothing and this list
      // stays byte-identical to the one HEAD produced. The recovery is therefore
      // strictly ADDITIVE -- pinned by a test that asserts the old list is a
      // prefix of the new one for every command in the corpus.
      else for (const form of nested) if (!collected.includes(form)) collected.push(form)
    }
  }
  return collected
}

/**
 * The command text at the bottom of a chain of WRAPPER-ONLY substitution spans,
 * or null when the subcommand is not such a chain.
 *
 * ## Why the depth budget had to be answered and not merely raised
 *
 * `splitWithSubstitutions` descends one span at a time and stops at `budget`.
 * That bound limits REACH, not work: `'( ' × 33 + 'rm -rf ~' + ' )' × 33` is
 * **140 characters**, runs in `bash`, `/bin/sh` AND `dash`, and the floor
 * returned null while the same string at 32 nestings returned `home` (P2.156,
 * HIGH-3 of the P2.142 review). A budget that fails OPEN on a string short
 * enough to type by hand is not a budget.
 *
 * Removing the bound is not the fix either, and that was MEASURED rather than
 * assumed: at this module's own 10 000-character ceiling an unbounded descent
 * costs **1 376 ms** and materialises **12.5 million characters** of nested
 * text, against 35 ms today — the same order of ×30 regression the P2.142
 * review rejected a cap for causing.
 *
 * ## The treatment `a0a5ca4da` used, applied here
 *
 * That commit did not raise its cap; it changed WHICH entries the cap keeps,
 * because only one of them could ever be a removal. The same statement holds
 * here, and it is exact:
 *
 * > A subcommand whose entire content is ONE substitution span carries no
 * > command of its own. Its head is `(`, `$(` or a backtick, so no scan can
 * > read a removal out of it — only the span INSIDE it can hold one.
 *
 * So a chain of wrapper-only spans hides its payload in exactly one place: the
 * bottom. This function walks to that bottom by consuming one delimiter from
 * each END of the text per layer — O(1) a layer, O(n) for the chain, no
 * re-scanning of nested text — and the result is offered to the same walk. The
 * budget above is left exactly as it was, so nothing that fits inside it changes
 * by a byte; this is purely the recovery of the one body the budget can drop.
 *
 * Two-ended peeling can be fooled where one-scan-per-layer could not:
 * `( a ) ( b )` opens and closes but is two spans, and peeling it yields
 * `a ) ( b`. That is why the caller hands the result to
 * {@link splitCompoundCommand} and drops it when it does not parse — a peel is
 * only ever ADDITIVE, so a discarded one costs nothing that HEAD had.
 *
 * A single-quoted or double-quoted body is not a span and stops the peel at its
 * first character, because neither `'` nor `"` is an opener here.
 */
function innermostWrappedCommand(subcommand: string): string | null {
  // INDICES, not slices. Peeling by `slice().trim()` copies the remaining text
  // once per layer, which is O(n^2) in the shape this exists for and measured
  // +42% on the 10 000-character worst case. Two cursors cost O(1) a layer and
  // one substring at the end -- the same "collect indices, materialise once"
  // move `compoundKeywordBodies` makes.
  const isBlank = (index: number) => {
    const char = subcommand[index]
    return char === ' ' || char === '\t' || char === '\n' || char === '\r'
  }
  let start = 0
  let end = subcommand.length
  let layers = 0
  for (;;) {
    while (start < end && isBlank(start)) start++
    while (end > start && isBlank(end - 1)) end--
    const opener = SUBSTITUTION_OPENERS.find(
      candidate => subcommand.startsWith(candidate, start),
    )
    if (!opener) break
    const closer = opener === '`' ? '`' : ')'
    if (end - start <= opener.length + closer.length) break
    if (subcommand[end - 1] !== closer) break
    start += opener.length
    end -= closer.length
    layers++
  }
  return layers > 0 ? subcommand.slice(start, end) : null
}

/**
 * Openers {@link innermostWrappedCommand} peels, longest first so `$(` is never
 * read as a bare `(`. `<(`/`>(` are process substitution, which `scanCommand`
 * already opens a span for.
 */
const SUBSTITUTION_OPENERS = ['$(', '<(', '>(', '(', '`'] as const

/**
 * Every command text hidden behind a reserved word in one subcommand.
 *
 * Returns each token SUFFIX that begins where a new COMMAND begins — after a
 * {@link COMMAND_OPENING_WORDS} token, a {@link COMPOUND_PATTERN_LABEL}, or a
 * function definition's `()`. One linear pass over the subcommand's own tokens,
 * no recursion, because a body of a body is just a shorter suffix of the same
 * list: `do { rm -rf ~` reaches `rm -rf ~` in the same pass that reaches
 * `{ rm -rf ~`.
 *
 * ## The question this asks, and the one it used to ask
 *
 * The rule is *where does a command start*, and the answer is the shell's:
 * **a reserved word is a reserved word only in COMMAND POSITION.** The walk
 * therefore carries one of three positions:
 *
 * | position | meaning | what a token does to it |
 * | --- | --- | --- |
 * | `command` | a command may start here | an opener emits a body and stays; a header word holds; anything else IS the command head, and the walk ends |
 * | `header` | inside `for`/`case`/`select`/`function`/`[[` operands | reserved words are still recognised; ordinary WORDS are just words and do not end the walk |
 * | ended | a real command head was seen | nothing further is a boundary |
 *
 * The version this replaces asked a cruder question — *does the SUBCOMMAND
 * start with a boundary* — and then treated every later token as a boundary
 * regardless. That single test was wrong in both directions at once, and both
 * were MEASURED on 2026-08-25 with `true && rm -rf ~` firing as the positive
 * control and `echo hello` quiet as the negative:
 *
 * - **Too narrow.** A function definition starts with its NAME, so
 *   `wipe () { rm -rf ~; }` failed the test at token 0 and the genuine `{`
 *   boundary at token 2 was never examined. Four spellings of one construct
 *   returned null from the floor and `no-match` from `deny Bash(rm:*)` — not
 *   `'unparseable'`, so `permission-dsl.ts`'s prompt-anyway carve-out did not
 *   catch them either — while the fifth, `wipe() { … }`, fired only because
 *   `tokenize` happened to glue its name and parens into a token ending in `)`.
 *   All five are `bash -n` clean and all five RUN their body in `bash` and
 *   `/bin/sh`. Whitespace decided whether a `nonNegotiable` floor engaged.
 * - **Too wide.** Once token 0 passed, `in` opened a body at any later index —
 *   but `in`'s operand is a word list, so `for opt in rm -rf ~; do echo $opt;
 *   done` fired `home` on a loop that (executed) prints three words and removes
 *   nothing. The user cannot turn a `nonNegotiable` floor off, so a false
 *   positive there has no escape hatch at all.
 *
 * Position tracking answers both with one mechanism, which is why the individual
 * spellings stop mattering: `echo then rm -rf ~` is quiet because `echo` ends
 * the walk, not because `then` is at index 1.
 *
 * ## The bound, and why it can no longer hide a payload
 *
 * A suffix per boundary is quadratic in the command's length, so the count is
 * capped at {@link MAX_KEYWORD_BODIES}. What matters is WHICH bodies the cap
 * keeps. The previous version emitted outermost-first and truncated the tail —
 * i.e. it discarded the INNERMOST bodies, which is exactly where a payload sits.
 * That was reachable with valid shell: `'for ((i=0;i<1;i++)) do ' × 32 +
 * 'rm -rf ~; ' + 'done ' × 32` is 906 characters, well inside the 10 000 this
 * module accepts, `bash -n` clean, and VERIFIED to run its body; the floor
 * returned null at 32 nestings and `home` at 31. A performance knob decided
 * whether a home wipe was seen.
 *
 * Two properties fix that, and both are load-bearing:
 *
 * 1. **Boundaries are collected as INDICES first and materialised second**, so
 *    the walk itself costs nothing per boundary and the cap is applied before
 *    any string is built.
 * 2. **The cap keeps the LAST {@link MAX_KEYWORD_BODIES}, never the first.**
 *    Emitted bodies are nested suffixes, and — by the position rule above — the
 *    walk ENDS at the first body headed by a real command. Every body except
 *    the last is therefore headed by a construct word (`for`, `case`, `select`,
 *    `function`, `[[`) that names no removal. Keeping the tail keeps the only
 *    body that can be a removal, at any nesting depth: the cap now bounds WORK
 *    and cannot bound REACH. Pinned by a test at 32, 500 and 4 000 nestings.
 *
 * Keeping the last N also keeps the SHORTEST N, since a later suffix is a
 * shorter one — so the materialisation cost falls out of the same choice rather
 * than being traded against it.
 *
 * ## Why this is not a shell parser, and must not become one
 *
 * It still reads no grammar: it does not know that `if` takes a condition, that
 * `case` takes a subject, or where `fi` closes anything. It knows one thing —
 * which words are followed by a command, which by a word — because that is the
 * distinction between reaching a removal and inventing one, and `bash(1)` states
 * it outright. Where a body cannot be walked confidently the failure is toward
 * FIRING: the text is offered anyway, and offering text to a scan that still
 * demands `rm`/`rmdir`/`find` plus an exact root-or-home target can only ever
 * add a refusal, never remove one.
 *
 * ## Two boundaries that are load-bearing
 *
 * - The comparison is against the VERBATIM token, never {@link literalText}. A
 *   quoted `'then'` is not a reserved word to the shell either, so
 *   `'then' rm -rf ~` stays one ordinary command — reading the literal text
 *   would have invented a boundary the shell does not have.
 * - **THREE callers read this list, not two.** `matchClaudeBashRule` routes
 *   deny and ask through it (allow goes through {@link splitCompoundCommand},
 *   which this change does not touch), and {@link matchClaudeBashIfRule} routes
 *   every Claude hook `if: Bash(…)` filter through it as well
 *   (`claude-permission-rules.ts`, `evaluateClaudeHookIfFilter`). This comment
 *   used to say "only DENY and ASK read this list … so the extra reach cannot
 *   approve anything", and both halves were wrong: the hook filter is a third
 *   reader, and a `PreToolUse` hook may answer `permissionDecision: allow`, so
 *   the reach does end up in front of an approval path. It is still the safe
 *   direction — that filter is best-effort by contract and its caller fails
 *   OPEN on `'unparseable'`, so matching more only runs a hook the user already
 *   attached to that command shape, and a hook `allow` cannot clear a
 *   `nonNegotiable` floor. But the blast radius is three consumers wide and the
 *   next maintainer will size it from this sentence.
 */
function compoundKeywordBodies(subcommand: string): string[] {
  const tokens = normalizeFunctionDefinitions(tokenize(subcommand))
  // Pass 1 — WHERE the bodies start. Indices only: no string is built for a
  // body the cap is about to drop, which is what keeps the walk linear.
  const starts: number[] = []
  let position: 'command' | 'header' = 'command'
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    const next = tokens[index + 1]
    if (opensCompoundCommand(token)) {
      // End of a RUN only: the body of `{ { rm …` is `rm …`, and the discarded
      // `{ rm …` was headed by a reserved word that names no command. A header
      // word ends the run for the same reason — `do for ((…)) do rm …` has one
      // command in it, not two.
      if (next !== undefined && !opensCompoundCommand(next) && !continuesConstructHead(next)) {
        starts.push(index + 1)
      }
      position = 'command'
      continue
    }
    if (CONSTRUCT_HEADER_WORDS.has(token)) { position = 'header'; continue }
    // `coproc NAME { … }` and `name () { … }` both put ONE word between the
    // construct and its body (`bash(1)` § Coprocesses, § Shell Function
    // Definitions). That word is a label, not a command head, so it does not
    // end the walk — but only in the two shapes the shell gives it, or
    // `echo { rm -rf ~ }` would start firing.
    if (position === 'command' && next === FUNCTION_PARENS_TOKEN) continue
    if (position === 'command' && index > 0 && tokens[index - 1] === 'coproc' && next !== undefined
      && opensCompoundCommand(next)) continue
    if (position === 'command') break
  }
  // Pass 2 — materialise the LAST bodies, which are the innermost ones. See the
  // doc above: every earlier body is headed by a construct word, so this is the
  // direction that cannot hide a removal.
  return starts.slice(-MAX_KEYWORD_BODIES).map(start => tokens.slice(start).join(' '))
}

/**
 * How many bodies one subcommand may contribute; sized like the substitution
 * budget. See {@link compoundKeywordBodies} — this bounds the WORK, and by
 * keeping the last bodies rather than the first it cannot bound the REACH.
 */
const MAX_KEYWORD_BODIES = 32

/** The normalised spelling of a function definition's parens. */
const FUNCTION_PARENS_TOKEN = '()'

/**
 * Rewrites every function-definition token into the same three tokens.
 *
 * `wipe()`, `wipe(){` and `( )` all become `wipe`, `()`, `{` — see
 * {@link FUNCTION_DEFINITION_PARENS} for the four spellings and what it cost to
 * treat them as four different things. Nothing else in the list is touched, and
 * a subcommand with no `()` in it returns the SAME ARRAY, so the ordinary path
 * pays one regex test per token and no allocation.
 */
function normalizeFunctionDefinitions(tokens: string[]): string[] {
  if (!tokens.some(isFunctionDefinitionToken)) return tokens
  const normalized: string[] = []
  for (const token of tokens) {
    const match = isFunctionDefinitionToken(token) ? FUNCTION_DEFINITION_PARENS.exec(token) : null
    if (!match) { normalized.push(token); continue }
    const [, name, rest] = match
    if (name) normalized.push(name)
    normalized.push(FUNCTION_PARENS_TOKEN)
    if (rest) normalized.push(rest)
  }
  return normalized
}

/**
 * A token that IS a function definition's parens, and not process substitution.
 *
 * `>( )` matched {@link FUNCTION_DEFINITION_PARENS} with the NAME `>`, so the
 * normaliser rewrote it to `>`, `()` and the `()` then opened a body — the same
 * P2.180 over-fire as {@link COMPOUND_PATTERN_LABEL}'s, reached through the
 * other reader. The sweep in {@link opensProcessSubstitution} found 12 spellings
 * of it.
 */
function isFunctionDefinitionToken(token: string): boolean {
  return !opensProcessSubstitution(token) && FUNCTION_DEFINITION_PARENS.test(token)
}

/** A word after which a COMMAND begins — see {@link compoundKeywordBodies}. */
function opensCompoundCommand(token: string): boolean {
  // Process substitution is a WORD, not a label: see
  // {@link opensProcessSubstitution} for the 44-token sweep and the five-shell
  // measurement that no such token ever reaches the words after it (P2.180).
  if (opensProcessSubstitution(token)) return false
  return COMMAND_OPENING_WORDS.has(token)
    || token === FUNCTION_PARENS_TOKEN
    || COMPOUND_PATTERN_LABEL.test(token)
}

/**
 * A word that holds the walk open without opening a command — see
 * {@link CONSTRUCT_HEADER_WORDS}.
 */
function continuesConstructHead(token: string): boolean {
  return CONSTRUCT_HEADER_WORDS.has(token)
}

/** A short option cluster: `-lc`, `+o`, `-O`. */
const SHORT_OPTION_CLUSTER = /^[-+][A-Za-z]+$/
/** A long option, joined value included: `--login`, `--no-rcs`, `--rcfile=f`. */
const LONG_OPTION = /^--[A-Za-z][A-Za-z0-9-]*(?:=.*)?$/
/**
 * Short option CHARACTERS whose value is the next argv word.
 *
 * `o`/`O` are `set -o`/`shopt` names (`bash -o pipefail -c …`,
 * `bash -O extglob -c …`, `zsh -o noglob -c …`), and they consume the next word
 * even from inside a cluster: `bash -oc pipefail '<script>'` RUNS `<script>`,
 * measured 2026-08-25 with a `touch` payload.
 */
const SHELL_VALUE_SHORT_OPTIONS = new Set(['o', 'O'])
/**
 * Long options whose value is the next argv word — `bash --rcfile f -c …`,
 * `bash --init-file f -c …`, `zsh --emulate sh -c …`, each measured running.
 *
 * A value-taking long option MISSING from this set fails toward a miss, not
 * toward a false fire: its value word ends the option scan, so either the
 * operand read is a filename (which names no removal) or no `c` was seen yet
 * and the answer is null. The joined spelling needs no entry —
 * `bash --rcfile=/dev/null -c …` is `invalid option` to bash 3.2.57 and does
 * not run at all — so nothing here pins a string that cannot run.
 */
const SHELL_VALUE_LONG_OPTIONS = new Set(['--rcfile', '--init-file', '--emulate'])

/**
 * Drops the `$` of an ANSI-C (`$'…'`) or locale-translation (`$"…"`) quote.
 *
 * `sh -c $'rm -rf ~'` runs the same command as `sh -c 'rm -rf ~'` (measured
 * running 2026-08-25), but {@link literalText} treats the `$` as an ordinary
 * character and hands back `$rm -rf ~`, whose head is `$rm` and matches
 * nothing. Only the quote INTRODUCER is handled: `$'\x7e'`-style escape
 * decoding is a different mechanism and is not attempted here.
 */
function stripQuoteIntroducer(token: string): string {
  return /^\$['"]/.test(token) ? token.slice(1) : token
}

/**
 * The command line a `sh -c`-style invocation would run, or null.
 *
 * ## The question this asks, and the one it used to ask
 *
 * It used to ask *is this token a short option cluster* and gave up on the
 * first token that was not — so every LONG-form flag hid the script behind it.
 * Eleven spellings were measured open on 2026-08-25, each one confirmed to RUN
 * its operand against a sandbox path with a `touch` payload while the floor
 * returned null and `deny Bash(rm:*)` returned `no-match`: `bash --login -c`
 * (`--login` is bash's FIRST documented long flag), `--norc`, `--noprofile`,
 * `--posix`, `zsh --no-rcs -c`, `bash -o pipefail -c`, `-O extglob`,
 * `--rcfile … -c`, `/usr/bin/env sh -c`, `/usr/bin/sudo sh -c`, `$SHELL -c`,
 * plus `csh`/`tcsh`, `SH -c`/`Bash -c` and `sh -c $'…'`.
 *
 * It now asks the shell's own question — *where does option parsing end* — and
 * that is one rule rather than a set of accepted flags:
 *
 * 1. Option WORDS are consumed until `--` or the first non-option word. A short
 *    cluster is read CHARACTER BY CHARACTER, in order, because that is the
 *    order the value chars bind in.
 * 2. `c` anywhere in a cluster does not name the next word; it sets a flag.
 * 3. The script is the FIRST OPERAND after option parsing ends.
 *
 * Rules 2 and 3 are one measurement, not a guess: `bash -c -- '<script>'` RUNS
 * the script (so `--` is not `c`'s operand), and `bash -co '<script>' pipefail`
 * does NOT (so `c` did not take the word after its cluster — `o` did, and
 * `pipefail` became the script). A "next word after the cluster containing `c`"
 * rule gets both of those backwards. `bash -- -c '<script>'` does not run
 * either, and falls out of rule 1 for free: `--` ends options with no `c` seen,
 * so `-c` is a FILENAME.
 *
 * Anything that is not an option and is not reached with `c` set still ends the
 * scan, which keeps `sh script.sh` from being read as a command line: that
 * file's CONTENTS are not this command's text, and treating them as such would
 * deny on a name rather than on anything the caller wrote.
 *
 * The operand is returned as its LITERAL text ({@link literalText}, after
 * {@link stripQuoteIntroducer}) because the quoting is the wrapper's, not the
 * script's: `sh -c 'rm -rf ~'`, `sh -c "rm -rf ~"` and `sh -c $'rm -rf ~'` run
 * the same command and must match the same rules.
 */
function shellScriptOperand(tokens: readonly string[]): string | null {
  const head = tokens[0]
  if (head === undefined || !namesAShell(head)) return null
  let index = 1
  let sawCommandOption = false
  for (; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token === '--') { index++; break }
    if (LONG_OPTION.test(token)) {
      if (!token.includes('=') && SHELL_VALUE_LONG_OPTIONS.has(token)) index++
      continue
    }
    if (!SHORT_OPTION_CLUSTER.test(token)) break
    for (const character of token.slice(1)) {
      if (character === 'c') { sawCommandOption = true; continue }
      // Its value is the next argv word, cluster or not — so skip that word and
      // keep reading THIS cluster, which is what `-oc pipefail <script>` needs.
      if (SHELL_VALUE_SHORT_OPTIONS.has(character)) index++
    }
  }
  if (!sawCommandOption) return null
  const operand = tokens[index]
  if (operand === undefined) return null
  const script = literalText(stripQuoteIntroducer(operand)).trim()
  return script.length > 0 ? script : null
}

const DYNAMIC_CONTENT = /\$\(|`|\$[A-Za-z_{]/

/**
 * Matches a hook `if` filter of the form `Bash(pattern)` (hooks.md § if).
 *
 * NOT allow-shaped: leading assignments are stripped unconditionally, ANY
 * matching subcommand runs the hook, `$(…)` and backtick contents are checked
 * as subcommands, and a pattern that specifies more than the command name
 * matches whenever the command carries `$(`, backticks, or `$VAR`. The filter
 * is best-effort by contract — the caller fails open on `'unparseable'`.
 *
 * It therefore takes the `s`-carrying `regex`, not `allowRegex`: this is an ANY
 * match on the deny/ask footing, where a `*` that crosses a line terminator can
 * only ever run a hook on MORE commands. {@link compileBashPattern} carries the
 * asymmetry and the measurement.
 */
export function matchClaudeBashIfRule(pattern: string, command: string): ClaudeBashMatchResult {
  const subcommands = splitWithSubstitutions(command)
  if (!subcommands) return 'unparseable'
  let normalized = pattern.trim()
  if (normalized.endsWith(':*')) normalized = `${normalized.slice(0, -2)} *`
  const patternTokens = normalized.split(/\s+/)
  const namesMoreThanCommand = patternTokens.length > 1 && patternTokens.slice(1).some(token => token !== '*')
  if (namesMoreThanCommand && DYNAMIC_CONTENT.test(command)) return 'match'
  const { regex } = compileBashPattern(pattern)
  for (const subcommand of subcommands) {
    const stripped = stripSubcommand(subcommand)
    if (regex.test(stripped.text)) return 'match'
  }
  return 'no-match'
}
