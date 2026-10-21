/**
 * The denied-path floor against a command the SHELL has not finished writing.
 *
 * ## What was measured at HEAD, and what it cost (P6.673, born from W8-x's
 * P6.544 measurement 2026-09-07)
 *
 * `shouldAllowToolInMode` is the ONE request-side gate all three runtimes reach
 * (`core/pre-tool-use.ts`, `claude-agent.ts`, `pi-agent.ts`, `codex-agent.ts`),
 * and the `deniedPaths` check sits ABOVE its `bypassPermissions` early return —
 * so one mode's answer is every mode's answer, and one hole is a hole on all
 * three runtimes at once. Driven against the shipped floor with a fake `HOME`,
 * denied file `~/.aws/credentials`, three positive controls REFUSED and two
 * negative controls ALLOWED in the same run:
 *
 *   REFUSED   cat <home>/.aws/credentials          (positive control, literal)
 *   REFUSED   Read {file_path: <home>/.aws/credentials}
 *   REFUSED   cat .env                             (positive control)
 *   REFUSED   cat ~/.aws/credentials
 *   REFUSED   cat <home>/.aws/cred[star]           glob on the FILE
 *   REFUSED   cd <home>/.aws && cat credentials
 *   ALLOWED   cat $HOME/.aws/credentials           <-- THE HOLE, no glob at all
 *   ALLOWED   cat "$HOME"/.aws/credentials
 *   ALLOWED   cat ${HOME}/.aws/credentials
 *   ALLOWED   cat $HOME/.aws/cred[star]
 *   ALLOWED   cat <home>/.a[star]/credentials      glob on the DIRECTORY
 *   ALLOWED   D=.aws; cat $HOME/$D/credentials
 *   ALLOWED   cat $(echo $HOME/.aws/credentials)
 *   ALLOWED   cat .en[star]
 *   ALLOWED   cat $HOME/Documents/[star].txt       (negative control)
 *   ALLOWED   echo hello                           (negative control)
 *
 * Four facts, and the row's own title understates two of them:
 *
 * 1. **`$HOME` alone is enough. No glob is needed.** `extractShellPathTokens`
 *    tokenises the raw command string and the matcher compares the token to the
 *    pattern; `$HOME/.aws/credentials` is not a path, it is a string starting
 *    with a dollar sign.
 * 2. **`~` is NOT a hole**, because the matcher expands it in the PATTERN. So
 *    two spellings a user would call identical gave opposite verdicts.
 * 3. **A glob only escapes in the segment the pattern spells LITERALLY.** A
 *    star on the file name after a literal `.aws/` was already refused, because
 *    the pattern's own trailing wildcard swallows the star character; a star
 *    inside the directory name was not, because the pattern requires the
 *    letters `aws`.
 * 4. **Punctuation splits a path into harmless pieces.** Quotes and braces both
 *    end the token class, so the quoted and braced spellings never produced a
 *    path token at all.
 *
 * ## Native mechanism (owner rule 2026-08-28)
 *
 * None per runtime, and that is a finding rather than an omission. Claude's own
 * posture is explicitly NOT to resolve the shell —
 * `permissions.md#read-and-edit`: "Read and Edit deny rules apply to Claude's
 * built-in file tools, to file commands Claude Code recognizes in Bash, such as
 * `cat`, `head`, `tail`, and `sed`, and to the targets of Bash redirections such
 * as `> file` and `< file`. They don't apply to arbitrary subprocesses that read
 * or write files indirectly, like a Python or Node script that opens files
 * itself. For OS-level enforcement that blocks all processes from accessing a
 * path, enable the sandbox." — and `permissions.md#bash` names a shell variable
 * among the spellings its own Bash rules do not follow ("Variables:
 * `URL=http://github.com && curl $URL`"), pointing at the sandbox or a
 * PreToolUse hook. Codex's answer is likewise its OS sandbox policy. Both
 * sandboxes are OFF here by standing owner decision (2026-08-12/13), so this
 * host gate is the only read-side floor there is, and it stays ONE gate
 * (native-first option 2) rather than three.
 *
 * ## What the fix deliberately does NOT do
 *
 * It does not resolve the shell. Resolving `$(…)` and arbitrary variables means
 * implementing one, and a partial resolver is worse than none because it makes
 * the gate look complete. It resolves the two spellings of the home directory a
 * user actually means, and everything else it cannot read it treats as
 * UNRESOLVED and refuses only where the unresolved part could stand for a
 * segment a denied pattern spells out.
 *
 * SAFETY: every path here is DATA handed to a glob matcher, under a FAKE home
 * directory below a temp path. Nothing in this file opens, creates, deletes or
 * executes anything, and no command naming a real home directory or the
 * filesystem root is ever run.
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import { homedir } from 'node:os';
import { shouldAllowToolInMode } from '../mode-manager.ts';
import { PERMISSION_MODE_ORDER, type PermissionMode } from '../mode-types.ts';

// Same value and reason as `credential-read-floor.test.ts`: `mode-manager.ts` is
// a heavy import and bun's 5s default sits close to its resting cost on a cold
// module graph (measured by W8-x: ~70s for the plugin barrel on this rig, and
// `user 0.08 / sys 0.05` against `real 23.17` for one module — it is I/O wait,
// not compute, so it scales with how many lanes are running).
setDefaultTimeout(30_000);

const HOME = homedir();

/** The verdict the floor gives, reduced to the one bit this file is about. */
function floorVerdict(toolName: string, toolInput: unknown, mode: PermissionMode): 'REFUSED' | 'ALLOWED' {
  const result = shouldAllowToolInMode(toolName, toolInput, mode);
  // Narrowed the way `denied-path-windows-separators.test.ts` narrows it:
  // `denyPathBlocked` lives only on the refusal arm of `ToolCheckResult`, and a
  // refusal for any OTHER reason is not what this file is measuring.
  return result.allowed === false && result.denyPathBlocked === true ? 'REFUSED' : 'ALLOWED';
}

function bash(command: string, mode: PermissionMode): 'REFUSED' | 'ALLOWED' {
  return floorVerdict('Bash', { command }, mode);
}

/**
 * Every arm W8-x drove, with the verdict it MUST give now. The three positive
 * and two negative controls stay in the table rather than in a separate block:
 * a floor that refuses everything passes the first thirteen and fails the last
 * two, and a floor that refuses nothing does the reverse.
 */
const SHELL_SPELLING_ARMS: ReadonlyArray<readonly [
  label: string,
  command: string,
  expected: 'REFUSED' | 'ALLOWED',
]> = [
  // --- positive controls: already correct at HEAD, and must stay correct ---
  ['literal absolute path', `cat ${HOME}/.aws/credentials`, 'REFUSED'],
  ['literal .env, relative', 'cat .env', 'REFUSED'],
  ['tilde, literal rest', 'cat ~/.aws/credentials', 'REFUSED'],
  ['glob on the FILE after a literal directory', `cat ${HOME}/.aws/cred*`, 'REFUSED'],
  ['cd into the denied directory', `cd ${HOME}/.aws && cat credentials`, 'REFUSED'],

  // --- the holes, in the order W8-x measured them ---
  ['$HOME with no glob at all', 'cat $HOME/.aws/credentials', 'REFUSED'],
  ['quoted "$HOME", which splits the token', 'cat "$HOME"/.aws/credentials', 'REFUSED'],
  ['braced ${HOME}, which also splits the token', 'cat ${HOME}/.aws/credentials', 'REFUSED'],
  ['$HOME plus a glob on the file', 'cat $HOME/.aws/cred*', 'REFUSED'],
  ['glob on the DIRECTORY the pattern spells literally', `cat ${HOME}/.a*/credentials`, 'REFUSED'],
  ['a variable assembled from an earlier assignment', 'D=.aws; cat $HOME/$D/credentials', 'REFUSED'],
  ['command substitution', 'cat $(echo $HOME/.aws/credentials)', 'REFUSED'],
  ['a dotfile reached by a glob that spells its own prefix', 'cat .en*', 'REFUSED'],

  // --- negative controls: the floor must NOT refuse these ---
  ['$HOME under a directory nothing denies', 'cat $HOME/Documents/*.txt', 'ALLOWED'],
  ['a command naming no path at all', 'echo hello', 'ALLOWED'],
];

/**
 * The commands a bare wildcard is actually written for. Every one of these was
 * REFUSED by the first version of the fix — a wildcard that constrains nothing
 * was allowed to stand for `id_rsa` — and 9 of 25 ordinary commands failing is
 * a product regression, not a safety fix. They are cases, not a footnote,
 * because the rule that keeps them open (bash leaves `dotglob` off, and a glob
 * earns a substitution only by spelling a character of its own) is the part a
 * later "tightening" is most likely to undo.
 */
const ORDINARY_COMMANDS: string[] = [
  'ls dist/*',
  'cat build/*',
  'cp dist/* /tmp/out/',
  'rm -rf tmp/*',
  'chmod +x scripts/*',
  'ls node_modules/*',
  'mv build/* release/',
  'ls apps/electron/dist/*',
  'cat src/*.ts',
  'cat src/config/*.json',
  'cat packages/*/package.json',
  'tail -20 logs/*.log',
  'cat $PWD/README.md',
  'cd $TMPDIR && ls',
  'echo "$(pwd)/out"',
  'cat $HOME/.config/nvim/init.lua',
  'ls ~/Documents',
  'find . -name "*.ts"',
  'git diff -- packages/shared/src/agent/mode-manager.ts',
];

describe('denied-path floor: the shell spellings of a denied path (P6.673)', () => {
  describe.each(SHELL_SPELLING_ARMS)('%s', (_label, command, expected) => {
    it(`is ${expected}`, () => {
      expect(bash(command, 'default')).toBe(expected);
    });
  });

  it('gives the same verdict in EVERY mode, because the floor sits above the bypass return', () => {
    // Not a repetition of the table: the reason this hole was worth fixing once
    // rather than per mode is that `getDeniedPathViolation` runs before
    // `bypassPermissions` short-circuits. If that ever moves, this fails while
    // every case above still passes.
    for (const mode of PERMISSION_MODE_ORDER) {
      expect(bash('cat $HOME/.aws/credentials', mode)).toBe('REFUSED');
      expect(bash('echo hello', mode)).toBe('ALLOWED');
    }
  });

  it('reads $HOME on the file tools too, not only inside a Bash command', () => {
    expect(floorVerdict('Read', { file_path: '$HOME/.aws/credentials' }, 'default')).toBe('REFUSED');
    // Pi's `read` sends `path`, not `file_path` — the vocabulary
    // `denied-path-tool-vocabulary.test.ts` pins. The expansion must reach both.
    expect(floorVerdict('Read', { path: '${HOME}/.aws/credentials' }, 'default')).toBe('REFUSED');
  });

  it('names the pattern it refused on, so the user can see WHICH rule fired', () => {
    const result = shouldAllowToolInMode('Bash', { command: 'cat $HOME/.aws/credentials' }, 'default');
    expect(result.allowed).toBe(false);
    expect(result.allowed === false ? result.reason : '').toContain('~/.aws/**');
  });

  describe('does not refuse the commands a bare wildcard is written for', () => {
    it.each(ORDINARY_COMMANDS)('%s', (command) => {
      expect(bash(command, 'default')).toBe('ALLOWED');
    });
  });

  it('still refuses a wildcard that SPELLS the denied name', () => {
    // The boundary between the two blocks above, stated as a case: `dist/*` is
    // open and `dist/id_rs*` is not, and the only difference is whether the
    // token spells characters of its own.
    expect(bash('cat dist/*', 'default')).toBe('ALLOWED');
    expect(bash('cat dist/id_rs*', 'default')).toBe('REFUSED');
    expect(bash(`cat ${HOME}/.ss*/id_rsa`, 'default')).toBe('REFUSED');
  });
});

/**
 * F1.761 — a QUOTED heredoc body is text, and its backticks are characters.
 *
 * Measured at HEAD 2026-09-26 (DN-029, re-driving WJ-crit-u's probe, which met
 * the refusal in SIT-f and SIT-g): writing a markdown plan whose body puts a
 * path in backticks was refused by the double-star dot-env entry in all
 * four quoted spellings and in the `$(cat <<'EOF' … EOF)` commit-message form,
 * while the same body with the backticks removed was allowed. The token reader
 * scans the whole command string, so a backtick-wrapped path in the body was
 * taken for P6.673's unreadable command substitution, and a substitution can
 * stand for the `.env` segment. The fix (`quoted-heredoc-backticks.ts`) covered
 * the four quoted spellings at the top level. F1.1081 (DN-278, 2026-09-29) also
 * covers the commit-message form — a quoted heredoc opened inside `$(…)`, even
 * when that `$(…)` sits in a double quote — and a single-quoted string, whose
 * backticks are literal text as well.
 *
 * The shell's own rule (bash(1), "Here Documents"): "If any characters in word
 * are quoted, the delimiter is the result of quote removal on word, and the
 * lines in the here-document are not expanded." An UNQUOTED body is expanded,
 * so there a backtick IS a real substitution and stays refused.
 */
const BT = '`';
const QUOTED_HEREDOC_ARMS: ReadonlyArray<readonly [label: string, command: string, expected: 'REFUSED' | 'ALLOWED']> = [
  // --- the false refusals: the body is literal text ---
  ['<<\'EOF\' body with a backticked path', `cat > plans/x.md <<'EOF'\n# Plan\nEdit ${BT}src/foo.ts${BT} next\nEOF`, 'ALLOWED'],
  ['<<"EOF" body with a backticked path', `cat > plans/x.md <<"EOF"\nEdit ${BT}src/foo.ts${BT}\nEOF`, 'ALLOWED'],
  ['<<\\EOF body with a backticked path', `cat > plans/x.md <<\\EOF\nEdit ${BT}src/foo.ts${BT}\nEOF`, 'ALLOWED'],
  ['<<-\'EOF\' tab-indented body and delimiter', `cat > plans/x.md <<-'EOF'\n\tEdit ${BT}src/foo.ts${BT}\n\tEOF`, 'ALLOWED'],
  ['two quoted heredocs opened on one line', `cat <<'A' <<'B'\n${BT}src/a.ts${BT}\nA\n${BT}src/b.ts${BT}\nB`, 'ALLOWED'],

  // --- controls: what the shell really expands stays refused ---
  ['an UNQUOTED <<EOF body, where the backtick is a real substitution', `cat > plans/x.md <<EOF\nEdit ${BT}src/foo.ts${BT}\nEOF`, 'REFUSED'],
  ['a real substitution on the line AFTER the delimiter', `cat > x.md <<'EOF'\nhello\nEOF\ncat ${BT}echo src/foo.ts${BT}`, 'REFUSED'],
  ['a here-string, which the shell expands', `cat <<< "${BT}src/foo.ts${BT}"`, 'REFUSED'],
  // --- controls: the quoted body is still READ, only its backticks are literal ---
  ['a literal credential path in a quoted body run by bash', `bash <<'EOF'\ncat ~/.aws/credentials\nEOF`, 'REFUSED'],
  ['$HOME in a quoted body run by bash (P6.673 stays closed)', `bash <<'EOF'\ncat $HOME/.aws/credentials\nEOF`, 'REFUSED'],
  ['a backticked credential path in a quoted body', `cat > x.md <<'EOF'\nsee ${BT}~/.aws/credentials${BT}\nEOF`, 'REFUSED'],
  // --- F1.1081: the same literal text one level down, and in single quotes.
  // The first arm was F1.761's stated residue, pinned REFUSED; all four were
  // measured REFUSED at HEAD 17acba032 before the fix.
  ['the "$(cat <<\'EOF\' …)" commit-message form', `git commit -m "$(cat <<'EOF'\nfix ${BT}src/foo.ts${BT}\nEOF\n)"`, 'ALLOWED'],
  ['a quoted heredoc in an unquoted $(…)', `msg=$(cat <<'EOF'\nfix ${BT}src/foo.ts${BT}\nEOF\n)`, 'ALLOWED'],
  ['a single-quoted commit message', `git commit -m 'fix ${BT}src/foo.ts${BT}'`, 'ALLOWED'],
  ['a single-quoted echo', `echo 'see ${BT}src/foo.ts${BT}'`, 'ALLOWED'],
  // --- F1.1081 boundaries: every real substitution, and every path read, stays refused ---
  ['an UNQUOTED heredoc in the commit-message form', `git commit -m "$(cat <<EOF\nfix ${BT}src/foo.ts${BT}\nEOF\n)"`, 'REFUSED'],
  ['a $(…) naming a credential in an UNQUOTED heredoc in the commit-message form', `git commit -m "$(cat <<EOF\nfix $(cat ~/.aws/credentials)\nEOF\n)"`, 'REFUSED'],
  ['a real substitution after the commit-message form closes', `git commit -m "$(cat <<'EOF'\nfix\nEOF\n)" && cat ${BT}echo src/foo.ts${BT}`, 'REFUSED'],
  ['a backtick in a DOUBLE-quoted message, which the shell runs', `git commit -m "fix ${BT}src/foo.ts${BT}"`, 'REFUSED'],
  ['an apostrophe inside double quotes opens no single quote', `git commit -m "it's ${BT}src/foo.ts${BT} now'"`, 'REFUSED'],
  ['an escaped apostrophe opens no single quote', `echo it\\'s ${BT}echo src/foo.ts${BT} ok\\'`, 'REFUSED'],
  ['an apostrophe in a comment opens no single quote', `# don't\ncat ${BT}echo src/foo.ts${BT}\n# it's`, 'REFUSED'],
  ['a backticked credential path in single quotes', `echo 'see ${BT}~/.aws/credentials${BT}'`, 'REFUSED'],
  ['a backticked credential path in the commit-message form', `git commit -m "$(cat <<'EOF'\nsee ${BT}~/.aws/credentials${BT}\nEOF\n)"`, 'REFUSED'],
  // --- a construct the F1.1081 reader does not model (a `case` arm's `)`) falls
  // back to F1.761's top-level pass (HEAD's reading), not to rewriting nothing.
  ['a quoted heredoc in a case arm keeps the F1.761 reading', `case x in a) cat > p.md <<'EOF'\n${BT}src/foo.ts${BT}\nEOF\n;; esac`, 'ALLOWED'],
  // --- stated residue (module docblock), pinned so a change to it is a decision:
  // an inner shell run on single-quoted text splices a name from backticks that
  // never spell it. REFUSED at HEAD 17acba032; the floor's documented reach
  // excludes subprocesses, and the sandbox is off by owner decision.
  ['residue: bash -c splicing a name from single-quoted backticks', `bash -c 'cat ~/.a${BT}echo ws${BT}/credentials'`, 'ALLOWED'],
];

describe('denied-path floor: a quoted heredoc body is not a command (F1.761)', () => {
  describe.each(QUOTED_HEREDOC_ARMS)('%s', (_label, command, expected) => {
    it(`is ${expected}`, () => {
      expect(bash(command, 'default')).toBe(expected);
    });
  });
});
