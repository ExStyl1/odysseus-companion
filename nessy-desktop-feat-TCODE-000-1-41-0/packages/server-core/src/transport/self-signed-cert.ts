/**
 * F1 — TLS for the embedded/headless server.
 *
 * Plain `ws` on a shared network puts the pairing token and the whole session
 * transcript in clear text, which is why `nessy-server` refuses a non-loopback
 * bind without TLS. Requiring the user to obtain a certificate first turns that
 * refusal into a dead end, so we generate a self-signed one.
 *
 * A self-signed certificate has no chain to validate, so the trust decision
 * moves to the human: the server prints the certificate's SHA-256 fingerprint,
 * the phone shows the fingerprint it actually received at first pairing, and
 * the user confirms they match. That is the same model as SSH's host-key
 * prompt — weaker than a real PKI, far stronger than cleartext, and honest
 * about which link in the chain is the human.
 *
 * Owner decision 2026-08-09: self-signed with fingerprint confirmation is the
 * default; a provisioned certificate is used instead when one is supplied.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { networkInterfaces } from 'node:os'

export interface SelfSignedCertificate {
  cert: Buffer
  key: Buffer
  /** Uppercase, colon-separated SHA-256 of the DER certificate. */
  fingerprint: string
  /** Where the pair lives, so the user can replace or delete it. */
  certPath: string
  keyPath: string
}

/** Every address a phone on the LAN might dial, so the SAN covers it. */
export function localSubjectAltNames(): string[] {
  const names = new Set<string>(['DNS:localhost', 'IP:127.0.0.1'])
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      names.add(`IP:${address.address}`)
    }
  }
  return [...names]
}

/**
 * The address a phone can actually dial. A bind host of `0.0.0.0` (or `::`)
 * means "every interface" and is not routable from another device, so a pairing
 * link built from it is guaranteed not to work — measured: the first printed
 * link said `wss://0.0.0.0:9101`.
 */
export function advertisedHost(bindHost: string): string {
  if (bindHost !== '0.0.0.0' && bindHost !== '::' && bindHost !== '') return bindHost
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address
    }
  }
  return '127.0.0.1'
}

/** SHA-256 over the DER bytes — the same value `openssl x509 -fingerprint` prints. */
export function certificateFingerprint(certPem: Buffer | string): string {
  const pem = certPem.toString()
  const body = pem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '')
  const der = Buffer.from(body, 'base64')
  const digest = createHash('sha256').update(der).digest('hex').toUpperCase()
  return digest.match(/.{2}/g)!.join(':')
}

/**
 * Returns the server's self-signed certificate, generating it on first use.
 *
 * Regenerates when the machine's addresses have changed, otherwise a laptop
 * that moved networks would serve a certificate whose SAN no longer covers the
 * address the phone dials — a TLS failure that looks like the server being
 * down.
 */
export function ensureSelfSignedCertificate(configDir: string): SelfSignedCertificate {
  const dir = join(configDir, 'tls')
  const certPath = join(dir, 'server-cert.pem')
  const keyPath = join(dir, 'server-key.pem')
  const sanPath = join(dir, 'server-san.txt')
  const san = localSubjectAltNames().join(',')

  const usable =
    existsSync(certPath) &&
    existsSync(keyPath) &&
    existsSync(sanPath) &&
    readFileSync(sanPath, 'utf8').trim() === san &&
    notExpiringSoon(certPath)

  if (!usable) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-sha256',
        '-days', '825', // the maximum Apple platforms accept for a leaf
        '-nodes',
        '-keyout', keyPath,
        '-out', certPath,
        '-subj', '/CN=Nessy Desktop',
        '-addext', `subjectAltName=${san}`,
      ],
      { stdio: 'pipe' },
    )
    writeFileSync(sanPath, `${san}\n`, { mode: 0o600 })
    // The private key must not be world-readable even for a moment longer.
    writeFileSync(keyPath, readFileSync(keyPath), { mode: 0o600 })
  }

  const cert = readFileSync(certPath)
  return {
    cert,
    key: readFileSync(keyPath),
    fingerprint: certificateFingerprint(cert),
    certPath,
    keyPath,
  }
}

/** True while the certificate has more than 30 days left. */
function notExpiringSoon(certPath: string): boolean {
  try {
    execFileSync('openssl', ['x509', '-checkend', String(30 * 24 * 60 * 60), '-noout', '-in', certPath], {
      stdio: 'pipe',
    })
    return true
  } catch {
    return false
  }
}
