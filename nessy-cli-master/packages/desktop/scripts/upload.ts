#!/usr/bin/env bun
/**
 * Upload desktop build artifacts to S3
 *
 * Usage:
 *   bun run scripts/upload.ts --electron [--version <version>]
 *
 * Environment variables (required):
 *   S3_VERSIONS_BUCKET_ENDPOINT - S3 endpoint (e.g., s3-msk.tinkoff.ru)
 *   S3_VERSIONS_BUCKET_ACCESS_KEY_ID - S3 access key
 *   S3_VERSIONS_BUCKET_SECRET_ACCESS_KEY - S3 secret key
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import * as https from 'node:https'
import * as http from 'node:http'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const S3_BUCKET = 'nestor-companion'
const S3_BASE_KEY = 'nessy-cli/desktop'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UploadOptions {
  electron: boolean
  version?: string
  latest?: boolean
  script?: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRequiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`ERROR: Environment variable ${name} is not set`)
    console.error('Required environment variables:')
    console.error('  S3_VERSIONS_BUCKET_ENDPOINT')
    console.error('  S3_VERSIONS_BUCKET_ACCESS_KEY_ID')
    console.error('  S3_VERSIONS_BUCKET_SECRET_ACCESS_KEY')
    process.exit(1)
  }
  return value
}

function createS3Client(options?: { tlsRejectUnauthorized?: boolean }): S3Client {
  const endpoint = getRequiredEnv('S3_VERSIONS_BUCKET_ENDPOINT')
  const accessKeyId = getRequiredEnv('S3_VERSIONS_BUCKET_ACCESS_KEY_ID')
  const secretAccessKey = getRequiredEnv('S3_VERSIONS_BUCKET_SECRET_ACCESS_KEY')

  // Normalize endpoint to URL format
  const endpointUrl = endpoint.startsWith('http') ? endpoint : `https://${endpoint}`

  const tlsRejectUnauthorized = options?.tlsRejectUnauthorized ?? true

  // Create custom HTTPS agent with TLS settings
  const httpsAgent = new https.Agent({
    rejectUnauthorized: tlsRejectUnauthorized,
  })

  return new S3Client({
    endpoint: endpointUrl,
    region: 'ru-central1', // Default region for S3-compatible storage
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
    forcePathStyle: true, // Required for S3-compatible storage
    requestHandler: {
      httpsAgent,
      httpAgent: new http.Agent({ rejectUnauthorized: tlsRejectUnauthorized }),
    },
  })
}

async function uploadFile(s3Client: S3Client, filePath: string, key: string): Promise<void> {
  const fileData = await readFile(filePath)

  const command = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: fileData,
    ContentType: getContentType(filePath),
  })

  await s3Client.send(command)
  console.log(`  ✓ Uploaded: ${key}`)
}

function getContentType(filePath: string): string {
  if (filePath.endsWith('.gpg-key.asc')) {
    return 'application/pgp-keys'
  }

  const ext = filePath.split('.').pop()?.toLowerCase()
  const contentTypes: Record<string, string> = {
    dmg: 'application/x-apple-diskimage',
    exe: 'application/x-msdownload',
    appimage: 'application/x-executable',
    zip: 'application/zip',
    yml: 'application/x-yaml',
    sh: 'text/x-shellscript',
    ps1: 'text/plain',
    blockmap: 'application/octet-stream',
    asc: 'application/pgp-signature',
    json: 'application/json',
  }
  return contentTypes[ext || ''] || 'application/octet-stream'
}

async function getReleaseFiles(releaseDir: string): Promise<string[]> {
  const files: string[] = []

  try {
    const entries = await readdir(releaseDir)
    for (const entry of entries) {
      const fullPath = join(releaseDir, entry)
      const stats = await stat(fullPath)
      if (stats.isFile()) {
        files.push(fullPath)
      }
    }
  } catch (error) {
    console.error(`ERROR: Failed to read release directory: ${releaseDir}`)
    console.error(error)
    process.exit(1)
  }

  return files
}

async function uploadToS3(
  s3Client: S3Client,
  files: string[],
  version: string,
  uploadLatest: boolean = false,
): Promise<void> {
  const versionKey = `${S3_BASE_KEY}/${version}`

  console.log(`\nUploading ${files.length} file(s) to S3...`)
  console.log(`  Version: ${versionKey}`)
  if (uploadLatest) {
    console.log(`  Latest: ${S3_BASE_KEY}/latest`)
  }
  console.log()

  // Upload to versioned directory
  for (const file of files) {
    const fileName = file.split('/').pop()!
    const key = `${versionKey}/${fileName}`
    await uploadFile(s3Client, file, key)
  }

  // Upload to latest directory (if --latest flag is set)
  if (uploadLatest) {
    const latestKey = `${S3_BASE_KEY}/latest`
    for (const file of files) {
      const fileName = file.split('/').pop()!
      const key = `${latestKey}/${fileName}`
      await uploadFile(s3Client, file, key)

      // [nessy-fork] desktop-stable-update-channel
      if (/^latest(?:-.+)?\.yml$/.test(fileName)) {
        const legacyBetaKey = `${latestKey}/${fileName.replace(/^latest/, 'beta')}`
        await uploadFile(s3Client, file, legacyBetaKey)
      }
    }
  }
}

async function uploadManifest(
  s3Client: S3Client,
  version: string,
  commitSha: string,
  uploadLatest: boolean = false,
): Promise<void> {
  const manifest = {
    version,
    publishedAt: new Date().toISOString(),
    commit: commitSha,
    platforms: ['linux-x64', 'win-x64', 'mac-x64', 'mac-arm64'],
  }

  // Upload manifest to versioned directory
  const versionManifestKey = `${S3_BASE_KEY}/${version}/manifest.json`
  const versionCommand = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: versionManifestKey,
    Body: JSON.stringify(manifest, null, 2),
    ContentType: 'application/json',
  })
  await s3Client.send(versionCommand)
  console.log(`  ✓ Uploaded: ${versionManifestKey}`)

  // Upload manifest to latest directory (if --latest flag is set)
  if (uploadLatest) {
    const latestManifestKey = `${S3_BASE_KEY}/latest/manifest.json`
    const latestCommand = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: latestManifestKey,
      Body: JSON.stringify(manifest, null, 2),
      ContentType: 'application/json',
    })
    await s3Client.send(latestCommand)
    console.log(`  ✓ Uploaded: ${latestManifestKey}`)
  }
}

// ---------------------------------------------------------------------------
// CLI Parser
// ---------------------------------------------------------------------------

function parseArgs(args: string[]): UploadOptions {
  const options: UploadOptions = {
    electron: false,
    version: undefined,
    latest: false,
    script: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--electron') {
      options.electron = true
    } else if (arg === '--version' && args[i + 1]) {
      options.version = args[++i]
    } else if (arg === '--latest') {
      options.latest = true
    } else if (arg === '--script') {
      options.script = true
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Upload desktop build artifacts to S3

Usage:
  bun run scripts/upload.ts [options]

Options:
  --electron    Upload Electron desktop build artifacts
  --version     Override version (default: read from package.json)
  --latest      Also upload to nessy-cli/desktop/latest
  --script      Also upload installer scripts (requires --latest)
  --help, -h    Show this help message

Environment variables:
  S3_VERSIONS_BUCKET_ENDPOINT      - S3 endpoint (e.g., s3-msk.tinkoff.ru)
  S3_VERSIONS_BUCKET_ACCESS_KEY_ID - S3 access key
  S3_VERSIONS_BUCKET_SECRET_ACCESS_KEY - S3 secret key

Examples:
  bun run scripts/upload.ts --electron
  bun run scripts/upload.ts --electron --version 1.2.3
  bun run scripts/upload.ts --electron --version 1.2.3 --latest --script
`)
      process.exit(0)
    }
  }

  return options
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function runWithTlsFallback(): Promise<void> {
  const args = process.argv.slice(2)
  const options = parseArgs(args)

  if (!options.electron) {
    console.error('ERROR: No upload target specified')
    console.error('Usage: bun run scripts/upload.ts --electron [--version <version>]')
    console.error('Run with --help for more information.')
    process.exit(1)
  }

  if (options.script && !options.latest) {
    console.error('ERROR: --script requires --latest')
    process.exit(1)
  }

  console.log('=== Desktop S3 Upload ===\n')

  // Determine release directory
  const scriptDir = new URL('.', import.meta.url).pathname
  const releaseDir = join(scriptDir, '..', 'apps', 'electron', 'release')

  // Get version
  let version = options.version
  if (!version) {
    const pkgPath = join(scriptDir, '..', 'package.json')
    const pkgData = await readFile(pkgPath, 'utf-8')
    const pkg = JSON.parse(pkgData)
    version = pkg.version
  }

  if (!/^\d+\.\d+\.\d+(-beta\.\d+)?$/.test(version)) {
    console.error(`ERROR: Invalid desktop version: ${JSON.stringify(version)}`)
    process.exit(1)
  }

  if (options.latest && !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error('ERROR: --latest is only allowed for stable versions')
    process.exit(1)
  }

  console.log(`Version: ${version}`)
  console.log(`Release directory: ${releaseDir}`)

  // Get release files
  const files = await getReleaseFiles(releaseDir)

  if (files.length === 0) {
    console.error(`ERROR: No files found in ${releaseDir}`)
    process.exit(1)
  }

  // [nessy-fork] desktop-linux-update-signing
  const appImages = files.filter((candidate) => candidate.endsWith('.AppImage'))
  for (const file of appImages) {
    if (!files.includes(`${file}.asc`)) {
      console.error(`ERROR: Missing GPG signature for ${file.split('/').pop()}`)
      process.exit(1)
    }
  }
  for (const file of files.filter((candidate) => /\/.*-linux.*\.yml$/.test(candidate))) {
    if (!files.includes(`${file}.asc`)) {
      console.error(`ERROR: Missing GPG signature for ${file.split('/').pop()}`)
      process.exit(1)
    }
  }
  if (appImages.length > 0 && !files.some((file) => file.endsWith('/nessy-cli-desktop.gpg-key.asc'))) {
    console.error('ERROR: Missing GPG public key for AppImage verification')
    process.exit(1)
  }

  console.log(`Found ${files.length} file(s):`)
  for (const file of files) {
    console.log(`  - ${file.split('/').pop()}`)
  }

  // Get commit SHA from environment (GitLab CI) or use 'manual'
  const commitSha = process.env.CI_COMMIT_SHORT_SHA || 'manual'

  // Try upload with TLS verification enabled first
  let s3Client = createS3Client()
  let tlsFallback = false

  try {
    await uploadToS3(s3Client, files, version, options.latest)
    await uploadManifest(s3Client, version, commitSha, options.latest)

    // Upload installer scripts (if --script flag is set)
    if (options.script) {
      for (const scriptName of ['install-app.sh', 'install-app.ps1']) {
        const scriptPath = join(scriptDir, scriptName)
        try {
          await stat(scriptPath)
          const scriptKey = `${S3_BASE_KEY}/latest/${scriptName}`
          await uploadFile(s3Client, scriptPath, scriptKey)
        } catch {
          console.warn(`WARNING: ${scriptName} not found at ${scriptPath}, skipping...`)
        }
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const isTlsError =
      errorMessage.includes('unable to get local issuer certificate') ||
      errorMessage.includes('UNABLE_TO_GET_ISSUER_CERT_LOCALLY') ||
      errorMessage.includes('UNABLE_TO_VERIFY_LEAF_SIGNATURE') ||
      errorMessage.includes('certificate') ||
      errorMessage.includes('self-signed')

    if (isTlsError) {
      console.warn('\n⚠ TLS certificate verification failed')
      console.warn('Retrying with TLS verification disabled (insecure)...')

      tlsFallback = true
      s3Client = createS3Client({ tlsRejectUnauthorized: false })

      await uploadToS3(s3Client, files, version, options.latest)
      await uploadManifest(s3Client, version, commitSha, options.latest)

      if (options.script) {
        for (const scriptName of ['install-app.sh', 'install-app.ps1']) {
          const scriptPath = join(scriptDir, scriptName)
          try {
            await stat(scriptPath)
            const scriptKey = `${S3_BASE_KEY}/latest/${scriptName}`
            await uploadFile(s3Client, scriptPath, scriptKey)
          } catch {
            console.warn(`WARNING: ${scriptName} not found at ${scriptPath}, skipping...`)
          }
        }
      }
    } else {
      throw error
    }
  }

  console.log('\n=== Upload Complete ===\n')
  console.log(`S3 Bucket: ${S3_BUCKET}`)
  console.log(`Version path: ${S3_BASE_KEY}/${version}/`)
  if (options.latest) {
    console.log(`Latest path: ${S3_BASE_KEY}/latest/`)
  }
  if (tlsFallback) {
    console.warn('\n⚠ Warning: Upload completed with TLS verification disabled')
    console.warn('This is insecure and should only be used in development/testing environments.')
  }
  console.log()
}

// Run
runWithTlsFallback().catch((error) => {
  console.error('ERROR:', error.message)
  if (error.stack) {
    console.error(error.stack)
  }
  process.exit(1)
})
