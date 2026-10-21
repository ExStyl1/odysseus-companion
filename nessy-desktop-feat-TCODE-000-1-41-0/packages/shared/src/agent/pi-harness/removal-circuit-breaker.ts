/**
 * The removal circuit breaker: does this Bash command remove the filesystem
 * root or the home directory?
 *
 * Contract source, fetched with `curl -s` on 2026-07-29:
 *
 * `code.claude.com/docs/en/permissions.md:58` (the `bypassPermissions` row):
 * "Skips permission prompts, except those forced by explicit `ask` rules,
 * connector tools your organization set to `ask`, and MCP tools marked
 * `requiresUserInteraction`. Root and home directory removals such as
 * `rm -rf /` also still prompt as a circuit breaker".
 *
 * `permissions.md:63` (the warning under that table): "Removals targeting the
 * filesystem root or home directory, such as `rm -rf /` and `rm -rf ~`, also
 * prompt as a circuit breaker against model error, including when the command
 * contains command substitution with `$(...)` or backticks, or process
 * substitution with `<(...)`."
 *
 * `code.claude.com/docs/en/permission-modes.md:399`: "… The circuit breaker
 * also fires when the command contains command substitution with `$(...)` or
 * backticks, or process substitution with `<(...)`, whether the removal sits
 * inside the substitution, as in `echo "$(rm -rf ~)"`, or elsewhere in the same
 * command."
 *
 * `permission-modes.md:401`, on plan mode under bypass: "Explicit ask rules and
 * the removal circuit breaker above still prompt."
 *
 * Pure string semantics, no I/O and no permission decision — the caller
 * (`core/pre-tool-use.ts`) turns a hit into the prompt. The resolved home path
 * is a parameter so the predicate stays testable; it defaults to `os.homedir()`.
 *
 * ## The decisions, and why
 *
 * **A false positive is how this feature gets disabled.** A breaker that fires
 * on `rm -rf ~/projects/scratch` gets routed around, and then it protects
 * nothing. Every rule below is therefore an EXACT match on the resolved target,
 * never a prefix: only the root or the home directory ITSELF fires.
 *
 * - **Targets.** `/` and `~` are the documented examples. Accepted spellings:
 *   `/`, `~`, `$HOME`, `${HOME}` and the resolved absolute home path, each with
 *   any number of trailing slashes, `.` segments and quotes, and with `..`
 *   segments resolved (`~/projects/..` IS the home directory).
 * - **`/*` and `~/*` fire.** `rm -rf /*` removes every child of root — the same
 *   destruction as `rm -rf /`, and it is the form that actually works, since
 *   GNU `rm` refuses a bare `/` without `--no-preserve-root`. A trailing `/*`
 *   or `/.*` is therefore treated as the directory itself. A NARROWER glob
 *   (`~/*.log`, `~/p*`) names specific children and does NOT fire.
 * - **Removal commands** (matched on the basename, so `/bin/rm` counts):
 *   `rm` and `rmdir` in sh; `Remove-Item` and every shipped `Set-Alias`
 *   spelling of it in PowerShell and cmd (`ri`, `rm`, `rmdir`, `del`, `erase`,
 *   `rd`), read through `canonicalPowerShellCommandName` so the breaker and the
 *   `PowerShell(...)` rule matcher cannot disagree about what `del` is; and
 *   `find <target> -delete`, which removes its starting point (D16).
 *   `shred`, `truncate`, `dd of=` and `unlink` are excluded: each REFUSES a
 *   directory, so no spelling of them removes the root or the home directory.
 *   See the category strings in
 *   `docs/superpowers/plans/2026-07-29-removal-circuit-breaker.md` § 3.
 * - **`find` fires only when nothing narrows the traversal.** `find ~ -delete`
 *   deletes the home directory; `find ~ -name '*.pyc' -delete` is ordinary
 *   cleanup that would cry wolf on every run. Any primary other than the
 *   removal action and the non-narrowing global options therefore cancels the
 *   match — the same fail-toward-not-prompting posture as everything below.
 * - **Wrapper stripping is `claude-bash-rule.ts`'s**, in its enforcement pass,
 *   so `sudo rm -rf ~`, `doas`, `env -S "rm -rf /"` and the exec wrappers all
 *   fire through the one stripper that already handles them.
 * - **Substitution breadth.** `splitWithSubstitutions` yields every top-level
 *   subcommand plus the contents of every `$(…)`, backtick, `<(…)` and subshell
 *   span, recursively — so a qualifying removal fires from anywhere in the
 *   command, which is the documented breadth. It also yields the body behind
 *   every COMPOUND-COMMAND KEYWORD (P2.142): a separator ends a command but
 *   `then`, `do`, `else`, `{`, a `case` label and a function definition's `()`
 *   do not, so `if true; then rm -rf ~; fi` used to arrive here as a subcommand
 *   whose head was `then` and returned NULL — this floor, `nonNegotiable` on
 *   every runtime, was cleared by ordinary shell control flow until 2026-08-24.
 *   That reach is governed by the SHELL'S OWN RULE for where a command starts
 *   (a reserved word is a reserved word only in command position), because the
 *   first version asked instead whether the SUBCOMMAND began with one — and
 *   that was wrong in both directions at once, measured 2026-08-25. It missed
 *   `wipe () { rm -rf ~; }`, a definition that starts with its NAME, in four of
 *   its five spellings; and it fired `home` on `for opt in rm -rf ~; do echo
 *   $opt; done`, a loop that echoes three words and removes nothing, on a floor
 *   the user cannot switch off. The reach is bounded, but the bound now limits
 *   WORK and not DEPTH: 32 nestings of `for ((i=0;i<1;i++)) do` — 906 runnable
 *   characters — used to push the removal past the old cap and return null.
 *   The DEPTH bound is likewise no longer a bound on reach: a chain of
 *   wrapper-only spans (`'( ' × 33 + 'rm -rf ~' + ' )' × 33`, 140 runnable
 *   characters) used to hide its payload one layer past the budget, and the one
 *   body a depth budget can drop is now recovered in linear time
 *   (`innermostWrappedCommand`, P2.156).
 *   What the substitution clause does
 *   NOT do is drop the "targeting the filesystem root or home directory"
 *   qualifier: `rm -rf "$(cat targets.txt)"` has an unresolvable target and does
 *   not fire, or every `rm` with a computed argument would prompt.
 *
 * ## The sole-floor slice, and what this module catches on it (P2.312, census
 * ## closed 2026-09-03)
 *
 * **13.78 % of real agent-issued Bash — 2 517 of 18 272 — parses at the top
 * level while carrying a nested span or `-c` script that does not.** On those
 * the DSL's verdict is `no-match` rather than `'unparseable'`, so `PROMPT_ANYWAY`
 * cannot fire whatever rules the user has, and this module is not a backstop:
 * it is the ONLY floor. The row asked for a census before any decision, and
 * three lanes drove one. Where it stands:
 *
 * | Head / wrapper on the slice | Reaches the floor |
 * | --- | --- |
 * | `rm`, `/bin/rm`, every recursion spelling incl. GNU prefixes | yes |
 * | `sudo`, `doas`, `env`, `env VAR=…`, `nohup`, `timeout N` | yes |
 * | `env -S "…"` | **yes since 2026-09-03** — it was the last gap, and it was a pre-filter, not a rule |
 * | `find … -delete`, `find … -exec rm …` | yes (P2.312, W3-c) |
 * | `Remove-Item` and its aliases | yes (P2.388, as a narrowing) |
 * | `rmdir` | **no, deliberately** — it removes only an EMPTY directory |
 * | a removal whose target is computed (`xargs`, `$(cat …)`) | no — the documented "targeting" qualifier, not a gap |
 *
 * What is NOT closed, and is not closable here: the **corpus-weighted** fire
 * rate over real traffic. That needs the 18 272-command corpus, which lives
 * under the user's real home and cannot be read by a lane — **P2.389,
 * owner-owed**. Every number above is the adversarial set, and saying so is the
 * point: a coverage claim about this floor is a claim about constructed cases
 * until that corpus is copied out safely.
 *
 * ## Known limits (deliberate, all fail toward NOT prompting)
 *
 * - A command over 10 000 characters is not analysed and does not fire.
 * - A command the shared scanner cannot BALANCE is no longer silent, and the
 *   reason it changed is worth keeping: the natural spelling of a `case`
 *   statement is unbalanced text, so `case $x in a) rm -rf ~ ;; esac` — and,
 *   worse, anything after ANY `case` in the same string — was not analysed at
 *   all (P2.144). Such text now gets the deliberately weaker reading of
 *   {@link findTextualRemoval}: an `rm` word carrying RECURSION with a
 *   root-or-home operand, all three required (force is not — a bare `rm -r`
 *   was measured to delete the whole tree in all five shells; P2.178). The posture the old sentence was
 *   protecting is intact — matching raw text everywhere WOULD fire on
 *   `echo "rm -rf ~"`, which is why the fallback runs only on text the
 *   structured scan could not read, and never on text it could. The DSL's
 *   unparseable posture governs deny/ask as before; it does not reach the floor,
 *   and under `sh -c '…'` it does not reach deny/ask either.
 * - Quoting is normalized away rather than modelled: `'~'` fires even though a
 *   shell would not expand it. A file literally named `~` is vanishingly rare,
 *   and one spurious prompt is cheaper than a missed home wipe.
 * - Only literal spellings resolve. `${HOME:?}`, `$(echo ~)` and `rm -rf *` in
 *   a home working directory are not detected; the breaker is a floor over the
 *   documented forms, not a shell.
 * - A removal nested inside ANOTHER interpreter's quoted argument —
 *   `powershell -Command "Remove-Item -Recurse -Force $HOME"`,
 *   `cmd /c rd /s /q %USERPROFILE%` — is not reached: neither scan descends into
 *   a quoted argument, and sh's own `$(…)`/`<(…)` breadth is a documented
 *   clause that says nothing about a second shell. The wrapper stripper is the
 *   place to fix that if it ever needs fixing.
 * - .NET and WinAPI forms (`[System.IO.Directory]::Delete($HOME, $true)`) are
 *   not commands and are not matched.
 * - **The WINDOWS scan classifies only TARGET tokens (P2.51), and skips the
 *   value of `-Include`/`-Exclude`/`-Filter`/`-Stream`** — for a PowerShell head
 *   only, since `del`/`erase`/`rd`/`rmdir` in `cmd` take filenames and bind no
 *   parameters (P2.74). `Remove-Item -Exclude ~ -Path ./logs` used to prompt
 *   "this command removes your home directory (`~`)" for a command whose `~` is
 *   what it SPARES. The sh scan has no such parameter rule and needs none: `rm`
 *   takes operands, not named parameters.
 * - **A comment tail is not scanned by EITHER scan, but they get there by
 *   different routes.** {@link tokenizePowerShell} stops at a token-initial `#`
 *   for the two Windows scans; {@link findShRemoval} inherits the same outcome
 *   from `claude-bash-rule.ts`'s splitter, which excises a sh comment tail
 *   before the subcommand is ever tokenized (P2.71). `rm ./one.txt # also
 *   clears ~` and `rm -rf ./logs  # careful with /` both used to prompt (MEASURED
 *   2026-08-23 on this matcher) and now return null. The sh rule is deliberately
 *   NARROWER than the shell's — the argument, and the three non-coverages, are
 *   written out on `scanCommand` in that file rather than repeated here.
 *
 * ## A second, neighbouring matcher lives at the bottom of this file
 *
 * `findRemoveItemLadderDeny` answers a DIFFERENT question — "is this a
 * `Remove-Item` the page denies outright, in every mode, without asking" — for
 * the ladder `permission-modes.md:599` gives that cmdlet. It is deliberately
 * not folded into the predicate above: its targets are frequently neither the
 * root nor the home directory, and everything the caller does with a
 * `RootOrHomeRemoval` is raise a PROMPT that names one of those two.
 */

import { homedir } from 'node:os'

import { splitWithSubstitutions, stripSubcommand } from './claude-bash-rule.ts'
import {
  canonicalPowerShellCommandName,
  looksLikePowerShell,
  splitPowerShellCommand,
} from './claude-powershell-rule.ts'
import { POWERSHELL_REMOVAL_CMDLET, powerShellHostScripts } from './claude-powershell-rule.ts'
import type { PowerShellRemovalHead } from './claude-powershell-rule.ts'

/** Which documented floor the removal target resolved to. */
export type RemovalTarget = 'root' | 'home'

export interface RootOrHomeRemoval {
  /** `root` for `/`, `home` for the home directory. */
  target: RemovalTarget
  /** The removal subcommand, wrapper-stripped, as the user would read it. */
  subcommand: string
  /** The verbatim argument token that resolved to the target. */
  argument: string
}

/** Commands whose whole purpose is to remove the path they are given. */
const REMOVAL_COMMANDS = new Set(['rm', 'rmdir'])

/** `find`'s removal actions. `-delete` implies `-depth`, so it takes the root too. */
const FIND_DELETE_ACTION = '-delete'
const FIND_EXEC_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir'])

/**
 * `find` options that do NOT narrow the traversal to a subset of the tree.
 * Everything else — `-name`, `-type`, `-mtime`, `-maxdepth`, `-prune` … —
 * selects some of the tree, which is the ordinary-cleanup shape, so its
 * presence cancels the match.
 */
const FIND_NON_NARROWING_OPTIONS = new Set([
  '-H', '-L', '-P', '-d', '-depth', '-mount', '-s', '-x', '-xdev', '-print', '-print0',
])

/** Longest first is not needed — no spelling is a prefix of another. */
const HOME_SPELLINGS = ['${HOME}', '$HOME', '~'] as const

/**
 * The home spellings a Windows shell resolves. Longest first WHERE it matters:
 * `${env:USERPROFILE}` must be tried before `$env:USERPROFILE`, and `${HOME}`
 * before `$HOME`, or the shorter one would claim the prefix.
 */
const WINDOWS_HOME_SPELLINGS = [
  '${env:USERPROFILE}', '$env:USERPROFILE', '%USERPROFILE%', '${HOME}', '$HOME', '~',
] as const

/**
 * Drops quoting and escaping the way the shell would, so `"$HOME"`, `'~'` and
 * `~/"Documents"` all reduce to the path the command actually names.
 */
function unquotePath(token: string): string {
  let result = ''
  let escaped = false
  let singleQuote = false
  let doubleQuote = false
  for (const current of token) {
    if (escaped) { result += current; escaped = false; continue }
    if (current === '\\' && !singleQuote) { escaped = true; continue }
    if (singleQuote) {
      if (current === "'") singleQuote = false
      else result += current
      continue
    }
    if (current === "'" && !doubleQuote) { singleQuote = true; continue }
    if (current === '"') { doubleQuote = !doubleQuote; continue }
    result += current
  }
  return result
}

/**
 * Drops quoting and escaping the way PowerShell would, not the way sh would.
 * The escape character is the BACKTICK, `'` is literal with a doubled `''`
 * escaping one quote inside it, and a backslash carries no meaning at all —
 * which is the whole point, because a Windows path IS backslashes and the sh
 * unquoter would eat every one of them.
 */
function unquotePowerShellPath(token: string): string {
  let result = ''
  let escaped = false
  let singleQuote = false
  let doubleQuote = false
  for (let index = 0; index < token.length; index += 1) {
    const current = token[index]!
    if (escaped) { result += current; escaped = false; continue }
    if (singleQuote) {
      if (current !== "'") { result += current; continue }
      if (token[index + 1] === "'") { result += "'"; index += 1; continue }
      singleQuote = false
      continue
    }
    if (current === '`') { escaped = true; continue }
    if (current === "'" && !doubleQuote) { singleQuote = true; continue }
    if (current === '"') { doubleQuote = !doubleQuote; continue }
    result += current
  }
  return result
}

/**
 * Splits one PowerShell subcommand into words, respecting its quoting, and
 * STOPS at a comment tail.
 *
 * The comment rule is PowerShell's own: `#` opens a comment only where a token
 * begins, so `./a#b/*` and `$dir#1` are ordinary tokens and a `#` inside quotes
 * is quoted text. Both cases fall out of the `started` flag and the quote
 * branches already here rather than needing a rule of their own.
 *
 * Why it is here at all (P2.51): without it `Remove-Item ./one.txt  # also
 * clears src/*` handed `src/*` to the matcher as though it were an argument,
 * and a note the user wrote to themselves became an every-mode deny with no
 * override. Both WINDOWS scans in this file tokenize through here and both
 * inherit it. The third, {@link findShRemoval}, reaches the same outcome from
 * the other end: `claude-bash-rule.ts`'s splitter excises a sh comment tail
 * before this file ever sees the subcommand (P2.71). The two rules are NOT
 * interchangeable — PowerShell's `#` and POSIX's differ on where a token begins
 * and on what ends the comment — so each is stated where it is implemented.
 *
 * What it no longer has to cover: {@link splitPowerShellCommand} runs FIRST and
 * used to know nothing about comments, so a `;` or `|` inside one still split
 * the command and handed the text after it on as a subcommand — which is why a
 * tokenizer that stops at `#` did not close the defect by itself. P2.75 taught
 * that splitter the same rule. It does NOT excise the tail, only refuse to
 * separate inside it, so this function still does the removing; the two halves
 * are stated at both ends rather than one relying on the other silently.
 *
 * What still is not covered: a `<#` block comment disables the splitter's line
 * rule outright (no `pwsh` on the measuring rig), so a `;` inside a block
 * comment separates as before. That residue fails toward FIRING — a deny we
 * cannot justify is still louder than a removal we missed — which is the
 * posture this ladder wants.
 */
function tokenizePowerShell(text: string): string[] {
  const tokens: string[] = []
  let current = ''
  let started = false
  let escaped = false
  let singleQuote = false
  let doubleQuote = false
  for (const character of text) {
    if (escaped) { current += character; escaped = false; continue }
    if (!singleQuote && character === '`') { current += character; escaped = true; started = true; continue }
    if (singleQuote) {
      current += character
      if (character === "'") singleQuote = false
      continue
    }
    if (doubleQuote) {
      current += character
      if (character === '"') doubleQuote = false
      continue
    }
    if (character === "'") { singleQuote = true; current += character; started = true; continue }
    if (character === '"') { doubleQuote = true; current += character; started = true; continue }
    // The comment tail: everything from here on is prose, not command text.
    if (character === '#' && !started) break
    if (/\s/.test(character)) {
      if (started) { tokens.push(current); current = ''; started = false }
      continue
    }
    current += character
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

/**
 * A Windows path in one comparable spelling: separators forward, drive letter
 * upper-cased, `.` and `..` resolved. Returns null for a relative path, which
 * cannot be proven to be root or home without a working directory.
 *
 * A driveless absolute path (`/`, `\`) is the root of the CURRENT drive and
 * comes back as `/`, which is also what a POSIX home resolves to — so this
 * function is correct for the off-Windows PowerShell case too, where `home` is
 * an ordinary POSIX path.
 *
 * ## The single-letter drive is a SCOPE, not a safety (P2.85)
 *
 * A drive here is one letter, so a multi-letter PSDrive root (`HKLM:`, `Cert:`,
 * `WSMan:`) returns null and classifies as nothing — as it does in
 * {@link isWindowsRoot} and twice in {@link classifyWindowsSystemPath}, which
 * have to widen with this one or widening this one changes nothing (MEASURED
 * 2026-08-27: widening only this regex left `Remove-Item HKLM:\` null on both
 * scans).
 *
 * That was ALSO, by coincidence, the only thing keeping a non-FileSystem
 * provider out of reach of the `-Stream` skip in {@link windowsTargetTokens} —
 * a dependency nothing recorded, so widening this regex used to re-open an
 * under-fire. It no longer does: that skip now guards itself, and this regex is
 * free. Widening it costs only over-fire — `Remove-Item HKLM:\` would start
 * reading as a drive root — which is a scope decision, not a security one.
 */
function normalizeWindowsPath(value: string): string | null {
  const forward = value.replaceAll('\\', '/')
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(forward)
  if (drive) return `${drive[1]!.toUpperCase()}:${normalizeAbsolutePath(drive[2] ?? '/')}`
  if (!forward.startsWith('/')) return null
  return normalizeAbsolutePath(forward)
}

/** `C:\`, `\`, `/` — the root of a drive or of the current one. */
function isWindowsRoot(normalized: string): boolean {
  return normalized === '/' || /^[A-Z]:\/$/.test(normalized)
}

/**
 * Replaces a leading home spelling with the resolved home path, or returns the
 * value untouched. Forward-slashed input only — every caller normalizes the
 * separators first, because a Windows path IS backslashes.
 */
function substituteWindowsHome(value: string, home: string): string {
  const lowered = value.toLowerCase()
  for (const spelling of WINDOWS_HOME_SPELLINGS) {
    const marker = spelling.toLowerCase()
    if (lowered === marker) return home
    if (lowered.startsWith(`${marker}/`)) return home + value.slice(spelling.length)
  }
  return value
}

/** The Windows twin of {@link classifyTarget}: same rules, Windows spellings. */
function classifyWindowsTarget(rawToken: string, home: string): RemovalTarget | null {
  let value = unquotePowerShellPath(rawToken).replaceAll('\\', '/')
  if (!value) return null

  if (value.endsWith('/*')) value = value.slice(0, -1)
  else if (value.endsWith('/.*')) value = value.slice(0, -2)

  value = substituteWindowsHome(value, home)

  const normalized = normalizeWindowsPath(value)
  if (!normalized) return null
  if (isWindowsRoot(normalized)) return 'root'
  const normalizedHome = normalizeWindowsPath(home)
  // Windows paths are case-insensitive; a POSIX home reaching here (the
  // off-Windows PowerShell case) is compared the same way, which can only ever
  // over-prompt on a home whose siblings differ by case alone.
  if (normalizedHome && normalized.toLowerCase() === normalizedHome.toLowerCase()) return 'home'
  return null
}

/**
 * Resolves `.`, `..`, duplicate and trailing slashes. Absolute input only —
 * every caller has already substituted the home spellings, and a relative path
 * cannot be proven to be root or home without a working directory.
 */
function normalizeAbsolutePath(value: string): string {
  const segments: string[] = []
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') { segments.pop(); continue }
    segments.push(segment)
  }
  return `/${segments.join('/')}`
}

/** `/`, `~`, `$HOME`, the absolute home path — or null for anything else. */
function classifyTarget(rawToken: string, home: string): RemovalTarget | null {
  let value = unquotePath(rawToken)
  if (!value) return null

  // "every child of X" globs remove exactly what the bare directory does.
  // Narrower globs (`~/*.log`) name specific children and fall through.
  if (value.endsWith('/*')) value = value.slice(0, -1)
  else if (value.endsWith('/.*')) value = value.slice(0, -2)

  for (const spelling of HOME_SPELLINGS) {
    if (value === spelling) { value = home; break }
    if (value.startsWith(`${spelling}/`)) { value = home + value.slice(spelling.length); break }
  }

  if (!value.startsWith('/')) return null
  const normalized = normalizeAbsolutePath(value)
  if (normalized === '/') return 'root'
  if (home.startsWith('/') && normalized === normalizeAbsolutePath(home)) return 'home'
  return null
}

/**
 * `find <target> … -delete`, or null when this subcommand is not one.
 *
 * The operands are everything before the expression; the expression must
 * contain a removal action and nothing that narrows the traversal. Leading
 * global options (`find -L ~ -delete`) are consumed before the operands, which
 * is the order `find` itself parses them in.
 */
function findDeleteOperands(tokens: readonly string[]): readonly string[] | null {
  let index = 0
  while (index < tokens.length && FIND_NON_NARROWING_OPTIONS.has(tokens[index]!)) index += 1
  const operands: string[] = []
  while (index < tokens.length && !tokens[index]!.startsWith('-')) {
    operands.push(tokens[index]!)
    index += 1
  }
  if (operands.length === 0) return null

  let removes = false
  while (index < tokens.length) {
    const token = tokens[index]!
    if (token === FIND_DELETE_ACTION) { removes = true; index += 1; continue }
    if (FIND_EXEC_ACTIONS.has(token)) {
      const command = tokens[index + 1]
      const name = command ? unquotePath(command).split('/').pop() : undefined
      if (name && REMOVAL_COMMANDS.has(name)) removes = true
      // The whole `-exec … ;` / `-exec … +` span belongs to the action.
      index += 1
      while (index < tokens.length && tokens[index] !== ';' && tokens[index] !== '\\;' && tokens[index] !== '+') {
        index += 1
      }
      index += 1
      continue
    }
    if (FIND_NON_NARROWING_OPTIONS.has(token)) { index += 1; continue }
    // Anything else selects a SUBSET of the tree: ordinary cleanup, not a
    // removal of the directory itself.
    return null
  }
  return removes ? operands : null
}

/**
 * The sh scan: every top-level subcommand of a compound command, plus the
 * contents of every command substitution, backtick span, process substitution
 * and subshell, at any nesting depth.
 */
/**
 * An `rm` word in COMMAND POSITION, textually: at the start of the text or after
 * a command separator, with only blanks between. A path spelling (`/bin/rm`)
 * counts, as it does everywhere else in this module.
 *
 * The bare word-boundary version of this — `rm` after ANY blank — was written
 * first and was wrong in a direction that matters: it fired on
 * `case $x in a) git rm -rf ~ ;; esac` and on `sudo rm -rf ~`, because in both
 * the letters `rm` follow a space. `git rm` is a DIFFERENT command that the
 * structured scan explicitly declines to treat as `rm`, and a floor the user
 * cannot switch off must not invent removals — this module's founding rule is
 * that a false positive is how the feature gets routed around. Requiring command
 * position costs the fallback `sudo`, which the structured scan already covers
 * and which is recorded as a known gap between the two matchers.
 */
const TEXTUAL_RM_WORD =
  /(?:^|[;&|(){}`\n\r])[ \t]*((?:[^\s;&|(){}`"']*\/)?rm)(?=[ \t]|$)/g

/**
 * A `find` word in COMMAND POSITION — {@link TEXTUAL_RM_WORD}'s character class,
 * verbatim, with the head word swapped (P2.312).
 *
 * The same class on purpose, and for the same reason it was chosen there: a
 * `find` that merely follows a blank (`git find`, `xargs find`, a `find` inside
 * a quoted message) is a different word, and a floor the user cannot switch off
 * must not invent removals. Sharing the class also means the wrapper rewrite in
 * {@link stripTextualEnforcementWrappers} cannot move a `find` into or out of a
 * command position for one head and not the other.
 */
const TEXTUAL_FIND_WORD =
  /(?:^|[;&|(){}`\n\r])[ \t]*((?:[^\s;&|(){}`"']*\/)?find)(?=[ \t]|$)/g

/** Where a textual scan stops reading operands: any command terminator. */
const TEXTUAL_OPERAND_END = /[;&|()}`\n\r]/

/**
 * Whether these words carry a RECURSIVE removal, in any spelling the shell
 * accepts: `-r`, `-R`, `-rf`, `-fr`, `-Rf`, `-r -f`, `--recursive`.
 *
 * ## Force is NOT required, and that is a measurement rather than a preference
 *
 * This predicate demanded recursion AND force until 2026-08-25, so `rm -r ~`
 * inside a `case` did not fire while `rm -rf ~` did — surfaced by the
 * differential test in `removal-circuit-breaker.test.ts`, which is the only
 * reason anyone noticed. The widening was held for the owner precisely because
 * this matcher runs on the unparseable path where the module's false-positive
 * posture is the whole justification for firing at all, and the case for it is
 * that a bare `-r` is not a gentler removal — it is the SAME removal:
 *
 * | payload | tree | stdin | result |
 * | --- | --- | --- | --- |
 * | `rm -r <tree>` | writable | pipe | GONE, exit 0 |
 * | `rm -r <tree>` | writable | tty | GONE, exit 0 |
 * | `rm -r <tree>` | unwritable | pipe | GONE, exit 0 |
 * | `rm -r <tree>` | unwritable | tty | prompts; survives on EOF, exit 1 |
 * | `rm -rf <tree>` | any | any | GONE, exit 0 |
 *
 * MEASURED 2026-08-25 against a sandbox stand-in tree, `-r` and `-R` alike, in
 * ALL FIVE of `bash`, `/bin/sh`, `dash`, `zsh` and `ksh` — no shell disagreed on
 * any row. The per-file prompt that made a bare `-r` look survivable exists in
 * exactly ONE of those four states: it needs a controlling terminal AND a file
 * the user cannot write. A home directory is the user's own files, and the Bash
 * tool spawns its shell on a pipe, so the row that matters is the first one.
 *
 * `--dir` keeps its OLD requirement and is deliberately not folded into
 * `recursive`. `rm --dir <non-empty tree>` was measured NON-destructive (exit 1,
 * `Directory not empty`; BSD `rm` rejects the long spelling outright), so
 * treating it as recursion on its own would have widened onto a shape that
 * removes nothing. Pairing it with force preserves exactly what fired before.
 *
 * The result is a strict SUPERSET of the old predicate — every `(recursion or
 * --dir) and force` input still fires — so no row can go quiet, which the
 * differential test's bucket declarations enforce.
 *
 * **`--recursive` is a documented GNU spelling this host cannot execute.** BSD
 * `rm` takes no long options at all (`rm: illegal option -- -`, exit 64, usage
 * `[-f | -i] [-dIPRrvWx]`), so `rm --recursive ~` cannot run on macOS; it is
 * `-r, -R, --recursive` in GNU coreutils, which is what ships on the Linux build.
 * It was already accepted here before this change and stays accepted: the floor
 * is cross-platform even when its test host is not.
 */
function carriesRecursiveRemoval(words: readonly string[]): boolean {
  let recursive = false
  let emptyDirOnly = false
  let force = false
  for (const word of words) {
    if (!word.startsWith('-') || word === '-' || word === '--') continue
    // P3.307 — GNU `getopt_long` accepts any UNAMBIGUOUS PREFIX of a long
    // option, so `--recursive` has a whole family of spellings and this matcher
    // used to see exactly one of them. Measured by W2-q on coreutils 9.1 in a
    // container: `rm --recursive --force $HOME` fires both matchers, while
    // `rm --rec --force $HOME`, `rm --r -f $HOME` and `rm --rec --fo $HOME`
    // fire NEITHER and all three leave the home gone. A control that a
    // three-character abbreviation walks past is not a control.
    //
    // Prefix-matched rather than enumerated, because the family is open: any
    // non-empty prefix counts. No disambiguation is owed against `rm`'s other
    // long options — `--r`, `--f` and `--d` are each unambiguous to GNU, and a
    // genuinely ambiguous prefix makes `rm` exit without removing anything, so
    // over-matching here costs a prompt on a command that was going to fail.
    if (word.startsWith('--')) {
      const name = word.slice(2)
      if (name.length > 0 && 'recursive'.startsWith(name)) { recursive = true; continue }
      if (name.length > 0 && 'force'.startsWith(name)) { force = true; continue }
      if (name.length > 0 && 'dir'.startsWith(name)) { emptyDirOnly = true; continue }
      continue
    }
    for (const character of word.slice(1)) {
      if (character === 'r' || character === 'R') recursive = true
      if (character === 'f') force = true
    }
  }
  return recursive || (emptyDirOnly && force)
}

/**
 * THE SECOND, WEAKER MATCHER — the textual fallback for command text the shared
 * scanner cannot parse. Owner decision 2026-08-25, option (c) of three.
 *
 * ## Why a second matcher exists at all
 *
 * `splitWithSubstitutions` returns null on text it cannot balance, and this
 * floor then analysed nothing. The natural spelling of a `case` statement is
 * exactly such text: `case $x in a) rm -rf ~ ;; esac` leaves the shared
 * scanner's paren depth unbalanced at the bare `a)` label, in EVERY spelling
 * including multi-line, and — the half that made this a decision rather than a
 * footnote — it poisons the whole string: `case $x in a) echo hi ;; esac;
 * rm -rf ~` returned null too, so a `case` anywhere acted as a general-purpose
 * disabling prefix. All measured runnable in `bash`, `/bin/sh` and `dash`.
 *
 * The two obvious answers were both bad. Leaving it is a silent hole under
 * `bypassPermissions`; firing on ALL unparseable input contradicts this
 * module's false-positive posture AND has no target to name in the prompt,
 * which {@link describeRootOrHomeRemoval} requires. The deny/ask net that made
 * the hole look survivable is ALSO absent where it matters most: under
 * `sh -c '…'` the outer command parses fine, so the verdict is `no-match`, not
 * `'unparseable'` — no `PROMPT_ANYWAY` — and codex wraps every command as
 * `<shell> -lc`, so the unprotected form is that runtime's NORMAL one.
 *
 * **That net is thinner still, and the second hole is the larger one** (MEASURED
 * 2026-08-28, P2.91). `PROMPT_ANYWAY` lives inside `matchesRule`'s
 * `bashPattern`/`powershell` branches, so it is reached only if the compiled
 * program CONTAINS a Claude-shaped `Bash(prefix)` rule. Evaluated against one
 * unparseable command carrying a removal, on four programs a real user can have:
 * no rules at all → no action; only non-Bash rules → no action; a TOOL-level
 * `allow` for bash (`{kind:'tool',semanticId:'bash'}`) → **`allow`**; one
 * `Bash(tail:*)` deny → `ask`. Three of the four never reach the carve-out, and
 * the third returns an outright approval. Nessy ships no default `Bash(...)`
 * rule, so a fresh profile is the FIRST row. The reassurance that this floor is
 * "not urgent because `PROMPT_ANYWAY` covers the ground today" is therefore
 * false for any profile without a Bash prefix rule — recorded here rather than
 * fixed here, because the fix is `permission-dsl.ts`'s and not this module's.
 *
 * ## What it does, and what it deliberately cannot do
 *
 * It reads words, not syntax: an `rm` word, a RECURSIVE flag
 * ({@link carriesRecursiveRemoval} — force is not required, and P2.178's
 * measurement of why is there), and an operand that {@link classifyTarget} —
 * the SAME target classifier the structured scan uses — resolves to the root or
 * the home directory. All three are required, so an unparseable command with no
 * removal shape still passes and the posture is unchanged.
 *
 * It is weaker than the structured scan on purpose, and the gap is the point:
 * it sees no `rmdir`, no `find … -delete`, no substitution spans, and it cannot
 * tell command text from a quoted string. The last of those is why it runs ONLY
 * where the structured scan was blind — over the whole command when that could
 * not be parsed, and over each nested span or `-c` script that could not. On
 * text the structured scan CAN read, it never runs, so `echo "rm -rf ~"` is
 * still not a prompt.
 *
 * ## What `unparseable` MEANS to the breaker — the posture, and its measurement
 *
 * P2.91 asked the question one layer up: should text the scanner cannot read
 * make this floor FIRE? The row expected yes, on the grounds that firing is the
 * posture held everywhere else on the plan. MEASURED, it is the wrong answer,
 * and the number is the argument: over **18 272 distinct Bash commands actually
 * issued by agents in this repo** (harvested from the local session
 * transcripts), **800 (4.38 %) are whole-command unparseable**, of which 16
 * already fire. Firing on the rest would add **784 unskippable prompts, 1 in
 * every 23 commands** — and **504 of those 784 (64 %) are heredocs**
 * (`python3 - <<'PY' … PY`), the ordinary way a model writes a file. The
 * remainder is 128 `case` statements, 120 commands whose only sin is an
 * APOSTROPHE INSIDE A COMMENT, 17 over the 10 000-character cap and 12 ANSI-C
 * literals. None of them removes anything. A floor the user cannot switch off
 * that fires on two thirds of all heredocs is not a floor — it is the noise this
 * module's founding rule says users route around.
 *
 * So `unparseable` means **read it with the weaker matcher**, which is what
 * P2.144 already made it mean. What P2.91 leaves is the narrower defect: the
 * weaker matcher was **selectively** blind. It read `rm -rf ~` and not
 * `sudo rm -rf ~`, so the floor was present for one spelling of a removal and
 * absent for the same removal run with MORE privilege — the row's own sentence
 * ("a floor that goes quiet on text it cannot parse is not a floor") one level
 * down. {@link stripTextualEnforcementWrappers} closes it, and the reason it
 * closes THAT gap and not the `rmdir` one is written there.
 *
 * ## THIS IS NOT A BACKSTOP. It is the only floor for one command in seven
 *
 * P2.312, and it is the number that should govern how much is spent here.
 * **2 517 of the same 18 272 commands — 13.78 %** PARSE at the top level while
 * carrying a nested span or `-c` script that does not. That is a different
 * population from P2.91's 800: the whole command is readable, so the DSL's
 * `commandIsUnparseable` is FALSE and `PROMPT_ANYWAY` cannot fire *whatever
 * rules the user has* — while `findShRemoval`'s `unparsed` sink is non-empty, so
 * the structured scan saw nothing of the text that matters. On that slice this
 * function is not a second line of defence behind the structured scan; it is the
 * whole of the floor. And `<shell> -lc '…'` is codex's normal wrapper, so the
 * slice is not exotic.
 *
 * Every row before P2.312 reasoned about this matcher as a backstop, which is
 * how `find … -delete` came to be declined twice as "covered elsewhere". The
 * `find` pass ({@link textualFindRemoval}) is that decision revisited with the
 * number in hand.
 *
 * ## MEASURED ON THE SLICE, and what is still open
 *
 * Instrument: each command classified by `splitWithSubstitutions`' `unparsed`
 * sink plus `matchClaudeBashRule('*', …)`, then handed to
 * {@link findRootOrHomeRemoval}. Nothing was executed; a stand-in home was used
 * for the resolved path while the matcher was fed `~`, `$HOME` and `/` verbatim.
 *
 * CAUGHT on the slice, and pinned: `rm -rf ~` and `rm -rf /` behind
 * `sh -c`/`bash -lc`, a backtick span and a process substitution; the `sudo`,
 * `env`, `nohup` and `timeout` spellings of each; and, since P2.312,
 * `find … -delete`.
 *
 * STILL OPEN on the slice, both stated rather than quietly left:
 *  - **`rmdir`** — unchanged and on its own merit: it removes nothing on a
 *    non-empty home and takes no recursion flag.
 *  - **A PowerShell removal inside an unparsed SH span (P2.388).** `findShRemoval`'s
 *    `unparsed` loop offers each span to this function only, and this function
 *    reads sh words; the Windows scan and the PowerShell-host resolver both run
 *    on the WHOLE command, one level up.
 *
 *    Re-measured at `7a8477690` (W3-c, 2026-09-03) with controls on the same
 *    rig, strings only: `Remove-Item -Recurse -Force <home>` fires at top level
 *    on darwin AND win32, `pwsh -Command "…"` fires on both, and both
 *    `sh -c "…"` and `bash -lc "…"` return **null on both** — while the
 *    controls `rm -rf <home>` inside `sh -c` and `find <home> -delete` fire. So
 *    the gap is exactly the PowerShell pass, not the unparsed-span machinery.
 *
 *    **THE RECORDED REASON FOR DECLINING IT DOES NOT HOLD, and this is the same
 *    refutation z-w5 made for `find`.** It read: *"closing it means running the
 *    Windows scan over word soup and `looksLikePowerShell` already fires on
 *    1 534 of 18 272 real SH commands (8.39 %) … a false-positive budget this
 *    module cannot pay"*. That conflates being SCANNED with FIRING. 8.39 % is
 *    the rate at which the language gate would ADMIT a span to the scan; it says
 *    nothing about the rate at which the scan then reports a removal. Measured
 *    the way `findDeleteOperands` was: **10 ordinary sh strings that name the
 *    home and would all be scanned — a `cat <<EOF` heredoc body carrying
 *    `Get-Content`, a `ls … | while read` pipeline, `grep -r Remove-Item`, and
 *    two that contain a COMPLETE valid removal spelling as quoted text
 *    (`echo "Remove-Item -Recurse -Force <home>" >> notes.md`, the same inside
 *    `git commit -m`) — stayed quiet 10 of 10, against 3 of 3 genuine spellings
 *    firing.** The scan fails CLOSED on word soup, exactly as
 *    `findDeleteOperands` does.
 *
 *    What is STILL missing is the corpus-weighted FIRE rate, which needs the
 *    18 272-command corpus under the real home — **P2.389, owner-owed**. So the
 *    row stays open on its real blocker rather than on a refuted one, and the
 *    fix, when it lands, is the unparsed loop offering each span to the
 *    PowerShell pass under the same per-span language gate the whole command
 *    gets. Recorded with the measurement so the next reader inherits the state,
 *    not the idea.
 *
 * ## Keeping the two honest
 *
 * Two matchers over one input class is the share-vs-split rule's expensive side,
 * and the cost is paid by a DIFFERENTIAL test rather than by discipline:
 * `removal-circuit-breaker.test.ts` runs both over one corpus, classifies every
 * disagreement into a named bucket, and FAILS on any disagreement that has no
 * bucket — with a positive control in each direction, so the harness cannot pass
 * by finding nothing. That test is the only reason this function is EXPORTED:
 * production code reaches it through {@link findRootOrHomeRemoval} alone, and a
 * differential cannot be run on a matcher it cannot call.
 */
export function findTextualRemoval(text: string, home: string): RootOrHomeRemoval | null {
  if (!text || text.length > MAX_TEXTUAL_SCAN_LENGTH) return null
  const scanned = stripTextualEnforcementWrappers(text)
  // `rm` FIRST, so every spelling this function already reported keeps reporting
  // the same `subcommand` and `argument` bytes. The `find` pass can only ever
  // add a row the `rm` pass left null (P2.312).
  return textualRmRemoval(scanned, home) ?? textualFindRemoval(scanned, home)
}

/** The `rm`-word half of {@link findTextualRemoval}, unchanged since P2.144. */
function textualRmRemoval(scanned: string, home: string): RootOrHomeRemoval | null {
  TEXTUAL_RM_WORD.lastIndex = 0
  for (;;) {
    const match = TEXTUAL_RM_WORD.exec(scanned)
    if (!match) return null
    const head = match[1]!
    const operandStart = match.index + match[0].length
    const terminator = TEXTUAL_OPERAND_END.exec(scanned.slice(operandStart))
    const tail = terminator
      ? scanned.slice(operandStart, operandStart + terminator.index)
      : scanned.slice(operandStart)
    const words = tail.split(/\s+/).filter(word => word.length > 0)
    if (!carriesRecursiveRemoval(words)) continue
    for (const word of words) {
      if (word.startsWith('-')) continue
      const target = classifyTarget(word, home)
      if (target) {
        return { target, subcommand: `${head} ${words.join(' ')}`.trim(), argument: word }
      }
    }
  }
}

/**
 * The `find … -delete` half — P2.312, and it exists because the reason recorded
 * against it turned out to be half wrong when it was finally measured.
 *
 * ## Why this became urgent, having been declined twice
 *
 * P2.312 quantified the slice this whole function serves: **2 517 of 18 272 real
 * agent-issued commands — 13.78 %, one in seven — PARSE at the top level while
 * carrying a nested span or `-c` script that does not.** On those the DSL's
 * verdict is `no-match`, never `'unparseable'`, so `PROMPT_ANYWAY` cannot fire
 * whatever rules the user has, and this weaker matcher is not a backstop behind
 * the structured scan — it is the ONLY floor. Every earlier row treated it as a
 * second line of defence, and `find … -delete` was declined on that basis: it
 * was a `structured-only` row in the differential, which reads as "covered
 * elsewhere". On this slice there is no elsewhere.
 *
 * Measured on the slice, before this: `sh -c 'case $x in a) find ~ -delete ;; esac'`
 * returned **null** from `findRootOrHomeRemoval` on both platforms, while the
 * same removal spelled `rm -rf ~` fired. A destructive, runnable command with no
 * floor at all.
 *
 * ## Why the stated objection does not survive contact
 *
 * The reason on {@link stripTextualEnforcementWrappers} was that applying
 * `FIND_NON_NARROWING_OPTIONS` "to word soup would either invent removals or
 * miss them silently". The second half is true and is this module's accepted
 * posture everywhere. The FIRST half is not: {@link findDeleteOperands} returns
 * `null` on the first token it does not recognise, so soup — an unbalanced quote
 * span, a stray flag, a `-name`/`-type`/`-mtime` predicate — FAILS CLOSED.
 * Measured over a fire-set of 7 and a quiet-set of 10 including
 * `~ -name '*.tmp' -delete`, `~ -type f -delete`, `~ -maxdepth 1 -delete` and an
 * unbalanced `~ -name "*.log -delete`: **zero disagreements**, the classic
 * narrowed-cleanup false positive among the quiet.
 *
 * That is also why this asks the real predicate instead of writing a second one,
 * the same rule {@link stripSegmentWrappers} follows: the narrowing logic has
 * grown before, and a mirror nothing checks is this repo's most-repeated failure
 * mode. The two matchers now agree on `find`, which the differential test
 * enforces by declaration rather than by trust.
 *
 * ## What it still does NOT do, deliberately
 *
 * It cannot tell command text from a quoted string, exactly as the `rm` pass
 * cannot — that is the price of running only where the structured scan was
 * blind. And it misses a `find` whose operand is built by expansion, because
 * {@link classifyTarget} matches the resolved target EXACTLY and a name it
 * cannot resolve has nothing to name in the prompt.
 */
function textualFindRemoval(scanned: string, home: string): RootOrHomeRemoval | null {
  TEXTUAL_FIND_WORD.lastIndex = 0
  for (;;) {
    const match = TEXTUAL_FIND_WORD.exec(scanned)
    if (!match) return null
    const head = match[1]!
    const operandStart = match.index + match[0].length
    const terminator = TEXTUAL_OPERAND_END.exec(scanned.slice(operandStart))
    const tail = terminator
      ? scanned.slice(operandStart, operandStart + terminator.index)
      : scanned.slice(operandStart)
    const words = tail.split(/\s+/).filter(word => word.length > 0)
    // The SAME predicate the structured scan runs, on the same shape of input:
    // a token list. It is what decides that `-name`/`-type` narrows the traversal
    // to a subset and that only `-delete` or a removal `-exec` removes at all.
    const operands = findDeleteOperands(words)
    if (!operands) continue
    for (const operand of operands) {
      const target = classifyTarget(operand, home)
      if (target) {
        return { target, subcommand: `${head} ${words.join(' ')}`.trim(), argument: operand }
      }
    }
  }
}

/**
 * The textual fallback's own length ceiling, one order below the shared
 * scanner's 10 000: it runs a global regex over raw text and only ever runs on
 * text nothing else could read, so it is bounded well inside the budget the
 * parse it replaces would have spent.
 */
const MAX_TEXTUAL_SCAN_LENGTH = 10_000

/**
 * The command-position openers {@link TEXTUAL_RM_WORD} anchors on, as a
 * SPLITTER. Same character class on purpose: a segment produced here is exactly
 * a span that regex would consider to begin at a command position, so the
 * rewrite below can never move an `rm` into or out of one.
 */
const TEXTUAL_SEGMENT_BOUNDARY = /[;&|(){}`\n\r]/

/**
 * An `rm` or `find` WORD anywhere in a segment — the cheap bail for the rewrite.
 *
 * `find` was added with {@link textualFindRemoval} (P2.312) rather than after
 * it, because leaving it out would have re-created, for `find`, the EXACT defect
 * P2.91 closed for `rm`: the floor present for `find ~ -delete` and absent for
 * `sudo find ~ -delete`, i.e. absent for the same removal run with more
 * privilege. Knowingly shipping a defect shape this file already paid for once
 * is worse than not having the rule.
 *
 * It moves no existing verdict. A segment that now passes this test only because
 * of its `find` reaches {@link stripSegmentWrappers}, and whatever that returns
 * is then read by the `rm` pass exactly as before — a strip cannot create an `rm`
 * in command position that the unstripped text did not already carry behind a
 * wrapper.
 *
 * **A QUOTE counts as the blank before the head (P2.312, W4-g).** It did not,
 * and that one character was the whole of the last asymmetry between the two
 * matchers on the sole-floor slice: `env -S "rm -rf ~"` fires from the
 * structured scan — `env -S` is named as a stripped wrapper in this file's
 * header and in {@link findShRemoval} — and returned NULL from the fallback,
 * because the head sits behind a `"` and this cheap bail rejected the segment
 * before {@link stripSegmentWrappers} could hand it to the very stripper that
 * knows `-S`. Driven, not read: `case $x in a) env -S "rm -rf ~" ;; esac` was
 * null on both platforms while `env rm -rf ~` in the same span fired.
 *
 * It cannot widen anything else, and that is a property of the two gates BELOW
 * it rather than of this regex: a segment only gets rewritten when the stripper
 * resolves its head to `rm` or `find`, so `echo "rm -rf ~"` still returns
 * untouched (head `echo`) and the `rm` pass still requires COMMAND POSITION,
 * which a quoted word does not have. Pinned in the differential as a
 * `both-quiet` row beside the `both-fire` one.
 */
const TEXTUAL_CONTAINS_REMOVAL_HEAD = /(?:^|[\s"'])(?:[^\s]*\/)?(?:rm|find)(?=\s|$)/

/** The head words {@link stripSegmentWrappers} will stop stripping in front of. */
const TEXTUAL_REMOVAL_HEADS: ReadonlySet<string> = new Set(['rm', 'find'])

/** The name a head token resolves to, as every other head test here spells it. */
const removalHeadName = (token: string): string | undefined =>
  unquotePath(token).split('/').pop()

/**
 * Rewrites each command-position segment of `text` with its ENFORCEMENT-WRAPPER
 * prefix removed, but only where doing so uncovers an `rm`. Identity otherwise,
 * byte for byte.
 *
 * ## Why this exists (P2.91)
 *
 * {@link TEXTUAL_RM_WORD} requires `rm` in COMMAND POSITION, and that rule was
 * written for a good reason it also over-served: the bare word-boundary version
 * fired on `git rm -rf ~`, which is a different command. The stated cost was
 * "the fallback loses `sudo`, which the structured scan already covers" — and
 * that trade is only sound while the two matchers see the same text. They do
 * not. On text the shared scanner cannot balance, the structured scan sees
 * NOTHING, so the fallback is the whole floor, and the floor was present for
 * `rm -rf ~` and absent for the same removal with more privilege in front of it.
 *
 * MEASURED on this tree before the fix: `case a in a) rm -rf ~ ;; esac` fired
 * `home`, while `case a in a) sudo rm -rf ~ ;; esac`, the `env` and the `nohup`
 * spellings all returned null. Runnable and destructive, not hypothetical — with
 * a sandbox stand-in tree in place of `~`, `bash`, `/bin/sh` and `zsh` each
 * removed it and exited 0 for the `env` and `nohup` forms (2026-08-28).
 *
 * ## Why it asks {@link stripSubcommand} instead of keeping a wrapper list
 *
 * The enforcement pass already owns the list — privilege wrappers, `env`,
 * `nohup`/`builtin`/`noglob`, `watch`/`setsid`/`ionice`/`flock`, `timeout`,
 * `time`, `nice`, `stdbuf`, `command`, flagless `xargs`, leading redirections
 * and leading `FOO=bar` assignments — and it has grown repeatedly. A second copy
 * here would be a mirror nothing checks, which is this repo's most-repeated
 * failure mode. Asking the real stripper costs one call per segment that
 * CONTAINS an `rm` word at all, and inherits every future entry for free.
 *
 * ## The three properties that keep the false-positive posture
 *
 * - A segment holding no `rm` word is returned untouched without calling the
 *   stripper, so the 504 heredocs and 128 `case` blocks in the measured corpus
 *   pay one regex test and change not at all.
 * - A segment whose FIRST word is already `rm` is returned untouched, so every
 *   spelling the scan reported before still reports the same `subcommand` and
 *   `argument` bytes.
 * - `git` is not a wrapper, so `git rm -rf ~` still yields a head of `git` and
 *   stays quiet — the exact regression the command-position rule was added to
 *   prevent, and the one the differential's `staysQuiet` corpus pins.
 *
 * ## What it deliberately does NOT widen
 *
 * Not `rmdir`: `rmdir ~` removes nothing on a non-empty home, and the fallback
 * requires recursion, which `rmdir` has no flag for — the same reasoning
 * {@link carriesRecursiveRemoval} records for `--dir`. It remains a stated gap
 * between the two matchers, declared as a `structured-only` row in the
 * differential.
 *
 * `find … -delete` WAS the second half of this paragraph and P2.312 closed it —
 * see {@link textualFindRemoval}, including which half of the reason recorded
 * here ("applying that to word soup would either invent removals or miss them
 * silently") was measured false. This function's own `find` handling is the
 * consequence: {@link TEXTUAL_CONTAINS_REMOVAL_HEAD} and
 * {@link TEXTUAL_REMOVAL_HEADS} carry both heads, so the fallback reads
 * `sudo find ~ -delete` and not only `find ~ -delete`.
 */
function stripTextualEnforcementWrappers(text: string): string {
  if (!TEXTUAL_CONTAINS_REMOVAL_HEAD.test(text)) return text
  let result = ''
  let start = 0
  for (let index = 0; index <= text.length; index += 1) {
    const atEnd = index === text.length
    if (!atEnd && !TEXTUAL_SEGMENT_BOUNDARY.test(text[index]!)) continue
    result += stripSegmentWrappers(text.slice(start, index))
    if (!atEnd) result += text[index]!
    start = index + 1
  }
  return result
}

/** One segment of {@link stripTextualEnforcementWrappers}; identity by default. */
function stripSegmentWrappers(segment: string): string {
  if (!TEXTUAL_CONTAINS_REMOVAL_HEAD.test(segment)) return segment
  const firstWord = segment.trimStart().split(/\s+/)[0]
  if (!firstWord || TEXTUAL_REMOVAL_HEADS.has(removalHeadName(firstWord) ?? '')) return segment
  const stripped = stripSubcommand(segment, true)
  const head = stripped.tokens[0]
  if (!head || !TEXTUAL_REMOVAL_HEADS.has(removalHeadName(head) ?? '')) return segment
  return stripped.text
}

function findShRemoval(command: string, home: string, platform: NodeJS.Platform): RootOrHomeRemoval | null {
  // Enforcement-wrapper pass: the floor must see `rm` through `sudo`, `env -S`
  // and `watch`, exactly as a deny rule does.
  //
  // `unparsed` collects the command text the walk could NOT balance -- the whole
  // command, a nested span, or a `-c` script. That is the textual fallback's
  // entire domain; see {@link findTextualRemoval}.
  const unparsed: string[] = []
  const subcommands = splitWithSubstitutions(command, undefined, unparsed)
  if (!subcommands) return findTextualRemoval(command, home)

  for (const subcommand of subcommands) {
    const stripped = stripSubcommand(subcommand, true)
    const [head, ...rest] = stripped.tokens
    if (!head) continue
    const name = unquotePath(head).split('/').pop()
    if (!name) continue

    if (name === 'find') {
      const operands = findDeleteOperands(rest)
      if (!operands) continue
      for (const token of operands) {
        const target = classifyTarget(token, home)
        if (target) return { target, subcommand: stripped.text, argument: token }
      }
      continue
    }

    if (!REMOVAL_COMMANDS.has(name)) {
      // P2.388 -- THE HALF THAT ACTUALLY CARRIED THE DEFECT, and it is not the
      // unparsed one. `sh -c "Remove-Item -Recurse -Force <home>"` PARSES: the
      // walk balances it, `stripSubcommand` unwraps the `-c` script exactly as
      // it does for `rm`, and the stripped head is `Remove-Item` -- a name no
      // POSIX `REMOVAL_COMMANDS` set contains, so the subcommand was dropped
      // here. That is why the wrapper strip caught `rm -rf ~` behind `sh -c`
      // while a PowerShell removal behind the same wrapper was null on BOTH
      // platforms: the two languages met different halves of one function.
      //
      // Same gate as {@link findRootOrHomeRemoval}'s, on the STRIPPED text, so
      // the wrapper is unwrapped once and both languages read the same string.
      if (platform === 'win32' || looksLikePowerShell(stripped.text)) {
        const windows = findWindowsRemoval(stripped.text, home)
        if (windows) return windows
      }
      continue
    }

    let flagsEnded = false
    for (const token of rest) {
      if (!flagsEnded && token === '--') { flagsEnded = true; continue }
      if (!flagsEnded && token.length > 1 && token.startsWith('-')) continue
      const target = classifyTarget(token, home)
      if (target) return { target, subcommand: stripped.text, argument: token }
    }
  }
  // The structured scan is exhausted. Anything it could not READ gets the
  // weaker reading, so the naming the prompt needs still comes from a real
  // operand rather than from the fact that a parse failed.
  //
  // P2.388 -- and the weaker reading is TWO readings, not one. This loop used to
  // offer each span to `findTextualRemoval` alone, which reads sh words, while
  // the PowerShell passes ran on the WHOLE command one level up. Measured at
  // `7a8477690` with controls on the same rig: `Remove-Item -Recurse -Force
  // <home>` fired at top level on darwin AND win32, and returned **null inside
  // an unparsed span on both**, while `rm -rf <home>` inside `sh -c` and `find
  // <home> -delete` fired. A shell wrapper was a way past a floor that has no
  // mode to switch out of.
  //
  // The gate is the SAME ONE the whole command gets in
  // `findRootOrHomeRemoval` -- every span on a Windows host, and off Windows
  // only a span `looksLikePowerShell` recognises -- so the two levels cannot
  // disagree about what language a command is in.
  //
  // THE HOST RESOLVER IS DELIBERATELY NOT CALLED HERE, and the residue is
  // stated rather than hidden: `findPowerShellHostRemoval` recurses, and
  // calling it from a loop that is itself reached from that recursion would
  // reset its depth counter, so the bound would have to be re-argued from the
  // text shrinking rather than from the counter. `sh -c "pwsh -c '...'"`
  // therefore stays null -- one spelling, measured and recorded, against a
  // traversal whose termination would rest on an argument instead of a
  // constant. The smaller thing that is provably true beats the larger one that
  // needs a proof.
  //
  // Why this can only narrow: `findWindowsRemoval` fails CLOSED on text it
  // cannot read. Measured over 10 ordinary sh strings that name the home and
  // would all now be scanned -- a `cat <<EOF` heredoc body carrying
  // `Get-Content`, a `ls ... | while read` pipeline, `grep -r Remove-Item`, and
  // two carrying a COMPLETE valid removal spelling as quoted text -- 10 of 10
  // stayed quiet, against 3 of 3 genuine spellings firing.
  for (const text of unparsed) {
    const textual = findTextualRemoval(text, home)
    if (textual) return textual
    if (platform === 'win32' || looksLikePowerShell(text)) {
      const spanWindows = findWindowsRemoval(text, home)
      if (spanWindows) return spanWindows
    }
  }
  return null
}

/**
 * The Windows scan: PowerShell and cmd spellings of the same removal.
 *
 * Run on a Windows host for EVERY command — the shell this build spawns there
 * is `cmd.exe /d /s /c` — and off Windows only when the command is PowerShell,
 * decided by the WIDE `looksLikePowerShell`, deliberately: `mode-manager.ts`
 * routes on the narrower `looksLikePowerShellOutsidePosixTest` (UA12.104), and
 * a wider reading here only adds refusals (`test 1 -eq 1` is scanned too).
 */
function findWindowsRemoval(command: string, home: string): RootOrHomeRemoval | null {
  const subcommands = splitPowerShellCommand(command)
  if (!subcommands) return null

  for (const subcommand of subcommands) {
    const tokens = tokenizePowerShell(subcommand)
    const [head, ...rest] = tokens
    if (!head) continue
    const name = windowsHeadName(head)
    if (!name || canonicalPowerShellCommandName(name) !== POWERSHELL_REMOVAL_CMDLET) continue

    // Shares `windowsTargetTokens` with the ladder below, and inherits its
    // narrowing on purpose — see that function for the decision and the
    // measurement behind it. The head goes with the tokens because the
    // narrowing is a PowerShell parameter-binding rule and the cmd builtins do
    // not bind parameters (P2.74).
    // The P2.85 predicate is this scan's OWN classifier, so the abbreviation
    // guard can never be blinded to something the breaker would have prompted on.
    const classifies = (token: string) => classifyWindowsTarget(token, home) !== null
    for (const token of windowsTargetTokens(rest, name, classifies)) {
      const target = classifyWindowsTarget(token, home)
      if (target) return { target, subcommand, argument: token }
    }
  }
  return null
}

/**
 * The command name a Windows head resolves to, lower-cased. `.exe` because a
 * Windows head can be spelled as a program (`del.exe`), and the path split
 * because it can be spelled with one.
 */
function windowsHeadName(head: string): string {
  return unquotePowerShellPath(head).split(/[\\/]/).pop()?.replace(/\.exe$/i, '').toLowerCase() ?? ''
}

/**
 * False for the tokens that cannot be a target. `-Recurse`/`-Force`/
 * `-LiteralPath` are PowerShell parameters; `/s`, `/q`, `/f` and `/a:h` are cmd
 * switches. Skipping them keeps a bare `/s` from being read as the filesystem
 * root.
 */
function isWindowsTargetToken(token: string): boolean {
  if (token.length > 1 && token.startsWith('-')) return false
  return !/^\/[A-Za-z](?::.*)?$/.test(token)
}

/**
 * `Remove-Item` parameters whose value is NOT a target, with the shortest
 * abbreviation that still names them.
 *
 * PowerShell accepts any UNAMBIGUOUS prefix of a parameter name, so `-Exc` and
 * `-Exclude` are the same parameter. The minimum below is the length at which
 * the prefix stops colliding with another NAME OR ALIAS in this cmdlet's
 * binding namespace — its own parameters, the common ones, and the aliases of
 * both — measured against the cmdlet's parameter set, not guessed. The set is
 * quoted in full on {@link windowsTargetTokens}; the collisions are:
 *
 * - `exclude` — `-e` also prefixes `-ErrorAction`/`-ErrorVariable`; `-ex` does
 *   not (they are `er`).
 * - `include` — `-in` also prefixes `-InformationAction`/`-InformationVariable`;
 *   `-inc` does not.
 * - `filter` — `-f` also prefixes `-Force`; `-fi` does not.
 * - `stream` — nothing collides AT ALL. No parameter, and no alias of one,
 *   begins with `s` in any of the three shipped versions, so `-s` already binds
 *   `-Stream` and ONE character is the true minimum (P2.72).
 *
 * A SHORTER prefix is therefore left in the scan rather than skipped. That is
 * the deliberate direction: PowerShell would refuse `-E vendor/*` as ambiguous,
 * and for a deny this strong an extra classified token is the cheaper error.
 *
 * `stream` is the one row where that safety margin is zero, so it is worth
 * saying what holds it up. A minimum of 1 can only under-fire on a command
 * where `-s` binds something OTHER than `-Stream` and the next token is a real
 * target — and inside `Remove-Item` there is nothing else for `-s` to bind, so
 * such a command is one PowerShell refuses rather than runs (`-s /` leaves
 * `-Path` unfilled and fails mandatory-parameter binding, the same argument
 * that made the other three costless). The one place a bare `-s` is plausibly
 * not a parameter at all is a `cmd` head, where it would be a FILENAME, and
 * {@link windowsTargetTokens} no longer applies this list to those heads
 * (P2.74). Rounding the minimum up "to be safe" would have been the safe
 * DIRECTION and a guess, and the other three minima here are measurements.
 */
interface NonTargetParameter {
  /** The full parameter name, lower-cased. */
  name: string
  /** The shortest abbreviation that still names it unambiguously. */
  minimumPrefix: number
  /**
   * True when a PROVIDER supplies this parameter at run time instead of the
   * cmdlet declaring it — so it is ABSENT from the binding namespace whenever
   * some other provider is in play, and the minimum above is a fact about the
   * FileSystem provider rather than about `Remove-Item`. See the P2.85 section
   * on {@link windowsTargetTokens} for what that costs and what pays for it.
   */
  providerDynamic?: boolean
}

const NON_TARGET_PARAMETERS: ReadonlyArray<NonTargetParameter> = [
  { name: 'exclude', minimumPrefix: 2 },
  { name: 'include', minimumPrefix: 3 },
  { name: 'filter', minimumPrefix: 2 },
  { name: 'stream', minimumPrefix: 1, providerDynamic: true },
]

/**
 * The row `-Exclude`, `-Include`, `-Filter`, `-Stream` or an unambiguous
 * abbreviation of one names, in any case — plus whether this SPELLING was an
 * abbreviation rather than the full name, which is what the P2.85 guard on
 * {@link windowsTargetTokens} turns on.
 *
 * A DENY-LIST of non-target parameters, deliberately not an allow-list of
 * `-Path`/`-LiteralPath`: an allow-list would silently stop scanning every
 * target-bearing parameter nobody thought of, and for a check that denies in
 * every mode the safe failure is to keep scanning.
 *
 * The COLON form (`-Exclude:vendor/*`) is not matched and must not be: the
 * value rides on this same token, which {@link isWindowsTargetToken} already
 * drops, so matching it here would consume the NEXT token — which can be the
 * real `-Path` value.
 *
 * No two rows share a prefix, so the first match is the only match.
 */
function matchNonTargetParameter(
  token: string,
): { parameter: NonTargetParameter; abbreviated: boolean } | null {
  if (!token.startsWith('-')) return null
  const name = token.slice(1).toLowerCase()
  for (const parameter of NON_TARGET_PARAMETERS) {
    if (name.length < parameter.minimumPrefix || !parameter.name.startsWith(name)) continue
    return { parameter, abbreviated: name.length < parameter.name.length }
  }
  return null
}

/**
 * Which shell resolves a removal head, for every head the alias table has.
 *
 * `cmd` — `del`, `erase`, `rd` and `rmdir` are `cmd.exe` INTERNAL commands, and
 * on win32 they reach {@link windowsTargetTokens} through the shell this build
 * actually spawns there (`cmd.exe /d /s /c`), not through PowerShell, even
 * though `canonicalPowerShellCommandName` also resolves all four to
 * `Remove-Item` through the shipped `Set-Alias` table. A `-Param` in front of
 * one of them is a FILENAME, not a parameter that swallows the next token.
 *
 * `powershell` — `remove-item`, `ri` and `rm`: cmd has no such commands, so a
 * `-Param` in front of one is being read by something that binds parameters.
 *
 * ## This is ONE value, and the site over it is TOTAL (P2.84)
 *
 * The predecessor was `CMD_REMOVAL_BUILTINS`, a hand-kept set of four names
 * living in this file while the alias table it had to partition lived in
 * another, with NOTHING linking them. A head added to that table inherited the
 * PowerShell parameter rule silently — the UNDER-FIRE direction, so the
 * security one.
 *
 * The fix is not a test comparing two lists (that only proves they agree with
 * each other, the shape `P2.94` rejected) but the totality of THIS record:
 * `PowerShellRemovalHead` is COMPUTED from the alias table, so a new removal
 * alias makes this object missing a key and the BUILD fails at the one site
 * that has to decide the question. There is no second list to keep in step.
 *
 * The lookup is by string and tolerates a miss on purpose — `windowsTargetTokens`
 * is reached by heads that are not removals at all — and a miss means "binds
 * parameters", which is the behaviour every non-cmd head had before.
 */
type RemovalHeadShell = 'cmd' | 'powershell'

const REMOVAL_HEAD_SHELL: Record<PowerShellRemovalHead, RemovalHeadShell> = {
  del: 'cmd',
  erase: 'cmd',
  rd: 'cmd',
  rmdir: 'cmd',
  'remove-item': 'powershell',
  ri: 'powershell',
  rm: 'powershell',
}

/**
 * The argument tokens that can be a TARGET, in order.
 *
 * `:599` frames the whole ladder on the target — "The outcome depends on the
 * target" — and `:602` on "any TARGET ending in `/*`", but until P2.51 both
 * scans classified every token that was not a `-Param` or a `/x` cmd switch, so
 * a glob-shaped parameter VALUE was read as a target. `-Exclude` and `-Include`
 * name what is spared or selected inside the target, `-Filter` narrows it, and
 * `-Stream` names an alternate data stream OF it;
 * `Remove-Item -Path ./logs -Recurse -Exclude vendor/*` denied on the negation
 * of its own target.
 *
 * BOTH Windows scans use this deliberately — the ladder's deny
 * ({@link findRemoveItemLadderDeny}) and the circuit breaker's PROMPT
 * ({@link findWindowsRemoval}). The over-reach was measured on both before the
 * change (`Remove-Item -Exclude ~ -Path ./logs` raised a breaker prompt saying
 * the command removes the home directory, for a command that spares it), and
 * this file's own posture — "a false positive is how this feature gets
 * disabled" — reads the same on the prompt path as on the deny path. Pinned
 * from both sides in `removal-circuit-breaker.test.ts`.
 *
 * Exactly ONE token is skipped per non-target parameter. PowerShell passes a
 * multi-value list as one comma-joined token (`-Exclude a/*,b/*`), so a SECOND
 * space-separated glob is positional there, not part of the exclusion — and
 * anything this filter is unsure of stays in the scan.
 *
 * ## THE LIST IS COMPLETE FOR THIS CMDLET, and that is measured (P2.72)
 *
 * `Remove-Item.md` from `MicrosoftDocs/PowerShell-Docs@main`, fetched with
 * `curl -s` on 2026-08-23 for 5.1, 7.4 and 7.5 (the 7.4 and 7.5 parameter sets
 * are identical), documents exactly these parameters: `-Credential`,
 * `-DeleteKey`, `-Exclude`, `-Filter`, `-Force`, `-Include`, `-LiteralPath`,
 * `-Path`, `-Recurse`, `-Stream`, `-Confirm`, `-WhatIf`, plus `-UseTransaction`
 * on 5.1 only, plus the common parameters. Of those, the ones whose VALUE can
 * be a path or a glob are exactly six: `-Path` and `-LiteralPath` name the
 * target, and `-Include`, `-Exclude`, `-Filter` and `-Stream` are the four
 * below. Everything else carries no path: `-Force`, `-Recurse`, `-DeleteKey`,
 * `-Confirm`, `-WhatIf` and `-UseTransaction` are declared
 * `System.Management.Automation.SwitchParameter` and take no value at all, and
 * `-Credential` takes a `PSCredential`.
 *
 * `-Stream` earned its place from the same page: "This is a dynamic parameter
 * made available by the **FileSystem** provider" (`:432`), `Type:
 * System.String[]` with `Accept wildcard characters: True` (`:447`, `:455`) —
 * a documented GLOB whose value is a stream name, not a path. So
 * `Remove-Item C:/Users/me/a/notes.txt -Stream *` removes every alternate data
 * stream of ONE file, and it used to be denied in every mode as a bare `*`
 * (MEASURED 2026-08-23 on the parent commit).
 *
 * `-DeleteKey` is the parameter P2.51's enumeration did not name — a
 * Certificate-provider dynamic parameter, Windows-only — and it is a switch, so
 * the count of glob-shaped parameters is unchanged by it. It still matters
 * here: it is in the binding namespace the prefix minima above are measured
 * against.
 *
 * Do NOT read "complete" as "the deny-list posture was over-cautious". Two of
 * the twelve parameters above (`-Stream`, `-DeleteKey`) exist only because a
 * PROVIDER supplies them at run time, so a cmdlet's parameter set is extended
 * by whatever provider the path resolves to — a documented list is a snapshot
 * of the shipped providers, not a closed set. A deny-list keeps scanning
 * anything it does not recognise; an allow-list of `-Path`/`-LiteralPath`
 * would have stopped scanning it.
 *
 * ## The cmd heads are OUT of the parameter rule (P2.74)
 *
 * Everything above reasons about PowerShell PARAMETER BINDING, and that
 * reasoning does not reach `del`, `erase`, `rd` or `rmdir`
 * ({@link REMOVAL_HEAD_SHELL}'s `cmd` rows). In a real `cmd` shell those are internal
 * commands that take FILENAMES, so `-Include` there is a file called
 * `-Include`, not a parameter that swallows the next token — and P2.51's
 * narrowing therefore made `del -Include C:\ /s /q` `null` on both scans when
 * it had been a drive-root deny plus a root prompt (MEASURED on win32 by
 * P2.51's review; the only under-fire that change introduced).
 *
 * So the skip is applied only when the head is one a parameter-binding shell
 * resolves. The alternative was a docstring admitting the mismatch, which costs
 * the same and leaves the gate doing something its stated reason does not
 * justify. What it costs: a PowerShell session that spells `Remove-Item` as
 * `del` gets P2.51's false deny back (`del /s /q ./logs -Exclude vendor/*`
 * denies again, pinned). That is the right direction for this file — an
 * over-firing deny is an annoyance, an under-firing one is a missed removal —
 * and it is also what keeps `stream`'s one-character minimum honest, since a
 * bare `-s` in front of a cmd builtin is a filename too.
 *
 * ## An ABBREVIATED provider-dynamic parameter never blinds the scan (P2.85)
 *
 * The section above ends on a caveat that turned out to be load-bearing: a
 * PROVIDER extends the parameter set at run time, so "nothing in this cmdlet's
 * binding namespace begins with `s`" — the whole justification for `stream`'s
 * one-character minimum — is a claim about the SHIPPED providers only. Widen
 * the frame and the claim fails in the security direction: under a
 * non-FileSystem provider `-Stream` is not merely un-abbreviated, it is ABSENT
 * ("These parameters are available only when the cmdlet is used with the
 * provider that added them", `about_Providers.md` § Finding dynamic parameters,
 * `MicrosoftDocs/PowerShell-Docs@main`, `curl -s` 2026-08-27; the FileSystem
 * attribution is `Remove-Item.md` § `-Stream`, "This is a dynamic parameter
 * made available by the **FileSystem** provider"). A bare `-s` there binds
 * whatever that provider DID contribute, and if that is a switch the token
 * behind it is not a stream name at all — it is the positional `-Path` value,
 * i.e. the target, which this function would hand back as skipped.
 *
 * That path was closed when it was found, and closed BY COINCIDENCE: the four
 * drive regexes in this file are single-letter (`normalizeWindowsPath`,
 * `isWindowsRoot`, and two in `classifyWindowsSystemPath`), and every shipped
 * non-FileSystem PSDrive is spelled with more than one letter — `Alias:`,
 * `Cert:`, `Env:`, `Function:`, `HKLM:`, `HKCU:`, `Variable:`, `WSMan:`, against
 * FileSystem's "`C:` and other depending on hardware" (`about_Providers.md`
 * § Built-in providers, same fetch). So a non-FileSystem root never classified,
 * and skipping it cost nothing.
 *
 * Nothing said those regexes were holding a security property up, and widening
 * them is an otherwise-harmless improvement. MEASURED 2026-08-27 on the parent
 * commit, with all four widened to `[A-Za-z]+` and `home: 'C:/Users/testuser'`:
 * `Remove-Item HKLM:\` went from null/null to a root PROMPT and a drive-root
 * DENY, while `Remove-Item -s HKLM:\` stayed NULL ON BOTH — the under-fire, back
 * from one sed. (Nor is the coincidence even structural: `New-PSDrive.md`
 * § `-Name` says "For temporary PowerShell drives, you aren't limited to drive
 * letters, use any valid string", so a one-letter Registry drive needs no code
 * change at all — only a `New-PSDrive`.)
 *
 * So the rule no longer depends on them. A value is still skipped, EXCEPT when
 * the parameter was spelled as a strict ABBREVIATION of a `providerDynamic` row
 * AND the value is one this scan would classify — then it stays in the scan.
 * Both halves are load-bearing:
 *
 * - **Abbreviation only.** The FULL name is unambiguous in every binding
 *   namespace, since a provider cannot contribute a second `-Stream`; and where
 *   `-Stream` is absent, `Remove-Item -Stream …` is a binding ERROR rather than
 *   a removal, so nothing runs for the breaker to miss. That is also what keeps
 *   P2.72's measured rows still measuring what they measured — the quiet
 *   `Remove-Item -Stream ~ -Path ./logs` spells it in full.
 * - **`providerDynamic` only.** `-Exclude`, `-Include` and `-Filter` are
 *   declared by the cmdlet, so they are in the namespace under every provider
 *   and their minima stay measurements. Widening the guard to them would cost a
 *   real false positive (`Remove-Item -Ex ~ -Path ./logs` is legal, spares the
 *   home, and would start denying in every mode) to defend against a collision
 *   nobody has measured.
 *
 * The cost this DOES pay is `Remove-Item -s ~ -Path ./logs`: under FileSystem
 * that is `-Stream ~`, a stream named `~`, and it now prompts and denies.
 *
 * **That cost was recorded wrongly, and the correction is the whole of it
 * (P2.287, MEASURED 2026-08-28).** This paragraph used to excuse the row with
 * "it is also a command that cannot run — an unbound `-Path` fails mandatory
 * binding — so the annoyance lands on commands that were already errors". The
 * command it names BINDS `-Path`, by name, in the same line: `Remove-Item.md`
 * § `-Path` gives `Required: True`, `Position: 0`, so `-Path ./logs` satisfies
 * it, and the FileSystem `Path` parameter set is spelled
 * `Remove-Item [-Path] <String[]> … [-Stream <String[]>]` — `-Stream` and
 * `-Path` together are one parameter set, not a conflict. § Example 7 runs that
 * exact shape (`Remove-Item C:\Test\Copy-Script.ps1 -Stream Zone.Identifier`)
 * and removes a STREAM, leaving the file. (`MicrosoftDocs/PowerShell-Docs@main`,
 * `curl -s` 2026-08-28.)
 *
 * So `Remove-Item -s ~ -Path ./logs` is runnable, benign, and touches nothing
 * under the home directory — and this guard gives it a `nonNegotiable` prompt
 * AND an every-mode deny with no override. Measured on the same rig:
 * `deny system-path/home`, `prompt home`, argument `~`, and the same for
 * `-LiteralPath` and for the reordered `Remove-Item -Path ./logs -s ~`.
 *
 * What still holds is the ROW the guard was built for: `-Stream` "can't be used
 * in combination with the **Recurse** parameter" (§ `-Stream`), so P2.85's
 * traced shape `Remove-Item -s ~ -Recurse -Force` really is a binding error
 * under FileSystem, and rescuing it really is free. The false generalisation was
 * extending that to the `-Path`-bound spelling, where it is not.
 *
 * The guard is left as it is rather than narrowed, because narrowing it —
 * skipping the value whenever `-Path`/`-LiteralPath` is bound elsewhere, which
 * is sound under BOTH readings, since an explicitly bound `-Path` leaves no
 * positional slot for the swallowed token to be the target of — reverses part
 * of a security decision and is an owner call, not a side effect of P2.287.
 * Recorded here and pinned below so the next reader inherits the measurement
 * rather than the excuse.
 *
 * The predicate is the CALLER'S, not a shared one, so neither scan can be
 * blinded to something the OTHER scan happens not to classify. It must,
 * however, ask what its OWN scan asks, and the ladder's did not: it tested
 * `ladderCase === 'system-path'` where its loop body accepts any match, so it
 * blinded the ladder to the ladder's own `wildcard` rung (P2.287, seven
 * measured spellings). Both predicates now test the same thing their loop does.
 * What kept P2.72 alive was never the rung but the RESOLUTION — a glob IS a
 * documented `-Stream` value (`Accept wildcard characters: True`), so a target
 * whose base cannot be named (`*`, `vendor/*`, `./build/*`) is still swallowed,
 * while `/usr/*` and `~/*` are not stream names and deny as they do bare.
 */
function windowsTargetTokens(
  rest: readonly string[],
  headName: string,
  classifiesAsTarget: (token: string) => boolean,
): string[] {
  // A cmd builtin binds no parameters, so every token is a candidate filename.
  const bindsParameters =
    (REMOVAL_HEAD_SHELL as Record<string, RemovalHeadShell | undefined>)[headName] !== 'cmd'
  const targets: string[] = []
  // Non-null while the PREVIOUS token was a non-target parameter and this one is
  // its value. `keepIfTarget` is the P2.85 guard: the spelling was an
  // abbreviation of a provider-dynamic row, so it may not be the parameter we
  // think it is, and a value this scan classifies is not one it may swallow.
  let pendingValue: { keepIfTarget: boolean } | null = null
  for (const token of rest) {
    if (pendingValue) {
      const { keepIfTarget } = pendingValue
      pendingValue = null
      if (!keepIfTarget || !classifiesAsTarget(token)) continue
    } else if (bindsParameters) {
      const match = matchNonTargetParameter(token)
      if (match) {
        pendingValue = { keepIfTarget: match.abbreviated && match.parameter.providerDynamic === true }
        continue
      }
    }
    if (!isWindowsTargetToken(token)) continue
    targets.push(token)
  }
  return targets
}

/**
 * The first root-or-home removal anywhere in `command`, or null.
 *
 * Both scans run: a Windows host still spells `rm -rf ~` the sh way inside a
 * `bash -c`, and a POSIX host can be handed a PowerShell command by a model
 * that guessed wrong about the platform. Whichever scan recognises it first
 * wins, and both produce the same `RootOrHomeRemoval`, so the caller's prompt
 * — and its `nonNegotiable` marker — is identical either way.
 */
export function findRootOrHomeRemoval(
  command: string,
  options: { home?: string; platform?: NodeJS.Platform } = {},
): RootOrHomeRemoval | null {
  if (!command) return null
  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform

  const sh = findShRemoval(command, home, platform)
  if (sh) return sh
  // P2.160 -- a PowerShell HOST hides its script in an ARGUMENT, so neither scan
  // above can see it: `powershell -Command "Remove-Item -Recurse -Force ~"`
  // returned null on both platforms while the bare `Remove-Item` form fired,
  // and so did 21 further spellings (measured). Resolving the host is the
  // PowerShell counterpart of what P2.151 did for sh.
  const host = findPowerShellHostRemoval(command, home, 0, platform)
  if (host) return host
  if (platform !== 'win32' && !looksLikePowerShell(command)) return null
  return findWindowsRemoval(command, home)
}

/**
 * How many nested PowerShell hosts the floor unwraps.
 *
 * A bound, not a guess about nesting depth: `pwsh -c "pwsh -c '…'"` is one real
 * spelling, and every level costs a full re-scan, so the recursion is capped the
 * way {@link MAX_TEXTUAL_SCAN_LENGTH} caps the textual pass. Three is one more
 * than any spelling measured.
 */
const MAX_POWERSHELL_HOST_DEPTH = 3

/**
 * The first root-or-home removal inside a PowerShell HOST invocation, or null.
 *
 * Both scans run on the resolved script, and the Windows scan runs WITHOUT the
 * `looksLikePowerShell` gate on purpose: the head was a measured PowerShell
 * host, so the script IS PowerShell, and re-asking a heuristic about text whose
 * language is already known is how `pwsh -c "rm -Recurse -Force ~"` would slip
 * — its script names no Verb-Noun cmdlet at all.
 *
 * An `unreadable` script (a `-File` path, or an `-EncodedCommand` payload that
 * does not decode) yields NOTHING here rather than a prompt: this matcher's
 * contract is to name the target it found, and a target it cannot read has no
 * name. That is a stated limit, not an oversight — the same one P2.144 records
 * for an unparseable command, and it is why the resolver reports the case
 * instead of dropping it.
 */
function findPowerShellHostRemoval(
  command: string,
  home: string,
  depth: number,
  platform: NodeJS.Platform,
): RootOrHomeRemoval | null {
  if (depth >= MAX_POWERSHELL_HOST_DEPTH) return null
  for (const script of powerShellHostScripts(command)) {
    if (script.kind !== 'script') continue
    const sh = findShRemoval(script.text, home, platform)
    if (sh) return sh
    const windows = findWindowsRemoval(script.text, home)
    if (windows) return windows
    const nested = findPowerShellHostRemoval(script.text, home, depth + 1, platform)
    if (nested) return nested
  }
  return null
}

/**
 * The description the user reads on the prompt. It names WHAT is about to be
 * removed and WHY the prompt appeared despite the mode — a prompt that looks
 * like every other prompt gets the same reflexive approval.
 */
export function describeRootOrHomeRemoval(removal: RootOrHomeRemoval): string {
  const what = removal.target === 'root'
    ? 'the filesystem root'
    : 'your home directory'
  return `This command removes ${what} (\`${removal.argument}\`): \`${removal.subcommand}\`. `
    + 'Removals of the root or home directory always ask, in every permission mode including '
    + 'Execute, and there is no "don\'t ask again" — it is a circuit breaker against model '
    + 'error. Approve only if you meant to delete everything there.'
}

// ============================================================
// The `Remove-Item` ladder — a DENY, not a prompt
// ============================================================

/**
 * `permission-modes.md`, section `### Remove-Item in PowerShell`, fetched with
 * `curl -s` on 2026-08-23. `:599` opens it:
 *
 *   "When you enable the [PowerShell tool](/docs/en/tools-reference#powershell-tool),
 *   Claude Code gives `Remove-Item` its own check, separate from the `rm`
 *   critical-path list. The outcome depends on the target, and the first
 *   matching case applies:"
 *
 * Two of its three cases are DENIES that no mode asks about, and they are what
 * {@link findRemoveItemLadderDeny} matches:
 *
 *   `:601` — "**System paths**: the filesystem root and its top-level
 *   directories, drive roots and their top-level directories, and your home
 *   directory. Claude Code denies the command in every mode, without asking
 *   you."
 *
 *   `:602` — "**Wildcards**: a bare `*`, or any target ending in `/*` or `\*`,
 *   including a glob under a shell variable such as `$dir/*`. Claude Code
 *   denies the command in every mode, without asking you, before the
 *   [classifier](#eliminate-prompts-with-auto-mode) sees it."
 *
 * The THIRD case is an ordinary approval and is deliberately NOT matched here,
 * `:603` — "**Your working directory or one of its parents, with `-Recurse`**:
 * Claude Code treats the command like any other that needs approval in your
 * permission mode … `bypassPermissions` mode skips this check." That last
 * sentence belongs to the third case ALONE, which is why the two above deny in
 * `bypassPermissions` too.
 *
 * The classifier's own page-level list states `:602` from the other side,
 * `:379`, last sentence of the unresolvable-variable bullet: "`Remove-Item`
 * targets that are a bare `*` or end in `/*` or `\*` never reach the classifier:
 * Claude Code denies them outright" — in the same bullet that names
 * `rm -rf "$VAR"` as something the classifier BLOCKS, i.e. reaches it.
 *
 * ## Separate from {@link findRootOrHomeRemoval}, on purpose
 *
 * That matcher answers "is this a root-or-home removal that must PROMPT", and
 * its answer feeds the sh critical-path table (`:574-580`) as well. This one
 * answers "is this a `Remove-Item` the page denies outright", which covers
 * targets that are neither root nor home (`/usr`, `$dir/*`, a bare `*`) and
 * must never turn into a prompt for a target it cannot name. Widening the
 * first matcher would have produced exactly that: a new circuit-breaker prompt
 * saying "removes the filesystem root" for `rm /usr`.
 *
 * ## Known limits, and one that was closed (coverage-map row 70/line 76)
 *
 * - **The `rm` aliases (gap (c), P2.34).** `rm` and `rmdir` ARE `Remove-Item`
 *   in PowerShell, and this matcher skips them by literal spelling — see
 *   {@link REMOVE_ITEM_LADDER_SKIPPED_HEADS}.
 * - **`:602` was implemented one carve-out short of its literal width, and is
 *   not any more (P2.49, owner decision on OQ-4, 2026-08-23).** The carve-out
 *   spared a glob under a relative base that NAMED a subdirectory — `./build/*`,
 *   `build/*`, `src/generated/*` — on the argument that an ordinary in-workspace
 *   cleanup should not become an every-mode deny with no override. The bullet
 *   grants no such exception: "any target ending in `/*` or `\*`", full stop.
 *   The branch above now denies every base, and the base is resolved for the
 *   MESSAGE only.
 *
 *   What settled it is that the carve-out was SPELLING-DEPENDENT, not scope-
 *   dependent: `Remove-Item /Users/me/project/build/*` already denied in every
 *   mode, so `Remove-Item ./build/*` allowed was the same cleanup of the same
 *   directory answered two ways. Removing it makes the answer uniform across
 *   spellings rather than strict in a place nothing was strict before.
 *
 *   Two accounts are kept here because the CODE that carried them is gone.
 *   (1) `DOT_ONLY_BASE`: a base of only `.`/`..` segments is the bare `*`
 *   respelled (PowerShell resolves `.` and `..` against the current location
 *   and takes either separator), and the carve-out swallowed it — `*` denied in
 *   every mode while `./*`, `.\*` and `../*` were ALLOWED in
 *   `bypassPermissions`, reachable on win32 through the aliases the ladder does
 *   claim (`del .\*`, `rd /s /q .\*`), while {@link describeRemoveItemLadderDeny}
 *   told the model that spelling was impossible. A `.`-only base slipped the
 *   carve-out's absolute-path test specifically because `normalizeWindowsPath`
 *   returns null for a relative path, so `normalizeWindowsPath('.')` is null and
 *   the check read as "not absolute, spare it". P2.34's round-2 review closed it
 *   with a dedicated predicate; P2.49 deleted the predicate along with the
 *   carve-out it patched, and the rows it pinned still pass through the
 *   unconditional deny. (2) A DOUBLED separator (`.//*`, `..//*`, `./build//*`)
 *   was a live hole in that patch — `.//` is neither dot-only nor absolute nor
 *   variable-rooted — and is moot by construction now rather than fixed: no base
 *   shape is left that can fall through.
 *
 *   Unchanged by all of it: `:602` is a rule about a GLOB. `Remove-Item ..`,
 *   `.` and `./build` carry no trailing `/*`, never entered this branch, and
 *   remain the ladder's THIRD case — an ordinary approval. Pinned as
 *   does-not-fire rows in `removal-circuit-breaker.test.ts`.
 * - **No substitution breadth.** Like {@link findWindowsRemoval}, this scan does
 *   not descend into `$(…)`. The page's substitution clause (`:595`) sits in the
 *   `rm` critical-path section and says nothing about this ladder.
 * - **Only the TARGET is classified, since P2.51.** `:599` and `:602` are quoted
 *   above and both frame the ladder on the target; the token loop classified
 *   every token that was not a `-Param` or a `/x` cmd switch, so a glob-shaped
 *   parameter VALUE denied. All five measured spellings —
 *   `-Exclude vendor/*`, `-Include bin/*`, `-Filter obj/*`, `-Stream *` (P2.72)
 *   and a `#` comment tail — are filtered by {@link windowsTargetTokens} and
 *   {@link tokenizePowerShell} now. The narrowing is an inference from "the
 *   target", NOT a documented carve-out: the page names none of those four
 *   parameters, so the deny-list is kept short and everything unrecognised
 *   keeps being classified. It is also a PowerShell parameter-binding rule, so
 *   since P2.74 it stops at the heads `cmd` resolves itself — `del`, `erase`
 *   and `rd` classify every token, and `rmdir` never reaches here at all
 *   ({@link REMOVE_ITEM_LADDER_SKIPPED_HEADS}).
 */

/** Which rung of the ladder denied. */
export type RemoveItemLadderCase = 'system-path' | 'wildcard'

/** What the target resolved to, when it resolved at all. Message material. */
export type RemoveItemLadderResolved = 'root' | 'drive-root' | 'top-level' | 'home'

export interface RemoveItemLadderDeny {
  /** `:601` or `:602`. */
  ladderCase: RemoveItemLadderCase
  /** null when the target names no path we can resolve (`$dir/*`, a bare `*`). */
  resolved: RemoveItemLadderResolved | null
  /** The removal subcommand, as the user would read it. */
  subcommand: string
  /** The verbatim argument token that matched. */
  argument: string
}

/**
 * The heads this ladder does NOT claim, by literal spelling.
 *
 * `rm` and `rmdir` resolve to `Remove-Item` through the shipped `Set-Alias`
 * table, so a PowerShell session really would run `rm -rf $HOME/*` as this
 * cmdlet — and we still leave it on the `rm` critical-path list. `:599` gives
 * the ladder to `Remove-Item` "separate from the `rm` critical-path list", and
 * that list's per-mode answers are the `:574-580` table this file's caller
 * matches five-of-five (P2.3 + P2.21): claiming `rm` here would DENY, in every
 * mode, commands that table says to prompt for (`default`, `acceptEdits`,
 * `bypassPermissions`) or to send to the classifier (`auto`, eligible `plan`).
 * The fork also cannot know which shell will run the command: on win32 it
 * spawns `cmd.exe /d /s /c`, where `rm` is not a command at all, and off Windows
 * the scan only runs for a command `looksLikePowerShell` recognises. `find` is
 * here for the same reason — it is the sh side of the breaker (D16), not a
 * cmdlet. Recorded as gap (c) of P2.34 rather than implemented, and pinned by
 * tests on both sides so a flip is loud.
 */
const REMOVE_ITEM_LADDER_SKIPPED_HEADS = new Set(['rm', 'rmdir', 'find'])

/**
 * `:601`'s set: the filesystem root, a drive root, one of THEIR top-level
 * directories, or the home directory. Exactly one segment below a root is
 * top-level; two are not (`/usr/local` is an ordinary path).
 */
function classifyWindowsSystemPath(value: string, home: string): RemoveItemLadderResolved | null {
  const normalized = normalizeWindowsPath(substituteWindowsHome(value.replaceAll('\\', '/'), home))
  if (!normalized) return null
  const normalizedHome = normalizeWindowsPath(home)
  // Home first: on Windows it IS below a drive root, and the page names it in
  // the same breath, so the more specific phrase wins the message.
  if (normalizedHome && normalized.toLowerCase() === normalizedHome.toLowerCase()) return 'home'
  if (normalized === '/') return 'root'
  if (/^[A-Z]:\/$/.test(normalized)) return 'drive-root'
  const belowRoot = /^(?:[A-Z]:)?\/(.+)$/.exec(normalized)?.[1]
  if (belowRoot && !belowRoot.includes('/')) return 'top-level'
  return null
}

/**
 * Which rung this one target lands on, or null for a target on neither.
 *
 * WILDCARD IS TESTED FIRST even though `:601` is the earlier bullet: the two
 * sets are disjoint under the reading that a glob is not a directory, so
 * "the first matching case applies" cannot arbitrate between them, and a target
 * that LOOKS like a glob is the one the user needs named as a glob. `$HOME/*`
 * therefore reports the wildcard case with `resolved: 'home'`, not the
 * system-path case.
 */
function classifyRemoveItemLadderTarget(
  rawToken: string,
  home: string,
): { ladderCase: RemoveItemLadderCase; resolved: RemoveItemLadderResolved | null } | null {
  const value = unquotePowerShellPath(rawToken).replaceAll('\\', '/')
  if (!value) return null

  if (value === '*') return { ladderCase: 'wildcard', resolved: null }
  if (value.endsWith('/*')) {
    const base = value.slice(0, -2)
    // `/*` and `C:/*` strip to a root, which has no separate spelling.
    if (base === '') return { ladderCase: 'wildcard', resolved: 'root' }
    // EVERY other base denies, because `:602` says "any target ending in `/*`
    // or `\*`" and names no exception. Resolving the base is message material
    // only — a base we cannot name still denies, with `resolved: null`.
    return { ladderCase: 'wildcard', resolved: classifyWindowsSystemPath(base, home) }
  }

  const resolved = classifyWindowsSystemPath(value, home)
  return resolved ? { ladderCase: 'system-path', resolved } : null
}

/**
 * The first `Remove-Item` target anywhere in `command` that the ladder denies
 * outright, or null. See the section docstring above for the contract, the
 * scope and the recorded limits.
 *
 * Platform gate mirrors {@link findRootOrHomeRemoval}'s Windows scan exactly:
 * every command on a Windows host, and off Windows only a command the WIDE
 * `looksLikePowerShell` recognises — wider than mode-manager's routing since
 * UA12.104, on purpose: here it only adds refusals ({@link findWindowsRemoval}).
 */
export function findRemoveItemLadderDeny(
  command: string,
  options: { home?: string; platform?: NodeJS.Platform } = {},
): RemoveItemLadderDeny | null {
  if (!command) return null
  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform
  // P2.160 -- the host layer, BEFORE the gate. This authority is a DENY in every
  // mode including `bypassPermissions`, so a spelling it cannot see is strictly
  // worse than one the breaker cannot see: measured on the parent commit,
  // `pwsh -c "Remove-Item *"` was null while the bare `Remove-Item *` was a
  // wildcard deny. It runs BEFORE `looksLikePowerShell` because a PowerShell
  // HOST HEAD is itself the evidence, and asking a text heuristic first can only
  // lose — measured while wiring this: with the call placed after the gate,
  // `powershell -e <base64>` was null on darwin and a deny on win32, because
  // base64 names no Verb-Noun cmdlet for the heuristic to recognise.
  const hostDeny = findPowerShellHostLadderDeny(command, home, 0)
  if (hostDeny) return hostDeny
  if (platform !== 'win32' && !looksLikePowerShell(command)) return null

  const subcommands = splitPowerShellCommand(command)
  if (!subcommands) return null

  for (const subcommand of subcommands) {
    const tokens = tokenizePowerShell(subcommand)
    const [head, ...rest] = tokens
    if (!head) continue
    const name = windowsHeadName(head)
    if (!name || REMOVE_ITEM_LADDER_SKIPPED_HEADS.has(name)) continue
    if (canonicalPowerShellCommandName(name) !== POWERSHELL_REMOVAL_CMDLET) continue

    // The P2.85 predicate, this scan's own. It must ask the SAME question the
    // loop body below asks — "does this token classify?" — and it did not:
    // testing `ladderCase === 'system-path'` narrowed the guard to ONE of the
    // two rungs the loop accepts, so a target on the OTHER rung was swallowed
    // behind an abbreviation while its bare form denied. MEASURED 2026-08-28,
    // `home: '/Users/testuser'`, platform win32 — SEVEN spellings, not the five
    // first reported: `-s /usr/*`, `-s C:\Windows\*`, `-s R:\SOFTWARE\*`,
    // `-s C:\*`, `-s /*`, `-s ~/*` and `-s $HOME/*` were all null here while
    // the bare forms denied, and the first three were null on the PROMPT scan
    // too, so nothing named them at all. A third `RemoveItemLadderCase` would
    // have been excluded the same way, silently — which is the accidental
    // safety P2.85 existed to remove, reappearing inside P2.85's own fix.
    //
    // `resolved != null` is the discriminator the rung test was standing in
    // for, and it keeps P2.72 exactly where it was. A glob IS a documented
    // `-Stream` value (`Accept wildcard characters: True`), so a target whose
    // base this scan cannot NAME — a bare `*`, `vendor/*`, `./build/*` — is a
    // plausible stream name and stays swallowed. A glob over a base that
    // resolves to a root, a drive root, a top-level directory or the home is
    // not a plausible stream name, and the bare spelling already denies it.
    // (`system-path` never carries a null `resolved`, so this is a strict
    // superset of the test it replaces: nothing that denied stops denying.)
    const classifies = (token: string) =>
      classifyRemoveItemLadderTarget(token, home)?.resolved != null
    for (const token of windowsTargetTokens(rest, name, classifies)) {
      const match = classifyRemoveItemLadderTarget(token, home)
      if (match) return { ...match, subcommand, argument: token }
    }
  }
  return null
}

/**
 * The first ladder deny inside a PowerShell HOST invocation, or null.
 *
 * Recurses through {@link powerShellHostScripts} with the same bound the breaker
 * uses ({@link MAX_POWERSHELL_HOST_DEPTH}), and — as there — an `unreadable`
 * script yields nothing, because this authority's message must name the target
 * and a target it cannot read has no name.
 */
function findPowerShellHostLadderDeny(
  command: string,
  home: string,
  depth: number,
): RemoveItemLadderDeny | null {
  if (depth >= MAX_POWERSHELL_HOST_DEPTH) return null
  for (const script of powerShellHostScripts(command)) {
    if (script.kind !== 'script') continue
    const deny = findRemoveItemLadderDeny(script.text, { home, platform: 'win32' })
    if (deny) return deny
    const nested = findPowerShellHostLadderDeny(script.text, home, depth + 1)
    if (nested) return nested
  }
  return null
}

/** What each resolved target is called in the message. */
const REMOVE_ITEM_LADDER_PHRASES: Record<RemoveItemLadderResolved, string> = {
  root: 'the filesystem root',
  'drive-root': 'a drive root',
  'top-level': 'a top-level system directory',
  home: 'the home directory',
}

/**
 * The refusal the model reads. It names the target, the rung, and the fact that
 * no mode and no approval can clear it — a deny the model mistakes for a
 * prompt gets retried in a different mode.
 */
export function describeRemoveItemLadderDeny(deny: RemoveItemLadderDeny): string {
  const what = deny.resolved
    ? REMOVE_ITEM_LADDER_PHRASES[deny.resolved]
    : 'every file the glob matches'
  if (deny.ladderCase === 'wildcard') {
    return `\`${deny.subcommand}\` removes ${what} by wildcard (\`${deny.argument}\`). `
      + 'A `Remove-Item` target that is a bare `*`, or ends in `/*` or `\\*`, is denied in every '
      + 'permission mode, without asking, and is never sent to the classifier.'
  }
  return `\`${deny.subcommand}\` removes ${what} (\`${deny.argument}\`). `
    + 'A `Remove-Item` target that is the filesystem root, a drive root, one of their top-level '
    + 'directories, or your home directory is denied in every permission mode, without asking.'
}
