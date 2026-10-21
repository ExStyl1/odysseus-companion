/**
 * The command scanner's handling of tools that CAN EXECUTE, and of the reads it
 * must not refuse while doing so.
 *
 * Rows covered: P2.113 (sed's `e` execution primitive), P2.120 (a sed script
 * arriving through a parameter expansion), P2.121 (with `-e` present the first
 * filename was scanned as a script), P2.109 (awk's parenthesised comparison
 * over-blocked), P2.112 (six git reads over-blocked — and the operand fail-open
 * that closing it uncovered), plus the `find` write ACTIONS the P2.118 extent
 * sweep surfaced.
 *
 * Every case here was measured against the real scanner before it was written;
 * each `it` names the MUTATION it is here to kill, because a test that only
 * restates the implementation survives the mutation that matters.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { validateBashCommand, scanBashWriteVectors } from '../bash-validator.ts';

/**
 * The SHIPPED read-only allowlist, not a hand-made stand-in: these rows are all
 * about the interaction between the allowlist and the scanner, so a test using
 * invented patterns would prove nothing about the product.
 */
const allowlistPath = new URL(
  '../../../../../apps/electron/resources/permissions/default.json',
  import.meta.url,
);
const shipped = JSON.parse(readFileSync(allowlistPath, 'utf8')) as {
  allowedBashPatterns: { pattern: string }[];
};
const patterns = shipped.allowedBashPatterns.flatMap(entry => {
  try {
    return [{ regex: new RegExp(entry.pattern), source: entry.pattern }];
  } catch {
    return [];
  }
});

/** Plan mode's verdict: does the read-only gate let this command run? */
const planMode = (command: string): 'allow' | 'block' =>
  validateBashCommand(command, patterns).allowed ? 'allow' : 'block';

/** The isolation write-scan's verdict: `read` means it contributed NO vector. */
const isolation = (command: string): 'read' | 'write' =>
  scanBashWriteVectors(command, patterns).length === 0 ? 'read' : 'write';

describe('the allowlist entries these rows depend on', () => {
  // Kills: an allowlist edit that silently moves the ground under every case
  // below (e.g. dropping `^sed\s+-n\b`), which would make them pass vacuously
  // by blocking everything for the wrong reason.
  it('still ships the sed/awk/find/git read patterns the cases assume', () => {
    const sources = shipped.allowedBashPatterns.map(entry => entry.pattern);
    // P2.207 anchored these entries; the pins moved WITH them rather than being
    // softened, because this pin is what caught that row's one allow-path
    // regression (`git branch -av`, a CLUSTERED short flag its corpus lacked).
    expect(sources).toContain(String.raw`^sed\s+-n\b(?!.*\s-i)(?!.*\s--in-place\b)`);
    expect(sources).toContain(String.raw`^(?:gawk|mawk|nawk|awk)\b`);
    expect(sources).toContain(String.raw`^find\b`);
    expect(sources.some(source => source.startsWith('^git'))).toBe(true);
    // Non-vacuity: the helpers really do separate allow from block.
    expect(planMode('cat file.txt')).toBe('allow');
    expect(planMode('rm -rf /')).toBe('block');
  });
});

describe("P2.113 — sed's `e` executes a shell command", () => {
  // Kills: making the walk treat `e` as an ordinary command and walk PAST it,
  // which would let it prove the script CLEAN and suppress the residue test;
  // and disabling the `validateCommand` hook, which would leave plan mode
  // wide open while the isolation path still looked fixed.
  it('refuses the `e` COMMAND in plan mode, not only under isolation', () => {
    expect(planMode('sed -n \'e touch marker\' f')).toBe('block');
    expect(isolation('sed -n \'e touch marker\' f')).toBe('write');
  });

  // Kills: a flag run that walks past `e` instead of stopping on it.
  it('refuses the `e` FLAG on s/// under every delimiter', () => {
    for (const command of [
      "sed -n 's/.*/touch marker/e' f",
      "sed -n 's|.*|touch marker|e' f",
      "sed -n 's,.*,touch marker,e' f",
      "sed -n 's|a|b|gpe' f",
    ]) {
      expect(planMode(command), command).toBe('block');
      expect(isolation(command), command).toBe('write');
    }
  });

  // Kills: replacing the address walk with a `script.startsWith('e')` test, or
  // any check that only looks at the head of the script. Each of these hides the
  // `e` behind a different construct, which is exactly how the WRITE axis's `w`
  // defeated position-hunting.
  it('finds the `e` behind every address and separator form', () => {
    for (const command of [
      "sed -n '1e touch marker' f",          // numeric address
      "sed -n '/x/e touch marker' f",        // regex address
      "sed -n '1,5e touch marker' f",        // range
      "sed -n '1~2e touch marker' f",        // GNU first~step
      "sed -n '1!e touch marker' f",         // negation
      "sed -n '\\|x|e touch marker' f",      // \c…c custom delimiter
      "sed -n '/x/{e touch marker}' f",      // inside a block
      "sed -n 'p;e touch marker' f",         // after a `;`
      "sed -n 'p\ne touch marker' f",        // after a newline
      "sed -n 's/a/b/;e touch marker' f",    // after a completed s///
      "sed -n 'etouch marker' f",            // no space after the command
      "sed -n -e 'p' -e 'e touch marker' f", // in the SECOND -e
      "sed -n -e'e touch marker' f",         // attached -e value
    ]) {
      expect(planMode(command), command).toBe('block');
    }
  });

  // Kills: replacing the walk with the letter-absence test the WRITE axis uses
  // (`script.includes('e')`). That mutation passes every case above and refuses
  // all of these — which is precisely why the row said letter-absence cannot
  // close this axis.
  it('keeps the ordinary sed reads that merely CONTAIN the letter e', () => {
    for (const command of [
      "sed -n '/error/p' f",
      "sed -n 's/e/E/p' f",
      "sed -n 's/emphasis/EMPH/gp' f",
      "sed -n 'p' f",
      "sed -n '1,5p' f",
      "sed -n '$p' f",
      "sed -n '/^$/d;p' f",
      "sed -n '$!d;p' f",
      "sed -n 'y/abc/xyz/;p' f",
      "sed -n '\\|/etc/|p' f",
      "sed -n '/error/Ip' f",
      "sed -n '5q;p' f",
      "sed -n ':a;N;$!ba;p' f",
      "sed -n '/a/,+3p' f",
    ]) {
      expect(planMode(command), command).toBe('allow');
      expect(isolation(command), command).toBe('read');
    }
  });

  // Kills BOTH degenerate fallbacks: `return false` on `unparsed` (fail-open —
  // the first case would pass), and `return true` on `unparsed` (fail-closed
  // always — the second case would fail).
  it('fails closed on a script it cannot parse only when an `e` could hide there', () => {
    expect(planMode("sed -n 's/[/]/x/e' f")).toBe('block');
    expect(planMode("sed -n 'l80' f")).toBe('allow');
  });
});

describe('P2.121 — with -e present, a filename is not a script', () => {
  // Kills: removing `sawScriptOperand = true` from the `-e VALUE` branch, which
  // is what made `warnings.txt` get scanned and refused for its `w`.
  it('stops scanning the first FILENAME as a script', () => {
    for (const command of [
      "sed -n -e 'p' warnings.txt",
      "sed -n -e 'p' show.txt",
      "sed -n -e 'p' warnings.txt show.txt",
      "sed -n -e 'p' '*.log'", // quoted: since UA12.212 an UNQUOTED input glob is a write on its own
    ]) {
      expect(isolation(command), command).toBe('read');
    }
  });

  // Kills: removing `sawScriptOperand = true` from the `--expression=` branch
  // specifically — the case above leaves that branch untouched.
  it('stops scanning it for the --expression= spelling too', () => {
    expect(isolation("sed -n --expression='p' warnings.txt")).toBe('read');
  });

  // Kills: "fixing" P2.121 by not scanning `-e` scripts at all, which would open
  // the write axis it was carefully closed on.
  it('still scans the -e SCRIPTS themselves for the write primitive', () => {
    expect(isolation("sed -n -e 'p' -e 'w out.txt' f")).toBe('write');
    expect(isolation("sed -n 'w out.txt' f")).toBe('write');
    expect(isolation("sed -n 'wout' f")).toBe('write');
  });

  // The control that predates the fix and must not move.
  it('leaves the no-flag form alone', () => {
    expect(isolation("sed -n 'p' warnings.txt")).toBe('read');
  });
});

describe('P2.120 — a sed script carried by a parameter expansion', () => {
  // Kills: dropping the ParameterExpansion arm, or narrowing it back to
  // CommandExpansion only (which is what let the UNBRACED form through while
  // `${X}` was caught incidentally by the brace metacharacter).
  it('is a write, because the scanned text is not what sed will see', () => {
    expect(isolation('sed -n "$X" f')).toBe('write');
    expect(isolation('sed -n "${X}" f')).toBe('write');
    expect(isolation('sed -n "$(echo p)" f')).toBe('write');
    expect(isolation('sed -n -e "$X" f')).toBe('write');
  });

  // Kills: implementing this row as the `$` CHARACTER CLASS the row proposed.
  // `$p` is sed's last-line address and this repository's own scripts use it;
  // the AST records an expansion, the text cannot tell the two apart.
  it("does not mistake sed's last-line address `$` for an expansion", () => {
    expect(isolation("sed -n '$p' f")).toBe('read');
    expect(isolation("sed -n '$!d;p' f")).toBe('read');
  });
});

describe('P2.109 — awk `>` is a comparison inside parentheses', () => {
  // Kills: reverting to the single `print…>…` regex, which refused all of these.
  it('allows a parenthesised comparison, which writes nothing', () => {
    for (const command of [
      "awk 'BEGIN{print (a>b)}'",
      "awk '{print ($1>$2)}'",
      'awk \'BEGIN{printf("%d", a>b)}\'',
      "awk '{ if (print(a>b)) x }'",
    ]) {
      expect(planMode(command), command).toBe('allow');
      expect(isolation(command), command).toBe('read');
    }
  });

  // Kills: deleting the string-skip branch.
  it('allows a `>` that is a printed CHARACTER, not an operator', () => {
    expect(planMode('awk \'{print "a -> b"}\'')).toBe('allow');
    expect(planMode('awk \'{print "a>b"}\'')).toBe('allow');
  });

  // Kills: returning false unconditionally; treating every `>` as a comparison;
  // and a string-skip that swallows the operator after the string.
  it('still refuses every real redirect', () => {
    for (const command of [
      'awk \'BEGIN{print "x" > "/tmp/secret"}\'',
      'awk \'BEGIN{print "x" >> "/tmp/secret"}\'',
      "awk 'BEGIN{print > FILE}'",
      'awk \'BEGIN{print (a) > "/tmp/secret"}\'',
      'awk \'BEGIN{print ($1>$2) > "/tmp/secret"}\'',
      'awk \'BEGIN{print "a>b" > "/tmp/secret"}\'',
      'awk \'BEGIN{printf "x" > "/tmp/secret"}\'',
      'awk \'BEGIN{ if (1) print "x" > "/tmp/secret" }\'',
    ]) {
      expect(planMode(command), command).toBe('block');
      expect(isolation(command), command).toBe('write');
    }
  });

  // Kills: deleting any of awk's other three execution rules while editing this
  // function.
  it("leaves awk's other execution primitives refused", () => {
    expect(planMode('awk \'BEGIN{system("touch pwned")}\'')).toBe('block');
    expect(planMode('awk \'BEGIN{"id" | getline x}\'')).toBe('block');
    expect(planMode('awk \'BEGIN{print "x" | "sh"}\'')).toBe('block');
  });
});

describe('P2.112 — git proves a read through its SUBCOMMAND', () => {
  // Kills: reverting the per-subcommand flag sets.
  it('opens the six reads the allowlist already permits', () => {
    for (const command of [
      'git remote -v',
      'git branch -a',
      'git tag -l',
      'git config --get user.name',
      'git config -l',
      'git blame -L 1,10 file.ts',
    ]) {
      expect(planMode(command), command).toBe('allow');
      expect(isolation(command), command).toBe('read');
    }
  });

  // Kills: closing P2.112 with ONE FLAT flag set — the mistake the row warned
  // about, since `-a` lists for `branch` but CREATES for `tag`.
  //
  // The distinguishing case is `git branch -l`, and picking it took a measured
  // correction: the obvious pair (`branch -a` vs `tag -a v9`) does NOT
  // distinguish anything, because `v9` is an operand and the operand rule
  // refuses it whichever flag set is in force. A flat-union mutant survived that
  // assertion. `-l` has no operand to fall back on — `config`/`tag` declare it,
  // `branch` deliberately does NOT (before git 2.28 `git branch -l` is
  // `--create-reflog`) — so only a per-subcommand set refuses it.
  it('keeps each subcommand to its OWN flags', () => {
    expect(isolation('git branch -a')).toBe('read');
    expect(isolation('git tag -l')).toBe('read');
    expect(isolation('git config -l')).toBe('read');
    // Declared by `tag`/`config`, withheld from `branch`: a flat union loses this.
    expect(isolation('git branch -l')).toBe('write');
  });

  // Kills: declaring these subcommands `operandsAreInputs: true`, or dropping
  // the operand loop. Each of these carries NO flag and was PROVEN READ-ONLY
  // before this row; `git branch newbranch` and `git tag v9` were confirmed live
  // to really write a repository.
  it('refuses an operand that SELECTS AN ACTION', () => {
    for (const command of [
      'git branch newbranch',
      'git tag v9',
      'git remote add evil http://x',
      'git remote remove origin',
      'git reflog delete HEAD',
      'git reflog expire --all',
      'git branch -D main',
      'git branch -m old new',
      'git branch -l reflogged',
      'git tag -v v9',
    ]) {
      expect(isolation(command), command).toBe('write');
    }
  });

  // Kills: defaulting an unknown subcommand to proven-read (the self-closing
  // property), and dropping the `-c` exclusion.
  it('fails closed on a subcommand it does not declare', () => {
    expect(isolation('git status:*')).toBe('write');
    expect(isolation('git -c core.hooksPath=/tmp/h status')).toBe('write');
    expect(isolation('git show --output=x HEAD')).toBe('write');
  });

  // The over-block guard: closing the operand axis must not cost the reads.
  it('keeps the ordinary reads, including the two-word `stash list`', () => {
    for (const command of [
      'git status',
      'git log --oneline',
      'git log --graph --all --oneline',
      'git log -5',
      'git diff HEAD~1 -- src/',
      'git show HEAD:file.ts',
      'git ls-files',
      'git shortlog -s',
      'git describe --tags',
      'git -C sub status',
      'git stash list',
      'git reflog',
      'git branch',
      'git branch -av',
    ]) {
      expect(isolation(command), command).toBe('read');
    }
  });
});

describe("find's file-writing ACTIONS (found by the P2.118 extent sweep)", () => {
  // Kills: reverting the four additions to DANGEROUS_COMMAND_ARGS.find. Each was
  // measured ALLOWED in Explore (now plan) mode while `-delete` and `-exec` were refused.
  it('refuses -fprintf/-fprint/-fprint0/-fls like -delete', () => {
    for (const command of [
      'find . -fprintf out.txt %p',
      'find . -fprint out.txt',
      'find . -fprint0 out.txt',
      'find . -fls out.txt',
    ]) {
      expect(planMode(command), command).toBe('block');
    }
    expect(planMode('find . -delete')).toBe('block');
    expect(planMode('find . -print')).toBe('allow');
  });
});
