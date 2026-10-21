/**
 * PKG-3 — the hosted `WebSearch` is WITHHELD on a claude-runtime turn the local
 * adapter has to TRANSLATE, and KEPT on one that routes natively.
 *
 * ## The inversion, and why the old case had to be rewritten before re-sitting
 *
 * This case used to ask "does WebSearch EXECUTE through the gateway?" and it
 * answered, on packaged 1.33.0, run twice: dispatched, `completed`,
 * `searchCount: 0`, with the upstream model's own attempted tool call returned
 * as prose and the SDK's *"REMINDER: You MUST include the sources above…"*
 * appended to it. A capability that reported success and did nothing.
 *
 * P3.314/P3.319 (`49a1d4107`) removed it deliberately: on any turn whose request
 * the local adapter must translate, `WebSearch` is pushed onto
 * `Options.disallowedTools` (`claude-agent.ts`, `resolveClaudeHostedWebSearchWithheld`).
 * So the old case's hard-false check — whose failure message read *"the tool was
 * not advertised to the model at all"* — now describes the SUCCESS condition,
 * and its second assertion demanded a search result the product deliberately no
 * longer produces. **Re-running it unchanged manufactures a false regression on
 * the checklist's only red row** (P3.360).
 *
 * ## Two arms in one sitting, because each is the other's control
 *
 *  - **gateway** (`kind: 'nestor'`) — every turn is translated, so the tool must
 *    be ABSENT.
 *  - **native wire** — a claude-runtime connection whose model is stamped
 *    `wire: 'anthropic-messages'`, which `buildClaudeRuntimeWireRouter` routes
 *    straight through, so the tool must be KEPT.
 *
 * **If both arms show absence the DETECTOR is broken, not the product**, and the
 * case says so rather than scoring a green absence. That is the whole reason the
 * second arm exists; an absence finding with no positive control on the same rig
 * is not evidence (AGENTS.md).
 *
 * ## What is read, and what is deliberately NOT read
 *
 * **Not** the model's self-report. Asking a model to list its own tools measures
 * what it says about itself; the old case's advertisement control did exactly
 * that and is gone. What is read instead is the runtime's OWN transcript under
 * the per-workspace `CLAUDE_CONFIG_DIR` — a file the host does not write and
 * cannot retouch — for a `tool_use` block naming the tool. A host that fabricated
 * a transcript row cannot put one there.
 *
 * Second half, gateway arm only: the fabricated tool result that made the old
 * behaviour look successful must not reach the transcript either. On the native
 * arm the same string is RECORDED, not asserted — there it is the vendor's own
 * text arriving through the vendor's own path, and asserting on it would pin
 * someone else's prose.
 *
 * One arm is run on a 1M-window model where the config dir offers one, so
 * P3.319's `[1m]` normalisation is exercised rather than assumed — both halves of
 * that pair previously agreed on the wrong answer.
 */

import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import { resolveAppUnderTest } from '../lib/bundle.ts'
import type { CdpSession } from '../lib/connect.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { blocked, exitCodeFor, runCase, type CaseRun } from '../lib/report.ts'
import { configDir, type RuntimeSessionEntry } from '../lib/runtime-session-log.ts'
import { listConnections, runtimeOf, selectModel, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession } from '../lib/state.ts'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ID = 'PKG-3'
const TITLE = 'WebSearch is withheld on a translated claude turn and kept on a native-wire one'

const TURN_TIMEOUT_MS = 300_000
const CDP_COMMAND_TIMEOUT_MS = 420_000

/** Every spelling the tool reaches a transcript under. */
const WEB_SEARCH_NAMES = ['WebSearch', 'web_search', 'websearch'] as const

/** The fabricated result the withheld path existed to stop reaching the model. */
const FABRICATED_REMINDER = 'REMINDER: You MUST include the sources above'

const SEARCH_PROMPT =
  'Use your web search tool to search the web for: "Electron 39 release notes". '
  + 'Then reply with the first result URL you got back. Do not answer from memory.'

function readClaudeTranscriptsSince(workspaceId: string, sinceMs: number): { files: string[]; entries: RuntimeSessionEntry[] } {
  const root = join(configDir(), 'workspaces', workspaceId, 'claude-config', 'projects')
  if (!existsSync(root)) return { files: [], entries: [] }
  const files: string[] = []
  for (const dir of readdirSync(root)) {
    const child = join(root, dir)
    if (!statSync(child).isDirectory()) continue
    for (const name of readdirSync(child)) {
      if (!name.endsWith('.jsonl')) continue
      const file = join(child, name)
      if (statSync(file).mtimeMs >= sinceMs - 1_000) files.push(file)
    }
  }
  const entries: RuntimeSessionEntry[] = []
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const raw = JSON.parse(trimmed) as Record<string, unknown>
        entries.push({ type: String(raw.type ?? ''), text: '', raw })
      } catch { /* a partially written line is not evidence */ }
    }
  }
  return { files, entries }
}

interface ArmReading {
  slug: string
  model: string | null
  /** `tool_use` blocks naming the tool, in the runtime's own transcript. */
  sdkToolUses: number
  /** Rows the user can see, written by the host's event adapter. */
  hostRows: Array<{ toolName?: string; toolStatus?: string; resultChars: number }>
  /** The fabricated tool result, anywhere in the entries this turn wrote. */
  fabricatedReminders: number
  transcriptFiles: number
  transcriptEntries: number
  replyExcerpt: string
}

/**
 * `tool_use` blocks, not a substring of the whole line.
 *
 * A raw `includes('"WebSearch"')` over the serialized entry also matches the
 * user prompt (which names the tool), a refusal that quotes it, and any system
 * text that lists it — so the old spelling could score a withheld turn as a
 * dispatched one on the strength of the prompt this case itself sends.
 */
function countWebSearchToolUses(entries: RuntimeSessionEntry[]): number {
  let n = 0
  for (const entry of entries) {
    const message = entry.raw.message as Record<string, unknown> | undefined
    const content = message && Array.isArray(message.content) ? message.content : []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as Record<string, unknown>
      if (b.type !== 'tool_use' && b.type !== 'server_tool_use') continue
      const name = typeof b.name === 'string' ? b.name : ''
      if (WEB_SEARCH_NAMES.some(candidate => name.toLowerCase() === candidate.toLowerCase())) n += 1
    }
  }
  return n
}

async function driveArm(
  run: CaseRun,
  session: CdpSession,
  label: string,
  slug: string,
  model: string | null,
): Promise<ArmReading> {
  const key = await freshSession(session, `${ID} ${label}`)
  run.require(`[${label}] a fresh session was created`, key.fresh, key.reason ?? '')
  const outcome = await switchRuntime(session, key.sessionId, slug)
  run.require(`[${label}] the session moved onto ${slug}`, outcome.ok, outcome.error ?? '')
  await waitForConnection(session, key.sessionId, slug).catch(() => undefined)
  const resolvedModel = model ? await selectModel(session, key, model) : null
  run.observe(`[${label}] connection`, { slug, requestedModel: model, resolvedModel })

  const startedMs = Date.now()
  const turn = await sendPrompt(session, key, SEARCH_PROMPT, TURN_TIMEOUT_MS)
  const reply = lastAssistantText(turn.added)

  const hostRows = turn.added
    .filter(m => m.toolName && WEB_SEARCH_NAMES.some(n => m.toolName!.toLowerCase().includes(n.toLowerCase())))
    .map(m => ({ toolName: m.toolName, toolStatus: m.toolStatus, resultChars: m.toolResult?.length ?? 0 }))

  const log = readClaudeTranscriptsSince(key.workspaceId, startedMs)
  const reading: ArmReading = {
    slug,
    model: resolvedModel,
    sdkToolUses: countWebSearchToolUses(log.entries),
    hostRows,
    fabricatedReminders: log.entries.filter(e => JSON.stringify(e.raw).includes(FABRICATED_REMINDER)).length,
    transcriptFiles: log.files.length,
    transcriptEntries: log.entries.length,
    replyExcerpt: reply.slice(0, 400),
  }
  run.observe(`[${label}] reading`, reading)
  return reading
}

async function body(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))
  const app = resolveAppUnderTest(session)
  run.observe('app-under-test', { kind: app.kind, via: app.via })
  if (app.kind !== 'packaged') {
    blocked(`this row is owed on the SHIPPED artefact; the CDP target is ${app.kind} (${app.targetUrl})`)
  }

  const connections = await listConnections(session)
  const claudeRows = connections.filter(row => runtimeOf(row.providerType) === 'anthropic')
  if (claudeRows.length === 0) {
    blocked(
      'no claude-runtime connection in this config dir. '
      + `The app lists: ${connections.map(c => `${c.slug}(${c.providerType})`).join(', ') || 'nothing'}`,
    )
  }

  // The wire stamp is what decides the product's behaviour, so it is read off
  // the connection rather than inferred from the slug. `listConnections` does
  // not carry it — reading it here keeps the change inside this case's zone.
  const wireByModel = await session.call<Array<{ slug: string; providerType: string; models: Array<{ id: string; wire?: string; contextWindow?: number }> }>>(`
    const rows = await window.electronAPI.listLlmConnections()
    return (rows ?? []).map(c => ({
      slug: c.slug,
      providerType: c.providerType,
      models: Array.isArray(c.models)
        ? c.models.map(m => ({ id: m.id, wire: m.wire, contextWindow: m.contextWindow }))
        : [],
    }))
  `)
  run.observe('claude-runtime connections and their wires', wireByModel.filter(r => runtimeOf(r.providerType) === 'anthropic'))

  const gateway = claudeRows.find(row => row.providerType === 'claude-runtime' && row.slug === 'claude-gateway')
    ?? claudeRows[0]!

  // A NATIVE-wire arm: a model stamped `anthropic-messages` on a claude-runtime
  // connection. Preferring a 1M-window model exercises P3.319's `[1m]`
  // normalisation on a live turn instead of assuming it.
  let nativeSlug: string | null = null
  let nativeModel: string | null = null
  for (const row of wireByModel) {
    if (runtimeOf(row.providerType) !== 'anthropic') continue
    const native = row.models.filter(m => m.wire === 'anthropic-messages')
    if (native.length === 0) continue
    const wide = native.find(m => (m.contextWindow ?? 0) >= 1_000_000)
    nativeSlug = row.slug
    nativeModel = (wide ?? native[0]!).id
    if (wide) break
  }
  run.observe('native-wire arm resolved', { slug: nativeSlug, model: nativeModel, oneMillion: nativeModel?.includes('[1m]') ?? false })

  const gatewayArm = await driveArm(run, session, 'gateway', gateway.slug, null)

  if (!nativeSlug || !nativeModel) {
    // Honest, and NOT a pass: without the positive arm this sitting cannot tell
    // a withheld tool from a broken detector, which is the one thing the row
    // asks it to separate.
    run.observe('native-wire arm', 'absent from this config dir')
    blocked(
      'no claude-runtime model stamped `wire: "anthropic-messages"` in this config dir, so the positive control '
      + 'for the withholding cannot be driven. The gateway arm read: '
      + JSON.stringify({ sdkToolUses: gatewayArm.sdkToolUses, hostRows: gatewayArm.hostRows.length })
      + ' — recorded, not scored.',
    )
  }

  const nativeArm = await driveArm(run, session, 'native-wire', nativeSlug, nativeModel)

  // The cross-arm control FIRST: it decides whether the two verdicts below mean
  // anything at all.
  const detectorAlive = nativeArm.sdkToolUses > 0
  run.check(
    'the detector can see a WebSearch call at all (native-wire arm)',
    detectorAlive,
    detectorAlive
      ? `${nativeArm.sdkToolUses} tool_use block(s) on ${nativeArm.slug}/${nativeArm.model}`
      : 'NEITHER arm shows the tool. Two arms showing absence means the DETECTOR is broken, not that the '
        + 'product withholds — do not read the gateway result below as a product verdict.',
  )

  run.check(
    'the gateway arm withholds the tool from the model',
    gatewayArm.sdkToolUses === 0 && gatewayArm.hostRows.length === 0,
    `sdk tool_use ${gatewayArm.sdkToolUses}, host rows ${gatewayArm.hostRows.length} `
    + `over ${gatewayArm.transcriptEntries} transcript entries in ${gatewayArm.transcriptFiles} file(s)`,
  )

  run.check(
    'no fabricated search result reaches the gateway transcript',
    gatewayArm.fabricatedReminders === 0,
    `${gatewayArm.fabricatedReminders} entr(ies) carry the reminder text`,
  )

  // Recorded, never asserted: on the native arm this is the vendor's own text
  // arriving through the vendor's own path.
  run.observe('native-wire arm reminder occurrences (recorded, not asserted)', nativeArm.fabricatedReminders)

  run.check(
    'the gateway turn still produced an answer rather than an error',
    gatewayArm.replyExcerpt.trim().length > 0,
    gatewayArm.replyExcerpt.slice(0, 120),
  )

  run.observe('VERDICT', {
    gateway: { slug: gatewayArm.slug, sdkToolUses: gatewayArm.sdkToolUses, hostRows: gatewayArm.hostRows.length },
    nativeWire: { slug: nativeArm.slug, model: nativeArm.model, sdkToolUses: nativeArm.sdkToolUses },
    oneMillionExercised: nativeArm.model?.includes('[1m]') ?? false,
  })
}

if (import.meta.main) {
  const result = await runCase(ID, TITLE, body, { timeoutMs: CDP_COMMAND_TIMEOUT_MS })
  process.exit(exitCodeFor(result.status))
}

export { ID, TITLE, body }
