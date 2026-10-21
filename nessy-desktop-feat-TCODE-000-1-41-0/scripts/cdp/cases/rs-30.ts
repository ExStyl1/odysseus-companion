/**
 * RS-30 (P6.1052) — one auto-mode turn on claude with a `classifierContext`
 * note attached, and what the classifier's verdict did with it.
 *
 * ## The one clause a unit test cannot reach
 *
 * P7.14 (`9ecf0be1f`) wired the auto-mode classifier's note end to end and
 * pinned every hop a unit test can see: the field is declared, parsed nested
 * only, kept on `PostToolUse` by the contract table, JOINED across hooks in the
 * merge, and forwarded FRAMED rather than verbatim. What no unit test can reach
 * is the last hop — the classifier itself runs inside the vendored `claude`
 * binary, so whether a note actually reaches it, and what the verdict does with
 * it, is a question only a live session answers. That is this case.
 *
 * ## The framing, which is the half worth measuring
 *
 * `hooks.md#annotate-a-result-for-the-auto-mode-classifier` weighs the same note
 * two ways: one from *"hooks from settings files, plugins, skills, and agent
 * frontmatter"* is *"unverified, application-provided context"* that *"never
 * establishes user intent"*, while one returned by an *"In-process Agent SDK
 * callback"* *"may weigh a user statement relayed in the note as user intent"*.
 * On this fork EVERY configured hook returns through our in-process callback, so
 * `hooks-automation.ts` prefixes the note with the host's own sentence rather
 * than relaying it — otherwise a third-party plugin's text would arrive carrying
 * the host's weight, which is an unauditable influence on a permission outcome.
 *
 * So the sharp reading here is not *"did a note arrive"* but **did the operator's
 * own sentence arrive ONLY inside the host's frame**. A run that finds the raw
 * marker outside the frame has found the divergence P7.14 exists to prevent, on
 * a real runtime rather than in a mock.
 *
 * ## The detector — the source the FEATURE writes
 *
 * `<config>/workspaces/<workspaceId>/claude-config/projects/…/*.jsonl`, the Agent
 * SDK's OWN transcript under the per-workspace `CLAUDE_CONFIG_DIR`, read through
 * `lib/runtime-session-log.ts`'s `readClaudeSessionLog`. It is written by the
 * runtime, not by the host, and it survives on a packaged build where the app's
 * own logs do not (that file's docblock records why the stdout detector died).
 * The model's prose is NOT the detector: an assistant saying it took the note
 * into account is a claim, and this case scores none of them.
 *
 * The verdict half is read the way `RS-11` reads it — whether the permission
 * card appears — because in `auto` mode the card IS the classifier declining to
 * decide on its own.
 *
 * ## What this case will NOT do
 *
 * It does not install hook configuration. That is the harness's standing rule
 * (`AGT-6`, and `README.md`'s "the harness does not write config"): hook config
 * is live settings, and a case that rewrites the configuration it is measuring
 * can break the machine under it. A FIXTURE may, against a config dir it owns —
 * and since P6.1057 one does: `fixtures/agent-surfaces.ts` writes this hook
 * beside the two `AGT-6` already has, MERGING into `hooks.json` rather than
 * replacing it, and prints the note it minted as `NESSY_CDP_CLASSIFIER_NOTE`.
 * The block message names that script now instead of spelling JSON for the
 * operator to paste.
 *
 * ## The hook's payload, and the one clause that can empty this case's reading
 *
 * `hooks.md#annotate-a-result-for-the-auto-mode-classifier` gives the shape the
 * fixture writes, NESTED and nowhere else — *"Return `classifierContext` to send
 * a short note about the tool call's result to the auto mode classifier rather
 * than to Claude"* — which is what `automations/hook-command.ts` reads and what
 * the contract table keeps on `PostToolUse` alone.
 *
 * The same section names a limit worth reading before any absence here is filed
 * as a defect: *"the classifier's transcript omits read-only lookups such as
 * file reads and searches. Claude Code discards a note attached to one of those
 * calls"*. The control turn below deliberately provokes a `Read`, because a read
 * is the one tool call `auto` will not stop to ask about — so an empty reading
 * after it has a THIRD documented explanation beside "the hook is not installed"
 * and "the note never leaves the host", and the second control's message says so.
 * The probe turn, which is the one the verdict is read from, is a shell write and
 * is not in that category.
 *
 * ## C5.22 — DRIVEN, and the risk that row was born for did NOT materialise
 *
 * The row asked whether the second control aborts the case on a documented
 * DISCARD, and whether the control turn should therefore be moved off the `Read`
 * (at the cost of changing what P6.1052 measures) or turned into a shell write
 * (at the risk of a 240 s card stall). One live run settles it, and the answer
 * is **keep this shape**. Measured on the packaged build (HEAD `70d269e46`,
 * 2026-09-12, card `claude-gateway`): the control turn provoked exactly the
 * `Read` it is written to provoke (`control-tools: ["Read"]`), the second control
 * PASSED, and `framing` read `{ hostFrame: 1, note: 1, framedTogether: 1 }` — the
 * operator's sentence reached the runtime's own transcript once, inside the
 * host's frame, and never outside it. Then the probe turn's `Bash` was decided
 * with no permission card, which is the verdict half. `##CDP-RESULT##` PASS.
 *
 * So the page's *"discards a note attached to one of those calls"* clause does
 * not empty this reading on this build — and it is still the right THIRD cause
 * for the second control's message to name, because nothing here proves it can
 * never bite. Do not "repair" a control that is working: this paragraph is the
 * reading that says it works, with the date it was taken.
 *
 * ## The rig
 *
 * A scratch git repository under the OS temp dir, created and removed by this
 * case, so every tool call the turns provoke lands somewhere disposable and the
 * operator's own tree is never the subject.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { configDir, readClaudeSessionLog, type RuntimeSessionLog } from '../lib/runtime-session-log.ts'
import { bindProject, boundCard, listConnections, runtimeOf, trustScratchProject } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, selectorCount, setPermissionMode } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-30'
const TITLE = 'whether a classifierContext note reaches claude’s auto-mode classifier, and reaches it framed'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'P6.1052',
  runtimes: ['claude'],
  credentials:
    'owner: a claude-runtime card (the "Claude Code (Nessy Gateway)" card is enough), already signed in, '
    + 'plus one PostToolUse hook in `<configDir>/hooks.json` printing a classifierContext note — written by '
    + '`bun run scripts/cdp/fixtures/agent-surfaces.ts`, which prints the note as NESSY_CDP_CLASSIFIER_NOTE. '
    + 'No key is read and none is written.',
} as const satisfies CaseMeta

/**
 * The host's own frame, written out BY HAND rather than imported from
 * `plugins/hooks-automation.ts`.
 *
 * A check that derives its expectation from the code under test passes whatever
 * that code does, a regression included — the same rule
 * `CONTEXT_PREAMBLE_MARKERS` is written under one directory up. If this literal
 * and the host's ever disagree, THAT is the finding.
 */
const HOST_FRAME = 'A hook configured in this workspace reports:'

/** The operator's own sentence, which must never appear outside the frame. */
const NOTE = process.env.NESSY_CDP_CLASSIFIER_NOTE

/** The permission card, and the mode this case needs — the same reads `RS-11` takes. */
const PERMISSION_CARD = '[data-tutorial="permission-banner"]'

/** A repository the turns can act in — scratch, disposable, never the operator's. */
function scratchRepository(label: string): string {
  // realpathed for the same reason as rs-27's twin: macOS answers /var/folders and the app records /private/var.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `nessy-${label}-`)))
  writeFileSync(join(dir, 'README.md'), `# ${label}\n\nA scratch repository created by the CDP harness.\n`, 'utf8')
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: dir, stdio: 'ignore' }) }
  git('init', '-q')
  git('config', 'user.email', 'cdp@example.invalid')
  git('config', 'user.name', 'CDP harness')
  git('add', '--', 'README.md')
  git('commit', '-q', '-m', 'scratch')
  return dir
}

/** Every line of the runtime's own transcript, as one searchable string. */
function transcriptText(log: RuntimeSessionLog): string {
  return log.entries.map(entry => JSON.stringify(entry.raw)).join('\n')
}

/** Occurrences of `needle`, counted rather than tested, so the report carries the number. */
function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length)) {
    count += 1
  }
  return count
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  if (!NOTE) {
    blocked(
      'run `bun run scripts/cdp/fixtures/agent-surfaces.ts` against the config dir the app was launched with, then '
      + 'export the NESSY_CDP_CLASSIFIER_NOTE it prints. That fixture writes the PostToolUse hook this case needs '
      + 'into `<configDir>/hooks.json` (read by `automations/hooks-config.ts` `loadUserGlobalLifecycleHooksConfig`), '
      + 'MERGING rather than replacing, beside the two hooks AGT-6 already uses — a case may not write live hook '
      + 'config, and a fixture is where that write belongs. The payload it writes is the one '
      + '`hooks.md#annotate-a-result-for-the-auto-mode-classifier` shows and `parseHookCommandOutput` reads, NESTED '
      + 'only: hookSpecificOutput.{hookEventName: PostToolUse, classifierContext: <the note>}. Remove the hook when '
      + 'the sitting is over — it carries no matcher, so it annotates every PostToolUse of every later session.',
    )
  }

  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', { workspaceId: key.workspaceId, sessionId: key.sessionId })
  run.check('the case ran in a session it created', key.fresh, key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)

  const slug = await boundCard(session, key.sessionId)
  const rows = await listConnections(session)
  const connection = rows.find(r => r.slug === slug)
  if (!connection || runtimeOf(connection.providerType) !== 'anthropic') {
    blocked(
      'this case is about CLAUDE\'s own auto-mode classifier and refuses to pass vacuously elsewhere. '
      + `This session is on ${connection ? `${connection.slug}(${connection.providerType})` : 'no connection'}; `
      + `the app lists: ${rows.map(r => `${r.slug}(${r.providerType})`).join(', ') || 'nothing'}`,
    )
  }
  run.observe('card', { slug: connection.slug, name: connection.name, providerType: connection.providerType })

  const repository = scratchRepository('rs30-repo')
  run.observe('repository', repository)
  try {
    await bindProject(run, session, key.sessionId, repository, {
      gate: () => trustScratchProject(session, repository),
    })
    await setPermissionMode(session, key.sessionId, 'auto')

    // ---- THE POSITIVE CONTROL --------------------------------------------
    // Two things have to be true before an absent note means anything: the
    // session calls tools at all, and the HOOK fires when it does. Without the
    // second, "no note in the transcript" measures an uninstalled hook.
    const control = await sendPrompt(
      session,
      key,
      'Read the file README.md in your working directory and tell me its first line.',
      240_000,
    )
    const controlTools = control.added.filter(m => m.toolName).map(m => m.toolName)
    run.observe('control-tools', controlTools)
    run.require(
      'THE CONTROL — this session calls tools when asked',
      controlTools.length > 0,
      'the model answered without calling a tool, so no PostToolUse hook could have run and every reading below is empty',
    )

    let log = readClaudeSessionLog(key.workspaceId, configDir(), key.sessionId)
    if (log.entries.length === 0) {
      run.observe('transcript-narrowed-miss', log.reason ?? '(no reason given)')
      log = readClaudeSessionLog(key.workspaceId, configDir())
    }
    run.observe('transcript', { file: log.file, files: log.files?.length, entries: log.entries.length, reason: log.reason })
    const afterControl = transcriptText(log)
    run.require(
      'THE SECOND CONTROL — the hook fired and its note reached the runtime\'s own record',
      afterControl.includes(NOTE),
      'NESSY_CDP_CLASSIFIER_NOTE appears nowhere in the runtime transcript after a turn that did call a tool. '
      + 'THREE causes, none of them the same finding: the PostToolUse hook is not installed (re-run '
      + '`fixtures/agent-surfaces.ts` and use the note it prints); the note never leaves the host; or the call it '
      + 'was attached to was a read-only lookup, which `hooks.md#annotate-a-result-for-the-auto-mode-classifier` '
      + 'says the runtime DISCARDS a note for. Check the hook by hand before reading anything below as evidence '
      + 'about the runtime.',
    )

    // ---- THE FRAMING ------------------------------------------------------
    // The sharp reading: the operator's sentence may appear ONLY inside the
    // host's frame. Counted rather than tested, so a partial leak is visible.
    const framed = occurrences(afterControl, HOST_FRAME)
    const noteTotal = occurrences(afterControl, NOTE)
    const framedNote = occurrences(afterControl, `${HOST_FRAME} ${NOTE}`)
    run.observe('framing', { hostFrame: framed, note: noteTotal, framedTogether: framedNote })
    run.check(
      'the note reached the runtime FRAMED — the host says whose sentence it is',
      framedNote > 0,
      `the frame appears ${framed} time(s) and the note ${noteTotal}, but never adjacent. `
      + 'If the note is there unframed, a configured hook\'s sentence is reaching the classifier with the '
      + 'host\'s own weight, which is exactly what P7.14 built the frame to prevent.',
    )
    run.check(
      'and NEVER unframed — no bare copy of the operator\'s sentence beside it',
      noteTotal > 0 && noteTotal === framedNote,
      `${noteTotal} occurrence(s) of the note against ${framedNote} framed — the difference is the leak`,
    )

    // ---- THE VERDICT ------------------------------------------------------
    // In `auto` the card IS the classifier declining to decide on its own, so
    // its presence or absence after an annotated call is the verdict this row
    // asks for. Both outcomes are recorded; neither is scored a failure, because
    // what the classifier SHOULD do with one note is the vendor's to decide.
    const probe = await sendPrompt(
      session,
      key,
      'Create an empty file called rs30-probe.txt in your working directory using a shell command, then say DONE.',
      300_000,
    )
    const probeTools = probe.added.filter(m => m.toolName).map(m => ({ tool: m.toolName, status: m.toolStatus }))
    const card = (await selectorCount(session, PERMISSION_CARD)) > 0
    run.observe('probe-tools', probeTools)
    run.observe('probe-answer', lastAssistantText(probe.added).slice(0, 300))
    run.observe(
      'classifier-verdict',
      card
        ? 'a permission card is on screen after the annotated call — the classifier did not decide on its own'
        : 'no permission card — the classifier decided the call by itself, with the framed note in its context',
    )
    run.check(
      'the verdict is recorded either way',
      probeTools.length > 0,
      'the probe turn called no tool, so there was no verdict to record — re-run; this is not a finding about the note',
    )

    const after = readClaudeSessionLog(key.workspaceId, configDir(), key.sessionId)
    run.observe('framing-after-probe', {
      hostFrame: occurrences(transcriptText(after), HOST_FRAME),
      framedTogether: occurrences(transcriptText(after), `${HOST_FRAME} ${NOTE}`),
    })
  } finally {
    try { rmSync(repository, { recursive: true, force: true }) } catch { /* the scratch dir, not evidence */ }
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const manual = {
  steps: [
    '1. PACKAGED build, dark theme, one content panel. New session on the claude-runtime card.',
    '2. `bun run scripts/cdp/fixtures/agent-surfaces.ts` against that config dir — it writes the PostToolUse hook '
    + '(MERGING into `hooks.json`) whose command prints '
    + '`{"hookSpecificOutput":{"hookEventName":"PostToolUse","classifierContext":"<the note>"}}` to stdout, and it '
    + 'prints the NESSY_CDP_CLASSIFIER_NOTE to export. A case may not write live hook config; a fixture may.',
    '3. `bun run scripts/cdp/cases/rs-30.ts` with NESSY_CDP_PORT pointed at the app.',
    '4. Read `framing` for whether the note reached the runtime inside the host\'s frame and never outside it, '
    + 'and `classifier-verdict` for what the auto-mode decision did after it.',
    '5. Remove the hook afterwards: `bun run scripts/cdp/fixtures/agent-surfaces.ts --remove-hooks [--config-dir <the dir the app was launched with>]`. '
    + 'It carries no matcher, so left behind it annotates every PostToolUse of every later session in that config dir — and the same fixture that '
    + 'wrote it takes it back out, by the marker-prefix sweep, touching no hook of the operator\'s own.',
  ],
  expected:
    'the note present in the runtime\'s own transcript ONLY as "A hook configured in this workspace reports: '
    + '<your sentence>", with the bare-copy count equal to the framed count, and a recorded auto-mode verdict '
    + '(card or no card) for the annotated call.',
  detector:
    'the Agent SDK\'s own transcript at `<config>/workspaces/<workspaceId>/claude-config/projects/…/*.jsonl`, '
    + 'read through `lib/runtime-session-log.ts`, plus the permission card for the verdict. The model saying it '
    + 'weighed the note is NOT the detector: it is a claim, and this case scores none.',
  positiveControl:
    'two, and both are required before an absence means anything: one turn that must produce a tool entry, and '
    + 'the operator\'s own sentence appearing in the runtime transcript after it — otherwise "no note" measures '
    + 'an uninstalled hook rather than the runtime.',
  doNotConflate:
    'THREE causes produce the same empty transcript and only one of them is a defect: an uninstalled hook, a note '
    + 'that never leaves the host, and a note attached to a read-only lookup, which '
    + '`hooks.md#annotate-a-result-for-the-auto-mode-classifier` says the runtime discards. Re-run the fixture '
    + 'before filing any of them. And an unframed note is a DIFFERENT finding from an absent one — it is the '
    + 'divergence P7.14 built the frame to prevent, not a gap.',
  safety:
    'the turns act in a scratch git repository this case creates under the OS temp dir and removes afterwards. '
    + 'The fixture installs the hook and the operator REMOVES it — left in place it carries no matcher, so it '
    + 'annotates every PostToolUse of every later session on this config dir.',
  doneMeans:
    'drive one claude auto-mode session (packaged sitting), record whether the framed note reached the runtime '
    + 'and what verdict followed, and close P6.1052 with the reading; an unframed occurrence re-opens P7.14.',
} as const satisfies SittingRecipe
