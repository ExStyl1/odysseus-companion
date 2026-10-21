/**
 * SHA-256 with no `node:crypto`, written from the FIPS 180-4 specification
 * (NIST FIPS PUB 180-4, §4.1.2 the six logical functions, §4.2.2 the 64 K
 * constants, §5.1.1 padding, §5.3.3 the initial hash value, §6.2.2 the
 * compression function). Nothing is vendored, so no upstream licence applies.
 *
 * WHY it exists (P6.971, 2026-09-10): Vite's production build resolves EVERY
 * browser-externalized node builtin to one stub module whose whole body is
 * `export default {}` (`vite/dist/node/chunks/dep-*.js`, the `browserExternalId`
 * load handler), so a NAMED import of a builtin — `import { createHash } from
 * 'node:crypto'` — is a HARD rollup error in the renderer bundle, not the
 * warning a default/namespace import gets. `mcp-wire-name.ts` is reached from
 * the renderer through `capabilities/views.ts`, and its digest decides MCP wire
 * names, which are a contract: the controller's decision for P6.971 is that the
 * names do NOT change. So the digest moves to this module and stays
 * byte-identical to `createHash('sha256')`'s, pinned by
 * `__tests__/sha256-isomorphic.test.ts`, which compares the two over a corpus
 * of names incl. unicode and the 55/56/63/64/65/119/120-byte block boundaries.
 *
 * Do NOT replace this with WebCrypto's `crypto.subtle.digest`: that API is
 * async, and every caller of `pluginMcpWireName` is synchronous.
 */

/** FIPS 180-4 §4.2.2 — the first 32 bits of the fractional parts of the cube
 *  roots of the first 64 primes. */
// prettier-ignore
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** FIPS 180-4 §5.3.3 — the first 32 bits of the fractional parts of the square
 *  roots of the first 8 primes. */
// prettier-ignore
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
])

const HEX = '0123456789abcdef'

/** FIPS 180-4 §3.2 — ROTR^n(x) on a 32-bit word. */
function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0
}

/** The digest of arbitrary bytes, as 32 bytes. */
export function sha256Bytes(input: Uint8Array): Uint8Array {
  const h = Uint32Array.from(H0)
  const bitLength = input.length * 8

  // §5.1.1: append 0x80, then zeros, then the 64-bit big-endian message length.
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(input)
  padded[input.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false)
  view.setUint32(paddedLength - 4, bitLength >>> 0, false)

  const w = new Uint32Array(64)
  for (let offset = 0; offset < paddedLength; offset += 64) {
    // §6.2.2 step 1 — the message schedule.
    for (let t = 0; t < 16; t += 1) w[t] = view.getUint32(offset + t * 4, false)
    for (let t = 16; t < 64; t += 1) {
      const x = w[t - 15] as number
      const y = w[t - 2] as number
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0
      w[t] = ((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) >>> 0
    }

    // §6.2.2 step 2 — initialise the eight working variables.
    let a = h[0] as number
    let b = h[1] as number
    let c = h[2] as number
    let d = h[3] as number
    let e = h[4] as number
    let f = h[5] as number
    let g = h[6] as number
    let hh = h[7] as number

    // §6.2.2 step 3 — the 64 rounds.
    for (let t = 0; t < 64; t += 1) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0
      const ch = ((e & f) ^ (~e & g)) >>> 0
      const t1 = (hh + S1 + ch + (K[t] as number) + (w[t] as number)) >>> 0
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0
      const t2 = (S0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }

    // §6.2.2 step 4 — the intermediate hash value.
    h[0] = ((h[0] as number) + a) >>> 0
    h[1] = ((h[1] as number) + b) >>> 0
    h[2] = ((h[2] as number) + c) >>> 0
    h[3] = ((h[3] as number) + d) >>> 0
    h[4] = ((h[4] as number) + e) >>> 0
    h[5] = ((h[5] as number) + f) >>> 0
    h[6] = ((h[6] as number) + g) >>> 0
    h[7] = ((h[7] as number) + hh) >>> 0
  }

  const digest = new Uint8Array(32)
  const out = new DataView(digest.buffer)
  for (let i = 0; i < 8; i += 1) out.setUint32(i * 4, h[i] as number, false)
  return digest
}

/**
 * The lowercase hex digest of a string, UTF-8 encoded — byte-identical to
 * `createHash('sha256').update(value).digest('hex')`, whose `update` also
 * defaults to UTF-8.
 */
export function sha256Hex(value: string): string {
  const digest = sha256Bytes(new TextEncoder().encode(value))
  let hex = ''
  for (let i = 0; i < digest.length; i += 1) {
    const byte = digest[i] as number
    hex += HEX[byte >>> 4]
    hex += HEX[byte & 0x0f]
  }
  return hex
}
