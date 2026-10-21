import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readNessyGatewayJwt } from '../nessy-auth'

let tempDir: string | null = null

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true })
    tempDir = null
  }
})

describe('readNessyGatewayJwt', () => {
  it('returns the jwt field from a creds file', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nessy-auth-'))
    const credsPath = join(tempDir, 'dp_auth_creds.json')
    // JWT-shaped (3 non-empty dot-separated segments) — readNessyGatewayJwt
    // guards with isJwtShaped, so a placeholder like the old 'jwt-token' would
    // now read as absent.
    writeFileSync(credsPath, JSON.stringify({ jwt: 'aGVhZA.cGF5bG9hZA.c2ln' }))

    expect(readNessyGatewayJwt(credsPath)).toEqual({ jwt: 'aGVhZA.cGF5bG9hZA.c2ln' })
  })

  it('returns null when the creds file is absent or invalid', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nessy-auth-'))
    expect(readNessyGatewayJwt(join(tempDir, 'missing.json'))).toBeNull()

    const invalidPath = join(tempDir, 'invalid.json')
    writeFileSync(invalidPath, JSON.stringify({ jwt: '' }))
    expect(readNessyGatewayJwt(invalidPath)).toBeNull()
  })
})
