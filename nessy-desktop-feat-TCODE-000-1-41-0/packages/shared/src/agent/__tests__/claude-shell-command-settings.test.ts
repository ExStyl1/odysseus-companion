/**
 * P6.254 — a credential helper an operator configures is read by the SDK, can
 * never be consulted, and nothing said so.
 *
 * `apiKeyHelper` sits at authentication precedence tier 4 and the vendored SDK
 * reads it. Every claude child this product spawns is given a tier-3
 * `ANTHROPIC_API_KEY` unconditionally, and tier 3 outranks tier 4 — so an
 * operator's credential rotation silently never ran.
 *
 * The MECHANISM stays refused (owner ruling 2026-08-08, R50, extended to the two
 * helper keys in `config/managed-env.ts`: this product does not accept an
 * admin-supplied executable as a settings source). These cases pin the honesty
 * half: the line exists, it names the ruling, and it never carries a value.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CLAUDE_SHELL_COMMAND_CREDENTIAL_SETTING_KEYS,
  formatClaudeShellCommandSettingRefusal,
  readClaudeProjectSettingsKeys,
  readClaudeUserSettingsKeys,
} from '../claude-shell-command-settings.ts'

function workspaceWith(settings: string | undefined, local?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'nessy-claude-shell-settings-'))
  mkdirSync(join(root, '.claude'), { recursive: true })
  if (settings !== undefined) writeFileSync(join(root, '.claude', 'settings.json'), settings)
  if (local !== undefined) writeFileSync(join(root, '.claude', 'settings.local.json'), local)
  return root
}

describe('P6.254 · the shell-command settings refusal', () => {
  it('names the key and the ruling, and NEVER the value', () => {
    const secretish = '/opt/corp/mint-key.sh --token AKIAsecretvalue'
    const [line, ...rest] = formatClaudeShellCommandSettingRefusal(
      readClaudeProjectSettingsKeys(workspaceWith(
        JSON.stringify({ apiKeyHelper: secretish, permissions: { allow: [] } }),
      )),
    )
    expect(rest).toEqual([])
    expect(line).toContain('apiKeyHelper')
    expect(line).toContain('2026-08-08')
    expect(line).toContain('admin-supplied executable is not accepted as a settings source')
    // The whole point of the "never a value" clause: a helper command line is
    // itself a place an administrator can put a secret.
    expect(line).not.toContain(secretish)
    expect(line).not.toContain('AKIAsecretvalue')
  })

  it('F1.1064: does not claim the Claude runtime ignores apiKeyHelper — measured, the child runs it', () => {
    const [line] = formatClaudeShellCommandSettingRefusal(['apiKeyHelper'])
    expect(line).toContain('the Pi and codex runtimes do not apply')
    expect(line).toContain('On the Claude runtime Claude Code itself runs an `apiKeyHelper`')
    expect(line).not.toContain('unreachable')
    expect(line).not.toContain('on any runtime')
  })

  it('is SILENT when no such key is set — a line that always prints is one nobody reads', () => {
    expect(formatClaudeShellCommandSettingRefusal(
      readClaudeProjectSettingsKeys(workspaceWith(JSON.stringify({ permissions: { allow: [] } }))),
    )).toEqual([])
    expect(formatClaudeShellCommandSettingRefusal([])).toEqual([])
    expect(formatClaudeShellCommandSettingRefusal(undefined)).toEqual([])
  })

  it('reads `settings.local.json` as well, and names both keys in ONE line', () => {
    const keys = readClaudeProjectSettingsKeys(workspaceWith(
      JSON.stringify({ apiKeyHelper: 'a' }),
      JSON.stringify({ otelHeadersHelper: 'b' }),
    ))
    expect(new Set(keys)).toEqual(new Set(CLAUDE_SHELL_COMMAND_CREDENTIAL_SETTING_KEYS))
    const lines = formatClaudeShellCommandSettingRefusal(keys)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('apiKeyHelper')
    expect(lines[0]).toContain('otelHeadersHelper')
  })

  it('skips a file that is missing, unparseable or not an object — the same outcome as no keys', () => {
    expect(readClaudeProjectSettingsKeys('/nonexistent/workspace/root')).toEqual([])
    expect(readClaudeProjectSettingsKeys(workspaceWith('{ not json'))).toEqual([])
    expect(readClaudeProjectSettingsKeys(workspaceWith('[1,2,3]'))).toEqual([])
  })
})

/**
 * C3.49 (QC3 = A, owner 2026-09-11) — the scope the P6.254 reader never read.
 *
 * The docblock of the module under test names `~/.claude/settings.json` as the
 * case that motivated the whole diagnostic, and the reader only ever opened
 * `<workingDirectory>/.claude`. The ruling is scope-free — R50 refuses an
 * admin-supplied executable as a settings source wherever it is configured — so
 * the line now covers the user scope too and says which file to edit.
 */
describe('C3.49 · the same refusal in the USER scope', () => {
  function userHomeWith(settings: string | undefined, dirName = '.claude'): string {
    const home = mkdtempSync(join(tmpdir(), 'nessy-claude-user-settings-'))
    mkdirSync(join(home, dirName), { recursive: true })
    if (settings !== undefined) {
      writeFileSync(join(home, dirName, 'settings.json'), settings)
    }
    return home
  }

  it('names the key, the user file and the ruling — and NEVER the value', () => {
    const secretish = '/opt/corp/mint-key.sh --token AKIAsecretvalue'
    const home = userHomeWith(JSON.stringify({ apiKeyHelper: secretish }))
    const keys = readClaudeUserSettingsKeys({ home })
    expect(keys).toEqual(['apiKeyHelper'])
    const lines = formatClaudeShellCommandSettingRefusal({ user: keys })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('apiKeyHelper')
    expect(lines[0]).toContain('~/.claude/settings.json')
    expect(lines[0]).toContain('in any scope')
    expect(lines[0]).toContain('admin-supplied executable is not accepted as a settings source')
    expect(lines[0]).not.toContain(secretish)
    expect(lines[0]).not.toContain('AKIAsecretvalue')
  })

  it('reads `CLAUDE_CONFIG_DIR` as the REPLACEMENT for `~/.claude`, never as its parent', () => {
    // settings.md#find-or-create-your-settings-files: "To keep the
    // home-directory files somewhere else, set CLAUDE_CONFIG_DIR; Claude Code
    // then stores your settings, session history, and plugins there instead."
    const relocated = userHomeWith(JSON.stringify({ otelHeadersHelper: 'x' }), 'corp-claude')
    expect(readClaudeUserSettingsKeys({ configDir: join(relocated, 'corp-claude') }))
      .toEqual(['otelHeadersHelper'])
    // The parent reading — `<CLAUDE_CONFIG_DIR>/.claude/settings.json` — finds
    // nothing, which is the control that the path is not nested.
    expect(readClaudeUserSettingsKeys({ home: relocated })).toEqual([])
  })

  it('is SILENT for a user file without such a key, and for a home with no `.claude` at all', () => {
    const home = userHomeWith(JSON.stringify({ theme: 'dark', permissions: { allow: [] } }))
    expect(readClaudeUserSettingsKeys({ home })).toEqual(['theme', 'permissions'])
    expect(formatClaudeShellCommandSettingRefusal({ user: readClaudeUserSettingsKeys({ home }) }))
      .toEqual([])
    expect(readClaudeUserSettingsKeys({ home: join(tmpdir(), 'nessy-no-such-home-c349') }))
      .toEqual([])
    expect(formatClaudeShellCommandSettingRefusal({})).toEqual([])
  })

  it('names BOTH scopes in one line when both carry a key', () => {
    const lines = formatClaudeShellCommandSettingRefusal({
      project: readClaudeProjectSettingsKeys(workspaceWith(JSON.stringify({ apiKeyHelper: 'p' }))),
      user: readClaudeUserSettingsKeys({
        home: userHomeWith(JSON.stringify({ apiKeyHelper: 'u', otelHeadersHelper: 'u2' })),
      }),
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("apiKeyHelper (in this project's .claude settings and your user")
    expect(lines[0]).toContain('otelHeadersHelper (in your user ~/.claude/settings.json)')
  })
})
