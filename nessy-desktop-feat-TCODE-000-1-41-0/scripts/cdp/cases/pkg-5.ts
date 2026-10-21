/**
 * PKG-5 — P3.202: codex's on-demand image read-back, end to end, on the shipped
 * artefact.
 *
 * `view_image` is declared (`[features] view_image = true`, P3.116) and the
 * runtime-switch handover hands codex an image as a NAMED PATH the model opens
 * when it needs it (P3.54/P3.151). Nobody had run that path. The row arrived
 * with a NAMED SUSPECT, and the suspect is what gives this case its shape:
 *
 * > the pointer we hand codex targets the session attachments store, which sits
 * > OUTSIDE the workspace, while `writeCodexConfig` emits
 * > `[permissions.<profile>]` with `extends = ':workspace'` plus a deny map. If
 * > the profile's filesystem scope does not reach the attachments directory,
 * > `view_image` refuses on a path it was handed — and the failure would read as
 * > *the model declined*, not as *we fenced it out*.
 *
 * ## The instrument, and why it is stronger than the row assumed
 *
 * `runtime-session-log.ts` says of codex: **"Codex — nothing."** `codex-agent.ts`
 * mints `CODEX_HOME` with `mkdtempSync` and `rmSync`es it on teardown, so a case
 * looking for codex's own record AFTER a session ends finds no home (F1.652: in either root).
 *
 * That is true of teardown and NOT true of the live window. While the session's
 * runtime is up, the home is on disk at 0700 with the config we wrote AND
 * `sessions/**\/rollout-*.jsonl`, which codex writes itself. Read it during the
 * run and the codex arm stops being instrument-less:
 *
 *  - **`config.toml`** — the `[permissions.nessy_runtime]` block the host emitted,
 *    i.e. the input to the suspect.
 *  - **the rollout's `turn_context`** — codex's own RESOLVED
 *    `permission_profile`, `workspace_roots` and `sandbox_policy`. This is the
 *    output: what the binary decided our config meant. A host that emitted the
 *    right TOML and a codex that compiled it into something else would be
 *    invisible to a config-only read, and that gap is exactly where the suspect
 *    lives.
 *  - **the rollout's `response_item` entries** — every `function_call` and
 *    `function_call_output` of the turn, so "was `view_image` called, and what
 *    came back" is a reading from codex rather than from the model's prose.
 *
 * The home is matched to THIS session by the `--session-id` argument the host
 * writes into `[mcp_servers.session]`, never by "newest": a second codex session
 * in another window would otherwise donate its rollout to this verdict.
 *
 * ## Where the two probe images go, and why one of them may NOT go to /tmp
 *
 * The out-of-workspace probe is written into the session's OWN attachments
 * directory — `<config>/sessions/<ws>/<sid>/attachments/` — which is the exact
 * store the handover pointer names. A probe placed in `tmpdir()` instead would
 * have passed for free and measured the wrong thing: codex's resolved profile
 * carries explicit `write` grants for the `tmpdir` and `slash_tmp` specials, so
 * a temp path is covered by an entry the attachments store is not covered by.
 * Same reason the in-workspace control is a real file in the fixture project
 * rather than a path asserted about.
 *
 * Both files are removed at the end, by absolute path, only if their basename is
 * the one this run minted.
 *
 * ## The control does real work here
 *
 * Three outcomes, three different findings, and only the pair separates them:
 *
 *  - both arms read back  → the read-back works; the suspect is refuted.
 *  - **only** the attachments arm fails → the suspect is CONFIRMED, and the
 *    fence is ours.
 *  - both arms fail the same way → not a permission problem at all. On the
 *    gateway that is the expected shape: `view_image` returns an IMAGE CONTENT
 *    ITEM, and P3.114/P3.280 measured the gateway answering one with
 *    `400 Invalid Chat Message Part: Model Does Not Support Image Inputs`. A
 *    capability declared, reachable, and useless — for modality, not for path.
 *
 * If neither arm produces a call at all, an advertisement turn separates "the
 * tool was never offered" from "it was offered and the model chose prose"
 * (PKG-3's lesson). Nothing about the model's opinion is scored; the verdict
 * rides the rollout.
 */

import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import { resolveAppUnderTest } from '../lib/bundle.ts'
import type { CdpSession } from '../lib/connect.ts'
import { fixturePaths } from '../fixtures/runtime-switch.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { blocked, exitCodeFor, runCase, type CaseRun } from '../lib/report.ts'
import { configDir, sessionStoragePath } from '../lib/runtime-session-log.ts'
import { codexHomeRoots, listCodexHomes } from '../lib/codex-session-log.ts'
import {
  listConnections,
  runtimeOf,
  bindProject,
  switchRuntime,
  trustFixtureProject,
  waitForConnection,
} from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, isProcessing, listSessions, waitFor } from '../lib/state.ts'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'

const ID = 'PKG-5'
const TITLE = 'P3.202: codex opens an image handed to it as a path — in the attachments store and in the workspace'

const TURN_TIMEOUT_MS = 300_000
const CDP_COMMAND_TIMEOUT_MS = 240_000

/**
 * Two 24×24 solid-colour PNGs, distinct so a vision-capable model could tell
 * them apart. Generated rather than embedded from a real screenshot: the
 * assertion is on codex's `function_call`, and a picture whose content nobody
 * can predict makes the model's answer look like the detector.
 */
const PNG_RED =
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAI0lEQVR4nGO4IyJCFcQwatBoGI2mo9EsMlqMjJaQdwa8FgEACkRJH3RIcp4AAAAASUVORK5CYII='
const PNG_BLUE =
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAI0lEQVR4nGMQEblDFcQwatBoGI2mo9EsMlqMjJaQIgNeiwAAhghJH6K0DQ8AAAAASUVORK5CYII='

/** Names `view_image` can reach a rollout under. */
const VIEW_IMAGE_NAMES = ['view_image', 'viewimage', 'view-image'] as const

interface CodexHome {
  dir: string
  configToml: string
  rolloutFile?: string
  rolloutEntries: Record<string, unknown>[]
}

/**
 * The live `CODEX_HOME` for one session.
 *
 * Matched on the `--session-id` the host writes into `[mcp_servers.session]`
 * rather than on mtime. `createRuntime` mints one home per runtime, so a second
 * codex session anywhere in the app produces a second directory whose rollout
 * would otherwise be read as this session's.
 */
function findCodexHome(sessionId: string): CodexHome | { reason: string } {
  // F1.652 — the host root under the config dir first, then the OS temp dir (the fallback).
  const roots = codexHomeRoots()
  const root = roots.join(' and ')
  const candidates = listCodexHomes(roots)
  const seen: string[] = []
  for (const dir of candidates) {
    const config = join(dir, 'config.toml')
    if (!existsSync(config)) continue
    let text: string
    try {
      text = readFileSync(config, 'utf8')
    } catch {
      continue
    }
    seen.push(dir)
    if (!text.includes(sessionId)) continue
    return { dir, configToml: text, ...readRollout(dir) }
  }
  return {
    reason:
      `no-codex-home-for-session: ${candidates.length} nessy-codex-home-* under ${root}`
      + `${seen.length ? ` (${seen.length} readable)` : ''}, none naming ${sessionId}. `
      + 'The runtime is torn down with the session, so this read must happen while it is still up.',
  }
}

/** Codex's own rollout for that home — every JSONL line under `sessions/`. */
function readRollout(dir: string): { rolloutFile?: string; rolloutEntries: Record<string, unknown>[] } {
  const sessions = join(dir, 'sessions')
  if (!existsSync(sessions)) return { rolloutEntries: [] }
  const files: string[] = []
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const child = join(current, name)
      if (statSync(child).isDirectory()) walk(child)
      else if (name.endsWith('.jsonl')) files.push(child)
    }
  }
  walk(sessions)
  if (files.length === 0) return { rolloutEntries: [] }
  const newest = files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]!
  const entries: Record<string, unknown>[] = []
  for (const line of readFileSync(newest, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push(JSON.parse(trimmed) as Record<string, unknown>)
    } catch { /* a partially written line is not evidence */ }
  }
  return { rolloutFile: newest, rolloutEntries: entries }
}

interface ResolvedProfile {
  workspaceRoots: string[]
  sandboxPolicy?: unknown
  entries: { access: string; kind: string; value: string }[]
}

/**
 * The permission profile CODEX resolved, out of the rollout's `turn_context`.
 *
 * The point of reading the resolved form rather than our own TOML: the suspect
 * is about a scope, and a scope is what the binary compiled, not what we wrote.
 */
function readResolvedProfile(entries: Record<string, unknown>[]): ResolvedProfile | undefined {
  for (const entry of [...entries].reverse()) {
    if (entry.type !== 'turn_context') continue
    const payload = entry.payload as Record<string, unknown> | undefined
    if (!payload) continue
    const profile = payload.permission_profile as Record<string, unknown> | undefined
    const fs = profile?.file_system as Record<string, unknown> | undefined
    const raw = Array.isArray(fs?.entries) ? fs!.entries as Record<string, unknown>[] : []
    return {
      workspaceRoots: Array.isArray(payload.workspace_roots) ? payload.workspace_roots.map(String) : [],
      sandboxPolicy: payload.sandbox_policy,
      entries: raw.map(item => {
        const path = item.path as Record<string, unknown> | undefined
        const special = path?.value as Record<string, unknown> | undefined
        return {
          access: String(item.access ?? ''),
          kind: String(path?.type ?? ''),
          value: String(path?.path ?? path?.pattern ?? special?.kind ?? ''),
        }
      }),
    }
  }
  return undefined
}

interface ToolCall {
  name: string
  arguments: string
  /** The output payload as text, whatever shape it took. */
  output: string
  /** True when the output carried an image content item rather than text. */
  carriedImage: boolean
}

/**
 * Every tool call in the rollout, with what came back.
 *
 * `function_call_output.output` is EITHER a string OR an array of
 * `FunctionCallOutputContentItem` — the array is how `view_image` hands back a
 * picture (`to-chat.ts`, P3.114). Both are recorded, and which one arrived is
 * the difference between "codex read the file" and "codex refused".
 */
function readToolCalls(entries: Record<string, unknown>[]): ToolCall[] {
  const calls = new Map<string, ToolCall>()
  const order: string[] = []
  for (const entry of entries) {
    if (entry.type !== 'response_item') continue
    const payload = entry.payload as Record<string, unknown> | undefined
    if (!payload) continue
    const type = String(payload.type ?? '')
    const callId = String(payload.call_id ?? payload.id ?? '')
    if (type === 'function_call' || type === 'custom_tool_call' || type === 'local_shell_call') {
      const name = String(payload.name ?? type)
      calls.set(callId, {
        name,
        arguments: typeof payload.arguments === 'string' ? payload.arguments : JSON.stringify(payload.arguments ?? ''),
        output: '',
        carriedImage: false,
      })
      order.push(callId)
      continue
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'local_shell_call_output') {
      const existing = calls.get(callId)
      const output = (payload as { output?: unknown }).output
      const text = typeof output === 'string' ? output : JSON.stringify(output ?? '')
      const carriedImage = Array.isArray(output)
        && output.some(item => String((item as { type?: unknown })?.type ?? '').includes('image'))
      if (existing) {
        existing.output = text
        existing.carriedImage = carriedImage
      } else {
        calls.set(callId, { name: '(output with no call)', arguments: '', output: text, carriedImage })
        order.push(callId)
      }
    }
  }
  return order.map(id => calls.get(id)!).filter(Boolean)
}

/**
 * Bind the session to `dir`, and VERIFY it rather than trusting the call.
 *
 * `sessionCommand` is answered by the renderer over an IPC channel with its own
 * 30 s timeout, and the second arm of this case reliably tripped it: the request
 * lands while the PREVIOUS arm's codex runtime is still tearing down (a child
 * process, an in-process adapter and a `rmSync` of the managed `CODEX_HOME`), so
 * the reply misses the window. The throw is not the bind failing — the next read
 * shows the directory bound — so a case that lets it propagate loses an arm to a
 * queue rather than to a finding.
 *
 * Verified against the session's own `workingDirectory`, so a silent no-op is
 * still caught.
 */
function isViewImage(name: string): boolean {
  const lower = name.toLowerCase()
  return VIEW_IMAGE_NAMES.some(candidate => lower.includes(candidate))
}

/** True when `path` sits under one of codex's own workspace roots. */
function insideRoots(path: string, roots: string[]): boolean {
  const target = resolvePath(path)
  return roots.some(root => target === resolvePath(root) || target.startsWith(`${resolvePath(root)}/`))
}

interface ArmSpec {
  label: string
  colour: string
  /** base64 PNG written to disk for this arm. */
  png: string
  /**
   * `attachments` → the arm's own session attachment store, OUTSIDE codex's
   * workspace root; `workspace` → the fixture project, inside it.
   */
  place: 'attachments' | 'workspace'
  nonce: string
}

interface ArmResult {
  label: string
  file: string
  sessionId: string
  reply: string
  /** codex's own record for THIS arm's session. */
  home: CodexHome | { reason: string }
  viewImageCalls: ToolCall[]
  readBack: boolean
}

/**
 * One arm, in a session of its OWN.
 *
 * **The two arms may not share a session, and the first run of this case is
 * why.** Run back to back in one conversation, the attachments arm succeeded —
 * `view_image` returned `{"type":"input_image", …}` — and the in-workspace
 * control that followed produced an EMPTY assistant reply and no tool call at
 * all. That is not the control failing: it is the FIRST arm's image sitting in
 * the conversation the second turn replays, which the gateway model refuses
 * (`400 Invalid Chat Message Part: Model Does Not Support Image Inputs`,
 * P3.114/P3.280). Scored as a control it says "the workspace path is fenced and
 * the attachments path is not", which is the exact inverse of the truth. A fresh
 * session per arm is the only form of this pair that measures the paths rather
 * than the order they were asked in.
 *
 * The prompt is phrased POSITIVELY and names no tool it must not call —
 * AGENTS.md's Guardian trap. The path is the whole instruction, which is also
 * the shape the real handover note uses (three facts, no imperative — P3.151).
 */
async function runArm(
  run: CaseRun,
  session: CdpSession,
  connectionSlug: string,
  projectDir: string,
  spec: ArmSpec,
): Promise<ArmResult> {
  const { label, colour, png, place } = spec
  const key = await freshSession(session, `${ID} ${label}`)
  run.require(`[${label}] a fresh session was created`, key.fresh, key.reason ?? '')
  // F1.182 — one spelling of the bind, in `lib/runtime-switch.ts`. This case's
  // own copy is where property 2 was measured (`Request timeout:
  // sessions:command (30000ms)` on a mutation that LANDED), and the shared
  // helper keeps the throw as evidence beside the read-back rather than
  // retrying three times the way this copy did.
  const bind = await bindProject(run, session, key.sessionId, projectDir, {
    label: `[${label}]`, gate: () => trustFixtureProject(session),
  })
  run.observe(`${label} · working-directory bind`, bind)
  await waitFor(() => isProcessing(session, key), busy => !busy, { timeoutMs: 60_000, intervalMs: 500 })
    .catch(() => undefined)
  const outcome = await switchRuntime(session, key.sessionId, connectionSlug)
  run.require(`[${label}] the session moved onto the codex connection`, outcome.ok, outcome.error ?? '')
  await waitForConnection(session, key.sessionId, connectionSlug).catch(() => undefined)

  // The probe file is placed relative to THIS arm's own session, which is why it
  // is written here and not by the caller: the attachments store is per-session,
  // and the whole point of the outside arm is that it is the store the handover
  // pointer names for the session doing the reading.
  const file = place === 'attachments'
    ? join(sessionStoragePath(key), 'attachments', `pkg5-outside-${spec.nonce}.png`)
    : join(projectDir, `pkg5-inside-${spec.nonce}.png`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, Buffer.from(png, 'base64'))
  run.observe(`${label} · probe file`, { file, bytes: statSync(file).size })

  const turn = await sendPrompt(
    session,
    key,
    `There is a PNG image on disk at ${file}. Look at that image and tell me, in one short line, `
    + 'what single colour fills it. If you cannot open it, say what stopped you, verbatim.',
    TURN_TIMEOUT_MS,
  )
  const reply = lastAssistantText(turn.added)
  run.observe(`${label} · expected colour`, colour)
  run.observe(`${label} · reply`, reply.slice(0, 400))
  // EVERY added message, not just the assistant's. An upstream refusal arrives
  // as its own row and the first run of this case had an empty reply with no
  // clue in it; a role+excerpt dump is what makes that legible next time.
  run.observe(
    `${label} · every added transcript row`,
    turn.added.map(m => ({
      role: m.role,
      tool: m.toolName,
      status: m.toolStatus,
      excerpt: (m.content || m.toolResult || '').slice(0, 200),
    })),
  )

  // Read codex's own record while this arm's runtime is still up.
  const home = findCodexHome(key.sessionId)
  const calls = 'dir' in home ? readToolCalls(home.rolloutEntries) : []
  const viewImageCalls = calls.filter(c => isViewImage(c.name) && c.arguments.includes(basename(file)))
  run.observe(`${label} · codex home`, 'dir' in home
    ? { dir: home.dir, rollout: home.rolloutFile, entries: home.rolloutEntries.length }
    : home.reason)
  run.observe(`${label} · tool calls in codex's own rollout`, calls.map(c => ({
    name: c.name,
    args: c.arguments.slice(0, 200),
    carriedImage: c.carriedImage,
    output: c.output.slice(0, 200),
  })))

  return {
    label,
    file,
    sessionId: key.sessionId,
    reply,
    home,
    viewImageCalls,
    readBack: viewImageCalls.some(c => c.carriedImage),
  }
}

async function body(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))
  const app = resolveAppUnderTest(session)
  run.observe('app-under-test', { kind: app.kind, via: app.via })
  // Which profile the file reads came from. `configDir()` answers
  // `~/.nessy-agent` unless the case process was given `NESSY_CONFIG_DIR`, and a
  // case reading one profile while the app runs on another reports 0 of
  // everything (SKL-P1's trap).
  run.observe('config dir this case reads', configDir())
  if (app.kind !== 'packaged') {
    blocked(`this row is owed on the SHIPPED artefact; the CDP target is ${app.kind} (${app.targetUrl})`)
  }

  const connections = await listConnections(session)
  const codex = connections.find(row => row.slug === 'codex-gateway')
    ?? connections.find(row => runtimeOf(row.providerType) === 'codex-runtime')
  if (!codex) {
    blocked(
      'no codex-runtime connection in this config dir. '
      + `The app lists: ${connections.map(c => `${c.slug}(${c.providerType})`).join(', ') || 'nothing'}`,
    )
  }
  run.observe('connection', { slug: codex.slug, providerType: codex.providerType, model: codex.defaultModel })

  const { projectDir } = fixturePaths()
  if (!existsSync(projectDir)) {
    blocked(
      `the runtime-switch fixture project is missing (${projectDir}). It is the only directory `
      + '`trustFixtureProject` will answer the trust gate for, and the in-workspace control needs a real one.',
    )
  }

  const nonce = Math.random().toString(16).slice(2, 10).toUpperCase()
  const written: string[] = []
  try {
    // ORDER: the positive control FIRST. If a rig fault takes the second arm,
    // the reading that survives should be the one that says the instrument works.
    const inside = await runArm(run, session, codex.slug, projectDir, {
      label: 'workspace (positive control)',
      colour: 'blue',
      png: PNG_BLUE,
      place: 'workspace',
      nonce,
    })
    written.push(inside.file)
    const outside = await runArm(run, session, codex.slug, projectDir, {
      label: 'attachments-store (outside the workspace)',
      colour: 'red',
      png: PNG_RED,
      place: 'attachments',
      nonce,
    })
    written.push(outside.file)

    // ---- the mechanism half: what the host wrote, what codex resolved --------
    //
    // Read off the OUTSIDE arm, because that is the session whose scope the row
    // is about. Its own `turn_context` is codex's compiled view of our TOML.
    if (!('dir' in outside.home)) {
      run.observe('codex home (outside arm)', outside.home.reason)
      blocked(
        `${outside.home.reason} Without codex's own rollout the live half of this row rests on the model's `
        + 'prose, which is the detector this case exists to avoid.',
      )
    }
    const emitted = outside.home.configToml
    const permissionsAt = emitted.indexOf('[permissions.')
    run.observe(
      'emitted [permissions.*] (verbatim)',
      permissionsAt >= 0 ? emitted.slice(permissionsAt, permissionsAt + 1200) : '(no [permissions.*] block emitted)',
    )
    run.observe(
      'emitted top-level policy lines',
      emitted.split('\n').filter(line => /^(sandbox_mode|approval_policy|default_permissions)\b/.test(line)),
    )

    const resolved = readResolvedProfile(outside.home.rolloutEntries)
    if (!resolved) {
      blocked('codex\'s rollout carried no turn_context, so the resolved permission profile could not be read')
    }
    run.observe('codex workspace_roots', resolved.workspaceRoots)
    run.observe('codex sandbox_policy (resolved)', resolved.sandboxPolicy)
    run.observe('codex resolved filesystem entries', resolved.entries)

    const attachmentsDir = dirname(outside.file)

    // The row's PREMISE. If this is false the suspect cannot even be posed, and
    // a green run below would be green for the wrong reason.
    run.check(
      'the attachments store lies OUTSIDE codex\'s own workspace roots',
      resolved.workspaceRoots.length > 0 && !insideRoots(attachmentsDir, resolved.workspaceRoots),
      `${attachmentsDir} vs roots ${JSON.stringify(resolved.workspaceRoots)}`,
    )
    run.check(
      'the in-workspace control lies INSIDE them',
      insideRoots(inside.file, resolved.workspaceRoots),
      `${inside.file} vs roots ${JSON.stringify(resolved.workspaceRoots)}`,
    )

    // The suspect itself, answered against the RESOLVED profile: a read grant
    // covering the attachments path, and no deny entry that takes it back.
    const rootRead = resolved.entries.find(e => e.kind === 'special' && e.value === 'root')
    const denyHits = resolved.entries.filter(
      e => e.access === 'deny' && e.kind === 'path' && insideRoots(attachmentsDir, [e.value]),
    )
    run.check(
      'codex\'s resolved profile grants read at the filesystem root',
      rootRead?.access === 'read' || rootRead?.access === 'write',
      rootRead ? `root → ${rootRead.access}` : 'no root entry in the resolved profile',
    )
    run.check(
      'no deny entry covers the attachments store',
      denyHits.length === 0,
      denyHits.length === 0 ? 'none of the deny entries is an ancestor of it' : JSON.stringify(denyHits),
    )

    // ---- the live half ------------------------------------------------------
    run.observe('view_image calls per arm', {
      workspace: inside.viewImageCalls.length,
      attachments: outside.viewImageCalls.length,
    })

    if (inside.viewImageCalls.length === 0 && outside.viewImageCalls.length === 0) {
      // Advertisement control (PKG-3's lesson): no call is two findings.
      const controlKey = await freshSession(session, `${ID} advertisement ${nonce}`)
      await bindProject(run, session, controlKey.sessionId, projectDir, {
        label: '[advertisement control]', gate: () => trustFixtureProject(session),
      })
      await switchRuntime(session, controlKey.sessionId, codex.slug)
      await waitForConnection(session, controlKey.sessionId, codex.slug).catch(() => undefined)
      const control = await sendPrompt(
        session,
        controlKey,
        'Without calling anything: list the exact names of the tools you were given that can open or '
        + 'display a local image file. If you were given none, reply with exactly: NONE',
        TURN_TIMEOUT_MS,
      )
      const controlText = lastAssistantText(control.added)
      run.observe('advertisement control (verbatim, unscored)', controlText.slice(0, 600))
      const advertised = isViewImage(controlText)
      run.check(
        'codex opened an image handed to it as a path',
        false,
        advertised
          ? 'the model names an image tool and codex\'s rollout carries no call — the offer is real and the call is not'
          : 'no image tool reached the model at all, so this run measured ADVERTISEMENT, not the permission scope. '
            + 'The mechanism checks above still stand: the path is not fenced.',
      )
      run.observe('VERDICT (P3.202)', {
        premiseAttachmentsOutsideWorkspace: !insideRoots(attachmentsDir, resolved.workspaceRoots),
        suspectPathFencedOut: false,
        rootAccess: rootRead?.access,
        viewImageCalled: false,
        imageToolAdvertised: advertised,
      })
      return
    }

    run.check(
      'the in-workspace control read back an image (the positive control)',
      inside.readBack,
      inside.viewImageCalls.length === 0
        ? 'the model never called the tool on the in-workspace path'
        : `carriedImage=${inside.viewImageCalls.map(c => c.carriedImage).join('/')}; `
          + `output ${inside.viewImageCalls[0]!.output.slice(0, 160)}`,
    )
    run.check(
      'the attachments-store path read back an image too',
      outside.readBack,
      outside.viewImageCalls.length === 0
        ? 'the model never called the tool on the attachments path'
        : `carriedImage=${outside.viewImageCalls.map(c => c.carriedImage).join('/')}; `
          + `output ${outside.viewImageCalls[0]!.output.slice(0, 160)}`,
    )
    // THE row. A fence shows up as a DIFFERENCE between the two paths; anything
    // that hits both is not about the permission scope at all.
    run.check(
      'both paths behaved the SAME — the suspect is a fence only if they differ',
      outside.readBack === inside.readBack,
      `attachments=${outside.readBack} workspace=${inside.readBack}`,
    )
    run.observe('VERDICT (P3.202)', {
      premiseAttachmentsOutsideWorkspace: !insideRoots(attachmentsDir, resolved.workspaceRoots),
      rootAccess: rootRead?.access,
      workspaceArmReadBack: inside.readBack,
      attachmentsArmReadBack: outside.readBack,
      suspectConfirmed: inside.readBack && !outside.readBack,
    })
  } finally {
    // Only the files this run minted, by absolute path, name-guarded twice.
    for (const file of written) {
      if (basename(file).startsWith('pkg5-') && basename(file).includes(nonce)) {
        try { rmSync(file, { force: true }) } catch { /* a leftover probe is not a failure */ }
      }
    }
  }
}

if (import.meta.main) {
  const result = await runCase(ID, TITLE, body, { timeoutMs: CDP_COMMAND_TIMEOUT_MS })
  process.exit(exitCodeFor(result.status))
}

export { ID, TITLE, body }
