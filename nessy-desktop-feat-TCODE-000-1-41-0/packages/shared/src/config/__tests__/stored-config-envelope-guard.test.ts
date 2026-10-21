/**
 * P6.719 — the structural guard on the strict stored-config envelope.
 *
 * `StoredConfigTopLevelSchema` is `z.object(StoredConfigKnownFields).strict()`
 * and `loadStoredConfig()` throws `UnsupportedStorageLayoutError` when that
 * parse fails, so ONE top-level key that a reader or a setter names but the
 * envelope does not declare does not get ignored — it REFUSES the whole
 * `config.json` and costs the user every OTHER setting in it. The failure is
 * invisible in code review because the reader looks complete: it is the
 * ABSENCE, two files away, that bricks the file.
 *
 * Three occurrences in one wave were fixed one consumer at a time, which is
 * why this exists as a structure rather than as a fourth fix:
 *
 * 1. **P6.390 / P6.174 — `autoMemoryDirectory` and `plansDirectory`.** Both
 *    readers shipped in `storage.ts`; neither key was declared, so a user
 *    following `settings-reference.md#automemorydirectory` lost the file.
 *    Closed by W8-hz (`298c3c384`).
 * 2. **P6.686 — the three keys a delivered-policy fixture lacked.** The same
 *    class one layer out: a list of keys maintained by hand fell behind the
 *    keys that had landed.
 * 3. **P6.361 — `workspaceActions`.** Found by trying to READ the store rather
 *    than by reasoning about it: the feature was unreachable by construction,
 *    because declaring one action refused the whole file.
 *
 * And a FOURTH, found by this guard on its first run rather than by a user:
 * **`unattendedApprovalFallback`** (`config/unattended-approval.ts`), read out
 * of `loadStoredConfig()` at `codex-agent.ts` and named to the user by
 * `describeUnattendedApprovalRefusal()` — *"Set `unattendedApprovalFallback` to
 * \"allow\"…"*. Following that sentence refused the whole `config.json`.
 * Declared in the same commit as this file.
 *
 * ## Why the key list is SCANNED and never typed here
 *
 * A hand-maintained list in a test is the same artefact as a hand-maintained
 * list in a schema, one file further away — it goes stale in the same silence.
 * So the keys come from the modules themselves, out of two sources whose shapes
 * this package already uses everywhere:
 *
 * - `config/storage.ts` — the `StoredConfig` interface members, every
 *   `config.<key>` / `config?.<key>` a reader or setter names, and every
 *   `(config as { <key>?: … })` cast (which is how `autoMemoryDirectory` and
 *   `plansDirectory` are read: no interface member, no ordinary access).
 * - `config/*.ts` — every `export const …_SETTING_KEY = '<key>'`, the
 *   convention a settings module beside `storage.ts` uses to name the top-level
 *   key it owns. This is the source that catches occurrence 3 and the fourth:
 *   both READ the stored config from a module that is not `storage.ts`.
 *
 * Comments and string literals are stripped before the scan, because this
 * package writes `config.json`, `model-config.md` and `server-config.ts` in
 * prose on almost every page — unstripped, those read as four settings keys.
 * `input.config.ok` and its siblings are excluded by requiring `config` to be a
 * standalone identifier, not a property of something else.
 *
 * ## The two ways this guard could go wrong, and which direction they fail in
 *
 * A MISSED key (a reader shaped like none of the above) makes the guard silent,
 * not wrong — the third source can always be added. A SPURIOUS key would make
 * it cry wolf, and a rule that cries wolf stops being run; the positive-control
 * assertions below exist so a regex that silently stops matching cannot pass
 * this file vacuously. If a `…_SETTING_KEY` constant is ever introduced for a
 * NESTED key, this guard is right to complain and the constant is wrong: the
 * suffix means "a top-level key of `config.json`" everywhere it is used today.
 */
import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

import { StoredConfigSchema, StoredConfigTopLevelSchema } from '../validators.ts'

const CONFIG_DIR = join(import.meta.dir, '..')
/**
 * BOTH readers of `config.<key>`, and the second one is why this is a list.
 *
 * DA1.72 moved `loadStoredConfig`, its refusal semantics and
 * `getNetworkProxySettings` out of `storage.ts` into `stored-config-load.ts`,
 * so `config.storageLayoutVersion`, `config.workspaceRefs`,
 * `config.activeWorkspaceId` and `config?.networkProxy` stopped being visible
 * to a scan of `storage.ts` alone. Nothing would have FAILED — every assertion
 * below is of the form "nothing was missing", so the guard would simply have
 * gone quieter, which is the silent-weakening this file's own positive controls
 * exist to catch. A settings module that reads `config.<key>` belongs in this
 * list.
 */
const STORAGE_FILES = [join(CONFIG_DIR, 'storage.ts'), join(CONFIG_DIR, 'stored-config-load.ts')]

/**
 * Remove comments and string/template literals so prose cannot be read as code.
 *
 * Deliberately a scanner and not a parser: it needs to be obvious enough that
 * the next person can see what it does and does not cover, and every construct
 * it would get wrong (a regex literal containing an unbalanced quote) would
 * cost a spurious key, which the positive controls below would catch.
 */
function stripCommentsAndStrings(source: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    const two = source.slice(i, i + 2)
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 2
      out += ' '
      continue
    }
    if (two === '//') {
      const end = source.indexOf('\n', i)
      i = end === -1 ? source.length : end
      out += ' '
      continue
    }
    const ch = source[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      i++
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2
          continue
        }
        if (source[i] === ch) {
          i++
          break
        }
        i++
      }
      out += '""'
      continue
    }
    out += ch
    i++
  }
  return out
}

/** Every top-level member of the `StoredConfig` interface, by name. */
function storedConfigInterfaceMembers(code: string): string[] {
  const start = code.indexOf('interface StoredConfig {')
  if (start === -1) return []
  const open = code.indexOf('{', start)
  let depth = 0
  let close = -1
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}' && --depth === 0) {
      close = i
      break
    }
  }
  if (close === -1) return []
  const members: string[] = []
  let nesting = 0
  let current = ''
  for (const ch of code.slice(open + 1, close)) {
    if (ch === '{' || ch === '(' || ch === '<') nesting++
    else if (ch === '}' || ch === ')' || ch === '>') nesting--
    if (ch === ';' && nesting === 0) {
      const name = current.trim().match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*\??\s*:/)?.[1]
      if (name) members.push(name)
      current = ''
    } else current += ch
  }
  return members
}

/** `config.key`, `config?.key`, and `(config as { key?: … })` in one place. */
function storageModuleKeys(code: string): string[] {
  const keys = new Set<string>(storedConfigInterfaceMembers(code))
  for (const m of code.matchAll(/(^|[^.\-A-Za-z0-9_$])config\??\.([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
    if (m[2]) keys.add(m[2])
  }
  for (const cast of code.matchAll(/\(\s*config\s+as\s*\{([^}]*)\}/g)) {
    for (const field of (cast[1] ?? '').matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*\??\s*:/g)) {
      if (field[1]) keys.add(field[1])
    }
  }
  return [...keys]
}

/** `export const …_SETTING_KEY = '<key>'` across the settings modules. */
function settingKeyConstants(): { key: string; file: string }[] {
  const found: { key: string; file: string }[] = []
  for (const file of readdirSync(CONFIG_DIR)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts') || file === 'validators.ts') continue
    const code = readFileSync(join(CONFIG_DIR, file), 'utf8')
    for (const m of code.matchAll(/export const [A-Z0-9_]*SETTING_KEYS? = '([^']+)'/g)) {
      if (m[1]) found.push({ key: m[1], file })
    }
  }
  return found
}

const declaredTopLevel = new Set(Object.keys(StoredConfigTopLevelSchema.shape))
const declaredFull = new Set(Object.keys(StoredConfigSchema.shape))
const storageKeys = STORAGE_FILES.flatMap(file => storageModuleKeys(stripCommentsAndStrings(readFileSync(file, 'utf8'))))
const settingKeys = settingKeyConstants()

describe('the strict stored-config envelope declares every key its readers name', () => {
  // Positive controls FIRST. Every assertion below is of the form "nothing was
  // missing", and a scanner that silently stopped matching would satisfy all of
  // them while proving nothing — the absence-needs-a-control rule.
  it('the scan actually found the readers it is scanning for', () => {
    expect(storageKeys.length).toBeGreaterThan(40)
    // One key per extraction shape, so a regex that stops matching is red here
    // rather than silently green above.
    expect(storageKeys).toContain('retentionDays') // config.<key>, reader and setter
    expect(storageKeys).toContain('env') // StoredConfig interface member, never accessed as config.env
    expect(storageKeys).toContain('plansDirectory') // (config as { plansDirectory?: unknown })
    // DA1.72 — one key per FILE in `STORAGE_FILES`, so dropping either entry is
    // red here rather than a quieter scan. `workspaceRefs` is read only by
    // `loadStoredConfig`, which now lives in the second file.
    expect(storageKeys).toContain('workspaceRefs')
    expect(settingKeys.length).toBeGreaterThanOrEqual(6)
    expect(settingKeys.map(s => s.key)).toContain('workspaceActions')
  })

  it('strips prose so a documented filename is not read as a settings key', () => {
    // `config.json`, `model-config.md` and `server-config.ts` appear dozens of
    // times in this package's comments and string literals. Unstripped, the
    // scan reports four keys that do not exist and the guard cries wolf.
    expect(storageKeys).not.toContain('json')
    expect(storageKeys).not.toContain('md')
    expect(storageKeys).not.toContain('ts')
    // `input.config.ok` / `.sweepEnabled` / `.error` — a different `config`.
    expect(storageKeys).not.toContain('ok')
    expect(storageKeys).not.toContain('sweepEnabled')
  })

  it('every key config/storage.ts names is declared in both envelopes', () => {
    const undeclared = storageKeys.filter(k => !declaredTopLevel.has(k) || !declaredFull.has(k))
    expect(undeclared).toEqual([])
  })

  it('every …_SETTING_KEY constant beside storage.ts is declared in both envelopes', () => {
    const undeclared = settingKeys
      .filter(s => !declaredTopLevel.has(s.key) || !declaredFull.has(s.key))
      .map(s => `${s.key} (${s.file})`)
    expect(undeclared).toEqual([])
  })

  it('an undeclared top-level key refuses the whole file, which is why the above matter', () => {
    // The consequence, pinned beside the guard so nobody has to take the
    // docblock's word for it: the envelope does not ignore the stray key, it
    // rejects the document that carries it — every other setting included.
    const withStray = StoredConfigTopLevelSchema.safeParse({
      storageLayoutVersion: 4,
      colorTheme: 'dark',
      aKeyNoReaderNames: true,
    })
    expect(withStray.success).toBe(false)
    const withoutStray = StoredConfigTopLevelSchema.safeParse({
      storageLayoutVersion: 4,
      colorTheme: 'dark',
    })
    expect(withoutStray.success).toBe(true)
  })
})
