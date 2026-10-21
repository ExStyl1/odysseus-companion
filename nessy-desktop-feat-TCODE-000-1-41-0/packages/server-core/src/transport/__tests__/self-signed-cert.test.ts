import { describe, expect, test } from 'bun:test'
import { mkdtempSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { certificateFingerprint, ensureSelfSignedCertificate, localSubjectAltNames } from '../self-signed-cert.ts'

describe('self-signed certificate for the network bind (F1)', () => {
  test('generates a usable pair and reports the fingerprint openssl reports', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nessy-tls-'))
    const generated = ensureSelfSignedCertificate(dir)

    expect(generated.cert.toString()).toContain('BEGIN CERTIFICATE')
    expect(generated.key.toString()).toContain('PRIVATE KEY')
    // Uppercase hex pairs joined by colons — the shape the phone shows.
    expect(generated.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    expect(certificateFingerprint(generated.cert)).toBe(generated.fingerprint)
  })

  test('the private key is not readable by group or others', () => {
    // A key that leaks makes the whole exercise decorative.
    const dir = mkdtempSync(join(tmpdir(), 'nessy-tls-'))
    const generated = ensureSelfSignedCertificate(dir)

    expect(statSync(generated.keyPath).mode & 0o077).toBe(0)
  })

  test('reuses the pair on a second call rather than churning the fingerprint', () => {
    // Regenerating every start would invalidate the phone's pin on every
    // restart and train the user to accept a changed certificate.
    const dir = mkdtempSync(join(tmpdir(), 'nessy-tls-'))
    const first = ensureSelfSignedCertificate(dir)
    const second = ensureSelfSignedCertificate(dir)

    expect(second.fingerprint).toBe(first.fingerprint)
  })

  test('regenerates when the machine addresses change, so the SAN still covers the dialled address', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nessy-tls-'))
    const first = ensureSelfSignedCertificate(dir)
    // Simulate "the laptop moved networks": the recorded SAN no longer matches.
    Bun.write(join(dir, 'tls', 'server-san.txt'), 'DNS:localhost,IP:10.0.0.1\n')
    const second = ensureSelfSignedCertificate(dir)

    expect(second.fingerprint).not.toBe(first.fingerprint)
  })

  test('the SAN covers loopback and every non-internal IPv4 address', () => {
    const names = localSubjectAltNames()

    expect(names).toContain('DNS:localhost')
    expect(names).toContain('IP:127.0.0.1')
    expect(names.every(n => n.startsWith('DNS:') || n.startsWith('IP:'))).toBe(true)
  })
})

describe('advertised host for the pairing link (F5)', () => {
  test('a wildcard bind is replaced by a routable address', async () => {
    const { advertisedHost } = await import('../self-signed-cert.ts')
    // `0.0.0.0` means "every interface" and is not dialable from a phone. The
    // first printed pairing link said exactly that and could not have worked.
    expect(advertisedHost('0.0.0.0')).not.toBe('0.0.0.0')
    expect(advertisedHost('::')).not.toBe('::')
  })

  test('an explicit host is left alone', async () => {
    const { advertisedHost } = await import('../self-signed-cert.ts')
    expect(advertisedHost('10.60.3.95')).toBe('10.60.3.95')
    expect(advertisedHost('127.0.0.1')).toBe('127.0.0.1')
  })
})
