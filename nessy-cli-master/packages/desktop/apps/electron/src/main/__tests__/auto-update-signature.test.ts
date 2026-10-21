import { describe, expect, it } from 'bun:test'

import {
  EXPECTED_MAC_BUNDLE_IDENTIFIER,
  EXPECTED_MAC_TEAM_IDENTIFIER,
  getMacAppBundlePath,
  parseMacCodeSignatureStatus,
} from '../auto-update-signature'

describe('auto-update-signature', () => {
  it('maps an executable path back to the macOS app bundle', () => {
    expect(getMacAppBundlePath('/Applications/OpenWork.app/Contents/MacOS/OpenWork'))
      .toBe('/Applications/OpenWork.app')
  })

  it('rejects ad-hoc signatures because they pin updates to a cdhash', () => {
    const status = parseMacCodeSignatureStatus('/Applications/OpenWork.app', 0, [
      'Signature=adhoc',
      'TeamIdentifier=not set',
    ].join('\n'))

    expect(status.trustedForAutoUpdate).toBe(false)
    expect(status.reason).toBe('adhoc-signature')
  })

  it('rejects unsigned apps', () => {
    const status = parseMacCodeSignatureStatus(
      '/Applications/OpenWork.app',
      1,
      '/Applications/OpenWork.app: code object is not signed at all',
    )

    expect(status.trustedForAutoUpdate).toBe(false)
    expect(status.reason).toBe('codesign-failed')
  })

  it('accepts apps signed by the expected publisher', () => {
    const status = parseMacCodeSignatureStatus(
      '/Applications/OpenWork.app',
      0,
      [
        `Identifier=${EXPECTED_MAC_BUNDLE_IDENTIFIER}`,
        'Authority=Developer ID Application: T-Bank (35CMT9F8X3)',
        `TeamIdentifier=${EXPECTED_MAC_TEAM_IDENTIFIER}`,
      ].join('\n'),
    )

    expect(status.trustedForAutoUpdate).toBe(true)
    expect(status.identifier).toBe(EXPECTED_MAC_BUNDLE_IDENTIFIER)
    expect(status.teamIdentifier).toBe(EXPECTED_MAC_TEAM_IDENTIFIER)
  })

  it('rejects apps signed by another Apple team', () => {
    const status = parseMacCodeSignatureStatus(
      '/Applications/OpenWork.app',
      0,
      [
        `Identifier=${EXPECTED_MAC_BUNDLE_IDENTIFIER}`,
        'Authority=Developer ID Application: Example Inc (ABCDE12345)',
        'TeamIdentifier=ABCDE12345',
      ].join('\n'),
    )

    expect(status.trustedForAutoUpdate).toBe(false)
    expect(status.reason).toBe('unexpected-team-identifier')
  })

  it('rejects another app signed by the expected Apple team', () => {
    const status = parseMacCodeSignatureStatus(
      '/Applications/OpenWork.app',
      0,
      [
        'Identifier=com.example.other-app',
        'Authority=Developer ID Application: T-Bank (35CMT9F8X3)',
        `TeamIdentifier=${EXPECTED_MAC_TEAM_IDENTIFIER}`,
      ].join('\n'),
    )

    expect(status.trustedForAutoUpdate).toBe(false)
    expect(status.reason).toBe('unexpected-bundle-identifier')
  })
})
