/**
 * F5 — the pairing payload behind the QR code.
 *
 * Typing a URL and a 32-character token by hand is the most error-prone step
 * the mobile app has; the whole M0–M5 pass lost time to it more than once. A QR
 * carries all of it at once.
 *
 * It also carries the certificate fingerprint, which removes the manual
 * comparison F1 introduced: a QR displayed on the machine running the server IS
 * a trusted side channel, so a fingerprint read from it is already confirmed by
 * the act of scanning the screen in front of you. That is strictly better than
 * asking a human to compare 64 hex characters, which is a check people skip.
 */
export interface PairingPayload {
  /** Full websocket URL including scheme — `wss://host:port`. */
  url: string
  /** The server's bearer token. */
  token: string
  /**
   * SHA-256 fingerprint of the server's certificate, when it is self-signed.
   * Absent for plain `ws` or a certificate the device already trusts.
   */
  fingerprint?: string
}

export const PAIRING_URL_SCHEME = 'nessy'

/** Builds the string encoded into the QR (and printable as a link). */
export function buildPairingURL(payload: PairingPayload): string {
  const params = new URLSearchParams({ url: payload.url, token: payload.token })
  if (payload.fingerprint) params.set('fp', payload.fingerprint)
  return `${PAIRING_URL_SCHEME}://pair?${params.toString()}`
}

/**
 * Parses a scanned string. Returns `null` rather than throwing for anything
 * that is not one of ours — a camera sees a lot of QR codes, and a wrong one
 * must read as "not a pairing code", never as a crash or a half-filled form.
 */
export function parsePairingURL(raw: string): PairingPayload | null {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== `${PAIRING_URL_SCHEME}:`) return null
  if (parsed.hostname !== 'pair') return null

  const url = parsed.searchParams.get('url')?.trim()
  const token = parsed.searchParams.get('token')?.trim()
  if (!url || !token) return null

  // Only websocket schemes; a pairing code that points at https is not ours,
  // and following it would be a redirect we never intended to honour.
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return null
  }
  if (target.protocol !== 'ws:' && target.protocol !== 'wss:') return null

  const fingerprint = parsed.searchParams.get('fp')?.trim()
  return { url, token, ...(fingerprint ? { fingerprint } : {}) }
}
