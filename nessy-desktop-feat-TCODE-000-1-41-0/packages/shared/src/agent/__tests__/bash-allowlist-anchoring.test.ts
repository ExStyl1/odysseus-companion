/**
 * The read-only allowlist's ANCHORING, and the sed glob rule's oracle.
 *
 * Rows covered: P2.207 (allowlist patterns that were unanchored, or that
 * accepted an action-selecting subcommand) and P2.208 (the glob rule refusing
 * ordinary sed reads, fixed the way P2.120 was — at the AST).
 *
 * Every case here was MEASURED against the real matcher before it was written,
 * and each `it` names the MUTATION it exists to kill. That is deliberate: a
 * substring mutant of a gate in this subsystem once passed all 646 tests, so a
 * test that merely restates the implementation is worth nothing here.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { validateBashCommand, scanBashWriteVectors } from '../bash-validator.ts';

/**
 * The SHIPPED allowlist, not a hand-made stand-in. These rows are about the
 * patterns themselves, so invented patterns would prove nothing.
 */
const allowlistPath = new URL(
  '../../../../../apps/electron/resources/permissions/default.json',
  import.meta.url,
);
const shipped = JSON.parse(readFileSync(allowlistPath, 'utf8')) as {
  allowedBashPatterns: { pattern: string; comment?: string }[];
};
const sources = shipped.allowedBashPatterns.map(entry => entry.pattern);
const patterns = shipped.allowedBashPatterns.flatMap(entry => {
  try {
    return [{ regex: new RegExp(entry.pattern), source: entry.pattern }];
  } catch {
    return [];
  }
});

/** Explore mode's verdict. */
const explore = (command: string): 'allow' | 'block' =>
  validateBashCommand(command, patterns).allowed ? 'allow' : 'block';

/** The isolation write-scan's verdict: `read` means it contributed NO vector. */
const isolation = (command: string): 'read' | 'write' =>
  scanBashWriteVectors(command, patterns).length === 0 ? 'read' : 'write';

describe('the allowlist is anchored at BOTH ends of the head (P2.207)', () => {
  // Kills: dropping the `^` from any entry — the defect this row is about. An
  // unanchored pattern matches wherever its characters appear, which is how
  // `python -c import os --help` became an ALLOW.
  it('has no entry that can match away from the start of the command', () => {
    const unanchored = sources.filter(source => !source.startsWith('^'));
    expect(unanchored).toEqual([]);
  });

  // Kills: re-widening the help entries back to a bare `--help\b` / `-h\b$`, and
  // also widening the head to allow a `/` or a `.` in it. Every row below was
  // measured ALLOW on the parent commit.
  it('refuses a help flag smuggled onto an executing command', () => {
    for (const command of [
      'python -c import os --help',
      'python3 -c import os --help',
      'node -e process.exit --help',
      'perl -e unlink --help',
      'rm -rf ./build --help',
      'sh deploy.sh --help',
      'node app.js --help',
      './configure --help',
      'rm -rf ./build -h',
      'sh deploy.sh -h',
      'git push origin main -h',
    ]) {
      expect(explore(command), command).toBe('block');
    }
  });

  // Kills: over-anchoring the help entries into uselessness (e.g. requiring the
  // head to be one of a hard-coded list, or forgetting that a head may carry a
  // digit or a hyphen).
  it('still allows a plain help invocation of a PATH-resolvable tool', () => {
    for (const command of [
      'ls --help', 'git --help', 'npm --help', 'python --help', 'python3 --help',
      'pdf-tool --help', 'ls -h', 'du -h', 'df -h', 'tsc --help',
    ]) {
      expect(explore(command), command).toBe('allow');
    }
  });
});

describe('an action-selecting subcommand is not accepted bare (P2.207)', () => {
  // Kills: restoring `branch`/`tag`/`remote`/`reflog`/`history` as bare
  // alternatives in the git entry. `42ebdc062` fixed the ISOLATION path for
  // these; the allowlist pattern is a different authority and was still ALLOW.
  it('refuses the git writes the read entry used to accept', () => {
    for (const command of [
      'git branch -D main',
      'git branch newbranch',
      'git branch -m old new',
      'git tag v9',
      'git tag -d v9',
      'git tag -a v9 -m msg',
      'git remote add evil http:_x',
      'git remote remove origin',
      'git remote set-url origin http:_x',
      'git reflog expire --expire=now --all',
      'git reflog delete HEAD@{0}',
      // Not a git builtin, so it dispatches to a user ALIAS — and a git alias
      // may be `!<shell command>`.
      'git history',
      // Config injection: `-c core.pager=<cmd>` runs <cmd>. The old entry
      // accepted any `-[A-Za-z]` before the subcommand.
      'git -c core.pager=touch log',
      // `git diff --output=FILE` writes FILE.
      'git diff --output=leak.txt',
    ]) {
      expect(explore(command), command).toBe('block');
    }
  });

  // Kills: an over-tight git rewrite. `git branch -av` is the specific row that
  // caught the one regression this change produced: a CLUSTERED short flag,
  // absent from a 4 968-command corpus that carried `-a`, `-v` and `-vv`.
  it('keeps the git reads, including clustered short flags', () => {
    for (const command of [
      'git status', 'git log --oneline', 'git diff HEAD~1', 'git show HEAD',
      'git branch', 'git branch -a', 'git branch -v', 'git branch -av',
      'git branch -vv', 'git branch --list', 'git branch --show-current',
      'git tag', 'git tag -l', 'git tag -n', 'git tag -ln',
      'git remote', 'git remote -v', 'git remote show origin',
      'git remote get-url origin', 'git reflog', 'git reflog show',
      'git stash list', 'git config --get user.name', 'git config --list',
      'git ls-files', 'git rev-parse HEAD', 'git blame f.txt',
      'git -C sub status', 'git --no-pager log',
    ]) {
      expect(explore(command), command).toBe('allow');
    }
  });

  // Kills: reading only the LONG method flag on `gh api`. `-X` is gh's short
  // form of `--method`, and `-f`/`-F`/`--field`/`--raw-field`/`--input` make gh
  // switch to POST with no method flag present at all — so the old
  // `(?!.*--method)` lookahead passed every one of these.
  it('refuses a gh api call that is not a GET', () => {
    for (const command of [
      'gh api -X DELETE repos/o/r',
      'gh api -X POST repos/o/r',
      'gh api repos/o/r -f name=x',
      'gh api repos/o/r -F name=x',
      'gh api repos/o/r --input body.json',
      'gh api --method POST repos/o/r',
      // The last method flag wins in gh's parser, so a trailing `-X DELETE`
      // after an explicit `--method GET` is a DELETE.
      'gh api --method GET repos/o/r -X DELETE',
    ]) {
      expect(explore(command), command).toBe('block');
    }
    for (const command of [
      'gh api repos/o/r',
      'gh api --method GET repos/o/r',
      'gh api --method=GET repos/o/r',
      'gh api repos/o/r --jq .name',
      'gh api -H accept:x repos/o/r',
    ]) {
      expect(explore(command), command).toBe('allow');
    }
  });

  // Kills: restoring `\s*(show)?\b` on the `ip` entry. The `show` was OPTIONAL
  // with nothing after it anchored, so every write verb matched.
  it('refuses ip and ifconfig writes while keeping their reads', () => {
    for (const command of [
      'ip addr add 10.0.0.1/24 dev eth0',
      'ip addr del 10.0.0.1/24 dev eth0',
      'ip link set eth0 down',
      'ip route add default via 10.0.0.1',
      'ip neigh add 10.0.0.2 dev eth0',
      'ifconfig eth0 down',
      'ifconfig eth0 10.0.0.1 netmask 255.255.255.0',
    ]) {
      expect(explore(command), command).toBe('block');
    }
    for (const command of [
      'ip addr', 'ip addr show', 'ip addr show dev eth0', 'ip link show',
      'ip route', 'ip route get 1.1.1.1',
      'ifconfig', 'ifconfig -a', 'ifconfig eth0',
    ]) {
      expect(explore(command), command).toBe('allow');
    }
  });

  // Kills: dropping any one of the per-tool action guards. Each row was
  // measured ALLOW on the parent commit, and each names a real write.
  it('refuses the per-tool write actions that rode an unanchored tail', () => {
    const rows: Array<[command: string, why: string]> = [
      ['npm audit fix', 'rewrites the lockfile and node_modules'],
      ['npm audit fix --force', 'same, with --force'],
      ['pnpm audit --fix', 'pnpm spells the same action as a flag'],
      ['kubectl cluster-info dump --output-directory=/x', 'writes a tree of files'],
      ['sed -n -i s/a/b/ f.txt', '-n does not make sed read-only'],
      ['sort -o out.txt in.txt', 'sort -o truncates its target'],
      ['sort --output=out.txt in.txt', 'the long spelling of the same'],
      ['uniq in.txt out.txt', "uniq's second operand is WRITTEN (POSIX)"],
      ['yq -i .a=1 f.yaml', 'in-place edit'],
      ['yq --inplace .a=1 f.yaml', 'the long spelling'],
      ['xq -i .a=1 f.xml', 'in-place edit'],
      ['xmllint --output out.xml in.xml', 'writes its target'],
      ['fd -x rm {}', 'fd -x executes per result'],
      ['fd --exec rm', 'the long spelling'],
      ['fd -X rm', 'the batch spelling'],
      ['ss -K dst 1.2.3.4', 'ss -K destroys sockets'],
      ['python -m json.tool in.json out.json', "json.tool's 2nd operand is written"],
    ];
    for (const [command, why] of rows) {
      expect(explore(command), `${command} — ${why}`).toBe('block');
    }
  });

  // Kills: closing the guards above with a blunt instrument (refusing the head
  // outright, or capping operands too tightly). `uniq -w 5 in.txt` is the sharp
  // one: its flag VALUE looks exactly like a second operand.
  it('keeps the reads those guards sit next to', () => {
    for (const command of [
      'npm audit', 'npm audit signatures', 'npm ls', 'pnpm audit',
      'kubectl cluster-info', 'kubectl get pods',
      'sed -n 1,5p f.txt',
      'sort in.txt', 'sort -r in.txt', 'sort -rn in.txt',
      'uniq', 'uniq in.txt', 'uniq -c in.txt', 'uniq -w 5 in.txt',
      'uniq -f 1 in.txt', 'uniq --skip-fields=1 in.txt',
      'yq .a f.yaml', 'xq .a f.xml', 'xmllint --format in.xml',
      'fd -e ts src', 'fd --type f', 'ss -tulpn',
      'python -m json.tool in.json', 'python -m json.tool',
    ]) {
      expect(explore(command), command).toBe('allow');
    }
  });
});

describe("sed's glob rule asks the AST, not a character class (P2.208)", () => {
  // Kills: reverting `sedScriptMayWriteFile` to test the glob metacharacter on
  // the script TEXT. A regular expression's metacharacters ARE a glob's, so on
  // the parent commit every row here was classified a WRITE under isolation —
  // ordinary reads a user cannot override.
  it('no longer refuses an ordinary QUOTED sed read', () => {
    for (const command of [
      "sed -n '/foo.*bar/p' f.txt",
      'sed -n "/foo.*bar/p" f.txt',
      "sed -n '/a[bc]d/p' f.txt",
      "sed -n '/[0-9]/p' f.txt",
      "sed -n '/[[:digit:]]/p' f.txt",
      "sed -n '/x\\{2,3\\}/p' f.txt",
      "sed -n '/ab\\?c/p' f.txt",
      "sed -n '1,10{p;}' f.txt",
      "sed -n '/a/{n;p;}' f.txt",
      "sed -n 's/[0-9]*//p' f.txt",
      "sed -n 's/.*=//p' f.txt",
      "sed -n -e '/a.*b/p' f.txt",
      // The glob is in the INPUT position, which the rule never scanned (quoted: since UA12.212 an UNQUOTED one refuses the line).
      "sed -n '1,5p' '*.log'",
    ]) {
      expect(isolation(command), command).toBe('read');
    }
  });

  // Kills: replacing the AST oracle with "always literal", i.e. dropping the
  // glob term altogether. `sed -n *.txt` is the LIVE incident the term exists
  // for: it expanded to `warnings.txt`, which sed parsed as `w` + `arnings.txt`
  // and CREATED that file. Also kills treating a partially-quoted word as
  // literal (`'p'*.txt`).
  it('still refuses a script the SHELL will expand', () => {
    for (const command of [
      'sed -n *.txt',
      'sed -n *',
      'sed -n {a,b}',
      'sed -n ?.txt',
      'sed -n [ab].txt',
      'sed -n -e *.txt',
      "sed -n 'p'*.txt",
      "sed -n '/a/p'*.txt",
    ]) {
      expect(isolation(command), command).toBe('write');
    }
  });

  // Kills: letting the AST oracle swallow the OTHER two terms of the rule — the
  // `[wW]` letter test (sed's own write primitive) and P2.120's parameter
  // expansion. Quoting makes a glob literal; it does not make a `w` harmless.
  it('keeps the write primitive and the expansion axis refused', () => {
    for (const command of [
      "sed -n 'w out.txt' f.txt",
      "sed -n 's/a/b/w out.txt' f.txt",
      "sed -n 'W out.txt' f.txt",
      "sed -n 'wout' f.txt",
      'sed -n "$X" f.txt',
      'sed -n ${X} f.txt',
    ]) {
      expect(isolation(command), command).toBe('write');
    }
  });

  // A REGRESSION PIN for P2.120's instrument, and labelled as one because it is
  // NOT evidence for this row's new reach: no mutation of the AST oracle kills
  // it. Measured — with `insertLOC` removed entirely, `'$p'` is still a read
  // (its script carries no glob metacharacter) and `"$p"` is still a write (the
  // recorded `ParameterExpansion`), so this pair turns on P2.120's check rather
  // than on the source span. It is kept because P2.208 reuses that instrument
  // one axis over, and a change here would mean the precedent moved.
  it("separates '$p' from \"$p\" even though their text is identical", () => {
    expect(isolation("sed -n '$p' f.txt")).toBe('read');
    expect(isolation('sed -n "$p" f.txt')).toBe('write');
  });
});
