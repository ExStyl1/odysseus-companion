/**
 * RS-107 - SIT-11 surface C: the PLUGIN path, as a case file instead of a hand
 * drive (F1.148) - and the first time C6/C7 can be driven on `pi` at all.
 *
 * ## Why this case exists
 *
 * SIT-11 (2026-09-20, packaged 1.40.0) passed surface C by hand. On `pi` two arms
 * were NOT_DRIVABLE - no shipped fixture carried a plugin COMMAND or a plugin
 * HOOK - and the claude and codex lanes each minted the missing bundle in a
 * scratch directory and threw it away. That bundle is now a fixture
 * (`fixtures/mcp-naming.ts`, `buildCmdHookFixture`: one prompt command, a
 * `PreToolUse` hook on `Bash` and a `PostToolUse` hook with no matcher, registry
 * `market-c`), and this case carries every control the SIT-11 lanes paid for.
 *
 * ## The arms
 *
 * C1. **Install through the product's own door** - `marketplace.addRegistry` →
 *     the listing, polled by NAME → `marketplace.install`, the calls the Plugins
 *     page makes - into the config dir the run was launched with.
 * C3. **The posture the install lands in**, recorded rather than re-decided: the
 *     install record must carry BOTH capability kinds (`prompt-command`, `hook`).
 * C6. **The command is in the roster and dispatches its BODY**, per chosen
 *     runtime: the palette offers it BY NAME (a count alone moved 110 → 112 → 111
 *     at SIT-11 and discriminates nothing), and selecting it on a fresh chat
 *     brings back a token that exists ONLY in the command file's body.
 * C7. **A plugin hook fires behind the card D1.343 prescribes**, per chosen
 *     runtime, in `default` - the mode it measures, set and read back (the card
 *     is the subject, so this arm does not take the harness's bypass). The
 *     detectors are the hit files the hooks themselves write, read before and
 *     after; every hook that fired must have been ASKED about first (its marker
 *     on a card). Per runtime: claude fires `PreToolUse` (SIT-11); codex leaves
 *     `PreToolUse` unwired by design and fires `PostToolUse`, so the pair is the
 *     documented null beside a hook that works; `pi` is recorded - its first
 *     reading.
 * C5. **Uninstall leaves the roster clean** - plugins and registries back to the
 *     pre-state on disk, and then the NEGATIVE CONTROLS on the same runtimes: the
 *     palette no longer offers the command (with a bundled skill in the same read
 *     as the proof the palette was read at all), and the identical C7 turn raises
 *     no card naming a marker and leaves both hit files unchanged - the only thing
 *     that proves the card and the write in C7 were the plugin's.
 *
 * C2 (the agent channel) and C4 (a minted MCP tool called by a real turn) are
 * NOT re-implemented here: `AGENT-INSTALL`, `MCP-W2` and `PLUGIN-INSTALL-RUNTIMES`
 * are those arms, re-driven by SIT-11 on all three runtimes.
 *
 * `NESSY_CDP_RS107_FAMILIES` (comma list of `pi`, `claude`, `codex`) narrows the
 * runtimes; absent, every family the profile has a card for - C6/C7 are three
 * turns per runtime.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildCmdHookFixture, CMDHOOK, type CmdHookFixture } from '../fixtures/mcp-naming.ts'
import { appEnvBlockReason, readAppEnvContamination } from '../lib/app-env.ts'
import { lastAssistantText, sendPrompt, sendSlashCommand } from '../lib/chat.ts'
import { peekPalette } from '../lib/composer.ts'
import type { CdpSession } from '../lib/connect.ts'
import { pressCard, readCard } from '../lib/permission-card.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { configDir } from '../lib/runtime-session-log.ts'
import { listConnections, runtimeOf, switchRuntime } from '../lib/runtime-switch.ts'
import type { CaseMeta } from '../lib/sitting.ts'
import {
  assertElectronApi, freshSession, listSessions, setPermissionMode, transcript, waitFor,
  type SessionKey, type TranscriptMessage,
} from '../lib/state.ts'
import { checkAbsence, positive, turnRowsSince } from '../lib/turn-evidence.ts'

const ID = 'RS-107'
const TITLE = 'the plugin path: install through the product, a plugin COMMAND dispatching its body and a plugin HOOK '
  + 'firing behind its card on every runtime, and uninstall leaving nothing behind'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'F1.148',
  runtimes: ['pi', 'claude', 'codex'],
  credentials: 'owner: at least one card per runtime to be read, already signed in. It installs ONE fixture plugin '
    + 'into the config dir the run was launched with, through the app\'s own marketplace RPC, and removes it and its '
    + 'registry in a `finally`. No key is read, printed or written.',
} as const satisfies CaseMeta

/** The palette row the command must appear as - namespaced as SIT-11 read it on claude and codex. */
export const COMMAND_ROW = new RegExp(`^/(${CMDHOOK.pluginId}:)?${CMDHOOK.commandName}(\\s|$)`)
/** A bundled skill in the SAME palette read - the proof the palette was read at all. */
export const PALETTE_CONTROL_ROW = /^\/code-review(\s|$)/
/**
 * F1.767 - the filter each palette read types, the way the dispatch types its token.
 *
 * The C6 read used to type a bare `/` and take whatever rows were there: on pi
 * (SIT-b, packaged `5896a66d2`) that read returned 32 rows with neither the
 * command NOR the `/code-review` control, while the dispatch one step later
 * typed the token and found the row - and on a Mac whose `~/.claude` adds user
 * skills the unfiltered palette carries 113 rows. A filtered read shows only
 * the rows that match, and `waitForPalette` holds it until one does (8 s), so a
 * roster still loading is waited for instead of read short. The menu filters by
 * SUBSTRING of label and id (`slash-command-menu.tsx`, `filterCommands`), so
 * the token cannot drop a row {@link COMMAND_ROW} accepts.
 */
export const COMMAND_TOKEN = CMDHOOK.commandName
export const PALETTE_CONTROL_TOKEN = 'code-review'
/** The C7 prompt: one ordinary Bash call, the same words with and without the plugin. */
export const HOOK_PROBE_PROMPT = 'Run the Bash command `echo rs107-hook-probe` verbatim as the whole command, with nothing '
  + 'before it and nothing after it, and paste its output back.'

export type Family = 'pi' | 'claude' | 'codex'

/** Which hook each runtime is EXPECTED to fire (SIT-11), and `undefined` where no reading exists yet. */
export function expectedHooks(family: Family): { pre: boolean | undefined; post: boolean | undefined } {
  if (family === 'claude') return { pre: true, post: undefined }
  if (family === 'codex') return { pre: false, post: true }
  return { pre: undefined, post: undefined }
}

/** Whether a hit file grew by its own marker between two reads. */
export function fired(before: string, after: string, marker: string): boolean {
  return after.length > before.length && after.slice(before.length).includes(marker)
}

/** Every hook that fired must have been asked about: a card carrying its marker. */
export function unaskedFirings(input: { pre: boolean; post: boolean; cards: readonly string[]; preMarker: string; postMarker: string }): string[] {
  const asked = (marker: string): boolean => input.cards.some(card => card.includes(marker))
  return [
    ...(input.pre && !asked(input.preMarker) ? ['PreToolUse'] : []),
    ...(input.post && !asked(input.postMarker) ? ['PostToolUse'] : []),
  ]
}

function familyOf(providerType: string): Family | undefined {
  const raw = runtimeOf(providerType)
  return raw === 'anthropic' ? 'claude' : raw === 'codex-runtime' ? 'codex' : raw === 'pi' ? 'pi' : undefined
}

function readText(path: string): string {
  try { return existsSync(path) ? readFileSync(path, 'utf8') : '' } catch { return '' }
}

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return fallback }
}

interface InstalledRow { pluginId?: string; pluginKey?: string; manifest?: { capabilities?: Array<{ kind?: string }> } }

function installedRows(): InstalledRow[] {
  return readJson<{ plugins?: InstalledRow[] }>(join(configDir(), 'plugins', 'installed.json'), {}).plugins ?? []
}

function registryIds(): string[] {
  return (readJson<{ registries?: Array<{ id?: string }> }>(join(configDir(), 'plugins', 'marketplaces.json'), {}).registries ?? [])
    .map(entry => entry?.id).filter((id): id is string => typeof id === 'string').sort()
}

function pluginIds(): string[] {
  return installedRows().map(row => row?.pluginId).filter((id): id is string => typeof id === 'string').sort()
}

async function openArm(session: CdpSession, label: string, card: string): Promise<SessionKey | string> {
  const key = await freshSession(session, `CDP ${ID} ${label} ${new Date().toISOString().slice(11, 19)}`)
  if (!key.fresh) return `no fresh session: ${key.reason ?? 'inherited messages'}`
  const bound = await switchRuntime(session, key.sessionId, card)
  return bound.ok ? key : `the session did not bind to ${card}: ${bound.error ?? 'no reason given'}`
}

async function paletteRows(session: CdpSession, token: string): Promise<string[]> {
  return peekPalette(session, token).catch(() => [] as string[])
}

/** One turn with a card watcher beside it that READS every card and then presses Allow. */
async function turnReadingCards(session: CdpSession, key: SessionKey, prompt: string): Promise<{ added: TranscriptMessage[]; error?: string; cards: string[]; pressed: string[] }> {
  const cards: string[] = []
  const pressed: string[] = []
  let running = true
  const watcher = (async () => {
    while (running) {
      await Bun.sleep(1_000)
      const card = await readCard(session)
      if (!card.present) continue
      cards.push(card.text)
      pressed.push(await pressCard(session, ['Allow'], `${ID}: a card during the hook turn`))
    }
  })()
  const rowsBefore = (await transcript(session, key)).length // F1.521: the fallback's baseline, read before the send
  const turn = await sendPrompt(session, key, prompt, 240_000)
    .then(done => ({ added: done.added }), (cause: unknown) => ({ added: [] as TranscriptMessage[], error: String(cause).slice(0, 300) }))
  running = false
  await watcher
  const added = await turnRowsSince(() => transcript(session, key), turn.added, rowsBefore)
  return { ...turn, added, cards, pressed }
}

/** C7's turn in `default`, read back before the prompt is sent. */
async function hookTurn(run: CaseRun, session: CdpSession, family: Family, card: string, label: string, fixture: CmdHookFixture) {
  const key = await openArm(session, `${family} ${label}`, card)
  if (typeof key === 'string') { run.check(`[${family}] ${label} — a fresh session`, false, key); return undefined }
  await setPermissionMode(session, key.sessionId, 'default')
  const mode = await waitFor(async () => (await listSessions(session)).find(row => row.id === key.sessionId)?.permissionMode,
    value => value === 'default', { timeoutMs: 20_000, intervalMs: 1_000, label: 'default mode to take effect' }).catch(() => undefined)
  if (mode !== 'default') { run.check(`[${family}] ${label} — the session runs in default, read back`, false, `mode ${String(mode)}`); return undefined }
  const pre = readText(fixture.preHitFile)
  const post = readText(fixture.postHitFile)
  const turn = await turnReadingCards(session, key, HOOK_PROBE_PROMPT)
  const bash = turn.added.find(row => /bash|shell|exec/i.test(row.toolName ?? '') && row.toolStatus === 'completed')
  return {
    attempted: bash !== undefined,
    bashRow: bash?.toolName,
    pre: fired(pre, readText(fixture.preHitFile), fixture.preMarker),
    post: fired(post, readText(fixture.postHitFile), fixture.postMarker),
    cards: turn.cards,
    pressed: turn.pressed,
    error: turn.error,
  }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const appEnv = readAppEnvContamination()
  run.observe('app-env', { pids: appEnv.pids.length, present: appEnv.present, controlSeen: appEnv.controlSeen })
  const contaminated = appEnvBlockReason(appEnv, 'the model turns this case drives')
  if (contaminated !== undefined) blocked(contaminated)

  const pluginsBefore = pluginIds()
  const registriesBefore = registryIds()
  run.observe('the profile before', { plugins: pluginsBefore, registries: registriesBefore.length })
  if (pluginsBefore.includes(CMDHOOK.pluginId)) {
    blocked(`${CMDHOOK.pluginId} is already installed - a previous run did not clean up; remove it through the Plugins page first`)
  }

  const cards = new Map<Family, string>()
  for (const row of await listConnections(session)) {
    const family = familyOf(row.providerType)
    if (family && !cards.has(family)) cards.set(family, row.slug)
  }
  const wanted = (process.env.NESSY_CDP_RS107_FAMILIES ?? '').split(',').map(entry => entry.trim()).filter(Boolean)
  const chosen: Family[] = (wanted.length > 0 ? wanted : ['pi', 'claude', 'codex']).filter((family): family is Family => cards.has(family as Family))
  run.observe('the runtimes', { cards: Object.fromEntries(cards), chosen })
  if (chosen.length === 0) blocked('this profile lists no pi, claude-runtime or codex-runtime card')

  // The registry and the hit files only - never the config dir (F1.146).
  const fixture = await buildCmdHookFixture()
  run.observe('the fixture', { market: fixture.market, hitFiles: [fixture.preHitFile, fixture.postHitFile] })

  // ---- C1: install through the product's own door ----------------------------
  run.observe('C1 — addRegistry', await session.call(`
    return await window.electronAPI.marketplace.addRegistry({ source: ${JSON.stringify(fixture.market)} })
  `).catch((cause: unknown) => ({ threw: String(cause).slice(0, 200) })))
  const registryId = await waitFor(async () => registryIds().find(id => !registriesBefore.includes(id)), id => typeof id === 'string',
    { timeoutMs: 60_000, intervalMs: 1_000, label: 'the registry to appear in marketplaces.json' }).catch(() => undefined)
  let installed = false
  try {
    run.require('C1 — the fixture registry is registered', typeof registryId === 'string', String(registryId))
    const listed = await waitFor(async () => session.call<string[]>(`
      const page = await window.electronAPI.marketplace.list({ kind: 'plugins', page: 1, pageSize: 100 })
      return (page?.items ?? []).filter(item => item.marketplaceId === ${JSON.stringify(registryId)}).map(item => item.name ?? item.id)
    `).catch(() => [] as string[]), names => names.includes(CMDHOOK.pluginId),
    { timeoutMs: 90_000, intervalMs: 3_000, label: 'the registry catalog to list the fixture' }).catch(() => [] as string[])
    run.require('C1 — the registry lists the fixture plugin by name', listed.includes(CMDHOOK.pluginId), `listed ${listed.join(',')}`)
    const install = await session.call(`
      const ws = (await window.electronAPI.getWorkspaces?.())?.[0]?.id
      return await window.electronAPI.marketplace.install({
        source: { kind: 'listing', marketplaceId: ${JSON.stringify(registryId)},
          listingId: ${JSON.stringify(`${registryId}:${CMDHOOK.pluginId}`)}, listingKind: 'plugins' },
        activateIn: ws ? { kind: 'workspace', workspaceId: ws } : { kind: 'global' },
      })
    `).catch((cause: unknown) => ({ threw: String(cause).slice(0, 300) }))
    run.observe('C1 — the install answered', install)
    installed = pluginIds().includes(CMDHOOK.pluginId)
    run.require('C1 — the product install put the plugin on disk', installed, `installed ${pluginIds().join(',')}`)

    // ---- C3: the posture it lands in ------------------------------------------
    const kinds = (installedRows().find(row => row.pluginId === CMDHOOK.pluginId)?.manifest?.capabilities ?? []).map(entry => entry.kind)
    run.observe('C3 — the capability kinds the install recorded', kinds)
    run.check('C3 — the install recorded the command AND the hook', kinds.includes('prompt-command') && kinds.includes('hook'), JSON.stringify(kinds))

    for (const family of chosen) {
      const card = cards.get(family)!
      // ---- C6: the command, by NAME, dispatching its BODY -------------------
      const arm = await openArm(session, `${family} command`, card)
      if (typeof arm === 'string') {
        run.check(`[${family}] C6 — a fresh session`, false, arm)
      } else {
        const rows = await paletteRows(session, COMMAND_TOKEN)
        const row = rows.find(text => COMMAND_ROW.test(text))
        run.observe(`[${family}] C6 — the palette, filtered by /${COMMAND_TOKEN}`, { entries: rows.length, commandRow: row })
        run.check(`[${family}] C6 — the palette offers the plugin command BY NAME`, row !== undefined,
          `no row matches ${String(COMMAND_ROW)} over ${rows.length} entries`)
        const sent = await sendSlashCommand(session, arm, {
          token: CMDHOOK.commandName, match: COMMAND_ROW, expectComposer: '', submitOnSelect: true, timeoutMs: 180_000,
        }).then(result => ({ reply: lastAssistantText(result.added ?? []) }), (cause: unknown) => ({ reply: '', error: String(cause).slice(0, 300) }))
        run.observe(`[${family}] C6 — the dispatch`, { reply: sent.reply.slice(0, 160), error: 'error' in sent ? sent.error : undefined })
        run.check(`[${family}] C6 — the command's BODY reached the model (a token only the body carries)`,
          sent.reply.includes(fixture.commandToken), `reply ${JSON.stringify(sent.reply.slice(0, 160))}`)
      }

      // ---- C7: the hooks, in default, behind their cards ------------------------
      const hook = await hookTurn(run, session, family, card, 'hook', fixture)
      if (!hook) continue
      run.observe(`[${family}] C7 — the hook turn`, hook)
      run.check(`[${family}] C7 — the model ATTEMPTED the Bash call (a hook has something to fire on)`, hook.attempted,
        `no completed shell row; turn error ${String(hook.error)}`)
      run.check(`[${family}] C7 — a plugin hook fired, read off the file it writes`, hook.pre || hook.post,
        `neither ${fixture.preHitFile} nor ${fixture.postHitFile} grew`)
      const unasked = unaskedFirings({ ...hook, preMarker: fixture.preMarker, postMarker: fixture.postMarker })
      run.check(`[${family}] C7 — every plugin hook that fired was ASKED about first (D1.343)`, unasked.length === 0,
        `fired with no card naming its marker: ${unasked.join(', ')}`)
      const expected = expectedHooks(family)
      if (expected.pre !== undefined) {
        run.check(`[${family}] C7 — PreToolUse ${expected.pre ? 'fires' : 'stays silent (the documented null)'}`, hook.pre === expected.pre, `pre fired: ${hook.pre}`)
      }
      if (expected.post !== undefined) {
        run.check(`[${family}] C7 — PostToolUse ${expected.post ? 'fires' : 'stays silent'}`, hook.post === expected.post, `post fired: ${hook.post}`)
      }
    }
  } finally {
    // ---- C5: uninstall, and the profile back to its pre-state -------------------
    const pluginKey = installedRows().find(row => row.pluginId === CMDHOOK.pluginId)?.pluginKey
    if (pluginKey) {
      run.observe('C5 — uninstall answered', await session.call(`
        return await window.electronAPI.plugin.manage({ pluginKey: ${JSON.stringify(pluginKey)}, action: 'uninstall' })
      `).catch((cause: unknown) => ({ threw: String(cause).slice(0, 300) })))
    }
    if (typeof registryId === 'string') {
      run.observe('C5 — removeRegistry answered', await session.call(`
        return await window.electronAPI.marketplace.removeRegistry({ marketplaceId: ${JSON.stringify(registryId)} })
      `).catch((cause: unknown) => ({ threw: String(cause).slice(0, 300) })))
    }
    const settled = await waitFor(async () => ({ plugins: pluginIds(), registries: registryIds() }),
      now => JSON.stringify(now.plugins) === JSON.stringify(pluginsBefore) && JSON.stringify(now.registries) === JSON.stringify(registriesBefore),
      { timeoutMs: 30_000, intervalMs: 1_000, label: 'the profile to return to its pre-state' },
    ).catch(() => ({ plugins: pluginIds(), registries: registryIds() }))
    run.check('C5 — plugins and registries are back to the pre-state', JSON.stringify(settled.plugins) === JSON.stringify(pluginsBefore)
      && JSON.stringify(settled.registries) === JSON.stringify(registriesBefore),
    `plugins ${pluginsBefore.join(',')} -> ${settled.plugins.join(',')}; registries ${registriesBefore.length} -> ${settled.registries.length}`)
  }
  if (!installed) return

  // ---- the NEGATIVE CONTROLS, after the uninstall, on the same runtimes ----------
  for (const family of chosen) {
    const card = cards.get(family)!
    const arm = await openArm(session, `${family} control`, card)
    if (typeof arm !== 'string') {
      // F1.767 - the SAME filtered instrument as C6, and its control is the same
      // read for a row that must be there: a filter that matched nothing proves
      // an absence only beside a filter that found what it looked for.
      const controlRows = await paletteRows(session, PALETTE_CONTROL_TOKEN)
      const rows = await paletteRows(session, COMMAND_TOKEN)
      run.check(`[${family}] C5 control — the palette was read (a bundled skill is in it)`, controlRows.some(text => PALETTE_CONTROL_ROW.test(text)),
        `/${PALETTE_CONTROL_TOKEN} gave ${controlRows.length} entries and no /code-review - an empty read would make the absence below vacuous`)
      run.check(`[${family}] C5 control — the command is gone from the palette`, !rows.some(text => COMMAND_ROW.test(text)),
        rows.filter(text => COMMAND_ROW.test(text)).join(' | '))
    }
    const control = await hookTurn(run, session, family, card, 'hook control', fixture)
    if (!control) continue
    run.observe(`[${family}] C7 control — the identical turn with the plugin gone`, control)
    const named = control.cards.filter(text => text.includes(fixture.preMarker) || text.includes(fixture.postMarker))
    // F1.504 — silence from a turn that ran no shell call is no control: the
    // hooks had nothing to fire on. The subject arm asks the same thing above.
    checkAbsence(run, `[${family}] C7 control — no card names a hook marker, and neither hit file moved`,
      named.length === 0 && !control.pre && !control.post,
      positive(control.attempted, 'completed shell row (a hook has something to fire on)', `turn error ${String(control.error)}`),
      `cards naming a marker: ${named.length}; pre moved ${control.pre}; post moved ${control.post}`)
  }
}

if (import.meta.main) await main(ID, TITLE, drive)
