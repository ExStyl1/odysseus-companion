/**
 * PKG-7 — P3.57: a real image carry, reachable on Pi and blocked on Claude by
 * EVIDENCE rather than by assumption.
 *
 * The row's title is the whole assignment. Its two halves were argued from
 * types and from silence, and both are the kind of claim that looks obviously
 * right while being unmeasured:
 *
 *  - **Pi** — upstream types a session entry's content as
 *    `string | (TextContent | ImageContent)[]` while ours is `PiTextContent[]`,
 *    "so Pi's blocker is ours and removable".
 *  - **Claude** — "no vendor transcript observed carries an image block, and the
 *    verifier cannot detect an SDK rejection, so shipping it there means
 *    asserting a format we have never seen accepted".
 *
 * "We have never seen it" is an ABSENCE claim, and AGENTS.md is explicit that an
 * absence finding needs a positive control on the same rig. Nobody had run one.
 * This case runs four, in two registers.
 *
 * ## Register 1 — what the SHIPPED artefacts say (not the repo's node_modules)
 *
 * P3.313 is the reason this distinction is not pedantry: the packaged app was
 * shipping a DIFFERENT SDK from the one the lockfile pinned, so every type read
 * taken against `node_modules/` was a statement about the dev tree. These reads
 * come out of the `.app` the CDP target names.
 *
 *  - the shipped Pi bundle, `resources/pi-agent-server/index.js`, is searched
 *    for `ImageContent` with `TextContent` as the positive control and a
 *    nonsense token as the negative one, so a zero means absence rather than a
 *    broken search (`countInFile` scans BYTES — `grep -c` counts lines, and a
 *    25 MB single-line bundle would report 1 for everything).
 *  - the shipped Claude SDK's published `.d.ts` set is searched the same way.
 *
 * ## Register 2 — the operator's own corpus, and the live control that reads it
 *
 * Counting image blocks across every transcript on this profile answers "has one
 * ever been seen". It cannot answer "would one be accepted", and reading it as
 * if it could is precisely the assumption the row is made of. So the case then
 * SENDS one: a real 24×24 PNG through the app's own attachment path, on each
 * runtime, and reads what that runtime wrote into its own transcript.
 *
 * That live turn is the control the corpus count needs. If a live attachment
 * produces no image block in the Claude SDK's transcript, the corpus zero is
 * explained by the format. If it DOES produce one, the corpus zero is about
 * history and the row's premise is refuted — and either way it is measured
 * instead of assumed.
 *
 * ## Why the attachment goes through `sendMessage` and not the composer
 *
 * The harness's rule is to drive the app's own surfaces, and this does: `sendMessage`
 * is one of the three functions `assertElectronApi` requires, and its
 * `attachments` parameter is the same one the composer fills. There is no
 * alternative — attaching a file through the composer needs a native file
 * dialog, which CDP cannot drive. Stated here rather than discovered later.
 *
 * ## The one thing this case must not conflate
 *
 * **The RUNTIME accepting an image block and the MODEL accepting it are
 * different claims.** P3.114's modality wall is live on this profile: the
 * gateway model answers `Model Does Not Support Image Inputs`, and PKG-5 watched
 * that refusal poison a second turn. A transcript entry is written around the
 * outbound message, so the block can be formed and the upstream can still
 * refuse. The case therefore reports the block count and the reply SEPARATELY
 * and scores neither as the other.
 *
 * ## What is deliberately NOT here
 *
 * No fix. The row's resting state is P3.54's honest loss — the image becomes a
 * NAMED path the model can read back — and the owner's 2026-08-28 objection
 * killed the bulk re-attachment alternative on the grounds that it fabricates
 * history. PKG-5 already proved the read-back on codex, the last runtime where
 * it was unmeasured. This case measures the carry as it SHIPS and hands the
 * evidence to the row; it changes nothing.
 */

import { lastAssistantText } from '../lib/chat.ts'
import { bundleFiles, countInFile, resolveAppUnderTest } from '../lib/bundle.ts'
import type { CdpSession } from '../lib/connect.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { blocked, exitCodeFor, runCase, type CaseRun } from '../lib/report.ts'
import { configDir } from '../lib/runtime-session-log.ts'
import {
  activeConnection,
  listConnections,
  runtimeOf,
  switchRuntime,
} from '../lib/runtime-switch.ts'
import { fixturePaths } from '../fixtures/runtime-switch.ts'
import {
  assertElectronApi,
  freshSession,
  isProcessing,
  listSessions,
  transcript,
  waitFor,
  type SessionKey,
} from '../lib/state.ts'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'

const ID = 'PKG-7'
const TITLE = 'P3.57: a real image carry — reachable on Pi and blocked on Claude, measured rather than assumed'

const TURN_TIMEOUT_MS = 300_000
const CDP_COMMAND_TIMEOUT_MS = 240_000

/**
 * A 24×24 solid-colour PNG, generated rather than lifted from a screenshot: the
 * assertions are on transcript structure, and a picture whose content nobody can
 * predict makes the model's answer look like the detector. Same constant PKG-5
 * used, for the same reason.
 */
const PNG_RED =
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAI0lEQVR4nGO4IyJCFcQwatBoGI2mo9EsMlqMjJaQdwa8FgEACkRJH3RIcp4AAAAASUVORK5CYII='

/* ------------------------------------------------------------------ *
 * Tolerant reads — the app's own 30 s RPC budget, on a loaded box
 * ------------------------------------------------------------------ */

let rpcTimeouts = 0

/**
 * `sessions:get` projects EVERY session, and this operator profile holds ~739.
 * At the load this sitting ran under (14-22, from unrelated jest workers, an
 * antivirus daemon and an EDR agent) the renderer's own
 * `Request timeout: sessions:get (30000ms)` fires on a call that is merely slow.
 * That budget is the APP's, so no harness timeout reaches it; the honest
 * response is to treat a timed-out read as UNKNOWN and read again, and to count
 * how often that happened so a run made of retries cannot look like a clean one.
 */
async function tolerant<T>(read: () => Promise<T>, fallback: T, attempts = 3): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await read()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (!/Request timeout|cdp-eval-threw/.test(message)) throw cause
      rpcTimeouts += 1
      if (attempt === attempts) return fallback
      await Bun.sleep(2_000)
    }
  }
  return fallback
}

/**
 * Move the session onto a connection, and believe the SESSION rather than the RPC.
 *
 * `switchRuntime` drains the old runtime and builds a new one, which on this box
 * outlasts the app's own 30 s `sessions:command` budget — so the RPC reports
 * `Request timeout` for a switch that then completes. PKG-6 lost a run to
 * exactly that. The RPC's answer is recorded (it carries the real message when a
 * switch genuinely fails); the VERDICT is the session's own `activeConnection`.
 */
async function bindRuntime(
  session: CdpSession,
  key: SessionKey,
  slug: string,
): Promise<{ bound: boolean; rpc: string; active?: string }> {
  let rpc = 'in flight'
  // Started, NOT awaited. `switchRuntime`'s `Runtime.evaluate` can stop
  // answering while the switch itself proceeds — PKG-6 sat inside this one call
  // for twelve minutes on a 600 s budget while a `1+1` probe against the same
  // renderer answered instantly. The session's own `activeConnection` is the
  // verdict and stays readable throughout; 20 s between reads because each
  // `getSessions()` costs up to 27 s mid-switch on this profile, and polling
  // faster than the app can answer makes the case part of the load.
  const issue = (): void => {
    void switchRuntime(session, key.sessionId, slug)
      .then(outcome => { rpc = outcome.ok ? 'ok' : (outcome.error ?? 'switch reported not-ok') })
      .catch((cause: unknown) => {
        rpc = cause instanceof Error ? (cause.message.split('\n')[0] ?? cause.message) : String(cause)
        rpcTimeouts += 1
      })
  }
  issue()
  let active = await waitFor(
    () => tolerant(() => activeConnection(session, key.sessionId), undefined, 2),
    value => value === slug,
    { timeoutMs: 150_000, intervalMs: 15_000 },
  ).catch(() => undefined)
  // `SESSION_BUSY` is the server refusing a switch while the session is still
  // settling, and it is TRANSIENT — unlike a mutation-boundary collision there
  // is nothing in flight to wait for, so re-issuing is the right response and
  // waiting alone never succeeds. Measured on the first PKG-7 run, where the
  // arm was lost to it seconds after `freshSession` returned.
  if (active !== slug && /SESSION_BUSY/i.test(rpc)) {
    await Bun.sleep(20_000)
    issue()
    active = await waitFor(
      () => tolerant(() => activeConnection(session, key.sessionId), undefined, 2),
      value => value === slug,
      { timeoutMs: 240_000, intervalMs: 15_000 },
    ).catch(() => undefined)
  }
  return { bound: active === slug, rpc, active }
}

/* ------------------------------------------------------------------ *
 * Register 1 — the shipped artefacts
 * ------------------------------------------------------------------ */

interface TokenScan {
  file: string
  exists: boolean
  /** token → byte-occurrence count. */
  counts: Record<string, number>
}

/**
 * Byte-occurrence counts for a set of tokens in one file.
 *
 * The negative control is part of the RESULT, not a separate step: a scan whose
 * nonsense token counts above zero is a broken scan, and a reader can see that
 * without trusting this comment.
 */
function scanTokens(file: string, tokens: string[]): TokenScan {
  const counts: Record<string, number> = {}
  for (const token of tokens) counts[token] = countInFile(file, token)
  return { file, exists: existsSync(file), counts }
}

/** Every published `.d.ts` of the SHIPPED Claude SDK, concatenated for one scan. */
function shippedClaudeTypeFiles(appRoot: string): string[] {
  const dir = join(appRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => name.endsWith('.d.ts')).map(name => join(dir, name)).sort()
}

/* ------------------------------------------------------------------ *
 * Register 2 — the operator's own transcript corpus
 * ------------------------------------------------------------------ */

interface CorpusCount {
  root: string
  files: number
  /** marker → number of FILES carrying it. */
  filesWith: Record<string, number>
}

function walkJsonl(root: string, keep: (path: string) => boolean): string[] {
  if (!existsSync(root)) return []
  const found: string[] = []
  const walk = (current: string): void => {
    let names: string[]
    try {
      names = readdirSync(current)
    } catch {
      return
    }
    for (const name of names) {
      const child = join(current, name)
      let stat
      try {
        stat = statSync(child)
      } catch {
        continue
      }
      if (stat.isDirectory()) walk(child)
      else if (name.endsWith('.jsonl') && keep(child)) found.push(child)
    }
  }
  walk(root)
  return found
}

/**
 * How many files in a corpus carry each marker.
 *
 * FILES rather than occurrences: the question is "has such a block ever been
 * written here", and one file carrying a thousand is the same answer as one
 * carrying one. Content is never read out — only whether a structural marker is
 * present — because this walks the operator's real sessions.
 */
function countCorpus(root: string, files: string[], markers: string[]): CorpusCount {
  const filesWith: Record<string, number> = {}
  for (const marker of markers) filesWith[marker] = 0
  for (const file of files) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const marker of markers) {
      if (text.includes(marker)) filesWith[marker] = (filesWith[marker] ?? 0) + 1
    }
  }
  return { root, files: files.length, filesWith }
}

/* ------------------------------------------------------------------ *
 * Register 2b — the live turn, and what each runtime recorded
 * ------------------------------------------------------------------ */

/** Structural markers an image block reaches a transcript under, per runtime. */
const IMAGE_MARKERS = ['"type":"image"', '"type": "image"', '"media_type"', '"base64"'] as const
/** The pointer the shipped carry writes instead — `handoffAttachmentBlock`'s own words. */
const POINTER_MARKERS = ['[Stored at: ', 'did not cross the runtime switch', '[Attached image: '] as const

interface TranscriptScan {
  files: number
  bytes: number
  imageMarkers: Record<string, number>
  pointerMarkers: Record<string, number>
  /** The control: a marker every transcript must carry, proving the scan reads. */
  textMarker: number
  reason?: string
}

function scanSessionTranscripts(files: string[]): TranscriptScan {
  const imageMarkers: Record<string, number> = {}
  const pointerMarkers: Record<string, number> = {}
  for (const marker of IMAGE_MARKERS) imageMarkers[marker] = 0
  for (const marker of POINTER_MARKERS) pointerMarkers[marker] = 0
  let textMarker = 0
  let bytes = 0
  for (const file of files) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    bytes += text.length
    if (text.includes('"type":"text"') || text.includes('"type": "text"')) textMarker += 1
    for (const marker of IMAGE_MARKERS) if (text.includes(marker)) imageMarkers[marker] = (imageMarkers[marker] ?? 0) + 1
    for (const marker of POINTER_MARKERS) if (text.includes(marker)) pointerMarkers[marker] = (pointerMarkers[marker] ?? 0) + 1
  }
  return { files: files.length, bytes, imageMarkers, pointerMarkers, textMarker }
}

/** This session's own Claude SDK transcripts — the directory name ends with the id. */
function claudeTranscriptFiles(key: SessionKey): string[] {
  const projects = join(configDir(), 'workspaces', key.workspaceId, 'claude-config', 'projects')
  return walkJsonl(projects, file => file.includes(key.sessionId))
}

/** This session's own Pi sidecars. */
function piSidecarFiles(key: SessionKey): string[] {
  const dir = join(configDir(), 'sessions', key.workspaceId, key.sessionId, '.pi-sessions')
  return walkJsonl(dir, () => true)
}

function transcriptFilesFor(kind: 'pi' | 'anthropic', key: SessionKey): string[] {
  return kind === 'pi' ? piSidecarFiles(key) : claudeTranscriptFiles(key)
}

/**
 * Send a message WITH a real image attachment, through the app's own API.
 *
 * The `FileAttachment` shape is `protocol/dto.ts`'s: an `image` row carrying
 * `base64`, which is exactly what a composer attachment produces and what
 * `ClaudeAgent.buildSDKUserMessage` and `PiAgent`'s chat path each consume.
 */
async function sendWithImage(
  session: CdpSession,
  key: SessionKey,
  text: string,
  file: string,
  base64: string,
): Promise<{ stored: boolean; storeError?: string }> {
  return session.call<{ stored: boolean; storeError?: string }>(`
    const attachment = {
      type: 'image',
      path: ${JSON.stringify(file)},
      name: ${JSON.stringify(file.split('/').pop() ?? 'probe.png')},
      mimeType: 'image/png',
      base64: ${JSON.stringify(base64)},
      size: ${Buffer.from(base64, 'base64').length},
    }
    let ref
    let storeError
    try {
      ref = await window.electronAPI.storeAttachment(${JSON.stringify(key.sessionId)}, attachment)
    } catch (e) {
      storeError = String(e && e.message || e)
    }
    await window.electronAPI.sendMessage(
      ${JSON.stringify(key.sessionId)},
      ${JSON.stringify(text)},
      [attachment],
      ref ? [ref] : undefined,
    )
    return { stored: !!ref, storeError }
  `)
}

/**
 * How many user rows the HOST records as carrying an attachment.
 *
 * **The positive control the first run did not have, and the reason it is
 * required rather than observed.** That run passed a bare `attachments` array to
 * `sendMessage` and both models answered *"I don't see any image attached"* —
 * which reads exactly like the product finding this row is about, and was not
 * one. `App.tsx` stores each attachment FIRST (`storeAttachment`) and sends the
 * resulting `SessionAttachmentDto` refs alongside; a call without them attaches
 * nothing. So before any conclusion is drawn from "no image block appeared", the
 * host's own transcript has to agree that an image was attached at all.
 */
async function hostAttachmentRows(session: CdpSession, key: SessionKey): Promise<number> {
  return session.call<number>(`
    const result = await window.electronAPI.getSessionMessages(${JSON.stringify(key.sessionId)})
    const rows = (result && result.messages) || []
    return rows.filter(m => Array.isArray(m.attachments) && m.attachments.length > 0).length
  `)
}

/** Wait for the turn to grow the transcript and stop streaming. */
async function settle(session: CdpSession, key: SessionKey, before: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const messages = await tolerant(() => transcript(session, key), [])
    const processing = await tolerant(() => isProcessing(session, key), true)
    if (messages.length > before && !processing) return messages.length
    if (Date.now() >= deadline) return messages.length
    await Bun.sleep(4_000)
  }
}

interface LiveArm {
  runtime: 'pi' | 'anthropic'
  slug: string
  key: SessionKey
  before: TranscriptScan
  after: TranscriptScan
  reply: string
  modalityRefusal: boolean
}

const MODALITY_REFUSAL = /does not support image|image input|unsupported.*image|image.*not supported/i

/**
 * A live arm could not be SET UP. The artefact and corpus registers are the
 * decisive half of this row and they have already been measured by the time an
 * arm runs, so losing them to a rig fault in the optional half would be the
 * worst possible trade.
 */
class LiveArmUnavailable extends Error {}

async function runLiveArm(
  run: CaseRun,
  session: CdpSession,
  input: { kind: 'pi' | 'anthropic'; slug: string; dir: string; png: string; nonce: string },
): Promise<LiveArm> {
  const label = `${input.kind}/live-image`
  let key = await tolerant(() => freshSession(session, `${ID} ${label}`), undefined)
  if (!key) key = await freshSession(session, `${ID} ${label} retry`)
  if (!run.check(`${label} · a fresh session was created`, key.fresh, key.reason ?? '')) {
    throw new LiveArmUnavailable(`${label}: ${key.reason ?? 'session not fresh'}`)
  }

  // No working-directory bind: the image travels as base64 INSIDE the message,
  // and the fixture already lives in the one project this profile trusts, so a
  // bind would add the deadlock PKG-6 measured and buy nothing.
  await waitFor(() => tolerant(() => isProcessing(session, key), true), busy => !busy, { timeoutMs: 90_000, intervalMs: 4_000 })
    .catch(() => undefined)

  const moved = await bindRuntime(session, key, input.slug)
  run.observe(`${label} · runtime bind`, moved)
  if (!run.check(`${label} · the session moved onto ${input.slug}`, moved.bound, `rpc said ${moved.rpc}; session reports ${String(moved.active)}`)) {
    throw new LiveArmUnavailable(`${label}: runtime bind failed — rpc ${moved.rpc}, active ${String(moved.active)}`)
  }

  const file = join(input.dir, `pkg7-${input.kind}-${input.nonce}.png`)
  writeFileSync(file, Buffer.from(input.png, 'base64'))

  const before = scanSessionTranscripts(transcriptFilesFor(input.kind, key))
  const beforeCount = (await tolerant(() => transcript(session, key), [])).length
  const sent = await sendWithImage(
    session,
    key,
    'Look at the attached image and tell me in one short line what single colour fills it.',
    file,
    input.png,
  )
  run.observe(`${label} · storeAttachment`, sent)
  await settle(session, key, beforeCount, TURN_TIMEOUT_MS)
  const attachedRows = await tolerant(() => hostAttachmentRows(session, key), 0)
  run.observe(`${label} · user rows the HOST records as carrying an attachment`, attachedRows)
  if (attachedRows === 0) {
    throw new LiveArmUnavailable(
      `${label}: the host recorded NO attachment on any user row (storeAttachment ${JSON.stringify(sent)}), `
      + 'so this arm never put an image in front of the runtime and its transcript counts say nothing about '
      + 'whether an image block would be accepted.',
    )
  }
  const after = scanSessionTranscripts(transcriptFilesFor(input.kind, key))
  const reply = lastAssistantText(await tolerant(() => transcript(session, key), []))

  const arm: LiveArm = {
    runtime: input.kind,
    slug: input.slug,
    key,
    before,
    after,
    reply: reply.slice(0, 400),
    modalityRefusal: MODALITY_REFUSAL.test(reply),
  }
  run.observe(`${label} · what the runtime wrote`, {
    transcriptFiles: after.files,
    controlMarkerFiles: after.textMarker,
    imageMarkers: after.imageMarkers,
    pointerMarkers: after.pointerMarkers,
    replyExcerpt: arm.reply.slice(0, 250),
    modalityRefusal: arm.modalityRefusal,
  })
  return arm
}

function anyImageMarker(scan: TranscriptScan): number {
  return Math.max(...Object.values(scan.imageMarkers), 0)
}

/* ------------------------------------------------------------------ *
 * The case
 * ------------------------------------------------------------------ */

async function body(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))

  const app = resolveAppUnderTest(session)
  run.observe('app-under-test', { kind: app.kind, appRoot: app.appRoot, via: app.via })
  if (app.kind !== 'packaged' || !app.appRoot) {
    blocked(`this row is owed on the SHIPPED artefact — "a dev build is not the shipped artefact". The CDP target is ${app.kind} (${app.targetUrl})`)
  }

  // ---- Register 1: the shipped artefacts ------------------------------
  const bundles = bundleFiles(app)
  const piScan = scanTokens(bundles.pi.path, ['ImageContent', 'TextContent', 'PKG7_NEGATIVE_CONTROL_TOKEN'])
  run.observe('shipped Pi bundle · type tokens', { ...piScan, bytes: bundles.pi.bytes })
  run.require(
    'the Pi bundle scan reads the shipped file at all',
    piScan.exists && (piScan.counts.TextContent ?? 0) > 0,
    `positive control TextContent=${piScan.counts.TextContent}`,
  )
  run.check(
    'the shipped Pi bundle scan has a clean negative control',
    (piScan.counts.PKG7_NEGATIVE_CONTROL_TOKEN ?? 0) === 0,
    'a nonsense token must count zero, or every other count here is noise',
  )
  run.check(
    'the SHIPPED Pi runtime carries the image content type',
    (piScan.counts.ImageContent ?? 0) > 0,
    `ImageContent=${piScan.counts.ImageContent} — Pi's own runtime knows the type our PiUserMessage narrows away`,
  )

  const claudeTypeFiles = shippedClaudeTypeFiles(app.appRoot)
  run.require('the shipped Claude SDK publishes type declarations', claudeTypeFiles.length > 0, `${claudeTypeFiles.length} .d.ts under the app's @anthropic-ai scope`)
  const claudeTypeScan = claudeTypeFiles.map(file => scanTokens(file, ['type: "image"', 'type: "text"', 'image_error', 'PKG7_NEGATIVE_CONTROL_TOKEN']))
  const sum = (token: string): number => claudeTypeScan.reduce((total, scan) => total + (scan.counts[token] ?? 0), 0)
  run.observe('shipped Claude SDK · published .d.ts', claudeTypeScan.map(scan => ({
    file: scan.file.split('/').pop(),
    counts: scan.counts,
  })))
  run.check(
    'the Claude type scan has a clean negative control',
    sum('PKG7_NEGATIVE_CONTROL_TOKEN') === 0,
    'a nonsense token must count zero',
  )
  run.observe('shipped Claude SDK · where an image appears in the published types', {
    imageTypeMembers: sum('type: "image"'),
    textTypeMembers: sum('type: "text"'),
    imageErrorTerminalReason: sum('image_error'),
    note:
      'Read the FILE column above: the only `type: "image"` member the SDK publishes sits in sdk-tools.d.ts, '
      + 'in the Read tool\'s OUTPUT shape (FileReadOutput) and in an `images?:` field the same file documents as '
      + '"Images returned by inner Read calls". There is no published transcript INPUT shape carrying one — which '
      + 'is the type-level half of the row\'s claim, and it points the same way as the shipped design: the '
      + 'read-back path is the one image shape this SDK publishes.',
  })

  // ---- Register 2: the operator's whole corpus ------------------------
  const root = configDir()
  const claudeCorpusFiles = walkJsonl(join(root, 'workspaces'), file => file.includes('claude-config'))
  const piCorpusFiles = walkJsonl(join(root, 'sessions'), file => file.includes('.pi-sessions'))
  const markers = ['"type":"image"', '"type": "image"', '"media_type"', '"base64"', '"type":"text"', '"type":"tool_use"']
  const claudeCorpus = countCorpus(root, claudeCorpusFiles, markers)
  const piCorpus = countCorpus(root, piCorpusFiles, markers)
  run.observe('corpus · Claude SDK transcripts on this profile', claudeCorpus)
  run.observe('corpus · Pi sidecars on this profile', piCorpus)
  run.require(
    'the corpus scan reads both corpora (positive control)',
    (claudeCorpus.filesWith['"type":"text"'] ?? 0) > 0 && (piCorpus.filesWith['"type":"text"'] ?? 0) > 0,
    `claude text=${claudeCorpus.filesWith['"type":"text"']}/${claudeCorpus.files}, pi text=${piCorpus.filesWith['"type":"text"']}/${piCorpus.files}`,
  )

  // ---- Register 2b: the live turn ------------------------------------
  const connections = await tolerant(() => listConnections(session), [])
  const pi = connections.find(c => runtimeOf(c.providerType) === 'pi')
  const claude = connections.find(c => runtimeOf(c.providerType) === 'anthropic')
  if (!pi || !claude) {
    blocked(
      'this row needs a Pi AND a claude-runtime connection — its whole claim is an asymmetry between them. '
      + `The app lists: ${connections.map(c => `${c.slug}(${c.providerType})`).join(', ') || 'nothing'}`,
    )
  }

  // The runtime-switch fixture project, not a `mkdtemp`. Binding an untrusted
  // directory raises a modal "Trust this project?" gate that
  // `updateWorkingDirectory` waits on and that `trustFixtureProject` refuses to
  // answer for any other path — PKG-6 measured that deadlock four times. This
  // case does not bind at all, but it writes its PNG where PKG-5 writes its
  // probes, so nothing here can raise that gate either.
  const nonce = Math.random().toString(16).slice(2, 10).toUpperCase()
  const dir = fixturePaths().projectDir
  if (!existsSync(dir)) {
    blocked(
      `the runtime-switch fixture project is missing (${dir}); seed it with `
      + '`bun run scripts/cdp/fixtures/runtime-switch.ts`.',
    )
  }
  run.observe('fixture', { dir, nonce })

  const liveUnavailable: string[] = []
  const arm = async (kind: 'pi' | 'anthropic', slug: string): Promise<LiveArm | undefined> => {
    try {
      return await runLiveArm(run, session, { kind, slug, dir, png: PNG_RED, nonce })
    } catch (cause) {
      if (!(cause instanceof LiveArmUnavailable)) throw cause
      liveUnavailable.push(cause.message)
      run.observe(`${kind} · live arm abandoned (rig)`, cause.message)
      return undefined
    }
  }
  const piArm = await arm('pi', pi.slug)
  const claudeArm = await arm('anthropic', claude.slug)

  // The live control for the corpus counts, stated as the comparison it is.
  // Reported as UNMEASURED rather than as a negative when the arm never ran:
  // "no image block appeared" and "no turn happened" are different findings and
  // this row exists because they were once conflated.
  // **The live half REPORTS; it does not score — and the first two runs are why.**
  //
  // Both arms come back with no image block and a model saying *"I don't see any
  // image attached"*, with the host's own transcript confirming it stored and
  // recorded the attachment. That is not a statement about whether a transcript
  // can carry an image block: `SessionManager.sendMessage` filters the outbound
  // attachment array by `modelSupportsImages`, so on a model that declares no
  // image input the host never sends one and the runtime never sees one. The
  // gateway card's models are exactly that case (P3.114's wall), so scoring this
  // as "the runtime rejected the format" would attribute a MODEL declaration to
  // a RUNTIME capability — the same conflation this row exists to remove.
  //
  // What the arms are worth is recorded instead, and the row's verdict rests on
  // the artefact and corpus registers, which answer the question actually asked.
  for (const [label, armed] of [['Pi', piArm], ['Claude', claudeArm]] as const) {
    if (!armed) continue
    run.observe(`${label} · live image attachment (reported, not scored)`, {
      hostStoredAndRecordedIt: true,
      imageBlockInTheRuntimeOwnTranscript: anyImageMarker(armed.after) > anyImageMarker(armed.before),
      markersBefore: armed.before.imageMarkers,
      markersAfter: armed.after.imageMarkers,
      transcriptFiles: armed.after.files,
      controlMarkerFiles: armed.after.textMarker,
      modalityRefusalInTheReply: armed.modalityRefusal,
      replyExcerpt: armed.reply.slice(0, 220),
      why:
        'no image block here is consistent with the host filtering the attachment out by '
        + '`modelSupportsImages` before the runtime is reached; it is NOT evidence that the '
        + 'runtime would refuse one.',
    })
  }
  run.check(
    'the live half ran on both runtimes with the host recording the attachment',
    Boolean(piArm) && Boolean(claudeArm),
    liveUnavailable.length > 0 ? liveUnavailable.join(' | ') : 'both arms completed a turn',
  )
  run.observe('live arms abandoned for rig reasons', liveUnavailable)

  // ---- the carry itself ----------------------------------------------
  // The Pi session now holds a real attachment row. Moving it to claude is the
  // ONE operation the row is named for, and what the rebuilt transcript carries
  // is the answer: an image block, or the pointer the shipped design writes.
  const carryOutcome = piArm ? await bindRuntime(session, piArm.key, claude.slug) : undefined
  run.observe('carry · Pi → claude switch', carryOutcome ?? 'not attempted — the Pi arm never ran')
  if (piArm && carryOutcome?.bound) {
    const beforeCount = (await tolerant(() => transcript(session, piArm.key), [])).length
    // A turn is needed for the SDK to write the rebuilt history into its own
    // transcript: the handoff is assembled around the first message after the
    // switch, so a read taken before it would measure nothing.
    await session.call<null>(`
      await window.electronAPI.sendMessage(
        ${JSON.stringify(piArm.key.sessionId)},
        "In one short line: what image, if any, was shared earlier in this conversation?",
      )
      return null
    `)
    await settle(session, piArm.key, beforeCount, TURN_TIMEOUT_MS)
    const carried = scanSessionTranscripts(claudeTranscriptFiles(piArm.key))
    const carriedReply = lastAssistantText(await tolerant(() => transcript(session, piArm.key), []))
    run.observe('carry · what claude received after the switch', {
      transcriptFiles: carried.files,
      controlMarkerFiles: carried.textMarker,
      imageMarkers: carried.imageMarkers,
      pointerMarkers: carried.pointerMarkers,
      replyExcerpt: carriedReply.slice(0, 300),
    })
    run.check(
      'carry · the rebuilt transcript claude received names the image',
      Math.max(...Object.values(carried.pointerMarkers), 0) > 0 || Math.max(...Object.values(carried.imageMarkers), 0) > 0,
      'either the pointer block (`[Stored at: `, the handoff note) or a real image block must be present — '
      + 'neither would mean the attachment vanished silently, which is the failure this row exists to prevent',
    )
    run.observe('carry · image block vs pointer', {
      imageBlockCarried: Math.max(...Object.values(carried.imageMarkers), 0) > 0,
      pointerCarried: Math.max(...Object.values(carried.pointerMarkers), 0) > 0,
    })
  }

  run.observe('app RPC reads that timed out and were retried', rpcTimeouts)
  run.observe('VERDICT (for the row)', {
    row: 'P3.57',
    shippedPiCarriesImageContentType: (piScan.counts.ImageContent ?? 0) > 0,
    ourOwnNarrowing: 'packages/shared/src/agent/pi-session-rebuild.ts — PiUserMessage.content: PiTextContent[]',
    shippedClaudePublishedImageShapes: 'Read tool OUTPUT only (FileReadOutput / images?:), no transcript INPUT shape',
    claudeTerminalReasonImageError: sum('image_error') > 0,
    corpus: {
      claudeTranscripts: claudeCorpus.files,
      claudeFilesWithImageBlock: claudeCorpus.filesWith['"type":"image"'],
      piSidecars: piCorpus.files,
      piFilesWithImageBlock: piCorpus.filesWith['"type":"image"'],
    },
    live: {
      piWroteImageBlock: piArm ? anyImageMarker(piArm.after) > anyImageMarker(piArm.before) : 'not measured',
      claudeWroteImageBlock: claudeArm ? anyImageMarker(claudeArm.after) > anyImageMarker(claudeArm.before) : 'not measured',
      piModalityRefusal: piArm?.modalityRefusal ?? 'not measured',
      claudeModalityRefusal: claudeArm?.modalityRefusal ?? 'not measured',
      armsAbandoned: liveUnavailable,
      note: 'the runtime forming a block and the MODEL accepting it are different claims — P3.114\'s wall is live on this profile',
    },
    rpcTimeoutsRetried: rpcTimeouts,
  })
}

if (import.meta.main) {
  const result = await runCase(ID, TITLE, body, { timeoutMs: CDP_COMMAND_TIMEOUT_MS })
  process.exit(exitCodeFor(result.status))
}

export { ID, TITLE, body }
