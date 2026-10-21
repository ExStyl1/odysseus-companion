import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { sha256Bytes, sha256Hex } from '../sha256-isomorphic.ts'

/**
 * P6.971 — the pure-JS digest exists ONLY so the renderer bundle stops pulling
 * `node:crypto`, and it is worth nothing unless it is byte-identical to the one
 * `mcp-wire-name.ts` used before: a wire name is a contract every projection,
 * resolver and translation site recomputes independently, so a single differing
 * byte silently unbinds every plugin-bundled MCP tool. This file is that pin.
 */

/** A deterministic, reproducible corpus. Every entry is a plausible plugin or
 *  server name, or a length that sits on a SHA-256 block boundary. */
function buildCorpus(): string[] {
  const names: string[] = []

  // The three degenerate inputs.
  names.push('', 'a', ' ')

  // Byte-length boundaries around the 64-byte block and the 55/56 split where
  // the length field stops fitting in the final block — plus the second block's
  // 119/120 twin, which is where a wrong padded-length formula first shows.
  for (const n of [
    1, 2, 31, 32, 33, 54, 55, 56, 57, 63, 64, 65, 111, 112, 118, 119, 120, 121, 127, 128, 129, 255, 256,
  ]) {
    names.push('x'.repeat(n))
  }

  // Unicode: two-, three- and four-byte code points, combining marks, an astral
  // pair and RTL — all of which `TextEncoder` must encode exactly as node's
  // UTF-8 `update()` does.
  names.push('плагин', 'サーバー', '🙂', '🙂🙂🙂', 'école', 'école', 'مرحبا', 'ﬁ-ligature', '\u{1F600}\u{10FFFF}')
  // The same unicode at block boundaries, where a byte/char confusion in the
  // padding lands on a different block count than the ASCII cases do.
  for (const n of [16, 21, 22, 32]) names.push('é'.repeat(n))
  for (const n of [15, 16, 17, 30]) names.push('🙂'.repeat(n))

  // Real mint shapes: what `pluginMcpWireName` and `capMcpNameSegment` actually
  // hash — `plugin_<id>_<server>` strings, sanitized and unsanitized.
  const ids = ['acme', 'acme-tools', 'my.plugin', 'Очень-Длинный-Плагин', 'a', 'x'.repeat(48)]
  const servers = ['fs', 'github', 'my server.v2', 'server_with_a_very_long_name_indeed', 'Ω']
  for (const id of ids) {
    for (const server of servers) {
      names.push(`plugin_${id}_${server}`)
      names.push(`${id}/${server}`)
    }
  }

  // Fill to well past 200 with a deterministic generated tail that varies every
  // byte class: digits, separators, case, and length modulo 64.
  for (let i = 0; names.length < 260; i += 1) {
    names.push(`srv-${i}-${'aB'.repeat(i % 40)}_${i % 7}${i % 3 === 0 ? 'Ω' : ''}`)
  }

  return names
}

const CORPUS = buildCorpus()

describe('sha256-isomorphic', () => {
  test('the corpus covers the shapes this pin exists for', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(200)
    const byteLengths = new Set(CORPUS.map((name) => Buffer.byteLength(name, 'utf8')))
    // empty, one byte, and both sides of the two block boundaries.
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120]) expect(byteLengths.has(n)).toBe(true)
    // at least one multi-byte code point, or the unicode arm proves nothing.
    expect(CORPUS.some((name) => Buffer.byteLength(name, 'utf8') > name.length)).toBe(true)
  })

  test('every corpus name digests byte-for-byte as node:crypto does', () => {
    const mismatches: string[] = []
    for (const name of CORPUS) {
      const expected = createHash('sha256').update(name).digest('hex')
      const actual = sha256Hex(name)
      if (actual !== expected) mismatches.push(`${JSON.stringify(name)}: ${actual} !== ${expected}`)
    }
    expect(mismatches).toEqual([])
  })

  test('the raw byte digest matches too, so a hex-formatting bug cannot hide one', () => {
    for (const name of ['', 'abc', 'плагин', 'x'.repeat(64)]) {
      const expected = Array.from(new Uint8Array(createHash('sha256').update(name).digest()))
      const actual = sha256Bytes(new TextEncoder().encode(name))
      expect(actual.length).toBe(32)
      expect(Array.from(actual)).toEqual(expected)
    }
  })

  test('the negative: a one-character change moves the digest, and the FIPS vectors hold', () => {
    expect(sha256Hex('plugin_acme_fs')).not.toBe(sha256Hex('plugin_acme_gs'))
    // A wrong initial hash value or a wrong K entry would still be
    // self-consistent above; only a published vector catches that.
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  test('the module imports no node builtin — the whole reason it exists', async () => {
    const source = await Bun.file(new URL('../sha256-isomorphic.ts', import.meta.url)).text()
    // Comments are stripped first: this file's own header NAMES `node:crypto`,
    // and a guard over the raw text would fire on the sentence explaining why.
    const codeOnly = source
      .split('\n')
      .filter((line) => {
        const trimmed = line.trimStart()
        return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*')
      })
      .join('\n')
    expect(codeOnly).not.toMatch(/from\s+'(node:)?(crypto|fs|path|os|buffer|util)'/)
    expect(codeOnly).toContain('export function sha256Hex')
  })
})
