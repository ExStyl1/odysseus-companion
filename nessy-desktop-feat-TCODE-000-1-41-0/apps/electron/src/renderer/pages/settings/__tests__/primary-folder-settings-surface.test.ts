/**
 * C3.178 — the surface the row asks for, and the reason it has to exist.
 *
 * The wire block that has always carried `primaryRoot`
 * (`PiHarnessFilesystemScopeSummaryV1`, `packages/core/src/types/pi-harness-runtime.ts`)
 * is WIRE-LIVE and DISPLAY-DEAD (P2.364): its only renderer was deleted a month
 * before the keys that labelled it were. So a stored choice with no control
 * would be a setting nobody could make and nobody could see — which is why the
 * row names the surface as part of "done", not as a follow-up.
 *
 * `bun test` has no DOM in this repo, so the wiring is pinned by source match,
 * for `codex-subagents-settings-surface.test.ts`'s reason and one of its own:
 * importing `PermissionsSettingsPage` drags in the `@nessy-agent/ui` barrel and
 * its pdfjs chain (a nested `pdfjs-dist` copy no `mock.module` of the bare
 * specifier reaches — AGENTS.md §Traps), for no gain. Nothing below needs the
 * component to render, only to be wired.
 *
 * ONE PIN IS DELIBERATELY ABSENT: the locale copy. The five
 * `settings.permissions.primaryFolder*` keys are handed to this wave's locale
 * holder (W17-e) with their exact en/ru values, so the presence assertion lands
 * WITH the keys rather than here, where it would be red on arrival. The keys are
 * named below all the same, so a rename in this file without a rename there is
 * still caught.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol/channels'
import { channelLocality } from '@nessy-agent/shared/protocol/routing'

const source = readFileSync(
  fileURLToPath(new URL('../PermissionsSettingsPage.tsx', import.meta.url)),
  'utf8',
)

const PRIMARY_FOLDER_KEYS = [
  'settings.permissions.primaryFolderSection',
  'settings.permissions.primaryFolder',
  'settings.permissions.primaryFolderDesc',
  'settings.permissions.primaryFolderDerived',
  'settings.permissions.primaryFolderScopeNote',
] as const

describe('C3.178 · the primary-folder control', () => {
  it('consumes both primaryDirectory channels', () => {
    expect(source).toContain('getPrimaryDirectory()')
    expect(source).toContain('setPrimaryDirectory(next)')
    // Positive control: the page already consumed a settings pair before this
    // one, so a source read that stopped matching is red here rather than
    // silently green above.
    expect(source).toContain('setMcpChannelPushEnabled(')
  })

  it('re-reads after the write, because a stored choice can be refused', () => {
    // The boundary that matters for a value (rather than a boolean): the stored
    // path is refused at resolution time when it names a folder that is not
    // attached, so an optimistic control that never re-read would keep showing a
    // selection the session does not use. Same shape as the sandbox switches
    // directly above it, and for the same stated reason.
    expect(source).toContain('const handlePrimaryDirectoryChange = useCallback(async (value: string) => {')
    expect(source).toContain('const resolved = await window.electronAPI?.getPrimaryDirectory()')
    expect(source).toContain('if (resolved) setPrimaryDirectoryState(resolved)')
  })

  it('offers the derivation as the default option, through a non-empty sentinel', () => {
    // `''` cannot be the sentinel: Radix reserves it for "clear the selection",
    // so an option with that value renders and then refuses to be selected. The
    // sentinel starts with a character no absolute path can start with.
    expect(source).toContain("const PRIMARY_DIRECTORY_DERIVED = '@derived'")
    expect(source).toContain('value={primaryDirectory.choice ?? PRIMARY_DIRECTORY_DERIVED}')
    expect(source).toContain("value === PRIMARY_DIRECTORY_DERIVED ? null : value")
  })

  it('states the P6.929 narrowing on the control itself', () => {
    // Not decoration. A folder picker that did not say "display and ordering
    // only" would be read as "point the agent at this instead", which is exactly
    // the half the owner ruled out by record on 2026-09-10.
    expect(source).toContain('settings.permissions.primaryFolderScopeNote')
    for (const key of PRIMARY_FOLDER_KEYS) expect(source).toContain(key)
  })

  it('hides itself when there is nothing to choose between', () => {
    // With no attached folders the only candidate is the derivation, and a
    // select with one option is a control that does not control.
    expect(source).toContain('primaryDirectory && primaryDirectory.candidates.length > 0')
  })

  it('routes both channels local, for the machine the folders are on', () => {
    // TOTAL by construction in `routing.ts`, so this cannot be forgotten — but
    // the DIRECTION can be wrong: both the choice and the candidates come from
    // this machine's `config.json`, and the candidates are absolute paths on
    // this filesystem, so a remote answer would offer folders that do not exist.
    expect(channelLocality(RPC_CHANNELS.primaryDirectory.GET)).toBe('local')
    expect(channelLocality(RPC_CHANNELS.primaryDirectory.SET)).toBe('local')
  })
})
