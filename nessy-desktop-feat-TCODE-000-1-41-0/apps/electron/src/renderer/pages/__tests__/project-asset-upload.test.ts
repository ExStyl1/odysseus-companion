/**
 * UA5.8 — the project page's Assets tab encodes an upload in chunks (UA-au's hand-back, wave 6).
 *
 * Upstream v0.13.4 `ProjectInfoPage.tsx` encodes with `btoa(String.fromCharCode(...new Uint8Array(buf)))`: one call
 * with one argument per byte, which throws `RangeError` once a file passes the engine's argument limit (a few
 * hundred KB). POSITIVE: a 3 MB file encodes and decodes back byte for byte. CONTROL: upstream's one-shot spread
 * throws on the same bytes, so the positive arm measures the defect, not a size nothing breaks on. BOUNDARY: an
 * empty file and a size one past a chunk edge.
 */
import { describe, expect, it } from 'bun:test'
import { PROJECT_ASSET_MAX_BYTES, ProjectStorageError } from '@nessy-agent/shared/projects'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'
import { PROJECT_ASSET_LIMIT_BYTES, bytesToBase64, uploadFailureToast } from '../project-asset-upload'

function bytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = (i * 31 + 7) & 0xff
  return out
}

describe('UA5.8 — bytesToBase64', () => {
  it('POSITIVE: a 3 MB file encodes, and decodes back byte for byte', () => {
    const input = bytes(3 * 1024 * 1024)
    const encoded = bytesToBase64(input)
    expect(Buffer.from(encoded, 'base64').equals(Buffer.from(input))).toBe(true)
  })

  it('CONTROL: upstream\'s one-shot spread throws on the same bytes', () => {
    const input = bytes(3 * 1024 * 1024)
    expect(() => btoa(String.fromCharCode(...input))).toThrow(RangeError)
  })

  it('BOUNDARY: an empty file, and one byte past a chunk edge, match Buffer\'s encoding', () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe('')
    const edge = bytes(0x8000 + 1)
    expect(bytesToBase64(edge)).toBe(Buffer.from(edge).toString('base64'))
  })
})

// UA12.113 follow-up (2026-10-08 verification): the 16 MiB cap was stated only in code — an over-cap
// upload answered the generic "Failed to upload file". The refusal's code arrives in the MESSAGE (copied
// verbatim at every RPC hop; `ProjectTrustDialog.tsx` reads its code the same way).
describe('UA12.113 — uploadFailureToast', () => {
  it('POSITIVE: the cap refusal, as the rebuilt RPC error carries it, names the limit', () => {
    const wire = new Error(new ProjectStorageError('project-asset-too-large', '17000000 decoded bytes').message)
    expect(uploadFailureToast(wire)).toEqual({ key: 'projectInfo.assetTooLarge', params: { limitMiB: 16 } })
  })

  it('NEGATIVE: every other failure keeps the generic toast (upstream\'s catch)', () => {
    expect(uploadFailureToast(new Error('project-not-found: dash'))).toEqual({ key: 'projectInfo.uploadFailed' })
    expect(uploadFailureToast('boom')).toEqual({ key: 'projectInfo.uploadFailed' })
    expect(uploadFailureToast(undefined)).toEqual({ key: 'projectInfo.uploadFailed' })
  })

  // Follow-up 2: the unit is the LOCALE's text (ru writes МиБ), never a string built in code — the
  // precedent is `capability.instruction.overSizeLimit`'s bare `{{limitMiB}}`.
  it('LOCALE: each locale renders the limit with its own unit; ru carries no Latin "MiB"', () => {
    const failure = uploadFailureToast(new Error('project-asset-too-large: 17000000 decoded bytes'))
    if (failure.key !== 'projectInfo.assetTooLarge') throw new Error('expected the cap toast')
    const render = (template: string) =>
      template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(({ name: 'big.bin', ...failure.params } as Record<string, unknown>)[k]))
    expect(render(en[failure.key])).toBe('big.bin is larger than 16 MiB and was not uploaded')
    expect(render(ru[failure.key])).toBe('Файл big.bin больше 16 МиБ и не загружен')
    expect(render(ru[failure.key])).not.toContain('MiB')
  })

  it('PIN: the renderer\'s copy of the limit is the server\'s cap', () => {
    expect(PROJECT_ASSET_LIMIT_BYTES).toBe(PROJECT_ASSET_MAX_BYTES)
  })
})
