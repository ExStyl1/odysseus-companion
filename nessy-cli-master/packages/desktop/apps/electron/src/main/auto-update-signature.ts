import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export const EXPECTED_MAC_TEAM_IDENTIFIER = '35CMT9F8X3'
export const EXPECTED_MAC_BUNDLE_IDENTIFIER = 'ru.tfinance.nessy-cli.desktop'

export interface MacCodeSignatureStatus {
  trustedForAutoUpdate: boolean
  appBundlePath: string
  reason?:
    | 'codesign-failed'
    | 'adhoc-signature'
    | 'missing-team-identifier'
    | 'unexpected-team-identifier'
    | 'unexpected-bundle-identifier'
  identifier?: string
  signature?: string
  teamIdentifier?: string
  diagnostic?: string
}

export interface MacUpdateArchiveStatus {
  trustedForAutoUpdate: boolean
  archivePath: string
  reason?:
    | 'archive-extraction-failed'
    | 'missing-app-bundle'
    | 'invalid-app-signature'
    | 'gatekeeper-assessment-failed'
  appSignature?: MacCodeSignatureStatus
  diagnostic?: string
}

function parseCodesignField(output: string, field: string): string | undefined {
  const match = output.match(new RegExp(`^${field}=(.*)$`, 'm'))
  return match?.[1]?.trim()
}

export function getMacAppBundlePath(executablePath: string): string {
  return path.dirname(path.dirname(path.dirname(executablePath)))
}

export function parseMacCodeSignatureStatus(
  appBundlePath: string,
  exitStatus: number | null,
  output: string,
): MacCodeSignatureStatus {
  if (exitStatus !== 0) {
    return {
      trustedForAutoUpdate: false,
      appBundlePath,
      reason: 'codesign-failed',
      diagnostic: output.trim(),
    }
  }

  const identifier = parseCodesignField(output, 'Identifier')
  const signature = parseCodesignField(output, 'Signature')
  const teamIdentifier = parseCodesignField(output, 'TeamIdentifier')

  if (signature === 'adhoc') {
    return {
      trustedForAutoUpdate: false,
      appBundlePath,
      reason: 'adhoc-signature',
      identifier,
      signature,
      teamIdentifier,
    }
  }

  if (!teamIdentifier || teamIdentifier === 'not set') {
    return {
      trustedForAutoUpdate: false,
      appBundlePath,
      reason: 'missing-team-identifier',
      identifier,
      signature,
      teamIdentifier,
    }
  }

  if (teamIdentifier !== EXPECTED_MAC_TEAM_IDENTIFIER) {
    return {
      trustedForAutoUpdate: false,
      appBundlePath,
      reason: 'unexpected-team-identifier',
      identifier,
      signature,
      teamIdentifier,
    }
  }

  if (identifier !== EXPECTED_MAC_BUNDLE_IDENTIFIER) {
    return {
      trustedForAutoUpdate: false,
      appBundlePath,
      reason: 'unexpected-bundle-identifier',
      identifier,
      signature,
      teamIdentifier,
    }
  }

  return {
    trustedForAutoUpdate: true,
    appBundlePath,
    identifier,
    signature,
    teamIdentifier,
  }
}

export function getMacAppCodeSignatureStatus(appBundlePath: string): MacCodeSignatureStatus {
  const verification = spawnSync(
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', appBundlePath],
    { encoding: 'utf8' },
  )
  const verificationOutput = `${verification.stdout ?? ''}${verification.stderr ?? ''}`
  if (verification.status !== 0) {
    return parseMacCodeSignatureStatus(appBundlePath, verification.status, verificationOutput)
  }

  const metadata = spawnSync('/usr/bin/codesign', ['-d', '-vvv', appBundlePath], {
    encoding: 'utf8',
  })
  const metadataOutput = `${metadata.stdout ?? ''}${metadata.stderr ?? ''}`
  return parseMacCodeSignatureStatus(appBundlePath, metadata.status, metadataOutput)
}

export function getCurrentMacCodeSignatureStatus(executablePath: string): MacCodeSignatureStatus {
  return getMacAppCodeSignatureStatus(getMacAppBundlePath(executablePath))
}

export function verifyMacUpdateArchive(archivePath: string): MacUpdateArchiveStatus {
  const extractionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nessy-update-'))

  try {
    const extraction = spawnSync('/usr/bin/ditto', ['-x', '-k', archivePath, extractionDir], {
      encoding: 'utf8',
    })
    if (extraction.status !== 0) {
      return {
        trustedForAutoUpdate: false,
        archivePath,
        reason: 'archive-extraction-failed',
        diagnostic: `${extraction.stdout ?? ''}${extraction.stderr ?? ''}`.trim(),
      }
    }

    const appBundles = fs
      .readdirSync(extractionDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    if (appBundles.length !== 1) {
      return {
        trustedForAutoUpdate: false,
        archivePath,
        reason: 'missing-app-bundle',
        diagnostic: `Expected one app bundle, found ${appBundles.length}`,
      }
    }

    const appBundlePath = path.join(extractionDir, appBundles[0].name)
    const appSignature = getMacAppCodeSignatureStatus(appBundlePath)
    if (!appSignature.trustedForAutoUpdate) {
      return {
        trustedForAutoUpdate: false,
        archivePath,
        reason: 'invalid-app-signature',
        appSignature,
      }
    }

    const assessment = spawnSync(
      '/usr/sbin/spctl',
      ['--assess', '--type', 'execute', '--verbose=2', appBundlePath],
      { encoding: 'utf8' },
    )
    if (assessment.status !== 0) {
      return {
        trustedForAutoUpdate: false,
        archivePath,
        reason: 'gatekeeper-assessment-failed',
        appSignature,
        diagnostic: `${assessment.stdout ?? ''}${assessment.stderr ?? ''}`.trim(),
      }
    }

    return { trustedForAutoUpdate: true, archivePath, appSignature }
  } finally {
    fs.rmSync(extractionDir, { recursive: true, force: true })
  }
}
