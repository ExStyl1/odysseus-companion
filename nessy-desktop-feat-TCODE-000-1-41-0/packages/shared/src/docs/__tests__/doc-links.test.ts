import { describe, expect, it } from 'bun:test'
import { getDocUrl } from '../doc-links'

describe('getDocUrl', () => {
  it('returns English docs by default', () => {
    expect(getDocUrl('sources')).toBe(
      'https://nessy-desktop-releases-dev.s3-msk.tinkoff.ru/docs/sources/overview.html',
    )
  })

  it('returns Russian docs when the UI language is Russian', () => {
    expect(getDocUrl('sources', 'ru')).toBe(
      'https://nessy-desktop-releases-dev.s3-msk.tinkoff.ru/docs/ru/sources/overview.html',
    )
  })

  it('falls back to English docs for non-Russian languages', () => {
    expect(getDocUrl('sources', 'en')).toBe(
      'https://nessy-desktop-releases-dev.s3-msk.tinkoff.ru/docs/sources/overview.html',
    )
  })
})
