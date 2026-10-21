/**
 * **D1.215 / D1.139 — the per-session runtime facts a PULL surface can carry.**
 *
 * ## The gap this closes
 *
 * Four claude postures were decided and written down this month, and every one
 * of them reaches a channel a user of the packaged app never opens:
 *
 *  - the auto-memory disposition (`resolveClaudeAutoMemoryDisposition`,
 *    C3.181/C3.349) had ONE consumer, a `debug(...)` in `ClaudeAgent.postInit`,
 *    and a packaged build logs nothing outside debug mode. That is D1.139's
 *    whole finding: the runtime keeps notes in a directory no host surface
 *    names.
 *  - the restricted-mode notice (`claudeRestrictedModeNotice`, D1.164) reaches
 *    the transcript banner, which is a PUSH channel and only at session start.
 *  - the search-result filter's KEEP (D1.163) and the worktree cwd divergence
 *    (D1.126) are recorded in their modules' docblocks and nowhere a user looks.
 *
 * ## Why one LIST and not four surfaces
 *
 * W19-e's PR-2, in D1.139's own note: *"the same surface should carry every
 * claude product posture, not only the auto-memory sentence — one info surface,
 * both rows"*. A list is what makes that possible without a new page per
 * posture, and it is what lets the renderer stay ignorant of which runtime is
 * answering: it maps an ID to a sentence in the user's language and renders
 * nothing for an empty list, which is every non-claude session today.
 *
 * ## Why the ID and not the sentence
 *
 * The modules above each write their sentence in English on purpose — the
 * restricted-mode one deliberately relays the runtime's own changelog wording,
 * because a paraphrase of a runtime message is a chance to be wrong about
 * someone else's behaviour. Those sentences are right for the transcript banner
 * and for the doctor, which are one English voice each. This surface is
 * localised, so the wire carries the DISPOSITION and the renderer carries the
 * words. The one value that cannot be localised — a filesystem path — rides
 * beside it in {@link SessionRuntimeNoticeV1.path}.
 *
 * ## Why this is not a second derivation
 *
 * The auto-memory arm calls {@link resolveClaudeAutoMemoryDisposition} on an env
 * assembled in `applyAutoMemoryOffSwitch`'s own order, from
 * `buildClaudeSessionMemoryEnv` — the exact function the child's env is built
 * with, on the exact scope this session resolved. Nothing here reimplements the
 * rule; a change to either function moves both the child and this notice. The
 * caller supplies `claudeConfigDir` for the same reason: `workspaceClaudeConfigDir`
 * is what the spawn uses, and deriving a second answer here would give a
 * per-workspace tree the wrong root — the failure WI-l refuted for the renderer.
 *
 * ## Deliberately NOT re-exported from `protocol/index.ts`
 *
 * Every other module in this directory is, and this one is reached by its own
 * subpath (`@nessy-agent/shared/protocol/session-runtime-notices`, covered by
 * the existing `"./protocol/*"` entry). The reason is the module graph: this
 * file imports `config/managed-env` and `agent/memory/claude-auto-memory`, and
 * putting it in the barrel would load both for every consumer of
 * `@nessy-agent/shared/protocol` — a cost paid by files that will never render a
 * notice, and the class `lint:module-graph-hooks` exists to price.
 */

import type { ModelProvider } from '../config/models'
import {
  buildClaudeSessionMemoryEnv,
  type SessionMemoryScope,
} from '../agent/memory/session-memory-scope'
import { resolveClaudeAutoMemoryDisposition } from '../agent/memory/claude-auto-memory'
import { claudeRestrictedModeNotice } from '../config/managed-env'

/**
 * One fact, named. The renderer maps each to a locale key through a switch it
 * cannot satisfy by omission, so an id added here without words is a build
 * failure on the surface rather than a sentence nobody sees.
 */
export type SessionRuntimeNoticeIdV1 =
  /** C3.181 — nothing is written, so the runtime's own default (on) stands. */
  | 'claude-auto-memory-runtime-default'
  /** This chat's memory is closed, so the host turns the runtime's store off too. */
  | 'claude-auto-memory-off-by-host'
  /** `=0` is present in the environment and this app never writes it. */
  | 'claude-auto-memory-forced-on'
  /** D1.164 — the child runs in restricted mode. */
  | 'claude-restricted-mode'
  /** D1.163 — denied paths are kept out of search RESULTS by this app, on every runtime. */
  | 'claude-search-results-filtered'
  /** D1.126 — the runtime can enter a worktree itself, and then this session is in it. */
  | 'claude-worktree-cwd-may-move'

export interface SessionRuntimeNoticeV1 {
  readonly id: SessionRuntimeNoticeIdV1
  /**
   * The one value a translation cannot carry: where the runtime's own files
   * land. Present only on the auto-memory notices, and it is the PARENT of the
   * per-project leaf — never the leaf, which is the runtime's to derive
   * (`claude-auto-memory.ts` says why at length).
   */
  readonly path?: string
}

export interface SessionRuntimeNoticeInputV1 {
  /** `getSessionProvider`'s answer; anything but `anthropic` yields an empty list today. */
  readonly provider: ModelProvider | undefined
  /** The EFFECTIVE scope this session resolved — the same value the verb returns. */
  readonly memoryScope: SessionMemoryScope
  /** `workspaceClaudeConfigDir(workspaceId)`; absent means the runtime's own default root. */
  readonly claudeConfigDir?: string | undefined
  /** The host environment the child inherits. Injected so a test needs no ambient state. */
  readonly env?: NodeJS.ProcessEnv
}

/**
 * The notices this session carries, in the order a reader should meet them:
 * what the runtime is doing with memory first (it is the one that writes files),
 * then the postures that narrow what the session can do.
 *
 * Returns an empty list for every runtime but claude, and that is a statement
 * rather than a stub: pi and codex have no auto-memory store of their own, no
 * restricted mode, and no worktree the runtime enters by itself. The search
 * filter is the one that is NOT claude-specific — the host performs it on all
 * three — and it is listed here anyway, because on claude alone the runtime has
 * performed it too since 2.1.251, so the user's `permissions.deny` has two
 * enforcers there and exactly one everywhere else. D1.163 is the decision to
 * keep both; this is where a user can find out that it was taken.
 */
export function resolveSessionRuntimeNotices(
  input: SessionRuntimeNoticeInputV1,
): readonly SessionRuntimeNoticeV1[] {
  if (input.provider !== 'anthropic') return []
  const env = input.env ?? process.env

  // `applyAutoMemoryOffSwitch`'s own order: the inherited environment, then the
  // per-workspace config dir, then the memory switch last. Reproducing the ORDER
  // matters as much as reproducing the values — the switch is what the child ends
  // up with, and it overwrites whatever the environment carried.
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    ...(input.claudeConfigDir ? { CLAUDE_CONFIG_DIR: input.claudeConfigDir } : {}),
    ...buildClaudeSessionMemoryEnv(input.memoryScope),
  }

  const disposition = resolveClaudeAutoMemoryDisposition(childEnv)
  const notices: SessionRuntimeNoticeV1[] = [{
    id: disposition.state === 'off-by-host'
      ? 'claude-auto-memory-off-by-host'
      : disposition.state === 'forced-on'
        ? 'claude-auto-memory-forced-on'
        : 'claude-auto-memory-runtime-default',
    path: disposition.projectsRoot,
  }]

  // Read from the same predicate the transcript banner uses, so the two cannot
  // disagree about whether this session is restricted.
  if (claudeRestrictedModeNotice(env) !== null) notices.push({ id: 'claude-restricted-mode' })

  notices.push({ id: 'claude-search-results-filtered' })
  notices.push({ id: 'claude-worktree-cwd-may-move' })
  return notices
}
