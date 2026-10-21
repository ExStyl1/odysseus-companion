/**
 * P2.148 — a grant that cannot be parsed must degrade to one that matches
 * NOTHING, never to a broader one; and the scanner that enforces that must not
 * mistake a QUOTED parenthesis for structure.
 *
 * Three shapes were measured widening or losing a ceiling, all through the one
 * tokenizer every tool-grant field shares:
 *
 * - `- Bash(grep -rn " # TODO" *)` is truncated by YAML at the ` #` to
 *   `Bash(grep -rn "`, and the ORIGINAL regex then ate the unbalanced paren and
 *   exploded one entry into `["Bash", "grep", "-rn"]`. A bare `Bash` is the
 *   widest grant there is — `prerequisite-manager.skillGrantAllows` returns
 *   `true` for a grant with no patterns — so one narrow grep rule silently
 *   became blanket prompt-free shell.
 * - `Bash(echo (hi))` lost its trailing `)`, so the pattern arrived one byte
 *   short of the call it names.
 * - `Bash(grep "(" *), Write, Edit` on `disallowed-tools` denied bash, write and
 *   edit before the depth scanner and denied NOTHING after it: the scanner
 *   counted the quoted `(` as structure, opened a depth the author never opened,
 *   and swallowed the two entries behind it. Measured 2026-08-25 through the
 *   real `PrerequisiteManager.checkPrerequisites`, which is why the deny arms
 *   below run through that class rather than asserting on token strings.
 *
 * A LOST DENY IS NOT A PROMPT. Measured end to end through the real
 * `runPreToolUseChecks`: with the skill deny present the gate blocks in every
 * mode including `bypassPermissions` (step 3 sits above every mode branch);
 * with it lost, `default` prompts but `auto` and `bypassPermissions` ALLOW, and
 * `acceptEdits` allows a write. That is why the deny direction is tested at the
 * enforcement class and not only at the token list.
 */
import { describe, it, expect, spyOn, beforeEach } from 'bun:test'
import { splitToolGrantList, resetToolGrantWarningMemory } from '../tool-grant-list.ts'
import { parseSkillToolEntry, parseSkillToolList } from '../../capabilities/runtime-skill-content.ts'
import { splitMarkdownFrontmatter } from '../../plugins/format-adapters/shared.ts'
import { PrerequisiteManager } from '../../agent/core/prerequisite-manager.ts'

const quiet = { warn: () => {} }

beforeEach(() => { resetToolGrantWarningMemory() })

/** The grants a skill's frontmatter field actually produces, end to end. */
function grantsFromFrontmatter(field: string, entry: string) {
  const parsed = splitMarkdownFrontmatter(
    ['---', 'name: probe', `${field}:`, `  - ${entry}`, '---', 'body'].join('\n'),
  )
  const list = parseSkillToolList(parsed.frontmatter[field]) ?? []
  return { raw: parsed.frontmatter[field], list, grants: list.map(parseSkillToolEntry) }
}

/**
 * Which of `probes` an invoked skill's `disallowed-tools` actually REMOVES.
 *
 * The real class, not a stand-in: `setSkillInvocationDeniedTools` stores
 * `parseSkillToolEntry(tool).name` and `checkPrerequisites` is what the gate
 * calls at step 3. A token list that denies nothing shows up here as an empty
 * array, which is the whole finding.
 */
function toolsDeniedBy(field: string, probes: readonly string[]): string[] {
  const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' })
  manager.setSkillInvocationDeniedTools(splitToolGrantList(field, quiet).map(t => parseSkillToolEntry(t).name))
  return probes.filter(probe => !manager.checkPrerequisites(probe, {}).allowed)
}

describe('splitToolGrantList — a truncated grant must not widen (allowed-tools)', () => {
  it('does not turn a YAML-truncated grant into a bare, blanket tool grant', () => {
    const { raw, list, grants } = grantsFromFrontmatter('allowed-tools', 'Bash(grep -rn " # TODO" *)')
    // YAML is right to truncate — ` #` opens a comment. The tokenizer is what
    // must not widen afterwards.
    expect(raw).toBe('Bash(grep -rn "')
    // One authored entry yields at most ONE entry. The explosion was the defect.
    expect(list).toHaveLength(1)
    // The load-bearing assertion: no grant here may be the bare tool `bash`,
    // which `skillGrantAllows` reads as "any argument, no prompt".
    expect(grants.map(grant => grant.name)).not.toContain('bash')
    expect(grants[0]!.name).toContain('(')
  })

  it('still parses the same grant when the argument does not open a YAML comment', () => {
    const { grants } = grantsFromFrontmatter('allowed-tools', 'Bash(grep -rn "TODO" *)')
    expect(grants).toEqual([{ name: 'bash', patterns: ['grep -rn "TODO" *'] }])
  })
})

describe('splitToolGrantList — an unterminated "(" is kept whole and is loud', () => {
  it('keeps the unbalanced paren so the downstream parser can fail closed', () => {
    // `runtime-skill-content.ts` SKILL_TOOL_ENTRY: "Anything that does not close
    // (`Bash(`) simply is not the parameterized form and falls through to the
    // bare branch, where it becomes a tool name no call can ever equal."
    expect(splitToolGrantList('Bash(', quiet)).toEqual(['Bash('])
    expect(parseSkillToolEntry('Bash(').name).toBe('bash(')
  })

  it('does not let an unterminated entry re-expose the tail as separate grants', () => {
    expect(splitToolGrantList('Read Bash( Write', quiet)).toEqual(['Read', 'Bash( Write'])
  })

  it('warns through the injected sink, naming the entry and the " #" cause', () => {
    const messages: string[] = []
    splitToolGrantList('Bash(grep -rn "', { warn: message => { messages.push(message) } })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('Bash(grep -rn')
    expect(messages[0]).toContain(' #')
    // Both field consequences, because this function cannot see which field it
    // serves and the deny half used to be recorded as "the user is asked".
    expect(messages[0]).toContain('DENIES nothing')
    expect(messages[0]).toContain('bypassPermissions')
  })

  it('defaults to console.warn, so the six readers are loud without opting in', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      splitToolGrantList('Bash(grep -rn "')
      expect(warnSpy).toHaveBeenCalledTimes(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('stays silent for a balanced grant', () => {
    const messages: string[] = []
    expect(splitToolGrantList('Bash(git diff:*), Read', { warn: m => { messages.push(m) } }))
      .toEqual(['Bash(git diff:*)', 'Read'])
    expect(messages).toEqual([])
  })
})

describe('splitToolGrantList — the warning is bounded on an uncached path', () => {
  // `loadAgentDefinitions` has no cache: it re-reads and re-parses agent files
  // per subagent dispatch, per workflow step, per skill fork and per guardian
  // consult. Unbounded, one malformed field wrote a line per dispatch, and
  // because an unterminated `(` swallows the rest of the list the line grew with
  // the field — a 10 KB field measured a 10,227-character single stderr line.
  const oversized = `Bash(${'x'.repeat(10_000)}`

  it('truncates the quoted entry and says how long the real one was', () => {
    const messages: string[] = []
    splitToolGrantList(oversized, { warn: m => { messages.push(m) } })
    expect(messages).toHaveLength(1)
    expect(messages[0]!.length).toBeLessThan(1_000)
    expect(messages[0]).toContain('(10005 chars)')
  })

  it('writes one line for a field re-parsed on every dispatch, not one per parse', () => {
    const messages: string[] = []
    for (let dispatch = 0; dispatch < 5; dispatch += 1) {
      splitToolGrantList('Bash(oops', { warn: m => { messages.push(m) } })
    }
    expect(messages).toHaveLength(1)
  })

  it('still reports a DIFFERENT malformed field — the dedupe is per message', () => {
    const messages: string[] = []
    splitToolGrantList('Bash(oops', { warn: m => { messages.push(m) } })
    splitToolGrantList('Write(other', { warn: m => { messages.push(m) } })
    expect(messages).toHaveLength(2)
  })
})

describe('splitToolGrantList — a parenthesis inside a QUOTED argument is payload', () => {
  // The one-character gap that hid this class: the suite pinned `Bash(echo ")")`
  // and never `Bash(echo "(")`.
  const quotedParenEntries: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['Bash(grep "(" *), Write, Edit', ['Bash(grep "(" *)', 'Write', 'Edit']],
    ["Bash(grep '(' *), Write, Edit", ["Bash(grep '(' *)", 'Write', 'Edit']],
    ['Bash(echo "("), Write', ['Bash(echo "(")', 'Write']],
    ["Bash(echo '('), Write", ["Bash(echo '(')", 'Write']],
    ["Bash(sed 's/(//g'), Write", ["Bash(sed 's/(//g')", 'Write']],
    ['Bash(grep "((" *), Read', ['Bash(grep "((" *)', 'Read']],
    ["Bash(echo $'('), Read", ["Bash(echo $'(')", 'Read']],
  ]
  for (const [field, expected] of quotedParenEntries) {
    it(`keeps the entries after ${JSON.stringify(field)} instead of swallowing them`, () => {
      expect(splitToolGrantList(field, quiet)).toEqual([...expected])
    })
  }

  it('still DENIES every tool the list names, measured through checkPrerequisites', () => {
    // The finding itself: this field denied bash+write+edit before the depth
    // scanner and denied nothing after it.
    expect(toolsDeniedBy('Bash(grep "(" *), Write, Edit', ['Bash', 'Write', 'Edit']))
      .toEqual(['Bash', 'Write', 'Edit'])
    expect(toolsDeniedBy("Bash(sed 's/(//g'), Write", ['Bash', 'Write'])).toEqual(['Bash', 'Write'])
    // Control on the same rig: a list with no quoted paren at all, and a list
    // that denies nothing, so the helper is proved able to answer both ways.
    expect(toolsDeniedBy('Bash(rm -rf:*, sudo:*), Write', ['Bash', 'Write'])).toEqual(['Bash', 'Write'])
    expect(toolsDeniedBy('Bash(', ['Bash', 'Write'])).toEqual([])
  })

  it('GRANTS every entry the list names, so the allow side stops losing them too', () => {
    const grants = splitToolGrantList('Bash(grep "(" *), Read, Write', quiet).map(parseSkillToolEntry)
    expect(grants).toEqual([
      { name: 'bash', patterns: ['grep "(" *'] },
      { name: 'read' },
      { name: 'write' },
    ])
  })

  it('says nothing about a quoted paren, because nothing is unterminated', () => {
    const messages: string[] = []
    splitToolGrantList('Bash(grep "(" *), Write', { warn: m => { messages.push(m) } })
    // The old diagnostic told the author to close a parenthesis that was
    // already closed, and to quote an entry that was already quoted.
    expect(messages).toEqual([])
  })

  it('keeps an apostrophe payload, as every generation of this splitter has', () => {
    // REGRESSION GUARD, true before and after — stated as such because it is
    // what the quote rule must not break, not evidence that it works. `don't`
    // is a lone quote whose paren-boundary makes the specifier bound (tested
    // below) refuse it, so this arm passes against every earlier generation too.
    expect(splitToolGrantList("Bash(echo don't), Read", quiet)).toEqual(["Bash(echo don't)", 'Read'])
    expect(toolsDeniedBy("Bash(echo don't), Read", ['Bash', 'Read'])).toEqual(['Bash', 'Read'])
  })

  it('does not let a quote pair across a specifier boundary', () => {
    // The apostrophe in `don't` must not pair with the quote two entries later.
    // An unbounded partner search collapsed this whole list into one entry, and
    // 665 of 20,000 structured differential inputs with it.
    expect(splitToolGrantList(`["Write(echo don't)", "Read(echo ')')"]`, quiet))
      .toEqual(["Write(echo don't)", "Read(echo ')')"])
  })

  it('does not let a BACKSLASH-ESCAPED quote be the partner', () => {
    // `"a\" (b"` is one quoted argument whose `(` is payload, so the entry
    // closes on its own `)` and needs no warning. Taking the escaped quote as
    // the partner instead ends the run early, leaves the `(` counted, and
    // swallows the entry after it.
    const messages: string[] = []
    expect(splitToolGrantList('Bash(echo "a\\" (b" ), Read', { warn: m => { messages.push(m) } }))
      .toEqual(['Bash(echo "a\\" (b" )', 'Read'])
    expect(messages).toEqual([])
  })

  it('treats a quote at depth 0 as YAML wrapping, so the parens inside it are structure', () => {
    // A rule that suppressed paren structure inside EVERY quote shredded this
    // flow sequence (`"Agent(a` + `b)"`) and merged the scalar below.
    expect(splitToolGrantList('"Agent(a, b)", "Read"', quiet)).toEqual(['Agent(a, b)', 'Read'])
    expect(splitToolGrantList('"Bash(git add *) Bash(git commit *)"', quiet))
      .toEqual(['Bash(git add *)', 'Bash(git commit *)'])
  })
})

describe('splitToolGrantList — nested parentheses survive the tokenizer', () => {
  it('delivers `Bash(echo (hi))` whole, which is what the downstream unit test assumes', () => {
    expect(splitToolGrantList('Bash(echo (hi))', quiet)).toEqual(['Bash(echo (hi))'])
    // Byte-identical to runtime-skill-content.test.ts's own expectation.
    expect(parseSkillToolEntry(splitToolGrantList('Bash(echo (hi))', quiet)[0]!))
      .toEqual({ name: 'bash', patterns: ['echo (hi)'] })
  })

  it('keeps a `)` that closes nothing rather than dropping it', () => {
    // The tokenizer decides only WHERE entries split; `parseSkillToolEntry`
    // anchors on the LAST `)` and owns what the pattern means.
    expect(splitToolGrantList('Bash(echo ")")', quiet)).toEqual(['Bash(echo ")")'])
    expect(parseSkillToolEntry('Bash(echo ")")')).toEqual({ name: 'bash', patterns: ['echo ")"'] })
  })
})

describe('splitToolGrantList — the deny direction', () => {
  it('delivers a well-formed parameterized deny WHOLE, so the stored name is the tool', () => {
    const { list, grants } = grantsFromFrontmatter('disallowed-tools', 'Bash(echo (hi))')
    // The token list is the assertion that moves: the original regex delivered
    // `Bash(echo (hi)` here. The name below is a POSITIVE CONTROL — it reads
    // `bash` under every generation of this tokenizer, so it is stated as the
    // invariant it is (`setSkillInvocationDeniedTools` stores the NAME only)
    // rather than counted as coverage of the fix.
    expect(list).toEqual(['Bash(echo (hi))'])
    expect(grants.map(grant => grant.name)).toEqual(['bash'])
    expect(toolsDeniedBy('Bash(echo (hi))', ['Bash', 'Read'])).toEqual(['Bash'])
  })

  it('keeps a multi-argument deny intact instead of shredding it', () => {
    expect(splitToolGrantList('Bash(rm -rf:*, sudo:*), Write', quiet))
      .toEqual(['Bash(rm -rf:*, sudo:*)', 'Write'])
  })

  it('degrades a truncated deny to a name that denies nothing, not to a blanket deny', () => {
    // The measured, accepted residue. The old explosion produced a bare `bash`
    // here, which OVER-denied every shell call the author never mentioned;
    // losing the deny is the other direction, and the cost is NOT a prompt:
    // measured through the real `runPreToolUseChecks`, a lost skill deny is a
    // prompt in `default` only, and a SILENT ALLOW in `auto` and
    // `bypassPermissions` — the modes where this deny was the last floor. It is
    // still the only trade available to a tokenizer that cannot see its field:
    // one token string cannot mean both "matches nothing" (fail-closed for a
    // grant) and "matches everything" (fail-closed for a deny), and re-emitting
    // the swallowed tail reopens F1 — `Bash(sudo bash # x)` truncates to a tail
    // whose bare word is `bash`, i.e. blanket prompt-free shell again.
    const { grants } = grantsFromFrontmatter('disallowed-tools', 'Bash(grep -rn " # TODO" *)')
    expect(grants.map(grant => grant.name)).not.toContain('bash')
    expect(toolsDeniedBy('Bash( Write', ['Bash', 'Write'])).toEqual([])
  })
})

describe('splitToolGrantList — the rules that were already there still hold', () => {
  const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['', []],
    ['Read', ['Read']],
    ['Read Write', ['Read', 'Write']],
    ['Read, Write', ['Read', 'Write']],
    // A comma inside a specifier is payload, not a delimiter.
    ['Agent(claude-security:scan-inventory, claude-security:scan-researcher)',
      ['Agent(claude-security:scan-inventory, claude-security:scan-researcher)']],
    ['Read, Agent(a, b), Workflow(scan), TaskOutput', ['Read', 'Agent(a, b)', 'Workflow(scan)', 'TaskOutput']],
    // A YAML flow sequence survives the frontmatter splitter as a raw scalar.
    ['["Read", "Agent(a, b)", "Bash(git diff:*)"]', ['Read', 'Agent(a, b)', 'Bash(git diff:*)']],
    ['Bash(git add *) Bash(git commit *)', ['Bash(git add *)', 'Bash(git commit *)']],
  ]
  for (const [input, expected] of cases) {
    it(`tokenizes ${JSON.stringify(input)}`, () => {
      expect(splitToolGrantList(input, quiet)).toEqual([...expected])
    })
  }
})
