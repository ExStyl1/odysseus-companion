/**
 * DA1.34 — the doctor's gateway sign-in section.
 *
 * ISOLATION FIRST, and it is the DA1.36 door: `getCredsPath` resolves through
 * `getNessyDir`, which returns an absolute `NESSY_HOME` VERBATIM and never
 * consults the home latch. So this suite sets that variable at a temp directory
 * rather than faking `HOME` — anything else would read the developer's own
 * credential file. `delete` first, then assign, on the restore path too
 * (AGENTS.md section Traps: an assignment to a name Bun pre-creates a slot for
 * is invisible to the spread every subprocess env in this tree is built from).
 *
 * EVERY CREDENTIAL HERE IS FABRICATED: three dot-separated segments whose
 * payload is base64 of a literal object this file writes. No real token is read,
 * written or asserted on, and the assertions are on CODES, a LENGTH and
 * BOOLEANS — never on a value.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NESSY_HOME_ENV } from '../../auth/dp/creds-store.ts'
import { NESSY_DP_ENV } from '../../auth/dp/dp-binary.ts'
import { collectGatewayAuthInput } from '../doctor-collectors.ts'
import { buildConfigDoctorReport, type ConfigDoctorInputV1 } from '../config-doctor.ts'

/** The minimum a report needs beside the section under test. */
const BASE: ConfigDoctorInputV1 = { drops: [], winner: 'none', fileCarriesSettings: false }

function fabricatedJwt(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf-8').toString('base64url')
  return `fixture-header.${payload}.fixture-signature`
}

let home: string
let savedNessyHome: string | undefined
let savedNessyDp: string | undefined
let savedEnvToken: string | undefined
let savedCliEnvToken: string | undefined

beforeEach(() => {
  savedNessyHome = process.env[NESSY_HOME_ENV]
  savedNessyDp = process.env[NESSY_DP_ENV]
  savedEnvToken = process.env.NESSY_DP_AUTH_TOKEN
  savedCliEnvToken = process.env.NESSY_CLI_DP_AUTH_TOKEN
  delete process.env.NESSY_DP_AUTH_TOKEN
  delete process.env.NESSY_CLI_DP_AUTH_TOKEN
  home = mkdtempSync(join(tmpdir(), 'nessy-gw-doctor-'))
  delete process.env[NESSY_HOME_ENV]
  process.env[NESSY_HOME_ENV] = home
})

afterEach(() => {
  delete process.env[NESSY_HOME_ENV]
  if (savedNessyHome !== undefined) process.env[NESSY_HOME_ENV] = savedNessyHome
  delete process.env[NESSY_DP_ENV]
  if (savedNessyDp !== undefined) process.env[NESSY_DP_ENV] = savedNessyDp
  delete process.env.NESSY_DP_AUTH_TOKEN
  if (savedEnvToken !== undefined) process.env.NESSY_DP_AUTH_TOKEN = savedEnvToken
  delete process.env.NESSY_CLI_DP_AUTH_TOKEN
  if (savedCliEnvToken !== undefined) process.env.NESSY_CLI_DP_AUTH_TOKEN = savedCliEnvToken
  rmSync(home, { recursive: true, force: true })
})

function writeCreds(body: unknown): void {
  writeFileSync(join(home, 'dp_auth_creds.json'), typeof body === 'string' ? body : JSON.stringify(body), 'utf-8')
}

describe('collectGatewayAuthInput (DA1.34)', () => {
  it('no file at all reads as no_credentials', () => {
    const input = collectGatewayAuthInput()
    expect(input?.credentialsFile).toBe('absent')
    expect(input?.reMintReason).toBe('no_credentials')
    expect(input?.jwtLength).toBeUndefined()
  })

  it('a healthy credential reads as ok, with a LENGTH and never a value', () => {
    const jwt = fabricatedJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
    writeCreds({ jwt, expiresAt: Date.now() + 3_600_000, username: 'u', userId: 'i' })

    const input = collectGatewayAuthInput()
    expect(input?.reMintReason).toBe('ok')
    expect(input?.credentialsFile).toBe('present')
    expect(input?.jwtLength).toBe(jwt.length)
    expect(input?.jwtShaped).toBe(true)
    expect(input?.jwtDecodes).toBe(true)
    expect(input?.expiresInMinutes).toBeGreaterThan(0)
    // The value itself is nowhere in the payload.
    expect(JSON.stringify(input)).not.toContain(jwt)
  })

  it('an expired credential reads as credentials_expired', () => {
    writeCreds({
      jwt: fabricatedJwt({ exp: Math.floor(Date.now() / 1000) - 60 }),
      expiresAt: Date.now() - 60_000,
      username: 'u',
      userId: 'i',
    })
    const input = collectGatewayAuthInput()
    expect(input?.reMintReason).toBe('credentials_expired')
    expect(input?.expiresInMinutes).toBeLessThan(0)
  })

  it('a three-dot value whose claims do not decode reads as unparseable, NOT as expired', () => {
    // The order matters and it is the runtime's own: DA1.26 refuses a value
    // whose payload does not decode BEFORE any expiry is consulted, so naming
    // this one `credentials_expired` would name the second door. The expiry here
    // is in the past precisely so the two arms are distinguishable.
    writeCreds({ jwt: 'aaa.bbb.ccc', expiresAt: Date.now() - 60_000, username: 'u', userId: 'i' })
    const input = collectGatewayAuthInput()
    expect(input?.reMintReason).toBe('credentials_unparseable')
    expect(input?.jwtShaped).toBe(true)
    expect(input?.jwtDecodes).toBe(false)
  })

  it('a record with no numeric expiresAt reads as unreadable, not as ok', () => {
    // Found by reading `loadCreds`, which requires `typeof expiresAt ===
    // 'number'` BEFORE `getValidCreds` compares anything: such a file is no
    // credential at runtime, so reporting `ok` here would tell an operator the
    // credential was fine while every turn took the no-credential path.
    writeCreds({ jwt: fabricatedJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }), username: 'u', userId: 'i' })
    const input = collectGatewayAuthInput()
    expect(input?.credentialsFile).toBe('present')
    expect(input?.reMintReason).toBe('credentials_unreadable')
    expect(input?.expiresInMinutes).toBeUndefined()
  })

  it('a file that is not JSON reads as unreadable', () => {
    writeCreds('{not json')
    const input = collectGatewayAuthInput()
    expect(input?.credentialsFile).toBe('unreadable')
    expect(input?.reMintReason).toBe('credentials_unreadable')
  })

  it('the env bypass is reported as a boolean and makes an absent file ok', () => {
    delete process.env.NESSY_DP_AUTH_TOKEN
    process.env.NESSY_DP_AUTH_TOKEN = 'fabricated-env-token'
    const input = collectGatewayAuthInput()
    expect(input?.envTokenPresent).toBe(true)
    expect(input?.reMintReason).toBe('ok')
    expect(JSON.stringify(input)).not.toContain('fabricated-env-token')
  })
})

describe('the doctor section it prints (DA1.34)', () => {
  it('prints the reason as a CODE and the token as a length', () => {
    const jwt = fabricatedJwt({ exp: Math.floor(Date.now() / 1000) - 60 })
    writeCreds({ jwt, expiresAt: Date.now() - 60_000, username: 'u', userId: 'i' })
    const gatewayAuth = collectGatewayAuthInput()!

    const report = buildConfigDoctorReport({ ...BASE, gatewayAuth })

    expect(report.text).toContain('Nessy Gateway sign-in:')
    expect(report.text).toContain('re-mint reason: credentials_expired')
    expect(report.text).toContain(`token: ${jwt.length} characters`)
    expect(report.text).toContain('stored expiry: passed')
    // The one thing that must never appear.
    expect(report.text).not.toContain(jwt)
    // And it moves NOTHING: a printed reading, not a verdict. This section
    // cannot see whether the profile has a gateway card at all, so a host with
    // none would otherwise move an exit code over a credential it does not want
    // — and the CLI's clean-configuration case would depend on whether whoever
    // runs it happens to be signed in.
    expect(report.hasFindings).toBe(false)
  })

  /* ------------------------------------------------------------------ *
   * DA1.56 — WHICH dp answered
   * ------------------------------------------------------------------ */

  it('reports the rung that answered and the path it resolved (NESSY_DP)', () => {
    // The real ladder, not a stub: rung 1 is an explicit path, so a runnable
    // file under this suite's own temp home is enough to drive it end to end.
    // `beforeEach` already deleted NESSY_DP (the repo-wide preload does too),
    // so the arm cannot be answered by the developer's own environment.
    const fakeDp = join(home, 'fake-dp')
    writeFileSync(fakeDp, '#!/bin/sh\nexit 0\n', 'utf-8')
    chmodSync(fakeDp, 0o755)
    delete process.env[NESSY_DP_ENV]
    process.env[NESSY_DP_ENV] = fakeDp

    const input = collectGatewayAuthInput()
    expect(input?.dpBinary?.source).toBe('override')
    expect(input?.dpBinary?.path).toBe(fakeDp)

    // And it is carried on the NO-FILE return path too — the state an operator
    // is in precisely when they need to know which dp would run.
    expect(input?.credentialsFile).toBe('absent')

    const report = buildConfigDoctorReport({ ...BASE, gatewayAuth: input! })
    expect(report.text).toContain(`dp binary: override — ${fakeDp}`)
    // A path is not a verdict: this section still moves nothing.
    expect(report.hasFindings).toBe(false)
  })

  it('an UNRUNNABLE NESSY_DP falls through to another rung rather than being reported as override', () => {
    // The negative twin of the arm above, and the whole reason the field
    // exists: DA1.6 falls through an unrunnable rung 1 in silence, so before
    // this field a typo in the variable and never having set it looked
    // identical. Whatever answers here, it is NOT `override`.
    const notExecutable = join(home, 'not-executable-dp')
    writeFileSync(notExecutable, 'not a program', 'utf-8')
    chmodSync(notExecutable, 0o644)
    delete process.env[NESSY_DP_ENV]
    process.env[NESSY_DP_ENV] = notExecutable

    const input = collectGatewayAuthInput()
    expect(input?.dpBinary?.source).not.toBe('override')
    expect(input?.dpBinary?.path).not.toBe(notExecutable)
  })

  it('renders the not-found state as a named answer rather than as silence', () => {
    // The renderer is exercised directly for this one: whether any rung is
    // runnable depends on the machine (a developer box has a real `dp` on
    // PATH), so driving the collector here would make the arm read the host
    // instead of the code. The collector arms above cover the live ladder.
    const report = buildConfigDoctorReport({
      ...BASE,
      gatewayAuth: {
        credentialsFile: 'absent',
        reMintReason: 'no_credentials',
        envTokenPresent: false,
        cliEnvTokenOnly: false,
        dpBinary: { source: 'not-found' },
      },
    })
    expect(report.text).toContain('dp binary: NOT FOUND')
    expect(report.text).toContain('nessy-cli copy')
    expect(report.hasFindings).toBe(false)
  })

  it('prints no dp line at all when the caller did not look', () => {
    // The field is optional on purpose — the CLI emits this object whole and a
    // caller that did not resolve the ladder must be able to say so without
    // the report inventing an answer.
    const report = buildConfigDoctorReport({
      ...BASE,
      gatewayAuth: {
        credentialsFile: 'absent',
        reMintReason: 'no_credentials',
        envTokenPresent: false,
        cliEnvTokenOnly: false,
      },
    })
    expect(report.text).toContain('re-mint reason: no_credentials')
    expect(report.text).not.toContain('dp binary:')
  })

  it('a healthy credential prints ok and is not a finding on its own', () => {
    writeCreds({
      jwt: fabricatedJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      expiresAt: Date.now() + 3_600_000,
      username: 'u',
      userId: 'i',
    })
    const report = buildConfigDoctorReport({ ...BASE, gatewayAuth: collectGatewayAuthInput()! })
    expect(report.text).toContain('re-mint reason: ok')
    expect(report.hasFindings).toBe(false)
    // The negative control for the case above: `false` here has to mean "this
    // section never moves the flag", not "this state happens to be clean", so
    // both states assert the same thing and the section's own text is what
    // distinguishes them.
  })
})
