import { existsSync, readFileSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * CI2 — Edit-feedback loop.
 *
 * On a PostToolUse for an edit/write tool, run the project's ALREADY-PRESENT
 * linter/typechecker on the changed file(s) and fold BOUNDED diagnostics back
 * into the agent context as OBSERVATIONAL context so the agent self-corrects.
 *
 * Hard rules (mirrored from `code-intelligence-ci.md` § CI2 Stop Conditions):
 * - detect-and-use ONLY; NEVER install a host tool. A missing binary/config is a
 *   typed no-op, never an install.
 * - observational only: the diagnostics inform the model; they NEVER block/deny a
 *   tool or widen a permission. PostToolUse cannot cancel the completed edit.
 * - bounded: scope the command to the changed file(s), a short timeout well under
 *   the plugin-hook cap, and a capped output.
 * - the caller trust-gates the spawn identically to LSP
 *   (`isPiLspProvisioningAllowed`) and respects the off switch before invoking a
 *   runner built here — this module never spawns on its own.
 */

/** Model-facing tool names that mutate a file on disk (adapter `permissionName`). */
const EDIT_WRITE_TOOL_NAMES = new Set(['Edit', 'Write', 'NotebookEdit'])

/** Max characters of linter output folded back into the model context. */
export const EDIT_FEEDBACK_OUTPUT_LIMIT = 4_000

/** Short bound, well under the hook ceiling `MAX_HOOK_TIMEOUT_MS` (600_000). */
export const EDIT_FEEDBACK_TIMEOUT_MS = 20_000

/**
 * Max pushed LSP diagnostics for one file folded into the payload.
 *
 * `LspService`'s own buffer allows `MAX_DIAGNOSTICS_PER_FILE` (1000) per URI
 * because it also backs `code_action` seeding, where completeness matters. What
 * reaches the model is bounded far tighter and separately: this block rides the
 * next PreToolUse `additionalContext`, and a thousand-line dump there would cost
 * more context than the edit it comments on.
 */
export const MAX_LSP_DIAGNOSTICS_IN_PAYLOAD = 20

/**
 * LSP `DiagnosticSeverity` values worth telling the model about. Information (3)
 * and Hint (4) are editor affordances, not problems with the edit, and folding
 * them in turns a clean edit into noise.
 */
const LSP_SEVERITY_LABELS = new Map<number, string>([[1, 'error'], [2, 'warning']])

export interface EditFeedbackToolEvent {
  toolName: string
  toolInput: Record<string, unknown>
}

export interface DetectedCheck {
  /** Stable id for the detected tool (e.g. `eslint`, `biome`, `tsc`, `ruff`, `mypy`). */
  id: string
  /** Shell command (already scoped to the changed file). Run via ProcessSupervisor `workspace`. */
  command: string
}

/** True for edit/write tools whose result changed a file we can lint. */
export function isEditWriteTool(toolName: string): boolean {
  return EDIT_WRITE_TOOL_NAMES.has(toolName)
}

/**
 * Resolve the changed file's absolute path from a PostToolUse `tool_input`.
 * Edit/Write carry `file_path` (the adapter normalizes `path` → `file_path`);
 * NotebookEdit carries `notebook_path`. Returns null when no path is present or
 * it escapes the workspace root (defense-in-depth; never lint outside the root).
 */
export function resolveChangedFile(
  event: EditFeedbackToolEvent,
  workspaceRoot: string,
): string | null {
  if (!isEditWriteTool(event.toolName)) return null
  const raw = event.toolInput.file_path ?? event.toolInput.path ?? event.toolInput.notebook_path
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(workspaceRoot, raw)
  const rel = relative(workspaceRoot, absolute)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return absolute
}

/**
 * F1.1012 — the ONE root the host's Pi edit tooling works under: post-edit checks
 * (this module), the `format` op (`formatter-registry.ts`) and plugin language
 * servers (`LspService`'s `workspaceRoot` and `resolvePiLspDocumentUri`'s
 * containment boundary). It is the session's project — its working directory —
 * and the managed workspace directory only when the session has none.
 *
 * All three used to get the managed workspace directory (the app's own folder
 * for the workspace, never the user's code), so `resolveChangedFile` answered
 * null and `resolvePiLspDocumentUri` threw `lsp-path-outside-workspace` for
 * every project file: the checks never ran, and a language server started with
 * `rootUri` pointing at a folder that holds no code.
 *
 * The trust gate is unchanged and still the caller's (`isPiLspProvisioningAllowed`
 * on the project's own trust verdict), so the fallback can only be reached where
 * that gate is already closed: a session with no project has trust `none`. The
 * root is read ONCE, when the agent is built, beside that same verdict. A Pi
 * project switch keeps the agent, so its runners and language server stay on the
 * project they were built for until the agent is rebuilt — a file in the new
 * project is refused, never checked under the old project's verdict. A rebuilt
 * agent sees a new project key, so a new capability generation, and
 * `shouldRetainPiLspService` retires the old language server.
 */
export function resolvePiHostToolingRoot(session: {
  readonly workingDirectory?: string
  readonly workspace: { readonly rootPath: string }
}): string {
  return session.workingDirectory ?? session.workspace.rootPath
}

const JS_TS_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'])
const PY_EXTENSIONS = new Set(['.py', '.pyi'])

function fileExistsAny(root: string, names: readonly string[]): boolean {
  return names.some(name => existsSync(join(root, name)))
}

/**
 * Detect the project's already-configured linter/typechecker for the changed
 * file from config markers at the workspace root. Returns at most a small,
 * ordered set of checks (linter first, then typechecker) scoped to the one
 * changed file. Detect-only — presence of a config marker is required; a marker
 * without the actual binary installed becomes a fail-soft no-op at spawn time.
 *
 * The command uses `--` and a shell-quoted path so a path with spaces is safe,
 * and each detected tool runs through a package runner already implied by the
 * marker (`npx --no-install` / `python -m`) so nothing is ever installed.
 */
export function detectChecks(changedFile: string, workspaceRoot: string): DetectedCheck[] {
  const ext = extname(changedFile).toLowerCase()
  const quoted = shellQuote(changedFile)
  const checks: DetectedCheck[] = []

  if (JS_TS_EXTENSIONS.has(ext)) {
    // Biome and ESLint are mutually common; prefer whichever the project configures.
    if (fileExistsAny(workspaceRoot, ['biome.json', 'biome.jsonc'])) {
      checks.push({ id: 'biome', command: `npx --no-install biome lint ${quoted}` })
    } else if (fileExistsAny(workspaceRoot, [
      'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts',
      '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
    ])) {
      checks.push({ id: 'eslint', command: `npx --no-install eslint ${quoted}` })
    }
    // A TS typechecker only makes sense for .ts/.tsx when a tsconfig is present.
    if ((ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts')
      && fileExistsAny(workspaceRoot, ['tsconfig.json'])) {
      // No per-file tsc without breaking project references; keep it bounded by
      // running the file in isolation with no emit. Best-effort typecheck.
      checks.push({ id: 'tsc', command: `npx --no-install tsc --noEmit --pretty false ${quoted}` })
    }
    return checks
  }

  if (PY_EXTENSIONS.has(ext)) {
    if (fileExistsAny(workspaceRoot, ['ruff.toml', '.ruff.toml']) || hasPyprojectTable(workspaceRoot, 'ruff')) {
      checks.push({ id: 'ruff', command: `ruff check ${quoted}` })
    }
    if (fileExistsAny(workspaceRoot, ['mypy.ini', '.mypy.ini']) || hasPyprojectTable(workspaceRoot, 'mypy')) {
      checks.push({ id: 'mypy', command: `python -m mypy ${quoted}` })
    }
    return checks
  }

  return checks
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

export interface CheckOutcome {
  id: string
  exitCode: number | null
  /**
   * Combined stdout/stderr from the check.
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
 * Render pushed LSP diagnostics as bounded lines. Malformed entries are dropped
 * rather than surfaced raw, and positions are converted to the 1-based numbering
 * the model sees everywhere else (LSP is 0-based).
 */
function formatLspDiagnosticLines(diagnostics: readonly unknown[]): string[] {
  const lines: string[] = []
  let skipped = 0
  for (const entry of diagnostics) {
    if (typeof entry !== 'object' || entry === null) continue
    const { message, severity, source, range } = entry as {
      message?: unknown; severity?: unknown; source?: unknown; range?: unknown
    }
    if (typeof message !== 'string' || message.trim() === '') continue
    // An absent severity is Error by LSP convention (the client decides); an
    // explicit Information/Hint is dropped.
    const label = severity === undefined ? 'error' : LSP_SEVERITY_LABELS.get(Number(severity))
    if (!label) continue
    if (lines.length >= MAX_LSP_DIAGNOSTICS_IN_PAYLOAD) {
      skipped += 1
      continue
    }
    const start = (range as { start?: { line?: unknown; character?: unknown } } | undefined)?.start
    const position = typeof start?.line === 'number' && typeof start.character === 'number'
      ? `${start.line + 1}:${start.character + 1} `
      : ''
    lines.push(`${position}${label}: ${message.trim()}${typeof source === 'string' && source ? ` (${source})` : ''}`)
  }
  if (skipped > 0) lines.push(`... and ${skipped} more`)
  return lines
}

/**
 * Fold check outcomes and pushed LSP diagnostics into a SINGLE bounded
 * OBSERVATIONAL context block. Only checks that reported a problem (non-zero
 * exit with output) are surfaced — a clean check produces nothing so a passing
 * edit adds no noise. A crashed/absent binary (fail-soft) is skipped: it never
 * blocks and never floods context. Returns undefined when there is nothing worth
 * telling the model.
 *
 * Both sources compose here, into one payload, deliberately. The delivery
 * channel is the next PreToolUse `additionalContext`, which is single-slot; two
 * competing post-edit injections for one tool call would be worse than one.
 */
export function formatDiagnostics(
  changedFile: string,
  outcomes: readonly CheckOutcome[],
  lspDiagnostics: readonly unknown[] = [],
): string | undefined {
  const problems = outcomes.filter(o => !o.timedOut && o.exitCode !== null && o.exitCode !== 0 && o.output.trim() !== '')
  const lspLines = formatLspDiagnosticLines(lspDiagnostics)
  if (problems.length === 0 && lspLines.length === 0) return undefined

  const parts = [
    ...(lspLines.length > 0 ? [`[lsp]\n${lspLines.join('\n')}`] : []),
    ...problems.map(o => `[${o.id}]\n${o.output.trim()}`),
  ]
  let body = parts.join('\n\n')
  let truncated = false
  if (body.length > EDIT_FEEDBACK_OUTPUT_LIMIT) {
    body = body.slice(0, EDIT_FEEDBACK_OUTPUT_LIMIT)
    truncated = true
  }
  const reporters = [
    ...(lspLines.length > 0 ? ['language server'] : []),
    ...(problems.length > 0 ? ['project linter/typechecker'] : []),
  ].join(' and ')
  const header = `The ${reporters} reported issues on ${changedFile} after your edit. `
    + `This is observational — fix them if they are real, or continue if not:`
  return `${header}\n\n${body}${truncated ? '\n\n[output truncated]' : ''}`
}
