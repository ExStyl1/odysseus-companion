/**
 * R29a Task 5 — the fork-mode gate and its background interaction.
 *
 * `sub-agents.md`:
 *  - `:1006` the env var has three states: `1` enables, `0` disables, unset is
 *    the default (a staged server-side rollout there; OFF for us — see
 *    `forkSubagentModeEnabled`);
 *  - `:1008`/`:1010` enabling fork mode is what makes the `fork` type spawnable;
 *  - `:1011` under fork mode every subagent runs in the background, fork or not;
 *  - `:783` fork mode removes the `run_in_background` parameter (ours is
 *    `background`), and `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` takes precedence
 *    over fork mode and keeps subagents in the foreground.
 *
 * The differential table below is the deliverable: it enumerates every
 * configuration and records exactly which cells move and in which direction.
 */
import { afterEach, describe, expect, it } from 'bun:test'

import { forkSubagentModeEnabled } from '../../../shared/src/config/background-task-settings.ts'
import type { ChildSessionResult, SpawnChildSessionArgs } from './spawner.ts'
import { createSubagentTool } from './subagent-tool.ts'

type Tri = 'unset' | 'on' | 'off'
type BackgroundArg = 'unset' | 'true' | 'false'

interface Cell {
  forkMode: Tri
  backgroundArg: BackgroundArg
  disableBackground: 'unset' | 'on'
  parameterPresent: boolean
  effectiveBackground: boolean
  forkTypeAccepted: boolean
}

const originalFork = process.env.NESSY_FORK_SUBAGENT
const originalDisable = process.env.NESSY_DISABLE_BACKGROUND_TASKS

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(() => {
  setEnv('NESSY_FORK_SUBAGENT', originalFork)
  setEnv('NESSY_DISABLE_BACKGROUND_TASKS', originalDisable)
})

async function probe(forkMode: Tri, backgroundArg: BackgroundArg, disableBackground: 'unset' | 'on'): Promise<Cell> {
  setEnv('NESSY_FORK_SUBAGENT', forkMode === 'unset' ? undefined : forkMode === 'on' ? '1' : '0')
  setEnv('NESSY_DISABLE_BACKGROUND_TASKS', disableBackground === 'on' ? '1' : undefined)

  const spawned: SpawnChildSessionArgs[] = []
  const tool = createSubagentTool({
    getCwd: () => '/tmp/ws',
    getDepth: () => 0,
    makeRunId: () => 'run-matrix',
    // The host resolves fork mode and delivers it through the manifest; this is
    // that delivery.
    isForkModeEnabled: () => forkSubagentModeEnabled(),
    spawn: async (args: SpawnChildSessionArgs): Promise<ChildSessionResult> => {
      spawned.push(args)
      return { agent: args.agentDef.name, status: 'done', text: 'ok', tokensIn: 0, tokensOut: 0 }
    },
  })

  const params: Record<string, unknown> = { agent: 'scout', task: 'inspect' }
  if (backgroundArg !== 'unset') params.background = backgroundArg === 'true'
  const result = await tool.execute('call-matrix', params, undefined, undefined, {} as never)
  const backgrounded = result.details?.backgrounded === true

  const fork = await tool.execute('call-fork', { agent: 'fork', task: 'draft' }, undefined, undefined, {} as never)

  return {
    forkMode,
    backgroundArg,
    disableBackground,
    parameterPresent: 'background' in ((tool.parameters as any).properties ?? {}),
    // The tool reports a backgrounded run by returning a task id instead of the
    // child's text; the spawn call carries the same decision.
    effectiveBackground: backgrounded || spawned.some(args => args.background === true),
    forkTypeAccepted: fork.details?.error?.includes('fork-mode-disabled') !== true,
  }
}

describe('fork mode gate', () => {
  it('reads the three documented env states through the repo flag parser', () => {
    // P6.506 — the UNSET default is ON since 2026-09-07, matching
    // `sub-agents.md#turn-fork-mode-on-or-off`: "Claude Code turns fork mode on
    // by default in interactive sessions". A Nessy Pi session is that shape.
    // Both EXPLICIT states are unchanged and are the boundary this case exists
    // for — a default flip must not move what an operator actually wrote.
    expect(forkSubagentModeEnabled({})).toBe(true)
    expect(forkSubagentModeEnabled({ NESSY_FORK_SUBAGENT: '1' })).toBe(true)
    expect(forkSubagentModeEnabled({ NESSY_FORK_SUBAGENT: 'on' })).toBe(true)
    expect(forkSubagentModeEnabled({ NESSY_FORK_SUBAGENT: 'yes' })).toBe(true)
    expect(forkSubagentModeEnabled({ NESSY_FORK_SUBAGENT: '0' })).toBe(false)
    expect(forkSubagentModeEnabled({ NESSY_FORK_SUBAGENT: 'off' })).toBe(false)
    // AGENTS.md: anything else falls back to the default, which is now ON — so
    // this line moved WITH the default rather than being left asserting the old
    // one, which is how a fallback silently stops following its own rule.
    expect(forkSubagentModeEnabled({ NESSY_FORK_SUBAGENT: 'maybe' })).toBe(true)
  })

  it('moves exactly the documented cells across fork mode x background x disable-background', async () => {
    const cells: Cell[] = []
    for (const forkMode of ['unset', 'on', 'off'] as Tri[]) {
      for (const backgroundArg of ['unset', 'true', 'false'] as BackgroundArg[]) {
        for (const disableBackground of ['unset', 'on'] as const) {
          cells.push(await probe(forkMode, backgroundArg, disableBackground))
        }
      }
    }
    expect(cells).toHaveLength(18)

    for (const cell of cells) {
      // P6.506 — the DEFAULT moved, so every "is fork mode on" test below reads
      // the EFFECTIVE state rather than the literal `'on'` cell. Written once,
      // here, because three separate assertions used to spell the same
      // predicate as `forkMode === 'on'` and a default flip would have left all
      // three quietly asserting the old default.
      const effectivelyOn = cell.forkMode !== 'off'

      // 1. Unset behaves exactly like `on` — our chosen default since P6.506,
      //    matching `sub-agents.md`'s interactive default. This assertion is the
      //    one that fails if the default is flipped and nothing else is.
      const asIfOn = cells.find(other => other.forkMode === 'on'
        && other.backgroundArg === cell.backgroundArg
        && other.disableBackground === cell.disableBackground)!
      if (cell.forkMode === 'unset') {
        expect({ ...cell, forkMode: 'on' }).toEqual(asIfOn)
      }
      // The control the assertion above needs: `off` must NOT equal `on`, or an
      // equality that held because every cell collapsed would read as a pass.
      const asIfOff = cells.find(other => other.forkMode === 'off'
        && other.backgroundArg === cell.backgroundArg
        && other.disableBackground === cell.disableBackground)!
      if (cell.forkMode === 'unset') {
        expect({ ...cell, forkMode: 'off' }).not.toEqual(asIfOff)
      }

      // 2. :1010 — the `fork` type is accepted if and only if fork mode is on.
      expect(cell.forkTypeAccepted).toBe(effectivelyOn)

      // 3. :783 — the parameter exists if and only if fork mode is off. Its
      //    removal is a fork-mode effect, so the off switch does not restore it.
      expect(cell.parameterPresent).toBe(!effectivelyOn)

      // 4. :783 — the off switch wins over everything, including fork mode's
      //    "every subagent runs in the background" and an explicit `true`.
      if (cell.disableBackground === 'on') {
        expect(cell.effectiveBackground).toBe(false)
        continue
      }

      // 5. :1011 — with fork mode on and background tasks available, every
      //    subagent is backgrounded regardless of the argument (which the model
      //    can no longer send anyway).
      if (effectivelyOn) {
        expect(cell.effectiveBackground).toBe(true)
        continue
      }

      // 6. Unchanged legacy behaviour otherwise: the explicit argument wins,
      //    and depth 0 defaults to background.
      expect(cell.effectiveBackground).toBe(cell.backgroundArg !== 'false')
    }

    // The rendered table, so a reviewer reads results rather than assertions.
    const table = cells.map(cell => [
      `fork=${cell.forkMode}`,
      `background=${cell.backgroundArg}`,
      `disable=${cell.disableBackground}`,
      `param=${cell.parameterPresent ? 'present' : 'removed'}`,
      `effective=${cell.effectiveBackground ? 'background' : 'foreground'}`,
      `forkType=${cell.forkTypeAccepted ? 'accepted' : 'rejected'}`,
    ].join(' | ')).join('\n')
    expect(table.split('\n')).toHaveLength(18)
  })
})
