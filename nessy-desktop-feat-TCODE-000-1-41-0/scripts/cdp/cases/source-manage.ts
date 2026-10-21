/**
 * SOURCE-MANAGE — the agent turns a source off, and removes it, live.
 *
 * D3 gave the agent one tool with two actions so that "remove this source"
 * stops meaning "raw-edit files and skip the UI channel's cleanup". The live
 * value of this case is that it exercises the HOST BINDING, which is where D3
 * first shipped broken: `remove` answered "not available in this context" on
 * every Pi session because the seam was threaded only through
 * `session-scoped-tools.ts` while Pi builds its own context (fixed 4e07f3abd).
 * A unit test cannot see that; this case can.
 *
 * The subject is created BY THE RUN and removed by it — never one of the
 * operator's own sources.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession, setPermissionMode } from '../lib/state.ts'
import { sendPrompt } from '../lib/chat.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { configDir } from '../lib/runtime-session-log.ts'

const ID = 'SOURCE-MANAGE'
const TITLE = 'The agent disables and then removes a source it created — through the shipped tool, on a real session'

const SLUG = 'cdp-source-manage-probe'
/** Credential-free stdio MCP server from the mcp-naming fixture tree. */
const PROBE = `${process.env.HOME}/nessy-cdp-g6/probe/scoped-sanitized.mjs`

/**
 * Sources are read FROM DISK, not through the renderer API: there is no
 * `window.electronAPI.getSources` (measured 2026-08-14 — the same rig fact that
 * killed `loadSourceConfig`), and the product writes these files itself, so
 * they are the honest witness for "was it created" and "was it removed".
 */
function sourcesDir(workspaceId: string): string {
  return join(configDir(), 'workspaces', workspaceId, 'sources')
}

function sourceSlugs(workspaceId: string): string[] {
  try {
    return readdirSync(sourcesDir(workspaceId), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
  } catch {
    return []
  }
}

function sourceEnabled(workspaceId: string, slug: string): boolean | null {
  try {
    const raw = readFileSync(join(sourcesDir(workspaceId), slug, 'config.json'), 'utf-8')
    return (JSON.parse(raw) as { enabled?: boolean }).enabled ?? null
  } catch {
    return null
  }
}

/**
 * A runtime error recorded in the session's OWN transcript, if any.
 *
 * Without this the case cannot tell "the tool ran and did nothing" from "the
 * turn never ran at all", and it blames the wrong subsystem. Measured
 * 2026-08-14: the `remove` turn died on
 * `Pi subprocess error: Stale runtime agent definition: agent::global::…`
 * — a leftover agent file in `~/.nessy-agent/agents/`, nothing to do with
 * `source_manage` — and a case without this check reported it as
 * "remove does not reach its host binding", which is precisely the D3 defect
 * that had already been fixed. A wrong re-open is worse than no finding.
 */
function runtimeError(workspaceId: string, sessionId: string): string | null {
  try {
    const path = join(configDir(), 'sessions', workspaceId, sessionId, 'session.jsonl')
    const rows = readFileSync(path, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { type?: string; content?: unknown })
    const last = rows.filter(r => r?.type === 'error').at(-1)
    return last ? String(last.content ?? 'unnamed error') : null
  } catch {
    return null
  }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))

  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', key)
  await setPermissionMode(session, key.sessionId, 'bypassPermissions')
  await Bun.sleep(4_000)

  const before = sourceSlugs(key.workspaceId)
  run.observe('sources before', before)
  if (before.includes(SLUG)) {
    blocked(`a source named ${SLUG} already exists — a previous run did not clean up; remove it before measuring`)
  }

  // THE DRIVER creates the source, not the model — and that is the point, not a
  // shortcut.
  //
  // The subject of this case is `source_manage`, and a source's provenance is
  // irrelevant to whether the tool can disable and remove one. Three runs on
  // 2026-08-14 proved that letting the model do the setup measures the model
  // instead: run A needed three Write attempts to converge on the schema, run B
  // spent the whole 300 s window reading the sources skill and left a bare
  // directory, run C's Write sat unanswered on a `file_write` permission
  // request for the full window even though the session was in
  // `bypassPermissions` (recorded as an open question, NOT assumed here). Every
  // one of those is a BLOCKED result carrying no information about
  // `source_manage`.
  //
  // Writing it here makes setup deterministic, and it costs the case nothing:
  // `sourceExists`, `loadSourceConfig` and `removeSourceEverywhere` are all
  // filesystem-driven, so a driver-written source is the same subject the UI
  // channel would hand the tool.
  mkdirSync(join(sourcesDir(key.workspaceId), SLUG), { recursive: true })
  writeFileSync(join(sourcesDir(key.workspaceId), SLUG, 'config.json'), `${JSON.stringify({
    id: SLUG, slug: SLUG, type: 'mcp', name: 'CDP source-manage probe', enabled: true, provider: 'custom',
    mcp: { transport: 'stdio', command: 'node', args: [PROBE], authType: 'none' },
  }, null, 2)}\n`, 'utf-8')

  // Setup's own postcondition. A bare DIRECTORY would sail past a listing
  // check: the product's `sourceExists` gate is directory-based
  // (`source-helpers.ts:42`) while `loadSourceConfig` needs the file, so a
  // config-less source makes `disable` answer "has no readable config.json" —
  // which reads exactly like a tool defect. Asserted here so setup can never be
  // mistaken for the measurement.
  const created = sourceSlugs(key.workspaceId)
  run.observe('sources after create', created)
  run.require('setup: the probe source exists with a readable config',
    created.includes(SLUG) && sourceEnabled(key.workspaceId, SLUG) === true,
    `slugs=${created.join(',')} enabled=${sourceEnabled(key.workspaceId, SLUG)}`)

  await sendPrompt(session, key,
    `Now use source_manage with sourceSlug "${SLUG}" and action "disable", then tell me what it returned.`,
    240_000).catch(() => undefined)
  const enabled = sourceEnabled(key.workspaceId, SLUG)
  run.check('source_manage: disable flips enabled to false through the validated writer', enabled === false, `config.json enabled is ${enabled}`)

  await sendPrompt(session, key,
    `Now use source_manage with sourceSlug "${SLUG}" and action "remove", then tell me what it returned.`,
    240_000).catch(() => undefined)
  const after = sourceSlugs(key.workspaceId)
  run.observe('sources after remove', after)

  // Before blaming the tool: did the turn run at all?
  const failure = runtimeError(key.workspaceId, key.sessionId)
  if (failure && after.includes(SLUG)) {
    run.observe('runtime error', failure)
    blocked(`the remove turn never executed — the runtime failed with: ${failure}. `
      + 'This is not a source_manage result; fix the runtime failure and re-run.')
  }

  // THE regression this case exists for: the host binding must reach the tool
  // on the runtime this session actually runs.
  run.check('source_manage: remove reaches its host binding and deletes the source', !after.includes(SLUG))
  run.check("the operator's own sources are untouched", before.every(slug => after.includes(slug)), `before=${before.join(',')} after=${after.join(',')}`)
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
