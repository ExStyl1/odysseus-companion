import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { mintArmProject, seedWriteAnchorIndex, seedWritePrompt } from './cases/rs-05.ts'
import { memoryCarriesPhrase, memorySnapshot, memoryTextCarriesFact, QUEUED_TOKEN, stopQueueVerdict } from './cases/rs-103.ts'
import { callsSchedulingTool, probePrompt, probeReplyRows, scoredText } from './cases/rs-106.ts'
import { COMMAND_ROW, COMMAND_TOKEN, PALETTE_CONTROL_ROW, PALETTE_CONTROL_TOKEN } from './cases/rs-107.ts'
import { diagnostic, readInterruptReceipts, receiptSaysNothingSurvived } from './cases/rs-81.ts'
import { ALREADY_TRUSTED, lspProbePrompt, mintProject, PROJECT_COMMAND, trustBlocksLspRoute } from './cases/rs-99.ts'
import { launchRecipe } from './fixtures/runtime-switch.ts'
import { DEBUG_LEVER } from './lib/runtime-session-log.ts'
import { silentGateVerdict } from './lib/runtime-switch.ts'
import type { TranscriptMessage } from './lib/state.ts'

/**
 * The instrument defects the 1.41.0 sittings measured in four cases (F1.767,
 * F1.810, F1.877, F1.915), each held against the reading that exposed it — no app.
 */

let seq = 0
function row(role: string, content: string, extra: Partial<TranscriptMessage> = {}): TranscriptMessage {
  seq += 1
  return { id: `s-${seq}`, role, content, timestamp: seq, ...extra }
}

describe('F1.767 — RS-81 reads the interrupt receipt the host now records', () => {
  // SIT-b's host note file for arm A, verbatim (packaged `5896a66d2`, 2026-09-25).
  const SIT_B_HOST_FILE = [
    '[2026-09-25T03:13:59.480Z] Claude turn interrupt (user_stop); child advertises interrupt_receipt_v1 '
      + '(capabilities: interrupt_receipt_v1, interrupt_cancel_queued_v1, msg_lifecycle_v1)',
    '[2026-09-25T03:13:59.499Z] Claude turn interrupt receipt (user_stop): still_queued=[]',
  ]

  function readRecorded(lines: readonly string[]): ReturnType<typeof diagnostic> {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'cdp-f1767-'))
    try {
      mkdirSync(join(root, 'logs', 'runtime'), { recursive: true })
      writeFileSync(join(root, 'logs', 'runtime', 'sess-1-claude-host.txt'), `${lines.join('\n')}\n`)
      return diagnostic(root, 'sess-1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('SIT-b\'s recorded file PASSES the new check and failed the old one', () => {
    const read = readRecorded(SIT_B_HOST_FILE)
    // The seam count is unchanged by the receipt line — the before-Stop control still reads 1 seam.
    expect(read.seam).toBe(1)
    // The OLD check (`stillQueued === 0 && cancelQueued === 0`) is what SIT-b saw FAIL:
    // the receipt spells `still_queued`, the capability list spells `…cancel_queued…`.
    expect(read.stillQueued).toBe(1)
    expect(read.cancelQueued).toBe(1)
    const receipt = readInterruptReceipts(read.receiptLines)
    expect(receipt).toEqual({ parsed: 1, stillQueued: [], noContent: 0, failed: 0 })
    expect(receiptSaysNothingSurvived(receipt)).toBe(true)
  })

  it('a receipt naming a survivor FAILS — the row\'s "Stop lied"', () => {
    const receipt = readInterruptReceipts(['Claude turn interrupt receipt (user_stop): still_queued=[uuid-1, uuid-2]'])
    expect(receipt.stillQueued).toEqual(['uuid-1', 'uuid-2'])
    expect(receiptSaysNothingSurvived(receipt)).toBe(false)
  })

  it('an UNRECORDED receipt is not an empty one — no line, a `none` answer, a failed interrupt all fail', () => {
    expect(receiptSaysNothingSurvived(readInterruptReceipts([]))).toBe(false)
    const none = readInterruptReceipts(['Claude turn interrupt receipt (user_stop): none — this child answers the older empty success'])
    expect(none).toEqual({ parsed: 0, stillQueued: [], noContent: 1, failed: 0 })
    expect(receiptSaysNothingSurvived(none)).toBe(false)
    const failed = readInterruptReceipts(['Claude turn interrupt failed: stdin closed'])
    expect(failed.failed).toBe(1)
    expect(receiptSaysNothingSurvived(failed)).toBe(false)
    // And the seam line alone is no receipt.
    expect(readRecorded(SIT_B_HOST_FILE.slice(0, 1)).receiptLines).toEqual([])
  })
})

describe('F1.767 — RS-107 reads the palette filtered by the token, as the dispatch does', () => {
  it('the menu filters by SUBSTRING, so the token cannot drop a row COMMAND_ROW accepts', () => {
    for (const text of ['/cdp-cmdhook-probe:cdp-probe-cmd CDP fixture command', '/cdp-probe-cmd CDP fixture command']) {
      expect(COMMAND_ROW.test(text)).toBe(true)
      expect(text.toLowerCase()).toContain(COMMAND_TOKEN.toLowerCase())
    }
    expect(PALETTE_CONTROL_ROW.test(`/${PALETTE_CONTROL_TOKEN} Review the current diff`)).toBe(true)
  })

  it('BOUNDARY — each token is spellable in the palette\'s own filter charset', () => {
    for (const token of [COMMAND_TOKEN, PALETTE_CONTROL_TOKEN]) expect(token).toMatch(/^[a-zA-Z0-9._-]+$/)
    // The control token does not also select the command: the two reads stay distinct.
    expect(COMMAND_ROW.test(`/${PALETTE_CONTROL_TOKEN}`)).toBe(false)
  })
})

describe('F1.810 — RS-99 can reach its subject', () => {
  it('the trust gate\'s `already decided: trusted` lets the route run, spelled as the helper spells it', () => {
    expect(ALREADY_TRUSTED).toBe(silentGateVerdict({ ok: true, trustState: 'trusted', items: null }))
    expect(trustBlocksLspRoute('answered')).toBe(false)
    expect(trustBlocksLspRoute(ALREADY_TRUSTED)).toBe(false)
  })

  it('every other `not-shown` still BLOCKS', () => {
    expect(trustBlocksLspRoute(silentGateVerdict({ ok: true, trustState: 'untrusted', items: null }))).toBe(true)
    expect(trustBlocksLspRoute(silentGateVerdict({ ok: true, trustState: 'unknown', items: [] }))).toBe(true)
    expect(trustBlocksLspRoute(silentGateVerdict({ ok: false, why: 'probe threw' }))).toBe(true)
  })

  it('the probe prompt is ONE line — the composer drops a typed newline (SIT-t `composer-mismatch`)', () => {
    const prompt = lspProbePrompt('Edit the file /tmp/x/src/probe.ts', 'export const answer: number = "one"')
    expect(prompt).not.toContain('\n')
    expect(prompt).toContain('= "one" After the edit')
    expect(prompt).toContain('NO FEEDBACK SHOWN')
  })

  it('the minted project contributes a project command, so the trust question is asked', () => {
    const root = mintProject()
    try {
      expect(PROJECT_COMMAND.startsWith(join('.claude', 'commands'))).toBe(true)
      expect(PROJECT_COMMAND.endsWith('.md')).toBe(true)
      expect(readFileSync(join(root, PROJECT_COMMAND), 'utf8')).toContain('description:')
      expect(existsSync(join(root, 'src', 'probe.ts'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('F1.877 — RS-106 scores the probe\'s OWN reply', () => {
  const prompt = probePrompt('code-review')

  it('a follow-up turn that slipped in ahead of the probe is not the reply (SIT-z claude /code-review)', () => {
    const rows = [
      row('user', '/code-review'),
      row('assistant', 'Starting the review in the background.'),
      // what the send's `added` began with: the background reviewer's follow-up turn
      row('assistant', 'The reviewer found no issues in sum.js.'),
      row('user', prompt),
      row('assistant', 'Review a diff in this session and report what it found.'),
    ]
    const reply = probeReplyRows(rows, prompt)
    expect(reply.map(r => r.content)).toEqual(['Review a diff in this session and report what it found.'])
    expect(scoredText(reply, rows.slice(0, 3)).detector).toBe('probe reply')
  })

  it('stops at the next user row, and anchors on the LAST probe row', () => {
    const rows = [row('user', prompt), row('assistant', 'old'), row('user', `${prompt}  `), row('assistant', 'new'), row('user', 'later')]
    expect(probeReplyRows(rows, prompt).map(r => r.content)).toEqual(['new'])
  })

  it('an interview skill whose probe was never typed falls back to the invocation replies, and says so', () => {
    const invocation = [row('user', '/plugin-creator'), row('assistant', 'step 1 interview the user first')]
    expect(probeReplyRows(invocation, probePrompt('plugin-creator'))).toEqual([])
    const scored = scoredText([], invocation)
    expect(scored.detector).toContain('weaker')
    expect(scored.text).toBe('step 1 interview the user first')
  })

  it('BOUNDARY — the fallback never scores a user row', () => {
    expect(scoredText([], [row('user', 'step 1 interview the user first')]).text).toBe('')
  })
})

describe('F1.1201 — RS-106\'s NEG probe of a model-invocable skill cleans up what it may schedule', () => {
  const SOURCE = readFileSync(join(import.meta.dir, 'cases', 'rs-106.ts'), 'utf8')
  const negArm = SOURCE.slice(SOURCE.indexOf('// ---- NEG:'), SOURCE.indexOf('} finally {'))

  it('a turn that called a scheduling tool is one the cleanup must delete; a plain turn is not', () => {
    expect(callsSchedulingTool([row('user', '/loop'), row('tool', '', { toolName: 'CronCreate' }), row('assistant', 'scheduled')])).toBe(true)
    expect(callsSchedulingTool([row('tool', '', { toolName: 'mcp__session__ScheduleWakeup' })])).toBe(true)
    expect(callsSchedulingTool([row('tool', '', { toolName: 'Read' }), row('assistant', 'Run a prompt repeatedly.')])).toBe(false)
    expect(callsSchedulingTool([])).toBe(false)
  })

  it('the NEG arm pushes its session onto the cleanup list when the invocable probe scheduled', () => {
    expect(negArm).toContain('if (callsSchedulingTool(invocableRows)) scheduled.push(neg.key)')
  })

  it('the review-shaped reading is taken BEFORE the invocable probe can load a body or start a loop', () => {
    const review = negArm.indexOf('sendPrompt(session, neg.key, REVIEW_SHAPED_PROMPT')
    const invocable = negArm.indexOf('sendPrompt(session, neg.key, invocablePrompt')
    expect(review).toBeGreaterThan(-1)
    expect(invocable).toBeGreaterThan(-1)
    expect(review).toBeLessThan(invocable)
  })
})

describe('F1.1202 — the debug-logger lever every pointer names is F1.767\'s `-- --debug`', () => {
  it('DEBUG_LEVER is the recipe, and the RTS fixture prints it', () => {
    expect(DEBUG_LEVER).toBe('-- --debug')
    expect(launchRecipe()).toContain(`\`${DEBUG_LEVER}\``)
  })

  it('BOUNDARY — the env-var route is named only as the fallback, never as the lever', () => {
    expect(DEBUG_LEVER).not.toContain('NESSY_IS_PACKAGED')
    const recipe = launchRecipe().replace(/\s+/g, ' ')
    expect(recipe).not.toMatch(/Add `NESSY_IS_PACKAGED=false` to the launch/)
    expect(recipe).toMatch(/`NESSY_IS_PACKAGED=false`, the fallback/)
  })
})

describe('F1.915 — RS-05 names the file by its absolute path in the arm\'s own folder', () => {
  it('the seed names a full path inside the bound folder, not "the current working directory"', () => {
    const dir = mintArmProject('pi')
    try {
      const prompt = seedWritePrompt(dir, 'pi')
      expect(prompt).toContain(join(dir, 'rs05-pi.txt'))
      expect(prompt).not.toMatch(/current working directory/i)
      expect(dir.startsWith(realpathSync(tmpdir()))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('F1.1250 — RS-05 presses restore-files on the seed write\'s own anchor, not the last one', () => {
  // The menu lists prompts by a truncated preview, so the anchor is found by the prompt's lead, never its path.
  const preview = (text: string) => (text.length <= 80 ? text : `${text.slice(0, 79)}…`)
  const anchors = (dir: string) => [
    '1 Reply with the single word READY. 10:38 AM',
    `2 ${preview(seedWritePrompt(dir, 'pi'))} 10:38 AM`,
    '3 How many things have I asked you to do so far? Answer with a digit. 10:39 AM',
  ]

  it('finds the write anchor among the three, though the menu opens on the last', () => {
    expect(seedWriteAnchorIndex(anchors(join(realpathSync(tmpdir()), 'cdp-rs05-pi-abcdef', 'deeper', 'still')))).toBe(1)
  })

  it('NEGATIVE — a session whose write prompt is not listed selects nothing', () => {
    expect(seedWriteAnchorIndex(anchors('/tmp').filter((_, index) => index !== 1))).toBe(-1)
  })
})

describe('F1.1250 — RS-103 arm E detects the saved FACT, not the planted wording', () => {
  it('the third-person save the 1.41.0 sitting wrote counts, and so does the verbatim one', () => {
    expect(memoryTextCarriesFact("# Memory\n- The user's favourite colour is teal.\n")).toBe(true)
    expect(memoryTextCarriesFact('My favorite color is Teal')).toBe(true)
  })

  it('NEGATIVE — another colour, or the two halves on different lines, is not the fact', () => {
    expect(memoryTextCarriesFact("The user's favourite colour is blue.")).toBe(false)
    expect(memoryTextCarriesFact('- favourite colour: see below\n- likes teal mugs')).toBe(false)
    expect(memoryTextCarriesFact('')).toBe(false)
  })
})

// F1.1295 (SIT4-a, 2026-10-02) — sessions live at `<config>/sessions/<workspaceId>/<sessionId>/` (storage v2,
// `workspaces/paths.ts` SESSIONS_DIR), and a session-scope `remember` writes `<session>/data/MEMORY.md`
// (`getSessionDataPath`). The detector looked under `<config>/workspaces/<ws>/sessions/`, a folder v2 never writes.
describe('F1.1295 — RS-103 arm E finds a session-scope MEMORY.md where storage v2 keeps it', () => {
  const plant = (relative: string, text: string): string => {
    const root = mkdtempSync(join(tmpdir(), 'rs103-mem-'))
    mkdirSync(join(root, dirname(relative)), { recursive: true })
    writeFileSync(join(root, relative), text, 'utf8')
    return root
  }
  const FACT = "- The user's favourite colour is teal.\n"

  it('reads <config>/sessions/<ws>/<session>/data/MEMORY.md', () => {
    const root = plant('sessions/ws-1/260101-abc/data/MEMORY.md', FACT)
    try {
      expect(memoryCarriesPhrase(root, 'ws-1', '260101-abc')).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('BOUNDARY — another workspace\'s session, and a session file without the fact, do not count', () => {
    const other = plant('sessions/ws-2/260101-abc/data/MEMORY.md', FACT)
    const bare = plant('sessions/ws-1/260101-abc/data/MEMORY.md', '- likes tea\n')
    try {
      expect(memoryCarriesPhrase(other, 'ws-1', '260101-abc')).toBe(false)
      expect(memoryCarriesPhrase(bare, 'ws-1', '260101-abc')).toBe(false)
    } finally {
      rmSync(other, { recursive: true, force: true })
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('CONTROL — the user-scope file at the config root still counts', () => {
    const root = plant('MEMORY.md', FACT)
    try {
      expect(memoryCarriesPhrase(root, 'ws-1', '260101-abc')).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  // The verifier's re-drive: drive #1's CONTROL chat saved the fact in ITS session and the case keeps it, so drive #2's
  // switch-off check must read the off chat's own session, not every session in the workspace.
  it('BOUNDARY — a sibling session of the SAME workspace (a previous drive\'s control save) does not count', () => {
    const root = plant('sessions/ws-1/260101-control1/data/MEMORY.md', FACT)
    try {
      expect(memoryCarriesPhrase(root, 'ws-1', '260102-off2')).toBe(false)
      expect(memoryCarriesPhrase(root, 'ws-1', '260101-control1')).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('BOUNDARY — a shared file that already carried the fact before the turn counts only when the turn changed it', () => {
    const root = plant('MEMORY.md', FACT)
    try {
      const before = memorySnapshot(root, 'ws-1', '260102-off2')
      expect(memoryCarriesPhrase(root, 'ws-1', '260102-off2', before)).toBe(false)
      writeFileSync(join(root, 'MEMORY.md'), `${FACT}${FACT}`, 'utf8')
      expect(memoryCarriesPhrase(root, 'ws-1', '260102-off2', before)).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('F1.1280 — RS-103 arm F reads the paused queue, not just a user row', () => {
  // SIT3-c's Pi session c1310151 (RC #2 198e27f39, 2026-10-02), as its session file and header carried it after the
  // Stop: the essay prompt, the queued message still isQueued, `Response interrupted`, `messageQueuePaused: true`,
  // and ONE `Starting chat` in the app log — the queue never moved, yet the old check scored it "drained".
  const queuedText = `${QUEUED_TOKEN} reply with exactly the word drained`
  const sit3cRows = [
    { role: 'user', content: 'Write a detailed essay of at least 800 words about the history of version control systems.' },
    { role: 'user', content: queuedText, isQueued: true },
    { role: 'info', content: 'Response interrupted' },
  ]
  const pausedQueue = { paused: true, queue: [{ text: queuedText }] }

  it('DEFECT — the old "drained" check passes on a queued row that was never sent', () => {
    const oldDrained = sit3cRows.some(r => r.role === 'user' && (r.content ?? '').includes(QUEUED_TOKEN))
    expect(oldDrained).toBe(true)
    expect(stopQueueVerdict({ rows: sit3cRows, queue: pausedQueue })).toBe('kept-paused')
  })

  it('NEGATIVE — sent, unpaused and lost are each told apart from kept-paused', () => {
    const sentRows = sit3cRows.map(r => (r.content === queuedText ? { ...r, isQueued: false } : r))
    expect(stopQueueVerdict({ rows: sentRows, queue: { paused: false, queue: [] } })).toBe('sent')
    expect(stopQueueVerdict({ rows: sit3cRows, queue: { paused: false, queue: [{ text: queuedText }] } })).toBe('unpaused')
    expect(stopQueueVerdict({ rows: sit3cRows, queue: { paused: true, queue: [] } })).toBe('lost')
    expect(stopQueueVerdict({ rows: sit3cRows.filter(r => r.content !== queuedText), queue: pausedQueue })).toBe('lost')
    expect(stopQueueVerdict({ rows: sit3cRows, queue: null })).toBe('lost')
  })
})
