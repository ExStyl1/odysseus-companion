/**
 * UA5.7 — the folder-vs-project copy pass (spec §12 "Naming": "Project" means the entity; existing strings that mean
 * a folder are reworded to "folder" in en and ru). No key is added or removed: the row rewords values only.
 *
 * UA12.94 — the two English values that kept the word "project" as CDP anchors say folder now: `projectTrust.title`
 * is "Trust this folder?" and `projectTrust.trust` "Trust folder". They moved in ONE commit with every reader: the
 * case-local heading finders (`cru-1`, `cru-6`, `pkg-6`, `rs-51`, `rs-53`, `rs-87`, `rs-116`) read
 * `TRUST_GATE_HEADING_IN_PAGE` from `scripts/cdp/lib/runtime-switch.ts` instead of `/trust this project/i`, and that,
 * like `TRUST_GATE_TITLES` / `TRUST_GATE_BUTTON` (UA12.123), comes from en.json AND ru.json, so no finder spells the
 * copy again. The Russian values never had the anchor and say "папка" throughout (unchanged).
 *
 * UA12.95 — the CODE-side folder strings a locale pass cannot reach were reworded to the same folder wording:
 * the renderer `defaultValue` fallbacks in `ServerDirectoryBrowser.tsx`, `ProjectTrustDialog.tsx`,
 * `ProjectContributionsList.tsx` and `WorkspaceSettingsPage.tsx` (origin P-UAan-2, plus the two further
 * fallbacks of those files that still called the folder a project), and the OS picker title in
 * `rpc/projects.ts`'s `PICK_LOCAL_DIRECTORY` (no key exists for it — it mirrors `projects.selectFolder`).
 * `projectTrust.trust`'s fallback read UA12.94's target ("Trust folder") first; UA12.94 then moved the en VALUE
 * and the title's fallback ("Trust this folder?") with the CDP anchors, so every fallback now equals its en value.
 * The last describe below reads those sources.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Dict = Record<string, string>
const readLocale = (lang: string): Dict =>
  JSON.parse(readFileSync(join(import.meta.dir, '../locales', `${lang}.json`), 'utf-8')) as Dict
const EN = readLocale('en')
const RU = readLocale('ru')
/** "folder" in Russian, every case form: папка, папки, папке, папку, папкой — and the genitive plural папок. */
const FOLDER_RU = /пап(?:к|ок)/i

/** Every value this row rewords: each now names a folder, and none calls that folder a project. */
const REWORDED = [
  'chat.runtimeSwitch.costWorktree',
  'chat.sessionStorageWorkingDirectory',
  'projectTrust.description',
  'projectTrust.provides.title',
  'projectTrust.title',
  'projectTrust.updateFailed',
  'projects.invalidFolder',
  'projects.localOnlyNote',
  'projects.selectFolder',
  'settings.permissions.primaryFolderDerived',
  'settings.permissions.primaryFolderDesc',
  'settings.workspace.defaultProjectFolder',
  'toast.couldNotOpenChatDefaultFolder',
] as const

/** The harness anchors (header): English values in REWORDED that may still contain "project" — none since UA12.94. */
const EN_HARNESS_ANCHORS = new Set<string>([])

/** The entity's own string families (UA5.8, UA5.9 and UA5.10 add them; upstream v0.13.4 names them so). */
const ENTITY_PREFIXES = ['projectInfo.', 'projectsList.', 'sidebar.projects', 'sidebar.allProjects', 'sidebarMenu.addProject']

/**
 * A string in an entity family that says FOLDER is calling the entity a folder — unless its KEY names the folder
 * field itself (`projectInfo.workingDirectory*`, upstream's "Working directory" and "/absolute/path/to/folder"), or
 * the folder it names IS that field: a mention of the working folder ("working folder", ru "рабочая папка" in any
 * case form) is removed before matching, so a sentence ABOUT the entity that lists its working-folder setting
 * (upstream `projectsList.emptyDescription`, UA5.8) is not read as the entity being called a folder.
 */
const WORKING_FOLDER_FIELD = /working\s+(?:folder|directory)|рабоч\S*\s+пап\S*/gi
function entityStringsSayingFolder(dict: Dict): string[] {
  return Object.keys(dict).filter((key) => {
    if (!ENTITY_PREFIXES.some(prefix => key.startsWith(prefix)) || /workingDirectory|folder/i.test(key)) return false
    const value = dict[key]!.replace(WORKING_FOLDER_FIELD, '')
    return /folder/i.test(value) || FOLDER_RU.test(value)
  })
}

describe('UA5.7 — strings that mean a folder say folder', () => {
  it('positive: the trust dialog says folder (title, description, contributions heading, failure) in en and ru', () => {
    for (const key of ['projectTrust.title', 'projectTrust.description', 'projectTrust.provides.title', 'projectTrust.updateFailed']) {
      expect(EN[key], `en ${key}`).toMatch(/folder/i)
      expect(RU[key], `ru ${key}`).toMatch(FOLDER_RU)
    }
    expect(RU['projectTrust.trust']).toBe('Доверять папке')
  })

  it('positive: every reworded value names a folder, and none (bar the harness anchor) calls it a project', () => {
    for (const key of REWORDED) {
      expect(EN[key], `en ${key}`).toMatch(/folder/i)
      expect(RU[key], `ru ${key}`).toMatch(FOLDER_RU)
      if (!EN_HARNESS_ANCHORS.has(key)) expect(EN[key], `en ${key}`).not.toMatch(/project/i)
      expect(RU[key], `ru ${key}`).not.toMatch(/проект/i)
    }
  })

  it('boundary (UA12.94): the title and the button say folder, and neither says project any more', () => {
    expect(EN['projectTrust.title']).toBe('Trust this folder?')
    expect(EN['projectTrust.trust']!.replace(/\s+/g, ' ').trim().toLowerCase()).toBe('trust folder')
    for (const key of ['projectTrust.title', 'projectTrust.trust']) expect(EN[key], `en ${key}`).not.toMatch(/project/i)
  })
})

describe('UA5.7 — no entity string calls the project a folder', () => {
  it('negative: no projectInfo.* / projectsList.* / sidebar project string says folder for the entity (en, ru)', () => {
    expect(entityStringsSayingFolder(EN)).toEqual([])
    expect(entityStringsSayingFolder(RU)).toEqual([])
  })

  it('control: the detector fires on a planted entity string and spares the folder field\'s own keys', () => {
    expect(entityStringsSayingFolder({
      'projectInfo.deleteConfirm': 'Delete folder {{name}}? Sessions will be unlinked but not deleted.',
      'projectsList.empty': 'Папок пока нет',
      'projectInfo.workingDirectoryPlaceholder': '/absolute/path/to/folder',
      'projectInfo.title': 'Name',
      'projectTrust.title': 'Trust this folder?',
    })).toEqual(['projectInfo.deleteConfirm', 'projectsList.empty'])
  })

  it('boundary: a string that names the working-folder FIELD inside an entity sentence is not the entity called a folder', () => {
    // upstream v0.13.4 projectsList.emptyDescription ("… settings — working directory, details, and assets — …") in this
    // row's own wording (en "working folder") and ru's convention ("рабочая папка"), next to a planted entity string.
    expect(entityStringsSayingFolder({
      'projectsList.emptyDescription': 'Each project\'s settings — working folder, details, and assets — are injected.',
      'projectsList.emptyDescriptionRu': 'Настройки каждого проекта — рабочая папка, описание и ресурсы — добавляются.',
      'projectsList.emptyDescriptionDir': 'Each project\'s settings — working directory, details, and assets.',
      'projectsList.deleted': 'Deleted folder {{name}} (its working folder is kept)',
    })).toEqual(['projectsList.deleted'])
  })
})

/**
 * UA12.95 — the source read of the code-side fallbacks (origin P-UAan-2's control). Every reworded
 * `defaultValue` carries the same folder wording its key has in en (the fallback must not disagree with the
 * dictionary it backs); the OS picker title in `rpc/projects.ts` has no key and mirrors
 * `projects.selectFolder`; the trust dialog's title and button fallbacks equal their en values (UA12.94).
 */
describe('UA12.95 — the code-side folder strings say folder too', () => {
  const ROOT = join(import.meta.dir, '../../../../..')
  const source = {
    picker: readFileSync(join(ROOT, 'packages/server-core/src/handlers/rpc/projects.ts'), 'utf-8'),
    browser: readFileSync(join(ROOT, 'apps/electron/src/renderer/components/ServerDirectoryBrowser.tsx'), 'utf-8'),
    dialog: readFileSync(join(ROOT, 'apps/electron/src/renderer/components/workspace/ProjectTrustDialog.tsx'), 'utf-8'),
    contributions: readFileSync(join(ROOT, 'apps/electron/src/renderer/components/workspace/ProjectContributionsList.tsx'), 'utf-8'),
    settings: readFileSync(join(ROOT, 'apps/electron/src/renderer/pages/settings/WorkspaceSettingsPage.tsx'), 'utf-8'),
  }
  const fallback = (value: string | undefined): string => `defaultValue: '${value}'`

  it('positive: every reworded defaultValue carries its key\'s en folder wording', () => {
    // The premise of the OS title: it mirrors `projects.selectFolder`'s en value.
    expect(EN['projects.selectFolder']).toBe('Select working folder')
    expect(source.picker).toContain("title: 'Select working folder'")
    expect(source.browser).toContain(fallback(EN['projects.invalidFolder']))
    expect(source.browser).toContain(fallback(EN['projects.selectFolder']))
    expect(source.dialog).toContain(fallback(EN['projectTrust.description']))
    expect(source.dialog).toContain(fallback(EN['projectTrust.updateFailed']))
    expect(source.contributions).toContain(fallback(EN['projectTrust.provides.title']))
    expect(source.settings).toContain(fallback(EN['settings.workspace.defaultProjectFolder']))
    expect(source.settings).toContain(fallback(EN['settings.workspace.defaultProjectFolderDesc']))
  })

  it('negative: no code-side fallback still calls the folder a project', () => {
    expect(source.picker).not.toContain('Select Project Folder')
    expect(source.browser).not.toContain('Select an existing project folder.')
    expect(source.browser).not.toContain('Select project folder')
    expect(source.dialog).not.toContain('Trusted projects may use project-scoped skills, hooks, and tools.')
    expect(source.dialog).not.toContain('Could not update project trust.')
    expect(source.dialog).not.toContain("defaultValue: 'Trust project'")
    expect(source.contributions).not.toContain('This project provides')
    expect(source.settings).not.toContain('Default project folder')
    expect(source.settings).not.toContain('Used as the starting project folder for new chats.')
  })

  it('boundary (UA12.94): the trust title and button fallbacks equal their en values, and neither says project', () => {
    expect(source.dialog).toContain(fallback(EN['projectTrust.trust']))
    expect(source.dialog).toContain(fallback(EN['projectTrust.title']))
    expect(source.dialog).toMatch(/projectTrust\.title', \{ defaultValue: 'Trust this folder\?' \}/)
    expect(source.dialog).not.toContain('Trust this project folder?')
  })
})
