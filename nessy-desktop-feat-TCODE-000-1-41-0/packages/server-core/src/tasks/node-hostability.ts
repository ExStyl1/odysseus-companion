/**
 * UA1.7 — Conductor node hostability: the preflight `tasks:validate` and `tasks:run` call before the FIRST
 * dispatch, so a task never starts a node its connection cannot host (spec §11 "Conductor", item 3).
 *
 * Nessy-only: upstream v0.13.4 has no such check (its `TaskRunner` hands `node.llmConnection ??
 * spec.defaults?.llmConnection` to `createSession` and learns at the first turn). It is the Conductor's twin of
 * the runtime-switch precondition `SessionManager.assertSwitchTargetHostable`, built from the same two parts:
 *
 * 1. **The node predicate IS {@link SCHEDULED_DELIVERY_RUNTIMES}** (pi, anthropic, codex-runtime) — the set of
 *    runtimes with a host-side tool loop, which is what a node needs to be driven and completed. No second record:
 *    `nestor-cloud-agent` is refused here for the reason it is absent there (it runs no host-side loop), even though
 *    {@link canHostSession} answers `ok` for it (a remote session is hosted remotely).
 * 2. **{@link canHostSession}** — deterministic and local (flag, binary on disk, credential record), called ONCE per
 *    DISTINCT connection however many nodes share it.
 *
 * **An unresolvable connection refuses; it never falls back.** A node that NAMES a connection gets exactly that
 * record ({@link NodeHostabilityDeps.resolveConnection}), never `resolveSessionConnection`'s silent fallback to the
 * workspace or global default — a typo must not run the node on another runtime. A node that names none (and whose
 * spec `defaults.llmConnection` names none either) runs where `createSession` would put it, the default connection
 * ({@link NodeHostabilityDeps.resolveDefaultConnection}); when there is no default either, that refuses too.
 *
 * **Input is structural** (`{ nodes, defaults? }`): the task spec type arrives with UA3.2, and UA3.4 passes its spec
 * here without a reshape.
 *
 * **Module-graph cost (waves O20, decided 2026-10-02).** Importing {@link SCHEDULED_DELIVERY_RUNTIMES} from
 * `SessionManager.ts` pulls that whole graph into this small module — the plan forbids a duplicate record, and moving
 * the constant to a leaf would touch a docs-cited region of the hot file, so it is imported as-is. The cost is paid
 * once at module load, which no test timer covers; see the test file's header for the measured readings.
 *
 * A refusal throws `CodedError('RUNTIME_UNHOSTABLE', …)` — the wire code the runtime switch already uses for the same
 * question — whose message names the node, the connection and the reason, with the same three in `data`.
 */
import type { BackendHostRuntimeContext } from '@nessy-agent/shared/agent/backend'
import { resolveSessionConnection } from '@nessy-agent/shared/agent/backend'
import { tryProviderTypeToAgentProvider } from '@nessy-agent/shared/agent/backend/factory'
import { getLlmConnection, type LlmConnection } from '@nessy-agent/shared/config'
import { CodedError } from '@nessy-agent/shared/protocol'
import { SCHEDULED_DELIVERY_RUNTIMES } from '../sessions/SessionManager'
import { canHostSession, type CanHostSessionVerdict, type RuntimeUnhostableReason } from '../sessions/runtime-switch'

/** The structural slice of a task spec this check reads (UA3.2's `TaskSpec` satisfies it). */
export interface HostabilitySpec {
  nodes: ReadonlyArray<{ id: string; llmConnection?: string }>
  defaults?: { llmConnection?: string }
}

/** Why a node cannot be hosted: {@link canHostSession}'s three, plus the Conductor's own. */
export type NodeUnhostableReason =
  | RuntimeUnhostableReason
  /** The connection resolves, but its runtime is not in {@link SCHEDULED_DELIVERY_RUNTIMES} (nestor-cloud). */
  | 'runtime-not-node-capable'
  /** The connection record carries a providerType this build does not know. */
  | 'runtime-unknown'
  /** The named connection does not exist (or, when none is named, there is no default connection). */
  | 'connection-unresolved'

/** `CodedError.data` of a refusal. */
export interface NodeUnhostableDetail {
  nodeId: string
  /** The connection slug the node resolves to; `undefined` when it names none and there is no default. */
  connection: string | undefined
  reason: NodeUnhostableReason
}

export interface NodeHostabilityDeps {
  /** The host context {@link canHostSession} resolves binaries against (`buildBackendHostRuntimeContext`). */
  hostRuntime: BackendHostRuntimeContext
  /** The workspace default connection slug, as `createSession` would read it (`defaults.defaultLlmConnection`). */
  workspaceDefaultConnection?: string
  /** Exactly the named record, or null. Default: `getLlmConnection` — no fallback. */
  resolveConnection?: (slug: string) => LlmConnection | null
  /** The connection a node naming none runs on. Default: `resolveSessionConnection(undefined, workspaceDefault)`. */
  resolveDefaultConnection?: (workspaceDefaultConnection: string | undefined) => LlmConnection | null
  /** Default: {@link canHostSession}. */
  canHost?: (target: LlmConnection, hostRuntime: BackendHostRuntimeContext) => Promise<CanHostSessionVerdict>
}

const REASON_TEXT: Record<NodeUnhostableReason, string> = {
  'runtime-disabled': 'its runtime is not included in this build',
  'runtime-binary-missing': "its runtime's binary is not present on this machine",
  'credentials-missing': 'the connection has no usable credentials',
  'runtime-not-node-capable': 'its runtime runs no host-side tool loop, so it cannot run a task node',
  'runtime-unknown': 'its provider type is not one this build knows',
  'connection-unresolved': 'the connection does not exist',
}

function refuse(detail: NodeUnhostableDetail): never {
  const connection = detail.connection === undefined ? 'the default connection' : `connection "${detail.connection}"`
  throw new CodedError(
    'RUNTIME_UNHOSTABLE',
    `Task node "${detail.nodeId}" cannot run on ${connection}: ${REASON_TEXT[detail.reason]}`,
    detail,
  )
}

/**
 * Refuse, before the first dispatch, any node whose connection cannot host it. Resolves when every node can run;
 * otherwise throws for the FIRST node (in spec order) whose connection fails, naming it. {@link canHostSession}
 * runs once per distinct resolved connection.
 */
export async function assertNodesHostable(spec: HostabilitySpec, deps: NodeHostabilityDeps): Promise<void> {
  const resolveNamed = deps.resolveConnection ?? getLlmConnection
  const resolveDefault = deps.resolveDefaultConnection ?? (workspaceDefault => resolveSessionConnection(undefined, workspaceDefault))
  const canHost = deps.canHost ?? canHostSession
  const verdicts = new Map<string, Promise<NodeUnhostableReason | undefined>>()

  for (const node of spec.nodes) {
    const named = node.llmConnection ?? spec.defaults?.llmConnection
    const connection = named === undefined ? resolveDefault(deps.workspaceDefaultConnection) : resolveNamed(named)
    if (!connection) refuse({ nodeId: node.id, connection: named, reason: 'connection-unresolved' })

    let verdict = verdicts.get(connection.slug)
    if (!verdict) {
      verdict = (async (): Promise<NodeUnhostableReason | undefined> => {
        const provider = tryProviderTypeToAgentProvider(connection.providerType)
        if (!provider) return 'runtime-unknown'
        if (!SCHEDULED_DELIVERY_RUNTIMES.includes(provider)) return 'runtime-not-node-capable'
        const hosted = await canHost(connection, deps.hostRuntime)
        return hosted.ok ? undefined : hosted.code
      })()
      verdicts.set(connection.slug, verdict)
    }
    const reason = await verdict
    if (reason) refuse({ nodeId: node.id, connection: connection.slug, reason })
  }
}
