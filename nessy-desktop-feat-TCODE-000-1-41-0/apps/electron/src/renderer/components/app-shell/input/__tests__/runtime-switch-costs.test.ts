/**
 * R11 — what a runtime switch costs, told to the user before they take it.
 *
 * Two halves, and the second is the one that matters. The table is a pure
 * function and is exercised directly. The WIRING is asserted by reading the
 * two files on the user's path, because this runner has no DOM: `ConnectionRow`
 * is where a session's runtime is picked, and `RuntimeSwitchDialog` is the only
 * thing it renders in front of the switch. A tested table that no dialog calls
 * is a library, not a fix — so every wiring assertion below carries a positive
 * control, and removing the call from the dialog turns this file red.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  RUNTIME_SWITCH_COST_BODY_KEYS,
  RUNTIME_SWITCH_COST_CLAIMS,
  RUNTIME_SWITCH_COST_CONSEQUENCE_ORDER,
  runtimeSwitchCosts,
} from '../runtime-switch-costs'

const sourceOf = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

const dialog = sourceOf('../RuntimeSwitchDialog.tsx')
const connectionRow = sourceOf('../ConnectionRow.tsx')
const locale = (code: string): Record<string, string> =>
  JSON.parse(sourceOf(`../../../../../../../../packages/shared/src/i18n/locales/${code}.json`))

const idsFor = (from: Parameters<typeof runtimeSwitchCosts>[0], to: Parameters<typeof runtimeSwitchCosts>[1]) =>
  runtimeSwitchCosts(from, to).map(cost => cost.id)

describe('runtimeSwitchCosts — the list is per DIRECTION', () => {
  // The whole model in one pair: the two legs of the same move are different
  // lists, because a cost is a capability the SOURCE has and the TARGET lacks.
  it('is not symmetric — Pi → Claude and Claude → Pi are different lists', () => {
    expect(idsFor('pi', 'anthropic'))
      // P6.896 — `webSearch` sat between `scheduledRun` and `gatewayFeatureFlags`
      // and was RETIRED, not moved: P6.148's claude arm made its three cells all
      // `true`, and a row that can never fire is not a row.
      // C3.251 — `worktreeMove` LEFT this leg, and it is the second subtraction
      // this list has recorded. Not a retirement like `webSearch`: the row still
      // fires out of claude and out of Pi into codex. RS-28 drove claude's
      // native `EnterWorktree` against a real repository at the packaged 1.36.0
      // sitting and it succeeded, so the claude cell moved `'unmeasured'` → `true`
      // and a capability that is not lost is not a switch cost.
      // C3.256 — `autoMemoryDirectoryScope` joins in `subagentReportScan`'s
      // table position, and it is the FIRST row ever to reach this leg by being
      // `anthropic: false` with both other runtimes `true`: a claude-only
      // absence, where every earlier addition here was a Pi-held capability.
      .toEqual(['guardianJudge', 'autoDenialBreaker', 'subagentWorktree', 'autoMemoryDirectoryScope',
        'scheduledRun',
        'gatewayFeatureFlags', 'forkSubagent', // F1.588 retired `subagentModelOrder` here
        'subagentMemory', 'toolSupportFallback'])
    // P6.170 · the return leg is no longer EMPTY, and that is the change, not a
    // regression. It used to be `[]` because every row happened to be `pi: true`,
    // which made "switching back onto Pi costs nothing" a property of the row set
    // rather than of the mechanism. `policyKeys` is the first row Pi lacks.
    // P6.346(a) added the second: `toolMemoryCap`, whose claude claim is
    // `'unmeasured'` — it fires OUT of claude on the same rule a definite claim
    // would, under a marker.
    // P6.382 added the third: `subagentOutputText`, whose claude claim is `true`
    // and whose Pi claim is a MEASURED `false` — the first row on this leg that
    // is a plain measurement rather than an unmeasured caution.
    // P6.340 added the fourth: `projectMcpApproval` — the three documented keys
    // that approve a project's own MCP servers. The vendored binary honours them
    // and nothing of ours reads them on either of the other two runtimes.
    // P6.690 added the fifth: `bashWorkingDir` — a `cd` that persists across Bash
    // calls on claude by documented default and on neither of the other two.
    // P6.743's `toolSupportFallback` is NOT here, and that absence is the rule
    // rather than an oversight: its claude cell is `'unmeasured'` and Pi's is a
    // definite `true`, and an unmeasured SOURCE into a target that has the
    // capability outright returns null — we do not warn about GAINING something.
    // P6.596 added the sixth: `toolRestriction`. Pi's cell is `'conditional'`
    // and claude's is a definite `true`, so it fires INTO Pi on the ordinary
    // rule — the deny-list half of a session tool restriction is silently
    // ignored there (P6.852), and the allow-list half survives.
    // P6.312 added a seventh, `sessionAgent`, and P6.1018 TOOK IT BACK OFF this
    // leg — the only subtraction this list records, and it is the shape worth
    // keeping. The row was written when Pi had no main-session-agent path at
    // all; P6.940 clause (2) (`fb011ffcb`) then taught the HOST to compose one
    // for Pi out of the same `sessionAgent` key the claude arm reads, so the
    // capability arrives on Pi and this leg costs nothing. For a day the cell
    // said otherwise and the dialog named a loss the switcher had not taken.
    // The cell follows the capability the user gets, not the mechanism that
    // provides it: host-composed and runtime-native are the same session.
    expect(idsFor('anthropic', 'pi'))
      // C3.276 — `claudeProjectCommands` is the eighth row on this leg and the
      // first whose subject is a DIRECTORY the claude child reads and neither
      // other runtime nor the host's own loader does.
      .toEqual(['claudeProjectCommands',
        'policyKeys', 'projectMcpApproval', 'bashWorkingDir', 'toolMemoryCap',
        // C3.98 and C3.219 (2026-09-11), both claude-held and absent here.
        'securityPluginEnv', 'subagentAgentIdHeader',
        // C3.64 (2026-09-11): the claude runtime's own Explore and Plan, which
        // Pi has no vendor roster to supply.
        'claudeBuiltinAgents',
        // C3.290 (2026-09-11): claude and codex both load skills out of an added
        // folder and Pi loads them by neither path, so this row fires on the two
        // legs INTO Pi and nowhere else.
        'addedFolderSkills', 'subagentOutputText',
        'toolRestriction'])
    // The negative control for that subtraction, so "it stopped firing" cannot
    // pass as "the row went inert": it still fires on both legs INTO codex.
    expect(idsFor('anthropic', 'codex-runtime')).toContain('sessionAgent')
    expect(idsFor('pi', 'codex-runtime')).toContain('sessionAgent')
  })

  /**
   * P2.315. The Guardian safety judge is ours and runs on Pi alone
   * (`consultGuardian` → pi 6, claude 0, codex 0; claude's absence is pinned by
   * `claude-agent-guardian-free.test.ts`). It matters most in Allow all, where
   * nothing else asks — so leaving Pi for either vendor runtime has to say so,
   * and coming back must not.
   */
  it('names the Guardian on the way out of Pi, in both directions, and never on the way back', () => {
    expect(idsFor('pi', 'anthropic')).toContain('guardianJudge')
    expect(idsFor('pi', 'codex-runtime')).toContain('guardianJudge')
    expect(idsFor('anthropic', 'pi')).not.toContain('guardianJudge')
    expect(idsFor('codex-runtime', 'pi')).not.toContain('guardianJudge')
    // Neither vendor runtime runs it, so a move BETWEEN them costs nothing here
    // — the set-difference model, and the control that keeps the row from being
    // a property of the target.
    expect(idsFor('anthropic', 'codex-runtime')).not.toContain('guardianJudge')
    expect(idsFor('codex-runtime', 'anthropic')).not.toContain('guardianJudge')
  })

  it('names everything Codex cannot do, coming from Pi', () => {
    expect(idsFor('pi', 'codex-runtime')).toEqual([
      'preToolCheck',
      'preToolDefer',
      // P6.928 — the operator's read fence. Placed beside the two pre-call rows
      // because it rides the same gate, and separate from them because it is a
      // SETTING the user turned on rather than a mechanism they never see.
      'readFence',
      'guardianJudge',
      'autoDenialBreaker',
      'worktreeMove',
      'subagentWorktree',
      'subagentReportScan',
      // C3.377 — the DEPTH of the protected-path floor, not its existence:
      // codex's projection resolves each subpath against a ROOT, so a `.git`
      // below the workspace top is writable where Pi and claude prompt.
      'nestedProtectedPaths',
      // C4.49 — the sibling row, and it sits here because it is the same
      // consequence class and a different question: the 37 protected FILES
      // reach no codex session at all, where `nestedProtectedPaths` above is
      // about how DEEP the protected directories reach once they do.
      'protectedFilesUnprojected',
      'planApproval',
      'appActions',
      'bridgeTools',
      'scheduledRun',
      // UB12.63 RETIRED `outputStyleTiming` (codex now applies a mid-session
      // style to the next message, so all three cells are `true`).
      'autoCompactionOff',
      'autoCompactionKnobs',
      // P6.148 — `webSearch` LEFT this leg (the host registers its own
      // `web_search` on every codex session over the key-free engine Pi falls
      // back to), and P6.896 then removed the row from the table outright once
      // its claude arm landed and all three cells read `true`.
      'liveToolInput',
      'subagentNesting',
      // C3.285 — the build C3.12 asked for, and the row that is about the
      // rules the USER wrote rather than about the gate: codex's approval
      // projection carries three tool names and two input fields, so a rule
      // naming another subject has nothing to match on that path.
      'ruleSubjects',
      // C3.310 — the sibling of the row above, and the one it used to deny:
      // `Host(...)` and `mcp(...)` rules bind nothing on codex by EITHER path,
      // because no host-run tool reaches the rule gate there at all.
      'hostMcpRules',
      'pathScopedInstructions',
      'forkSubagent',
      'subagentMemory',
      'backgroundTaskOffSwitch',
      'reasoningCarry',
      'toolSupportFallback',
      // P6.1018 — the row arrived on this leg without being added to the table:
      // P6.940 clause (2) gave Pi the capability host-side, so `pi` went `false`
      // → `true` and a leg that could not fire a `pi: false` row now does.
      'sessionAgent',
    ])
    // NOT every row: a `pi: false` row cannot fire on a leg that LEAVES Pi, and
    // there are FOURTEEN of those today — C3.276's `claudeProjectCommands`,
    // `credentialShellFloor`, `policyKeys`,
    // `projectMcpApproval`, `bashWorkingDir`, `toolMemoryCap`, codex's two —
    // `codexBuiltinAgents` and `codexReviewer` (P6.225) — `subagentOutputText`
    // (P6.382), the two C3.98/C3.219 added on 2026-09-11,
    // `securityPluginEnv` and `subagentAgentIdHeader`, and C3.64's
    // `claudeBuiltinAgents`, and C3.290's `addedFolderSkills` (claude's AND
    // codex's, and Pi's by neither path), and C4.42's `codexDetachedReview`
    // (codex's own review THREAD, which only codex has), all of which leave the
    // numerator where it was, so this leg is twenty-seven of forty-four. (C3.285's `ruleSubjects` is
    // `pi: true` and moves the NUMERATOR instead of this list: it fires on the
    // leg out of Pi into codex, which is what the fraction counts — and C3.310's
    // `hostMcpRules` is the same shape, which is why the fraction moved on BOTH
    // halves while the twelve names below it stood still.)
    // The word said "five" while the list beside it named six and the table held
    // nine, which is this file's own recurring failure: re-read the count, never
    // restate it. Asserted here because the parity suite's "Pi → Codex fires
    // everything" assumption died on exactly that (P6.170). The fraction is
    // re-read, not restated: it said "twelve of fourteen" while the table held
    // fifteen rows, and this comment named THREE `pi: false` rows while the
    // table held five. P6.296's `preToolDefer` made it nineteen of twenty-seven,
    // and P6.696's `backgroundTaskOffSwitch` twenty of twenty-eight.
    // P6.200's `subagentReportScan` makes it twenty-one of thirty-one: `true`
    // on pi AND claude, so it fires on both forward legs into codex and on
    // neither leg between the two runtimes that hold it.
    // P6.481's `reasoningCarry` makes it twenty-two of thirty-two: `true` on pi
    // and claude and `'conditional'` on codex, and a conditional TARGET fires.
    // P6.743's `toolSupportFallback` makes it twenty-three of thirty-three:
    // `true` on pi and a measured `false` on codex.
    // P6.148 takes it back DOWN to twenty-two of thirty-three, and it is the
    // first row ever to leave this leg: codex's `webSearch` cell moved `false`
    // → `true` because the host now registers its own `web_search` there, so
    // Pi → codex loses nothing on that capability any more. P6.896 then removed
    // the row itself, making it twenty-two of THIRTY-TWO — the denominator
    // moved and the numerator did not, which is what retiring an already-silent
    // row looks like from this leg.
    // P6.928's `readFence` takes it to twenty-three of THIRTY-FIVE: `true` on
    // pi and claude, `false` on codex, so it fires on both forward legs. It is
    // the first row this leg gained from a ruling that REFUSED to build rather
    // than from one that found something missing — codex's own filesystem
    // profile could carry the fence and is deliberately not made to.
    // P6.1018's `sessionAgent` takes it to twenty-four of thirty-five WITHOUT
    // the table growing — the numerator moved and the denominator did not, which
    // is the mirror image of P6.896's removal above and the only other way this
    // fraction has ever changed: a cell went `false` → `true` on Pi because the
    // host started composing the capability there (P6.940 clause 2).
    // C3.285's `ruleSubjects` takes it to twenty-five of FORTY, moving both
    // halves: it is `true` on pi and claude and `false` on codex, so it fires on
    // both forward legs and on neither leg back.
    // C3.310's `hostMcpRules` takes it to twenty-six of FORTY-ONE by the same
    // shape and for the reason `ruleSubjects` used to deny: `Host(...)` and
    // `mcp(...)` rules bind nothing on codex by either path.
    // C3.377's `nestedProtectedPaths` takes it to twenty-seven of FORTY-FOUR,
    // moving both halves the way `ruleSubjects` did: `true` on pi and claude,
    // `false` on codex, so it fires on both forward legs and on neither leg
    // back. Re-read the fraction rather than restating it — the paragraph above
    // records four occasions on which this file's own prose aged past its list.
    // C4.49's `protectedFilesUnprojected` takes it to twenty-eight of FORTY-SIX
    // by that same shape, and the denominator moves by TWO rather than one
    // because C4.42's `codexDetachedReview` lands in the same commit and is
    // `pi: false` — it joins the list above instead of this fraction, which is
    // the whole reason the two halves of this sentence are counted separately.
    // F1.588 made it twenty-eight of FORTY-FIVE by retiring `subagentModelOrder`,
    // which was `true` on pi and codex and so never fired on this leg.
    // UB12.63 made it twenty-seven of FORTY-FOUR by retiring `outputStyleTiming`,
    // which was `true` on pi and `false` on codex, so BOTH halves moved: the
    // first retirement of a row that still fired on this leg when it went.
    expect(idsFor('pi', 'codex-runtime')).toHaveLength(27)
  })

  /**
   * P6.1022 — the sentence above, held to the table it describes.
   *
   * It is the one claim in this file nothing could read. It was stale in THREE
   * directions at once — the word said "five", the list beside it named six, and
   * the table held nine — and unlike the `lists <word>` family it had no
   * assertion of its own, so each of the three was found by a person re-counting
   * rather than by a run. The comment is worth keeping (it says WHICH rows and
   * why, which no assertion can), so what it needs is a reader.
   *
   * All three numbers, because the drift has taken all three: the count word,
   * the identifiers listed beside it, and the `<n> of <m>` fraction that closes
   * it. `<m>` is the table's own size, so a row added anywhere in the file
   * reddens here until the sentence is re-read.
   *
   * A word this guard cannot parse is a RED, never a pass — the alternative is a
   * guard that goes quiet the first time somebody writes a number it does not
   * know, which is how the `lists <word>` family failed twice in one wave.
   */
  it('holds the `pi: false` sentence to the table — its number, its names and its fraction', () => {
    // Only `//` lines, so this case's own regex — which necessarily spells the
    // sentence it hunts for — cannot be found by it. Same inversion AGENTS.md
    // records for a stale-NAME guard: a substring guard cannot tell code from the
    // prose beside it, and it fires exactly when the thing it guards is correct.
    const comments = sourceOf('./runtime-switch-costs.test.ts')
      .split('\n')
      .filter(line => /^\s*\/\//.test(line))
      .map(line => line.replace(/^\s*\/\/ ?/, ''))
      .join(' ')

    const said = /there are ([A-Z]+) of those today([\s\S]*?)so this leg is ([a-z-]+) of ([a-z-]+)/.exec(comments)
    // A rewrite that DELETES the sentence must be red rather than vacuously
    // green: an unread claim is what this case exists to end.
    expect(said === null ? 'the `pi: false` sentence has left this file' : 'found').toBe('found')
    const [, word, names, numerator, denominator] = said as RegExpExecArray

    const UNITS = new Map<string, number>([
      ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6], ['seven', 7],
      ['eight', 8], ['nine', 9], ['ten', 10], ['eleven', 11], ['twelve', 12], ['thirteen', 13],
      ['fourteen', 14], ['fifteen', 15], ['sixteen', 16], ['seventeen', 17], ['eighteen', 18],
      ['nineteen', 19],
    ])
    const TENS = new Map<string, number>([['twenty', 20], ['thirty', 30], ['forty', 40], ['fifty', 50]])
    const valueOf = (raw: string): number | undefined => {
      const lower = raw.toLowerCase()
      const whole = UNITS.get(lower) ?? TENS.get(lower)
      if (whole !== undefined) return whole
      const parts = lower.split('-')
      const tens = TENS.get(parts[0] ?? '')
      const unit = UNITS.get(parts[1] ?? '')
      return tens === undefined || unit === undefined || parts.length !== 2 ? undefined : tens + unit
    }

    const piFalse = Object.entries(RUNTIME_SWITCH_COST_CLAIMS)
      .filter(([, on]) => on.pi === false)
      .map(([id]) => id)
      .sort()

    // 0 — the parser's own boundary, first: a `valueOf` that answered `undefined`
    // for everything would make the three assertions below pass against nothing,
    // and `toBe(undefined)` is what a silently-broken one returns.
    expect([valueOf('eight'), valueOf('twenty-four'), valueOf('thirty')]).toEqual([8, 24, 30])
    expect([valueOf('eleventy'), valueOf('twenty-twenty'), valueOf('8')]).toEqual([undefined, undefined, undefined])

    // 1 — the count word against the table.
    expect(valueOf(word)).toBe(piFalse.length)
    // 2 — the identifiers listed beside it, as a SET: the sentence groups them by
    // provenance rather than in table order, and that grouping is the readable
    // part.
    expect([...names.matchAll(/`([A-Za-z][A-Za-z0-9]*)`/g)].map(hit => hit[1]).sort()).toEqual(piFalse)
    // 3 — the fraction that closes it, both halves. The denominator is the whole
    // table, so a row added anywhere reddens here.
    expect(valueOf(numerator)).toBe(idsFor('pi', 'codex-runtime').length)
    expect(valueOf(denominator)).toBe(Object.keys(RUNTIME_SWITCH_COST_CLAIMS).length)
  })

  // Claude → Codex must NOT inherit Pi's two Pi-only rows. A table keyed on the
  // target alone would list them here, and that is the exact mistake this shape
  // exists to prevent.
  /**
   * P6.382 — the DIRECTION, because this row's premise was written backwards and
   * a later reader is likelier to "correct" it than to check it.
   *
   * The plan row said claude could not stream a subagent's own output. It can,
   * since `a8377a7fb` set the SDK's own `forwardSubagentText`, and Pi is the
   * runtime that forwards a heartbeat and a tool count instead. So the row fires
   * LEAVING claude and must stay silent leaving Pi. Flipping the two cells would
   * still satisfy every count pin in this file; only this assertion sees it.
   */
  it('names a subagent\'s own output leaving claude, and never leaving Pi', () => {
    expect(idsFor('anthropic', 'pi')).toContain('subagentOutputText')
    expect(idsFor('pi', 'anthropic')).not.toContain('subagentOutputText')
    expect(idsFor('pi', 'codex-runtime')).not.toContain('subagentOutputText')
    // The codex cell is `'unmeasured'`, so it fires INTO codex under a marker and
    // stays silent on the return leg into claude, which HAS the capability.
    expect(runtimeSwitchCosts('anthropic', 'codex-runtime')
      .find(cost => cost.id === 'subagentOutputText')?.certainty).toBe('unmeasured')
    expect(idsFor('codex-runtime', 'anthropic')).not.toContain('subagentOutputText')
  })

  /**
   * The two halves of `'conditional'`, asserted rather than left to the module's
   * own docblock: a conditional TARGET fires, a conditional SOURCE does not,
   * because warning about the loss of something that may never have existed is
   * noise.
   *
   * P3.342 wrote this test on `webSearch`, whose CLAUDE claim was the first
   * `'conditional'` in the table. **P6.896 retired that row** — P6.148 made all
   * three of its cells `true` — and no claude cell is `'conditional'` any more,
   * so the property is re-anchored on `toolRestriction`, whose PI claim is
   * conditional. The direction is mirrored and the rule is the same one; what
   * must not happen is the property going untested because its example closed.
   */
  it('a conditional claim fires as a target and stays silent as a source', () => {
    expect(RUNTIME_SWITCH_COST_CLAIMS.toolRestriction!.pi).toBe('conditional')
    // Fires as a TARGET: claude has the capability outright, Pi only under a
    // precondition this table cannot evaluate, so the switch carries the line.
    expect(idsFor('anthropic', 'pi')).toContain('toolRestriction')
    // Stays silent as a SOURCE, even into codex, which lacks it outright — the
    // module's own known under-warn direction, recorded on the row.
    expect(idsFor('pi', 'codex-runtime')).not.toContain('toolRestriction')
    // And the control that keeps the two halves from being one accident: the
    // same row DOES fire out of claude, whose claim is a definite `true`.
    expect(idsFor('anthropic', 'codex-runtime')).toContain('toolRestriction')
  })

  it('drops the Pi-only rows when the source is Claude', () => {
    // P3.227's row was NOT Pi-only — pi and claude both apply a style change to
    // the next message — so it was the first row to join this leg since P2.484,
    // and it was here rather than in the list above only because the two lists
    // differ by the Pi-only rows (UB12.63 retired it: codex applies the change
    // to the next message too). P3.234's `autoCompactionOff` is the second,
    // for the same reason: Pi sends `set_auto_compaction` and Claude sets
    // `DISABLE_AUTO_COMPACT`, so both have the switch and only codex lacks it.
    // P6.597 — `worktreeMove` and `scheduledRun` joined this leg, both as
    // `'unmeasured'` claude sources firing into a target that lacks the
    // capability outright: we cannot tell this user they are keeping something
    // we never drove. C3.251 left the pair intact on THIS leg and changed what
    // one of them means — `worktreeMove`'s claude cell is a driven `true` since
    // RS-28, so it fires here as a plain measurement and `scheduledRun` is now
    // the only `'unmeasured'` row in this list.
    expect(idsFor('anthropic', 'codex-runtime'))
      .toEqual([
        // P6.928's `readFence` fires on this leg too — claude routes its
        // `Read`/`Grep`/`Glob` through the same gate Pi does, and codex reads
        // with its own built-ins.
        'preToolCheck', 'preToolDefer', 'readFence', 'worktreeMove', 'subagentReportScan',
        // C3.377 — fires on this leg for the same reason it fires out of Pi:
        // the floor's DEPTH is claude's too, because claude routes its writes
        // through the same segment-window gate, and codex's projection stops at
        // the top of each root.
        'nestedProtectedPaths',
        // C4.49 — fires on this leg for the same reason it fires out of Pi:
        // claude confirms a protected-FILE write through the same gate, on the
        // file-tool path and, since C4.50, on the shell path too, and neither
        // reaches codex.
        'protectedFilesUnprojected',
        // C3.276 — first of the `abilities` rows on this leg, which is where
        // its table position puts it: a project `.claude/commands` file is
        // dispatched by the claude child and by nothing on codex.
        'claudeProjectCommands',
        'planApproval', 'appActions', 'bridgeTools',
        'scheduledRun', 'autoCompactionOff', 'autoCompactionKnobs', // UB12.63 retired `outputStyleTiming`
        'liveToolInput', 'subagentNesting', 'policyKeys', 'projectMcpApproval', 'bashWorkingDir',
        'toolMemoryCap',
        // C3.98 and C3.219 (2026-09-11). Both are claude-held and absent on
        // codex for the same two reasons they are absent on Pi: codex's hooks
        // here are host-run command hooks behind the six-name whitelist, and a
        // codex agent's turn never passes through `gatewaySessionFetch`.
        'securityPluginEnv', 'subagentAgentIdHeader',
        // C3.64 (2026-09-11). Codex has no per-agent deny at all, so there is no
        // Explore/Plan pair here either — its own two roles are `explorer` and
        // `awaiter`, which the mirror row prices on the other legs.
        'claudeBuiltinAgents',
        // C3.285 — the build C3.12 asked for, and the row that is about the
        // rules the USER wrote rather than about the gate: codex's approval
        // projection carries three tool names and two input fields, so a rule
        // naming another subject has nothing to match on that path.
        'ruleSubjects',
        // C3.310, beside its sibling on this leg for the same reason.
        'hostMcpRules',
        'pathScopedInstructions', 'subagentOutputText',
        'backgroundTaskOffSwitch', 'reasoningCarry', 'toolSupportFallback',
        // P6.596. Claude holds both halves of a session tool restriction and
        // codex can express neither — its `enabled_tools`/`disabled_tools` are
        // MCP-server-scoped — so this leg is a plain measured loss.
        'toolRestriction',
        // P6.312. Claude runs a session AS an agent through the SDK's own
        // `Options.agent`; codex layers role config for SPAWNED agents only and
        // the main thread takes `developer_instructions`, so there is nothing to
        // select a role for it. A plain measured loss on this leg too.
        'sessionAgent',
      ])
  })

  /**
   * P6.65 · leaving codex is not free, and this test used to say it was.
   *
   * `credentialShellFloor` is the first capability in this table that a runtime
   * other than Pi holds: codex enforces the credential deny list at the OS layer,
   * where ours is tool-mediated and a shell command walking a folder above a
   * denied entry still reads it.
   *
   * **The docblock said "both legs out of codex carry it AND NOTHING ELSE" for
   * three row additions after it stopped being true** (P6.262's
   * `codexBuiltinAgents`, P6.262's `gatewayFeatureFlags` on the claude leg,
   * P6.364's `subagentModelOrder`, and now P6.225's `codexReviewer`). The
   * assertion below was edited each time and the sentence above it was not, which
   * is this file's own recurring defect. So what is asserted is the WHOLE list on
   * each leg, in table order — that is still the control against a row's `on` map
   * being widened by accident, and it cannot rot into a claim about a count.
   */
  it('leaving Codex costs the OS-enforced credential floor and codex-only capabilities, on both legs', () => {
    expect(idsFor('codex-runtime', 'pi'))
      // C3.290 (2026-09-11): codex loads skills out of an added folder through
      // its own extra skill roots and Pi loads them by neither path, so the row
      // fires on this leg as well as on claude → Pi.
      // C4.42's residue (2026-09-13): a backgrounded `/code-review` runs on a
      // codex THREAD, and Pi backgrounds the same review as a subagent of this
      // session — so there is no runtime-owned thread for the switch to carry.
      .toEqual(['credentialShellFloor', 'codexReviewer', 'codexBuiltinAgents', 'addedFolderSkills',
        'subagentOutputText', 'codexDetachedReview'])
    expect(idsFor('codex-runtime', 'anthropic'))
      // C3.251 — `worktreeMove` LEFT this leg too, and for the opposite reason
      // to the one that put it here. P6.137 made codex's cell `'conditional'`
      // (our worktree three cross on the host-callback bridge) and claude's was
      // `'unmeasured'`, so an unmeasured TARGET fired. Claude's is now a driven
      // `true`, and a `'conditional'` source into a target that HAS the
      // capability is not a cost: we do not warn about gaining something.
      // C3.256 — `autoMemoryDirectoryScope` joins this leg in its table position:
      // codex has one auto-memory store and the setting moves it, claude keeps a
      // second store the setting is deliberately not projected into.
      .toEqual(['credentialShellFloor', 'codexReviewer', 'autoMemoryDirectoryScope',
        // P6.184 — codex's `scheduledRun` cell moved `false` → `'conditional'`
        // (our `PushNotification` now crosses on the host-callback bridge), and
        // claude's is `'unmeasured'`. An unmeasured TARGET fires wherever a
        // definite one would, so leaving codex for claude now carries the line:
        // codex MAY have had the notification, and whether claude delivers one
        // has never been driven.
        'scheduledRun',
        // P6.148 — codex's `webSearch` cell moved `false` → `true` and then its
        // claude arm landed too, so P6.896 RETIRED the row: with all three cells
        // `true` it could never fire again, and this leg — the one it had just
        // joined — is where its absence is most visible.
        'gatewayFeatureFlags', 'codexBuiltinAgents',
        // F1.588 retired `subagentModelOrder`: claude honours the documented order at 2.1.267.
        // C4.42's residue — the same loss on the other leg out of codex, and
        // for the same reason: claude backgrounds a review as a subagent of the
        // session, which is the vendored `sdk-tools.d.ts`'s own default.
        'codexDetachedReview'])
  })

  /**
   * The emptiness of a leg is READ rather than asserted from memory — the
   * module's header used to state which legs were empty in prose, and that
   * sentence outlived two row additions. Today only a same-runtime switch is
   * empty; if a future row changes that, this test names which leg moved.
   */
  it('no cross-runtime leg is empty any more, and a same-runtime one still is', () => {
    const runtimes = ['pi', 'anthropic', 'codex-runtime'] as const
    for (const from of runtimes) {
      for (const to of runtimes) {
        if (from === to) continue
        expect(idsFor(from, to).length, `${from} → ${to}`).toBeGreaterThan(0)
      }
      expect(idsFor(from, from), `${from} → ${from}`).toEqual([])
    }
  })

  it('costs nothing when the runtime does not change', () => {
    expect(idsFor('pi', 'pi')).toEqual([])
    expect(idsFor('anthropic', 'anthropic')).toEqual([])
  })

  // A wrong list here is worse than no list. `nestor-cloud-agent` is neither a
  // switch source nor a target (`ConnectionRow` filters it, the server refuses
  // it), and nothing in the table was measured against it.
  it('says nothing about a runtime it has not measured', () => {
    expect(idsFor('nestor-cloud-agent', 'pi')).toEqual([])
    expect(idsFor('pi', 'nestor-cloud-agent')).toEqual([])
  })
})

/**
 * P2.484 — the fourth claim value, and the ONE inversion it removes.
 *
 * Every other row's codex column was derived from the BRIDGED tool surface, so
 * the ten tools that only exist over `CodexAgent`'s per-session host-callback
 * bridge produced no set difference and no row: a session whose bridge failed
 * lost all ten and the dialog said nothing. That is the module's only
 * under-warning, and these assertions are what stop it coming back.
 */
describe("a capability the target has only CONDITIONALLY", () => {
  it('fires into codex from both runtimes that hold it outright', () => {
    expect(idsFor('pi', 'codex-runtime')).toContain('bridgeTools')
    expect(idsFor('anthropic', 'codex-runtime')).toContain('bridgeTools')
  })

  // The direction that must NOT fire. A conditional SOURCE has no definite
  // capability to lose, and warning about the loss of something that may never
  // have existed is noise rather than safety.
  //
  // P6.65 narrowed the assertion from "the leg is empty" to "this row is not on
  // it": the leg carries `credentialShellFloor` now, and an emptiness assertion
  // would have made THIS row's property indistinguishable from the leg's.
  it('does not fire on the way OUT of codex, to either target', () => {
    expect(idsFor('codex-runtime', 'pi')).not.toContain('bridgeTools')
    expect(idsFor('codex-runtime', 'anthropic')).not.toContain('bridgeTools')
  })

  // The claim is `'conditional'` and not `false`: a `false` here would be a
  // statement that codex does not have these tools, which is untrue of the
  // ordinary bridged session, and it would make the row's copy a lie in the
  // common case rather than a caution in the rare one.
  it("records the codex claim as 'conditional', not as an absence", () => {
    expect(RUNTIME_SWITCH_COST_CLAIMS['bridgeTools']).toEqual({
      pi: true,
      anthropic: true,
      'codex-runtime': 'conditional',
      'nestor-cloud-agent': null,
    })
  })

  // The tri-state's no-claim arm must still fail CLOSED — a `null` must never
  // read as "does not have it" now that the filter has a second firing value.
  it('a conditional value does not make a null claim fire', () => {
    expect(idsFor('pi', 'nestor-cloud-agent')).toEqual([])
    expect(idsFor('nestor-cloud-agent', 'codex-runtime')).toEqual([])
  })

  // The copy says MAY. A flat "no longer" here would be the over-warning P4.6
  // declined, dressed up as the fix for the under-warning.
  it('says the capability MAY be missing, in both locales', () => {
    expect(locale('en')['chat.runtimeSwitch.costBridgeTools']).toContain('may be missing')
    expect(locale('ru')['chat.runtimeSwitch.costBridgeTools']).toContain('могут оказаться недоступны')
  })
})

/**
 * P6.296 — a `PreToolUse` hook that pauses a call stops pausing it on codex.
 *
 * Two runtimes deliver the defer/resume vocabulary and codex has none of it:
 * `grep -rl 'Defer'` over `packages/codex-protocol/generated/v2/` returns zero
 * files against 33 for `Approval` on the same tree. The row is pinned rather
 * than left to the two exact-list assertions above, because those would still
 * pass if the cells were flipped to `pi: false` and the row simply moved legs.
 */
describe('the PreToolUse defer/resume vocabulary', () => {
  it('records codex as the only runtime without it', () => {
    expect(RUNTIME_SWITCH_COST_CLAIMS['preToolDefer']).toEqual({
      pi: true,
      anthropic: true,
      'codex-runtime': false,
      'nestor-cloud-agent': null,
    })
  })

  it('fires on both legs INTO codex and on neither leg out of it', () => {
    expect(idsFor('pi', 'codex-runtime')).toContain('preToolDefer')
    expect(idsFor('anthropic', 'codex-runtime')).toContain('preToolDefer')
    expect(idsFor('codex-runtime', 'pi')).not.toContain('preToolDefer')
    expect(idsFor('codex-runtime', 'anthropic')).not.toContain('preToolDefer')
    // The negative that matters most: pi and claude both have it, so a switch
    // between them costs nothing here.
    expect(idsFor('pi', 'anthropic')).not.toContain('preToolDefer')
    expect(idsFor('anthropic', 'pi')).not.toContain('preToolDefer')
  })

  it('is a measured claim, not an unmeasured one', () => {
    const row = runtimeSwitchCosts('pi', 'codex-runtime').find(c => c.id === 'preToolDefer')
    expect(row?.certainty).toBe('measured')
    expect(row?.consequence).toBe('files')
  })
})

/**
 * C3.64 — the mirror of `codexBuiltinAgents`, and the guard the row demanded.
 *
 * The row's own done-means says a comment does not count: what it bought is the
 * leg OUT OF claude reporting a builtin loss, and nothing in the two exact-list
 * assertions above goes red if the row is re-claimed onto another runtime or
 * dropped. This is written in the `preToolDefer` shape for that reason — the
 * claim pinned cell by cell, then the legs it must and must not fire on.
 */
describe("the claude runtime's own two builtin agents", () => {
  it('claims the pair on the claude column only', () => {
    expect(RUNTIME_SWITCH_COST_CLAIMS['claudeBuiltinAgents']).toEqual({
      pi: false,
      anthropic: true,
      'codex-runtime': false,
      'nestor-cloud-agent': null,
    })
  })

  it('fires on both legs OUT OF claude and on neither leg into it', () => {
    expect(idsFor('anthropic', 'pi')).toContain('claudeBuiltinAgents')
    expect(idsFor('anthropic', 'codex-runtime')).toContain('claudeBuiltinAgents')
    // The negatives: a runtime that never had the pair cannot lose it.
    expect(idsFor('pi', 'anthropic')).not.toContain('claudeBuiltinAgents')
    expect(idsFor('codex-runtime', 'anthropic')).not.toContain('claudeBuiltinAgents')
    expect(idsFor('pi', 'codex-runtime')).not.toContain('claudeBuiltinAgents')
    expect(idsFor('codex-runtime', 'pi')).not.toContain('claudeBuiltinAgents')
  })

  it('is a measured claim about abilities, and it does not restate the codex row', () => {
    const row = runtimeSwitchCosts('anthropic', 'pi').find(cost => cost.id === 'claudeBuiltinAgents')
    expect(row?.certainty).toBe('measured')
    expect(row?.consequence).toBe('abilities')
    // The two rows are mirrors, never duplicates: the codex one prices the other
    // direction, so neither leg may carry both.
    expect(idsFor('anthropic', 'pi')).not.toContain('codexBuiltinAgents')
    expect(idsFor('codex-runtime', 'pi')).not.toContain('claudeBuiltinAgents')
  })
})

/**
 * P6.562 — the FIFTH claim value, and the silence it removes.
 *
 * Before it, a cell nobody had driven had two spellings and both lied: `true`
 * and `false` assert a measurement, and `null` removes the runtime from
 * `isSwitchableRuntime` — which empties EVERY direction it is an endpoint of, so
 * one honest "we do not know" would have made the dialog say a switch costs
 * nothing at all. `toolMemoryCap` (P6.346(a)) is the first cell to use it.
 */
describe("a claim the table has NOT measured", () => {
  it("records the claude claim as 'unmeasured', not as a yes or a no", () => {
    expect(RUNTIME_SWITCH_COST_CLAIMS['toolMemoryCap']).toEqual({
      pi: false,
      anthropic: 'unmeasured',
      'codex-runtime': false,
      'nestor-cloud-agent': null,
    })
  })

  // It fires where a definite claim would, and carries the marker the dialog
  // renders. The certainty is the whole point: a caution the user cannot tell
  // from a measurement is the other half of the defect this row closes.
  it('fires out of claude on both legs, marked unmeasured', () => {
    for (const to of ['pi', 'codex-runtime'] as const) {
      const row = runtimeSwitchCosts('anthropic', to).find(cost => cost.id === 'toolMemoryCap')
      expect(row, `anthropic → ${to}`).toBeDefined()
      expect(row!.certainty).toBe('unmeasured')
    }
    // Every other row on those legs is a measurement, so the marker cannot leak
    // onto the rows that were driven. P6.597 added two more names to the
    // exemption and they are named rather than filtered by value: an exemption
    // written as "skip whatever is unmeasured" would assert nothing at all.
    // P6.382's `subagentOutputText` is the fourth, and it is unmeasured on the
    // OTHER end: its codex TARGET carries no claim, where the three above are
    // unmeasured at their claude source. Same exemption, opposite cause.
    // P6.743's `toolSupportFallback` is the fifth, back to the claude-source
    // cause: which failures move the fallback chain is the closed binary's to
    // decide and the page's trigger sentence names a tool-support refusal in
    // neither of its two lists.
    // C3.251 dropped `worktreeMove` from this exemption: its claude cell is a
    // driven `true` now, so every leg it still fires on is a measurement.
    const UNMEASURED_ROWS = [
      'toolMemoryCap', 'scheduledRun', 'subagentOutputText', 'toolSupportFallback',
    ]
    for (const to of ['pi', 'codex-runtime'] as const) {
      for (const row of runtimeSwitchCosts('anthropic', to)) {
        if (UNMEASURED_ROWS.includes(row.id)) continue
        expect(row.certainty, `${row.id} on anthropic → ${to}`).toBe('measured')
      }
    }
  })

  // THE PROPERTY P6.562 EXISTS FOR: an unmeasured cell must not silence the
  // runtime. A `null` here would make both of these lists empty — which is the
  // reading "this switch costs nothing", the opposite of what the cell says.
  it('does not drop claude from the table the way a null claim would', () => {
    expect(idsFor('pi', 'anthropic'))
      // P6.896 — `webSearch` sat between `scheduledRun` and `gatewayFeatureFlags`
      // and was RETIRED, not moved: P6.148's claude arm made its three cells all
      // `true`, and a row that can never fire is not a row.
      // C3.251 — `worktreeMove` LEFT this leg, and it is the second subtraction
      // this list has recorded. Not a retirement like `webSearch`: the row still
      // fires out of claude and out of Pi into codex. RS-28 drove claude's
      // native `EnterWorktree` against a real repository at the packaged 1.36.0
      // sitting and it succeeded, so the claude cell moved `'unmeasured'` → `true`
      // and a capability that is not lost is not a switch cost.
      // C3.256 — `autoMemoryDirectoryScope` joins in `subagentReportScan`'s
      // table position, and it is the FIRST row ever to reach this leg by being
      // `anthropic: false` with both other runtimes `true`: a claude-only
      // absence, where every earlier addition here was a Pi-held capability.
      .toEqual(['guardianJudge', 'autoDenialBreaker', 'subagentWorktree', 'autoMemoryDirectoryScope',
        'scheduledRun',
        'gatewayFeatureFlags', 'forkSubagent', // F1.588 retired `subagentModelOrder` here
        'subagentMemory', 'toolSupportFallback'])
    expect(idsFor('codex-runtime', 'anthropic'))
      // C3.251 — `worktreeMove` LEFT this leg too, and for the opposite reason
      // to the one that put it here. P6.137 made codex's cell `'conditional'`
      // (our worktree three cross on the host-callback bridge) and claude's was
      // `'unmeasured'`, so an unmeasured TARGET fired. Claude's is now a driven
      // `true`, and a `'conditional'` source into a target that HAS the
      // capability is not a cost: we do not warn about gaining something.
      // C3.256 — `autoMemoryDirectoryScope` joins this leg in its table position:
      // codex has one auto-memory store and the setting moves it, claude keeps a
      // second store the setting is deliberately not projected into.
      .toEqual(['credentialShellFloor', 'codexReviewer', 'autoMemoryDirectoryScope',
        // P6.184 — codex's `scheduledRun` cell moved `false` → `'conditional'`
        // (our `PushNotification` now crosses on the host-callback bridge), and
        // claude's is `'unmeasured'`. An unmeasured TARGET fires wherever a
        // definite one would, so leaving codex for claude now carries the line:
        // codex MAY have had the notification, and whether claude delivers one
        // has never been driven.
        'scheduledRun',
        // P6.148 — codex's `webSearch` cell moved `false` → `true` and then its
        // claude arm landed too, so P6.896 RETIRED the row: with all three cells
        // `true` it could never fire again, and this leg — the one it had just
        // joined — is where its absence is most visible.
        'gatewayFeatureFlags', 'codexBuiltinAgents',
        // F1.588 retired `subagentModelOrder`: claude honours the documented order at 2.1.267.
        // C4.42's residue — the same loss on the other leg out of codex, and
        // for the same reason: claude backgrounds a review as a subagent of the
        // session, which is the vendored `sdk-tools.d.ts`'s own default.
        'codexDetachedReview'])
  })

  /**
   * P6.597 — the leg the user actually meets, and the one nothing asserted.
   *
   * Every certainty assertion above walks a leg whose SOURCE is claude. The two
   * cells this row moved are claude TARGETS on the busiest leg in the table, so
   * before this the marker could have been dropped on Pi → Claude and every
   * suite would still have been green. What a user sees there is a MIXTURE and
   * that is the whole point; the count is deliberately not written here, because
   * a number beside a list is the one thing this file has been wrong about
   * repeatedly — the leg's length is asserted by RUNNING the function above.
   *
   * P6.743's `toolSupportFallback` is the third such target and is asserted
   * beside the other two rather than instead of them.
   */
  it('marks the unmeasured claude targets on Pi → Claude and leaves the rest measured', () => {
    const byId = new Map(runtimeSwitchCosts('pi', 'anthropic').map(cost => [cost.id, cost.certainty]))
    // C3.251 — `worktreeMove` was the third name here and is now ABSENT from the
    // leg entirely, which is a stronger statement than "measured" and the one
    // worth asserting: a cell that stops being unmeasured by becoming `true`
    // removes its row from this direction rather than re-marking it.
    expect(byId.has('worktreeMove')).toBe(false)
    expect(byId.get('scheduledRun')).toBe('unmeasured')
    expect(byId.get('toolSupportFallback')).toBe('unmeasured')
    // The control, and the reason this is not `filter(c => c.certainty === ...)`:
    // the same leg must still carry measurements, or the marker means nothing.
    expect(byId.get('guardianJudge')).toBe('measured')
    expect(byId.get('subagentWorktree')).toBe('measured')
    // `webSearch` was the third control here until P6.896 retired the row;
    // `guardianJudge` and `subagentWorktree` keep the control alive.
    expect(byId.get('gatewayFeatureFlags')).toBe('measured')
  })

  // An unmeasured SOURCE fires; an unmeasured TARGET would too — but only where
  // the source definitely has the capability. Here the source is `false` on both
  // legs into claude, so nothing fires, which is the `'conditional'` rule's own
  // shape and the reason a cap Pi never had is not reported as a loss.
  it('says nothing about a capability the source does not have', () => {
    expect(idsFor('pi', 'anthropic')).not.toContain('toolMemoryCap')
    expect(idsFor('codex-runtime', 'anthropic')).not.toContain('toolMemoryCap')
  })
})

describe('ranking', () => {
  // The dialog renders this list in order and a user skims the top of it, so
  // what happens to their working tree has to sort above what the model can do.
  it('never puts an abilities row above a files row', () => {
    const pairs: [Parameters<typeof runtimeSwitchCosts>[0], Parameters<typeof runtimeSwitchCosts>[1]][] = [
      ['pi', 'anthropic'], ['pi', 'codex-runtime'], ['anthropic', 'codex-runtime'],
      ['anthropic', 'pi'], ['codex-runtime', 'pi'], ['codex-runtime', 'anthropic'],
    ]
    for (const [from, to] of pairs) {
      const ranks = runtimeSwitchCosts(from, to)
        .map(cost => RUNTIME_SWITCH_COST_CONSEQUENCE_ORDER.indexOf(cost.consequence))
      expect(ranks, `${from} → ${to}`).toEqual([...ranks].sort((a, b) => a - b))
      // A rank the order does not know would sort as -1 and pass silently.
      expect(ranks.includes(-1), `${from} → ${to} has an unranked consequence`).toBe(false)
    }
  })
})

describe('the strings the user actually reads', () => {
  const en = locale('en')
  const ru = locale('ru')

  it('resolves every emitted key in both locales', () => {
    // P3.227 added `outputStyleTiming` as the eighth row, P3.234
    // `autoCompactionOff` as the ninth and P3.342 `webSearch` as the tenth.
    // W6-d added four at once (2026-09-06): `credentialShellFloor` (P6.65),
    // `subagentWorktree` (P6.128), `subagentNesting` (P6.124) and `policyKeys`
    // (P6.170).
    // P6.346(a) added `toolMemoryCap` as the fifteenth and P6.157
    // `liveToolInput` as the sixteenth and P6.96 `autoCompactionKnobs` as the
    // seventeenth. P6.201's `autoDenialBreaker` is the eighteenth, and P6.262
    // added `gatewayFeatureFlags` and `codexBuiltinAgents` as the nineteenth and
    // twentieth. P6.391's `pathScopedInstructions` is the twenty-first and
    // P6.506's `forkSubagent` the twenty-second and P6.364's
    // `subagentModelOrder` the twenty-third; P6.309 arm (3) added
    // `subagentMemory` as the twenty-fourth and P6.225 `codexReviewer` as the
    // twenty-fifth; P6.382's `subagentOutputText` is the twenty-sixth and
    // P6.296's `preToolDefer` the twenty-seventh and P6.696's
    // `backgroundTaskOffSwitch` the twenty-eighth.
    // …and P6.340's `projectMcpApproval` the twenty-ninth.
    // …and P6.690's `bashWorkingDir` the thirtieth.
    // …and P6.481's `reasoningCarry` the thirty-second, the second row whose
    // codex cell is `'conditional'` — reasoning crosses on a Responses
    // connection and not on a gateway one, so either boolean would be wrong on
    // half of codex's connections.
    // …and P6.743's `toolSupportFallback` the thirty-third, the FIFTH
    // `'unmeasured'` cell: the claude fallback ladder runs inside the closed
    // binary and `model-config.md`'s trigger sentence names a tool-support
    // refusal in neither of its two lists.
    // …and P6.200's `subagentReportScan` the thirty-first — the ninth `files`
    // row, and it sits in the table's `files` block for the reason the ranking
    // case below asserts: `runtimeSwitchCosts` preserves table order, so a
    // `files` row written among the `abilities` ones renders out of rank.
    // …and P6.596's `toolRestriction` the thirty-fourth, and P6.312's
    // `sessionAgent` the thirty-fifth — the first added BY the arm that created
    // the divergence rather than by a sweep that found one.
    // …and then P6.896 REMOVED one — `webSearch`, P3.342's tenth — which is
    // the only subtraction this list has ever recorded. P6.148 built the host's
    // own `web_search` on both runtimes that lacked one, so the row's three
    // cells all read `true` and it could never fire again; both of its shipped
    // sentences went with it, because an unreachable string is worse than a
    // wrong one — nothing can ever prove it false.
    // …and P6.928's `readFence` the thirty-sixth added, taking the live count
    // back to thirty-five.
    // …and C3.98's `securityPluginEnv` plus C3.219's `subagentAgentIdHeader`
    // (2026-09-11) the thirty-seventh and thirty-eighth added, taking the live
    // count to thirty-seven.
    // …and C3.64's `claudeBuiltinAgents` the thirty-ninth added — the mirror of
    // `codexBuiltinAgents`, so leaving claude reports its own builtin loss the
    // way leaving codex already did — taking the live count to thirty-eight.
    // …and C3.290's `addedFolderSkills` the fortieth added — the switch-report
    // half of C4.24, which the owner's letter required so a capability living on
    // two runtimes of three does not vanish silently on the third — taking the
    // live count to thirty-nine.
    // …and C3.285's `ruleSubjects` the forty-first added — the build C3.12 asked
    // for, which is about the rules the USER wrote rather than about the gate —
    // taking the live count to forty.
    // …and C3.377's `nestedProtectedPaths` the forty-fourth added — the DEPTH
    // of the protected-path floor rather than its existence, which is why it
    // fires into codex even though C3.343 already projected the list there.
    // …and C4.49's `protectedFilesUnprojected` and C4.42's `codexDetachedReview`
    // the forty-fifth and forty-sixth, added in ONE commit — the owner's two
    // decided postures of 2026-09-13, one disclosing that the 37 protected FILES
    // reach no codex session and one disclosing that a backgrounded codex review
    // does not survive the switch that C4.42 made ordinary. They are the first
    // pair this file has gained together, which is why no count here ever spells
    // forty-five.
    // …until F1.588 RETIRED `subagentModelOrder` (the twenty-third), which is how
    // the live count came to spell forty-five after all.
    // …and UB12.63 RETIRED `outputStyleTiming` (the eighth): codex now applies a
    // mid-session style to the next message, so the live count is forty-four.
    expect(RUNTIME_SWITCH_COST_BODY_KEYS.length).toBe(44)
    for (const key of [
      ...RUNTIME_SWITCH_COST_BODY_KEYS,
      'chat.runtimeSwitch.costHeading',
      // P6.562's marker rides beside a sentence rather than replacing one, so it
      // is held to the same two-locale rule as the sentences.
      'chat.runtimeSwitch.costNotMeasured',
    ]) {
      expect(en[key], `en is missing ${key}`).toBeTruthy()
      expect(ru[key], `ru is missing ${key}`).toBeTruthy()
      // A translation that was copied rather than translated is a defect the
      // parity check cannot see.
      expect(ru[key], `ru still holds the English text for ${key}`).not.toBe(en[key])
    }
  })

  // The dialog passes exactly four values. A `{{whatever}}` the dialog does not
  // supply renders as a literal brace pair on screen, which parity and sorting
  // both let through.
  it('interpolates only the values the dialog supplies', () => {
    const supplied = new Set(['from', 'to', 'fromRuntime', 'toRuntime'])
    // P3's three carry lines render through the same `values` record, so they
    // are held to the same rule — an unsupplied `{{name}}` shows as a literal
    // brace pair on screen and both i18n lints let it through.
    //
    // P3.55 · the Codex native line was missing from this list, as was the Pi
    // one that P3.55 then deleted: both were added to the catalogue after this
    // test was written, so a fourth carry line has been shipping unchecked. The
    // merged `carryNative` now interpolates `{{toRuntime}}` TWICE, which is
    // exactly the shape this rule exists to catch.
    for (const key of [
      ...RUNTIME_SWITCH_COST_BODY_KEYS,
      'chat.runtimeSwitch.costHeading',
      'chat.runtimeSwitch.carryNative',
      'chat.runtimeSwitch.carryNativeCodex',
      'chat.runtimeSwitch.carryAnchor',
      'chat.runtimeSwitch.carryText',
      'chat.runtimeSwitch.crossRuntimeBody',
      'chat.runtimeSwitch.crossRuntimeBodyCodex',
    ]) {
      for (const messages of [en, ru]) {
        for (const [, name] of messages[key]!.matchAll(/\{\{(\w+)\}\}/g)) {
          expect(supplied.has(name), `${key} interpolates unknown "${name}"`).toBe(true)
        }
      }
    }
  })
})

describe('the wiring — the path a real user takes', () => {
  // Positive control: an emptied or moved file must not read as a pass.
  it('reads both files on the path', () => {
    expect(dialog).toContain('export function RuntimeSwitchDialog')
    expect(connectionRow).toContain('export function ConnectionRow')
  })

  // ConnectionRow is the only place a session's runtime is picked, and the
  // dialog is what it puts in front of the switch.
  it('routes a cross-runtime pick through the dialog', () => {
    // P3 widened the pending record with the carry plan the server decided
    // before the switch, and P3.266 widened it again with the REASON for that
    // plan; the route it pins is unchanged. Two shapes are pinned because the
    // record is now built in two places — the no-preview arm inline, the
    // previewed arm from the server's answer — and a route that lost either
    // would still satisfy a single-shape assertion.
    expect(connectionRow).toContain('setPending({ kind, from: activeConnection, to: target, historyCarry: null, historyCarryReason: null })')
    expect(connectionRow).toContain('historyCarryReason: preview?.historyCarryReason ?? null,')
    expect(connectionRow).toContain('<RuntimeSwitchDialog')
    expect(connectionRow).toContain('if (target) onSwitch(target)')
  })

  // P3. The carry line is the one thing the dialog could not say before a
  // pre-switch server round trip existed, so the round trip and the line are
  // pinned together: either alone ships a modal that still cannot answer
  // "what happens to my conversation?".
  it('asks the server what will carry, and renders the answer', () => {
    expect(connectionRow).toContain('await onPreviewSwitch(target.slug)')
    expect(dialog).toContain('pending.historyCarry')
    expect(dialog).toContain('t(copy.carryKey, values)')
  })

  // The three lines that make the list appear. Delete any one of them and the
  // table ships as an unreachable library — which is how a fully tested change
  // has already shipped inert on this plan.
  it('computes the direction and renders every row of it', () => {
    expect(dialog).toContain("import { runtimeSwitchCosts } from './runtime-switch-costs'")
    expect(dialog).toContain('runtimeSwitchCosts(fromRuntime, toRuntime)')
    expect(dialog).toContain('costs.map(cost =>')
    expect(dialog).toContain('t(cost.bodyKey, values)')
    expect(dialog).toContain("t('chat.runtimeSwitch.costHeading', values)")
  })

  // P6.562 · the marker is part of the wiring, not of the copy: a row the table
  // has not measured must reach the screen SAYING so, and a dialog that renders
  // the sentence without the marker is exactly the state the row closes.
  it('marks an unmeasured row on screen', () => {
    expect(dialog).toContain("cost.certainty === 'unmeasured'")
    expect(dialog).toContain("t('chat.runtimeSwitch.costNotMeasured')")
  })

  // An empty list must render nothing at all, so a return leg onto Pi does not
  // show an empty heading that reads as "we could not work it out".
  it('renders the block only when the direction costs something', () => {
    expect(dialog).toContain('costs.length > 0 &&')
  })
})
