/**
 * Provider-scoped runtime conversation anchors.
 */

import type { AgentProvider } from '../agent/backend/types.ts';

/**
 * A session's runtime-side conversation anchors, one per backend.
 *
 * This replaces the single `sdkSessionId`, which held a PI session id for a Pi
 * session and a CLAUDE SDK session id for a Claude session — one slot, two
 * namespaces. That was safe only while a session's provider could not change;
 * once it can, handing Claude a Pi id resumes nothing and reads to the user as
 * "resume is broken".
 *
 * Keyed by provider rather than merely cleared on switch, so returning to a
 * runtime returns to its conversation. `nestor-cloud-agent` is never recorded:
 * it keeps no local anchor and is out of scope for switching.
 */
export type RuntimeAnchorMap = Partial<Record<AgentProvider, string>>;

/**
 * P2.283 · which runtimes keep a durable anchor — one arm per runtime, TOTAL
 * over the vocabulary.
 *
 * This was `['pi', 'anthropic']`, a hand-maintained array, and P2.124 closed
 * claiming its property — *a per-runtime capability site must be total over the
 * vocabulary, so adding a runtime BREAKS THE BUILD* — held everywhere. It did
 * not hold here. Measured on an isolated clone at `f58f66a36`: adding a fifth
 * member to `ModelProvider` broke six other sites and left this file compiling
 * clean, because `readonly AgentProvider[]` accepts any subset. A new runtime
 * was silently NOT anchored, which is the quiet half of the bug this module was
 * written to fix — the loud half was handing Claude a Pi id, and "resume finds
 * nothing, forever, with no error" reads the same way to a user.
 *
 * `Record<AgentProvider, boolean>` is the whole change: a missing arm is a type
 * error and an invented one is an excess-property error, while `isAnchored`
 * still answers `false` for any string outside the union, so nothing a caller
 * observes has moved.
 *
 * `codex-runtime: false` is DELIBERATE and must stay false — for the MAP, which
 * is what runtime-switch planning reads. F1.1235: since P6.102 codex publishes
 * its own thread id and since F1.1074 its rollouts outlive a runtime build, so
 * a rebuild of the SAME codex leg resumes through
 * {@link readAgentResumeAnchor}, not through this record. The history below
 * explains the map's arm; its claims that the thread id is never persisted and
 * the home is all there is are no longer true.
 *
 * Codex keeps no durable conversation store: its thread lives in a
 * `mkdtempSync` CODEX_HOME that `teardownRuntime` deletes, and its `threadId` is
 * never persisted — `/usr/bin/grep -ac sdkSessionId codex-agent.ts` is 0
 * (re-measured 2026-08-28; `-a` because a `rg` absence claim over a NUL-carrying
 * file is silently empty, and the file coordinates this docblock used to cite —
 * `:292`, `:1066` — had drifted to `:1204` and `:3733` while the mechanism
 * stayed exactly as described). Worse, `BaseAgent.getSessionId()` returns the
 * NESSY session id and `CodexAgent` does not override it, so `SessionManager`'s
 * fallback capture writes that id into `sdkSessionId` after the first Codex
 * turn. Anchoring Codex would migrate that garbage into the map and make a
 * Codex→Codex change report "history preserved" while the runtime starts empty
 * — a lie with a UI string behind it.
 *
 * Codex is a context-handoff case, not an anchored one; `nestor-cloud-agent`
 * keeps no local anchor at all and is out of scope for switching.
 */
export const RUNTIME_ANCHOR_SUPPORT: Record<AgentProvider, boolean> = {
  // Resumes its own `.pi-sessions` sidecar from the recorded id.
  pi: true,
  // Resumes through the Claude Agent SDK's own session id.
  anthropic: true,
  // See above — anchoring it would record the Nessy session id as if it were a
  // Codex thread id.
  'codex-runtime': false,
  // Remote; keeps no local anchor and is not a switch endpoint.
  'nestor-cloud-agent': false,
};

/**
 * The anchored runtimes, DERIVED from {@link RUNTIME_ANCHOR_SUPPORT}.
 *
 * Exported because eight docblocks and live-test cases across `server-core`,
 * `pi-agent-server` and `scripts/cdp` cite `ANCHORED_PROVIDERS` by name and
 * restate its contents in prose; a value they can be checked against is worth
 * more than a private constant they can only be checked against by eye.
 */
export const ANCHORED_PROVIDERS: readonly AgentProvider[] =
  (Object.keys(RUNTIME_ANCHOR_SUPPORT) as AgentProvider[])
    .filter(provider => RUNTIME_ANCHOR_SUPPORT[provider]);

function isAnchored(provider: AgentProvider): boolean {
  return RUNTIME_ANCHOR_SUPPORT[provider] === true;
}

export function readRuntimeAnchor(
  anchors: RuntimeAnchorMap | undefined,
  provider: AgentProvider,
): string | undefined {
  if (!anchors || !isAnchored(provider)) return undefined;
  return anchors[provider];
}

/**
 * F1.1235 · the id a NEW agent of `provider` resumes from, read where the agent
 * is built (`SessionManager`'s session config) — after an app restart, an
 * idle-agent release or an eviction alike, since all of them rebuild there.
 *
 * An anchored runtime answers its map entry ({@link readRuntimeAnchor}). Codex
 * answers the legacy `sdkSessionId` slot, the one place its thread id lives:
 * `CodexAgent` publishes the id at every thread open (`onSdkSessionIdUpdate`,
 * P6.102), `writeRuntimeAnchor` drops it from the map (codex is not anchored),
 * and the slot keeps it. Without this read the id never reached the agent and
 * a relaunched codex chat opened a fresh thread with no notice (SIT2-d).
 *
 * The slot cannot hold another runtime's id while codex is the provider:
 * `clearRuntimeScopedSessionState` clears it at every runtime switch, so a switch
 * INTO codex still starts a thread and carries the history (codex stays out of
 * `ANCHORED_PROVIDERS`). A host session id is not a codex thread: sessions from before P6.102 hold one, and so does
 * a chat whose runtime never opened a thread (SessionManager's stream fallback stores `getSessionId()`). Codex refuses
 * it and the agent says so (`chat.codexNotice.threadResumeFailed`), even where there was no thread to resume.
 */
export function readAgentResumeAnchor(
  anchors: RuntimeAnchorMap | undefined,
  legacySdkSessionId: string | undefined,
  provider: AgentProvider,
): string | undefined {
  return readRuntimeAnchor(anchors, provider)
    ?? (provider === 'codex-runtime' ? legacySdkSessionId || undefined : undefined);
}

export function writeRuntimeAnchor(
  anchors: RuntimeAnchorMap | undefined,
  provider: AgentProvider,
  anchor: string | undefined,
): RuntimeAnchorMap {
  const next: RuntimeAnchorMap = { ...(anchors ?? {}) };
  if (!isAnchored(provider)) return next;
  if (anchor) next[provider] = anchor;
  else delete next[provider];
  return next;
}

/**
 * One-way adoption of a pre-map `sdkSessionId`.
 *
 * A session written before this field existed carries its anchor in the legacy
 * slot and nothing else, so the only provider it can belong to is the one the
 * session was running. Never overwrites an anchor already recorded — on a
 * session that has both, the map is the newer truth.
 */
export function migrateLegacyAnchor(
  anchors: RuntimeAnchorMap | undefined,
  legacy: string | undefined,
  provider: AgentProvider,
): RuntimeAnchorMap {
  const next: RuntimeAnchorMap = { ...(anchors ?? {}) };
  if (!legacy || !isAnchored(provider) || next[provider]) return next;
  next[provider] = legacy;
  return next;
}
