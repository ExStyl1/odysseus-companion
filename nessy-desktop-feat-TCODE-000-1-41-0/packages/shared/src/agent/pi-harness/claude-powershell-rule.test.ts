import { describe, expect, test } from 'bun:test'

import { parseClaudeRuleString } from './claude-permission-rules.ts'
import {
  looksLikePowerShell,
  matchClaudePowerShellRule,
  splitPowerShellCommand,
} from './claude-powershell-rule.ts'
import { compilePermissionDslV1, evaluatePermissionDslV1 } from './permission-dsl.ts'

/** permissions.md § PowerShell, re-fetched raw 2026-07-29. */

const match = (pattern: string, command: string, ruleAction: 'allow' | 'deny' | 'ask' = 'allow') =>
  matchClaudePowerShellRule(pattern, command, { ruleAction })

describe('PowerShell rule matching', () => {
  test('the documented allow/deny example', () => {
    // allow: PowerShell(Get-ChildItem *), PowerShell(git commit *)
    expect(match('Get-ChildItem *', 'Get-ChildItem -Path C:\\src')).toBe('match')
    expect(match('git commit *', 'git commit -m "x"')).toBe('match')
    expect(match('Get-ChildItem *', 'Remove-Item x')).toBe('no-match')
    // deny: PowerShell(Remove-Item *)
    expect(match('Remove-Item *', 'Remove-Item x', 'deny')).toBe('match')
  })

  test('common aliases are canonicalized before matching, case-insensitively', () => {
    // "a rule written for the cmdlet name also matches its aliases, so
    // `PowerShell(Get-ChildItem *)` matches `gci`, `ls`, and `dir` as well"
    for (const alias of ['gci', 'ls', 'dir', 'GCI', 'Dir']) {
      expect(match('Get-ChildItem *', `${alias} -Force`), alias).toBe('match')
    }
    expect(match('GET-CHILDITEM *', 'gci -Force')).toBe('match')
    // The rule may itself be written with an alias.
    expect(match('gci *', 'Get-ChildItem -Force')).toBe('match')
    // curl/wget are deliberately NOT aliased to Invoke-WebRequest.
    expect(match('Invoke-WebRequest *', 'curl https://example.test')).toBe('no-match')
  })

  test('`:*` equals a trailing ` *`, and a trailing ` *` is a word boundary', () => {
    expect(match('Get-ChildItem:*', 'Get-ChildItem')).toBe('match')
    expect(match('Get-ChildItem:*', 'Get-ChildItem -Force')).toBe('match')
    expect(match('Get-Child:*', 'Get-ChildItem')).toBe('no-match')
    expect(match('Get-ChildItem', 'Get-ChildItem -Force')).toBe('no-match')
  })

  test('compound commands split on | ; && ||, and allow needs every subcommand', () => {
    expect(splitPowerShellCommand('Get-Process | Where-Object { $_.Id -gt 1 } ; gci'))
      .toEqual(['Get-Process', 'Where-Object { $_.Id -gt 1 }', 'gci'])
    expect(splitPowerShellCommand('gci && Remove-Item x')).toEqual(['gci', 'Remove-Item x'])
    expect(match('Get-ChildItem *', 'gci a | gci b')).toBe('match')
    expect(match('Get-ChildItem *', 'gci a | Remove-Item b')).toBe('no-match')
    // deny/ask match on ANY subcommand
    expect(match('Remove-Item *', 'gci a | Remove-Item b', 'deny')).toBe('match')
  })

  test('separators inside quotes, braces and a backtick escape do not split', () => {
    expect(splitPowerShellCommand("Write-Output 'a|b;c'")).toEqual(["Write-Output 'a|b;c'"])
    expect(splitPowerShellCommand('Write-Output "a|b"')).toEqual(['Write-Output "a|b"'])
    expect(splitPowerShellCommand('Get-ChildItem C:\\src')).toEqual(['Get-ChildItem C:\\src'])
    expect(splitPowerShellCommand('Write-Output `|')).toEqual(['Write-Output `|'])
    expect(splitPowerShellCommand("Write-Output 'unbalanced")).toBeNull()
    expect(splitPowerShellCommand('Get-Process | Where-Object { $_.Id -gt 1')).toBeNull()
  })

  /**
   * P2.75 — a separator inside a `#` comment tail does not separate.
   *
   * MEASURED on the parent tree (2026-08-23), each spared row carrying the
   * verdict it used to produce:
   *
   * | command | before |
   * | --- | --- |
   * | `Remove-Item ./a.txt # note \| Remove-Item /usr` | split into two; ladder `system-path` on `/usr` |
   * | `Remove-Item ./a.txt # note ; Remove-Item ~` | split into two; breaker prompt: home |
   *
   * The tokenizer in `removal-circuit-breaker.ts` already stopped at the `#`;
   * this splitter ran first and had already handed the tail on as a subcommand,
   * which is why P2.51's tokenizer fix left this residue standing.
   */
  test('a separator inside a comment tail does not split (P2.75)', () => {
    expect(splitPowerShellCommand('Remove-Item ./a.txt # note | Remove-Item /usr'))
      .toEqual(['Remove-Item ./a.txt # note | Remove-Item /usr'])
    expect(splitPowerShellCommand('Remove-Item ./a.txt # note ; Remove-Item ~'))
      .toEqual(['Remove-Item ./a.txt # note ; Remove-Item ~'])
    expect(splitPowerShellCommand('gci # note && Remove-Item /'))
      .toEqual(['gci # note && Remove-Item /'])
    // The comment ends at the NEWLINE, so a real second line is still its own
    // subcommand — the row that would go quiet if it ever ran to end-of-input.
    expect(splitPowerShellCommand('gci # note\nRemove-Item /'))
      .toEqual(['gci # note', 'Remove-Item /'])
    // Deny therefore stops firing on the commented-out half…
    expect(match('Remove-Item /usr', 'Remove-Item ./a.txt # note | Remove-Item /usr', 'deny'))
      .toBe('no-match')
    // …and the positive control on the same rig: uncomment it and it fires.
    expect(match('Remove-Item /usr', 'Remove-Item ./a.txt | Remove-Item /usr', 'deny'))
      .toBe('match')
  })

  test('the comment rule stops where PowerShell says a token does not begin', () => {
    // A `#` mid-token, and one inside either quote, is ordinary text — the same
    // rule `tokenizePowerShell` applies, and the reason `./a#b/*` still scans.
    expect(splitPowerShellCommand('Remove-Item ./a#b/* ; Remove-Item /'))
      .toEqual(['Remove-Item ./a#b/*', 'Remove-Item /'])
    expect(splitPowerShellCommand("Write-Output '# not a comment' ; Remove-Item /"))
      .toEqual(["Write-Output '# not a comment'", 'Remove-Item /'])
    expect(splitPowerShellCommand('Write-Output "# not a comment" ; Remove-Item /'))
      .toEqual(['Write-Output "# not a comment"', 'Remove-Item /'])
    // A backtick-escaped blank keeps the token open, so the `#` is mid-token.
    expect(splitPowerShellCommand('Write-Output a` #b ; Remove-Item /'))
      .toEqual(['Write-Output a` #b', 'Remove-Item /'])
    // The negatives that must not move: a genuine compound command still splits
    // and a deny still reaches its second half.
    expect(splitPowerShellCommand('gci a | Remove-Item b')).toEqual(['gci a', 'Remove-Item b'])
    expect(match('Remove-Item *', 'gci a | Remove-Item b', 'deny')).toBe('match')
  })

  /**
   * A comment may NARROW a parse, never rescue one — the same ordering
   * `splitCompoundCommand` carries, and for the same reason. Skipping a comment
   * also skips whatever was unbalanced inside it, so `Remove-Item ./a.txt # it's
   * here` went from `'unparseable'` (which the DSL enters as `ask`) to a `match`
   * for `allow PowerShell(Remove-Item *)`. An apostrophe in an English comment
   * is all it takes; the balance verdict is now taken with the comment rule off.
   */
  test('a comment cannot rescue an unparseable command', () => {
    for (const command of [
      String.raw`Remove-Item ./a.txt # it's here`,
      String.raw`gci # don't`,
      String.raw`Remove-Item ./a.txt # it's here ; Remove-Item /`,
      'gci # unclosed (',
      'gci # unclosed "',
    ]) {
      expect(splitPowerShellCommand(command), command).toBeNull()
    }
    expect(match('Remove-Item *', String.raw`Remove-Item ./a.txt # it's here`, 'allow')).toBe('unparseable')
    // The positive control: balance the quote and the comment rule works again.
    expect(splitPowerShellCommand(String.raw`Remove-Item ./a.txt # it is here ; Remove-Item /`))
      .toEqual([String.raw`Remove-Item ./a.txt # it is here ; Remove-Item /`])
  })

  test('a `<#` block comment disables the line rule for the whole command', () => {
    // No `pwsh` on this rig to measure block-comment parsing against, so the
    // guard restores the parent behaviour verbatim rather than guessing: the
    // command keeps splitting inside its comments, which only over-fires.
    expect(splitPowerShellCommand('Remove-Item ./a.txt <# note #> ; Remove-Item /'))
      .toEqual(['Remove-Item ./a.txt <# note #>', 'Remove-Item /'])
    expect(splitPowerShellCommand('Remove-Item ./a.txt <# n #> # note | Remove-Item /usr'))
      .toEqual(['Remove-Item ./a.txt <# n #> # note', 'Remove-Item /usr'])
    // …and the deny it protects still fires there.
    expect(match('Remove-Item /', 'Remove-Item ./a.txt <# note #> ; Remove-Item /', 'deny'))
      .toBe('match')
  })

  /**
   * Suppressing a split WIDENS ALLOW, because an allow rule requires EVERY
   * subcommand to match and this removes one. Disclosed here rather than left to
   * be rediscovered; the direction is correct per the language spec
   * (PowerShell-Docs `lang-spec/chapter-02.md` § 2.2.3, fetched raw 2026-08-23:
   * "hello #there is considered the token hello followed by a single-line
   * comment"), so PowerShell really does run only the first command.
   *
   * MEASURED through the DSL on the parent tree: every `PRE` below was no
   * decision at all.
   */
  test('suppressing a split widens every glob allow rule (P2.75)', () => {
    const program = (raw: string, action: 'allow' | 'deny') => {
      const parsed = parseClaudeRuleString(raw, action)
      if (!parsed.rule) throw new Error(`did not compile: ${raw}`)
      return compilePermissionDslV1({
        generation: 'ps', projectTrusted: true,
        layers: [{
          scope: 'workspace', sourceDigest: 'ps',
          document: { version: 1, rules: [{ id: 'r', action, match: parsed.rule.match }] },
        }],
      })
    }
    const decide = (raw: string, action: 'allow' | 'deny', command: string) =>
      evaluatePermissionDslV1(program(raw, action), {
        generation: 'ps', semanticId: 'bash', toolName: 'Bash', input: { command }, cwd: '/work',
      }).action

    // PRE: undefined on both. The comment is the whole reason they now allow.
    expect(decide('PowerShell(Get-ChildItem *)', 'allow', 'gci # note ; Remove-Item /')).toBe('allow')
    expect(decide('PowerShell(Remove-Item *)', 'allow', 'Remove-Item /usr # note ; gci')).toBe('allow')
    // THE CONTROLS THAT MUST NOT MOVE. Without a comment the second subcommand
    // is real and the allow rule does not cover it …
    expect(decide('PowerShell(Get-ChildItem *)', 'allow', 'gci ; Remove-Item /')).toBeUndefined()
    // … and the `<#` guard puts the command back on parent behaviour entirely.
    expect(decide('PowerShell(Get-ChildItem *)', 'allow', 'gci <# n #> # note ; Remove-Item /')).toBeUndefined()
    // A deny rule is unaffected by the widening in the dangerous direction: it
    // still reaches a real second subcommand.
    expect(decide('PowerShell(Remove-Item *)', 'deny', 'gci ; Remove-Item /')).toBe('deny')
  })

  test('only a command our PowerShell routing calls PowerShell is judged', () => {
    const program = (raw: string, action: 'allow' | 'deny') => {
      const parsed = parseClaudeRuleString(raw, action)
      if (!parsed.rule) throw new Error(`did not compile: ${raw}`)
      return compilePermissionDslV1({
        generation: 'ps', projectTrusted: true,
        layers: [{
          scope: 'workspace', sourceDigest: 'ps',
          document: { version: 1, rules: [{ id: 'r', action, match: parsed.rule.match }] },
        }],
      })
    }
    const decide = (raw: string, action: 'allow' | 'deny', command: string) =>
      evaluatePermissionDslV1(program(raw, action), {
        generation: 'ps', semanticId: 'bash', toolName: 'Bash', input: { command }, cwd: '/work',
      }).action

    expect(looksLikePowerShell('Get-ChildItem -Force')).toBe(true)
    expect(looksLikePowerShell('ls -la')).toBe(false)

    expect(decide('PowerShell(Get-ChildItem *)', 'allow', 'Get-ChildItem -Force')).toBe('allow')
    expect(decide('PowerShell(Remove-Item *)', 'deny', 'Remove-Item x')).toBe('deny')
    // A plain sh command is not PowerShell, so a PowerShell rule never grants it.
    expect(decide('PowerShell(Get-ChildItem *)', 'allow', 'ls -la')).toBeUndefined()
    // ...and never denies it either.
    expect(decide('PowerShell(Remove-Item *)', 'deny', 'rm -rf build')).toBeUndefined()
    // An unparseable PowerShell command is the documented prompt-anyway carve-out.
    expect(decide('PowerShell(Get-ChildItem *)', 'allow', "Get-ChildItem 'unbalanced")).toBe('ask')
  })

  /**
   * P2.99 / F2 — the token-start blank set is PowerShell's, not JavaScript's. JS
   * `/\s/` matches U+FEFF (the BOM), which PowerShell does NOT treat as
   * whitespace (class Cf; § 2.2.4 whitespace is Unicode Zs/Zl/Zp + tab/VT/FF). So
   * `gci a<BOM>#…` was a token-boundary-then-comment to us and one token to
   * PowerShell: the `#` suppressed a real `;` split, and because an allow rule
   * requires EVERY subcommand to match, dropping the second subcommand WIDENED
   * the rule onto `Remove-Item /`.
   *
   * Spec-derived, recorded conservatively: no `pwsh` on this rig, so the shell
   * half is the § 2.2.4 quotation in `splitPowerShellCommand`'s docstring and the
   * matcher half is measured here. The fix is `\s` minus exactly U+FEFF, so the
   * hole row and its control differ by that one character — the control is a real
   * Zs (U+2003), which PowerShell DOES treat as whitespace, so it still opens a
   * comment. Chars are `\uXXXX` escapes so the source stays visible ASCII.
   */
  test('the BOM before # cannot suppress a split (P2.99 / F2)', () => {
    const program = (raw: string, action: 'allow' | 'deny') => {
      const parsed = parseClaudeRuleString(raw, action)
      if (!parsed.rule) throw new Error(`did not compile: ${raw}`)
      return compilePermissionDslV1({
        generation: 'ps', projectTrusted: true,
        layers: [{ scope: 'workspace', sourceDigest: 'ps',
          document: { version: 1, rules: [{ id: 'r', action, match: parsed.rule.match }] } }],
      })
    }
    const decide = (raw: string, action: 'allow' | 'deny', command: string) =>
      evaluatePermissionDslV1(program(raw, action), {
        generation: 'ps', semanticId: 'bash', toolName: 'Bash', input: { command }, cwd: '/work',
      }).action

    const bom = 'gci a\uFEFF# note ; Remove-Item /'
    // PowerShell reads `a<BOM>#note` as one token, so the `;` still separates.
    expect(splitPowerShellCommand(bom)).toEqual(['gci a\uFEFF# note', 'Remove-Item /'])
    // allow no longer approves (was `allow` on the parent): the second subcommand
    // is real again and `Remove-Item /` is not Get-ChildItem.
    expect(decide('PowerShell(Get-ChildItem *)', 'allow', bom)).toBeUndefined()
    // and a deny reaches that second subcommand.
    expect(match('Remove-Item *', bom, 'deny')).toBe('match')

    // THE CONTROL, one character apart: U+2003 EM SPACE is Zs, which PowerShell
    // treats as whitespace, so `a<U+2003>#` DOES open a comment and the `;` stays
    // suppressed — one segment, allow still fires. Narrowing PS to space+tab
    // would wrongly move this; `\s` minus U+FEFF leaves it exactly here.
    const zs = 'gci a\u2003# note ; Remove-Item /'
    expect(splitPowerShellCommand(zs)).toEqual(['gci a\u2003# note ; Remove-Item /'])
    expect(decide('PowerShell(Get-ChildItem *)', 'allow', zs)).toBe('allow')
  })
})

/**
 * P2.329 — the same missing `s` flag the Bash compiler carried. Found by
 * sweeping the other pattern compilers rather than by a report of its own,
 * which is why it gets its own test rather than a line in the Bash one.
 */
describe('a `*` pattern crosses a line terminator', () => {
  // A literal line break, not the two-character escape: the escape always
  // matched, so a test written with it passes on the broken compiler.
  const LF = `
`
  const TERMINATORS: Array<[name: string, char: string]> = [
    ['LF', LF],
    ['CR', String.fromCharCode(13)],
    ['U+2028', String.fromCharCode(0x2028)],
    ['U+2029', String.fromCharCode(0x2029)],
  ]

  test('a deny is not evadable by quoting a terminator into an argument', () => {
    // Control: the deny fires on the bare command and an ordinary quoted arg.
    expect(match('Remove-Item *', 'Remove-Item C:\\tmp', 'deny')).toBe('match')
    expect(match('Remove-Item *', "Remove-Item C:\\tmp 'x'", 'deny')).toBe('match')
    for (const [name, char] of TERMINATORS) {
      expect([name, match('Remove-Item *', `Remove-Item C:\\tmp 'a${char}b'`, 'deny')])
        .toEqual([name, 'match'])
      expect([name, match('Remove-Item:*', `Remove-Item C:\\tmp 'a${char}b'`, 'deny')])
        .toEqual([name, 'match'])
    }
    // Negative control: still not a matcher that fires on everything.
    expect(match('Remove-Item *', `Get-ChildItem 'a${LF}b'`, 'deny')).toBe('no-match')
  })

  /**
   * CORRECTED BY P2.350. The first assertion used to read `'allow'` → `match`
   * on a command carrying a terminator, which is precisely the auto-approval
   * the P2.329 fix opened. The property this test exists to pin — that the flag
   * did not move the word boundary or the case-insensitivity — is unchanged and
   * is now asserted on inputs that do not smuggle a separator.
   */
  test('the boundary and case-insensitivity are unchanged by the flag', () => {
    // permissions.md#powershell — the `:*` suffix is a trailing ` *`, and the
    // comparison stays case-insensitive. Guards against a rewrite that reaches
    // for `[\s\S]` and drops a flag while doing it.
    expect(match('Get-ChildItem *', `get-childitem 'a b'`, 'allow')).toBe('match')
    expect(match('Get-Child *', `Get-ChildItem 'a b'`, 'allow')).toBe('no-match')
    // The terminator forms keep their case-insensitivity on the deny side,
    // which is where a `*` is still allowed to cross one.
    expect(match('Get-ChildItem *', `get-childitem 'a${LF}b'`, 'deny')).toBe('match')
    expect(match('Get-Child *', `Get-ChildItem 'a${LF}b'`, 'deny')).toBe('no-match')
  })
})

/**
 * P2.350 — the P2.329 fix's own regression, and it reached THIS compiler too.
 * The row named the Bash one and asked whether the allow-side hole was
 * reachable through the other two; it is, by the same shape one comment
 * character over. `splitPowerShellCommand` disables its `#` rule when the
 * command contains `<#`, so an apostrophe in a real comment swallows the line
 * ending and a two-statement script arrives as ONE segment.
 *
 * Measured at `0d7af52cd^` this fixture was `no-match` (a prompt); at
 * `461961d99` it was `match` under `allow PowerShell(Get-Content *)` while
 * `deny PowerShell(Remove-Item *)` did not fire.
 */
describe('an allow rule cannot span a line terminator (P2.350)', () => {
  const LF = `
`
  const EXPLOIT = `Get-Content x <# n #> # don't${LF}Remove-Item -Recurse ~ #'`
  const TERMINATORS: Array<[name: string, char: string]> = [
    ['LF', LF],
    ['CR', String.fromCharCode(13)],
    ['U+2028', String.fromCharCode(0x2028)],
    ['U+2029', String.fromCharCode(0x2029)],
  ]

  test('the fixture is one segment, and no rule may approve it', () => {
    expect(splitPowerShellCommand(EXPLOIT)).toEqual([EXPLOIT])
    expect(match('Get-Content *', EXPLOIT, 'allow')).toBe('no-match')
    // No floor underneath: the single segment's head is `Get-Content`.
    expect(match('Remove-Item *', EXPLOIT, 'deny')).toBe('no-match')
    // Control: the benign command the rule is for is still approved.
    expect(match('Get-Content *', 'Get-Content x', 'allow')).toBe('match')
  })

  test('the deny side is unmoved — P2.329 stays fixed here too', () => {
    for (const [name, char] of TERMINATORS) {
      expect([name, match('Remove-Item *', `Remove-Item C:\\tmp 'a${char}b'`, 'deny')])
        .toEqual([name, 'match'])
      expect([name, match('Remove-Item *', `Remove-Item C:\\tmp 'a${char}b'`, 'ask')])
        .toEqual([name, 'match'])
    }
  })

  test('an EXACT rule still matches; only a GLOB is refused', () => {
    expect(match(EXPLOIT, EXPLOIT, 'allow')).toBe('match')
    // A `:*` rule is a glob (the suffix is a trailing ` *`), so it is refused —
    // the `hasGlob` computation happens before the boundary is sliced off.
    expect(match('Get-Content:*', EXPLOIT, 'allow')).toBe('no-match')
  })
})

/**
 * P2.92 — HERE-STRINGS, settled with an oracle the row said did not exist.
 *
 * The row recorded them as unmodelled and could not diagnose them: "No
 * executable miss could be constructed — every shape tried landed on
 * `unparseable` -> prompt — and there is no `pwsh` on this rig to settle it. If
 * a `pwsh` rig ever exists here, this is the first thing to point at it."
 *
 * pwsh 7.6.5 exists on this rig now. Pointed at it, the miss is REAL and the
 * script is VALID — `[Parser]::ParseInput` (a parse, never a run) reports two
 * statements and ZERO errors for the fixture below, so it is a script the shell
 * executes, not one it refuses.
 *
 * Mechanism, and it is the sh `<<` desync exactly: the apostrophe in `don't`
 * CLOSES the span the `@'` opened, the scan splits at a newline that is inside
 * the here-string BODY, and the second segment's head becomes `'@` rather than
 * `Remove-Item`. A head-anchored deny cannot see it. The trailing `#'` restores
 * quote parity, which is why the command balances instead of falling to the
 * `'unparseable'` prompt every earlier attempt hit — that is the one ingredient
 * the row was missing.
 *
 * ## Differential, HEAD vs this tree
 *
 * 39 818 commands (35 198 harvested from the permission surface at HEAD, plus a
 * 4 620-shape here-string grid) x 150 patterns x 3 actions:
 * **zero** splits changed on the harvested half — so no real string in this repo
 * moves — and 96 on the grid, **every one a strict prefix-superset**. Zero
 * rescues (`unparseable -> parse`), zero losses. Verdicts moved in exactly two
 * cells: `deny: no-match -> match` (276) and `ask: no-match -> match` (276).
 * **No `allow` verdict moved at all**, in either direction.
 *
 * ## And checked against pwsh's own answer, not just against HEAD
 *
 * All 96 changed commands re-parsed by `[Parser]::ParseInput` and compared on
 * STATEMENT HEADS: 96/96 parse with no error; **90 had a head the splitter could
 * not see and every one is now exposed; 0 remain hidden; 0 heads the shell has
 * no statement for were introduced.** The absence claim has its positive control
 * on the same rig — the harvested half showing zero differences is only
 * meaningful because the grid half shows 96.
 */
describe('here-strings hid a statement from every deny rule (P2.92)', () => {
  const LF = String.fromCharCode(10)
  // A sandbox path, never a real home or root: nothing in this file is executed,
  // and the oracle only ever PARSED.
  const VICTIM = 'Remove-Item -Recurse -Force /private/tmp/nessy-splitter-probe/fakehome'

  test('the literal form: pwsh runs two statements, and the deny now sees both', () => {
    const command = `$x = @'${LF}don't${LF}'@${LF}${VICTIM} #'`
    // Kills: removing the here-string append from `splitPowerShellCommand`.
    expect(matchClaudePowerShellRule('Remove-Item *', command, { ruleAction: 'deny' })).toBe('match')
    expect(matchClaudePowerShellRule('Remove-Item *', command, { ruleAction: 'ask' })).toBe('match')
    // The parent's reading is still FIRST and still intact — kills a mutant that
    // REPLACES it with the here-string reading rather than appending.
    const split = splitPowerShellCommand(command)
    expect(split?.[0]).toBe(`$x = @'${LF}don't`)
    expect(split?.[1]).toBe(`'@${LF}${VICTIM} #'`)
    // …and the appended reading is pwsh's own two statements.
    expect(split?.slice(2)).toEqual([`$x = @'${LF}don't${LF}'@`, `${VICTIM} #'`])
  })

  test('the expandable form carries the identical hole', () => {
    const command = `$x = @"${LF}don"t${LF}"@${LF}${VICTIM} #"`
    expect(matchClaudePowerShellRule('Remove-Item *', command, { ruleAction: 'deny' })).toBe('match')
    expect(splitPowerShellCommand(command)?.slice(2))
      .toEqual([`$x = @"${LF}don"t${LF}"@`, `${VICTIM} #"`])
  })

  test('a here-string BODY stays data — the mirror-image defect', () => {
    // The direction that would make this a false-deny machine: a removal spelled
    // INSIDE the body is text pwsh never runs (measured: two statements, the
    // assignment and the `Write-Output`), so no deny may fire on it.
    const command = `$x = @'${LF}${VICTIM}${LF}'@${LF}Write-Output done`
    expect(matchClaudePowerShellRule('Remove-Item *', command, { ruleAction: 'deny' })).toBe('no-match')
    // Both readings agree here — a body with no apostrophe never desynced the
    // parent's quote model in the first place — so the append contributes
    // nothing and the list is exactly two segments, not four.
    expect(splitPowerShellCommand(command))
      .toEqual([`$x = @'${LF}${VICTIM}${LF}'@`, 'Write-Output done'])
  })

  /**
   * The opener and terminator rules, each row MEASURED against pwsh 7.6.5 rather
   * than inferred — and the last two are why measuring mattered, because the
   * obvious guess is wrong in both.
   */
  test('the shapes pwsh does NOT accept are not treated as here-strings', () => {
    const inert = (command: string) => splitPowerShellCommand(command)
    // "No characters are allowed after a here-string header": `@'junk` is a
    // parse error to pwsh, so it must not open one here either.
    expect(inert(`$x = @'junk${LF}b${LF}'@${LF}gci`)?.some(s => s.startsWith("@'junk") || s.includes("@'junk"))).toBe(true)
    // "White space is not allowed before the string terminator": an indented
    // `'@` does not terminate, and a mid-line one is not a terminator either
    // ("The string is missing the terminator: '@"). Neither opens a here-string
    // for this reading, so NO form is appended and the list is the parent's
    // exact two segments. Kills a mutant that terminates on a `'@` found
    // anywhere rather than at a line start.
    expect(splitPowerShellCommand(`$x = @'${LF}b${LF}  '@${LF}gci`))
      .toEqual([`$x = @'${LF}b${LF}  '@`, 'gci'])
    expect(splitPowerShellCommand(`$x = @'${LF}b '@${LF}gci`))
      .toEqual([`$x = @'${LF}b '@`, 'gci'])

    // MEASURED, AND THE OPPOSITE OF THE OBVIOUS GUESS (1): the opener does NOT
    // have to sit at a token start. pwsh gives `a@'` two statements and no
    // error, so a token-start rule — which is what this file's comment rule and
    // its sh sibling both use — would have been wrong. Kills a mutant that adds
    // an `atTokenStart` test to the here-string branch.
    const glued = `$x = a@'${LF}don't${LF}'@${LF}${VICTIM} #'`
    expect(matchClaudePowerShellRule('Remove-Item *', glued, { ruleAction: 'deny' })).toBe('match')

    // MEASURED (2): `'@'` is an ordinary single-quoted string containing `@`,
    // not an opener, because the quote opened first. Kills a mutant that tests
    // for `@` before the quote state.
    expect(splitPowerShellCommand(`$x = '@'${LF}gci`)).toEqual([`$x = '@'`, 'gci'])
  })

  test('the controls: no here-string, no change at all', () => {
    // A bare `@` in ordinary text must not arm anything — this is the row that
    // fails if the branch stops requiring a quote after the `@`.
    expect(splitPowerShellCommand('Get-Content x@y.txt ; gci')).toEqual(['Get-Content x@y.txt', 'gci'])
    expect(splitPowerShellCommand('echo a@b')).toEqual(['echo a@b'])
    // And the parent's whole comment/quote contract is untouched.
    expect(splitPowerShellCommand("Write-Output 'a|b;c'")).toEqual(["Write-Output 'a|b;c'"])
    expect(splitPowerShellCommand('gci && Remove-Item x')).toEqual(['gci', 'Remove-Item x'])
    expect(splitPowerShellCommand("Write-Output 'unbalanced")).toBeNull()
  })
})
