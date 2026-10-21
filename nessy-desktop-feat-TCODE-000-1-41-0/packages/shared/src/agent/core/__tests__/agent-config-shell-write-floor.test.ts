/**
 * C3.353 — the SHELL half of the protected-path floor.
 *
 * ## What was measured, and where
 *
 * Rig day R2 (packaged 1.36.0, HEAD `70d269e46`), case RS-12's hazard arm: the
 * agent wrote a repository's own `.codex/rules/*.rules` through `Bash` —
 * `/bin/zsh -lc "mkdir -p <repo>/.codex/rules && printf 'prefix_rule(…)' >
 * <repo>/.codex/rules/x.rules"` — with `fileWritten: true`, `cards approved: 0`
 * and the file-tool floor's own sentence (*"Project agent configuration is
 * read-only for file tools"*) nowhere in the transcript. The SAME case proves
 * codex then READS such a file: its refusal quoted that file's own
 * justification string.
 *
 * Re-confirmed at HEAD before this file existed, with both controls:
 *   - `Write {file_path:'/repo/.codex/rules/a'}` -> floor `protectedPath`
 *   - `Bash {command:"printf x > /repo/.codex/rules/a"}` -> NO floor
 *   - `Bash {command:'ls -la'}` -> NO floor  (negative control)
 * and `apps/electron/resources/permissions/default.json` names none of these
 * directories in `deniedPaths` (`grep -c codex` -> 0), so nothing else on the
 * shell path was gating them either.
 *
 * ## Native mechanism (read, not invented)
 *
 * Codex protects exactly these names itself — `codex-rs/protocol/src/permissions.rs`
 * `default_read_only_subpaths_for_writable_root` at the shipped tag
 * `rust-v0.150.1` makes `<root>/.git`, `<root>/.agents` and `<root>/.codex`
 * read-only subpaths of a writable root — but those carveouts hang off the
 * `WorkspaceWrite` filesystem policy, and this product ships the sandbox OFF, so
 * `codexSandboxConfigForMode` emits `sandbox_mode: 'danger-full-access'` and the
 * carveouts never exist. The host is therefore the seam, for all three runtimes.
 *
 * SAFETY: every string here is DATA handed to a pure matcher. Nothing in this
 * file spawns a process, touches a real home directory, or creates a file.
 */
import { describe, expect, it } from 'bun:test';
import {
  findNonNegotiableFloors,
  firstNonNegotiableFloor,
} from '../pre-tool-use.ts';
import {
  AGENT_CONFIG_DIRS,
  SHELL_GATED_AGENT_CONFIG_DIRS,
  agentConfigDirectoryInPath,
} from '../../session-filesystem-scope.ts';
import { PROTECTED_FILES } from '../../pi-harness/protected-paths.ts';
import { PERMISSION_MODE_AGENT_LABELS, PERMISSION_MODE_ORDER, type PermissionMode } from '../../mode-types.ts';

/** A stand-in repository root. Never touched — these are strings. */
const R = '/repo';

/** Shell calls that WRITE into an agent-config directory. Each fires the floor. */
const GATED_WRITES: Array<[label: string, command: string, entry: string]> = [
  [
    'the R2 shape: a nested zsh -lc whose redirect no AST sees through',
    `/bin/zsh -lc "mkdir -p ${R}/.codex/rules && printf 'prefix_rule(pattern=[\\"touch\\"])' > ${R}/.codex/rules/x.rules"`,
    '.codex',
  ],
  ['a plain absolute redirect', `printf x > ${R}/.codex/rules/x.rules`, '.codex'],
  ['a relative append', 'printf x >> .codex/rules/x.rules', '.codex'],
  ['a heredoc written to a file', 'cat <<EOF > .agents/x.md\nhi\nEOF', '.agents'],
  ['a quoted redirect target', `printf x > "${R}/.codex/config.toml"`, '.codex'],
  ['cp into the directory', `cp /tmp/evil.rules ${R}/.codex/rules/x.rules`, '.codex'],
  ['mv into the directory', `mv /tmp/evil.rules ${R}/.agents/x.md`, '.agents'],
  ['mkdir of the directory itself', `mkdir -p ${R}/.codex/rules`, '.codex'],
  ['rm of the directory', `rm -rf ${R}/.claude`, '.claude'],
  ['tee after a pipe', 'printf x | tee ~/.claude/settings.json', '.claude'],
  ['an unexpanded $HOME spelling', 'cp a "$HOME/.nessy-agent/skills/x/SKILL.md"', '.nessy-agent'],
  ['a braced ${HOME} spelling', 'cp a ${HOME}/.codex/config.toml', '.codex'],
  ['a second command in a chain', `ls -la && cp a ${R}/.codex/x`, '.codex'],
];

/**
 * Shell calls that READ the very same paths, or write somewhere else entirely.
 * None fires — this is the half the row's `done_means` names ("a read of the
 * same path is untouched"), and the half a floor keyed on "the command mentions
 * `.codex`" would fail.
 */
const UNTOUCHED: Array<[label: string, command: string]> = [
  ['cat of a rules file', `cat ${R}/.codex/rules/x.rules`],
  ['grep -r over the directory', `grep -r touch ${R}/.codex/rules`],
  ['ls of the directory', 'ls -la .codex/rules'],
  ['head of a claude settings file', 'head -n 20 ~/.claude/settings.json'],
  ['a read whose redirect lands elsewhere', `cat ${R}/.codex/rules/x.rules > /tmp/out`],
  ['a write that names no agent-config path', 'printf x > /tmp/out'],
  ['a mutating command elsewhere', 'cp a.txt build/a.txt'],
  ['a chain that mutates only build output', 'mkdir -p build && cp a.txt build/a.txt'],
  ['a bare listing', 'ls -la'],
  ['a name that merely contains the string', 'printf x > .codexrc'],
  ['a file whose basename ends in the string', `cp a ${R}/my.codex`],
];

describe('the agent-config directory list the shell gate reads', () => {
  it('is the file-tool floor\'s own list plus .claude, and nothing else', () => {
    // The relationship, not a hand-copied array: a directory added to the
    // file-tool floor reaches the shell gate on the same commit.
    expect(SHELL_GATED_AGENT_CONFIG_DIRS).toEqual([...AGENT_CONFIG_DIRS, '.claude']);
    expect(AGENT_CONFIG_DIRS).toContain('.codex');
  });

  it('matches on a SEGMENT, in every spelling the gate can meet', () => {
    for (const spelling of [
      '.codex/rules/x',
      `${R}/.codex/rules/x`,
      '~/.codex/config.toml',
      '$HOME/.codex/config.toml',
      'C:\\repo\\.codex\\rules\\x',
      '.codex',
    ]) {
      expect(agentConfigDirectoryInPath(spelling)).toBe('.codex');
    }
  });

  it('does not match a name that merely contains one', () => {
    expect(agentConfigDirectoryInPath('.codexrc/x')).toBeNull();
    expect(agentConfigDirectoryInPath('/repo/my.codex')).toBeNull();
    expect(agentConfigDirectoryInPath('/repo/src/index.ts')).toBeNull();
  });

  it('deliberately does NOT name .git', () => {
    // The boundary this list is drawn at. `.git` is in the FILE-tool protected
    // set and must stay out of the shell one: `git commit` writes there on every
    // turn, and `session-filesystem-scope.ts` says git-via-shell "remains the
    // only writer". A `.git` entry here would refuse it.
    expect(agentConfigDirectoryInPath(`${R}/.git/hooks/pre-commit`)).toBeNull();
    expect(SHELL_GATED_AGENT_CONFIG_DIRS).not.toContain('.git');
  });
});

describe('a shell write into an agent-config directory raises the protected-path floor', () => {
  it.each(GATED_WRITES)('%s', (_label, command, entry) => {
    const floors = findNonNegotiableFloors('Bash', { command }, 'default');
    expect(floors.protectedPathWrite?.entry).toBe(entry);
    expect(floors.protectedPathWrite?.kind).toBe('directory');
  });

  it('reaches the same verdict a file-tool write reaches, as a prompt', () => {
    const verdict = firstNonNegotiableFloor(
      findNonNegotiableFloors('Bash', { command: `printf x > ${R}/.codex/rules/x.rules` }, 'default'),
    );
    expect(verdict?.floor).toBe('protectedPath');
    expect(verdict?.outcome).toBe('prompt');
    // The description must name the directory: a prompt indistinguishable from
    // every other prompt collects the same reflexive approval.
    expect(verdict?.description).toContain('.codex');
  });

  it('covers Monitor, which uses the same permission rules as Bash', () => {
    const floors = findNonNegotiableFloors('Monitor', { command: 'printf x > .codex/rules/x.rules' }, 'default');
    expect(floors.protectedPathWrite?.entry).toBe('.codex');
  });
});

describe('a read of the same path is untouched', () => {
  it.each(UNTOUCHED)('%s', (_label, command) => {
    const floors = findNonNegotiableFloors('Bash', { command }, 'default');
    expect(floors.protectedPathWrite).toBeNull();
    expect(firstNonNegotiableFloor(floors)).toBeNull();
  });
});

describe('the floor takes the file-tool path\'s own per-mode posture', () => {
  const modes: PermissionMode[] = PERMISSION_MODE_ORDER;
  const HAZARD = `printf x > ${R}/.codex/rules/x.rules`;

  it('covers every mode the product ships', () => {
    // Guards the table below against a truncated PERMISSION_MODE_ORDER by comparing
    // it, as a set, with a Record<PermissionMode, …> the compiler holds
    // exhaustive over the union — never a hand count, which went stale when
    // F1.1050 retired `explore` (seven modes -> six).
    expect(Object.keys(PERMISSION_MODE_AGENT_LABELS).sort()).toEqual([...modes].sort());
    expect(modes).toContain('bypassPermissions');
  });

  it.each(modes.filter(mode => mode !== 'bypassPermissions'))('fires in %s', mode => {
    expect(findNonNegotiableFloors('Bash', { command: HAZARD }, mode).protectedPathWrite).not.toBeNull();
  });

  it('does not fire in bypassPermissions, exactly as the file-tool arm does not', () => {
    // `protectedPathOutcome` is the shared table. This floor is the documented
    // protected-path floor reaching a new vector, not a stricter one: making it
    // survive `bypassPermissions` would make that mode stop being what it says.
    expect(
      findNonNegotiableFloors('Bash', { command: HAZARD }, 'bypassPermissions').protectedPathWrite,
    ).toBeNull();
    expect(
      findNonNegotiableFloors('Write', { file_path: `${R}/.codex/rules/x.rules` }, 'bypassPermissions')
        .protectedPathWrite,
    ).toBeNull();
  });
});

describe('the file-tool arm is unchanged', () => {
  // Regression controls: the shell arm was added by widening ONE branch, so the
  // documented protected set must still answer for a file tool — including the
  // entries the shell list deliberately leaves out.
  it.each([
    [`${R}/.codex/rules/x.rules`, '.codex'],
    [`${R}/.git/hooks/pre-commit`, '.git'],
    [`${R}/.claude/settings.json`, '.claude'],
    ['/home/u/.zshrc', '.zshrc'],
  ])('Write to %s still fires as %s', (filePath, entry) => {
    expect(findNonNegotiableFloors('Write', { file_path: filePath }, 'default').protectedPathWrite?.entry)
      .toBe(entry);
  });

  it('a non-shell tool whose input merely contains the text is not a shell write', () => {
    // The floor is about a shell WRITE. A `Read` carrying such a path is a read,
    // and the file-tool branch is the one that judges file tools.
    expect(findNonNegotiableFloors('Read', { file_path: `${R}/.codex/rules/x.rules` }, 'default')
      .protectedPathWrite).toBeNull();
  });
});

/**
 * C4.50 — the shell gate reaches the protected FILES (owner decision
 * 2026-09-13, option B).
 *
 * MEASURED AT HEAD FIRST, which is the premise the row was decided on:
 * `Bash {command:'printf "evil" >> ~/.zshrc'}` returned NO floor, while
 * `Write {file_path:'/home/u/.zshrc'}` returned `{entry:'.zshrc',kind:'file'}` —
 * the same byte written two ways getting two answers, with the OS sandbox (the
 * governor `protected-paths.ts` §Known limits named) OFF by standing owner
 * decision. `git commit` and `cat ~/.zshrc` were null then and must stay null
 * now: those are the two controls that separate B from option C and from a gate
 * that fires on a read.
 */
describe('C4.50 · a shell write to a protected FILE raises the same card the file tool raises', () => {
  const GATED_FILE_WRITES: Array<[label: string, command: string, entry: string]> = [
    ['the persistence vector the row was born for', 'printf "evil" >> ~/.zshrc', '.zshrc'],
    ['an absolute redirect into a repository .npmrc', `printf x > ${R}/.npmrc`, '.npmrc'],
    ['a relative redirect into bunfig.toml', 'printf x > bunfig.toml', 'bunfig.toml'],
    ['a quoted redirect target', `printf x > "${R}/.gitconfig"`, '.gitconfig'],
    ['a heredoc written to a shell rc', 'cat <<EOF > ~/.bash_profile\nhi\nEOF', '.bash_profile'],
    ['cp onto a protected file', `cp /tmp/evil ${R}/pyrightconfig.json`, 'pyrightconfig.json'],
    ['mv onto a protected file', 'mv /tmp/evil ~/.zprofile', '.zprofile'],
    ['tee after a pipe', 'printf x | tee ~/.gitconfig', '.gitconfig'],
    ['an unexpanded $HOME spelling', 'cp a "$HOME/.envrc"', '.envrc'],
    ['a nested zsh -lc, the R2 wrapper shape', `/bin/zsh -lc "printf 'x' >> ${R}/.npmrc"`, '.npmrc'],
    ['a vendored copy, matched on the basename as the file tool matches it', `printf x > ${R}/vendor/p/.npmrc`, '.npmrc'],
  ];

  it.each(GATED_FILE_WRITES)('%s', (_label, command, entry) => {
    const floors = findNonNegotiableFloors('Bash', { command }, 'default');
    expect(floors.protectedPathWrite?.entry).toBe(entry);
    expect(floors.protectedPathWrite?.kind).toBe('file');
  });

  it('reaches the file tool\'s own verdict, and names the file on the card', () => {
    const shell = firstNonNegotiableFloor(
      findNonNegotiableFloors('Bash', { command: 'printf "evil" >> ~/.zshrc' }, 'default'),
    );
    const fileTool = firstNonNegotiableFloor(
      findNonNegotiableFloors('Write', { file_path: '~/.zshrc' }, 'default'),
    );
    expect(shell?.floor).toBe('protectedPath');
    expect(shell?.outcome).toBe('prompt');
    expect(shell?.description).toContain('.zshrc');
    // The whole point of the row: one byte, two vectors, ONE answer. The
    // descriptions are identical because both come from
    // `describeProtectedPathWrite` over the same hit shape.
    expect(shell).toEqual(fileTool);
  });

  it('reads the SAME array the file tool reads, not a copy of it', () => {
    // A file added to `PROTECTED_FILES` reaches the shell gate on the same
    // commit. Table-driven over the whole list rather than a sample, so a future
    // entry cannot be half-wired.
    expect(PROTECTED_FILES.length).toBeGreaterThanOrEqual(37);
    for (const entry of PROTECTED_FILES) {
      expect(
        findNonNegotiableFloors('Bash', { command: `printf x > ${R}/${entry}` }, 'default')
          .protectedPathWrite?.entry,
      ).toBe(entry);
    }
  });

  it('NEGATIVE — git commit keeps working, which is why .git is not in the shell set', () => {
    // Option C of the row, refuted by a live pin rather than by argument. `.git`
    // is a protected DIRECTORY; the shell gate takes its directories from
    // `SHELL_GATED_AGENT_CONFIG_DIRS` and its files from `PROTECTED_FILES`, and
    // neither carries `.git`. A shell gate calling `findProtectedPathWrite`
    // instead would refuse every one of these.
    for (const command of [
      'git commit -F /tmp/msg -- packages/shared/src/a.ts',
      'git add -- a.ts',
      `git -C ${R} commit -F /tmp/msg -- a.ts`,
      `printf x > ${R}/.git/hooks/pre-commit`,
    ]) {
      expect(findNonNegotiableFloors('Bash', { command }, 'default').protectedPathWrite).toBeNull();
    }
  });

  it('NEGATIVE — a READ of a protected file is untouched, and so is a near-miss name', () => {
    for (const command of [
      'cat ~/.zshrc',
      `head -n 20 ${R}/.npmrc`,
      'grep -r registry ~/.npmrc',
      // The redirect lands elsewhere: reading 1 judges the right-hand side only.
      'cat ~/.zshrc > /tmp/out',
      // Near-misses on the basename rule.
      'printf x > ~/.zshrc.bak',
      `printf x > ${R}/my.npmrc`,
      `printf x > ${R}/bunfig.tom`,
      // A write that names no protected path at all.
      'printf x > /tmp/out',
    ]) {
      expect(findNonNegotiableFloors('Bash', { command }, 'default').protectedPathWrite).toBeNull();
    }
  });

  it('takes the same per-mode table as the file arm, and covers Monitor', () => {
    const command = 'printf "evil" >> ~/.zshrc';
    // `protectedPathOutcome` is the shared table and it is what turns this hit
    // into a denial in `dontAsk` — `firstNonNegotiableFloor` renders every
    // protected-path hit as `prompt` and is not the mode reader, which is why
    // the per-mode assertion is on the MATCH firing rather than on its verdict.
    for (const mode of PERMISSION_MODE_ORDER.filter(m => m !== 'bypassPermissions')) {
      expect(findNonNegotiableFloors('Bash', { command }, mode).protectedPathWrite?.entry)
        .toBe('.zshrc');
    }
    expect(findNonNegotiableFloors('Bash', { command }, 'bypassPermissions').protectedPathWrite)
      .toBeNull();
    // ...exactly as the file tool's own arm is skipped there.
    expect(
      findNonNegotiableFloors('Write', { file_path: '~/.zshrc' }, 'bypassPermissions').protectedPathWrite,
    ).toBeNull();
    expect(findNonNegotiableFloors('Monitor', { command }, 'default').protectedPathWrite?.entry)
      .toBe('.zshrc');
  });
});

describe('the seam that carries this to all three runtimes', () => {
  it('is the shared floor pair, which codex reaches with a Bash subject', () => {
    // `codex-agent.ts`'s `floorVerdict` calls exactly this pair, and
    // `codexApprovalFloorSubjects` renders a `command` approval as
    // `{toolName:'Bash', input:{command}}` — including, for the v1 shape, every
    // argv WORD on its own, which is how the `-lc` script slot keeps its
    // quoting. So the subject below is the one codex actually presents.
    const subject = { toolName: 'Bash', input: { command: `printf x > ${R}/.codex/rules/x.rules` } };
    const verdict = firstNonNegotiableFloor(
      findNonNegotiableFloors(subject.toolName, subject.input, 'default'),
    );
    expect(verdict?.floor).toBe('protectedPath');
  });

  it('the eval floor still outranks it, and both still fire on their own shapes', () => {
    // The ordering `firstNonNegotiableFloor` documents. `eval` wins because what
    // actually runs is not visible in the text; the protected-path description
    // would name a path the shell may never write.
    const both = findNonNegotiableFloors(
      'Bash',
      { command: `eval "printf x > ${R}/.codex/rules/x.rules"` },
      'default',
    );
    expect(both.shellEvalConstruct).not.toBeNull();
    expect(both.protectedPathWrite).not.toBeNull();
    expect(firstNonNegotiableFloor(both)?.floor).toBe('shellEval');
  });

  it('does not disturb the removal circuit breaker, which bypassPermissions never skips', () => {
    expect(
      findNonNegotiableFloors('Bash', { command: 'rm -rf ~' }, 'bypassPermissions').removalCircuitBreaker,
    ).not.toBeNull();
  });
});

/**
 * C3.378 — reading 2 stops being a positive word list.
 *
 * The list above is the FALLBACK path (no permissions context), and every case
 * in this file up to here exercises it, so those pins keep meaning what they
 * meant. This block is the CLASSIFIER path: the same floor asked with a
 * context, which routes reading 2 through `bash-validator.ts` symbol
 * `scanBashWriteVectors` — the gate's own merged read/write decision, the one
 * the worktree-isolation floor in the same file already runs.
 *
 * SAFETY: unchanged from the header — every string here is data handed to a pure
 * matcher, and `/fixture/workspace` is not a real directory.
 */
/**
 * A context whose merged config really carries read-only patterns.
 *
 * Necessary, and the reason is itself a finding: `mode-types.ts`'s
 * `SAFE_MODE_CONFIG` ships `readOnlyBashPatterns: []` with the comment *"Empty
 * fallbacks — actual patterns loaded from default.json"*, and `bun test` runs
 * against an isolated config dir where that file has never been written. So a
 * bare `{ workspaceRootPath }` context here would measure the EMPTY-allowlist
 * branch and prove nothing about the classifier. The patterns are pinned through
 * `pinnedConfigs`, which `permissions-config.ts` documents as the context that
 * "never reads a source file" — so this stays a pure matcher test with no
 * filesystem in it, exactly as the header promises.
 *
 * The five patterns are copied verbatim from the shipped
 * `apps/electron/resources/permissions/default.json`, and they are the only ones
 * the reads below need.
 */
const CTX = {
  workspaceRootPath: '/fixture/workspace',
  pinnedConfigs: [{
    config: {
      allowedBashPatterns: [
        { pattern: '^cat\\b' },
        { pattern: '^ls\\b' },
        { pattern: '^grep\\b' },
        { pattern: '^head\\b' },
        { pattern: '^find\\b' },
      ],
      allowedMcpPatterns: [],
      allowedApiEndpoints: [],
      allowedWritePaths: [],
      deniedPaths: [],
      deniedToolPatterns: [],
      allowedTools: [],
      disallowedTools: [],
      toolRules: [],
      blockedTools: [],
      blockedCommandHints: [],
    },
  }],
};

/** The same workspace with NO patterns pinned — the empty-allowlist branch. */
const CTX_NO_PATTERNS = { workspaceRootPath: '/fixture/workspace-empty' };

/**
 * The residue the word list NAMED as out of reach, verbatim from its own
 * docblock: an in-place editor, an archive extraction, an inline interpreter.
 */
const CLASSIFIER_ONLY_WRITES: Array<[label: string, command: string, entry: string]> = [
  ['sed -i, the in-place editor', `sed -i 's/a/b/' ${R}/.codex/config.toml`, '.codex'],
  ['perl -i, the same shape', `perl -pi -e 's/a/b/' ${R}/.claude/settings.json`, '.claude'],
  ['tar extraction into the directory', `tar -xf payload.tar -C ${R}/.codex`, '.codex'],
  ['unzip into the directory', `unzip payload.zip -d ${R}/.agents`, '.agents'],
  ['an inline python interpreter', `python3 -c "open('${R}/.codex/rules/x.rules','w')"`, '.codex'],
  ['an inline node interpreter', `node -e "require('fs').writeFileSync('${R}/.agents/x.md','')"`, '.agents'],
];

describe('C3.378 · the classifier path catches what the word list could not', () => {
  it.each(CLASSIFIER_ONLY_WRITES)('%s', (_label, command, entry) => {
    expect(findNonNegotiableFloors('Bash', { command }, 'default', CTX).protectedPathWrite?.entry)
      .toBe(entry);
  });

  it('CONTROL — every one of them is INVISIBLE without a context, which is the row', () => {
    // The negative half of the pair above. If this ever goes green-by-accident
    // (the word list grows a member), the arms above stop proving the classifier
    // is what caught them, so the two are asserted together.
    for (const [, command] of CLASSIFIER_ONLY_WRITES) {
      expect(findNonNegotiableFloors('Bash', { command }, 'default').protectedPathWrite).toBeNull();
    }
  });

  it('every write the word list already caught is caught by the classifier too', () => {
    // No regression in the other direction: the fallback is a subset, never a
    // capability the context path loses.
    for (const [, command, entry] of GATED_WRITES) {
      expect(findNonNegotiableFloors('Bash', { command }, 'default', CTX).protectedPathWrite?.entry)
        .toBe(entry);
    }
  });

  it('BOUNDARY — every untouched command stays untouched, reads included', () => {
    // The property the row must not cost, and the reason only the `cwd` vector
    // counts: `cat <repo>/.codex/rules/x > /tmp/out` produces a `path` vector for
    // `/tmp/out` and no `cwd` one, so reading 2 does not fire on a read whose
    // redirect lands elsewhere.
    for (const [, command] of UNTOUCHED) {
      expect(findNonNegotiableFloors('Bash', { command }, 'default', CTX).protectedPathWrite).toBeNull();
    }
  });

  it('an EMPTY read-only allowlist falls back rather than calling every read a write', () => {
    // The guard, and the half that would have shipped a real defect: with no
    // `default.json` loaded the classifier answers WRITE for everything,
    // including `cat`. Both arms, so the branch is pinned in both directions.
    expect(findNonNegotiableFloors(
      'Bash',
      { command: `cat ${R}/.codex/rules/x.rules` },
      'default',
      CTX_NO_PATTERNS,
    ).protectedPathWrite).toBeNull();
    // ...and the word list still works there, so the fallback is a fallback and
    // not a hole.
    expect(findNonNegotiableFloors(
      'Bash',
      { command: `cp a ${R}/.codex/x` },
      'default',
      CTX_NO_PATTERNS,
    ).protectedPathWrite?.entry).toBe('.codex');
  });

  it('the other three floors are unmoved by the new parameter', () => {
    // It is read by exactly one floor. Asserted in both directions so a future
    // edit that threads it further has to come back through this test.
    expect(findNonNegotiableFloors('Bash', { command: 'rm -rf ~' }, 'default', CTX).removalCircuitBreaker)
      .not.toBeNull();
    expect(findNonNegotiableFloors('Bash', { command: 'eval "ls"' }, 'default', CTX).shellEvalConstruct)
      .not.toBeNull();
    expect(findNonNegotiableFloors('Bash', { command: 'ls -la' }, 'default', CTX))
      .toEqual(findNonNegotiableFloors('Bash', { command: 'ls -la' }, 'default'));
  });

  it('bypassPermissions still skips it, context or not', () => {
    const command = `sed -i 's/a/b/' ${R}/.codex/config.toml`;
    expect(findNonNegotiableFloors('Bash', { command }, 'bypassPermissions', CTX).protectedPathWrite)
      .toBeNull();
    expect(findNonNegotiableFloors('Monitor', { command }, 'default', CTX).protectedPathWrite?.entry)
      .toBe('.codex');
  });

  /**
   * C4.50 on the CLASSIFIER path — the half that carries the widening, asserted
   * in BOTH directions so the residue is pinned rather than described.
   *
   * The blast radius of reading 2 over the 37 file names could not be MEASURED:
   * the read-only command corpus is the instrument (`bun scripts/command-corpus.ts
   * stats`, the copy named by `NESSY_COMMAND_CORPUS`) and it SKIPped with
   * *"NESSY_COMMAND_CORPUS is not set"* on this machine, 2026-09-13. So the
   * arms below pin what the widening does and does not do on the shapes we can
   * name, and the named narrowing (file arm on reading 1 only) is recorded on
   * `pre-tool-use.ts` symbol `shellGatedProtectedEntry`.
   */
  it('C4.50 · an in-place edit of a protected file fires ONLY with a context', () => {
    const command = `sed -i 's/a/b/' ${R}/.npmrc`;
    expect(findNonNegotiableFloors('Bash', { command }, 'default', CTX).protectedPathWrite?.entry)
      .toBe('.npmrc');
    // Without a context the word list answers, and `sed` is not one of its
    // words — the same asymmetry C3.378 records for the directories.
    expect(findNonNegotiableFloors('Bash', { command }, 'default').protectedPathWrite).toBeNull();
  });

  it('C4.50 · a provably read-only command naming a protected file still does not fire', () => {
    // The property the widening must not cost. `cat`/`grep`/`head` are in the
    // pinned allowlist, so the classifier proves them read-only and no `cwd`
    // vector is produced.
    for (const command of [`cat ${R}/.npmrc`, `grep -r registry ${R}/.npmrc`, 'head -n 5 ~/.zshrc']) {
      expect(findNonNegotiableFloors('Bash', { command }, 'default', CTX).protectedPathWrite).toBeNull();
    }
  });
});

/**
 * F1.858 (origin SIT-y, 2026-09-25) — the card must not call a READ a write.
 *
 * Measured on the packaged Pi build: a `Bash` listing of the session's own
 * folder, which sits under `<config>/sessions/` and so inside `.nessy-agent`,
 * raised this floor worded "This writes to the protected directory …". Reading 2
 * fires on a command the classifier cannot PROVE read-only (fail-closed, C3.378),
 * so what it knows is "unproven", not "writes"; only a redirect target (reading 1)
 * is a write it has seen. The card is kept — the posture is unchanged — and says
 * which of the two it is.
 */
describe('F1.858 · a command the classifier cannot prove read-only is not called a write', () => {
  const SESSION = '~/.nessy-agent/workspaces/w/sessions/s';

  it('a listing of the session folder keeps its card, and the card does not claim a write', () => {
    // RED before F1.858: "This writes to the protected directory `.nessy-agent` …".
    const floor = firstNonNegotiableFloor(findNonNegotiableFloors('Bash', { command: `du -sh ${SESSION}` }, 'plan', CTX));
    expect(floor?.floor).toBe('protectedPath');
    expect(floor?.description.startsWith('This writes to')).toBe(false);
    expect(floor?.description).toContain('could not be confirmed as read-only');
    expect(floor?.description).toContain('.nessy-agent');
  });

  it('CONTROL: a redirect into the same folder is a write the gate has seen, and still says so', () => {
    const floor = firstNonNegotiableFloor(findNonNegotiableFloors('Bash', { command: `printf x > ${SESSION}/x` }, 'plan', CTX));
    expect(floor?.floor).toBe('protectedPath');
    expect(floor?.description.startsWith('This writes to the protected directory `.nessy-agent`')).toBe(true);
  });
});

/**
 * F1.672 (DN-084, 2026-09-26) — the protected-path shell floor follows the
 * command's own `cd`/`pushd` chain for a RELATIVE redirect target.
 *
 * MEASURED before (WJ-crit-h P-WJcrith-1, default-install layout): `cd <root> &&
 * printf '{}' > hooks.json` answered an ordinary, rememberable Bash card while
 * the absolute spelling answered the non-negotiable protected-path card — the
 * floor matches SEGMENTS of the path the command names, and the relative target
 * `hooks.json` names none. The floor has no cwd (see `agentConfigDirectoryInPath`),
 * so only a directory the command itself `cd`s into is followed.
 */
describe('F1.672 · a relative redirect reached through the command\'s own cd', () => {
  /** A workspace root on the default layout: its path carries the `.nessy-agent` segment. */
  const ROOT = '~/.nessy-agent/workspaces/w';

  it.each([
    ['the P-WJcrith-1 shape: cd into the workspace root, then a relative write', `cd ${ROOT} && printf '{}' > hooks.json`, '.nessy-agent'],
    ['cd into a repository .codex, then a relative rules file', `cd ${R}/.codex && printf x > rules/x.rules`, '.codex'],
    ['a relative cd, then an append', 'cd .agents && printf x >> x.md', '.agents'],
    ['cd -P, whose option word is skipped (F1.692\'s follower)', `cd -P ${R}/.claude && echo x > settings.json`, '.claude'],
    ['a quoted redirect target after the cd', `cd ${R}/.codex; printf x > "config.toml"`, '.codex'],
  ])('%s', (_label, command, entry) => {
    const floors = findNonNegotiableFloors('Bash', { command }, 'default');
    expect(floors.protectedPathWrite?.entry).toBe(entry);
    expect(floors.protectedPathWrite?.kind).toBe('directory');
    // A redirect target is a write the gate has SEEN (F1.858): the card says "writes".
    expect(floors.protectedPathWrite?.access).toBeUndefined();
    expect(firstNonNegotiableFloor(floors)?.floor).toBe('protectedPath');
  });

  it('CONTROL: the absolute spelling keeps the same card, and both name the same directory', () => {
    const absolute = findNonNegotiableFloors('Bash', { command: `printf '{}' > ${ROOT}/hooks.json` }, 'default');
    const viaCd = findNonNegotiableFloors('Bash', { command: `cd ${ROOT} && printf '{}' > hooks.json` }, 'default');
    expect(absolute.protectedPathWrite?.entry).toBe('.nessy-agent');
    expect(viaCd.protectedPathWrite?.entry).toBe(absolute.protectedPathWrite?.entry);
    expect(firstNonNegotiableFloor(viaCd)?.description).toContain('hooks.json');
    expect(findNonNegotiableFloors('Bash', { command: `cd ${ROOT} && printf '{}' > hooks.json` }, 'bypassPermissions')
      .protectedPathWrite).toBeNull();
  });

  it.each([
    ['an unrelated cd', 'cd /tmp && printf \'{}\' > hooks.json'],
    ['an fd duplication is not a file', `cd ${R}/.codex && ls 2>&1`],
    ['a > inside a quoted argument is not a redirect', `cd ${R}/.codex && grep -n "a > b" rules/x.rules`],
    ['the cd comes after the write', `printf x > out.txt && cd ${R}/.codex`],
    ['an absolute target elsewhere', `cd ${R}/.codex && cat rules/x.rules > /tmp/out`],
  ])('NEGATIVE — %s', (_label, command) => {
    expect(findNonNegotiableFloors('Bash', { command }, 'default').protectedPathWrite).toBeNull();
  });
});
