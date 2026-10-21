import { describe, expect, test } from 'bun:test'
import { evaluateClaudeHookIfFilter, parseClaudeRuleString } from './claude-permission-rules.ts'
import { matcherMatchesWithContext } from '../../automations/utils.ts'
import { PERMISSION_RULE_TOOL_NAMES } from './harness-tool-descriptor.ts'
import { compilePermissionDslV1, evaluatePermissionDslV1 } from './permission-dsl.ts'

describe('parseClaudeRuleString', () => {
  test('Bash prefixes compile to the pattern-delegating bash matcher', () => {
    expect(parseClaudeRuleString('Bash(git *)', 'allow')).toEqual({
      rule: { action: 'allow', match: { kind: 'bash', pattern: 'git *' } },
    })
    expect(parseClaudeRuleString('Bash(npm run build)', 'allow')).toEqual({
      rule: { action: 'allow', match: { kind: 'bash', pattern: 'npm run build' } },
    })
    expect(parseClaudeRuleString('Bash', 'deny')).toEqual({
      rule: { action: 'deny', match: { kind: 'tool', semanticId: 'Bash' } },
    })
    // Bash(command:...) is bypassable via compound commands: ignored + warned.
    const ignored = parseClaudeRuleString('Bash(command:rm *)', 'deny')
    expect(ignored.rule).toBeUndefined()
    expect(ignored.warning?.code).toBe('claude_rule.param_ignored')
  })

  test('a named Bash input takes the parameter path on deny/ask, and only there', () => {
    // permissions.md:96/:102 — parameter rules work on ANY tool for deny and
    // ask; sandboxing.md:135 names this exact rule as the one to write to be
    // prompted on every unsandboxed retry.
    for (const action of ['deny', 'ask'] as const) {
      expect(parseClaudeRuleString('Bash(dangerouslyDisableSandbox:true)', action)).toEqual({
        rule: { action, match: { kind: 'parameter', name: 'dangerouslyDisableSandbox', equals: 'true' } },
      })
      expect(parseClaudeRuleString('Bash(run_in_background : true)', action)).toEqual({
        rule: { action, match: { kind: 'parameter', name: 'run_in_background', equals: 'true' } },
      })
      expect(parseClaudeRuleString('Bash(timeout:*)', action)).toEqual({
        rule: { action, match: { kind: 'parameter', name: 'timeout', matches: '*' } },
      })
    }
    // Allow rules keep the tool's own specifier syntax (permissions.md:96).
    expect(parseClaudeRuleString('Bash(dangerouslyDisableSandbox:true)', 'allow')).toEqual({
      rule: { action: 'allow', match: { kind: 'bash', pattern: 'dangerouslyDisableSandbox:true' } },
    })
    // A name that is not a Bash input stays a command pattern, so the
    // documented `:*` trailing wildcard is untouched (permissions.md:136).
    for (const action of ['allow', 'deny', 'ask'] as const) {
      expect(parseClaudeRuleString('Bash(ls:*)', action)).toEqual({
        rule: { action, match: { kind: 'bash', pattern: 'ls:*' } },
      })
      expect(parseClaudeRuleString('Bash(git commit:*)', action)).toEqual({
        rule: { action, match: { kind: 'bash', pattern: 'git commit:*' } },
      })
    }
  })

  test('the sandboxing.md ask rule reaches a decision end to end', () => {
    // sandboxing.md:135: "To be prompted on every unsandboxed retry even in
    // auto mode, add an ask rule for `Bash(dangerouslyDisableSandbox:true)`."
    // Rule string -> parser -> compiler -> evaluation, in one place, because
    // the row's damage was invisible at every single stage on its own.
    const parsed = parseClaudeRuleString('Bash(dangerouslyDisableSandbox:true)', 'ask')
    const program = compilePermissionDslV1({
      generation: 'g1',
      projectTrusted: true,
      layers: [{
        scope: 'workspace',
        sourceDigest: 'd1',
        document: { version: 1, rules: [{ id: 'ask-escape-hatch', ...parsed.rule! }] },
      }],
    })
    const evaluate = (input: Record<string, unknown>) => evaluatePermissionDslV1(program, {
      generation: 'g1', semanticId: 'bash', toolName: 'Bash', input, cwd: '/workspace',
    }).action
    expect(evaluate({ command: 'brew install x', dangerouslyDisableSandbox: true })).toBe('ask')
    expect(evaluate({ command: 'brew install x' })).toBeUndefined()
    // The old compilation: a shell-command pattern that only ever fired on a
    // command literally spelled that way, and never on the parameter.
    expect(evaluate({ command: 'dangerouslyDisableSandbox:true' })).toBeUndefined()
  })

  test('PowerShell specifier rules compile to a powershell matcher', () => {
    expect(parseClaudeRuleString('PowerShell(Remove-Item *)', 'deny')).toEqual({
      rule: { action: 'deny', match: { kind: 'powershell', pattern: 'Remove-Item *' } },
    })
    expect(parseClaudeRuleString('PowerShell(Get-ChildItem:*)', 'allow')).toEqual({
      rule: { action: 'allow', match: { kind: 'powershell', pattern: 'Get-ChildItem:*' } },
    })
    // A bare tool-name rule stays the whole-tool form.
    expect(parseClaudeRuleString('PowerShell', 'deny')).toEqual({
      rule: { action: 'deny', match: { kind: 'tool', semanticId: 'PowerShell' } },
    })
    // `command` is still the ignored parameter permissions.md:113 names.
    expect(parseClaudeRuleString('PowerShell(command:rm *)', 'deny').warning?.code)
      .toBe('claude_rule.param_ignored')
  })

  test('Read/Edit map the four anchors onto pathGlob with all path parameters', () => {
    expect(parseClaudeRuleString('Edit(src/**)', 'allow')).toEqual({
      rule: { action: 'allow', match: { kind: 'pathGlob', pattern: 'src/**', anchor: 'relative' } },
    })
    expect(parseClaudeRuleString('Read(//etc/secrets/**)', 'deny')).toEqual({
      rule: { action: 'deny', match: { kind: 'pathGlob', pattern: 'etc/secrets/**', anchor: 'absolute' } },
    })
    expect(parseClaudeRuleString('Read(~/Documents/*.pdf)', 'deny')).toEqual({
      rule: { action: 'deny', match: { kind: 'pathGlob', pattern: 'Documents/*.pdf', anchor: 'home' } },
    })
    expect(parseClaudeRuleString('Edit(/src/**/*.ts)', 'ask')).toEqual({
      rule: { action: 'ask', match: { kind: 'pathGlob', pattern: 'src/**/*.ts', anchor: 'source' } },
    })
    expect(parseClaudeRuleString('Read(./deep/.env)', 'deny')).toEqual({
      rule: { action: 'deny', match: { kind: 'pathGlob', pattern: 'deep/.env', anchor: 'relative' } },
    })
    // A Read deny also blocks Edit targets: parameter stays unset so the
    // matcher covers every PATH_PARAMETER (file_path, notebook_path, ...).
    expect(parseClaudeRuleString('Read(.env)', 'deny').rule?.match.parameter).toBeUndefined()
    // file_path is matched by the tools' own canonicalizing checks.
    expect(parseClaudeRuleString('Read(file_path:x)', 'deny').warning?.code).toBe('claude_rule.param_ignored')
    expect(parseClaudeRuleString('Edit(file_path:x)', 'ask').warning?.code).toBe('claude_rule.param_ignored')
  })

  /**
   * P3.214 — the two directions of the Read↔Edit binding, driven through the
   * compiler rather than asserted on the parsed shape.
   *
   * `permissions.md#read-and-edit` states the coupling for DENY only ("A `Read`
   * deny rule also blocks the Edit and Write tools on the same path") while the
   * sentence above it applies Read rules to the READING tools in both
   * directions ("all built-in tools that read files like Grep and Glob"). We
   * used to be symmetric, which shipped an undocumented GRANT.
   */
  test('P3.214 — a Read ALLOW reaches the reading tools and not the writing ones', () => {
    const parsed = parseClaudeRuleString('Read(vault/**)', 'allow')
    expect(parsed.rule?.match.excludeTools).toEqual(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
    const program = compilePermissionDslV1({
      generation: 'g1',
      projectTrusted: true,
      layers: [{
        scope: 'workspace',
        sourceDigest: 'd1',
        document: { version: 1, rules: [{ id: 'read-allow', ...parsed.rule! }] },
      }],
    })
    const evaluate = (toolName: string, input: Record<string, unknown>) => evaluatePermissionDslV1(program, {
      generation: 'g1', semanticId: toolName.toLowerCase(), toolName, input, cwd: '/workspace',
    }).action

    // Documented, and still granted: the Read tool itself, plus Grep and Glob
    // through their own `path` parameter.
    expect(evaluate('Read', { file_path: '/workspace/vault/a.txt' })).toBe('allow')
    expect(evaluate('Grep', { path: '/workspace/vault/a.txt' })).toBe('allow')
    expect(evaluate('Glob', { path: '/workspace/vault' })).toBe('allow')

    // Undocumented, and no longer granted. `file_path` is the SAME parameter
    // the Read arm matched on, so this pair is what proves the exclusion is
    // keyed on the tool and not on the parameter.
    expect(evaluate('Edit', { file_path: '/workspace/vault/a.txt' })).toBeUndefined()
    expect(evaluate('Write', { file_path: '/workspace/vault/a.txt' })).toBeUndefined()
    expect(evaluate('MultiEdit', { file_path: '/workspace/vault/a.txt' })).toBeUndefined()
    expect(evaluate('NotebookEdit', { notebook_path: '/workspace/vault/a.ipynb' })).toBeUndefined()
  })

  test('P3.214 — a Read DENY still covers Edit, Write and our extra NotebookEdit', () => {
    const parsed = parseClaudeRuleString('Read(vault/**)', 'deny')
    // No exclusion at all on the deny side: the widening was allow-only.
    expect(parsed.rule?.match.excludeTools).toBeUndefined()
    const program = compilePermissionDslV1({
      generation: 'g1',
      projectTrusted: true,
      layers: [{
        scope: 'workspace',
        sourceDigest: 'd1',
        document: { version: 1, rules: [{ id: 'read-deny', ...parsed.rule! }] },
      }],
    })
    const evaluate = (toolName: string, input: Record<string, unknown>) => evaluatePermissionDslV1(program, {
      generation: 'g1', semanticId: toolName.toLowerCase(), toolName, input, cwd: '/workspace',
    }).action
    expect(evaluate('Read', { file_path: '/workspace/vault/a.txt' })).toBe('deny')
    expect(evaluate('Edit', { file_path: '/workspace/vault/a.txt' })).toBe('deny')
    expect(evaluate('Write', { file_path: '/workspace/vault/a.txt' })).toBe('deny')
    // The stated posture: the page says "NotebookEdit isn't covered", we are
    // stricter, and the reason lives in `READ_ALLOW_EXCLUDED_TOOLS`'s docblock.
    expect(evaluate('NotebookEdit', { notebook_path: '/workspace/vault/a.ipynb' })).toBe('deny')
    // The negative control on the same program: a path the rule does not name.
    expect(evaluate('Edit', { file_path: '/workspace/src/a.ts' })).toBeUndefined()
  })

  test('P3.214 — an Edit rule is untouched in both directions', () => {
    expect(parseClaudeRuleString('Edit(src/**)', 'allow').rule?.match.excludeTools).toBeUndefined()
    expect(parseClaudeRuleString('Edit(src/**)', 'deny').rule?.match.excludeTools).toBeUndefined()
  })

  test('Write/NotebookEdit/Glob path rules are accepted but inert with the startup warning', () => {
    const write = parseClaudeRuleString('Write(docs/**)', 'deny')
    expect(write.rule).toBeUndefined()
    expect(write.warning?.code).toBe('claude_rule.unmatched_form')
    expect(write.warning?.message).toContain('is not matched by file permission checks')
    expect(write.warning?.message).toContain('Use Edit(docs/**) instead')
    const glob = parseClaudeRuleString('Glob(**/*.ts)', 'allow')
    expect(glob.warning?.code).toBe('claude_rule.unmatched_form')
    expect(glob.warning?.message).toContain('Use Read(**/*.ts) instead')
    expect(parseClaudeRuleString('NotebookEdit(nb/**)', 'ask').warning?.code).toBe('claude_rule.unmatched_form')
    // A tool-name rule with no path isn't affected (permissions.md).
    expect(parseClaudeRuleString('Write', 'deny')).toEqual({
      rule: { action: 'deny', match: { kind: 'tool', semanticId: 'Write' } },
    })
  })

  test('P6.211 — a Bash allow rule whose * precedes the subcommand warns and still matches', () => {
    // `errors.md#has-a-wildcard-before-the-rest-of-the-command` names both
    // examples: "such as `Bash(git * main)` or `Bash(git -C * status *)`".
    const inserted = parseClaudeRuleString('Bash(git -C * status *)', 'allow')
    expect(inserted.warning?.code).toBe('claude_rule.wildcard_before_subcommand')
    expect(inserted.warning?.message).toContain('has a wildcard before the rest of the command')
    expect(inserted.warning?.message).toContain('For git, options such as -c and --exec-path')
    expect(inserted.warning?.message).toContain('(for example Bash(git status *))')
    // The page: "Claude Code keeps the rule and changes nothing about how it
    // matches" — so the warning rides BESIDE a live rule, the shape
    // `claude_rule.unknown_tool` already uses.
    expect(inserted.rule).toEqual({ action: 'allow', match: { kind: 'bash', pattern: 'git -C * status *' } })
    expect(parseClaudeRuleString('Bash(git * main)', 'allow').warning?.code)
      .toBe('claude_rule.wildcard_before_subcommand')
    // A non-git program keeps the generic sentence and loses git's own.
    const docker = parseClaudeRuleString('Bash(docker * run)', 'allow')
    expect(docker.warning?.code).toBe('claude_rule.wildcard_before_subcommand')
    expect(docker.warning?.message).not.toContain('--exec-path')
    expect(docker.warning?.message).toContain('(for example Bash(docker run *))')
  })

  test('P6.211 — the controls: every form the page excludes stays silent', () => {
    // "rules whose subcommand comes before the first `*`, such as
    // `Bash(git commit *)`" — this is the row's named control.
    expect(parseClaudeRuleString('Bash(git commit *)', 'allow').warning).toBeUndefined()
    // "rules in which no word other than an option follows the `*`, such as
    // `Bash(git *)`" — and `Bash(* --help *)`, which permissions.md uses.
    expect(parseClaudeRuleString('Bash(git *)', 'allow').warning).toBeUndefined()
    expect(parseClaudeRuleString('Bash(* --help *)', 'allow').warning).toBeUndefined()
    expect(parseClaudeRuleString('Bash(*)', 'allow').warning).toBeUndefined()
    // "`:*` prefix rules such as `Bash(git:*)`".
    expect(parseClaudeRuleString('Bash(git:*)', 'allow').warning).toBeUndefined()
    // A `*` inside a later argument is behind the subcommand.
    expect(parseClaudeRuleString("Bash(git commit -m '* fix')", 'allow').warning).toBeUndefined()
    // No wildcard at all.
    expect(parseClaudeRuleString('Bash(git status)', 'allow').warning).toBeUndefined()
    // "Claude Code doesn't warn about deny and ask rules with the same shape".
    expect(parseClaudeRuleString('Bash(git -C * status *)', 'deny').warning).toBeUndefined()
    expect(parseClaudeRuleString('Bash(git * main)', 'ask').warning).toBeUndefined()
  })

  test('WebFetch domain rules normalize case and trailing dots onto the host matcher', () => {
    expect(parseClaudeRuleString('WebFetch(domain:Example.COM.)', 'allow')).toEqual({
      rule: { action: 'allow', match: { kind: 'host', host: 'example.com' } },
    })
    expect(parseClaudeRuleString('WebFetch(domain:*.example.com)', 'deny')).toEqual({
      rule: { action: 'deny', match: { kind: 'host', host: '*.example.com' } },
    })
    expect(parseClaudeRuleString('WebFetch(url:https://example.com)', 'deny').warning?.code).toBe('claude_rule.param_ignored')
    expect(parseClaudeRuleString('WebFetch', 'ask')).toEqual({
      rule: { action: 'ask', match: { kind: 'tool', semanticId: 'WebFetch' } },
    })
  })

  test('mcp rules keep the allow-side anchoring asymmetry', () => {
    expect(parseClaudeRuleString('mcp__github', 'allow')).toEqual({
      rule: { action: 'allow', match: { kind: 'mcp', server: 'github' } },
    })
    expect(parseClaudeRuleString('mcp__github__get_issue', 'deny')).toEqual({
      rule: { action: 'deny', match: { kind: 'mcp', server: 'github', tool: 'get_issue' } },
    })
    // Allow globs only after a literal glob-free mcp__<server>__ prefix.
    expect(parseClaudeRuleString('mcp__puppeteer__*', 'allow')).toEqual({
      rule: { action: 'allow', match: { kind: 'mcp', server: 'puppeteer', tool: '*' } },
    })
    expect(parseClaudeRuleString('mcp__github__get_*', 'allow')).toEqual({
      rule: { action: 'allow', match: { kind: 'mcp', server: 'github', tool: 'get_*' } },
    })
    for (const unanchored of ['*', 'B*', 'mcp__*', 'mcp__git*__x']) {
      const parsed = parseClaudeRuleString(unanchored, 'allow')
      expect(parsed.rule, unanchored).toBeUndefined()
      expect(parsed.warning?.code, unanchored).toBe('claude_rule.unanchored_allow_glob')
    }
    // Deny/ask accept any glob shape.
    expect(parseClaudeRuleString('mcp__*', 'deny')).toEqual({
      rule: { action: 'deny', match: { kind: 'mcp', server: '*' } },
    })
    expect(parseClaudeRuleString('*', 'deny')).toEqual({
      rule: { action: 'deny', match: { kind: 'tool', semanticId: '*' } },
    })
    expect(parseClaudeRuleString('B*', 'ask')).toEqual({
      rule: { action: 'ask', match: { kind: 'tool', semanticId: 'B*' } },
    })
  })

  test('Agent rules match by name, and param-shaped specifiers win on any tool', () => {
    expect(parseClaudeRuleString('Agent(reviewer)', 'ask')).toEqual({
      rule: { action: 'ask', match: { kind: 'agent', agent: 'reviewer' } },
    })
    expect(parseClaudeRuleString('Agent(Code Reviewer)', 'deny')).toEqual({
      rule: { action: 'deny', match: { kind: 'agent', agent: 'Code Reviewer' } },
    })
    // permissions.md: Agent(isolation:*) matches any explicit isolation value.
    expect(parseClaudeRuleString('Agent(isolation:*)', 'deny')).toEqual({
      rule: { action: 'deny', match: { kind: 'parameter', name: 'isolation', matches: '*' } },
    })
    expect(parseClaudeRuleString('Agent(model:sonnet)', 'ask')).toEqual({
      rule: { action: 'ask', match: { kind: 'parameter', name: 'model', equals: 'sonnet' } },
    })
  })

  test('Tool(param:value) rules are deny/ask only, one param, whitespace-tolerant', () => {
    expect(parseClaudeRuleString('Agent(model : sonnet)', 'deny')).toEqual({
      rule: { action: 'deny', match: { kind: 'parameter', name: 'model', equals: 'sonnet' } },
    })
    const allowParam = parseClaudeRuleString('Agent(isolation:*)', 'allow')
    expect(allowParam.rule).toBeUndefined()
    expect(allowParam.warning?.code).toBe('claude_rule.param_allow_inert')
    expect(parseClaudeRuleString('Foo(bar:baz)', 'deny')).toEqual({
      rule: { action: 'deny', match: { kind: 'parameter', name: 'bar', equals: 'baz' } },
    })
    expect(parseClaudeRuleString('Foo(bar:b*z)', 'ask')).toEqual({
      rule: { action: 'ask', match: { kind: 'parameter', name: 'bar', matches: 'b*z' } },
    })
  })

  test('bare-name deny/ask rules warn on unknown tools and tag EndConversation', () => {
    expect(parseClaudeRuleString('TaskStop', 'deny', { knownToolNames: ['TaskStop', 'Bash'] })).toEqual({
      rule: { action: 'deny', match: { kind: 'tool', semanticId: 'TaskStop' } },
    })
    const unknown = parseClaudeRuleString('StopTask', 'deny', { knownToolNames: ['TaskStop'] })
    expect(unknown.rule).toEqual({ action: 'deny', match: { kind: 'tool', semanticId: 'StopTask' } })
    expect(unknown.warning?.code).toBe('claude_rule.unknown_tool')
    // Names containing _ or * are exempt from the unknown-tool check.
    expect(parseClaudeRuleString('some_tool', 'deny', { knownToolNames: ['TaskStop'] }).warning).toBeUndefined()
    // Allow rules never get the unknown-tool warning.
    expect(parseClaudeRuleString('StopTask', 'allow', { knownToolNames: ['TaskStop'] }).warning).toBeUndefined()
    // EndConversation: the parser tags; the CONSUMER enforces "while any
    // other tool remains" (deferred to the gate — see the plan's follow-ups).
    for (const action of ['deny', 'ask'] as const) {
      const tagged = parseClaudeRuleString('EndConversation', action)
      expect(tagged.rule).toEqual({ action, match: { kind: 'tool', semanticId: 'EndConversation' } })
      expect(tagged.warning?.code).toBe('claude_rule.end_conversation_guarded')
    }
  })

  test('the supplied tool inventory covers the names a tool rule can match', () => {
    // The unknown-tool warning is only as good as the list behind it, and the
    // list is what production never passed. `permission-dsl.ts` matches a
    // `kind: 'tool'` rule against BOTH the request's `semanticId` and its
    // `toolName`, so both spellings have to be present or a valid rule is
    // reported as a typo.
    expect(PERMISSION_RULE_TOOL_NAMES).toContain('Bash')
    expect(PERMISSION_RULE_TOOL_NAMES).toContain('bash')
    expect(PERMISSION_RULE_TOOL_NAMES).toContain('NotebookEdit')
    expect(PERMISSION_RULE_TOOL_NAMES).toContain('EnterWorktree')
    const named = (raw: string) =>
      parseClaudeRuleString(raw, 'deny', { knownToolNames: PERMISSION_RULE_TOOL_NAMES })
    for (const raw of ['Bash', 'Read', 'Edit', 'Write', 'WebFetch', 'Monitor', 'SendUserFile', 'TaskStop']) {
      expect(named(raw).warning).toBeUndefined()
    }
    // F1.1083 — Claude's `Glob` is a known name since F1.1111 made it bind Pi's `find` (PI_BUILTIN_CLAUDE_RULE_NAMES),
    // so it no longer warns; a name that binds nothing still does.
    expect(named('Glob').warning).toBeUndefined()
    expect(named('Baash').warning?.code).toBe('claude_rule.unknown_tool')
    // Same seam as Glob/Find above, with the OPPOSITE verdict: `stopTask` was
    // never a documented spelling — it was the same tool under Pi's wire name
    // until the binding's permissionName moved to the documented `TaskStop`
    // (permissions.md:158). A legacy `deny stopTask` now warns because the
    // spelling left PERMISSION_RULE_TOOL_NAMES, which is the startup warning
    // doing its job; `stop_task` still resolves via the binding's descriptorId
    // (and is `_`-exempt from the unknown-tool check anyway).
    expect(PERMISSION_RULE_TOOL_NAMES).toContain('TaskStop')
    expect(PERMISSION_RULE_TOOL_NAMES).not.toContain('stopTask')
    expect(named('stopTask').warning?.code).toBe('claude_rule.unknown_tool')
    expect(named('stop_task').warning).toBeUndefined()
  })

  test('Cd rules compile to a whole-path cdPath matcher, with the four anchors', () => {
    expect(parseClaudeRuleString('Cd(//tmp/**)', 'allow')).toEqual({
      rule: { action: 'allow', match: { kind: 'cdPath', pattern: 'tmp/**', anchor: 'absolute' } },
    })
    expect(parseClaudeRuleString('Cd(~/code/*)', 'deny')).toEqual({
      rule: { action: 'deny', match: { kind: 'cdPath', pattern: 'code/*', anchor: 'home' } },
    })
    expect(parseClaudeRuleString('Cd(/vendor)', 'deny')).toEqual({
      rule: { action: 'deny', match: { kind: 'cdPath', pattern: 'vendor', anchor: 'source' } },
    })
    expect(parseClaudeRuleString('Cd(**/node_modules)', 'deny')).toEqual({
      rule: { action: 'deny', match: { kind: 'cdPath', pattern: '**/node_modules', anchor: 'relative' } },
    })
    // A bare `Cd` deny rule "disables `/cd` entirely" — the whole-tool form.
    expect(parseClaudeRuleString('Cd', 'deny').rule)
      .toEqual({ action: 'deny', match: { kind: 'tool', semanticId: 'Cd' } })
    expect(parseClaudeRuleString('Cd()', 'deny').warning?.code).toBe('claude_rule.invalid')
  })

  test('garbage and empty specifiers are inert with an invalid warning', () => {
    for (const raw of ['???', '', 'Tool(unclosed', 'Read()', 'Read(~)', '(x)', 'Bash()']) {
      const parsed = parseClaudeRuleString(raw, 'deny')
      expect(parsed.rule, raw).toBeUndefined()
      expect(parsed.warning?.code, raw).toBe('claude_rule.invalid')
    }
  })
})

/**
 * P6.299 — hook MATCHER semantics, measured on the two arms this tree owns.
 *
 * ## G23, the separator question, and the row's premise was stale
 *
 * The row records *"the separator rule itself was NOT located"*. It IS located
 * at HEAD: `matchesClaudeMatcher` in `automations/utils.ts` splits on
 * `/[|,]/`. What the row could not see is that it is reached only by a matcher
 * carrying `matchMode: 'claude'`, which two readers set: `pluginHookMatcher` in
 * `capabilities/runtime-automations.ts`, and `adaptClaudeHookGroups` in
 * `automations/hooks-config.ts` for a group in Claude's settings shape (F1.898 —
 * the Claude import, or a hooks file written so). Our `actions` shape stays a regex.
 *
 * So the answer to *"does `Edit,Write` match what `Edit|Write` matches"* is
 * **yes on the imported arm and no on the native one**, and the divergence is
 * not per-runtime — it is per-matcher, inside one host function, keyed on a
 * field nothing a person writes ever sets. It is named here rather than
 * repaired: `AutomationMatcher.matchMode`'s own docblock records that flipping
 * the default would silently re-scope every stored automation.
 *
 * ## G20, the `if` filter
 *
 * `hooks.md` makes it best-effort — the posture is quoted at
 * `claude-bash-rule.ts` — so `evaluateClaudeHookIfFilter` runs the hook when
 * the rule will not compile, and says so through `unparseableRule`.
 */
describe('hook matcher separators — the two arms differ, and the field that decides is opt-in', () => {
  const matches = (matcher: string, tool: string, claudeMode: boolean): boolean =>
    matcherMatchesWithContext(
      { name: 'probe', actions: [], matcher, ...(claudeMode ? { matchMode: 'claude' as const } : {}) },
      'PreToolUse',
      { matchValue: tool, payload: {} },
    )

  test('IMPORTED arm — `Edit,Write` and `Edit|Write` match exactly the same tools', () => {
    for (const matcher of ['Edit,Write', 'Edit|Write', 'Edit, Write']) {
      expect({ matcher, Edit: matches(matcher, 'Edit', true) }).toEqual({ matcher, Edit: true })
      expect({ matcher, Write: matches(matcher, 'Write', true) }).toEqual({ matcher, Write: true })
      // The exact-name comparison also refuses the prefix over-match a regex
      // would take.
      expect({ matcher, EditFile: matches(matcher, 'EditFile', true) }).toEqual({ matcher, EditFile: false })
    }
    expect(matches('*', 'Bash', true)).toBe(true)
  })

  test('NATIVE arm — they DIVERGE, in both directions, and neither is an error', () => {
    // A comma list is a literal regex that matches no single tool name, so a
    // native automation written with the documented separator never fires.
    expect(matches('Edit,Write', 'Edit', false)).toBe(false)
    expect(matches('Edit,Write', 'Write', false)).toBe(false)
    // The pipe works — and over-matches, because the regex is unanchored.
    expect(matches('Edit|Write', 'Edit', false)).toBe(true)
    expect(matches('Edit|Write', 'EditFile', false)).toBe(true)
    // And the documented match-everything spelling is an invalid regex here, so
    // it matches NOTHING. (An omitted matcher is what means "match all" on this
    // arm — `matchesBasePredicate` returns true before any regex is built.)
    expect(matches('*', 'Bash', false)).toBe(false)
  })
})

describe('the hook `if` filter fails FULLY OPEN, and reports that it did', () => {
  const call = { toolName: 'Bash', toolInput: { command: 'ls' }, cwd: '/work/repo' }

  test('a rule that will not compile runs the hook and flags itself', () => {
    // Not a silent pass: `unparseableRule` is what `hooks-automation.ts` turns
    // into an operator-visible `hookErrors` entry (P2.277).
    const broken = evaluateClaudeHookIfFilter('Bash(', call)
    expect(broken).toEqual({ run: true, unparseableRule: true })
  })

  test('CONTROL — a rule that compiles decides, in both directions, with no flag', () => {
    expect(evaluateClaudeHookIfFilter('Bash(ls *)', call)).toEqual({ run: true, unparseableRule: false })
    expect(evaluateClaudeHookIfFilter('Bash(npm *)', call)).toEqual({ run: false, unparseableRule: false })
  })
})
