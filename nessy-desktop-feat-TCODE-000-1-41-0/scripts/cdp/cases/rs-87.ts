/**
 * RS-87 (D1.75) — which of the four settings keys actually WAIT for workspace
 * trust, read off the product's own surfaces before the trust decision and
 * again after it, in a profile created for the run.
 *
 * ## The row
 *
 * D1.75, carried from P6.435: ledger denominator L118 is `partial` on all three
 * runtimes, and the reason it is `partial` rather than `have` is precise — *"a
 * trust state EXISTS, and that the four named keys are each gated on it is not
 * established"*. The rig it asks for:
 *
 * > an untrusted workspace whose settings carry all four keys plus one deny and
 * > one ask rule; per runtime, a table of which took effect BEFORE trust and
 * > which only after, and whether `deny`/`ask` applied at once as the page
 * > requires; control = the same workspace trusted, where every key must take
 * > effect.
 *
 * The four keys are `permissions.allow`, `permissions.additionalDirectories`,
 * `env` and `extraKnownMarketplaces`.
 *
 * ## The row's rig names a file; the product puts that file somewhere else
 *
 * Measured 2026-09-18 before this case was written. The obvious reading of
 * *"an untrusted workspace whose settings carry all four keys"* is a
 * `.claude/settings.json` in the directory the session works in. The product's
 * own `getSettingsProvenance` publishes four families and, per family, the exact
 * files it consults — and its `project` scope is rooted at
 * `<config>/workspaces/<workspaceId>/`, NOT at the working directory. A first
 * drive wrote the file into the working directory, every surface answered empty,
 * and the resulting silence would have been recorded as a trust gate.
 *
 * So the two halves of this row are rooted in two different places, and that is
 * the reading rather than an obstacle: the TRUST DIALOG asks about the session's
 * working directory, while the settings tier it is supposed to gate lives in the
 * config dir under the workspace id. `fixtures/workspace-trust-settings.ts`
 * writes the file where the product says that tier is, and restores it.
 *
 * ## The detectors, and all three are surfaces the feature itself writes
 *
 *  1. **`getWorkspacePermissionsConfig(workspaceId)`** — the effective
 *     permissions config for the workspace, which is where `allow`, `deny`,
 *     `ask` and `additionalDirectories` land if they land anywhere.
 *  2. **`getSettingsProvenance(workspaceId)`** — the host's own per-family
 *     account of which FILE supplies which family. A project file that is read
 *     appears in it; one that is gated out does not, or appears in a different
 *     state. This is the reading that separates *"the key did nothing"* from
 *     *"the file was never opened"*.
 *  3. **`marketplace.listRegistries()`** — `extraKnownMarketplaces` is a
 *     registry declaration, so the registry list is where it shows up. It
 *     answers `{ registries, available }`; both are recorded, because a
 *     declaration that reaches neither is a different reading from one that
 *     reaches `available` and waits to be added.
 *
 * None of them needs a model turn, which is what makes the row cheap: the whole
 * question is a host predicate (`projectTrusted`, threaded into the settings
 * manager and into the permission-config cache key), and a turn would only add
 * a second place for it to fail.
 *
 * ## THE CONTROLS, and there are three because a zero here has three causes
 *
 *  1. **The same run reads every surface BEFORE and AFTER.** A key that is
 *     absent in both readings is not gated on trust; it is unread for some other
 *     reason, and the case says so rather than reporting a gate.
 *  2. **The trust decision is answered through the app's OWN dialog**
 *     (`trustScratchProject` clicks the shipped button; the RPC behind it leaves
 *     the modal up). A profile where the gate answers `not-shown` has not been
 *     driven at all, and the case BLOCKS rather than reporting "nothing
 *     changed" — SIT-5e measured that once the modal has been CANCELLED the gate
 *     answers `not-shown` for every later project in that profile, so this case
 *     wants a FRESH profile and refuses to pretend otherwise.
 *  3. **A marker that is not gated on anything.** The project file also carries
 *     a `permissions.deny` rule, which `permissions.md` says applies at once;
 *     if the whole FILE were unread before trust, the deny would be missing too
 *     — so "the file was read and this key was dropped" and "the file was not
 *     read" are separable readings rather than one absence.
 *
 * ## What it writes, and what it does not
 *
 * One scratch project under the OS temp dir, minted and removed by this case,
 * holding one `.claude/settings.json`. Nothing of the operator's is touched: the
 * trust helper refuses any path outside the OS temp dir, and the config dir is
 * the run's own. The trust modal is DISMISSED before the directory is removed —
 * SIT-5e measured that a modal left pointing at a deleted directory answers
 * `Could not update project trust` to every click and blocks every later case in
 * the profile (→ D1.363).
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appEnvBlockReason, readAppEnvContamination } from '../lib/app-env.ts'
import { resolveAppUnderTest } from '../lib/bundle.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import {
  bindWorkingDirectory, buttonTextInPage, CANCEL_BUTTON_TEXTS, listConnections, runtimeOf, switchRuntime, TRUST_GATE_HEADING_IN_PAGE, trustScratchProject,
} from '../lib/runtime-switch.ts'
import { configDir } from '../lib/runtime-session-log.ts'
import { assertElectronApi, freshSession, selectorCount } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'
import {
  projectTierSettingsFile, restoreTrustSettings, seedTrustSettings, type TrustSettingsSeed,
} from '../fixtures/workspace-trust-settings.ts'

const ID = 'RS-87'
const TITLE = 'which settings keys wait for workspace trust, read before and after the app\'s own trust dialog'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.75',
  runtimes: ['pi', 'claude', 'codex'],
  credentials:
    'owner: any one card, to open a session the workspace is read for. No key, token or credential file is read. '
    + 'Two things are written: one scratch project under the OS temp dir, removed by this case, and one project-tier '
    + 'settings file inside the RUN\'S OWN config dir, written by the fixture and restored to its previous bytes.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. PACKAGED build, a config dir created for the run whose trust modal has NEVER been cancelled — the gate answers `not-shown` for every later project once it has been.',
    '2. Open a session, bind it to a card, and seed the PROJECT TIER through `fixtures/workspace-trust-settings.ts` — `<config>/workspaces/<workspaceId>/.claude/settings.json`, all four keys plus one deny and one ask rule. That path is where the product\'s own provenance report says the `project` scope is; the session\'s working directory is NOT.',
    '3. Point the session at a scratch project directory that DECLARES something — one `.agents/skills/<name>/SKILL.md` is enough. A project with nothing to declare raises no trust modal at all on 1.40.0, and then the gate cannot be answered.',
    '4. Read `getWorkspacePermissionsConfig`, `getSettingsProvenance` and `marketplace.listRegistries()`. This is the UNTRUSTED table.',
    '5. Answer the app\'s own "Trust this folder?" dialog by pressing its Trust button.',
    '6. Read the same three surfaces again. This is the TRUSTED table, and the control.',
    '7. Dismiss any dialog, remove the scratch project, and let the fixture put the previous project-tier file back — including "absent".',
  ],
  expected:
    'A per-key table with two columns. A key present in the trusted reading and absent in the untrusted one is '
    + 'gated on trust; a key present in both is not; a key absent in both is unread for a reason this case must '
    + 'name rather than report as a gate.',
  detector:
    'the product\'s own `getWorkspacePermissionsConfig` (allow / deny / ask / additionalDirectories), '
    + '`getSettingsProvenance` (which FILE supplies which family) and `marketplace.listRegistries()` '
    + '(extraKnownMarketplaces). Never the model\'s prose and never a turn: the gate is a host predicate.',
  positiveControl:
    'the same surfaces read twice in ONE run with only the trust decision between them, the trust gate reporting '
    + '`answered` rather than `not-shown` (a `not-shown` means the decision was never made and the second table is '
    + 'the first one again), and the `deny` rule as the file-was-read marker — `permissions.md` says deny applies '
    + 'at once, so its absence in the untrusted reading means the FILE is gated rather than the key.',
  doneMeans:
    'D1.75 records, per key, whether it took effect before trust or only after, with the surface each reading came '
    + 'from — and L118\'s `partial` gets the establishment it names as missing.',
  doNotConflate:
    'A gate answering `not-shown` is NOT "the project was already trusted": it is also what a profile whose modal '
    + 'has been cancelled answers for every project (SIT-5e). This case blocks on it rather than reporting a table '
    + 'whose two halves were taken under the same condition.',
} as const satisfies SittingRecipe

/** The token every key carries, so a hit can only have come from this file. */
const TOKEN = `rs87${Math.random().toString(16).slice(2, 10)}`

interface Provenance {
  families?: Array<{ id: string; combine?: string; entries?: Array<{ scope: string; file: string; state: string }> }>
}

interface PermissionsConfigShape {
  permissions?: {
    allow?: unknown[]
    deny?: unknown[]
    ask?: unknown[]
    additionalDirectories?: unknown[]
  }
  [key: string]: unknown
}

/** One reading of all three surfaces, taken at one moment. */
interface KeyTable {
  /** Does the project settings file appear in the host's own provenance report, and how. */
  provenanceEntries: Array<{ family: string; scope: string; state: string }>
  allow: string[]
  deny: string[]
  ask: string[]
  additionalDirectories: string[]
  /** `listRegistries()` answers both; an `available` hit is not an `added` one. */
  registries: { added: string[]; available: string[] }
  /** Raw, so a shape change shows up as a shape rather than as a silent zero. */
  permissionsConfigKeys: string[]
  /** `getWorkspacePermissionsConfig` returning null is its own state. */
  permissionsConfigNull: boolean
}

function texts(value: unknown[] | undefined): string[] {
  return (value ?? []).map(entry => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
}

async function readTable(session: CdpSession, workspaceId: string, projectFile: string): Promise<KeyTable> {
  const provenance = await session.call<Provenance>(`
    return await window.electronAPI.getSettingsProvenance(${JSON.stringify(workspaceId)})
  `).catch(() => ({ families: [] } as Provenance))
  const provenanceEntries: Array<{ family: string; scope: string; state: string }> = []
  for (const family of provenance.families ?? []) {
    for (const entry of family.entries ?? []) {
      if (entry.file === projectFile) {
        provenanceEntries.push({ family: family.id, scope: entry.scope, state: entry.state })
      }
    }
  }
  const config = await session.call<PermissionsConfigShape | null>(`
    return await window.electronAPI.getWorkspacePermissionsConfig(${JSON.stringify(workspaceId)})
  `).catch(() => null)
  const registries = await session.call<{ added: string[]; available: string[] }>(`
    const result = await window.electronAPI.marketplace.listRegistries()
    return {
      added: (result?.registries ?? []).map(r => String(r.displayName ?? '') + '|' + String(r.source ?? '')),
      available: (result?.available ?? []).map(r => String(r.name ?? '') + '|' + String(r.source ?? '')),
    }
  `).catch(() => ({ added: [], available: [] }))
  return {
    provenanceEntries,
    allow: texts(config?.permissions?.allow),
    deny: texts(config?.permissions?.deny),
    ask: texts(config?.permissions?.ask),
    additionalDirectories: texts(config?.permissions?.additionalDirectories),
    registries,
    permissionsConfigKeys: config ? Object.keys(config) : [],
    permissionsConfigNull: config === null || config === undefined,
  }
}

/**
 * Watch for the app's own trust modal and RECORD what was on screen, rather
 * than inferring its absence from the helper's verdict.
 *
 * `trustScratchProject` answers `not-shown` for three different worlds — the
 * modal never appeared, it appeared after the deadline, and it appeared for a
 * path the helper refuses — and the first drive of this case spent two runs
 * unable to tell them apart while a hand probe on the same profile saw the
 * dialog four seconds after the same call. So the case keeps its own reading:
 * the same predicate the helper uses, the dialog's own path and its BUTTON
 * LABELS (`Cancel`, `Keep restricted`, `Trust project`, `Close` on 1.40.0), and
 * the number of milliseconds it took to appear.
 */
async function watchForTrustDialog(
  session: CdpSession,
  timeoutMs: number,
): Promise<{ appearedAfterMs: number | null; path?: string; buttons?: string[]; polls: number }> {
  const started = Date.now()
  let polls = 0
  while (Date.now() - started < timeoutMs) {
    polls += 1
    const seen = await session.call<{ present: boolean; path?: string; buttons?: string[] }>(`
      const heading = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]'))
        .find(${TRUST_GATE_HEADING_IN_PAGE})
      if (!heading) return { present: false }
      const root = heading.closest('[role="dialog"]') ?? document.body
      const field = root.querySelector('input,code,pre,[class*="path"]')
      return {
        present: true,
        path: String(field ? (field.value ?? field.textContent ?? '') : '').trim(),
        buttons: Array.from(root.querySelectorAll('button')).map(b => (b.innerText || b.textContent || '').trim()),
      }
    `).catch(() => ({ present: false } as { present: boolean; path?: string; buttons?: string[] }))
    if (seen.present) return { appearedAfterMs: Date.now() - started, path: seen.path, buttons: seen.buttons, polls }
    await Bun.sleep(500)
  }
  return { appearedAfterMs: null, polls }
}

/** Whether this run's own token reached a given surface. */
function carries(values: string[]): boolean {
  return values.some(value => value.includes(TOKEN))
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const app = resolveAppUnderTest(session)
  run.observe('app under test', { kind: app.kind, via: app.via })
  run.check('the artefact under test is the PACKAGED app', app.kind === 'packaged',
    app.kind === 'packaged' ? undefined : `kind=${app.kind} — a dev build is not the shipped artefact`)

  const appEnv = readAppEnvContamination()
  run.observe('app-env', { pids: appEnv.pids.length, present: appEnv.present, controlSeen: appEnv.controlSeen })
  const contaminated = appEnvBlockReason(appEnv, 'the settings stack this case reads')
  if (contaminated !== undefined) blocked(contaminated)

  const cards = await listConnections(session)
  const card = cards[0]
  if (!card) blocked('this profile lists no connection at all, so no session can be bound to the scratch project')

  // ---- the scratch project the TRUST DIALOG will ask about -----------------
  //
  // It carries a SKILL, and that is a precondition rather than decoration.
  // Measured 2026-09-18 on the packaged 1.40.0, both arms on one fresh profile
  // in one run: a project holding only a `README.md` raises NO trust modal at
  // all in 20 s, while the same rig with one `.agents/skills/<name>/SKILL.md`
  // raises it in under 2 s and the dialog names it — *"THIS PROJECT PROVIDES ·
  // 1 skill — cdp-probe5 · .agents/skills"*. The gate is on the project having
  // something to DECLARE; `lib/runtime-switch.ts`'s own docblock said any
  // directory raises it, and that is refuted at 1.40.0.
  //
  // Its `.claude/` stays empty: the settings file this case reads goes into the
  // PROJECT TIER, which the product roots in the config dir (see the docblock),
  // and writing one here too would make a hit unattributable.
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-rs87-')))
  const extraDir = join(project, 'granted')
  mkdirSync(extraDir, { recursive: true })
  writeFileSync(join(project, 'README.md'), `rs-87 ${TOKEN}\n`, 'utf8')
  const skillDir = join(project, '.agents', 'skills', `cdp-${ID.toLowerCase()}`)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: cdp-${ID.toLowerCase()}\ndescription: the contribution that makes this project's trust gate reachable (${TOKEN})\n---\nnothing to run\n`,
    'utf8',
  )
  run.observe('the scratch project this case minted', { project, skill: skillDir, token: TOKEN })

  let trust: string = 'not-attempted'
  let seed: TrustSettingsSeed | undefined
  try {
    const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
    run.check('the case ran in a session it created', key.fresh,
      key.fresh ? undefined : `inherited ${key.inheritedMessages} messages; reason: ${key.reason ?? '(none given)'}`)
    const bind = await switchRuntime(session, key.sessionId, card.slug)
    run.observe('bind', { slug: card.slug, providerType: card.providerType, runtime: runtimeOf(card.providerType), ok: bind.ok })

    // ---- the project tier, written by the fixture where the product reads it -
    const root = configDir()
    const projectFile = projectTierSettingsFile(root, key.workspaceId)
    seed = seedTrustSettings(root, key.workspaceId, TOKEN, extraDir)
    run.observe('the project-tier settings file the FIXTURE wrote', {
      file: seed.file, bytes: seed.bytes, hadPrevious: seed.previous !== undefined,
    })
    run.require(
      'THE CONTROL — the file is where the product says the `project` tier is',
      seed.file === projectFile,
      `the fixture wrote ${seed.file} and this case reads ${projectFile}`,
    )

    // F1.182 — started and NOT awaited, because the UNTRUSTED reading below is
    // taken WHILE the modal is up: a helper that awaited the bind could not
    // return until the gate was answered, which is the `pkg-4.ts` deadlock and
    // would also destroy this case's own before/after pair. The bind's verdict
    // is read after the gate.
    const binding = bindWorkingDirectory(session, key.sessionId, project)

    // ---- the modal, watched rather than assumed -----------------------------
    // Taken BEFORE the untrusted reading, so that reading is demonstrably taken
    // while the project is untrusted rather than merely before the click.
    const dialog = await watchForTrustDialog(session, 45_000)
    run.observe('the app\'s own trust modal', dialog)

    // ---- the UNTRUSTED table, taken before the gate is answered -------------
    const before = await readTable(session, key.workspaceId, projectFile)
    run.observe('UNTRUSTED — the three surfaces', before)

    // ---- the app's own trust dialog ----------------------------------------
    // 45 s, not the helper's default 15: the modal is raised asynchronously
    // after the bind and a renderer that has just seeded a card can be slow
    // enough to answer `not-shown` for a modal that then appears (measured
    // 2026-09-18 on the first drive of this case, against a hand probe on the
    // same profile that saw the dialog four seconds after the same call).
    trust = await trustScratchProject(session, project, 45_000).catch((error: unknown) => `threw: ${String(error)}`)
    run.observe('the trust gate', trust)
    run.require(
      'THE CONTROL — the trust decision was actually made, through the app\'s own dialog',
      trust === 'answered',
      `the gate answered ${JSON.stringify(trust)} while this case's own watch reported `
      + `${JSON.stringify(dialog)}. A \`not-shown\` is NOT "already trusted": a profile whose modal has been `
      + 'cancelled once answers it for every later project (SIT-5e), and then both tables below are the same '
      + 'reading taken twice. If the watch above DID see the modal, the helper and this case disagree and the '
      + 'helper is the thing to read next.',
    )

    // ---- the TRUSTED table, everything else identical ----------------------
    const after = await readTable(session, key.workspaceId, projectFile)
    run.observe('TRUSTED — the three surfaces', after)

    // ---- the row's own table ------------------------------------------------
    const perKey = {
      'permissions.allow': { untrusted: carries(before.allow), trusted: carries(after.allow) },
      'permissions.deny': { untrusted: carries(before.deny), trusted: carries(after.deny) },
      'permissions.ask': { untrusted: carries(before.ask), trusted: carries(after.ask) },
      'permissions.additionalDirectories': {
        untrusted: before.additionalDirectories.some(entry => entry.startsWith(project)),
        trusted: after.additionalDirectories.some(entry => entry.startsWith(project)),
      },
      'extraKnownMarketplaces (added)': {
        untrusted: carries(before.registries.added), trusted: carries(after.registries.added),
      },
      'extraKnownMarketplaces (offered)': {
        untrusted: carries(before.registries.available), trusted: carries(after.registries.available),
      },
      'the FILE itself (provenance)': {
        untrusted: before.provenanceEntries.length > 0,
        trusted: after.provenanceEntries.length > 0,
      },
    }
    run.observe('D1.75 — the table the row asks for', perKey)
    run.observe('D1.75 — how to read it', {
      gated: Object.entries(perKey).filter(([, v]) => !v.untrusted && v.trusted).map(([k]) => k),
      ungated: Object.entries(perKey).filter(([, v]) => v.untrusted && v.trusted).map(([k]) => k),
      unreadEither: Object.entries(perKey).filter(([, v]) => !v.untrusted && !v.trusted).map(([k]) => k),
      lostOnTrust: Object.entries(perKey).filter(([, v]) => v.untrusted && !v.trusted).map(([k]) => k),
      note:
        'an `unreadEither` key is NOT a gate: the file may be read and the key dropped, or the key may live on a '
        + 'surface this case does not read. It is reported as unread, with the raw surfaces above, and the row '
        + 'carries that null rather than a verdict.',
    })

    // The `env` family has no dedicated surface here, so it is answered off the
    // provenance report ALONE and said to be answered that way.
    run.observe('D1.75 — the `env` key', {
      untrustedFamilies: before.provenanceEntries.map(entry => entry.family),
      trustedFamilies: after.provenanceEntries.map(entry => entry.family),
      note:
        'read off `getSettingsProvenance` only: there is no per-workspace surface publishing the resolved `env` '
        + 'block, so what this case can say is whether the host counts this file as supplying that family.',
    })

    // ---- the checks ---------------------------------------------------------
    run.check(
      'THE CONTROL — at least one of the six reached a surface once trusted, so a zero above is a gate rather than an unread file',
      Object.values(perKey).some(entry => entry.trusted),
      `nothing this file declares reached any of the three surfaces even after the project was trusted `
      + `(permissions keys ${JSON.stringify(after.permissionsConfigKeys)}, registries `
      + `${after.registries.added.length} added / ${after.registries.available.length} offered, `
      + `provenance entries ${after.provenanceEntries.length}). The whole table is then a statement about the `
      + 'READERS, not about trust, and D1.75 stays open with that as its reading.',
    )
    run.check(
      'D1.75 — the deny rule, which `permissions.md` says applies at once, is not withheld by the gate',
      perKey['permissions.deny'].untrusted || !perKey['permissions.deny'].trusted,
      'the deny rule appeared only AFTER trust. The page requires deny and ask to apply immediately, so this is '
      + 'the row\'s finding rather than its control — record it with both raw tables above.',
    )
  } finally {
    // DISMISS BEFORE DELETING (SIT-5e): a modal left pointing at a directory
    // that no longer exists answers `Could not update project trust` to every
    // click and blocks every later case in the profile.
    const dialogs = await selectorCount(session, '[role="dialog"]').catch(() => -1)
    if (dialogs > 0) {
      await session.call<boolean>(`
        const b = Array.from(document.querySelectorAll('[role="dialog"] button'))
          .find(${buttonTextInPage(CANCEL_BUTTON_TEXTS)})
        if (!b) return false
        b.click()
        return true
      `).catch(() => false)
      await Bun.sleep(500)
    }
    run.observe('dialogs on screen before the scratch project was removed', dialogs)
    rmSync(project, { recursive: true, force: true })
    if (seed) run.observe('the restore', restoreTrustSettings(seed))
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
