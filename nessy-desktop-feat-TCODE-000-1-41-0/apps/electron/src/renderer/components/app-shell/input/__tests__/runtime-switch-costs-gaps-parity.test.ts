/**
 * P2.342 — the switch-cost table and `runtime-capability-gaps.md` must not
 * disagree about a safety the user loses.
 *
 * ## The drift this pins
 *
 * `runtime-switch-costs.ts` tells a user what a switch costs, at the moment
 * they take it. `docs/architecture/runtime-capability-gaps.md` records, per
 * runtime, what is unavailable and which of four reasons it is — it is where
 * someone checks before deciding a gap is acceptable. The two are written by
 * different hands at different times, and they came apart:
 *
 * - P2.315 added the `guardianJudge` row to the cost table. The gaps document
 *   had **no Guardian row at all**, in either the Claude or the Codex section —
 *   `grep -ac Guardian` → 0 over the whole file, against a positive control on
 *   the same rig (`docs/architecture/guardian-command-judge.md` matches). So one
 *   document told the user they were giving up the safety judge and the other
 *   was silent about it.
 * - `worktreeMove` and `scheduledRun` both fire on Pi → Claude, and neither
 *   subject had a Claude row (they were covered for Codex only, inside the
 *   "22 session tools are absent" row). — A READING WITH A DATE, kept as the
 *   finding it was: since C3.251 (2026-09-12) `worktreeMove` does NOT fire on
 *   Pi → Claude, because RS-28 drove claude's native `EnterWorktree` and its
 *   claude cell became `true`. The Claude row it gained meanwhile is CLOSED in
 *   the document for the same reason.
 * - The gaps document's own prose said *"Five rows are surfaced"* and *"Pi →
 *   Claude lists two rows"*. Measured by RUNNING the table: six and three.
 *
 * ## Why the assertions are shaped this way
 *
 * The counts are read OUT OF THE PROSE and compared against the live function,
 * so the sentence cannot rot while a test stays green — which is exactly what
 * happened for the twelve days between P2.315 and P2.342.
 *
 * {@link SUBJECT_MARKERS} is the reader's index from a cost row to the words
 * that must appear in the target runtime's own section. It is asserted TOTAL
 * over the table's row ids, so a NEW cost row added later fails here until
 * someone writes its gaps row — the P2.124 totality shape, applied across two
 * documents instead of across a runtime vocabulary. It is deliberately not
 * derived: a marker derived from the row would match itself and prove nothing.
 *
 * P2.485 — that sentence said "a SEVENTH cost row", the next ordinal when it was
 * written; the table holds nine today, so the ordinal named a row that had
 * already been added twice over. The mechanism was always the point and the
 * number never was, so the number is gone — the same treatment the sibling drift
 * test's header records for exactly this failure.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SESSION_TOOL_DEFS } from '@nessy-agent/session-tools-core'
import { RUNTIME_SWITCH_COST_CLAIMS, runtimeSwitchCosts } from '../runtime-switch-costs'

const repoFile = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../../../../../${relative}`, import.meta.url)), 'utf8')

const GAPS_DOC = fileURLToPath(
  new URL('../../../../../../../../docs/architecture/runtime-capability-gaps.md', import.meta.url),
)
const doc = readFileSync(GAPS_DOC, 'utf8')
const costsModule = readFileSync(fileURLToPath(new URL('../runtime-switch-costs.ts', import.meta.url)), 'utf8')
const toolDefs = repoFile('packages/session-tools-core/src/tool-defs.ts')
// P6.847 — the second DOCUMENT that quoted the refuted worktree-floor sentence
// and attributed it to `tool-defs.ts`. The gaps doc is already read as `doc`
// above; the ledger had no reader here at all.
const ledger = repoFile('docs/superpowers/specs/2026-08-28-capability-ledger.md')
const enLocale: Record<string, string> = JSON.parse(repoFile('packages/shared/src/i18n/locales/en.json'))

/**
 * The gaps document's per-runtime section, sliced on its own headings.
 *
 * P6.65/P6.170 added `'pi'`. It was never needed while every cost row was a
 * capability Pi HELD — the target of a firing row was always claude or codex, so
 * the Pi section was never a marker's home. Two rows now fire TOWARDS Pi, and a
 * two-value helper would have forced their markers into the wrong runtime's
 * section to satisfy a totality rule, which is the failure mode P2.379 measured
 * on this same guard family.
 */
const SECTION_HEADINGS: Readonly<Record<'pi' | 'claude' | 'codex', readonly [string, string]>> = Object.freeze({
  pi: ['## Pi — our own harness', '## Claude — the Agent SDK runtime'],
  claude: ['## Claude — the Agent SDK runtime', '## Codex — the app-server runtime'],
  codex: ['## Codex — the app-server runtime', '## What R11 surfaced'],
})

/** The runtime a cost row's marker must be documented under: the switch TARGET. */
const SECTION_OF: Readonly<Record<string, 'pi' | 'claude' | 'codex'>> = Object.freeze({
  pi: 'pi', anthropic: 'claude', 'codex-runtime': 'codex',
})

function section(runtime: 'pi' | 'claude' | 'codex'): string {
  const [startMarker, endMarker] = SECTION_HEADINGS[runtime]
  const start = doc.indexOf(startMarker)
  const end = doc.indexOf(endMarker, start + 1)
  expect(start, `no ${runtime} section heading`).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return doc.slice(start, end)
}

/**
 * Words the target runtime's section must carry for each cost row.
 *
 * Hand-written on purpose — see the header. One entry per row id; the totality
 * assertion below is what keeps it complete.
 */
const SUBJECT_MARKERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // C3.98. The subject is the OFF SWITCH, so the marker is the one name that
  // belongs to no other row and to no other page — the plugin-wide switch from
  // `security-guidance.md#disable-or-uninstall`'s table. A marker naming the
  // plugin alone would match any future row about it.
  securityPluginEnv: ['SECURITY_GUIDANCE_DISABLE'],
  // C3.219. The subject is the HEADER an operator reads, not the subagent: both
  // sections already carry several subagent rows, and a marker naming one would
  // match the wrong one.
  subagentAgentIdHeader: ['x-nessy-agent-id'],
  preToolCheck: ['runPreToolUseChecks'],
  // P6.296. The subject is the third ANSWER a hook can give, not the gate: the
  // row above already owns `runPreToolUseChecks`, and both rows live in the
  // codex section, so a marker naming the gate would match the wrong one.
  preToolDefer: ['cannot pause a call and resume it later'],
  // P6.157. The subject is what the user STOPS SEEING, and the codex row states
  // it in those words; the marker is deliberately not `tool_start` or
  // `input_json_delta`, which are mechanism names that appear in neither
  // document's prose.
  liveToolInput: ['arguments are NOT DELIVERED live'],
  // P6.96. The subject is the two KNOBS, not compaction — `autoCompactionOff`
  // already owns the off-switch and both rows live in the same section, so a
  // marker naming compaction alone would match the wrong row and prove
  // nothing.
  autoCompactionKnobs: ['auto-compaction window and threshold knobs'],
  guardianJudge: ['Guardian'],
  // P6.201. The subject is the EFFECT, not the counter: codex counts on the same
  // imported thresholds and only reports, so a marker on a threshold name would
  // read as present in a section whose row says the opposite.
  autoDenialBreaker: ['A run of denials never changes the mode'],
  // P6.262 (D5). The subject is the CONNECTION, not the variable: the env name
  // appears in the rank-2 policy-switch table further down, outside every
  // per-runtime section, so a marker on it would match a paragraph that is
  // about something else.
  gatewayFeatureFlags: ["A gateway connection is kept off the vendor's network"],
  // P6.262 (D6). The subject is the two ROLES, and their names are spelled the
  // same in the Pi and Claude sections because the row fires into both.
  codexBuiltinAgents: ['explorer and awaiter, do not exist here'],
  // C3.64 (D6). The mirror of the row above and marked the same way, for the
  // same reason: the subject is the two ROLES, and their names are spelled
  // identically in the Pi and Codex sections because the row fires into both.
  claudeBuiltinAgents: ['Explore and Plan, do not exist here'],
  // C3.290 (L4/L39). The subject is the FOLDER, not the skill: both sections
  // already carry several skill rows, and a marker naming skills alone would
  // match one of those. Pi is the only section this row fires into.
  addedFolderSkills: ['an added folder loads no skills here'],
  // C3.285 (A51/A52). The subject is the RULE SUBJECT, and the marker is the
  // sentence the codex row states it in: the section already carries several
  // permission rows, and a marker naming rules alone would match one of those.
  ruleSubjects: ['only a shell command or a file path can be judged here'],
  // C3.310 (A51/A52, born from C3.298; split by F1.368). The two MATCHER KINDS,
  // and the marker is the codex row's own opening claim rather than `Host(` or
  // `mcp(` — both spellings appear in the sibling `ruleSubjects` row, which is
  // the row this one exists to correct, so an identifier marker would be
  // satisfied by the sentence that was WRONG.
  hostMcpRules: ["A rule about a network host binds none of codex's own approvals"],
  // C3.256 (W17-m's measurement, this lane's surface). The subject is the
  // SECOND STORE, and the marker is the claude row's own opening claim rather
  // than `autoMemoryDirectory` — that identifier appears in the Pi section's
  // settings rows too, and this row fires into claude only.
  autoMemoryDirectoryScope: ["The auto-memory FOLDER setting does not cover the child's own auto memory"],
  // C3.276 (L67). The row fires into BOTH Pi and codex, so ONE phrase lives in
  // two sections — the `codexBuiltinAgents` shape. The subject is the FOLDER
  // and the marker is the row's own claim rather than `custom-commands.ts` or
  // `COMMAND_DIRS`: the loader is the host's and is the same on all three, so
  // naming it would prove nothing about either target.
  claudeProjectCommands: ['`.claude/commands` file is not a command here'],
  // P6.225. The subject is the REVIEWER, not `auto_review` or
  // `codexAutoReviewEnabled` — both spellings appear in the Codex section, which
  // is the one section this row never fires into, so an identifier marker would
  // be satisfied by the source runtime's own row and prove nothing about the two
  // targets. Spelled the same in the Pi and Claude sections for the reason
  // `codexBuiltinAgents` above is: one row, two targets, one phrase.
  codexReviewer: ["Codex's own approval reviewer has no counterpart here"],
  // P6.382. The subject is the OUTPUT, and the phrase is deliberately spelled
  // without its leading article so ONE marker serves a Pi row that states the
  // defect and a Codex row that states an UNMEASURED claim — the two sections
  // cannot honestly carry the same sentence, only the same subject.
  // P6.200. The subject is the SCAN, and the marker is the identifier the Pi
  // side runs rather than the word 'subagent', which the codex section spends
  // on four other rows.
  subagentReportScan: ['scanSubagentOutput'],
  // P6.481. The marker is the wire shape the codex section states, not the
  // word 'reasoning', which that section spends on three other rows.
  reasoningCarry: ['thread/inject_items'],
  // P6.743. The row fires into BOTH claude and codex, so ONE phrase has to live
  // in two sections whose rows say different things — the shape
  // `codexBuiltinAgents` already has. The marker is the SUBJECT, deliberately
  // not `model_no_tool_support` or `FALLBACK_MODEL_RETRY_ERROR_CODES`: both are
  // Pi's own identifiers and neither belongs in the section of a runtime the row
  // fires INTO.
  toolSupportFallback: ['tool-support refusal'],
  subagentOutputText: ["subagent's own output"],
  // P6.391. The subject is the DELIVERY, so the marker is the row's own claim
  // rather than `deliversPathScopedActivations` — that identifier appears in no
  // other section and would prove only that this row exists, not that the loss
  // is documented where a reader looks for it.
  pathScopedInstructions: ['A subdirectory `CLAUDE.md` never reaches the model on demand'],
  // P6.696. The subject is the SWITCH having nothing to act on, not background
  // work: codex HAS background terminals and the section says so in the same
  // row, so a marker on `backgroundTerminals` would read as present in a
  // paragraph that grants the capability rather than in the one that prices it.
  backgroundTaskOffSwitch: ['background-task off switch has nothing to switch off here'],
  // P6.506. The subject is the DEFAULT, not the mechanism: `/subtask` starts a
  // fork by hand on a runtime that has one whatever the mode, so a marker on
  // "fork" alone would match a row that says the opposite of this one.
  forkSubagent: ['Subagents do not inherit the conversation by default'],
  // P6.364's `subagentModelOrder` was RETIRED by F1.588 (2026-09-24): claude
  // honours the documented order at 2.1.267, so the row could never fire again
  // and its gaps row now carries `[switch: none — …]` instead of a marker here.
  // P6.309 arm (3). The subject is the STORE, so the marker is the row's claim
  // and not `memory` — that word appears in both sections for other reasons
  // (codex's `MemoriesToml`, claude's SDK field) and would match either.
  subagentMemory: ["A subagent's own memory does not travel"],
  worktreeMove: ['worktree'],
  planApproval: ['SubmitPlan'],
  appActions: ['session tools are absent'],
  // P2.484. The subject is the BRIDGE, not any one tool: the row fires because
  // the nine names it covers exist on codex only when the per-session
  // host-callback bridge started, and the gaps document is where an operator
  // reads that the condition is real rather than theoretical.
  bridgeTools: ['host-callback bridge'],
  scheduledRun: ['PushNotification'],
  // P6.65. The subject is the ENFORCEMENT LAYER, not the file list: the same 19
  // `deniedPaths` entries are enforced on all three, and what a switch away from
  // codex loses is that the OS does it. Both target sections carry the phrase.
  credentialShellFloor: ['OS-enforced credential exclusion'],
  // P6.128. The subject is the HOST's decision before a subagent runs, which is
  // why the marker is not `worktree` — that word appears in both sections for
  // `worktreeMove`, the model's own mid-session move, and would match the wrong
  // row in each.
  subagentWorktree: ["subagent's worktree isolation"],
  // P6.124. The subject is the UNSET default, so the marker is the row's claim
  // rather than a knob name: both knob names appear in the Claude section too.
  subagentNesting: ['unset-case subagent ceilings differ'],
  // P6.170. The subject is the COUNT, and it is the one marker deliberately
  // spelled the same in two sections that are not both a target's — the Pi
  // section states the asymmetry and the Codex section states that it lands
  // there too.
  policyKeys: ['32 documented Claude policy and security switches'],
  // P3.227's `outputStyleTiming` was RETIRED by UB12.63 (2026-10-17): codex now
  // applies a mid-session style to the next message, all three cells are `true`
  // and the row could never fire again, so its gaps row carries
  // `[switch: none — …]` instead of a marker here (F1.588's shape).
  // P3.234 + P3.286. The subject is the ABSENCE of a switch, so the marker is
  // the row's own claim rather than an identifier — the two config keys it is
  // about are both named in the Claude section too, and a key name would match
  // the wrong runtime's row.
  autoCompactionOff: ['Auto-compaction cannot be turned off'],
  // P6.346(a). The subject is the OPERATOR'S CAP, not the variable name: the
  // name is spelled in the retracted-exclusion note further down the document,
  // outside every per-runtime section, so a marker on the name would match a
  // paragraph that is about not surfacing it. Both target sections carry the
  // phrase and neither other row uses it.
  toolMemoryCap: ["operator's tool memory cap"],
  // P6.340. The subject is the THREE KEYS, and the marker names them as a class
  // rather than by spelling: the key names themselves appear in the tier-2
  // policy table further down, outside every per-runtime section, so a marker on
  // one of them would match a paragraph that is about something else. Both
  // target sections carry the phrase verbatim and no other row uses it.
  projectMcpApproval: ["three documented keys that approve a project's own MCP servers"],
  // P6.690. The subject is what STOPS HAPPENING between two calls, not the flag:
  // `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` is spelled in the tier-2 policy
  // table further down, outside every per-runtime section, so a marker on the
  // variable would match a paragraph that is about something else.
  bashWorkingDir: ['a `cd` inside one Bash call does not carry over to the next'],
  // P6.596 / P6.852. The subject is the SETTING, and the phrase is spelled the
  // same in the Pi and Codex sections because the row is about one setting whose
  // two halves land differently on each — the Pi row says half of it is ignored,
  // the Codex row says neither half can be expressed. Deliberately not
  // `allowedTools` or `enabled_tools`: the first is a claude SDK option named in
  // no per-runtime section, the second is codex's MCP-server key and would read
  // as present in a paragraph that is about something else.
  toolRestriction: ['session-level tool restriction'],
  // P6.312. The subject is running AS an agent rather than delegating to one,
  // and the target section says it in those words. A marker on `sessionAgent`
  // or on `Options.agent` would name the host key and the SDK member, neither of
  // which a section that LACKS the capability has any reason to spell.
  // P6.1018: there were TWO such sections and there is one — Pi's row is retired
  // (P6.940 clause 2 closed that gap host-side), so codex is the only target
  // this row fires into and the only section that must carry the phrase.
  sessionAgent: ['run AS one of its agents'],
  // P6.928. The subject is the FENCE, and the marker is the Codex row's own
  // claim rather than the setting's name: `blockReadsOutsideWorkingDirectories`
  // is spelled in the tier-2 policy table further down, outside every
  // per-runtime section, so a marker on the key would match a paragraph that is
  // about something else entirely. Codex is the only section this row fires
  // into, and no other row in it uses the word `fenced`.
  readFence: ['Reads outside the working directories are not fenced here'],
  // C3.377. The subject is the DEPTH, and the marker is the codex row's own
  // claim rather than `.git` or `PROTECTED_DIRECTORIES` — the first is spelled
  // in three other rows of that section and the second is the host's own list
  // name, which the section quotes while GRANTING the top-level protection. A
  // marker on either would be satisfied by the paragraph that says the opposite
  // of this row.
  nestedProtectedPaths: ['protected directory below the workspace root is writable here'],
  // C4.49. The subject is the FILE list, and the marker must not be satisfiable
  // by the sibling row two lines above: the codex section already carries
  // `nestedProtectedPaths`, whose claim is about a protected DIRECTORY below the
  // root, and a marker naming `.npmrc` alone would sit inside either paragraph
  // once one of them quotes the list. The phrase names the class and the
  // confirmation, which is what this row is about and the sibling is not.
  protectedFilesUnprojected: ['protected FILE is written here without a card'],
  // C4.42's residue. The marker is the THREAD, not the review — every runtime
  // reviews, and the Pi and Claude sections both carry review rows already, so a
  // marker naming `/code-review` would be satisfied by a paragraph about the
  // rubric. Spelled the same in both sections for the reason `codexReviewer`
  // above is: one row, two targets, one phrase.
  codexDetachedReview: ['no review thread of its own to inherit'],
})

describe('P2.342 — switch costs and the capability-gaps document agree', () => {
  it('the marker index is TOTAL over the cost table (a new row fails here until it is documented)', () => {
    expect(Object.keys(SUBJECT_MARKERS).sort()).toEqual(Object.keys(RUNTIME_SWITCH_COST_CLAIMS).sort())
  })

  it('every cost that fires into Claude is named in the Claude section', () => {
    const claude = section('claude')
    const fired = runtimeSwitchCosts('pi', 'anthropic').map(row => row.id)
    // Positive control: a switch that costs nothing would make the loop vacuous.
    expect(fired.length).toBeGreaterThan(0)
    for (const id of fired) {
      for (const marker of SUBJECT_MARKERS[id]!) expect(claude).toContain(marker)
    }
  })

  it('every cost that fires into Codex is named in the Codex section', () => {
    const codex = section('codex')
    // Pi → Codex is still the WIDEST leg, and it is no longer the WHOLE table.
    //
    // P6.170 · this line read `toHaveLength(Object.keys(RUNTIME_SWITCH_COST_CLAIMS).length)`
    // — "Pi → Codex fires every row" — which was true only while every row was a
    // capability Pi held. `credentialShellFloor` (codex's) and `policyKeys`
    // (claude's) are `pi: false`, so they cannot fire on a leg that LEAVES Pi.
    // The property the assertion was reaching for is totality of the marker
    // index, and that is asserted directly above; what is asserted here is that
    // this leg is the widest one, which is what makes it worth walking.
    // P6.148 · Pi → Codex STOPPED being the widest leg, and the assertion is
    // re-cut rather than re-pinned. `webSearch` LEFT that leg — the host now
    // registers its own `web_search` on every codex session — while Claude →
    // Codex kept every row it had, so the two legs swapped places and a
    // widest-leg proxy would have started walking the narrower one. What the
    // section actually owes is the UNION of everything that fires INTO codex,
    // which is what this walks now: strictly stronger than the proxy, and it
    // cannot go stale when the legs move again.
    const fired = [...new Set([
      ...runtimeSwitchCosts('pi', 'codex-runtime').map(row => row.id),
      ...runtimeSwitchCosts('anthropic', 'codex-runtime').map(row => row.id),
    ])]
    // Positive control: an empty union would make the loop below vacuous.
    expect(fired.length).toBeGreaterThan(0)
    expect(fired.length).toBeLessThan(Object.keys(RUNTIME_SWITCH_COST_CLAIMS).length)
    for (const id of fired) {
      for (const marker of SUBJECT_MARKERS[id]!) expect(codex).toContain(marker)
    }
  })

  it('the counts the document states match the counts the table computes', () => {
    // Read out of the prose, so the sentence and the function are one claim.
    const stated = doc.match(/\*\*FORTY-FOUR rows are surfaced, and Pi → Claude lists nine\*\*/)
    expect(stated).not.toBeNull()
    expect(Object.keys(RUNTIME_SWITCH_COST_CLAIMS)).toHaveLength(44) // UB12.63 retired `outputStyleTiming`
    expect(doc).not.toMatch(/(?<![A-Z-])FORTY-(?:SIX|FIVE) rows are surfaced/) // F1.588's and UB12.63's spent counts
    // P6.743's `toolSupportFallback` is the first addition since P6.201 to move
    // the Pi → Claude leg, and it moves BOTH: its claude cell is `'unmeasured'`,
    // which fires as a target (we cannot tell the user they keep it) and as a
    // source into codex, which lacks it outright.
    // P6.896 then took it back to ten by RETIRING `webSearch` — the first
    // subtraction this paragraph has ever recorded, and it is a closure rather
    // than a correction: P6.148's claude arm made all three cells `true`, and a
    // row that can never fire is not a row.
    // C3.251 took this from ten to nine WITHOUT retiring a row, which is the
    // second way this number has ever gone down and a different one from
    // P6.896's retirement: `worktreeMove` still fires, just not INTO claude.
    // RS-28 drove claude's native `EnterWorktree` against a real repository at
    // the packaged 1.36.0 sitting and it succeeded, so the claude cell moved
    // `'unmeasured'` → `true` and the row stopped being a loss on this leg.
    // C3.256 took it back to ten, and it is the first row EVER to join this leg
    // by being `anthropic: false` with both others `true` — a claude-only
    // absence, where every earlier addition was a Pi-held capability.
    expect(runtimeSwitchCosts('pi', 'anthropic')).toHaveLength(9) // F1.588 retired `subagentModelOrder` (P6.896's shape)
    // P2.484 added the seventh, P3.227 the eighth and P3.234 the ninth; all
    // three fire only into codex, so the Claude leg was unchanged and the Codex
    // one moved three times. P3.342's `webSearch` is the tenth and the FIRST to
    // move the Claude leg since P2.315 — its Claude claim is `'conditional'`,
    // which fires as a TARGET and stays silent as a SOURCE, so Claude → Codex is
    // deliberately still six. Every number read out of the prose rather than
    // restated here.
    // P6.597 took this from nine to eleven without adding a row: two claude
    // cells moved from `false` to `'unmeasured'`, and an unmeasured SOURCE
    // fires into a target that lacks the capability outright.
    // P6.382 took this from fourteen to fifteen without a new claude claim: the
    // row's codex cell is `'unmeasured'`, and a measured `true` SOURCE fires into
    // an unmeasured target under a marker rather than being dropped.
    // P6.296 took it from fifteen to sixteen: `preToolDefer` is `true` on both
    // pi and claude and `false` on codex, so it fires on BOTH forward legs and
    // moves the Claude → Codex count while leaving Pi → Claude at ten.
    // P6.596 took Claude → Codex from twenty-two to twenty-three and left BOTH Pi
    // legs alone: the row's Pi cell is `'conditional'`, which fires as a target
    // and never as a source, so Pi → Claude stays at eleven and Pi → Codex is
    // deliberately silent (the row's docblock states that under-warn).
    // P6.312 took Claude → Codex from twenty-three to twenty-four and Claude → Pi
    // from six to seven, leaving both Pi legs alone: the row is `anthropic: true`
    // with `pi: false` and `codex-runtime: false`, so it fires only LEAVING
    // claude. Pi and codex never had a main-session-agent path, and this dialog
    // reports what a switch takes away, not what it grants.
    // P6.928 took Claude → Codex from twenty-four to twenty-five and Pi → Codex
    // from twenty-two to twenty-three, leaving both legs ONTO Pi alone: the row
    // is `true` on pi and claude and `false` on codex, so it fires on both
    // forward legs and never backwards.
    // C3.98 and C3.219 are both claude-held and absent on the other two, so they
    // moved BOTH legs out of claude by one each and neither leg into it.
    // C3.310 took Claude → Codex from twenty-nine to thirty and Pi → Codex with
    // it, leaving both legs ONTO claude and onto Pi alone: `hostMcpRules` is
    // `true` on pi and claude and `false` on codex, so it fires on both forward
    // legs and never backwards. The bounded match is deliberate — `thirty`
    // without it would be satisfied by `thirty-one` (AGENTS.md §Traps).
    // C3.276 took Claude → Codex to thirty-one and Claude → Pi with it, leaving
    // both Pi legs alone: `claudeProjectCommands` is `anthropic: true` with both
    // others `false`, so it fires only LEAVING claude.
    // C3.377 took Claude → Codex from thirty-one to thirty-two and Pi → Codex
    // with it, leaving both legs ONTO claude and onto Pi alone: the row is
    // `true` on pi and claude and `false` on codex, the `ruleSubjects` shape.
    // C4.49's `protectedFilesUnprojected` took Claude → Codex from thirty-two to
    // thirty-three and Pi → Codex with it (the `ruleSubjects` shape); C4.42's
    // `codexDetachedReview`, in the same commit, fires only LEAVING codex, so the
    // row total jumped by TWO while this leg moved by one. UB12.63 took it back
    // to thirty-two by RETIRING `outputStyleTiming` (`true` on pi and claude,
    // `false` on codex until the mid-session notice), and Pi → Codex with it,
    // leaving both legs ONTO claude and onto Pi alone.
    expect(doc).toMatch(/Claude → Codex lists thirty-two(?![a-z])/)
    expect(runtimeSwitchCosts('anthropic', 'codex-runtime')).toHaveLength(32)
    // Every stale sentence this paragraph has carried, kept as a set so a
    // revert to any of them fails rather than only the most recent one.
    //
    // ## P6.736 — every guard below is BOUNDED, and the sweep is the point
    //
    // Three times this block guarded a spent count with a bare substring that
    // its own successor contained, and each time the guard failed on the
    // CORRECT sentence: `four`/`fourteen`, `SIX`/`TWENTY-SIX`,
    // `eight`/`EIGHTEEN`. Each was converted individually, at the moment it
    // fired, and the paragraph below still ended with a prediction that the
    // remaining bare ones were safe — which was true only for the spellings
    // reachable that day. The whole set is bounded now, in one pass:
    // a `lists <word>` guard stops at the word with `(?![a-z])`, and a
    // `<WORD> rows are surfaced` guard refuses a compound prefix with
    // `(?<![A-Z-])`.
    //
    // Most of the converted ones were not in danger TODAY, and that is said
    // rather than dressed up: `five` is no prefix of `fifteen`, `nine.` carries
    // a period `nineteen` cannot supply, and no compound spells its teens as
    // `TWENTY-ELEVEN`. The reason to convert them anyway is that whether a bare
    // guard is safe depends on a spelling nobody checks when they bump a count,
    // so "safe today" is exactly the property this block has now been wrong
    // about three times. A bounded guard needs no such reasoning.
    expect(doc).not.toMatch(/(?<![A-Za-z-])Five rows are surfaced/)
    // NOT `toContain('SIX rows are surfaced')` any more, and the same for its
    // four neighbours. The live sentence is TWENTY-SIX, which CONTAINS "SIX rows
    // are surfaced", so the guard for the spent SIX failed on the correct
    // sentence. **This is the second time this block has done it** — the
    // `four`/`fourteen` pair below is the first — and unlike that one it will
    // recur on schedule: every count from here on is a `TWENTY-`/`THIRTY-`
    // compound, so `SEVEN`, `EIGHT` and `NINE` are one row addition each away
    // from the same failure. All five are converted now rather than one at a
    // time, because a guard that fails on the CORRECT sentence teaches the next
    // reader to delete guards.
    //
    // (`ELEVEN` … `EIGHTEEN` below used to stay substrings on the reasoning
    // that no compound spells its teens as `TWENTY-ELEVEN`. That reasoning is
    // still true and no longer load-bearing — P6.736 bounded them anyway.)
    expect(doc).not.toMatch(/(?<![A-Z-])SIX rows are surfaced/)
    expect(doc).not.toMatch(/(?<![A-Z-])SEVEN rows are surfaced/)
    expect(doc).not.toMatch(/(?<![A-Z-])EIGHT rows are surfaced/)
    expect(doc).not.toMatch(/(?<![A-Z-])NINE rows are surfaced/)
    expect(doc).not.toMatch(/(?<![A-Z-])TEN rows are surfaced/)
    // NOT `toContain('… lists four')`: the live count is now FOURTEEN and the
    // substring guard for the spent "four" matched its own successor, failing on
    // the correct sentence. A stale-count guard has to stop at the word.
    expect(doc).not.toMatch(/Claude → Codex lists four(?!teen)/)
    expect(doc).not.toMatch(/Claude → Codex lists five(?![a-z])/)
    // NOT `toContain('… lists six')`: the live count is SIXTEEN, which contains
    // it — the third time this block has guarded a spent count with a prefix of
    // its own successor (`four`/`fourteen`, `SIX`/`TWENTY-SIX`). Stop at the word.
    expect(doc).not.toMatch(/Claude → Codex lists six(?!teen)/)
    expect(doc).not.toMatch(/Claude → Codex lists fifteen(?![a-z])/)
    // P6.696 took it from sixteen to seventeen: `backgroundTaskOffSwitch` is
    // `true` on pi and claude and `false` on codex, so it fires on both forward
    // legs into codex and leaves Pi → Claude at ten.
    expect(doc).not.toMatch(/Claude → Codex lists sixteen(?![a-z])/)
    // NOT `toContain('… lists eight')`: the live count is EIGHTEEN, which
    // contains it, so the guard for the spent "eight" failed on the correct
    // sentence — the THIRD time this block has done that (`four`/`fourteen` and
    // `SIX rows are surfaced` are the other two), and the file's own comment
    // predicted it. Stopped at the word, like its two predecessors.
    expect(doc).not.toMatch(/Claude → Codex lists eight(?!een)/)
    expect(doc).not.toMatch(/Claude → Codex lists nine(?![a-z])/)
    expect(doc).not.toMatch(/Claude → Codex lists eleven(?![a-z])/)
    expect(doc).not.toMatch(/Claude → Codex lists twelve(?![a-z])/)
    expect(doc).not.toMatch(/Claude → Codex lists thirteen(?![a-z])/)
    expect(doc).not.toMatch(/(?<![A-Z-])ELEVEN rows are surfaced/)
    expect(doc).not.toMatch(/(?<![A-Z-])FIFTEEN rows are surfaced/)
    expect(doc).not.toMatch(/(?<![A-Z-])SIXTEEN rows are surfaced/)
    expect(doc).not.toMatch(/(?<![A-Z-])FOURTEEN rows are surfaced/)
    expect(doc).not.toMatch(/(?<![A-Z-])SEVENTEEN rows are surfaced/)
    expect(doc).not.toMatch(/(?<![A-Z-])EIGHTEEN rows are surfaced/)
    // P6.225. Spelled with the hyphen the sentence itself carries: a guard on
    // the bare 'FOUR rows are surfaced' would match nothing today AND nothing
    // after the next twenty-something, which is a guard that only looks like one.
    expect(doc).not.toMatch(/(?<![A-Z-])TWENTY-FOUR rows are surfaced/)
    expect(doc).not.toMatch(/(?<![A-Z-])TWENTY-FIVE rows are surfaced/)
    expect(doc).not.toMatch(/(?<![A-Z-])TWENTY-SIX rows are surfaced/)
    expect(doc).not.toMatch(/(?<![A-Z-])TWENTY-SEVEN rows are surfaced/)
    expect(doc).not.toMatch(/Claude → Codex lists fourteen(?![a-z])/)
    // The sentence W6-d spent, kept as an absence for the same reason as the
    // stale counts above: it was true for three waves and is now false in two
    // directions at once.
    // P6.200 spent both counts at once: a row that is `true` on Pi AND claude
    // and `false` on codex moves the Claude → Codex leg and the row total, and
    // leaves Pi → Claude alone. Both spent sentences are guarded BOUNDED from
    // birth (P6.736), so neither can fail on its own successor.
    expect(doc).not.toMatch(/Claude → Codex lists nineteen(?![a-z])/)
    expect(doc).not.toMatch(/Claude → Codex lists twenty(?![a-z-])/)
    // P6.743's two, bounded from birth: `twenty-one` must not match
    // `twenty-two`, and `THIRTY-TWO` must not match itself inside
    // `THIRTY-THREE` — nor be found by a bare `THIRTY` guard.
    expect(doc).not.toMatch(/Claude → Codex lists twenty-one(?![a-z])/)
    expect(doc).not.toMatch(/(?<![A-Z-])THIRTY-TWO rows are surfaced/)
    expect(doc).not.toMatch(/(?<![A-Z-])THIRTY-ONE rows are surfaced/)
    expect(doc).not.toMatch(/(?<![A-Z-])THIRTY rows are surfaced/)
    // P6.596's `twenty-two`, bounded from birth (P6.736): it must not match its
    // own successor `twenty-three`.
    expect(doc).not.toMatch(/Claude → Codex lists twenty-two(?![a-z])/)
    // P6.896's guard was for THIRTY-FOUR, spent by going DOWN when `webSearch`
    // was retired. P6.312 added a row and made that spelling LIVE again, so its
    // line is deleted here and the count it displaced is guarded instead — the
    // shape this block gets wrong most often is exactly the other one: a
    // spent-count guard and a live count are the same string one commit apart,
    // and leaving both in fails on the sentence the commit just made correct
    // (AGENTS.md §Traps, measured three times). This block is now the first in
    // the file to have seen a count spelling become stale, live and stale again.
    expect(doc).not.toMatch(/(?<![A-Z-])THIRTY-THREE rows are surfaced/)
    // P6.928's two, bounded from birth (P6.736). `THIRTY-FOUR` shares no prefix
    // with its successor `THIRTY-FIVE`, and `twenty-four` shares none with
    // `twenty-five` — bounded anyway, because whether a bare guard is safe
    // depends on a spelling nobody checks when they bump a count, and this block
    // has been wrong about that three times.
    expect(doc).not.toMatch(/(?<![A-Z-])THIRTY-FOUR rows are surfaced/)
    // C3.64's two, bounded from birth (P6.736): `THIRTY-SEVEN` must not be found
    // by a bare `SEVEN` guard and `twenty-seven` must stop at the word, so
    // neither can be satisfied by the successor that displaced it.
    expect(doc).not.toMatch(/(?<![A-Z-])THIRTY-FIVE rows are surfaced/)
    expect(doc).not.toMatch(/(?<![A-Z-])THIRTY-SIX rows are surfaced/)
    expect(doc).not.toMatch(/(?<![A-Z-])THIRTY-SEVEN rows are surfaced/)
    // C3.290's, bounded from birth: `THIRTY-EIGHT` must not be found by a bare
    // `EIGHT` guard, which is the exact failure this block has recorded three
    // times.
    expect(doc).not.toMatch(/(?<![A-Z-])THIRTY-EIGHT rows are surfaced/)
    // C3.285's two. `THIRTY-NINE` is bounded like its siblings, and
    // `twenty-eight` stops at the word so it cannot be satisfied by a
    // `twenty-eight`-prefixed spelling.
    expect(doc).not.toMatch(/(?<![A-Z-])THIRTY-NINE rows are surfaced/)
    expect(doc).not.toMatch(/Claude → Codex lists twenty-eight(?![a-z])/)
    expect(doc).not.toMatch(/Claude → Codex lists twenty-five(?![a-z])/)
    expect(doc).not.toMatch(/Claude → Codex lists twenty-six(?![a-z])/)
    expect(doc).not.toMatch(/Claude → Codex lists twenty-seven(?![a-z])/)
    expect(doc).not.toMatch(/Claude → Codex lists twenty-four(?![a-z])/)
    // P6.312's, bounded from birth: `twenty-three` must not match its own
    // successor `twenty-four`, and it does not share a prefix with it either —
    // bounded anyway, because whether a bare guard is safe depends on a spelling
    // nobody checks when they bump a count.
    expect(doc).not.toMatch(/Claude → Codex lists twenty-three(?![a-z])/)
    // The Pi → Claude half of the same sentence, spent for the first time by a
    // REMOVAL. Bounded: `ten` sits inside no live spelling here, but `eleven`
    // is guarded at the word so a future `eleven`-prefixed count cannot satisfy
    // it by accident.
    expect(doc).not.toMatch(/Pi → Claude lists eleven(?![a-z])/)
    // C3.251's, the second removal from this leg. `ten` is bounded on BOTH
    // sides: unbounded it would be satisfied by nothing live today, but the next
    // count up the scale that starts with it is exactly the trap AGENTS.md
    // §Traps records (`four` matching `fourteen`), and this leg has already
    // spent `eleven`.
    // C3.251 spent `ten`, C3.256 spent `nine` and F1.588 spent `ten` again (the
    // leg back to nine), so the guard moves with the count rather than being
    // deleted: the spelling to forbid is always the one just left behind.
    expect(doc).not.toMatch(/Pi → Claude lists ten(?![a-z-])/)
    // C3.310's, on the other half of the same sentence.
    expect(doc).not.toMatch(/Claude → Codex lists twenty-nine(?![a-z])/)
    // C3.310 took the row count to FORTY-ONE, so the spelling it left behind is
    // guarded like its four predecessors — and bounded, because `FORTY` is a
    // prefix of `FORTY-ONE` and an unbounded guard would fire on the correct
    // sentence, which is the failure mode that makes people delete guards.
    expect(doc).not.toMatch(/(?<![A-Z-])FORTY rows are surfaced/)
    // C3.256's, bounded on both sides for the reason above: `FORTY-ONE` shares
    // no prefix with `FORTY-TWO`, but `FORTY` is a prefix of both.
    expect(doc).not.toMatch(/(?<![A-Z-])FORTY-ONE rows are surfaced/)
    // C3.276's. `FORTY-TWO` shares no prefix with `FORTY-THREE`; bounded anyway,
    // because whether a bare guard is safe depends on a spelling nobody checks
    // when they bump a count.
    expect(doc).not.toMatch(/(?<![A-Z-])FORTY-TWO rows are surfaced/)
    expect(doc).not.toMatch(/Claude → Codex lists thirty(?![a-z-])/)
    // C3.377's two, bounded from birth (P6.736). `FORTY-THREE` must not be
    // found by a bare `THREE` guard and must not match its own successor
    // `FORTY-FOUR`; `thirty-one` stops at the word for the same reason every
    // sibling above does — whether a bare guard is safe depends on a spelling
    // nobody checks when they bump a count.
    expect(doc).not.toMatch(/(?<![A-Z-])FORTY-THREE rows are surfaced/)
    expect(doc).not.toMatch(/Claude → Codex lists thirty-one(?![a-z])/)
    // C4.49 + C4.42's two guards (`FORTY-FOUR`, `thirty-two`) LEFT with
    // UB12.63: its retirement made both spellings live again, P6.312's shape,
    // and a guard on a live count fires on the correct sentence. Its own spent
    // pair is guarded instead: FORTY-FIVE in the case's first lines (beside
    // F1.588's FORTY-SIX) and `thirty-three` below, bounded at the word. The
    // FORTY-FIVE spelling had no guard before, because it was never live until
    // F1.588 — the other half of what this block records: a guard must not
    // forbid a sentence the document never carried.
    expect(doc).not.toMatch(/Claude → Codex lists thirty-three(?![a-z])/)
    expect(doc).not.toContain('every return leg onto\nPi lists none')
  })

  /**
   * P6.597 — the count of each CLAIM VALUE, pinned.
   *
   * The sweep this row carried asked every `false` cell to show its
   * measurement, and two could not: a cell written before `'unmeasured'`
   * existed had to spell *we do not know* as `false`, and a value chosen for
   * want of a better one leaves no trace. The pin is what makes the next such
   * cell deliberate — a new row, or a cell edited from one value to another,
   * moves a number here and has to be justified in the same commit rather than
   * merging into a wall of booleans.
   *
   * Read the FOUR-value shape, not just the total: `null` at exactly one per
   * row is `nestor-cloud-agent`, the only non-endpoint, and a `null` appearing
   * anywhere else silently removes a runtime from BOTH ends of every direction
   * ({@link isSwitchableRuntime}), which is the single most damaging edit
   * possible in this table and the one a total alone would not catch.
   */
  it('pins how many cells carry each claim value', () => {
    const tally: Record<string, number> = {}
    for (const on of Object.values(RUNTIME_SWITCH_COST_CLAIMS)) {
      for (const claim of Object.values(on)) tally[String(claim)] = (tally[String(claim)] ?? 0) + 1
    }
    const rows = Object.keys(RUNTIME_SWITCH_COST_CLAIMS).length
    // P6.157's `liveToolInput` moved three of the five: two more `true`
    // (Pi and claude both read their runtime's incremental frames), one more
    // `false` (codex's protocol declares no tool-argument delta) and one more
    // `null` (nestor-cloud, one per row by the rule below).
    // P6.96's `autoCompactionKnobs` moves the same three as the row before
    // it: two `true` (Pi and claude both read the knobs; claude's floor is a
    // clamp reported on its own transcript, not a capability it lacks), one
    // `false` (codex reads neither) and one `null`.
    // P6.225's `codexReviewer` moves four: one `true` (codex holds the
    // reviewer), two `false` (Pi has its own judge and claude has neither) and
    // one `null` (nestor-cloud, one per row by the rule below).
    // P6.382's `subagentOutputText` moves four more: one `true` (claude
    // forwards since `a8377a7fb`), one `false` (Pi counts and never forwards),
    // one `unmeasured` (codex, declining to make the claim twice-refuted
    // reasoning would have produced) and one `null`. It is the FOURTH member of
    // the unmeasured class, and the class had been empty of new arrivals since
    // P6.597.
    // P6.296's `preToolDefer` moves three: two `true` (pi and claude both carry
    // the defer/resume vocabulary), one `false` (codex's generated protocol has
    // no `Defer*` type at all) and one `null`. No new unmeasured cell — the
    // codex absence is read off the generated tree with a positive control.
    // P6.696's `backgroundTaskOffSwitch` moves three: two `true` (pi and claude
    // both honour the off switch, the claude half through its own env var since
    // `6981d9950`), one `false` (codex's config schema and its shipped binary
    // both carry no such switch, with positive controls) and one `null`. No new
    // unmeasured cell.
    // P6.340's row adds one cell of each kind the table's shape forces: one
    // `true` (claude), two `false` (pi and codex) and one `null` (the cloud
    // agent, which this table never claims about).
    // P6.200's `subagentReportScan` moves three: two `true` (Pi scans host-side,
    // claude scans its own past the documented 2.1.210 floor), one `false`
    // (codex's subagent thread returns inside the app-server, so there is no
    // artifact to scan) and one `null`. No new unmeasured cell — the codex
    // absence is read off the shipped binary with both controls.
    // P6.481's `reasoningCarry` moves three, and one of them is only the SECOND
    // `conditional` this table has ever carried: two `true` (Pi's `ThinkingContent`
    // and claude's `ThinkingBlockParam`, each a native slot), one `conditional`
    // (codex carries reasoning on a Responses connection and not on a gateway
    // one, so either boolean would be wrong on half its connections) and one
    // `null`. No new `false`.
    // P6.743's `toolSupportFallback` moves four cells and adds the FIFTH
    // `unmeasured`: one `true` (Pi's trigger set, with the whole emitting path
    // measured live rather than the set alone), one `false` (codex's ladder,
    // whose two members are translated from the page's own sentence and whose
    // `badRequest` exclusion is written at the constant), one `'unmeasured'`
    // (the claude ladder runs inside the closed binary and the page's trigger
    // sentence names a tool-support refusal in NEITHER of its two lists) and
    // one `null`.
    // P6.596's `toolRestriction` moves four and adds the FOURTH `conditional`:
    // one `true` (claude takes both halves through `Options.allowedTools` /
    // `Options.disallowedTools`), one `false` (codex's `enabled_tools` /
    // `disabled_tools` are MCP-server-scoped, so neither half has a key), one
    // `conditional` (Pi honours the allow half and silently ignores the deny
    // half, and which half a user wrote is a condition this table cannot
    // evaluate) and one `null`. No new unmeasured cell — all three arms are
    // measured.
    // P6.184 moves ONE cell and adds no row: `scheduledRun`'s codex claim goes
    // `false` → `'conditional'`, because our `PushNotification` now reaches a
    // bridged codex spawn over `HOST_CALLBACK_BRIDGE_ROUTES.notificationPush`
    // and the bridge's own non-fatal failure is the precondition.
    // P6.148 moved ONE cell and added no row, in the direction this tally had
    // rarely seen: `webSearch`'s codex claim went `false` → `true`, because the
    // host registers its own `web_search` on every codex session over the
    // key-free engine while codex's native one stays `disabled`. Then its claude
    // arm landed too, all three cells read `true`, and P6.896 REMOVED the row —
    // the first removal this tally has ever recorded, and the only kind of
    // subtraction it can see: four cells at once (`true` ×2, `conditional` ×1
    // and the row's own `null`), never a lone cell moving.
    // P6.312's `sessionAgent` moved four: one `true` (claude runs a session as an
    // agent through the SDK's own `Options.agent`), two `false` (Pi's harness
    // manifest has no main-session-agent path and codex layers roles for spawned
    // agents only) and one `null` by the rule below.
    // P6.1018 then moved ONE of those cells and added no row — Pi `false` →
    // `true` — because P6.940 clause (2) taught the HOST to compose the pin for
    // Pi out of the same `sessionAgent` key. It is the second lone-cell move
    // this tally has recorded (P6.184's and P6.148's are the others) and the
    // first that CLOSED a gap the document had written down: the Pi section's
    // row is retired rather than reworded, because the row's own claim stopped
    // being true.
    // P6.928's `readFence` moves three: two `true` (pi and claude both route
    // their file tools through a gate that reaches
    // `getReadsOutsideWorkingDirectoriesViolation`), one `false` (codex reads
    // with its own built-ins and raises no read approval — read off the
    // generated `ServerRequest` union, whose two approval members are the
    // positive control) and one `null`. No new unmeasured cell: the refusal
    // here is a POSTURE, not a gap in what was measured, and marking it
    // unmeasured would have said we do not know when the owner decided.
    // C3.98's `securityPluginEnv` and C3.219's `subagentAgentIdHeader` move six
    // between them and add no new claim VALUE: two `true` (claude holds both —
    // the plugin's hooks run inside its own child, and its runtime sends the
    // agent id header we rename), four `false` (Pi and codex run host-run
    // command hooks behind a six-name whitelist, and neither request passes
    // through `gatewaySessionFetch` at all) and two `null`.
    // C3.64's `claudeBuiltinAgents` moves four and adds no new claim VALUE: one
    // `true` (claude ships Explore and Plan), two `false` (Pi has no vendor
    // roster underneath and codex has no per-agent deny to express one with) and
    // one `null` by the rule below.
    // C3.290's `addedFolderSkills` moves four and adds no new claim VALUE: two
    // `true` (claude through the SDK's `additionalDirectories`, codex through its
    // own `skills/extraRoots/set`), one `false` (for Pi an added folder is the
    // setting that loads no skills, and the host scan walks project roots only)
    // and one `null` by the rule below.
    // C3.285's `ruleSubjects` moves four and adds no new claim VALUE: two `true`
    // (on Pi and claude every tool call reaches the host gate, so a rule may name
    // any subject and still be evaluated), one `false` (codex's approval
    // projection carries three tool names and two input fields) and one `null`.
    // C3.251 moves ONE cell and adds no new claim value: `worktreeMove.anthropic`
    // `'unmeasured'` → `true`, off RS-28's live drive at the packaged 1.36.0
    // sitting. It is the first cell to leave the unmeasured class by being
    // DRIVEN rather than by a row being added or retired — `scheduledRun` is
    // untouched, because nothing drove a notification.
    // C3.310's `hostMcpRules` moves four and adds no new claim VALUE: two `true`
    // (on Pi and claude a rule about an MCP tool or a network host is evaluated
    // like any other), one `false` (on codex neither path consults it — codex's
    // own approvals carry no host or `mcp__` subject, and no host-run tool
    // reaches the rule gate at all) and one `null` by the rule below.
    // C3.256's `autoMemoryDirectoryScope` moves four and adds no new claim VALUE:
    // two `true` (Pi and codex have one auto-memory store and the setting moves
    // it), one `false` (the claude child keeps a second store this fork
    // deliberately does not project the setting into) and one `null`.
    // C3.276's `claudeProjectCommands` moves four and adds no new claim VALUE:
    // one `true` (the claude child dispatches a project `.claude/commands` file,
    // driven), two `false` (neither other runtime has a reader and the host
    // loader supplies none) and one `null`.
    // C3.377's `nestedProtectedPaths` moves four: two more `true` (Pi and
    // claude both run the segment-window floor through `runPreToolUseChecks`),
    // one more `false` (codex's projection resolves per root and reaches no
    // deeper) and the row's own `null` for the non-endpoint.
    // C4.49's `protectedFilesUnprojected` moves four: two more `true` (Pi and
    // claude confirm a protected-FILE write on both paths since C4.50), one more
    // `false` (codex has no filesystem mode that prompts, so the list is not
    // projected) and the row's own `null` for the non-endpoint.
    // C4.42's `codexDetachedReview` moves four the other way round: one more
    // `true` (codex owns the review thread), two more `false` (a backgrounded
    // review is a subagent of this session on Pi and claude, so there is no
    // thread to inherit) and one `null`. Neither adds a new claim VALUE.
    // F1.588 RETIRED `subagentModelOrder` and took its four back out: two `true`
    // (pi, codex), one `false` (claude, before the 2.1.267 order) and one `null`.
    // UB12.63 RETIRED `outputStyleTiming` the same way: two `true` (pi, claude),
    // one `false` (codex, before the mid-session notice) and one `null`.
    expect(tally).toEqual({ true: 66, false: 57, null: 44, unmeasured: 4, conditional: 5 })
    // Totality: every row claims something about every runtime in the
    // vocabulary, so the cells are rows x runtimes exactly.
    expect(Object.values(tally).reduce((sum, count) => sum + count, 0)).toBe(rows * 4)
    // And every `null` is one per row — see the docblock.
    expect(tally.null).toBe(rows)
  })

  /**
   * P6.65 / P6.170 — the marker rule, GENERALISED to every ordered pair.
   *
   * The two tests above walk Pi → Claude and Pi → Codex, which covered every
   * firing row for exactly as long as every row was a capability Pi HELD.
   * `credentialShellFloor` fires only out of codex and `policyKeys` only out of
   * claude, so both were invisible to a suite that only ever left Pi: their
   * markers would have satisfied the totality assertion above and been checked
   * against no section at all.
   *
   * The rule is one sentence — a fired row must be documented in the section of
   * the runtime that LACKS the capability, i.e. the TARGET — and it is applied
   * to all six ordered pairs rather than to the two that used to matter.
   */
  it('every fired row is documented in its TARGET runtime section, on all six legs', () => {
    const runtimes = ['pi', 'anthropic', 'codex-runtime'] as const
    let checked = 0
    for (const from of runtimes) {
      for (const to of runtimes) {
        if (from === to) continue
        const body = section(SECTION_OF[to]!)
        const fired = runtimeSwitchCosts(from, to).map(row => row.id)
        // Positive control per leg: no leg is empty today, so a leg that went
        // vacuous is a change to explain rather than a silent pass.
        expect(fired.length, `${from} → ${to} fired nothing`).toBeGreaterThan(0)
        for (const id of fired) {
          for (const marker of SUBJECT_MARKERS[id]!) {
            expect(body, `${from} → ${to}: the ${to} section does not name ${id} ("${marker}")`).toContain(marker)
            checked += 1
          }
        }
      }
    }
    // The loop really ran: a `section()` that returned the whole document would
    // pass every `toContain` above, so the count is the second control.
    expect(checked).toBeGreaterThan(20)
  })

  /**
   * P3.352 — the WebFetch preflight row is a DISCLOSURE now, and a revert to its
   * owner-owed form fails here.
   *
   * The row recorded a REAL per-runtime egress for three waves: the vendored
   * binary sent the hostname of every page it fetched to a hardcoded
   * `api.anthropic.com` endpoint, and Pi and codex ran no such preflight. The
   * owner ruled (sitting 2026-09-05 §2.2 = (C)) and `9af3a92c4` built it, so the
   * three runtimes now agree and the row's subject inverted: what is left is not
   * a gap but a residual an operator can meet — an install with no domain
   * allowlist and no denylist has no vendor blocklist either.
   *
   * This is pinned rather than left to prose because the row has now been
   * REWRITTEN twice under the same title, and both times the previous wording
   * stayed true-looking. The notice id is cross-read out of `claude-agent.ts`:
   * a disclosure that quotes a transcript line the code no longer emits is worse
   * than no disclosure, since it reads as evidence.
   */
  it('the WebFetch preflight row states the disclosure, not the owner-owed decision (P3.352)', () => {
    const line = section('claude').split('\n').find(row => row.includes('domain_info?domain='))
    expect(line, 'the WebFetch preflight row is no longer in the Claude section').toBeDefined()
    expect(line).toContain('| DECISION |')
    expect(line).toContain('skipWebFetchPreflight')
    expect(line).toContain('claude-webfetch-preflight-disabled')
    expect(line).toContain('[switch: none —')
    // The pre-ruling form, kept as an absence: the status the row carried while
    // the decision was owed, and the sentence that asked for it.
    expect(line).not.toContain('DECISION (owner-owed)')
    expect(line).not.toContain('What is owed instead is the OWNER DECISION')
    // The notice the row quotes is the one the runtime actually emits. Read from
    // the agent rather than restated, so the two cannot drift apart silently.
    expect(
      repoFile('packages/shared/src/agent/claude-agent.ts'),
      'the transcript notice this row names is not emitted by claude-agent.ts',
    ).toContain('claude-webfetch-preflight-disabled')
  })

  it('the Guardian rows carry a reason drawn from the four the document defines', () => {
    for (const runtime of ['claude', 'codex'] as const) {
      const body = section(runtime)
      const line = body.split('\n').find(row => row.includes('Guardian safety judge'))
      expect(line).toBeDefined()
      expect(line).toContain('| DECISION |')
      // The measurement, not just the verdict: a reason with no number behind it
      // is the kind of row this document exists to avoid.
      expect(line).toContain('consultGuardian')
    }
  })
})

// ============================================================
// P6.92 — the REVERSE direction: every documented gap must have been ruled on.
//
// The forward guard above walks the cost table and demands a gaps row for each
// firing row. Nothing walked the other way, so a gap could be written into this
// document, reviewed, shipped — and reach no switch dialog because nobody had
// decided whether it should. That is the half of the pair that was missing, and
// it is the half a NEW gap goes through: gaps are written far more often than
// cost rows are.
//
// ## The annotation is AT THE ROW, and that is the whole design
//
// P2.379 measured this guard family misfiring when it inferred a verdict from
// PROSE — the Pi section enumerates zero session-tool names and one Claude row
// would have failed falsely on `Monitor`, "which appears as contrastive prose
// rather than as an enumeration". So nothing here is inferred. Each row carries
// one explicit `**[switch: …]**` token, in one of exactly three shapes:
//
//   [switch: <id>[, <id>…]]  — surfaced, and named
//   [switch: none — <reason>] — ruled out, with the reason written at the row
//   [switch: owner — <what a promotion would add>]
//
// The third exists because of the row's own boundary: a gap this pass would
// PROMOTE into the cost table adds a user-visible dialog line, and that is the
// owner's call rather than a lane's. Collapsing it into `none` would have made
// the guard record a decision nobody took.
//
// ## What each assertion below is for
//
// Totality — a row with no token fails, so a newly documented gap fails the
// suite until someone rules. Vocabulary — an id that is not in the live table
// fails, so a row annotated with a deleted cost row fails. **Direction** — an id
// named in a section must actually FIRE INTO that runtime, which is the negative
// control the row asked for: move one annotation to the other side and it goes
// red. And the forward leg is re-asserted from the annotations rather than from
// `SUBJECT_MARKERS`, so the two indexes cannot both drift the same way.
//
// A COUNT is deliberately not pinned. This row was born saying "68 per-runtime
// rows"; the document held 61 when the sweep ran and 68 the day the guard
// landed, because four sibling lanes added rows in between. Totality is the
// property; the number is a reading with a date.
// ============================================================

/** One `| … |` row out of a per-runtime gap table — header and rule excluded. */
function gapRows(runtime: 'pi' | 'claude' | 'codex'): string[] {
  return section(runtime)
    .split('\n')
    .filter(line => line.startsWith('| ') && !line.startsWith('| Gap |') && !/^\|\s*-+\s*\|/.test(line))
}

type SwitchAnnotation =
  | { kind: 'ids'; ids: string[] }
  | { kind: 'none' | 'owner'; reason: string }

function parseAnnotation(row: string): SwitchAnnotation {
  const matches = [...row.matchAll(/\*\*\[switch: ([^\]]+)\]\*\*/g)]
  const title = row.split('|')[1]!.trim().slice(0, 70)
  expect(matches.length, `no (or duplicated) [switch: …] annotation on: ${title}`).toBe(1)
  const body = matches[0]![1]!.trim()
  for (const kind of ['none', 'owner'] as const) {
    if (body.startsWith(`${kind} —`)) {
      return { kind, reason: body.slice(`${kind} —`.length).trim() }
    }
  }
  return { kind: 'ids', ids: body.split(',').map(id => id.trim()).filter(Boolean) }
}

describe('P6.92 — every documented gap has been ruled on, at the row', () => {
  const RUNTIME_OF: Readonly<Record<'pi' | 'claude' | 'codex', 'pi' | 'anthropic' | 'codex-runtime'>> =
    Object.freeze({ pi: 'pi', claude: 'anthropic', codex: 'codex-runtime' })
  const SECTIONS = ['pi', 'claude', 'codex'] as const

  it('every per-runtime row carries exactly one annotation, in the three-shape vocabulary', () => {
    let seen = 0
    for (const runtime of SECTIONS) {
      const rows = gapRows(runtime)
      // Positive control per section: an empty slice would make every loop below
      // vacuous, and `section()` returning nothing is a heading rename away.
      expect(rows.length, `${runtime} section has no rows`).toBeGreaterThan(5)
      for (const row of rows) {
        const annotation = parseAnnotation(row)
        if (annotation.kind === 'ids') {
          expect(annotation.ids.length, `empty id list on: ${row.slice(0, 60)}`).toBeGreaterThan(0)
        } else {
          // A reason short enough to be a shrug is not a reason. The shortest
          // legitimate one in the document is the CLOSED sentence.
          expect(annotation.reason.length, `${annotation.kind} with no reason on: ${row.slice(0, 60)}`)
            .toBeGreaterThan(30)
        }
        seen += 1
      }
    }
    // The whole-document control: the three sections together, so a section that
    // silently stopped being sliced cannot pass as "nothing to check".
    expect(seen).toBeGreaterThan(50)
  })

  it('every id named is a live cost row, and it FIRES INTO the section it is named in', () => {
    const ids = new Set(Object.keys(RUNTIME_SWITCH_COST_CLAIMS))
    const sources = ['pi', 'anthropic', 'codex-runtime'] as const
    let checked = 0
    for (const runtime of SECTIONS) {
      const target = RUNTIME_OF[runtime]
      const firesHere = new Set(
        sources.filter(from => from !== target).flatMap(from => runtimeSwitchCosts(from, target).map(row => row.id)),
      )
      for (const row of gapRows(runtime)) {
        const annotation = parseAnnotation(row)
        if (annotation.kind !== 'ids') continue
        for (const id of annotation.ids) {
          expect(ids.has(id), `${runtime}: "${id}" is not a row in the cost table`).toBe(true)
          // THE NEGATIVE CONTROL the row asked for: move an annotation to a
          // section the row does not fire into and this line goes red.
          expect(firesHere.has(id), `${runtime}: "${id}" is annotated here but never fires INTO ${target}`)
            .toBe(true)
          checked += 1
        }
      }
    }
    expect(checked).toBeGreaterThan(10)
  })

  it('and the forward leg holds from the ANNOTATIONS too — no cost row is undocumented', () => {
    const sources = ['pi', 'anthropic', 'codex-runtime'] as const
    for (const runtime of SECTIONS) {
      const target = RUNTIME_OF[runtime]
      const annotated = new Set(
        gapRows(runtime).flatMap(row => {
          const annotation = parseAnnotation(row)
          return annotation.kind === 'ids' ? annotation.ids : []
        }),
      )
      const firesHere = new Set(
        sources.filter(from => from !== target).flatMap(from => runtimeSwitchCosts(from, target).map(row => row.id)),
      )
      for (const id of firesHere) {
        // Deliberately re-derived from the annotations rather than from
        // `SUBJECT_MARKERS`: two indexes that drift together prove nothing, and
        // a marker phrase can be satisfied by a row that is about something else.
        expect(annotated.has(id), `no ${runtime} gap row is annotated with "${id}", which fires into ${target}`)
          .toBe(true)
      }
    }
  })
})

// ============================================================
// P4.6 — a quote attributed to a source that STOPPED SAYING IT.
//
// `runtime-switch-costs.ts` earns its authority by quoting the code that
// enforces each row, and AGENTS.md prefers a quoted sentence to a line number
// precisely because sentences are stable. They are stable; their SUBJECT is not.
//
// The defect this block exists to catch, measured on this very file's subject:
// the `scheduledRun` row said `PushNotification` stays `pi-only` "for the reason
// `tool-defs.ts` still records", and quoted "the store, the once-a-second check
// and the between-turns delivery gate are bound on the Pi path". That sentence
// is still in `tool-defs.ts` — so every grep for it succeeded, and the counts
// beside it were pinned and green — but T1 MOVED it: it now sits beside the cron
// four, described as the premise T1 falsified. A live citation of a refuted
// reason, invisible to a substring search and invisible to a count pin.
//
// So the assertion is ATTRIBUTION, not presence: each quote must appear inside
// the comment block that immediately precedes its own tool's definition. The
// quote table is hand-written for the same reason `SUBJECT_MARKERS` above is —
// a quote derived from the module would match itself and prove nothing — and
// both ends are checked, so a quote deleted from the module also fails.
// ============================================================

/** `tool-defs.ts`'s comment block immediately above one tool's definition. */
function commentBlockAbove(toolName: string): string {
  const lines = toolDefs.split('\n')
  const at = lines.findIndex(line => line.includes(`{ name: '${toolName}'`))
  expect(at, `no definition line for ${toolName} in tool-defs.ts`).toBeGreaterThan(-1)
  const block: string[] = []
  for (let i = at - 1; i >= 0 && /^\s*\/\//.test(lines[i]!); i -= 1) block.unshift(lines[i]!)
  return block.join('\n').replace(/^\s*\/\/ ?/gm, '').replace(/\s+/g, ' ').trim()
}

/**
 * What this module quotes, and whose comment block it must come from.
 *
 * Trailing quoted words are cut off on purpose (`… can only answer` stops before
 * `"unavailable"`): the source spells it with double quotes and the module nests
 * it in single ones, and a test that fails on a quote-character difference is a
 * test people delete.
 */
const ATTRIBUTED_QUOTES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  PushNotification: [
    // P6.52 replaced this entry. It used to pin "the host port is bound on the Pi
    // path; projecting it elsewhere would advertise a tool that can only answer"
    // — a sentence that was still in `tool-defs.ts` and still above the right
    // tool, so this row was green, and was nonetheless FALSE: the port takes a
    // workspace id and a session id and is bound for Pi only because the binding
    // SITE is gated, which is precisely the premise T1 and P2.2 removed for the
    // cron four and the goal pair. The reason that survived measurement is a name
    // collision, so that is what is pinned now.
    'Claude Code ships its own `PushNotification`, so projecting ours would put a second notification tool in front of the model and the ungated one would win',
  ],
  EnterWorktree: [
    // P6.841 replaced this entry, the P6.52 way. It used to pin the R2-era
    // sentence naming the Pi permission gate as the home of the floor these
    // tools depend on — green, because the string really was in both files and
    // really was above the right tool, and nonetheless HALF-FALSE. P6.799
    // measured the floor to be `evaluateWorktreeApproval` in the host-side
    // `core/pre-tool-use.ts`, reached by `claude-agent.ts` through
    // `runPreToolUseChecks`; what is Pi-only is one INPUT, and without it the
    // floor fails CLOSED, so a lift could only ever have advertised a
    // permanently-refusing tool. The half that survived is codex-only, and the
    // reason that survived measurement is native-first, so that is what is
    // pinned now.
    'claude already ships both the tool and its own approval floor while codex publishes no worktree surface at all, and `visibility` is `pi-only` or `not-pi` with no third value, so one lift reaches both runtimes at once',
  ],
})

/** The refuted sentence the `scheduledRun` row used to cite, and its real owner. */
const REFUTED_CRON_PREMISE =
  'the store, the once-a-second check and the between-turns delivery gate are bound on the Pi path'

/**
 * P6.52 — the sentence that REPLACED the cron premise and was refuted in its
 * turn, this time on its own tool.
 *
 * Guarded as a plain absence, which is the weak form and is stated as such: the
 * sentence has no other owner in the tree, so there is no partition to assert
 * the way `REFUTED_CRON_PREMISE` has one. The strong half is the attribution row
 * above — the quote the module DOES carry must sit above `PushNotification` — and
 * this line only stops the superseded wording coming back under it.
 */
const SUPERSEDED_PORT_PREMISE =
  'the host port is bound on the Pi path; projecting it elsewhere would advertise a tool'

/**
 * P6.841 — the two wordings of the refuted worktree-floor premise, guarded as
 * absences over the WHOLE of both files rather than over one comment block.
 *
 * Stronger than `SUPERSEDED_PORT_PREMISE` above on purpose, and it can be: the
 * claim had two spellings in `tool-defs.ts` — the registry comment above
 * `EnterWorktree`, which is the one `ATTRIBUTED_QUOTES` used to pin, and the
 * `WorktreeBatchSchema` docblock, which quoted the inherited reason it was
 * correcting. A block-scoped absence would have missed the second, and a
 * paraphrase is what both sites carry now, so nothing legitimate needs the
 * string back. The strong half is still the attribution row above.
 */
const SUPERSEDED_WORKTREE_FLOOR_PREMISES: readonly string[] = Object.freeze([
  'the approval floor these tools depend on is implemented in the Pi permission gate',
  'approval floor, and no host-side equivalent of that floor exists',
])

/**
 * Comment markers off, whitespace collapsed — so a sentence WRAPPED across
 * comment lines still matches. Both `//` and the `*` of a block comment are
 * stripped, because the two files this compares use different comment shapes and
 * a helper per shape is how the two drift apart.
 */
const flatten = (text: string): string =>
  text.replace(/^[ \t]*(?:\/\/|\*)[ \t]?/gm, '').replace(/\s+/g, ' ')

describe('P4.6 — every sentence this module borrows is still said by its own source', () => {
  it('each quote sits in the comment block above the tool it is attributed to', () => {
    for (const [toolName, quotes] of Object.entries(ATTRIBUTED_QUOTES)) {
      const block = commentBlockAbove(toolName)
      // Positive control: the block was really found and is not empty, so a
      // refactor that moved the comment cannot make this loop vacuous.
      expect(block.length, `${toolName} has no comment block above its definition`).toBeGreaterThan(80)
      for (const quote of quotes) {
        expect(block, `${toolName}'s own comment no longer says: ${quote}`).toContain(quote)
        expect(flatten(costsModule), `runtime-switch-costs.ts no longer quotes: ${quote}`).toContain(quote)
      }
    }
  })

  it('the refuted cron premise belongs to the cron tools and not to PushNotification', () => {
    // The regression itself, asserted as a PARTITION rather than an absence: the
    // sentence is still in `tool-defs.ts` and it is CronCreate's, so a guard
    // written only as `not.toContain` would also pass the day someone deletes it.
    expect(commentBlockAbove('CronCreate'), 'the refuted premise moved; this guard now proves nothing')
      .toContain(REFUTED_CRON_PREMISE)
    expect(commentBlockAbove('PushNotification')).not.toContain(REFUTED_CRON_PREMISE)
  })

  it('the superseded port premise is gone from both files (P6.52)', () => {
    expect(commentBlockAbove('PushNotification')).not.toContain(SUPERSEDED_PORT_PREMISE)
    expect(flatten(costsModule)).not.toContain(SUPERSEDED_PORT_PREMISE)
  })

  it('the superseded worktree floor premise is gone from all four files (P6.841 + P6.847)', () => {
    // Positive control on the instrument: all four files were really read, so an
    // empty or missing read cannot make the absences below vacuous.
    expect(flatten(toolDefs)).toContain('WorktreeBatchSchema')
    expect(flatten(costsModule)).toContain("id: 'worktreeMove'")
    // P6.847 — the same absence over the two DOCUMENTS that quoted the sentence
    // and attributed it to `tool-defs.ts`. Controls first, so a moved heading
    // cannot make the document absences vacuous.
    expect(flatten(doc)).toContain('The model cannot move the session into a git worktree')
    expect(flatten(ledger)).toContain('Have the model move the session into a worktree mid-session')
    for (const premise of SUPERSEDED_WORKTREE_FLOOR_PREMISES) {
      expect(flatten(toolDefs), `tool-defs.ts still says: ${premise}`).not.toContain(premise)
      expect(flatten(costsModule), `runtime-switch-costs.ts still says: ${premise}`).not.toContain(premise)
      expect(flatten(doc), `runtime-capability-gaps.md still says: ${premise}`).not.toContain(premise)
      expect(flatten(ledger), `the capability ledger still says: ${premise}`).not.toContain(premise)
    }
  })

  it('the Monitor description the row explains itself with is the live one', () => {
    const monitor = SESSION_TOOL_DEFS.find(def => def.name === 'Monitor')
    expect(monitor, 'no Monitor tool in the registry').toBeDefined()
    const quoted = 'Watch an event source and get interrupted when something happens, instead of polling for it'
    expect(monitor!.description).toContain(quoted)
    expect(flatten(costsModule)).toContain(quoted)
  })

  it('the Guardian scope note the row quotes is the string the user reads', () => {
    // P6.65 re-cut it. The old wording — "Claude Code and Codex sessions are not
    // covered yet" — read as *neither has a judge*, and only the claude half of
    // that is about a missing judge: codex ships its own auto-review guardian,
    // this repo already writes `approvals_reviewer = "auto_review"` for it, and
    // it is default OFF.
    //
    // P6.571 re-cut it a second time, and this half is the interesting one: the
    // sentence said *"until an administrator turns it on"* because at P6.65 the
    // key had NO user-reachable control — hand-editing a config file was the
    // only way in. P6.225 (`3101b7a92`) shipped the Codex auto-review section on
    // this very settings page, directly below Guardian, so the note now names
    // where the switch is instead of naming a person the reader is not.
    const quoted = 'Runs on Pi-agent sessions only — Claude Code sessions are not covered. '
      + 'Codex ships its own auto-review guardian instead, off by default and switched on under Codex auto-review below.'
    // Exact equality, not `toContain`: this is the whole setting note, and a
    // sibling lane widening it is exactly the drift worth failing on.
    expect(enLocale['settings.ai.guardian.scopeNote']).toBe(quoted)
    expect(flatten(costsModule)).toContain(quoted)
  })
})
