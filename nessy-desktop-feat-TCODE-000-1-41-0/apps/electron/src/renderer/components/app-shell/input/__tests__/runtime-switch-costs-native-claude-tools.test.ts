/**
 * P6.52 — the cost table's `anthropic` column is derived from OUR tool surface,
 * and our surface is not the model's.
 *
 * ## The blind spot, stated as a mechanism
 *
 * `runtime-capability-drift.test.ts` derives every `on` map in
 * `runtime-switch-costs.ts` from `getSessionToolNames(...)`, which enumerates the
 * SESSION tools this repo ships. A Claude session's model is also handed Claude
 * Code's own built-in set — `claude-agent.ts` asks for
 * `tools: { type: 'preset', preset: 'claude_code' }` and subtracts only
 * `CLAUDE_SESSION_DISALLOWED_TOOLS`. Nothing in that derivation can see those
 * tools, so a row that says `anthropic: false` because OUR tool is `pi-only` is
 * only TRUE when the capability has no built-in counterpart.
 *
 * `runtime-switch-costs.ts` already applies exactly this test by hand, and
 * correctly, to the four `Task*` tools: it refuses them a row because "Claude
 * advertises the same four NATIVELY". It had not been applied to the other names
 * in the same overlap, and two live rows rest on them.
 *
 * ## The second half, which is a defect rather than an over-warning
 *
 * The overlap cuts the other way too. Where we DO project one of our tools onto
 * claude and Claude Code ships a built-in of the SAME NAME, the model is offered
 * both — `mcp__session__X` and bare `X` — and can pick whichever it likes. T3 met
 * this once and answered it: bare `Monitor` is in `CLAUDE_SESSION_DISALLOWED_TOOLS`
 * because "a session offering both would let the model pick the ungated one". Its
 * comment calls `Monitor` "the first collision"; measured, it is one of seven, and
 * the other six are not subtracted.
 *
 * ## Why these are pins and not fixes
 *
 * Every remedy is outside this lane's zone (`claude-agent.ts`, `SessionManager`),
 * and two of them are product-posture calls that want a live run first. What a
 * pin CAN do is stop the overlap moving silently, which is this fork's largest
 * defect class: a new `pi-only` tool that collides with a built-in, or a
 * projection that adds a seventh duplicate, fails here and reads the reason.
 *
 * ## The instrument
 *
 * `sdk-tools.d.ts` is the vendored SDK's schema file for Claude Code's OWN
 * tools. That it lists Claude's and not ours is asserted rather than assumed —
 * four of our tool names are checked to be ABSENT from it — because a file that
 * happened to contain every name would make every assertion below vacuous.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SESSION_TOOL_DEFS, getSessionToolNames } from '@nessy-agent/session-tools-core'
import { RUNTIME_SWITCH_COST_CLAIMS } from '../runtime-switch-costs'

const repoFile = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../../../../../${relative}`, import.meta.url)), 'utf8')

const SDK_TOOLS_D_TS = 'node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts'

/**
 * Claude Code's own built-in tool names, read from the vendored SDK.
 *
 * Keyed on `export interface <Name>Input`, which is the SDK's one declaration per
 * tool input schema. A LOWER BOUND on purpose: a built-in whose interface is
 * spelled differently from its tool name (`FileEditInput` for `Edit`) is missed,
 * and missing a collision under-reports rather than inventing one.
 */
const claudeNativeToolNames = (): ReadonlySet<string> => {
  const source = repoFile(SDK_TOOLS_D_TS)
  return new Set([...source.matchAll(/^export interface ([A-Za-z]+)Input\b/gm)].map(match => match[1]!))
}

/** The `CLAUDE_SESSION_DISALLOWED_TOOLS` members, read as text. */
const claudeDisallowedToolNames = (): readonly string[] => {
  const source = repoFile('packages/shared/src/agent/claude-agent.ts')
  const start = source.indexOf('CLAUDE_SESSION_DISALLOWED_TOOLS: readonly string[] = Object.freeze([')
  expect(start, 'the disallowed-tools literal moved or was renamed').toBeGreaterThan(-1)
  const end = source.indexOf(']);', start)
  expect(end).toBeGreaterThan(start)
  return [...source.slice(start, end).matchAll(/'([A-Za-z_]+)'/g)].map(match => match[1]!)
}

/** The raw text of the switch-cost table, so a NAME can be looked for in it. */
const runtimeSwitchCostsSource = (): string =>
  repoFile('apps/electron/src/renderer/components/app-shell/input/runtime-switch-costs.ts')

const ourToolNames = (): readonly string[] => SESSION_TOOL_DEFS.map(def => def.name)
const ourPiOnlyToolNames = (): readonly string[] =>
  SESSION_TOOL_DEFS.filter(def => def.visibility === 'pi-only').map(def => def.name)

describe('the instrument reads Claude Code’s tools and not ours', () => {
  it('lists Claude built-ins, with our own tool names absent as the control', () => {
    const native = claudeNativeToolNames()
    // Positive controls: three built-ins whose presence this file's arguments use.
    for (const name of ['TaskCreate', 'Monitor', 'PushNotification']) {
      expect(native.has(name), `${name} missing — the SDK vendored here is not the one measured`).toBe(true)
    }
    // Negative controls: four tools that are OURS and have never been Claude's.
    // Without these the set could be "every identifier in the file" and every
    // assertion below would pass for the wrong reason.
    for (const name of ['SubmitPlan', 'source_manage', 'advisor_consult', 'send_agent_message']) {
      expect(native.has(name), `${name} is ours; the probe is matching too much`).toBe(false)
    }
    expect(native.size).toBeGreaterThan(30)
  })

  it('reads the disallowed list as a real list', () => {
    const disallowed = claudeDisallowedToolNames()
    // Positive control: a member that has been there since before T3 (`Skill` was one until F1.862 lifted it).
    expect(disallowed).toContain('EnterPlanMode')
    expect(disallowed.length).toBeGreaterThanOrEqual(4)
  })
})

describe('P6.52 — which of our tools Claude Code also ships', () => {
  /**
   * Our `pi-only` names that Claude Code supplies itself.
   *
   * For every name here, "the model cannot do this on claude" is a claim about
   * OUR surface only. Four are already argued in `runtime-switch-costs.ts` (the
   * `Task*` set, refused a cost row for exactly this reason). The other three are
   * the grounds of two live rows — `worktreeMove` and `scheduledRun`. ONE of
   * them has since been settled by a live run: C3.251 moved
   * `worktreeMove.anthropic` to `true` off RS-28, which drove
   * `EnterWorktree` on a claude card against a real repository at the packaged
   * 1.36.0 sitting. `scheduledRun` still stands on an over-warning, because
   * advertised is not delivered and nothing drove a notification. The list
   * below is UNCHANGED by that: it is about what Claude Code SHIPS, which is
   * the premise both rows rest on and not the verdict either reached.
   */
  const PI_ONLY_WITH_A_CLAUDE_BUILT_IN: readonly string[] = [
    'EnterWorktree',
    'ExitWorktree',
    'PushNotification',
    'TaskCreate',
    'TaskGet',
    'TaskList',
    'TaskUpdate',
  ]

  /**
   * Names we DO put on the claude surface that collide with a built-in.
   *
   * Each is offered twice to the model unless the built-in is disallowed. Pinned
   * so a projection cannot quietly add an eighth.
   */
  const PROJECTED_WITH_A_CLAUDE_BUILT_IN: readonly string[] = [
    'CronCreate',
    'CronDelete',
    'CronList',
    'Monitor',
    'ReportFindings',
    'ScheduleWakeup',
    'TodoWrite',
  ]

  it('the pi-only overlap is exactly the pinned set', () => {
    const native = claudeNativeToolNames()
    expect(ourPiOnlyToolNames().filter(name => native.has(name)).sort())
      .toEqual([...PI_ONLY_WITH_A_CLAUDE_BUILT_IN].sort())
  })

  it('the projected overlap is exactly the pinned set', () => {
    const native = claudeNativeToolNames()
    const projected = [...getSessionToolNames()]
    expect(projected.filter(name => native.has(name)).sort())
      .toEqual([...PROJECTED_WITH_A_CLAUDE_BUILT_IN].sort())
  })

  it('the two sets partition our tools that collide, and neither is vacuous', () => {
    const native = claudeNativeToolNames()
    const all = ourToolNames().filter(name => native.has(name)).sort()
    expect(all).toEqual(
      [...PI_ONLY_WITH_A_CLAUDE_BUILT_IN, ...PROJECTED_WITH_A_CLAUDE_BUILT_IN].sort(),
    )
    expect(PI_ONLY_WITH_A_CLAUDE_BUILT_IN.length).toBeGreaterThan(0)
    expect(PROJECTED_WITH_A_CLAUDE_BUILT_IN.length).toBeGreaterThan(0)
  })

  it('Monitor and ScheduleWakeup are subtracted, and the rest are absent for reasons rather than duplicated (P2.512)', () => {
    // P2.512 measured the vendored native binary instead of counting names.
    // Of the seven projected collisions only three reach the model's surface:
    // the three cron tools each carry an isEnabled reading a flag this host
    // forces off on every spawn, and TodoWrite reads a setting we never set.
    // ScheduleWakeup has no isEnabled at all and WAS shipping twice.
    // ReportFindings stays: its built-in is a documented superset of ours.
    // Those three absences are environment decisions rather than properties,
    // which is why the coupling is pinned separately — if the flag stops
    // being forced, that pin fails by name instead of re-arming duplicates.
    const disallowed = new Set(claudeDisallowedToolNames())
    expect(PROJECTED_WITH_A_CLAUDE_BUILT_IN.filter((name) => disallowed.has(name))).toEqual([
      'Monitor',
      'ScheduleWakeup',
    ])
  })

  /**
   * P6.219 — the COMPLEMENT, which no instrument had ever looked at.
   *
   * Every assertion above pins an INTERSECTION: names the bundle declares AND
   * we already carry. The complement is the other side — a name Claude Code
   * ships that appears in NONE of our three registers (`CLAUDE_SESSION_DISALLOWED_TOOLS`,
   * the session-tool registry, the switch-cost table). Unpinned, an SDK bump
   * widens the model's reach by a name nobody has read, and every existing
   * assertion stays green while it happens.
   *
   * Measured 2026-09-06 against the vendored `sdk-tools.d.ts` (45 declarations):
   * 23 names reach a register, 3 reach one under a DIFFERENT SPELLING, and 19
   * reach none. The 19 are reviewed below and split by whether the tree names
   * them at all, because those are two different risks.
   *
   * ## C3.25 — RE-DERIVED 2026-09-11 against the vendored `0.3.247` / `2.1.247`
   *
   * The reading above was taken at `0.3.233` and the bundle has moved fourteen
   * patch versions since, so the complement was a reading with a date rather
   * than a fact. Re-derived: **unchanged** — 45 declarations, the same
   * 23 / 3 / 19 split, the same nineteen names, the same nine unseen. No new
   * member arrived, so nothing needed adding to the disallow list, the registry
   * or the switch-cost table.
   *
   * The re-derivation also closed the hole that made the row necessary: nothing
   * tied the reading to the BUNDLE VERSION, so a lift could move under it while
   * every assertion here stayed green. `LAST_DERIVED_AGAINST_SDK_VERSION` at the
   * end of this block is that tie.
   *
   * RE-DERIVED AGAIN 2026-09-24 against `0.3.267` / `2.1.267` (F1.255): unchanged —
   * 45 `…Input` declarations in `sdk-tools.d.ts`, none added and none removed
   * against the `0.3.251` tarball in the bun cache, and every other case of this
   * block green on the lifted bundle before the tie moved.
   *
   * RE-DERIVED AGAIN 2026-10-01 against `0.3.274` / `2.1.274` (F1.1213): unchanged —
   * the same 45 `…Input` declaration names in `sdk-tools.d.ts` as the 0.3.267
   * tarball (diffed by name), and every other case of this block green on the
   * lifted bundle before the tie moved.
   *
   * RE-DERIVED AGAIN 2026-10-10 against `0.3.280` / `2.1.280` (UA12.211): the
   * surface SHRANK for the first time in this block's history — `TaskOutputInput`
   * and `REPLInput` left `sdk-tools.d.ts` (45 → 43 `…Input` declarations; the
   * name diff against the 0.3.274 tarball still in the bun cache is exactly
   * those two lines, nothing arrived), the SDK having removed both tools (the
   * vendored sdk.d.ts on TaskOutput: "Deprecated: no longer has any effect (the
   * TaskOutput tool was removed). Read a background task's output file with the
   * Read tool instead."). Per the rule the first assertion below states,
   * `TaskOutput` left UNREGISTERED_BUT_NAMED_IN_TREE and `REPL` left
   * UNREGISTERED_AND_UNSEEN. The host's own copies of the two names are
   * deliberately NOT swept: `ALWAYS_ALLOWED_TOOL_NAMES` and `BUILT_IN_TOOLS`
   * carry dated in-place notes (an inert allow entry grants nothing; the SDK
   * tool's metadata exemption is now dead weight with the tool gone), and
   * `CLAUDE_KNOWN_TOOL_NAMES` keeps both names on purpose — a stored permission
   * rule naming either must not read as unknown, and that set is a superset
   * whose stale names only under-report.
   */
  describe('P6.219 — the complement: bundle tools no register of ours knows', () => {
    /**
     * The SDK's interface name is not always the tool name — this is the ONE
     * place that inflation is written down. `FileEditInput` is `Edit`'s schema,
     * and `Edit`/`Read`/`Write` are all named in the switch-cost table, so
     * counting them as unknown would over-report by three.
     *
     * Keys are SDK interface names; values are the tool name a register carries.
     */
    const SDK_INTERFACE_ALIASES: Readonly<Record<string, string>> = {
      FileEdit: 'Edit',
      FileRead: 'Read',
      FileWrite: 'Write',
    }

    /**
     * Reviewed, and the tree DOES name them — a reader has at least met the
     * word, so the risk is a wrong assumption rather than a blind spot.
     *
     * The per-name FILE COUNTS this list used to carry are gone, and their
     * removal is the point rather than tidying: every one of them had moved
     * within five days (`AskUserQuestion` 18 → 21, `NotebookEdit` 36 → 40,
     * `WebFetch` 40 → 45, `Workflow` 32 → 37, `SendFeedback` 1 → 2), which is
     * AGENTS.md's *a count is a reading with a date* in its smallest form. The
     * load-bearing claim is "non-zero", not the number, and the reader
     * re-derives it rather than trusting a line — note `-w`, without which
     * `Mcp` and `Artifact` match half the tree:
     *
     * ```sh
     * git grep -alIw -- '<Name>' -- packages/shared/src packages/server-core/src \
     *   packages/session-tools-core/src apps/electron/src \
     *   ':(exclude)apps/electron/src/renderer/components/app-shell/input/__tests__/runtime-switch-costs-native-claude-tools.test.ts'
     * ```
     *
     * Re-measured that way 2026-09-11 (C3.25): all ten still non-zero, 2–45
     * files each. The exclusion matters — this file names all nineteen, so a
     * probe that counts it answers 1 for every unseen name.
     */
    // F1.253 (2026-09-23): `Artifact` and `Projects` left this list for
    // CLAUDE_SESSION_DISALLOWED_TOOLS — claude.ai cloud tools, denied on every card.
    // UA12.211 (2026-10-10, the 0.3.280 lift): `TaskOutput` left this list —
    // its `TaskOutputInput` declaration is gone from `sdk-tools.d.ts` (45 → 43),
    // and a reviewed name the bundle no longer declares is exactly the rot the
    // first assertion below exists to catch.
    const UNREGISTERED_BUT_NAMED_IN_TREE: readonly string[] = [
      'AskUserQuestion',
      'Mcp',
      'NotebookEdit',
      'SendFeedback',
      'TaskStop',
      'WebFetch',
      'Workflow',
    ]

    /**
     * Reviewed, and the tree names them NOWHERE — zero files each on the same
     * run. This is the set the row was born for. It is NINE, not the five the
     * row's own evidence lists: `ClaudeDesign`, `ProposeGoal`, `ProposeSkills`
     * and `ReadNotifications` are as unseen as the five and were not counted.
     *
     * Re-measured 2026-09-11 (C3.25) with the command above: eight are still
     * zero and `REPL` is now ONE — `packages/shared/src/utils/open-url.ts`,
     * whose docblock mentions "the REPL footer-link scanner". A different
     * subject that happens to spell the same four letters, so the name stays
     * here; recorded rather than silently re-counted, because the next reader
     * running the probe will meet that hit and needs to know it was seen.
     */
    // F1.253 (2026-09-23): `ClaudeDesign` and `RemoteTrigger` left this list for
    // CLAUDE_SESSION_DISALLOWED_TOOLS, beside `Artifact` and `Projects` above.
    // UA12.211 (2026-10-10, the 0.3.280 lift): `REPL` left this list — its
    // `REPLInput` declaration is gone from `sdk-tools.d.ts` (the SDK removed the
    // tool, same lift that removed TaskOutput), so the 2026-09-11 note below is
    // history twice over: the name no longer rots here because the bundle no
    // longer declares it.
    const UNREGISTERED_AND_UNSEEN: readonly string[] = [
      'ProposeGoal',
      'ProposeSkills',
      'ReadMcpResourceDir',
      'ReadNotifications',
      'RefreshMcpTools',
      'ShowOnboardingRolePicker',
    ]

    /** Names reaching at least one register, derived — never hand-listed. */
    const registeredNames = (): ReadonlySet<string> => {
      const costs = runtimeSwitchCostsSource()
      const registers = new Set<string>([...claudeDisallowedToolNames(), ...ourToolNames()])
      return new Set(
        [...claudeNativeToolNames()].filter(name => (
          registers.has(name) || new RegExp(`\\b${name}\\b`).test(costs)
        )),
      )
    }

    it('every bundle-declared tool is registered, aliased, or in the reviewed complement — nothing else', () => {
      const native = [...claudeNativeToolNames()]
      const registered = registeredNames()
      const unaccounted = native.filter(name => (
        !registered.has(name)
        && !(name in SDK_INTERFACE_ALIASES)
        && !UNREGISTERED_BUT_NAMED_IN_TREE.includes(name)
        && !UNREGISTERED_AND_UNSEEN.includes(name)
      ))
      // The whole point of the row: a bump that adds a tool lands HERE, by name.
      expect(unaccounted, 'the vendored SDK declares a tool no register and no reviewed list carries')
        .toEqual([])
      // ...and a name leaving the bundle must not rot in a reviewed list either.
      const nativeSet = new Set(native)
      expect(
        [...UNREGISTERED_BUT_NAMED_IN_TREE, ...UNREGISTERED_AND_UNSEEN, ...Object.keys(SDK_INTERFACE_ALIASES)]
          .filter(name => !nativeSet.has(name)),
        'a reviewed name is no longer declared by the bundle — drop it from the list',
      ).toEqual([])
    })

    it('the reviewed complement is exactly what it says it is', () => {
      const registered = registeredNames()
      const complement = [...claudeNativeToolNames()]
        .filter(name => !registered.has(name) && !(name in SDK_INTERFACE_ALIASES))
        .sort()
      expect(complement)
        .toEqual([...UNREGISTERED_BUT_NAMED_IN_TREE, ...UNREGISTERED_AND_UNSEEN].sort())
    })

    it('each alias resolves to a tool name a register really carries', () => {
      const costs = runtimeSwitchCostsSource()
      const registers = new Set<string>([...claudeDisallowedToolNames(), ...ourToolNames()])
      for (const [interfaceName, toolName] of Object.entries(SDK_INTERFACE_ALIASES)) {
        expect(
          registers.has(toolName) || new RegExp(`\\b${toolName}\\b`).test(costs),
          `${interfaceName} claims to alias ${toolName}, which no register carries`,
        ).toBe(true)
      }
    })

    /**
     * C3.25 — the version this block's reading was last re-derived against.
     *
     * Bump it ONLY after re-running this file at the new bundle. Every other
     * assertion here compares the bundle against hand-kept lists, so they all
     * stay green when the bundle is lifted and the lists still happen to match —
     * which is exactly what a fourteen-version drift looked like from inside.
     */
    const LAST_DERIVED_AGAINST_SDK_VERSION = '0.3.280'

    it('C3.25: the complement has been re-derived against the bundle actually vendored here', () => {
      const vendored = (
        JSON.parse(repoFile('node_modules/@anthropic-ai/claude-agent-sdk/package.json')) as {
          version: string
        }
      ).version

      // Instrument control first: an unreadable or reshaped manifest must fail
      // as itself rather than make the comparison below read `undefined`.
      expect(vendored).toMatch(/^0\.\d+\.\d+$/)

      expect(
        { vendored, lastDerivedAgainst: LAST_DERIVED_AGAINST_SDK_VERSION },
        'the vendored Claude SDK has moved since this block\'s complement was derived. Re-run this '
          + 'file: if it is green, the tool surface is unchanged — refresh the dated paragraph in the '
          + 'block docblock and bump LAST_DERIVED_AGAINST_SDK_VERSION. If it is red, a bundle tool '
          + 'arrived or left, and it must be named in CLAUDE_SESSION_DISALLOWED_TOOLS, the session-tool '
          + 'registry, the switch-cost table, or one of the two reviewed lists here — with the reason.',
      ).toEqual({ vendored, lastDerivedAgainst: vendored })
    })

    it('the controls: a registered name is not in the complement, and a nonsense name is in nothing', () => {
      const registered = registeredNames()
      // `EnterPlanMode` — the row's own positive control. Disallowed AND named
      // in the cost table, so it must never read as unregistered.
      expect(registered.has('EnterPlanMode')).toBe(true)
      expect(UNREGISTERED_AND_UNSEEN).not.toContain('EnterPlanMode')
      expect(UNREGISTERED_BUT_NAMED_IN_TREE).not.toContain('EnterPlanMode')
      // Negative control: without it, `registeredNames()` returning everything
      // would make the complement empty and every assertion above vacuous.
      expect(claudeNativeToolNames().has('ZzzNotARealClaudeTool')).toBe(false)
      expect(registered.has('ZzzNotARealClaudeTool')).toBe(false)
      // And the complement is non-empty, which is the finding itself.
      expect(UNREGISTERED_AND_UNSEEN.length).toBeGreaterThan(0)
    })
  })

  it('the two cost rows that rest on the overlap have SPLIT: one driven, one still unmeasured', () => {
    // P6.597 — the tripwire fired, and this is the flip it was built to make
    // visible. It read `.toBe(false)` and its comment anticipated a flip "after
    // a live run"; the move that came was the OPPOSITE one, and it is the reason
    // the tripwire was worth having. What this file measures is that Claude Code
    // ADVERTISES `EnterWorktree`/`ExitWorktree` and `PushNotification` to our
    // session. That made `false` — a claim that claude does not have the
    // capability — unsupported, while `true` would have promised a delivery no
    // live run had driven, so both rows took `'unmeasured'` (P6.562).
    //
    // C3.251 is the live run the tripwire asked for, and it names it: **RS-28**,
    // driven at the packaged 1.36.0 release sitting on 2026-09-11 (`152f4035e`,
    // pass 2). Arm A issued `EnterWorktree` on a claude card against a real
    // repository; the tool succeeded and the control was green. So
    // `worktreeMove.anthropic` is a boolean now, earned by that run.
    //
    // `scheduledRun` is asserted STILL `'unmeasured'` in the same breath, and
    // that is the half that keeps this guard honest: nothing drove a
    // notification, and a sweep that moved both because they were written
    // together would be exactly the over-flat claim this file exists to catch.
    expect(RUNTIME_SWITCH_COST_CLAIMS['worktreeMove'], 'worktreeMove left the cost table').toBeDefined()
    expect(RUNTIME_SWITCH_COST_CLAIMS['worktreeMove']!.anthropic).toBe(true)
    expect(RUNTIME_SWITCH_COST_CLAIMS['scheduledRun'], 'scheduledRun left the cost table').toBeDefined()
    expect(RUNTIME_SWITCH_COST_CLAIMS['scheduledRun']!.anthropic).toBe('unmeasured')
    // The run that earned it is named where a reader will look for it, and the
    // checklist row is the durable record rather than this sentence.
    const checklist = repoFile('docs/testing/cdp-live-checklist.md')
    const rs28 = checklist.split('\n').find(line => line.startsWith('| RS-28 '))
    expect(rs28, 'the RS-28 checklist row is gone').toBeDefined()
    expect(rs28!).toContain('PASS')
  })
})
