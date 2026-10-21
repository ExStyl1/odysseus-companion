import { existsSync, readFileSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * CI1 — Formatter dispatch registry.
 *
 * Detect the project's ALREADY-CONFIGURED formatter from config markers at the
 * workspace root and run it on a changed file, exposed as an agent-facing
 * `format` op. This works WITHOUT an LSP server (the L1 `formatting` op is
 * LSP-only and only projects when a server is `ready`), so it gives formatter
 * coverage independent of LSP provisioning.
 *
 * Hard rules (mirrored from `code-intelligence-ci.md` § CI1 Stop Conditions):
 * - detect-and-use ONLY; NEVER install a host tool. A missing marker or a missing
 *   binary is a typed no-op, never an install (JS/TS runners use `npx
 *   --no-install`; native binaries run directly and fail-soft when absent).
 * - additive only: the LSP `formatting`/`range_formatting` ops and their schema
 *   union are UNTOUCHED. The `format` op is a separate agent-facing tool.
 * - bounded: scope the command to the one changed file, a short timeout well under
 *   the plugin-hook cap, and a capped output.
 * - the caller trust-gates the spawn identically to LSP
 *   (`isPiLspProvisioningAllowed`) and respects the off switch before invoking a
 *   runner built here — this module never spawns on its own.
 *
 * Marker subset adopted (a starter subset of pi-lens's ~26; the rest are
 * DEFERRED to a follow-up — record any addition here):
 * - biome.json / biome.jsonc      → biome         (JS/TS/JSON/…)
 * - .prettierrc* / prettier config → prettier      (JS/TS/CSS/MD/…)
 * - ruff.toml / pyproject[tool.ruff] → ruff         (Python)
 * - rustfmt.toml / .rustfmt.toml  → rustfmt        (Rust)
 * - .clang-format                 → clang-format   (C/C++/…)
 * - .gofmt marker is intentionally NOT adopted (gofmt has no config marker;
 *   deferred with the rest of the pi-lens table).
 */

/** Max characters of formatter output folded back into the model context. */
export const FORMAT_OUTPUT_LIMIT = 4_000

/** Short bound, well under the hook ceiling `MAX_HOOK_TIMEOUT_MS` (600_000). */
export const FORMAT_TIMEOUT_MS = 20_000

export interface FormatToolEvent {
  /** Absolute or workspace-relative path of the file to format. */
  path?: unknown
}

export interface DetectedFormatter {
  /** Stable id for the detected formatter (e.g. `biome`, `prettier`, `ruff`). */
  id: string
  /** Shell command (already scoped to the changed file). Run via ProcessSupervisor `workspace`. */
  command: string
}

/**
 * Resolve the target file's absolute path from a `format` op input. Returns null
 * when no path is present or it escapes the workspace root (defense-in-depth;
 * never format outside the root — identical guard to CI2's `resolveChangedFile`).
 */
export function resolveFormatTarget(event: FormatToolEvent, workspaceRoot: string): string | null {
  const raw = event.path
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(workspaceRoot, raw)
  const rel = relative(workspaceRoot, absolute)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return absolute
}

const JS_TS_LIKE_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
  '.json', '.jsonc', '.css', '.scss', '.less', '.html', '.vue', '.svelte',
  '.md', '.mdx', '.yaml', '.yml', '.graphql', '.gql',
])
const PRETTIER_EXTENSIONS = JS_TS_LIKE_EXTENSIONS
const BIOME_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.json', '.jsonc',
])
const PY_EXTENSIONS = new Set(['.py', '.pyi'])
const RUST_EXTENSIONS = new Set(['.rs'])
const CLANG_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx', '.m', '.mm',
])

function fileExistsAny(root: string, names: readonly string[]): boolean {
  return names.some(name => existsSync(join(root, name)))
}

/**
 * Detect the project's already-configured formatter for the changed file from
 * config markers at the workspace root. Returns null when no marker matches the
 * file's language (a typed no-op — the caller never spawns). Detect-only: a
 * present marker with no installed binary becomes a fail-soft no-op at spawn.
 *
 * At most one formatter is returned (the project's configured one for that
 * language); when both Biome and Prettier configs exist for a JS/TS file, Biome
 * wins (mirrors CI2's linter precedence).
 */
export function detectFormatter(changedFile: string, workspaceRoot: string): DetectedFormatter | null {
  const ext = extname(changedFile).toLowerCase()
  const quoted = shellQuote(changedFile)

  // JS/TS-family: Biome or Prettier, whichever the project configures.
  if (BIOME_EXTENSIONS.has(ext) && fileExistsAny(workspaceRoot, ['biome.json', 'biome.jsonc'])) {
    return { id: 'biome', command: `npx --no-install biome format --write ${quoted}` }
  }
  if (PRETTIER_EXTENSIONS.has(ext) && hasPrettierConfig(workspaceRoot)) {
    return { id: 'prettier', command: `npx --no-install prettier --write ${quoted}` }
  }

  // Python: Ruff formatter.
  if (PY_EXTENSIONS.has(ext)
    && (fileExistsAny(workspaceRoot, ['ruff.toml', '.ruff.toml']) || hasPyprojectTable(workspaceRoot, 'ruff'))) {
    return { id: 'ruff', command: `ruff format ${quoted}` }
  }

  // Rust: rustfmt.
  if (RUST_EXTENSIONS.has(ext) && fileExistsAny(workspaceRoot, ['rustfmt.toml', '.rustfmt.toml'])) {
    return { id: 'rustfmt', command: `rustfmt ${quoted}` }
  }

  // C/C++/Objective-C: clang-format.
  if (CLANG_EXTENSIONS.has(ext) && fileExistsAny(workspaceRoot, ['.clang-format', '_clang-format'])) {
    return { id: 'clang-format', command: `clang-format -i ${quoted}` }
  }

  return null
}

const PRETTIER_CONFIG_FILES = [
  '.prettierrc', '.prettierrc.json', '.prettierrc.yml', '.prettierrc.yaml',
  '.prettierrc.json5', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs',
  '.prettierrc.ts', '.prettierrc.cts', '.prettierrc.mts',
  'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs', 'prettier.config.ts',
] as const

function hasPrettierConfig(workspaceRoot: string): boolean {
  if (fileExistsAny(workspaceRoot, PRETTIER_CONFIG_FILES)) return true
  // package.json may carry a `prettier` key instead of a dedicated file.
  const pkg = join(workspaceRoot, 'package.json')
  if (!existsSync(pkg)) return false
  try {
    const parsed = JSON.parse(readFileSync(pkg, 'utf-8')) as { prettier?: unknown }
    return parsed.prettier !== undefined
  } catch {
    return false
  }
}

function hasPyprojectTable(workspaceRoot: string, tool: string): boolean {
  const path = join(workspaceRoot, 'pyproject.toml')
  if (!existsSync(path)) return false
  try {
    // Cheap, dependency-free marker check: the tool's config table header.
    const contents = readFileSync(path, 'utf-8')
    return contents.includes(`[tool.${tool}]`) || contents.includes(`[tool.${tool}.`)
  } catch {
    return false
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export interface FormatOutcome {
  id: string
  exitCode: number | null
  /**
   * Combined stdout/stderr from the formatter.
   *
   * P3.320 — this said "already capped by the supervisor", which was right
   * that a cap exists and wrong about where it is. The cap is
   * `ProcessStore`'s output RING (`MAX_LOG_BYTES`, the last 64 KiB by
   * default), not `ProcessSupervisor.MAX_FOREGROUND_STREAM_BYTES` — that one
   * bounds the supervisor's `stdout`/`stderr` fields, which nothing here
   * reads. The distinction matters because the ring drops the HEAD, so a
   * long check loses its EARLIEST output and the value then carries
   * `describeDroppedOutput`'s notice saying how much.
   */
  output: string
  timedOut?: boolean
}

/**
 * Fold a formatter outcome into a single bounded result string for the agent.
 * Returns undefined when there was no formatter to run. A clean run reports a
 * short success line; a non-zero exit reports the (bounded) output so the agent
 * can react. Fail-soft (crashed/absent binary → null exit) is reported as a
 * benign "not available" note, never an error that blocks the turn.
 */
export function formatResult(formattedFile: string, outcome: FormatOutcome | null): string {
  if (!outcome) {
    return `No project formatter is configured for ${formattedFile}. Nothing was changed.`
  }
  if (outcome.timedOut) {
    return `[${outcome.id}] timed out formatting ${formattedFile}. Nothing was changed.`
  }
  if (outcome.exitCode === null) {
    // Absent binary / spawn crash — detect-and-use, never install.
    return `[${outcome.id}] is not available on this machine; ${formattedFile} was left unchanged. `
      + `Nessy never installs a formatter — install it in the project to enable formatting.`
  }

  let body = (outcome.output ?? '').trim()
  let truncated = false
  if (body.length > FORMAT_OUTPUT_LIMIT) {
    body = body.slice(0, FORMAT_OUTPUT_LIMIT)
    truncated = true
  }

  if (outcome.exitCode === 0) {
    return body
      ? `[${outcome.id}] formatted ${formattedFile}.\n\n${body}${truncated ? '\n\n[output truncated]' : ''}`
      : `[${outcome.id}] formatted ${formattedFile}.`
  }
  return `[${outcome.id}] reported issues formatting ${formattedFile} (exit ${outcome.exitCode}):`
    + `\n\n${body}${truncated ? '\n\n[output truncated]' : ''}`
}
