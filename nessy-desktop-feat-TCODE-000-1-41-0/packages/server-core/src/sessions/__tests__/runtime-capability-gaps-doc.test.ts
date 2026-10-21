/**
 * P2.211 — the per-runtime absence claim in `docs/architecture/runtime-capability-gaps.md`,
 * asserted against the surface that decides it.
 *
 * ## Why this file exists, stated as the defect it removes
 *
 * P2.211 was a documentation-rot cluster: ONE dead claim ("the cron tools are
 * Pi-only") repeated in six places, drifting for weeks because nothing tied any
 * of the six to the value they described. Five of the six were PROSE — a
 * sentence in a comment restating a `visibility` field — and prose is not
 * checkable: a scanner over `pi-only` mentions in this repo's TypeScript flags
 * 23 of 31 sites, and every one of the 23 is a deliberate historical or
 * contrastive sentence ("these four WERE pi-only", "the goal pair LEFT
 * pi-only"). Those five were fixed by deleting the restatement, which is the
 * only repair prose admits.
 *
 * The sixth is different, and that difference is what this file exploits: the
 * Codex row of `runtime-capability-gaps.md` does not merely describe a
 * capability, it ENUMERATES TOOL NAMES. A list of names is a value, and a value
 * can be compared against the enforcement site — which is exactly the property
 * `e0a64da64` (P2.124) established for the eleven per-runtime sites in code.
 * This is that property, reaching one line of documentation.
 *
 * ## What is checked, and what is deliberately not
 *
 * CHECKED: every tool name the row spells in backticks, in both directions —
 * the names before the `**No longer absent:**` sentinel must really be missing
 * from a Codex session's surface, and the names after it must really be there.
 * Both directions matter: the row went stale by keeping four names on the
 * absent side after the bridge carried them across, and a one-directional test
 * would have stayed green through exactly that.
 *
 * UB12.96 — and, since then, the split is checked WHOLE. Checking only the
 * names the row spells could not see an OMISSION: measured on the row as it
 * stood (2026-10-17), 18 of the 34 host-callback tools a shipping codex surface
 * offers were named nowhere in it — the finding's four (`decide`,
 * `project_memory_append`, `source_list_prompts`, `source_get_prompt`) plus
 * fourteen more — and "session labels and status", a prose group and so
 * invisible to the name extractor, stayed on the absent side after UA1.3
 * bridged both tools; its leading count read 21 against 16. The row now spells every member
 * of `SESSION_TOOLS_REQUIRING_HOST_CALLBACK` (the row's own denominator: "they
 * sit in `SESSION_TOOLS_REQUIRING_HOST_CALLBACK` to this day") on exactly one
 * side, so three more things are asserted: the absent half is EXACTLY the
 * members the surface lacks, every member the surface has is named in the
 * crossed half, and the row's leading count is the absent half's size. A new
 * host-callback tool, or a crossing, therefore fails here until the row says
 * which side it is on.
 *
 * NOT CHECKED, and named so no reader assumes otherwise: the surface SIZES the
 * row quotes as dated readings (`scheduling-projection.test.ts` pins five of
 * them), and a session tool OUTSIDE the host-callback set, which the row does
 * not claim either way.
 *
 * The surface is the one a SHIPPING codex session runs with every gate open —
 * external standalone, the per-session host-callback bridge, the three ports
 * `session-mcp-server`'s `createSessionTools` derives from that bridge
 * (notification, worktree, review-diff), the advisor route, and the decision
 * layer's `decidePort` — so "absent" here means absent even with every gate
 * open, which is the strongest form of the row's own claim. Residue: a FUTURE
 * port flag missing from {@link CODEX_EVERY_GATE_OPEN} would make its tool read
 * as absent, and the row would have to name it there to stay green.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  SESSION_TOOLS_REQUIRING_HOST_CALLBACK,
  SESSION_TOOL_DEFS,
  type SessionToolFilterOptions,
  areTaskToolsEnabled,
  getSessionToolNames,
  isCronDisabled,
} from '@nessy-agent/session-tools-core'

const DOC = fileURLToPath(
  new URL('../../../../../docs/architecture/runtime-capability-gaps.md', import.meta.url),
)

/** The sentinel the row is split on. Quoted here so a doc edit that drops it fails loudly. */
const CROSSED_SENTINEL = '**No longer absent:**'

const TOOL_NAMES = new Set(SESSION_TOOL_DEFS.map(def => def.name))

/** Backticked identifiers that are really session tools. `getSessionToolNames` is not. */
const toolNamesIn = (text: string): string[] =>
  [...new Set([...text.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map(m => m[1]!))]
    .filter(name => TOOL_NAMES.has(name))
    .sort()

/**
 * The shipping codex surface with every gate open, written ONCE (it was two
 * copies, and neither carried `reviewDiffPort` or `decidePort`). The first
 * three ports are what `session-mcp-server`'s `createSessionTools` derives from
 * the bridge itself (P6.184, P6.137, C3.360); the advisor rides the host's
 * setting (P3.13) and `decidePort` the spawn's `--decide-port` (UB6.11).
 */
const CODEX_EVERY_GATE_OPEN: SessionToolFilterOptions = {
  externalStandaloneOnly: true,
  hostCallbackBridge: true,
  notificationPort: true,
  worktreePort: true,
  reviewDiffPort: true,
  advisorConsultBridge: true,
  decidePort: true,
}

const halvesOf = (row: string): { absent: string; crossed: string } => {
  const [absent, crossed] = row.split(CROSSED_SENTINEL)
  return { absent: absent!, crossed: crossed ?? '' }
}

/** The absent arm: names the row calls absent that the surface offers. */
const offeredButClaimedAbsent = (row: string, surface: ReadonlySet<string>): string[] =>
  toolNamesIn(halvesOf(row).absent).filter(name => surface.has(name))

/** The completeness arm (UB12.96): host-callback members the surface offers that the crossed half never names. */
const crossedButUnnamed = (row: string, surface: ReadonlySet<string>): string[] => {
  const named = new Set(toolNamesIn(halvesOf(row).crossed))
  return [...SESSION_TOOLS_REQUIRING_HOST_CALLBACK].filter(name => surface.has(name) && !named.has(name)).sort()
}

/** The host-callback members the surface lacks — what the absent half must be, exactly. */
const hostCallbackAbsences = (surface: ReadonlySet<string>): string[] =>
  [...SESSION_TOOLS_REQUIRING_HOST_CALLBACK].filter(name => !surface.has(name)).sort()

/** The row's leading `**N session tools are absent**`, or undefined when the claim lost its count. */
const leadingCountOf = (row: string): number | undefined => {
  const match = /\*\*(\d+) session tools are absent\*\*/.exec(row)
  return match ? Number(match[1]) : undefined
}

/** The four names UB12.96 found crossed and unnamed. */
const UB12_96_CROSSED = ['decide', 'project_memory_append', 'source_get_prompt', 'source_list_prompts'] as const

describe('runtime-capability-gaps.md — the Codex absence row names what is really absent', () => {
  const doc = readFileSync(DOC, 'utf8')
  const row = doc
    .split('\n')
    .find(line => line.startsWith('|') && /session tools are absent/.test(line))

  // The row is found by its CLAIM, not by a line number or a count, so a
  // renumbering or a recount cannot silently disarm this file. If the claim
  // itself is reworded away, that is a real failure and should be seen.
  it('the row is present and split by its sentinel', () => {
    expect(row, `no "session tools are absent" row in ${DOC}`).toBeDefined()
    expect(row!.includes(CROSSED_SENTINEL), `row lost its "${CROSSED_SENTINEL}" sentinel`).toBe(true)
  })

  // A polluted env shifts the surface underneath every assertion below, and the
  // rows would then pass or fail for a reason that has nothing to do with the
  // doc. Fail first, naming the cause.
  it('runs with the default task/cron surface', () => {
    expect(isCronDisabled(), 'NESSY_DISABLE_CRON / CLAUDE_CODE_DISABLE_CRON is set in this test env').toBe(false)
    expect(areTaskToolsEnabled(), 'NESSY_ENABLE_TASKS is off in this test env').toBe(true)
  })

  it('every name on the absent side is really absent from a shipping codex surface', () => {
    // Positive control: the extractor really found names. Without it, a doc
    // rewrite that removed every backtick would pass this test vacuously —
    // the exact blind spot a test double that drops its argument creates.
    expect(toolNamesIn(halvesOf(row!).absent).length, 'no tool names extracted from the absent half').toBeGreaterThan(5)
    expect(offeredButClaimedAbsent(row!, getSessionToolNames(CODEX_EVERY_GATE_OPEN))).toEqual([])
  })

  it('every name on the crossed side is really present there', () => {
    const claimed = toolNamesIn(halvesOf(row!).crossed)
    expect(claimed.length, 'no tool names extracted from the crossed half').toBeGreaterThan(5)
    const codex = getSessionToolNames(CODEX_EVERY_GATE_OPEN)
    expect(claimed.filter(name => !codex.has(name))).toEqual([])
  })

  // UB12.96 — positive: the four names the row omitted are now on its crossed
  // side AND on the surface, which needs `decidePort` (`decide` is port-gated
  // on every runtime, so the pre-UB12.96 surface lacked it).
  it('UB12.96 — the crossed half names the four 1.43.0 crossings, all offered with every gate open', () => {
    const named = new Set(toolNamesIn(halvesOf(row!).crossed))
    const codex = getSessionToolNames(CODEX_EVERY_GATE_OPEN)
    expect(UB12_96_CROSSED.filter(name => !named.has(name) || !codex.has(name))).toEqual([])
  })

  // UB12.96 — negative: a `decide` planted on the absent side fails the absent
  // arm. Against the old surface (no `decidePort`) the plant would have passed,
  // which is the blind spot this arm proves closed.
  it('UB12.96 — a `decide` planted on the absent side fails the absent arm', () => {
    const planted = row!.replace(CROSSED_SENTINEL, '`decide`. ' + CROSSED_SENTINEL)
    expect(offeredButClaimedAbsent(planted, getSessionToolNames(CODEX_EVERY_GATE_OPEN))).toEqual(['decide'])
  })

  // UB12.96 — the omission arm. The two arms above only read names the row
  // already spells; this one reads the SET, so a crossed host-callback tool the
  // row never names fails here.
  it('every host-callback member a shipping codex surface offers is named on the crossed side', () => {
    expect(crossedButUnnamed(row!, getSessionToolNames(CODEX_EVERY_GATE_OPEN))).toEqual([])
  })

  it('the omission arm can fail: unspelling `decide` from the crossed side reports it', () => {
    const unspelled = row!.replaceAll('`decide`', 'decide')
    // The plant really changed the row (positive control on the replacement).
    expect(unspelled).not.toBe(row)
    expect(crossedButUnnamed(unspelled, getSessionToolNames(CODEX_EVERY_GATE_OPEN))).toEqual(['decide'])
  })

  it('the absent half is EXACTLY the host-callback members the surface lacks, and the leading count is its size', () => {
    const expected = hostCallbackAbsences(getSessionToolNames(CODEX_EVERY_GATE_OPEN))
    expect(toolNamesIn(halvesOf(row!).absent)).toEqual(expected)
    expect(leadingCountOf(row!), 'the row\'s leading count').toBe(expected.length)
    // Boundary: the parser reads the count it is shown, so a stale count is a
    // mismatch rather than a parse failure that skips the comparison.
    const stale = row!.replace(/\*\*\d+ session tools are absent\*\*/, `**${expected.length + 1} session tools are absent**`)
    expect(leadingCountOf(stale)).toBe(expected.length + 1)
  })

  // The two halves must be disjoint. A name that drifted into both would make
  // one of the two assertions above vacuous for it, and the row would read as
  // self-contradicting to a human while both tests stayed green.
  it('no name appears on both sides', () => {
    const [absentHalf, crossedHalf] = row!.split(CROSSED_SENTINEL)
    const crossed = new Set(toolNamesIn(crossedHalf!))
    expect(toolNamesIn(absentHalf!).filter(name => crossed.has(name))).toEqual([])
  })
})

/**
 * P2.291 / P2.379 — the same narrow shape, reaching the CLAUDE section.
 *
 * ## Why this is not simply "the Codex block again with a different filter"
 *
 * P2.291 proposed extending the guard to "the Claude and Pi tables". Measured
 * against today's document, one of those two does not exist and the other is
 * not uniform:
 *
 *   - **The Pi section enumerates ZERO session-tool names.** Every claim there
 *     is about a mechanism (the SDK's compaction, the loop, the sandbox), so
 *     there is no list of values to compare against an enforcement site and no
 *     Pi half of this row to write. Asserted below rather than asserted-away,
 *     because "we chose not to" and "there was nothing there" are different
 *     facts and only one of them stays true if the section grows a table.
 *   - **The Claude section has six names across three rows, and one row is
 *     MIXED.** Two rows spell a pair each and every name in them is really
 *     absent. The third spells `PushNotification`, which is absent, beside
 *     `Monitor`, which is PRESENT — it appears there as contrastive prose
 *     ("after T3 moved the scheduling four and `Monitor` onto Claude"), not as
 *     part of the claim. A row-level "every name here is absent" rule fires
 *     falsely on it: P2.211's own measured false-positive shape, reappearing
 *     inside the extension built to avoid it.
 *
 * So the mixed row is REFUSED the generic treatment and pinned by its two facts
 * instead — and the pin asserts the PRESENT name is present, so the refusal
 * cannot rot into a silent omission. That is the difference between a guard
 * that skips a row and a guard that records why it skipped it.
 *
 * ## The surface these are measured against
 *
 * `getSessionToolNames()` with no projection — the call the Claude backend
 * makes. `tool-defs.ts` drops every `visibility: 'pi-only'` row for it
 * (`if (def.visibility === 'pi-only' && options?.projection !== 'pi') return false`),
 * which is the mechanism all six of these claims rest on. Deliberately NOT the
 * Codex block's `externalStandaloneOnly` + bridge call: there is no bridge on
 * this path, and using the stronger filter would make an absence look absent
 * for a reason the document does not claim.
 */
describe('runtime-capability-gaps.md — the Claude rows that name tools name what is really absent', () => {
  const doc = readFileSync(DOC, 'utf8')
  const rowNamed = (claim: string): string => {
    const rows = doc.split('\n').filter(line => line.startsWith('|') && line.includes(claim))
    expect(rows.length, `expected exactly one row containing ${JSON.stringify(claim)} in ${DOC}`).toBe(1)
    return rows[0]!
  }
  const claudeSurface = (): Set<string> => getSessionToolNames()

  const CLEAN_ROWS = [
    'The model cannot move the session into a git worktree',
    'Only the MODEL-initiated MCP resource tools do not reach the model',
  ] as const
  const MIXED_ROW = 'The model cannot raise a desktop notification'

  for (const claim of CLEAN_ROWS) {
    it(`every tool "${claim}" names is absent from the claude surface`, () => {
      const claimed = toolNamesIn(rowNamed(claim))
      // Positive control, and the one this guard's Codex sibling already
      // carries: a doc rewrite that dropped the backticks would otherwise pass
      // this case vacuously. Two is the real count for both rows today.
      expect(claimed.length, `no tool names extracted from "${claim}"`).toBeGreaterThanOrEqual(2)
      const claude = claudeSurface()
      expect(claimed.filter(name => claude.has(name))).toEqual([])
    })
  }

  it(`REFUSES the mixed row "${MIXED_ROW}", and pins both halves of why`, () => {
    const claimed = toolNamesIn(rowNamed(MIXED_ROW))
    expect(claimed).toEqual(['Monitor', 'PushNotification'])
    const claude = claudeSurface()
    // The claim itself.
    expect(claude.has('PushNotification')).toBe(false)
    // The refusal's pin. `Monitor` is in this row as contrast, not as part of
    // the claim, so the generic rule above would fail on it — and if `Monitor`
    // ever went absent here, the sentence that mentions it would be wrong and
    // the row could take the generic treatment after all. Either way somebody
    // should be told, which is what this assertion is for.
    expect(claude.has('Monitor')).toBe(true)
  })

  /**
   * The Pi section names no tool AS AN ABSENCE, which is what makes it
   * un-guardable in the shape this file guards the other two sections.
   *
   * It stopped naming NONE at `b8d8a80a4` (P6.526), which added a row saying
   * cross-machine addressing is missing on all three runtimes and spelled
   * `send_agent_message` in backticks doing it. This case had asserted an empty
   * extraction and went red on a correct sentence — the same shape the
   * `MIXED_ROW` exception above exists for, so it gets the same treatment: the
   * name is allowed BY NAME and the reason it is not an absence claim is pinned
   * beside it, so a real Pi absence table still fails here.
   */
  const PI_SECTION_CONTRAST_NAMES = ['send_agent_message']

  it('the Pi section names no session tool as an absence, so there is no Pi table to guard', () => {
    const section = (start: string, end: string): string =>
      doc.slice(doc.indexOf(start), doc.indexOf(end))
    const pi = section('## Pi — our own harness', '## Claude — the Agent SDK runtime')
    // Positive control on the same extractor and the same document: the Claude
    // section really does yield names, so an empty Pi result is an absence and
    // not a broken slice or a broken regex.
    const claude = section('## Claude — the Agent SDK runtime', '## Codex — the app-server runtime')
    expect(pi.length).toBeGreaterThan(1000)
    expect(toolNamesIn(claude).length).toBeGreaterThanOrEqual(6)
    expect(toolNamesIn(pi).filter(name => !PI_SECTION_CONTRAST_NAMES.includes(name))).toEqual([])
    // The exception's own pin, the `MIXED_ROW` shape: `send_agent_message` is
    // named in the Pi section because the row says the capability around it is
    // missing on ALL THREE — the tool itself is present on Pi, and if it ever
    // were not, this row would be an absence claim after all and somebody should
    // be told.
    expect(getSessionToolNames({ projection: 'pi' }).has('send_agent_message')).toBe(true)
  })
})
