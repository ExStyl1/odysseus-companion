/**
 * Claude permission-rule-string parser (R1).
 *
 * Compiles one documented rule string — `Tool`, `Tool(specifier)`,
 * `mcp__server__tool`, `WebFetch(domain:…)`, `Agent(Name)`,
 * `Tool(param:value)` — into a `PermissionDslRuleV1`-shaped rule, or into a
 * structured warning for the documented inert forms. Contract:
 * `code.claude.com/docs/en/permissions.md` (re-fetched 2026-07-26), distilled
 * in `docs/superpowers/specs/2026-07-26-r-queue-doc-verification.md` § R1.
 *
 * The parser NEVER throws and never enforces: an inert result is
 * `{ warning }` with no rule, and consumers pick their own posture — the
 * managed-policy loader fails closed (an admin rule that silently does
 * nothing is worse than a crash), the hook `if` filter fails open per its
 * own documented contract.
 */

import {
  bashPatternWildcardBeforeSubcommand,
  matchClaudeBashIfRule,
} from './claude-bash-rule.ts'
import {
  compilePermissionDslV1,
  evaluatePermissionDslV1,
  type PathGlobAnchor,
  type PermissionDslRuleV1,
} from './permission-dsl.ts'

export type ClaudeRuleAction = 'allow' | 'ask' | 'deny'

export interface ParsedClaudeRule {
  /** Undefined when the rule is inert (accepted but never matched). */
  rule?: Omit<PermissionDslRuleV1, 'id'>
  /** Inert forms, skipped globs, unknown tools, deferred surfaces. */
  warning?: { code: string; message: string }
}

export interface ParseClaudeRuleOptions {
  /**
   * Canonical tool names for the documented deny/ask startup warning
   * ("A deny or ask rule whose tool name matches no known tool produces a
   * startup warning to catch typos"). Names containing `_` or `*` are exempt.
   */
  knownToolNames?: readonly string[]
}

/** `ToolName` or `ToolName(specifier)`; globs (deny/ask) and `-` (mcp.md, F1.367). */
const RULE_SHAPE = /^([A-Za-z*][A-Za-z0-9_*-]*)(?:\((.*)\))?$/s
/** `param:value` with whitespace around the colon ignored. */
const PARAM_SPECIFIER = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/s

/**
 * Per-tool parameters the tool already matches with its own canonicalizing
 * checks (permissions.md): a rule like `Bash(command:rm *)` would be
 * bypassable by a compound command, so it is ignored with a startup warning.
 */
const IGNORED_PARAMS: Readonly<Record<string, readonly string[]>> = {
  Bash: ['command'],
  PowerShell: ['command'],
  Read: ['file_path'],
  Edit: ['file_path'],
  Write: ['file_path'],
  Grep: ['path'],
  Glob: ['path'],
  NotebookEdit: ['notebook_path'],
  WebFetch: ['url'],
}

/**
 * Bash's own top-level input fields, the only names a `Bash(name:value)`
 * specifier may take the PARAMETER path with.
 *
 * The set has to be closed, because for Bash the same syntax also spells a
 * trailing wildcard: permissions.md:136 makes `Bash(ls:*)` equal to
 * `Bash(ls *)`, so an open reading would turn every `:*` prefix rule into a
 * parameter rule on a field no Bash call has. Each name below is documented as
 * a Bash input — `run_in_background` (permissions.md:102, tools-reference.md:160),
 * `timeout` (tools-reference.md:155), and `dangerouslyDisableSandbox`
 * (sandboxing.md:135, which names `Bash(dangerouslyDisableSandbox:true)` as the
 * ask rule to write). `command` is not here: it is in IGNORED_PARAMS, where
 * permissions.md:113 puts it.
 */
const BASH_INPUT_PARAMS: ReadonlySet<string> = new Set([
  'run_in_background', 'timeout', 'dangerouslyDisableSandbox',
])

/** Accepted-but-inert path-rule spellings (only Edit/Read are matched). */
const UNMATCHED_PATH_FORMS: Readonly<Record<string, string>> = {
  Write: 'Edit',
  NotebookEdit: 'Edit',
  Glob: 'Read',
}

/**
 * **P3.214 — the tools a `Read` ALLOW rule must not grant, and the one deny we
 * keep that the page declines to make.**
 *
 * `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`, row P3.214,
 * decided by the owner on 2026-09-02 (§A2, option (c) — "split").
 *
 * ## The page states the coupling for DENY only
 *
 * `permissions.md#read-and-edit`, verbatim: *"A `Read` deny rule also blocks
 * the Edit and Write tools on the same path, including creating a new file
 * there. NotebookEdit isn't covered, so add an `Edit` deny rule for paths no
 * tool may change."* One sentence earlier, and this one is not action-scoped:
 * *"Claude makes a best-effort attempt to apply `Read` rules to all built-in
 * tools that read files like Grep and Glob."*
 *
 * So the documented shape is asymmetric on purpose: a Read rule reaches the
 * READING tools in both directions, and reaches the WRITING tools in the deny
 * direction only. We shipped it symmetric, which meant an `allow` on a path
 * also handed out Edit and Write there — an undocumented GRANT, the loose
 * direction, and this fork's recurring defect class. Read-don't-invent deletes
 * it: these four names are excluded from a `Read` allow and from nothing else.
 *
 * `MultiEdit` is on the list although it is the legacy spelling the same page
 * calls legacy — it costs one string, and a grant that comes back through a
 * deprecated alias is exactly the shape nobody re-checks.
 *
 * ## The deny half is KEPT, and it is a posture rather than a reading
 *
 * Our `Read` deny covers `notebook_path` too, so it blocks `NotebookEdit` where
 * the page explicitly says *"NotebookEdit isn't covered"*. That is STRICTER
 * than the contract, on a rule whose whole purpose is to fence credentials, and
 * closing it would mean deleting a deny from a credential path to match a page
 * that declines to cover the case. It stays, deliberately, and this paragraph
 * is where it is written down — the owner's condition for keeping it — rather
 * than living unexplained in a compiler.
 *
 * The residue that keeps this honest: an author who writes a `Read` deny on
 * this fork gets a slightly wider deny than the page promises. Wider is the
 * safe direction, it is announced here, and `NotebookEdit(path)` itself remains
 * an inert-with-warning spelling ({@link UNMATCHED_PATH_FORMS}) exactly as the
 * page says it is.
 */
const READ_ALLOW_EXCLUDED_TOOLS: readonly string[] = Object.freeze([
  'Edit', 'Write', 'NotebookEdit', 'MultiEdit',
])

function inert(code: string, message: string): ParsedClaudeRule {
  return { warning: { code, message } }
}

/**
 * The documented startup warning for a Bash ALLOW rule whose `*` precedes the
 * subcommand — `errors.md#has-a-wildcard-before-the-rest-of-the-command`.
 *
 * It rides the SAME sink as `claude_rule.unmatched_form` and, unlike every
 * other warning here, it comes WITH a rule: the page is explicit that *"Claude
 * Code keeps the rule and changes nothing about how it matches; the warning
 * names the rule and its source in parentheses"*. `claude_rule.unknown_tool` is
 * the existing precedent for a warning beside a live rule, so no consumer
 * learns a new shape — and the consumers that read `warning` only when there is
 * no rule (`plugins/schema.ts`'s hook-`if` diagnostic) see nothing new at all.
 *
 * Deny and ask are excluded by the page in the same paragraph: *"Claude Code
 * doesn't warn about deny and ask rules with the same shape: it refuses or
 * prompts for the extra commands they match rather than approving them."*
 *
 * The git sentence is the page's and is emitted only for git, because it names
 * git's own options; inventing an equivalent for another program is exactly the
 * step this fork's read-don't-invent rule forbids. The remedy example is built
 * from the rule's own two words and is dropped when either still carries a `*`,
 * where a rewritten example would not be a valid narrowing.
 */
function withWildcardBeforeSubcommandWarning(
  parsed: ParsedClaudeRule,
  raw: string,
  pattern: string,
  action: ClaudeRuleAction,
): ParsedClaudeRule {
  if (action !== 'allow') return parsed
  const position = bashPatternWildcardBeforeSubcommand(pattern)
  if (!position) return parsed
  const gitNote = position.program === 'git'
    ? ' For git, options such as -c and --exec-path can run arbitrary commands.'
    : ''
  const example = position.program.includes('*') || position.subcommand.includes('*')
    ? ''
    : ` (for example Bash(${position.program} ${position.subcommand} *))`
  parsed.warning = {
    code: 'claude_rule.wildcard_before_subcommand',
    message: `Permission ${action} rule "${raw}" has a wildcard before the rest of the command,`
      + ' so it also matches any options inserted at that position and approves them without a'
      + ` prompt.${gitNote} Replace that * with the exact value you mean, or only use * after the`
      + ` subcommand${example}.`,
  }
  return parsed
}

function invalid(raw: string): ParsedClaudeRule {
  return inert('claude_rule.invalid', `Permission rule "${raw}" is not a recognized rule form.`)
}

function splitPathAnchor(specifier: string): { anchor: PathGlobAnchor; pattern: string } | null {
  let anchor: PathGlobAnchor
  let pattern: string
  if (specifier.startsWith('//')) {
    anchor = 'absolute'
    pattern = specifier.replace(/^\/+/, '')
  } else if (specifier === '~' || specifier.startsWith('~/')) {
    anchor = 'home'
    pattern = specifier.slice(2)
  } else if (specifier.startsWith('/')) {
    anchor = 'source'
    pattern = specifier.slice(1)
  } else {
    anchor = 'relative'
    pattern = specifier.startsWith('./') ? specifier.slice(2) : specifier
  }
  return pattern.length > 0 ? { anchor, pattern } : null
}

function parameterRule(
  raw: string,
  action: ClaudeRuleAction,
  name: string,
  value: string,
): ParsedClaudeRule {
  if (action === 'allow') {
    return inert(
      'claude_rule.param_allow_inert',
      `Permission allow rule "${raw}": parameter rules apply to deny and ask only; the rule is ignored.`,
    )
  }
  const trimmed = value.trim()
  return {
    rule: {
      action,
      match: trimmed.includes('*')
        ? { kind: 'parameter', name, matches: trimmed }
        : { kind: 'parameter', name, equals: trimmed },
    },
  }
}

function ignoredParam(raw: string, action: ClaudeRuleAction, name: string): ParsedClaudeRule {
  return inert(
    'claude_rule.param_ignored',
    `Permission ${action} rule "${raw}": the ${name} parameter is matched by the tool's own canonicalizing checks and would be bypassable here, so the rule is ignored.`,
  )
}

function mcpRule(raw: string, action: ClaudeRuleAction, name: string): ParsedClaudeRule {
  const [, server, ...toolParts] = name.split('__')
  const tool = toolParts.length > 0 ? toolParts.join('__') : undefined
  if (!server || server.length === 0 || (tool !== undefined && tool.length === 0)) return invalid(raw)
  if (action === 'allow') {
    // permissions.md: allow rules accept tool-name globs only after a literal
    // glob-free mcp__<server>__ prefix. An unanchored allow glob is skipped.
    if (server.includes('*') || (tool === undefined && name.includes('*'))) {
      return inert(
        'claude_rule.unanchored_allow_glob',
        `Permission allow rule "${raw}" is an unanchored glob and doesn't auto-approve anything; it is skipped.`,
      )
    }
  }
  return { rule: { action, match: { kind: 'mcp', server, ...(tool === undefined ? {} : { tool }) } } }
}

function bareToolRule(
  raw: string,
  action: ClaudeRuleAction,
  name: string,
  options: ParseClaudeRuleOptions,
): ParsedClaudeRule {
  if (name.startsWith('mcp__')) return mcpRule(raw, action, name)
  if (name.includes('*') && action === 'allow') {
    return inert(
      'claude_rule.unanchored_allow_glob',
      `Permission allow rule "${raw}" is an unanchored glob and doesn't auto-approve anything; it is skipped.`,
    )
  }
  const rule: ParsedClaudeRule = { rule: { action, match: { kind: 'tool', semanticId: name } } }
  if (name === 'EndConversation' && action !== 'allow') {
    // The parser only tags; "a deny rule can't remove it while any other tool
    // remains, and an ask rule never prompts for it" is consumer-side.
    rule.warning = {
      code: 'claude_rule.end_conversation_guarded',
      message: `Permission ${action} rule "${raw}": EndConversation cannot be removed while any other tool remains; the consumer enforces the exception.`,
    }
    return rule
  }
  if (
    action !== 'allow'
    && options.knownToolNames !== undefined
    && !name.includes('_')
    && !name.includes('*')
    && !options.knownToolNames.includes(name)
  ) {
    rule.warning = {
      code: 'claude_rule.unknown_tool',
      message: `Permission ${action} rule "${raw}" names no known tool; check for a typo (rules match canonical tool names only).`,
    }
  }
  return rule
}

export interface ClaudeHookIfCall {
  toolName?: string
  toolInput?: Record<string, unknown>
  cwd: string
  /** Directory a `/x` (source-anchored) path rule resolves against. */
  sourceRoot?: string
}

export interface ClaudeHookIfResult {
  /** Whether the hook should run. */
  run: boolean
  /** The rule itself could not be parsed/compiled (the fail-open diagnostic case). */
  unparseableRule: boolean
}

const HOOK_IF_GENERATION = 'hook-if'

/**
 * Evaluates a hook `if` filter (hooks.md § if) against one tool call.
 *
 * FAIL-OPEN by documented contract — the opposite posture from the
 * managed-policy loader, which fails closed on the same parser: "The filter
 * also fails open, running your hook regardless of pattern, when the Bash
 * command can't be parsed. Because the `if` filter is best-effort, use the
 * permission system rather than a hook to enforce a hard allow or deny."
 * An unparseable rule, an inert rule form, or an unparseable Bash command all
 * run the hook. Event gating ("On other events, a hook with `if` set never
 * runs") is the caller's job — this function only sees tool calls.
 *
 * READ THE QUOTED SENTENCE NARROWLY (P2.277): what hooks.md fixes is the
 * unparseable Bash COMMAND. It says nothing about an `if` RULE that will not
 * parse, so the direction for THAT case is ours — and it is fail-open too, on
 * the second half of the same sentence ("best-effort", "use the permission
 * system rather than a hook to enforce a hard allow or deny") plus the hazard
 * of the alternative: a rule that fails to compile would otherwise silently
 * disable the hook, which is the failure P2.270 measured one file over, where
 * a source-anchored rule with no root reaches this function's `invalid-policy`
 * branch on perfectly ordinary configs. `unparseableRule` is the compensating
 * control and is NOT decoration — `hooks-automation.ts`'s
 * `reportUnparseableIfRule` turns it into an operator-visible notice, so a hook
 * running because its condition is broken is distinguishable from one running
 * because its condition matched. Keep every `unparseableRule: true` return
 * paired with `run: true`; the consumer reports after deciding to run.
 *
 * `Bash(...)` rules use the dedicated if-mode matcher (any subcommand,
 * `$()`/backtick contents, more-than-command-name fail-open) — NOT the
 * allow-shaped permission semantics. Every other rule form compiles into a
 * one-rule allow DSL and evaluates through `evaluatePermissionDslV1`, which
 * gives file-tool rules the documented anchored depth. Path rules match any
 * path parameter, so an `Edit(...)` filter can also fire on read and MCP tools —
 * over-firing is the fail-open direction for a best-effort filter.
 */
export function evaluateClaudeHookIfFilter(ifRule: string, call: ClaudeHookIfCall): ClaudeHookIfResult {
  const parsed = parseClaudeRuleString(ifRule, 'allow')
  if (!parsed.rule) return { run: true, unparseableRule: true }
  const match = parsed.rule.match
  if (match.kind === 'bash' && typeof match.pattern === 'string') {
    if (!call.toolName || !/^bash$/i.test(call.toolName)) return { run: false, unparseableRule: false }
    const command = call.toolInput?.command
    if (typeof command !== 'string') return { run: true, unparseableRule: false }
    const result = matchClaudeBashIfRule(match.pattern, command)
    if (result === 'unparseable') return { run: true, unparseableRule: false }
    return { run: result === 'match', unparseableRule: false }
  }
  const program = compilePermissionDslV1({
    generation: HOOK_IF_GENERATION,
    projectTrusted: true,
    layers: [{
      scope: 'workspace',
      sourceDigest: HOOK_IF_GENERATION,
      document: { version: 1, rules: [{ id: 'hook-if-rule', action: 'allow', match }] },
      ...(call.sourceRoot === undefined ? {} : { sourceRoot: call.sourceRoot }),
    }],
  })
  const evaluation = evaluatePermissionDslV1(program, {
    generation: HOOK_IF_GENERATION,
    semanticId: call.toolName ?? '',
    toolName: call.toolName ?? '',
    input: call.toolInput ?? {},
    cwd: call.cwd, pathAllowReachesMcpTools: true, // F1.377: this filter keeps its documented over-firing
  })
  // A rule the DSL cannot compile (e.g. a source anchor with no root) is an
  // unparseable rule: fail open.
  if (evaluation.match?.ruleId === 'invalid-policy') return { run: true, unparseableRule: true }
  return { run: evaluation.action === 'allow', unparseableRule: false }
}

/**
 * Parses one Claude permission-rule string into a DSL-shaped rule or a
 * structured warning. Pure; never throws.
 */
export function parseClaudeRuleString(
  raw: string,
  action: ClaudeRuleAction,
  options: ParseClaudeRuleOptions = {},
): ParsedClaudeRule {
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > 2048) return invalid(raw)
  const shape = RULE_SHAPE.exec(trimmed)
  if (!shape) return invalid(raw)
  const toolName = shape[1]!
  const specifier = shape[2]

  if (specifier === undefined) return bareToolRule(trimmed, action, toolName, options)
  if (specifier.trim().length === 0) return invalid(trimmed)
  if (toolName.includes('*')) return invalid(trimmed)

  const param = PARAM_SPECIFIER.exec(specifier)
  const ignored = IGNORED_PARAMS[toolName]
  if (param && ignored?.includes(param[1]!)) return ignoredParam(trimmed, action, param[1]!)

  switch (toolName) {
    case 'Bash':
      // permissions.md:96 — "Deny and ask rules can match a top-level input
      // parameter on ANY tool with `Tool(param:value)`", with
      // `Bash(run_in_background:true)` given as an example at :102; allow rules
      // "continue to use each tool's own specifier syntax", which for Bash is
      // the command pattern below. Only a named Bash input takes the parameter
      // path, so `Bash(ls:*)` stays the documented trailing wildcard (:136).
      if (param && action !== 'allow' && BASH_INPUT_PARAMS.has(param[1]!)) {
        return parameterRule(trimmed, action, param[1]!, param[2]!)
      }
      return withWildcardBeforeSubcommandWarning(
        { rule: { action, match: { kind: 'bash', pattern: specifier } } },
        trimmed,
        specifier,
        action,
      )
    case 'PowerShell':
      // permissions.md § PowerShell: "PowerShell permission rules use the same
      // shape as Bash rules." Its own matcher kind rather than `bash`, because
      // the alias canonicalization, the case-insensitivity and the PowerShell
      // separator set are all different — and because only a command our own
      // PowerShell routing calls PowerShell may be judged by it.
      return { rule: { action, match: { kind: 'powershell', pattern: specifier } } }
    case 'Read':
    case 'Edit': {
      const path = splitPathAnchor(specifier)
      if (!path) return invalid(trimmed)
      // `parameter` stays unset so the matcher covers every path parameter —
      // Edit governs all file-editing tools, and a Read DENY also blocks Edit.
      //
      // P3.214 — and a Read ALLOW does not, which is the half this used to get
      // wrong in the loose direction. See {@link READ_ALLOW_EXCLUDED_TOOLS}.
      const excludeTools = toolName === 'Read' && action === 'allow'
        ? READ_ALLOW_EXCLUDED_TOOLS
        : undefined
      return {
        rule: {
          action,
          match: {
            kind: 'pathGlob',
            pattern: path.pattern,
            anchor: path.anchor,
            ...(excludeTools ? { excludeTools } : {}),
          },
        },
      }
    }
    case 'Write':
    case 'NotebookEdit':
    case 'Glob': {
      if (param) return parameterRule(trimmed, action, param[1]!, param[2]!)
      const replacement = UNMATCHED_PATH_FORMS[toolName]!
      return inert(
        'claude_rule.unmatched_form',
        `Permission ${action} rule "${trimmed}" is not matched by file permission checks — only Edit(path) and Read(path) rules are. Use ${replacement}(${specifier}) instead (Edit rules cover all file-editing tools).`,
      )
    }
    case 'WebFetch': {
      const domain = /^domain\s*:\s*(.+)$/s.exec(specifier)
      if (domain) {
        const host = domain[1]!.trim().toLowerCase().replace(/\.$/, '')
        if (host.length === 0) return invalid(trimmed)
        return { rule: { action, match: { kind: 'host', host } } }
      }
      if (param) return parameterRule(trimmed, action, param[1]!, param[2]!)
      return invalid(trimmed)
    }
    case 'Agent': {
      if (param) return parameterRule(trimmed, action, param[1]!, param[2]!)
      return { rule: { action, match: { kind: 'agent', agent: specifier.trim() } } }
    }
    case 'Cd': {
      // permissions.md § Cd. The surface is the session working-directory
      // transaction (`SessionManager.mutateWorkingDirectory`), which every
      // user-driven cwd move already goes through. Matching is whole-path, not
      // gitignore-style, so this is its own matcher kind and NOT `pathGlob`:
      // `*` is exactly one segment, `**` spans segments, and a bare literal
      // does not float to any depth.
      const path = splitPathAnchor(specifier)
      if (!path) return invalid(trimmed)
      return { rule: { action, match: { kind: 'cdPath', pattern: path.pattern, anchor: path.anchor } } }
    }
    default: {
      if (param) {
        const parsed = parameterRule(trimmed, action, param[1]!, param[2]!)
        if (
          parsed.rule
          && action !== 'allow'
          && options.knownToolNames !== undefined
          && !toolName.includes('_')
          && !options.knownToolNames.includes(toolName)
        ) {
          parsed.warning = {
            code: 'claude_rule.unknown_tool',
            message: `Permission ${action} rule "${trimmed}" names no known tool; check for a typo (rules match canonical tool names only).`,
          }
        }
        return parsed
      }
      return inert(
        'claude_rule.unmatched_form',
        `Permission ${action} rule "${trimmed}" uses a specifier form no permission check matches; the rule is ignored.`,
      )
    }
  }
}
