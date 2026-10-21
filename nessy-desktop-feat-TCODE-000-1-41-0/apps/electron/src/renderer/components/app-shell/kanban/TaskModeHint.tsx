/**
 * UA4.2 (Nessy-only; spec §11 "Conductor", item 2 "Posture", OQ-7) — the line under the Task editor's permission
 * mode that says what the mode means for the task's subtasks:
 *
 * - **The ceiling** (always): every subtask runs in this mode or a narrower one. The host holds it twice — the
 *   Conductor clamps each node's mode to the orchestrator's at dispatch (`TaskRunner.dispatch`), and a node's later
 *   mode changes are clamped to the orchestrator's CURRENT mode (`SessionManager.clampChildPermissionModeToParent`,
 *   whose ceiling keys are `piParentSessionKey` and a Conductor child's `parentSessionId`).
 * - **The block hint** (`plan`, `default`, `acceptEdits`): a subtask stops at each action that needs approval and
 *   waits for the person in its own session — upstream started every task in `allow-all`, where nothing stopped.
 *   `dontAsk` never stops (it refuses instead); `bypassPermissions` adds nothing.
 * - **The judge, named per runtime** (`auto`): who decides an approval differs by runtime, and the line names only
 *   the runtimes this task's sessions run on (the orchestrator's connection and each subtask's). Pi: our Guardian
 *   judge (`guardianEnabled`, default on; uncertain verdicts fall back to the person); Claude Code: its own
 *   auto-mode judge; Codex: Codex's auto-review guardian when it is switched on (off by default), else the person.
 *   The wording follows the Settings pages' own scope notes (`settings.ai.guardian.scopeNote`,
 *   `settings.ai.codexAutoReview.scopeNote`, `settings.permissions.judgeRules.description`).
 */
import { useTranslation } from 'react-i18next'
import type { ModelProvider } from '@config/models'
import type { PermissionMode } from '@nessy-agent/shared/agent/modes'

/** What the mode adds under the ceiling line. */
export type TaskModeHintKind = 'blocks' | 'noPrompts' | 'auto' | 'none'

export function taskModeHintKind(mode: PermissionMode): TaskModeHintKind {
  switch (mode) {
    case 'plan':
    case 'default':
    case 'acceptEdits':
      return 'blocks'
    case 'dontAsk':
      return 'noPrompts'
    case 'auto':
      return 'auto'
    default:
      return 'none'
  }
}

/** The runtimes a node can run on, in the order the judge lines are shown. */
const JUDGE_RUNTIMES = ['pi', 'anthropic', 'codex-runtime'] as const
export type JudgeRuntime = (typeof JUDGE_RUNTIMES)[number]

const JUDGE_KEY: Record<JudgeRuntime, string> = {
  pi: 'tasks.modeHint.judgePi',
  anthropic: 'tasks.modeHint.judgeClaude',
  'codex-runtime': 'tasks.modeHint.judgeCodex',
}

/** One session of the task (the orchestrator or a subtask): its explicit model and connection, either may be unset. */
export interface TaskSessionRoute {
  model?: string
  llmConnection?: string
}

/**
 * The runtimes the task's sessions run on: each route's connection (its own, else the one serving its model,
 * else the orchestrator's), looked up in the catalogue's groups. A runtime no node can run on
 * (`nestor-cloud-agent`) is left out. When nothing resolves, all three are returned — the line then names every
 * judge rather than none.
 */
export function taskJudgeRuntimes(
  groups: readonly { connectionSlug: string; runtime: ModelProvider }[],
  modelToConnection: ReadonlyMap<string, string>,
  orchestrator: TaskSessionRoute,
  subtasks: readonly TaskSessionRoute[],
): JudgeRuntime[] {
  const connectionOf = (route: TaskSessionRoute): string | undefined =>
    route.llmConnection ?? (route.model ? modelToConnection.get(route.model) : undefined)
  const orchestratorConnection = connectionOf(orchestrator)
  const found = new Set<ModelProvider>()
  for (const route of [orchestrator, ...subtasks]) {
    const slug = connectionOf(route) ?? orchestratorConnection
    const runtime = slug ? groups.find(g => g.connectionSlug === slug)?.runtime : undefined
    if (runtime) found.add(runtime)
  }
  const named = JUDGE_RUNTIMES.filter(r => found.has(r))
  return named.length > 0 ? named : [...JUDGE_RUNTIMES]
}

export function TaskModeHint({ mode, runtimes }: { mode: PermissionMode; runtimes: readonly JudgeRuntime[] }) {
  const { t } = useTranslation()
  const kind = taskModeHintKind(mode)
  return (
    <div data-task-mode-hint={kind} className="-mt-1 flex flex-col gap-1 text-[11px] leading-relaxed text-foreground/45">
      <p>{t('tasks.modeHint.ceiling')}</p>
      {kind === 'blocks' && <p>{t('tasks.modeHint.blocks')}</p>}
      {kind === 'noPrompts' && <p>{t('tasks.modeHint.noPrompts')}</p>}
      {kind === 'auto' && (
        <div>
          <p>{t('tasks.modeHint.autoJudge')}</p>
          <ul className="ml-3 list-disc">
            {runtimes.map(r => (
              <li key={r} data-task-mode-judge={r}>
                {t(JUDGE_KEY[r])}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
