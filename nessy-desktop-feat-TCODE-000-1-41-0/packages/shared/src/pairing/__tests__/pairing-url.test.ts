import { describe, expect, test } from 'bun:test'
import { buildPairingURL, parsePairingURL } from '../pairing-url.ts'

describe('pairing URL (F5)', () => {
  test('round-trips url, token and fingerprint', () => {
    const payload = {
      url: 'wss://10.60.3.95:9101',
      token: 'abcdefghijklmnopqrstuvwxyz012345',
      fingerprint: '8B:50:60:88:03:87:C0:5A',
    }

    expect(parsePairingURL(buildPairingURL(payload))).toEqual(payload)
  })

  test('a fingerprint is optional — plain ws has no certificate to pin', () => {
    const payload = { url: 'ws://10.60.3.95:9101', token: 'tokentokentokentoken' }

    expect(parsePairingURL(buildPairingURL(payload))).toEqual(payload)
  })

  test('a token containing URL metacharacters survives the round trip', () => {
    // Tokens are generated, but a user-supplied one may contain anything.
    const payload = { url: 'wss://h:1', token: 'a&b=c d/+%?#' }

    expect(parsePairingURL(buildPairingURL(payload))?.token).toBe(payload.token)
  })

  test.each([
    ['not a url at all', 'hello world'],
    ['someone else’s QR', 'https://example.com/?url=x&token=y'],
    ['our scheme, wrong action', 'nessy://connect?url=wss://h:1&token=t'],
    ['missing token', 'nessy://pair?url=wss%3A%2F%2Fh%3A1'],
    ['missing url', 'nessy://pair?token=t'],
    ['non-websocket target', 'nessy://pair?url=https%3A%2F%2Fh&token=t'],
    ['empty', ''],
  ])('returns null for %s rather than throwing or half-filling the form', (_name, raw) => {
    // A camera sees a lot of QR codes. A wrong one must read as "not a pairing
    // code", never as a crash and never as a partially-applied connection.
    expect(parsePairingURL(raw)).toBeNull()
  })
})
