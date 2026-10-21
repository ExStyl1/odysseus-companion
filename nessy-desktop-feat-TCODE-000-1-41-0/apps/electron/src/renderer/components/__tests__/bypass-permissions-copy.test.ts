/**
 * P6.229 — the Full Access warning says what the mode means on THIS runtime,
 * and names the safer mode.
 *
 * The row's premise ("nothing warns a user, before Full Access is enabled")
 * is refuted at HEAD: `BypassPermissionsDialog` has existed as a one-time
 * responsibility gate with a durable acknowledgment. What it lacked is the two
 * things the row's `done_means` names, and both are copy.
 *
 * These assertions are on the COPY rather than on a render, deliberately: the
 * dialog is a static component behind a radix portal, so a render test would
 * pin the portal and the provider stack rather than the sentence, and the
 * sentence is the whole deliverable. What a render cannot regress, and this
 * can, is someone editing the runtime note back into a uniform promise.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const localesDir = fileURLToPath(new URL(
  '../../../../../../packages/shared/src/i18n/locales/',
  import.meta.url,
))
const load = (locale: string): Record<string, string> =>
  JSON.parse(readFileSync(`${localesDir}${locale}.json`, 'utf-8')) as Record<string, string>

const dialogSource = readFileSync(
  fileURLToPath(new URL('../BypassPermissionsDialog.tsx', import.meta.url)),
  'utf-8',
)

/**
 * The escape hatch's settings key, read out of the module that DEFINES it
 * rather than retyped here — the note names a key an operator types into their
 * settings file, and a copy of that key in a test is one rename away from
 * pinning a name the product no longer has. Read as source, not imported, for
 * the same reason the rest of this file reads source: no module graph.
 */
const unattendedFallbackSettingKey = (() => {
  const source = readFileSync(
    fileURLToPath(new URL(
      '../../../../../../packages/shared/src/config/unattended-approval.ts',
      import.meta.url,
    )),
    'utf-8',
  )
  const match = /UNATTENDED_APPROVAL_FALLBACK_SETTING_KEY = '([^']+)'/.exec(source)
  if (!match) throw new Error('UNATTENDED_APPROVAL_FALLBACK_SETTING_KEY not found in unattended-approval.ts')
  return match[1]!
})()

describe('the Full Access warning', () => {
  it('renders both new keys, so the copy is not orphaned in the locale file', () => {
    expect(dialogSource).toContain('dialog.bypassPermissions.runtimeNote')
    expect(dialogSource).toContain('dialog.bypassPermissions.recommendation')
  })

  it('names the measured per-runtime narrowing in every locale', () => {
    // The one divergence this product has measured for the mode: on codex,
    // `danger-full-access` resolves to `workspaceWrite` because the host's
    // `:workspace`-extending profile supersedes it (P3.315; owner sitting §3.1 =
    // report honestly). Since F1.1057 that profile carries the protected-path
    // floor (C3.343), not a credential one — see the F1.1068 block. The existing
    // `description` promises "network access included", which is true on two
    // runtimes and overstates on the third.
    for (const locale of ['en', 'ru']) {
      const note = load(locale)['dialog.bypassPermissions.runtimeNote']
      expect({ locale, present: typeof note === 'string' && note.length > 0 })
        .toEqual({ locale, present: true })
      // Named runtimes, not "some runtimes": a note that does not say WHICH is
      // the same silent divergence in prose form.
      expect({ locale, codex: /codex/i.test(note!) }).toEqual({ locale, codex: true })
      expect({ locale, claude: /claude/i.test(note!) }).toEqual({ locale, claude: true })
      expect({ locale, pi: /\bPi\b/i.test(note!) }).toEqual({ locale, pi: true })
    }
  })

  it('names what an unattended codex turn answers, and the setting that opens it', () => {
    // P6.531 (`61d6c51ca`) made an unattended codex turn REFUSE a call no rule
    // and no floor covers, in every mode except `dontAsk` — this one included:
    // the block sits above the `bypassPermissions` answer, so with nobody
    // attached the mode skips the prompt and the call still does not run. The
    // note used to end "…while every prompt is still skipped", which is true
    // about prompts and was read as a promise about execution.
    //
    // Guarding the SUCCESSOR — the setting is named — rather than the absence
    // of the old words: a `not.toContain` of a retired sentence fires on the
    // very commit that retires it, because the comment explaining the change
    // spells it (AGENTS.md §Traps, the stale-NAME guard).
    for (const locale of ['en', 'ru']) {
      const note = load(locale)['dialog.bypassPermissions.runtimeNote']!
      expect({ locale, namesTheEscapeHatch: note.includes(unattendedFallbackSettingKey) })
        .toEqual({ locale, namesTheEscapeHatch: true })
    }
    // And the mode's own one-line description no longer promises the approval
    // itself, only the absence of the prompt — the two surfaces have to agree,
    // and the description is the one a user reads BEFORE the dialog exists.
    // Pinned verbatim in both locales rather than probed for a keyword: a
    // keyword either language happens to satisfy would let the promise come
    // back in the other, and this sentence is a safety claim, not a label.
    // Re-cut 2026-09-11 (W13-k's hand-off): the first re-cut ran to 82 / 107
    // characters against the picker's measured one-line budgets of 78 / 72 in
    // `composer-permission-modes.test.ts`, and the RU one opened with an
    // absolute that suite bans — so both strings now sit inside both gates.
    // F1.1052 (owner's MODES-SPEC, 2026-09-28): Claude Desktop's own words lead
    // ("Accepts all permissions"), and the refusal half this pin exists for stays.
    expect(load('en')['mode.bypassPermissionsFullDesc'])
      .toBe('Accepts all permissions; some calls are still refused.')
    expect(load('ru')['mode.bypassPermissionsFullDesc'])
      .toBe('Разрешает всё, но некоторые вызовы всё равно отклоняются.')
  })

  it('recommends a specific safer mode rather than "be careful", in every locale', () => {
    for (const locale of ['en', 'ru']) {
      const line = load(locale)['dialog.bypassPermissions.recommendation']
      expect({ locale, namesAuto: /auto/i.test(line ?? '') }).toEqual({ locale, namesAuto: true })
    }
    // The control: the pre-existing description is untouched and still carries
    // the blanket promise, so this row added a qualifier rather than quietly
    // rewriting the warning it was asked to extend.
    expect(load('en')['dialog.bypassPermissions.description'])
      .toContain('without approval prompts')
  })
})

/**
 * F1.534 (origin WJ-at P-WJat-2, DECIDED 2026-09-24: HONEST, not uniform). With
 * Codex auto-review on, Bypass on codex still hands what codex raises (an MCP
 * call, an escalated command) to codex's reviewer. Mapping Bypass to codex's
 * `never` would make it "no approval" and would also switch off every floor
 * this product keeps in Bypass on all runtimes (`config-writer.ts`, P2.197:
 * "Where a non-negotiable floor exists: all seven modes"). And the reviewer here
 * is the counterpart of Pi's Guardian, which still screens risky actions in
 * Bypass when it is on (`pi-agent.ts`, `consultGuardianDenyNet`). So the
 * difference stays, and the note the user meets before Bypass says it.
 */
describe('F1.534 · the Bypass note says the Codex reviewer still answers in this mode', () => {
  it('en and ru name the Codex reviewer in Bypass, and Pi\'s Guardian beside it', () => {
    expect(load('en')['dialog.bypassPermissions.runtimeNote'])
      .toContain("With Codex auto-review on, Codex's reviewer still answers the actions Codex raises in this mode")
    expect(load('en')['dialog.bypassPermissions.runtimeNote']).toContain("Pi's Guardian")
    expect(load('ru')['dialog.bypassPermissions.runtimeNote'])
      .toContain('Если включено авто-ревью Codex, его проверяющий по-прежнему отвечает на действия, которые Codex поднимает в этом режиме')
    expect(load('ru')['dialog.bypassPermissions.runtimeNote']).toContain('Guardian')
  })
})

/**
 * F1.1068 (origin DN-242). F1.1057 (`df107c0b5`) took the host's credential
 * floor out of every codex permission profile, and the note kept crediting it
 * with bounding Codex's writes. The bound itself is unchanged: `CodexAgent`
 * still hands codex `PROTECTED_DIRECTORIES` as `read` entries under
 * `":workspace_roots"` (C3.343, `codexProtectedWorkspaceSubpaths`), so a
 * profile is always written, it `extends = ":workspace"`, and codex resolves it
 * ahead of `sandbox_mode = "danger-full-access"` (P3.315). What that parent
 * allows is codex's own `FileSystemSandboxPolicy::workspace_write`
 * (`protocol/src/permissions.rs`, `rust-v0.156.1`, called with no extra roots
 * by `extensible_builtin_parent_profile` in `core/src/config/permissions.rs`):
 * read everywhere, write to the workspace roots, `:slash_tmp` and `:tmpdir` —
 * plus each added directory the host's profile lists as `write`.
 */
describe('F1.1068 · the Bypass note credits Codex\'s own workspace sandbox, not a credential floor', () => {
  it('en and ru name Codex\'s workspace sandbox, the protected folders and the roots it still writes to', () => {
    const en = load('en')['dialog.bypassPermissions.runtimeNote']!
    expect(en).toContain("Codex's own workspace sandbox stays on even in this mode")
    expect(en).toContain('keep .git and the other protected folders read-only')
    expect(en).toContain('outside the workspace, the temp folders and any folder you added are still refused')
    const ru = load('ru')['dialog.bypassPermissions.runtimeNote']!
    expect(ru).toContain('собственная песочница Codex для рабочей папки')
    expect(ru).toContain('.git и другие защищённые папки только для чтения')
    expect(ru).toContain('за пределами рабочей папки, временных папок и добавленных вами папок всё равно отклоняется')
  })

  it('en and ru no longer credit a credential floor for the Codex bound', () => {
    // Read off the locale VALUE, not this file, so the sentence explaining the
    // change above cannot trip it.
    expect(load('en')['dialog.bypassPermissions.runtimeNote']).not.toMatch(/credential/i)
    expect(load('ru')['dialog.bypassPermissions.runtimeNote']).not.toContain('учётных данных')
  })
})
