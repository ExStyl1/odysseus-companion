import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ComposerCapabilities } from '@nessy-agent/shared/protocol'
import { PERMISSION_MODE_ORDER, type PermissionMode } from '@nessy-agent/shared/agent/modes'
import { LOCALE_REGISTRY } from '@nessy-agent/shared/i18n'
import {
  PERMISSION_MODE_FULL_DESCRIPTION_KEYS,
  PERMISSION_MODE_PICKER_ORDER,
  RUNTIME_PERMISSION_MODE_CLAUSE_KEYS,
  RUNTIME_PERMISSION_MODE_FOOTER_KEYS,
  coercePermissionModeForComposer,
  describePermissionModeLine,
  findComposerPermissionModeDisplay,
  getSupportedComposerPermissionModes,
  getVisibleComposerPermissionModes,
  nextCyclePermissionMode,
  resolveComposerPermissionModeList,
  resolvePermissionModeMenuDecorations,
  resolveRuntimePermissionModeNote,
  resolveWorkspaceCyclablePermissionModes,
  selectPermissionModeByDigit,
  withPermissionModeMenuDecorations,
} from '../composer-permission-modes'
import { dispatchSlashCommandAction } from '../../components/app-shell/input/slash-command-actions'

const translate = (key: string) => key

/** The words a user actually reads — the shipped `en` locale, not a stub. */
const en = LOCALE_REGISTRY.en.messages as Record<string, string>
const translateEn = (key: string) => en[key] ?? key

function caps(overrides: Partial<ComposerCapabilities>): ComposerCapabilities {
  return {
    attachments: { files: true, images: 'no', folders: true },
    mentions: { files: true, skills: true, sources: true },
    slash: { commandIds: 'all' },
    submit: { queue: true, steer: false },
    reasoning: { levels: [] },
    permissions: { modes: PERMISSION_MODE_ORDER },
    connection: { switchable: true, activeRuntime: 'pi' },
    contextMeter: true,
    externalFooter: { gitBranch: true },
    ...overrides,
  }
}

describe('composer permission mode helpers', () => {
  it('a backend that names its own modes keeps its order (Nestor Cloud: Plan, then Act)', () => {
    const visible = getVisibleComposerPermissionModes(caps({
      permissions: {
        modes: ['plan', 'default'],
        modeOptions: [
          { mode: 'plan', label: 'Plan', shortLabel: 'Plan', description: 'Remote plan', remoteModeId: 'plan' },
          { mode: 'default', label: 'Act', shortLabel: 'Act', description: 'Remote act', remoteModeId: 'act' },
        ],
      },
    }))

    expect(visible).toEqual(['plan', 'default'])
    // F1.1052 CONTROL on the same instrument: the same two modes WITHOUT a
    // backend's own options are Nessy's, and take the picker's order.
    expect(getVisibleComposerPermissionModes(caps({ permissions: { modes: ['plan', 'default'] } })))
      .toEqual(['default', 'plan'])
  })

  it('coerces hidden execution-like modes to ask when cloud act mode is exposed through ask', () => {
    expect(coercePermissionModeForComposer('bypassPermissions', ['plan', 'default'])).toBe('default')
    expect(coercePermissionModeForComposer('acceptEdits', ['plan', 'default'])).toBe('default')
  })

  // F1.1070 (DN-272): the shown mode agrees with the sent one. The wire maps `dontAsk` to Nestor's `plan`
  // (`mapPermissionModeToNestorCloudMode`), so the composer shows Plan and keeps it rather than rewriting the
  // session to Act. F1.1050 deleted this block's `explore → plan` arm with the retired mode.
  it('F1.1070: a dontAsk session on a Plan and Act list lands on Plan, what the wire sends', () => {
    expect(coercePermissionModeForComposer('dontAsk', ['plan', 'default'])).toBe('plan')
  })

  it('F1.1070 CONTROL: dontAsk stays itself where the runtime honours it, and a list without plan still falls to default', () => {
    expect(coercePermissionModeForComposer('dontAsk', ['dontAsk', 'plan', 'default'])).toBe('dontAsk')
    expect(coercePermissionModeForComposer('dontAsk', ['default', 'acceptEdits'])).toBe('default')
  })

  it('uses backend-provided labels for remote cloud modes', () => {
    const { modes } = resolveComposerPermissionModeList(caps({
      permissions: {
        modes: ['plan', 'default'],
        modeOptions: [
          { mode: 'plan', label: 'Plan', shortLabel: 'Plan', description: 'Remote plan', remoteModeId: 'plan' },
          { mode: 'default', label: 'Act', shortLabel: 'Act', description: 'Remote act', remoteModeId: 'act' },
        ],
      },
    }), translate)

    expect(modes.map(({ mode, label, remoteModeId }) => ({ mode, label, remoteModeId }))).toEqual([
      { mode: 'plan', label: 'Plan', remoteModeId: 'plan' },
      { mode: 'default', label: 'Act', remoteModeId: 'act' },
    ])
  })

  it('preserves synthetic future remote mode ids on local composer modes', () => {
    const { modes } = resolveComposerPermissionModeList(caps({
      permissions: {
        modes: ['default'],
        modeOptions: [
          { mode: 'default', label: 'Review', shortLabel: 'Review', description: 'Remote review', remoteModeId: 'review' },
        ],
      },
    }), translate)

    expect(modes).toHaveLength(1)
    expect(modes[0]).toMatchObject({
      mode: 'default',
      label: 'Review',
      remoteModeId: 'review',
    })
  })
})

/**
 * R15 — the permission-mode descriptions stop being runtime-independent.
 *
 * Asserted through `resolveComposerPermissionModeList`, which is the ONLY
 * producer of the strings `FreeFormInput` renders in the picker
 * (`display.description`, `runtimeNote`) and hands to the slash menu — not
 * through `describePermissionModeLine` alone, which would pass with the wiring
 * removed.
 */
describe('R15 — a mode description says what the ACTIVE runtime enforces', () => {
  const pickerModes = [...PERMISSION_MODE_PICKER_ORDER]

  it('the general string carries no promise a runtime-less surface cannot keep', () => {
    // Workspace Settings → Permissions renders exactly these seven for a
    // WORKSPACE, which has no runtime. The three absolutes R15 found — explore
    // "never prompts", bypassPermissions "no prompts", plan "produce a plan" —
    // are the ones that surface could not keep, and this is what stops one
    // coming back in a copy edit.
    // EVERY shipped locale, not just `en`. The guard exists to stop a copy edit
    // walking an absolute back in, and a copy edit is at least as likely in the
    // translation as in the source — ru is the primary locale here.
    const banned: Record<string, readonly string[]> = {
      en: ['never prompts', 'no prompts'],
      ru: ['не спрашивает', 'без запросов', 'не запрашивает'],
    }
    for (const [code, entry] of Object.entries(LOCALE_REGISTRY)) {
      const messages = entry.messages as Record<string, string>
      const phrases = banned[code]
      for (const mode of PERMISSION_MODE_ORDER) {
        const general = messages[PERMISSION_MODE_FULL_DESCRIPTION_KEYS[mode]]!
        expect(general, `${code}/${mode}`).toBeTruthy()
        if (mode === 'dontAsk') continue // its "never prompts" IS true on all three; see the clause table.
        for (const phrase of phrases ?? []) {
          expect(general.toLowerCase(), `${code}/${mode}`).not.toContain(phrase)
        }
      }
    }
    expect(en['mode.planFullDesc']!.toLowerCase()).not.toContain('produce a plan')
  })

  it('on codex the picker modes that need a clause get one, appended to the same general string', () => {
    const { modes } = resolveComposerPermissionModeList(
      caps({ connection: { switchable: true, activeRuntime: 'codex-runtime' } }),
      translateEn,
    )

    expect(modes.map(d => d.mode)).toEqual(pickerModes)
    const clauses = RUNTIME_PERMISSION_MODE_CLAUSE_KEYS['codex-runtime']!
    for (const display of modes) {
      const general = en[PERMISSION_MODE_FULL_DESCRIPTION_KEYS[display.mode]]!
      const clauseKey = clauses[display.mode]
      expect(display.description, display.mode).toBe(
        clauseKey ? `${general} ${en[clauseKey]}` : general,
      )
    }

    // THE WRITE HALF, which an early version of this row left unbacked. The two
    // modes whose general string still promises something about FILES must
    // discharge that promise in their own clause — the footer only discharges
    // the ASKING half. Since F1.787 codex's own `:read-only` profile holds a shell
    // write back in both switch positions and RAISES a patch, which can then be
    // approved, so the clause says that (F1.1003) instead of "Nessy cannot
    // enforce it". Review caught the opposite arrangement once — the benign
    // absolute removed and the safety-relevant one kept.
    const byMode = new Map(modes.map(d => [d.mode, d.description]))
    for (const mode of ['plan'] as const) {
      expect(byMode.get(mode), mode).toContain('Codex asks on edits')
      expect(byMode.get(mode), mode).not.toContain('cannot enforce')
    }
    expect(byMode.get('plan')).toContain('no plan to approve')
  })

  it('THE DE-DUPLICATION: the shared caveat is the list note, and appears in NO item', () => {
    // The defect the owner reported, pinned as a shape. One fact about the
    // runtime used to be appended to all six items; it is now stated once.
    const list = resolveComposerPermissionModeList(
      caps({ connection: { switchable: true, activeRuntime: 'codex-runtime' } }),
      translateEn,
    )

    // P6.492 joined a second, runtime-independent half onto the note, so this
    // is the codex sentence PLUS the resume-table sentence, in that order.
    expect(list.runtimeNote)
      .toBe(`${en['chat.permissionModeRuntimeNote.codex']} ${en['chat.permissionModeNote.resumeTable']}`)
    // P3.328 rewrote this note (`7843b293b`): both pins below named the OLD
    // sentence and this file went red at HEAD on the first, while the second
    // went VACUOUS — it looked for "decides what to ask you about", a fragment
    // the new note does not contain, so it would have passed against an item
    // repeating the note word for word. Both now name the live sentence.
    expect(list.runtimeNote).toContain('Nessy checks each raised action against its own limits and rules before it runs')
    for (const display of list.modes) {
      expect(display.description, display.mode).not.toContain('decides which actions to raise')
      expect(display.description, display.mode).not.toBe(list.runtimeNote)
    }

    // Four of the six carry NO clause at all now — that is where the height
    // went. A clause key sneaking back onto one of them is a regression.
    const clauses = RUNTIME_PERMISSION_MODE_CLAUSE_KEYS['codex-runtime']!
    for (const mode of ['default', 'acceptEdits', 'auto', 'bypassPermissions'] as const) {
      expect(clauses[mode], mode).toBeUndefined()
      expect(new Map(list.modes.map(d => [d.mode, d.description])).get(mode))
        .toBe(en[PERMISSION_MODE_FULL_DESCRIPTION_KEYS[mode]])
    }
  })

  it('EVERY picker line stays inside the measured one-line budget', () => {
    // The owner's complaint was a LAYOUT one, so the budget is guarded rather
    // than merely described — but read what this actually asserts.
    //
    // The real ceiling is PIXELS: 440px, the `max-w` of the description span in
    // `FreeFormInput`'s picker, at `text-xs` on a 15px root (= 11.25px
    // system-ui). Bun has no text-metrics engine, so this cannot be measured
    // here; it was measured in the running app over CDP with `measureText` under
    // the live computed font. The two binding lines came out at 401px for 75
    // characters (en `plan` on codex) and 411px for 71 characters (ru `plan` on
    // codex) — Cyrillic advances wider per character, which is why ru binds on
    // pixels while en binds on length.
    //
    // What this test is, therefore, is a CHARACTER tripwire — and its first
    // calibration was WRONG IN THE DIRECTION THAT MATTERS. It was set at 78,
    // derived from English's 75-character binding line, which leaves Russian
    // unprotected: a reviewer measured a 76-character Russian line at 457.6px and
    // a 78-character one at 450–464px, i.e. TWO LINES, both passing the test.
    //
    // The two locales advance differently — Russian ~5.78–6.02 px/char against
    // English's ~5.34 — and THAT is why one shared budget was the bug rather than
    // merely a loose number. Collapsing both into 78 left Russian unguarded;
    // collapsing both into Russian's 72 would fail an English line measured at
    // 400.5px inside a 440px box, i.e. report a defect against a string that fits.
    // So the budget is per locale, each derived from its own measured advance
    // against the same 440px cap:
    //
    //   ru — 440 / ~6.02 ≈ 73 → 72 taken. Binding line: `plan`, 71 ch / 410.4px.
    //   en — 440 / ~5.34 ≈ 82 → 78 taken. Binding line: `plan`, 75 ch / 400.5px.
    //
    // A locale with no measured entry falls to the TIGHTER budget, because an
    // unmeasured script is not evidence of a wide one.
    //
    // It does NOT prove a pixel fit. A new locale in a script wider than
    // Cyrillic, or a change to the font stack or the `max-w`, needs a fresh live
    // measurement; the numbers to reproduce are in the comment beside the span.
    const MAX_CHARS_BY_LOCALE: Record<string, number> = { en: 78, ru: 72 }
    const TIGHTEST_MAX_CHARS = Math.min(...Object.values(MAX_CHARS_BY_LOCALE))
    for (const [code, entry] of Object.entries(LOCALE_REGISTRY)) {
      const messages = entry.messages as Record<string, string>
      const translateLocale = (key: string) => messages[key] ?? key
      for (const runtime of ['pi', 'anthropic', 'codex-runtime'] as const) {
        for (const mode of pickerModes) {
          const line = describePermissionModeLine(mode, translateLocale, runtime)
          const budget = MAX_CHARS_BY_LOCALE[code] ?? TIGHTEST_MAX_CHARS
          expect(line.length, `${code}/${runtime}/${mode} (budget ${budget}) — ${JSON.stringify(line)}`)
            .toBeLessThanOrEqual(budget)
        }
      }
    }
  })

  it('dontAsk keeps "denies everything else" and states codex\'s bound as an exception', () => {
    // Not in the picker (PICKER_HIDDEN_MODES), so this is the path that reaches
    // it: the slash menu's fallback and `findComposerPermissionModeDisplay`.
    // Being off every one-line surface is also why its clause has no width
    // budget above.
    const description = findComposerPermissionModeDisplay([], 'dontAsk', translateEn, 'codex-runtime').description
    expect(description).toContain('denies everything else')
    expect(description).toContain('runs its own reads without asking Nessy')
    // The footer's sentence would be WRONG here — `CodexAgent.handleServerRequest`
    // refuses without a card in this mode, so codex is not the one deciding.
    // That is why `dontAsk` keeps a clause of its own rather than inheriting the
    // note the other modes share. (P3.328: this named the pre-`7843b293b`
    // wording and had gone vacuous — it can only fail on a fragment the note
    // still contains.)
    expect(description).not.toContain('decides which actions to raise')
  })

  it('pi and claude render the general string alone — no clause, and no ENFORCEMENT note', () => {
    for (const runtime of ['pi', 'anthropic'] as const) {
      const list = resolveComposerPermissionModeList(
        caps({ connection: { switchable: true, activeRuntime: runtime } }),
        translateEn,
      )
      // P6.492 changed what this row can claim, and the narrowing is the point.
      // These two still have NOTHING to say about enforcement — the pre-tool-use
      // gate really does run there — which is what `FOOTER_KEYS` answers and
      // what the row was written for. What they now DO say is the resume-table
      // fact, which is a statement about the host and true on all three. So the
      // absence is asserted where it belongs, on the enforcement table, and the
      // note is asserted to carry the resume half and nothing else.
      expect(list.runtimeNote, runtime).toBe(en['chat.permissionModeNote.resumeTable'])
      expect(list.runtimeNote, runtime).not.toContain('decides which actions to raise')
      expect(RUNTIME_PERMISSION_MODE_FOOTER_KEYS[runtime], runtime).toBeUndefined()
      for (const display of list.modes) {
        expect(display.description, `${runtime} ${display.mode}`)
          .toBe(en[PERMISSION_MODE_FULL_DESCRIPTION_KEYS[display.mode]])
      }
    }
  })

  it('the footer table is keyed by runtime and answers for the ones with nothing to say', () => {
    // There is no "runtime-less capability set" to test: `activeRuntime` is a
    // REQUIRED field of `ComposerCapabilities.connection` (protocol/dto.ts), so
    // the list resolver always has one. The runtime-less surface is Workspace
    // Settings, and it goes through `describePermissionModeLine` with the runtime
    // omitted — asserted in the PREFIX row below. This is the honest remaining
    // claim: a runtime the table does not name gets no note.
    // P6.492 — Pi and Claude now DO have something to say: they follow the same
    // restore path, so they get the resume-table half and nothing else. The
    // honest remaining claim is `nestor-cloud-agent`, which ships its own modes
    // with its own words and is deliberately outside the set.
    expect(resolveRuntimePermissionModeNote(translateEn, 'pi'))
      .toBe(en['chat.permissionModeNote.resumeTable'])
    expect(resolveRuntimePermissionModeNote(translateEn, 'anthropic'))
      .toBe(en['chat.permissionModeNote.resumeTable'])
    expect(resolveRuntimePermissionModeNote(translateEn, 'nestor-cloud-agent')).toBeUndefined()
    expect(resolveRuntimePermissionModeNote(translateEn, 'codex-runtime'))
      .toBe(`${en['chat.permissionModeRuntimeNote.codex']} ${en['chat.permissionModeNote.resumeTable']}`)
  })

  it('a backend-supplied modeOptions description still wins outright on every runtime', () => {
    // Nestor cloud ships its own modes with its own words; a clause about a local
    // runtime would be false there. Pinned because the clause is composed at the
    // same `??` the override guards.
    const { modes } = resolveComposerPermissionModeList(caps({
      permissions: {
        modes: ['plan'],
        modeOptions: [{ mode: 'plan', label: 'Plan', shortLabel: 'Plan', description: 'Remote plan', remoteModeId: 'plan' }],
      },
      connection: { switchable: true, activeRuntime: 'codex-runtime' },
    }), translateEn)

    expect(modes[0]!.description).toBe('Remote plan')
  })

  it('THE NEGATIVE CONTROL — the rig fails when the runtime stops reaching the picker', () => {
    // The defect R15 fixes, reproduced: nothing in the list mentions the
    // runtime. Written out so the assertions above are known to be able to fail.
    // Since the de-duplication, only TWO items differ on codex, so an
    // item-by-item control would pass on four of six with the wiring gone — the
    // note is what carries it.
    const runtimeBlind = (mode: PermissionMode) => translateEn(PERMISSION_MODE_FULL_DESCRIPTION_KEYS[mode])
    const codex = resolveComposerPermissionModeList(
      caps({ connection: { switchable: true, activeRuntime: 'codex-runtime' } }),
      translateEn,
    )
    expect(codex.runtimeNote).toBeTruthy()
    for (const mode of ['plan'] as const) {
      const display = codex.modes.find(d => d.mode === mode)!
      expect(display.description, mode).not.toBe(runtimeBlind(mode))
    }
    // And the control's own control: with no runtime named, the runtime-blind
    // string IS the right answer, so the check above is discriminating rather
    // than always-true.
    for (const mode of pickerModes) {
      expect(describePermissionModeLine(mode, translateEn), mode).toBe(runtimeBlind(mode))
    }
  })

  it('THE TWO SURFACES CANNOT CONTRADICT: the runtime-less string is a PREFIX of every runtime string', () => {
    // The whole shape of the R15 decision, asserted rather than described.
    // Workspace Settings → Permissions has no runtime and renders
    // `describePermissionModeLine(mode, t)`; the composer renders the same call
    // WITH a runtime. As long as the runtime form only ever EXTENDS the
    // runtime-less form, the two surfaces can differ in detail and never in
    // claim. A clause that negated the general string — the shape the old
    // "never prompts" would have forced — cannot satisfy this.
    for (const locale of Object.values(LOCALE_REGISTRY)) {
      const messages = locale.messages as Record<string, string>
      const translateLocale = (key: string) => messages[key] ?? key
      for (const mode of PERMISSION_MODE_ORDER) {
        const workspaceSettings = describePermissionModeLine(mode, translateLocale)
        expect(workspaceSettings, mode).toBe(messages[PERMISSION_MODE_FULL_DESCRIPTION_KEYS[mode]])
        for (const runtime of ['pi', 'anthropic', 'codex-runtime'] as const) {
          expect(
            describePermissionModeLine(mode, translateLocale, runtime).startsWith(workspaceSettings),
            `${runtime} ${mode}`,
          ).toBe(true)
        }
      }
    }
  })

  it('an untranslated clause or note is dropped rather than rendered as a raw key', () => {
    const clauseBlind = (key: string) => (key.startsWith('chat.permissionModeClause.') ? key : en[key] ?? key)
    expect(describePermissionModeLine('plan', clauseBlind, 'codex-runtime'))
      .toBe(en['mode.planFullDesc'])

    // Each half is dropped on its own, so a locale that has one and not the
    // other still shows a sentence rather than a raw key.
    const noteBlind = (key: string) => (key.startsWith('chat.permissionModeRuntimeNote.') ? key : en[key] ?? key)
    expect(resolveRuntimePermissionModeNote(noteBlind, 'codex-runtime'))
      .toBe(en['chat.permissionModeNote.resumeTable'])

    const resumeBlind = (key: string) => (key === 'chat.permissionModeNote.resumeTable' ? key : en[key] ?? key)
    expect(resolveRuntimePermissionModeNote(resumeBlind, 'codex-runtime'))
      .toBe(en['chat.permissionModeRuntimeNote.codex'])
    expect(resolveRuntimePermissionModeNote(resumeBlind, 'pi')).toBeUndefined()

    const bothBlind = (key: string) =>
      (key.startsWith('chat.permissionModeRuntimeNote.') || key === 'chat.permissionModeNote.resumeTable'
        ? key
        : en[key] ?? key)
    expect(resolveRuntimePermissionModeNote(bothBlind, 'codex-runtime')).toBeUndefined()
  })
})

/**
 * THE FOOTER'S RENDER, pinned on BOTH surfaces.
 *
 * A reviewer replaced the desktop guard with `{false && permissionModeRuntimeNote && (`
 * and the band vanished from the live product — the menu shrank 355.6px → 309.4px on
 * a Codex session — while 176 tests across 19 files stayed green. Every assertion
 * about this change lived in the resolver, so nothing noticed the one thing the
 * owner actually asked for going missing.
 *
 * `bun test` has no DOM in this repo (no happy-dom, no testing-library), so the
 * render is pinned by source match, the same instrument `submit-control.test.ts`
 * uses for its own wiring. The DECISION — one note per list, sized to one line —
 * is behavioural above; this is the wiring that carries it to a screen.
 */
describe('the runtime note reaches both pickers', () => {
  const read = (relative: string) =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

  // UB14.29 — the desktop menu moved out of `FreeFormInput` into v0.15.1's `ComposerModeChip`; the composer
  // threads the note to both surfaces and renders neither band itself.
  const COMPOSER = '../../components/app-shell/input/FreeFormInput.tsx'
  const DESKTOP = '../../components/app-shell/input/ComposerModeChip.tsx'
  const DRAWER = '../../components/app-shell/input/CompactPermissionModeSelector.tsx'

  it('the desktop dropdown renders it once, guarded, and NOT as a menu item', () => {
    const source = read(DESKTOP)
    // The guard: no band when there is no note (Nestor Cloud, a runtime-less set).
    expect({ guard: source.includes('{runtimeNote && (') }).toEqual({ guard: true })
    // The hook both surfaces share, and the one a live check greps for.
    expect({ marker: source.includes('data-permission-mode-runtime-note') }).toEqual({ marker: true })
    // Not selectable: Radix keyboard navigation must skip it, which it does only
    // because this is a plain element rather than a menu item.
    const at = source.indexOf('data-permission-mode-runtime-note')
    const element = source.slice(source.lastIndexOf('<', at), at)
    expect({ element: element.trim() }).toEqual({ element: '<p' })
    // Exactly one render site — the defect this replaces was six copies.
    expect(source.split('data-permission-mode-runtime-note').length - 1).toBe(1)
  })

  it('the compact drawer renders it too, from the same prop', () => {
    // Threaded end-to-end from `FreeFormInput`; the drawer has no live desktop
    // surface today, so this source pin is the only thing standing between it and
    // a silent divergence from the dropdown beside it.
    const drawer = read(DRAWER)
    expect({ marker: drawer.includes('data-permission-mode-runtime-note') }).toEqual({ marker: true })
    // Threaded to BOTH surfaces (the chip and the drawer), and drawn by neither inside the composer itself.
    const composer = read(COMPOSER)
    expect(composer.split('runtimeNote={permissionModeRuntimeNote}').length - 1).toBe(2)
    expect(composer.includes('data-permission-mode-runtime-note')).toBe(false)
  })
})

/**
 * D1.327 — the picker may HIDE a mode; it may not make that mode unenterable.
 *
 * Measured on the packaged 1.40.0 (SIT-5b): asked for `dontAsk`, the app
 * reported the session's mode as `default` on BOTH the pi and the claude card,
 * twice each, while `explore` and `plan` reported themselves in the same runs.
 * The host is not where it happened —
 * `packages/server-core/src/sessions/__tests__/dont-ask-mode-round-trip.test.ts`
 * drives all seven modes through the real `setSessionPermissionMode` and reads
 * them back out of both session projections on both cards. The composer was:
 * it coerced the SESSION's mode against the PICKER's list and then wrote the
 * coerced value back to the host.
 */
describe('D1.327 — a picker-hidden mode is still a mode the session may sit in', () => {
  const read = (relative: string) =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
  const COMPOSER = '../../components/app-shell/input/FreeFormInput.tsx'

  it('the two lists differ by exactly the picker-hidden modes', () => {
    const all = caps({ permissions: { modes: PERMISSION_MODE_ORDER } })
    const supported = getSupportedComposerPermissionModes(all)
    const visible = getVisibleComposerPermissionModes(all)
    expect(supported).toEqual([...PERMISSION_MODE_ORDER])
    expect(supported.filter(mode => !visible.includes(mode))).toEqual(['dontAsk'])
  })

  it('a mode the RUNTIME does not name is absent from both — the coercion keeps its job', () => {
    const narrow = caps({ permissions: { modes: ['plan', 'default'] } })
    expect(getSupportedComposerPermissionModes(narrow)).toEqual(['plan', 'default'])
    expect(getVisibleComposerPermissionModes(narrow)).toEqual(['default', 'plan'])
    // Still coerced, still written back: that is what the effect is for. F1.1070 (DN-272) moved the landing from
    // `default` to `plan` — the read-only neighbour, and the mode Nestor Cloud's wire sends for dontAsk.
    expect(coercePermissionModeForComposer('dontAsk', getSupportedComposerPermissionModes(narrow)))
      .toBe('plan')
  })

  it('`dontAsk` survives the coercion the composer applies, where the old list ate it', () => {
    const all = caps({ permissions: { modes: PERMISSION_MODE_ORDER } })
    expect(coercePermissionModeForComposer('dontAsk', getSupportedComposerPermissionModes(all)))
      .toBe('dontAsk')
    // The OLD reading, kept as the negative arm: against the picker's list the
    // same call still rewrites the mode (to `plan` since F1.1070, `default`
    // before), which is the packaged finding in one line. Deleting the line
    // above would not make this one pass.
    expect(coercePermissionModeForComposer('dontAsk', getVisibleComposerPermissionModes(all)))
      .toBe('plan')
  })

  it('the composer feeds the coercion the SUPPORTED list, and the effect still writes that value', () => {
    const source = read(COMPOSER)
    // The argument, not a line: this is the whole fix.
    expect({ fed: source.includes('coercePermissionModeForComposer(permissionMode, supportedPermissionModes)') })
      .toEqual({ fed: true })
    expect({ built: source.includes('getSupportedComposerPermissionModes(composerCapabilities)') })
      .toEqual({ built: true })
    // The write-back is deliberately KEPT — a mode the runtime cannot honour
    // must still be corrected — so its presence is asserted beside the fix
    // rather than left implied.
    expect({ writesBack: source.includes('onPermissionModeChange?.(effectivePermissionMode)') })
      .toEqual({ writesBack: true })
    // And the picker's own list must not be what the coercion reads again. The
    // needle is the CALL with those arguments, never the bare identifier: a
    // comment naming the helper would satisfy a looser guard forever.
    expect(source).not.toContain('coercePermissionModeForComposer(permissionMode, visiblePermissionModes)')
  })
})

/**
 * D1.336 — `PICKER_HIDDEN_MODES` reaches THREE surfaces, and until this block
 * only one of them said what it intends.
 *
 * D1.327 made a picker-hidden mode enterable again by feeding the composer's
 * coercion the modes the RUNTIME can honour instead of the modes the picker
 * offers. The other two surfaces still narrow on the picker's list, and both are
 * right to: a hidden mode should not be cyclable with SHIFT+TAB, and the
 * slash-command menu should not offer a row it deliberately does not render.
 * Neither had a test saying so, so the next edit to `PICKER_HIDDEN_MODES` would
 * have moved three surfaces at once with one of them silent.
 *
 * This block pins the INTENT, it does not change it. The set itself is
 * module-private, so every case derives it the only way a consumer can — the
 * difference between the two exported lists — and asserts over EVERY member.
 * Adding a mode to the set therefore moves all three cases rather than none.
 */
describe('D1.336 — the three surfaces a picker-hidden mode reaches', () => {
  const read = (relative: string) =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
  const COMPOSER = '../../components/app-shell/input/FreeFormInput.tsx'
  const APP_SHELL = '../../components/app-shell/AppShell.tsx'

  const all = caps({ permissions: { modes: PERMISSION_MODE_ORDER } })
  const visible = getVisibleComposerPermissionModes(all)
  const supported = getSupportedComposerPermissionModes(all)
  /** `PICKER_HIDDEN_MODES`, derived rather than imported: it is module-private. */
  const hidden = supported.filter(mode => !visible.includes(mode))

  it('SURFACE 1 — the slash-command menu will not dispatch a hidden mode, and the composer feeds it the VISIBLE list', () => {
    // Without this line the loop below is vacuous, and a vacuous loop is the
    // shape an emptied `PICKER_HIDDEN_MODES` would take.
    expect(hidden.length).toBeGreaterThan(0)

    for (const mode of hidden) {
      const written: PermissionMode[] = []
      const handled = dispatchSlashCommandAction(mode, {
        onPermissionModeChange: next => written.push(next),
        allowedPermissionModes: visible,
      })
      // Not handled AND nothing written — two different failures, and the
      // second is the one that would reach the host.
      expect({ mode, handled, written }).toEqual({ mode, handled: false, written: [] })
    }

    // The control on the same instrument: every VISIBLE mode IS dispatched and
    // written, so the assertions above cannot be passing because the dispatch
    // is broken for permission modes generally.
    for (const mode of visible) {
      const written: PermissionMode[] = []
      const handled = dispatchSlashCommandAction(mode, {
        onPermissionModeChange: next => written.push(next),
        allowedPermissionModes: visible,
      })
      expect({ mode, handled, written }).toEqual({ mode, handled: true, written: [mode] })
    }

    // And the list the composer hands that dispatch is the PICKER's — which is
    // the whole of what makes this case be about the menu rather than about
    // `dispatchSlashCommandAction`'s own filter. The needle is the property
    // with its value, never the bare identifier.
    const composer = read(COMPOSER)
    expect({ feeds: composer.includes('allowedPermissionModes: visiblePermissionModes') })
      .toEqual({ feeds: true })
    expect(composer).not.toContain('allowedPermissionModes: supportedPermissionModes')
  })

  it('SURFACE 2 — SHIFT+TAB never lands on a hidden mode, and a workspace setting cannot re-admit one', () => {
    expect(hidden.length).toBeGreaterThan(0)

    // `AppShell.tsx`'s `chat.cyclePermissionMode`, copied rather than
    // re-derived, for the reason `applyWorkspaceCycleToComposerModes` gives
    // about the click path: the point is that the two agree.
    // F1.1052: the step itself is `nextCyclePermissionMode`, the helper AppShell calls.
    const cycleOnce = (current: PermissionMode, cyclable?: PermissionMode[]): PermissionMode => {
      const capabilityModes = getVisibleComposerPermissionModes(all)
      const workspaceModes = resolveWorkspaceCyclablePermissionModes(cyclable)
      const intersectedModes = capabilityModes.filter(mode => workspaceModes.includes(mode))
      const modes = intersectedModes.length >= 2 ? intersectedModes : capabilityModes
      return nextCyclePermissionMode(current, modes)!
    }

    const lap = (cyclable?: PermissionMode[]): PermissionMode[] => {
      const landed: PermissionMode[] = []
      // From EVERY mode, hidden ones included: a session sitting in a hidden
      // mode is exactly the state D1.327 made reachable, and SHIFT+TAB from
      // there is the question this case answers.
      for (const start of PERMISSION_MODE_ORDER) {
        let mode = start
        for (let step = 0; step < PERMISSION_MODE_ORDER.length + 1; step += 1) {
          mode = cycleOnce(mode, cyclable)
          landed.push(mode)
        }
      }
      return landed
    }

    const defaultWorkspace = lap()
    expect(defaultWorkspace.filter(mode => hidden.includes(mode))).toEqual([])
    // The control: the lap is not empty and it does move — an always-`default`
    // cycle would satisfy the line above for the wrong reason.
    expect(new Set(defaultWorkspace).size).toBeGreaterThan(1)

    // A workspace that NAMES a hidden mode in `cyclablePermissionModes` still
    // cannot cycle into it: the runtime list is filtered before the workspace
    // list is intersected, and an intersection only ever narrows.
    const namesTheHiddenMode = lap([...hidden, 'plan', 'default'])
    expect(namesTheHiddenMode.filter(mode => hidden.includes(mode))).toEqual([])
    expect(new Set(namesTheHiddenMode).size).toBeGreaterThan(1)

    // And the cycle reads the PICKER's list, which is what keeps this case
    // about SHIFT+TAB. The positive control for the negative needle is the
    // composer, where that exact call DOES appear — so the string is one this
    // corpus can spell, and its absence here is a reading rather than a typo.
    const appShell = read(APP_SHELL)
    expect({ narrows: appShell.includes('getVisibleComposerPermissionModes(composerCapabilities)') })
      .toEqual({ narrows: true })
    expect(appShell).not.toContain('getSupportedComposerPermissionModes(composerCapabilities)')
    expect({ spellable: read(COMPOSER).includes('getSupportedComposerPermissionModes(composerCapabilities)') })
      .toEqual({ spellable: true })
  })

  it('SURFACE 3 — the composer writes nothing back for a hidden mode the runtime honours (D1.327)', () => {
    expect(hidden.length).toBeGreaterThan(0)

    // `FreeFormInput.tsx`'s effect as a predicate: it calls
    // `onPermissionModeChange` — a WRITE to the host — exactly when the coerced
    // value differs from the session's own mode.
    const writesBack = (mode: PermissionMode, capabilities: ComposerCapabilities): boolean =>
      coercePermissionModeForComposer(mode, getSupportedComposerPermissionModes(capabilities)) !== mode

    for (const mode of hidden) {
      expect({ mode, writesBack: writesBack(mode, all) }).toEqual({ mode, writesBack: false })
    }

    // The arm the write-back exists for, and the one D1.327 deliberately kept:
    // a runtime that does not name the mode still gets it corrected.
    const narrow = caps({ permissions: { modes: ['plan', 'default'] } })
    for (const mode of hidden) {
      expect({ mode, writesBack: writesBack(mode, narrow) }).toEqual({ mode, writesBack: true })
    }

    // The packaged finding in one line: against the PICKER's list — the list
    // the composer used until D1.327 — every hidden mode was written back, on
    // both the pi and the claude card, within a render of mounting.
    for (const mode of hidden) {
      const coerced = coercePermissionModeForComposer(mode, getVisibleComposerPermissionModes(all))
      expect({ mode, wroteBack: coerced !== mode }).toEqual({ mode, wroteBack: true })
    }
  })
})

/**
 * F1.1052 — the picker is Claude Desktop's (the owner's MODES-SPEC, 2026-09-28):
 * Auto "Recommended", Manual, Accept edits, Plan, Bypass permissions, numbered
 * 1–5; a "Default" badge on the configured default; `dontAsk` never offered but
 * named "Don't ask" wherever a session's mode is shown. Nestor Cloud's picker is
 * Nestor's and stays as it was.
 */
describe('F1.1052 — Claude Desktop\'s mode picker', () => {
  const all = caps({ permissions: { modes: PERMISSION_MODE_ORDER } })
  const nestor = caps({
    permissions: {
      modes: ['plan', 'default'],
      modeOptions: [
        { mode: 'plan', label: 'Plan', shortLabel: 'Plan', description: 'Remote plan', remoteModeId: 'plan' },
        { mode: 'default', label: 'Act', shortLabel: 'Act', description: 'Remote act', remoteModeId: 'act' },
      ],
    },
  })

  it('ORDER: the picker lists Auto, Manual, Accept edits, Plan, Bypass permissions — the labels read so', () => {
    const { modes } = resolveComposerPermissionModeList(all, translateEn)
    expect(modes.map(d => d.mode)).toEqual(['auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions'])
    expect(modes.map(d => d.label)).toEqual(['Auto', 'Manual', 'Accept edits', 'Plan', 'Bypass permissions'])
    // The clamp's strictness order is untouched — the picker order is a UI order only.
    expect(PERMISSION_MODE_ORDER).toEqual(['dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'])
  })

  it('ORDER BOUNDARY: a capability list in any order, or naming the hidden mode first, still yields the picker order', () => {
    const shuffled = caps({ permissions: { modes: ['bypassPermissions', 'dontAsk', 'plan', 'auto', 'acceptEdits', 'default'] } })
    expect(getVisibleComposerPermissionModes(shuffled)).toEqual([...PERMISSION_MODE_PICKER_ORDER])
    // No capabilities at all (a session whose meta has not arrived) — the same list, never PERMISSION_MODE_ORDER.
    expect(getVisibleComposerPermissionModes(undefined)).toEqual([...PERMISSION_MODE_PICKER_ORDER])
  })

  it('HIDDEN dontAsk: never offered, never cycled into, but a session in it reads "Don\'t ask"', () => {
    expect(getVisibleComposerPermissionModes(all)).not.toContain('dontAsk')
    expect(findComposerPermissionModeDisplay([], 'dontAsk', translateEn)).toMatchObject({
      label: "Don't ask",
      shortLabel: "Don't ask",
    })
    for (const code of Object.keys(LOCALE_REGISTRY)) {
      const messages = LOCALE_REGISTRY[code as keyof typeof LOCALE_REGISTRY].messages as Record<string, string>
      for (const key of ['mode.dontAsk', 'mode.dontAskShort']) {
        expect(messages[key], `${code}/${key}`).toBeTruthy()
        expect(messages[key]!.toLowerCase(), `${code}/${key}`).not.toMatch(/unattended|quiet|без запросов|тихо/)
      }
    }
    // Both clients agree (F1.1165): the iPhone's ru table says «Не спрашивать».
    expect((LOCALE_REGISTRY.ru.messages as Record<string, string>)['mode.dontAsk']).toBe('Не спрашивать')
  })

  it('HIDDEN BOUNDARY: SHIFT+TAB from dontAsk lands on Manual — never on Plan\'s neighbour, Bypass permissions', () => {
    const ring = getVisibleComposerPermissionModes(all)
    expect(nextCyclePermissionMode('dontAsk', ring)).toBe('default')
    // The ring itself is Claude's CLI cycle read as a ring: default → acceptEdits → plan → bypass → auto → default.
    const lap: PermissionMode[] = []
    let mode: PermissionMode = 'default'
    for (let step = 0; step < ring.length; step += 1) {
      mode = nextCyclePermissionMode(mode, ring)!
      lap.push(mode)
    }
    expect(lap).toEqual(['acceptEdits', 'plan', 'bypassPermissions', 'auto', 'default'])
    // Without Manual in the ring an outside mode takes the ring's first; an empty ring cannot cycle.
    expect(nextCyclePermissionMode('dontAsk', ['plan', 'acceptEdits'])).toBe('plan')
    expect(nextCyclePermissionMode('default', [])).toBeUndefined()
  })

  it('BADGES: Recommended on Auto, Default on the configured default, digits 1–5 on the rendered rows', () => {
    const rows = resolveComposerPermissionModeList(all, translateEn).modes
      .map(withPermissionModeMenuDecorations('bypassPermissions'))
    expect(rows.map(row => [row.mode, row.decorations])).toEqual([
      ['auto', { recommended: true, isDefault: false, shortcut: 1 }],
      ['default', { recommended: false, isDefault: false, shortcut: 2 }],
      ['acceptEdits', { recommended: false, isDefault: false, shortcut: 3 }],
      ['plan', { recommended: false, isDefault: false, shortcut: 4 }],
      ['bypassPermissions', { recommended: false, isDefault: true, shortcut: 5 }],
    ])
    expect(en['chat.permissionModeBadge.recommended']).toBe('Recommended')
    expect(en['chat.permissionModeBadge.default']).toBe('Default')
  })

  it('BADGES BOUNDARY: Nestor Cloud\'s rows get none, an unknown default draws no Default badge, digits stop at 9', () => {
    const cloudRows = resolveComposerPermissionModeList(nestor, translateEn).modes
      .map(withPermissionModeMenuDecorations('default'))
    expect(cloudRows.map(row => row.decorations)).toEqual([
      { recommended: false, isDefault: false },
      { recommended: false, isDefault: false },
    ])
    expect(resolvePermissionModeMenuDecorations({ mode: 'auto' }, 0, undefined))
      .toEqual({ recommended: true, isDefault: false, shortcut: 1 })
    expect(resolvePermissionModeMenuDecorations({ mode: 'plan' }, 9, 'plan'))
      .toEqual({ recommended: false, isDefault: true })
  })

  it('DIGITS: a digit clicks the row that carries it; a modifier, a digit no row carries, or a letter does nothing', () => {
    const clicked: string[] = []
    const rows = new Map(['1', '2'].map(digit => [digit, { click: () => clicked.push(digit) }]))
    const menu = {
      querySelector: (selector: string) => rows.get(/"(\d)"/.exec(selector)?.[1] ?? '') ?? null,
    } as unknown as ParentNode
    const press = (key: string, modifiers: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey', boolean>> = {}) => {
      let prevented = false
      selectPermissionModeByDigit({
        key, metaKey: false, ctrlKey: false, altKey: false, ...modifiers,
        currentTarget: menu, preventDefault: () => { prevented = true },
      })
      return prevented
    }
    expect(press('2')).toBe(true)
    expect(clicked).toEqual(['2'])
    expect(press('1', { metaKey: true })).toBe(false)
    expect(press('7')).toBe(false)
    expect(press('a')).toBe(false)
    expect(clicked).toEqual(['2'])
  })

  it('the desktop dropdown wires the digits, the badges and the check through the shared row parts', () => {
    // UB14.29 — the desktop menu is `ComposerModeChip`'s; the composer still builds the decorated rows and feeds it
    // the coerced session mode (its own render is pinned in `composer-mode-chip.test.tsx`).
    const source = readFileSync(fileURLToPath(new URL('../../components/app-shell/input/ComposerModeChip.tsx', import.meta.url)), 'utf8')
    expect(source).toContain('onKeyDown={selectPermissionModeByDigit}')
    expect(source).toContain('data-permission-mode-shortcut={display.decorations?.shortcut}')
    expect(source).toContain('<PermissionModeItemTitle label={display.label} decorations={display.decorations} />')
    expect(source).toContain('<PermissionModeItemTrailing current={display.mode === optimisticMode}')
    const composer = readFileSync(fileURLToPath(new URL('../../components/app-shell/input/FreeFormInput.tsx', import.meta.url)), 'utf8')
    expect(composer).toContain('.map(withPermissionModeMenuDecorations(appShellContext?.defaultPermissionMode))')
    expect(composer).toMatch(/<ComposerModeChip\s+permissionMode=\{effectivePermissionMode\}/)
    const drawer = readFileSync(fileURLToPath(new URL('../../components/app-shell/input/CompactPermissionModeSelector.tsx', import.meta.url)), 'utf8')
    expect(drawer).toContain('<PermissionModeItemTitle label={display.label} decorations={display.decorations} />')
    // The drawer names a mode it does not list by that mode, not by its first row.
    expect(drawer).not.toContain('?? permissionModeDisplays[0]')
  })
})
