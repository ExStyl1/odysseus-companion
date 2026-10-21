import { totalmem } from 'node:os'
import {
  hostLiveAgentCeiling,
  resolveLiveAgentCeilingFor,
  type SubagentLimitsEnvRecord,
} from '@nessy-agent/shared/config/subagent-limits'

/** One session that currently holds a live agent runtime. */
export interface LiveAgentCandidate {
  /** Encoded session key; opaque to this module. */
  key: string
  /** When the session last did anything; the LRU ordering. */
  lastUsedAt: number
  /** Work is in flight. Never evictable — see {@link liveAgentBusyDomains}. */
  busy: boolean
}

/**
 * A kind of work a session can be holding that a runtime dispose would destroy.
 *
 * L3 — THE EVICTION DEFECT. This list used to be one boolean,
 * `ManagedSession.isProcessing`, and that was safe only while "not mid-turn"
 * and "holding nothing" were the same statement. They are not:
 *
 * - `startPiChildRuntime` DETACHES a background child's run and returns
 *   `running`, so the parent sits at `isProcessing === false` while its child
 *   works. `SessionManager` already knows what that combination means — the
 *   agent-view residency computes `runtime_owner_lost` from exactly
 *   `!managed.agent && (activeChildren > 0 || activeProcesses > 0 || activeWorkflows > 0)` —
 *   and evicting the parent is how you MANUFACTURE it.
 * - `disposeManagedAgentRuntime` calls `piProcessSupervisor.drainSession`, which
 *   STOPS every running background process this session owns, and clears
 *   `piBackgroundTaskKinds`. A background process is work the model started and
 *   will later read; killing it destroys the work and the reason for it. That
 *   call read `for a Pi session` until P2.23: the drain and the `process` domain
 *   were both provider-gated, so a claude or codex session holding a running
 *   supervised process (a `Monitor` command watch is one) measured idle, was
 *   evicted, and had its records left latched `running`. Both gates are gone;
 *   this bullet is now true of every runtime.
 * - A pending permission card or model question is a promise the renderer is
 *   holding. `ClaudeAgent.destroy()` cancels both, so the card resolves as
 *   cancelled and the user's answer is thrown away.
 *
 * The domain vocabulary deliberately mirrors `session-settlement.ts` — that
 * module is already "the single server-owned answer to 'may settled-session work
 * run now?'" and two different answers to "is this session holding anything"
 * would be the defect, not the safeguard. It is not reused directly because this
 * question has two inputs settlement does not: the BACKEND turn (post-L2,
 * `agent.isProcessing()` is the Claude slot and can disagree with the host flag
 * at either edge of a turn) and background shells.
 */
export type LiveAgentBusyDomain =
  | 'foreground_turn'
  | 'backend_turn'
  | 'child'
  | 'process'
  | 'workflow_evaluator'
  | 'background_shell'
  | 'background_task'
  | 'permission'
  | 'ask_user'

export interface LiveAgentBusyInputsV1 {
  /** `ManagedSession.isProcessing` — the host's foreground turn flag. */
  foregroundTurn: boolean
  /** `AgentInstance.isProcessing()` — post-L2 this is Claude's open turn slot. */
  backendTurn: boolean
  activeChildren: number
  activeProcesses: number
  activeWorkflowEvaluators: number
  backgroundShells: number
  /**
   * `AgentInstance.backgroundWorkCount()` — background work the BACKEND is
   * holding and that no host-side map records.
   *
   * L5. `activeWorkflowEvaluators` reads `piBackgroundTaskKinds`, whose only
   * writer is the `task_backgrounded` event, and Claude's adapter deliberately
   * never emits it — so before this input a Claude session running a background
   * subagent (the SDK's Agent tool backgrounds by default) reported every domain
   * at zero and was both reapable and evictable.
   */
  backendBackgroundTasks: number
  pendingPermissions: number
  pendingAskUser: number
}

const BUSY_COUNTS: readonly [keyof LiveAgentBusyInputsV1, LiveAgentBusyDomain][] = Object.freeze([
  ['activeChildren', 'child'],
  ['activeProcesses', 'process'],
  ['activeWorkflowEvaluators', 'workflow_evaluator'],
  ['backgroundShells', 'background_shell'],
  ['backendBackgroundTasks', 'background_task'],
  ['pendingPermissions', 'permission'],
  ['pendingAskUser', 'ask_user'],
])

/**
 * Everything this session is holding that a dispose would destroy. Empty means
 * evictable.
 *
 * Counts rather than booleans, for `session-settlement.ts`'s reason: a producer
 * cannot accidentally report idle while parallel work remains. A negative or
 * non-integer count is a programming error and throws rather than rounding down
 * to "idle" — the failure direction that kills work.
 */
export function liveAgentBusyDomains(inputs: LiveAgentBusyInputsV1): readonly LiveAgentBusyDomain[] {
  const domains: LiveAgentBusyDomain[] = []
  if (inputs.foregroundTurn) domains.push('foreground_turn')
  if (inputs.backendTurn) domains.push('backend_turn')
  for (const [field, domain] of BUSY_COUNTS) {
    const count = inputs[field] as number
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`live-agent-busy-invalid-count:${field}`)
    }
    if (count > 0) domains.push(domain)
  }
  return Object.freeze(domains)
}

export type LiveAgentAdmission =
  | { decision: 'admit' }
  | { decision: 'admit-after-eviction'; evict: readonly string[] }
  | { decision: 'refuse'; live: number; busy: number }

/**
 * How many agent runtimes this host may hold at once.
 *
 * Derived from installed memory rather than picked: the audit's finding is that
 * "nothing currently bounds N subprocesses x ~1 GiB", so the bound belongs to the
 * machine and a hardcoded number would be wrong on both a 8 GiB laptop and a
 * 128 GiB workstation. One agent per 2 GiB leaves the other half of RAM to the
 * app, the renderer and everything else the user is running.
 *
 * The floor of 2 is not cosmetic: a Pi session that spawns a child session needs
 * two live agents at once, so a ceiling of 1 would refuse the child and make
 * subagents impossible on a small host.
 *
 * The formula itself now lives in `@nessy-agent/shared/config/subagent-limits`
 * (`hostLiveAgentCeiling`) because the Pi SUBPROCESS has to compute the same
 * number: the concurrent-subagent ceiling is narrowed against it so this gate can
 * never be the first one an Agent-tool spawn hits. Two copies of the formula
 * would be two answers to that question.
 */
export function defaultLiveAgentCeiling(totalMemoryBytes = totalmem()): number {
  return hostLiveAgentCeiling(totalMemoryBytes)
}

/**
 * The ceiling a host actually runs with: the memory bound, or one more than the
 * concurrent-subagent ceiling when an operator raised that above it with
 * `NESSY_MAX_CONCURRENT_SUBAGENTS`.
 *
 * WHICH GATE SPEAKS FIRST, stated once. Three gates sit on one Agent-tool spawn:
 * the spawner's subagent counter (`maxConcurrentSubagents`, the documented
 * `Concurrent subagent limit reached`), the durable per-parent backstop in
 * `child-session-service.ts`, and this one. Only the first may ever speak for a
 * subagent, because its refusal is the documented one and the other two are
 * host-internal strings that reach the model as a FAILED child rather than as a
 * refused spawn — a background child's ceiling error surfaces asynchronously,
 * long after the tool call returned. `resolveLiveAgentCeilingFor` keeps the
 * invariant `subagent ceiling < live-agent ceiling` true in both directions, so
 * this gate is structurally unreachable for a subagent child.
 *
 * Two residues, deliberately left: a session running under ultracode is exempt
 * from the subagent ceiling (`sub-agents.md:898`), so a max-effort fan-out can
 * reach this gate; and another session of the user's that is mid-turn is a busy
 * occupant this module will refuse for rather than evict.
 */
export function resolveLiveAgentCeiling(
  env?: SubagentLimitsEnvRecord,
  totalMemoryBytes: number = totalmem(),
): number {
  return resolveLiveAgentCeilingFor(env ?? process.env, totalMemoryBytes)
}

/**
 * Whether one more agent runtime may be created, and what to shut down first.
 *
 * EVICTING A SESSION THAT HOLDS WORK IS REFUSED, NOT PERFORMED. An evicted agent
 * is disposed and lazily rebuilt on the next send, which is harmless for an idle
 * session and destructive for one holding anything:
 * `disposeManagedAgentRuntime` drains the automation events, captures the
 * lifecycle state, stops the session's background processes (P2.23 — on every
 * runtime, not only Pi) and tears the subprocess down, so a turn in flight would
 * end mid-stream with no result and no error the
 * user asked for — and a background task would simply stop existing. A refusal,
 * by contrast, surfaces at the exact moment the user tried to start something and
 * names why. So a busy session is never a candidate, and when every live agent is
 * busy the answer is `refuse` rather than a smaller set of victims.
 *
 * `busy` is {@link liveAgentBusyDomains}, not "a turn is in flight" — see that
 * function for the three shapes the narrower reading killed.
 *
 * Pure and total: it reads no clock, allocates no process and never throws, so the
 * decision is assertable without a session store, a supervisor or a subprocess.
 */
export function resolveLiveAgentAdmission(input: {
  candidates: readonly LiveAgentCandidate[]
  /**
   * The session about to receive an agent. Excluded from the count — a session
   * refreshing its own runtime is not a new occupant, and counting it would
   * refuse every send once the ceiling was exactly reached.
   */
  admitting: string
  ceiling: number
}): LiveAgentAdmission {
  const occupants = input.candidates.filter(candidate => candidate.key !== input.admitting)
  const overBy = occupants.length - input.ceiling + 1
  if (overBy <= 0) return { decision: 'admit' }

  const evictable = occupants
    .filter(candidate => !candidate.busy)
    // Ties broken by key so the decision is deterministic; two sessions can share
    // a millisecond, and a nondeterministic victim is an unreproducible bug report.
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt || left.key.localeCompare(right.key))
  if (evictable.length < overBy) {
    return {
      decision: 'refuse',
      live: occupants.length,
      busy: occupants.length - evictable.length,
    }
  }
  return {
    decision: 'admit-after-eviction',
    evict: evictable.slice(0, overBy).map(candidate => candidate.key),
  }
}

/** The refusal a caller turns into an error, so the wording lives with the rule. */
export function liveAgentCeilingRefusal(refusal: {
  live: number
  busy: number
  ceiling: number
}): string {
  return `live-agent-ceiling-reached: ${refusal.live} of ${refusal.ceiling} agent runtimes are live and `
    + `${refusal.busy} of them are still holding work, so none can be shut down without dropping it. `
    + 'Wait for a running turn or background task to finish, or stop one, and send again.'
}

// ---------------------------------------------------------------------------
// The idle reaper.
// ---------------------------------------------------------------------------

/** Default idle window before a live agent runtime is reaped. */
export const DEFAULT_IDLE_AGENT_TTL_MS = 30 * 60_000
/** Default gap between reaper sweeps. */
export const DEFAULT_IDLE_AGENT_SWEEP_MS = 60_000

/** One session whose live agent the reaper may take. */
export interface IdleAgentCandidate {
  /** Encoded session key; opaque to this module. */
  key: string
  /**
   * When this session last STARTED or FINISHED a turn.
   *
   * Deliberately not `lastMessageAt`: `rewindToMessage` assigns that field the
   * timestamp of a HISTORICAL message, so a user rewinding to yesterday's turn
   * in a session they are actively working in would hand this policy an
   * hours-old clock and have their agent reaped out from under them. And
   * deliberately not anything derived from the SDK stream — L0 measured
   * `system/init` arriving once per TURN, which makes it a turn marker wearing a
   * session-start name.
   */
  lastActiveAt: number
  /** {@link liveAgentBusyDomains} found something. */
  busy: boolean
  /**
   * This session holds a peripheral whose whole purpose is to WAKE it, and a
   * dispose would take it: since F1.1282 an MCP channel subscription backed
   * by an ARMED connection (`hasArmedChannelConnection`) and running plugin
   * command monitors, both re-armed only at agent construction — the user's
   * next send. Reaping such a session does not hibernate it, it makes it DEAF,
   * and the loss is silent and recoverable only by the user typing something.
   *
   * The ceiling's eviction still takes these: it acts under real memory
   * pressure, it is the alternative to refusing the user's send outright, and it
   * tells the evicted session why. The reaper acts under no pressure at all, so
   * it gets the strictly loss-free rule.
   */
  holdsWakePath: boolean
}

/**
 * Which idle agent runtimes to shut down now.
 *
 * Pure and total, like {@link resolveLiveAgentAdmission}: no clock is read (the
 * caller passes `now`), nothing is allocated and it never throws, so the policy
 * is assertable without a timer, a session store or a subprocess.
 *
 * `idleAfterMs <= 0`, or a non-finite one, DISABLES the reaper — that is the
 * operator's off switch and it must not be spelled as "reap everything".
 * A `lastActiveAt` in the future (clock step, a restored header) reads as
 * not-idle for the same fail-safe reason.
 */
export function resolveIdleAgentReaping(input: {
  candidates: readonly IdleAgentCandidate[]
  now: number
  idleAfterMs: number
}): { reap: readonly string[] } {
  if (!Number.isFinite(input.idleAfterMs) || input.idleAfterMs <= 0) return { reap: Object.freeze([]) }
  const reap = input.candidates
    .filter(candidate =>
      !candidate.busy
      && !candidate.holdsWakePath
      && Number.isFinite(candidate.lastActiveAt)
      && input.now - candidate.lastActiveAt >= input.idleAfterMs)
    .map(candidate => candidate.key)
    .sort()
  return { reap: Object.freeze(reap) }
}

function positiveMsFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return parsed
}

/** Idle window before an agent runtime is reaped. `0` disables the reaper. */
export function resolveIdleAgentTtlMs(env: Record<string, string | undefined> = process.env): number {
  return positiveMsFromEnv(env.NESSY_IDLE_AGENT_TTL_MS, DEFAULT_IDLE_AGENT_TTL_MS)
}

/** Gap between reaper sweeps. Never zero — a zero here would be a busy loop. */
export function resolveIdleAgentSweepMs(env: Record<string, string | undefined> = process.env): number {
  const resolved = positiveMsFromEnv(env.NESSY_IDLE_AGENT_SWEEP_MS, DEFAULT_IDLE_AGENT_SWEEP_MS)
  return resolved > 0 ? resolved : DEFAULT_IDLE_AGENT_SWEEP_MS
}
