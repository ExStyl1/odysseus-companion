/**
 * Claude `PowerShell(...)` permission-rule matching (permissions.md § PowerShell,
 * re-fetched raw 2026-07-29).
 *
 * Pure string semantics, no I/O and no subprocess — deliberately NOT
 * `powershell-validator.ts`, which shells out to a real `pwsh` to build a true
 * AST. A permission matcher runs inside the decision path on every rule for
 * every call and must be total, synchronous and available on a machine with no
 * PowerShell installed; the validator is none of those. What this module
 * mirrors instead is `claude-bash-rule.ts`, which the docs make the right
 * reference: "PowerShell permission rules use the same shape as Bash rules.
 * Wildcards with `*` match at any position, the `:*` suffix is equivalent to a
 * trailing ` *`, and a bare `PowerShell` or `PowerShell(*)` matches every
 * command."
 *
 * The two PowerShell-only rules are the alias table and case-insensitivity:
 *
 *   "Common aliases are canonicalized before matching. A rule written for the
 *   cmdlet name also matches its aliases, so `PowerShell(Get-ChildItem *)`
 *   matches `gci`, `ls`, and `dir` as well. Matching is case-insensitive."
 *
 *   "Claude Code parses the PowerShell AST and checks each command in a
 *   compound command independently. Pipeline operators `|`, statement
 *   separators `;`, and on PowerShell 7+ the chain operators `&&` and `||`
 *   split a compound command into subcommands. A rule must match every
 *   subcommand for the compound command to be allowed."
 */

// The only import this pure module takes, and it is deliberate: the line-
// terminator class the allow branch refuses must be the SAME one the Bash side
// refuses, because "identical shape" drifting apart is what produced P2.329 and
// then P2.350. `claude-bash-rule.ts` imports nothing, so there is no cycle.
import { LINE_TERMINATOR } from './claude-bash-rule.ts'

export type ClaudePowerShellMatchResult = 'match' | 'no-match' | 'unparseable'
export type ClaudePowerShellRuleAction = 'allow' | 'deny' | 'ask'

const MAX_COMMAND_LENGTH = 10_000

/**
 * Canonical cmdlet name keyed by lowercased alias.
 *
 * The shipped `Set-Alias` defaults, minus `curl` and `wget`. Those two alias to
 * `Invoke-WebRequest` in Windows PowerShell 5.1 only and were removed in
 * PowerShell 7, and unlike every other row here their Unix meaning is a
 * DIFFERENT and more capable program — an allow rule for `Invoke-WebRequest`
 * must not become an allow rule for real curl. Every other alias
 * (`ls`/`dir`/`cat`/`rm`/`cp`) names the same operation either way.
 */
const CMDLET_ALIAS_TABLE = {
  gci: 'get-childitem', ls: 'get-childitem', dir: 'get-childitem',
  gc: 'get-content', cat: 'get-content', type: 'get-content',
  gcm: 'get-command',
  gps: 'get-process', ps: 'get-process',
  gsv: 'get-service',
  gl: 'get-location', pwd: 'get-location',
  sl: 'set-location', cd: 'set-location', chdir: 'set-location',
  gi: 'get-item',
  gp: 'get-itemproperty', sp: 'set-itemproperty',
  si: 'set-item',
  copy: 'copy-item', cp: 'copy-item', cpi: 'copy-item',
  move: 'move-item', mv: 'move-item', mi: 'move-item',
  del: 'remove-item', erase: 'remove-item', rd: 'remove-item',
  ri: 'remove-item', rm: 'remove-item', rmdir: 'remove-item',
  ni: 'new-item',
  ren: 'rename-item', rni: 'rename-item',
  clc: 'clear-content', sc: 'set-content', ac: 'add-content',
  where: 'where-object', '?': 'where-object',
  foreach: 'foreach-object', '%': 'foreach-object',
  select: 'select-object', sort: 'sort-object',
  measure: 'measure-object', group: 'group-object',
  compare: 'compare-object', diff: 'compare-object',
  iex: 'invoke-expression', icm: 'invoke-command',
  iwr: 'invoke-webrequest', irm: 'invoke-restmethod', ii: 'invoke-item',
  start: 'start-process', saps: 'start-process',
  kill: 'stop-process', spps: 'stop-process',
  echo: 'write-output', write: 'write-output',
  sls: 'select-string', tee: 'tee-object',
  gm: 'get-member', nal: 'new-alias',
  h: 'get-history', history: 'get-history', ghy: 'get-history',
  gjb: 'get-job',
  cls: 'clear-host', clear: 'clear-host',
  set: 'set-variable', sv: 'set-variable',
  gv: 'get-variable', rv: 'remove-variable',
  rvpa: 'resolve-path', pushd: 'push-location', popd: 'pop-location',
  ipmo: 'import-module', gmo: 'get-module',
} as const

const CMDLET_ALIASES: ReadonlyMap<string, string> = new Map(Object.entries(CMDLET_ALIAS_TABLE))

/** The cmdlet every removal alias in {@link CMDLET_ALIAS_TABLE} canonicalises to. */
export const POWERSHELL_REMOVAL_CMDLET = 'remove-item'

/**
 * Every head this module resolves to `remove-item`, as a TYPE, derived from the
 * alias table rather than restated beside it.
 *
 * ## Why a type and not a second list (P2.84)
 *
 * `removal-circuit-breaker.ts` has to know, per removal head, whether the shell
 * that resolves it BINDS PARAMETERS — `del`/`erase`/`rd`/`rmdir` are `cmd.exe`
 * internals that take filenames, `remove-item`/`ri`/`rm` are cmdlets that bind
 * `-Exclude` and friends (P2.74). That was a hand-kept set in the other file
 * with NOTHING asserting it partitioned this table, and the direction of the
 * drift is the dangerous one: a cmd builtin added here would silently inherit
 * the PowerShell parameter rule and stop classifying its own operands.
 *
 * A test comparing the two lists would only prove they agree with each other —
 * the shape `P2.94` rejected for the same reason. So there is ONE value, and
 * the per-item site over it is made TOTAL by the type system: this union is
 * computed from the table, and the classification is a
 * `Record<PowerShellRemovalHead, …>`, which TypeScript will not accept with a
 * key missing. Adding `deltree: 'remove-item'` here therefore breaks the BUILD
 * at the site that has to decide, rather than a test that might not exist.
 */
export type PowerShellRemovalHead =
  | typeof POWERSHELL_REMOVAL_CMDLET
  | {
    [K in keyof typeof CMDLET_ALIAS_TABLE]:
    typeof CMDLET_ALIAS_TABLE[K] extends typeof POWERSHELL_REMOVAL_CMDLET ? K : never
  }[keyof typeof CMDLET_ALIAS_TABLE]

/**
 * Splits a compound PowerShell command on the documented separators at the top
 * nesting level: `|`, `;`, `&&`, `||`, and newlines. A separator inside a `#`
 * COMMENT TAIL does not separate. Returns null when the command cannot be
 * balanced or is longer than the analysis parses.
 *
 * Quoting follows PowerShell, not sh: `'` is literal (a doubled `''` escapes a
 * quote inside it), `"` interpolates, and the escape character is the BACKTICK,
 * not the backslash — a Windows path `C:\dir` carries no escape at all.
 *
 * ## The comment rule (P2.75), and the four things it deliberately is not
 *
 * `#` opens a comment where a TOKEN begins, and the comment runs to the end of
 * the line — the same rule `tokenizePowerShell` in `removal-circuit-breaker.ts`
 * already applies one layer down. That layer is why this defect survived P2.51:
 * the tokenizer never saw the tail, because THIS function had already split on a
 * `;` or `|` inside it and handed the text after it on as a real subcommand.
 * `Remove-Item ./a.txt # note | Remove-Item /usr` was an every-mode deny raised
 * on a note (MEASURED 2026-08-23: the ladder returned `system-path` on `/usr`).
 *
 * The language specification, rather than our inference — PowerShell-Docs
 * `reference/docs-conceptual/lang-spec/chapter-02.md` § 2.2.3, fetched raw
 * 2026-08-23:
 *
 *   "A character sequence is only recognized as a comment if that sequence
 *   begins with `#` or `<#`. For example, hello#there is considered a single
 *   token whereas hello #there is considered the token hello followed by a
 *   single-line comment." … "As well as following white space, the comment start
 *   sequence can also be preceded by any expression-terminating or
 *   statement-terminating character (such as `)`, `}`, `]`, `'`, `"`, or `;`)."
 *
 * That sentence settles two things this file used to assume. The `<#` guard
 * below is conservative rather than wrong, and — once U+FEFF is excluded from the
 * token-start test — our blank set matches the spec's § 2.2.4 whitespace
 * (Unicode Zs/Zl/Zp plus tab, VT and FF) exactly. It used to test JS `/\s/`,
 * which matches U+FEFF too, though PowerShell does not (class Cf, and
 * `Char.IsWhiteSpace` returns false for it): that one character opened a comment
 * the spec does not, letting a `#` after it suppress a real split (P2.99 / F2,
 * fixed here). With it gone the token-start rule is a SUBSET of the spec's — the
 * spec ALSO opens a comment after `)`, `}`, `]`, `'`, `"` and `;`, which we do
 * not — so we scan more, never less.
 *
 * ## Suppressing a split WIDENS ALLOW, and that is the part to watch
 *
 * An allow rule requires EVERY subcommand to match, so removing a subcommand can
 * only help it. MEASURED 2026-08-23 through `evaluatePermissionDslV1`:
 * `allow PowerShell(Get-ChildItem *)` had no decision on
 * `gci # note ; Remove-Item /` and now returns **allow**; likewise
 * `allow PowerShell(Remove-Item *)` on `Remove-Item /usr # note ; gci`. The
 * DIRECTION is correct — the spec sentence above says PowerShell runs only
 * `gci` — but it is a real widening of every glob `PowerShell(...)` allow rule
 * and it is pinned in the test file rather than left to be rediscovered. The
 * controls that must not move are pinned with it: `gci ; Remove-Item /` (no
 * comment) still has no decision, and the `<#` form still has none.
 *
 * - **The tail is NOT excised from the segment**, unlike the sh splitter's. The
 *   asymmetry is deliberate and it is about the consumers: `findShRemoval`
 *   tokenizes through a stripper with no comment rule, so there the text has to
 *   go; here both Windows scans tokenize through `tokenizePowerShell`, which
 *   stops at the `#` on its own. Excising would only widen EXACT
 *   `PowerShell(...)` rules onto commands carrying a comment, which no defect
 *   asks for, and a rule that fails to match still prompts.
 * - **A `<#` anywhere disables the rule for the whole command.** PowerShell's
 *   block comment spans lines, and a line INSIDE one can begin with `#` — so a
 *   line rule applied there could swallow real code after the `#>` and hide a
 *   command from the scan, the one direction this must never fail in. No `pwsh`
 *   exists on this rig to measure block-comment parsing against, so rather than
 *   ship unmeasured semantics the guard restores the parent behaviour verbatim:
 *   the command keeps splitting inside its comments, which only over-fires.
 * - **Top level only**, and a token begins only after start-of-input or an
 *   unquoted, unescaped BLANK — never after one of the terminating characters
 *   § 2.2.3 also allows. Both are the same subset argument the sh splitter
 *   makes: where this rule and the spec's differ, this one scans MORE.
 * - **It may NARROW a parse, never rescue one** — see the balance pass in the
 *   function body, and the sh splitter's `scanCommand` for the same ordering and
 *   the standing "dumber, not smarter" ruling behind it.
 */
export function splitPowerShellCommand(command: string): string[] | null {
  if (command.length > MAX_COMMAND_LENGTH) return null
  // THE COMMENT RULE MAY NARROW A PARSE, NEVER RESCUE ONE. This pass reads the
  // command exactly as the parent did, and its verdict is final. A comment can
  // contain an apostrophe — `Remove-Item ./a.txt # it's here` — and skipping the
  // text would hide the unbalanced quote that made the command `'unparseable'`,
  // turning the prompt that verdict produces into an `allow` under a rule like
  // `PowerShell(Remove-Item *)`. When in doubt, refuse to parse and ask.
  if (!scanPowerShellCommand(command, false)) return null
  const segments = scanPowerShellCommand(command, true)
  if (!segments || !command.includes('@')) return segments
  // P2.92 — the HERE-STRING reading, APPENDED and never substituted. See
  // {@link hereStringAwareForms} for what pwsh measured and why appending is
  // safe in both rule directions here, unlike on the sh side.
  const forms = scanPowerShellCommand(command, true, true)
  if (!forms) return segments
  return [...segments, ...forms.filter(form => !segments.includes(form))]
}

/**
 * PowerShell HERE-STRINGS (`@'…'@`, `@"…"@`) — P2.92, and the measurement that
 * turned it from a recorded suspicion into a live defect.
 *
 * The row recorded this as "unmodelled" and could not settle it: "every shape
 * tried landed on `unparseable` -> prompt, and there is no `pwsh` on this rig".
 * There is one now (7.6.5), and pointed at it the miss is real and EXECUTABLE.
 * Measured through `[Parser]::ParseInput` — a parse, never a run — on
 * `$x = @'`+LF+`don't`+LF+`'@`+LF+`Remove-Item -Recurse -Force <path> #'`:
 *
 * - **pwsh: two statements, ZERO parse errors.** A valid script that removes.
 * - the splitter: `["$x = @'`+LF+`don't", "'@`+LF+`Remove-Item … #'"]`
 * - `deny PowerShell(Remove-Item *)`: **`no-match`**
 *
 * The mechanism is the sh `<<` desync exactly: the apostrophe in `don't` CLOSES
 * the span the `@'` opened, the scanner splits at a newline that is inside the
 * here-string body, and the second segment's HEAD becomes `'@` rather than
 * `Remove-Item` — so a head-anchored deny cannot see it. The trailing `#'` is
 * what restores quote parity, which is why the command BALANCES instead of
 * falling to the `'unparseable'` prompt every earlier attempt hit.
 *
 * ## The rules below were READ from the shipped binary, not inferred
 *
 * Measured 2026-08-29 against pwsh 7.6.5, each row a script `ParseInput` was
 * given (the parse error text is pwsh's own):
 *
 * | shape | pwsh |
 * | --- | --- |
 * | `@'` then optional blanks then EOL | opens a here-string |
 * | `@'junk` then EOL | ERROR "No characters are allowed after a here-string header" |
 * | `'@` at the START of a line | terminates it |
 * | `  '@` (indented) | ERROR "White space is not allowed before the string terminator" |
 * | `body '@` (mid-line) | NOT a terminator — "The string is missing the terminator" |
 * | `'@ junk` | terminates, and `junk` is a separate (erroring) token |
 * | `a@'` — opener GLUED to a preceding token | still opens one |
 * | `'@'` — inside an ordinary single-quoted string | NOT an opener |
 * | CRLF endings | unchanged |
 *
 * The glued-opener row is the one worth naming: a token-start rule, which is
 * what both this file's comment rule and its sh sibling use, would have been
 * WRONG here. It was measured rather than assumed.
 *
 * ## Why this reading is APPENDED, and why appending is enough on this side
 *
 * The sh splitter needed an asymmetry for the same class (P2.363): its allow
 * and deny paths read different lists, so a refusal on one would have cost the
 * other. PowerShell does not have that problem — {@link matchClaudePowerShellRule}
 * reads ONE list, requiring EVERY segment to match for an allow and ANY segment
 * for a deny/ask. So a longer list is strictly harder to allow and strictly
 * easier to deny: appending moves both directions the safe way at once, and no
 * verdict this reading is wrong about can approve more than before.
 *
 * It is still not a rescue: the reading is only ever ADDED to the one the parent
 * produced, which stays first, so nothing a deny already matched can be lost.
 */
function scanPowerShellCommand(
  command: string,
  honourComments: boolean,
  inertHereStrings = false,
): string[] | null {
  const segments: string[] = []
  let segmentStart = 0
  let singleQuote = false
  let doubleQuote = false
  let escaped = false
  let depth = 0
  // A token boundary, not the previous character: a quoted or backtick-escaped
  // blank keeps the token open, so the `#` after it is ordinary text.
  let tokenStart = true
  const blockComment = command.includes('<#')
  for (let index = 0; index < command.length; index++) {
    const current = command[index]!
    const atTokenStart = tokenStart
    tokenStart = false
    if (escaped) { escaped = false; continue }
    if (current === '`') { escaped = true; continue }
    // A HERE-STRING is inert text to PowerShell, and a state change to this
    // scanner — the P2.92 desync. Only the extra reading turns this on; the
    // parent's reading is produced with it off and stays first in the list.
    if (inertHereStrings && !singleQuote && !doubleQuote && current === '@') {
      const end = hereStringEnd(command, index)
      if (end >= 0) { index = end; continue }
    }
    if (singleQuote) {
      if (current === "'") singleQuote = false
      continue
    }
    if (doubleQuote) {
      if (current === '"') doubleQuote = false
      continue
    }
    if (current === "'") { singleQuote = true; continue }
    if (current === '"') { doubleQuote = true; continue }
    if (current === '(' || current === '{' || current === '[') { depth++; continue }
    if (current === ')' || current === '}' || current === ']') {
      depth--
      if (depth < 0) return null
      continue
    }
    if (depth > 0) continue
    if (honourComments && current === '#' && atTokenStart && !blockComment) {
      // Skip to just BEFORE the line ending, so the newline still separates.
      let end = index + 1
      while (end < command.length && command[end] !== '\n' && command[end] !== '\r') end++
      index = end - 1
      continue
    }
    // The blank set is PowerShell's, not JavaScript's. § 2.2.4 whitespace is
    // Unicode Zs/Zl/Zp plus tab, VT and FF — every member of JS `/\s/` EXCEPT
    // U+FEFF (class Cf, and `Char.IsWhiteSpace('\uFEFF')` is false in modern
    // .NET). Unlike sh, PowerShell genuinely treats NBSP, U+3000, VT and FF as
    // whitespace, so narrowing to space+tab would miss comments it opens; the
    // sole divergence is U+FEFF, where `/\s/` opened a comment PowerShell does
    // not (P2.99 / F2) — so `\s` minus that one character is the exact set.
    if (/\s/.test(current) && current !== '\uFEFF') tokenStart = true
    const next = command[index + 1]
    let width = 0
    if (current === '\n' || current === '\r') width = current === '\r' && next === '\n' ? 2 : 1
    else if (current === '&' && next === '&') width = 2
    else if (current === '|' && next === '|') width = 2
    else if (current === '|' || current === ';') width = 1
    if (width === 0) continue
    segments.push(command.slice(segmentStart, index))
    segmentStart = index + width
    index += width - 1
  }
  if (singleQuote || doubleQuote || escaped || depth !== 0) return null
  segments.push(command.slice(segmentStart))
  const trimmed = segments.map(segment => segment.trim()).filter(segment => segment.length > 0)
  return trimmed.length > 0 ? trimmed : null
}

/**
 * The index of the last character of the here-string opening at `index`, or -1
 * when nothing here-string-shaped starts there.
 *
 * Every rule is one of the rows measured against pwsh 7.6.5 in
 * {@link scanPowerShellCommand}'s docstring, and each is here because guessing
 * it would have gone the other way:
 *  - the opener is `@` + `'`/`"` followed by BLANKS ONLY to the line end; any
 *    other character makes it a parse error in pwsh rather than a here-string,
 *    so refusing to treat it as one keeps this reading a subset of the shell's;
 *  - the terminator is `'@`/`"@` at the START of a line, matching the opener's
 *    quote character; leading whitespace is an error in pwsh, so it does not
 *    terminate here either;
 *  - the opener does NOT have to sit at a token start (`a@'` opens one), which
 *    is why there is no `atTokenStart` test in the caller.
 *
 * Returns -1 for an UNTERMINATED here-string too, so the caller falls back to
 * scanning it as ordinary text — which is what leaves the command unbalanced and
 * therefore `'unparseable'`, the direction this file already prefers.
 */
function hereStringEnd(command: string, index: number): number {
  const quote = command[index + 1]
  if (quote !== "'" && quote !== '"') return -1
  let cursor = index + 2
  while (cursor < command.length && (command[cursor] === ' ' || command[cursor] === '\t')) cursor++
  if (command[cursor] !== '\n' && !(command[cursor] === '\r' && command[cursor + 1] === '\n')) return -1
  // Scan line by line for a line that BEGINS with the matching terminator.
  for (let lineStart = command.indexOf('\n', cursor) + 1; lineStart > 0; ) {
    if (command[lineStart] === quote && command[lineStart + 1] === '@') return lineStart + 1
    const next = command.indexOf('\n', lineStart)
    if (next < 0) return -1
    lineStart = next + 1
  }
  return -1
}

/**
 * The canonical cmdlet name for ONE command head, lowercased — `rm`, `del`,
 * `rd`, `ri` and `rmdir` all come back as `remove-item`.
 *
 * Exported because a caller can need to recognise a cmdlet by IDENTITY rather
 * than match a rule pattern against it: the removal circuit breaker asks "is
 * this Remove-Item?" and must read the same shipped `Set-Alias` table the rule
 * matcher reads. A second copy of that table is a copy that drifts, and a
 * removal spelling missing from the breaker's copy is a home directory nobody
 * was asked about.
 */
export function canonicalPowerShellCommandName(head: string): string {
  const name = head.trim().toLowerCase()
  return CMDLET_ALIASES.get(name) ?? name
}

/** Replaces a leading alias with its canonical cmdlet name; lowercases the rest. */
function canonicalizePowerShell(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length === 0) return trimmed
  const boundary = trimmed.search(/\s/)
  const head = (boundary === -1 ? trimmed : trimmed.slice(0, boundary)).toLowerCase()
  const rest = boundary === -1 ? '' : trimmed.slice(boundary).toLowerCase()
  return `${canonicalPowerShellCommandName(head)}${rest}`
}

/**
 * Compiles one PowerShell rule pattern. Identical shape to the Bash compiler —
 * `:*` at the end equals a trailing ` *`, a trailing ` *` enforces a word
 * boundary, and `*` is the only metacharacter — except that the pattern is
 * canonicalized and the comparison is case-insensitive.
 *
 * "Identical shape" included the missing `s` flag, so this compiler carried the
 * SAME deny bypass the Bash one did (P2.329) and was found by sweeping for it
 * rather than by a report of its own. See `compileBashPattern`'s docblock for
 * the mechanism and the measurement; the contract is the same sentence one
 * section over — permissions.md#powershell: "PowerShell permission rules use
 * the same shape as Bash rules. Wildcards with `*` match at any position, the
 * `:*` suffix is equivalent to a trailing ` *`, and a bare `PowerShell` or
 * `PowerShell(*)` matches every command."
 *
 * IT THEN CARRIED THE FIX'S OWN REGRESSION TOO, and again nobody reported it —
 * the P2.350 row named the Bash compiler and asked whether the allow-side hole
 * was reachable here. It was, by the same shape one comment character over:
 * `splitPowerShellCommand` disables its `#` rule when the command contains `<#`
 * (block comment), so
 *
 * ```
 * Get-Content x <# n #> # don't
 * Remove-Item -Recurse ~ #'
 * ```
 *
 * splits into ONE segment, and with `s` on the allow side
 * `allow PowerShell(Get-Content *)` matched the whole two-line text while
 * `deny PowerShell(Remove-Item *)` did not fire. Measured at `0d7af52cd^`:
 * `no-match`, i.e. a prompt.
 *
 * So keep the two compilers' ASYMMETRY equal, which is the thing that was
 * really meant by "keep the flag lists equal": `s` on the deny/ask regex, no
 * `s` on the allow one, and one explicit refusal of a glob allow over a
 * subcommand that still carries a line terminator. {@link LINE_TERMINATOR} is
 * imported rather than re-spelled for exactly that reason.
 */
function compilePowerShellPattern(rawPattern: string): {
  regex: RegExp
  allowRegex: RegExp
  hasGlob: boolean
} {
  let pattern = rawPattern.trim()
  if (pattern.endsWith(':*')) pattern = `${pattern.slice(0, -2)} *`
  const boundary = pattern.endsWith(' *')
  if (boundary) pattern = pattern.slice(0, -2)
  // After the slice, so the trailing ` *` this strips still counts as a glob —
  // it is the same `hasGlob` the Bash compiler computes BEFORE its own slice.
  const hasGlob = boundary || pattern.includes('*')
  const canonical = canonicalizePowerShell(pattern)
  const glob = canonical
    .split('*')
    .map(chunk => chunk.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  const source = `^${glob}${boundary ? '(?: .*)?' : ''}$`
  return { regex: new RegExp(source, 'us'), allowRegex: new RegExp(source, 'u'), hasGlob }
}

/**
 * Matches one Claude `PowerShell(prefix)` rule against a command.
 *
 * Allow rules require EVERY subcommand to match ("A rule must match every
 * subcommand for the compound command to be allowed"); deny and ask rules match
 * when ANY subcommand does, the same asymmetry `matchClaudeBashRule` carries.
 * The caller owns the posture for `'unparseable'`.
 *
 * That asymmetry now extends to the compiled pattern itself — an allow matches
 * through the `u`-only `allowRegex` and refuses a glob over any segment still
 * carrying a line terminator, exactly as `subcommandMatches` does (P2.350).
 */
export function matchClaudePowerShellRule(
  pattern: string,
  command: string,
  options: { ruleAction: ClaudePowerShellRuleAction },
): ClaudePowerShellMatchResult {
  const subcommands = splitPowerShellCommand(command)
  if (!subcommands) return 'unparseable'
  const { regex, allowRegex, hasGlob } = compilePowerShellPattern(pattern)
  if (options.ruleAction === 'allow') {
    const approves = subcommands.every(subcommand => {
      const text = canonicalizePowerShell(subcommand)
      if (hasGlob && LINE_TERMINATOR.test(text)) return false
      return allowRegex.test(text)
    })
    return approves ? 'match' : 'no-match'
  }
  return subcommands.some(subcommand => regex.test(canonicalizePowerShell(subcommand)))
    ? 'match'
    : 'no-match'
}

/**
 * Whether a shell command is PowerShell rather than sh.
 *
 * This repo runs ONE shell tool, so a `PowerShell(...)` rule and a `Bash(...)`
 * rule both see the same call, and this predicate is what decides which of them
 * is entitled to judge it. It lives here, in the pure module, as the ONE wide
 * language predicate. Since UA12.104 `mode-manager.ts` routes to the PowerShell
 * AST validator on a narrower answer, its `looksLikePowerShellOutsidePosixTest`
 * (`test 1 -eq 1` is bash there, PowerShell here, sparing a pwsh spawn); this
 * one is not narrowed, so the DSL and the removal breaker read it as before.
 *
 * F1.468 — a Verb-Noun is a cmdlet only in COMMAND position: at the start, or
 * after a separator PowerShell runs a new command after (`;` `|` `&` `(` `{`, a
 * newline, `$var =`), optionally quoted (`& "Remove-Item"`). Matched anywhere,
 * an sh command whose ARGUMENT is spelled like one — `kubectl config
 * get-contexts`, `npm run test-unit` — read as PowerShell, and with `pwsh`
 * installed `mode-manager.ts` then sent it to the PowerShell parser (a spawn
 * with P2.240's deliberate 10 s ceiling, left as it is: bounding the parse
 * means not starting it for a command that is not PowerShell).
 *
 * F1.499 (2) — DECIDED, for the residue F1.468 named: a Linux command whose own
 * NAME is Verb-Noun-shaped sits in command position too. Two SHAPES tell it
 * apart, and neither is a list of names: a cmdlet name is ONE Verb-Noun pair
 * (`start-stop-daemon` carries a second hyphenated segment), and a cmdlet takes
 * `-Param` parameters, never a GNU `--long` option, so a Verb-Noun followed by
 * `--word` is sh (`update-alternatives --config java`). The stop-parsing token
 * `--%` is PowerShell's own and is not a `--word`. What is left is a bare
 * one-pair name with no `--` option (`update-alternatives` alone), still read as
 * PowerShell — the same answer as before, on a command that does nothing
 * without an option.
 */
export function looksLikePowerShell(command: string): boolean {
  const psPatterns = [
    // Cmdlet pattern: Verb-Noun, in command position only (F1.468), ONE pair and no GNU `--long` option after it (F1.499 (2))
    /(?:^|[\n;|&({]|\$\w+\s*=)\s*["']?(Get|Set|New|Remove|Add|Clear|Write|Read|Out|ConvertTo|ConvertFrom|Test|Select|Where|ForEach|Sort|Group|Measure|Compare|Format|Export|Import|Start|Stop|Invoke|Enable|Disable|Register|Unregister|Update|Find|Install|Uninstall|Save|Publish|Push|Pop)-\w+(?![-\w])(?!["']?\s+--[A-Za-z])/i,

    // PowerShell variables in pipeline
    /\$\w+\s*\|/,

    // PowerShell operators
    /\s-(?:eq|ne|gt|lt|ge|le|like|notlike|match|notmatch|contains|notcontains|in|notin|replace|split|join)\s/i,

    // Array/hashtable literals
    /@\([^)]*\)/,
    /@\{[^}]*\}/,

    // PowerShell specific cmdlets
    /\b(Where-Object|Select-Object|ForEach-Object|Sort-Object|Group-Object|Measure-Object)\b/i,

    // Common PowerShell aliases that differ from Unix
    /\b(gci|gcm|gps|gsv|gjb)\b/i,
  ]

  return psPatterns.some(p => p.test(command))
}

/**
 * The PowerShell host executables, lower-cased and extension-free.
 *
 * `powershell` is Windows PowerShell 5.1, `pwsh` is PowerShell 7+, and
 * `pwsh-preview` is the side-by-side preview channel. A head is matched by
 * BASENAME, case-insensitively, with a `.exe` suffix removed — the same three
 * normalisations `claude-bash-rule.ts` applies to an sh head, and for the same
 * reason: `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` and
 * `pwsh` are one host spelled two ways.
 */
const POWERSHELL_HOST_NAMES: ReadonlySet<string> = new Set([
  'pwsh', 'powershell', 'pwsh-preview',
])

/**
 * The host parameters that carry a script, and the FULL name each one is a
 * prefix of.
 *
 * ## Measured, not inferred — on a real pwsh 7.6.5
 *
 * The host's own argument parser accepts any non-empty case-insensitive PREFIX
 * of these names, which is a different rule from the cmdlet parameter binder's
 * (that one refuses an AMBIGUOUS prefix). Executed on 2026-08-26 against
 * `pwsh 7.6.5` (macOS arm64, homebrew), each payload creating a marker file
 * inside the lane sandbox and the marker's presence being the verdict:
 *
 * - RAN: `-Command`, `-command`, `-COMMAND`, `-c`, `-C`, `-Co`, `-Com`,
 *   `-Comm`, `-Comma`, `-Comman`.
 * - did NOT run: `-Cm`, `-Cmd` — neither is a prefix of `command`.
 * - RAN: `-File`, `-file`, `-f`, `-Fi`, `-Fil`.
 * - RAN: `-EncodedCommand`, `-encodedcommand`, `-e`, `-E`, `-ec`, `-en`,
 *   `-enc`, `-Encoded`.
 * - `-c` binds `-Command` even though `-ConfigurationName` and
 *   `-CustomPipeName` also begin with `c`, and `-e` binds `-EncodedCommand`
 *   even though `-ExecutionPolicy` also begins with `e` — both MEASURED, and
 *   both are why a "refuse ambiguous prefixes" rule copied from the cmdlet
 *   binder would MISS the shortest and most likely spellings.
 *
 * Also measured, and deliberately NOT accepted here because the host rejects
 * them: `-Command:<script>`, `-Command=<script>`, `/Command`, `/c`, a `--`
 * before the script, and a bare script with no parameter at all. Modelling a
 * spelling the host refuses would be the P2.142 trap — an assertion about a
 * string nobody can execute.
 */
const POWERSHELL_HOST_SCRIPT_PARAMETERS: ReadonlyArray<{
  readonly name: string
  readonly kind: PowerShellHostScriptKind
}> = [
  { name: 'command', kind: 'command' },
  { name: 'encodedcommand', kind: 'encodedcommand' },
  { name: 'file', kind: 'file' },
]

/**
 * The host parameter spellings that are NOT prefixes of any name above.
 *
 * One entry, and it is a measurement rather than caution: `-ec` RUNS on
 * pwsh 7.6.5 while `'encodedcommand'.startsWith('ec')` is false — the second
 * letter is `n` — so a pure-prefix rule misses the alias PowerShell's own help
 * advertises alongside `-e`. This lane's first draft had exactly that hole, and
 * its own test against the oracle caught it. Bounded by re-probe: `-ec`, `-eC`
 * and `-EC` RAN; `-ecx` and `-ea` did NOT, so the alias is `ec` exactly and not
 * a second prefix family.
 */
const POWERSHELL_HOST_PARAMETER_ALIASES: ReadonlyMap<string, PowerShellHostScriptKind> =
  new Map([['ec', 'encodedcommand']])

export type PowerShellHostScriptKind = 'command' | 'encodedcommand' | 'file'

/** What a PowerShell host was handed, once resolved. */
export type PowerShellHostScript =
  /** Script text this floor can read. */
  | { readonly kind: 'script'; readonly text: string }
  /**
   * A script this floor cannot read: a `-File` path, or an `-EncodedCommand`
   * payload that does not decode. Reported rather than dropped, because a
   * payload the floor cannot read is the same fail-open shape as an
   * unparseable command (P2.144) and the caller must be able to say so.
   */
  | { readonly kind: 'unreadable'; readonly why: 'file' | 'undecodable' }

function powerShellHostScriptParameter(token: string): PowerShellHostScriptKind | null {
  if (!token.startsWith('-') || token.startsWith('--')) return null
  const named = token.slice(1).toLowerCase()
  if (named.length === 0) return null
  const alias = POWERSHELL_HOST_PARAMETER_ALIASES.get(named)
  if (alias !== undefined) return alias
  for (const parameter of POWERSHELL_HOST_SCRIPT_PARAMETERS) {
    if (parameter.name.startsWith(named)) return parameter.kind
  }
  return null
}

/** A head in one comparable spelling: basename, no `.exe`, lower-cased. */
function powerShellHostName(head: string): string {
  const bare = head.replace(/^['"]|['"]$/g, '')
  const basename = bare.split(/[\\/]/).pop() ?? bare
  return basename.replace(/\.exe$/i, '').toLowerCase()
}

/**
 * Splits a command into words, keeping quoted runs together and DROPPING the
 * quote characters, so the yielded words are what the host receives in `argv`.
 *
 * Deliberately posture-matched to the removal floor rather than to a shell
 * grammar: this runs on the OUTER command line, which may have been written for
 * sh or for cmd, so both quote characters are honoured and a backslash is left
 * alone (a Windows path carries no escape).
 */
function powerShellHostArgv(command: string): string[] {
  const words: string[] = []
  let current = ''
  let started = false
  let quote: "'" | '"' | null = null
  for (const character of command) {
    if (quote !== null) {
      if (character === quote) { quote = null; continue }
      current += character
      continue
    }
    if (character === "'" || character === '"') { quote = character; started = true; continue }
    if (/\s/.test(character)) {
      if (started) { words.push(current); current = ''; started = false }
      continue
    }
    current += character
    started = true
  }
  if (started) words.push(current)
  return words
}

/**
 * Decodes an `-EncodedCommand` payload, or null.
 *
 * UTF-16LE, and that is MEASURED rather than taken from the docs: on pwsh 7.6.5
 * the same script base64-encoded as UTF-16LE RAN and as UTF-8 did NOT. The row
 * that asked for this said plainly not to model `-EncodedCommand` without
 * decoding it — an undecodable payload is reported as `unreadable`, never
 * silently skipped, because a payload the floor cannot read is exactly the
 * fail-open shape it exists to prevent.
 */
function decodePowerShellEncodedCommand(payload: string): string | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return null
  let bytes: Uint8Array
  try {
    const binary = atob(payload)
    bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  } catch { return null }
  if (bytes.length % 2 !== 0) return null
  let text = ''
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    text += String.fromCharCode(bytes[index]! | (bytes[index + 1]! << 8))
  }
  return text
}

/**
 * The script a PowerShell HOST was handed, however the host and its parameter
 * were spelled — the PowerShell counterpart of the sh resolution P2.151 built.
 *
 * Returns an empty array when the command is not a PowerShell host invocation,
 * so a caller can run it unconditionally.
 *
 * ## Why this is one resolver and not a list of flag clusters
 *
 * P2.151 fixed the sh half of this floor by making it resolve the shell and its
 * script operand THE WAY THE SHELL DOES, after a hand-listed set of flag
 * clusters had been shown to miss eleven real spellings. The PowerShell half was
 * split out of that row for three stated reasons, and the first was that there
 * was no oracle on the host — so every claim would have been unexecuted, which
 * is how the wrong spellings got recorded in the first place. A real
 * `pwsh 7.6.5` was installed for this row and every argv claim above was
 * executed against it, with a sandbox-only payload, through the lane's guard.
 *
 * The rule the measurements produced: option words are consumed until a
 * script-bearing parameter is seen; the parameter is any non-empty
 * case-insensitive prefix of `command`, `encodedcommand` or `file`; `-Command`
 * takes ALL REMAINING WORDS joined by a space (measured: a multi-word script
 * after `-Command` runs), `-EncodedCommand` takes one base64 word, and `-File`
 * takes a path this floor cannot read.
 */
export function powerShellHostScripts(command: string): PowerShellHostScript[] {
  if (!command || command.length > MAX_COMMAND_LENGTH) return []
  const words = powerShellHostArgv(command)
  const [head, ...rest] = words
  if (head === undefined) return []
  if (!POWERSHELL_HOST_NAMES.has(powerShellHostName(head))) return []
  const scripts: PowerShellHostScript[] = []
  for (let index = 0; index < rest.length; index++) {
    const word = rest[index]
    if (word === undefined) continue
    const parameter = powerShellHostScriptParameter(word)
    if (parameter === null) continue
    if (parameter === 'command') {
      const text = rest.slice(index + 1).join(' ').trim()
      if (text.length > 0) scripts.push({ kind: 'script', text })
      break
    }
    const value = rest[index + 1]
    if (value === undefined) break
    if (parameter === 'file') {
      scripts.push({ kind: 'unreadable', why: 'file' })
      break
    }
    const decoded = decodePowerShellEncodedCommand(value)
    scripts.push(decoded === null
      ? { kind: 'unreadable', why: 'undecodable' }
      : { kind: 'script', text: decoded })
    break
  }
  return scripts
}
