/**
 * Every macOS TCC prompt this app can raise carries its own purpose string.
 *
 * macOS renders the consent prompt from the `NS…UsageDescription` key that
 * matches the resource being asked for. When the key is absent the prompt is
 * blank — the user is asked to grant access to their Desktop by an app that
 * says nothing about why. The bundle carried exactly one such key
 * (`NSLocalNetworkUsageDescription`), whose own comment states the rationale
 * ("Declare the purpose string so the OS prompt is not blank"), while an agent
 * session reads and writes real files in whichever workspace the user opens —
 * routinely Desktop, Documents or Downloads.
 *
 * Asserted against `electron-builder.yml`'s `extendInfo`, which is the only
 * place these strings are declared: nothing at runtime notices a missing one,
 * because the failure is a blank system dialog in a signed build and the app
 * itself is never told.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { load } from 'js-yaml'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')
const builderConfig = load(
  readFileSync(join(repoRoot, 'apps', 'electron', 'electron-builder.yml'), 'utf-8'),
) as { mac?: { extendInfo?: Record<string, unknown> } }

const extendInfo = builderConfig.mac?.extendInfo ?? {}

/** The prompts a workspace-reading agent session can trigger, plus the one already declared. */
const REQUIRED_USAGE_DESCRIPTION_KEYS = [
  'NSLocalNetworkUsageDescription',
  'NSDesktopFolderUsageDescription',
  'NSDocumentsFolderUsageDescription',
  'NSDownloadsFolderUsageDescription',
  'NSAppleMusicUsageDescription',
] as const

describe('macOS usage descriptions', () => {
  for (const key of REQUIRED_USAGE_DESCRIPTION_KEYS) {
    it(`${key} is declared with a non-empty purpose string`, () => {
      const value = extendInfo[key]
      expect(typeof value).toBe('string')
      expect((value as string).trim().length).toBeGreaterThan(0)
    })
  }

  // Boundary: a key that is present but empty produces the same blank prompt as
  // a key that is absent, so presence alone is not the contract.
  it('declares no usage description with an empty value', () => {
    const empty = Object.entries(extendInfo)
      .filter(([key]) => key.endsWith('UsageDescription'))
      .filter(([, value]) => typeof value !== 'string' || value.trim().length === 0)
      .map(([key]) => key)
    expect(empty).toEqual([])
  })

  // Negative control: the probe reads the real file rather than an empty object.
  it('does not invent keys that were never declared', () => {
    expect(extendInfo.NSContactsUsageDescription).toBeUndefined()
    expect(Object.keys(extendInfo).length).toBeGreaterThanOrEqual(
      REQUIRED_USAGE_DESCRIPTION_KEYS.length,
    )
  })
})
