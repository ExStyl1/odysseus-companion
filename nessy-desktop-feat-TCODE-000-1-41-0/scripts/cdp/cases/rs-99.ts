/**
 * RS-99 (D1.137) — Pi's LSP route driven once with an official `*-lsp` plugin in
 * a TRUSTED project, which is the positive control P3.366 asked for.
 *
 * ## The row
 *
 * J25's Pi cell is `partial` on inference: P3.366 deleted the unreachable native
 * LSP fallback rather than supplying it, so Pi keeps the documented plugin route
 * (`agent/pi-harness/lsp-port.ts` plus the post-edit consumer
 * `server-core/src/pi-harness/edit-feedback.ts`) — and that route has never been
 * driven with an official `*-lsp` plugin. The row's own words: *"without the
 * control, three separate gates produce the same empty result for the wrong
 * reason"*. The three gates are the plugin, the trust state and the off switch.
 *
 * ## Why this case insists on a FRESH profile
 *
 * `isPiLspProvisioningAllowed` (`server-core/src/sessions/SessionManager.ts`) is
 * `projectTrustState === 'trusted'` and nothing else. Measure sitting 5e
 * measured that once the app's trust modal has been CANCELLED, the gate answers
 * `not-shown` for every later project in that profile — so a profile where
 * anything has cancelled it can never produce a trusted project, and every
 * reading below would be the trust gate rather than the LSP route. The case
 * BLOCKS on `not-shown` rather than reporting an absence taken under it — every
 * `not-shown` except `already decided: trusted`, which IS the state the gate
 * needs (F1.810, SIT-t: the stock case blocked there, the one state it wanted).
 *
 * The minted project CONTRIBUTES one thing, a project command under
 * `.claude/commands/`, because a folder that contributes nothing is never asked
 * about (`resolveProjectTrustPrompt` → `projectWouldContribute`): its state stays
 * `unknown`, the gate stays shut, and the case could not reach its subject on
 * any fresh profile (F1.810, SIT-t: `not-shown (contributes nothing)`).
 *
 * ## The three readings, each with what its zero would otherwise mean
 *
 *  1. **The plugin contributed an LSP capability.** Read off
 *     `capabilities.getCatalog` before the install and after it, with
 *     `installedPlugins` and the catalog's own `generation` hash as the controls
 *     the two earlier plugin cases paid for. Without this, "no diagnostics" is
 *     equally true of a plugin that never installed.
 *  2. **The project is TRUSTED**, answered through the app's own dialog and read
 *     back. Without this, "no diagnostics" is the trust gate, not the route.
 *  3. **The post-edit payload.** One edit that breaks the types, and the model
 *     asked to report verbatim what it was shown about the file afterwards —
 *     with a TYPE-CORRECT edit in the same session as the control. Only the
 *     difference is evidence: a model that says "no errors" after both is
 *     telling you about its own manners, and a model that invents an error after
 *     both is telling you about the prompt.
 *
 * ## What this case cannot do, stated rather than implied
 *
 * It measures the route's OUTPUT as the model reports it, because the payload is
 * assembled host-side and folded into the next request rather than written
 * anywhere a case can read on a packaged build. So a positive here is strong (an
 * error the model could only have been handed) and a negative is weaker than it
 * looks — which is exactly why the type-correct control runs in the same session.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appEnvBlockReason, readAppEnvContamination } from '../lib/app-env.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import {
  bindWorkingDirectory, buttonTextInPage, CANCEL_BUTTON_TEXTS, CLOSE_BUTTON_TEXTS, listConnections, runtimeOf, switchRuntime, trustScratchProject, type TrustGateOutcome,
} from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, transcript, type TranscriptMessage } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'
import { turnOwnText } from '../lib/turn-evidence.ts'

const ID = 'RS-99'
const TITLE = 'Pi\'s LSP route with an official *-lsp plugin in a trusted project'

/** Resolved BY NAME; a marketplace id is a fact about a catalogue, never a literal. */
const PLUGIN_NAME = process.env.NESSY_CDP_LSP_PLUGIN ?? 'typescript-lsp'
const REGISTRY = process.env.NESSY_CDP_LSP_REGISTRY ?? 'anthropics/claude-plugins-official'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.137',
  runtimes: ['pi'],
  credentials:
    'owner: a pi card (the one-click Nessy Gateway Pi agent). No key is read. The profile must be one whose '
    + 'trust modal has never been CANCELLED, because the LSP gate is the trust state.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. PACKAGED build, a config dir created for the run whose trust modal has never been answered.',
    '2. Add the official registry and install an official `*-lsp` plugin through the app\'s own marketplace RPC.',
    '3. Mint a TypeScript project under the OS temp dir (realpathed), with one `.claude/commands/` file so it '
    + 'contributes and the trust question is asked, and bind a session to it.',
    '4. Answer the app\'s own "Trust this folder?" dialog, and read the trust state back.',
    '5. Drive one edit that BREAKS the types and ask the model what it was shown about the file afterwards; then a type-correct edit as the control.',
    '6. Uninstall the plugin and remove the project in the case\'s own `finally`.',
  ],
  expected:
    'With the plugin installed and the project trusted, a type-breaking edit is followed by diagnostics the '
    + 'model can quote. Whether it is, is the row\'s question and is recorded rather than assumed.',
  detector:
    'three: `capabilities.getCatalog` before and after the install (did the plugin contribute an LSP '
    + 'capability); the app\'s own trust dialog answered and the state read back; and what the model reports it '
    + 'was shown after a type-breaking edit, against a type-correct edit in the same session.',
  positiveControl:
    '`installedPlugins` empty before and naming this plugin after, plus the catalog `generation` hash moving; '
    + 'the trust gate answered, or already decided `trusted`, rather than any other `not-shown`; and the type-correct edit, without which a '
    + 'model that always says "no errors" and a route that delivers none are the same reading.',
  doneMeans:
    'J25\'s Pi cell moves to `covered` or to `absent` with the reason, instead of staying `partial` on '
    + 'inference — and the reading names which of the three gates produced it.',
  doNotConflate:
    'A `not-shown` trust gate is not an untrusted project: it is a profile that cannot answer, and the case '
    + 'BLOCKS on it — unless it reads `already decided: trusted`, the state the gate needs. And a model reporting no diagnostics is weaker evidence than a model quoting one, which '
    + 'is why the two edits run in the same session.',
} as const satisfies SittingRecipe

/**
 * The probe prompt. Exported so the unit arm reads the words the case really
 * sends: the prompt itself names `NO FEEDBACK SHOWN` and the word "error".
 */
export function lspProbePrompt(edit: string, line: string): string {
  // F1.810 — ONE line: the composer DROPS a typed newline rather than turning it
  // into a space, so `sendPrompt`'s read-back failed with `composer-mismatch`
  // ("= \"one\"After") before the probe turn was ever sent (SIT-t).
  return `${edit} so the line reads exactly: ${line} `
    + 'After the edit, quote back verbatim every diagnostic, error or piece of feedback you were shown about '
    + 'that file. If you were shown none, say the words NO FEEDBACK SHOWN.'
}

/** What one edit turn reported: its text, whether it said "none", whether it reported feedback. */
export interface LspTurnReading {
  text: string
  saidNone: boolean
  saw: boolean
}

/**
 * F1.506 — the turn's OWN rows, never `added` whole. `added` starts with the
 * user's prompt, and the prompt above says both `NO FEEDBACK SHOWN` and
 * "error": joined in, it made `saidNone` true on every run, so `saw` was false
 * on every run and the D1.137 check could never pass (origin WJ-ad P-WJ-ad-4).
 */
export function lspTurnReading(added: readonly TranscriptMessage[]): LspTurnReading {
  const text = turnOwnText(added)
  const saidNone = /NO FEEDBACK SHOWN/i.test(text)
  return { text, saidNone, saw: /type|diagnostic|error|not assignable/i.test(text) && !saidNone }
}

/** The row's verdict: feedback after the type-breaking edit, and none after the type-correct control. */
export function lspRouteDelivered(bad: LspTurnReading, good: LspTurnReading): boolean {
  return bad.saw && !good.saw
}

interface Catalog {
  generation?: string
  installedPlugins?: Array<Record<string, unknown>>
  capabilities?: Array<Record<string, unknown>>
}

async function catalogOf(session: CdpSession, workspaceId: string): Promise<Catalog> {
  return session.call<Catalog>(`
    return await window.electronAPI.capabilities.getCatalog({ workspaceId: ${JSON.stringify(workspaceId)} })
  `)
}

/** Every catalog entry whose text names the plugin, or whose kind is an LSP one. */
function lspEntries(catalog: Catalog): Array<Record<string, unknown>> {
  return (catalog.capabilities ?? []).filter(row => {
    const text = JSON.stringify(row)
    return /lsp/i.test(text) || text.includes(PLUGIN_NAME)
  })
}

/**
 * F1.810 — the one trust-gate outcome besides `answered` under which
 * `isPiLspProvisioningAllowed` (`projectTrustState === 'trusted'`) can be true.
 * Spelled as `silentGateVerdict` spells it; a test holds the two together.
 */
export const ALREADY_TRUSTED: TrustGateOutcome = 'not-shown (already decided: trusted)'

/** Whether the trust gate's outcome leaves the LSP route shut, so the case must BLOCK. */
export function trustBlocksLspRoute(trust: TrustGateOutcome): boolean {
  return trust !== 'answered' && trust !== ALREADY_TRUSTED
}

/** The project command that makes the minted folder CONTRIBUTE, so the trust question is asked at all (F1.810). */
export const PROJECT_COMMAND = join('.claude', 'commands', 'cdp-rs99-hello.md')

/** A minimal TypeScript project a language server has something to say about, with one contribution. */
export function mintProject(): string {
  // `mkdtempSync(join(tmpdir(), …))` answers `/var/folders/…` on macOS where the
  // real path is `/private/var/folders/…`, and `trustScratchProject` compares BY
  // STRING — measure sitting 5e paid for that one. realpath the root first.
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'cdp-rs99-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', noEmit: true },
    include: ['src'],
  }, null, 2))
  writeFileSync(join(root, 'src', 'probe.ts'), 'export const answer: number = 1\n')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'cdp-rs99-probe', private: true }, null, 2))
  mkdirSync(join(root, '.claude', 'commands'), { recursive: true })
  writeFileSync(join(root, PROJECT_COMMAND), '---\ndescription: CDP RS-99 fixture command\n---\nSay hello.\n')
  return root
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  const api = await assertElectronApi(session)
  run.observe('electronAPI', { keys: api.length })

  const appEnv = readAppEnvContamination()
  run.observe('app-env', { pids: appEnv.pids.length, present: appEnv.present, controlSeen: appEnv.controlSeen })
  const contaminated = appEnvBlockReason(appEnv, 'the Pi LSP route')
  if (contaminated !== undefined) blocked(contaminated)

  const cards = await listConnections(session)
  const pi = cards.find(row => runtimeOf(row.providerType) === 'pi')
  if (!pi) {
    blocked(
      `this profile lists no pi card, and the LSP route under test is Pi's. It lists `
      + `${cards.map(row => `${row.slug}(${row.providerType})`).join(', ') || 'nothing'}`,
    )
  }

  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  const bind = await switchRuntime(session, key.sessionId, pi.slug)
  run.check(`the session is bound to ${pi.slug}`, bind.ok, bind.ok ? undefined : bind.error)

  const before = await catalogOf(session, key.workspaceId)
  run.observe('the catalog BEFORE', {
    generation: before.generation,
    installedPlugins: before.installedPlugins,
    capabilities: (before.capabilities ?? []).length,
    lspEntries: lspEntries(before).length,
  })
  run.require(
    'THE CONTROL — this profile had no plugin installed before the case',
    (before.installedPlugins ?? []).length === 0,
    `\`installedPlugins\` already names ${JSON.stringify(before.installedPlugins)}. On a dirty profile "the LSP `
    + 'capability is there afterwards" says nothing',
  )

  // ---- the plugin ---------------------------------------------------------
  const registry = await session.call<unknown>(`
    try { return await window.electronAPI.marketplace.addRegistry({ source: ${JSON.stringify(REGISTRY)} }) }
    catch (error) { return { error: String(error) } }
  `)
  run.observe('addRegistry', registry)

  // `addRegistry` resolves BEFORE the catalogue is queryable, so poll rather
  // than read once — the window is recorded in `cases/agent-install.ts`.
  interface Listing { marketplaceId?: string; id?: string; name?: string; capabilities?: string[] }
  let listing: Listing | null = null
  for (let attempt = 0; attempt < 12 && !listing?.id; attempt += 1) {
    listing = await session.call<Listing | null>(`
      const page = await window.electronAPI.marketplace.list({ kind: 'plugins', query: ${JSON.stringify(PLUGIN_NAME)}, pageSize: 20 })
      const hit = (page.items ?? []).find(item => item.name === ${JSON.stringify(PLUGIN_NAME)})
      return hit ? { marketplaceId: hit.marketplaceId, id: hit.id, name: hit.name, capabilities: hit.capabilities } : null
    `).catch(() => null)
    if (!listing?.id) await Bun.sleep(2_500)
  }
  run.observe('the listing, resolved by name', listing)
  if (!listing?.marketplaceId || !listing.id) {
    blocked(
      `no marketplace listing named ${JSON.stringify(PLUGIN_NAME)} is reachable from this profile after adding `
      + `${REGISTRY}. Name another with NESSY_CDP_LSP_PLUGIN — this is a reading about the catalogue, not the product`,
    )
  }

  let pluginKey: string | undefined
  let project: string | undefined
  try {
    const install = await session.call<unknown>(`
      return await window.electronAPI.marketplace.install({
        source: {
          kind: 'listing',
          marketplaceId: ${JSON.stringify(listing.marketplaceId)},
          listingId: ${JSON.stringify(listing.id)},
          listingKind: 'plugins',
        },
      })
    `)
    run.observe('the install result', install)

    const after = await catalogOf(session, key.workspaceId)
    pluginKey = (after.installedPlugins ?? [])
      .map(row => row.pluginKey)
      .find((value): value is string => typeof value === 'string')
    const entries = lspEntries(after)
    run.observe('the catalog AFTER', {
      generation: after.generation,
      installedPlugins: after.installedPlugins,
      capabilities: (after.capabilities ?? []).length,
      lspEntries: entries,
    })
    run.require(
      'THE CONTROL — the reader SEES the install (installedPlugins grew and the generation hash moved)',
      (after.installedPlugins ?? []).length > (before.installedPlugins ?? []).length
        && before.generation !== after.generation,
      `installedPlugins ${JSON.stringify(before.installedPlugins)} → ${JSON.stringify(after.installedPlugins)}, `
      + `generation ${String(before.generation)} → ${String(after.generation)}. Without both, everything below is `
      + 'a stale read',
    )
    run.check(
      'D1.137 — the official *-lsp plugin contributes an LSP capability to the catalog',
      entries.length > lspEntries(before).length,
      `LSP-shaped catalog entries went ${lspEntries(before).length} → ${entries.length}: ${JSON.stringify(entries)}`,
    )

    // ---- the trusted project -------------------------------------------
    project = mintProject()
    run.observe('the scratch project', { dir: project })
    // F1.182 — started, not awaited: the gate is answered while the mutation is
    // in flight, and the bind's own polled reading is the check below it.
    const binding = bindWorkingDirectory(session, key.sessionId, project)
    const trust = await trustScratchProject(session, project, 30_000)
    run.observe('the trust gate', { outcome: trust, dir: project })
    const bound = await binding
    run.require('the session is bound to the scratch project', bound.bound, bound.reason ?? '')
    if (trustBlocksLspRoute(trust)) {
      blocked(
        `the app's trust dialog answered ${trust} for ${project}. \`isPiLspProvisioningAllowed\` is `
        + '`projectTrustState === "trusted"` and nothing else, so every reading below would be the trust gate '
        + 'rather than the LSP route. This needs a profile whose modal has never been CANCELLED (sitting 5e)',
      )
    }

    // ---- the post-edit payload, and its control ------------------------
    const probe = join(project, 'src', 'probe.ts')
    const bad = await sendPrompt(session, key, lspProbePrompt(`Edit the file ${probe}`, 'export const answer: number = "one"'), 900_000)
    const badReading = lspTurnReading(bad.added)
    run.observe('after the TYPE-BREAKING edit', {
      messages: bad.added.length,
      sawFeedback: !badReading.saidNone,
      text: badReading.text.slice(0, 1_200),
    })

    const good = await sendPrompt(session, key, lspProbePrompt(`Now edit the same file ${probe}`, 'export const answer: number = 2'), 900_000)
    const goodReading = lspTurnReading(good.added)
    run.observe('THE CONTROL — after the TYPE-CORRECT edit', {
      messages: good.added.length,
      sawFeedback: !goodReading.saidNone,
      text: goodReading.text.slice(0, 1_200),
    })

    run.check(
      'D1.137 — the LSP half of the post-edit payload reaches the model on Pi',
      lspRouteDelivered(badReading, goodReading),
      `type-breaking edit: reported feedback = ${badReading.saw}; type-correct CONTROL: ${goodReading.saw}. Both true is a model `
      + 'talking about the prompt rather than about a payload; both false is the route delivering nothing (or a '
      + 'model that will not quote what it was handed, which this instrument cannot separate and says so)',
    )
  } finally {
    if (pluginKey) {
      const removed = await session.call<unknown>(`
        try { return await window.electronAPI.plugin.manage({ action: 'uninstall', pluginKey: ${JSON.stringify(pluginKey)} }) }
        catch (error) { return { error: String(error) } }
      `).catch(error => ({ error: String(error) }))
      const back = await catalogOf(session, key.workspaceId).catch(() => ({} as Catalog))
      run.observe('the uninstall', { removed, installedPlugins: back.installedPlugins })
    }
    if (project) {
      // Dismiss BEFORE deleting: a case that removes a directory the trust modal
      // still names leaves a modal answering `Could not update project trust` to
      // every click, and every later case in the profile dies at
      // `trust-dialog-did-not-close` (sitting 5e).
      await session.call(`
        const button = Array.from(document.querySelectorAll('button'))
          .find(${buttonTextInPage([...CANCEL_BUTTON_TEXTS, ...CLOSE_BUTTON_TEXTS])})
        if (button) button.click()
        return 1
      `).catch(() => undefined)
      try { rmSync(project, { recursive: true, force: true }) } catch { /* the OS temp dir sweeps it */ }
    }
    const left = (await transcript(session, key).catch(() => [])).length
    run.observe('the session at exit', { messages: left })
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
