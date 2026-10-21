import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { isGitBashExecutablePath, isUsableGitBashPath, validateGitBashPath } from '@nessy-agent/server-core/services'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'git-bash-test-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('git-bash helpers', () => {
  it('accepts the four documented filenames with different separators', () => {
    // troubleshoot-install.md: only bash.exe, sh.exe, bash, or sh are accepted.
    expect(isGitBashExecutablePath('C:\\Program Files\\Git\\bin\\bash.exe')).toBe(true)
    expect(isGitBashExecutablePath('/tmp/git/bin/bash.exe')).toBe(true)
    expect(isGitBashExecutablePath('/tmp/git/bin/sh.exe')).toBe(true)
    expect(isGitBashExecutablePath('/tmp/git/bin/bash')).toBe(true)
    expect(isGitBashExecutablePath('/tmp/git/usr/bin/sh')).toBe(true)
    expect(isGitBashExecutablePath('C:\\Git\\bin\\SH.EXE')).toBe(true)
    expect(isGitBashExecutablePath('bash')).toBe(true)
    // Non-enum names stay rejected — including Git for Windows' launcher.
    expect(isGitBashExecutablePath('C:\\Program Files\\Git\\git-bash.exe')).toBe(false)
    expect(isGitBashExecutablePath('/tmp/git/bin/')).toBe(false)
  })

  it('rejects non-enum executable names', async () => {
    const fakePath = join(tempDir, 'cmd.exe')
    writeFileSync(fakePath, 'echo test')

    const result = await validateGitBashPath(fakePath)
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toBe('Path must point to bash.exe, sh.exe, bash, or sh')
    }
  })

  it('rejects missing enum-named paths — the existence half still bites', async () => {
    const result = await validateGitBashPath(join(tempDir, 'bash.exe'))
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toBe('File does not exist at the specified path')
    }
    // The widened names get the same existence check.
    const missingSh = await validateGitBashPath(join(tempDir, 'sh'))
    expect(missingSh.valid).toBe(false)
    if (!missingSh.valid) {
      expect(missingSh.error).toBe('File does not exist at the specified path')
    }
  })

  it('accepts existing bash.exe files', async () => {
    const bashPath = join(tempDir, 'bash.exe')
    writeFileSync(bashPath, 'echo bash')

    const result = await validateGitBashPath(bashPath)
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.path).toBe(bashPath)
    }
    await expect(isUsableGitBashPath(bashPath)).resolves.toBe(true)
  })
})
