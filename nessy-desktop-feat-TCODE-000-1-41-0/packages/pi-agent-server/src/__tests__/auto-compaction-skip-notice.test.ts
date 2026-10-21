import { describe, expect, it } from 'bun:test'

import { isSilentAutoCompactionSkip, describeAutoCompactionSkip } from '../auto-compaction-skip-notice.ts'

describe('auto-compaction skip notice (P6.489)', () => {
  it('fires on an auto compaction that found no queued instructions', () => {
    expect(isSilentAutoCompactionSkip('auto', undefined)).toBe(true)
    expect(isSilentAutoCompactionSkip('auto', '')).toBe(true)
  })

  it('CONTROL — a turn with instructions queued emits nothing', () => {
    expect(isSilentAutoCompactionSkip('auto', 'carry the open questions forward')).toBe(false)
  })

  it('CONTROL — a manual compaction is not this case', () => {
    // Excluded deliberately: a manual compaction carries the user's own
    // instructions or none by choice, and reporting it would fire the notice on
    // the ordinary path.
    expect(isSilentAutoCompactionSkip('manual', undefined)).toBe(false)
    expect(isSilentAutoCompactionSkip('manual', 'summarize tightly')).toBe(false)
  })

  it('names what did not happen, why it can happen, and that nothing changed', () => {
    const line = describeAutoCompactionSkip('auto')
    expect(line).toContain('reason=auto')
    expect(line).toContain('## Compact Instructions')
    expect(line).toContain('message_start')
    expect(line).toContain('Behaviour is unchanged')
  })
})
