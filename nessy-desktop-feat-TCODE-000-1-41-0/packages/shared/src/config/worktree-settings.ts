/**
 * Worktree settings — `settings.md` § Worktree settings, plus one key of ours.
 *
 * Four documented keys and a fifth this fork adds (`setupScript`). Parsed with
 * the same strictness `sandbox` uses: an unknown key or a bad value THROWS
 * rather than being dropped to a default, because three of these five change
 * where the agent may write or what it runs.
 *
 * ## `setupScript` is OURS, and it lives in THIS tier on purpose
 *
 * The fifth key declares a shell command run once inside a NEW worktree, after
 * git created it. It is not a documented Claude key — it is this fork's answer
 * to the codex gap "local-environment setup scripts" — so it carries no doc
 * citation and no documented default.
 *
 * The tier is the security boundary. This file parses the app's own settings
 * (`<CONFIG_DIR>/config.json`, the layer `getUserWorktreeSettings` reads), NOT
 * a project's `.nessy-agent/config.toml`. That project parser is an allowlist
 * of `[defaults]`/`[plugins]` whose recorded invariant is "A project file can
 * never grant trust, credentials, provider auth, environment, filesystem roots
 * or shell commands" (`plugins/project-config.ts`), and this key must never
 * become the hole in it: a repository you clone must not be able to run a
 * command by being opened. Declaring it here keeps the declaration with the
 * user, and the consent card keeps the execution with the user.
 *
 * ## `setupScript` is PER-PLATFORM, and no corpus documents a shape for that
 *
 * P6.60. One string was handed to `cmd.exe /d /s /c` on Windows and to
 * `/bin/sh -c` everywhere else (`worktreeSetupCommand`), so a user with a Mac
 * and a Windows machine could declare a script for exactly one of them and got
 * silence or a shell error on the other.
 *
 * READ BEFORE INVENTING, and the read came back EMPTY — recorded rather than
 * paraphrased, because the row that sent this lane here said the shape was
 * documented:
 *
 * - `worktrees.md` has no setup-script setting at all. Its § Set up the worktree
 *   environment says only "A worktree is a fresh checkout, so initialize your
 *   development environment there: ask Claude to install dependencies, or run
 *   your project's setup yourself in the worktree directory under
 *   `.claude/worktrees/`." Positive control on the same page: `.worktreeinclude`
 *   IS documented, § Copy gitignored files into worktrees.
 * - `settings-reference.md` documents FOUR `worktree.*` keys and no fifth —
 *   `worktree.baseRef`, `worktree.bgIsolation`, `worktree.sparsePaths`,
 *   `worktree.symlinkDirectories` — and no settings key anywhere on that page
 *   takes a platform-keyed object (probed for `"windows"` / `"darwin"` /
 *   `"linux"` as JSON keys: zero hits, against those four rows as the control).
 * - Codex's own setup scripts (`codex/cloud/environments`) are a single Bash
 *   script in a Linux container — "Codex runs your setup script, plus an
 *   optional maintenance script when a cached container is resumed" — so there
 *   is no per-platform shape to copy there either.
 *
 * So the documentation is SILENT and this is decided rather than queued, under
 * the two conditions: TRANSPARENT (the shape is refused loudly by the parser
 * below, and stated here) and SIMPLE.
 *
 * The buckets are `windows` and `posix` and there are exactly two, because
 * there are exactly two interpreters: `worktreeSetupCommand` branches once, on
 * `platform === 'win32'`. A user who needs to tell darwin from linux writes one
 * `posix` script that branches on `uname` — the residue is stated rather than
 * met with a third bucket nobody asked for.
 *
 * A layer that declares only the OTHER platform's script resolves to NO script,
 * and that silence is deliberate: the user scoped it themselves, so there is no
 * "did it run?" ambiguity to report, and a transcript line on every worktree
 * creation saying a Windows script did not run on macOS is noise. This is the
 * one place the `describeWorktreeSetupOutcome` rule ("every branch says
 * something") does not apply, because the branch was chosen by the person who
 * would be told.
 *
 * ## `bgIsolation` and the default we did NOT copy
 *
 * Claude documents `"worktree"` as the default. As of Week 32 (Aug 3–7, 2026)
 * that isolation "now blocks not only file edits but also Bash commands and git
 * redirects that reach the main checkout, in every session type and in the
 * session's subagents" (`whats-new/2026-w32.md`), enforced as the checks in
 * `worktrees.md` § How Claude Code enforces isolation: an `Edit`/`Write`/
 * `NotebookEdit` into the main checkout, a Bash command whose working directory
 * resolves to it, a git redirect into it (`git -C`, `--work-tree`, output
 * redirects), and a command it cannot verify stays inside the worktree.
 *
 * We ship the key with the documented value available and `"none"` as OUR
 * default, and the WIDENED contract makes that divergence MORE necessary, not
 * less — so the reason survives the widening rather than being retired by it.
 * The release valve is still a Pi-only tool: `EnterWorktree` stays pi-only in
 * this fork (unchanged by this widening), so a Claude- or Codex-backed session
 * has no way to lift the block. Adopting `"worktree"` here would refuse the
 * first edit of every existing session; under the wider contract it would ALSO
 * refuse that session's every non-read-only Bash command — a broader, still
 * unliftable wall. A silent, unliftable write block reads as a bug, so the
 * default stays `"none"` and the whole block (edits, Bash, and git redirects
 * alike) is opt-in.
 */

export type WorktreeBaseRef = 'fresh' | 'head'
export type WorktreeBackgroundIsolation = 'worktree' | 'none'

/**
 * The two interpreters, and therefore the two buckets (P6.60, module note).
 *
 * The names are the INTERPRETER's, not the platform's, so the mapping to
 * `worktreeSetupCommand` is one-to-one and there is nothing to get backwards:
 * `windows` is the `cmd.exe /d /s /c` arm (`platform === 'win32'`), `posix` is
 * the `/bin/sh -c` arm (everything else).
 */
export interface WorktreeSetupScriptByPlatform {
  /** Run through `cmd.exe /d /s /c` on `win32`. */
  windows?: string
  /** Run through `/bin/sh -c` on every other platform. */
  posix?: string
}

/**
 * What one settings LAYER may declare for `setupScript`.
 *
 * A bare string is both platforms, which is what every existing config means
 * and keeps meaning — this shape only ADDS the ability to say two things.
 * Resolution narrows it to the one string this host runs.
 */
export type WorktreeSetupScriptSetting = string | WorktreeSetupScriptByPlatform

export interface WorktreeSettingsV1 {
  /**
   * Where a new worktree branches from.
   *
   * `"fresh"` (default) is the default branch as the remote has it;
   * `"head"` is local HEAD, which inside a worktree means THAT worktree's HEAD.
   * A branch name is rejected on purpose — the documented key takes these two
   * values only, and accepting a ref here would silently create worktrees off
   * something no other tier can reason about.
   */
  baseRef?: WorktreeBaseRef
  /**
   * Directories symlinked into a new worktree instead of being recreated —
   * `["node_modules", ".cache"]` and the like. Repository-relative.
   */
  symlinkDirectories?: readonly string[]
  /**
   * Sparse-checkout paths. While a sparse worktree exists git enables
   * `extensions.worktreeConfig` in the repository's shared `.git/config`, which
   * is a side effect on the MAIN checkout and the reason this is a settings key
   * rather than a per-call argument. large-codebases.md:245: the entry is
   * removed after the last worktree is removed, but only when WE enabled it —
   * a value the user set themselves is never touched (the ownership marker and
   * cleanup live in server-core's worktree lease closures).
   */
  sparsePaths?: readonly string[]
  /**
   * Whether a background session is confined to a worktree. `"worktree"` blocks
   * writes to the main checkout until `EnterWorktree` is called: `Edit`/`Write`/
   * `NotebookEdit` into it, a non-read-only Bash command whose working directory
   * or git redirect (`git -C`, `--work-tree`, an output redirect) reaches it,
   * and any Bash command the gate cannot verify stays outside it (`worktrees.md`
   * § How Claude Code enforces isolation). `"none"` does not. See the module
   * note for why `"none"` is our default.
   */
  bgIsolation?: WorktreeBackgroundIsolation
  /**
   * A shell command run once in a NEW worktree, after git created it and after
   * the user consents. Ours, not a documented key (module note).
   *
   * The value is DATA: it is handed to a host-selected interpreter as a single
   * argv element and is never concatenated into a command line by us. What
   * makes it safe is not the parse — a shell command is arbitrary by
   * definition — but where it may be declared (this tier only) and the consent
   * card that gates every run whose script this session has not already been
   * approved for.
   *
   * Refused rather than defaulted: a non-string, an empty or blank string, a
   * value past {@link MAX_SETUP_SCRIPT_LENGTH}, or a NUL byte. Blank is a
   * mistake and not "no script" — this parser never drops a bad value to a
   * default — and a NUL cannot cross an argv boundary intact, so it would
   * silently truncate the command that eventually runs.
   *
   * A `{ windows, posix }` object declares one script per interpreter (P6.60).
   * Every rule above applies to each half unchanged, plus two of its own: an
   * unknown key is refused like any other unknown worktree key, and an object
   * that declares NEITHER half is refused for blank's reason — `{}` would be the
   * one value that silently disabled the key.
   */
  setupScript?: WorktreeSetupScriptSetting
  /**
   * P6.336 (a) — the directory every worktree of every project is created
   * under, instead of the derived `<parent-of-repo>/.nessy-worktrees/<repo>`.
   *
   * OURS, like `setupScript`, and READ-BEFORE-INVENTED came back EMPTY:
   * `worktrees.md` documents a FIXED location (`.claude/worktrees/`) and
   * `settings-reference.md` lists exactly four `worktree.*` keys — `baseRef`,
   * `bgIsolation`, `sparsePaths`, `symlinkDirectories` — with no root, no count
   * and no lifetime key; codex exposes no worktree object at all through the
   * app-server (`ClientRequest.ts`). So the documentation is SILENT and this is
   * decided rather than queued (Criterion 4: a sweep with no operator-visible
   * policy is a control the operator can neither see nor stop).
   *
   * Absolute only, and refused for a filesystem root — the same
   * `worktree-project-root-too-broad` refusal the derived path already makes,
   * because when this is set it BECOMES the containment boundary the worktree
   * git commands run inside.
   *
   * The tier is the security boundary, exactly as it is for `setupScript`: this
   * file parses the app's own settings, never a project's
   * `.nessy-agent/config.toml`, so a repository you clone cannot move where its
   * own worktrees are written.
   */
  root?: string
  /**
   * P6.336 (a) — how many idle worktrees the automatic sweep KEEPS, newest
   * first, beyond the age cutoff it already applies.
   *
   * The age cutoff answers "how old is too old" and nothing answers "how many
   * is too many": a project that makes a worktree per scheduled run
   * accumulates them inside the cutoff window with no bound at all. `0` is a
   * legal value and means "keep none beyond the other rules"; absent means no
   * count limit, which is exactly today's behaviour.
   */
  retainCount?: number
  /**
   * P6.336 (a) — the OFF SWITCH for automatic deletion.
   *
   * `false` stops the sweep removing anything at all; every candidate is
   * reported as skipped with its own reason rather than silently kept, so an
   * operator who turned it off can still see what WOULD have gone. Absent means
   * `true`, today's behaviour.
   *
   * It is a separate key from `retainCount: 0` on purpose: "keep nothing extra"
   * and "never delete" are opposite intents, and a count that had to be set to
   * infinity to mean "off" is a control nobody would find.
   */
  autoRemove?: boolean
}

export interface ResolvedWorktreeSettings {
  baseRef: WorktreeBaseRef
  symlinkDirectories: readonly string[]
  sparsePaths: readonly string[]
  bgIsolation: WorktreeBackgroundIsolation
  /**
   * The script for THIS host's interpreter, already selected (P6.60).
   *
   * Still one string, deliberately: the port that runs it (`WorktreeSetupPort`)
   * and the consent record keyed on the script both work on one command, and
   * pushing the platform choice past this point would give two more places to
   * make it. Absent means no setup script for this platform — the default, the
   * common case, and also what a Windows-only declaration means on macOS.
   */
  setupScript?: string
  /** P6.336 (a) — the operator's worktree root, absent when derived. */
  root?: string
  /** P6.336 (a) — idle worktrees the sweep keeps, newest first. Absent = no count limit. */
  retainCount?: number
  /** P6.336 (a) — false stops automatic deletion entirely. */
  autoRemove: boolean
}

const WORKTREE_SETTING_KEYS = ['baseRef', 'symlinkDirectories', 'sparsePaths', 'bgIsolation', 'setupScript', 'root', 'retainCount', 'autoRemove'] as const
const BASE_REFS: readonly WorktreeBaseRef[] = ['fresh', 'head']
const BACKGROUND_ISOLATIONS: readonly WorktreeBackgroundIsolation[] = ['worktree', 'none']

const MAX_LIST_ENTRIES = 128
const MAX_ENTRY_LENGTH = 512
/** A setup script is a command, not a program file; anything longer is a mistake. */
export const MAX_SETUP_SCRIPT_LENGTH = 4096

/**
 * The default this fork ships. Documented default for `baseRef` is `"fresh"`
 * and we match it, including the v2.1.208 freshness rule (worktrees.md:128:
 * when the repository hasn't been fetched in the last 24 hours the default
 * branch is fetched, capped at five seconds, with the cached ref as the
 * fallback — see `worktreeBaseShaCandidates` in server-core);
 * `bgIsolation` deliberately diverges (module note).
 */
export const WORKTREE_SETTINGS_DEFAULTS: ResolvedWorktreeSettings = Object.freeze({
  baseRef: 'fresh',
  symlinkDirectories: Object.freeze([]),
  sparsePaths: Object.freeze([]),
  bgIsolation: 'none',
  // P6.336 — automatic deletion stays ON by default, which is what shipped.
  // Turning it off is a decision an operator makes, and a default that changed
  // it silently would leak worktrees on every machine that never opened this
  // setting.
  autoRemove: true,
})

function assertKnownKeys(layer: object): void {
  const allowed = new Set<string>(WORKTREE_SETTING_KEYS)
  for (const key of Object.keys(layer)) {
    if (!allowed.has(key)) throw new Error(`invalid worktree setting: ${key}`)
  }
}

/**
 * A repository-relative path list. Absolute paths and `..` escapes are refused:
 * both `symlinkDirectories` and `sparsePaths` name locations INSIDE the
 * repository, and a settings file must not be able to point either of them out
 * of it.
 */
function repoRelativePaths(value: unknown, key: string): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES) {
    throw new Error(`invalid worktree ${key}`)
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0 || entry.length > MAX_ENTRY_LENGTH) {
      throw new Error(`invalid worktree ${key}`)
    }
    const normalized = entry.replaceAll('\\', '/')
    if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
      throw new Error(`worktree-${key}-not-relative`)
    }
    if (normalized.split('/').includes('..')) throw new Error(`worktree-${key}-escapes-repository`)
  }
  return value as readonly string[]
}

/**
 * P6.336 — the operator's worktree root: absolute, not a filesystem root.
 *
 * Refused rather than dropped to the derived path, the posture every key in
 * this file takes: a root the operator meant and we silently ignored would put
 * worktrees somewhere they did not choose, which is the opposite of the control
 * this key exists to give them.
 */
function worktreeRoot(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_ENTRY_LENGTH || value.includes('\0')) {
    throw new Error('invalid worktree root')
  }
  const trimmed = value.trim()
  const normalized = trimmed.replaceAll('\\', '/')
  if (!normalized.startsWith('/') && !/^[a-zA-Z]:/.test(normalized)) {
    throw new Error('worktree-root-not-absolute')
  }
  // The same refusal the derived path already makes. When this key is set it
  // BECOMES the containment boundary the worktree git commands run inside, and
  // a filesystem root is no boundary at all.
  if (normalized === '/' || /^[a-zA-Z]:\/?$/.test(normalized)) {
    throw new Error('worktree-project-root-too-broad')
  }
  if (normalized.split('/').includes('..')) throw new Error('worktree-root-escapes')
  return trimmed
}

/** P6.336 — a retention COUNT: a non-negative integer, `0` included. */
function retainCount(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error('invalid worktree retainCount')
  }
  return value
}

/** P6.336 — the off switch. Strictly boolean; a truthy string is a mistake. */
function autoRemove(value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error('invalid worktree autoRemove')
  return value
}

/** The buckets an object-form `setupScript` may declare, and nothing else. */
const SETUP_SCRIPT_PLATFORM_KEYS: readonly string[] = ['windows', 'posix']

/**
 * One script string.
 *
 * Trimmed on the way out so the string the consent record is keyed on and the
 * string the interpreter receives are the same one: a script that differs from
 * a remembered one only by trailing whitespace must not slip past the card, and
 * a script that differs only by trailing whitespace must not re-prompt either.
 */
function setupScriptString(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_SETUP_SCRIPT_LENGTH || value.includes('\0')) {
    throw new Error('invalid worktree setupScript')
  }
  const trimmed = value.trim()
  // Blank is a mistake, not "no script": this parser never drops a bad value to
  // a default, and "" would be the one value that silently disabled the key.
  if (trimmed.length === 0) throw new Error('invalid worktree setupScript')
  return trimmed
}

/**
 * The declared `setupScript`, in either accepted shape (P6.60, module note).
 *
 * The object form is refused with the same strictness the rest of this file
 * uses, on three counts a looser parse would have swallowed:
 *
 *  - an unknown bucket (`darwin`, `linux`, `win32`, a typo) — dropping it would
 *    silently run nothing on the platform the user thought they had covered,
 *    which is the very defect this shape exists to fix;
 *  - an array, which `typeof` calls an object and which has no buckets at all;
 *  - `{}` or `{ windows: undefined }`, for blank's reason — an object that
 *    declares neither half is the one value that would silently disable the key.
 */
function setupScriptSetting(value: unknown): WorktreeSetupScriptSetting | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return setupScriptString(value)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid worktree setupScript')
  }
  const layer = value as Record<string, unknown>
  for (const key of Object.keys(layer)) {
    if (!SETUP_SCRIPT_PLATFORM_KEYS.includes(key)) {
      throw new Error(`invalid worktree setupScript platform: ${key}`)
    }
  }
  const windows = layer.windows === undefined ? undefined : setupScriptString(layer.windows)
  const posix = layer.posix === undefined ? undefined : setupScriptString(layer.posix)
  if (windows === undefined && posix === undefined) throw new Error('invalid worktree setupScript')
  return Object.freeze({
    ...(windows === undefined ? {} : { windows }),
    ...(posix === undefined ? {} : { posix }),
  })
}

/**
 * Pick the script this host's interpreter runs (P6.60).
 *
 * `platform` is an input rather than a read of `process.platform` for
 * `worktreeSetupCommand`'s reason, and it is the SAME branch: the Windows
 * mapping has to be assertable from a mac test run, or the half of this feature
 * nobody here can execute is the half nobody here can check.
 *
 * A string declares both platforms, so it is returned unchanged — every config
 * written before this shape existed keeps meaning exactly what it meant.
 */
export function selectWorktreeSetupScript(
  value: WorktreeSetupScriptSetting | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  return platform === 'win32' ? value.windows : value.posix
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  key: string,
): T | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`invalid worktree ${key}`)
  }
  return value as T
}

/** Strict parser for one layer arriving from an untrusted-shape source. */
export function parseWorktreeSettingsV1(value: unknown): WorktreeSettingsV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid worktree settings')
  }
  const layer = value as Record<string, unknown>
  assertKnownKeys(layer)
  const baseRef = enumValue(layer.baseRef, BASE_REFS, 'baseRef')
  const symlinkDirectories = repoRelativePaths(layer.symlinkDirectories, 'symlinkDirectories')
  const sparsePaths = repoRelativePaths(layer.sparsePaths, 'sparsePaths')
  const bgIsolation = enumValue(layer.bgIsolation, BACKGROUND_ISOLATIONS, 'bgIsolation')
  const script = setupScriptSetting(layer.setupScript)
  const root = worktreeRoot(layer.root)
  const retain = retainCount(layer.retainCount)
  const remove = autoRemove(layer.autoRemove)
  return Object.freeze({
    ...(baseRef === undefined ? {} : { baseRef }),
    ...(layer.symlinkDirectories === undefined ? {} : { symlinkDirectories: Object.freeze([...symlinkDirectories]) }),
    ...(layer.sparsePaths === undefined ? {} : { sparsePaths: Object.freeze([...sparsePaths]) }),
    ...(bgIsolation === undefined ? {} : { bgIsolation }),
    ...(script === undefined ? {} : { setupScript: script }),
    ...(root === undefined ? {} : { root }),
    ...(retain === undefined ? {} : { retainCount: retain }),
    ...(remove === undefined ? {} : { autoRemove: remove }),
  })
}

function concatDedupe(lists: readonly (readonly string[])[]): readonly string[] {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const list of lists) {
    for (const entry of list) {
      if (seen.has(entry)) continue
      seen.add(entry)
      merged.push(entry)
    }
  }
  return Object.freeze(merged)
}

/**
 * Resolve worktree settings from ordered layers, least- to most-specific.
 *
 * Composition mirrors `resolveSandboxSettings` so the two security-adjacent
 * settings surfaces do not behave differently for no reason:
 * - the two list keys CONCAT across layers, first-seen order preserved;
 * - `baseRef` is last-wins, an ordinary preference with no tighter direction;
 * - `bgIsolation` is the RESTRICTING one, so it is "tighter wins": any layer
 *   asking for `"worktree"` gets it, and a more specific layer cannot relax an
 *   isolation an outer one imposed. Same rule as `allowManagedDomainsOnly`,
 *   applied to a boolean-shaped enum.
 * - `setupScript` is last-wins like `baseRef`, and deliberately NOT
 *   tighter-wins: a command has no more-restrictive form, so there is nothing
 *   for a "tighter" rule to compare. Composition is not what gates this key —
 *   the consent card is, and the record is keyed on the script itself, so a
 *   layer that replaces one script with another gets a fresh prompt rather
 *   than inheriting the approval the replaced one earned.
 *
 *   Last-wins takes the WHOLE declaration, never one bucket of it (P6.60): a
 *   layer declaring only `windows` replaces an outer layer's `posix` rather
 *   than merging with it. Per-bucket merging would be a composition rule
 *   nobody asked for, and it would make "which script did I approve, on this
 *   machine?" a question you answer by reading two files instead of one.
 *
 * `platform` is an input for `selectWorktreeSetupScript`'s reason — the Windows
 * arm must be assertable from a mac test run.
 */
export function resolveWorktreeSettings(
  layers: readonly WorktreeSettingsV1[],
  options: { platform?: NodeJS.Platform } = {},
): ResolvedWorktreeSettings {
  for (const layer of layers) assertKnownKeys(layer)
  let baseRef: WorktreeBaseRef = WORKTREE_SETTINGS_DEFAULTS.baseRef
  for (const layer of layers) {
    const value = enumValue(layer.baseRef, BASE_REFS, 'baseRef')
    if (value !== undefined) baseRef = value
  }
  for (const layer of layers) enumValue(layer.bgIsolation, BACKGROUND_ISOLATIONS, 'bgIsolation')
  let declared: WorktreeSetupScriptSetting | undefined
  for (const layer of layers) {
    const value = setupScriptSetting(layer.setupScript)
    if (value !== undefined) declared = value
  }
  const script = selectWorktreeSetupScript(declared, options.platform)
    ?? WORKTREE_SETTINGS_DEFAULTS.setupScript
  // P6.336. `root` is last-wins like `baseRef` — an ordinary preference with no
  // tighter direction. `retainCount` is TIGHTER-WINS (the smallest declared
  // count), and `autoRemove` is tighter-wins in the safe direction (any layer
  // saying `false` turns automatic deletion off): both follow `bgIsolation`'s
  // rule rather than `baseRef`'s, because a more specific layer must not be
  // able to make the sweep delete MORE than an outer one allowed.
  let root: string | undefined
  let retain: number | undefined
  let remove = WORKTREE_SETTINGS_DEFAULTS.autoRemove
  for (const layer of layers) {
    const layerRoot = worktreeRoot(layer.root)
    if (layerRoot !== undefined) root = layerRoot
    const layerRetain = retainCount(layer.retainCount)
    if (layerRetain !== undefined) retain = retain === undefined ? layerRetain : Math.min(retain, layerRetain)
    if (autoRemove(layer.autoRemove) === false) remove = false
  }
  return Object.freeze({
    baseRef,
    symlinkDirectories: concatDedupe(layers.map(layer => repoRelativePaths(layer.symlinkDirectories, 'symlinkDirectories'))),
    sparsePaths: concatDedupe(layers.map(layer => repoRelativePaths(layer.sparsePaths, 'sparsePaths'))),
    bgIsolation: layers.some(layer => layer.bgIsolation === 'worktree') ? 'worktree' : 'none',
    ...(script === undefined ? {} : { setupScript: script }),
    ...(root === undefined ? {} : { root }),
    ...(retain === undefined ? {} : { retainCount: retain }),
    autoRemove: remove,
  })
}
