/**
 * P2.458 — the `WorktreeCreate` / `WorktreeRemove` seam, which is the OTHER
 * side of P2.427's worktree leak.
 *
 * ## Why this exists at all
 *
 * P6.20 refused to wire the shipped binary's `--worktree` flag on the premise
 * that *a worktree the runtime creates for itself has a path the host never
 * learns* — no lease, no working-directory record, no retention sweep. P2.453
 * refuted that premise and recorded the verdict at the `extraArgs` site in
 * `claude-agent.ts`. What P2.453 also measured is why this file is urgent
 * rather than optional: **the hook fires on routes this fork does not drive.**
 *
 * `hooks.md#worktreecreate`: *"Runs when a worktree is being created, whether
 * from `claude --worktree`, from a subagent using `isolation: "worktree"`, or
 * for a background session that Claude Code isolates in its own worktree."*
 * A subagent declaring worktree isolation and a background session are live
 * today, and `sdk.d.ts` gives the second one a worktree DEFAULT —
 * `worktree.bgIsolation?: 'worktree' | 'none'`, documented in the same file as
 * *"Isolation mode for background sessions in this repo. 'worktree' (default)"*.
 * Registering no hook therefore does not mean "the feature is off"; it means
 * those paths create worktrees through the binary's own `git worktree` that
 * nothing on the host can lease, record or sweep.
 *
 * ## What the hook lets the host do about it
 *
 * `hooks.md#worktreecreate`: *"By default Claude Code creates the isolated
 * working copy with `git worktree`. Configuring a WorktreeCreate hook replaces
 * that default git behavior"*, and *"The hook must return the path to the
 * created worktree directory. Claude Code uses this path as the working
 * directory for the isolated session."* The teardown half,
 * `hooks.md#worktreeremove`: *"Claude Code passes the path returned by
 * WorktreeCreate as `worktree_path` in the hook input."*
 *
 * So the host does not merely learn the path — it CHOOSES it. That is what
 * makes a claude worktree indistinguishable from a Pi one: the same lease
 * service mints both.
 *
 * ## The route, which the page does not document (bundle-as-denominator)
 *
 * `hooks.md#worktreecreate-output` lists exactly two ways to return the path:
 * *"**Command hooks** (`type: "command"`): print the path as the last non-empty
 * line of stdout"* and *"**HTTP hooks** (`type: "http"`): return `{
 * "hookSpecificOutput": { "hookEventName": "WorktreeCreate", "worktreePath":
 * "/absolute/path" } }`"*. An SDK consumer registers neither — it registers a
 * CALLBACK, and reading only the page would conclude the callback cannot
 * return a path. Per `AGENTS.md` the bundle is the denominator for what the
 * runtime CAN do, and the bundle is unambiguous. Measured in the vendored
 * native binary (`@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`), which
 * carries both the failure string that names three routes —
 *
 *   `WorktreeCreate hook failed: hook succeeded but returned no worktree path`
 *   `(command: echo the path to stdout; http/callback: return`
 *   `hookSpecificOutput.worktreePath)`
 *
 * — and the code that implements the callback arm:
 *
 *   `let H = i==="WorktreeCreate" && zU(L) && L.hookSpecificOutput?.hookEventName==="WorktreeCreate"`
 *   `  ? L.hookSpecificOutput.worktreePath : L.systemMessage||"";`
 *   `… return {command:"callback",succeeded:!0,output:H,blocked:q}`
 *
 * and the consumer that reads it back, which takes the FIRST succeeded hook
 * whose output is non-empty:
 *
 *   `n = r.filter((o)=>o.succeeded).map((o)=>JPb(o.output)).find((o)=>o.length>0)`
 *
 * Counts on that binary, one rig, one run, `grep -a -o -F | wc -l`:
 * `WorktreeCreate` 79, `worktreePath` 286, `WorktreeRemove` 44,
 * `worktree_path` 5, `http/callback` 2, against `PreToolUse` 132 as the
 * positive control and a nonsense string at 0.
 *
 * Those counts are MEMBERSHIP and nothing more — they establish the names are
 * in the artefact, while the quoted body above is what establishes the callback
 * arm runs. P3.171 measured why that distinction is not pedantry, and the
 * instrument is `__tests__/binary-evidence.ts` beside this file: in the JS
 * bundle we ship alongside this binary, 753 of 834 declared env names have no
 * reader in that file at all, so an accessor-existence probe there separates
 * nothing; and a reader-shape probe needs a control of BOTH polarities — a name
 * known to be read AND a name known to be mentioned-and-unread — before any zero
 * of its own carries information.
 *
 * ## Two rules that fall out of that measurement, both load-bearing
 *
 * 1. **A registered hook that returns no path BREAKS creation.** The same
 *    binary throws on `n === undefined`, and `hooks.md#exit-code-2-behavior-per-event`
 *    agrees: *"The exception is `WorktreeCreate`, where any non-zero exit code
 *    aborts worktree creation."* So the hook is registered ONLY when a port
 *    exists that can actually create one. Absent port → nothing registered →
 *    the binary's own `git worktree` path, byte-identical to today.
 * 2. **A user's own `WorktreeCreate` hook wins outright, and ours stands
 *    down.** Because the binary takes the FIRST non-empty output, two
 *    path-returning hooks means one of them created a worktree that the session
 *    never enters — a NEW leak, on either ordering. A user who configured a
 *    Perforce checkout gets it; the host records the removal it is told about
 *    and says in the debug log that it did not create this one.
 */

import { resolveHookWorktreePath } from '../../../automations/hook-worktree-path.ts';
import type {
  SdkAutomationCallbackMatcher,
  SdkAutomationCallbackResult,
  SdkAutomationInput,
} from '../../../automations/types.ts';
import type { ClaudeWorktreePort } from './worktree-port.ts';

/**
 * D1.126 — the MECHANICAL cause of "two views of where this session is working",
 * stated here because this is the only file that can see it.
 *
 * The 1.36.0 sitting (W14-sit, RS-27, PASS 5/5) measured claude's native
 * `EnterWorktree` answering *"Created worktree at …/worktree-mighty-gliding-galaxy.
 * The session is now working in the worktree."* while the host's recorded
 * `workingDirectory` was unchanged — `cwd-after` equalled `cwd-before`.
 *
 * The host is NOT blind to that worktree: P6.839's residual is answered, and the
 * route the host IS in is this hook — `EnterWorktree` does not reach
 * `canUseTool`, but it does create a worktree, and creation is what
 * `WorktreeCreate` fires on. So the path is leased, recorded and swept. What the
 * host cannot do is tell WHOSE working directory just moved, and the reason is
 * in the payload: `hooks.md#worktreecreate` lists three routes — `claude
 * --worktree`, a subagent with `isolation: "worktree"`, and a background session
 * — and `WorktreeCreateHookInput` carries `name` and `cwd` and NO discriminator
 * among them. On two of the three the OWNER session stays where it is; on
 * `EnterWorktree` the owner session is the thing that moves.
 *
 * That is why `SessionManager.createClaudeWorktreePort`'s "NO cwd MOVE" line is
 * right for the case it was written for and cannot be right for both, and why
 * the notice it appended read as false on the `EnterWorktree` route, in the
 * user's disfavour: there the edits land there AND this session is now working
 * there. D1.220 repaired that sentence in `createClaudeWorktreePort` — it now
 * states the second half conditionally and names the recorded working directory
 * as unchanged — so this paragraph is the mechanism and that site is the
 * wording; if one moves, read the other.
 *
 * POSTURE, stated and defaulted rather than decided for the owner: option B of
 * the row, be HONEST rather than follow. The host does NOT move its
 * `workingDirectory`, for the reason D1.141 records independently — the SDK
 * derives the transcript's project key from that cwd, so moving it silently
 * breaks resume — and the residue is a wording change on the notice, which lives
 * in `server-core` and is handed over rather than taken here. Option A (follow
 * the SDK's cwd) is the owner's to choose and is strictly more expensive: it
 * needs the discriminator this payload does not carry.
 */
export const CLAUDE_WORKTREE_HOOK_EVENTS = ['WorktreeCreate', 'WorktreeRemove'] as const;

/**
 * The two payload fields the shared `SdkAutomationInput` mirror does not carry.
 *
 * `hooks.md#worktreecreate-input`: WorktreeCreate hooks *"receive the `name`
 * field. This is a slug identifier for the new worktree, either specified by
 * the user or auto-generated, for example `bold-oak-a3f2`."*
 * `hooks.md#worktreeremove-input`: WorktreeRemove hooks *"receive the
 * `worktree_path` field, which is the absolute path to the worktree being
 * removed."*
 *
 * Read through a local widening rather than by adding them to the mirror,
 * because both fields are already declared on the SDK's own
 * `WorktreeCreateHookInput` / `WorktreeRemoveHookInput` — the surface
 * `claude-worktree-path-surface.test.ts` pins — and this file is their only
 * reader. NOT because the mirror may not be edited: P2.495 edited that same
 * file to add the RESULT half's `worktreePath`, which is the reason the cast
 * below this comment is gone. It left the INPUT half alone, so the widening
 * here is a choice about two per-event fields with one reader, not a barrier.
 */
type ClaudeWorktreeHookInput = SdkAutomationInput & {
  name?: unknown;
  worktree_path?: unknown;
};

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * A path a lease service may be asked to create at, or to tear down.
 *
 * ABSOLUTE ONLY, and this is not defensive noise. The binary resolves a
 * relative return value against its own notion of the repository
 * (`if(isAbsolute(n)) return {worktreePath:n}; return {worktreePath:resolve(await ZYo(),n)}`),
 * so a relative path can leave the host's lease record and the session's actual
 * working directory pointing at two different directories — which is the leak
 * this row closes, re-created one layer up.
 *
 * The `.`/`..` screen is the runtime's own, quoted so a reader does not have to
 * guess whether we duplicated it or contradicted it —
 * `hooks.md#worktreecreate-output`: *"Claude Code refuses an absolute path that
 * contains `.` or `..` segments, and any path that passes through a symlink
 * below the repository root."* We apply the two cheap halves here so a bad path
 * is refused with OUR diagnostic naming the port, instead of surfacing as the
 * binary's error about a path the user never typed. The symlink half needs a
 * repository root to walk from and is left to the side that has one — the lease
 * service already calls {@link resolveHookWorktreePath} with its own `repoRoot`.
 */
export function screenClaudeWorktreePath(candidate: string): { path: string } | { refusedReason: string } {
  const raw = candidate.trim();
  if (!raw) return { refusedReason: 'the path is empty' };
  // Deliberately NOT `resolveHookWorktreePath` here: that function needs a
  // `repoRoot` and this side does not have one it can defend. Its first two
  // refusals are the ones reproducible without a root, so only those are made.
  if (!raw.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(raw)) {
    return { refusedReason: `the path is not absolute: ${JSON.stringify(raw)}` };
  }
  if (raw.split(/[\\/]+/).some(segment => segment === '.' || segment === '..')) {
    return { refusedReason: `the path contains a '.' or '..' segment: ${JSON.stringify(raw)}` };
  }
  return { path: raw };
}

export interface ClaudeWorktreeHookContext {
  /** The SDK session id, so the host can scope the lease it takes. */
  sessionId?: string;
  /** One line per decision; the only place a stood-down hook is visible. */
  debug?: (line: string) => void;
  /**
   * D1.128 — one sentence per REFUSAL, on a surface the user reads.
   *
   * The runtime's own words for every refusal this file makes are
   * `WorktreeCreate hook failed: hook succeeded but returned no worktree path
   * (command: echo the path to stdout; http/callback: return
   * hookSpecificOutput.worktreePath)` — measured at the 1.36.0 sitting
   * (W14-sit2, RS-28 arm B) as what the session actually shows. That sentence
   * is addressed to whoever WROTE a hook, and the person reading it did not
   * write one: they asked for an isolated session and got a paragraph about
   * stdout conventions.
   *
   * It cannot be replaced — the binary throws it, and the shape it is thrown
   * from is the same one that reads our path back, so any output we could put
   * in its way would be taken FOR a path. What is owed is a host sentence
   * BESIDE it, which is what this callback carries. It is deliberately not a
   * throw and not a decision: refusing is already decided by the time it runs.
   *
   * Absent callback = the pre-row behaviour exactly (a `debug` line and
   * nothing else), so a host that has not wired it cannot regress.
   */
  notice?: (sentence: string) => void;
}

/**
 * The tail every refusal sentence carries.
 *
 * Split out so the three call sites cannot drift apart, and worded to connect
 * the two messages a user sees rather than to compete with the runtime's: a
 * reader who has just met "returned no worktree path" needs to be told that it
 * is the same event and not a second, unrelated failure.
 */
const CLAUDE_WORKTREE_REFUSAL_TAIL =
  ' The isolated session did not start and nothing was created. The runtime follows this with its own'
  + ' message about a hook that "returned no worktree path" — that is this same refusal seen from the'
  + ' hook protocol\'s side, not a second problem, and it is not about anything you configured.';

/**
 * Add the host's worktree hooks to an already-merged SDK hook map.
 *
 * Applied to the MERGED map (internal + user automations) rather than to the
 * internal half, for two reasons that are both about the user's own hooks:
 * rule 2 in this file's header can only be honoured by a function that can SEE
 * a user-declared `WorktreeCreate`, and `WorktreeRemove` has to be appended
 * after theirs rather than instead of it.
 *
 * An ABSENT port changes nothing — same object contents as the input, and the
 * binary keeps creating worktrees with `git worktree`. That is the state every
 * caller was in before this row, so a host that has not wired the port cannot
 * regress by upgrading.
 */
export function withClaudeWorktreeHooks(
  hooks: Record<string, SdkAutomationCallbackMatcher[]>,
  port: ClaudeWorktreePort | undefined,
  context: ClaudeWorktreeHookContext = {},
): Record<string, SdkAutomationCallbackMatcher[]> {
  if (!port) return hooks;
  const debug = context.debug;
  const merged: Record<string, SdkAutomationCallbackMatcher[]> = { ...hooks };

  // Rule 2: a user hook that can return a path owns creation. Ours is not
  // appended "just in case" — a second creating hook is a second worktree.
  const userCreateMatchers = merged.WorktreeCreate?.length ?? 0;
  if (userCreateMatchers > 0) {
    debug?.(
      `[ClaudeWorktree] ${userCreateMatchers} user WorktreeCreate hook(s) declared; the host stands down `
      + 'and will not lease worktrees it did not create (hooks.md#worktreecreate-output: the first hook '
      + 'returning a path wins)',
    );
  } else {
    merged.WorktreeCreate = [{
      hooks: [async input => claudeWorktreeCreateResult(input, port, context)],
    }];
  }

  // Removal is registered either way. `hooks.md#worktreeremove`: *"WorktreeRemove
  // hooks have no decision control. They can't block worktree removal but can
  // perform cleanup tasks"* — so an extra matcher cannot change the outcome, and
  // being told about a teardown the host did not initiate is exactly the record
  // P2.427's sweep is missing. The port is expected to ignore a path it never
  // leased; it holds the records, this side does not.
  merged.WorktreeRemove = [
    ...(merged.WorktreeRemove ?? []),
    { hooks: [async input => claudeWorktreeRemoveResult(input, port, context)] },
  ];

  return merged;
}

async function claudeWorktreeCreateResult(
  input: SdkAutomationInput,
  port: ClaudeWorktreePort,
  context: ClaudeWorktreeHookContext,
): Promise<SdkAutomationCallbackResult> {
  const debug = context.debug;
  const payload = input as ClaudeWorktreeHookInput;
  const name = readString(payload.name);
  if (!name) {
    // No slug means the host cannot name a lease, and a lease named after
    // nothing is the record that makes a sweep unable to act. Refuse loudly:
    // creation aborts, which is the outcome that leaves nothing on disk.
    debug?.('[ClaudeWorktree] WorktreeCreate arrived with no `name`; refusing rather than leasing an unnamed worktree');
    context.notice?.(
      'An isolated working copy was requested without a name, so this app could not record it and refused to create it.'
      + CLAUDE_WORKTREE_REFUSAL_TAIL,
    );
    return { decision: 'block', reason: 'WorktreeCreate hook input carried no worktree name' };
  }

  let outcome: Awaited<ReturnType<ClaudeWorktreePort['create']>>;
  try {
    outcome = await port.create({
      name,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(readString(payload.cwd) ? { cwd: readString(payload.cwd) as string } : {}),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    debug?.(`[ClaudeWorktree] WorktreeCreate port threw for ${name}: ${reason}`);
    // The port's own arm ALSO speaks here on the host side
    // (`SessionManager.createClaudeWorktreePort`'s catch, P6.127), so this one
    // is deliberately short: it exists so the two messages a user sees are
    // connected, not to repeat the detail the port already gave.
    context.notice?.(
      `This app could not set up an isolated working copy for \`${name}\`: ${reason}.`
      + CLAUDE_WORKTREE_REFUSAL_TAIL,
    );
    return { decision: 'block', reason: `worktree lease failed: ${reason}` };
  }

  if ('refusedReason' in outcome) {
    debug?.(`[ClaudeWorktree] WorktreeCreate refused for ${name}: ${outcome.refusedReason}`);
    context.notice?.(
      `This app declined to set up an isolated working copy for \`${name}\`: ${outcome.refusedReason}.`
      + CLAUDE_WORKTREE_REFUSAL_TAIL,
    );
    return { decision: 'block', reason: outcome.refusedReason };
  }

  const screened = screenClaudeWorktreePath(outcome.worktreePath);
  if ('refusedReason' in screened) {
    debug?.(`[ClaudeWorktree] WorktreeCreate port returned an unusable path for ${name}: ${screened.refusedReason}`);
    context.notice?.(
      `This app set up an isolated working copy for \`${name}\` at a location it cannot use — ${screened.refusedReason}.`
      + CLAUDE_WORKTREE_REFUSAL_TAIL,
    );
    return { decision: 'block', reason: `worktree lease returned an unusable path — ${screened.refusedReason}` };
  }

  debug?.(`[ClaudeWorktree] WorktreeCreate leased ${name} at ${screened.path}`);
  // The one shape the binary reads back on the callback route. `hookEventName`
  // is not decoration: the measured branch is gated on it
  // (`L.hookSpecificOutput?.hookEventName==="WorktreeCreate"`), and without it
  // the output falls through to `systemMessage||""`, which reads as "returned
  // no worktree path" and fails creation.
  return {
    continue: true,
    hookSpecificOutput: { hookEventName: 'WorktreeCreate', worktreePath: screened.path },
  };
}

async function claudeWorktreeRemoveResult(
  input: SdkAutomationInput,
  port: ClaudeWorktreePort,
  context: ClaudeWorktreeHookContext,
): Promise<SdkAutomationCallbackResult> {
  const debug = context.debug;
  const payload = input as ClaudeWorktreeHookInput;
  const raw = readString(payload.worktree_path);
  if (!raw) {
    debug?.('[ClaudeWorktree] WorktreeRemove arrived with no `worktree_path`; nothing to release');
    return { continue: true };
  }
  const screened = screenClaudeWorktreePath(raw);
  if ('refusedReason' in screened) {
    // NEVER handed on. Whatever the port does with a path, it does it to a
    // directory — so a payload this side cannot vouch for stops here.
    debug?.(`[ClaudeWorktree] WorktreeRemove path refused: ${screened.refusedReason}`);
    return { continue: true };
  }
  try {
    await port.remove({
      worktreePath: screened.path,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    });
    debug?.(`[ClaudeWorktree] WorktreeRemove released ${screened.path}`);
  } catch (error) {
    // `hooks.md#worktreeremove`: *"Hook failures are logged in debug mode
    // only."* Matching that is the point — a failed release must not take the
    // session down, and there is no decision field here that could.
    debug?.(`[ClaudeWorktree] WorktreeRemove port threw for ${screened.path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { continue: true };
}
