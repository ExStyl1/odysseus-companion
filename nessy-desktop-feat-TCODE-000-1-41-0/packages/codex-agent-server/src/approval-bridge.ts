/**
 * Pure mapping helpers bridging codex app-server approval **requests**
 * (server→client) to Nessy's permission round-trip and back.
 *
 * (spike) The generated protocol has **no `availableDecisions` field** (this
 * corrects 00-context's Task 4.1 text). The decision set is a fixed enum per
 * approval type:
 *   CommandExecutionApprovalDecision = "accept" | "acceptForSession" |
 *     {acceptWithExecpolicyAmendment} | {applyNetworkPolicyAmendment} |
 *     "decline" | "cancel"
 *   FileChangeApprovalDecision       = "accept" | "acceptForSession" |
 *     "decline" | "cancel"
 * We only ever emit the shared string members accept/acceptForSession/decline,
 * so no decision string is ever sent that the schema doesn't define.
 */

/** The request shape `BaseAgent.onPermissionRequest` expects (subset). */
export interface NessyApprovalRequest {
  requestId: string;
  toolName: string;
  command?: string;
  description: string;
  reason?: string;
  /** Hide the client's Always Allow button when nothing can honour it. */
  noAlwaysAllow?: boolean;
}

export type ApprovalKind =
  | 'command'
  | 'fileChange'
  | 'elicitation'
  | 'permissions'
  /** The v1 `execCommandApproval` / `applyPatchApproval` pair; see `resolveLegacyDecision`. */
  | 'commandV1'
  | 'fileChangeV1';

/** The method codex-app-server uses to ask for an MCP tool-call approval. */
export const MCP_ELICITATION_METHOD = 'mcpServer/elicitation/request';

/**
 * The method behind codex's own `request_permissions` tool
 * (`core/src/tools/handlers/request_permissions.rs`), which asks the user to
 * widen the turn's filesystem/network sandbox.
 */
export const PERMISSIONS_METHOD = 'item/permissions/requestApproval';

/**
 * `McpServerElicitationAction` — the fixed enum of
 * `schema/McpServerElicitationRequestResponse.json`, whose only REQUIRED field
 * is `action`. Answering that method with `{}` (the generic empty JSON-RPC
 * result) fails to deserialize server-side and codex reads the failure as a
 * rejection, which is how an MCP tool call died with `user rejected MCP tool
 * call` while nothing was ever shown to a user.
 */
export type ElicitationAction = 'accept' | 'decline' | 'cancel';

/** `McpServerElicitationRequestResponse` (the fields we emit). */
export interface ElicitationResponse {
  action: ElicitationAction;
  /** `content` is nullable: decline/cancel responses carry none. */
  content: Record<string, unknown> | null;
}

/** codex CommandExecutionRequestApprovalParams (fields we read). */
export interface CommandApprovalParams {
  command?: string | null;
  cwd?: string | null;
  reason?: string | null;
  /**
   * P7.2 — `CommandExecutionApprovalKind`, new at `rust-v0.150.1` (upstream
   * #40528), and the one field on this frame that changes WHAT IS BEING ASKED.
   *
   * Its own generated doc: *"Distinguishes a command approval from input sent to
   * an existing terminal"*, `"command" | "writeStdin"`, and the params type adds
   * *"Kind of action under review. Defaults to `command` for older servers"* and
   * *"Stdin approvals also use a distinct callback id; inspect `kind` to
   * distinguish them."* Upstream is telling a client in as many words to read
   * this field.
   *
   * Ignoring it is safe-by-default in ONE direction and not in the other. An
   * older server sends nothing and the default is `command`, which is what this
   * bridge already assumed, so nothing regresses. But a `writeStdin` frame read
   * as a command is a card that says *"Run: <command>"* about an act that is not
   * running that command — it is typing into a process already running — and a
   * consent given to the sentence on screen would not be a consent to the act.
   * That is the advertised-but-wrong shape, one step worse than
   * advertised-but-dead.
   *
   * UNMEASURED, and said so: obtaining a real `writeStdin` frame needs a live
   * turn with an interactive process, which this lane could not drive. What is
   * built is therefore the narrow half that cannot be wrong — the card names the
   * act, and no DURABLE grant is minted from a frame whose subject is not a
   * command. The allow/deny decision itself is untouched.
   */
  kind?: string | null;
  /**
   * DISPLAY METADATA, NEVER A ROUTING KEY — and P2.418 is the measurement that
   * says so, recorded here because this is the field a collision would have to
   * come through.
   *
   * ## The question
   *
   * `CommandExecutionRequestApprovalParams` carries a fourth field this bridge
   * reads in zero files, `approvalId`, whose generated docstring explains
   * itself: for zsh-exec-bridge subcommand approvals **multiple callbacks can
   * belong to one parent `itemId`**, so `approvalId` is "a distinct opaque
   * callback id (a UUID) used to disambiguate routing". If our routing were
   * keyed on `itemId`, two such callbacks would collide — and a routing
   * collision on an approval means one consent answering for a different
   * command. That hazard was UNVERIFIED, so it was measured before anything was
   * built.
   *
   * ## The verdict: not reachable here, for three independent reasons
   *
   * 1. **Our key is the REQUEST, not the item.** `CodexAgent.handleServerRequest`
   *    mints `randomUUID()` per incoming server→client request and keys
   *    `pendingApprovals` by it. `itemId` reaches this module only as the two
   *    optional interface fields it is declared on, and neither mapper puts it
   *    on the card.
   * 2. **The reply is correlated by a JSON-RPC id we never invent.**
   *    `AppServerClient` dispatches each request line as
   *    `dispatchServerRequest(msg.id, …)` — `void`-spawned, so two callbacks are
   *    genuinely concurrent — and answers with `write({ id, result })` on that
   *    same incoming id.
   * 3. **The response has nowhere to put a routing key even if we read one.**
   *    `CommandExecutionRequestApprovalResponse = { decision }`, and
   *    {@link buildApprovalResponse} emits exactly that.
   *
   * So `approvalId` is the SERVER's key, not ours: the app-server re-attaches it
   * itself when it translates our `decision` into core's `Op::ExecApproval`,
   * whose pending map is keyed `approval_id.unwrap_or(call_id)`. Keying on it
   * here would add a second source of truth for a routing decision this side
   * does not make — which is what P2.418 forbade doing speculatively.
   *
   * ## Evidence, split by tier as the non-symmetric rule requires
   *
   * STRONG (openai/codex at `rust-v0.148.0`, and the shipped binary): the
   * per-request id allocator (`app-server/src/outgoing_message.rs`
   * `next_request_id`, correlated through `request_id_to_callback`), the
   * re-attachment (`bespoke_event_handling.rs`
   * `Op::ExecApproval { id: approval_id.unwrap_or_else(|| item_id.clone()) }`),
   * the single non-null construction site (`core/src/tools/runtimes/shell/
   * unix_escalation.rs`, `approval_id: Uuid::new_v4()`, `#[cfg(unix)]`, every
   * other caller passing `None`), and the response struct
   * (`app-server-protocol/src/protocol/v2/item.rs`). String-probed in
   * `apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`:
   * `approval_id` 11, `shell_zsh_fork` 3, `unified_exec_zsh_fork` 5, and core's
   * own collision warning `Overwriting existing pending approval for call_id` 1
   * — against `zzz_not_a_real_field` and `qqq_absent_control` at 0, with
   * `thread/start` 3 and `item/commandExecution/requestApproval` 3 as the
   * positive controls.
   *
   * ALSO MEASURED, and it does NOT carry the verdict: the feature is
   * `Stage::UnderDevelopment` with `default_enabled: false` at that tag, and this
   * repo writes its key in no config (`git grep` finds it only in generated
   * bindings, schemas and one spec; `approvals_reviewer`, which the writer DOES
   * emit, is the positive control on the same corpus). That means a non-null
   * `approvalId` cannot even arrive today — but it is written down second on
   * purpose, because a default that flips is not a safety property, and the
   * three reasons above hold whether or not it does.
   *
   * TWO RESIDUES, both real and neither a defect here:
   * - Callbacks under one `itemId` can be **concurrently in flight** (codex
   *   spawns a handler per intercepted `execve` and a detached waiter per
   *   approval). Two cards open at once is correct behaviour on this side —
   *   each has its own `requestId` — but a consumer that assumed one open
   *   approval per item would be wrong, so do not add that assumption.
   * - `approvalId` is `skip_serializing_if = "Option::is_none"`, so the regular
   *   case OMITS the key rather than sending `null`, despite the TS binding
   *   typing it `?: string | null`. Absent and `null` must read the same.
   */
  itemId?: string;
  /**
   * `CommandExecutionRequestApprovalParams.proposedExecpolicyAmendment`
   * (`packages/codex-protocol/generated/v2/…`): "Optional proposed execpolicy
   * amendment to allow similar commands without prompting." An
   * `ExecPolicyAmendment` — the command's token prefix, already parsed by the
   * app-server — which is what an Always Allow persists as a durable rule.
   */
  proposedExecpolicyAmendment?: readonly string[] | null;
  /**
   * P2.407 — `CommandExecutionRequestApprovalParams.networkApprovalContext`,
   * "Optional context for a managed-network approval prompt". A
   * `NetworkApprovalContext = { host, protocol }`, where `NetworkApprovalProtocol
   * = "http" | "https" | "socks5Tcp" | "socks5Udp"`.
   *
   * Read in ZERO files before this row, which is what made it the field the
   * whole consent turned on: on this variant `command` can be absent and
   * `reason` is free text, so the card said "Run a command" for a prompt whose
   * real subject is *this process is about to reach this host*.
   */
  networkApprovalContext?: { host?: unknown; protocol?: unknown } | null;
  /**
   * P2.407 — `proposedNetworkPolicyAmendments`, "Optional proposed network
   * policy amendments (allow/deny host) for future requests". An array of
   * `NetworkPolicyAmendment = { host, action: "allow" | "deny" }`.
   *
   * READ AND RECORDED, NOT ACTED ON. Acting means answering with
   * `CommandExecutionApprovalDecision::applyNetworkPolicyAmendment`, which
   * writes a durable egress policy — a product posture P2.407 explicitly defers
   * ("record what arrives before proposing any behaviour change"). It is read
   * here so the amendment is visible instead of discarded at the door, and so
   * {@link execpolicyAmendmentForApproval} can refuse to over-grant beside it.
   */
  proposedNetworkPolicyAmendments?: readonly { host?: unknown; action?: unknown }[] | null;
}

/**
 * The host and protocol a managed-network approval is about, or `null` when this
 * is an ordinary command approval.
 *
 * ## Why this is `null` in every session we ship today, and why it still matters
 *
 * P2.384 measured it: every frame carrying this field requires codex's managed
 * network proxy to be running, and that proxy is `Feature::NetworkProxy`,
 * `Stage::Experimental, default_enabled: false`. We do not write the key (a
 * tripwire pins it unwritten), so this reader returns `null` on every approval
 * this build can currently receive.
 *
 * That is not an argument against reading it. The field is REAL on the artifact
 * we ship — string-probed in
 * `apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`
 * (rust-v0.148.0) at counts `networkApprovalContext` 2,
 * `proposedNetworkPolicyAmendments` 2, `applyNetworkPolicyAmendment` 3,
 * `socks5Tcp`/`socks5Udp` 2 each, against `zzz_not_a_real_field` = 0 as the
 * negative control — so the day anything turns that proxy on, the difference
 * between this reader existing and not existing is whether the user is asked to
 * approve a host or asked to approve a blank.
 *
 * EVIDENCE TIER, stated because AGENTS.md requires codex's two tiers not be
 * recorded as one: the SHAPE is strong (ts-rs output generated from the codex
 * source at the tag we ship, plus the binary probe above). The ARRIVAL is
 * UNMEASURED — obtaining a live frame requires enabling `network_proxy`, which
 * this lane is forbidden to write.
 */
export function readNetworkApprovalContext(
  params: unknown,
): { host: string; protocol: string | null } | null {
  const p = isRecord(params) ? params : {};
  const context = isRecord(p.networkApprovalContext) ? p.networkApprovalContext : null;
  if (!context) return null;
  const host = nonEmptyString(context.host);
  if (!host) return null;
  return { host, protocol: nonEmptyString(context.protocol) };
}

/**
 * The protocol-qualified subject line for a managed-network approval — the thing
 * the user is actually being asked about.
 *
 * `NetworkApprovalContext` carries no port (unlike the guardian's own
 * `networkAccess` action, which does), so this does not invent one.
 */
export function describeNetworkApprovalContext(params: unknown): string | null {
  const context = readNetworkApprovalContext(params);
  if (!context) return null;
  return context.protocol ? `${context.host} over ${context.protocol}` : context.host;
}

/**
 * The allow/deny host rules codex is offering to remember, normalised — or `[]`
 * when the frame proposes none.
 *
 * Deliberately NOT put on the permission card. Showing "codex offers to remember
 * allow example.com" beside a Yes/No pair would promise a control this bridge
 * does not implement: the only way to accept one is the
 * `applyNetworkPolicyAmendment` decision variant, and P2.407 defers that
 * decision rather than taking it here. It is exported so the amendment is
 * RECORDED — see the caller's diagnostic — instead of being dropped unseen,
 * which is the defect the row names.
 */
export function readProposedNetworkPolicyAmendments(
  params: unknown,
): Array<{ host: string; action: 'allow' | 'deny' }> {
  const p = isRecord(params) ? params : {};
  const proposed = Array.isArray(p.proposedNetworkPolicyAmendments) ? p.proposedNetworkPolicyAmendments : [];
  const out: Array<{ host: string; action: 'allow' | 'deny' }> = [];
  for (const entry of proposed) {
    if (!isRecord(entry)) continue;
    const host = nonEmptyString(entry.host);
    // `NetworkPolicyRuleAction = "allow" | "deny"` — a third value is a protocol
    // we do not understand, and guessing which way an egress rule points is the
    // one mistake it must not make.
    if (!host || (entry.action !== 'allow' && entry.action !== 'deny')) continue;
    out.push({ host, action: entry.action });
    if (out.length >= 16) break;
  }
  return out;
}

/** codex FileChangeRequestApprovalParams (fields we read). */
export interface FileChangeApprovalParams {
  reason?: string | null;
  grantRoot?: string | null;
  itemId?: string;
}

/**
 * P2.407 — the card for a command approval, which is ALSO the card for a
 * managed-network approval, and used to say nothing about the difference.
 *
 * `networkApprovalContext` is what separates them, and it was read nowhere. On
 * that variant the subject of the consent is the HOST, not the command: the
 * generated params make `command` optional and its own docstring gives "request
 * for network access" as the example `reason`, so a frame with a host and no
 * command rendered as `Run a command` — a Yes/No on something the user could not
 * see. That is the same defect `mapPermissionsApprovalToRequest`'s docblock
 * already names for the sandbox-widening card, one field further along.
 *
 * The host therefore leads the description when it is present, and the command —
 * when there is one — follows it, because a user needs both: *which host* is the
 * decision, *which command* is the context. Nothing else about the card changes,
 * and on an ordinary command approval the output is byte-identical to what it
 * was. "The only kind this build can currently receive" was true when written
 * and is not since `rust-v0.150.1`: {@link CommandApprovalParams.kind} carries
 * the account of the second one.
 */
export function mapCommandApprovalToRequest(requestId: string, p: CommandApprovalParams): NessyApprovalRequest {
  const command = typeof p.command === 'string' ? p.command : undefined;
  const network = describeNetworkApprovalContext(p);
  // P7.2 · absent means `command`, per the field's own doc — that is the
  // older-server default and the shape every frame had before `rust-v0.150.1`.
  const kind = typeof p.kind === 'string' && p.kind ? p.kind : 'command';
  const ordinary = kind === 'command';
  const description = !ordinary
    ? (kind === 'writeStdin'
      ? (command
        ? `Send input to the running terminal — started by: ${command}`
        : 'Send input to the running terminal')
      : `Approve a codex action of an unrecognised kind ("${kind}")${command ? ` — related command: ${command}` : ''}`)
    : network
      ? (command ? `Reach ${network} — running: ${command}` : `Reach ${network}`)
      : (command ? `Run: ${command}` : 'Run a command');
  return {
    requestId,
    toolName: 'shell',
    command: network && !command ? network : command,
    description,
    reason: p.reason ?? undefined,
    // An Always Allow here cannot be honoured faithfully, for two different
    // reasons that land on the same refusal.
    //
    // NETWORK: the consent is scoped to one host, and the only durable thing
    // this bridge can persist from a command approval is an execpolicy COMMAND
    // prefix. See {@link execpolicyAmendmentForApproval}.
    //
    // KIND (P7.2): a durable grant minted from a non-`command` frame would be a
    // command-prefix rule standing in for an act that is not running a command.
    // A `writeStdin` frame carries the command that STARTED the terminal, so the
    // prefix it would mint is both plausible and wrong — the worst combination.
    // Unknown kinds take the same refusal for the same reason, which is also
    // what makes this forward-safe: a third member added upstream is refused
    // durably and still put to the user.
    ...(network || !ordinary ? { noAlwaysAllow: true } : {}),
  };
}

/**
 * C3.386 — the card for a v2 file-change approval, which until this row could
 * not name what it was asking about.
 *
 * RS-12 read it verbatim off packaged 1.37.0: `Permission required · Tool:
 * ApplyPatch · Apply file changes · Allow · Always Allow · Deny`. No path, no
 * floor sentence, and an **Always Allow** offered for an act the user could not
 * see — on a patch writing into a protected directory.
 *
 * The frame genuinely carries no paths — `FileChangeRequestApprovalParams` is
 * `{threadId, turnId, itemId, startedAtMs, reason?, grantRoot?}` — but it
 * carries `itemId`, and the host already received that item's `changes[].path`
 * on `item/started`. `paths` is that correlation, done by the caller; this
 * function invents nothing and still reads `grantRoot` as what it is (a session
 * write root, not the file being written).
 *
 * ## Two answers, and the empty one is the load-bearing half
 *
 * With paths, the card names them and Always Allow stands: the user can see
 * what they are agreeing to, and the same set has just been handed to the floor
 * and the rule matchers, so a durable grant means what the card said.
 *
 * Without them, `noAlwaysAllow` — the same refusal
 * {@link mapCommandApprovalToRequest} already makes for a non-`command` kind
 * and for the same stated reason: a durable grant minted from a frame that
 * cannot name its own subject is a promise about acts nobody enumerated. The
 * one-off Allow and Deny are untouched, so nothing becomes un-answerable.
 *
 * The path list is bounded at four with a remainder count, because a card is a
 * sentence a user reads before deciding and codex's `convert_patch_changes`
 * sorts by path with no cap of its own — a forty-file patch must not render as
 * a wall the user scrolls past.
 */
export function mapFileChangeApprovalToRequest(
  requestId: string,
  p: FileChangeApprovalParams,
  paths: readonly string[] = [],
): NessyApprovalRequest {
  const named = paths.filter(entry => typeof entry === 'string' && entry.trim().length > 0);
  const shown = named.slice(0, 4).join(', ');
  const remainder = named.length - Math.min(named.length, 4);
  const subject = remainder > 0 ? `${shown} and ${remainder} more` : shown;
  return {
    requestId,
    toolName: 'ApplyPatch',
    ...(named.length > 0 ? { command: subject } : {}),
    description: named.length > 0
      ? `Apply file changes to ${subject}`
      : p.grantRoot ? `Apply file changes under ${p.grantRoot}` : 'Apply file changes',
    reason: p.reason ?? undefined,
    ...(named.length === 0 ? { noAlwaysAllow: true } : {}),
  };
}

// codex `McpServerElicitationRequestParams` reaches this module as `unknown` and
// is read field by field below (`serverName`, `message`, `mode`,
// `requestedSchema`, `_meta`), because a server-sent payload is not a promise
// about its own shape.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Build the permission card for an elicitation.
 *
 * Every rendered field resolves to a non-empty string on the barest payload
 * there is: the live run rendered a blank subject, and a card that says
 * "undefined" asks a user to approve something they cannot see.
 *
 * `noAlwaysAllow` because neither side can honour it. The host only remembers
 * an approval that carries a `commandHash` (bash), and codex only persists one
 * off the chosen option's metadata, which we do not echo — so the button would
 * promise what nothing implements. Precedent: the worktree approval floor,
 * `SessionManager.handleAgentPermissionRequest`.
 */
export function mapElicitationApprovalToRequest(
  requestId: string,
  params: unknown,
  /**
   * For url mode, the VALIDATED href. It becomes the card's subject: consent to
   * a link nobody can read is not consent, and the validated form is what will
   * actually be opened.
   */
  validatedUrl?: string,
): NessyApprovalRequest {
  const p = isRecord(params) ? params : {};
  const meta = isRecord(p._meta) ? p._meta : {};
  const serverName = nonEmptyString(p.serverName);
  // `tool_title` is the app-server's own display name for the tool it is asking
  // about (`core/src/mcp_tool_call.rs`); without it the card names the server.
  const toolTitle = nonEmptyString(meta.tool_title);
  const toolName = toolTitle ?? codexMcpToolCallRowName(p, meta) ?? serverName ?? 'MCP server';
  const message = nonEmptyString(p.message);
  // `tool_params_display` is what the tool was called WITH — the subject of the
  // approval. Its fallback still names something concrete rather than nothing.
  const subject = nonEmptyString(validatedUrl)
    ?? nonEmptyString(meta.tool_params_display) ?? renderedToolParamsDisplay(meta.tool_params_display)
    ?? (serverName && toolTitle ? `${serverName}: ${toolTitle}` : toolName);
  return {
    requestId,
    toolName,
    command: subject,
    description: message ?? `Allow ${toolName} to run`,
    noAlwaysAllow: true,
    ...(serverName ? { reason: `MCP server: ${serverName}` } : {}),
  };
}

/**
 * The decline sentinel codex puts in its own approval form
 * (`core/src/mcp_tool_call.rs`), alongside the `approve` option. Choosing it
 * would turn an approval into a refusal, so it is never an accepted answer.
 */
const DECLINE_CONST_PREFIX = '__codex_mcp_decline';

type FillScalar = string | number | boolean;

/** A value is usable unless it is the decline sentinel or an unanswerable type. */
function usableScalar(value: unknown): value is FillScalar {
  if (typeof value === 'string') return !value.startsWith(DECLINE_CONST_PREFIX);
  return typeof value === 'number' || typeof value === 'boolean';
}

function usableValue(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 && value.every(usableScalar) : usableScalar(value);
}

/** The const/enum options a (sub)schema offers, in declaration order. */
function optionValues(schema: Record<string, unknown>): unknown[] {
  const values: unknown[] = [];
  for (const key of ['oneOf', 'anyOf'] as const) {
    const options = schema[key];
    if (Array.isArray(options)) for (const option of options) if (isRecord(option)) values.push(option.const);
  }
  if (Array.isArray(schema.enum)) values.push(...schema.enum);
  return values;
}

/** The first value a schema property offers that is not the decline sentinel. */
function answerFor(field: unknown): FillScalar | FillScalar[] | undefined {
  if (!isRecord(field)) return undefined;

  // A `default` is an answer like any other, and is held to the same guard: a
  // schema whose default IS the decline option must not be "accepted" with it.
  if (usableValue(field.default)) return field.default as FillScalar | FillScalar[];

  // Multi-select (`McpElicitationTitled/UntitledMultiSelectEnumSchema`): the
  // options live under `items`, and the answer is an array. An explicit
  // `minItems: 0` asks for nothing, so it gets nothing; absent means one.
  if (field.type === 'array') {
    const picks = (isRecord(field.items) ? optionValues(field.items) : []).filter(usableScalar);
    const minItems = typeof field.minItems === 'number' && field.minItems >= 0 ? field.minItems : 1;
    return picks.length >= minItems ? picks.slice(0, minItems) : undefined;
  }

  for (const value of optionValues(field)) if (usableScalar(value)) return value;
  if (field.type === 'boolean') return true;
  return undefined;
}

/** The property names a form schema marks required. */
function requiredFields(requestedSchema: unknown): string[] {
  const required = isRecord(requestedSchema) ? requestedSchema.required : undefined;
  return Array.isArray(required) ? required.filter((name): name is string => typeof name === 'string') : [];
}

/**
 * Fill a form elicitation's `requestedSchema` with the answer an approval
 * carries — for codex's own tool-call form that is `approval_mode: "approve"`,
 * the option it titles "Allow". Returns `null` when there is no form to fill;
 * the caller decides what that means for the answer.
 */
export function buildElicitationContent(requestedSchema: unknown): Record<string, unknown> | null {
  if (!isRecord(requestedSchema) || !isRecord(requestedSchema.properties)) return null;
  const content: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(requestedSchema.properties)) {
    const value = answerFor(field);
    if (value !== undefined) content[name] = value;
  }
  return content;
}

// ============================================================
// item/permissions/requestApproval
// ============================================================

/**
 * `PermissionsRequestApprovalResponse`: `permissions` is REQUIRED (a
 * `GrantedPermissionProfile`), `scope` defaults to `"turn"`, `strictAutoReview`
 * is optional. There is no decision field anywhere in it — the schema cannot
 * say "denied", it can only describe what was granted.
 */
export interface PermissionsResponse {
  permissions: Record<string, unknown>;
  scope: 'turn' | 'session';
}

/**
 * Deny is "granted nothing".
 *
 * `GrantedPermissionProfile` has NO required properties (`fileSystem` and
 * `network` are both optional), so `{}` is a well-formed profile that grants
 * nothing, and codex records it through `TurnState::record_granted_permissions`
 * as the turn's permissions. That is the whole of the denial vocabulary this
 * response has; a JSON-RPC error was considered and rejected, because the
 * app-server's own handler expects a response it can deserialize
 * (`failed to deserialize PermissionsRequestApprovalResponse` sits beside the
 * elicitation one in `app-server/src/bespoke_event_handling.rs`) and an error
 * frame would put us back at "the human's answer never arrived".
 */
const GRANTS_NOTHING: PermissionsResponse = { permissions: {}, scope: 'turn' };

/** The two members of `GrantedPermissionProfile`, which is also the request's shape. */
const GRANTABLE = ['fileSystem', 'network'] as const;

function requestedProfile(params: unknown): Record<string, unknown> | null {
  const p = isRecord(params) ? params : {};
  return isRecord(p.permissions) ? p.permissions : null;
}

/**
 * Answer a permissions request with a profile, never a word codex cannot parse.
 *
 * An Allow grants EXACTLY what was asked for, at `scope: "turn"` — the
 * narrowest of the two documented scopes. One Allow click is consent for the
 * request on screen and nothing more, so the requested set at the narrowest
 * scope is the ceiling: this must never widen a grant, neither by adding a
 * permission that was not asked for nor by promoting it to `"session"`.
 *
 * The values are echoed VERBATIM rather than rebuilt. `GrantedPermissionProfile`
 * and `RequestPermissionProfile` carry the same two member types, and the
 * app-server localizes and validates the granted paths — it interrupts the turn
 * on invalid ones (`failed to interrupt turn after invalid permission paths`) —
 * so the only paths safe to grant are the ones it just sent us.
 */
function buildPermissionsResponse(
  params: unknown,
  allowed: boolean,
  onDegraded?: ElicitationDegradeSink,
): PermissionsResponse {
  if (!allowed) return GRANTS_NOTHING;
  const requested = requestedProfile(params);
  if (requested === null) {
    onDegraded?.('permissions allow degraded to an empty grant: request carried no profile');
    return GRANTS_NOTHING;
  }

  const permissions: Record<string, unknown> = {};
  for (const key of GRANTABLE) {
    if (requested[key] !== undefined && requested[key] !== null) permissions[key] = requested[key];
  }

  // A member we do not know how to grant is not silently dropped: the user said
  // Allow and part of the request is not in the answer.
  const ungrantable = Object.keys(requested).filter(
    key => !(GRANTABLE as readonly string[]).includes(key) && requested[key] !== null,
  );
  if (ungrantable.length > 0) {
    onDegraded?.(`permissions allow degraded to a partial grant: ungrantable [${ungrantable.join(', ')}]`);
  }
  return { permissions, scope: 'turn' };
}

/** One line naming what a permissions request is actually asking for. */
export function describeRequestedPermissions(params: unknown): string {
  const requested = requestedProfile(params);
  if (!requested) return 'additional permissions';
  const parts: string[] = [];
  const network = isRecord(requested.network) ? requested.network : null;
  if (network && network.enabled !== false) parts.push('network access');
  const fs = isRecord(requested.fileSystem) ? requested.fileSystem : null;
  if (fs) {
    for (const mode of ['read', 'write'] as const) {
      const paths = Array.isArray(fs[mode]) ? fs[mode].filter((p): p is string => typeof p === 'string') : [];
      if (paths.length > 0) parts.push(`${mode} ${paths.join(', ')}`);
    }
    const entries = Array.isArray(fs.entries) ? fs.entries : [];
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const path = isRecord(entry.path) ? entry.path : {};
      const shown = nonEmptyString(path.path) ?? nonEmptyString(path.pattern)
        ?? (isRecord(path.value) ? nonEmptyString(path.value.kind) : null);
      if (shown) parts.push(`${nonEmptyString(entry.access) ?? 'access'} ${shown}`);
    }
  }
  return parts.length > 0 ? parts.join('; ') : 'additional permissions';
}

/**
 * The card for a permissions request. It used to be built by the shell mapper,
 * so it read `Tool: shell` / `Run a command` for what is really a request to
 * widen the sandbox — the user could not see what they were approving.
 *
 * `noAlwaysAllow` because the only scope we ever send is `"turn"`: an Always
 * Allow button would promise the `"session"` grant this bridge deliberately
 * does not make.
 */
export function mapPermissionsApprovalToRequest(requestId: string, params: unknown): NessyApprovalRequest {
  const p = isRecord(params) ? params : {};
  const wanted = describeRequestedPermissions(params);
  const cwd = nonEmptyString(p.cwd);
  return {
    requestId,
    toolName: 'request_permissions',
    command: wanted,
    description: `Grant for this turn: ${wanted}`,
    noAlwaysAllow: true,
    ...(nonEmptyString(p.reason) ? { reason: nonEmptyString(p.reason)! } : cwd ? { reason: `Working directory: ${cwd}` } : {}),
  };
}

/**
 * Resolve Nessy's (allowed, alwaysAllow) into a decision string that is a
 * member of the fixed codex approval enum for both command and file-change
 * approvals (accept / acceptForSession / decline are shared members).
 */
export function resolveDecision(_kind: ApprovalKind, allowed: boolean, alwaysAllow?: boolean): 'accept' | 'acceptForSession' | 'decline' {
  if (!allowed) return 'decline';
  if (alwaysAllow) return 'acceptForSession';
  return 'accept';
}

/**
 * The execpolicy prefix an Always Allow on a COMMAND approval should persist as
 * a durable rule, or `null` when there is nothing faithful to persist.
 *
 * The tokens come from the app-server itself, never from re-tokenizing a shell
 * string here:
 * - v2 (`command`) carries `proposedExecpolicyAmendment` — codex's own parsed
 *   prefix ("Optional proposed execpolicy amendment to allow similar commands
 *   without prompting"). Absent it, there is no amendment to persist and this
 *   returns `null` (the caller keeps the session-only grant, unchanged).
 * - v1 (`commandV1`) carries argv directly (`command: string[]`), which is
 *   already the token prefix.
 *
 * Pure and side-effect-free: the caller owns the durable write. Protocol-drift
 * safe — a params shape without either field degrades to `null`, never a throw.
 */
export function execpolicyAmendmentForApproval(
  kind: ApprovalKind,
  params: unknown,
): readonly string[] | null {
  const p = isRecord(params) ? params : {};
  // P2.407 — A HOST-SCOPED CONSENT MUST NOT MINT A COMMAND-SCOPED RULE.
  //
  // `CommandExecutionRequestApprovalParams` carries `networkApprovalContext` and
  // `proposedExecpolicyAmendment` as independent optional fields, so a
  // managed-network approval can arrive with BOTH. Persisting the execpolicy
  // prefix off such a frame would durably allow the whole command — `curl`, say
  // — on the strength of a user agreeing to reach one host, and every later
  // `curl` anywhere would then run unprompted. The over-grant is silent, durable
  // and in the widening direction, which is the combination this tree treats as
  // the worst one.
  //
  // The conservative direction costs one prompt; the permissive one costs a
  // standing egress-shaped hole. So the grant degrades to session-only, which is
  // exactly what an absent `proposedExecpolicyAmendment` already does — no new
  // code path, just a refusal to take this one.
  //
  // INERT TODAY BY CONSTRUCTION, and said out loud rather than left to be
  // discovered: `networkApprovalContext` only arrives when codex's managed proxy
  // runs, and we do not enable it. This is a floor waiting for the day something
  // does, not a fix to observed behaviour. Its arrival is UNMEASURED here for
  // that reason — obtaining the frame needs `network_proxy`, which this lane is
  // forbidden to write.
  if (readNetworkApprovalContext(p)) return null;
  // P7.2 · THE SAME REFUSAL ONE LAYER DOWN, so the two cannot drift apart.
  // `mapCommandApprovalToRequest` sets `noAlwaysAllow` for a non-`command`
  // `CommandExecutionApprovalKind`; this is the half that runs if a caller ever
  // reaches the amendment without going through the card. A `writeStdin` frame
  // carries the command that STARTED the terminal, so an amendment minted from
  // it would be a durable allow for a command the user never agreed to run.
  const frameKind = typeof p.kind === 'string' && p.kind ? p.kind : 'command';
  if (frameKind !== 'command') return null;
  const source = kind === 'command'
    ? p.proposedExecpolicyAmendment
    : kind === 'commandV1'
      ? p.command
      : undefined;
  if (!Array.isArray(source)) return null;
  const tokens = source.filter((token): token is string => typeof token === 'string' && token.length > 0);
  return tokens.length > 0 ? tokens : null;
}

// ============================================================
// execCommandApproval / applyPatchApproval — the legacy v1 pair
// ============================================================

/** The v1 methods, whose params and decision enum both differ from their v2 twins. */
export const LEGACY_EXEC_METHOD = 'execCommandApproval';
export const LEGACY_PATCH_METHOD = 'applyPatchApproval';

/**
 * v1's `ReviewDecision` is a DIFFERENT enum from the v2 approval decisions:
 * `approved` | `approved_for_session` | `{denied: {rejection}}` | `timed_out` |
 * `abort`, plus two more object variants we never emit. Answering a v1 request
 * with v2's `accept`/`decline` would be exactly as unparseable as `{}`.
 *
 * **`denied` STOPPED BEING A BARE STRING** in `rust-v0.147.0`: it is now the
 * object variant `{denied: {rejection}}`, carrying the reason upstream added so
 * a refusal reaches the model instead of vanishing (`#34400`, "preserved
 * rejection reasons across tools"). Emitting the old string here would fail to
 * deserialize server-side — the same silent-rejection failure mode the rest of
 * this module exists to prevent — so the reason is a required part of a no.
 *
 * Whether the bundled app-server still emits these under `experimentalApi: true`
 * was not proved either way. They are declared in the generated `ServerRequest`
 * union and in the binary's own method table, and one switch arm is cheap
 * insurance against a frame we would otherwise garble.
 */
export type LegacyReviewDecision =
  | 'approved'
  | 'approved_for_session'
  | { denied: { rejection: string } };

/** The reason a v1 denial carries when the user simply said no. */
const LEGACY_DENIED_REJECTION = 'The user declined this action.';

/**
 * P6.1 — `rejection` is the ONE place in this protocol where a refusal can say
 * why, and the default sentence is false for most of our refusals.
 *
 * Measured against `github.com/openai/codex` at `rust-v0.148.0`, the tag shipped
 * when this was read (today's is `manifest.json`'s `upstream.tag`):
 * `ReviewDecision::Denied { rejection: String }` is the only
 * denial in either protocol version that carries a reason at all. Its v2
 * counterparts — `CommandExecutionApprovalDecision::Decline`,
 * `FileChangeApprovalDecision::Decline`, and the whole of
 * `PermissionsRequestApprovalResponse` — have NO field for one, and
 * `impl From<CoreReviewDecision> for CommandExecutionApprovalDecision` maps
 * `Denied { .. } => Decline`, dropping the string codex itself had. (Positive
 * control on the same read: the same structs DO carry `reason: Option<String>`
 * on the request side, so the absence is a design fact and not a failed grep.)
 *
 * So on the v2 path a refusal of ours cannot name anything, and that residue is
 * stated rather than papered over. On the v1 path it can, and until this
 * parameter existed every refusal said "The user declined this action." — a
 * floor denial, a permission-rule denial and a `dontAsk` denial all attributed
 * to a human who was never asked. Callers that HAVE a reason pass it; the
 * default stays for the case it describes, which is a person actually saying no.
 */
export function resolveLegacyDecision(
  allowed: boolean,
  alwaysAllow?: boolean,
  rejection?: string,
): LegacyReviewDecision {
  // Non-empty is not decoration: an empty `rejection` would replace a true
  // sentence with nothing at all.
  if (!allowed) return { denied: { rejection: rejection?.trim() || LEGACY_DENIED_REJECTION } };
  return alwaysAllow ? 'approved_for_session' : 'approved';
}

function isLegacyKind(kind: ApprovalKind): boolean {
  return kind === 'commandV1' || kind === 'fileChangeV1';
}

/** v1 `ExecCommandApprovalParams`: `command` is argv, not a string. */
export function mapLegacyExecApprovalToRequest(requestId: string, params: unknown): NessyApprovalRequest {
  const p = isRecord(params) ? params : {};
  const argv = Array.isArray(p.command) ? p.command.filter((part): part is string => typeof part === 'string') : [];
  const command = argv.join(' ');
  return {
    requestId,
    toolName: 'shell',
    command: command || 'a command',
    description: command ? `Run: ${command}` : 'Run a command',
    ...(nonEmptyString(p.reason) ? { reason: nonEmptyString(p.reason)! } : {}),
  };
}

/** v1 `ApplyPatchApprovalParams`: the changed paths are the keys of `fileChanges`. */
export function mapLegacyPatchApprovalToRequest(requestId: string, params: unknown): NessyApprovalRequest {
  const p = isRecord(params) ? params : {};
  const paths = isRecord(p.fileChanges) ? Object.keys(p.fileChanges) : [];
  const grantRoot = nonEmptyString(p.grantRoot);
  const subject = paths.length > 0 ? paths.join(', ') : grantRoot ?? 'the workspace';
  return {
    requestId,
    toolName: 'ApplyPatch',
    command: subject,
    description: `Apply file changes to ${subject}`,
    ...(nonEmptyString(p.reason) ? { reason: nonEmptyString(p.reason)! } : {}),
  };
}

// ============================================================
// Methods we answer without a card
// ============================================================

/**
 * The refusal for a server→client method whose FEATURE this client does not
 * implement — in the shape that method's response schema requires, so the
 * app-server parses a "no" instead of failing to parse anything.
 *
 * Returns `null` for a method that must keep answering `{}`. Two do:
 * `account/chatgptAuthTokens/refresh` (`accessToken`, `chatgptAccountId`) and
 * `attestation/generate` (`token`) consist entirely of required credential
 * strings and have no refusal form. Every value we could put there is a forged
 * credential the app-server would then USE, so a frame it cannot deserialize —
 * a visible failure — is the honest answer. We also decline attestation at
 * `initialize` (`requestAttestation: false`, "Opt into `attestation/generate`
 * requests"), so it should never arrive at all.
 */
export function buildUnsupportedResponse(
  method: string,
  params: unknown,
  onDegraded?: ElicitationDegradeSink,
): Record<string, unknown> | null {
  const p = isRecord(params) ? params : {};

  if (method === 'item/tool/requestUserInput') {
    // `answers` maps question id → answer; an empty map is a well-formed
    // "nothing was answered", and inventing an answer would put words in the
    // user's mouth.
    //
    // P6.344 — THIS IS NO LONGER THE LIVE ANSWER, and the sentence it used to
    // carry ("this runtime has no question surface") was never true: the host
    // renders the identical card for Pi and for claude, and
    // `CodexAgent.handleCodexRequestUserInput` now intercepts this method
    // BEFORE `handleServerRequest` reaches here. What is left is the fallback
    // for a caller that binds no such handler — a test rig, or a future client
    // of this bridge — so the branch stays and says which case it is.
    const asked = Array.isArray(p.questions) ? p.questions.length : 0;
    onDegraded?.(
      'item/tool/requestUserInput answered with no answers: no question handler is bound to this '
      + `bridge (${asked} asked)`,
    );
    return { answers: {} };
  }

  if (method === 'item/tool/call') {
    // A dynamic tool call (`core/src/tools/handlers/dynamic.rs`), for tools a
    // client registers. We register none, so the schema's own failure shape is
    // the whole truth.
    onDegraded?.('item/tool/call refused: no dynamic tool is registered by this client');
    return {
      success: false,
      contentItems: [{ type: 'inputText', text: 'This client does not implement dynamic tool calls.' }],
    };
  }

  return null;
}

const DECLINED: ElicitationResponse = { action: 'decline', content: null };

/** Told the branch on which a user's Allow could not be honoured. */
export type ElicitationDegradeSink = (reason: string) => void;

function degrade(onDegraded: ElicitationDegradeSink | undefined, reason: string): ElicitationResponse {
  onDegraded?.(`elicitation allow degraded to decline: ${reason}`);
  return DECLINED;
}

/**
 * The answer to one elicitation, which never claims something that did not
 * happen.
 *
 * - A denial declines.
 * - URL mode declines HERE, on the unattended path. Answering it means opening
 *   a browser, which is a side effect nobody asked for when there is no user at
 *   the keyboard. The interactive path does not come through this function: it
 *   surfaces a card and answers through `buildUrlElicitationResponse`.
 * - A form we cannot fully fill declines. An accept missing a required field is
 *   an invalid response to the server, and the values would be ones the user
 *   never gave; `elicitation.ts:63-71` refuses a partial accept for the same
 *   reason. A form-mode request carrying no schema at all is the same case.
 *
 * Each of those last three turns a user's Allow into a decline, which on the
 * wire is indistinguishable from the silent rejection this bridge exists to
 * fix. So every one of them reports its branch through `onDegraded`: the Pi
 * precedent is `declineVisibly` — refuse, but never silently. A log line is
 * the floor; the user-visible reason rides the url-mode port.
 */
function buildElicitationResponse(
  params: unknown,
  allowed: boolean,
  onDegraded?: ElicitationDegradeSink,
): ElicitationResponse {
  if (!allowed) return DECLINED;
  const p = isRecord(params) ? params : {};
  if (p.mode === 'url') return degrade(onDegraded, 'url-mode not offered: no user to show it to');
  const content = buildElicitationContent(p.requestedSchema);
  if (content === null) return degrade(onDegraded, 'no form schema');
  const missing = requiredFields(p.requestedSchema).filter(name => content[name] === undefined);
  if (missing.length > 0) return degrade(onDegraded, `unfillable required [${missing.join(', ')}]`);
  return { action: 'accept', content };
}

/** True when an elicitation is the browser-URL kind rather than a form. */
export function isUrlElicitation(params: unknown): boolean {
  return isRecord(params) && params.mode === 'url';
}

/**
 * The answer to a URL-mode elicitation the user was actually shown.
 *
 * ACCEPT SEMANTICS — `accept` means "the client accepted the request and opened
 * the URL", NOT "the user finished the flow". The evidence is in the bundled
 * app-server: url mode is the only mode whose params carry a required
 * `elicitationId`, and the binary implements the MCP notification
 * `notifications/elicitation/complete`, whose
 * `ElicitationResponseNotificationParam` carries exactly that one field. The
 * server announces completion out-of-band keyed by the id, so the JSON-RPC
 * response is not what reports it.
 *
 * That is a deliberate divergence from the Pi flow's second dialog
 * (`handleUrlElicitation`; `mcp.md:1089` — "Complete the flow in the browser,
 * then confirm in the CLI"). Claude Code has no completion notification and so
 * must ask; codex has one, and holding this response open until a human
 * confirms would block the turn on an answer codex is not waiting for. The
 * SAFETY half of the Pi flow is not diverged from at all: the same
 * `safeHttpUrl` gate decides what may be opened, and a refusal is never silent.
 *
 * `content` is null: a url accept carries no form values, which is also what
 * the Pi flow returns for this mode.
 */
export function buildUrlElicitationResponse(
  opened: boolean,
  reason?: string,
  onDegraded?: ElicitationDegradeSink,
): ElicitationResponse {
  if (opened) return { action: 'accept', content: null };
  return degrade(onDegraded, reason ?? 'url-mode was not opened');
}

/**
 * The JSON-RPC result for one bridged approval, in the shape its own method
 * requires: `{decision}` for the command/file-change families, `{action}` for
 * an MCP elicitation. Every branch produces a well-formed frame — a decision
 * the far side cannot parse is worse than a refusal it can.
 *
 * `alwaysAllow` has no elicitation spelling: the app-server persists an MCP
 * tool approval off the chosen option's metadata, which we do not echo, so
 * "always allow" degrades to a single accept and the next call asks again. The
 * card hides the button for the same reason (`mapElicitationApprovalToRequest`).
 */
export function buildApprovalResponse(
  kind: ApprovalKind,
  params: unknown,
  allowed: boolean,
  alwaysAllow?: boolean,
  onDegraded?: ElicitationDegradeSink,
  /**
   * Why this was refused, when something other than a person refused it (P6.1).
   *
   * Reaches the model on the v1 kinds only — see {@link resolveLegacyDecision}
   * for the measured reason the v2 approval responses have nowhere to put it.
   * Ignored on an approval, and ignored on the elicitation and permissions
   * kinds, whose own response shapes carry no reason either.
   */
  rejection?: string,
): Record<string, unknown> {
  if (kind === 'elicitation') return { ...buildElicitationResponse(params, allowed, onDegraded) };
  if (kind === 'permissions') return { ...buildPermissionsResponse(params, allowed, onDegraded) };
  if (isLegacyKind(kind)) return { decision: resolveLegacyDecision(allowed, alwaysAllow, rejection) };
  return { decision: resolveDecision(kind, allowed, alwaysAllow) };
}

/**
 * The answer when a pending approval is torn down rather than decided — an
 * aborted turn or a dying agent.
 *
 * An elicitation gets `cancel`, the enum's dismissed-dialog member: nobody
 * refused, the dialog went away. The command/file-change families keep the
 * `decline` they have always sent on abort.
 */
export function buildAbortResponse(kind: ApprovalKind, _params?: unknown): Record<string, unknown> {
  if (kind === 'elicitation') return { action: 'cancel', content: null };
  // A torn-down permissions request grants nothing; the schema has no way to
  // say "cancelled", and a grant is the one thing an abort must not produce.
  if (kind === 'permissions') return { ...GRANTS_NOTHING };
  // v1 `abort`: "the agent should not do anything until the user's next
  // command" — the teardown member of that enum.
  if (isLegacyKind(kind)) return { decision: 'abort' };
  return { decision: resolveDecision(kind, false) };
}

/** True if a server→client request method is an approval request we bridge. */
export function isApprovalMethod(method: string): boolean {
  return (
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval' ||
    method === PERMISSIONS_METHOD ||
    method === MCP_ELICITATION_METHOD ||
    method === LEGACY_EXEC_METHOD ||
    method === LEGACY_PATCH_METHOD
  );
}

export function approvalKindForMethod(method: string): ApprovalKind {
  if (method === MCP_ELICITATION_METHOD) return 'elicitation';
  if (method === PERMISSIONS_METHOD) return 'permissions';
  if (method === LEGACY_EXEC_METHOD) return 'commandV1';
  if (method === LEGACY_PATCH_METHOD) return 'fileChangeV1';
  return method === 'item/fileChange/requestApproval' ? 'fileChange' : 'command';
}

// ============================================================
// P2.407 — the approval codex reviewed ON OUR BEHALF
// ============================================================

/**
 * WHAT codex's auto-review just decided about, off the `action` field of
 * `item/autoApprovalReview/{started,completed}`.
 *
 * ## The gap this closes
 *
 * The event adapter consumes both notifications and reads `review` — the
 * VERDICT — and never `action`, the SUBJECT. So a guardian denial reached the
 * user as "Auto-review denied this action", with "this action" naming nothing,
 * and reached the audit trail as nothing at all. P2.384's finding was that an
 * unauditable influence on permission outcomes is worse than an absent one;
 * this is the half of the receipt that was missing, and it costs one field read.
 *
 * ## All six variants, none of them guessed
 *
 * `GuardianApprovalReviewAction` (`generated/v2/`, ts-rs output from the codex
 * source at `rust-v0.148.0`, the tag shipped when this was read) is a
 * `"type"`-tagged union of exactly six:
 *
 * | `type` | fields |
 * | --- | --- |
 * | `command` | `source, command, cwd` |
 * | `execve` | `source, program, argv, cwd` |
 * | `applyPatch` | `cwd, files` |
 * | `networkAccess` | `target, host, protocol, port` |
 * | `mcpToolCall` | `server, toolName, connectorId, connectorName, toolTitle` |
 * | `requestPermissions` | `reason, permissions` |
 *
 * `networkAccess` is the one P2.384 named as unconsumed "even on the path where
 * it would arrive"; it is handled here with the other five rather than alone,
 * because a describer that knew one variant would leave the other five in the
 * same silence one row later.
 *
 * Every branch is bounded and falls back to the bare `type`, so an unknown
 * seventh variant from a future binary still produces a name instead of an empty
 * string — the failure mode this whole function exists to end.
 *
 * Returns `null` only when there is no readable action at all.
 */
export function describeGuardianReviewAction(action: unknown): string | null {
  if (!isRecord(action)) return null;
  const type = nonEmptyString(action.type);
  if (!type) return null;
  const cut = (value: unknown, max: number): string | null => {
    const text = nonEmptyString(value);
    if (!text) return null;
    const collapsed = text.replace(/\s+/g, ' ');
    return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
  };
  switch (type) {
    case 'command': {
      const command = cut(action.command, 200);
      const cwd = cut(action.cwd, 160);
      if (!command) return cwd ? `run a command in ${cwd}` : 'run a command';
      return cwd ? `run \`${command}\` in ${cwd}` : `run \`${command}\``;
    }
    case 'execve': {
      const argv = Array.isArray(action.argv)
        ? action.argv.filter((part): part is string => typeof part === 'string').slice(0, 12).join(' ')
        : '';
      const program = cut(action.program, 160) ?? 'a program';
      const shown = cut(argv ? `${program} ${argv}` : program, 200)!;
      const cwd = cut(action.cwd, 160);
      return cwd ? `execute \`${shown}\` in ${cwd}` : `execute \`${shown}\``;
    }
    case 'applyPatch': {
      const files = Array.isArray(action.files)
        ? action.files.filter((file): file is string => typeof file === 'string')
        : [];
      const cwd = cut(action.cwd, 160);
      // F1.724 — the files themselves, not the turn's folder: a patch to one file outside that folder read
      // "patch 1 file under <cwd>" (SIT-u, 2026-09-25). Three named, the rest counted.
      const named = files.slice(0, 3).map(file => cut(file, 160)).filter((file): file is string => file !== null);
      if (named.length === 0) return cwd ? `patch files in ${cwd}` : 'patch files';
      const more = files.length - Math.min(files.length, 3);
      return `patch ${named.join(', ')}${more > 0 ? ` and ${more} more file${more === 1 ? '' : 's'}` : ''}`;
    }
    case 'networkAccess': {
      // The one variant that carries a port, so unlike the approval-side
      // `NetworkApprovalContext` this one can name the full endpoint.
      const host = cut(action.host, 160) ?? cut(action.target, 160);
      if (!host) return 'reach the network';
      const port = typeof action.port === 'number' && Number.isFinite(action.port)
        ? `:${action.port}`
        : '';
      const protocol = cut(action.protocol, 32);
      return protocol ? `reach ${host}${port} over ${protocol}` : `reach ${host}${port}`;
    }
    case 'mcpToolCall': {
      const tool = cut(action.toolName, 120) ?? cut(action.toolTitle, 120);
      const server = cut(action.server, 120) ?? cut(action.connectorName, 120);
      if (!tool) return server ? `call an MCP tool on ${server}` : 'call an MCP tool';
      return server ? `call MCP tool ${server}/${tool}` : `call MCP tool ${tool}`;
    }
    case 'requestPermissions': {
      // `permissions` is a `RequestPermissionProfile` — the same shape the
      // permissions CARD renders, so it is described by the same function rather
      // than by a second, drifting copy.
      const wanted = describeRequestedPermissions({ permissions: action.permissions });
      const why = cut(action.reason, 160);
      return why ? `widen this turn's permissions (${wanted}) — ${why}` : `widen this turn's permissions (${wanted})`;
    }
    default:
      return type;
  }
}

// ============================================================
// P6.1065 — the STRICT REVIEW codex's own reviewer demands
// ============================================================

/**
 * The notification method codex publishes when its own auto-approval reviewer
 * decides the cheap path cannot answer and a strict review is required.
 *
 * Kept beside the approval methods because it belongs to the same vocabulary:
 * `item/autoApprovalReview/{started,completed}` report a review, and this one
 * reports that the review must be the strict kind. It is NOT an approval method
 * — {@link isApprovalMethod} deliberately does not admit it — because nothing
 * answers it; it is a notification the host observes.
 */
export const CODEX_STRICT_REVIEW_REQUIRED_METHOD = 'autoApprovalReview/strictReviewRequired';

/**
 * P6.1065 — the sentence for one `autoApprovalReview/strictReviewRequired`
 * frame, or `null` when the frame carries nothing a host can stand behind.
 *
 * ## WHEN it fires, read from the source (codex outranks its page)
 *
 * `codex-rs/app-server/src/bespoke_event_handling.rs` at `rust-v0.150.1` emits
 * it in exactly one place, and under TWO conditions together: the guardian
 * assessment that just arrived has status `InProgress` — the same event that
 * produces `item/autoApprovalReview/started` — AND the thread's extension data
 * carries a `StrictReviewReason`, which is `remove`d as it is read, so the
 * notification fires once per reason rather than once per assessment.
 *
 * `StrictReviewReason` (`codex-rs/ext/guardian-v2/src/async_scorer/extension.rs`)
 * has exactly two variants and the source's own docblock says what they are for:
 * *"Explains why Guardian v2 requires synchronous approval review."*
 *
 * | variant | inserted when |
 * | --- | --- |
 * | `StaleScore` | the tool-call lag exceeds `max_tool_call_lag` — the cached risk score is too far behind to be trusted |
 * | `ElevatedRisk` | the latest FAILED tool call is newer than the latest scored one, or the cached `action_risk` score is at or above `review_threshold` |
 *
 * **The frame carries none of that.** `StrictReviewRequiredNotification`
 * (`app-server-protocol/src/protocol/v2/notification.rs`) is
 * `{ threadId, turnId, startedAtMs }` and nothing else, so the honest sentence
 * says that strict review was demanded and WHEN the review started — never why.
 * Inventing a reason from the two source variants would be a guess at runtime
 * about a field the wire does not carry.
 *
 * ## What a green here does NOT prove, measured rather than assumed
 *
 * `guardianv2` — the only extension that ever inserts a `StrictReviewReason` —
 * self-reports `stage: "underDevelopment"`, `enabled: false`,
 * `defaultEnabled: false` on the shipped `0.150.1` darwin-arm64 binary
 * (`experimentalFeature/list`, 124 features, with `guardian_approval`
 * `stable`/`enabled` in the same answer as the positive control). So the frame
 * is real in the contract and in the binary's own method table
 * (`grep -ao` counts it 3 times, the same count as the
 * `item/autoApprovalReview/completed` we already consume) and it cannot arrive
 * on a session today. This listener is correct and inert; it becomes live the
 * day that feature is turned on, and the alternative — dropping a safety
 * demand in `default:` — is the one thing that must not happen when it is.
 *
 * Returns `null` for any frame that is not a readable strict-review frame, so
 * an unrelated notification routed here by mistake produces nothing rather than
 * a sentence about a turn that was never reviewed.
 */
export function describeStrictReviewRequired(params: unknown): string | null {
  if (!isRecord(params)) return null;
  // `turnId` is the one field that makes the sentence about something; a frame
  // without it names no turn and is not worth surfacing.
  const turnId = nonEmptyString(params.turnId);
  if (!turnId) return null;
  const startedAtMs = typeof params.startedAtMs === 'number' && Number.isFinite(params.startedAtMs)
    ? params.startedAtMs
    : null;
  const when = startedAtMs === null ? '' : ` (review started ${new Date(startedAtMs).toISOString()})`;
  return `Auto-review requires a strict review of this turn${when}.`
    + ' The runtime\'s own reviewer could not approve from its cached assessment.';
}

/**
 * F1.218 — the name the HOST gives codex's own MCP tool-call approval, so its
 * card is filed under the call it asks about and not under the bridge.
 *
 * Read off the frame the shipped `codex-app-server` sends at `rust-v0.154.0`
 * (measured 2026-09-23; `core/src/mcp_tool_call.rs`,
 * `build_mcp_tool_approval_elicitation_meta` and
 * `build_mcp_tool_approval_fallback_message`): `_meta.codex_approval_kind` is
 * `"mcp_tool_call"`, and for a server that is not codex's own apps server the
 * tool is named ONLY in codex's fixed sentence
 * `Allow the <server> MCP server to run tool "<tool>"?` — no `tool_title`
 * unless the tool declares a title. The result is spelled the way the
 * transcript row spells the same call (`mcp__<server>__<tool>`, codex's raw
 * pair, `backend/codex/event-adapter.ts` `mcpRowToolName`). Any other frame, or
 * a sentence that is not that WHOLE sentence for this frame's own server (a
 * connector template, another server's sentence, a prefixed one), answers
 * `null` and the card keeps its older name.
 *
 * F1.381 — read as the whole sentence, never as its tail. Since F1.272 this name
 * feeds ALLOW decisions, and a read anchored only at the end took a tool named
 * `x" to run tool "whoami` for `whoami`. At `rust-v0.154.0` the actor is
 * `the <server> MCP server` for every server but codex's own apps server (a
 * `connector_name` and the `message_override` template exist only there, and
 * this product writes `apps = false`), so the prefix is known from `serverName`
 * and matched literally, and a tool part carrying a quote is refused.
 */
export function codexMcpToolCallRowName(p: Record<string, unknown>, meta: Record<string, unknown>): string | null {
  if (meta.codex_approval_kind !== 'mcp_tool_call') return null;
  const server = nonEmptyString(p.serverName);
  if (!server || typeof p.message !== 'string') return null;
  const message = p.message.trim();
  const prefix = `Allow the ${server} MCP server to run tool "`;
  if (!message.startsWith(prefix) || !message.endsWith('"?')) return null;
  const tool = message.slice(prefix.length, -2);
  return tool.length > 0 && !tool.includes('"') ? `mcp__${server}__${tool}` : null;
}

/**
 * F1.218 — `tool_params_display` at `rust-v0.154.0` is an ARRAY of
 * `{ name, value, display_name }` (`RenderedMcpToolApprovalParam`), not the
 * string the older frame carried, so the card's subject reads it as
 * `display_name: value` pairs. `null` for an empty or unreadable list.
 */
function renderedToolParamsDisplay(display: unknown): string | null {
  if (!Array.isArray(display)) return null;
  const parts = display.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const label = nonEmptyString(entry.display_name) ?? nonEmptyString(entry.name);
    if (!label) return [];
    return [`${label}: ${typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value)}`];
  });
  return parts.length > 0 ? parts.join(', ') : null;
}
