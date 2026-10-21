import { describe, expect, test } from 'bun:test'

import { splitCompoundCommand } from './claude-bash-rule.ts'
import {
  describeRemoveItemLadderDeny,
  describeRootOrHomeRemoval,
  findRemoveItemLadderDeny,
  findRootOrHomeRemoval,
  findTextualRemoval,
  type RemoveItemLadderResolved,
} from './removal-circuit-breaker.ts'

/**
 * The home this suite pretends the session runs under. Fixed rather than
 * `os.homedir()` so the negative sibling-prefix row below is deterministic.
 */
const HOME = '/Users/testuser'

function detect(command: string) {
  return findRootOrHomeRemoval(command, { home: HOME })
}

describe('findRootOrHomeRemoval — fires', () => {
  const cases: Array<[command: string, target: 'root' | 'home']> = [
    // The two documented forms (permissions.md:63, permission-modes.md:399).
    ['rm -rf /', 'root'],
    ['rm -rf ~', 'home'],
    // Wrapper evasion, all seen through by `stripSubcommand`'s enforcement pass.
    ['sudo rm -rf ~', 'home'],
    ['sudo -u root rm -rf /', 'root'],
    ['doas rm -rf ~', 'home'],
    ['env rm -rf /', 'root'],
    ['env -S "rm -rf ~"', 'home'],
    ['env --split-string=rm -rf /', 'root'],
    ['watch rm -rf ~', 'home'],
    ['nohup rm -rf /', 'root'],
    ['timeout 5 rm -rf ~', 'home'],
    ['/bin/rm -rf ~', 'home'],
    // A `-c` shell runs its operand as a command line, exactly as `env -S`
    // does. Measured OPEN 2026-08-24 (P3.12): every row here returned null
    // while the `sudo` and substitution rows above it fired, so wrapping the
    // removal in a shell walked through the floor. `-lc` is not an exotic
    // spelling — it is what codex puts in front of EVERY command it runs.
    [`/bin/zsh -lc 'rm -rf ~'`, 'home'],
    [`sh -c 'rm -rf /'`, 'root'],
    ['bash -c "rm -rf ~"', 'home'],
    [`sudo bash -lc 'rm -rf /'`, 'root'],
    [`zsh -c 'ls -la; rm -rf ~'`, 'home'],
    // ── D1.413 `[safety]`: the set was the AUTHOR's shells, not the PRODUCT's ──
    //
    // `fish` was the one common login shell `SHELL_INTERPRETERS` missed, and WHY
    // it missed it is the transferable half. That set's docblock said "every name
    // in the set was measured on this host rather than assumed" — which described
    // the method exactly, and is how the method's blind spot stayed invisible.
    // Measured 2026-09-20: its seven names are EXACTLY this host's `/etc/shells`
    // (`/bin/bash`, `/bin/csh`, `/bin/dash`, `/bin/ksh`, `/bin/sh`, `/bin/tcsh`,
    // `/bin/zsh`), and `fish` is not installed here. A shell a developer's Mac
    // does not ship can never be measured on it, and a USER's login shell is not
    // bounded by what a developer's Mac ships.
    //
    // It cost a live floor bypass. With a synthetic home at HEAD `4333cd155`,
    // `findRootOrHomeRemoval('fish -c "rm -rf ~"')` answered **null** while
    // `rm -rf ~`, `bash -c "rm -rf ~"`, `zsh -lc 'rm -rf ~'` and
    // `sh -c 'rm -rf ~'` all fired `home` in the same minute. Not an exotic
    // spelling either: codex wraps EVERY command as `<user shell> -lc '<script>'`,
    // so on a machine whose login shell is fish every codex command reached this
    // floor by the one spelling it could not read.
    //
    // `fish` is added on its DOCUMENTED `-c` semantics plus that transport, and
    // this says so rather than claiming a measurement it cannot make: the name
    // cannot be driven on this host, and pretending otherwise would repeat the
    // very failure. The direction is what makes that honest rather than sloppy —
    // a head wrongly called a shell only offers MORE text to a scan that still
    // demands `rm`/`rmdir`/`find` plus an exact root-or-home target, so a wrong
    // name can only ever ADD a refusal. The does-not-fire block below keeps that
    // cheap: `selfish`, `fishy`, `fisher` (fish's own plugin manager — a real
    // program and not a shell) and `gofish` are all pinned as NOT shells.
    //
    // F1.99 (2026-09-23) added the seven D1.413 named — `nu`, `elvish`, `xonsh`,
    // `ash`, `mksh`, `yash`, `oksh` — on the same DOCUMENTED `-c` semantics and
    // the same free direction, pinned in `removal-circuit-breaker-login-shells.test.ts`.
    // Still not DRIVEN: none is installed on this host, so the drive is an ASK.
    // This hotfix added the one name measured MISSING; the list followed later.
    [`fish -c 'rm -rf ~'`, 'home'],
    [`fish -lc 'rm -rf ~'`, 'home'],
    [`/opt/homebrew/bin/fish -lc 'rm -rf /'`, 'root'],
    [`sudo fish -lc 'rm -rf /'`, 'root'],
    // A compound-command KEYWORD HEAD hid the removal exactly as the `-c`
    // wrapper above did (P2.142, controller-confirmed live on HEAD 2026-08-24):
    // `if true; then rm -rf ~; fi` splits on its `;` into `if true`,
    // `then rm -rf ~` and `fi`, and the middle subcommand's head is `then`, not
    // `rm`. Every row below returned NULL on that rig while `true && rm -rf ~`
    // fired as the positive control and `echo hello` stayed quiet as the
    // negative — so ordinary shell control flow cleared a `nonNegotiable` floor
    // on every runtime. The full reserved-word set, each with a benign twin in
    // the does-not-fire block below:
    ['if true; then rm -rf ~; fi', 'home'],
    ['if rm -rf /; then :; fi', 'root'],
    ['if false; then :; else rm -rf ~; fi', 'home'],
    ['if false; then :; elif true; then rm -rf ~; fi', 'home'],
    ['for i in 1 2 3; do rm -rf ~; done', 'home'],
    ['for ((i=0;i<1;i++)); do rm -rf /; done', 'root'],
    ['while true; do rm -rf ~; done', 'home'],
    ['while rm -rf ~; do :; done', 'home'],
    ['until false; do rm -rf /; done', 'root'],
    ['select x in a b; do rm -rf ~; done', 'home'],
    ['case $x in (a) rm -rf ~ ;; esac', 'home'],
    ['{ rm -rf ~; }', 'home'],
    ['function wipe { rm -rf ~; }', 'home'],
    // FIVE spellings of ONE construct. Until 2026-08-25 only the first fired:
    // `tokenize` glues `(`…`)` onto its neighbour, so the head gate recognised
    // that spelling by accident and rejected the rest at token 0 — throwing
    // away the `{` boundary two tokens later. All five are `bash -n` clean and
    // all five RUN their body in bash and /bin/sh (executed against a sandbox
    // path with a `touch` payload, 2026-08-25).
    ['wipe() { rm -rf ~; }', 'home'],
    ['wipe(){ rm -rf ~; }', 'home'],
    ['wipe () { rm -rf ~; }', 'home'],
    ['wipe ( ) { rm -rf ~; }', 'home'],
    ['function wipe(){ rm -rf ~; }', 'home'],
    [`sh -c 'wipe () { rm -rf ~; }; wipe'`, 'home'],
    ['! rm -rf ~', 'home'],
    ['coproc rm -rf ~', 'home'],
    // Nested at depth, and combined with every wrapper the floor already saw
    // through — the keyword head hid `sudo` and the `-c` shell just as well.
    ['if true; then while true; do { rm -rf ~; }; done; fi', 'home'],
    ['for i in 1; do if true; then rm -rf /; fi; done', 'root'],
    ['if true; then sudo rm -rf ~; fi', 'home'],
    ['for i in 1; do doas rm -rf /; done', 'root'],
    ['if true; then env -S "rm -rf ~"; fi', 'home'],
    ['if true; then watch rm -rf ~; fi', 'home'],
    ['if true; then time rm -rf ~; fi', 'home'],
    [`if true; then /bin/zsh -lc 'rm -rf ~'; fi`, 'home'],
    [`/bin/zsh -lc 'if true; then rm -rf ~; fi'`, 'home'],
    // The other two removal heads reach through a keyword head too.
    ['if true; then rmdir ~; fi', 'home'],
    ['while true; do find / -delete; done', 'root'],
    // Substitution: the removal INSIDE it (the documented example) …
    ['echo "$(rm -rf ~)"', 'home'],
    // …including behind a keyword head, which is a CONTROL and not evidence for
    // the keyword reach: the span walk runs per subcommand and already reached
    // this before P2.142 existed. It sat in this block under a comment claiming
    // the keyword head had hidden it, which a 2026-08-25 review measured false.
    ['if true; then echo $(rm -rf ~); fi', 'home'],
    ['echo `rm -rf /`', 'root'],
    ['cat <(rm -rf ~)', 'home'],
    ['(rm -rf /)', 'root'],
    ['echo "$(echo "$(rm -rf ~)")"', 'home'],
    // … and "elsewhere in the same command".
    ['rm -rf ~ && echo "$(date)"', 'home'],
    ['ls -la; rm -rf /', 'root'],
    // Home spellings.
    ['rm -rf $HOME', 'home'],
    ['rm -rf ${HOME}', 'home'],
    ['rm -rf "$HOME"', 'home'],
    ["rm -rf '~'", 'home'],
    [`rm -rf ${HOME}`, 'home'],
    // Trailing-slash, dot and `..` variants of the same two directories.
    ['rm -rf ~/', 'home'],
    ['rm -rf $HOME/', 'home'],
    ['rm -rf //', 'root'],
    ['rm -rf /.', 'root'],
    ['rm -rf ~/.', 'home'],
    ['rm -rf ~/projects/..', 'home'],
    // "Every child of" globs: the same destruction, and the form that works.
    ['rm -rf /*', 'root'],
    ['rm -rf ~/*', 'home'],
    ['rm -rf ~/.*', 'home'],
    // Flags and the end-of-flags marker are not targets.
    ['rm -fr --no-preserve-root /', 'root'],
    ['rm -rf -- ~', 'home'],
    // rmdir is in scope; find/shred deliberately are not (see the module).
    ['rmdir ~', 'home'],
    ['rmdir /', 'root'],
    // ── P2.151 ────────────────────────────────────────────────────────────
    // Eleven spellings measured OPEN on 2026-08-25 (floor null, `deny
    // Bash(rm:*)` no-match) and each one confirmed to RUN its operand against a
    // sandbox path with a `touch` payload, with `sh -c 'true'` leaving no marker
    // as the detector's negative control. The old scan gave up on the first
    // token that was not a short cluster, so every LONG flag hid the script.
    [`bash --login -c 'rm -rf ~'`, 'home'],
    [`bash --norc -c 'rm -rf /'`, 'root'],
    [`bash --noprofile -c 'rm -rf ~'`, 'home'],
    [`bash --posix -c 'rm -rf ~'`, 'home'],
    [`zsh --no-rcs -c 'rm -rf ~'`, 'home'],
    [`bash --verbose -c 'rm -rf ~'`, 'home'],
    // A value-taking option: its value must be skipped rather than end the
    // scan. Kills a mutant that empties SHELL_VALUE_SHORT/LONG_OPTIONS.
    [`bash -o pipefail -c 'rm -rf ~'`, 'home'],
    [`bash -O extglob -c 'rm -rf /'`, 'root'],
    [`bash +o pipefail -c 'rm -rf ~'`, 'home'],
    [`bash --rcfile /dev/null -c 'rm -rf ~'`, 'home'],
    [`zsh --emulate sh -c 'rm -rf ~'`, 'home'],
    // `c` sets a flag; the script is the FIRST OPERAND after option parsing.
    // Both rows RUN, and a "next word after the cluster holding c" rule gets
    // both wrong — it would read `--` and `pipefail` as the script.
    [`sh -c -- 'rm -rf ~'`, 'home'],
    [`bash -oc pipefail 'rm -rf ~'`, 'home'],
    // The ABSOLUTE-PATH spellings of the two wrappers this floor's own comment
    // claimed to see through: the enforcement pass compared the RAW head while
    // every other head test in the subsystem resolves the basename.
    [`/usr/bin/env sh -c 'rm -rf ~'`, 'home'],
    [`/usr/bin/sudo sh -c 'rm -rf /'`, 'root'],
    [`/usr/bin/env -i sh -c 'rm -rf ~'`, 'home'],
    // …which also exposed these two, with no `-c` shell involved at all.
    ['/usr/bin/sudo rm -rf ~', 'home'],
    ['/usr/bin/nohup rm -rf /', 'root'],
    // An UNRESOLVABLE head is not proven to be a non-shell, and this spelling
    // is codex's own `shell_command` tool description, not a hypothetical.
    [`$SHELL -c 'rm -rf ~'`, 'home'],
    ['${SHELL} -c \'rm -rf /\'', 'root'],
    [`"$SHELL" -c 'rm -rf ~'`, 'home'],
    // Both ship with macOS and both were measured running their `-c` operand.
    [`csh -c 'rm -rf ~'`, 'home'],
    [`tcsh -c 'rm -rf /'`, 'root'],
    // Case-insensitive APFS is the default, and both of these RUN there.
    [`SH -c 'rm -rf ~'`, 'home'],
    [`Bash -c 'rm -rf /'`, 'root'],
    // win32 spells the same program with a suffix.
    [`bash.exe -c 'rm -rf ~'`, 'home'],
    // ANSI-C quoting: `literalText` treats the `$` as an ordinary character and
    // handed back `$rm -rf ~`, whose head matched nothing.
    [`sh -c $'rm -rf ~'`, 'home'],
    // Composition — the new reach stacks with every wrapper, keyword head and
    // substitution the floor already saw through.
    [`sh -c 'bash --login -c "rm -rf ~"'`, 'home'],
    [`env -S "sh --posix -c 'rm -rf ~'"`, 'home'],
    [`if true; then bash --login -c 'rm -rf ~'; fi`, 'home'],
    [`echo $(bash --norc -c 'rm -rf /')`, 'root'],
  ]

  test.each(cases)('%s', (command, target) => {
    expect(detect(command)?.target).toBe(target)
  })
})

/**
 * The rows that matter more. A breaker that cries wolf on ordinary cleanup gets
 * routed around or switched off, and then it protects nothing.
 */
describe('findRootOrHomeRemoval — does not fire', () => {
  const cases: string[] = [
    // Ordinary cleanup under home.
    'rm -rf ~/projects/scratch',
    'rm -rf $HOME/projects/scratch',
    'rm -rf "$HOME/Library/Caches"',
    'rm -rf ~/.cache',
    'rmdir ~/empty',
    // Ordinary cleanup elsewhere.
    'rm -rf ./build',
    'rm -rf build/',
    'rm file.txt',
    'rm -rf /tmp/session-123',
    'rm -rf /tmp/*',
    'rm -rf node_modules',
    // A narrower glob names specific children, not the directory.
    'rm -rf ~/*.log',
    'rm -rf ~/p*',
    // A quoted string is not a removal.
    'echo "rm -rf ~"',
    "echo 'rm -rf /'",
    'grep -r "rm -rf /" .',
    // The shell-script reach is bounded by the same target rules as everything
    // else — a `-c` shell cleaning a build directory is still ordinary cleanup.
    `bash -lc 'rm -rf ./build'`,
    `/bin/zsh -lc 'rm -rf ~/projects/scratch'`,
    // …and by what a `-c` operand actually IS. `sh cleanup.sh` names a FILE,
    // whose contents are not this command's text, so nothing is read out of it.
    'sh cleanup.sh',
    'bash -x deploy.sh',
    // A shell named as an operand rather than run is not a wrapper either.
    'which zsh',
    `echo "sh -c 'rm -rf ~'"`,
    // The keyword-head reach (P2.142) is bounded the same way: it offers the
    // body to the SAME scan, so a benign body stays benign and a narrow target
    // is still a narrow target. One negative twin per construct.
    'if true; then echo hi; fi',
    'if false; then :; else echo hi; fi',
    'for i in 1 2 3; do echo hi; done',
    'while true; do echo hi; done',
    'until false; do echo hi; done',
    'select x in a b; do echo hi; done',
    'case $x in (a) echo hi ;; esac',
    '{ echo hi; }',
    'function greet { echo hi; }',
    'greet() { echo hi; }',
    '! echo hi',
    'coproc echo hi',
    'if true; then rm -rf ~/logs; fi',
    'for i in 1; do rm -rf ./build; done',
    // A reserved word spelled as an ARGUMENT of an ordinary command is not a
    // keyword head, and the shell agrees — `echo then rm -rf ~` prints three
    // words and removes nothing. An earlier draft of the fix treated a reserved
    // word anywhere as a boundary and fired on exactly these; a floor that
    // cries wolf is a floor that gets routed around (module header, first rule).
    'echo then rm -rf ~',
    'echo do rm -rf /',
    `grep -n 'do rm -rf ~' notes.txt`,
    // The same rule read the other way: `in` takes a WORD LIST, not a command,
    // so these loops echo three words and remove nothing (executed 2026-08-25
    // against a sandbox path — the loop printed the words and created nothing).
    // Until then the floor fired `home` on them, and a `nonNegotiable` floor is
    // one the user cannot switch off, so there was no way past the false alarm.
    'for opt in rm -rf ~; do echo $opt; done',
    'for d in rm -rf /; do echo $d; done',
    'select s in rm -rf ~; do echo $s; done',
    'if true; then echo in rm -rf ~; fi',
    'for cmd in rm rmdir find; do which $cmd; done',
    // Quoted, the keyword is not a keyword — the shell does not treat it as one
    // either, which is why the boundary test reads the verbatim token.
    'echo "if true; then rm -rf ~; fi"',
    "echo 'for i in 1; do rm -rf ~; done'",
    // The rows that actually bite the verbatim-token choice: HERE the quoted
    // keyword is the head, so reading its unquoted literal text would have
    // opened a body the shell never opens.
    `'then' rm -rf ~`,
    '"do" rm -rf /',
    // The home path as a PREFIX of a longer directory name.
    'rm -rf /Users/testuserbackup',
    'rm -rf /Users/testuser2/tmp',
    'rm -rf /Users/testuser.old',
    // A different variable that merely starts with the same letters.
    'rm -rf $HOMEBREW_PREFIX',
    // `git rm` removes tracked files through git, and is not `rm`.
    'git rm -rf ~',
    // Not a removal at all.
    'echo ~',
    'ls -la ~',
    'cp -r ~ /backup',
    // A computed target is not a proven root-or-home target.
    'rm -rf "$(cat targets.txt)"',
    'rm -rf ${HOME:?}/../elsewhere',
    // ── P2.152: the head gate, the direction nothing covered ──────────────
    // A substring-match mutant of the shell head gate — one that makes these
    // fire — passed all 646 tests before these rows existed. Each name merely
    // CONTAINS a real shell name and is not one, so `-c` is an ordinary
    // argument and the floor must stay silent.
    `zshfoo -c 'rm -rf ~'`,
    `mybash -c 'rm -rf ~'`,
    `shell -c 'rm -rf ~'`,
    `bashful -c 'rm -rf ~'`,
    `/opt/zshfoo -c 'rm -rf ~'`,
    // D1.413's own half of that gate: adding `fish` must not make a name that
    // merely CONTAINS it into a shell. `selfish` and `fishy` are the mutants
    // the new name invites, and `fisher` is a real program (fish's own plugin
    // manager) that is NOT a shell.
    `selfish -c 'rm -rf ~'`,
    `fishy -c 'rm -rf ~'`,
    `fisher -c 'rm -rf ~'`,
    `/usr/local/bin/gofish -c 'rm -rf ~'`,
    // A RESOLVABLE head that is not a shell stays out too — only an
    // unresolvable one gets the benefit of the doubt. Kills a mutant that
    // makes `namesAShell` answer true for everything.
    `python3 -c 'rm -rf ~'`,
    `perl -c 'rm -rf ~'`,
    // `--` ends option parsing, so `-c` here is a FILENAME and this command
    // does NOT run its argument (measured: exit 127, no marker). Kills a
    // mutant that ignores `--` and reads the operand anyway.
    `sh -- -c 'rm -rf ~'`,
    // No `c` at all: `sh script.sh` names a file whose CONTENTS are not this
    // command's text. `-C` is bash's noclobber, not its command flag.
    'sh /tmp/some-script.sh',
    `bash -C 'rm -rf ~'`,
    // The wrapper spellings resolve on the ENFORCEMENT pass only, and an
    // unresolvable head must not be mistaken for a wrapper NAME.
    `$SUDO rm -rf ~`,
  ]

  test.each(cases)('%s', command => {
    expect(detect(command)).toBeNull()
  })
})

/**
 * D16. Nessy ships a native Windows build, and the shell it spawns there is
 * `cmd.exe /d /s /c` (`pi-agent-server/src/index.ts:3643`), not sh — so on
 * Windows the one floor `allow-all` and `auto` cannot skip has to recognise the
 * spellings that shell actually resolves. `find … -delete` removes its starting
 * point on every platform (probed against a temp tree, never a real path).
 */
describe('findRootOrHomeRemoval — the spellings other platforms use', () => {
  const windows = (command: string, home = 'C:\\Users\\testuser') =>
    findRootOrHomeRemoval(command, { home, platform: 'win32' })

  const fires: Array<[command: string, target: 'root' | 'home']> = [
    // PowerShell: the cmdlet and every shipped alias that resolves to it.
    ['Remove-Item -Recurse -Force $HOME', 'home'],
    ['Remove-Item -Recurse -Force $env:USERPROFILE', 'home'],
    ['Remove-Item -Recurse -Force "C:\\Users\\testuser"', 'home'],
    ['Remove-Item -Recurse -Force C:\\', 'root'],
    ['remove-item -recurse -force ~', 'home'],
    ['ri -Recurse -Force $HOME', 'home'],
    // cmd.exe builtins — the shell this build actually spawns on Windows.
    ['rd /s /q %USERPROFILE%', 'home'],
    ['rmdir /s /q %USERPROFILE%', 'home'],
    ['del /s /q C:\\Users\\testuser', 'home'],
    ['erase /s /q C:\\Users\\testuser', 'home'],
    // A compound command is split, exactly as the sh scan splits one.
    ['dir C:\\ ; Remove-Item -Recurse -Force $HOME', 'home'],
  ]

  test.each(fires)('%s', (command, target) => {
    expect(windows(command)?.target).toBe(target)
  })

  test('a PowerShell removal is recognised off Windows too, when the command is PowerShell', () => {
    expect(findRootOrHomeRemoval('Remove-Item -Recurse -Force $HOME', { home: HOME, platform: 'darwin' })?.target)
      .toBe('home')
  })

  test('find … -delete removes its starting point, so it fires on every platform', () => {
    expect(detect('find ~ -delete')?.target).toBe('home')
    expect(detect('find / -delete')?.target).toBe('root')
    expect(detect('find ~ -depth -delete')?.target).toBe('home')
    expect(detect('find ~ -exec rm -rf {} +')?.target).toBe('home')
  })
})

/**
 * The half that decides whether the wider matcher survives contact with users.
 * A floor that fires on ordinary cleanup gets muscle-memory-approved, and then
 * it protects nothing.
 */
describe('findRootOrHomeRemoval — the wider matcher stays quiet', () => {
  const windowsCases: string[] = [
    'Remove-Item -Recurse -Force C:\\Users\\testuser\\AppData\\Local\\Temp',
    'Remove-Item -Recurse -Force $HOME\\projects\\scratch',
    'Remove-Item -Recurse -Force $env:USERPROFILE\\.cache',
    'Remove-Item -Recurse -Force C:\\Users\\testuserbackup',
    'rd /s /q C:\\Users\\testuser\\build',
    'del /s /q %USERPROFILE%\\*.log',
    // A quoted mention is not a removal.
    'Write-Output "Remove-Item -Recurse -Force $HOME"',
    // Not a removal cmdlet at all.
    'Get-ChildItem $HOME',
    'Copy-Item $HOME C:\\backup -Recurse',
    // A path that merely CONTAINS a removal word.
    'Remove-Item -Recurse -Force C:\\Users\\testuser\\shred',
  ]

  test.each(windowsCases)('win32: %s', command => {
    expect(findRootOrHomeRemoval(command, { home: 'C:\\Users\\testuser', platform: 'win32' })).toBeNull()
  })

  const findCases: string[] = [
    // The form the module was right to exclude: ordinary cleanup, every run.
    "find ~ -name '*.pyc' -delete",
    'find ~ -type f -mtime +30 -delete',
    'find / -name core -delete',
    "find ~ -maxdepth 1 -name '*.tmp' -delete",
    // No removal action at all.
    'find ~ -name "*.ts"',
    'find /',
    "find ~ -name '*.log' -exec gzip {} +",
    // A path that merely contains the word.
    'rm -rf ~/projects/shred',
    'grep -r "find / -delete" .',
  ]

  test.each(findCases)('%s', command => {
    expect(detect(command)).toBeNull()
  })
})

describe('the hit it reports', () => {
  test('names the target argument and the wrapper-stripped command', () => {
    const hit = detect('sudo rm -rf --no-preserve-root /')
    expect(hit).toEqual({ target: 'root', subcommand: 'rm -rf --no-preserve-root /', argument: '/' })
  })

  test('the description says what is removed and why the mode did not skip it', () => {
    const hit = detect('rm -rf ~')
    expect(hit).not.toBeNull()
    const description = describeRootOrHomeRemoval(hit!)
    expect(description).toContain('your home directory')
    expect(description).toContain('rm -rf ~')
    expect(description).toContain('every permission mode')
    expect(description).toContain("don't ask again")
  })

  test('defaults to the real home when none is supplied', () => {
    expect(findRootOrHomeRemoval('rm -rf ~')?.target).toBe('home')
    expect(findRootOrHomeRemoval('rm -rf ~/projects/scratch')).toBeNull()
  })
})

// ============================================================
// The `Remove-Item` ladder (P2.34) — a DENY, not a prompt
// ============================================================

/**
 * `permission-modes.md`, fetched with `curl -s` on 2026-08-23, the section
 * `### Remove-Item in PowerShell`:
 *
 * `:599` — "When you enable the [PowerShell tool](/docs/en/tools-reference#powershell-tool),
 * Claude Code gives `Remove-Item` its own check, separate from the `rm`
 * critical-path list. The outcome depends on the target, and the first matching
 * case applies:"
 *
 * `:601` — "**System paths**: the filesystem root and its top-level
 * directories, drive roots and their top-level directories, and your home
 * directory. Claude Code denies the command in every mode, without asking you."
 *
 * `:602` — "**Wildcards**: a bare `*`, or any target ending in `/*` or `\*`,
 * including a glob under a shell variable such as `$dir/*`. Claude Code denies
 * the command in every mode, without asking you, before the classifier sees it."
 */
function ladder(command: string, platform: NodeJS.Platform = 'darwin') {
  return findRemoveItemLadderDeny(command, { home: HOME, platform })
}

describe('findRemoveItemLadderDeny — `:601` system paths', () => {
  const cases: Array<[command: string, resolved: RemoveItemLadderResolved, platform: NodeJS.Platform]> = [
    ['Remove-Item -Recurse -Force /', 'root', 'darwin'],
    ['Remove-Item -Recurse -Force /usr', 'top-level', 'darwin'],
    ['Remove-Item -Recurse -Force /usr/', 'top-level', 'darwin'],
    // The gap that had no row at all before P2.34: home itself PROMPTED.
    ['Remove-Item -Recurse -Force $HOME', 'home', 'darwin'],
    ['Remove-Item -Recurse -Force ~', 'home', 'darwin'],
    ['Remove-Item -Recurse -Force "/Users/testuser"', 'home', 'darwin'],
    ['Remove-Item -Recurse -Force ~/projects/..', 'home', 'darwin'],
    ['Remove-Item -Recurse -Force C:\\', 'drive-root', 'win32'],
    ['Remove-Item -Recurse -Force C:\\Windows', 'top-level', 'win32'],
    ['del %USERPROFILE%', 'home', 'win32'],
    ['rd /s /q C:\\Windows', 'top-level', 'win32'],
  ]

  test.each(cases)('%s', (command, resolved, platform) => {
    const deny = ladder(command, platform)
    expect(deny?.ladderCase).toBe('system-path')
    expect(deny?.resolved).toBe(resolved)
    expect(deny?.argument).not.toBe('')
  })
})

describe('findRemoveItemLadderDeny — `:602` wildcards', () => {
  const cases: Array<[command: string, resolved: RemoveItemLadderResolved | null, platform: NodeJS.Platform]> = [
    // The bare `*` the bullet opens with — invisible to the root/home matcher.
    ['Remove-Item -Recurse -Force *', null, 'darwin'],
    // "a glob under a shell variable such as `$dir/*`" — the variable does not
    // have to resolve, and it does not have to point at the home directory.
    ['Remove-Item -Recurse -Force $dir/*', null, 'darwin'],
    ['Remove-Item -Recurse -Force $HOME/projects/scratch/*', null, 'darwin'],
    ['Remove-Item -Recurse -Force %TEMP%\\*', null, 'darwin'],
    ['Remove-Item -Recurse -Force /var/log/*', null, 'darwin'],
    // A RELATIVE base no longer buys anything. Until P2.49 a glob under a
    // relative base that NAMED a subdirectory was carved out of `:602`, so
    // `./build/*` was allowed while `/Users/testuser/project/build/*` — the
    // same cleanup of the same directory — was denied. The owner settled OQ-4
    // on 2026-08-23 for the page's literal "any target ending in `/*` or
    // `\*`", and the two halves of that pair answer the same way now. The
    // `del` row is the same rule reached through a win32 alias and the `\*`
    // spelling the bullet names alongside `/*`.
    ['Remove-Item -Recurse -Force /Users/testuser/project/build/*', null, 'darwin'],
    ['Remove-Item -Recurse -Force ./build/*', null, 'darwin'],
    ['Remove-Item -Recurse -Force build/*', null, 'darwin'],
    ['Remove-Item -Recurse -Force src/generated/*', null, 'darwin'],
    ['del /s /q build\\*', null, 'win32'],
    // A DOUBLED separator was a live hole inside the carve-out, and it is moot
    // by construction now rather than fixed: `.//` was neither dot-only (the
    // old `DOT_ONLY_BASE` rejected the trailing separator) nor absolute nor
    // variable-rooted, so it fell out of the carve-out's own `return null`.
    // With no carve-out there is no base shape left to fall through.
    ['Remove-Item -Recurse -Force .//*', null, 'darwin'],
    ['Remove-Item -Recurse -Force ..//*', null, 'darwin'],
    ['Remove-Item -Recurse -Force ./build//*', null, 'darwin'],
    // The P2.29 rows, which must keep denying through the moved predicate.
    ['Remove-Item -Recurse -Force $HOME/*', 'home', 'darwin'],
    ['Remove-Item -Recurse -Force ~/*', 'home', 'darwin'],
    ['Remove-Item -Recurse -Force "$HOME/*"', 'home', 'darwin'],
    ['Remove-Item -Recurse -Force ${env:USERPROFILE}/*', 'home', 'darwin'],
    ['Remove-Item -Recurse -Force /*', 'root', 'darwin'],
    ['Remove-Item -Recurse -Force C:\\*', 'drive-root', 'win32'],
    ['del /s /q %USERPROFILE%\\*', 'home', 'win32'],
    // A DOT-ONLY base is the bare `*` in a different spelling, and it used to
    // be the one-character step around a deny no mode can clear (round-2
    // review of P2.34, reproduced on the shipped matcher: `*` denied while
    // `./*` and `.\*` returned NO MATCH and therefore ALLOWED in
    // `bypassPermissions`). PowerShell resolves `.` and `..` against the
    // current location and takes either separator, so all four spellings run
    // the same removal. These rows outlived the predicate that first closed
    // them: P2.49 deleted `DOT_ONLY_BASE` with the carve-out it was a patch
    // on, and they deny through the unconditional wildcard branch instead.
    ['Remove-Item -Recurse -Force ./*', null, 'darwin'],
    ['Remove-Item -Recurse -Force .\\*', null, 'darwin'],
    ['Remove-Item -Recurse -Force ../*', null, 'darwin'],
    ['Remove-Item -Recurse -Force ..\\*', null, 'darwin'],
    ['Remove-Item -Recurse -Force "./*"', null, 'darwin'],
    ['Remove-Item -Recurse -Force ../../*', null, 'darwin'],
    // The win32 aliases the ladder DOES claim — the reachable spellings on the
    // platform where this scan runs for every command.
    ['del .\\*', null, 'win32'],
    ['rd /s /q .\\*', null, 'win32'],
  ]

  test.each(cases)('%s', (command, resolved, platform) => {
    const deny = ladder(command, platform)
    expect(deny?.ladderCase).toBe('wildcard')
    expect(deny?.resolved ?? null).toBe(resolved)
  })
})

describe('findRemoveItemLadderDeny — does not fire', () => {
  const cases: Array<[command: string, platform: NodeJS.Platform]> = [
    // THE `rm` BOUNDARY (`:599`, "separate from the `rm` critical-path list").
    // Both rows are the recorded gap (c): on Windows PowerShell these ARE
    // `Remove-Item`, and we deliberately leave them on the `:574-580` table
    // rather than deny commands that table says to prompt for.
    ['rm -rf $HOME/*', 'win32'],
    ['rmdir /s /q %USERPROFILE%', 'win32'],
    ['rm -rf /*', 'darwin'],
    ['find ~ -delete', 'darwin'],
    // WHAT IS LEFT ON THIS LIST after P2.49, and it is the whole boundary:
    // `:602` is a rule about a GLOB, so a target with no trailing `/*` is not
    // on it however the path is spelled. `./build/*` and `build/*` sat here
    // until 2026-08-23 as the recorded carve-out; they are deny rows above now
    // that OQ-4 chose the page's literal width, and `./build` is the row that
    // keeps the boundary visible from this side.
    //
    // The ladder's THIRD case (`:603`) is an ordinary approval, not a deny, and
    // `..` is the sharpest row of it: a parent-of-cwd removal is case THREE,
    // and no dot handling survives in the matcher that could swallow it —
    // `DOT_ONLY_BASE` lived inside the `/*` branch and went with the carve-out.
    ['Remove-Item -Recurse -Force ..', 'darwin'],
    ['Remove-Item -Recurse -Force .', 'darwin'],
    ['Remove-Item -Recurse -Force ./build', 'darwin'],
    ['Remove-Item -Recurse -Force $HOME/projects/scratch', 'darwin'],
    ['Remove-Item -Recurse -Force $HOME/*.log', 'darwin'],
    ['Remove-Item -Recurse -Force /usr/local', 'darwin'],
    // Not a removal cmdlet, and a quoted mention of one.
    ['Get-ChildItem $HOME', 'darwin'],
    ['Write-Output "Remove-Item -Recurse -Force $HOME"', 'darwin'],
    // Off Windows the alias-only heads do not look like PowerShell, so the
    // scan never runs — the same platform gate `findRootOrHomeRemoval` uses.
    ['del %USERPROFILE%', 'darwin'],
  ]

  test.each(cases)('%s', (command, platform) => {
    expect(ladder(command, platform)).toBeNull()
  })
})

describe('the ladder deny it reports', () => {
  test('names the case, the target argument and the subcommand', () => {
    expect(ladder('Remove-Item -Recurse -Force $HOME')).toEqual({
      ladderCase: 'system-path',
      resolved: 'home',
      subcommand: 'Remove-Item -Recurse -Force $HOME',
      argument: '$HOME',
    })
  })

  test('the description says which rung denied and that no mode asks', () => {
    const systemPath = describeRemoveItemLadderDeny(ladder('Remove-Item -Recurse -Force /usr')!)
    expect(systemPath).toContain('a top-level system directory')
    expect(systemPath).toContain('denied in every permission mode')

    const wildcard = describeRemoveItemLadderDeny(ladder('Remove-Item -Recurse -Force $HOME/*')!)
    expect(wildcard).toContain('home directory')
    expect(wildcard).toContain('denied in every permission mode')
    expect(wildcard).toContain('never sent to the classifier')
  })

  test('defaults to the real home when none is supplied', () => {
    expect(findRemoveItemLadderDeny('Remove-Item -Recurse -Force ~')?.resolved).toBe('home')
    expect(findRemoveItemLadderDeny('Remove-Item -Recurse -Force ~/projects/scratch')).toBeNull()
  })
})

// ============================================================
// Only the TARGET is classified (P2.51)
// ============================================================

/**
 * `permission-modes.md`, re-fetched with `curl -s` on 2026-08-23, frames the
 * whole ladder on the TARGET — `:599` "The outcome depends on the target, and
 * the first matching case applies:" and `:602` "**Wildcards**: a bare `*`, or
 * any target ending in `/*` or `\*`, including a glob under a shell variable
 * such as `$dir/*`." The sentences are the anchors; the line numbers are
 * convenience only.
 *
 * Both Windows scans classified every token that was not a `-Param` or a `/x`
 * cmd switch, so a glob-shaped parameter VALUE was read as a target. MEASURED
 * ON HEAD BEFORE THE CHANGE (2026-08-23, `home: '/Users/testuser'`), each row
 * below carrying the verdict it used to produce:
 *
 * | command | ladder | breaker |
 * | --- | --- | --- |
 * | `Remove-Item -Path ./logs -Recurse -Exclude vendor/*` | wildcard deny on `vendor/*` | — |
 * | `Remove-Item -Path ./logs -Include bin/*` | wildcard deny on `bin/*` | — |
 * | `Remove-Item -Path ./logs -Filter obj/*` | wildcard deny on `obj/*` | — |
 * | `Remove-Item ./one.txt  # also clears src/*` | wildcard deny on `src/*` | — |
 * | `Remove-Item -Exclude ~ -Path ./logs` | system-path deny on `~` | prompt: home |
 * | `Remove-Item ./one.txt  # also clears ~` | system-path deny on `~` | prompt: home |
 *
 * The first four are denies no mode can clear, raised on the NEGATION of the
 * target (`-Exclude` names what is spared) or on a note the user wrote to
 * themselves. The last two are the same defect on the PROMPT path, which is why
 * `findWindowsRemoval` shares the filter rather than keeping its own loop.
 */
describe('the removal ladder classifies only targets (P2.51)', () => {
  const spared: Array<[command: string, platform: NodeJS.Platform]> = [
    // The four probes, RED against the pre-change matcher (table above).
    ['Remove-Item -Path ./logs -Recurse -Exclude vendor/*', 'darwin'],
    ['Remove-Item -Path ./logs -Include bin/*', 'darwin'],
    ['Remove-Item -Path ./logs -Filter obj/*', 'darwin'],
    ['Remove-Item ./one.txt  # also clears src/*', 'darwin'],
    // PowerShell accepts any unambiguous prefix, and the parameter name is
    // case-insensitive like every other PowerShell name in this file.
    ['Remove-Item -Path ./logs -Exc vendor/*', 'darwin'],
    ['Remove-Item -Path ./logs -Ex vendor/*', 'darwin'],
    ['Remove-Item -Path ./logs -exclude vendor/*', 'darwin'],
    ['Remove-Item -Path ./logs -EXCLUDE vendor/*', 'darwin'],
    ['Remove-Item -Path ./logs -Inc bin/*', 'darwin'],
    ['Remove-Item -Path ./logs -Fi obj/*', 'darwin'],
    // `-Stream` is the fourth (P2.72). Its minimum prefix is ONE character —
    // nothing else in `Remove-Item`'s binding namespace begins with `s` — so
    // every abbreviation of it is unambiguous and every one of these was a
    // wildcard deny on `*` before the change.
    ['Remove-Item C:\\Users\\testuser\\a\\notes.txt -stream *', 'win32'],
    ['Remove-Item C:\\Users\\testuser\\a\\notes.txt -STREAM *', 'win32'],
    ['Remove-Item C:\\Users\\testuser\\a\\notes.txt -Str *', 'win32'],
    ['Remove-Item C:\\Users\\testuser\\a\\notes.txt -St *', 'win32'],
    ['Remove-Item C:\\Users\\testuser\\a\\notes.txt -S *', 'win32'],
    // The win32 aliases reach the same filter — the PowerShell-only spellings
    // do. `del`/`erase`/`rd`/`rmdir` are cmd builtins and do NOT, since P2.74;
    // their rows are in the block at the bottom of this file.
    ['ri -Exclude C:\\ -Path ./logs', 'win32'],
    ['rm -Exclude C:\\ -Path ./logs', 'win32'],
    // A comment can also be the whole subcommand.
    ['Remove-Item ./one.txt', 'darwin'],
    ['# Remove-Item -Recurse -Force /usr', 'win32'],
  ]

  test.each(spared)('no deny: %s', (command, platform) => {
    expect(ladder(command, platform)).toBeNull()
  })

  const stillDenies: Array<[command: string, argument: string, platform: NodeJS.Platform]> = [
    // THE NEGATIVES THAT MUST NOT MOVE. A real glob TARGET still denies …
    ['Remove-Item ./src/*', './src/*', 'darwin'],
    ['Remove-Item -Recurse -Force $HOME/*', '$HOME/*', 'darwin'],
    // … a `-Path`/`-LiteralPath` value is still classified …
    ['Remove-Item -Path /usr', '/usr', 'darwin'],
    ['Remove-Item -LiteralPath /usr -Recurse', '/usr', 'darwin'],
    ['Remove-Item -Path ./build/*', './build/*', 'darwin'],
    // … and a non-target parameter blinds ONE token, not the command: the real
    // target is still found, whichever side of the exclusion it sits on.
    ['Remove-Item -Exclude vendor/* -Path /usr', '/usr', 'darwin'],
    ['Remove-Item -Path /usr -Exclude vendor/*', '/usr', 'darwin'],
    // A comment tail does not blind the command in front of it.
    ['Remove-Item /usr  # tidy up', '/usr', 'darwin'],
    // The COLON form carries its value on the parameter token, which was always
    // skipped whole — so it must NOT consume the next token as well.
    ['Remove-Item -Exclude:vendor/* /usr', '/usr', 'darwin'],
    // A `#` opens a comment only where a token BEGINS: mid-token and inside
    // quotes it is an ordinary character, which is the tokenizer's own quoting
    // doing the work, not new quoting support.
    ['Remove-Item ./a#b/*', './a#b/*', 'darwin'],
    ["Remove-Item -Path './a#b/*'", "'./a#b/*'", 'darwin'],
    // AMBIGUOUS prefixes stay in the scan on purpose — PowerShell itself would
    // refuse `-E`/`-In`/`-F` here (`-ErrorAction`, `-InformationAction`,
    // `-Force`), and for an every-mode deny an extra classified token is the
    // cheaper error. Pinned so a widening of the deny-list is loud.
    ['Remove-Item -Path ./logs -E vendor/*', 'vendor/*', 'darwin'],
    ['Remove-Item -Path ./logs -In bin/*', 'bin/*', 'darwin'],
    ['Remove-Item -Path ./logs -F obj/*', 'obj/*', 'darwin'],
    // Only ONE token is skipped: PowerShell joins a multi-value list with
    // commas, so a second space-separated glob is positional, not excluded.
    ['Remove-Item -Exclude vendor/* build/*', 'build/*', 'darwin'],
    // …and `-Stream` (P2.72) obeys every one of those rules. A real target on
    // either side of it still denies, the colon form still consumes only its
    // own token, and only ONE token is skipped.
    ['Remove-Item C:\\ -Stream *', 'C:\\', 'win32'],
    ['Remove-Item -Stream * -Path /usr', '/usr', 'darwin'],
    ['Remove-Item -Path /usr -Stream *', '/usr', 'darwin'],
    ['Remove-Item -Stream:* /usr', '/usr', 'darwin'],
    ['Remove-Item -Stream a/* b/*', 'b/*', 'darwin'],
  ]

  test.each(stillDenies)('still denies: %s', (command, argument, platform) => {
    expect(ladder(command, platform)?.argument).toBe(argument)
  })

  /**
   * P2.72, and it used to be a recorded LIMIT here: this row asserted the
   * wildcard deny it now asserts the absence of. `-Stream` names an alternate
   * data stream OF the target, so the command removes every ADS of ONE file
   * and the `*` is a stream name, never a path.
   *
   * `Remove-Item.md` from `MicrosoftDocs/PowerShell-Docs@main`, fetched with
   * `curl -s` on 2026-08-23 (7.5), § `-Stream`: "This is a dynamic parameter
   * made available by the **FileSystem** provider." — declared
   * `Type: System.String[]` with `Accept wildcard characters: True`, i.e. a
   * documented glob that is not a target. RED against the parent commit
   * (`6676ce5c7`), which returned `wildcard`/`resolved: null` on `*`.
   *
   * The enumeration behind "fourth AND LAST" is on
   * `windowsTargetTokens` — the same fetch for 5.1, 7.4 and 7.5 — and it turned
   * up a parameter P2.51's review had not named, `-DeleteKey`. It is a
   * `SwitchParameter`, so it carries no value and cannot be mistaken for a
   * target; the six glob-shaped parameters are unchanged by it.
   */
  test('`-Stream *` names a stream, not a target (P2.72)', () => {
    expect(ladder('Remove-Item C:\\Users\\testuser\\a\\notes.txt -Stream *', 'win32')).toBeNull()
    // The positive control on the same rig: drop `-Stream` and the same `*` is
    // the bare wildcard `:602` denies outright.
    expect(ladder('Remove-Item C:\\Users\\testuser\\a\\notes.txt *', 'win32')?.argument).toBe('*')
  })

  /**
   * The PROMPT path, which shares the target-token filter with the deny
   * path. A shared helper that quietly changes its second caller is the failure
   * mode here, so both directions are pinned: the two spared rows were measured
   * as home PROMPTS on HEAD, and the fires rows are the positive control that
   * the scan still runs on the same rig.
   */
  describe('the breaker prompt path inherits the same narrowing', () => {
    const quiet: string[] = [
      'Remove-Item -Exclude ~ -Path ./logs',
      'Remove-Item -Include ~ -Path ./logs',
      'Remove-Item ./one.txt  # also clears ~',
      // MEASURED as a home prompt on `6676ce5c7` — the shared helper carries
      // `-Stream` to the prompt path exactly as it carried the other three.
      'Remove-Item -Stream ~ -Path ./logs',
    ]

    test.each(quiet)('no prompt: %s', command => {
      expect(findRootOrHomeRemoval(command, { home: HOME, platform: 'darwin' })).toBeNull()
    })

    const fires: Array<[command: string, target: 'root' | 'home']> = [
      ['Remove-Item -Recurse -Force ~', 'home'],
      ['Remove-Item -Exclude vendor/* -Path ~', 'home'],
      ['Remove-Item -Stream vendor/* -Path ~', 'home'],
      ['Remove-Item ~  # tidy up', 'home'],
    ]

    test.each(fires)('still prompts: %s', (command, target) => {
      expect(findRootOrHomeRemoval(command, { home: HOME, platform: 'darwin' })?.target).toBe(target)
    })
  })
})

/**
 * P2.85 — the escape hatch that was inert BY ACCIDENT.
 *
 * `-Stream` is not declared by `Remove-Item`; the FileSystem provider adds it at
 * run time ("This is a dynamic parameter made available by the **FileSystem**
 * provider", `Remove-Item.md` § `-Stream`), and a dynamic parameter is
 * "available only when the cmdlet is used with the provider that added them"
 * (`about_Providers.md` § Finding dynamic parameters) — both from
 * `MicrosoftDocs/PowerShell-Docs@main`, `curl -s` 2026-08-27. So under any other
 * provider `-s` does NOT name `-Stream`, and the one-character minimum that
 * makes `-s` swallow the next token is a fact about FileSystem, not about the
 * cmdlet. If the provider contributes an `s`-named SWITCH, the swallowed token
 * is the positional `-Path` value — the target.
 *
 * MEASURED 2026-08-27 on `feat/TCODE-000`, `home: 'C:/Users/testuser'`,
 * platform win32: the path was CLOSED, and closed only because every shipped
 * non-FileSystem PSDrive is spelled with more than one letter while all four
 * drive regexes in the module take exactly one. Widen them to `[A-Za-z]+` and
 * `Remove-Item HKLM:\` went null → root prompt + drive-root deny while
 * `Remove-Item -s HKLM:\` stayed NULL ON BOTH SCANS. Nothing recorded that
 * dependency, so the widening — an otherwise-harmless improvement — silently
 * re-opened it.
 *
 * The fix is in `windowsTargetTokens`, not in a comment: an ABBREVIATED
 * spelling of a `providerDynamic` row may not be the parameter we think it is,
 * so it is not allowed to swallow a value the scan classifies. Re-running the
 * same widening with that guard in place, `Remove-Item -s HKLM:\` now fires on
 * both scans, so the regexes are free.
 */
describe('an abbreviated provider-dynamic parameter never blinds the scan (P2.85)', () => {
  /**
   * The POSITIVE direction, RED on the parent commit: every one of these
   * returned null on both scans, because `-s`/`-St`/`-Str` ate the target.
   */
  const rescued: Array<[command: string, target: 'root' | 'home']> = [
    ['Remove-Item -s ~', 'home'],
    ['Remove-Item -s /', 'root'],
    ['Remove-Item -s C:\\', 'root'],
    // Every abbreviation, not just the one-character one.
    ['Remove-Item -St ~', 'home'],
    ['Remove-Item -Str / -Recurse', 'root'],
    // …and with a real `-Path` behind it, which is the shape the traced exploit
    // takes: the provider's own `s`-switch, then the positional target.
    ['Remove-Item -s ~ -Recurse -Force', 'home'],
  ]

  test.each(rescued)('prompts: %s', (command, target) => {
    expect(findRootOrHomeRemoval(command, { home: HOME, platform: 'win32' })?.target).toBe(target)
  })

  test.each(rescued)('denies: %s', command => {
    expect(ladder(command, 'win32')?.ladderCase).toBe('system-path')
  })

  /**
   * The NEGATIVES that pay for it — each one a boundary of the guard, and each
   * one a decision that would otherwise have been silently widened.
   */
  const stillQuiet: Array<[command: string, why: string]> = [
    // The FULL name is unambiguous in every binding namespace, and where
    // `-Stream` is absent the command is a binding error rather than a removal.
    // This is P2.72's measured row and it must not move.
    ['Remove-Item -Stream ~ -Path ./logs', 'full spelling still blinds'],
    ['Remove-Item -stream ~ -Path ./logs', 'full spelling, any case'],
    // A value the scan does not classify is skipped exactly as before — this is
    // what keeps `-Stream *`, the documented glob, out of the wildcard deny.
    ['Remove-Item -s vendor/* -Path ./logs', 'value does not classify'],
    // `-Exclude`/`-Include`/`-Filter` are DECLARED by the cmdlet, so they are in
    // the namespace under every provider and their measured minima stand. The
    // guard deliberately does not reach them: `-Ex ~` is legal, SPARES the home,
    // and rescuing it would deny a benign command in every mode.
    ['Remove-Item -Ex ~ -Path ./logs', 'not provider-dynamic'],
    ['Remove-Item -Inc ~ -Path ./logs', 'not provider-dynamic'],
    ['Remove-Item -Fi ~ -Path ./logs', 'not provider-dynamic'],
  ]

  test.each(stillQuiet)('no prompt: %s (%s)', command => {
    expect(findRootOrHomeRemoval(command, { home: HOME, platform: 'win32' })).toBeNull()
  })

  test.each(stillQuiet)('no deny: %s (%s)', command => {
    expect(ladder(command, 'win32')).toBeNull()
  })

  /**
   * A cmd builtin binds no parameters, so `-s` in front of one is a FILENAME
   * and the guard has nothing to do (P2.74). Pinned because the fix touches the
   * shared filter and this is the branch it must NOT have changed.
   */
  test('cmd heads are untouched — `-s` was never a parameter there', () => {
    expect(findRootOrHomeRemoval('del -s C:\\ /q', { home: HOME, platform: 'win32' })?.argument)
      .toBe('C:\\')
    expect(ladder('del -s C:\\ /q', 'win32')?.argument).toBe('C:\\')
  })

  /**
   * THE INVARIANT, stated as a property rather than a list: whatever this scan
   * classifies bare, it must still classify behind an abbreviated
   * provider-dynamic parameter. This is the assertion that survives a future
   * widening of the drive regexes — a widening adds rows to what "classifies"
   * means, and this test re-derives its own expectation from the bare form
   * rather than hard-coding it.
   */
  test.each(['/', '~', 'C:\\', '$HOME', '${HOME}', '/usr/..', `${HOME}/`])(
    'an abbreviated `-s` cannot silence a target the bare scan classifies: %s',
    token => {
      const bare = findRootOrHomeRemoval(`Remove-Item ${token}`, { home: HOME, platform: 'win32' })
      // The positive control: this token really is classified on this rig.
      expect(bare?.target).toBeDefined()
      const behindAbbreviation = findRootOrHomeRemoval(`Remove-Item -s ${token}`, {
        home: HOME,
        platform: 'win32',
      })
      expect(behindAbbreviation?.target).toBe(bare!.target)
    },
  )
})

/**
 * P2.287 — the same accidental safety P2.85 removed, reappearing inside P2.85's
 * own fix.
 *
 * `findRemoveItemLadderDeny` built its P2.85 predicate as
 * `?.ladderCase === 'system-path'` while its loop body accepts ANY non-null
 * match, so the guard covered ONE of the ladder's two rungs and an abbreviated
 * `-s` went on swallowing targets on the other. MEASURED on `f58f66a36`
 * (2026-08-28, `home: '/Users/testuser'`, win32) the row's five spellings were
 * SEVEN — `~/*` and `$HOME/*` were not on the list and were blinded too — and
 * for `/usr/*`, `C:\Windows\*` and `R:\SOFTWARE\*` neither scan said anything
 * at all, since those resolve to a top-level directory rather than root or home.
 *
 * The fix is `?.resolved != null`: `system-path` never carries a null
 * `resolved`, so it is a strict superset — nothing that denied stops denying —
 * and it is the discriminator the rung test was standing in for. It also makes
 * a THIRD `RemoveItemLadderCase` inherit the guard instead of being excluded by
 * a hard-coded equality nobody would think to update.
 */
describe('the ladder guard covers every rung its loop accepts (P2.287)', () => {
  /**
   * RED on `f58f66a36`: each of these was `null` behind `-s` while the bare
   * form denied. The expectation is re-derived from the bare form rather than
   * hard-coded, so a future rung or a widened drive regex is covered without a
   * new row — which is the property the `system-path` equality could not hold.
   */
  test.each([
    '/usr/*',
    'C:\\Windows\\*',
    'R:\\SOFTWARE\\*',
    'C:\\*',
    '/*',
    '~/*',
    '$HOME/*',
  ])('an abbreviated `-s` cannot silence a ladder target the bare scan denies: %s', token => {
    const bare = ladder(`Remove-Item ${token}`, 'win32')
    // The positive control on this rig: the bare form really does deny.
    expect(bare).not.toBeNull()
    const behindAbbreviation = ladder(`Remove-Item -s ${token}`, 'win32')
    expect(behindAbbreviation?.ladderCase).toBe(bare!.ladderCase)
    expect(behindAbbreviation?.resolved).toBe(bare!.resolved)
    expect(behindAbbreviation?.argument).toBe(token)
  })

  /**
   * The boundary that pays for it, and the reason the fix is `resolved != null`
   * rather than "drop the guard". `-Stream` takes a glob (`Accept wildcard
   * characters: True`), so a target whose base this scan cannot NAME is a
   * plausible stream name and must stay swallowed — this is P2.72's decision and
   * it must not move. Each row's bare form is a wildcard deny with
   * `resolved: null`, which is the whole distinction.
   */
  test.each(['*', 'vendor/*', './build/*'])(
    'a glob this scan cannot name is still swallowed — P2.72 unmoved: %s',
    token => {
      // The positive control: bare, it denies, and with an UNNAMEABLE base.
      const bare = ladder(`Remove-Item ${token}`, 'win32')
      expect(bare?.ladderCase).toBe('wildcard')
      expect(bare?.resolved).toBeNull()
      expect(ladder(`Remove-Item -s ${token} -Path ./logs`, 'win32')).toBeNull()
    },
  )

  /**
   * P2.287's second half — the review finding that was raised and never
   * verified, settled here as VERIFIED. `windowsTargetTokens`'s docstring used
   * to excuse this row with "an unbound `-Path` fails mandatory binding", but
   * the command it names BINDS `-Path` by name, and `-Stream` + `-Path` are one
   * FileSystem parameter set (`Remove-Item.md` § `-Path`, `Required: True`,
   * `Position: 0`; § Example 7 removes a stream and leaves the file). So this
   * is a runnable, benign command that touches nothing under the home
   * directory, and it takes a `nonNegotiable` prompt AND an every-mode deny.
   *
   * Pinned as the CURRENT behaviour, not as the desired one: narrowing the
   * guard when `-Path`/`-LiteralPath` is bound elsewhere reverses part of a
   * security decision and is an owner call. If that call is made, this block is
   * the row to flip, and it is here so the flip is deliberate rather than
   * silent.
   */
  test('the recorded cost of the P2.85 guard is real, not hypothetical', () => {
    for (const command of [
      'Remove-Item -s ~ -Path ./logs',
      'Remove-Item -s ~ -LiteralPath ./logs',
      'Remove-Item -Path ./logs -s ~',
    ]) {
      expect(ladder(command, 'win32')).toMatchObject({ ladderCase: 'system-path', resolved: 'home', argument: '~' })
      expect(findRootOrHomeRemoval(command, { home: HOME, platform: 'win32' })?.target).toBe('home')
    }
    // The full spelling is unambiguous in every binding namespace and still
    // blinds both scans — P2.72's row, unmoved by any of the above.
    expect(ladder('Remove-Item -Stream ~ -Path ./logs', 'win32')).toBeNull()
    expect(findRootOrHomeRemoval('Remove-Item -Stream ~ -Path ./logs', { home: HOME, platform: 'win32' }))
      .toBeNull()
  })
})

/**
 * P2.71 — the same defect on the sh side, which P2.51 recorded as a limit here
 * rather than fixing because the fix belongs to a splitter the whole `Bash(...)`
 * rule matcher shares. It was fixed there, at `splitCompoundCommand`, once the
 * blast radius had been measured: zero rules in the repo's permission surface
 * matched a command because its comment tail was scanned.
 *
 * This block sits at the file's top level ON PURPOSE. It used to be nested under
 * `describe('the breaker prompt path inherits the same narrowing')`, and the sh
 * scan is precisely the one that does NOT inherit that narrowing — it reaches
 * the same outcome through a different rule (POSIX's `#`, not PowerShell's).
 *
 * MEASURED on the parent tree (2026-08-23, `home: '/Users/testuser'`), each
 * spared row carrying the verdict it used to produce:
 *
 * | command | before |
 * | --- | --- |
 * | `rm ./one.txt # also clears ~` | prompt: home on `~` |
 * | `rm -rf ./logs  # careful with /` | prompt: root on `/` |
 * | `rm ./one.txt # note \| rm -rf /` | prompt: root on `/` |
 */
describe('a comment tail does not reach the sh scan (P2.71)', () => {
  const spared: string[] = [
    'rm ./one.txt # also clears ~',
    'rm -rf ./logs  # careful with /',
    // The separators inside the comment are prose too, so the text after them
    // is no longer offered to the scan as a subcommand.
    'rm ./one.txt # note | rm -rf /',
    'rm ./one.txt # note ; rm -rf ~',
    // The wrapper pass runs first and does not re-expose the tail.
    'sudo rm ./one.txt # also clears ~',
  ]

  test.each(spared)('no prompt: %s', command => {
    expect(detect(command)).toBeNull()
  })

  const fires: Array<[command: string, target: 'root' | 'home']> = [
    // THE POSITIVE CONTROL, on the same rig: the scan still runs, and a real
    // removal in front of a comment is still found.
    ['rm -rf ~  # tidy up', 'home'],
    ['rm -rf /  # tidy up', 'root'],
    // A `#` opens a comment only at the start of a WORD, and quoting keeps it
    // ordinary text — `echo a#b` prints `a#b`, `echo 'a #b'` prints `a #b`.
    ['rm -rf ./a#b ~', 'home'],
    ["rm -rf '#' ~", 'home'],
    // A comment ends at the NEWLINE, so the next line is still scanned. This is
    // the row that would go quiet if the comment ever swallowed to end-of-input.
    ['rm ./ok.txt # note\nrm -rf /', 'root'],
    // The substitution breadth is unaffected: the scan still descends, and the
    // inner text is comment-stripped on its own once it is scanned as a command.
    ['echo $(rm -rf ~ # x)', 'home'],
  ]

  test.each(fires)('still prompts: %s', (command, target) => {
    expect(detect(command)?.target).toBe(target)
  })

  /**
   * ## A PIN THAT MOVED, and exactly what it used to assert
   *
   * This group used to read "THIS SCAN IS NOT A BACKSTOP", and pinned three
   * ANSI-C (`$'…'`) commands as returning null "so nobody reasons 'the breaker
   * will catch it'". Its reasoning was: `findShRemoval` returned null whenever
   * `splitWithSubstitutions` could not parse, so a lost parse was silently a
   * lost scan, and the protection was the splitter's `$'` guard plus the PROMPT
   * that its `'unparseable'` verdict produces.
   *
   * The OWNER DECISION of 2026-08-25 (P2.144, option (c) of three) replaces the
   * general half of that claim deliberately: on the unparseable path the floor
   * now runs a conservative textual scan and fires when — and only when — it
   * finds an `rm` carrying recursion with a root-or-home operand (force stopped
   * being required under P2.178). The
   * decision was taken because the `'unparseable'` prompt this group relied on
   * DOES NOT EXIST on the form that matters most: `sh -c 'case …'` parses at the
   * top level, so deny/ask answer `no-match`, not `'unparseable'`, and codex
   * wraps every command as `<shell> -lc`.
   *
   * So the first two rows move here, unchanged as strings. The pin is not
   * deleted — it is inverted, in the same commit, with the operand it now names.
   */
  const ansiCNowFires: [string, 'root' | 'home', string][] = [
    [String.raw`git commit -m $'don\'t # ship'; rm -rf ~`, 'home', '~'],
    [String.raw`echo $'a\'b # c'; rm -rf /`, 'root', '/'],
  ]

  test.each(ansiCNowFires)(
    'the textual fallback reaches an unparseable ANSI-C command: %s',
    (command, target, argument) => {
      expect(detect(command)?.target).toBe(target)
      // The owner's condition on option (c): the prompt must NAME the operand.
      expect(detect(command)?.argument).toBe(argument)
    },
  )

  /**
   * ## THE THIRD ROW, NOW INVERTED — and what it used to assert
   *
   * The P2.144 lane pinned this row separately rather than moving it with the
   * other two, because it measured that the reason was different: "a MIS-parse,
   * not a lost parse, still fails open — and the fallback is not its backstop",
   * asserting `splitCompoundCommand(command)` is not null and
   * `detect(command)` is null. Both halves were true and the diagnosis was
   * exactly right: `splitCompoundCommand` PARSES this command, reads the `\'`
   * inside `$'…'` as closing the quote, splits at a `;` that is INSIDE the
   * ANSI-C string, and hands the scan `rm -rf /' ; rm -rf ~ \'` — whose single
   * operand token is not a root-or-home target. The textual fallback could not
   * help, by contract: it runs only on text the structured scan could NOT read.
   *
   * P2.179 fixes the mis-parse itself, in the ENFORCEMENT pass only. The floor
   * now fires and names `~`, and the shell agrees — it prints the ANSI-C string
   * and runs `rm -rf ~` (measured through `/bin/sh -lc`; `scanCommand`'s
   * docstring records it). The allow splitter keeps its exact bytes, which the
   * first assertion below pins: 8 032 496 checks over 31 624 commands moved
   * `splitCompoundCommand` on zero of them and no `allow` verdict anywhere.
   */
  test('P2.179 — the mis-parse is fixed for the floor, and NOT for the allow splitter', () => {
    const command = String.raw`echo $'a\'b # c ; rm -rf /' ; rm -rf ~ \'`
    // Kills: turning the ANSI-C knob on for the allow path — the exact bytes the
    // old pin recorded, kept deliberately.
    expect(splitCompoundCommand(command)).toEqual([
      String.raw`echo $'a\'b # c`,
      String.raw`rm -rf /' ; rm -rf ~ \'`,
    ])
    // Kills: reverting the ANSI-C rule (null again), and a fallback-shaped
    // "fix" that fires without naming a real operand.
    expect(detect(command)?.target).toBe('home')
    expect(detect(command)?.argument).toBe('~')
  })

  test('the positive control: without the ANSI-C quote the same removal fires', () => {
    expect(detect(String.raw`git commit -m 'do not # ship'; rm -rf ~`)?.target).toBe('home')
    expect(detect(String.raw`echo 'a b # c'; rm -rf /`)?.target).toBe('root')
  })
})

/**
 * P2.75 — the same shape on the Windows side, one layer ABOVE
 * {@link tokenizePowerShell}. That tokenizer has stopped at a token-initial `#`
 * since P2.51, but `splitPowerShellCommand` ran first and split on a `;` or `|`
 * inside the comment, so the text after it arrived as a subcommand the
 * tokenizer then read in full. Both rows below were MEASURED on the parent tree
 * (2026-08-23) producing the verdict named beside them.
 */
describe('a separator inside a comment tail does not reach the Windows scans (P2.75)', () => {
  // PRE: `system-path` deny on `/usr`, and a home prompt on `~`.
  const spared: string[] = [
    'Remove-Item ./a.txt # note | Remove-Item /usr',
    'Remove-Item ./a.txt # note ; Remove-Item ~',
    'Remove-Item ./a.txt # note && Remove-Item /',
  ]

  test.each(spared)('no ladder deny: %s', command => {
    expect(findRemoveItemLadderDeny(command, { platform: 'win32' })).toBeNull()
  })

  test.each(spared)('no prompt: %s', command => {
    expect(findRootOrHomeRemoval(command, { home: HOME, platform: 'win32' })).toBeNull()
  })

  test('the positive control on the same rig: both scans still run', () => {
    // Uncomment the tail and the every-mode deny is back …
    expect(findRemoveItemLadderDeny('Remove-Item ./a.txt | Remove-Item /usr', { platform: 'win32' })?.argument)
      .toBe('/usr')
    // … as is the prompt.
    expect(findRootOrHomeRemoval('Remove-Item ./a.txt ; Remove-Item ~', { home: HOME, platform: 'win32' })?.target)
      .toBe('home')
    // A comment does not blind the command in FRONT of it, on either scan.
    expect(findRemoveItemLadderDeny('Remove-Item /usr # note ; gci', { platform: 'win32' })?.argument)
      .toBe('/usr')
    expect(findRootOrHomeRemoval('Remove-Item ~ # note ; gci', { home: HOME, platform: 'win32' })?.target)
      .toBe('home')
    // The `<#` guard keeps the parent behaviour, so the deny still fires there.
    expect(findRemoveItemLadderDeny('Remove-Item ./a.txt <# n #> ; Remove-Item /usr', { platform: 'win32' })?.argument)
      .toBe('/usr')
  })
})

// ============================================================
// The cmd heads keep their own target rule (P2.74)
// ============================================================

/**
 * P2.51's narrowing is a statement about PowerShell PARAMETER BINDING, and
 * `del`, `erase`, `rd` and `rmdir` are `cmd.exe` internal commands that bind no
 * parameters: there `-Include` is a FILE called `-Include`, and the token after
 * it is still a target. MEASURED on win32 by P2.51's review — the only
 * under-fire the narrowing introduced — `del -Include C:\ /s /q` was a
 * drive-root deny plus a root prompt before it, and `null` on both after.
 *
 * Both directions are pinned, because the fix is a widening of a DENY and the
 * way to get it wrong is to widen it past the heads it reasons about.
 */
describe('the cmd heads bind no parameters, so every token is a target (P2.74)', () => {
  const cmdHeadsClassify: Array<[command: string, argument: string]> = [
    // The measured row itself, and the same shape on each remaining cmd head.
    ['del -Include C:\\ /s /q', 'C:\\'],
    ['del -Exclude C:\\ -Path ./logs', 'C:\\'],
    ['erase -Filter C:\\ /q', 'C:\\'],
    ['rd -Include C:\\ /s /q', 'C:\\'],
    // `-s` is `-Stream`'s one-character minimum in PowerShell (P2.72) and an
    // ordinary filename in cmd — the interlock that keeps that minimum honest.
    ['del -s C:\\ /q', 'C:\\'],
    // THE POSITIVE CONTROL. The genuinely dangerous cmd spelling has no
    // `-Param` syntax at all and never depended on any of this.
    ['rd /s /q C:\\', 'C:\\'],
    // The cost, stated rather than hidden: a PowerShell session that spells the
    // cmdlet `del` gets P2.51's false deny back. An over-firing deny is an
    // annoyance; an under-firing one is a removal nobody was asked about.
    ['del /s /q ./logs -Exclude vendor/*', 'vendor/*'],
  ]

  test.each(cmdHeadsClassify)('ladder denies: %s', (command, argument) => {
    expect(ladder(command, 'win32')?.argument).toBe(argument)
  })

  test.each(cmdHeadsClassify.filter(([command]) => command.includes('C:\\')))(
    'breaker prompts: %s',
    command => {
      expect(findRootOrHomeRemoval(command, { home: HOME, platform: 'win32' })?.target).toBe('root')
    },
  )

  /**
   * `rmdir` is a cmd builtin too, so the PROMPT path classifies its tokens —
   * but the ladder never sees it, because gap (c) leaves `rm`/`rmdir` on the
   * `rm` critical-path list by literal spelling. The asymmetry is pinned so it
   * stays deliberate.
   */
  test('rmdir reaches the prompt path but not the ladder', () => {
    expect(findRootOrHomeRemoval('rmdir -Include C:\\ /s /q', { home: HOME, platform: 'win32' })?.target)
      .toBe('root')
    expect(ladder('rmdir -Include C:\\ /s /q', 'win32')).toBeNull()
  })

  /**
   * And the narrowing is untouched wherever a shell really does bind
   * parameters: the cmdlet itself and the two aliases `cmd` does not have.
   */
  const powerShellHeadsSkip: string[] = [
    'Remove-Item -Exclude C:\\ -Path ./logs',
    'ri -Include C:\\ -Path ./logs',
    'rm -Filter C:\\ -Path ./logs',
  ]

  test.each(powerShellHeadsSkip)('still narrowed: %s', command => {
    expect(ladder(command, 'win32')).toBeNull()
    expect(findRootOrHomeRemoval(command, { home: HOME, platform: 'win32' })).toBeNull()
  })
})

// ============================================================
// P2.144 — the textual fallback for command text nothing could parse
// ============================================================

/**
 * Every spelling below was verified BEFORE the fix, and verified as a COMMAND
 * rather than as a string: each was `bash -n` clean and each RAN its body in
 * `/bin/bash`, `/bin/sh` and `/bin/dash`, with a non-destructive `touch` in the
 * payload position and a no-op run as the detector's control (the marker had to
 * be absent in the control and present in the run). Nothing executed while
 * building this group named a real home or root — the payload arrived at the
 * matcher as JSON data, and a refusal harness gated every execution.
 *
 * Two of the corpus's rig defects are worth recording, because both would have
 * produced a confident wrong answer: `case $x in a)` never reaches its body with
 * `$x` unset, so the first run pass reported "does not execute" for five valid
 * spellings; and `sh -c` starts a fresh shell, so the subject has to be
 * EXPORTED for the wrapper row.
 */
describe('P2.144 — an unparseable command with a removal shape reaches the floor', () => {
  const fires: [string, 'root' | 'home', string][] = [
    // The bare `a)` label leaves the shared scanner's paren depth unbalanced.
    ['case $x in a) rm -rf ~ ;; esac', 'home', '~'],
    // Every label spelling, because the row's original claim that only the bare
    // one missed was refuted by measurement.
    ['case $x in *) rm -rf ~ ;; esac', 'home', '~'],
    ['case $x in a|b) rm -rf ~ ;; esac', 'home', '~'],
    // MULTI-LINE was claimed to fire already. It did not — measured.
    ['case $x in\n  a)\n    rm -rf ~\n    ;;\nesac', 'home', '~'],
    // The half that made this a decision: a `case` ANYWHERE disables the floor
    // for everything after it, so this is a general-purpose disabling prefix
    // and not one exotic spelling.
    ['case $x in a) echo hi ;; esac; rm -rf ~', 'home', '~'],
    // Codex wraps EVERY command as `<shell> -lc`, and on that form deny/ask
    // answer `no-match` rather than `'unparseable'` — there is no prompt-anyway
    // net at all, which is why the floor had to grow one.
    [`sh -c 'case $x in a) rm -rf ~ ;; esac'`, 'home', '~'],
    [`sh -c 'case $x in a) echo hi ;; esac; rm -rf ~'`, 'home', '~'],
    ['/', 'root', '/'].length === 0 ? ['', 'root', '/'] : ['case $x in a) rm -rf / ;; esac', 'root', '/'],
  ]

  test.each(fires)('fires and names the operand: %s', (command, target, argument) => {
    // Kills: reverting the fallback (every row returns null again).
    expect(detect(command)?.target).toBe(target)
    // Kills: a fallback that fires without naming a real operand — the owner's
    // stated condition on option (c), and the thing option (b) could not do.
    expect(detect(command)?.argument).toBe(argument)
  })

  /**
   * P2.178 — RECURSION WITHOUT FORCE, which this group used to pin as quiet.
   *
   * The fallback demanded a recursive-AND-force pair, so `rm -r ~` inside a
   * `case` did not fire. The widening is a measurement, not a preference: a
   * sandbox stand-in tree, `-r` and `-R` alike, in ALL FIVE of `bash`,
   * `/bin/sh`, `dash`, `zsh` and `ksh` — GONE, exit 0, whether stdin was a pipe
   * or a tty and whether the files were writable or not. The per-file prompt
   * that made a bare `-r` look survivable needs a controlling terminal AND an
   * unwritable file at the same time; a home directory is the user's own files
   * and the Bash tool spawns its shell on a pipe. See
   * {@link carriesRecursiveRemoval} for the full table.
   */
  const recursionWithoutForce: [string, 'root' | 'home', string][] = [
    // Kills: reverting `carriesRecursiveRemoval` to `recursive && force`.
    ['case $x in a) rm -r ~ ;; esac', 'home', '~'],
    ['case $x in a) rm -R ~ ;; esac', 'home', '~'],
    ['case $x in a) rm -r / ;; esac', 'root', '/'],
    // The long GNU spelling. It cannot RUN on this host — BSD `rm` takes no
    // long options at all (`illegal option -- -`, exit 64) — but it is
    // `-r, -R, --recursive` in GNU coreutils, which is the Linux build's `rm`.
    ['case $x in a) rm --recursive ~ ;; esac', 'home', '~'],
    // Kills: a mutant that DROPS `--dir` while widening — that would be a
    // narrowing of a nonNegotiable floor, and this row is the only guard.
    ['case $x in a) rm --dir --force ~ ;; esac', 'home', '~'],
    // Codex's universal wrapper form, where there is no `'unparseable'` prompt
    // net at all — so this is the row that decides whether the widening reaches
    // the runtime that needs it.
    [`sh -c 'case $x in a) rm -r ~ ;; esac'`, 'home', '~'],
  ]

  test.each(recursionWithoutForce)(
    'a recursive removal fires without force: %s',
    (command, target, argument) => {
      expect(detect(command)?.target).toBe(target)
      expect(detect(command)?.argument).toBe(argument)
    },
  )

  test('the prompt text names the operand it found', () => {
    const removal = findRootOrHomeRemoval('case $x in a) rm -rf ~ ;; esac', { home: HOME })!
    // Kills: a mutant that reports a placeholder or the whole command as the
    // argument — `describeRootOrHomeRemoval` interpolates it into the prompt.
    expect(describeRootOrHomeRemoval(removal)).toContain('`~`')
    expect(describeRootOrHomeRemoval(removal)).toContain('your home directory')
  })

  const staysQuiet: string[] = [
    // THE POSTURE. An unparseable command with NO removal shape still passes —
    // this is the whole difference between the owner's option (c) and option (b)
    // ("fail closed on all unparseable input"), and a mutant implementing (b)
    // fails here.
    'case $x in a) echo hi ;; esac; echo done',
    'case $x in a) ls -la ~ ;; esac',
    // Force WITHOUT recursion, and no flags at all. Kills a mutant that drops
    // the RECURSION requirement and fires on any `rm` naming home — which is
    // what the structured scan does, and the one widening P2.178 did NOT take.
    // Both were measured non-destructive: `rm -f <dir>` and `rm <dir>` exit 1
    // with `is a directory` and remove nothing.
    'case $x in a) rm -f ~ ;; esac',
    'case $x in a) rm ~ ;; esac',
    // `--dir` alone. Kills a mutant that folds it into recursion: `rm --dir` on
    // a non-empty tree removes nothing (exit 1 `Directory not empty` on GNU,
    // `illegal option` on BSD), so it keeps the force pairing it always had.
    'case $x in a) rm --dir ~ ;; esac',
    // A NARROWER target. Kills a mutant that prefix-matches the home path
    // instead of asking `classifyTarget` for an exact root-or-home target —
    // the module's founding rule is that a false positive disables the feature.
    'case $x in a) rm -rf ~/projects/scratch ;; esac',
    'case $x in a) rm -rf ./build ;; esac',
    // A DIFFERENT command that merely contains the letters.
    'case $x in a) chmod -R 777 ~ ;; esac',
    'case $x in a) git rm -rf ~ ;; esac',
  ]

  test.each(staysQuiet)('stays quiet: %s', command => {
    expect(detect(command)).toBeNull()
  })

  test('the fallback never runs on text the structured scan CAN read', () => {
    // This is the property that keeps the module's documented false-positive
    // posture: quoted prose is not command text. Kills the mutant that runs the
    // fallback unconditionally — the single most tempting simplification of this
    // design, and the one that would start prompting on `echo "rm -rf ~"`.
    //
    // The fixture is chosen so the two matchers genuinely DISAGREE. Inside
    // double quotes the `;` is ordinary text, so `tokenize` keeps the whole
    // quoted string as one argument of `echo` and the structured scan is right
    // to stay quiet — while the textual scan, which cannot see quoting, reads a
    // separator and an `rm` in command position after it.
    const quoted = 'echo "hi; rm -rf ~"'
    expect(splitCompoundCommand(quoted)).not.toBeNull()
    expect(detect(quoted)).toBeNull()
    // ...and the fallback, asked DIRECTLY, DOES match it. Without this line the
    // assertion above would pass just as well for a fallback that matches
    // nothing at all — a matcher weaker than its label is how a re-break gets
    // mistaken for a success.
    expect(findTextualRemoval(quoted, HOME)?.target).toBe('home')
    // The operand it names carries the closing quote, because a word scanner
    // reads to the end of the text and does not know the quote closed anything.
    // Asserted verbatim rather than smoothed over: this is exactly the kind of
    // weakness that justifies confining the fallback to unparseable text.
    expect(findTextualRemoval(quoted, HOME)?.argument).toBe('~"')
  })

  test('the fallback is weaker than the structured scan, and these are the gaps', () => {
    // Recorded as tests rather than prose so a later widening is visible. Each
    // is a spelling the structured scan handles and this one does not.
    //
    // `sudo rm -rf ~` USED TO BE THE FIRST ROW HERE. P2.91 closed it, and the
    // reason is worth keeping next to the one that remains: on unparseable text
    // the structured scan sees nothing at all, so "the structured scan already
    // covers wrappers" stopped being true exactly where the fallback is the
    // only floor.
    //
    // `find … -delete` WAS THE SECOND ROW AND P2.312 CLOSED IT, for the same
    // reason one level on. This list's premise was that a gap here is covered
    // elsewhere; P2.312 measured that for 13.78 % of real agent-issued commands
    // — the ones parsing at top level while carrying an unparsed nested span or
    // `-c` script — there is no elsewhere, because the DSL sees `no-match` and
    // this matcher is the whole floor. The stated objection was that `find`'s
    // narrowing rules "cannot be applied to word soup without inventing
    // removals", and that half was measured FALSE: `findDeleteOperands` returns
    // null on the first token it does not recognise, so soup fails CLOSED. The
    // quiet half of that measurement is the test below this one.
    //
    // `rmdir` stays open on its own merit, unchanged: `rmdir ~` removes nothing
    // on a non-empty home, and the fallback requires recursion, which `rmdir`
    // has no flag for.
    expect(findTextualRemoval('rmdir ~', HOME)).toBeNull()
    // And the structured scan DOES handle it, so this is a gap between two live
    // matchers rather than an input nothing covers.
    expect(detect('rmdir ~')?.target).toBe('home')
  })

  /**
   * P2.312 — the `find` half of the fallback, and the two properties that let it
   * exist at all.
   *
   * The row that motivates it: **2 517 of 18 272 real agent-issued commands
   * (13.78 %)** parse at the top level while carrying a nested span or `-c`
   * script that does not. On those the DSL's verdict is `no-match`, so
   * `PROMPT_ANYWAY` never fires whatever rules the user has, and this matcher is
   * the sole floor — which is what turned a `structured-only` row from "covered
   * elsewhere" into "covered nowhere".
   */
  test('P2.312 — the fallback reads `find … -delete`, and refuses a narrowed traversal', () => {
    // FIRES: the plain removal, on both targets and through the home spellings.
    expect(findTextualRemoval('find ~ -delete', HOME)?.target).toBe('home')
    expect(findTextualRemoval('find / -delete', HOME)?.target).toBe('root')
    expect(findTextualRemoval('find $HOME -delete', HOME)?.target).toBe('home')
    // The non-narrowing options are traversal control, not selection.
    expect(findTextualRemoval('find ~ -depth -xdev -print -delete', HOME)?.target).toBe('home')
    // A removal spelled as an action rather than as `-delete`.
    expect(findTextualRemoval('find ~ -exec rm -rf {} +', HOME)?.target).toBe('home')

    // STAYS QUIET on the shape that would have made this a false-positive
    // machine — ordinary cleanup that selects a SUBSET of the tree. This is the
    // adversarial spelling, not the friendly one: it names the home directory,
    // it carries `-delete`, and it must not fire.
    expect(findTextualRemoval("find ~ -name '*.tmp' -delete", HOME)).toBeNull()
    expect(findTextualRemoval('find ~ -type f -delete', HOME)).toBeNull()
    expect(findTextualRemoval('find ~ -mtime +30 -delete', HOME)).toBeNull()
    expect(findTextualRemoval('find ~ -maxdepth 1 -delete', HOME)).toBeNull()
    // A traversal that removes nothing, and an `-exec` that runs something else.
    expect(findTextualRemoval('find ~ -print', HOME)).toBeNull()
    expect(findTextualRemoval('find ~ -exec echo {} +', HOME)).toBeNull()
    // Word soup fails CLOSED — the measured claim that overturned the stated
    // objection. An unbalanced quote span is exactly what reaches this matcher.
    expect(findTextualRemoval('find ~ -name "*.log -delete', HOME)).toBeNull()
    // Command position, same rule the `rm` pass has: a `find` that merely
    // follows a blank is a different word.
    expect(findTextualRemoval('git find ~ -delete', HOME)).toBeNull()
    expect(findTextualRemoval('echo my-find ~ -delete', HOME)).toBeNull()
  })

  /**
   * P2.312 — and the wrapper strip covers `find` in the SAME commit, because
   * leaving it out would re-create for `find` the exact defect P2.91 closed for
   * `rm`: present for the removal, absent for the same removal with MORE
   * privilege in front of it.
   */
  test('P2.312 — the fallback sees `find … -delete` through an enforcement wrapper', () => {
    for (const wrapper of ['sudo', 'env', 'nohup', 'timeout 5']) {
      expect(findTextualRemoval(`${wrapper} find ~ -delete`, HOME)?.target).toBe('home')
    }
    // `git` is not a wrapper here either, so the strip cannot uncover a `find`
    // that was never in command position.
    expect(findTextualRemoval('git find ~ -delete', HOME)).toBeNull()
    // And the whole point of the row: on the SLICE, through a real unparsed span.
    expect(detect(`sh -c 'case $x in a) find ~ -delete ;; esac'`)?.target).toBe('home')
    expect(detect(`sh -c 'case $x in a) sudo find ~ -delete ;; esac'`)?.target).toBe('home')
    // The narrowed traversal stays quiet on the slice too — a false positive
    // there is unskippable, which is how this feature gets routed around.
    expect(detect(`sh -c 'case $x in a) find ~ -name "*.tmp" -delete ;; esac'`)).toBeNull()
  })

  /**
   * P2.312 — THE SLICE CENSUS, and the last wrapper asymmetry it found.
   *
   * The row asked for one thing before anything was decided: *measure what the
   * breaker does and does not catch on that slice.* Two lanes measured parts of
   * it (`rm` behind wrappers; `find … -delete`; a PowerShell removal in an
   * unparsed span, P2.388). This is the rest, DRIVEN over every removal head and
   * every enforcement wrapper this module names, with the same span shape the
   * slice actually has.
   *
   * It found exactly one gap, and the gap was a PRE-FILTER: `env -S "rm -rf ~"`
   * fires from the structured scan and returned null from the fallback, because
   * the head sits behind a `"` and {@link TEXTUAL_CONTAINS_REMOVAL_HEAD} would
   * not accept a quote as the blank before it — so the segment never reached the
   * stripper that already knows `-S`. Measured against the pre-change file over
   * a 16-command corpus: **exactly one verdict moved**, this one.
   */
  test('P2.312 — every wrapper this module names reaches the floor on the slice', () => {
    // Each of these fires at top level; each must fire inside a span the
    // structured scan cannot balance, or the floor is present for a removal and
    // absent for the same removal wrapped.
    for (const wrapped of [
      'rm -rf ~',
      'sudo rm -rf ~',
      'doas rm -rf ~',
      'env rm -rf ~',
      'env FOO=1 rm -rf ~',
      'env -S "rm -rf ~"',
      'nohup rm -rf ~',
      'timeout 5 rm -rf ~',
      '/bin/rm -rf ~',
      'find ~ -delete',
      'find ~ -exec rm -rf {} +',
    ]) {
      const span = `case $x in a) ${wrapped} ;; esac`
      expect(splitCompoundCommand(span)).toBeNull()   // it really is the slice
      expect(detect(span)?.target).toBe('home')
    }
  })

  test('P2.312 — the quote in the pre-filter widens nothing else', () => {
    // The three gates BELOW the pre-filter are what keep the posture, so these
    // are the rows that would have gone loud if the widening were the whole
    // rule rather than a cheap bail.
    for (const quiet of [
      'echo "rm -rf ~"',
      `echo 'sudo rm -rf ~'`,
      `echo "env -S 'rm -rf ~'"`,
      'git rm -rf ~',
      'rm -rf ~/build',
      `find ~ -name '*.tmp' -delete`,
    ]) {
      expect(findTextualRemoval(quiet, HOME)).toBeNull()
      expect(detect(`case $x in a) ${quiet} ;; esac`)).toBeNull()
    }
  })

  /**
   * P2.312 — WHAT THE CENSUS LEAVES OPEN, pinned as behaviour so the residue is
   * a fact and not a paragraph.
   *
   * `rmdir` is the one removal head the fallback still cannot read, and it stays
   * that way on purpose: `rmdir` removes only an EMPTY directory, so `rmdir ~`
   * on any home a user has is `Directory not empty`, exit 1. The gap is
   * declared as a `structured-only` row in the differential below and the reason
   * is recorded on {@link stripTextualEnforcementWrappers}.
   *
   * The corpus-WEIGHTED fire rate over real traffic is a different thing and is
   * still owed: it needs the 18 272-command corpus under the real home, which is
   * P2.389 and owner-owed. Everything above is the adversarial set.
   */
  test('P2.312 — the residue is `rmdir`, and it is a stated decision', () => {
    expect(detect('rmdir ~')?.target).toBe('home')            // structured: yes
    expect(findTextualRemoval('rmdir ~', HOME)).toBeNull()    // fallback: no
    expect(detect('case $x in a) rmdir ~ ;; esac')).toBeNull()
    // The positive control that keeps this from passing on a dead instrument:
    // the same span with `rm` DOES fire, so the null above is `rmdir`'s and not
    // the span's.
    expect(detect('case $x in a) rm -rf ~ ;; esac')?.target).toBe('home')
  })

  /**
   * P2.91 — THE FALLBACK NOW SEES THROUGH THE ENFORCEMENT WRAPPERS.
   *
   * The row asked what `unparseable` should MEAN to this floor and expected the
   * answer "fire". Measured over 18 272 distinct Bash commands actually issued
   * by agents in this repo, 800 (4.38 %) are whole-command unparseable and 784
   * of them carry no removal at all — 504 heredocs, 128 `case` blocks, 120
   * commands whose only sin is an apostrophe in a comment. Firing on all of them
   * is 1 unskippable prompt in every 23 commands, which is noise, so the posture
   * stayed "read it with the weaker matcher". What was actually broken is
   * NARROWER and worse: the weaker matcher read `rm -rf ~` and not
   * `sudo rm -rf ~`, so on text nothing else could read the floor was present
   * for one spelling of a removal and absent for the same removal run with more
   * privilege.
   *
   * The `env` and `nohup` forms below were run for real: with a sandbox
   * stand-in tree in place of `~`, `bash`, `/bin/sh` and `zsh` each removed the
   * tree and exited 0 (2026-08-28).
   */
  const wrapperHidden: [string, 'root' | 'home'][] = [
    ['case a in a) sudo rm -rf ~ ;; esac', 'home'],
    ['case a in a) doas rm -rf ~ ;; esac', 'home'],
    ['case a in a) env rm -rf ~ ;; esac', 'home'],
    ['case a in a) nohup rm -rf / ;; esac', 'root'],
    // The head is RESOLVED, as it is everywhere else in this subsystem.
    ['case a in a) /usr/bin/sudo rm -rf ~ ;; esac', 'home'],
    // Wrapper flags that consume a value, and a leading assignment.
    ['case a in a) sudo -u root rm -rf ~ ;; esac', 'home'],
    ['case a in a) FOO=bar rm -rf ~ ;; esac', 'home'],
    ['case a in a) timeout 5 rm -rf ~ ;; esac', 'home'],
    ['case a in a) watch rm -rf ~ ;; esac', 'home'],
    // Unbalanced quoting, the other route into the fallback.
    ['echo "unterminated ; sudo rm -rf ~', 'home'],
    // Codex's universal wrapper form, where there is no `'unparseable'` prompt
    // net at all — the runtime this widening actually protects.
    [`sh -c 'case a in a) sudo rm -rf ~ ;; esac'`, 'home'],
  ]

  test.each(wrapperHidden)('a wrapper no longer hides the removal: %s', (command, target) => {
    // Kills: reverting `stripTextualEnforcementWrappers` (all rows null again).
    expect(detect(command)?.target).toBe(target)
    // Kills: a rewrite that fires but names the wrapper instead of the operand —
    // `describeRootOrHomeRemoval` interpolates this into the prompt.
    expect(detect(command)?.argument).toBe(target === 'home' ? '~' : '/')
  })

  const wrapperStaysQuiet: string[] = [
    // THE REGRESSION THE COMMAND-POSITION RULE EXISTS TO PREVENT. `git rm` is a
    // different command, `git` is not a wrapper, and a floor that invents
    // removals is how the feature gets routed around. Kills a rewrite that skips
    // ANY leading word rather than asking `stripSubcommand` which ones strip.
    'case a in a) git rm -rf ~ ;; esac',
    // The wrapper is there but the removal shape is not: all three requirements
    // still hold after stripping.
    'case a in a) sudo rm -rf ./build ;; esac',
    'case a in a) sudo rm ~ ;; esac',
    // `echo` is not a wrapper either, so the words after it are not a command.
    'case a in a) echo sudo rm -rf ~ ;; esac',
  ]

  test.each(wrapperStaysQuiet)('a wrapper does not manufacture a removal: %s', command => {
    expect(detect(command)).toBeNull()
  })

  test('the wrapper rewrite is the IDENTITY on text with no rm word', () => {
    // The cheap-bail property, asserted through behaviour rather than by reading
    // the code: the 504 heredocs and 128 `case` blocks in the measured corpus
    // must pass through untouched. A rewrite that normalized every segment would
    // still pass the rows above while quietly changing what the scan reports.
    expect(findTextualRemoval(`case a in a) python3 - <<'PY'\nprint("hi")\nPY\n ;; esac`, HOME)).toBeNull()
    // And the pinned spellings are byte-identical, quote included. Without this
    // the rewrite could re-tokenize every segment and nobody would notice.
    expect(findTextualRemoval('echo "hi; rm -rf ~"', HOME)?.argument).toBe('~"')
    expect(findTextualRemoval('rm -rf ~', HOME)?.subcommand).toBe('rm -rf ~')
  })
})

// ============================================================
// P2.180 — the floor does not fire on a construct that runs nothing
// ============================================================

/**
 * A false positive on a `nonNegotiable` floor is a block the user cannot
 * override, so it is a defect in its own right even though the direction looks
 * safe. `COMPOUND_PATTERN_LABEL` matched `>(cat)`, and the floor reported `home`
 * for `>(cat) rm -rf ~` — a command that, measured with a `touch` payload
 * against a `:` control, reaches its second word in NONE of `bash`, `/bin/sh`,
 * `dash`, `zsh` or `ksh`. See `claude-bash-rule.ts`'s `opensProcessSubstitution`
 * for the 44-token sweep and the per-shell exit codes.
 */
/**
 * P3.307 — an abbreviated GNU long option, the full spelling family.
 *
 * `carriesRecursiveRemoval` matched `--recursive`, `--dir` and `--force` by
 * EXACT string. GNU `getopt_long` accepts any unambiguous PREFIX, so every long
 * flag the matcher names has a family of spellings and the matcher saw one of
 * each. W2-q measured it in a coreutils 9.1 container: `rm --recursive --force
 * $HOME` fired both matchers, and `rm --rec --force $HOME`, `rm --r -f $HOME`
 * and `rm --rec --fo $HOME` fired NEITHER while leaving the home equally gone.
 *
 * The two sides of the family are asserted together on purpose. A fix that
 * simply widened everything past `--` would fire on `--interactive` and
 * `--verbose`, which remove nothing, and this table is what refuses it.
 */
describe('P3.307 — an abbreviated long option is the same command to GNU', () => {
  const fires: [string, string][] = [
    ['rm --recursive --force ~', 'the fully-spelled control, which always worked'],
    ['rm --rec --force ~', 'W2-q\'s measured abbreviation'],
    ['rm --r -f ~', 'a single letter — unambiguous, `rm` has no other long `r`'],
    ['rm --rec --fo ~', 'both flags abbreviated'],
    ['rm --recursiv ~', 'one character short'],
    ['rm --r ~', 'recursion alone is enough (P2.178)'],
    ['rm --re ~', 'ditto'],
    ['rm --recu ~', 'ditto'],
    ['rm --dir --force ~', 'the `--dir` pairing, fully spelled'],
    ['rm --d --f ~', 'the same pairing, both abbreviated'],
    ['rm --di --fo ~', 'and at two characters each'],
  ]

  const quiet: [string, string][] = [
    ['rm --force ~', 'force without recursion removes no tree — unchanged by P3.307'],
    ['rm --f ~', 'and its abbreviation must not become a fire'],
    ['rm --dir ~', '`--dir` alone removes only an EMPTY directory'],
    ['rm --d ~', 'and its abbreviation'],
    ['rm --interactive ~', 'a long option that is not a removal flag at all'],
    ['rm --i ~', 'the trap a blanket `--` widening would fall into'],
    ['rm --verbose ~', 'ditto — and `--v` is AMBIGUOUS to GNU, so it never runs'],
    ['rm --recursive ~/projects/x', 'a narrower target is not the home'],
    ['rm --rec ~/projects/x', 'the abbreviation does not change the target rule'],
  ]

  test.each(fires)('fires: %s', command => {
    expect(findTextualRemoval(command, HOME)).not.toBeNull()
  })

  test.each(quiet)('quiet: %s', command => {
    expect(findTextualRemoval(command, HOME)).toBeNull()
  })

  test('the prefix match is a PREFIX match, not a substring one', () => {
    // Kills a mutant that uses `includes` instead of `startsWith`: `--cursive`
    // is a substring of `recursive` and is not a spelling GNU accepts.
    expect(findTextualRemoval('rm --cursive ~', HOME)).toBeNull()
    expect(findTextualRemoval('rm --orce ~', HOME)).toBeNull()
    // …and the empty name is not a prefix of anything here: `rm -- ~` is the
    // end-of-options marker, and `--` alone removes a file literally named `~`.
    expect(findTextualRemoval('rm -- ~', HOME)).toBeNull()
  })
})

describe('P2.180 — the floor is quiet on process substitution in command position', () => {
  const quiet: string[] = [
    '>(cat) rm -rf ~', '<(cat) rm -rf ~', '2>(cat) rm -rf ~',
    '>>(cat) rm -rf /', '&>(cat) rm -rf ~', '{fd}>(cat) rm -rf ~',
    '>( ) rm -rf ~', '>() rm -rf ~', '<() rm -rf /',
  ]

  test.each(quiet)('does not fire: %s', command => {
    // Kills: reverting the fix — every row returns `home`/`root` again.
    expect(detect(command)).toBeNull()
  })

  test('a removal inside the parens still fires, and names its operand', () => {
    // The regression this change could have caused. The span walk is a
    // different mechanism from the label reader, and only the label reader
    // moved.
    expect(detect('cat >(rm -rf ~)')?.target).toBe('home')
    expect(detect('cat >(rm -rf ~)')?.argument).toBe('~')
    expect(detect('diff <(rm -rf /) b')?.target).toBe('root')
  })

  test('the sibling the row called broken was already quiet', () => {
    // P2.180 listed `for f in rm -rf ~; do echo $f; done` as a second member of
    // the class. MEASURED on HEAD (`c257eec7f`) before touching anything: it
    // returns null already — P2.142's command/header position tracking fixed it,
    // and the row's note is stale on that point. Pinned so it stays fixed
    // rather than silently re-broken by a later change to the position walk.
    expect(detect('for f in rm -rf ~; do echo $f; done')).toBeNull()
    expect(detect('for opt in rm -rf ~; do echo $opt; done')).toBeNull()
  })

  test('the third sibling is LEFT firing, on purpose, and here is the reason', () => {
    // `bash --rcfile=/dev/null -c 'rm -rf ~'` fires, and bash rejects that
    // string outright (`invalid option`, exit 2) — measured not to run in any
    // of the five shells. It is still left firing: silencing it means asserting
    // that NO shell on ANY supported platform accepts a joined `--opt=value`,
    // which was measured on one platform only, and the same reach protects
    // `bash --rcfile /dev/null -c` — the SEPARATED spelling, measured to RUN on
    // `bash` and `/bin/sh`. An over-fire on a string bash refuses costs a
    // prompt; the narrowing risks a missed home wipe. Owner call, not a
    // maintenance edit — pinned here so the trade is visible rather than
    // rediscovered.
    expect(detect(`bash --rcfile=/dev/null -c 'rm -rf ~'`)?.target).toBe('home')
    expect(detect(`bash --rcfile /dev/null -c 'rm -rf ~'`)?.target).toBe('home')
  })
})

// ============================================================
// P2.144 — the mechanism that keeps the two matchers honest
// ============================================================

/**
 * THE DIFFERENTIAL. The owner accepted option (c) with its cost named: a second,
 * weaker matcher that must be kept honest against the first. This is that
 * mechanism, and it is a test rather than a one-off measurement so it keeps
 * biting after this commit.
 *
 * It runs BOTH matchers over one corpus of commands that all PARSE — so
 * `findRootOrHomeRemoval` is the structured matcher alone, the fallback never
 * having been consulted — and requires every row to land in the bucket it
 * declares. A disagreement with no declared bucket fails the suite, which is
 * what makes a silent widening of either matcher visible.
 *
 * The method is the one that has now caught four widenings nobody was looking
 * for; two of them were caught by THIS harness while it was being written:
 * the textual matcher fired on `git rm -rf ~` and on `sudo rm -rf ~`, both
 * because `rm` followed a blank. Neither would have been noticed by testing the
 * fallback against its own expectations.
 */
describe('P2.144 — the differential between the structured and textual matchers', () => {
  type Bucket = 'both-fire' | 'both-quiet' | 'structured-only' | 'textual-only'

  /** Every row declares the bucket it belongs in, and why it is not a defect. */
  const corpus: [Bucket, string, string][] = [
    // ── both fire: the matchers agree on the plain shape ──────────────────
    ['both-fire', 'rm -rf ~', 'the documented example, read the same way by both'],
    ['both-fire', 'rm -rf /', 'ditto for the root'],
    ['both-fire', 'echo hi; rm -rf ~', 'a separator puts the removal in command position for both'],
    ['both-fire', 'echo $(rm -rf ~)', 'a `$(` is a command position to both readings'],
    ['both-fire', 'rm -rf $HOME', 'both resolve `$HOME` — the SAME classifyTarget does it'],
    ['both-fire', 'rm -fr ~', 'flag order is irrelevant to both'],
    ['both-fire', 'rm --recursive --force ~', 'long flags, both'],
    // P2.178 moved these into agreement. The differential is what surfaced the
    // disagreement in the first place, and the bucket declaration is what makes
    // the move impossible to land silently.
    ['both-fire', 'rm -r ~', 'recursion without force — measured to delete the tree in all five shells'],
    ['both-fire', 'rm -R ~', 'the other short spelling'],
    ['both-fire', 'rm --recursive ~', 'the GNU long spelling, unrunnable on BSD rm but shipped on Linux'],
    ['both-fire', 'rm --dir --force ~', '`--dir` keeps the force pairing it always had'],
    // P3.307 — GNU accepts any unambiguous PREFIX of a long option, so each of
    // these is `rm --recursive --force ~` to the shell. Before the prefix match
    // the fallback fired on the fully-spelled row above and on NONE of these,
    // measured in a coreutils 9.1 container with the home gone either way.
    ['both-fire', 'rm --rec --force ~', 'the abbreviation W2-q measured deleting a home'],
    ['both-fire', 'rm --r -f ~', 'one letter is still unambiguous to getopt_long'],
    ['both-fire', 'rm --rec --fo ~', 'both flags abbreviated'],
    ['both-fire', 'rm --recursiv ~', 'one character short of the full spelling'],
    ['both-fire', 'rm --re ~', 'recursion alone, per P2.178'],
    ['both-fire', 'rm --d --f ~', '`--dir` abbreviated, force pairing intact'],

    // ── both quiet: the qualifiers hold in both readings ──────────────────
    ['both-quiet', 'echo hello', 'no removal anywhere'],
    ['both-quiet', 'rm -rf ~/projects/scratch', 'a NARROWER target is not the home directory'],
    ['both-quiet', 'echo "some note # rm -rf ~"', 'a `#` is not a command separator to either'],
    ['both-quiet', 'ls -la ~', 'not a removal command'],
    ['both-quiet', 'rm -rf ./build', 'an ordinary relative target'],
    // P2.91's guard rail. `git rm` is a DIFFERENT command and `git` is not an
    // enforcement wrapper, so widening the fallback through `sudo` must not
    // widen it through anything that merely precedes an `rm` word. This row
    // fails the moment either matcher starts skipping arbitrary head words.
    ['both-quiet', 'git rm -rf ~', 'git is not a wrapper in either reading'],

    // P2.91 moved these three into agreement, and the bucket declaration is
    // what makes the move impossible to land silently. The fallback now asks
    // `stripSubcommand` to remove an enforcement-wrapper prefix before it looks
    // for `rm`, because on unparseable text it is the only floor there is.
    ['both-fire', 'sudo rm -rf ~', 'the fallback now strips the same wrappers the enforcement pass does'],
    ['both-fire', 'doas rm -rf ~', 'same class'],
    ['both-fire', 'nohup rm -rf ~', 'same class'],
    ['both-fire', 'env rm -rf ~', 'an `env` prefix, stripped by the same call'],
    ['both-fire', 'FOO=bar rm -rf ~', 'a leading assignment is part of the same prefix'],
    // P2.312's census moved this one. `env -S` is named as a stripped wrapper in
    // this module's header and in `findShRemoval`, so `structured-only` was the
    // floor present for `env rm -rf ~` and absent for the `-S` spelling of the
    // same command — on the slice where the fallback is the ONLY floor.
    ['both-fire', 'env -S "rm -rf ~"', 'the `-S` script form, now past the quote in the cheap bail'],
    ['both-quiet', `echo "env -S 'rm -rf ~'"`, 'and the same bytes QUOTED are still nobody\'s command'],

    // ── structured only: everything the weaker matcher cannot see ─────────
    ['structured-only', 'rmdir ~', 'the fallback reads `rm` only, and rmdir takes no -rf'],
    // P2.312 moved this row out of `structured-only`: the fallback now asks the
    // SAME `findDeleteOperands` the structured scan does, so the two matchers
    // agree on `find`. The declaration is the record of that, not a smoothing —
    // a narrowed traversal (`find ~ -name '*.tmp' -delete`) is `both-quiet`
    // below, and both halves are pinned in the P2.312 tests above.
    ['both-fire', 'find ~ -delete', 'a removal spelled as a traversal, now read by both'],
    ['both-quiet', "find ~ -name '*.tmp' -delete", 'a traversal NARROWED to a subset removes cleanup, not the home'],
    ['structured-only', 'if true; then rm -rf ~; fi', 'the fallback walks no compound-command bodies'],
    // THE DIFFERENTIAL FOUND THIS, and it corrects a premise the P2.144 lane
    // held while writing the fallback: the STRUCTURED scan requires no flags at
    // all — it fires on any `rm` whose operand resolves to the root or the home
    // directory. P2.178 closed the recursion half of that gap after measuring
    // that a bare `-r` deletes the tree; the rows below are what is LEFT, and
    // they are left deliberately. Closing them means firing on `rm ~`, which
    // was measured to remove nothing (`is a directory`, exit 1) — an owner
    // call, not a maintenance edit.
    ['structured-only', 'rm -f ~', 'force without recursion — structured has no flag rule'],
    ['structured-only', 'rm ~', 'no flags at all — and it removes nothing when run'],
    ['structured-only', 'rm --dir ~', '`--dir` alone removes nothing; the fallback wants force with it'],
    ['structured-only', `sh -c 'rm -rf ~'`, 'nor a script operand'],

    // ── textual only: where the weaker reading is WRONGER, on purpose ─────
    // These are the rows that justify confining the fallback to text the
    // structured scan could not read. Every one is a false positive it would
    // introduce if it ran everywhere.
    ['textual-only', 'echo "hi; rm -rf ~"', 'quoting is invisible to a word scanner'],
    ['textual-only', `echo 'hi; rm -rf /'`, 'ditto for single quotes'],

  ]

  const classify = (command: string): Bucket => {
    const structured = findRootOrHomeRemoval(command, { home: HOME, platform: 'darwin' })
    const textual = findTextualRemoval(command, HOME)
    if (structured && textual) return 'both-fire'
    if (structured) return 'structured-only'
    if (textual) return 'textual-only'
    return 'both-quiet'
  }

  test.each(corpus)('[%s] %s', (bucket, command) => {
    // Every row PARSES, so `findRootOrHomeRemoval` here IS the structured
    // matcher — the fallback cannot have contributed to the verdict.
    expect(splitCompoundCommand(command)).not.toBeNull()
    expect(classify(command)).toBe(bucket)
  })

  test('the harness has a positive control in every direction', () => {
    // Without this, a corpus that drifted until it contained only agreements
    // would keep passing while proving nothing — and a "no disagreements found"
    // result is exactly what a dead differential looks like.
    const seen = new Set(corpus.map(([bucket]) => bucket))
    expect(seen).toEqual(new Set<Bucket>(['both-fire', 'both-quiet', 'structured-only', 'textual-only']))
    for (const bucket of seen) {
      expect(corpus.filter(([b]) => b === bucket).length).toBeGreaterThan(0)
    }
  })

  test('the structured matcher is strictly stronger on parseable text', () => {
    // The one INVARIANT relating the two, and the reason the weaker one is safe
    // to add: on text that parses, anything the textual matcher finds in command
    // position with an unquoted operand, the structured matcher finds too. The
    // converse is false, and the `structured-only` rows above are why. (That
    // sentence used to carry a count. P2.91 moved three rows out of the bucket
    // and the count was still "nine" — a number nothing checks is a number that
    // rots, so it is gone rather than corrected.)
    const textualOnly = corpus
      .filter(([bucket]) => bucket === 'textual-only')
      .map(([, command]) => command)
    // Every textual-only row must owe its disagreement to QUOTING — the single
    // documented weakness — and not to some new one nobody described.
    for (const command of textualOnly) {
      expect(command).toMatch(/["']/)
    }
  })
})

describe('the cmd/cmdlet partition is ONE value (P2.84)', () => {
  /**
   * The guarantee this row asked for is a TYPE, not a test: `REMOVAL_HEAD_SHELL`
   * is a `Record<PowerShellRemovalHead, …>` over a union COMPUTED from
   * `CMDLET_ALIAS_TABLE`, so adding a removal alias breaks the BUILD at the one
   * site that has to classify it. That was verified by probe: adding
   * `deltree: 'remove-item'` to the alias table produced
   * `TS2741: Property 'deltree' is missing in type … but required in type
   * 'Record<PowerShellRemovalHead, RemovalHeadShell>'`, and the probe was
   * reverted by exact reverse replacement with the file hash confirmed back to
   * its pre-probe value.
   *
   * What the rows below pin is the OBSERVABLE partition the record produces, so
   * a wrong classification is a failing test and not just a silent posture
   * change. They deliberately do NOT compare two lists — that would only prove
   * the lists agree with each other, the shape P2.94 rejected.
   */
  const CMD_BUILTIN_HEADS = ['del', 'erase', 'rd', 'rmdir']
  /**
   * `rm` is absent on purpose, and it is not a hole: the sh scan runs FIRST and
   * intercepts `rm` before the Windows scan ever sees it, so
   * `rm -Exclude <home> -Path ./logs -Recurse` resolves `<home>` as an sh
   * operand. Measured on the PARENT commit as well as this one, so it is
   * pre-existing behaviour in the over-fire direction and not a regression of
   * this change. Asserted below rather than left implicit.
   */
  const CMDLET_HEADS = ['Remove-Item', 'ri']

  // Kills: reclassifying a cmd builtin as parameter-binding — the UNDER-FIRE
  // direction, and exactly what a silently-drifted list would do. In a real cmd
  // shell `-Include` is a FILENAME, so the token after it is still a target.
  test('a cmd builtin binds no parameters, so every token stays a target', () => {
    for (const head of CMD_BUILTIN_HEADS) {
      const command = `${head} -Include ${HOME} /s /q`
      expect(findRootOrHomeRemoval(command, { home: HOME, platform: 'win32' }), command)
        .toMatchObject({ target: 'home' })
    }
  })

  // Kills: reclassifying a cmdlet as a cmd builtin, which brings back P2.51's
  // false deny — `Remove-Item -Exclude <home> -Path ./logs` SPARES the home and
  // must not raise a prompt saying it removes it.
  test('a cmdlet head skips exactly one token per non-target parameter', () => {
    for (const head of CMDLET_HEADS) {
      const command = `${head} -Exclude ${HOME} -Path ./logs -Recurse`
      expect(findRootOrHomeRemoval(command, { home: HOME, platform: 'win32' }), command)
        .toBeNull()
    }
  })

  // Pins the `rm` exception the comment above describes, so a future reader does
  // not mistake it for the partition misclassifying a cmdlet.
  test('`rm` is intercepted by the sh scan before the partition applies', () => {
    expect(findRootOrHomeRemoval(`rm -Exclude ${HOME} -Path ./logs -Recurse`,
      { home: HOME, platform: 'win32' })).toMatchObject({ target: 'home' })
  })

  // Non-vacuity: the two groups above must be distinguishable at all, i.e. the
  // same command shape really does differ across the partition.
  test('the partition is observable — the same shape differs across it', () => {
    const cmdSide = findRootOrHomeRemoval(`del -Exclude ${HOME} -Path ./logs -Recurse`,
      { home: HOME, platform: 'win32' })
    const cmdletSide = findRootOrHomeRemoval(`ri -Exclude ${HOME} -Path ./logs -Recurse`,
      { home: HOME, platform: 'win32' })
    expect(cmdSide).not.toBeNull()
    expect(cmdletSide).toBeNull()
  })
})

describe('the floor resolves a PowerShell HOST (P2.160)', () => {
  /**
   * A REAL oracle, obtained for this row: `pwsh 7.6.5` (macOS arm64, homebrew).
   * Every argv claim below was EXECUTED against it with a payload that writes a
   * marker inside the lane sandbox, through the lane's refusal guard; the
   * marker's presence was the verdict. The one thing still unexecuted is the
   * `cmd /c` half — there is no `cmd` on this host and none could be obtained —
   * so `cmd` is deliberately NOT modelled rather than modelled unexecuted.
   *
   * Measured RAN: `-Command`, `-command`, `-COMMAND`, `-c`, `-C`, `-Co`, `-Com`,
   * `-Comm`, `-Comma`, `-Comman`; `-File`, `-file`, `-f`, `-Fi`, `-Fil`;
   * `-EncodedCommand`, `-encodedcommand`, `-e`, `-E`, `-ec`, `-en`, `-enc`,
   * `-Encoded`. Measured did NOT run: `-Cm`, `-Cmd`, `-Command:<script>`,
   * `-Command=<script>`, `/Command`, `/c`, a `--` before the script, a bare
   * script with no parameter, and a UTF-8 (rather than UTF-16LE) base64 payload.
   */
  const hostCases: string[] = [
    'powershell -Command "Remove-Item -Recurse -Force ~"',
    'pwsh -Command "Remove-Item -Recurse -Force ~"',
    'pwsh -c "Remove-Item -Recurse -Force ~"',
    'pwsh -C "Remove-Item -Recurse -Force ~"',
    'pwsh -Comman "Remove-Item -Recurse -Force ~"',
    'powershell -command "Remove-Item -Recurse -Force ~"',
    'powershell -COMMAND "Remove-Item -Recurse -Force ~"',
    'pwsh -nop -c "Remove-Item -Recurse -Force ~"',
    'pwsh -NoProfile -Command "Remove-Item -Recurse -Force ~"',
    'powershell -ExecutionPolicy Bypass -Command "Remove-Item -Recurse -Force ~"',
    'pwsh -noni -nop -c "Remove-Item -Recurse -Force ~"',
    '/opt/homebrew/bin/pwsh -c "Remove-Item -Recurse -Force ~"',
    'powershell.exe -Command "Remove-Item -Recurse -Force ~"',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -Command "Remove-Item -Recurse -Force ~"',
    'pwsh -c "rm -Recurse -Force ~"',
    'pwsh -c "del -Recurse -Force ~"',
    // Nested hosts, within the depth bound.
    'pwsh -c "pwsh -c \'Remove-Item -Recurse -Force ~\'"',
  ]

  // Kills: reverting the host resolution, or narrowing the parameter rule to the
  // full `-Command` spelling. Every row here returned null on BOTH platforms on
  // the parent commit while the bare `Remove-Item -Recurse -Force ~` fired.
  test('a home removal inside a host invocation still fires', () => {
    for (const command of hostCases) {
      expect(detect(command), command).toMatchObject({ target: 'home' })
    }
  })

  // Kills: a resolver that accepts a spelling the host REFUSES. Modelling a
  // string nobody can execute is the P2.142 trap, and each of these was measured
  // NOT to run on the real pwsh — so the floor must not claim to have caught a
  // removal that never happens. (`-Cm`/`-Cmd` are not prefixes of `command`.)
  test('a spelling the real host refuses is not modelled as a removal', () => {
    for (const command of [
      'pwsh -Cm "Remove-Item -Recurse -Force ~"',
      'pwsh -Cmd "Remove-Item -Recurse -Force ~"',
      'pwsh -Command:"Remove-Item -Recurse -Force ~"',
      'pwsh -Command="Remove-Item -Recurse -Force ~"',
      'pwsh /Command "Remove-Item -Recurse -Force ~"',
      'pwsh /c "Remove-Item -Recurse -Force ~"',
    ]) {
      expect(detect(command), command).toBeNull()
    }
  })

  // Kills: decoding -EncodedCommand as UTF-8, or not decoding it at all. Both
  // payloads below decode to `Remove-Item -Recurse -Force ~`; the encoding is
  // UTF-16LE because that is what the real host accepted (UTF-8 did not run).
  test('an -EncodedCommand payload is DECODED, not skipped', () => {
    const encoded = 'UgBlAG0AbwB2AGUALQBJAHQAZQBtACAALQBSAGUAYwB1AHIAcwBlACAALQBGAG8AcgBjAGUAIAB+AA=='
    for (const flag of ['-EncodedCommand', '-encodedcommand', '-e', '-E', '-ec', '-enc', '-Encoded']) {
      const command = `powershell ${flag} ${encoded}`
      expect(detect(command), command).toMatchObject({ target: 'home' })
    }
  })

  // Kills: turning an UNREADABLE script into a prompt. This matcher's contract
  // is to NAME the target it found, and a `-File` path or an undecodable payload
  // has no name — so it must yield nothing rather than a prompt about a target
  // it invented. The row said plainly not to model -EncodedCommand without
  // decoding it, and this is the other half of obeying that.
  test('a script the floor cannot read yields no prompt', () => {
    for (const command of [
      'pwsh -File wipe.ps1',
      'pwsh -f ./wipe.ps1',
      'powershell -EncodedCommand !!!notbase64!!!',
    ]) {
      expect(detect(command), command).toBeNull()
    }
  })

  // Kills: a resolver that fires on any command mentioning a host, and a
  // recursion with no bound. The first two are ordinary in-workspace removals.
  test('an in-workspace removal inside a host is still not a prompt', () => {
    for (const command of [
      'pwsh -c "Remove-Item -Recurse -Force ./build"',
      'powershell -Command "Remove-Item ./dist"',
      'ls -la',
      'echo "pwsh -c Remove-Item -Recurse -Force ~"'.replace('~', './x'),
    ]) {
      expect(detect(command), command).toBeNull()
    }
  })

  // Kills: wiring the host resolver into ONE of the two authorities. The ladder
  // is a DENY in every mode including `bypassPermissions`, so a spelling it
  // cannot see is strictly worse than one the breaker cannot see. Measured on
  // the parent commit: every row here was null while its bare form denied.
  test('the ladder deny sees the host layer too', () => {
    const rows: Array<[command: string, ladderCase: string]> = [
      ['pwsh -c "Remove-Item -Recurse -Force /usr"', 'system-path'],
      ['pwsh -c "Remove-Item *"', 'wildcard'],
      ['powershell -Command "Remove-Item ./build/*"', 'wildcard'],
      // base64 of `Remove-Item *` — and this one is why the resolver runs BEFORE
      // the `looksLikePowerShell` gate: base64 names no Verb-Noun cmdlet, so
      // with the call placed after the gate it was null on darwin and a deny on
      // win32, i.e. the same command answered two ways.
      ['powershell -e UgBlAG0AbwB2AGUALQBJAHQAZQBtACAAKgA=', 'wildcard'],
    ]
    for (const [command, ladderCase] of rows) {
      for (const platform of ['darwin', 'win32'] as const) {
        expect(findRemoveItemLadderDeny(command, { home: HOME, platform }), `${command} @${platform}`)
          .toMatchObject({ ladderCase })
      }
    }
    // Non-vacuity in both directions.
    expect(findRemoveItemLadderDeny('pwsh -c "Remove-Item ./build"',
      { home: HOME, platform: 'win32' })).toBeNull()
  })

  // Kills: regressing the sh half P2.151 closed while adding the PowerShell
  // half. These are that row's rows, re-asserted as this one's positive control.
  test('the sh half of the floor is unchanged', () => {
    for (const command of ['rm -rf ~', 'bash -c "rm -rf ~"', 'sh -c "rm -rf ~"']) {
      expect(detect(command), command).toMatchObject({ target: 'home' })
    }
  })
})

/**
 * P2.388 — a PowerShell removal behind an sh wrapper was null on BOTH platforms
 * while the same spelling fired bare.
 *
 * The two languages met different halves of one function. `findShRemoval`
 * balances `sh -c "..."`, `stripSubcommand` unwraps the `-c` script exactly as
 * it does for `rm`, and the stripped head is `Remove-Item` — a name no POSIX
 * `REMOVAL_COMMANDS` set contains — so the subcommand was dropped, while the
 * PowerShell scan only ever ran on the WHOLE command one level up. That made a
 * shell wrapper a way past a floor with no mode to switch out of.
 *
 * The recorded reason for leaving it open — that closing it means running the
 * Windows scan over word soup, and `looksLikePowerShell` fires on 8.39% of real
 * sh commands — conflated being SCANNED with FIRING. The quiet set below is the
 * measurement that separates them, and it is the same shape that refuted the
 * `find … -delete` decline: ask the real predicate and let it fail closed.
 *
 * SAFETY: every string here is DATA handed to a matcher against a FAKE home.
 * Nothing in this file spawns, removes or opens anything.
 */
describe('P2.388 — the wrapper strip reads PowerShell too', () => {
  const detect = (command: string, platform: NodeJS.Platform) =>
    findRootOrHomeRemoval(command, { home: HOME, platform })

  const WRAPPED = [
    ['sh -c', `sh -c "Remove-Item -Recurse -Force ${HOME}"`],
    ['bash -lc', `bash -lc "Remove-Item -Recurse -Force ${HOME}"`],
    ['sudo sh -c', `sudo sh -c "Remove-Item -Recurse -Force ${HOME}"`],
    ['command substitution', `echo $(Remove-Item -Recurse -Force ${HOME})`],
    ['process substitution', `diff <(Remove-Item -Recurse -Force ${HOME}) b`],
  ] as const

  for (const platform of ['darwin', 'win32'] as const) {
    test(`fires through an sh wrapper on ${platform}, as it always did bare`, () => {
      // The control first: the bare spelling has never been the broken one, so
      // without it a green row here could mean the whole scan stopped working.
      expect(detect(`Remove-Item -Recurse -Force ${HOME}`, platform)).toMatchObject({ target: 'home' });
      for (const [label, command] of WRAPPED) {
        expect(detect(command, platform), `${platform} / ${label}`).toMatchObject({ target: 'home' });
      }
      // The POSIX twin, which always worked: the two languages now agree about
      // what a wrapper is, which is the actual invariant.
      expect(detect(`sh -c "rm -rf ${HOME}"`, platform)).toMatchObject({ target: 'home' });
    })
  }

  test('stays quiet on ordinary sh text that merely NAMES a removal', () => {
    // The scan fails CLOSED on word soup — the property the recorded blocker
    // assumed away. Two of these carry a COMPLETE, valid removal spelling as
    // quoted text and must still not fire.
    const QUIET = [
      `cat <<EOF\nGet-Content ${HOME}\nEOF`,
      `grep -r Remove-Item ${HOME}`,
      `ls ${HOME} | while read f; do echo $f; done`,
      `printf "Remove-Item -Recurse -Force %s" ${HOME} > script.ps1`,
      `echo "Remove-Item -Recurse -Force ${HOME}" >> notes.md`,
      `git commit -m "document Remove-Item -Recurse -Force ${HOME}"`,
      `sh -c "echo Remove-Item -Recurse -Force ${HOME} >> notes.md"`,
      `sh -c "grep -r Remove-Item ${HOME}"`,
      `awk "/Remove-Item/ {print}" ${HOME}/log.txt`,
      `rg --files ${HOME} | xargs -I{} echo Remove-Item {}`,
    ]
    for (const platform of ['darwin', 'win32'] as const) {
      for (const command of QUIET) {
        expect(detect(command, platform), `${platform} / ${command.slice(0, 48)}`).toBeNull();
      }
    }
  })

  test('RESIDUE, pinned so it is not mistaken for coverage: a PowerShell host inside an sh span', () => {
    // `findPowerShellHostRemoval` recurses, and calling it from the span loop
    // would reset its own depth bound, so the termination argument would rest on
    // the text shrinking rather than on a constant. One spelling stays null,
    // deliberately, and this row is where that is written down rather than
    // discovered.
    expect(detect(`sh -c "pwsh -c 'Remove-Item -Recurse -Force ${HOME}'"`, 'darwin')).toBeNull();
  })
})
