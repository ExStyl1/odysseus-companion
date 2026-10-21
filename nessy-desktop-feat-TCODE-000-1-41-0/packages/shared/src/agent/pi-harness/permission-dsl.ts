import { latchedHomeDir } from '../../config/home-latch.ts'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { matchClaudeBashRule } from './claude-bash-rule.ts'
import { looksLikePowerShell, matchClaudePowerShellRule } from './claude-powershell-rule.ts'
import { isDepthFloatEligible, matchGitignoreGlob } from './gitignore-glob.ts'

export const NESSY_PERMISSION_DSL_VERSION = 1 as const

/**
 * How many rules one settings source may contribute to a compiled program.
 *
 * **This number is OURS**, and saying so is the point of this comment. It was
 * introduced by `b1571ad0a` and is published by no Claude page: the four
 * permission-bearing pages (`settings.md`, `settings-reference.md`,
 * `permissions.md`, `managed-settings.md`) state no cap on the number of
 * permission entries at all, and the control that they DO state caps where they
 * have them is `settings-reference.md`, which carries four explicit "at most N"
 * limits of its own. It is also absent from `.references/` (control: `permission`
 * hits there), so it is not inherited either. It is a bound on the work every
 * tool call pays, chosen here, and it may be changed here.
 *
 * P2.269 — what it does when EXCEEDED is the part that had to change. Until
 * then, one rule past this number set `invalidSource` and the layer collapsed
 * into a blanket `deny` under `ruleId: 'invalid-policy'`, so a request no rule
 * mentioned was refused: measured at 513 rules, `git status` — named by nothing
 * — answered `deny`. Raising the number would only move that cliff. The cliff
 * was the defect, so the FAILURE changed instead, and the number did not:
 *
 * - The overflow is paid by `allow` rules, last-declared first, each dropped
 *   with its own warning naming the rule and this limit. Dropping a grant is the
 *   narrowing direction — the requests it would have cleared are referred to the
 *   user — which is the disposition {@link DroppedRule} already records for the
 *   sibling case, and the direction `managed-settings.md#find-entries-claude-code-dropped`
 *   argues for: "Claude Code first skips the individual entries it can repair,
 *   such as one invalid permission rule, with a warning for each."
 * - `deny` and `ask` rules are NEVER dropped to fit. Dropping one is the
 *   widening direction, and this cap is not a reason to widen a policy.
 * - If the `deny`/`ask` rules ALONE exceed the limit, the layer still fails
 *   closed, because honouring the cap there could only be done by widening. That
 *   residue is deliberate, and it now says so in words instead of arriving as
 *   "Permission DSL document is invalid."
 *
 * The trade, stated: an administrator whose source overflows loses ALLOW rules
 * rather than the whole layer's discrimination. That is more prompting and
 * possibly more denial for the requests those grants covered, and it is never a
 * request the policy failed to deny.
 */
export const MAX_PERMISSION_DSL_RULES = 512

/**
 * The same bound for the immutable host-managed tier, which {@link parsePermissionDslV1}
 * enforces separately and more tightly.
 *
 * A managed policy is authored by an administrator and shipped as one file, so
 * it is held to a smaller budget than a workspace's own settings. The number was
 * a bare `128` in the expression until P2.269; naming it is the whole change,
 * because a limit nothing names cannot be discovered from the failure it causes.
 * The managed tier's overflow disposition is NOT this file's: `managed-policy.ts`
 * `tolerantPermissionDsl` re-validates each rule against the subset kept so far,
 * so the cap is attributed to the rule that breaks it and recorded on the drop
 * sink — the shape `managed-settings.md#keys-that-fail-closed` prescribes.
 */
export const MAX_MANAGED_PERMISSION_DSL_RULES = 128

/**
 * Marker prefix on the one layer-fatal error that carries its own sentence.
 *
 * The layer catch below reports a single generic message for everything it
 * sees, which is what made the rule-cap collapse indistinguishable from one
 * malformed pattern. Rather than widen that catch's vocabulary for every
 * thrower, the cap's own fatal case stamps its message and the catch passes it
 * through verbatim.
 */
const RULE_CAP_FATAL = 'rule cap: '

export type PermissionDslAction = 'allow' | 'ask' | 'deny'
export type PermissionDslScope = 'managed' | 'global' | 'workspace' | 'project' | 'plugin'

/** Immutable raw document accepted from the host-managed policy only. */
export interface PermissionDslV1 {
  readonly version: typeof NESSY_PERMISSION_DSL_VERSION
  readonly rules: readonly PermissionDslRuleV1[]
}

export interface PermissionDslRuleV1 {
  readonly id: string
  readonly action: PermissionDslAction
  readonly match: PermissionDslMatcherV1
  /**
   * P2.445 — the rule AS ITS AUTHOR WROTE IT (`Bash(rm -rf *)`, `Read(~/.ssh)`),
   * carried for exactly one purpose: so a refusal can name the rule with a
   * string the person who wrote it can search for.
   *
   * P6.1 found the same thing on codex and its finding applies unchanged here:
   * an identifier the user has never seen is not an identifier. EVERY `id` that
   * reaches the merged program is positional and internal —
   * `claude-settings-deny-3` (`permissions-config.ts`), `claude-deny-0`
   * (`managed-policy.ts`), `session-1` (the session-rule layer) — and
   * {@link parsePermissionDslV1} shows the id was never meant to be a display
   * string, since it constrains ids to `[A-Za-z0-9._-]` and requires them
   * unique, which no rule string satisfies. So the text rides ALONGSIDE the id
   * rather than replacing it, and the id stays the join key it always was.
   *
   * DISPLAY ONLY. Nothing matches on it, nothing keys off it, no digest changes
   * meaning because of it, and it is absent for a rule nobody wrote by hand (a
   * durable execpolicy allow grant) — there the refusal falls back to the id.
   */
  readonly text?: string
}

/**
 * Anchor for a `pathGlob` matcher, mirroring Claude's four Read/Edit anchors
 * (permissions.md): `//abs` → absolute, `~/x` → home, `/x` → source (the
 * rule's declaring settings source, threaded as `sourceRoot` on the layer
 * input), `x`/`./x` → relative (the request cwd).
 */
export type PathGlobAnchor = 'absolute' | 'home' | 'source' | 'relative'

export interface PermissionDslMatcherV1 {
  readonly kind: 'tool' | 'bash' | 'powershell' | 'path' | 'pathGlob' | 'cdPath' | 'host' | 'mcp' | 'agent' | 'parameter'
  readonly semanticId?: string
  readonly executable?: string
  readonly args?: readonly string[]
  readonly cwdRoot?: string
  readonly root?: string
  readonly parameter?: string
  readonly host?: string
  readonly server?: string
  readonly tool?: string
  readonly agent?: string
  readonly name?: string
  readonly equals?: string | number | boolean
  readonly oneOf?: readonly (string | number | boolean)[]
  /** Glob comparison for `parameter` matchers (`*` spans any characters). */
  readonly matches?: string
  readonly pattern?: string
  readonly anchor?: PathGlobAnchor
  /**
   * P3.214 — tool names a `pathGlob` matcher must NOT judge, so a rule whose
   * documented reach stops short of a tool sharing its path parameter can say
   * so. Exclusion-only: it can never widen. See `claude-permission-rules.ts`
   * `READ_ALLOW_EXCLUDED_TOOLS` for the only producer.
   */
  readonly excludeTools?: readonly string[]
}

export interface PermissionDslDiagnosticV1 {
  code: 'invalid-jsonc' | 'invalid-document' | 'unknown-matcher' | 'stale-generation' | 'unparseable-rule' | 'rule-cap' | 'project-untrusted'
  message: string
}

export interface PermissionDslSourceV1 {
  sourceDigest: string
  document?: unknown
  diagnostic?: PermissionDslDiagnosticV1
}

export interface PermissionDslLayerInputV1 extends PermissionDslSourceV1 {
  scope: PermissionDslScope
  /**
   * Absolute directory the layer's `pathGlob` rules with `anchor: 'source'`
   * resolve against (Claude's settings-source anchor). A source-anchored rule
   * in a layer without one fails that layer closed at compile.
   */
  sourceRoot?: string
}

type CompiledMatcher =
  | { kind: 'tool'; semanticId: string }
  | { kind: 'bash'; executable: string; args?: readonly string[]; cwdRoot?: string }
  | { kind: 'bashPattern'; pattern: string; action: PermissionDslAction }
  | { kind: 'powershell'; pattern: string; action: PermissionDslAction }
  | { kind: 'path'; root: string; parameter?: PathParameter }
  | { kind: 'pathGlob'; pattern: string; anchor: PathGlobAnchor; anyDepth: boolean; base?: string; parameter?: PathParameter; excludeTools?: readonly string[] }
  | { kind: 'cdPath'; pattern: string; anchor: PathGlobAnchor; base?: string }
  | { kind: 'host'; host: string }
  | { kind: 'mcp'; server: string; tool?: string }
  | { kind: 'agent'; agent: string }
  | { kind: 'parameter'; name: string; equals?: string | number | boolean; oneOf?: readonly (string | number | boolean)[]; matches?: string }

interface CompiledRule {
  id: string
  action: PermissionDslAction
  scope: PermissionDslScope
  sourceDigest: string
  /** The author's own rule string — see {@link PermissionDslRuleV1.text}. */
  text?: string
  matcher: CompiledMatcher
  order: number
  /**
   * P6.191 — this ALLOW rule is one of the two classes auto mode suspends by
   * default. Computed at compile so the classification is a property of the
   * program a caller can inspect, and so the rule stays in `rules` verbatim:
   * only the evaluation skips it, which is what makes "leaving auto mode
   * restores the rule" true by construction rather than by re-compiling.
   */
  broadShellGrant?: true
}

/**
 * A rule whose MATCHER the compiler rejected. It is SKIPPED — whatever its
 * action — and never reaches `rules`, so it decides nothing: not at the tool
 * gate, not at the `Cd` gate, not in the whole-tool deny filter.
 *
 * `managed-settings.md#keys-that-fail-closed` states it for the surface this
 * defect was found on, a project settings file: "User, project, and local
 * settings files remain strict: a file whose JSON or top-level shape fails
 * validation is rejected as a whole and reported, and an individual entry that
 * fails, such as a malformed permission rule, is skipped with a warning while
 * the rest of the file applies." `#find-entries-claude-code-dropped` says the
 * same for managed sources — "Claude Code first skips the individual entries it
 * can repair, such as one invalid permission rule, with a warning for each" —
 * and the same page's `deniedMcpServers` row gives the reason a skip is not
 * reserved for grants: "A wholly invalid value is dropped with a warning, since
 * denying every server would block servers the policy never named."
 *
 * The accepted cost, owner-resolved 2026-08-27 (OQ-8): a typo in a `deny` rule
 * stops denying, and the user may not read the warning. Substituting a blanket
 * `deny` instead — which this compiler did between `1e2aa4438` and this commit
 * — enforces a policy nobody wrote over every tool, which is the failure the
 * page argues against. Do NOT add a compensating hard-deny here.
 *
 * The record is kept so the skip can ANNOUNCE itself (see
 * `evaluatePermissionDslV1`'s tail) rather than being a silent subtraction.
 */
interface DroppedRule {
  id: string
  action: PermissionDslAction
  scope: PermissionDslScope
  sourceDigest: string
  diagnostic: PermissionDslDiagnosticV1
}

export interface CompiledPermissionDslV1 {
  version: typeof NESSY_PERMISSION_DSL_VERSION
  generation: string
  rules: readonly CompiledRule[]
  /** Rules skipped at compile because their matcher would not compile. */
  droppedRules: readonly DroppedRule[]
  droppedSources?: readonly Omit<DroppedRule, 'id' | 'action'>[] // F1.831 — unreadable documents, see `dropUnreadablePermissionDslLayer`
  diagnostics: readonly PermissionDslDiagnosticV1[]
  invalidSource?: { scope: PermissionDslScope; sourceDigest: string; diagnostic: PermissionDslDiagnosticV1 } // F1.1187 — the reason is the failing document's own
}

export interface PermissionDslRequestV1 {
  generation: string
  semanticId: string
  toolName: string
  input: Readonly<Record<string, unknown>>
  cwd: string
  canonicalizePath?: (value: string, cwd: string) => string
  /**
   * Pre-canonicalization form of the request's path input, for hosts that
   * canonicalize `input` before evaluation. `pathGlob` rules test the symlink
   * pair with Claude's documented asymmetry — an allow rule requires the raw
   * path AND its resolved target to match; deny/ask match on EITHER. Absent,
   * the raw side falls back to the parameter value itself.
   */
  rawInputPath?: string
  /**
   * P6.191 — auto mode's DEFAULT-ON suspension of broad shell grants.
   *
   * `auto-mode-config.md#route-all-shell-commands-through-the-classifier`,
   * verbatim: "By default, narrow Bash and PowerShell allow rules such as
   * `Bash(npm test)` stay in effect in auto mode, and Claude Code resolves them
   * before the classifier runs. Claude Code suspends only the broad rules that
   * grant arbitrary code execution, such as `Bash(*)` or wildcarded
   * interpreters, together with every rule that names `Monitor`, because
   * Monitor commands run through the shell."
   *
   * So this is set while the session's permission mode is `auto`, and NOT the
   * same switch as `autoMode.classifyAllShell`, which suspends EVERY shell
   * allow rule (the narrow ones too) and is off by default. Both can be on; this
   * one is the floor.
   *
   * Absent leaves every rule in effect, so a host that does not pass it behaves
   * exactly as before.
   */
  suspendBroadShellGrants?: boolean
}

export interface PermissionDslMatchV1 {
  ruleId: string
  scope: PermissionDslScope
  sourceDigest: string
  /**
   * The matched rule's own text when it has one — see
   * {@link PermissionDslRuleV1.text}. Absent on the two synthetic
   * `invalid-policy` reports, which name no rule the user wrote.
   */
  ruleText?: string
}

export interface PermissionDslEvaluationV1 {
  action?: PermissionDslAction
  match?: PermissionDslMatchV1
  diagnostic?: PermissionDslDiagnosticV1
}

const PATH_PARAMETERS = ['file_path', 'notebook_path', 'path', 'cwd', 'workingDirectory'] as const
type PathParameter = typeof PATH_PARAMETERS[number]

/**
 * Pre-canonicalization path for a DSL request whose `input` the host
 * canonicalizes before evaluation. Returns the raw input's single string path
 * parameter; when several distinct path parameters are present the pairing
 * would be ambiguous (`rawInputPath` applies to every parameter the matcher
 * tests), so it returns undefined and evaluation falls back to the
 * per-parameter value.
 */
export function rawDslInputPath(input: Readonly<Record<string, unknown>>): string | undefined {
  let found: string | undefined
  for (const parameter of PATH_PARAMETERS) {
    const value = input[parameter]
    if (typeof value !== 'string') continue
    if (found !== undefined && found !== value) return undefined
    found = value
  }
  return found
}
const SAFE_PARAMETERS = ['method', 'mode', 'action', 'access', 'operation', 'transport'] as const
type SafeParameter = typeof SAFE_PARAMETERS[number]
const ACTION_WEIGHT: Readonly<Record<PermissionDslAction, number>> = { allow: 0, ask: 1, deny: 2 }
const SCOPE_WEIGHT: Readonly<Record<PermissionDslScope, number>> = { managed: 4, global: 3, workspace: 2, project: 1, plugin: 0 }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function bounded(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) throw new Error(`invalid ${label}`)
  return value
}

/**
 * A frozen, bounded list of tool names for {@link PermissionDslMatchV1}'s
 * `excludeTools` (P3.214).
 *
 * Validated rather than trusted for the reason every other field here is: a
 * matcher can arrive from a managed policy or a settings file, and a compile
 * that accepts a non-array or an unbounded string is a compile that can be
 * handed a payload instead of a rule. Eight is well above the four names the
 * only producer emits.
 */
function boundedToolNames(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw new Error('invalid excludeTools')
  return Object.freeze(value.map(entry => bounded(entry, 'excludeTools entry', 64)))
}

/**
 * The longest rule text kept for display (P2.445).
 *
 * A settings rule string is otherwise unbounded — the managed tier caps an
 * entry at 2048 characters and a Claude settings file caps it at nothing — and
 * this string ends up inside a refusal that both the model and the user read,
 * so it is bounded where it is STORED rather than at each render site.
 */
const MAX_RULE_TEXT = 160

/**
 * Read a rule's display text. NEVER THROWS, and that is the whole design.
 *
 * The two callers sit on the path that decides whether a deny rule exists at
 * all: in {@link parsePermissionDslV1} a throw drops the rule under the managed
 * tier's tolerance, and in {@link compilePermissionDslV1} the rule-level `exact`
 * check is outside the per-rule catch, so a throw there is LAYER-fatal. A
 * display string must not be able to delete an enforcement rule, so anything
 * unusable is simply absent and the refusal falls back to the id.
 */
function ruleTextOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  return trimmed.length > MAX_RULE_TEXT ? `${trimmed.slice(0, MAX_RULE_TEXT)}…` : trimmed
}

function exact(value: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = new Set(allowed)
  if (Object.keys(value).some(key => !keys.has(key))) throw new Error('unknown field')
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

/** Minimal JSONC lexer: strips comments and trailing commas without touching string contents. */
export function parsePermissionJsonc(input: string): unknown {
  let output = ''
  let quote = false
  let escaped = false
  for (let index = 0; index < input.length; index++) {
    const current = input[index]!
    const next = input[index + 1]
    if (quote) {
      output += current
      if (escaped) escaped = false
      else if (current === '\\') escaped = true
      else if (current === '"') quote = false
      continue
    }
    if (current === '"') {
      quote = true
      output += current
      continue
    }
    if (current === '/' && next === '/') {
      while (index < input.length && input[index] !== '\n') index++
      output += '\n'
      continue
    }
    if (current === '/' && next === '*') {
      index += 2
      while (index < input.length && !(input[index] === '*' && input[index + 1] === '/')) index++
      if (index >= input.length) throw new Error('unterminated comment')
      index++
      output += ' '
      continue
    }
    output += current
  }
  if (quote) throw new Error('unterminated string')
  let normalized = ''
  quote = false
  escaped = false
  for (let index = 0; index < output.length; index++) {
    const current = output[index]!
    if (quote) {
      normalized += current
      if (escaped) escaped = false
      else if (current === '\\') escaped = true
      else if (current === '"') quote = false
      continue
    }
    if (current === '"') {
      quote = true
      normalized += current
      continue
    }
    if (current === ',') {
      let lookahead = index + 1
      while (/\s/.test(output[lookahead] ?? '')) lookahead++
      if (output[lookahead] === '}' || output[lookahead] === ']') continue
    }
    normalized += current
  }
  return JSON.parse(normalized)
}

export function parsePermissionDslSourceV1(value: unknown, sourceDigest: string): PermissionDslSourceV1 {
  const root = record(value)
  if (!root) return { sourceDigest, diagnostic: { code: 'invalid-document', message: 'Permission DSL must be an object.' } }
  return { sourceDigest, document: structuredClone(root) }
}

/** Strict raw parser for the immutable host-managed DSL layer. */
export function parsePermissionDslV1(value: unknown): PermissionDslV1 {
  const document = record(value)
  if (!document) throw new Error('invalid permission DSL document')
  exact(document, ['version', 'rules'])
  if (document.version !== NESSY_PERMISSION_DSL_VERSION || !Array.isArray(document.rules)) {
    throw new Error('invalid permission DSL document')
  }
  if (document.rules.length > MAX_MANAGED_PERMISSION_DSL_RULES) {
    // Named, so `tolerantPermissionDsl`'s drop sink records WHICH limit was hit
    // rather than a bare "invalid permission DSL document" — the same complaint
    // P2.269 closed for the project tier's own cap.
    throw new Error(`invalid permission DSL document: at most ${MAX_MANAGED_PERMISSION_DSL_RULES} rules`)
  }
  const ids = new Set<string>()
  const rules = document.rules.map(rawRule => {
    const rule = record(rawRule)
    if (!rule) throw new Error('invalid permission DSL rule')
    exact(rule, ['id', 'action', 'match', 'text'])
    const id = bounded(rule.id, 'rule id', 128)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || ids.has(id)) {
      throw new Error('invalid permission DSL rule id')
    }
    ids.add(id)
    if (rule.action !== 'allow' && rule.action !== 'ask' && rule.action !== 'deny') {
      throw new Error('invalid permission DSL action')
    }
    const action = rule.action as PermissionDslAction
    compileMatcher(rule.match, root => root, 32, { action, resolveBases: false })
    const text = ruleTextOf(rule.text)
    return deepFreeze({
      id,
      action,
      match: deepFreeze(structuredClone(rule.match) as PermissionDslMatcherV1),
      ...(text === undefined ? {} : { text }),
    })
  })
  return deepFreeze({ version: NESSY_PERMISSION_DSL_VERSION, rules })
}

function compileRoot(
  value: unknown,
  label: string,
  canonicalizeRoot: ((absolutePath: string) => string) | undefined,
): string {
  const root = bounded(value, label, 1024)
  if (!isAbsolute(root) || !canonicalizeRoot) throw new Error(`invalid ${label}`)
  const canonical = canonicalizeRoot(root)
  if (!isAbsolute(canonical)) throw new Error(`invalid canonical ${label}`)
  return resolve(canonical)
}

interface MatcherCompileContext {
  /** The owning rule's action; bakes the `pathGlob` depth-float decision. */
  action: PermissionDslAction
  /** The layer's settings-source directory for `anchor: 'source'` rules. */
  sourceRoot?: string
  /**
   * Validation-only parses (`parsePermissionDslV1`) skip anchor-base
   * resolution — the source root is a compile-time layer property.
   */
  resolveBases: boolean
}

/**
 * The absolute directory a non-relative anchor resolves against, or undefined
 * for a relative anchor (which only the request's cwd can resolve) and for
 * validation-only parses. Shared by `pathGlob` and `cdPath`, which
 * permissions.md gives the same three anchors — "Path patterns share the `//`,
 * `~/`, and `/` anchors from Read and Edit rules".
 */
function resolveAnchorBase(anchor: PathGlobAnchor, context: MatcherCompileContext): string | undefined {
  if (!context.resolveBases || anchor === 'relative') return undefined
  if (anchor === 'absolute') return sep
  // `latchedHomeDir()` and not `homedir()` — P3.168. This is the `~/` anchor
  // permissions.md gives Read/Edit/pathGlob/cdPath rules, so it is the base a
  // `~/.nessy` deny compiles against. A confirmed managed `HOME` moves
  // `os.homedir()` mid-session on Node, which would re-point a compiled deny at
  // a tree the credential is not in. Compile-time anchors follow the session.
  if (anchor === 'home') return resolve(latchedHomeDir())
  if (!context.sourceRoot || !isAbsolute(context.sourceRoot)) throw new Error('invalid pathGlob source root')
  return resolve(context.sourceRoot)
}

function compileMatcher(
  value: unknown,
  canonicalizeRoot: ((absolutePath: string) => string) | undefined,
  maxBashArgs = 256,
  context: MatcherCompileContext = { action: 'deny', resolveBases: false },
): CompiledMatcher {
  const matcher = record(value)
  if (!matcher) throw new Error('unknown matcher')
  const kind = matcher.kind
  switch (kind) {
    case 'tool':
      exact(matcher, ['kind', 'semanticId'])
      return { kind, semanticId: bounded(matcher.semanticId, 'semanticId') }
    case 'bash': {
      exact(matcher, ['kind', 'executable', 'args', 'cwdRoot', 'pattern'])
      if (matcher.pattern !== undefined) {
        // Claude Bash prefix rule: delegates to matchClaudeBashRule with the
        // rule action baked (allow = every subcommand, deny/ask = any).
        // Mutually exclusive with the structural executable/args form.
        if (matcher.executable !== undefined || matcher.args !== undefined || matcher.cwdRoot !== undefined) {
          throw new Error('invalid bash pattern matcher')
        }
        return { kind: 'bashPattern', pattern: bounded(matcher.pattern, 'bash pattern', 1024), action: context.action }
      }
      const args = matcher.args
      if (args !== undefined && (!Array.isArray(args) || args.length > maxBashArgs || args.some(value => typeof value !== 'string' || value.length > 256))) {
        throw new Error('invalid bash args')
      }
      return {
        kind,
        executable: bounded(matcher.executable, 'executable'),
        ...(args ? { args: [...args] as string[] } : {}),
        ...(matcher.cwdRoot === undefined ? {} : { cwdRoot: compileRoot(matcher.cwdRoot, 'cwdRoot', canonicalizeRoot) }),
      }
    }
    case 'path': {
      exact(matcher, ['kind', 'root', 'parameter'])
      const parameter = matcher.parameter
      if (parameter !== undefined && !PATH_PARAMETERS.includes(parameter as PathParameter)) throw new Error('invalid path parameter')
      return { kind, root: compileRoot(matcher.root, 'root', canonicalizeRoot), ...(parameter ? { parameter: parameter as PathParameter } : {}) }
    }
    case 'pathGlob': {
      // Claude Read/Edit gitignore semantics (permissions.md). The anchor base
      // is resolved WITHOUT symlink resolution — the docs evaluate the symlink
      // pair on the value side only, so the pattern side stays literal.
      exact(matcher, ['kind', 'pattern', 'anchor', 'parameter', 'excludeTools'])
      const pattern = bounded(matcher.pattern, 'pathGlob pattern', 1024)
      if (pattern.startsWith('/') || pattern.includes('\\') || pattern.includes('\0')) {
        throw new Error('invalid pathGlob pattern')
      }
      const anchor = matcher.anchor
      if (anchor !== 'absolute' && anchor !== 'home' && anchor !== 'source' && anchor !== 'relative') {
        throw new Error('invalid pathGlob anchor')
      }
      const parameter = matcher.parameter
      if (parameter !== undefined && !PATH_PARAMETERS.includes(parameter as PathParameter)) throw new Error('invalid path parameter')
      // Depth float (baked here, never re-decided per request): deny/ask
      // single-segment/slash-free relative patterns match at any depth; every
      // other shape is anchored in every rule type.
      const anyDepth = context.action !== 'allow' && anchor === 'relative' && isDepthFloatEligible(pattern)
      const base = resolveAnchorBase(anchor, context)
      // P3.214 — the tools this path rule must NOT judge, by name.
      //
      // A path matcher is keyed on the INPUT PARAMETER, and `file_path` is
      // shared by Read, Edit and Write (`permissions.md#use-specifiers-for-fine-grained-control`:
      // "`file_path` for Read, Edit, and Write"), so a parameter alone cannot
      // separate a read from a write. This is the one place the request's tool
      // NAME is consulted, and it is an EXCLUSION rather than an allowlist on
      // purpose: it can only ever narrow, so it cannot silently stop a Bash
      // file-command mediation or a future tool from being judged.
      const excludeTools = matcher.excludeTools === undefined
        ? undefined
        : boundedToolNames(matcher.excludeTools)
      return {
        kind,
        pattern,
        anchor,
        anyDepth,
        ...(base === undefined ? {} : { base }),
        ...(parameter ? { parameter: parameter as PathParameter } : {}),
        ...(excludeTools ? { excludeTools } : {}),
      }
    }
    case 'powershell': {
      // permissions.md § PowerShell — the same shape as a Bash pattern rule,
      // with the rule action baked at compile for the same reason: an allow
      // needs every subcommand to match, a deny/ask needs any.
      exact(matcher, ['kind', 'pattern'])
      return { kind, pattern: bounded(matcher.pattern, 'powershell pattern', 1024), action: context.action }
    }
    case 'cdPath': {
      // permissions.md § Cd: "Path patterns share the `//`, `~/`, and `/`
      // anchors from Read and Edit rules, but matching is anchored to the whole
      // directory path rather than gitignore-style." No depth float, in either
      // rule type — hence no `anyDepth` and no bare-literal float below.
      exact(matcher, ['kind', 'pattern', 'anchor'])
      const pattern = bounded(matcher.pattern, 'cdPath pattern', 1024)
      if (pattern.startsWith('/') || pattern.includes('\\') || pattern.includes('\0')) {
        throw new Error('invalid cdPath pattern')
      }
      const anchor = matcher.anchor
      if (anchor !== 'absolute' && anchor !== 'home' && anchor !== 'source' && anchor !== 'relative') {
        throw new Error('invalid cdPath anchor')
      }
      const base = resolveAnchorBase(anchor, context)
      return { kind, pattern, anchor, ...(base === undefined ? {} : { base }) }
    }
    case 'host':
      exact(matcher, ['kind', 'host'])
      return { kind, host: bounded(matcher.host, 'host').toLowerCase() }
    case 'mcp':
      exact(matcher, ['kind', 'server', 'tool'])
      return { kind, server: bounded(matcher.server, 'server'), ...(matcher.tool === undefined ? {} : { tool: bounded(matcher.tool, 'tool') }) }
    case 'agent':
      exact(matcher, ['kind', 'agent'])
      return { kind, agent: bounded(matcher.agent, 'agent') }
    case 'parameter': {
      exact(matcher, ['kind', 'name', 'equals', 'oneOf', 'matches'])
      const name = bounded(matcher.name, 'parameter name', 128)
      // Allow rules keep the curated safe-parameter set — an allow rule GRANTS
      // on a parameter value, so the vocabulary stays closed. Deny/ask rules
      // only restrict, and Claude's Tool(param:value) form (deny/ask only)
      // names any scalar top-level field (permissions.md).
      if (context.action === 'allow' && !SAFE_PARAMETERS.includes(name as SafeParameter)) {
        throw new Error('invalid safe parameter')
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) throw new Error('invalid parameter name')
      const scalar = (item: unknown) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
      if (matcher.equals !== undefined && !scalar(matcher.equals)) throw new Error('invalid parameter value')
      if (matcher.oneOf !== undefined && (!Array.isArray(matcher.oneOf) || matcher.oneOf.length > 32 || !matcher.oneOf.every(scalar))) {
        throw new Error('invalid parameter values')
      }
      if (matcher.matches !== undefined && typeof matcher.matches !== 'string') throw new Error('invalid parameter matches')
      const valueForms = [matcher.equals, matcher.oneOf, matcher.matches].filter(form => form !== undefined)
      if (valueForms.length !== 1) throw new Error('invalid parameter value forms')
      return {
        kind,
        name,
        ...(matcher.equals === undefined ? {} : { equals: matcher.equals as string | number | boolean }),
        ...(matcher.oneOf === undefined ? {} : { oneOf: [...matcher.oneOf] as (string | number | boolean)[] }),
        ...(matcher.matches === undefined ? {} : { matches: bounded(matcher.matches, 'parameter matches', 256) }),
      }
    }
    default:
      throw new Error('unknown matcher')
  }
}

/**
 * Tool names whose BARE allow rule is arbitrary code execution, so auto mode
 * suspends it by default (P6.191).
 *
 * `bash` and `powershell` because a bare `Bash` grant is `Bash(*)` by another
 * spelling; `monitor` because the page names it explicitly — "every rule that
 * names `Monitor`, because Monitor commands run through the shell".
 *
 * `Agent` is DELIBERATELY ABSENT, and the row that asked for this named it.
 * `auto-mode-config.md#route-all-shell-commands-through-the-classifier` scopes
 * the suspension to shell — Bash, PowerShell, Monitor — and says nothing about
 * delegation. Suspending an `Agent` allow rule would be a protection this fork
 * invented, applied to a rule a user wrote and a page told them would hold.
 */
const AUTO_MODE_BROAD_SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'powershell', 'monitor'])

/**
 * Interpreters whose WILDCARDED invocation is the page's "wildcarded
 * interpreters" — a rule that runs whatever it is handed.
 *
 * Read, not invented: the shells and interpreters this tree already treats as
 * arbitrary-execution vehicles. `env`, `xargs`, `nohup` and `command` are here
 * for the same reason `bash` is — each takes a program name as an argument, so
 * `Bash(env *)` grants everything `Bash(*)` does.
 */
const AUTO_MODE_ARBITRARY_INTERPRETERS: ReadonlySet<string> = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh',
  'python', 'python2', 'python3', 'node', 'deno', 'bun', 'ruby', 'perl', 'php',
  'osascript', 'pwsh', 'powershell',
  'env', 'exec', 'eval', 'xargs', 'nohup', 'command', 'time', 'timeout',
])

/** The program name a rule pattern or executable leads with, lowercased. */
function leadingProgram(value: string): string {
  const first = value.trim().split(/[\s:]+/)[0] ?? ''
  const tail = first.split(/[\\/]/).pop() ?? first
  return tail.toLowerCase()
}

/**
 * Does this shell pattern grant ARBITRARY code execution?
 *
 * Two shapes, both from the page's own examples:
 *  - `*` (and `:*`, `**`, an empty pattern) — matches every command;
 *  - a wildcarded interpreter — the pattern leads with an interpreter and its
 *    argument side is a wildcard, so `Bash(python *)` and `Bash(sh:*)` run
 *    anything.
 *
 * A pattern with a wildcard but NO interpreter (`Bash(npm *)`, `Bash(git *)`)
 * stays NARROW, exactly as the page says: "narrow Bash and PowerShell allow
 * rules such as `Bash(npm test)` stay in effect … This means a narrow rule can
 * still let a destructive argument through without the classifier seeing it".
 * That residual risk is the page's own stated cost of the default, and closing
 * it is what `autoMode.classifyAllShell` is for.
 */
function shellPatternGrantsArbitraryExecution(pattern: string): boolean {
  const trimmed = pattern.trim()
  if (trimmed === '' || /^\*+$/.test(trimmed) || /^:\*$/.test(trimmed)) return true
  const program = leadingProgram(trimmed)
  if (!AUTO_MODE_ARBITRARY_INTERPRETERS.has(program)) return false
  // The interpreter alone (`Bash(sh)`) runs an interactive shell we cannot see
  // the commands of, and the wildcarded forms run whatever they are handed.
  const rest = trimmed.slice(program.length)
  return rest.trim() === '' || rest.includes('*')
}

/**
 * P6.191 — is this compiled ALLOW rule one of auto mode's default-suspended
 * broad shell grants?
 *
 * Classified from the COMPILED matcher rather than the raw document, so a
 * native DSL rule and a Claude rule string that mean the same thing are judged
 * the same way — `Bash(*)` arrives as `bashPattern`, a structural native rule
 * as `bash`, a bare tool grant as `tool`.
 */
function isAutoModeBroadShellGrant(action: PermissionDslAction, matcher: CompiledMatcher): boolean {
  if (action !== 'allow') return false
  switch (matcher.kind) {
    case 'tool':
      return AUTO_MODE_BROAD_SHELL_TOOLS.has(matcher.semanticId.toLowerCase())
    case 'bashPattern':
    case 'powershell':
      return shellPatternGrantsArbitraryExecution(matcher.pattern)
    case 'bash': {
      if (!AUTO_MODE_ARBITRARY_INTERPRETERS.has(leadingProgram(matcher.executable))) return false
      return matcher.args === undefined
        || matcher.args.length === 0
        || matcher.args.some(arg => arg.includes('*'))
    }
    default:
      return false
  }
}

export function compilePermissionDslV1(input: {
  generation: string
  projectTrusted: boolean
  layers: readonly PermissionDslLayerInputV1[]
  /** Host-owned realpath canonicalizer. Path rules fail closed when absent. */
  canonicalizeRoot?: (absolutePath: string) => string
}): CompiledPermissionDslV1 {
  const rules: CompiledRule[] = []
  const droppedRules: DroppedRule[] = []
  const diagnostics: PermissionDslDiagnosticV1[] = []
  let invalidSource: CompiledPermissionDslV1['invalidSource']
  const sinks = { rules, droppedRules, diagnostics, droppedSources: [] as Array<Omit<DroppedRule, 'id' | 'action'>> }
  for (const layer of input.layers) {
    /**
     * P6.193 — an untrusted project withholds the folder's GRANTS, not its
     * RESTRICTIONS.
     *
     * This was `continue`: the whole project layer was dropped, so opening an
     * untrusted repository silently deleted its `deny` and `ask` rules along
     * with its `allow` rules. That is a LOOSENING performed in the name of
     * caution — the one direction a trust boundary must never move. A folder
     * that says "never touch .env" is not asking to be trusted; it is asking to
     * be restricted, and the request costs nothing to honour.
     *
     * permissions.md#project-allow-rules-and-workspace-trust is the contract
     * this restores, and it states the split directly: "`permissions.allow`
     * rules and `permissions.additionalDirectories` entries in a project's
     * `.claude/settings.json` grant capability, so Claude Code applies them only
     * after you accept the workspace trust dialog for that folder", while
     * "`deny` and `ask` rules aren't affected, since they only restrict."
     * permissions.md#manage-permissions carries the ordering: "Rules are
     * evaluated in order: deny, then ask, then allow."
     *
     * Re-anchored P6.661. The former cite named `permissions.md`, section
     * "permission rules", which is not a section of the page — it publishes
     * `#permission-rule-syntax` — and its quoted words, a `deny` rule "is
     * applied first and cannot be overridden", are on no fetchable revision of
     * it. (Spelled apart: `check-doc-anchors.ts` scans every tracked file, so
     * the dead anchor written the way one is normally written — page slug,
     * dot-m-d, hash, section slug, one unbroken token — would re-create here the
     * very finding this note reports as closed. §P2.376a's own trap, and a
     * PLACEHOLDER in that shape springs it too.)
     *
     * An untrusted project's UNREADABLE document is skipped outright and silently:
     * it has no deny rules to salvage (F1.831 drops any other one whole, announced).
     */
    const withholdProjectGrants = layer.scope === 'project' && !input.projectTrusted
    if (withholdProjectGrants && layer.diagnostic) continue
    const mark = [rules.length, droppedRules.length, diagnostics.length] as const
    if (layer.diagnostic) {
      invalidSource = dropUnreadablePermissionDslLayer(layer, layer.diagnostic, mark, sinks, invalidSource)
      continue
    }
    try {
      const document = record(layer.document)
      if (!document) throw new Error('invalid document')
      exact(document, ['version', 'generation', 'rules'])
      if (document.version !== NESSY_PERMISSION_DSL_VERSION || !Array.isArray(document.rules)) {
        throw new Error('invalid document')
      }
      // P2.269 — the rule cap, and it is a BUDGET rather than a cliff. See
      // `MAX_PERMISSION_DSL_RULES` for whose number this is and why exceeding it
      // no longer collapses the layer into a blanket deny. Counted from the RAW
      // actions, before any rule is compiled, so the budget is a property of what
      // the source declares rather than of what happens to compile.
      const declaredRules = document.rules as readonly unknown[]
      let allowBudget = Number.POSITIVE_INFINITY
      if (declaredRules.length > MAX_PERMISSION_DSL_RULES) {
        const enforcing = declaredRules.filter(raw => {
          const action = record(raw)?.action
          return action === 'deny' || action === 'ask'
        }).length
        if (enforcing > MAX_PERMISSION_DSL_RULES) {
          // The one case the cap still cannot absorb: there is no allow rule
          // left to pay with, and paying with a deny or an ask would WIDEN the
          // policy to satisfy a limit of our own choosing. Fail closed, and say
          // which limit and by how much, because the generic collapse this row
          // exists to close said neither.
          throw new Error(`${RULE_CAP_FATAL}This settings source declares ${enforcing} deny/ask permission rules, `
            + `over the ${MAX_PERMISSION_DSL_RULES}-rule compile limit. Dropping a deny or ask rule would widen the `
            + 'policy, so the source is refused as a whole and every request it covers is denied until it is shortened.')
        }
        allowBudget = MAX_PERMISSION_DSL_RULES - enforcing
      }
      let allowsKept = 0
      if (document.generation !== undefined && document.generation !== input.generation) {
        invalidSource = dropUnreadablePermissionDslLayer(layer, { code: 'stale-generation', message: 'Permission DSL generation is stale.' }, mark, sinks, invalidSource)
        continue
      }
      for (const rawRule of document.rules) {
        const rule = record(rawRule)
        if (!rule) throw new Error('invalid rule')
        exact(rule, ['id', 'action', 'match', 'text'])
        const action = rule.action
        if (action !== 'allow' && action !== 'ask' && action !== 'deny') throw new Error('invalid action')
        // The id and the action are read OUTSIDE the per-rule catch on purpose:
        // both are structure, not specifier. Without an id the diagnostic can
        // name nothing and the skip is silent — so those stay layer-fatal, as
        // they were.
        const id = bounded(rule.id, 'rule id', 128)
        // P2.269 — the overflow, paid here and only by grants. `allowBudget` is
        // Infinity for every source under the cap, so this costs nothing in the
        // ordinary case. Ordering is untouched: the rules that survive keep their
        // declared order, and only the trailing allows are dropped.
        // P6.193 — the grant half of the trust gate. Same shape as the rule-cap
        // drop below: the rule is not compiled, it is RECORDED, and the reason
        // is a sentence the user can act on (trusting the folder restores it).
        if (withholdProjectGrants && action === 'allow') {
          const diagnostic: PermissionDslDiagnosticV1 = {
            code: 'project-untrusted',
            message: `Permission rule "${id}" (allow) was not applied: this project is not trusted, so its `
              + 'permission rules can restrict but cannot grant. It grants nothing; the requests it would have '
              + "cleared are referred to you instead. The project's deny and ask rules DO apply. Trust the folder "
              + 'to apply its allow rules.',
          }
          diagnostics.push(diagnostic)
          droppedRules.push({ id, action, scope: layer.scope, sourceDigest: layer.sourceDigest, diagnostic })
          continue
        }
        if (action === 'allow' && allowsKept >= allowBudget) {
          const diagnostic: PermissionDslDiagnosticV1 = {
            code: 'rule-cap',
            message: `Permission rule "${id}" (allow) was not compiled: this settings source declares `
              + `${declaredRules.length} rules and at most ${MAX_PERMISSION_DSL_RULES} are compiled, so the allow `
              + 'rules past that limit are dropped first — deny and ask rules are always kept. It grants nothing; '
              + 'the requests it would have cleared are referred to you instead. Every other rule in this policy '
              + 'still applies.',
          }
          diagnostics.push(diagnostic)
          droppedRules.push({ id, action, scope: layer.scope, sourceDigest: layer.sourceDigest, diagnostic })
          continue
        }
        if (action === 'allow') allowsKept++
        let matcher: CompiledMatcher
        try {
          matcher = compileMatcher(rule.match, input.canonicalizeRoot, 256, {
            action,
            resolveBases: true,
            ...(layer.sourceRoot === undefined ? {} : { sourceRoot: layer.sourceRoot }),
          })
        } catch (error) {
          // ONE unparseable matcher costs ONE rule, not the layer, and it costs
          // that rule WHATEVER ITS ACTION — see `DroppedRule` for the contract
          // and the owner-accepted cost. Before `1e2aa4438` the catch sat around
          // the whole layer, so a single `Read(C:\Users\x)` in a project
          // `.claude/settings.json` set `invalidSource` and every tool call —
          // including ones a co-resident allow rule had cleared — answered
          // `deny` under `ruleId: 'invalid-policy'`.
          //
          // An UNKNOWN matcher kind or field is the exception, and stays
          // layer-fatal as it was. It does not mean one specifier was written
          // wrong; it means the document was written for a vocabulary this
          // compiler does not have, and salvaging the rules it happens to
          // recognize would enforce a policy nobody wrote — the same reason
          // `managed-policy.ts` refuses to salvage a document stamped for
          // another DSL version. None of the specifier rejections this catch
          // exists for reach it: every one of them is a bound or a predicate
          // inside a matcher kind we do know.
          const reason = error instanceof Error ? error.message : 'unparseable matcher'
          if (reason.includes('unknown')) throw error
          // "with a warning for each" — one diagnostic per skipped rule, naming
          // the rule, its action and the compiler's own reason, so the policy is
          // repairable from the warning alone.
          const diagnostic: PermissionDslDiagnosticV1 = {
            code: 'unparseable-rule',
            message: `Permission rule "${id}" (${action}) could not be compiled (${reason}) and was skipped. `
              + (action === 'allow'
                ? 'It grants nothing; the requests it would have cleared are referred to you instead. '
                : `It ${action === 'deny' ? 'denies' : 'asks about'} nothing until the rule is fixed. `)
              + 'Every other rule in this policy still applies.',
          }
          diagnostics.push(diagnostic)
          droppedRules.push({ id, action, scope: layer.scope, sourceDigest: layer.sourceDigest, diagnostic })
          continue
        }
        const text = ruleTextOf(rule.text)
        rules.push({
          id,
          action,
          scope: layer.scope,
          sourceDigest: layer.sourceDigest,
          ...(text === undefined ? {} : { text }),
          matcher,
          order: rules.length,
          ...(isAutoModeBroadShellGrant(action, matcher) ? { broadShellGrant: true as const } : {}),
        })
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : ''
      // P2.269 — the cap's own fatal case keeps its sentence. Every other
      // thrower still collapses to one of the two generic messages, deliberately:
      // they name a document we could not read, and there is nothing more to say.
      if (reason.startsWith(RULE_CAP_FATAL)) {
        diagnostics.push({ code: 'rule-cap', message: reason.slice(RULE_CAP_FATAL.length) })
        invalidSource ??= { scope: layer.scope, sourceDigest: layer.sourceDigest, diagnostic: diagnostics.at(-1)! } // P2.269's residue, whatever the scope
      } else {
        const unknown = reason.includes('unknown')
        invalidSource = dropUnreadablePermissionDslLayer(layer, {
          code: unknown ? 'unknown-matcher' : 'invalid-document',
          message: unknown ? 'Permission DSL contains an unknown matcher or field.' : 'Permission DSL document is invalid.',
        }, mark, sinks, invalidSource)
      }
    }
  }
  return Object.freeze({
    version: NESSY_PERMISSION_DSL_VERSION,
    generation: input.generation,
    rules: Object.freeze(rules),
    droppedRules: Object.freeze(droppedRules),
    ...(sinks.droppedSources.length > 0 ? { droppedSources: Object.freeze(sinks.droppedSources) } : {}),
    diagnostics: Object.freeze(diagnostics),
    ...(invalidSource ? { invalidSource } : {}),
  })
}

/**
 * The non-Bash matcher glob: tool and semantic ids, `exec` executable/args, MCP
 * server and tool names, agent names, and `matcher.matches` against an
 * arbitrary tool-input field.
 *
 * `s` for the reason `compileBashPattern` carries it (P2.329): `*` compiles to
 * `.`, which without `s` refuses all four JS line terminators, so a pattern
 * silently failed to match any value containing one.
 * permissions.md#match-by-input-parameter states the contract this restores —
 * "The value supports `*` as a wildcard that matches any sequence of
 * characters, so `Agent(isolation:*)` matches any explicit isolation value.
 * Without `*` the match is exact" — and a newline is a character in any
 * sequence of them.
 *
 * Only ONE of the callers can actually see a terminator, and it is worth naming
 * so the blast radius is not overestimated: `matcher.matches`, which stringifies
 * a raw input field. Ids and names cannot contain one, and the `exec` matcher is
 * fed by `tokenizeShell`, which returns null outright on `\r` or `\n` — so
 * executable and args are newline-free by construction before they arrive here.
 *
 * Stated plainly because it is the one place this widens rather than narrows: a
 * `matches:` glob on an ALLOW rule now also matches a multi-line field value.
 * That is the documented reading of `*`, and the deny side of the same matcher
 * was bypassable without it.
 */
function wildcard(pattern: string, value: string): boolean {
  const escaped = pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${escaped}$`, 'us').test(value)
}

function within(root: string, value: string): boolean {
  const rel = relative(root, value)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function tokenizeShell(command: string): string[] | null {
  if (!command.trim() || /\$\(|`|<\(|>\(|\r|\n/.test(command)) return null
  const tokens: string[] = []
  let token = ''
  let quote: 'single' | 'double' | null = null
  let escaped = false
  for (const current of command) {
    if (escaped) { token += current; escaped = false; continue }
    if (current === '\\' && quote !== 'single') { escaped = true; continue }
    if (quote) {
      if ((quote === 'single' && current === "'") || (quote === 'double' && current === '"')) quote = null
      else if (quote === 'double' && current === '$') return null
      else token += current
      continue
    }
    if (current === "'") { quote = 'single'; continue }
    if (current === '"') { quote = 'double'; continue }
    if ('|&;<>'.includes(current) || current === '$' || '*?['.includes(current)) return null
    if (/\s/.test(current)) {
      if (token) { tokens.push(token); token = '' }
    } else token += current
  }
  if (escaped || quote) return null
  if (token) tokens.push(token)
  return tokens.length ? tokens : null
}

function shellProgram(command: string): { executable: string; args: string[] } | null {
  let tokens = tokenizeShell(command)
  if (!tokens) return null
  while (tokens[0] === 'env' || tokens[0] === '/usr/bin/env' || tokens[0] === 'command') {
    tokens = tokens.slice(1)
    while (tokens[0]?.includes('=') && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1)
  }
  const executable = tokens[0]
  if (!executable) return null
  const base = executable.split(/[\\/]/).at(-1)!
  if (isShellScriptInvocation(executable, tokens[1])) {
    return tokens.length === 3 ? shellProgram(tokens[2]!) : null
  }
  return { executable: base, args: tokens.slice(1) }
}

function hostFromInput(input: Readonly<Record<string, unknown>>): string | null {
  for (const key of ['host', 'domain']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase().replace(/\.$/, '')
  }
  for (const key of ['url', 'baseUrl']) {
    const value = input[key]
    if (typeof value !== 'string') continue
    try { return new URL(value).hostname.toLowerCase().replace(/\.$/, '') } catch { return null }
  }
  return null
}

function matchesHost(pattern: string, host: string): boolean {
  // permissions.md § WebFetch: a bare `*` matches every domain; a leading
  // `*.` matches any subdomain at any depth but not the bare domain itself;
  // in any other position the wildcard matches only the text between two
  // dots (`example.*` matches `example.org`, never `example.evil.com`).
  if (pattern === '*') return true
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1)) && host !== pattern.slice(2)
  if (pattern.includes('*')) {
    const source = pattern
      .split('*')
      .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^.]+')
    return new RegExp(`^${source}$`, 'u').test(host)
  }
  return host === pattern
}

/**
 * Which requests a `Bash(...)` rule is allowed to judge.
 *
 * Bash itself, and `Monitor`'s `command` source: `tools-reference.md` says a
 * Monitor command "uses the same permission rules as Bash, so `allow` and
 * `deny` patterns you have set for Bash apply here too". Admitting it HERE, in
 * the one matcher every consumer already goes through, is what keeps that a
 * single implementation — a Monitor-side re-check would be a second path, and
 * the rules would silently disagree the first time one of them changed.
 *
 * Monitor's `ws` source carries no `command`, so it falls out on the type check
 * below and inherits nothing from Bash's command rules.
 */
function carriesBashCommand(request: PermissionDslRequestV1): boolean {
  return request.toolName === 'Bash'
    || request.semanticId === 'bash'
    || request.semanticId === 'monitor'
}

/**
 * A Claude-shaped Bash pattern rule whose command the analysis could not parse.
 *
 * permissions.md:210 — "when Claude Code can't fully parse a command, it asks
 * for approval instead of treating the command as read-only. Commands longer
 * than 10,000 characters always prompt because they exceed what the analysis
 * parses." So the carve-out is a PROMPT, not a terminal deny: the sentinel is
 * fed back into the normal selection below as an `ask` candidate, where a real
 * deny match still outranks it and an allow match never can.
 *
 * Distinct from `unsafe-shell`, the NATIVE structural matcher's (`kind: 'bash'`
 * with `executable`/`args`) terminal refusal of compound, substitution and glob
 * syntax it will not represent — since F1.816 an every-program DENY rule's alone (a
 * named rule reads subcommands, F1.1245 for an ASK; {@link unparseableStructuralBashVerdict}).
 *
 * This sentinel is only HALF the carve-out, and reading it as the whole of it
 * is a mistake three separate plan rows made. It is a PER-RULE verdict returned
 * from inside two matcher branches, so it exists only once the compiled program
 * already carries a `Bash(prefix)` / `PowerShell(prefix)` rule. The other half
 * — the part that does not need any rule to exist — is
 * {@link commandIsUnparseable}, applied at program level in
 * {@link evaluatePermissionDslV1}. Read that function's contract before relying
 * on "an unparseable command prompts": it is true in a narrower sense than it
 * sounds.
 */
const PROMPT_ANYWAY = 'prompt-anyway'

/**
 * Whether the command analysis cannot read this request's command AT ALL.
 *
 * Unparseability is a property of the REQUEST, not of any rule. `matchesRule`
 * discovers it only while judging a `bashPattern` / `powershell` rule, so on a
 * profile carrying no such rule the discovery never happened. Measured on four
 * programs a real user can have, against `echo "unbalanced` (P2.311):
 *
 * | program | before | after |
 * | --- | --- | --- |
 * | no rules at all | no action | no action |
 * | only non-Bash rules | no action | no action |
 * | a TOOL-level bash allow (`{kind:'tool',semanticId:'bash'}`) | **`allow`** | **`ask`** |
 * | one `Bash(tail:*)` deny | `ask` | `ask` |
 *
 * The third row was the defect: an allow rule that never consults the command
 * text approved a command nothing could read. It is also an internal
 * contradiction against a documented equivalence —
 * `permissions.md#match-all-uses-of-a-tool` says "`Bash(*)` is equivalent to
 * `Bash` and matches all Bash commands", yet `Bash(*)` compiles to a
 * `bashPattern` rule and already asked, while bare `Bash` compiles to a `tool`
 * rule and allowed. The two forms now agree.
 *
 * ## What this carve-out covers
 *
 * Exactly one transition: a selected **`allow` becomes `ask`** when the command
 * is unparseable. Nothing else moves. A deny still denies (it outranks `ask` by
 * `ACTION_WEIGHT`), an `ask` is already an ask, and a command the analysis CAN
 * read resolves by its rules completely unchanged.
 *
 * ## What it does NOT cover — do not lean on it for these
 *
 * - **A program where nothing matched.** The DSL keeps abstaining, and the MODE
 *   default decides. That is deliberate, for two reasons. The documented
 *   sentence is about not AUTO-APPROVING (`permissions.md#read-only-commands`:
 *   "when Claude Code can't fully parse a command, it asks for approval instead
 *   of treating the command as read-only"), and abstaining is not approving —
 *   in `default`/Manual mode a no-match already prompts at the gate, which is
 *   the mode the page's own lead-in scopes the bullet to ("In Manual mode,
 *   commands from this set still prompt in these cases"). And manufacturing an
 *   action on a no-match would break the `invalid-policy` fail-open below —
 *   `evaluateClaudeHookIfFilter` compiles a ONE-RULE allow program and reads a
 *   no-match as "do not run" — while firing on 4.38 % of real agent-issued
 *   commands. Under `bypassPermissions` the mode default is allow, so an
 *   unparseable command IS allowed there; that is the mode's meaning, not this
 *   carve-out's business.
 * - **A command whose OUTER form parses but which carries unreadable text
 *   inside** — `sh -c '<unparseable script>'`, which is Codex's normal form.
 *   The verdict is `no-match`, never `unparseable`, so neither half of the
 *   carve-out fires. Measured at 13.78 % of real agent-issued commands (P2.91).
 * - **PowerShell.** This half is the SH reading only, and that is a measured
 *   choice rather than an oversight. Routing by `looksLikePowerShell` was tried
 *   and rejected: that predicate fires on 1 534 of 18 272 real agent-issued sh
 *   commands (8.39 % — heredoc bodies containing `-match`, a `Verb-Noun` word,
 *   a `$var |` pipeline), and judging those by the PowerShell splitter instead
 *   would prompt on 94 commands the sh analysis read correctly, buying nothing.
 *   A `PowerShell(prefix)` rule still reaches {@link PROMPT_ANYWAY} on its own
 *   text; what has no program-level floor is a PowerShell command on a profile
 *   with no PowerShell rule. Measured cost of the gap on this corpus: 23
 *   commands (0.13 %) the sh splitter calls unreadable and the PowerShell one
 *   accepts. Widening here needs a tighter language predicate, not this one.
 * - **Any DENY.** This never manufactures a refusal, only a prompt.
 */
function commandIsUnparseable(request: PermissionDslRequestV1): boolean {
  if (!carriesBashCommand(request)) return false
  const command = request.input.command
  if (typeof command !== 'string') return false
  // Asked through the SAME function the per-rule carve-out uses, with the
  // pattern that `permissions.md#match-all-uses-of-a-tool` declares equivalent
  // to the bare tool name — so this returns exactly the verdict a `Bash(*)`
  // allow rule reaches, and the two documented-equivalent spellings cannot
  // diverge again. The pattern cannot skew the answer: `'unparseable'` is
  // returned from the SPLIT, before any pattern is compiled, and a pattern that
  // merely failed to match comes back `'no-match'` instead.
  return matchClaudeBashRule('*', command, { ruleAction: 'allow' }) === 'unparseable'
}

function matchesRule(rule: CompiledRule, request: PermissionDslRequestV1): boolean | typeof PROMPT_ANYWAY | 'unsafe-shell' {
  const matcher = rule.matcher
  switch (matcher.kind) {
    case 'tool': return wildcard(matcher.semanticId, request.semanticId) || wildcard(matcher.semanticId, request.toolName)
    case 'bash': {
      if (!carriesBashCommand(request)) return false
      const command = request.input.command
      if (typeof command !== 'string') return false
      const program = loginShellInvocationAsWritten(matcher, command) ?? shellProgram(command) // F1.824 — a rule naming the wrapper
      if (!program) return unparseableStructuralBashVerdict(rule.action, matcher, command, request) // F1.784, F1.816
      if (!wildcard(matcher.executable, program.executable)) return false
      if (matcher.args && (matcher.args.length !== program.args.length || matcher.args.some((pattern, index) => !wildcard(pattern, program.args[index]!)))) return false
      const cwd = request.canonicalizePath?.(request.cwd, request.cwd) ?? resolve(request.cwd)
      return matcher.cwdRoot ? within(matcher.cwdRoot, cwd) : true
    }
    case 'bashPattern': {
      if (!carriesBashCommand(request)) return false
      const command = request.input.command
      if (typeof command !== 'string') return false
      // Claude prefix semantics with the rule action baked at compile. An
      // unparseable command is the documented prompt-anyway carve-out
      // (permissions.md:210), NOT a terminal deny — the hook `if` consumer
      // fails fully open through its own path instead.
      const result = matchClaudeBashRule(matcher.pattern, command, { ruleAction: matcher.action })
      if (result === 'unparseable') return PROMPT_ANYWAY
      return result === 'match'
    }
    case 'path': {
      const parameters = matcher.parameter ? [matcher.parameter] : PATH_PARAMETERS
      for (const parameter of parameters) {
        const value = request.input[parameter]
        if (typeof value !== 'string') continue
        const canonical = request.canonicalizePath?.(value, request.cwd) ?? resolve(request.cwd, value)
        if (within(matcher.root, canonical)) return true
      }
      return false
    }
    case 'pathGlob': {
      // P3.214 — a rule that does not govern this tool never matches it. Only
      // `Read` ALLOW rules carry the list today; see
      // `claude-permission-rules.ts` for what is on it and why.
      if (matcher.excludeTools?.includes(request.toolName)) return false
      const parameters = matcher.parameter ? [matcher.parameter] : PATH_PARAMETERS
      // Relative anchors resolve per request; the raw side keeps the
      // uncanonicalized cwd so a symlinked working directory still pairs the
      // raw path with the raw base (macOS /tmp → /private/tmp).
      const rawBase = matcher.base ?? resolve(request.cwd)
      const canonicalBase = matcher.base
        ?? (request.canonicalizePath?.(request.cwd, request.cwd) ?? resolve(request.cwd))
      const globMatches = (base: string, value: string): boolean => {
        const rel = relative(base, value)
        if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) return false
        return matchGitignoreGlob(matcher.pattern, rel.split(sep).join('/'), { anyDepth: matcher.anyDepth })
      }
      for (const parameter of parameters) {
        const value = request.input[parameter]
        if (typeof value !== 'string') continue
        // Symlink-pair asymmetry (permissions.md): allow needs the symlink
        // path AND its resolved target to match; deny/ask match on either.
        const canonical = request.canonicalizePath?.(value, request.cwd) ?? resolve(request.cwd, value)
        const raw = resolve(request.cwd, request.rawInputPath ?? value)
        const rawMatched = globMatches(rawBase, raw)
        const canonicalMatched = globMatches(canonicalBase, canonical)
        const matched = rule.action === 'allow'
          ? rawMatched && canonicalMatched
          : rawMatched || canonicalMatched
        if (matched) return true
      }
      return false
    }
    case 'powershell': {
      // One shell tool serves both languages here, so the PowerShell rule is
      // entitled to judge the commands the WIDE `looksLikePowerShell` reads as
      // PowerShell. `mode-manager` routes on a narrower one since UA12.104
      // (`looksLikePowerShellOutsidePosixTest`: `test 1 -eq 1` is bash there,
      // PowerShell here). A plain `ls` is never judged by a
      // `PowerShell(Get-ChildItem *)` rule, and `Get-Process | ls` always is.
      if (!carriesBashCommand(request)) return false
      const command = request.input.command
      if (typeof command !== 'string' || !looksLikePowerShell(command)) return false
      const result = matchClaudePowerShellRule(matcher.pattern, command, { ruleAction: matcher.action })
      // permissions.md:210's prompt-anyway carve-out, same as `bashPattern`:
      // an unparseable command asks rather than terminally denying.
      if (result === 'unparseable') return PROMPT_ANYWAY
      return result === 'match'
    }
    // `Cd` is not a model-invocable tool (permissions.md § Cd: "Claude can't
    // call it, and the rules apply only when you run `/cd` yourself"), so a Cd
    // rule never judges an ordinary tool call. `evaluateCdPermissionDslV1` is
    // its only evaluator, because Cd's allowlist mode is not deny/ask/allow
    // first-match semantics.
    case 'cdPath': return false
    case 'host': {
      const host = hostFromInput(request.input)
      return host ? matchesHost(matcher.host, host) : false
    }
    case 'mcp': {
      if (!request.toolName.startsWith('mcp__')) return false
      const [, server, ...toolParts] = request.toolName.split('__')
      return !!server && wildcard(matcher.server, server) && (!matcher.tool || wildcard(matcher.tool, toolParts.join('__')))
    }
    case 'agent': {
      if (request.semanticId !== 'agent-admission') return false
      return [request.input.agent, request.input.agent_key]
        .some(value => typeof value === 'string' && wildcard(matcher.agent, value))
    }
    case 'parameter': {
      // permissions.md § Match by input parameter: `*` in the value matches any
      // characters; a parameter the model omits is never matched; the
      // comparison uses the literal input value.
      const value = request.input[matcher.name]
      const scalar = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      if (matcher.matches !== undefined) return scalar && wildcard(matcher.matches, String(value))
      if (matcher.equals !== undefined) {
        // A permission rule STRING can only carry text, so
        // `Bash(dangerouslyDisableSandbox:true)` (sandboxing.md:135) and
        // `Bash(run_in_background:true)` (permissions.md:102) compile to
        // `equals: 'true'` and have to meet the BOOLEAN the tool input
        // carries — the same `String(value)` the wildcard branch already
        // used, and without it the documented examples never fire. A native
        // DSL document that declares a typed `equals` keeps strict equality.
        return typeof matcher.equals === 'string'
          ? scalar && String(value) === matcher.equals
          : value === matcher.equals
      }
      return matcher.oneOf?.includes(value as never) === true
    }
  }
}

/**
 * F1.1187 (origin the do-now adversarial review, 2026-09-29) — the fail-closed
 * answer of a policy that could not be compiled: `invalid-policy` under the
 * source that failed it, with THAT source's diagnostic as the reason.
 *
 * It was `program.diagnostics[0]`, the program's FIRST diagnostic. Since F1.831
 * an earlier document that was dropped whole leaves one there, so a workspace
 * source over the deny/ask rule cap (P2.269) behind a broken global document
 * refused every call with "... The global permission settings document was
 * ignored as a whole; every other permission document still applies": the
 * wrong file, contradicting the refusal it was attached to. Pi, and since
 * F1.1002 claude, codex and the Monitor gate, all show it through
 * {@link permissionDslDenyReason}; so does the Pi manifest's removal card
 * (`piWholeToolDenyRefusals`). The session notice still lists every diagnostic.
 * `match` carries the source only, as before.
 */
export function permissionDslInvalidPolicyDeny(
  invalid: NonNullable<CompiledPermissionDslV1['invalidSource']>,
): PermissionDslEvaluationV1 {
  const { diagnostic, ...source } = invalid
  return { action: 'deny', match: { ruleId: INVALID_POLICY_RULE_ID, ...source }, diagnostic }
}

export function evaluatePermissionDslV1(program: CompiledPermissionDslV1, request: PermissionDslRequestV1): PermissionDslEvaluationV1 {
  if (request.generation !== program.generation) {
    return { action: 'deny', diagnostic: { code: 'stale-generation', message: 'Permission DSL generation is stale.' } }
  }
  if (program.invalidSource) return permissionDslInvalidPolicyDeny(program.invalidSource)
  let selected: { rule: CompiledRule; action: PermissionDslAction } | undefined
  for (const rule of program.rules) {
    // P6.191 — auto mode's default-on suspension. `continue` rather than a
    // synthesized answer: the call carries on to the next rule and, finding
    // none, falls through to the mode's own classifier, which is what the page
    // means by "the classifier evaluates" it. A deny or ask rule is never
    // marked, so no restriction is lifted here.
    if (rule.broadShellGrant && request.suspendBroadShellGrants) continue
    // F1.377 — a path/host ALLOW never answers an MCP call; see `allowRuleOutsideItsFamily`.
    if (rule.action === 'allow' && allowRuleOutsideItsFamily(rule, request)) continue
    const matched = matchesRule(rule, request)
    if (matched === 'unsafe-shell') {
      return {
        action: 'deny',
        match: {
          ruleId: rule.id,
          scope: rule.scope,
          sourceDigest: rule.sourceDigest,
          ...(rule.text === undefined ? {} : { ruleText: rule.text }),
        },
        diagnostic: { code: 'invalid-document', message: unparseableStructuralBashDenyMessage(rule) }, // F1.863 — names the rule
      }
    }
    if (!matched) continue
    // The prompt-anyway carve-out enters selection as `ask`, so it can only
    // ever RAISE the outcome above an allow and can never lower a deny: a deny
    // rule that matches on its own terms still outranks it by ACTION_WEIGHT.
    const action = matched === PROMPT_ANYWAY ? 'ask' : rule.action
    if (!selected
      || ACTION_WEIGHT[action] > ACTION_WEIGHT[selected.action]
      || (ACTION_WEIGHT[action] === ACTION_WEIGHT[selected.action] && SCOPE_WEIGHT[rule.scope] > SCOPE_WEIGHT[selected.rule.scope])) {
      selected = { rule, action }
    }
  }
  if (selected) {
    // The carve-out's program-level half. A rule that never consults the
    // command text — a bare `Bash` allow, a `parameter` allow, a `path` allow —
    // cannot be entitled to approve a command the analysis could not read, so
    // an unparseable command downgrades a winning ALLOW to `ask`. See
    // `commandIsUnparseable` for the measured before/after and, more
    // importantly, for what this does NOT cover.
    //
    // Only ever consulted on an `allow`, so the extra parse is off the deny,
    // `ask` and no-match paths entirely; and a `bashPattern` allow that reached
    // here returned `'match'`, which means it parsed, so the recheck agrees
    // with the branch that already ran.
    const action = selected.action === 'allow' && commandIsUnparseable(request) ? 'ask' : selected.action
    return {
      action,
      match: {
        ruleId: selected.rule.id,
        scope: selected.rule.scope,
        sourceDigest: selected.rule.sourceDigest,
        ...(selected.rule.text === undefined ? {} : { ruleText: selected.rule.text }),
      },
    }
  }
  // Nothing decided, and a rule was SKIPPED because its specifier would not
  // compile. Report it WITHOUT an action — the skipped rule decides nothing,
  // whatever its action, and this must never become a compensating deny — but
  // say so on a request the rule was written to have an opinion about, because
  // a skip that announces nothing is the silent failure this whole row exists
  // to close.
  //
  // The reserved `invalid-policy` id is the carrier, and it is load-bearing
  // beyond the message: `evaluateClaudeHookIfFilter` compiles a ONE-RULE allow
  // program and reads exactly this id to detect an uncompilable `if` rule.
  // Without it that filter sees an empty program, no match, and `run: false` —
  // silently breaking hooks.md's documented fail-open. The other two consumers
  // of the id (`SessionManager`'s Monitor gate, `codex-agent`'s answer path)
  // both test `action` before reading `match`, so an actionless report reaches
  // them as the ordinary "no rule matched" it is.
  //
  // Only the FIRST skipped document (F1.831), else rule, is named here;
  // `program.diagnostics` carries one warning for every one of them.
  const dropped = program.droppedSources?.[0] ?? program.droppedRules[0]
  return dropped
    ? {
        match: { ruleId: 'invalid-policy', scope: dropped.scope, sourceDigest: dropped.sourceDigest },
        diagnostic: dropped.diagnostic,
      }
    : {}
}

/**
 * Strip control characters out of a name that came from a settings file.
 *
 * A rule string is DATA an operator (or a repository) wrote, and it lands in a
 * refusal that is rendered to a terminal, a log line and the model's transcript.
 * A newline or an escape sequence in it would forge structure in all three.
 * Written as a scan rather than a control-character regex so no lint rule has to
 * be suppressed to keep it.
 */
function displaySafeName(value: string): string {
  let out = ''
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    out += code < 0x20 || code === 0x7F ? ' ' : character
  }
  return out.trim()
}

/**
 * P2.445 — the clause a refusal appends so it names WHICH rule decided and
 * WHERE that rule came from. Empty string when no rule matched, so a caller can
 * keep its unnamed sentence unchanged.
 *
 * **The rule** is named by its own text when it has one and by its id when it
 * does not; see {@link PermissionDslRuleV1.text} for why the id alone is not an
 * identifier the user can search for.
 *
 * **The scope** is named because on Pi more than one scope genuinely can
 * produce the rule — the merged policy compiles all five
 * ({@link PermissionDslScope}), which is precisely the condition P2.400 found
 * ABSENT on codex, where every projected rule already carried one constant
 * scope and a parameter would have threaded it for nothing.
 *
 * The scope's own word is used rather than a friendlier product name on
 * purpose: the five do not map one-to-one onto any documented settings tier
 * (`global` is the app's own `permissions/default.json` as well as global-scope
 * settings; `workspace` also carries session rules), so a nicer noun would be a
 * guess, and this token is the one every diagnostic and every code path already
 * uses.
 */
export function describePermissionDslMatch(match: PermissionDslMatchV1 | undefined): string {
  if (!match) return ''
  return describeRuleAndScope(match.ruleText ?? match.ruleId, match.scope)
}

/**
 * The one place the clause is SPELLED — backticks, the word `rule`, the word
 * `scope`, and the unnamed fallback.
 *
 * Extracted by P2.469 because it now has a second caller
 * ({@link describeCdPermissionDslMatch}) and because a copy of this format is
 * exactly what went stale elsewhere: a hard-coded refusal sentence in
 * `session-mcp-server`'s wire test drifted two generations behind this function
 * while looking, to every reader, like the sentence the host produces (P2.470).
 * Every renderer of a readable-policy decision goes through here, so the format
 * moves in one edit or not at all, and
 * `permission-refusal-single-seam.test.ts` pins that claim rather than leaving
 * it as prose: all five exported renderers are asserted to emit the identical
 * clause for one rule.
 *
 * ## P6.210 — there is NO setting that turns this naming off, and the row that
 * asked for one rests on a misreading. Measured 2026-09-07; recorded here
 * because this function is the single place such a switch could ever go.
 *
 * The row named `permissionExplainerEnabled` as the key to reach parity with.
 * That key governs something else entirely, and it is GONE upstream.
 * `settings-reference.md#permissionexplainerenabled` (anchor confirmed on the
 * rendered page) — "Removed in v2.1.257, together with the `Ctrl+E` command
 * explanation on Bash and PowerShell permission prompts. Setting it has no
 * effect on current versions." and "Through v2.1.256, you could press `Ctrl+E`
 * on a Bash or PowerShell permission prompt to see a model-generated
 * explanation of the command, and set this key to `false` to turn that shortcut
 * off." So it gated an LLM CALL behind a keystroke; it never governed whether a
 * refusal names the rule that produced it.
 *
 * The shipped binary agrees, and it also CORRECTS the row's own probe. The row
 * recorded `permissionExplainerEnabled` at zero occurrences in `sdk.mjs`,
 * `bridge.mjs` and `sdk.d.ts` and concluded the key "is NOT in the vendored
 * bundle at all". Those three are the JS shim. In the native binary this repo
 * actually runs (`@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`,
 * self-reporting `2.1.247`) the name is still there — re-measured 2026-09-12
 * (C3.252) at 3 lines / 3 occurrences, with `Explainer` at 1/1 and `Ctrl+E` at
 * 3/3 against a `zzznonsensecontrolzzz` control of 0/0; both instruments are
 * named because they disagree on a minified artefact (C3.294), and the
 * superseded reading was "FIVE … six … three" at `2.1.233`. It
 * sits in the global-config key array beside `copyFullResponse`,
 * `copyOnSelect`, `leftArrowOpensAgents` and `defaultToAgentsView` (per-user TUI
 * preferences, the `Global config` scope the page states), and its one reader is
 * `function TZi(){return nr().permissionExplainerEnabled!==!1}`, guarding a
 * request whose prompt ends "Explain this command in context.". So it is not
 * bundle-lag either: our bundle predates the removal and carries it.
 *
 * Consequence, and it is a decision NOT to build: a host toggle under that name
 * would import a deleted key bound to a different meaning, in order to switch
 * off the very explanation P2.445 / P2.459 / P2.469 landed three commits to
 * create. Whether an operator should be able to suppress a MANAGED rule's text
 * — the one real need, since rule strings can carry internal paths and hosts —
 * is a product posture, so it is the owner's call and not a lane's. If it is
 * ever taken, it is one branch here: return the `a rule (<scope> scope)` form
 * the empty-name case already produces, which every caller already renders. The
 * layer survives; only the operator's own string is withheld.
 */
function describeRuleAndScope(name: string, scope: PermissionDslScope): string {
  const safe = displaySafeName(name)
  return safe.length === 0
    ? `a rule (${scope} scope)`
    : `rule \`${safe}\` (${scope} scope)`
}

/**
 * The sentence a host shows when the readable permission policy DENIED a call.
 *
 * A compiler diagnostic still wins, unchanged: it already says far more than a
 * rule name can (which source failed, which limit, what to fix), and it is the
 * message the invalid-policy and dropped-rule paths exist to deliver.
 */
export function permissionDslDenyReason(evaluation: PermissionDslEvaluationV1): string {
  if (evaluation.diagnostic?.message) return evaluation.diagnostic.message
  const named = describePermissionDslMatch(evaluation.match)
  return named.length === 0
    ? 'Denied by readable permission policy.'
    : `Denied by readable permission policy ${named}.`
}

/** The sentence a host shows when the readable permission policy ASKS. */
export function permissionDslAskReason(evaluation: PermissionDslEvaluationV1): string {
  const named = describePermissionDslMatch(evaluation.match)
  return named.length === 0
    ? 'Readable permission policy requires approval.'
    : `Readable permission policy ${named} requires approval.`
}

/** The working-directory move a `Cd` rule judges. */
export interface CdPermissionRequestV1 {
  /** The resolved (canonical) target directory, absolute. */
  path: string
  /**
   * Every other spelling of the same target — the raw user input and each
   * symlink hop it resolves through. permissions.md § Cd: "Deny rules check
   * every spelling of the target, including each symlink hop it resolves
   * through, so a rule written for one path also blocks targets that resolve
   * to it."
   */
  alternatePaths?: readonly string[]
  /** Directory a relative Cd pattern resolves against. */
  cwd: string
}

export interface CdPermissionEvaluationV1 {
  /** `prompt` is the documented default: "/cd keeps its default behavior". */
  decision: 'allow' | 'deny' | 'prompt'
  ruleId?: string
  scope?: PermissionDslScope
  /**
   * P2.469 — the matched rule's own text when it has one, the carrier P2.445
   * deliberately left off this interface because nothing read it yet. Its
   * expiry condition was met the moment the `Cd` refusal was measured to render
   * in two places: an operator log that named the internal positional id and
   * dropped the scope beside it, and a user-facing sentence that named nothing
   * at all. Same contract as {@link PermissionDslMatchV1.ruleText} — DISPLAY
   * ONLY, nothing matches or keys on it, and absent on the synthetic
   * `invalid-policy` report, which names no rule anybody wrote.
   */
  ruleText?: string
  /** Set when the refusal came from allowlist mode rather than a deny rule. */
  allowlistRefusal?: true
}

/**
 * The synthetic `ruleId` the two invalid-policy reports carry. It is NOT a rule
 * anybody wrote, so no renderer may name it: the tool gate is protected by
 * {@link permissionDslDenyReason} preferring the diagnostic, and the `Cd` gate —
 * which has no diagnostic to prefer — is protected by
 * {@link describeCdPermissionDslMatch} refusing it explicitly.
 */
const INVALID_POLICY_RULE_ID = 'invalid-policy'

function matchesCdRule(matcher: CompiledMatcher, request: CdPermissionRequestV1): boolean {
  // A bare `Cd` rule is a whole-tool rule: "A bare `Cd` deny rule disables
  // `/cd` entirely", and symmetrically a bare allow admits every target.
  if (matcher.kind === 'tool') return wildcard(matcher.semanticId, 'Cd')
  if (matcher.kind !== 'cdPath') return false
  const base = matcher.base ?? resolve(request.cwd)
  const spellings = [request.path, ...(request.alternatePaths ?? [])]
  return spellings.some(spelling => {
    const target = resolve(request.cwd, spelling)
    const rel = relative(base, target)
    if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) return false
    return matchGitignoreGlob(matcher.pattern, rel.split(sep).join('/'), {
      anyDepth: false,
      bareLiteralFloat: false,
    })
  })
}

function isCdRule(rule: CompiledRule): boolean {
  return rule.matcher.kind === 'cdPath'
    || (rule.matcher.kind === 'tool' && wildcard(rule.matcher.semanticId, 'Cd'))
}

/**
 * Decide one working-directory move against the program's `Cd` rules
 * (permissions.md § Cd).
 *
 * Not the ordinary deny/ask/allow first-match evaluator, because `Cd` has a
 * mode the other tools do not: "Adding any `Cd` allow rule switches `/cd` to
 * allowlist mode: the resolved target directory must match one of your allow
 * rules, or `/cd` refuses. With no `Cd` rules configured, `/cd` keeps its
 * default behavior and prompts you to trust an unfamiliar directory."
 *
 * Order: a matching deny refuses; otherwise allowlist mode refuses an unmatched
 * target; otherwise a matching ask prompts, which is also what an unruled
 * session does. An ask rule therefore never enables allowlist mode and never
 * grants — the same "only restricts" property the docs give ask everywhere else.
 */
export function evaluateCdPermissionDslV1(
  program: CompiledPermissionDslV1,
  request: CdPermissionRequestV1,
): CdPermissionEvaluationV1 {
  if (program.invalidSource) {
    return { decision: 'deny', ruleId: INVALID_POLICY_RULE_ID, scope: program.invalidSource.scope }
  }
  const rules = program.rules.filter(isCdRule)
  if (rules.length === 0) return { decision: 'prompt' }
  let allowlist = false
  let matchedAllow: CompiledRule | undefined
  let matchedAsk: CompiledRule | undefined
  for (const rule of rules) {
    if (rule.action === 'allow') allowlist = true
    if (!matchesCdRule(rule.matcher, request)) continue
    if (rule.action === 'deny') return { decision: 'deny', ...cdRuleIdentity(rule) }
    // A rule the compiler skipped is not in `program.rules` at all, so it does
    // not reach this loop and — deliberately — does not switch allowlist mode
    // on either. A `Cd` allow nobody could read is not "any Cd allow rule".
    if (rule.action === 'ask') matchedAsk ??= rule
    else matchedAllow ??= rule
  }
  if (allowlist && !matchedAllow) {
    return { decision: 'deny', allowlistRefusal: true }
  }
  if (matchedAsk) return { decision: 'prompt', ...cdRuleIdentity(matchedAsk) }
  return matchedAllow
    ? { decision: 'allow', ...cdRuleIdentity(matchedAllow) }
    : { decision: 'prompt' }
}

/** The identity every `Cd` verdict reports: the join key, the scope, the name. */
function cdRuleIdentity(rule: CompiledRule): Pick<CdPermissionEvaluationV1, 'ruleId' | 'scope' | 'ruleText'> {
  return {
    ruleId: rule.id,
    scope: rule.scope,
    ...(rule.text === undefined ? {} : { ruleText: rule.text }),
  }
}

/**
 * P2.469 — the clause a `Cd` refusal appends so it names WHICH rule refused the
 * move and WHERE that rule came from, rendered by the same
 * {@link describeRuleAndScope} every other readable-policy refusal uses.
 *
 * Empty string in the three cases where naming a rule would be a lie: no rule
 * matched (allowlist mode refused, and that is a different sentence), and the
 * synthetic {@link INVALID_POLICY_RULE_ID} report, whose id is the one handle
 * P2.445 measured that no user has ever seen. The tool gate never needed this
 * guard because {@link permissionDslDenyReason} prefers its diagnostic; the `Cd`
 * evaluation carries no diagnostic, so the guard lives here instead.
 */
export function describeCdPermissionDslMatch(evaluation: CdPermissionEvaluationV1): string {
  if (evaluation.scope === undefined || evaluation.ruleId === undefined) return ''
  if (evaluation.ruleId === INVALID_POLICY_RULE_ID) return ''
  return describeRuleAndScope(evaluation.ruleText ?? evaluation.ruleId, evaluation.scope)
}

/**
 * The sentence a host shows a user whose `/cd` a `Cd` rule refused.
 *
 * Four outcomes, each naming something the user can act on, and the ordering is
 * the one three rows have now pinned — the POLICY's own failure outranks any
 * rule, because a rule that could not be compiled did not refuse anything:
 *
 *   1. the policy did not compile      → the scope whose file to fix
 *   2. allowlist mode, nothing matched → the mechanism, since no rule refused
 *   3. a deny rule matched             → that rule's own string and its scope
 *   4. neither, which the evaluator cannot currently produce → the sentence
 *      this site shipped with, kept so a future `deny` path that reports no
 *      identity degrades to today's behaviour rather than to `undefined`.
 */
export function cdPermissionDslDenyReason(evaluation: CdPermissionEvaluationV1): string {
  if (evaluation.ruleId === INVALID_POLICY_RULE_ID) {
    return `This directory is blocked because the permission policy is invalid (${evaluation.scope} scope).`
  }
  if (evaluation.allowlistRefusal) {
    return 'This directory is blocked because Cd permission rules allow only specific directories and none matches this one.'
  }
  const named = describeCdPermissionDslMatch(evaluation)
  return named.length === 0
    ? 'This directory is blocked by a Cd permission rule.'
    : `This directory is blocked by Cd permission ${named}.`
}

export function isWholeCapabilityDeniedByPermissionDsl(program: CompiledPermissionDslV1, semanticId: string): boolean {
  if (program.invalidSource) return true
  // A skipped rule is absent from `program.rules`, so it cannot wholly deny a
  // capability here either — the same answer the gate gives it. Removal and
  // enforcement stay in agreement precisely because both read `rules`.
  return program.rules.some(rule => rule.action === 'deny'
    && rule.matcher.kind === 'tool'
    && wildcard(rule.matcher.semanticId, semanticId))
}

export interface CapabilityIdentityForDenyFilter {
  bindingName: string
  piName: string
  semanticId: string
  /**
   * The canonical permission name — the spelling the gate evaluates as
   * `toolName`, and the one permissions.md means by "the tool name". Without
   * it a bare `deny Bash` matched nothing here (the binding spells itself
   * `bash`), so the gate denied every call while the schema stayed in context.
   */
  permissionName: string
}

/**
 * Whether ONE deny rule is a whole-tool rule that reaches this tool — the
 * forms permissions.md removes from the model's context rather than merely
 * gating.
 *
 * The spellings mirror the gate exactly (`matchesRule`), because removal that
 * disagrees with enforcement is a new defect in either direction: a tool the
 * gate would still admit must stay advertised, and a tool the gate denies in
 * every possible call must not.
 */
function isWholeToolDenyForIdentity(matcher: CompiledMatcher, identity: CapabilityIdentityForDenyFilter): boolean {
  switch (matcher.kind) {
    // permissions.md:70 — "Permission rules follow the format `Tool` or
    // `Tool(specifier)`" — and :142's tool-name globs. The gate compares a
    // tool rule against the request's semanticId and toolName; both spellings
    // belong here, plus the binding names our own manifest keys on.
    case 'tool':
      return [identity.semanticId, identity.permissionName, identity.bindingName, identity.piName]
        .some(value => wildcard(matcher.semanticId, value))
    // permissions.md:142 — "`mcp__*` matches every MCP tool across all
    // servers" — and a bare `mcp__server__tool` is a tool name with no
    // specifier. Matched against permissionName ALONE, the name this identity
    // carries. F1.478: Pi's call site ALSO runs this filter under claude's name
    // for a claude-visible session tool (`TodoWrite` is `mcp__session__TodoWrite`
    // there), so `mcp__*` removes it as on claude; see session-tool-rule-alias.ts.
    case 'mcp': {
      if (!identity.permissionName.startsWith('mcp__')) return false
      const [, server, ...toolParts] = identity.permissionName.split('__')
      return !!server && wildcard(matcher.server, server)
        && (!matcher.tool || wildcard(matcher.tool, toolParts.join('__')))
    }
    // permissions.md:82 — "`Bash(*)` is equivalent to `Bash` and matches all
    // Bash commands. As a deny rule, both forms remove the tool from Claude's
    // context." Only the bare `*` pattern: any narrower pattern is a
    // specifier, which gates without removing. Monitor is deliberately absent
    // even though its `command` source inherits Bash rules — its `ws` source
    // carries no command, so no Bash rule can deny every Monitor call.
    case 'bashPattern':
      return matcher.pattern.trim() === '*' && identity.permissionName === 'Bash'
    default:
      return false
  }
}

/**
 * Applies whole-tool (bare-name / tool-glob) deny rules to a manifest tool
 * list, honouring the documented EndConversation exception (permissions.md,
 * R1 follow-up): a deny rule cannot remove EndConversation while any other
 * tool remains — alone, it is removable like any other tool. The companion
 * "an ask rule never prompts for it" is enforced at the prompt band, which
 * never fires for EndConversation.
 */
export function filterCapabilityIdentitiesByWholeToolDeny<T extends CapabilityIdentityForDenyFilter>(
  identities: readonly T[],
  program: CompiledPermissionDslV1,
): T[] {
  // An unusable policy denies everything at the gate, so it advertises nothing
  // — the same fail-closed posture `isWholeCapabilityDeniedByPermissionDsl`
  // takes, kept here so the EndConversation exception still applies.
  const denied = (identity: CapabilityIdentityForDenyFilter): boolean => program.invalidSource !== undefined
    || program.rules.some(rule => rule.action === 'deny' && isWholeToolDenyForIdentity(rule.matcher, identity))
  const kept = identities.filter(identity => !denied(identity))
  if (kept.length === 0) return kept
  const guarded = identities.filter(identity => !kept.includes(identity)
    && [identity.semanticId, identity.permissionName, identity.bindingName, identity.piName].includes('EndConversation'))
  return guarded.length > 0 ? [...kept, ...guarded] : kept
}

/**
 * F1.377 (origin WJ-hh verifier on F1.272, 2026-09-23; DECIDED by the controller
 * the same day) — the matcher kinds whose ALLOW answers only their own built-in
 * tool family: a `Read`/`Edit` path rule (`pathGlob`), a native `path` root and a
 * `WebFetch(domain:)` host rule. Each reads a `path`/`file_path`/`cwd`/
 * `workingDirectory`/`url` input and, on its own terms, cannot tell WHICH tool
 * carried it — so once F1.272 routed codex's MCP tool-call approval through the
 * rules, `Read(./src/**)` pre-approved `fs__delete_file{path:'src/a.ts'}` and
 * `Read(./**)` pre-approved `shell__run{command:'rm -rf ~', cwd:'src'}`, on codex
 * and on Pi's own gate alike.
 *
 * `permissions.md#read-and-edit`, verbatim: "`Edit` rules apply to all built-in
 * tools that edit files. Claude makes a best-effort attempt to apply `Read`
 * rules to all built-in tools that read files like Grep and Glob"; and
 * `permissions.md#mcp`, on the one place the page lets a built-in rule reach an
 * MCP tool at all: "Allow rules don't carry over: Claude Code never applies a
 * `Bash` allow rule to `mcp__workspace__bash`." (fetched 2026-09-23).
 *
 * DENY and ASK are untouched: a `Read(./secrets/**)` deny still refuses an MCP
 * call that names that path — wider is the safe direction, and it is the one the
 * P3.214 deny half already takes.
 *
 * What counts as an MCP call: the `mcp_dynamic` descriptor (Pi's pool tools,
 * codex's MCP tool-call projection, the nestor-cloud adapter) or a name in the
 * `mcp__` family (codex's `mcp__session__*`, and a caller such as the skill-grant
 * check that passes the lowered tool name as its `semanticId`). Pi's own session
 * tools carry their built-in names (`Monitor`, `SendUserFile`), so F1.463 adds
 * them by their binding identity — see `isSessionToolPermissionRequest`.
 */
const FAMILY_BOUND_ALLOW_MATCHERS: ReadonlySet<CompiledMatcher['kind']> = new Set(['pathGlob', 'path', 'host'])

/** An MCP tool call, in either spelling a caller hands the DSL (see above). */
export function isMcpPermissionRequest(request: Pick<PermissionDslRequestV1, 'semanticId' | 'toolName'>): boolean {
  return request.semanticId === 'mcp_dynamic' || request.toolName.startsWith('mcp__')
}

function allowRuleOutsideItsFamily(rule: CompiledRule, request: PermissionDslRequestV1): boolean {
  return FAMILY_BOUND_ALLOW_MATCHERS.has(rule.matcher.kind)
    && request.pathAllowReachesMcpTools !== true
    && (isMcpPermissionRequest(request) || isSessionToolPermissionRequest(request))
}

// Declaration merge, appended here so no line cited above moves (the field
// belongs to the request interface declared near the top of this file).
export interface PermissionDslRequestV1 {
  /**
   * F1.377 — set ONLY by the hook `if` filter (`evaluateClaudeHookIfFilter`),
   * whose documented posture is to over-fire: a best-effort filter that runs a
   * hook on an MCP call its `Edit(src/**)` condition names by path fails in the
   * open direction. Every permission gate leaves it absent, so a path/host ALLOW
   * never answers an MCP call — nor, since F1.463, a session tool — there.
   */
  pathAllowReachesMcpTools?: boolean
}

/**
 * F1.463 (origin P-WJ-oo-1, F1.377's residue) — a SESSION tool, named by its Pi
 * binding identity: the `(permissionName, descriptorId)` pair Pi's gate passes as
 * `(toolName, semanticId)` and codex's F1.379 alias passes for `mcp__session__*`.
 * The pair rather than either half, so a built-in that shares one spelling with a
 * session tool can never be swept in (none does today — measured 2026-09-24 over
 * `PI_TOOL_BINDINGS`: 57 session bindings, 22 others, no name or id in common).
 *
 * Why the session family is outside a path/host ALLOW: `permissions.md#read-and-edit`
 * scopes Read and Edit rules to built-in tools that read or edit FILES, and
 * `tools-reference.md` says an `EnterWorktree` path "prompts for your approval
 * before entering, since it moves the session's working directory and write
 * access to that location" (both fetched 2026-09-24). Before this, `Read(./**)`
 * pre-approved `EnterWorktree{path}` and `spawn_session{workingDirectory}` — the
 * two of the 61 session tools with a top-level path-like input — on Pi by name and
 * on codex through the alias. Deny and ask still match, as for an MCP call.
 */
export function isSessionToolPermissionRequest(request: Pick<PermissionDslRequestV1, 'semanticId' | 'toolName'>): boolean {
  return SESSION_TOOL_BINDING_IDENTITIES.has(`${request.toolName}|${request.semanticId}`)
}

const SESSION_TOOL_BINDING_IDENTITIES: ReadonlySet<string> = new Set(
  PI_TOOL_BINDINGS
    .filter(binding => binding.bindingName.startsWith('mcp__session__'))
    .map(binding => `${binding.permissionName}|${binding.descriptorId}`),
)

// F1.463 — imported at the end so every line cited above keeps its place.
import { PI_TOOL_BINDINGS } from './harness-tool-descriptor.ts'

/**
 * F1.784 — what a command the structural tokenizer cannot split (`;`, `>>`,
 * `&&`, `$(…)`, a glob) means for ONE native structural `bash` rule
 * (`{ kind: 'bash', executable, args? }`, the shape codex's Always allow writes
 * through `mergeExecpolicyAllowGrant`). Read from `matchesRule`'s `case 'bash'`.
 *
 * The structural rule cannot tell whether such a command is about its program
 * at all, so the rule's ACTION decides what the unreadable command means for it:
 *
 * - `deny` — since F1.816 (owner decision 2026-09-26, option a) the command's
 *   SUBCOMMANDS decide, read by the Claude analysis that already judges a
 *   `Bash(…)` rule ({@link structuralSubcommandVerdict}): one that runs the
 *   rule's program is the rule's MATCH, refused exactly as a bare match is
 *   (its `cwdRoot` included); none that does is no match; a command the Claude
 *   analysis cannot read either is {@link PROMPT_ANYWAY}, as for a `Bash(…)`
 *   rule (`permissions.md#compound-commands`: "Deny and ask rules apply when
 *   any subcommand matches them"). A rule for EVERY program (`executable: '*'`)
 *   keeps the terminal `'unsafe-shell'` refusal: whatever runs is its program.
 *   Until F1.816 every named deny refused every such command too, so one
 *   `touch` deny refused a user's `printf …; true` hook in every mode.
 * - `ask` — since F1.1245 the same subcommand reading as `deny`, and the page's
 *   sentence names both actions: a subcommand that runs the program is the rule's
 *   match (a prompt naming the rule), none is no match, an unreadable command is
 *   {@link PROMPT_ANYWAY}; an every-program ask is {@link PROMPT_ANYWAY}, never a
 *   refusal. Until F1.1245 every such command asked, so one workspace ask for
 *   `touch sit2b-ask.txt` carded every compound Bash on claude in Bypass (SIT2-b).
 * - `allow` — no match. The rule may not APPROVE what it cannot read, and it
 *   has no business REFUSING it either: evaluation falls through to the next
 *   rule and then to the permission mode's own default, which is exactly what
 *   the same command meets with no rule at all. A winning allow from another
 *   rule is still downgraded by {@link commandIsUnparseable} where the Claude
 *   analysis cannot read the command either.
 *
 * Before this, every action returned the terminal refusal. One Always-allow for
 * an unrelated program therefore turned every compound command into a hard deny
 * in every mode, `bypassPermissions` included: a user's own UserPromptSubmit
 * command hook dropped every prompt (release sitting SIT-l), and the model's own
 * `echo a; echo b` was blocked at the Pi gate and on codex's rule answer path
 * (measured by this row before the fix). The tokenizer is unchanged, and a
 * command it CAN split is judged by every rule exactly as before.
 */
function unparseableStructuralBashVerdict(
  action: PermissionDslAction,
  matcher: StructuralBashMatcher,
  command: string,
  request: PermissionDslRequestV1,
): boolean | typeof PROMPT_ANYWAY | 'unsafe-shell' {
  if (action === 'allow') return false
  if (/^\*+$/u.test(matcher.executable)) return action === 'deny' ? 'unsafe-shell' : PROMPT_ANYWAY
  const verdict = structuralSubcommandVerdict(matcher, command, action)
  if (verdict !== 'match') return verdict === 'unparseable' ? PROMPT_ANYWAY : false
  const cwd = request.canonicalizePath?.(request.cwd, request.cwd) ?? resolve(request.cwd)
  return matcher.cwdRoot ? within(matcher.cwdRoot, cwd) : true
}

type StructuralBashMatcher = Extract<CompiledMatcher, { kind: 'bash' }>

/**
 * F1.816 — whether any subcommand of `command` runs a structural `bash` DENY
 * (since F1.1245 also ASK) rule's program, asked through {@link matchClaudeBashRule}'s deny/ask reading (every
 * subcommand, inside `$(…)`, subshells, `sh -c` scripts and control-flow bodies)
 * with the rule spelled as the Claude pattern `<executable> <args…> *`. No new
 * parse: the same analysis a `Bash(touch *)` deny already gets.
 *
 * Two readings, both toward refusing (or asking) more, since the rule is a deny or an ask:
 * - the trailing ` *` also refuses the program with MORE args than a rule with
 *   `args` lists (`git fetch && git push origin` under a `git push` deny), where
 *   a bare command must match the list exactly.
 * - the same pattern is asked a second time behind a `*` and a slash, because
 *   the structural matcher reads the program's BASENAME ({@link shellProgram}),
 *   so `a; /usr/bin/touch x` runs its program; the Claude pattern alone compares
 *   the head as written. That `*` also spans an argument ending in the program's
 *   path (`cat src/touch; true`) — a rare extra refusal, stated, not hidden.
 *
 * Residue, the same as a `Bash(<program> *)` deny's (`permissions.md#bash-rule-limits`:
 * the rule "isn't a security boundary around the program"): a quoted or escaped
 * program name (`a; 'touch' x`, `a; \touch x`) and `exec touch x` are not read
 * as the program inside a compound. The bare command still is, structurally.
 */
function structuralSubcommandVerdict(matcher: StructuralBashMatcher, command: string, ruleAction: 'deny' | 'ask'): ReturnType<typeof matchClaudeBashRule> {
  const words = [matcher.executable, ...(matcher.args ?? [])].join(' ')
  const verdicts = [`${words} *`, `*/${words} *`].map(pattern => matchClaudeBashRule(pattern, command, { ruleAction }))
  // The split is pattern-independent, so `'unparseable'` is both answers or neither.
  return verdicts.includes('match') ? 'match' : verdicts[0]!
}

/**
 * F1.863 — the sentence a structural `bash` DENY rule's terminal `'unsafe-shell'`
 * refusal carries ({@link unparseableStructuralBashVerdict}'s `deny` arm).
 *
 * The refusal is unchanged and stays conservative: the command could not be
 * split, so it might run the denied program. What changed is that it NAMES the
 * rule, its scope and the program it could not rule out — as a bare match of
 * the program already did through {@link permissionDslDenyReason}, and in the
 * same clause ({@link describeRuleAndScope}). Before this the only words were
 * "Shell command contains unsafe or unsupported syntax.", so in release sitting
 * SIT-x one `touch` deny rule refused a user's `printf …; true` hook and the
 * model's own `touch x; echo y` with nothing saying which rule, and the model
 * found `sitx-deny-touch` by bisecting.
 *
 * The program is named only when the rule's `executable` is a plain name; a
 * wildcard reads as "a program it denies". Since F1.816 only a rule for EVERY
 * program reaches this sentence (a named one reads the subcommands and refuses
 * with the bare-match sentence), so it reads the wildcard way in practice. The
 * command itself is never echoed — the same rule every other readable-policy
 * refusal keeps.
 */
function unparseableStructuralBashDenyMessage(rule: CompiledRule): string {
  const executable = rule.matcher.kind === 'bash' ? displaySafeName(rule.matcher.executable) : ''
  const program = executable.length > 0 && !/[*?[\]{}]/.test(executable) ? `\`${executable}\`` : 'a program it denies'
  return `Denied by readable permission policy ${describeRuleAndScope(rule.text ?? rule.id, rule.scope)}: `
    + `the shell command contains unsafe or unsupported syntax, so the rule cannot tell whether it runs ${program}.`
}

/**
 * F1.824 — the request AS WRITTEN, when a structural `bash` rule literally names
 * that exact login-shell invocation; `null` otherwise, and `matchesRule` unwraps
 * as before.
 *
 * {@link shellProgram} unwraps `<bash|zsh|sh> -c|-lc '<script>'` on the REQUEST
 * side only, so a rule that itself names the wrapper never matched anything.
 * Codex mints exactly such rules: its `proposedExecpolicyAmendment` stays the
 * whole wrapped argv whenever its own parser refuses to split the script
 * (`parse_shell_lc_plain_commands` rejects a bare word containing `~`, `*`, `$`
 * and others — `codex-rs/shell-command/src/bash.rs`, `rust-v0.156.1`), and
 * `mergeExecpolicyAllowGrant` persists it unchanged, so codex's own projection
 * keeps codex's own prefix. Before this, an Always Allow on `rm -rf ~/x` minted
 * `/bin/zsh -lc 'rm -rf ~/x'`, which the host's rule consult compared with the
 * unwrapped `rm` and never matched: fail-closed, the card asked again.
 *
 * LITERAL on purpose, the one place this matcher does not glob: the arm exists
 * for a rule naming one exact invocation, and a wildcard here would turn a
 * hand-written `/bin/zsh -lc *` into an approval of every codex command. Only a
 * rule of exactly `[-c|-lc, <one script>]` on a bash, zsh or sh executable takes
 * it, and it is tried AHEAD of the unwrap, never instead of it: a rule that
 * misses here meets the unchanged path, so a DENY keeps F1.784's unparseable
 * refusal and only gains the exact spelling it names. Residue: a command the
 * tokenizer refuses outright (a newline, `$(`, a backtick) is not read here
 * either, so such a grant still asks.
 *
 * F1.823 — codex's rule projection now unwraps its transport once
 * ({@link loginShellScript}), so the request a codex frame hands this matcher is
 * the SCRIPT, and the arm also takes a request that is, literally and whole, the
 * script the rule names. Same literalness: a `*` in that script is compared as
 * text, so the wildcard boundary above holds. On Pi the same rule now also
 * answers the bare script it names; the grant approved exactly that command.
 */
function loginShellInvocationAsWritten(
  matcher: { executable: string; args?: readonly string[] },
  command: string,
): { executable: string; args: string[] } | null {
  const args = matcher.args
  if (!args || args.length !== 2 || !isShellScriptInvocation(matcher.executable, args[0])) return null
  if (command === args[1]) return { executable: matcher.executable, args: [...args] } // F1.823 — the projected script
  const tokens = tokenizeShell(command)
  if (!tokens || tokens.length !== 3 || tokens[0] !== matcher.executable || tokens[1] !== args[0] || tokens[2] !== args[1]) return null
  return { executable: tokens[0], args: tokens.slice(1) }
}

/**
 * F1.831 (owner option A, 2026-09-26) — one layer that cannot be READ (a parse
 * diagnostic, a wrong shape, an unknown matcher or field, a stale generation) is
 * dropped WHOLE, and every other document keeps applying.
 *
 * `managed-settings.md#keys-that-fail-closed`, verbatim: "User, project, and
 * local settings files remain strict: a file whose JSON or top-level shape fails
 * validation is rejected as a whole and reported, and an individual entry that
 * fails, such as a malformed permission rule, is skipped with a warning while the
 * rest of the file applies." The per-ENTRY half is {@link DroppedRule}; this is the
 * per-FILE half. Until F1.831 one broken document set `invalidSource` for the
 * whole program: Pi refused every call, and claude and codex (which read an
 * `invalid-policy` deny as "not consulted") enforced no readable rule at all, so a
 * typo in a workspace `permissions.json` switched a managed deny off there.
 *
 * - A MANAGED document still fails everything closed and returns the
 *   `invalidSource` to keep — the same page on a managed file that "can't be
 *   parsed as a JSON object": Claude Code "refuses to start". (In practice
 *   `managed-policy.ts` validates the delivered document first; a `builtin`
 *   capability layer maps to `managed` too.)
 * - What the layer compiled BEFORE it failed is cut away by POSITION (`mark`),
 *   not by `sourceDigest`: two identical plugin files share one digest, and the
 *   twin must keep its rules. Its per-rule warnings go too — the file-level one
 *   replaces them, since none of those rules applies any more.
 * - The warning names the settings tier (the file to fix). It reaches the debug
 *   line and, joined to its scope by `reportPermissionDslDiagnostics`, the
 *   session notice every runtime shows; {@link evaluatePermissionDslV1}'s tail
 *   announces it on a call nothing decided, under the reserved `invalid-policy`
 *   id WITHOUT an action, exactly like a dropped rule.
 * - The cost, stated in the decision: on Pi a broken file no longer blocks
 *   everything; it loses only its own rules, as on Claude.
 * - NOT covered: the P2.269 deny/ask rule-cap overflow keeps failing closed —
 *   dropping that document would widen the policy to fit a limit of our own.
 */
function dropUnreadablePermissionDslLayer(
  layer: PermissionDslLayerInputV1,
  diagnostic: PermissionDslDiagnosticV1,
  mark: readonly [rules: number, droppedRules: number, diagnostics: number],
  sinks: { rules: CompiledRule[]; droppedRules: DroppedRule[]; diagnostics: PermissionDslDiagnosticV1[]; droppedSources: Array<Omit<DroppedRule, 'id' | 'action'>> },
  invalidSource: CompiledPermissionDslV1['invalidSource'],
): CompiledPermissionDslV1['invalidSource'] {
  if (layer.scope === 'managed') {
    sinks.diagnostics.push(diagnostic)
    return invalidSource ?? { scope: layer.scope, sourceDigest: layer.sourceDigest, diagnostic }
  }
  sinks.rules.length = mark[0]
  sinks.droppedRules.length = mark[1]
  sinks.diagnostics.length = mark[2]
  const announced: PermissionDslDiagnosticV1 = {
    code: diagnostic.code,
    message: `${diagnostic.message} The ${layer.scope} permission settings document was ignored as a whole; `
      + 'every other permission document still applies. Fix the file and it takes effect on the next turn.',
  }
  sinks.diagnostics.push(announced)
  sinks.droppedSources.push({ scope: layer.scope, sourceDigest: layer.sourceDigest, diagnostic: announced })
  return invalidSource
}

/**
 * F1.823 — the ONE script of a `<bash|zsh|sh> -c|-lc '<script>'` invocation, or
 * `null` for every other shape.
 *
 * Codex's approval frame carries its login-shell TRANSPORT, not the model's
 * command: `command: "/bin/zsh -lc 'git status'"` for `cmd: 'git status'`
 * (measured on `rust-v0.156.1`; the frames are in
 * `codex-login-shell-rule-projection.test.ts`). `permissions.md#bash-rule-limits`:
 * "A Bash rule matches the command text Claude writes", so
 * `codexApprovalRuleRequests` projects this script and every rule form judges
 * what the model wrote (owner decision 2026-09-26, option A). Codex's own
 * execpolicy unwraps the same shape before it matches (`extract_bash_command`,
 * `shell-command/src/bash.rs`, exactly `[shell, -lc|-c, script]`).
 *
 * Conservative, and ONE layer only: the predicate {@link shellProgram} unwraps
 * with, exactly three tokens, a non-blank script. Anything else (another option,
 * an extra operand, a shell not in the list, a command {@link tokenizeShell}
 * refuses such as a newline, `$(` or a backtick) is `null`, and the caller keeps
 * the frame's text: an allow still gives its fail-closed card, a deny still
 * reads the script (P3.12). A shell the model wrote INSIDE the transport is not
 * unwrapped, because Claude does not strip one either (the same section's table
 * lists `bash -c 'rm -rf build/'` among the forms `Bash(rm *)` does not stop).
 */
export function loginShellScript(command: string): string | null {
  const tokens = tokenizeShell(command)
  if (!tokens || tokens.length !== 3 || !isShellScriptInvocation(tokens[0]!, tokens[1])) return null
  return tokens[2]!.trim() ? tokens[2]! : null
}

/** The `bash|zsh|sh` + `-c|-lc` predicate {@link shellProgram}, {@link loginShellScript} and F1.824's arm share. */
function isShellScriptInvocation(executable: string, flag: string | undefined): boolean {
  return ['bash', 'zsh', 'sh'].includes(executable.split(/[\\/]/).at(-1)!) && (flag === '-c' || flag === '-lc')
}
