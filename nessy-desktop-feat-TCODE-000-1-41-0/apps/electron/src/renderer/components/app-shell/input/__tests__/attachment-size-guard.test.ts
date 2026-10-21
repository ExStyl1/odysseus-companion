/**
 * UB4.14 — the composer refuses attachments the connected server cannot take, with a toast naming
 * the problem, BEFORE it reads a file and BEFORE it sends (v0.15.1 "Clear message for attachments
 * that are too large").
 *
 * Two instruments, as in `staged-image-send-guard.test.ts`: the decision and the toast copy are
 * driven through `attachment-size-guard.ts` (real code, real locale strings), and the composer's
 * wiring is pinned at source level, because `bun test` has no DOM and importing the composer pulls
 * a UI barrel bun cannot resolve. A refusal that never reaches the reader and the send is what
 * keeps the socket open: the over-limit message is never built.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import {
  BUN_WS_MAX_MESSAGE_BYTES,
  DEFAULT_MAX_MESSAGE_BYTES,
  NODE_WS_MAX_MESSAGE_BYTES,
  checkAttachmentSizes,
  maxAttachmentBytes,
} from '@nessy-agent/shared/protocol/message-limits'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'
import {
  attachmentSizeInputOf,
  attachmentSizeToast,
  maxMessageBytesOf,
  oversizedAttachment,
} from '../attachment-size-guard'

/** A tiny `t` over a real locale table, interpolating `{{name}}` the way i18next does. */
function translator(table: Record<string, string>) {
  return (key: string, options?: Record<string, string>): string => {
    const template = table[key]
    if (template === undefined) throw new Error(`missing key ${key}`)
    return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => options?.[name] ?? `{{${name}}}`)
  }
}
const tEn = translator(en as Record<string, string>)
const tRu = translator(ru as Record<string, string>)

const file = (name: string, size: number, type = 'application/pdf') => ({ name, size, type })

describe('UB4.14 — the size decision the composer applies before reading a file', () => {
  it('refuses a file just over the Electron limit and a 12 MB file on a Bun server, naming it', () => {
    // 70 MiB (73 400 320 bytes) is exactly 70 % of Electron's 100 MiB: one byte more never fits.
    const electronLimit = maxAttachmentBytes(NODE_WS_MAX_MESSAGE_BYTES)
    expect(electronLimit).toBe(70 * 1024 * 1024)
    const desktop = oversizedAttachment(attachmentSizeInputOf(file('lecture.pdf', electronLimit + 1)), NODE_WS_MAX_MESSAGE_BYTES)
    expect(desktop).toEqual({ kind: 'file', name: 'lecture.pdf', size: electronLimit + 1, limit: electronLimit })
    expect(attachmentSizeToast(desktop!, tEn)).toEqual({
      title: '“lecture.pdf” is too large to send',
      description: 'It is 73.4 MB. Files can be up to 73.4 MB here.',
    })

    const headless = oversizedAttachment(attachmentSizeInputOf(file('scan.pdf', 12_000_000)), BUN_WS_MAX_MESSAGE_BYTES)
    expect(headless).toMatchObject({ kind: 'file', name: 'scan.pdf' })
    expect(attachmentSizeToast(headless!, tRu)).toEqual({
      title: 'Файл «scan.pdf» слишком большой для отправки',
      description: 'Его размер — 12.0 MB. Здесь можно отправить файл размером до 11.7 MB.',
    })
  })

  it('accepts a file exactly at the limit (control), and the pasted name wins over the File name', () => {
    for (const maxMessageBytes of [NODE_WS_MAX_MESSAGE_BYTES, BUN_WS_MAX_MESSAGE_BYTES]) {
      const atLimit = attachmentSizeInputOf(file('edge.pdf', maxAttachmentBytes(maxMessageBytes)))
      expect(oversizedAttachment(atLimit, maxMessageBytes)).toBeNull()
    }
    const pasted = attachmentSizeInputOf(file('image.png', 20_000_000, 'image/png'), 'pasted-image-3.png')
    expect(pasted).toEqual({ name: 'pasted-image-3.png', size: 20_000_000, type: 'image' })
    expect(oversizedAttachment(pasted, BUN_WS_MAX_MESSAGE_BYTES)).toMatchObject({ name: 'pasted-image-3.png' })
  })

  it('assumes the Bun limit for a server that advertises none, and uses an advertised one as given', () => {
    expect(maxMessageBytesOf(undefined)).toBe(DEFAULT_MAX_MESSAGE_BYTES)
    expect(maxMessageBytesOf(undefined)).toBe(BUN_WS_MAX_MESSAGE_BYTES)
    expect(maxMessageBytesOf(NODE_WS_MAX_MESSAGE_BYTES)).toBe(NODE_WS_MAX_MESSAGE_BYTES)
    // So a 12 MB file is refused by an older server's composer and taken by the desktop's.
    const scan = attachmentSizeInputOf(file('scan.pdf', 12_000_000))
    expect(oversizedAttachment(scan, maxMessageBytesOf(undefined))).not.toBeNull()
    expect(oversizedAttachment(scan, maxMessageBytesOf(NODE_WS_MAX_MESSAGE_BYTES))).toBeNull()
  })

  it('counts images at most 5 MB toward the total, so the send check names the total, not a file', () => {
    const photos = ['a', 'b', 'c'].map(n => attachmentSizeInputOf(file(`${n}.jpg`, 8_000_000, 'image/jpeg')))
    expect(checkAttachmentSizes(photos.slice(0, 2), BUN_WS_MAX_MESSAGE_BYTES)).toBeNull()
    const total = checkAttachmentSizes(photos, BUN_WS_MAX_MESSAGE_BYTES)
    expect(total).toMatchObject({ kind: 'total', size: 15 * 1024 * 1024 })
    expect(attachmentSizeToast(total!, tEn).title).toBe('Attachments are too large to send together')
    expect(attachmentSizeToast(total!, tRu).description).toContain('11.7 MB')
  })
})

// ---------------------------------------------------------------------------
// The composer wiring, at source level
// ---------------------------------------------------------------------------

const source = readFileSync(fileURLToPath(new URL('../FreeFormInput.tsx', import.meta.url)), 'utf8')

/** The text of a `const <name> = ...` definition, up to the next blank-line-separated sibling. */
function definition(name: string): string {
  const start = source.indexOf(`const ${name} = `)
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf('\n\n', start)
  return source.slice(start, end === -1 ? undefined : end)
}

/** Index of `needle` inside `text`, which must occur. */
function at(text: string, needle: string): number {
  const index = text.indexOf(needle)
  expect(index).toBeGreaterThan(-1)
  return index
}

describe('UB4.14 — the composer refuses before it reads and before it sends', () => {
  it('reads the limit from the transport connection state, falling back to the Bun limit', () => {
    expect(source).toContain('const transportState = useTransportConnectionState()')
    expect(source).toContain('React.useRef(DEFAULT_MAX_MESSAGE_BYTES)')
    expect(source).toContain('maxMessageBytesRef.current = maxMessageBytesOf(transportState?.maxMessageBytes)')
  })

  it('the shared file reader (picker, paste, drop) refuses before readFileAsAttachment and releases the spinner', () => {
    const body = definition('processFileAttachment')
    const refuse = at(body, 'if (refuseOversizedAttachment(attachmentSizeInputOf(file, overrideName))) {')
    expect(refuse).toBeLessThan(at(body, 'await readFileAsAttachment('))
    expect(body.slice(refuse, at(body, 'try {'))).toContain('setLoadingCount(prev => prev - 1)')
  })

  it('the global paste-files listener refuses each oversized file before reading it', () => {
    const start = at(source, "// Listen for nessy:paste-files events")
    const body = source.slice(start, source.indexOf("window.addEventListener('nessy:paste-files'", start))
    expect(at(body, 'if (refuseOversizedAttachment(attachmentSizeInputOf(files[i], fileNames[i]))) {'))
      .toBeLessThan(at(body, 'await readFileAsAttachment('))
    expect(source.slice(start, start + 2_500)).toContain('}, [disabled, sessionId, isFocusedPanel, richInputRef, refuseOversizedAttachment])')
  })

  it('a long-text paste is refused before it is staged', () => {
    const body = definition('handleLongTextPaste')
    expect(at(body, 'if (refuseOversizedAttachment(attachment)) return'))
      .toBeLessThan(at(body, 'setAttachments(prev => [...prev, attachment])'))
  })

  it('the send refuses a set that is too big together BEFORE onSubmit and before the draft is cleared', () => {
    const start = at(source, 'const submitMessage = React.useCallback(')
    const body = source.slice(start, source.indexOf('\n  }, [', start))
    const check = at(body, 'const sizeProblem = checkAttachmentSizes(attachments, maxMessageBytesRef.current)')
    const refusal = body.slice(check, check + 200)
    expect(refusal).toContain('showAttachmentSizeProblem(sizeProblem)')
    expect(refusal).toContain('return false')
    // The one send that carries the attachments, and the draft clear that follows it, come after.
    const send = body.lastIndexOf('onSubmit(\n      trimmedInput,')
    expect(send).toBeGreaterThan(check)
    expect(body.lastIndexOf('clearSubmittedDraft()')).toBeGreaterThan(send)
  })

  it('the toast is an error toast with the guard copy', () => {
    const body = definition('showAttachmentSizeProblem')
    expect(body).toContain('attachmentSizeToast(problem, t)')
    expect(body).toContain('toast.error(title, { description })')
  })
})
