/**
 * F1.813 — the readable permission DSL's DENY half on the claude runtime, and
 * F1.830 — its ASK half (see {@link claudeReadablePermissionAskCheckResult}).
 *
 * ## The gap this closes
 *
 * The host evaluates the readable permission policy (`permissionDsl`) on Pi
 * (`PiAgent.handlePreToolUseRequest` reads the merged config's `permissionDsl`)
 * and on codex (`CodexAgent.consultPermissionRules`, the same merged config), and
 * claude evaluated none of it: `claude-agent.ts` never called the evaluator, and
 * the shared gate it runs as a PreToolUse hook (`core/pre-tool-use.ts`,
 * `mode-manager.ts`) reads no `permissionDsl`. So a DENY rule in a workspace
 * `permissions.json`, a capability permission layer, a session rule, or a managed
 * rule written directly in `permissionDsl` raised a card in `default` and ran in
 * `bypassPermissions` on claude — measured in
 * `__tests__/claude-readable-permission-deny.test.ts`. Only managed `claudeRules`
 * bound, because `mapManagedPolicyToClaudeSettings` projects those onto the SDK's
 * own `permissions.deny`.
 *
 * ## Native-first, asked
 *
 * The runtime's own mechanism is `permissions.deny`, and it cannot carry this:
 * our DSL has structural matchers (`{kind:'bash', executable, args}`, path roots,
 * hosts) with no Claude rule-string spelling, which is why the managed mapping
 * sends only `claudeRules`. The host already supplies this policy on Pi and codex,
 * so the host supplies it here too (step 2 of the owner rule): the SAME merged
 * policy, evaluated by the SAME evaluator, answering the SAME deny.
 *
 * ## What is evaluated, and what is deliberately not
 *
 * - The merged config Pi reads: the capability layers the turn published (or,
 *   with none, the global/workspace/source files, codex's fallback context), the
 *   session rules, the managed `permissionDsl` and the managed-only lock
 *   (`allowManagedPermissionRulesOnly`), which Pi receives from `SessionManager`
 *   and claude reads from the same managed floor its SDK projection reads.
 * - The WHOLE managed `permissionDsl`, including the `claude-<action>-<n>` rules
 *   the parser compiled from `claudeRules`. Those also reach the SDK natively, and
 *   the project `.claude/settings*.json` layers are read natively too: a deny the
 *   runtime also enforces is refused here first, naming the rule, exactly as Pi
 *   and codex refuse it. Both enforcers deny; nothing is widened.
 * - THE DENY HALF, AND SINCE F1.830 THE ASK HALF. An allow rule is not honoured
 *   on claude (the call falls to the mode's own answer, which can only be
 *   stricter) — a stated residue. An ask rule is answered by the same evaluation
 *   and applied per mode by {@link claudeReadablePermissionAskCheckResult}.
 * - F1.831 (owner option A): an UNREADABLE workspace, project, plugin or global
 *   document no longer reaches here as a blanket answer — the shared compiler drops
 *   it whole with a warning naming its scope, and every other document (the managed
 *   one included) keeps binding here as on Pi and codex. What can still answer
 *   `invalid-policy` is a broken MANAGED layer or a deny/ask rule-cap overflow.
 *   F1.1002 (option A's managed half): that deny now REFUSES here, as Pi refuses
 *   every call, with the compiler's diagnostic as the reason
 *   (`permissionDslDenyReason`, the sentence Pi shows) — until F1.1002 it came
 *   back `not-consulted`, so an administrator's unreadable policy bound nothing on
 *   claude. `not-consulted` is left to a deny that names no rule at all (a stale
 *   generation, which cannot arise here) and an evaluation that threw.
 */
import { resolve } from 'node:path'

import { permissionsConfigCache, type PermissionsContext } from './permissions-config.ts'
import { isManagedPermissionRulesOnly, resolveManagedPiPolicyFloor, type ManagedPiPolicyV1 } from './pi-harness/managed-policy.ts'
import { describePermissionDslMatch, permissionDslAskReason, permissionDslDenyReason, rawDslInputPath } from './pi-harness/permission-dsl.ts'
import { getPiToolBindingByBindingName, PI_TOOL_BINDINGS } from './pi-harness/harness-tool-descriptor.ts'
import { evaluatePermissionDslUnderSessionToolAlias, type PiSessionToolRuleAlias } from './pi-harness/session-tool-rule-alias.ts'
import { canonicalizeForDecision } from './session-filesystem-scope.ts'
import type { PreToolUseCheckResult } from './core/pre-tool-use.ts'
import { PERMISSION_MODE_AGENT_LABELS, type PermissionMode } from './mode-types.ts'

export interface ClaudeReadablePermissionDenyRequest {
  /** The claude tool name the SDK reported (`Bash`, `Read`, `mcp__server__tool`, …). */
  toolName: string
  /**
   * Every input the call may run with — the hook-resolved input and, when the
   * gate rewrote it (`modify`, a prompt's `modifiedInput`), the rewritten one. A
   * deny under ANY of them refuses: a rewrite must not carry a denied command
   * past a rule written against its original spelling. F1.923 — the host's own
   * rewrite counts too: a Read of a large image is judged under the path it was
   * asked for as well as under the resized copy the SDK will read.
   */
  inputs: readonly Readonly<Record<string, unknown>>[]
  cwd: string
  /** The capability context the turn published, or codex's fallback when none. */
  permissionsContext: PermissionsContext
  /** The managed floor, as `resolveManagedPiPolicyFloor()` returns it. */
  managedPolicy: ManagedPiPolicyV1 | undefined
}

export type ClaudeReadablePermissionDenyVerdict =
  | { kind: 'deny'; reason: string; ruleId: string; scope?: string }
  | ClaudeReadablePermissionAskVerdict
  | { kind: 'not-consulted'; reason: string }

/**
 * F1.830 — an ASK the readable policy answered. `named` is the rule clause every
 * host renders (`rule \`id\` (scope scope)`, empty when the match names no
 * rule), so the card and the refusal say which rule asked.
 */
export interface ClaudeReadablePermissionAskVerdict {
  kind: 'ask'
  reason: string
  named: string
  ruleId?: string
  scope?: string
}

/**
 * The deny — or, since F1.830, the ask — the readable policy answers for one
 * claude tool call, or `undefined` when neither matches (the call keeps the
 * gate's own answer). A deny under ANY input wins over an ask under another; an
 * ask under any input asks.
 */
export function claudeReadablePermissionDeny(
  request: ClaudeReadablePermissionDenyRequest,
): ClaudeReadablePermissionDenyVerdict | undefined {
  const policy = request.managedPolicy
  const context: PermissionsContext = {
    ...request.permissionsContext,
    ...(policy?.permissionDsl ? { managedPermissionDsl: policy.permissionDsl } : {}),
    ...(policy && isManagedPermissionRulesOnly(policy) ? { managedPermissionRulesOnly: true } : {}),
  }
  let program
  try {
    program = permissionsConfigCache.getMergedConfig(context).permissionDsl
  } catch (error) {
    return { kind: 'not-consulted', reason: error instanceof Error ? error.message : String(error) }
  }
  if (!program) return undefined

  const { toolName, semanticId, alias } = claudeRuleRequestNames(request.toolName)
  let ask: ClaudeReadablePermissionAskVerdict | undefined
  for (const input of request.inputs) {
    const rawInputPath = rawDslInputPath(input)
    const evaluation = evaluatePermissionDslUnderSessionToolAlias(program, alias, {
      // The program's own generation, as codex passes it: claude has no manifest
      // generation to disagree with, so a stale-generation deny cannot arise here.
      generation: program.generation,
      semanticId,
      toolName,
      input,
      cwd: request.cwd,
      canonicalizePath: (value, cwd) => canonicalizeForDecision(resolve(cwd, value)),
      ...(rawInputPath === undefined ? {} : { rawInputPath }),
    })
    if (evaluation.action === 'ask') {
      ask ??= {
        kind: 'ask',
        reason: permissionDslAskReason(evaluation),
        named: describePermissionDslMatch(evaluation.match),
        ...(evaluation.match ? { ruleId: evaluation.match.ruleId } : {}),
        ...(evaluation.match?.scope === undefined ? {} : { scope: evaluation.match.scope }),
      }
      continue
    }
    if (evaluation.action !== 'deny') continue
    const match = evaluation.match
    if (!match) {
      return { kind: 'not-consulted', reason: evaluation.diagnostic?.message ?? 'the permission policy could not answer' }
    }
    // F1.1002 — an `invalid-policy` deny falls through: it refuses, and
    // `permissionDslDenyReason` prefers its diagnostic, so no rule id is named.
    return {
      kind: 'deny',
      reason: permissionDslDenyReason(evaluation),
      ruleId: match.ruleId,
      ...(match.scope === undefined ? {} : { scope: match.scope }),
    }
  }
  return ask
}

/** The gate's own set of file-writing tools (`FILE_WRITE_TOOLS` in `core/pre-tool-use.ts`, not exported). */
const CLAUDE_FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/**
 * F1.830 — what a readable ASK does to the gate's answer for one claude call.
 *
 * `permission-modes.md#actions-no-mode-auto-approves`: "Claude Code doesn't
 * auto-approve the following in any mode, including `bypassPermissions`" — and
 * its first bullet is "Tools matched by an explicit ask rule". The per-mode
 * sections it links say what happens instead: `auto` — "Explicit ask rules still
 * force a prompt"; `dontAsk` — "Claude Code denies calls matching your explicit
 * `ask` rules rather than prompting"; `bypassPermissions` — "The actions no mode
 * auto-approves still prompt in this mode". So:
 *
 * - A gate `block` (and a source activation, which runs nothing) is kept: it is
 *   already a refusal, and the more specific one.
 * - `dontAsk` refuses, naming the rule — the one mode that cannot ask.
 * - A gate `prompt` the MODE raised (no marker) takes the host card's shape
 *   below — the rule-naming description, `nonNegotiable: 'askRule'`, and NO
 *   remember window — keeping its type, command, rewrite and payload. The MODE
 *   did not raise it alone, so P6.863's `modePrompt` (the card's "switch to
 *   auto" offer) must not be set — auto still asks. F1.860: it used to keep the
 *   mode's `rememberForMinutes`/`commandHash`, which ARE the don't-ask-again
 *   mechanism (`core/pre-tool-use.ts` strips them from its own ask-rule and
 *   floor prompts for that reason): `SessionManager.respondToPermission` stores
 *   a session remember window under `commandHash` on "Allow for this session",
 *   and `SessionManager.handleAgentPermissionRequest` answers every later card
 *   carrying the same hash with no card — so in Manual, auto, acceptEdits and
 *   plan one click switched the ask rule off for the session (SIT-ae), while
 *   the bypass host card, which never carried them, asked again. A floor prompt
 *   (already marked) keeps its own description and loses only those two fields,
 *   which no floor sets today.
 * - Anything the gate would let run (`allow`, `modify`, `call_llm_intercept`)
 *   becomes a card naming the rule, in every other mode — `explore` and `plan`
 *   included, as Pi raises it (`PiAgent.handlePreToolUseRequest` upgrades an
 *   allow to ask on any mode). A `modify` keeps its rewrite for the approved
 *   call. The card offers no remember window: the rule asks again next time
 *   whatever is remembered, so "don't ask again" would promise what it cannot.
 *   F1.921 — and it says what it approves: the command for Bash, the path for a
 *   file write, {@link claudeReadableAskCardSubject} for every other tool.
 * - F1.842 — both ask-rule cards above carry `noAlwaysAllow`, which hides the
 *   card's Always Allow (the renderer's `canRemember`): since F1.860 an Always
 *   answer runs the one call and the rule asks again next time, so the button
 *   promised a lasting grant the rule outranks. Codex's ask-rule card (F1.870)
 *   and Pi's (F1.913) already send it; a floor's card keeps its own shape, as
 *   on both of them. What a client that sends Always anyway gets is unchanged:
 *   that one call (F1.888 is the host-side hardening).
 *
 * Native-first, asked: the runtime's `permissions.ask` cannot carry our
 * structural matchers (the deny half's reason, above), and a hook
 * `permissionDecision: 'ask'` would hand the question to the SDK's own prompt,
 * whose behaviour under `bypassPermissions` no page states and this row did not
 * measure. The host gate already raises its own cards through this same hook in
 * every mode (`origin: 'host_gate'`), so the ask rides that card, and its
 * approval is the one the SDK's native ask-rule step reads
 * (`gateApprovedToolUseIds`) — one question, not two.
 */
export function claudeReadablePermissionAskCheckResult(
  checkResult: PreToolUseCheckResult,
  ask: ClaudeReadablePermissionAskVerdict,
  call: { toolName: string; input: Readonly<Record<string, unknown>>; mode: PermissionMode },
): PreToolUseCheckResult {
  if (checkResult.type === 'block' || checkResult.type === 'source_activation_needed') return checkResult
  const clause = ask.named.length === 0 ? 'readable permission policy' : `readable permission policy ${ask.named}`
  if (call.mode === 'dontAsk') {
    return {
      type: 'block',
      reason: `Tool blocked: ${call.toolName} requires approval by ${clause}, and ${PERMISSION_MODE_AGENT_LABELS.dontAsk} mode never prompts.`,
    }
  }
  const description = `${call.toolName} requires approval by ${clause}.`
  if (checkResult.type === 'prompt') {
    // F1.860 — no remember window on an ask-rule card, in any mode: see the docblock.
    const { rememberForMinutes, commandHash, ...card } = checkResult
    if (checkResult.nonNegotiable !== undefined) {
      return rememberForMinutes === undefined && commandHash === undefined ? checkResult : card
    }
    return { ...card, description, nonNegotiable: 'askRule', noAlwaysAllow: true } // F1.842
  }
  const command = typeof call.input.command === 'string' ? call.input.command : undefined
  const filePath = [call.input.file_path, call.input.notebook_path, call.input.path].find(value => typeof value === 'string') as string | undefined
  const shape = call.toolName === 'Bash' && command !== undefined
    ? { promptType: 'bash' as const, command }
    : CLAUDE_FILE_WRITE_TOOLS.has(call.toolName) && filePath !== undefined
      ? { promptType: 'file_write' as const, command: filePath }
      : { promptType: 'mcp_mutation' as const, command: claudeReadableAskCardSubject(call.toolName, call.input) } // F1.921
  return {
    type: 'prompt',
    ...shape,
    description,
    nonNegotiable: 'askRule',
    noAlwaysAllow: true, // F1.842
    ...(checkResult.type === 'modify' ? { modifiedInput: checkResult.input } : {}),
  }
}

const CLAUDE_BUILTIN_PI_COUNTERPARTS: ReadonlyMap<string, string> = new Map([['Glob', 'find'], ['Agent', 'subagent'], ['Task', 'subagent'], ['AskUserQuestion', 'ask_user']]) // F1.833 — PI_RUNTIME_AGENT_TOOL_ALIASES glob/agent/task; F1.1083 askuserquestion
/**
 * The `(toolName, semanticId)` a claude call is judged under, in the vocabulary
 * the other two hosts already use: an MCP call is `mcp_dynamic` (codex's
 * `codexMcpToolCallRuleRequests`), a session tool is also read under Pi's own name
 * (codex's `codexSessionToolPiAlias`, F1.379), and a built-in carries the
 * descriptor id Pi gives the tool of the same permission name (`Bash` → `bash`,
 * `WebFetch` → `web_fetch`), so a native DSL rule written against Pi's ids binds
 * the same call here. F1.833 — `Glob` (Pi's `find`) and `Agent`/`Task` (Pi's
 * `subagent`, never its pi-only session `Task`) keep their own name and add Pi's as
 * that alias ({@link CLAUDE_BUILTIN_PI_COUNTERPARTS}). Else: its own name.
 */
function claudeRuleRequestNames(toolName: string): { toolName: string; semanticId: string; alias?: PiSessionToolRuleAlias } {
  const piName = CLAUDE_BUILTIN_PI_COUNTERPARTS.get(toolName)
  const binding = piName !== undefined || toolName.startsWith('mcp__session__') ? getPiToolBindingByBindingName(piName ?? toolName) : undefined
  const alias = binding ? { alias: { toolName: binding.permissionName, semanticId: binding.descriptorId } } : {}
  if (toolName.startsWith('mcp__')) return { toolName, semanticId: 'mcp_dynamic', ...alias }
  if (piName !== undefined) return { toolName, semanticId: toolName, ...alias }
  const builtin = PI_TOOL_BINDINGS.find(candidate => candidate.permissionName === toolName)
  return { toolName, semanticId: builtin?.descriptorId ?? toolName }
}

/** F1.921 — how much of an argument a card shows: the preview box scrolls, but a subject is a glance. */
const ASK_CARD_SUBJECT_MAX_ARGUMENTS = 8
const ASK_CARD_SUBJECT_MAX_VALUE = 200

/**
 * F1.921 — the subject of a readable-ask card over a tool that is neither Bash
 * nor a file write: what the approval is FOR.
 *
 * Delta review 2 measured the card {@link claudeReadablePermissionAskCheckResult}
 * builds over a call the gate would have run: Bash carried its command and a
 * file write its path, and every other tool was carded as its bare name — a
 * `Read` of a key file, a `WebFetch` of a URL carrying a secret, a `Grep` over
 * the home directory and an MCP write all read "Tool: Read" (or the tool name)
 * with the rule sentence and nothing else, and `command` is the only preview
 * the card renders. F1.902 closed the same hole on Pi (`piReadableAskCardCommand`,
 * the shell command, else `rawDslInputPath`, else the tool name); this is its
 * claude shape, one step wider because claude's built-ins name their subject in
 * more than one parameter:
 *
 * - `Read` — the path (`rawDslInputPath`, the value a path rule tests), as a
 *   file-write card shows its path.
 * - `WebFetch` — the URL; its `prompt` is what the model will ask of the page,
 *   not what is being fetched.
 * - anything else (`Grep`, `Glob`, an MCP tool, …) — its arguments, one
 *   `name: value` line each in the input's own order (a string verbatim,
 *   anything else as JSON), each value cut at
 *   {@link ASK_CARD_SUBJECT_MAX_VALUE} characters and at most
 *   {@link ASK_CARD_SUBJECT_MAX_ARGUMENTS} lines — so a Grep shows its pattern
 *   and its path, and an MCP call its arguments.
 * - no argument at all — the tool name, which is what the card showed before.
 *
 * Display, and one thing beside it: the card's `command` also feeds
 * `ClaudeAgent.respondToPermission`'s session whitelist, whose key for these
 * tools is `getBaseCommand(command)` — a Bash key. So a path here must never be
 * stored: see {@link claudeReadableAskCardSkipsHostWhitelist}.
 */
export function claudeReadableAskCardSubject(toolName: string, input: Readonly<Record<string, unknown>>): string {
  const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined
  if (toolName === 'WebFetch' && text(input.url)) return input.url as string
  if (toolName === 'Read') {
    const path = rawDslInputPath(input)
    if (path !== undefined && path.trim()) return path
  }
  const entries = Object.entries(input).filter(([, value]) => value !== undefined)
  if (entries.length === 0) return toolName
  const clip = (value: string) => value.length > ASK_CARD_SUBJECT_MAX_VALUE ? `${value.slice(0, ASK_CARD_SUBJECT_MAX_VALUE)}…` : value
  const render = (value: unknown): string => {
    if (typeof value === 'string') return value
    try {
      return JSON.stringify(value) ?? String(value)
    } catch {
      return String(value)
    }
  }
  const lines = entries.slice(0, ASK_CARD_SUBJECT_MAX_ARGUMENTS).map(([name, value]) => `${name}: ${clip(render(value))}`)
  if (entries.length > ASK_CARD_SUBJECT_MAX_ARGUMENTS) lines.push(`… ${entries.length - ASK_CARD_SUBJECT_MAX_ARGUMENTS} more`)
  return lines.join('\n')
}

/**
 * F1.921 — does "Allow for this session" on this ask-rule card stay out of the
 * host's session command whitelist?
 *
 * `ClaudeAgent.respondToPermission` stores `sessionWhitelistKeyForApproval(tool,
 * card.command, getBaseCommand(card.command))`, and for any tool that is not
 * Bash, a file write, MCP or an API tool that key WAS the card command's first
 * word (nothing since F1.936) — a key the Bash consult reads as a prefix. Once
 * {@link claudeReadableAskCardSubject} put a path, a URL or a pattern there, one
 * click on a `Read` of `/tmp/x.sh` would grant RUNNING `/tmp/x.sh` in Bash for
 * the session, and a Grep for `npm` would grant `npm …`. Before F1.921 the key
 * was the tool name (`read`, `grep`) — junk of the same class, which C3.312
 * already names for the SDK's own cards (`PendingPermission.suppressHostCommandWhitelist`:
 * "the command on such a card is a file path … whitelisting it is a junk entry").
 *
 * So these cards write nothing there, and lose nothing by it: an ask rule asks
 * again whatever the host remembers (F1.860), and the gate already lets these
 * calls run. Bash, file-write, MCP and API cards keep the key they store today —
 * each is read by a consult of its own.
 */
export function claudeReadableAskCardSkipsHostWhitelist(toolName: string, checkResult: PreToolUseCheckResult): boolean {
  return checkResult.type === 'prompt'
    && checkResult.nonNegotiable === 'askRule'
    && toolName !== 'Bash'
    && !CLAUDE_FILE_WRITE_TOOLS.has(toolName)
    && !toolName.startsWith('mcp__')
    && !toolName.startsWith('api_')
}

/**
 * F1.1116 (origin DN-093) — the readable policy's DENY of a `Read` of one
 * `call_llm` attachment, or `null`: asked exactly as the claude gate asks it for
 * a `Read` of that path ({@link claudeReadablePermissionDeny}: the same merged
 * context, the same managed floor, the same evaluator, under `Read`'s names, so
 * a rule written against Pi's `read` binds too). `callLlmAttachmentReadGuard`
 * (`mode-manager.ts`) asks it on both routes after the `deniedPaths` floor.
 * Before, a `deny Read(...)` rule refused `Read` of a file while `call_llm`
 * attached the same file and sent its text to the side model.
 *
 * `cwd` is the session's working directory, which a relative rule
 * (`Read(./.env)`) is anchored to, as it is for `Read`; with none, the workspace
 * root, the claude gate's own fallback. Only a DENY refuses, stated: an ASK rule
 * cannot raise a card from inside this reader, and a policy that could not be
 * consulted leaves the attachment to the floor, as it leaves `Read` to the gate.
 */
export function readablePermissionDenyOfAttachment(
  absolutePath: string,
  permissionsContext: PermissionsContext,
  cwd: string | undefined,
): string | null {
  const verdict = claudeReadablePermissionDeny({
    toolName: 'Read',
    inputs: [{ file_path: absolutePath }],
    cwd: cwd ?? permissionsContext.workspaceRootPath,
    permissionsContext,
    managedPolicy: resolveManagedPiPolicyFloor(),
  })
  return verdict?.kind === 'deny' ? verdict.reason : null
}
