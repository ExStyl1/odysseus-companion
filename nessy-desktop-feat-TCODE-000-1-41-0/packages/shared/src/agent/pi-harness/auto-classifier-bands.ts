/**
 * Two of the three check classes AUTO mode routes to the guardian classifier
 * (P2.3, owner decision 2026-08-22 in
 * `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`): background
 * jobs and suspicious Windows paths. The third — dangerous `rm` — already has
 * its own detector (`removal-circuit-breaker.ts`) because it is also a floor in
 * every other mode; these two never were, so they live here.
 *
 * Contract source, `code.claude.com/docs/en/whats-new/2026-w30.md:84` (the
 * corpus path — `scripts/claude-doc-pages.tsv` carries the slug
 * `whats-new/2026-w30`, never `release-notes/`; the line number that used to be
 * cited here moved when the snapshot went 186 → 191 pages on 2026-08-25, which
 * is why the slug is the identifier), whole sentence, fetched
 * 2026-08-23: "In auto mode, the checks for dangerous `rm` commands, background
 * jobs, and suspicious Windows paths no longer open permission dialogs; the
 * auto-mode classifier adjudicates them instead".
 *
 * ## What this module is FOR, which decides every rule below
 *
 * It does NOT decide permission. It answers one question — "should `auto` hand
 * this command to the classifier instead of auto-running it?" — and it is
 * consulted at exactly one place: the low-risk filter inside
 * `shouldPromptInAutoMode`, i.e. commands `auto` would otherwise have run with
 * no human and no judge. So a hit costs one judge call (or, with no working
 * judge, one prompt), and a miss costs the silent auto-run we have today.
 *
 * That asymmetry sets the posture: these detectors fail toward the CLASSIFIER.
 * Where the shell's own grammar is ambiguous they match, because the classifier
 * — or, failing it, a human — is a better reader than a regular expression. The
 * removal circuit breaker takes the opposite posture for the opposite reason:
 * it prompts unconditionally, so a false positive there teaches the user to
 * route around a floor.
 *
 * ## Deliberate limits
 *
 * - Only a command's TEXT and the Bash tool's own `run_in_background` parameter
 *   are read. No filesystem, no platform check: a Windows path spelled inside a
 *   command on macOS is either a mistake or an attempt, and both are worth a
 *   judge call.
 * - A quoted `&` never counts (`grep '&' file`), and neither does an operator
 *   that only looks like one: `&&`, `|&`, `&>`, `2>&1`, `>&2`, `\&`.
 * - "Suspicious Windows path" means a WINDOWS-SPELLED path into a system,
 *   startup, network or device location. A POSIX path is never matched — a repo
 *   directory called `src/windows/` is not a Windows system path, and matching
 *   it would put a cross-platform repo's ordinary edits in front of the judge.
 */

/** Which of the two classes matched. */
export type AutoClassifierBandKind = 'backgroundJob' | 'suspiciousWindowsPath'

export interface AutoClassifierBand {
  kind: AutoClassifierBandKind
  /** The operator, wrapper or path fragment that matched, as the user would read it. */
  evidence: string
  /** What the matched fragment IS, in words. Only the path class names one. */
  label?: string
}

/**
 * Commands whose whole purpose is to detach what follows them from this call,
 * matched at a segment's COMMAND HEAD only. `nohup` does not background on its
 * own (the shell's `&` does), but it is the documented "keep running after I am
 * gone" wrapper and belongs to the class by intent; `start` is cmd's.
 *
 * Head position is not decoration: `start` as a bare word appears in `npm
 * start`, and a class that fired there would put every dev-server run in front
 * of the judge.
 */
const BACKGROUND_WRAPPERS = new Set(['nohup', 'setsid', 'disown', 'bg', 'start'])

/**
 * Prefixes a background wrapper can hide behind. A token that is one of these,
 * an environment assignment or a flag is stepped over while looking for the
 * head; anything else IS the head and ends the search for that segment.
 */
const HEAD_PREFIXES = new Set(['sudo', 'doas', 'env', 'nice', 'time', 'command', 'builtin', 'exec'])
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * The PowerShell cmdlets that start detached work, matched as whole words
 * ANYWHERE — unlike the head-matched wrappers above. Neither this scanner nor
 * the removal circuit breaker's descends into another interpreter's quoted
 * argument (`powershell -Command "Start-Process …"` is the normal spelling), and
 * these two names are distinctive enough that matching them loose costs a judge
 * call on a sentence that happens to contain one, not a stream of false prompts.
 */
const BACKGROUND_CMDLETS = /\b(start-process|start-job)\b/i

/**
 * Windows-spelled paths worth a judge call. Every pattern requires a WINDOWS
 * spelling — a drive letter, a backslash separator, a `%VAR%` expansion or a
 * PowerShell `$env:` read — so no POSIX path can reach any of them.
 */
const SUSPICIOUS_WINDOWS_PATHS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  // `\\?\C:\…` and `\\.\PhysicalDrive0` — the device namespaces that bypass the
  // ordinary path parser (and, with it, most path-based checks).
  { pattern: /\\\\[?.]\\/, label: 'a Windows device path' },
  // `\\server\share\…` — a remote host, i.e. off-box.
  { pattern: /\\\\[A-Za-z0-9_.$-]+\\[A-Za-z0-9_.$-]/, label: 'a UNC network path' },
  { pattern: /%(?:systemroot|windir|systemdrive|programfiles(?:\(x86\))?|programdata)%/i, label: 'a Windows system directory' },
  { pattern: /\$(?:env:|\{env:)(?:systemroot|windir|systemdrive|programfiles|programdata)/i, label: 'a Windows system directory' },
  { pattern: /(?:[A-Za-z]:[\\/]|\\)windows(?:[\\/]|$|["'\s])/i, label: 'the Windows directory' },
  { pattern: /(?:[A-Za-z]:[\\/]|\\)(?:system32|syswow64)(?:[\\/]|$|["'\s])/i, label: 'a Windows system directory' },
  { pattern: /[\\/]?(?:system32|syswow64)\\/i, label: 'a Windows system directory' },
  { pattern: /(?:[A-Za-z]:[\\/]|\\)program files(?: \(x86\))?(?:[\\/]|$|["'\s])/i, label: 'the Program Files directory' },
  { pattern: /(?:[A-Za-z]:[\\/]|\\)programdata(?:[\\/]|$|["'\s])/i, label: 'the ProgramData directory' },
  { pattern: /start menu\\programs\\startup/i, label: 'the Windows Startup folder' },
]

/**
 * The first unquoted `&` that is a CONTROL operator, or null.
 *
 * Quoting is tracked the way the shell reads it; `$(…)` and backticks are NOT
 * descended into and NOT skipped, so `foo $(bar &)` matches — a job backgrounded
 * inside a substitution is still a background job.
 */
function backgroundOperator(command: string): string | null {
  let escaped = false
  let singleQuote = false
  let doubleQuote = false
  for (let index = 0; index < command.length; index += 1) {
    const current = command[index]!
    if (escaped) { escaped = false; continue }
    if (current === '\\' && !singleQuote) { escaped = true; continue }
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
    if (current !== '&') continue
    const previous = command[index - 1]
    const next = command[index + 1]
    // `&&` is the AND list operator, `&>` redirects, `2>&1` / `>&2` duplicate a
    // descriptor, `|&` pipes stderr. None of them detaches anything.
    if (next === '&') { index += 1; continue }
    if (next === '>' || previous === '>' || previous === '|') continue
    return '&'
  }
  return null
}

/** A token as the shell would name the program: basename, no quotes, no `.exe`. */
function programName(token: string): string {
  return token
    .replace(/^["']|["']$/g, '')
    .split(/[\\/]/)
    .pop()!
    .replace(/\.exe$/i, '')
    .toLowerCase()
}

/**
 * The first background WRAPPER standing at a segment's command head, or null.
 * Segments are split on the coarse separator set — this is a band decision, not
 * a permission decision, so it does not need `splitCompoundCommand`'s precision.
 */
function backgroundWrapper(command: string): string | null {
  for (const segment of command.split(/[;|&\n]+|\$\(|\)|`/)) {
    const tokens = segment.trim().split(/\s+/).filter(token => token.length > 0)
    for (const token of tokens) {
      const name = programName(token)
      if (BACKGROUND_WRAPPERS.has(name)) return name
      if (ENV_ASSIGNMENT.test(token) || token.startsWith('-') || HEAD_PREFIXES.has(name)) continue
      break // a real command that is not a wrapper — this segment is not one.
    }
  }
  return null
}

/**
 * Does this call start work that outlives it? Reads the command text AND the
 * Bash tool's own `run_in_background` parameter (permissions.md:102,
 * tools-reference.md:160), because the model can background a call without
 * writing a single shell operator.
 */
export function findBackgroundJob(
  command: string,
  input?: Record<string, unknown>,
): AutoClassifierBand | null {
  if (input?.run_in_background === true) {
    return { kind: 'backgroundJob', evidence: 'run_in_background: true' }
  }
  const operator = backgroundOperator(command)
  if (operator) return { kind: 'backgroundJob', evidence: operator }
  const wrapper = backgroundWrapper(command)
  if (wrapper) return { kind: 'backgroundJob', evidence: wrapper }
  const cmdlet = BACKGROUND_CMDLETS.exec(command)
  if (cmdlet) return { kind: 'backgroundJob', evidence: cmdlet[0].toLowerCase() }
  return null
}

/** Does this command name a Windows system, startup, network or device path? */
export function findSuspiciousWindowsPath(command: string): AutoClassifierBand | null {
  for (const { pattern, label } of SUSPICIOUS_WINDOWS_PATHS) {
    const match = pattern.exec(command)
    if (match) return { kind: 'suspiciousWindowsPath', evidence: match[0].trim(), label }
  }
  return null
}

/**
 * The first of the two classes this call belongs to, or null. Background jobs
 * are tested first: they are the cheaper decision and the more common one.
 */
export function findAutoClassifierBand(
  command: string,
  input?: Record<string, unknown>,
): AutoClassifierBand | null {
  return findBackgroundJob(command, input) ?? findSuspiciousWindowsPath(command)
}

/**
 * P2.111 — THE REMEDY, NAMED IN THE PROMPT THAT EXISTS BECAUSE NOTHING CLEARED
 * THE COMMAND.
 *
 * Residual of Dev-25 (owner 2026-08-24) and the cheap half of the parity it
 * accepts. On claude and codex these two classes PROMPT where Pi's guardian
 * clears them silently, and the user's remedy is already available — an allow
 * rule, the read-only allowlist and a session whitelist all return null ABOVE
 * the band check in `shouldPromptInAutoMode`, which is what keeps
 * `auto-mode-config.md`'s "allow, ask, and deny rules that apply before the
 * classifier runs" true. Nothing TOLD them so: Pi users got automatic
 * behaviour, claude users got a prompt with no hint that one allow rule ends it.
 *
 * The affordance is the one Dev-24 was valued for and the one the read-only-mode
 * refusal already carries ("Switch to Manual or Bypass permissions mode
 * (SHIFT+TAB) to run it", `mode-manager.ts`), and the wording follows that
 * family's other half, `dontAsk`'s "This call needs an explicit allow rule".
 *
 * ## Scope, and the line it must not cross
 *
 * ONLY these two moved classes. A `nonNegotiable` floor's prompt must NOT
 * advertise a remedy, because it HAS none by design — an allow rule, a
 * remembered click and a PreToolUse hook `allow` are all refused there
 * (`promptIsNonNegotiable`), so the same sentence on a floor would be an offer
 * the product then declines. Those prompts are built elsewhere and are left
 * alone; `auto-classifier-bands.test.ts` pins both directions.
 *
 * ## Why an English literal and not a locale key
 *
 * The row asked for i18n in both locales; measured, that premise does not hold
 * for this string. `PromptInfo.impact` travels the wire as a VALUE and is
 * rendered verbatim — `PermissionRequest.tsx` translates only the "Impact:"
 * label beside it — so the whole family (the sandbox-escape impact, the admin
 * approval reasons, `formatBashRejectionMessage`'s escape hints) is authored in
 * English inside `@nessy-agent/shared`. A locale key here would be the only
 * translated member of a sentence that is otherwise English, and the reader is
 * the same one that reads the class line above it.
 *
 * @param commandHead the command's base name (`PermissionManager.getBaseCommand`),
 *   so the hint names the rule the user would actually write. Omitted or blank
 *   yields the shape with a placeholder rather than no hint at all: the rule
 *   FORM is the part a user does not know.
 */
export function autoClassifierBandRemedy(commandHead?: string): string {
  const head = commandHead?.trim()
  return `An allow rule clears it without a prompt: Bash(${head && head.length > 0 ? head : '<command>'}:*).`
}

/**
 * The `impact` line the permission dialog shows. It names the class, so a
 * prompt that exists only because nothing cleared this command does not read
 * like every other prompt. Deliberately says nothing about WHY the classifier
 * did not answer: the same gate result is built on a runtime that has no
 * classifier wired at all.
 *
 * It DOES name the remedy — see {@link autoClassifierBandRemedy}, which is why
 * that is a separate function: the sentence has to be assertable on its own.
 */
export function describeAutoClassifierBand(band: AutoClassifierBand, commandHead?: string): string {
  const remedy = autoClassifierBandRemedy(commandHead)
  return band.kind === 'backgroundJob'
    ? `Starts work that outlives this call (${band.evidence}). Auto mode never runs a background job unreviewed. ${remedy}`
    : `Names ${band.label ?? 'a sensitive Windows location'} (${band.evidence}). Auto mode never touches a Windows system path unreviewed. ${remedy}`
}
