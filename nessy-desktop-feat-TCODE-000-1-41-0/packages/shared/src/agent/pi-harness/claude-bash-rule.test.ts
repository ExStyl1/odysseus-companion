import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  HEREDOC_SHAPE_CLASSES,
  classifyHeredocShape,
  describeHeredocShape,
  matchClaudeBashIfRule,
  matchClaudeBashRule,
  splitCompoundCommand,
  splitCompoundCommandWithoutHeredocModel,
  splitWithSubstitutions,
  stripSubcommand,
} from './claude-bash-rule.ts'
import { parseClaudeRuleString } from './claude-permission-rules.ts'
import { compilePermissionDslV1, evaluatePermissionDslV1 } from './permission-dsl.ts'
import { findRootOrHomeRemoval } from './removal-circuit-breaker.ts'

type Action = 'allow' | 'deny' | 'ask'
type Want = 'match' | 'no-match' | 'unparseable'

describe('matchClaudeBashRule', () => {
  // Documented examples and their stated boundaries (permissions.md § Bash,
  // re-fetched 2026-07-26; see the R1 plan's Task 1 notes for citations).
  const prefixCases: Array<[pattern: string, command: string, action: Action, want: Want]> = [
    ['git *',        'git status',            'allow', 'match'],
    ['git *',        'git',                   'allow', 'match'],      // word boundary = space OR end-of-string
    ['ls *',         'lsof',                  'allow', 'no-match'],   // space = word boundary
    ['ls*',          'lsof',                  'allow', 'match'],
    ['git commit:*', 'git commit -m x',       'allow', 'match'],      // :* == trailing ' *'
    ['npm run *',    'npm run build && rm -rf /', 'allow', 'no-match'], // every subcommand must match
    ['npm run *',    'npm run build && rm -rf /', 'deny',  'match'],    // any subcommand matches
    ['git *',        'timeout 5 git status',  'allow', 'match'],      // wrapper stripped
    ['git *',        'watch git status',      'allow', 'no-match'],   // exec wrapper never approvable by a prefix rule
    ['watch git status', 'watch git status',  'allow', 'match'],      // ...but an exact-match rule approves it
    ['git *',        'command -v git',        'allow', 'no-match'],   // command -v NOT stripped
    ['git *',        'FOO=bar git status',    'deny',  'match'],      // deny crosses any assignment
    ['git *',        'FOO=bar git status',    'allow', 'no-match'],   // allow refuses unknown var
    ['npm test *',   'NODE_ENV=test npm test','allow', 'match'],      // known-safe assignment stripped
    ['git *',        'git "status',           'allow', 'unparseable'],
  ]

  test.each(prefixCases)('%s vs %s as %s -> %s', (pattern, command, action, want) => {
    expect(matchClaudeBashRule(pattern, command, { ruleAction: action })).toBe(want)
  })

  // Adversarial rows beyond the documented examples (plan Task 2 Step 4).
  const adversarialCases: Array<[pattern: string, command: string, action: Action, want: Want]> = [
    // Operators inside $() must not split; an allow prefix rule must never
    // approve embedded command substitution (fail-closed choice, documented
    // in the module).
    ['git *',        'git log $(echo a && echo b)', 'allow', 'no-match'],
    ['git *',        'git log $(echo a && echo b)', 'deny',  'match'],
    // |& splits like the other operators.
    ['npm run *',    'npm run build |& tee log',    'allow', 'no-match'],
    ['tee *',        'npm run build |& tee log',    'deny',  'match'],
    // Oversized commands are unparseable.
    ['git *',        `git ${'x'.repeat(10_001)}`,   'allow', 'unparseable'],
    // Flagged xargs is NOT stripped; flagless xargs is.
    ['rm *',         'xargs -I{} rm {}',            'allow', 'no-match'],
    ['grep *',       'xargs grep pattern',          'allow', 'match'],
    // noglob strips, nocorrect does not.
    ['git *',        'noglob git status',           'allow', 'match'],
    ['git *',        'nocorrect git status',        'allow', 'no-match'],
    // CRLF newlines split compounds.
    ['git *',        'git status\r\ngit push',      'allow', 'match'],
    ['git *',        'git status\r\nrm -rf /',      'allow', 'no-match'],
    // Redirection fd-duplication is not a command separator.
    ['git *',        'git status 2>&1',             'allow', 'match'],
    // Wrapper chains strip iteratively.
    ['npm test *',   'nohup nice -n 10 npm test',   'allow', 'match'],
    // find with -exec/-delete is never approvable by a prefix rule.
    ['find *',       'find . -name "*.tmp" -delete', 'allow', 'no-match'],
    ['find *',       'find . -name "*.tmp"',        'allow', 'match'],
    // The :* form is only recognized at the END of a pattern.
    ['git:* push',   'git anything push',           'allow', 'no-match'],
    // Unbalanced $( span.
    ['git *',        'git log $(date',              'allow', 'unparseable'],
    // ARITHMETIC expansion runs no command, so the substitution veto does not
    // cover it. permissions.md names command substitution only for the
    // bypassPermissions circuit breaker (`:63`) and explicitly gives up on
    // argument-shaped Bash patterns (`:218-224`, `URL=… && curl $URL`); there
    // is no documented rule the veto could be widened from.
    ['sleep *',      'sleep $((60*5))',             'allow', 'match'],
    ['echo *',       'echo "$(( (1+2)*3 ))"',       'allow', 'match'],
    // ...but a substitution NESTED in arithmetic is still command execution.
    ['echo *',       'echo $(( $(id -u) + 1 ))',    'allow', 'no-match'],
    ['echo *',       'echo $(( `id -u` + 1 ))',     'allow', 'no-match'],
    ['echo *',       'echo $((1+2)) && echo $(whoami)', 'allow', 'no-match'],
    // Arithmetic is not a licence to unbalance the command.
    ['echo *',       'echo $((1+2',                 'allow', 'unparseable'],
    ['echo *',       'echo $((1+2)',                'allow', 'unparseable'],
    // The deny floor never consulted the veto and is unchanged either way.
    ['rm *',         'rm $((1+1))',                 'deny',  'match'],
    ['rm *',         'rm $(echo x)',                'deny',  'match'],
  ]

  test.each(adversarialCases)('adversarial: %s vs %s as %s -> %s', (pattern, command, action, want) => {
    expect(matchClaudeBashRule(pattern, command, { ruleAction: action })).toBe(want)
  })
})

describe('splitCompoundCommand', () => {
  test('splits on the six operators and newlines at top nesting level only', () => {
    expect(splitCompoundCommand('a && b || c; d | e |& f & g')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    expect(splitCompoundCommand('echo "a && b"')).toEqual(['echo "a && b"'])
    expect(splitCompoundCommand("echo 'a; b'")).toEqual(["echo 'a; b'"])
    expect(splitCompoundCommand('git log $(echo a && echo b) --stat')).toEqual(['git log $(echo a && echo b) --stat'])
    expect(splitCompoundCommand('echo `date; whoami` done')).toEqual(['echo `date; whoami` done'])
    expect(splitCompoundCommand('one\ntwo\r\nthree')).toEqual(['one', 'two', 'three'])
    expect(splitCompoundCommand('git status 2>&1')).toEqual(['git status 2>&1'])
    expect(splitCompoundCommand('cmd &> log')).toEqual(['cmd &> log'])
  })

  test('returns null for unparseable input', () => {
    expect(splitCompoundCommand('git "status')).toBeNull()
    expect(splitCompoundCommand("git 'status")).toBeNull()
    expect(splitCompoundCommand('git log $(date')).toBeNull()
    expect(splitCompoundCommand('echo `date')).toBeNull()
    expect(splitCompoundCommand('x'.repeat(10_001))).toBeNull()
    expect(splitCompoundCommand('   ')).toBeNull()
  })
})

/**
 * P2.71 — a `#` comment tail is prose, not command text.
 *
 * Every row's PRE verdict was MEASURED on the parent tree (2026-08-23) before
 * the change; the two the row was opened for are the first two, both false
 * prompts through `findRootOrHomeRemoval`:
 *
 * | command | PRE | POST |
 * | --- | --- | --- |
 * | `rm ./one.txt # also clears ~` | `['rm ./one.txt # also clears ~']` → home prompt | `['rm ./one.txt']` → null |
 * | `rm -rf ./logs  # careful with /` | `['rm -rf ./logs  # careful with /']` → root prompt | `['rm -rf ./logs']` → null |
 * | `echo hi # note \| rm -rf /` | `['echo hi # note', 'rm -rf /']` | `['echo hi']` |
 *
 * The shell facts every row rests on were measured through `/bin/sh -lc`, which
 * is what the Bash tool spawns off Windows (`pi-agent-server/src/index.ts`).
 */
describe('a comment tail is not command text (P2.71)', () => {
  test('the comment tail is excised and its separators do not split', () => {
    // The two rows P2.71 was opened for.
    expect(splitCompoundCommand('rm ./one.txt # also clears ~')).toEqual(['rm ./one.txt'])
    expect(splitCompoundCommand('rm -rf ./logs  # careful with /')).toEqual(['rm -rf ./logs'])
    // A `;`/`|` inside the comment is prose too — `echo x #y | echo z` prints
    // `x` and never runs `echo z`.
    expect(splitCompoundCommand('echo hi # note | rm -rf /')).toEqual(['echo hi'])
    expect(splitCompoundCommand('echo hi # note ; rm -rf /')).toEqual(['echo hi'])
    // A comment on one line of a compound command leaves every other line.
    expect(splitCompoundCommand('rm ./ok.txt # note\nrm -rf /')).toEqual(['rm ./ok.txt', 'rm -rf /'])
    expect(splitCompoundCommand('a # one\r\nb # two\r\nc')).toEqual(['a', 'b', 'c'])
  })

  test('the negatives that must not move: quoted, mid-word, and escaped `#`', () => {
    // `echo 'a #b'` and `echo "a #b"` both print `a #b`.
    expect(splitCompoundCommand("echo '# not a comment' ; rm -rf /"))
      .toEqual(["echo '# not a comment'", 'rm -rf /'])
    expect(splitCompoundCommand('echo "# not a comment" ; rm -rf /'))
      .toEqual(['echo "# not a comment"', 'rm -rf /'])
    // `echo a#b` prints `a#b`: a `#` mid-word is an ordinary character.
    expect(splitCompoundCommand('echo a#b | rm -rf /')).toEqual(['echo a#b', 'rm -rf /'])
    // An escaped or quoted BLANK keeps the word open, so the `#` after it is
    // still mid-word: `echo a\ #b` and `echo a" "#b` both print `a #b`.
    expect(splitCompoundCommand('echo a\\ #b | rm -rf /')).toEqual(['echo a\\ #b', 'rm -rf /'])
    expect(splitCompoundCommand('echo a" "#b | rm -rf /')).toEqual(['echo a" "#b', 'rm -rf /'])
    // A genuine compound command with no comment in it is untouched.
    expect(splitCompoundCommand('a && b || c; d | e |& f & g')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
  })

  test('the two non-coverages, each pinned in the direction it errs', () => {
    // Top level only. Real sh comments inside `$(…)` too and eats the closing
    // `)` doing it (`echo $(echo a # b)` is `unexpected EOF`), so the old
    // scanning survives here and can only over-fire on a command sh refuses.
    expect(splitCompoundCommand('echo $(rm -rf / # x)')).toEqual(['echo $(rm -rf / # x)'])
    expect(matchClaudeBashRule('rm:*', 'echo $(rm -rf / # x)', { ruleAction: 'deny' })).toBe('match')
    // A lone `\r` resumes the scan, though sh keeps commenting through one.
    // Scanning more is the safe side, and this splitter already separates on it.
    expect(splitCompoundCommand('echo a # note\rrm -rf /')).toEqual(['echo a', 'rm -rf /'])
  })

  test('a command that is only a comment runs nothing, and parses to nothing', () => {
    // `sh -lc '# nothing'` exits 0 having run no command, so this joins the
    // empty command as `'unparseable'` — which permissions.md:210 prompts on.
    expect(splitCompoundCommand('# nothing')).toBeNull()
    expect(splitCompoundCommand('#!/usr/bin/env node')).toBeNull()
    expect(matchClaudeBashRule('*', '# nothing', { ruleAction: 'deny' })).toBe('unparseable')
    // PRE this was `match` for deny and `match` for allow; both now prompt,
    // which is the louder half of the pair on the allow side.
    expect(matchClaudeBashRule('*', '# nothing', { ruleAction: 'allow' })).toBe('unparseable')
  })

  /**
   * The blast-radius rows. A representative `Bash(...)` rule must still match
   * what it matched before — the sweep behind this claim found zero
   * `match -> no-match` transitions across the whole permission surface, and
   * these are the shapes it swept.
   */
  const unmovedRules: Array<[pattern: string, command: string, action: Action, want: Want]> = [
    ['git *', 'git status', 'allow', 'match'],
    ['git commit:*', 'git commit -m x', 'allow', 'match'],
    ['npm run *', 'npm run build && rm -rf /', 'allow', 'no-match'],
    ['npm run *', 'npm run build && rm -rf /', 'deny', 'match'],
    ['rm *', 'echo $(rm -rf ./x)', 'deny', 'match'],
    ['git *', 'timeout 5 git status', 'allow', 'match'],
    ['git *', 'git status 2>&1', 'allow', 'match'],
    ['echo *', 'echo a#b', 'allow', 'match'],
    ['git *', 'git status\r\nrm -rf /', 'allow', 'no-match'],
  ]

  test.each(unmovedRules)('unmoved: %s vs %s as %s -> %s', (pattern, command, action, want) => {
    expect(matchClaudeBashRule(pattern, command, { ruleAction: action })).toBe(want)
  })

  /**
   * The two widenings, stated rather than hidden. Both move `no-match -> match`
   * for an ALLOW rule, and both are correct: excising a comment leaves the text
   * the shell actually runs, and nothing inside a comment runs at all (MEASURED
   * through `/bin/sh -lc`: `echo x # $(echo BAD)` prints `x`, and
   * `echo x # > /tmp/f` creates no file). Pinned from both sides so a later
   * reader can see they were chosen.
   */
  test('an EXACT rule now matches the command the shell will actually run', () => {
    expect(matchClaudeBashRule('git status', 'git status # done', { ruleAction: 'allow' })).toBe('match')
    // The positive control: the rule is still exact, so a real second command
    // is still outside it.
    expect(matchClaudeBashRule('git status', 'git status ; rm -rf /', { ruleAction: 'allow' })).toBe('no-match')
  })

  test('the substitution veto stops firing on a commented-out substitution', () => {
    expect(matchClaudeBashRule('echo:*', 'echo hi # $(rm -rf /)', { ruleAction: 'allow' })).toBe('match')
    // The positive control on the same rig: uncomment it and the veto is back.
    expect(matchClaudeBashRule('echo:*', 'echo hi $(rm -rf /)', { ruleAction: 'allow' })).toBe('no-match')
    // …and the deny floor never consulted the veto, so it is unmoved either way.
    expect(matchClaudeBashRule('rm:*', 'echo hi $(rm -rf /)', { ruleAction: 'deny' })).toBe('match')
  })

  test('the deny/ask splitter inherits it, so both floors reach the same distance', () => {
    expect(splitWithSubstitutions('rm ./one.txt # also clears ~')).toEqual(['rm ./one.txt'])
    expect(splitWithSubstitutions('echo hi # note | rm -rf /')).toEqual(['echo hi'])
    expect(splitWithSubstitutions('echo hi $(rm -rf ~)')).toEqual(['echo hi $(rm -rf ~)', 'rm -rf ~'])
  })
})

/**
 * ANSI-C quoting (`$'…'`), which the comment rule above DEPENDS on.
 *
 * In `$'…'` a backslash escapes, so `\'` is a literal quote and does not close
 * the string. A scanner that closes there sits at top level while bash is still
 * inside a word; the next blank-preceded `#` reads as a comment and swallows the
 * real closing quote — the very thing that used to make the scanner notice it
 * had lost its place. The result is a confident parse of half the command.
 *
 * MEASURED against the parent of the comment commit and against that commit
 * itself, on `echo $'a\'b # c ; rm -rf /' ; rm -rf /tmp/x \'` — a command
 * `/bin/sh -lc` runs to completion, second command included:
 *
 * | | `splitCompoundCommand` | `deny Bash(rm:*)` |
 * | --- | --- | --- |
 * | before the comment commit | `["echo $'a\\'b # c", "rm -rf /' ; rm -rf /tmp/x \\'"]` | `match` |
 * | the comment commit alone | `["echo $'a\\'b"]` | **`no-match`** |
 * | here | `["echo $'a\\'b # c ; rm -rf /'", "rm -rf /tmp/x \\'"]` | `match` |
 *
 * Every rule below was measured on this rig through `/bin/sh -lc`
 * (bash 3.2.57), not recalled.
 */
describe("ANSI-C quoting cannot hide a subcommand ($'…')", () => {
  /**
   * The guard is TOTAL: a command carrying `$'` is scanned exactly as it was
   * before this file knew about comments. These are the parent's verdicts,
   * re-measured on `9a7d2ebe1^`, and they are what the guard must reproduce.
   *
   * P2.363 left every row here untouched ON PURPOSE. It refuses an
   * UNCORROBORATED reading at `matchClaudeBashRule`'s allow branch, not at the
   * split, precisely so these bytes — which the deny side needs and which every
   * pin recording what the guards cost is written against — keep existing. The
   * two rows that ARE affected are affected at the verdict, and are pinned as
   * verdicts in `an allow rule cannot span a line terminator (P2.350)`.
   */
  const parentVerdicts: Array<[command: string, split: string[] | null]> = [
    [
      String.raw`echo $'a\'b # c ; rm -rf /' ; rm -rf /tmp/x \'`,
      [String.raw`echo $'a\'b # c`, String.raw`rm -rf /' ; rm -rf /tmp/x \'`],
    ],
    [String.raw`git commit -m $'don\'t # ship'; rm -rf ~`, null],
    [String.raw`echo $'a\'b # c'; rm -rf /`, null],
    [String.raw`echo x$'a\'b # c' ; echo TAIL`, null],
    [String.raw`echo $'a\'b'`, null],
    // The guard keys on the two characters, not on a parse — a `$'` anywhere,
    // even one the shell would treat as ordinary, disables the rule. Erring that
    // way is the point.
    [String.raw`echo "$'a\'b'"`, [String.raw`echo "$'a\'b'"`]],
    [String.raw`echo $'a' # x | rm -rf /`, [String.raw`echo $'a' # x`, 'rm -rf /']],
  ]

  test.each(parentVerdicts)('scanned byte-identically to the parent: %s', (command, split) => {
    expect(splitCompoundCommand(command)).toEqual(split as string[])
  })

  test('the prompt the parent raised is still raised', () => {
    // `permission-dsl.ts` enters `'unparseable'` as `ask`, which outranks
    // `allow` — so keeping the parent's verdict IS keeping the protection.
    for (const command of [
      String.raw`git commit -m $'don\'t # ship'; rm -rf ~`,
      String.raw`echo $'a\'b # c'; rm -rf /`,
    ]) {
      expect(matchClaudeBashRule('git commit:*', command, { ruleAction: 'allow' }), command)
        .toBe('unparseable')
      expect(matchClaudeBashRule('rm:*', command, { ruleAction: 'deny' }), command)
        .toBe('unparseable')
    }
  })

  test('a deny rule still reaches the second command', () => {
    // The reviewer's case: `/bin/sh -lc` runs the second command, and the
    // parent's over-split happens to expose it. The guard keeps that exposure.
    for (const pattern of ['rm:*', 'rm *']) {
      expect(
        matchClaudeBashRule(pattern, String.raw`echo $'a\'b # c ; rm -rf /' ; rm -rf /tmp/x \'`, { ruleAction: 'deny' }),
        pattern,
      ).toBe('match')
    }
  })

  /**
   * P2.179 — THE MIS-PARSE, and why the fix is enforcement-only.
   *
   * Everything above pins the ALLOW splitter's reading, which is wrong about
   * where an ANSI-C string ENDS: it reads `\'` as closing the quote and splits
   * at a `;` that is inside the literal. The shell does not — it prints the
   * whole string and runs the second command (measured through `/bin/sh -lc`;
   * `scanCommand`'s docstring records it).
   *
   * The fix is confined to the enforcement pass, because the allow direction is
   * the one that hurts: teaching `splitCompoundCommand` this rule turns
   * `allow Bash(echo:*)` on such a command from a prompt into an approval, and
   * `scanCommand`'s docstring records a corpus sweep where a full `$'…'` model
   * did exactly that nine times. So `splitCompoundCommand` keeps its bytes —
   * the `parentVerdicts` rows above ARE that pin — and only
   * `splitWithSubstitutions` gains the corrected reading, ADDED to the list
   * rather than replacing it.
   *
   * Re-measured for this change: 31 624 commands x 63 patterns x 4 actions =
   * 8 032 496 checks, HEAD vs this tree. `splitCompoundCommand` output changed
   * on 0 commands and no `allow` verdict moved anywhere.
   */
  const misParsePin = String.raw`echo $'a\'b # c ; rm -rf /' ; rm -rf ~ \'`

  test('P2.179 — the ALLOW split keeps its exact bytes', () => {
    // Kills: turning the ANSI-C knob on for `splitCompoundCommand`.
    expect(splitCompoundCommand(misParsePin)).toEqual([
      String.raw`echo $'a\'b # c`,
      String.raw`rm -rf /' ; rm -rf ~ \'`,
    ])
    // P2.363 — and the bytes are still a MIS-PARSE, which the docstring above
    // says in terms: neither form is a command the shell runs. What changed is
    // that an ALLOW rule no longer gets to believe them. Kills a mutant that
    // drops the corroboration check from `matchClaudeBashRule`.
    expect(matchClaudeBashRule('echo:*', misParsePin, { ruleAction: 'allow' })).toBe('unparseable')
    // …while the deny side keeps the reach P2.179 gave it.
    expect(matchClaudeBashRule('rm:*', misParsePin, { ruleAction: 'deny' })).toBe('match')
  })

  test('P2.179 — the enforcement pass ADDS the corrected reading', () => {
    // Kills: reverting the ANSI-C rule (the third and fourth forms vanish), and
    // a mutant that REPLACES the naive reading instead of appending to it (the
    // first two forms disappear). The order is the contract: the bytes a deny
    // rule already matched come first, then P2.179's ANSI-C reading, then
    // P2.363's comment-honouring one — which is the fifth form here, and is
    // itself a mutation-killer for dropping the comment append.
    expect(splitWithSubstitutions(misParsePin)).toEqual([
      String.raw`echo $'a\'b # c`,
      String.raw`rm -rf /' ; rm -rf ~ \'`,
      String.raw`echo $'a\'b # c ; rm -rf /'`,
      String.raw`rm -rf ~ \'`,
      String.raw`echo $'a\'b`,
    ])
  })

  test('P2.179 — a string stays a string in BOTH readings', () => {
    // The corrected reading must not turn quoted text into a command; that
    // would be the mirror-image defect. `echo $'…'` is one subcommand either
    // way, and a deny on `rm` must not match it.
    const quoted = String.raw`echo $'hi ; rm -rf ~'`
    expect(splitCompoundCommand(quoted)).toEqual([quoted])
    expect(splitWithSubstitutions(quoted)).toEqual([quoted])
    expect(matchClaudeBashRule('rm:*', quoted, { ruleAction: 'deny' })).toBe('no-match')
  })

  test('P2.179 — the rule arms on `$\'` only, not on every single quote', () => {
    // Kills a mutant that arms the ANSI-C escape rule for EVERY single quote.
    // That mutant survived the first re-break pass and was NOT accepted as
    // inert: the distinguishing input below was found by running the mutant and
    // the real code over 31 910 candidates and diffing. Arming everywhere makes
    // an ORDINARY `'p\'` swallow its closing quote, the whole ANSI-C pass goes
    // unbalanced, and the two corrected forms are LOST — a reach regression that
    // no verdict on this command reveals, because the naive split happens to
    // expose `rm -rf ~` anyway. So the assertion has to be on the FORM LIST.
    const mixed = String.raw`echo $'a\'b' ; 'p\' ; rm -rf ~`
    expect(splitWithSubstitutions(mixed)).toEqual([
      String.raw`echo $'a\'b' ; 'p\'`,
      'rm -rf ~',
      String.raw`echo $'a\'b'`,
      String.raw`'p\'`,
    ])
  })

  test('P2.179 — a command with no `$\'` gains no forms at all', () => {
    // NOT a mutation-killer, and the difference matters: dropping the
    // `command.includes("$'")` gate is BEHAVIOURALLY INERT, because `ansiCSpan`
    // can only arm after a `$` immediately followed by `'` — so on a command
    // with no `$'` the two readings are the same string list by construction.
    // Measured, not assumed: that mutant produced 0 differences over 31 910
    // candidates. The gate is a COST guard, and this row pins the property it
    // is supposed to preserve rather than pretending to test the gate.
    const plain = 'echo one ; rm -rf ~'
    expect(splitWithSubstitutions(plain)).toEqual(splitCompoundCommand(plain))
  })

  test('P2.179 — a LOST parse is still lost, and that boundary is deliberate', () => {
    // `splitWithSubstitutions` returns null on exactly the text that cannot be
    // BALANCED — since P2.363 `splitCompoundCommand` refuses a SUPERSET of that,
    // adding the commands whose two readings disagree, and this row is about the
    // balance half. An ANSI-C command the naive reading cannot BALANCE is not
    // rescued here. It does not need to be: that is the textual
    // fallback's domain (P2.144), and it fires. Kills a mutant that "fixes"
    // this by returning the ANSI-C split when the naive one is null, which
    // would silently make deny/ask disagree with allow about unparseability.
    const lost = String.raw`echo $'x\'y' $'p\'q' ; rm -rf ~`
    expect(splitCompoundCommand(lost)).toBeNull()
    expect(splitWithSubstitutions(lost)).toBeNull()
  })

  test('the guard costs the comment rule only where it is armed', () => {
    // No `$'` — the comment rule applies normally, which is the control proving
    // the guard is what silenced the rows above and not something else.
    expect(splitCompoundCommand(String.raw`echo 'a' # x | rm -rf /`)).toEqual([String.raw`echo 'a'`])
    expect(splitCompoundCommand('echo $x # note | rm -rf /')).toEqual(['echo $x'])
  })

  /**
   * P2.100 — the case the mis-parse pin above did NOT cover, and it was live.
   *
   * Everything above this point turns on `misParsePin`, whose two readings both
   * balance and DISAGREE, so P2.363's comment corroboration catches it. This
   * command is the other half of the same class: the two readings still
   * disagree, but the COMMENT reading agrees with the guarded one (the `#` sits
   * inside what the naive model thinks is a quoted span, so neither pass treats
   * it as a comment), and `commentReadingAgrees` therefore said yes.
   *
   *     echo a $'a\'b' && rmdir zzz $'a'b # don't
   *
   * Measured on strings only, before the fix:
   *   - `splitCompoundCommand` -> ONE subcommand, the entire text. The naive
   *     model closes the ANSI-C string at `\'`, so `b'` opens a fresh span that
   *     swallows the `&&`.
   *   - `allow Bash(echo:*)` -> **match**. An allow rule naming `echo`
   *     auto-approved a command whose second word-for-word command is `rmdir`.
   *   - `deny Bash(rmdir:*)` -> **no-match**. Both floors walked through.
   *
   * Found by `scripts/check-claude-bash-split-fuzz.ts` on its first thousand
   * generated cases — which is the argument for that artifact existing, since
   * the "blast-radius sweep" this class was previously certified by was a
   * citation with no script behind it.
   */
  const ansiCReadingPin = String.raw`echo a $'a\'b' && rmdir zzz $'a'b # don't`

  test('P2.100 — an allow rule cannot believe an ANSI-C reading the enforcing model contradicts', () => {
    // The mis-parse is UNCHANGED — the splitter got no smarter, per the owner's
    // dumber-not-smarter ruling. Kills a mutant that turns the ANSI-C knob on
    // for `splitCompoundCommand`.
    expect(splitCompoundCommand(ansiCReadingPin)).toEqual([ansiCReadingPin])
    // What changed is that ALLOW no longer believes it. Kills a mutant that
    // drops `ansiCReadingAgrees` from `matchClaudeBashRule`.
    expect(matchClaudeBashRule('echo:*', ansiCReadingPin, { ruleAction: 'allow' })).toBe('unparseable')
    // The comment corroboration alone does NOT catch this one — which is why a
    // second guard exists rather than a widened first. If this row ever passes
    // for the wrong reason, this is the assertion that says so: both readings
    // of the comment question are the same list.
    expect(splitCompoundCommand(String.raw`echo a $'a\'b' && rmdir zzz $'a'b`)).toBeNull()
  })

  test('P2.100 — the deny-side residue, recorded rather than claimed closed', () => {
    // Honest boundary. With the comment guard armed, the ANSI-C-CORRECT reading
    // of this command does not balance either (the apostrophe in `don't` is not
    // in a comment for that pass), so `splitWithSubstitutions` adds no corrected
    // form and the deny floor still sees only the mis-parse.
    expect(matchClaudeBashRule('rmdir:*', ansiCReadingPin, { ruleAction: 'deny' })).toBe('no-match')
    // The user-visible outcome is nevertheless a PROMPT and never an approval,
    // because no allow rule can match an `'unparseable'` command — that is the
    // whole reason the fix went on the allow side.
    expect(matchClaudeBashRule('*', ansiCReadingPin, { ruleAction: 'allow' })).toBe('unparseable')
  })

  test('P2.104 — the glued-head fuzz residue is RETIRED, and this is the measurement', () => {
    // The row asked whether the two remaining ANSI-C glued-head fuzz holes
    // should be retired or converted to `unparseable`, and said the answer was
    // now cheap. It is: they ALREADY answer `unparseable` on the allow side, by
    // P2.363's corroboration, so there is nothing left to convert. The splitter
    // output is still byte-identical to the parent's — the bytes were never the
    // problem, the verdict was.
    for (const held of [String.raw`echo $'a'b # c`, String.raw`echo $'a\'b # c`]) {
      expect(matchClaudeBashRule('echo:*', held, { ruleAction: 'allow' })).toBe('unparseable')
      // Both enforcement floors still reach it, so retiring the row costs no reach.
      expect(matchClaudeBashRule('echo:*', held, { ruleAction: 'deny' })).toBe('match')
      expect(matchClaudeBashRule('echo:*', held, { ruleAction: 'ask' })).toBe('match')
    }
    // Controls, so the two rows above are a measurement rather than a blanket
    // refusal of everything: a comment WITHOUT `$'`, and `$'` WITHOUT a comment,
    // both still match on allow.
    expect(matchClaudeBashRule('echo:*', 'echo hi # c', { ruleAction: 'allow' })).toBe('match')
    expect(matchClaudeBashRule('echo:*', String.raw`echo $'a'b`, { ruleAction: 'allow' })).toBe('match')
  })
})

/**
 * The second instance of the same class, found by the sweep the ANSI-C review
 * asked for and NOT covered by the `$'` guard: a comment rule that SKIPS text
 * also skips whatever was unbalanced in it, so a command the parent refused to
 * parse becomes one this splitter parses confidently.
 *
 * An apostrophe in an English comment is all it takes. `rm ./a.txt # don't` was
 * `'unparseable'` on the parent — which `permission-dsl.ts` enters as `ask` —
 * and an unguarded comment rule turned it into a `match` for
 * `allow Bash(rm:*)`. A lost prompt, from a command anyone might type.
 *
 * The rule is therefore ordered: **a comment may NARROW a parse, never rescue
 * one.** `splitCompoundCommand` balances the command with the parent's exact
 * reading first, and that verdict is final.
 */
describe('a comment cannot rescue an unparseable command', () => {
  const stillUnparseable: string[] = [
    String.raw`rm ./a.txt # don't`,
    String.raw`echo hi # it's fine`,
    String.raw`echo hi # don't ; rm -rf /`,
    'echo hi # "unclosed',
    'echo hi # $(unclosed',
    'echo hi # `unclosed',
  ]

  test.each(stillUnparseable)('parses to null exactly as the parent did: %s', command => {
    expect(splitCompoundCommand(command)).toBeNull()
  })

  test('so the prompt survives, on allow and on deny', () => {
    for (const action of ['allow', 'deny', 'ask'] as const) {
      expect(matchClaudeBashRule('rm:*', String.raw`rm ./a.txt # don't`, { ruleAction: action }), action)
        .toBe('unparseable')
    }
  })

  test('the positive control: a BALANCED comment is still narrowed away', () => {
    // The whole point of P2.71 still works — this is only about commands the
    // parent could not balance in the first place.
    expect(splitCompoundCommand('rm ./a.txt # do not')).toEqual(['rm ./a.txt'])
    expect(splitCompoundCommand('echo hi # note | rm -rf /')).toEqual(['echo hi'])
  })

  test('…and a comment that BREAKS the balance still fails closed', () => {
    // The ordering is one-way, not a veto: skipping a comment can remove an
    // OPENER whose closer is on the next line, and then the second pass is the
    // one that refuses. `echo # (` ⏎ `)` is `syntax error near unexpected token
    // ')'` in `/bin/sh -lc`, and the parent returned it as one confident
    // segment — so failing closed here is also the more accurate answer.
    expect(splitCompoundCommand('echo # (\n)')).toBeNull()
    expect(splitCompoundCommand("echo # '\nx'")).toBeNull()
    // …while a `#` INSIDE a span was never a comment, so nothing moves.
    expect(splitCompoundCommand('echo $( # )')).toEqual(['echo $( # )'])
  })

  /**
   * End to end, because the splitter verdict is not the user-visible one:
   * `permission-dsl.ts` maps `'unparseable'` to PROMPT_ANYWAY and enters it as
   * `ask`, which outranks `allow` — so losing the parse was losing a prompt.
   * `allow Bash(git commit:*)` is a canonical user rule and an apostrophe in a
   * commit message is a normal reason to reach for `$'…'`.
   */
  test('an allow rule does not auto-approve past an ANSI-C quote', () => {
    const decide = (rules: Array<[string, 'allow' | 'deny']>, command: string) =>
      evaluatePermissionDslV1(
        compilePermissionDslV1({
          generation: 'g',
          projectTrusted: true,
          layers: [{
            scope: 'workspace',
            sourceDigest: 'd',
            document: {
              version: 1,
              rules: rules.map(([raw, action], index) => {
                const parsed = parseClaudeRuleString(raw, action)
                if (!parsed.rule) throw new Error(`did not compile: ${raw}`)
                return { id: `r${index}`, action, match: parsed.rule.match }
              }),
            },
          }],
        }),
        { generation: 'g', semanticId: 'bash', toolName: 'Bash', input: { command }, cwd: '/work' },
      ).action

    // `allow Bash(git commit:*)` is a canonical user rule and an apostrophe in a
    // commit message is a normal reason to reach for `$'…'`. Unguarded, this
    // returned `allow` — the prompt the parent raised, gone.
    expect(decide([['Bash(git commit:*)', 'allow']], String.raw`git commit -m $'don\'t # ship'; rm -rf ~`))
      .toBe('ask')
    expect(decide([['Bash(echo:*)', 'allow'], ['Bash(rm:*)', 'deny']], String.raw`echo $'a\'b # c'; rm -rf /`))
      .toBe('ask')
    // The deny the parent reached is still reached.
    expect(decide([['Bash(rm:*)', 'deny']], String.raw`echo $'a\'b # c ; rm -rf /' ; rm -rf /tmp/x \'`))
      .toBe('deny')
    // The positive control on the same rig: the ordinary-quoted twin is
    // unaffected by any of this, so the rows above are about `$'` and nothing
    // else.
    expect(decide([['Bash(git commit:*)', 'allow']], String.raw`git commit -m 'do not # ship'; rm -rf ~`))
      .toBeUndefined()
  })
})

/**
 * The THIRD instance of the same class, after ANSI-C quoting above and
 * PowerShell's `<#`, and the first found by probing the construct class rather
 * than by the corpus sweep (which carries no `<<` fixture at all): sh HEREDOCS.
 * `cmd <<EOF … EOF` feeds a body to stdin and every character of that body is
 * inert text to the shell — but this scanner has no heredoc model, so an
 * apostrophe in the BODY flips its quote state. From there
 * it reads a later REAL opening quote as a CLOSE, sees the `#` inside what bash
 * knows is a quoted word as a top-level word-start `#`, and the comment rule
 * eats the rest of the command: the real closing quote AND the subcommand behind
 * it. A QUOTED delimiter (`<<'EOF'`) changes nothing — the desync is in the body.
 *
 * MEASURED on the parent of the guard (2026-08-24), with `home` = `/Users/tester`:
 *
 * | command | `splitCompoundCommand` | `deny Bash(rm:*)` | `findRootOrHomeRemoval` |
 * | --- | --- | --- | --- |
 * | `cat <<EOF\ndon't\nEOF\necho 'a # b' \' ; rm -rf ~` | `["cat <<EOF", "don't\nEOF\necho 'a"]` | **`no-match`** | **`null`** |
 * | the same body `'`, tail `; rm -rf /` | loses the tail the same way | **`no-match`** | **`null`** |
 * | the same with `<<'EOF'`, tail `\| rm -rf /` | loses the tail the same way | **`no-match`** | **`null`** |
 * | CONTROL, no `#` in the quoted word | keeps `rm -rf ~` | `match` | `{target:'home'}` |
 * | CONTROL, no heredoc | keeps `rm -rf ~` | `match` | `{target:'home'}` |
 *
 * The fix is the `$'` guard's twin and deliberately no smarter (same owner
 * ruling, same measurement behind it): a command containing `<<` gets NO comment
 * rule at all. The post-fix verdict is `'match'`, not `'unparseable'` — the
 * disarmed scan reaches the same split the two controls always had.
 */
describe('a heredoc cannot hide a subcommand (<<)', () => {
  const HOME = '/Users/tester'

  /**
   * label, command, post-fix split, the removal the parent lost.
   *
   * **The `split` column moved again at P3.329** and the movement is the point:
   * the guard alone left the body glued to the command behind it
   * (`["cat <<EOF", "don't\nEOF\necho 'a # b' \\'", "rm -rf ~"]`), because the
   * body's apostrophe still desynced the quote state — it only stopped the
   * comment rule from eating the tail. With the heredoc body EXCISED the body
   * text is gone entirely and the three real commands stand apart. The deny and
   * breaker rows below are unchanged in both readings, which is what says this
   * is a cleaner parse rather than a different verdict.
   */
  const reproductions: Array<[string, string, string[], 'home' | 'root']> = [
    [
      'an apostrophe in the body',
      "cat <<EOF\ndon't\nEOF\necho 'a # b' \\' ; rm -rf ~",
      ['cat <<EOF', "echo 'a # b' \\'", 'rm -rf ~'],
      'home',
    ],
    [
      'a bare quote in the body',
      "cat <<EOF\n'\nEOF\necho 'a # b' \\' ; rm -rf /",
      ['cat <<EOF', "echo 'a # b' \\'", 'rm -rf /'],
      'root',
    ],
    [
      "a QUOTED delimiter, <<'EOF'",
      "cat <<'EOF'\ndon't\nEOF\necho 'a # b' \\' | rm -rf /",
      ["cat <<'EOF'", "echo 'a # b' \\'", 'rm -rf /'],
      'root',
    ],
  ]

  test.each(reproductions)('the split keeps the subcommand: %s', (_label, command, split) => {
    expect(splitCompoundCommand(command)).toEqual(split)
  })

  test.each(reproductions)('a deny rule reaches the subcommand: %s', (_label, command) => {
    // Not `'unparseable'`: MEASURED post-fix, the disarmed scan balances and the
    // rule matches the segment the parent had dropped.
    for (const pattern of ['rm:*', 'rm *']) {
      expect(matchClaudeBashRule(pattern, command, { ruleAction: 'deny' }), pattern).toBe('match')
    }
  })

  /**
   * The breaker consumes `splitWithSubstitutions` from this file, so it inherits
   * the guard rather than carrying one of its own. This row pins the
   * inheritance: on the parent every reproduction returned `null` — no prompt at
   * all for `rm -rf ~` / `rm -rf /`.
   */
  test.each(reproductions)('the removal circuit breaker sees it again: %s', (_label, command, _split, target) => {
    expect(findRootOrHomeRemoval(command, { home: HOME, platform: 'darwin' })?.target).toBe(target)
  })

  /**
   * The two controls, byte-identical before and after the guard. They are what
   * makes the rows above about the `#`-in-a-quoted-word desync and nothing else:
   * one drops the `#`, one drops the heredoc, and both always kept `rm -rf ~`.
   */
  test('the controls do not move', () => {
    const noHash = "cat <<EOF\ndon't\nEOF\necho 'a b' \\' ; rm -rf ~"
    // P3.329: the body is excised here too, so this control now differs from the
    // rows above only in the `#` it never had. It still keeps `rm -rf ~`, which
    // is the property the control exists for.
    expect(splitCompoundCommand(noHash)).toEqual(['cat <<EOF', "echo 'a b' \\'", 'rm -rf ~'])
    expect(matchClaudeBashRule('rm:*', noHash, { ruleAction: 'deny' })).toBe('match')
    expect(findRootOrHomeRemoval(noHash, { home: HOME, platform: 'darwin' })?.target).toBe('home')

    const noHeredoc = "echo 'a # b' \\' ; rm -rf ~"
    expect(splitCompoundCommand(noHeredoc)).toEqual(["echo 'a # b' \\'", 'rm -rf ~'])
    expect(matchClaudeBashRule('rm:*', noHeredoc, { ruleAction: 'deny' })).toBe('match')
    expect(findRootOrHomeRemoval(noHeredoc, { home: HOME, platform: 'darwin' })?.target).toBe('home')
  })

  /**
   * The guard's SCOPE, pinned so the next reader sees what it costs. `<<` keys
   * on two characters, not on a parse, so it also disarms the rule for
   * here-strings (`<<<`) and arithmetic left-shift (`$((1<<2))`). Erring that way
   * is the point: with the rule off, comment text is scanned as COMMAND text, so
   * a rule sees more than the shell runs, never less.
   */
  test('the guard visibly disarms the comment rule, over-firing where it does', () => {
    // A comment tail is no longer excised — it survives as its own segment.
    // P3.329 removed the body (`hi`/`EOF`) from this list; the guard itself is
    // untouched, which is why the `# tail` segment is still here.
    expect(splitCompoundCommand('cat <<EOF\nhi\nEOF\n# tail'))
      .toEqual(['cat <<EOF', '# tail'])
    // …and the `<<`-free twin still loses it, which is the positive control
    // proving the guard is what changed the row above.
    expect(splitCompoundCommand('cat file\n# tail')).toEqual(['cat file'])

    // Here-string and arithmetic shift: not heredocs, guarded anyway.
    expect(splitCompoundCommand('echo <<< hi # tail')).toEqual(['echo <<< hi # tail'])
    expect(splitCompoundCommand('echo $((1<<2)) # tail')).toEqual(['echo $((1<<2)) # tail'])

    // The cost, in the safe direction: the substitution veto fires again on a
    // substitution that sits inside a comment, so an allow rule prompts. Since
    // P2.363 it prompts one step earlier, at the split, and `'unparseable'` is
    // the same prompt `'no-match'` produced here.
    expect(matchClaudeBashRule('echo:*', 'echo <<< hi # $(rm -rf /)', { ruleAction: 'allow' }))
      .toBe('unparseable')
    expect(matchClaudeBashRule('echo:*', 'echo hi # $(rm -rf /)', { ruleAction: 'allow' }))
      .toBe('match')

    // The other cost, also a prompt: P2.71's shape returns for `<<` commands, so
    // the `~` in a comment tail re-raises a home prompt for a one-file removal.
    expect(findRootOrHomeRemoval('cat <<EOF\nhi\nEOF\nrm ./one.txt # also clears ~', { home: HOME, platform: 'darwin' })?.target)
      .toBe('home')
    expect(findRootOrHomeRemoval('rm ./one.txt # also clears ~', { home: HOME, platform: 'darwin' }))
      .toBeNull()
  })
})

/**
 * P3.329 — the heredoc BODY, read as commands, and the ruling that had to be
 * lifted before it could stop being.
 *
 * The describe above is the GUARD: a command containing `<<` gets no comment
 * rule, which stopped the comment rule eating a subcommand and did nothing about
 * the body itself. `["cat <<EOF", "rm -rf ~", "EOF"]` is what remained — the
 * non-negotiable removal breaker firing on a heredoc that removes nothing, and
 * the deny/ask DSL sharing the same splitter.
 *
 * The owner sitting of 2026-09-05 (§1.5 = (A)) lifted the dumber-not-smarter
 * ruling for this one construct, on the precondition that §1.6's read-only
 * corpus copy land first so the change could be WEIGHTED rather than argued.
 * It did (P2.389), and it is the instrument here:
 * `bun scripts/command-corpus.ts split-diff` over 19 619 real agent-issued
 * commands reports **0 moves on a command with no `<<`** and **0 invented
 * segments** — every segment the new reading offers a rule already existed
 * inside a segment the old one offered — against 3 343 commands whose body
 * lines stopped being read as commands and 944 rescued from `'unparseable'`.
 */
describe('a heredoc body is not a list of commands (P3.329)', () => {
  const HOME = '/Users/tester'

  test("the row's own reproduction: the breaker no longer fires on a body", () => {
    const command = 'cat <<EOF\nrm -rf ~\nEOF'
    // BEFORE: three subcommands, the middle one a removal the shell never runs.
    expect(splitCompoundCommandWithoutHeredocModel(command)).toEqual(['cat <<EOF', 'rm -rf ~', 'EOF'])
    expect(findRootOrHomeRemoval(command, { home: HOME, platform: 'darwin' })).toBeNull()
    expect(splitCompoundCommand(command)).toEqual(['cat <<EOF'])
    // And the tail after the terminator is still its own subcommand.
    expect(splitCompoundCommand('cat <<EOF\nrm -rf ~\nEOF\necho done')).toEqual(['cat <<EOF', 'echo done'])
  })

  test('a quoted delimiter makes the body inert even when it reads like a command', () => {
    // `<<'EOF'` suppresses every expansion, so a substitution in the body is
    // text. Excising it cannot hide anything the shell would run.
    expect(splitCompoundCommand("cat <<'EOF'\n$(rm -rf ~)\nEOF")).toEqual(["cat <<'EOF'"])
    expect(splitCompoundCommand('cat <<"EOF"\nrm -rf ~\nEOF')).toEqual(['cat <<"EOF"'])
    expect(splitCompoundCommand('cat <<\\EOF\nrm -rf ~\nEOF')).toEqual(['cat <<\\EOF'])
  })

  test('an UNQUOTED body offers its SUBSTITUTION SPANS and nothing else (P6.716)', () => {
    // bash expands `$(…)` and backticks inside an unquoted-delimiter body, so
    // that text really is executed and must still reach the breaker. P3.329 kept
    // the WHOLE body for it, which was its stated residue: every other line of
    // such a body is data fed to stdin, and keeping it alive kept the
    // `["cat <<EOF", "rm -rf ~", "EOF"]` shape for exactly the bodies that
    // happened to carry one substitution somewhere.
    const command = 'cat <<EOF\n$(rm -rf ~)\nEOF'
    expect(splitCompoundCommand(command)).toEqual(['cat <<EOF', '$(rm -rf ~)'])
    // The property that must not move: the breaker still sees the removal.
    expect(findRootOrHomeRemoval(command, { home: HOME, platform: 'darwin' })?.target).toBe('home')
    // A backtick span is the same shape.
    expect(splitCompoundCommand('cat <<EOF\n`rm -rf ~`\nEOF'))
      .toEqual(['cat <<EOF', '`rm -rf ~`'])
  })

  test('P6.716 fixture 1: the data lines of an expanding body go the way of any body', () => {
    // The whole point. One substitution somewhere in the body used to keep the
    // other lines readable as commands, so a body line saying `rm -rf ~` fired
    // the non-negotiable breaker on a removal the shell never runs.
    const command = 'cat <<EOF\nrm -rf ~\n$(id)\nEOF'
    expect(splitCompoundCommandWithoutHeredocModel(command))
      .toEqual(['cat <<EOF', 'rm -rf ~', '$(id)', 'EOF'])
    expect(splitCompoundCommand(command)).toEqual(['cat <<EOF', '$(id)'])
    expect(findRootOrHomeRemoval(command, { home: HOME, platform: 'darwin' })).toBeNull()
  })

  test('P6.716 fixture 2: several spans, each its own subcommand, in order', () => {
    const command = 'cat <<EOF\nprefix $(id) middle `whoami` suffix\ndata line\nEOF\necho after'
    expect(splitCompoundCommand(command))
      .toEqual(['cat <<EOF', '$(id)', '`whoami`', 'echo after'])
    // CONTROL, the same body under a quoted delimiter: nothing expands, so
    // nothing is offered and the reading is unchanged from P3.329's.
    expect(splitCompoundCommand(command.replace('<<EOF', "<<'EOF'")))
      .toEqual(["cat <<'EOF'", 'echo after'])
  })

  test('P6.716: an ESCAPED marker yields no span, and then the body is left alone', () => {
    // `\\$(` is literal text to bash. The scanner produces no span for it, and a
    // body the scanner cannot account for keeps the reading it had before —
    // over-blocking is the safe direction when the model is unsure.
    const command = 'cat <<EOF\n\\$(rm -rf ~)\nEOF'
    expect(splitCompoundCommand(command)).toEqual(splitCompoundCommandWithoutHeredocModel(command))
  })

  test('the shapes a `<<` is NOT: here-string, arithmetic shift, quoted text', () => {
    // Each of these keeps the reading it has today, byte for byte.
    for (const command of [
      'cat <<< hi && echo x',
      'echo $((1<<2)) && rm -rf ~',
      "echo 'a <<b' && echo c",
      'a && b || c; d | e |& f & g',
    ]) {
      expect(splitCompoundCommand(command), command).toEqual(splitCompoundCommandWithoutHeredocModel(command))
    }
  })

  test('the operator forms: `<<-`, several on one line, and an unterminated body', () => {
    // `<<-` strips leading TABS from the terminator.
    expect(splitCompoundCommand('cat <<-EOF\n\tbody\n\tEOF\necho after')).toEqual(['cat <<-EOF', 'echo after'])
    // Two heredocs opened on one line consume their bodies in order.
    expect(splitCompoundCommand('cat <<A <<B\naaa\nA\nbbb\nB\necho after'))
      .toEqual(['cat <<A <<B', 'echo after'])
    // An unterminated heredoc reads to end of input — which is what bash does
    // with it, so those lines are body and not commands.
    expect(splitCompoundCommand('cat <<EOF\nnever terminated\nrm -rf ~')).toEqual(['cat <<EOF'])
  })

  /**
   * THE MIRRORED SHAPE, DOCUMENTED RATHER THAN CLOSED — the row named it and
   * this test is where it is written down.
   *
   * Over-blocking and under-blocking mirror through the same splitter. Now that
   * a body is data, a heredoc that WRITES a script and a later command that RUNS
   * it is a removal the breaker does not see. That is honest: the body is not
   * executed at the moment it is written, and the splitter's job is to say what
   * this command runs.
   *
   * It is also not a regression this row introduces in any general sense. The
   * same removal is equally invisible when it is written with `printf`, with a
   * `python3 -c` one-liner, or by a file-writing tool that is not Bash at all —
   * the splitter has never been the floor for deferred execution. What P3.329
   * removes is an ACCIDENTAL catch that existed only because the body's lines
   * happened to be split apart, and which fired just as readily on bodies that
   * were never executed at all.
   *
   * The floor that does apply is the one on the command that actually runs the
   * script, and this test pins that half too.
   */
  test('KNOWN SHAPE: a body executed LATER is not seen at write time', () => {
    const write = "cat <<'EOF' > ./tmp-script.sh\nrm -rf ~\nEOF"
    expect(splitCompoundCommand(write)).toEqual(["cat <<'EOF' > ./tmp-script.sh"])
    expect(findRootOrHomeRemoval(write, { home: HOME, platform: 'darwin' })).toBeNull()
    // The write and the run in ONE command: the run is still its own subcommand,
    // so a `deny Bash(sh:*)` still reaches it. The breaker cannot read the file.
    const writeAndRun = `${write}\nsh ./tmp-script.sh`
    expect(splitCompoundCommand(writeAndRun)).toEqual(["cat <<'EOF' > ./tmp-script.sh", 'sh ./tmp-script.sh'])
    expect(matchClaudeBashRule('sh:*', writeAndRun, { ruleAction: 'deny' })).toBe('match')
  })
})

/**
 * P6.717 — the corpus instrument's CI arm.
 *
 * `scripts/command-corpus.ts split-diff` is the heredoc split's only weighting
 * and it runs on exactly one machine: the corpus copy is untrusted transcript
 * text, lives outside the repository and is never committed. What CAN be
 * committed is arithmetic over it — a class histogram and the summed shape
 * fields, generated by `scripts/heredoc-shape-slice.ts`, which is structurally
 * incapable of emitting command text (strings in, integers out; its own test
 * plants a secret-shaped string and proves no fragment survives).
 *
 * This is deliberately the WEAKER half of the pair, and the division is worth
 * stating: `split-diff` proves nothing moved that should not have; these numbers
 * prove the population the model acts on has not changed shape. When they move,
 * the answer is not to edit them — it is to run `split-diff` again on the
 * machine that holds the corpus and regenerate the slice in the same commit.
 */
describe('the committed corpus shape slice (P6.717)', () => {
  const slice = JSON.parse(
    readFileSync(join(import.meta.dir, '__fixtures__/heredoc-shape-slice.json'), 'utf8'),
  ) as {
    corpusTakenAt: string
    corpusCommands: number
    classes: Record<string, number>
    totals: Record<string, number>
  }

  test('is keyed by the classifier\'s own class names, exactly', () => {
    // A renamed or added class fails HERE, which is the tripwire: the slice can
    // then only be made green by regenerating it where the corpus lives.
    expect(Object.keys(slice.classes).sort()).toEqual([...HEREDOC_SHAPE_CLASSES].sort())
  })

  test('pins the class counts of the 2026-09-07 corpus', () => {
    expect(slice.corpusTakenAt).toBe('2026-09-07')
    expect(slice.corpusCommands).toBe(19619)
    expect(slice.classes).toEqual({
      noHeredoc: 15242,
      inertBody: 4340,
      expandingWithoutSubstitution: 37,
      expandingWithSubstitution: 0,
    })
    expect(slice.totals).toEqual({
      bodySpans: 5157,
      bodyLines: 120940,
      expandingBodies: 46,
      executableBodies: 0,
      substitutionSpans: 0,
    })
    // The histogram must account for every command, or it is a sample and not a
    // census — and a census is the only thing these numbers are worth pinning as.
    const summed = HEREDOC_SHAPE_CLASSES.reduce((total, name) => total + (slice.classes[name] ?? 0), 0)
    expect(summed).toBe(slice.corpusCommands)
  })

  test('the class NAMES mean what the slice says they mean', () => {
    // Without this the pinned numbers are opaque: they would still be equal to
    // themselves after a classifier change that redefined a class wholesale.
    const classOf = (command: string) => classifyHeredocShape(describeHeredocShape(command))
    expect(classOf('git status')).toBe('noHeredoc')
    expect(classOf("cat <<'EOF'\n$(rm -rf ~)\nEOF")).toBe('inertBody')
    expect(classOf('cat <<EOF\nplain body\nEOF')).toBe('expandingWithoutSubstitution')
    expect(classOf('cat <<EOF\n$(id)\nEOF')).toBe('expandingWithSubstitution')
  })

  test('carries no string it did not write itself', () => {
    // The same structural claim the generator's own test makes, asserted again
    // over the COMMITTED artefact — a slice regenerated by a future edit is read
    // by CI, so CI is where the property has to hold.
    const raw = readFileSync(join(import.meta.dir, '__fixtures__/heredoc-shape-slice.json'), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const own = new Set([parsed.what, parsed.generatedBy, parsed.corpusTakenAt])
    const walk = (value: unknown, path: string): void => {
      // `typeof value` picks the arm, so it is asserted BEFORE any arm runs.
      // Without this a boolean anywhere in the slice falls past both returns
      // into `Object.entries(true)`, which is `[]`: the walk visits nothing,
      // reads nothing, and the test passes on a value it never looked at. A
      // `null` at least throws there, so the boolean is the silent one.
      expect({
        path,
        walkable: typeof value === 'number' || typeof value === 'string'
          || (typeof value === 'object' && value !== null),
      }).toEqual({ path, walkable: true })
      if (typeof value === 'number') return
      if (typeof value === 'string') {
        expect(own.has(value), `${path} = ${value}`).toBe(true)
        return
      }
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        walk(nested, `${path}.${key}`)
      }
    }
    walk(parsed, 'slice')
  })
})

/**
 * The FOURTH instance of the same class, after ANSI-C `$'…'`, heredocs, and
 * PowerShell's `<#` — and the first that is NOT a quote-state desync but a word-
 * BOUNDARY divergence, so no per-construct quote guard reaches it (P2.99). The
 * word-start setter used JS `/\s/`, which matches VT, FF and a dozen Unicode
 * blanks (NBSP, U+1680, U+2000–200A, U+2028, U+2029, U+202F, U+205F, U+3000, the
 * BOM) that bash keeps INSIDE a word. A `#` after one of them opened a comment
 * the scanner saw and the shell never opens, so the comment rule ate the
 * separator and the real subcommand behind it — `deny Bash(rm:*)` went
 * match → no-match and `allow Bash(git status:*)` went no-match → match.
 *
 * Shell truth, MEASURED 2026-08-24 through `/bin/sh` and `/bin/bash` (bash
 * 3.2.57), C locale and en_US.UTF-8, all four agreeing:
 * `echo a<WS># note ; echo SECOND` RUNS the tail for every char below (the `#`
 * is ordinary text) and does NOT for a plain space (the `#` is a comment). The
 * character, not the comment rule, is the whole difference — which is what the
 * plain-space control at the bottom pins. Chars are written as `\uXXXX` escapes
 * so the source stays visible ASCII.
 */
describe('a non-shell blank before # cannot hide a subcommand (P2.99)', () => {
  const HOME = '/Users/tester'

  /** label, the whitespace char (an escape, never a literal invisible char). */
  const blanks: Array<[string, string]> = [
    ['U+00A0 NBSP', '\u00a0'],
    ['U+000B VT', '\u000b'],
    ['U+000C FF', '\u000c'],
    ['U+2028 LINE SEP', '\u2028'],
    ['U+3000 IDEO SP', '\u3000'],
    ['U+FEFF BOM', '\uFEFF'],
  ]

  test.each(blanks)('the split keeps the hidden subcommand: %s', (_label, ws) => {
    // bash reads `git status<WS>#` as one word, so both segments stand.
    expect(splitCompoundCommand(`git status${ws}# ok ; rm -rf ~`))
      .toEqual([`git status${ws}# ok`, 'rm -rf ~'])
  })

  test.each(blanks)('a deny rule reaches it and the breaker regains home: %s', (_label, ws) => {
    const cmd = `git status${ws}# ok ; rm -rf ~`
    for (const pattern of ['rm:*', 'rm *']) {
      expect(matchClaudeBashRule(pattern, cmd, { ruleAction: 'deny' }), pattern).toBe('match')
    }
    expect(findRootOrHomeRemoval(cmd, { home: HOME, platform: 'darwin' })?.target).toBe('home')
  })

  test.each(blanks)('a glob allow rule no longer approves the hidden tail: %s', (_label, ws) => {
    // allow requires EVERY subcommand to match, and `rm -rf ~` is not git status.
    expect(matchClaudeBashRule('git status:*', `git status${ws}# ok ; rm -rf ~`, { ruleAction: 'allow' }))
      .toBe('no-match')
  })

  test('the whole path inherits it — splitWithSubstitutions and the DSL', () => {
    const decide = (raw: string, action: 'allow' | 'deny', command: string) => {
      const parsed = parseClaudeRuleString(raw, action)
      if (!parsed.rule) throw new Error(`did not compile: ${raw}`)
      return evaluatePermissionDslV1(
        compilePermissionDslV1({
          generation: 'g', projectTrusted: true,
          layers: [{ scope: 'workspace', sourceDigest: 'd',
            document: { version: 1, rules: [{ id: 'r', action, match: parsed.rule.match }] } }],
        }),
        { generation: 'g', semanticId: 'bash', toolName: 'Bash', input: { command }, cwd: '/work' },
      ).action
    }
    const cmd = 'git status\u00a0# ok ; rm -rf ~'
    expect(splitWithSubstitutions(cmd)).toEqual(['git status\u00a0# ok', 'rm -rf ~'])
    // deny fires (was `undefined`); allow no longer approves (was `allow`).
    expect(decide('Bash(rm:*)', 'deny', cmd)).toBe('deny')
    expect(decide('Bash(git status:*)', 'allow', cmd)).toBeUndefined()
  })

  /**
   * The control that makes every row above about the CHARACTER and not the
   * comment rule: a genuine comment after a PLAIN SPACE (or tab, or a line-
   * leading `#` after LF) still excises, so P2.71's behaviour is untouched. The
   * shell really does open a comment there.
   */
  test('a real shell blank still opens a comment (P2.71 preserved)', () => {
    expect(splitCompoundCommand('git status # ok ; rm -rf ~')).toEqual(['git status'])
    expect(splitCompoundCommand('git status\t# ok ; rm -rf ~')).toEqual(['git status'])
    expect(splitCompoundCommand('cat file\n# tail')).toEqual(['cat file'])
    expect(splitCompoundCommand('rm ./a.txt # note')).toEqual(['rm ./a.txt'])
    expect(matchClaudeBashRule('rm:*', 'git status # ok ; rm -rf ~', { ruleAction: 'deny' })).toBe('no-match')
    expect(findRootOrHomeRemoval('rm ./one.txt # also clears ~', { home: HOME, platform: 'darwin' }))
      .toBeNull()
  })

  /**
   * The CR sub-hole (chain re-review). A bare CR is NOT a shell line terminator:
   * `echo a\r#x <sep> rm -rf ~` is the single word `a\r#x` to bash, then a REAL
   * separator that runs `rm -rf ~` (MEASURED 2026-08-24 — `echo a\r#x <sep> echo P`
   * prints P for `;` `|` `&&` `&` on both `/bin/sh` and `/bin/bash`, C and
   * en_US.UTF-8). An earlier pass kept `\r` in the word-start set; that opened a
   * comment the shell does not, and its run-to-end-of-line skip then ate the
   * separator AND `rm -rf ~` — deny went match → no-match, breaker home → null,
   * and the tail ran. CR sets a word boundary ONLY as a separator (`onSeparator`,
   * a deliberate over-fire); it must never, on its own, open a comment.
   */
  test.each([';', '|', '&&', '&'])('a bare CR before # cannot hide a subcommand: sep %s', sep => {
    const cmd = `echo a\r#x ${sep} rm -rf ~`
    for (const pattern of ['rm:*', 'rm *']) {
      expect(matchClaudeBashRule(pattern, cmd, { ruleAction: 'deny' }), pattern).toBe('match')
    }
    expect(findRootOrHomeRemoval(cmd, { home: HOME, platform: 'darwin' })?.target).toBe('home')
  })

  /**
   * The CRLF control. bash's line terminator is LF; `\r\n` ends a line and a
   * line-leading `#` after it is a comment — but this splitter consumes `\r\n` as
   * a single 2-char separator, so the LF never re-arms word-start and the comment
   * is NOT excised. That is a SAFE over-fire, not a hole: the `#`-headed segment
   * matches no removal rule and the shell runs nothing there. LF alone (the real
   * terminator) still excises, which is the positive control.
   */
  test('a CRLF line-start comment is a safe over-fire; LF alone still excises', () => {
    expect(splitCompoundCommand('cat file\r\n# tail')).toEqual(['cat file', '# tail'])
    // No hole: a CRLF-line-start comment naming ~ raises no deny and no removal.
    expect(matchClaudeBashRule('rm:*', 'cat f\r\n# rm -rf ~', { ruleAction: 'deny' })).toBe('no-match')
    expect(findRootOrHomeRemoval('cat f\r\n# rm -rf ~', { home: HOME, platform: 'darwin' })).toBeNull()
    // LF alone is the real terminator and still excises (positive control).
    expect(splitCompoundCommand('cat file\n# tail')).toEqual(['cat file'])
  })
})

describe('matchClaudeBashIfRule', () => {
  // The documented hooks.md matching table, verbatim rows.
  const ifCases: Array<[pattern: string, command: string, want: Want]> = [
    ['git *',      'FOO=bar git push',      'match'],      // leading assignments stripped unconditionally
    ['git *',      'npm test && git push',  'match'],      // ANY subcommand matches
    ['rm *',       'echo $(rm -rf /)',      'match'],      // $() contents checked
    ['rm *',       'echo $(date)',          'no-match'],   // no subcommand matches
    ['git push *', 'echo $(date)',          'match'],      // more-than-command-name + $() => fail open
    ['git *',      'npm test',              'no-match'],
    ['git *',      'git status',            'match'],
    ['rm *',       'echo `rm -rf /`',       'match'],      // backtick contents checked
    ['git push *', 'echo $HOME',            'match'],      // $VAR triggers the fail-open path too
    ['git push *', 'npm test',              'no-match'],   // no dynamic content: normal matching
    ['git *',      'git "status',           'unparseable'],
    // Arithmetic is not a substitution, so it contributes no extra subcommand;
    // a substitution nested inside it still does. (The `$VAR`-shaped fail-open
    // at `namesMoreThanCommand` is a separate path — these patterns are one
    // token, so they take normal matching.)
    ['rm *',       'echo $((1+1))',         'no-match'],
    ['rm *',       'echo $(( $(rm -rf /) ))', 'match'],
    // Each open span now carries its own start offset, so a nested backtick no
    // longer clobbers the enclosing `$(` span's inner text. Before, BOTH of
    // these were 'no-match': the outer span was reported as the backtick's
    // slice, so neither the outer command nor the inner one was ever seen.
    ['printf *',   'echo $(printf `date -u`)', 'match'],
    ['date *',     'echo $(printf `date -u`)', 'match'],
  ]

  test.each(ifCases)('if %s vs %s -> %s', (pattern, command, want) => {
    expect(matchClaudeBashIfRule(pattern, command)).toBe(want)
  })
})

describe('deny and ask rules see through privilege and exec wrappers', () => {
  // `whats-new/2026-w16.md`: "deny rules now match through `env`/`sudo`/`watch`
  // wrappers". Measured on this repo before the fix: every wrapped row below
  // returned 'no-match' for deny, so writing `sudo` in front of a command
  // defeated a deny rule — including a managed policy's.
  const wrapped: Array<[pattern: string, command: string]> = [
    ['rm:*',   'sudo rm -rf /tmp/x'],
    ['rm:*',   'sudo -u root rm -rf /tmp/x'],
    ['rm:*',   'doas rm -rf /tmp/x'],
    ['rm:*',   'env rm -rf /tmp/x'],
    ['rm:*',   'env -i rm -rf /tmp/x'],
    ['rm:*',   'env -u PATH rm -rf /tmp/x'],
    ['rm:*',   'env -S "rm -rf /tmp/x"'],
    ['rm:*',   "env --split-string='rm -rf /tmp/x'"],
    ['rm:*',   'watch rm -rf /tmp/x'],
    ['rm:*',   'setsid rm -rf /tmp/x'],
    ['rm:*',   'sudo env FOO=1 watch rm -rf /tmp/x'],
    ['curl:*', 'env HTTPS_PROXY=http://evil curl http://evil'],
  ]

  test.each(wrapped)('deny Bash(%s) matches %s', (pattern, command) => {
    expect(matchClaudeBashRule(pattern, command, { ruleAction: 'deny' })).toBe('match')
    expect(matchClaudeBashRule(pattern, command, { ruleAction: 'ask' })).toBe('match')
  })

  // The asymmetry is the security property. An allow rule that saw through
  // `sudo` would let Bash(rm:*) auto-approve `sudo rm`, escalating the rule to
  // root, so allow must still refuse every row above.
  test.each(wrapped)('allow Bash(%s) still refuses %s', (pattern, command) => {
    expect(matchClaudeBashRule(pattern, command, { ruleAction: 'allow' })).toBe('no-match')
  })

  test('a rule naming the wrapper itself still matches it', () => {
    expect(matchClaudeBashRule('sudo:*', 'sudo rm -rf /tmp/x', { ruleAction: 'deny' })).toBe('match')
    expect(matchClaudeBashRule('env:*', 'env FOO=1 ls', { ruleAction: 'deny' })).toBe('match')
  })

  test('wrapper stripping does not invent matches', () => {
    expect(matchClaudeBashRule('ls:*', 'sudo echo hi', { ruleAction: 'deny' })).toBe('no-match')
    expect(matchClaudeBashRule('rm:*', 'env FOO=1 ls', { ruleAction: 'deny' })).toBe('no-match')
  })
})

describe('deny and ask rules see into a `-c` shell script (P3.12)', () => {
  // Measured on this repo before the fix (2026-08-24): every row below returned
  // 'no-match' for deny, so `sh -c` in front of a command defeated a deny rule
  // the same way `sudo` did before `4af8bd1e` and `$(…)` did before 2026-08-21.
  // `findRootOrHomeRemoval('/bin/zsh -lc "rm -rf ~"')` returned null on the same
  // rig while the bare, `sudo`- and substitution-wrapped spellings all fired.
  //
  // The reach matters most on codex, where it is not an evasion but the DEFAULT
  // transport: the bundled `codex-app-server`'s `shell_command` takes "Shell
  // script to run in the user's default shell" with `login` defaulting to true,
  // so a codex turn's commands reach this matcher as `<shell> -lc '<script>'`
  // (T6 live, 2026-08-23: a `tail:*` deny refused the Monitor watch and did not
  // cover codex's own `/bin/zsh -lc 'tail -f …'`).
  const wrapped: Array<[pattern: string, command: string]> = [
    ['rm:*',   `sh -c 'rm -rf /tmp/x'`],
    ['rm:*',   `bash -c "rm -rf /tmp/x"`],
    ['rm:*',   `/bin/zsh -lc 'rm -rf /tmp/x'`],
    ['tail:*', `/bin/zsh -lc 'tail -f /tmp/probe.log'`],
    ['tail:*', `zsh -ic 'tail -f /tmp/probe.log'`],
    ['curl:*', `dash -c 'curl http://evil'`],
    // Through the wrappers the enforcement pass already sees through.
    ['rm:*',   `sudo bash -lc 'rm -rf /tmp/x'`],
    ['rm:*',   `env FOO=1 sh -c 'rm -rf /tmp/x'`],
    // A compound script: the splitter walks it exactly as a top-level one.
    ['rm:*',   `bash -lc 'ls -la && rm -rf /tmp/x'`],
    // And a substitution inside the script, to the same budget.
    ['rm:*',   `bash -lc 'echo $(rm -rf /tmp/x)'`],
    // Nested one level: the script is command text wherever it sits.
    ['rm:*',   `sh -c "bash -c 'rm -rf /tmp/x'"`],
  ]

  test.each(wrapped)('deny Bash(%s) matches %s', (pattern, command) => {
    expect(matchClaudeBashRule(pattern, command, { ruleAction: 'deny' })).toBe('match')
    expect(matchClaudeBashRule(pattern, command, { ruleAction: 'ask' })).toBe('match')
  })

  // The same asymmetry as `sudo`, and for the same reason: an allow rule that
  // read the script would let `Bash(tail:*)` auto-approve a LOGIN shell — which
  // sources the user's rc files before running anything — off a rule that only
  // ever named `tail`. Allow reads the top-level subcommands and nothing else.
  test.each(wrapped)('allow Bash(%s) still refuses %s', (pattern, command) => {
    expect(matchClaudeBashRule(pattern, command, { ruleAction: 'allow' })).toBe('no-match')
  })

  test('a rule naming the shell itself still matches it', () => {
    expect(matchClaudeBashRule('zsh:*', `zsh -lc 'ls'`, { ruleAction: 'deny' })).toBe('match')
    expect(matchClaudeBashRule('sh:*', `sh -c 'ls'`, { ruleAction: 'deny' })).toBe('match')
  })

  test('the script reach does not invent matches', () => {
    // An operand that is a FILE is not a command line — its contents are not
    // this command's text, so nothing is read out of the name.
    expect(matchClaudeBashRule('rm:*', 'sh rm', { ruleAction: 'deny' })).toBe('no-match')
    expect(matchClaudeBashRule('rm:*', 'bash -x deploy.sh', { ruleAction: 'deny' })).toBe('no-match')
    // A shell named as an operand rather than run.
    expect(matchClaudeBashRule('rm:*', `echo "sh -c 'rm -rf /tmp/x'"`, { ruleAction: 'deny' })).toBe('no-match')
    expect(matchClaudeBashRule('rm:*', `sh -c 'ls -la'`, { ruleAction: 'deny' })).toBe('no-match')
    // A flag cluster without `c` names no script.
    expect(matchClaudeBashRule('rm:*', 'sh -l rm', { ruleAction: 'deny' })).toBe('no-match')
  })

  test('the splitter yields the wrapper first, then its script', () => {
    expect(splitWithSubstitutions(`/bin/zsh -lc 'rm -rf ~'`))
      .toEqual([`/bin/zsh -lc 'rm -rf ~'`, 'rm -rf ~'])
    expect(splitWithSubstitutions('sh cleanup.sh')).toEqual(['sh cleanup.sh'])
  })

  test('the removal floor reaches the same distance', () => {
    const home = '/Users/testuser'
    expect(findRootOrHomeRemoval(`/bin/zsh -lc 'rm -rf ~'`, { home, platform: 'darwin' })?.target)
      .toBe('home')
    expect(findRootOrHomeRemoval(`bash -lc 'rm -rf ./build'`, { home, platform: 'darwin' }))
      .toBeNull()
  })
})

describe('deny and ask rules see past a compound-command keyword head (P2.142)', () => {
  // Measured on this repo before the fix (2026-08-24, controller-confirmed on
  // HEAD with controls): every row below returned 'no-match' for deny and
  // `findRootOrHomeRemoval` returned NULL for the removal spellings, while
  // `true && rm -rf ~` fired as the positive control and `echo hello` stayed
  // quiet as the negative. The cause is structural, not exotic: the splitter
  // cuts on separators, so `if true; then rm -rf ~; fi` becomes `if true`,
  // `then rm -rf ~`, `fi` — and the middle subcommand's HEAD is the reserved
  // word `then`. A `nonNegotiable` floor and every deny/ask rule were therefore
  // cleared together by ordinary shell control flow, on every runtime. Same
  // function and same class as the `-c` wrapper hole above (P3.12).
  //
  // `bash(1)` § Reserved Words is the enumeration this covers: `! { } case do
  // done elif else esac fi for function if in select then time until while
  // [[ ]] coproc`, plus a `case` label and a function definition's `()`, each
  // proven here with a positive row and a benign twin in the negatives below.
  const hidden: Array<[pattern: string, command: string]> = [
    ['rm:*',   'if true; then rm -rf /tmp/x; fi'],
    ['rm:*',   'if rm -rf /tmp/x; then :; fi'],
    ['rm:*',   'if false; then :; else rm -rf /tmp/x; fi'],
    ['rm:*',   'if false; then :; elif rm -rf /tmp/x; then :; fi'],
    ['rm:*',   'for i in 1 2 3; do rm -rf /tmp/x; done'],
    ['rm:*',   'for ((i=0;i<1;i++)); do rm -rf /tmp/x; done'],
    ['rm:*',   'while true; do rm -rf /tmp/x; done'],
    ['rm:*',   'until false; do rm -rf /tmp/x; done'],
    ['rm:*',   'select x in a b; do rm -rf /tmp/x; done'],
    ['rm:*',   'case $x in (a) rm -rf /tmp/x ;; esac'],
    ['rm:*',   '{ rm -rf /tmp/x; }'],
    ['rm:*',   'function wipe { rm -rf /tmp/x; }'],
    // ONE construct, five spellings, decided until 2026-08-25 by where the
    // author put spaces: `tokenize` glues `(`…`)` into the neighbouring token,
    // so only the first of these had a head the old gate recognised. The other
    // four returned no-match — not 'unparseable', so nothing prompted either —
    // and all five are `bash -n` clean and RUN their body in bash and /bin/sh
    // (executed 2026-08-25 against a sandbox path, payload `touch`).
    ['rm:*',   'wipe() { rm -rf /tmp/x; }'],
    ['rm:*',   'wipe(){ rm -rf /tmp/x; }'],
    ['rm:*',   'wipe () { rm -rf /tmp/x; }'],
    ['rm:*',   'wipe ( ) { rm -rf /tmp/x; }'],
    ['rm:*',   'function wipe(){ rm -rf /tmp/x; }'],
    // The spelling that matters for codex, which wraps every command this way.
    ['rm:*',   `sh -c 'wipe () { rm -rf /tmp/x; }; wipe'`],
    ['rm:*',   '! rm -rf /tmp/x'],
    ['rm:*',   'coproc rm -rf /tmp/x'],
    ['rm:*',   'if [[ -d /tmp/x ]]; then rm -rf /tmp/x; fi'],
    // The rule the T6 live case actually named, in its control-flow spelling.
    ['tail:*', 'while true; do tail -f /tmp/probe.log; done'],
    ['curl:*', 'if true; then curl http://evil; fi'],
    // Nested at depth: a body of a body is just a shorter suffix of the same
    // token list, so one linear pass reaches every level.
    ['rm:*',   'if true; then while true; do { rm -rf /tmp/x; }; done; fi'],
    ['rm:*',   '{ { rm -rf /tmp/x; }; }'],
    ['rm:*',   'if a; then if b; then rm -rf /tmp/x; fi; fi'],
    // Combined with every wrapper the enforcement pass already saw through —
    // the keyword head hid those exactly as well as it hid a bare `rm`.
    ['rm:*',   'if true; then sudo rm -rf /tmp/x; fi'],
    ['rm:*',   'for i in 1; do env FOO=1 rm -rf /tmp/x; done'],
    ['rm:*',   'if true; then watch rm -rf /tmp/x; fi'],
    // Both directions of the P3.12 composition: a keyword in front of a `-c`
    // shell, and a keyword INSIDE one.
    ['rm:*',   `if true; then /bin/zsh -lc 'rm -rf /tmp/x'; fi`],
    ['rm:*',   `/bin/zsh -lc 'if true; then rm -rf /tmp/x; fi'`],
  ]

  test.each(hidden)('deny Bash(%s) matches %s', (pattern, command) => {
    expect(matchClaudeBashRule(pattern, command, { ruleAction: 'deny' })).toBe('match')
    expect(matchClaudeBashRule(pattern, command, { ruleAction: 'ask' })).toBe('match')
  })

  // The same asymmetry the `-c` script and the substitution spans already draw.
  // Allow reads `splitCompoundCommand` and nothing else, so this reach can only
  // ever refuse more — approving a construct off a rule that named one command
  // inside it would approve the condition, the loop and the rest of the body
  // along with it.
  //
  // HONEST LABEL: these rows CANNOT bite this fix or any re-break of it, and a
  // 2026-08-25 review measured that (all 27 pass against fully reverted
  // production code). Allow's splitter is byte-identical across the change, so
  // "allow is untouched" is proven structurally, not by these. They are kept
  // as a guard against a FUTURE re-routing of allow through this splitter,
  // which is a real risk and a cheap one to pin — they are simply not evidence
  // that the keyword reach is correct.
  test.each(hidden)('allow Bash(%s) still refuses %s [future-routing guard, not evidence for this fix]', (pattern, command) => {
    expect(matchClaudeBashRule(pattern, command, { ruleAction: 'allow' })).toBe('no-match')
  })

  // HONEST LABEL: pre-existing guard, passes before and after this change. It
  // pins that the subcommand's own text is still yielded FIRST, which is what
  // keeps a rule naming the construct matching; a change that started yielding
  // only the bodies would break it. Not evidence for the keyword reach.
  test('a rule naming the construct itself still matches the text as written [pre-existing guard]', () => {
    expect(matchClaudeBashRule('if:*', 'if true; then ls; fi', { ruleAction: 'deny' })).toBe('match')
    expect(matchClaudeBashRule('while:*', 'while true; do ls; done', { ruleAction: 'deny' })).toBe('match')
  })

  // The head gate used to ask "does the SUBCOMMAND start with a boundary", and
  // that one question was wrong in both directions at once. Both halves below
  // were measured on 2026-08-25 against the real shell, not reasoned about.
  test('a construct is found by its structure, not by where the author put spaces', () => {
    // TOO NARROW. The old gate short-circuited the whole pass on token 0, so a
    // definition — which starts with its NAME — threw away the genuine `{`
    // boundary two tokens later. Four of these five returned no-match.
    for (const command of [
      'wipe() { rm -rf /tmp/x; }',
      'wipe(){ rm -rf /tmp/x; }',
      'wipe () { rm -rf /tmp/x; }',
      'wipe ( ) { rm -rf /tmp/x; }',
      'function wipe(){ rm -rf /tmp/x; }',
    ]) {
      expect(matchClaudeBashRule('rm:*', command, { ruleAction: 'deny' }), command).toBe('match')
    }
    // All four spellings normalise to the same token list, which is why the
    // spelling stops deciding anything.
    expect(splitWithSubstitutions('wipe(){ rm -rf ~; }'))
      .toEqual(['wipe(){ rm -rf ~', 'rm -rf ~', '}'])
    expect(splitWithSubstitutions('wipe ( ) { rm -rf ~; }'))
      .toEqual(['wipe ( ) { rm -rf ~', 'rm -rf ~', '}'])
  })

  test('a word list is not a command: `in` opens no body', () => {
    // TOO WIDE. `in`'s operand is a WORD LIST (`bash(1)` § Compound Commands),
    // so this loop echoes three words and removes nothing — executed 2026-08-25
    // with a sandbox path: it printed `word=rm`, `word=-rf`, `word=<path>` and
    // created nothing. The floor fired `home` on it, and a `nonNegotiable` floor
    // is one the user cannot switch off, so the false positive had no escape.
    const home = '/Users/testuser'
    for (const command of [
      'for opt in rm -rf ~; do echo $opt; done',
      'for d in rm -rf /; do echo $d; done',
      'select s in rm -rf ~; do echo $s; done',
      'if true; then echo in rm -rf ~; fi',
    ]) {
      expect(findRootOrHomeRemoval(command, { home, platform: 'darwin' }), command).toBeNull()
      expect(matchClaudeBashRule('rm:*', command, { ruleAction: 'deny' }), command).toBe('no-match')
    }
    // …and the loop that really does remove still fires, so this narrowing did
    // not buy quiet with reach.
    expect(findRootOrHomeRemoval('for opt in a b; do rm -rf ~; done', { home, platform: 'darwin' })?.target)
      .toBe('home')
  })

  // THREE consumers read `splitWithSubstitutions`, not two: deny, ask, and every
  // Claude hook `if: Bash(…)` filter (`claude-permission-rules.ts`,
  // `evaluateClaudeHookIfFilter`). That third one changed unreviewed in the
  // first version of this fix while the source comment said it did not exist.
  test('the hook `if` filter is the third reader, and it reaches the same distance', () => {
    for (const [pattern, command] of [
      ['rm:*', 'if true; then rm -rf /tmp/x; fi'],
      ['git:*', 'for i in 1; do git push; done'],
      ['npm:*', '{ npm install; }'],
      ['rm:*', 'wipe () { rm -rf /tmp/x; }'],
    ] as const) {
      expect(matchClaudeBashIfRule(pattern, command), command).toBe('match')
    }
    // It inherits the head gate too — the filter is best-effort and its caller
    // fails OPEN, but "best-effort" is not a licence to fire on an argument.
    expect(matchClaudeBashIfRule('rm:*', 'echo then rm -rf /tmp/x')).toBe('no-match')
    expect(matchClaudeBashIfRule('rm:*', 'for opt in rm -rf /tmp/x; do echo $opt; done')).toBe('no-match')
    expect(matchClaudeBashIfRule('ls:*', 'ls -la')).toBe('match')
  })

  test('the keyword reach does not invent matches', () => {
    const quiet: Array<[pattern: string, command: string]> = [
      // A benign body stays benign — the body is offered to the SAME scan.
      ['rm:*', 'if true; then echo hi; fi'],
      ['rm:*', 'for i in 1 2 3; do echo hi; done'],
      ['rm:*', 'while true; do echo hi; done'],
      ['rm:*', 'until false; do echo hi; done'],
      ['rm:*', 'select x in a b; do echo hi; done'],
      ['rm:*', 'case $x in (a) echo hi ;; esac'],
      ['rm:*', '{ echo hi; }'],
      ['rm:*', 'function greet { echo hi; }'],
      ['rm:*', 'greet() { echo hi; }'],
      ['rm:*', '! echo hi'],
      ['rm:*', 'coproc echo hi'],
      // A reserved word spelled as an ARGUMENT of an ordinary command opens no
      // body, and the shell agrees: `echo then rm -rf ~` prints three words.
      // An earlier draft treated a reserved word at ANY position as a boundary
      // and matched all three of these.
      ['rm:*', 'echo then rm -rf /tmp/x'],
      ['rm:*', 'echo do rm -rf /tmp/x'],
      ['rm:*', 'git commit -m in -- rm'],
      // Quoted, a keyword is not a keyword — which is why the boundary test
      // reads the VERBATIM token and never its unquoted literal text. The first
      // two rows are covered by the head gate alone; the last two are the ones
      // that actually bite that choice, because THEIR head is the quoted
      // keyword. (Recorded because the first two passed a `literalText` re-break
      // unchanged — a negative that cannot fail proves nothing.)
      ['rm:*', `echo "if true; then rm -rf /tmp/x; fi"`],
      ['rm:*', `grep -n 'do rm -rf /tmp/x' notes.txt`],
      ['rm:*', `'then' rm -rf /tmp/x`],
      ['rm:*', `"do" rm -rf /tmp/x`],
      // A construct whose body names a different command.
      ['rm:*', 'if true; then git status; fi'],
    ]
    for (const [pattern, command] of quiet) {
      expect(matchClaudeBashRule(pattern, command, { ruleAction: 'deny' }), command).toBe('no-match')
      expect(matchClaudeBashRule(pattern, command, { ruleAction: 'ask' }), command).toBe('no-match')
    }
  })

  test('the splitter yields the subcommand first, then the body behind each keyword', () => {
    expect(splitWithSubstitutions('if true; then rm -rf ~; fi'))
      .toEqual(['if true', 'true', 'then rm -rf ~', 'rm -rf ~', 'fi'])
    expect(splitWithSubstitutions('{ rm -rf ~; }')).toEqual(['{ rm -rf ~', 'rm -rf ~', '}'])
    // A RUN of keywords emits once, at its end — the dropped `{ rm -rf ~` was
    // headed by a reserved word and named no command.
    expect(splitWithSubstitutions('do { rm -rf ~')).toEqual(['do { rm -rf ~', 'rm -rf ~'])
    // A construct HEADER word ends the run for the same reason: there is one
    // command in `do for ((…)) do rm -rf ~`, not two, so the intermediate
    // `((…)) do rm -rf ~` — which names no command — is not offered.
    expect(splitWithSubstitutions('do for ((i=0;i<1;i++)) do rm -rf ~'))
      .toEqual(['do for ((i=0;i<1;i++)) do rm -rf ~', 'rm -rf ~', '(i=0;i<1;i++)', 'i=0', 'i<1', 'i++'])
    // `coproc NAME compound-command` and `name () compound-command` are the two
    // places `bash(1)` puts a LABEL between the construct and its body. The
    // label is not a command head, so it does not end the walk — but only in
    // those two shapes, or `echo { rm -rf ~ }` would start firing.
    expect(splitWithSubstitutions('coproc NAME { rm -rf ~; }'))
      .toEqual(['coproc NAME { rm -rf ~', 'NAME { rm -rf ~', 'rm -rf ~', '}'])
    expect(splitWithSubstitutions('echo { rm -rf ~ }')).toEqual(['echo { rm -rf ~ }'])
    // No keyword head, no extra entry — an ordinary command is untouched.
    expect(splitWithSubstitutions('echo then rm -rf ~')).toEqual(['echo then rm -rf ~'])
    expect(splitWithSubstitutions('rm -rf ~')).toEqual(['rm -rf ~'])
    // A word list is offered no longer: `for i in 1 2 3` names no command.
    expect(splitWithSubstitutions('for i in 1 2 3; do rm -rf ~; done'))
      .toEqual(['for i in 1 2 3', 'do rm -rf ~', 'rm -rf ~', 'done'])
  })

  test('the removal floor reaches the same distance', () => {
    const home = '/Users/testuser'
    for (const command of [
      'if true; then rm -rf ~; fi',
      'for i in 1; do rm -rf ~; done',
      'case $x in (a) rm -rf ~ ;; esac',
      'wipe() { rm -rf ~; }',
    ]) {
      expect(findRootOrHomeRemoval(command, { home, platform: 'darwin' })?.target, command).toBe('home')
    }
    expect(findRootOrHomeRemoval('if true; then rm -rf ./build; fi', { home, platform: 'darwin' }))
      .toBeNull()
    expect(findRootOrHomeRemoval('echo then rm -rf ~', { home, platform: 'darwin' })).toBeNull()
  })

  // WHAT THIS TEST USED TO ASSERT, AND WHY IT WAS DELETED RATHER THAN RETUNED.
  // Until 2026-08-25 it read `expect(…alternating(32)…).toBeNull()`, where
  // `alternating(n) = 'if a '.repeat(n) + 'if rm -rf ~'` — i.e. it pinned the
  // cap's silence AS AN INVARIANT, so any correct fix had to fail a test. Two
  // measurements retired it rather than moving the number:
  //   1. That fixture is not valid shell at ANY n. `bash -n` rejects it
  //      ("syntax error: unexpected end of file") because after the command word
  //      `a` every later `if` is an ARGUMENT, so there is no `then` and nothing
  //      runs. The 31 side was pinning a FALSE POSITIVE and the 32 side a
  //      bypass shape no attacker could use. It was true in neither direction.
  //   2. The shape that IS runnable reached the cap easily: 32 nestings of
  //      `for ((i=0;i<1;i++)) do` (906 chars, well inside the 10 000 accepted)
  //      is `bash -n` clean, EXECUTES its body (verified against a sandbox path
  //      with a `touch` payload), and returned null at 32 while firing at 31.
  // So the cap is still here — an unbounded suffix-per-boundary walk is
  // quadratic — but it now bounds WORK and cannot bound REACH, and that is what
  // this test pins instead.
  test('the bound limits the work done, and cannot limit how deep the walk sees', () => {
    const home = '/Users/testuser'
    // A RUN of keywords is ONE body however long, which is what keeps the walk
    // linear on the shape the previous version benchmarked.
    expect(findRootOrHomeRemoval(`${'{ '.repeat(2500)}rm -rf ~`, { home, platform: 'darwin' })?.target)
      .toBe('home')
    expect(findRootOrHomeRemoval(`${'then '.repeat(1600)}rm -rf ~`, { home, platform: 'darwin' })?.target)
      .toBe('home')

    // REACH IS NOT CAPPED. The executable nesting, at and far past the old
    // cliff of 32 — every depth that fits inside MAX_COMMAND_LENGTH fires.
    const forNest = (n: number) => `${'for ((i=0;i<1;i++)) do '.repeat(n)}rm -rf ~; ${'done '.repeat(n)}`
    for (const depth of [1, 31, 32, 33, 100, 300]) {
      expect(findRootOrHomeRemoval(forNest(depth), { home, platform: 'darwin' })?.target, `depth ${depth}`)
        .toBe('home')
    }
    // The other unbounded nest, 1 000 deep — 31× the cap.
    expect(findRootOrHomeRemoval(`${'a () { '.repeat(1000)}rm -rf ~`, { home, platform: 'darwin' })?.target)
      .toBe('home')

    // WORK IS CAPPED, and in the direction that keeps the innermost body: the
    // bodies of one subcommand are nested suffixes, the walk ends at the first
    // body headed by a real command, so the LAST body is the only one that can
    // ever be a removal. Truncating the head of that list is free; truncating
    // its tail is the bypass above.
    const forms = splitWithSubstitutions(`${'a () { '.repeat(1000)}rm -rf ~`)
    expect(forms).not.toBeNull()
    expect(forms!.length).toBeLessThanOrEqual(33)  // 1 subcommand + at most 32 bodies
    expect(forms!.at(-1)).toBe('rm -rf ~')
  })

  // Regression controls for spellings that were NEVER broken, so a future
  // narrowing of the keyword rule cannot quietly take them with it. Every row
  // here passes before and after this change BY DESIGN — that is what a control
  // is — and none of them is offered as evidence that the reach is correct.
  // (The three named in the first version's commit message as "now pinned as
  // regression controls" were not in fact added; a 2026-08-25 review measured
  // zero added lines covering any of them. They are here now.)
  test('the spellings that already worked still work [regression controls]', () => {
    const home = '/Users/testuser'
    expect(matchClaudeBashRule('rm:*', 'true && rm -rf /tmp/x', { ruleAction: 'deny' })).toBe('match')
    expect(matchClaudeBashRule('rm:*', 'rm -rf /tmp/x', { ruleAction: 'deny' })).toBe('match')
    expect(matchClaudeBashRule('rm:*', 'echo hello', { ruleAction: 'deny' })).toBe('no-match')
    expect(findRootOrHomeRemoval('true && rm -rf ~', { home, platform: 'darwin' })?.target).toBe('home')
    expect(findRootOrHomeRemoval('echo hello', { home, platform: 'darwin' })).toBeNull()
    // A NEWLINE before the body: a separator, so the body was always its own
    // subcommand and no keyword reach was ever needed.
    expect(findRootOrHomeRemoval('if true\nthen\n  rm -rf ~\nfi', { home, platform: 'darwin' })?.target)
      .toBe('home')
    expect(findRootOrHomeRemoval('for i in 1; do\n  rm -rf ~\ndone', { home, platform: 'darwin' })?.target)
      .toBe('home')
    // A bare SUBSHELL: `scanCommand` opens a span for a top-level `(`, so this
    // was never a blind spot. It was named as one in the first version's brief.
    expect(findRootOrHomeRemoval('( rm -rf ~ )', { home, platform: 'darwin' })?.target).toBe('home')
    expect(findRootOrHomeRemoval('(rm -rf ~)', { home, platform: 'darwin' })?.target).toBe('home')
    // `time` STANDALONE: a documented `stripSubcommand` wrapper, not a keyword
    // body. The only row the first version added was `if true; then time …`,
    // which is a keyword-head composition and controls nothing here.
    expect(findRootOrHomeRemoval('time rm -rf ~', { home, platform: 'darwin' })?.target).toBe('home')
    expect(matchClaudeBashRule('rm:*', 'time rm -rf /tmp/x', { ruleAction: 'deny' })).toBe('match')
    // A substitution behind a keyword head: reached by the SPAN walk, which
    // runs per subcommand and owes nothing to the keyword reach. It was in the
    // positive list as evidence for the keyword fix; it is a control.
    expect(findRootOrHomeRemoval('if true; then echo $(rm -rf ~); fi', { home, platform: 'darwin' })?.target)
      .toBe('home')
    expect(matchClaudeBashRule('rm:*', 'if true; then echo $(rm -rf /tmp/x); fi', { ruleAction: 'deny' }))
      .toBe('match')
  })
})

describe('deny and ask rules see into substitution spans (T11)', () => {
  // Measured on this repo before the fix (2026-08-20, U1 CLI-fix audit): EVERY
  // `deny Bash(rm:*)` row below returned 'no-match', so wrapping a denied
  // command in `$(…)` walked straight through the deny floor.
  //
  // permissions.md's § Compound commands names separators only and never says
  // what a rule sees inside `$(…)`, so the reach is our choice — taken in the
  // direction the page's own deny/allow asymmetry points: "A deny or ask rule
  // matches past any leading assignment, so `Bash(rm *)` in deny still matches
  // `FOO=bar rm -rf tmp/`" (§ Wrappers), and, for paths, "**Deny and ask
  // rules**: `Read(secrets/**)` matches a directory named `secrets` at any
  // depth under the current directory".
  const reach: Array<[label: string, pattern: string, command: string, want: Want]> = [
    ['$() span',              'rm:*', 'echo $(rm -rf ./x)',            'match'],
    ['backtick span',         'rm:*', 'echo `rm -rf ./x`',             'match'],
    ['nested one level',      'rm:*', 'echo $(echo $(rm -rf ./x))',    'match'],
    // scanCommand opens a span for a top-level `(` too, so a subshell and a
    // PROCESS substitution are walked by the same pass.
    ['subshell',              'rm:*', '(rm -rf ./x)',                  'match'],
    ['process substitution',  'rm:*', 'diff <(rm -rf ./x) b',          'match'],
    // A double quote does not stop expansion, so it must not stop the deny.
    ['inside double quotes',  'rm:*', 'echo "$(rm -rf ./x)"',          'match'],
    // Arithmetic runs nothing, but a substitution nested in it does.
    ['nested in arithmetic',  'rm:*', 'echo $(( $(rm -rf ./x) ))',     'match'],
    // The span's own contents are split and wrapper-stripped like any other
    // subcommand, so a compound or a privilege wrapper inside one is reached.
    ['compound in a span',    'rm:*', 'echo $(id -u && rm -rf ./x)',   'match'],
    ['sudo in a span',        'rm:*', 'echo $(sudo rm -rf ./x)',       'match'],
    // Single quotes suppress expansion, so this text is an argument, not a
    // command. Reaching into it would be a false positive, not extra safety.
    ['single-quoted is inert', 'rm:*', "echo '$(rm -rf ./x)'",         'no-match'],
    // The extra reach must not manufacture matches out of unrelated spans.
    ['unrelated span',        'rm:*', 'echo $(date)',                  'no-match'],
  ]

  test.each(reach)('deny/ask reach: %s', (_label, pattern, command, want) => {
    expect(matchClaudeBashRule(pattern, command, { ruleAction: 'deny' })).toBe(want)
    expect(matchClaudeBashRule(pattern, command, { ruleAction: 'ask' })).toBe(want)
  })

  // The positive control: allow keeps the TOP-LEVEL view and gains nothing.
  // Each want below was measured against the pre-change function and is
  // byte-identical after it — a glob allow still refuses substitution outright,
  // and a glob-free exact rule still matches only its literal string.
  const allowUnchanged: Array<[label: string, pattern: string, command: string, want: Want]> = [
    ['a glob allow gains no reach',    'rm:*',   'echo $(rm -rf ./x)',    'no-match'],
    ['...not through backticks',       'rm:*',   'echo `rm -rf ./x`',     'no-match'],
    ['...not through a subshell',      'rm:*',   '(rm -rf ./x)',          'no-match'],
    ['...not through a nested span',   'rm:*',   'echo $(echo $(rm -rf ./x))', 'no-match'],
    // The substitution veto: the OUTER command matches `echo *` on its face and
    // is refused anyway, because a prefix rule must not auto-approve embedded
    // command execution.
    ['the glob veto still fires',      'echo:*', 'echo $(rm -rf ./x)',    'no-match'],
    ['...but inert text is allowed',   'echo:*', "echo '$(rm -rf ./x)'",  'match'],
    ['an exact rule still matches',    'echo $(rm -rf ./x)', 'echo $(rm -rf ./x)', 'match'],
  ]

  test.each(allowUnchanged)('allow unchanged: %s', (_label, pattern, command, want) => {
    expect(matchClaudeBashRule(pattern, command, { ruleAction: 'allow' })).toBe(want)
  })

  test('the descent is budgeted: deep nesting degrades to the top-level reach, never hangs', () => {
    const nest = (depth: number) => {
      let command = 'rm -rf ./x'
      for (let level = 0; level < depth; level++) command = `echo $(${command})`
      return command
    }
    const deny = (command: string) => matchClaudeBashRule('rm:*', command, { ruleAction: 'deny' })
    // `splitWithSubstitutions` spends one unit of its budget (32) per nesting
    // level, so the boundary is exact and the degradation is a 'no-match' —
    // i.e. the pre-fix top-level reach — rather than a stack overflow or a
    // hang. This test completing at all is the no-hang assertion.
    expect(deny(nest(32))).toBe('match')
    expect(deny(nest(33))).toBe('no-match')
    expect(deny(nest(500))).toBe('no-match')
  })

  test("'unparseable' is action-independent: both splitters return null together", () => {
    // The splitter now varies by action, so the two must agree on null or a
    // deny rule could turn an unparseable command into a verdict an allow rule
    // would have prompted on.
    const inputs = [
      'git "status', "git 'status", 'git log $(date', 'echo `date',
      'x'.repeat(10_001), '   ', 'echo $(echo "unbalanced)',
      'echo $(rm -rf ./x)', 'git status && rm -rf /', 'ls',
    ]
    for (const command of inputs) {
      expect(splitWithSubstitutions(command) === null, command)
        .toBe(splitCompoundCommand(command) === null)
      const unparseable = splitCompoundCommand(command) === null
      for (const action of ['allow', 'deny', 'ask'] as const) {
        expect(matchClaudeBashRule('rm:*', command, { ruleAction: action }) === 'unparseable', `${action} ${command}`)
          .toBe(unparseable)
      }
    }
  })

  test('a span that cannot be parsed on its own is dropped, not propagated', () => {
    // `$( )` holds no subcommand, so the recursive call returns null. That null
    // is skipped — the enclosing command is still perfectly parseable, and a
    // deny rule elsewhere in it must still fire.
    expect(splitWithSubstitutions('echo $( )')).toEqual(['echo $( )'])
    expect(matchClaudeBashRule('rm:*', 'ls $( ) && rm -rf ./x', { ruleAction: 'deny' })).toBe('match')
    expect(matchClaudeBashRule('rm:*', 'echo $( )', { ruleAction: 'deny' })).toBe('no-match')
  })
})

describe('three more shell forms fail closed (w30.md:85)', () => {
  // `whats-new/2026-w30.md:85`, the whole line, fetched 2026-08-23:
  // "Bash permission checks fail closed on more shell forms, including
  // file-descriptor redirects, Zsh variable subscripts in `[[ ]]` comparisons,
  // `help` and `man` invocations that could run unsafe options, and commands
  // over 10,000 characters". The fourth form we already had
  // (`MAX_COMMAND_LENGTH`); these are the other three.
  //
  // Every 'no-match' row below was measured as 'match' against the pre-change
  // function — i.e. a glob allow rule auto-approved it.
  const failClosed: Array<[label: string, pattern: string, command: string, want: Want]> = [
    // ---- Form 1: file-descriptor redirects ------------------------------
    ['fd 3 duplicated onto stdout', 'git *', 'git status 3>&1 1>/dev/null', 'no-match'],
    ['exec opens a descriptor',     'exec *', 'exec 3<>/tmp/payload',       'no-match'],
    ['varname descriptor',          'cat *',  'cat notes.txt {fd}>/tmp/out', 'no-match'],
    ['duplicated ONTO fd 3',        'ls *',   'ls -la 1>&3',                'no-match'],
    // The SPACED spelling of the same duplication. `tokenize` splits on
    // whitespace, so a within-token regex never sees `1>& 3` — yet bash reads
    // the two spellings identically (measured 2026-08-23, bash 3.2.57:
    // `bash -c 'exec 3>/tmp/f; echo hello 1>& 3'` wrote through fd 3's target
    // and created no file named `3`; a bare `>& 3` behaved the same). Same
    // boundary as the within-token form: veto iff a descriptor is 3 or higher.
    ['spaced duplication onto fd 3', 'git *', 'git status 1>& 3',           'no-match'],
    ['spaced bare duplication',      'git *', 'git status >& 3',            'no-match'],
    ['spaced source descriptor 3',   'git *', 'git status 3>& 1',           'no-match'],
    // Quotes around the OPERAND are the shell's, not the descriptor's: every
    // spelling below duplicates onto fd 3 exactly as a bare `1>& 3` does
    // (measured 2026-08-23, bash 3.2.57 and zsh 5.9 — each wrote through fd 3's
    // target after `exec 3>/tmp/f`, and none created a file named `3`). The
    // first and fourth were auto-approved before `literalText` existed, and the
    // third is the one a bare `unquote` read would have re-opened — single
    // quotes are the blind spot every narrower reader shares.
    ['single-quoted fd operand',     'git *', "git status 1>& '3'",         'no-match'],
    ['double-quoted fd operand',     'git *', 'git status 1>& "3"',         'no-match'],
    ['doubled-quote fd operand',     'git *', "git status 1>& ''3''",       'no-match'],
    ['mixed-quote fd operand',       'git *', "git status 1>& '3'\"\"",     'no-match'],
    // ...and the benign neighbours keep their classification (see the
    // dedicated `2>&1` pin below for the full standard-stream set).
    ['plain stderr duplication',    'git *',  'git status 2>&1',            'match'],
    ['plain truncating redirect',   'git *',  'git status > out.log',       'match'],
    // `>& word` where the word is NOT a pure number is a file redirect, which
    // is a deliberately classified form — the spacing must not change that.
    ['spaced file redirect',        'git *',  'git status >& out.log',      'match'],
    ['spaced 1>& 2',                'git *',  'git status 1>& 2',           'match'],
    // The quote-stripping is the operand's only change: a standard stream
    // stays classified whichever way it is spelled.
    ['single-quoted 1>& 2',         'git *',  "git status 1>& '2'",         'match'],

    // ---- Form 2: Zsh variable subscripts inside `[[ ]]` ------------------
    // A subscript is evaluated by zsh, so the text between the brackets is
    // code. No `$(` is needed, which is why the substitution veto never saw
    // these: `${arr[idx]}` carries neither `$(` nor a backtick.
    ['subscript in a condition',     '[[ *',  '[[ ${arr[idx]} == x ]]',     'no-match'],
    ['brace-less subscript',         '[[ *',  '[[ $arr[idx] == x ]]',       'no-match'],
    ['subscript on the right side',  '[[ *',  '[[ x == ${map[key]} ]]',     'no-match'],
    // ...and a `[[ ]]` comparison without a subscript is untouched, as is a
    // subscript OUTSIDE a condition (upstream scopes the form to `[[ ]]`).
    ['plain condition',              '[[ *',  '[[ -f config.json ]]',       'match'],
    ['glob in a condition',          '[[ *',  '[[ $name == [ab]* ]]',       'match'],
    ['subscript outside a condition','echo *', 'echo ${arr[0]}',            'match'],
    ['single-quoted text is inert',  '[[ *',  "[[ x == '${arr[idx]}' ]]",   'match'],
    // The two prefixed spellings zsh puts between `${` and the identifier —
    // `#` (length) and `(flags)` — carry a subscript that is evaluated exactly
    // like the bare one, so requiring an identifier immediately after `${` let
    // the length form through. The flag form was already 'no-match' before this
    // row existed, but INCIDENTALLY: its bare `(` trips the substitution veto
    // (`[[ (a) == x ]]` is 'no-match' too). It is pinned here so the subscript
    // reason is asserted on its own footing rather than borrowed.
    ['length-prefixed subscript',    '[[ *',  '[[ ${#arr[idx]} -gt 0 ]]',   'no-match'],
    ['flag-prefixed subscript',      '[[ *',  '[[ ${(f)arr[idx]} == x ]]',  'no-match'],
    // ...and a length with no subscript is an ordinary expansion.
    ['length without a subscript',   '[[ *',  '[[ ${#arr} -gt 0 ]]',        'match'],
    ['length subscript outside one', 'echo *', 'echo ${#arr[0]}',           'match'],

    // ---- Form 3: `help`/`man` carrying unsafe options --------------------
    // `man -P cmd` runs `cmd` as the pager; `--html=browser` runs a browser.
    // Unknown options fail closed rather than being read as inert.
    ['man runs a pager',            'man *',  "man -P 'sh -c whoami' ls",   'no-match'],
    ['man runs a browser',          'man *',  'man --html=xterm ls',        'no-match'],
    ['help writes to a file',       'help *', 'help -o /tmp/out cd',        'no-match'],
    ['man through a wrapper',       'man *',  "timeout 5 man -P 'id' ls",   'no-match'],
    // ...and a plain lookup stays classified exactly as before.
    ['plain man',                   'man *',  'man ls',                     'match'],
    ['plain help',                  'help *', 'help cd',                    'match'],
    ['man with a section number',   'man *',  'man 3 printf',               'match'],
    ['man -k is inert',             'man *',  'man -k rm',                  'match'],
    ['help -s is inert',            'help *', 'help -s cd',                 'match'],
  ]

  test.each(failClosed)('allow: %s', (_label, pattern, command, want) => {
    expect(matchClaudeBashRule(pattern, command, { ruleAction: 'allow' })).toBe(want)
  })

  // The veto is ALLOW-side only, exactly like the exec-wrapper and
  // substitution vetoes above it. Turning these into `'unparseable'` would have
  // pulled the deny floor out from under them — `PROMPT_ANYWAY`
  // (`permission-dsl.ts:669`) prompts instead of denying — so a deny rule must
  // still reach every form.
  const denyStillReaches: Array<[label: string, pattern: string, command: string]> = [
    ['fd redirect',        'rm:*',  'rm -rf ./x 3>&1'],
    ['spaced fd redirect', 'rm:*',  'rm -rf ./x 1>& 3'],
    ['varname descriptor', 'rm:*',  'rm -rf ./x {fd}>/tmp/out'],
    ['zsh subscript',      'rm:*',  '[[ -n ${arr[idx]} ]] && rm -rf ./x'],
    ['man pager',          'man:*', "man -P 'sh -c whoami' ls"],
  ]

  test.each(denyStillReaches)('deny/ask still reach: %s', (_label, pattern, command) => {
    expect(matchClaudeBashRule(pattern, command, { ruleAction: 'deny' })).toBe('match')
    expect(matchClaudeBashRule(pattern, command, { ruleAction: 'ask' })).toBe('match')
  })

  // A glob-free EXACT rule still approves its literal string — the same escape
  // hatch `watch git status` and `echo $(rm -rf ./x)` already have.
  test('an exact rule still approves the literal command', () => {
    const exact = (command: string) =>
      matchClaudeBashRule(command, command, { ruleAction: 'allow' })
    expect(exact('git status 3>&1 1>/dev/null')).toBe('match')
    expect(exact('[[ ${arr[idx]} == x ]]')).toBe('match')
    expect(exact("man -P 'sh -c whoami' ls")).toBe('match')
  })

  // THE `2>&1` PIN. Upstream's line names "file-descriptor redirects" without
  // carving anything out, but the fail-closed set here stops at descriptors the
  // command does not already name: `0`/`1`/`2` are the three streams every
  // subcommand has open, and `2>&1` is in a large share of allow-listed
  // commands — vetoing it would prompt on nearly every rule that exists. The
  // boundary is therefore "a descriptor numbered 3 or higher, or bound to a
  // variable"; the standard-stream spellings below are all classified as before
  // and are byte-identical to the pre-change results.
  const standardStreamRedirects = [
    'git status 2>&1',
    'git status 1>&2',
    'git status 2>&-',
    'git status > out.log',
    'git status >> out.log',
    'git status 2> err.log',
    'git status 1> out.log',
    'git status 2>> err.log',
    'git status < in.txt',
    'git status 0< in.txt',
    'git status &> all.log',
    'git status &>> all.log',
    'git status <<< hello',
    'git status > out.log 2>&1',
    'git status 2>/dev/null | git status',
    // The spaced spellings of the same standard-stream duplication. Bash
    // treats `2>& 1` as `2>&1`, so the ubiquity argument applies to it
    // identically — vetoing it would prompt-storm the same rules.
    'git status 2>& 1',
    'git status 1>& 2',
  ]

  test.each(standardStreamRedirects)('2>&1 pin: allow Bash(git *) still matches %s', command => {
    expect(matchClaudeBashRule('git *', command, { ruleAction: 'allow' })).toBe('match')
  })

  test('the splitter is untouched: redirects still never separate segments', () => {
    expect(splitCompoundCommand('git status 2>&1')).toEqual(['git status 2>&1'])
    expect(splitCompoundCommand('cmd &> log')).toEqual(['cmd &> log'])
    expect(splitCompoundCommand('cmd 3>&1 1>/dev/null')).toEqual(['cmd 3>&1 1>/dev/null'])
    expect(splitCompoundCommand('exec 3<>/tmp/f')).toEqual(['exec 3<>/tmp/f'])
  })
})

/**
 * The shell head gate and its option grammar (P2.151, P2.152).
 *
 * P2.151 measured ELEVEN spellings that walked through the `-c` reach the block
 * above installed, each confirmed to RUN its operand — executed against a
 * sandbox path with a `touch` payload on 2026-08-25, with `sh -c 'true'`
 * leaving no marker as the detector's own negative control. The cause was one
 * question asked wrongly: the scan tested whether a token was a SHORT OPTION
 * CLUSTER and gave up otherwise, so every long-form flag hid the script behind
 * it, while a second half of the same floor compared the RAW head where every
 * other head test in this subsystem resolves a basename.
 *
 * P2.152 is why that kept reopening: a substring-match mutant of the head gate
 * — one that makes `zshfoo -c 'rm -rf ~'` fire a `nonNegotiable` floor — passed
 * all 646 tests. The gate deciding whether a token IS a shell had no test that
 * failed when it was wrong in EITHER direction. Every row below therefore names
 * the mutation it kills, because test count was never the thing that was short.
 */
describe('the shell head gate and its option grammar (P2.151, P2.152)', () => {
  // Kills: reverting the option scan to `^-[A-Za-z]+$` + `return null`, which
  // is what hid all eight of these.
  const longFormFlags: string[] = [
    `bash --login -c 'rm -rf /tmp/x'`,
    `bash --norc -c 'rm -rf /tmp/x'`,
    `bash --noprofile -c 'rm -rf /tmp/x'`,
    `bash --posix -c 'rm -rf /tmp/x'`,
    `bash --verbose -c 'rm -rf /tmp/x'`,
    `bash --noediting -c 'rm -rf /tmp/x'`,
    `zsh --no-rcs -c 'rm -rf /tmp/x'`,
    `zsh --noglob -c 'rm -rf /tmp/x'`,
    // Two flags before the script, and a long flag after a short cluster.
    `bash --noprofile --norc -c 'rm -rf /tmp/x'`,
    `bash -l --posix -c 'rm -rf /tmp/x'`,
  ]

  // Kills: emptying SHELL_VALUE_SHORT_OPTIONS or SHELL_VALUE_LONG_OPTIONS. With
  // either set empty the option's VALUE ends the scan before `-c` is reached
  // and the answer goes back to null.
  const valueTakingOptions: string[] = [
    `bash -o pipefail -c 'rm -rf /tmp/x'`,
    `bash -O extglob -c 'rm -rf /tmp/x'`,
    `bash +o pipefail -c 'rm -rf /tmp/x'`,
    `bash +O extglob -c 'rm -rf /tmp/x'`,
    `bash --rcfile /dev/null -c 'rm -rf /tmp/x'`,
    `bash --init-file /dev/null -c 'rm -rf /tmp/x'`,
    `zsh --emulate sh -c 'rm -rf /tmp/x'`,
    `zsh -o noglob -c 'rm -rf /tmp/x'`,
  ]

  // Kills: reading the script as "the word after the cluster containing `c`".
  // Both of these RUN, and that rule reads `--` and `pipefail` instead. `c`
  // sets a flag; the script is the FIRST OPERAND after option parsing ends.
  const firstOperandRule: string[] = [
    `sh -c -- 'rm -rf /tmp/x'`,
    `bash -oc pipefail 'rm -rf /tmp/x'`,
  ]

  // Kills: dropping the basename/case/`.exe` resolution from the head gate, or
  // dropping csh/tcsh from SHELL_INTERPRETERS. Each row is a spelling the OS
  // resolves to a shell that this gate did not.
  const headSpellings: string[] = [
    // THE POSITIVE CONTROL, and the ONE row in this whole block that passes
    // against the reverted production hunk — an absolute path with forward
    // slashes was the one spelling the old gate already resolved. It stays
    // because it is what proves the other seven are testing the spelling and
    // not the harness, and it is load-bearing against a mutant that drops the
    // separator split. It is NOT evidence for the new reach; the other 40 rows
    // in this describe are (measured: 40 of 41 fail on revert, this one does
    // not).
    `/bin/sh -c 'rm -rf /tmp/x'`,
    `SH -c 'rm -rf /tmp/x'`,
    `Bash -c 'rm -rf /tmp/x'`,
    `ZSH -lc 'rm -rf /tmp/x'`,
    `bash.exe -c 'rm -rf /tmp/x'`,
    `C:\\Windows\\System32\\bash.exe -c 'rm -rf /tmp/x'`,
    `csh -c 'rm -rf /tmp/x'`,
    `tcsh -c 'rm -rf /tmp/x'`,
  ]

  // Kills: making an UNRESOLVABLE head answer "not a shell". `$SHELL -c` is the
  // phrasing in codex's own `shell_command` tool description.
  const unresolvableHeads: string[] = [
    `$SHELL -c 'rm -rf /tmp/x'`,
    '${SHELL} -c \'rm -rf /tmp/x\'',
    `"$SHELL" -c 'rm -rf /tmp/x'`,
    `$MY_LOGIN_SHELL -c 'rm -rf /tmp/x'`,
  ]

  // Kills: leaving the ENFORCEMENT pass comparing the raw head. These are the
  // absolute-path spellings of the two wrappers the `-c` commit's own comment
  // claimed to see through — `stripSubcommand` compared `/usr/bin/sudo` against
  // a set holding `sudo`, so the two halves of one floor disagreed.
  const absoluteWrappers: string[] = [
    `/usr/bin/env sh -c 'rm -rf /tmp/x'`,
    `/usr/bin/sudo sh -c 'rm -rf /tmp/x'`,
    `/usr/bin/env -i sh -c 'rm -rf /tmp/x'`,
    // No `-c` shell involved at all — the same raw-head comparison hid these.
    '/usr/bin/sudo rm -rf /tmp/x',
    '/usr/bin/nohup rm -rf /tmp/x',
    '/usr/bin/doas rm -rf /tmp/x',
    '/bin/nice -n 3 rm -rf /tmp/x',
  ]

  // Kills: not stripping the ANSI-C quote introducer. `literalText` reads the
  // `$` as an ordinary character, so the script came back as `$rm -rf …`.
  const quoteIntroducers: string[] = [
    `sh -c $'rm -rf /tmp/x'`,
    `bash --login -c $'rm -rf /tmp/x'`,
  ]

  const reaches = [
    ...longFormFlags, ...valueTakingOptions, ...firstOperandRule, ...headSpellings,
    ...unresolvableHeads, ...absoluteWrappers, ...quoteIntroducers,
  ]

  test.each(reaches)('deny Bash(rm:*) matches %s', command => {
    expect(matchClaudeBashRule('rm:*', command, { ruleAction: 'deny' })).toBe('match')
    expect(matchClaudeBashRule('rm:*', command, { ruleAction: 'ask' })).toBe('match')
  })

  /**
   * THE ASYMMETRY, and it is the row that has to bite hardest.
   *
   * The head resolution is gated to the enforcement pass precisely so allow
   * cannot inherit it: an allow rule that resolved the head would let
   * `Bash(rm:*)` approve `/usr/bin/nohup rm -rf …` off a rule that only ever
   * named `rm`. This row FAILS against a mutant that moves the resolution into
   * `stripSubcommand`'s default pass, and against one that hands allow the
   * enforcement view — checked, not assumed, because 11 rows of exactly this
   * shape one block above were measured VACUOUS on 2026-08-25.
   */
  test.each(reaches)('allow Bash(rm:*) still refuses %s', command => {
    expect(matchClaudeBashRule('rm:*', command, { ruleAction: 'allow' })).toBe('no-match')
  })

  /**
   * The gate's OTHER direction — the half P2.152 found uncovered. A name that
   * merely CONTAINS a shell name is not a shell, so its `-c` is an ordinary
   * argument. Kills the substring-match mutant that passed all 646 tests.
   */
  const notShells: string[] = [
    `zshfoo -c 'rm -rf /tmp/x'`,
    `mybash -c 'rm -rf /tmp/x'`,
    `shell -c 'rm -rf /tmp/x'`,
    `bashful -c 'rm -rf /tmp/x'`,
    `dashboard -c 'rm -rf /tmp/x'`,
    `kshrc -c 'rm -rf /tmp/x'`,
    `/opt/zshfoo -c 'rm -rf /tmp/x'`,
    // Resolvable and simply not a shell. Kills a `namesAShell` that answers
    // true for every head rather than only for an unresolvable one.
    `python3 -c 'rm -rf /tmp/x'`,
    `perl -c 'rm -rf /tmp/x'`,
    `ruby -c 'rm -rf /tmp/x'`,
  ]

  test.each(notShells)('deny Bash(rm:*) does not reach into %s', command => {
    expect(matchClaudeBashRule('rm:*', command, { ruleAction: 'deny' })).toBe('no-match')
  })

  /**
   * Two forms that do NOT run their argument, both measured: `sh -- -c '…'`
   * exits 127 because `--` ended option parsing and `-c` became a filename, and
   * `bash -C '…'` is noclobber, not a command flag. Kills a mutant that ignores
   * `--`, and one that folds the option character comparison to lower case.
   */
  test('option parsing ends where the shell ends it', () => {
    expect(matchClaudeBashRule('rm:*', `sh -- -c 'rm -rf /tmp/x'`, { ruleAction: 'deny' }))
      .toBe('no-match')
    expect(matchClaudeBashRule('rm:*', `bash -C 'rm -rf /tmp/x'`, { ruleAction: 'deny' }))
      .toBe('no-match')
    // Still the documented boundary: an operand that is a FILE is not a command
    // line, and no `c` was ever seen.
    expect(matchClaudeBashRule('rm:*', 'bash --login deploy.sh', { ruleAction: 'deny' }))
      .toBe('no-match')
    expect(matchClaudeBashRule('rm:*', 'bash --rcfile /dev/null deploy.sh', { ruleAction: 'deny' }))
      .toBe('no-match')
  })

  test('the splitter yields the wrapper first, then its script', () => {
    expect(splitWithSubstitutions(`bash --login -c 'rm -rf /tmp/x'`))
      .toEqual([`bash --login -c 'rm -rf /tmp/x'`, 'rm -rf /tmp/x'])
    expect(splitWithSubstitutions(`/usr/bin/env sh -c 'rm -rf /tmp/x'`))
      .toEqual([`/usr/bin/env sh -c 'rm -rf /tmp/x'`, 'rm -rf /tmp/x'])
    expect(splitWithSubstitutions(`sh -c $'rm -rf /tmp/x'`))
      .toEqual([`sh -c $'rm -rf /tmp/x'`, 'rm -rf /tmp/x'])
    // A rule naming the wrapper itself still matches the text as written.
    expect(matchClaudeBashRule('bash:*', `bash --login -c 'ls'`, { ruleAction: 'deny' }))
      .toBe('match')
  })
})

// ============================================================
// P2.157 — a command head hidden by a line continuation or a redirection
// ============================================================

/**
 * The shell lets a simple command's head be preceded by two things this
 * subsystem's enforcement readers did not model: a LINE CONTINUATION
 * (`\` + newline, which `bash(1)` removes from the input stream) and a
 * REDIRECTION (`> file cmd` runs `cmd`). Both hid the head as completely as a
 * reserved word did in P2.142.
 *
 * Every spelling below was verified BEFORE the fix, and verified as a COMMAND:
 * `bash -n` clean in `/bin/bash`, `/bin/sh` and `/bin/dash`, and each RAN its
 * body under all three with a `touch` in the payload position and a no-op
 * control that left no marker. The one exception is labelled where it appears.
 * Nothing executed while building this group named a real home or root.
 */
describe('P2.157 — the enforcement pass reads the head the shell reads', () => {
  const HOME = '/Users/testuser'
  const floor = (command: string) => findRootOrHomeRemoval(command, { home: HOME, platform: 'darwin' })
  const deny = (command: string) => matchClaudeBashRule('rm:*', command, { ruleAction: 'deny' })

  const fires: [string, string][] = [
    ['true && \\\nrm -rf ~', 'a continuation after a separator — the row that opened P2.157'],
    ['\\\nrm -rf ~', 'a continuation at the very head'],
    ['\\\n\\\nrm -rf ~', 'two of them'],
    ['{ \\\nrm -rf ~; }', 'a continuation inside a brace-group body'],
    ['> /tmp/lane-sink rm -rf ~', 'a leading output redirection'],
    ['< /dev/null rm -rf ~', 'a leading input redirection'],
    ['2> /tmp/lane-sink rm -rf ~', 'a leading fd redirection'],
    ['echo hi; > /tmp/lane-sink rm -rf ~', 'a leading redirection after a separator'],
    ['\\\n> /tmp/lane-sink rm -rf ~', 'both shapes at once'],
    // `<<<` is a bashism: `bash -n` and macOS `/bin/sh` accept it, `dash` does
    // NOT. Labelled rather than claimed, because "runs in every shell" was the
    // kind of over-claim that put a non-runnable string in a sibling row.
    ['<<< x rm -rf ~', 'a leading here-string (bash and macOS /bin/sh only)'],
  ]

  test.each(fires)('the floor fires and deny matches: %s', command => {
    // Kills: reverting `removeLineContinuations` or `stripLeadingRedirections`
    // — every row returns null / no-match again, as it did on HEAD.
    expect(floor(command)?.target).toBe('home')
    expect(deny(command)).toBe('match')
  })

  const staysQuiet: string[] = [
    // The negatives, so the fix is not just "fire more".
    'true && \\\necho hi',
    '> /tmp/lane-sink echo hi',
    'echo hi',
  ]

  test.each(staysQuiet)('stays quiet: %s', command => {
    expect(floor(command)).toBeNull()
  })

  test('the ALLOW pass does NOT learn either rule', () => {
    // THE ASYMMETRY, and the reason both normalisations live in the enforcement
    // pass. Teaching allow the same rules would let `allow Bash(rm:*)` approve
    // strings it does not approve today; this module's standing rule is that
    // extra reach may refuse more and never approve more.
    //
    // Kills: a mutant that drops the `throughEnforcementWrappers` guard and
    // normalises unconditionally — which is the obvious "simplification", and
    // the one that would spend the allow-path proof for real.
    expect(matchClaudeBashRule('rm:*', '\\\nrm -rf ./x', { ruleAction: 'allow' })).toBe('no-match')
    expect(matchClaudeBashRule('rm:*', '> /tmp/lane-sink rm -rf ./x', { ruleAction: 'allow' })).toBe('no-match')
    // ...while the same two commands DO reach deny. Without this half the
    // assertions above would pass for a matcher that matches nothing at all.
    expect(matchClaudeBashRule('rm:*', '\\\nrm -rf ./x', { ruleAction: 'deny' })).toBe('match')
    expect(matchClaudeBashRule('rm:*', '> /tmp/lane-sink rm -rf ./x', { ruleAction: 'deny' })).toBe('match')
  })

  test('a continuation inside single quotes is NOT one', () => {
    // Single quotes suspend the backslash entirely, so `'\<newline>'` is two
    // literal characters and no command starts after it.
    // Kills: a mutant that strips continuations without tracking single quotes.
    expect(floor("echo '\\\nrm -rf ~'")).toBeNull()
  })

  test('a backslash before a CARRIAGE RETURN is not a continuation', () => {
    // Measured for `scanCommand`'s CR rule and reused here: a bare CR is an
    // ordinary word character to bash, so `\<CR>` continues nothing.
    // Kills: a mutant widening the rule to any line ending.
    expect(floor('true && \\\rrm -rf ~')).toBeNull()
  })

  test('a redirection carrying its own target consumes no operand', () => {
    // `2>&1` names both descriptors inside the token. A stripper that always
    // ate the next word would eat `rm` and go quiet.
    // Kills: a mutant that unconditionally consumes an operand.
    expect(floor('2>&1 rm -rf ~')?.target).toBe('home')
    expect(floor('>/tmp/lane-sink rm -rf ~')?.target).toBe('home')
  })

  test('a bare redirection operator DOES consume its operand', () => {
    // The converse mutant: one that never consumes an operand reads `sink` as
    // the head and goes quiet.
    // Kills: a mutant that consumes only the operator token.
    expect(floor('> sink rm -rf ~')?.target).toBe('home')
  })

  test('process substitution at the head is a WORD, not a redirection', () => {
    // `>(cat) rm -rf ~` makes `>(cat)` the command NAME — bash reports "command
    // not found" and runs no `rm` — so the redirection stripper must leave it
    // alone. Asserted on the TOKENS rather than on the floor's verdict, and the
    // reason is a measurement: the floor already answers `home` here on HEAD,
    // because `COMPOUND_PATTERN_LABEL` matches `>(cat)` and reads it as a `case`
    // label. That over-fire is PRE-EXISTING (verified at 1c05aa43c in a pristine
    // worktree, `<(cat)` too) and out of this row's scope — asserting null would
    // have failed for a reason unrelated to the thing under test, and asserting
    // `home` would have pinned the stripper's correctness to an unrelated bug.
    //
    // Kills: a mutant dropping the `token[operator.length] === '('` guard, which
    // would strip `>(cat)` and promote `rm` to the head by a second route.
    expect(stripSubcommand('>(cat) rm -rf ~', true).tokens[0]).toBe('>(cat)')
    expect(stripSubcommand('> (cat) rm -rf ~', true).tokens[0]).not.toBe('>')
  })
})

// ============================================================
// P2.156 — the substitution budget bounded WORK, not REACH
// ============================================================

/**
 * `'( ' × 33 + 'rm -rf ~' + ' )' × 33` is 140 characters, runs in `/bin/bash`,
 * `/bin/sh` AND `/bin/dash` (verified: marker present in the run, absent in the
 * no-op control), and the floor returned null — while the same string at 32
 * nestings returned `home`. A depth budget was bounding reach.
 */
/**
 * P2.180 — A PATTERN LABEL THAT MATCHES A CONSTRUCT THAT IS NOT A COMMAND.
 *
 * `COMPOUND_PATTERN_LABEL` is meant to admit a `case` pattern label — `a)`,
 * `(a)`, `*)`, `(*.log)` — after which a new command genuinely begins. It also
 * admitted `>(cat)`, so `compoundKeywordBodies` emitted `rm -rf ~` as a body and
 * the floor reported `home` for a command that removes nothing.
 *
 * ## The row named one spelling; the sweep found a class straddling two readers
 *
 * Crossing every redirection prefix the shell accepts (`>`, `<`, `>>`, `&>`,
 * `2>`, `3<`, `{fd}>`, `>&`, `<&`, `<>`, `>|`) with the paren forms yields **44**
 * tokens accepted by `COMPOUND_PATTERN_LABEL` or `FUNCTION_DEFINITION_PARENS`
 * whose parens are process substitution. The second reader was NOT in the row:
 * `>( )` matched the function-definition regex with the NAME `>`, and the
 * normaliser's `()` then opened a body. One predicate now gates both.
 *
 * ## Measured, with a positive control on the same rig
 *
 * `touch <marker>` in the removal's position, `:` as the control: `>(cat) …`,
 * `<(cat) …`, `2>(cat) …` reach their payload in NONE of `bash`, `/bin/sh`,
 * `dash`, `zsh`, `ksh`. `bash`/`zsh` try to EXECUTE `/dev/fd/63` (exit 126/127);
 * `sh`/`dash`/`ksh` reject the construct at parse time (exit 2/3). No shell
 * created a file named `(cat)` either — the signature of a shell reading it as
 * an ordinary redirect, which would have meant `rm` really was the command.
 * The control row reached its payload in all five, so the rig can detect a run.
 *
 * ## The accepted cost, stated rather than discovered later
 *
 * `deny Bash(rm:*)` no longer matches `>(cat) rm -rf ~`. That is a deny
 * NARROWING, this module's normally-forbidden direction, and it is accepted here
 * on the measurement above: the command cannot remove anything on any shell
 * tested. In the 8 032 496-check corpus differential it was the ONLY narrowing,
 * it touched no command from the harvested corpus, and no `allow` verdict moved.
 */
describe('P2.180 — process substitution is a word, not a label', () => {
  // Every spelling the sweep found in command position. Each must be QUIET.
  const overFired: string[] = [
    '>(cat) rm -rf ~', '<(cat) rm -rf ~', '2>(cat) rm -rf ~',
    '>>(cat) rm -rf ~', '&>(cat) rm -rf ~', '{fd}>(cat) rm -rf ~',
    '>&(cat) rm -rf ~', '<>(cat) rm -rf ~', '3<(cat) rm -rf ~',
    // The FUNCTION_DEFINITION_PARENS half, which the row did not name.
    '>( ) rm -rf ~', '>() rm -rf ~', '<() rm -rf ~', '2>() rm -rf ~',
  ]

  test.each(overFired)('emits no keyword body: %s', command => {
    // Kills: reverting `opensProcessSubstitution`. Asserted through the deny
    // rule rather than the floor so this file tests its own subject — the body
    // list is what changed, and `deny Bash(rm:*)` is what reads it.
    expect(matchClaudeBashRule('rm:*', command, { ruleAction: 'deny' })).toBe('no-match')
  })

  test('a removal INSIDE the parens is still reached', () => {
    // THE HOLE THIS COULD HAVE OPENED, and the reason the fix touches only the
    // two label readers: `<(`/`>(` are substitution OPENERS, so `scanCommand`
    // walks their contents as commands on their own terms. Kills a mutant that
    // suppresses the span walk along with the label.
    for (const command of ['cat >(rm -rf ~)', 'diff <(rm -rf ~) b', 'cat 2>(rm -rf /)']) {
      expect(matchClaudeBashRule('rm:*', command, { ruleAction: 'deny' }), command).toBe('match')
    }
  })

  test('a real case label still opens a command', () => {
    // Kills: an `opensProcessSubstitution` that returns true too broadly — the
    // whole point of the label regex is these.
    //
    // ONLY the paren-PREFIXED spellings appear here, and that is not a
    // convenience: a bare `a)` / `*)` / `a|b)` label leaves the scanner's paren
    // depth unbalanced, so those commands are `'unparseable'` rather than
    // `match` — P2.144's entire premise, and the reason the floor grew a textual
    // fallback for them. Asserting `match` on them tests the parser's failure,
    // not this label rule. Their floor behaviour is covered in
    // `removal-circuit-breaker.test.ts` instead.
    for (const command of [
      'case $x in (a) rm -rf ~ ;; esac',
      'case $f in (*.log) rm -rf ~ ;; esac',
    ]) {
      expect(matchClaudeBashRule('rm:*', command, { ruleAction: 'deny' }), command).toBe('match')
    }
    for (const command of ['case $x in a) rm -rf ~ ;; esac', 'case $x in *) rm -rf ~ ;; esac']) {
      expect(matchClaudeBashRule('rm:*', command, { ruleAction: 'deny' }), command).toBe('unparseable')
    }
  })

  test('all four function-definition spellings still open a body', () => {
    // Kills: gating the NORMALISER too broadly — `()` carries no redirection
    // operator, so it must survive `isFunctionDefinitionToken`.
    for (const command of [
      'wipe() { rm -rf ~; }', 'wipe(){ rm -rf ~; }',
      'wipe () { rm -rf ~; }', 'wipe ( ) { rm -rf ~; }',
      'function wipe(){ rm -rf ~; }',
    ]) {
      expect(matchClaudeBashRule('rm:*', command, { ruleAction: 'deny' }), command).toBe('match')
    }
  })

  test('the two spellings this does NOT fix, and the route they take instead', () => {
    // `<&(cat) …` and `>|(cat) …` still reach `rm -rf ~`, and NOT through the
    // label: the `&` and `|` inside `<&`/`>|` are read as top-level SEPARATORS,
    // so the command splits into `<` + `(cat) rm -rf ~` and the bare
    // single-word subshell token `(cat)` is what `COMPOUND_PATTERN_LABEL`
    // accepts. Two reasons they are left, both measured:
    //  - `(cat)` is LEXICALLY IDENTICAL to a legitimate paren-prefixed `case`
    //    label. `case $f in (*.log) rm -rf ~ ;; esac` must keep firing, and no
    //    token-level rule can separate the two — only context can.
    //  - the alternative is teaching `scanCommand`'s separator rule that `&`
    //    after `<` is not a separator, which is on the ALLOW path, to buy an
    //    over-fire on a string that RUNS IN NO SHELL: `<&(cat) <payload>` and
    //    `>|(cat) <payload>` reach their payload in none of `bash`, `/bin/sh`,
    //    `dash`, `zsh`, `ksh` (syntax error or exit 1/2/3, marker absent, with
    //    the control row running in all five).
    // Pinned so the remaining over-fire is a recorded decision, not a gap.
    expect(matchClaudeBashRule('rm:*', '<&(cat) rm -rf ~', { ruleAction: 'deny' })).toBe('match')
    expect(matchClaudeBashRule('rm:*', '>|(cat) rm -rf ~', { ruleAction: 'deny' })).toBe('match')
    expect(splitCompoundCommand('<&(cat) rm -rf ~')).toEqual(['<', '(cat) rm -rf ~'])
  })

  test('an ordinary leading redirection is untouched', () => {
    // P2.157's rule — the token AFTER a redirection is the head — must keep
    // working. This does NOT kill a mutant that drops the
    // `token[operator.length] === '('` test: that mutant is unreachable through
    // the splitter, measured at 0 differences over 31 910 candidates. A token
    // that is a LABEL but not process substitution has to end in `)` with no
    // `(` before it (`>)`, `<)`, `{fd}>)`), and such a command is
    // `'unparseable'` — `scanCommand` rejects a stray close paren — so
    // `opensCompoundCommand` never sees one. The test is kept because the
    // property is load-bearing; the claim about what it kills is not made.
    expect(matchClaudeBashRule('rm:*', '> /tmp/x rm -rf ~', { ruleAction: 'deny' })).toBe('match')
    expect(matchClaudeBashRule('rm:*', '2>/tmp/x rm -rf ~', { ruleAction: 'deny' })).toBe('match')
    expect(matchClaudeBashRule('rm:*', 'rm -rf ~ 2>&1', { ruleAction: 'deny' })).toBe('match')
  })
})

describe('P2.156 — a wrapper chain cannot hide its payload behind the budget', () => {
  const HOME = '/Users/testuser'
  const floor = (command: string) => findRootOrHomeRemoval(command, { home: HOME, platform: 'darwin' })
  const chain = (depth: number, payload = 'rm -rf ~') =>
    '( '.repeat(depth) + payload + ' )'.repeat(depth)

  test('the 140-character command that opened the row', () => {
    const command = chain(33)
    expect(command.length).toBe(140)
    // Kills: restoring the depth budget as a reach bound.
    expect(floor(command)?.target).toBe('home')
  })

  test.each([32, 33, 64, 300, 1000])('reaches the payload at depth %i', depth => {
    // Depth 32 is the positive control: it fired on HEAD too, so it proves the
    // rig, not the fix. The rest are the new reach.
    expect(floor(chain(depth))?.target).toBe('home')
  })

  test('command-substitution and backtick chains too, not just subshells', () => {
    expect(floor('echo ' + '$('.repeat(33) + 'rm -rf ~' + ')'.repeat(33))?.target).toBe('home')
    expect(floor('$('.repeat(50) + 'rm -rf /' + ')'.repeat(50))?.target).toBe('root')
  })

  test('a deep chain with NO removal stays quiet', () => {
    // Kills a mutant that fires on depth itself rather than on a target.
    expect(floor(chain(33, 'echo hi'))).toBeNull()
    expect(floor(chain(300, 'rm -rf ./build'))).toBeNull()
  })

  test('the peel does not read through quotes', () => {
    // A quoted body is not a substitution span, so the peel must stop at the
    // first quote character. The fixtures must START with the quote, or the peel
    // never begins and the assertion is vacuous — measured: an earlier version
    // used `echo '( rm -rf ~ )'`, whose head is `echo`, and a quote-peeling
    // mutant SURVIVED it.
    //
    // Kills a mutant that adds `'`/`"` to the opener set AND derives the closer
    // from the opener (both halves are needed; adding openers alone is inert,
    // because the closer stays `)` and nothing matches).
    expect(floor(`'( rm -rf ~ )'`)).toBeNull()
    expect(floor('"( rm -rf ~ )"')).toBeNull()
    // The positive control: the same body WITHOUT the quotes does fire, so these
    // two are quiet because of the quoting and not because the shape is unknown.
    expect(floor('( rm -rf ~ )')?.target).toBe('home')
  })

  test('the recovery is strictly ADDITIVE: within budget the list is unchanged', () => {
    // The property that makes this safe to add to a list three consumers read:
    // a chain that fits inside the budget contributes nothing new, so the forms
    // are exactly what HEAD produced. Pinned verbatim.
    // Kills: removing the dedupe (the innermost body is appended twice, which is
    // what the first draft of this change did and what the P2.142 splitter test
    // caught).
    expect(splitWithSubstitutions('( ( rm -rf ~ ) )'))
      .toEqual(['( ( rm -rf ~ ) )', '( rm -rf ~ )', 'rm -rf ~'])
    expect(splitWithSubstitutions('echo $(rm -rf ~)'))
      .toEqual(['echo $(rm -rf ~)', 'rm -rf ~'])
  })

  test('a two-span subcommand is not a wrapper chain, and the peel is discarded', () => {
    // `( a ) ( b )` opens and closes but is TWO spans; peeling it by the ends
    // yields `a ) ( b`, which does not parse. The caller drops it, so a peel is
    // only ever additive. Kills a mutant that pushes the peel without checking
    // that it parses — which would put unparseable text into the form list.
    // Pinned as the exact list: the subcommand itself, then each span's content.
    // The peeled `echo one ) ( rm -rf ~` appears nowhere, which is the point.
    expect(splitWithSubstitutions('( echo one ) ( rm -rf ~ )'))
      .toEqual(['( echo one ) ( rm -rf ~ )', 'echo one', 'rm -rf ~'])
  })
})

/**
 * P2.329 — a newline quoted into an argument slipped past every `*` pattern,
 * DENY included, because `compileBashPattern` built `*` as `.` and compiled
 * without the `s` flag.
 *
 * These tests are written against a LITERAL line terminator. The two-character
 * escape `\n` is a different input and always matched, so a test written with
 * the escape passes on the broken compiler — which is why the first assertion
 * here is that the two are not the same string.
 */
describe('a `*` pattern crosses a line terminator', () => {
  // Written as an actual line break, not as an escape, for the reason above.
  const LF = `
`
  const CR = String.fromCharCode(13)
  // JavaScript counts these two as line terminators; a shell does not, so they
  // are regex-only exposure and were bypasses for exactly that reason.
  const LS = String.fromCharCode(0x2028)
  const PS = String.fromCharCode(0x2029)
  const TERMINATORS: Array<[name: string, char: string]> =
    [['LF', LF], ['CR', CR], ['U+2028', LS], ['U+2029', PS]]

  test('the input under test is the literal terminator, not the escape', () => {
    // Kills a rewrite of these tests that reaches for '\\n' and passes on the
    // broken compiler.
    expect(LF).toHaveLength(1)
    expect(String.raw`\n`).toHaveLength(2)
    expect(LF).not.toBe(String.raw`\n`)
  })

  test('a deny is not evadable by quoting a terminator into an argument', () => {
    const deny = (command: string) => matchClaudeBashRule('rm *', command, { ruleAction: 'deny' })
    // Controls first: the deny fires on the bare command and on an ordinary
    // quoted argument, so a `match` below is this pattern matching.
    expect(deny('rm -rf ~')).toBe('match')
    expect(deny("rm -rf ~ 'x'")).toBe('match')
    // The bypass: one quoted terminator and the deny returned 'no-match'.
    for (const [name, char] of TERMINATORS) {
      expect([name, deny(`rm -rf ~ 'a${char}b'`)]).toEqual([name, 'match'])
      expect([name, deny(`rm -rf ~ "a${char}b"`)]).toEqual([name, 'match'])
    }
    // The escaped form matched before the fix too; asserting it keeps the two
    // inputs distinguishable if this test is ever rewritten.
    expect(deny(String.raw`rm -rf ~ 'a\nb'`)).toBe('match')
    // Negative control: still not a matcher that fires on everything.
    expect(deny(`git status 'a${LF}b'`)).toBe('no-match')
  })

  test('the `:*` and bare-prefix forms cross it as well', () => {
    // `:*` and a trailing ` *` compile through the same boundary branch, and a
    // pattern with an interior `*` through the other one. All three were blind.
    for (const [name, char] of TERMINATORS) {
      const command = `rm -rf ~ 'a${char}b'`
      for (const pattern of ['rm:*', 'rm *', 'rm * ~ *', '*']) {
        expect([name, pattern, matchClaudeBashRule(pattern, command, { ruleAction: 'deny' })])
          .toEqual([name, pattern, 'match'])
      }
    }
    // The word boundary a trailing ` *` enforces is NOT loosened by the flag:
    // `lsof` must still fail `ls *` (permissions.md#wildcard-patterns — "The
    // space before a trailing `*` is part of the rule").
    expect(matchClaudeBashRule('ls *', `lsof 'a${LF}b'`, { ruleAction: 'deny' })).toBe('no-match')
  })

  test('at DSL level the evaded deny produced no action at all', () => {
    // The matcher returning 'no-match' is not the user-visible harm; this is.
    // A configured `deny Bash(rm *)` simply vanished for the command.
    const program = compilePermissionDslV1({
      generation: 'g',
      projectTrusted: false,
      layers: [{
        scope: 'workspace',
        sourceDigest: 'd',
        document: { version: 1, rules: [
          { id: 'deny-rm', action: 'deny', match: { kind: 'bash', pattern: 'rm *' } },
        ] },
      }],
    })
    const decide = (command: string) => evaluatePermissionDslV1(
      program,
      { generation: 'g', semanticId: 'bash', toolName: 'Bash', input: { command }, cwd: '/work' },
    ).action

    expect(decide('rm -rf ~')).toBe('deny')
    for (const [name, char] of TERMINATORS) {
      expect([name, decide(`rm -rf ~ 'a${char}b'`)]).toEqual([name, 'deny'])
    }
    // Positive control for the `undefined` this used to return: an unrelated
    // command genuinely has no opinion, so `undefined` is a real verdict here
    // and the assertions above are not just asserting non-undefined.
    expect(decide('git status')).toBeUndefined()
  })

  /**
   * THIS TEST USED TO ASSERT THE OPPOSITE ON ITS LAST LINE, AND THE ASSERTION
   * WAS FALSE (P2.350). It read `expect(allow("git commit -m 'a<LF>b'"))
   * .toBe('match')` under the title "crossing a terminator cannot approve more
   * than before", on the argument that a terminator surviving into the regex
   * must be inside a quoted token and therefore inert. That argument assumes
   * `scanCommand`'s quote model agrees with the shell's, and it does not — see
   * the P2.350 block below, where a real two-command shell script arrives here
   * as ONE subcommand. The allow side must therefore refuse a glob match over a
   * terminator, and the test that said otherwise is corrected here rather than
   * deleted, so the refuted claim stays visible.
   */
  test('an ALLOW never crosses a terminator, quoted or not (P2.350)', () => {
    const allow = (command: string) => matchClaudeBashRule('git *', command, { ruleAction: 'allow' })
    // An UNQUOTED terminator is a command separator the splitter already splits
    // on (permissions.md#compound-commands — "The recognized command separators
    // are `&&`, `||`, `;`, `|`, `|&`, `&`, and newlines. A rule must match each
    // subcommand independently").
    expect(allow(`git status${LF}rm -rf ~`)).toBe('no-match')
    expect(allow(`git status${CR}${LF}rm -rf ~`)).toBe('no-match')
    // A QUOTED one is refused too, because "quoted" is this scanner's opinion
    // and not the shell's. Correct direction: a prompt, not an approval.
    expect(allow(`git commit -m 'a${LF}b'`)).toBe('no-match')
    // Control, so the row above is about the terminator and not about the rule:
    // the same command on one line is still approved.
    expect(allow(`git commit -m 'a b'`)).toBe('match')
  })
})

/**
 * P2.350 — the P2.329 fix put `s` on ALL THREE permission compilers, and on the
 * ALLOW branch that turned a prompt into an auto-approval. Strictly worse than
 * the bug it fixed: the parent commit prompted, the child approved `rm -rf ~`.
 *
 * The mechanism, and why "a terminator here is inside a quoted token" is false:
 * `scanCommand` disables its comment rule outright when the command contains
 * `$'` or `<<`, because its quote model is not the shell's. With the comment
 * rule off, the apostrophe in a REAL comment opens a quote span, the newline
 * behind it is swallowed instead of separating, and the whole script arrives as
 * ONE subcommand whose head is the harmless first command.
 *
 * `/bin/sh` and `/bin/bash` both run TWO commands for the fixture below —
 * verified by running it, not argued.
 *
 * Direction is asymmetric ON PURPOSE and the asymmetry is the contract:
 * permissions.md#compound-commands makes a newline a separator requiring
 * per-subcommand matching, so a PERMISSIVE pattern spanning one is wrong, while
 * settings-reference.md#sandbox-excludedcommands states the prohibitive reading
 * for the same `Bash(...)` syntax — "When any part of a compound command
 * matches an entry, Claude Code runs the whole command unsandboxed."
 */
describe('an allow rule cannot span a line terminator (P2.350)', () => {
  const LF = `
`
  const EXPLOIT = `cat <<< 'x' # don't${LF}rm -rf ~ #'`

  /**
   * THIS ROW'S OWN PREDICTION CAME TRUE, AND P2.363 IS WHAT CAME TRUE.
   *
   * The assertion below read `expect(splitCompoundCommand(EXPLOIT))
   * .toEqual([EXPLOIT])` under the note "if the splitter ever learns to split
   * this, the rows below stop being about the allow branch and this assertion is
   * what says so". The splitter did not learn to SPLIT it — it learned to
   * REFUSE it, which is the same signal for this block's purposes and the one
   * the standing "dumber, not smarter" ruling permits.
   */
  test('the fixture is one subcommand to this splitter and two to the shell', () => {
    // The premise of the whole block, asserted rather than assumed. P2.363 did
    // NOT make the splitter split this — it made the allow VERDICT refuse to
    // believe the reading, and gave the deny side the shell's one as well. The
    // reading itself is unchanged, which is what this row still pins.
    expect(splitCompoundCommand(EXPLOIT)).toEqual([EXPLOIT])
    expect(LF).toHaveLength(1)
    expect(LF).not.toBe(String.raw`\n`)
  })

  test('a glob allow does not approve the exploit, and NOW there is a floor', () => {
    // `'unparseable'` rather than `'no-match'` since P2.363; the DSL prompts on
    // both, so the allow branch's guarantee is unchanged.
    expect(matchClaudeBashRule('cat *', EXPLOIT, { ruleAction: 'allow' })).toBe('unparseable')
    // THIS LINE ASSERTED `'no-match'` UNTIL P2.363, under the note "the deny side
    // sees the same single subcommand, whose head is `cat`, so a configured
    // `deny Bash(rm:*)` never fires on this command. There is nothing beneath."
    // That was true and it was the hole: `/bin/sh` and `/bin/bash` both run the
    // removal (measured with a non-destructive stand-in verb), and neither the
    // deny nor `findRootOrHomeRemoval` could see it. The enforcement list now
    // carries the comment-honouring reading as well, so there IS something
    // beneath, and the allow branch is no longer holding the line alone.
    expect(matchClaudeBashRule('rm:*', EXPLOIT, { ruleAction: 'deny' })).toBe('match')
    // Control: the benign command the rule is actually for is still approved,
    // so the rows above are the terminator and not `<<<` or the comment.
    expect(matchClaudeBashRule('cat *', `cat <<< 'x'`, { ruleAction: 'allow' })).toBe('match')
  })

  test("the ANSI-C form of the same hole ($' disables the comment rule too)", () => {
    const ansiC = `cat $'x' # don't${LF}rm -rf ~ #'`
    expect(splitCompoundCommand(ansiC)).toEqual([ansiC])
    expect(matchClaudeBashRule('cat *', ansiC, { ruleAction: 'allow' })).toBe('unparseable')
    expect(matchClaudeBashRule('rm:*', ansiC, { ruleAction: 'deny' })).toBe('match')
  })

  test('at DSL level the exploit is DENIED, and used to auto-approve', () => {
    // The user-visible harm is not `match`; it is that a configured
    // `allow Bash(cat *)` produced the action `allow` with no prompt.
    const decide = (command: string) => evaluatePermissionDslV1(
      compilePermissionDslV1({
        generation: 'g',
        projectTrusted: false,
        layers: [{
          scope: 'workspace',
          sourceDigest: 'd',
          document: { version: 1, rules: [
            { id: 'allow-cat', action: 'allow', match: { kind: 'bash', pattern: 'cat *' } },
            { id: 'deny-rm', action: 'deny', match: { kind: 'bash', pattern: 'rm:*' } },
          ] },
        }],
      }),
      { generation: 'g', semanticId: 'bash', toolName: 'Bash', input: { command }, cwd: '/work' },
    ).action

    // THIS ASSERTED `.toBeUndefined()` — "no rule has an opinion = the caller
    // prompts" — UNTIL P2.363. The configured `deny Bash(rm:*)` in this very
    // program now FIRES on the exploit, because the enforcement list carries the
    // reading in which `rm -rf ~` is its own subcommand. A prompt was the best
    // this block could reach while the deny was blind; a deny is better, and it
    // is the verdict the user configured.
    expect(decide(EXPLOIT)).toBe('deny')
    // Positive controls on the same program, so the verdict above is a verdict
    // and not a broken fixture: the allow still allows and the deny still denies.
    expect(decide(`cat <<< 'x'`)).toBe('allow')
    expect(decide('rm -rf ~')).toBe('deny')
  })

  test('the DENY side is unmoved — P2.329 stays fixed', () => {
    // The half of `0d7af52cd` that was correct. Every one of the four
    // terminators must still make a deny fire; this is the assertion that fails
    // if someone "fixes" P2.350 by reverting the `s` flag everywhere.
    const CR = String.fromCharCode(13)
    const terminators: Array<[string, string]> =
      [['LF', LF], ['CR', CR], ['U+2028', String.fromCharCode(0x2028)], ['U+2029', String.fromCharCode(0x2029)]]
    for (const [name, char] of terminators) {
      for (const action of ['deny', 'ask'] as const) {
        expect([name, action, matchClaudeBashRule('rm *', `rm -rf ~ 'a${char}b'`, { ruleAction: action })])
          .toEqual([name, action, 'match'])
      }
    }
    // And the hook `if` filter, which is ANY-shaped and fails open, keeps the
    // `s` regex for the same reason deny does.
    expect(matchClaudeBashIfRule('rm *', `rm -rf ~ 'a${LF}b'`)).toBe('match')
  })

  test('the exact/glob distinction is BELOW the split, and P2.363 sits above it', () => {
    // THIS ASSERTED `'match'` UNTIL P2.363, on the reading of
    // permissions.md#wildcard-patterns that "A rule with no `*` matches one exact
    // command" — naming the whole text is the admin approving that text, not a
    // family, so the terminator refusal is scoped to `hasGlob` exactly as the
    // exec-wrapper, unsafe-shell-form and substitution refusals are.
    //
    // That scoping is UNCHANGED and is re-pinned below. What changed is that a
    // command whose two readings disagree never reaches a pattern at all: the
    // split refuses first, and `matchClaudeBashRule` returns `'unparseable'`
    // before `compileBashPattern` runs. So an exact rule cannot approve THIS
    // command either — a divergence from the sentence above, in the direction of
    // a prompt, and named here rather than buried. It joins the divergence
    // P2.350 recorded for `Bash(*)` against
    // permissions.md#match-all-uses-of-a-tool, which glob allows already carry
    // for exec wrappers and substitution in all three trees.
    expect(matchClaudeBashRule(EXPLOIT, EXPLOIT, { ruleAction: 'allow' })).toBe('unparseable')
    // The `hasGlob` scoping itself, on a command the split CAN corroborate: an
    // exact rule naming a terminator-carrying command still matches, and this is
    // what fails if someone widens the terminator refusal past `hasGlob`.
    const spanning = `git commit -m 'a${LF}b'`
    expect(matchClaudeBashRule(spanning, spanning, { ruleAction: 'allow' })).toBe('match')
  })

  test('a pattern that spells the terminator out is refused as well', () => {
    // The floor the `u`-only `allowRegex` does NOT provide on its own, so this
    // is what makes the explicit guard a live sentinel rather than dead code:
    // here the literal terminator in the PATTERN matches the one in the
    // command, and only the `hasGlob` refusal stops it.
    expect(matchClaudeBashRule(`git commit -m 'a${LF}*`, `git commit -m 'a${LF}b'`, { ruleAction: 'allow' }))
      .toBe('no-match')
    // Same pattern on a deny still fires — the guard is allow-only.
    expect(matchClaudeBashRule(`git commit -m 'a${LF}*`, `git commit -m 'a${LF}b'`, { ruleAction: 'deny' }))
      .toBe('match')
  })

  test('a terminator inside a stripped known-safe assignment is not a refusal', () => {
    // The guard reads the text the regex reads, not the raw subcommand, so the
    // allow side is otherwise byte-for-byte what it was before `0d7af52cd`.
    // permissions.md#process-wrappers: "Claude Code also strips a leading
    // assignment of certain known-safe environment variables, so
    // `Bash(npm test *)` matches `NODE_ENV=test npm test`."
    expect(matchClaudeBashRule('npm test *', `NODE_ENV='a${LF}b' npm test`, { ruleAction: 'allow' }))
      .toBe('match')
  })
})

/**
 * P2.363 — THE DISAGREEMENT ITSELF, which P2.329 and P2.350 were both spent
 * downstream of.
 *
 * `scanCommand` switches its comment rule off whenever it sees `$'` or `<<`, and
 * then reports a subcommand list that disagrees with what the shell executes.
 * Both earlier rows were fixed at the MATCHER — one on the compiled pattern, one
 * on the allow branch's terminator refusal — and the disagreement stayed. This
 * block is the third symptom arriving, and it is on the side neither fix
 * covered.
 *
 * ## Measured, not argued
 *
 * Through `/bin/sh` and `/bin/bash`, with `echo SECOND_RAN` standing in for the
 * removal so nothing destructive is ever executed (`bash -n` clean, both shells
 * print two lines):
 *
 * | command | shell runs | parent split | parent `deny Bash(rm:*)` | parent floor |
 * | --- | --- | --- | --- | --- |
 * | `cat <<< 'x' # don't`+LF+`rm -rf ~ #'` | 2 commands | ONE subcommand | `no-match` | `null` |
 * | `cat $'x' # don't`+LF+`rm -rf ~ #'` | 2 commands | ONE subcommand | `no-match` | `null` |
 * | the same without a guard | 2 commands | two subcommands | `match` | `home` |
 *
 * So a configured deny and the removal circuit breaker BOTH missed a home
 * removal the shell runs, and only P2.350's glob-allow refusal stood between it
 * and an auto-approval — which its own test note said in terms ("There is
 * nothing beneath").
 *
 * ## The fix is the SIBLING'S, and it is dumber rather than smarter
 *
 * `splitPowerShellCommand` has parsed twice and refused on disagreement since
 * P2.75. Applied here: `commentReadingAgrees` re-parses with `honourComments`
 * overriding both guards and asks only whether the two readings are the same
 * string list. Neither pass learns any shell grammar it did not have, and the
 * second is never believed on its own — the desyncs recorded on `scanCommand`
 * are why the guards exist. It is only ever asked whether it AGREES.
 *
 * Placement is the asymmetry this module already draws everywhere: the ALLOW
 * branch refuses (an `'unparseable'` allow is a prompt, so it can only approve
 * less), while `splitWithSubstitutions` ADDS the comment-honouring reading for
 * deny/ask — the same append P2.179 makes for the ANSI-C reading, for the same
 * reason. `splitCompoundCommand` itself is byte-identical, which the whole
 * `parentVerdicts` table above still pins.
 *
 * ## Blast radius, measured rather than argued
 *
 * 35 198 string literals harvested from the permission surface at HEAD crossed
 * with 150 `Bash(...)`/`PowerShell(...)` patterns in three actions:
 * `splitCompoundCommand` moved on **zero** commands, `splitWithSubstitutions`
 * on **11 — every one a strict prefix-superset**, and at verdict level the only
 * transitions were `allow: match -> unparseable` (20) and
 * `allow: no-match -> unparseable` (2 200), i.e. an approval becoming a prompt
 * and a prompt staying one. **Zero `allow: * -> match`. Zero `deny: match -> *`.
 * Zero `ask: match -> *`.** On a grid saturated with the construct (66 427
 * commands) the deny gain appears as well: 1 684 `deny: no-match -> match` and
 * 1 684 `ask: no-match -> match`, and still zero in either dangerous direction.
 *
 * ## The divergence this creates, named rather than buried
 *
 * `permissions.md#wildcard-patterns` says "A rule with no `*` matches one exact
 * command", and the refusal sits ABOVE that distinction — a command whose
 * reading is uncorroborated never reaches a pattern at all, so an exact rule
 * cannot approve one either. It joins the divergence P2.350 recorded for
 * `Bash(*)` against `permissions.md#match-all-uses-of-a-tool`, which glob allows
 * already carry for exec wrappers and command substitution in all three trees.
 * Direction is a prompt in every case.
 */
describe('the splitter and the shell disagree, and the allow side stops believing it (P2.363)', () => {
  const LF = String.fromCharCode(10)
  const HOME = '/Users/tester'
  const guarded: Array<[label: string, command: string]> = [
    ['a here-string arms the guard', `cat <<< 'x' # don't${LF}rm -rf ~ #'`],
    ['an ANSI-C literal arms it too', `cat $'x' # don't${LF}rm -rf ~ #'`],
    ['a heredoc arms it', `cat <<EOF${LF}hi${LF}EOF${LF}echo ok # don't${LF}rm -rf ~ #'`],
  ]

  test.each(guarded)('the ALLOW verdict refuses an uncorroborated reading: %s', (_label, command) => {
    // Kills: dropping the `commentReadingAgrees` call from `matchClaudeBashRule`.
    expect(matchClaudeBashRule('cat *', command, { ruleAction: 'allow' })).toBe('unparseable')
    expect(matchClaudeBashRule('*', command, { ruleAction: 'allow' })).toBe('unparseable')
    // And ABOVE the exact/glob distinction — an exact rule naming the whole text
    // is refused too, because the refusal precedes `compileBashPattern`.
    expect(matchClaudeBashRule(command, command, { ruleAction: 'allow' })).toBe('unparseable')
  })

  test.each(guarded)('the DENY side gains the shell\'s reading instead: %s', (_label, command) => {
    // THE SECURITY GAIN. Kills: dropping the `commentForms` append from
    // `splitWithSubstitutions`, and any mutant that refuses on the deny side
    // instead of adding (which would answer `'unparseable'` here, not `'match'`).
    expect(matchClaudeBashRule('rm:*', command, { ruleAction: 'deny' })).toBe('match')
    expect(matchClaudeBashRule('rm:*', command, { ruleAction: 'ask' })).toBe('match')
    // …and the removal circuit breaker inherits it, because it reads the same
    // list. On the parent every row here returned null.
    expect(findRootOrHomeRemoval(command, { home: HOME, platform: 'darwin' })?.target).toBe('home')
  })

  test('the guarded reading is still FIRST, so nothing a deny already matched is lost', () => {
    // Kills a mutant that REPLACES the guarded reading with the corroborating
    // one rather than appending. Order is the contract.
    const command = `cat <<< 'x' # don't${LF}rm -rf ~ #'`
    expect(splitCompoundCommand(command)).toEqual([command])
    expect(splitWithSubstitutions(command)).toEqual([command, `cat <<< 'x'`, 'rm -rf ~'])
  })

  test('the controls: three ways to not arm the guard, none of them move', () => {
    // (1) No guard at all — the comment rule was never off, so there is nothing
    // to corroborate and this is the parent's behaviour verbatim.
    const plain = `cat ./x # don't${LF}rm -rf ~ #'`
    expect(splitCompoundCommand(plain)).toEqual(['cat ./x', 'rm -rf ~'])
    expect(matchClaudeBashRule('cat *', plain, { ruleAction: 'allow' })).toBe('no-match')
    expect(matchClaudeBashRule('rm:*', plain, { ruleAction: 'deny' })).toBe('match')

    // (2) A guard but NO `#` — the two readings are the same list by
    // construction, which is what makes the `#` half of the gate a cost guard
    // rather than a semantic one. This is the row that fails if someone widens
    // the gate to every guarded command.
    const noHash = `cat <<< 'x'${LF}rm -rf ~`
    expect(matchClaudeBashRule('cat *', noHash, { ruleAction: 'allow' })).toBe('no-match')
    expect(matchClaudeBashRule('cat *', `cat <<< 'x'`, { ruleAction: 'allow' })).toBe('match')

    // (3) A guard AND a `#` that is not at a word start, so no comment opens in
    // EITHER reading and the command is approved exactly as before.
    expect(matchClaudeBashRule('echo:*', 'echo <<< a#b', { ruleAction: 'allow' })).toBe('match')
  })

  test('at DSL level the exploit is DENIED, where the parent had no opinion', () => {
    const decide = (command: string) => evaluatePermissionDslV1(
      compilePermissionDslV1({
        generation: 'g',
        projectTrusted: false,
        layers: [{
          scope: 'workspace',
          sourceDigest: 'd',
          document: { version: 1, rules: [
            { id: 'allow-cat', action: 'allow', match: { kind: 'bash', pattern: 'cat *' } },
            { id: 'deny-rm', action: 'deny', match: { kind: 'bash', pattern: 'rm:*' } },
          ] },
        }],
      }),
      { generation: 'g', semanticId: 'bash', toolName: 'Bash', input: { command }, cwd: '/work' },
    ).action
    expect(decide(`cat <<< 'x' # don't${LF}rm -rf ~ #'`)).toBe('deny')
    // Positive controls on the same program: the allow still allows, the deny
    // still denies, so the row above is a verdict and not a broken fixture.
    expect(decide(`cat <<< 'x'`)).toBe('allow')
    expect(decide('rm -rf ~')).toBe('deny')
  })
})

/**
 * F1.1143 (origin DN-196 proposed row 3) — the deny reading resolves the
 * command head the way the shell reads it. `'touch' x`, `"touch" x`, `\touch
 * x`, `'tou'"ch" x` and `exec touch x` all run the program `touch`, and the
 * reading compared the head AS WRITTEN, so every one of them was `no-match`
 * where the bare form was a match — measured at HEAD 2026-10-09 (probe in
 * work/bk-18/), for `Bash(…)` denies directly and, since F1.816, for
 * structural denies inside compounds, whose seam asks this same function.
 * DENY only: the ask reading is deliberately unchanged (DN-196 proposed row 2
 * owns an ask widening — an extra card is a product posture).
 */
describe('F1.1143 — the deny reading resolves a quoted, escaped or exec-prefixed head', () => {
  test('refuses every spelling the shell runs as the program, bare and inside compounds, exact rules included', () => {
    for (const command of [`'touch' x`, `"touch" x`, `\\touch x`, `exec touch x`, `exec 'touch' x`, `'tou'"ch" x`, `sudo 'touch' x`, `exec sudo touch x`, `echo a; 'touch' x`, `echo a; exec touch x`]) {
      expect(matchClaudeBashRule('touch:*', command, { ruleAction: 'deny' }), command).toBe('match')
    }
    expect(matchClaudeBashRule('touch x', `'touch' x`, { ruleAction: 'deny' })).toBe('match')
  })

  test('negative: the ask reading stays as today, and unrelated rules and non-head arguments stay quiet', () => {
    for (const command of [`'touch' x`, `\\touch x`, `exec touch x`]) {
      expect(matchClaudeBashRule('touch:*', command, { ruleAction: 'ask' }), command).toBe('no-match')
    }
    expect(matchClaudeBashRule('rm:*', `'touch' x`, { ruleAction: 'deny' })).toBe('no-match')
    expect(matchClaudeBashRule('touch:*', `echo touch`, { ruleAction: 'deny' })).toBe('no-match')
    expect(matchClaudeBashRule('touch:*', `exec`, { ruleAction: 'deny' })).toBe('no-match')
  })

  test('residue — one head is resolved, not a chain: a quoted program behind exec plus a wrapper stays no-match, recorded rather than claimed closed', () => {
    // P2.100's shape, F1.1143's second residue (measured 2026-10-10). The bare
    // `exec` drops, but the head of the remainder is the wrapper itself (`sudo`,
    // already clean — `exec` is no wrapper's name, so the strip loop breaks
    // there), and the quoted program behind it is never re-resolved. Honest
    // boundary: the program-level deny rule does not refuse this spelling; the
    // wrapper's own deny rule still does, and a prefix allow keeps the raw head
    // (`allow Bash(sudo:*)` is no-match on it). Closing it means iterating head
    // resolution through wrappers — a row of its own.
    expect(matchClaudeBashRule('touch:*', `exec sudo 'touch' x`, { ruleAction: 'deny' })).toBe('no-match')
    // The ask reading is unchanged for the whole family, and the wrapper rule
    // still decides: the miss is the program-level reading only.
    expect(matchClaudeBashRule('touch:*', `exec sudo 'touch' x`, { ruleAction: 'ask' })).toBe('no-match')
    expect(matchClaudeBashRule('sudo:*', `exec sudo 'touch' x`, { ruleAction: 'deny' })).toBe('match')
    expect(matchClaudeBashRule('sudo:*', `exec sudo 'touch' x`, { ruleAction: 'allow' })).toBe('no-match')
  })
})
