import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  detectChecks,
  formatDiagnostics,
  isEditWriteTool,
  resolveChangedFile,
  EDIT_FEEDBACK_OUTPUT_LIMIT,
  MAX_LSP_DIAGNOSTICS_IN_PAYLOAD,
  type CheckOutcome,
} from './edit-feedback.ts'

function tempProject(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'edit-feedback-'))
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(root, name), contents)
  return root
}

// ---------------------------------------------------------------------------
// isEditWriteTool + resolveChangedFile — changed-file resolver (ANCHOR: the
// model-facing edit/write tool names are Edit/Write/NotebookEdit; Edit/Write
// carry file_path, NotebookEdit carries notebook_path).
// ---------------------------------------------------------------------------

test('isEditWriteTool matches only edit/write tools', () => {
  expect(isEditWriteTool('Edit')).toBe(true)
  expect(isEditWriteTool('Write')).toBe(true)
  expect(isEditWriteTool('NotebookEdit')).toBe(true)
  expect(isEditWriteTool('Read')).toBe(false)
  expect(isEditWriteTool('Bash')).toBe(false)
  expect(isEditWriteTool('Grep')).toBe(false)
})

test('resolveChangedFile reads file_path / notebook_path for edit/write tools', () => {
  const root = tempProject()
  expect(resolveChangedFile({ toolName: 'Edit', toolInput: { file_path: 'src/a.ts' } }, root))
    .toBe(join(root, 'src/a.ts'))
  expect(resolveChangedFile({ toolName: 'Write', toolInput: { file_path: 'b.js' } }, root))
    .toBe(join(root, 'b.js'))
  expect(resolveChangedFile({ toolName: 'NotebookEdit', toolInput: { notebook_path: 'n.ipynb' } }, root))
    .toBe(join(root, 'n.ipynb'))
})

test('resolveChangedFile is a no-op for non-edit tools (negative path)', () => {
  const root = tempProject()
  expect(resolveChangedFile({ toolName: 'Read', toolInput: { file_path: 'a.ts' } }, root)).toBeNull()
  expect(resolveChangedFile({ toolName: 'Bash', toolInput: { command: 'ls' } }, root)).toBeNull()
})

test('resolveChangedFile rejects paths that escape the workspace root', () => {
  const root = tempProject()
  expect(resolveChangedFile({ toolName: 'Edit', toolInput: { file_path: '../outside.ts' } }, root)).toBeNull()
  expect(resolveChangedFile({ toolName: 'Edit', toolInput: { file_path: '/etc/passwd' } }, root)).toBeNull()
  expect(resolveChangedFile({ toolName: 'Edit', toolInput: {} }, root)).toBeNull()
})

// ---------------------------------------------------------------------------
// detectChecks — detect-and-use only (config marker required); NEVER install.
// ---------------------------------------------------------------------------

test('detectChecks finds ESLint from eslint config marker', () => {
  const root = tempProject({ 'eslint.config.js': 'export default []' })
  const checks = detectChecks(join(root, 'x.ts'), root)
  expect(checks.some(c => c.id === 'eslint')).toBe(true)
  expect(checks.find(c => c.id === 'eslint')?.command).toContain('eslint')
  // detect-and-use only: uses --no-install so a missing binary never installs.
  expect(checks.find(c => c.id === 'eslint')?.command).toContain('--no-install')
})

test('detectChecks finds Biome and tsc for a TS file with markers', () => {
  const root = tempProject({ 'biome.json': '{}', 'tsconfig.json': '{}' })
  const checks = detectChecks(join(root, 'x.ts'), root)
  expect(checks.map(c => c.id).sort()).toEqual(['biome', 'tsc'])
})

test('detectChecks finds ruff from pyproject [tool.ruff] for a .py file', () => {
  const root = tempProject({ 'pyproject.toml': '[tool.ruff]\nline-length = 100\n' })
  const checks = detectChecks(join(root, 'm.py'), root)
  expect(checks.some(c => c.id === 'ruff')).toBe(true)
})

test('detectChecks is empty when the project has no config marker (no install)', () => {
  const root = tempProject()
  expect(detectChecks(join(root, 'x.ts'), root)).toEqual([])
  expect(detectChecks(join(root, 'm.py'), root)).toEqual([])
})

test('detectChecks is empty for unsupported file types', () => {
  const root = tempProject({ 'eslint.config.js': 'export default []' })
  expect(detectChecks(join(root, 'README.md'), root)).toEqual([])
})

// ---------------------------------------------------------------------------
// formatDiagnostics — bounded OBSERVATIONAL context; clean/failed = no noise.
// ---------------------------------------------------------------------------

function outcome(over: Partial<CheckOutcome> = {}): CheckOutcome {
  return { id: 'eslint', exitCode: 1, output: 'error: bad', ...over }
}

test('formatDiagnostics folds problem output into a bounded observational block', () => {
  const text = formatDiagnostics('/proj/a.ts', [outcome({ output: 'line 1: no-unused-vars' })])
  expect(text).toContain('observational')
  expect(text).toContain('/proj/a.ts')
  expect(text).toContain('no-unused-vars')
})

test('formatDiagnostics returns undefined for a clean edit (no noise)', () => {
  expect(formatDiagnostics('/proj/a.ts', [outcome({ exitCode: 0, output: '' })])).toBeUndefined()
  expect(formatDiagnostics('/proj/a.ts', [])).toBeUndefined()
})

test('formatDiagnostics skips fail-soft outcomes (timeout / absent binary)', () => {
  // timedOut and null-exit (spawn/crash) never surface — never blocks, never floods.
  expect(formatDiagnostics('/proj/a.ts', [outcome({ timedOut: true, exitCode: null, output: '' })])).toBeUndefined()
  expect(formatDiagnostics('/proj/a.ts', [outcome({ exitCode: null, output: 'partial' })])).toBeUndefined()
})

test('formatDiagnostics caps output at the bound', () => {
  const huge = 'x'.repeat(EDIT_FEEDBACK_OUTPUT_LIMIT * 3)
  const text = formatDiagnostics('/proj/a.ts', [outcome({ output: huge })])!
  expect(text).toContain('[output truncated]')
  // Body is bounded; the whole message stays a few hundred chars over the cap
  // (header + markers), never the multi-thousand-line raw output.
  expect(text.length).toBeLessThan(EDIT_FEEDBACK_OUTPUT_LIMIT + 500)
})

// ---------------------------------------------------------------------------
// formatDiagnostics — LSP contribution. The post-edit channel is single-slot,
// so the language server's pushed diagnostics compose into the SAME payload as
// the project's own checks; two competing injections for one tool call would be
// worse than one.
// ---------------------------------------------------------------------------

function lspDiagnostic(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message: 'Type error',
    severity: 1,
    range: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } },
    ...over,
  }
}

test('formatDiagnostics includes LSP diagnostics for the edited file with no project checks', () => {
  // The load-bearing case: a project with no linter config still gets the
  // language server's verdict, so an early return on "no checks detected"
  // must not swallow it.
  const text = formatDiagnostics('/proj/a.ts', [], [lspDiagnostic()])!
  expect(text).toContain('observational')
  expect(text).toContain('/proj/a.ts')
  expect(text).toContain('Type error')
  expect(text).toContain('language server')
})

test('formatDiagnostics delivers ONE payload when both sources have something to say', () => {
  const text = formatDiagnostics(
    '/proj/a.ts',
    [outcome({ output: 'a.ts:1:1 unused var' })],
    [lspDiagnostic()],
  )!
  // One string, one header, both contributions inside it.
  expect(typeof text).toBe('string')
  expect(text).toContain('Type error')
  expect(text).toContain('unused var')
  expect(text.match(/observational/g)).toHaveLength(1)
})

test('formatDiagnostics says nothing when neither source has anything', () => {
  expect(formatDiagnostics('/proj/clean.ts', [], [])).toBeUndefined()
  expect(formatDiagnostics('/proj/clean.ts', [outcome({ exitCode: 0, output: '' })], [])).toBeUndefined()
})

test('formatDiagnostics reports 1-based positions and drops hint/info noise', () => {
  const text = formatDiagnostics('/proj/a.ts', [], [
    lspDiagnostic({ source: 'ts' }),
    lspDiagnostic({ message: 'Prefer const', severity: 2 }),
    lspDiagnostic({ message: 'Unused import hint', severity: 4 }),
    lspDiagnostic({ message: 'Just information', severity: 3 }),
  ])!
  // LSP positions are 0-based; the model reads 1-based line numbers everywhere else.
  expect(text).toContain('1:5')
  expect(text).toContain('(ts)')
  expect(text).toContain('Prefer const')
  expect(text).not.toContain('Unused import hint')
  expect(text).not.toContain('Just information')
})

test('formatDiagnostics bounds how many LSP diagnostics reach the model', () => {
  // The LspService buffer alone allows 1000 per file; the payload must not.
  const many = Array.from({ length: MAX_LSP_DIAGNOSTICS_IN_PAYLOAD + 12 }, (_, index) =>
    lspDiagnostic({ message: `problem ${index}` }))
  const text = formatDiagnostics('/proj/a.ts', [], many)!
  expect(text).toContain('problem 0')
  expect(text).toContain(`problem ${MAX_LSP_DIAGNOSTICS_IN_PAYLOAD - 1}`)
  expect(text).not.toContain(`problem ${MAX_LSP_DIAGNOSTICS_IN_PAYLOAD}`)
  expect(text).toContain('more')
})

test('formatDiagnostics ignores malformed LSP entries instead of surfacing them raw', () => {
  expect(formatDiagnostics('/proj/a.ts', [], [null, 'nope', {}, { message: '   ' }])).toBeUndefined()
})
