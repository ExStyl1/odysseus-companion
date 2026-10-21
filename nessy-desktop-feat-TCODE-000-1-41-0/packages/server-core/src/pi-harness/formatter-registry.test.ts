import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  detectFormatter,
  formatResult,
  resolveFormatTarget,
  FORMAT_OUTPUT_LIMIT,
  type FormatOutcome,
} from './formatter-registry.ts'

function tempProject(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'formatter-registry-'))
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(root, name), contents)
  return root
}

// ---------------------------------------------------------------------------
// resolveFormatTarget — path resolver with workspace-escape guard (parity with
// CI2's resolveChangedFile).
// ---------------------------------------------------------------------------

test('resolveFormatTarget resolves workspace-relative and absolute in-root paths', () => {
  const root = tempProject()
  expect(resolveFormatTarget({ path: 'src/a.ts' }, root)).toBe(join(root, 'src/a.ts'))
  expect(resolveFormatTarget({ path: join(root, 'b.py') }, root)).toBe(join(root, 'b.py'))
})

test('resolveFormatTarget rejects escapes and empty/missing paths', () => {
  const root = tempProject()
  expect(resolveFormatTarget({ path: '../outside.ts' }, root)).toBeNull()
  expect(resolveFormatTarget({ path: '/etc/passwd' }, root)).toBeNull()
  expect(resolveFormatTarget({ path: '' }, root)).toBeNull()
  expect(resolveFormatTarget({ path: '   ' }, root)).toBeNull()
  expect(resolveFormatTarget({}, root)).toBeNull()
  expect(resolveFormatTarget({ path: 42 as unknown as string }, root)).toBeNull()
})

// ---------------------------------------------------------------------------
// detectFormatter — marker → formatter command. Detect-and-use only; NEVER
// installs. A marker without a matching language, or no marker, is a no-op.
// ---------------------------------------------------------------------------

test('detectFormatter → biome from biome.json for a JS/TS file, with --no-install', () => {
  const root = tempProject({ 'biome.json': '{}' })
  const detected = detectFormatter(join(root, 'x.ts'), root)
  expect(detected?.id).toBe('biome')
  expect(detected?.command).toContain('biome format --write')
  // Never install: JS/TS runner uses npx --no-install so a missing binary no-ops.
  expect(detected?.command).toContain('--no-install')
})

test('detectFormatter → prettier from .prettierrc (and package.json prettier key)', () => {
  const fileRoot = tempProject({ '.prettierrc': '{}' })
  expect(detectFormatter(join(fileRoot, 'x.tsx'), fileRoot)?.id).toBe('prettier')
  expect(detectFormatter(join(fileRoot, 'x.tsx'), fileRoot)?.command).toContain('--no-install')

  const pkgRoot = tempProject({ 'package.json': JSON.stringify({ prettier: { semi: false } }) })
  expect(detectFormatter(join(pkgRoot, 'styles.css'), pkgRoot)?.id).toBe('prettier')
})

test('detectFormatter → biome wins over prettier when both configs exist', () => {
  const root = tempProject({ 'biome.json': '{}', '.prettierrc': '{}' })
  expect(detectFormatter(join(root, 'x.ts'), root)?.id).toBe('biome')
})

test('detectFormatter → ruff from pyproject [tool.ruff] / ruff.toml for a .py file', () => {
  const pyproject = tempProject({ 'pyproject.toml': '[tool.ruff]\nline-length = 100\n' })
  expect(detectFormatter(join(pyproject, 'm.py'), pyproject)?.id).toBe('ruff')
  expect(detectFormatter(join(pyproject, 'm.py'), pyproject)?.command).toContain('ruff format')

  const ruffToml = tempProject({ 'ruff.toml': 'line-length = 100\n' })
  expect(detectFormatter(join(ruffToml, 'm.py'), ruffToml)?.id).toBe('ruff')
})

test('detectFormatter → rustfmt and clang-format from their markers', () => {
  const rust = tempProject({ 'rustfmt.toml': 'edition = "2021"\n' })
  expect(detectFormatter(join(rust, 'lib.rs'), rust)?.id).toBe('rustfmt')

  const clang = tempProject({ '.clang-format': 'BasedOnStyle: LLVM\n' })
  expect(detectFormatter(join(clang, 'main.cpp'), clang)?.id).toBe('clang-format')
})

test('detectFormatter is a typed no-op with no marker or a mismatched language (no install)', () => {
  const noMarker = tempProject()
  expect(detectFormatter(join(noMarker, 'x.ts'), noMarker)).toBeNull()
  expect(detectFormatter(join(noMarker, 'm.py'), noMarker)).toBeNull()

  // Marker present, but the file's language does not match it.
  const biomeRoot = tempProject({ 'biome.json': '{}' })
  expect(detectFormatter(join(biomeRoot, 'm.py'), biomeRoot)).toBeNull()
  const ruffRoot = tempProject({ 'ruff.toml': '' })
  expect(detectFormatter(join(ruffRoot, 'x.ts'), ruffRoot)).toBeNull()
})

test('EVERY detected command is a run-only invocation and NEVER installs', () => {
  const roots: Array<[string, string]> = [
    [tempProject({ 'biome.json': '{}' }), 'x.ts'],
    [tempProject({ '.prettierrc': '{}' }), 'x.ts'],
    [tempProject({ 'ruff.toml': '' }), 'm.py'],
    [tempProject({ 'rustfmt.toml': '' }), 'lib.rs'],
    [tempProject({ '.clang-format': '' }), 'main.c'],
  ]
  for (const [root, file] of roots) {
    const detected = detectFormatter(join(root, file), root)
    expect(detected).not.toBeNull()
    // No install verb ever appears in a formatter command.
    expect(detected!.command).not.toMatch(/\b(install|add|i)\b.*(npm|yarn|pnpm|pip|cargo)/i)
    expect(detected!.command).not.toContain('npm install')
    expect(detected!.command).not.toContain('pip install')
    expect(detected!.command).not.toContain('cargo install')
  }
})

// ---------------------------------------------------------------------------
// formatResult — bounded result string; no-formatter / absent-binary → benign.
// ---------------------------------------------------------------------------

test('formatResult reports a no-op when no formatter is configured', () => {
  const text = formatResult('/proj/a.ts', null)
  expect(text).toContain('No project formatter')
  expect(text).toContain('/proj/a.ts')
})

test('formatResult reports an absent binary as never-install, not an error', () => {
  const text = formatResult('/proj/a.ts', { id: 'biome', exitCode: null, output: '' })
  expect(text).toContain('not available')
  expect(text).toContain('never installs')
})

test('formatResult reports a clean success succinctly', () => {
  expect(formatResult('/proj/a.ts', { id: 'prettier', exitCode: 0, output: '' }))
    .toBe('[prettier] formatted /proj/a.ts.')
})

test('formatResult surfaces a non-zero exit with bounded output', () => {
  const text = formatResult('/proj/a.ts', { id: 'ruff', exitCode: 2, output: 'error: bad syntax' })
  expect(text).toContain('reported issues')
  expect(text).toContain('bad syntax')
})

test('formatResult caps output at the bound', () => {
  const huge = 'x'.repeat(FORMAT_OUTPUT_LIMIT * 3)
  const outcome: FormatOutcome = { id: 'biome', exitCode: 1, output: huge }
  const text = formatResult('/proj/a.ts', outcome)
  expect(text).toContain('[output truncated]')
  expect(text.length).toBeLessThan(FORMAT_OUTPUT_LIMIT + 500)
})

test('formatResult reports a timeout as a benign no-change note', () => {
  const text = formatResult('/proj/a.ts', { id: 'biome', exitCode: null, output: '', timedOut: true })
  expect(text).toContain('timed out')
})
