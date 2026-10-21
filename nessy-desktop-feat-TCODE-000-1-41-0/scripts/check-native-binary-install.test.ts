/**
 * D1.166 — the guard's own arms.
 *
 * The centrepiece is the 2026-09-13 incident in miniature: a lockfile whose
 * parent still declares eight platform dependencies while `packages` carries
 * none of them, which is what `bun install` produced while exiting 0.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLAUDE_SDK_PACKAGE,
  checkNativeBinaryInstall,
  collectPlatformDependencies,
  findNativeBinaryFindings,
  parseJsonc,
  readClaudeSelfReports,
  readInstalledVersion,
} from './check-native-binary-install.ts'

const PARENT = '@anthropic-ai/claude-agent-sdk'
const PLATFORM = `${PARENT}-darwin-arm64`

function lockText(options: {
  declared: string
  platformEntry: string | null
}): string {
  const platformLine = options.platformEntry === null
    ? ''
    : `    "${PLATFORM}": ["${PLATFORM}@${options.platformEntry}", "https://example.invalid/x.tgz", { "os": "darwin", "cpu": "arm64" }, "sha512-x"],\n`
  return `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "rig",
      "dependencies": {
        "${PARENT}": "${options.declared}",
      },
    },
  },
  "packages": {
    "${PARENT}": ["${PARENT}@${options.declared}", "https://example.invalid/p.tgz", { "optionalDependencies": { "${PLATFORM}": "${options.declared}" } }, "sha512-y"],
${platformLine}  },
}
`
}

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'wi-n-native-'))
}

describe('check-native-binary-install', () => {
  it('parses the trailing commas bun.lock really carries, and never edits a string', () => {
    // The comma inside the URL string must survive; the two before `}` must not.
    const parsed = parseJsonc('{ "a": ["x@1", "https://example.invalid/a,}b" ], "c": 1, }') as Record<string, unknown>
    expect(parsed.c).toBe(1)
    expect((parsed.a as string[])[1]).toBe('https://example.invalid/a,}b')
  })

  it('the 2026-09-13 incident: the parent declares eight, the lockfile carries none', () => {
    const root = makeRoot()
    try {
      const report = checkNativeBinaryInstall(root, lockText({ declared: '0.3.251', platformEntry: null }))
      expect(report.families).toEqual([PARENT])
      expect(report.findings).toHaveLength(1)
      expect(report.findings[0]?.reason).toBe('platform-entry-missing')
      expect(report.findings[0]?.locked).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the control: the same lockfile with the entry present is silent', () => {
    const root = makeRoot()
    try {
      const report = checkNativeBinaryInstall(root, lockText({ declared: '0.3.251', platformEntry: '0.3.251' }))
      expect(report.findings).toEqual([])
      expect(report.dependencies).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a platform entry left at the version BEFORE the bump is a finding rule 1 cannot see', () => {
    const root = makeRoot()
    try {
      const report = checkNativeBinaryInstall(root, lockText({ declared: '0.3.251', platformEntry: '0.3.247' }))
      expect(report.findings.map(finding => finding.reason)).toEqual(['locked-version-disagrees'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the incident\'s OTHER half: the directory on disk a version behind the lock', () => {
    const root = makeRoot()
    try {
      const dir = join(root, 'node_modules', ...PLATFORM.split('/'))
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: PLATFORM, version: '0.3.247' }))
      expect(readInstalledVersion(root, PLATFORM)).toBe('0.3.247')

      const report = checkNativeBinaryInstall(root, lockText({ declared: '0.3.251', platformEntry: '0.3.251' }))
      expect(report.findings.map(finding => finding.reason)).toEqual(['installed-version-disagrees'])
      expect(report.findings[0]?.installed).toBe('0.3.247')

      // The negative arm, same rig: matching versions are silent, so the rule
      // is reading the file rather than firing on its existence.
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: PLATFORM, version: '0.3.251' }))
      expect(checkNativeBinaryInstall(root, lockText({ declared: '0.3.251', platformEntry: '0.3.251' })).findings).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a platform package this host does not install is not a finding', () => {
    const root = makeRoot()
    try {
      const report = checkNativeBinaryInstall(root, lockText({ declared: '0.3.251', platformEntry: '0.3.251' }))
      expect(report.dependencies[0]?.installed).toBeNull()
      expect(report.findings).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('an optional dependency that is NOT platform-suffixed is out of the family', () => {
    const lock = parseJsonc(`{
  "packages": {
    "some-pkg": ["some-pkg@1.0.0", "https://example.invalid/s.tgz", { "optionalDependencies": { "fsevents": "^2.3.2" } }, "sha512-z"],
  },
}`)
    const collected = collectPlatformDependencies(lock, '/nonexistent')
    expect(collected.families).toEqual([])
    expect(collected.dependencies).toEqual([])
  })

  it('the self-report pair PARTS when the manifest and the binary disagree', () => {
    const root = makeRoot()
    try {
      const sdkDir = join(root, 'node_modules', ...CLAUDE_SDK_PACKAGE.split('/'))
      mkdirSync(sdkDir, { recursive: true })
      writeFileSync(join(sdkDir, 'package.json'), JSON.stringify({ name: CLAUDE_SDK_PACKAGE, claudeCodeVersion: '2.1.251' }))
      const binDir = join(root, 'node_modules', ...`${CLAUDE_SDK_PACKAGE}-${process.platform}-${process.arch}`.split('/'))
      mkdirSync(binDir, { recursive: true })
      writeFileSync(join(binDir, 'claude'), '')

      const parted = readClaudeSelfReports(root, () => '2.1.247')
      expect(parted).toEqual({ manifest: '2.1.251', binary: '2.1.247', skipped: null })

      // The agreeing arm, so the pair can fail as well as pass.
      expect(readClaudeSelfReports(root, () => '2.1.251').binary).toBe('2.1.251')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a missing SDK or a missing binary SKIPS with a reason, never silently', () => {
    const root = makeRoot()
    try {
      expect(readClaudeSelfReports(root, () => '2.1.251').skipped).toContain('not installed')

      const sdkDir = join(root, 'node_modules', ...CLAUDE_SDK_PACKAGE.split('/'))
      mkdirSync(sdkDir, { recursive: true })
      writeFileSync(join(sdkDir, 'package.json'), JSON.stringify({ name: CLAUDE_SDK_PACKAGE, claudeCodeVersion: '2.1.251' }))
      expect(readClaudeSelfReports(root, () => '2.1.251').skipped).toContain('ships no')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the real tree has no finding, and the family count is read rather than pinned', () => {
    const report = checkNativeBinaryInstall(join(import.meta.dir, '..'))
    expect(report.findings).toEqual([])
    // Not a pinned number: a lift that adds a native package must not redden
    // this. What is asserted is that the instrument SEES something, which is
    // the positive control for every absence above.
    expect(report.families.length).toBeGreaterThan(0)
    expect(report.dependencies.length).toBeGreaterThan(report.families.length)
  })

  it('findNativeBinaryFindings reports at most one reason per dependency', () => {
    const findings = findNativeBinaryFindings([
      { parent: 'p', name: 'p-a', declared: '1.0.0', locked: null, installed: '0.9.0' },
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0]?.reason).toBe('platform-entry-missing')
  })
})
