import { describe, expect, it } from 'bun:test'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'
import { CHECKPOINT_SKIP_REASON_KEYS, distinctSkipReasonKeys } from '../checkpoint-skip'

describe('checkpoint skip reasons reach the user', () => {
  it('has a translated explanation in every locale for every reason', () => {
    const keys = Object.values(CHECKPOINT_SKIP_REASON_KEYS)
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      // A missing key renders the raw key in the toast, which is exactly the
      // silent skip this unit exists to prevent.
      expect((en as Record<string, string>)[key]).toBeTruthy()
      expect((ru as Record<string, string>)[key]).toBeTruthy()
    }
  })

  it('collapses repeated reasons but keeps distinct ones, in first-seen order', () => {
    expect(distinctSkipReasonKeys([
      { filePath: '/a', reason: 'hard-link' },
      { filePath: '/b', reason: 'hard-link' },
      { filePath: '/c', reason: 'symlink' },
    ])).toEqual([
      CHECKPOINT_SKIP_REASON_KEYS['hard-link'],
      CHECKPOINT_SKIP_REASON_KEYS.symlink,
    ])
    expect(distinctSkipReasonKeys(undefined)).toEqual([])
  })
})
