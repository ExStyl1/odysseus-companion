import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

setDefaultTimeout(60_000)

// drafts.json is a single global file keyed by the composite {workspaceId, sessionId}
// (encodeSessionKey → `${workspaceId}:${sessionId}`). Two workspaces are used
// throughout to prove same-sessionId drafts never collide across workspaces.
const WS_A = 'ws-aaaaaaaa-1111-2222-3333-444444444444'
const WS_B = 'ws-bbbbbbbb-5555-6666-7777-888888888888'

function makeConfigDir(): string {
  return mkdtempSync(join(tmpdir(), 'nessy-general-agent-drafts-'))
}

function runEval(configDir: string, code: string): string {
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import { getSessionDraft, setSessionDraft, deleteSessionDraft, getAllSessionDrafts } from '${STORAGE_MODULE_PATH}'; ${code}`,
  ], {
    env: { ...process.env, NESSY_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (run.exitCode !== 0) {
    throw new Error(`subprocess failed (exit ${run.exitCode})\nstderr:\n${run.stderr.toString()}`)
  }

  return run.stdout.toString().trim()
}

const A = (sid: string) => `{ workspaceId: '${WS_A}', sessionId: '${sid}' }`
const B = (sid: string) => `{ workspaceId: '${WS_B}', sessionId: '${sid}' }`

describe('session draft storage', () => {
  it('returns null for an unknown session', () => {
    const configDir = makeConfigDir()
    const output = runEval(configDir, `console.log(JSON.stringify(getSessionDraft(${A('missing')})))`)
    expect(output).toBe('null')
  })

  it('round-trips a text-only draft', () => {
    const configDir = makeConfigDir()
    runEval(configDir, `setSessionDraft(${A('s1')}, { text: 'hello world' })`)
    const output = runEval(configDir, `console.log(JSON.stringify(getSessionDraft(${A('s1')})))`)
    expect(JSON.parse(output)).toEqual({ text: 'hello world' })
  })

  it('round-trips a draft with attachment refs', () => {
    const configDir = makeConfigDir()
    runEval(configDir,
      `setSessionDraft(${A('s1')}, { text: 'caption', attachments: [{ path: '/tmp/a.png', name: 'a.png' }, { path: '/tmp/b.pdf', name: 'Report.pdf' }] })`
    )
    const output = runEval(configDir, `console.log(JSON.stringify(getSessionDraft(${A('s1')})))`)
    expect(JSON.parse(output)).toEqual({
      text: 'caption',
      attachments: [
        { path: '/tmp/a.png', name: 'a.png' },
        { path: '/tmp/b.pdf', name: 'Report.pdf' },
      ],
    })
  })

  it('round-trips an attachments-only draft (empty text)', () => {
    const configDir = makeConfigDir()
    runEval(configDir, `setSessionDraft(${A('s1')}, { text: '', attachments: [{ path: '/tmp/a.png', name: 'a.png' }] })`)
    const output = runEval(configDir, `console.log(JSON.stringify(getSessionDraft(${A('s1')})))`)
    expect(JSON.parse(output)).toEqual({
      text: '',
      attachments: [{ path: '/tmp/a.png', name: 'a.png' }],
    })
  })

  it('removes the entry when draft is fully empty', () => {
    const configDir = makeConfigDir()
    runEval(configDir, `setSessionDraft(${A('s1')}, { text: 'typed' })`)
    runEval(configDir, `setSessionDraft(${A('s1')}, { text: '' })`)
    const output = runEval(configDir, `console.log(JSON.stringify(getSessionDraft(${A('s1')})))`)
    expect(output).toBe('null')
  })

  it('isolates same-sessionId drafts across two workspaces', () => {
    const configDir = makeConfigDir()
    runEval(configDir, `setSessionDraft(${A('dup')}, { text: 'from A' })`)
    runEval(configDir, `setSessionDraft(${B('dup')}, { text: 'from B' })`)
    // Each workspace's draft is retrieved independently by composite key.
    expect(JSON.parse(runEval(configDir, `console.log(JSON.stringify(getSessionDraft(${A('dup')})))`))).toEqual({ text: 'from A' })
    expect(JSON.parse(runEval(configDir, `console.log(JSON.stringify(getSessionDraft(${B('dup')})))`))).toEqual({ text: 'from B' })
    // getAllSessionDrafts is workspace-scoped and keyed by bare sessionId.
    expect(JSON.parse(runEval(configDir, `console.log(JSON.stringify(getAllSessionDrafts('${WS_A}')))`))).toEqual({ dup: { text: 'from A' } })
    expect(JSON.parse(runEval(configDir, `console.log(JSON.stringify(getAllSessionDrafts('${WS_B}')))`))).toEqual({ dup: { text: 'from B' } })
  })

  it('deleting one workspace draft leaves the other workspace intact', () => {
    const configDir = makeConfigDir()
    runEval(configDir, `setSessionDraft(${A('dup')}, { text: 'from A' })`)
    runEval(configDir, `setSessionDraft(${B('dup')}, { text: 'from B' })`)
    runEval(configDir, `deleteSessionDraft(${A('dup')})`)
    expect(runEval(configDir, `console.log(JSON.stringify(getSessionDraft(${A('dup')})))`)).toBe('null')
    expect(JSON.parse(runEval(configDir, `console.log(JSON.stringify(getSessionDraft(${B('dup')})))`))).toEqual({ text: 'from B' })
  })

  it('strips extra FileAttachment fields when persisting path-only attachments', () => {
    const configDir = makeConfigDir()
    // Pass a FileAttachment-shaped object (includes base64/size/etc.); persistence
    // should reduce it to just path + name when no `content` subfield is present.
    runEval(configDir,
      `setSessionDraft(${A('s1')}, { text: '', attachments: [{ path: '/tmp/a.png', name: 'a.png', base64: 'AAAA', size: 4, type: 'image', mimeType: 'image/png' }] })`
    )
    const draftsPath = join(configDir, 'drafts.json')
    const raw = JSON.parse(readFileSync(draftsPath, 'utf-8'))
    expect(raw.version).toBe(2)
    const key = `${WS_A}:s1`
    expect(raw.drafts[key].session).toEqual({ workspaceId: WS_A, sessionId: 's1' })
    expect(raw.drafts[key].draft.attachments).toEqual([{ path: '/tmp/a.png', name: 'a.png' }])
  })

  it('round-trips a draft with a content-backed attachment (paste / web-drag path)', () => {
    const configDir = makeConfigDir()
    runEval(configDir,
      `setSessionDraft(${A('s1')}, { text: 'note', attachments: [{ path: 'pasted-image-1.png', name: 'pasted-image-1.png', content: { type: 'image', mimeType: 'image/png', size: 4, base64: 'AAAA', thumbnailBase64: 'BBBB' } }] })`
    )
    const output = runEval(configDir, `console.log(JSON.stringify(getSessionDraft(${A('s1')})))`)
    expect(JSON.parse(output)).toEqual({
      text: 'note',
      attachments: [{
        path: 'pasted-image-1.png',
        name: 'pasted-image-1.png',
        content: { type: 'image', mimeType: 'image/png', size: 4, base64: 'AAAA', thumbnailBase64: 'BBBB' },
      }],
    })
  })

  it('round-trips a text-content attachment without base64', () => {
    const configDir = makeConfigDir()
    runEval(configDir,
      `setSessionDraft(${A('s1')}, { text: '', attachments: [{ path: 'pasted.txt', name: 'pasted.txt', content: { type: 'text', mimeType: 'text/plain', size: 5, text: 'hello' } }] })`
    )
    const output = runEval(configDir, `console.log(JSON.stringify(getSessionDraft(${A('s1')})))`)
    expect(JSON.parse(output)).toEqual({
      text: '',
      attachments: [{
        path: 'pasted.txt',
        name: 'pasted.txt',
        content: { type: 'text', mimeType: 'text/plain', size: 5, text: 'hello' },
      }],
    })
  })

  it('round-trips pasted-text attachment origin metadata', () => {
    const configDir = makeConfigDir()
    runEval(configDir,
      `setSessionDraft(${A('s1')}, { text: '', attachments: [{ path: 'pasted-text-1.txt', name: 'pasted-text-1.txt', content: { type: 'text', mimeType: 'text/plain', size: 5, text: 'hello', origin: 'pasted-text' } }] })`
    )
    const output = runEval(configDir, `console.log(JSON.stringify(getSessionDraft(${A('s1')})))`)
    expect(JSON.parse(output)).toEqual({
      text: '',
      attachments: [{
        path: 'pasted-text-1.txt',
        name: 'pasted-text-1.txt',
        content: { type: 'text', mimeType: 'text/plain', size: 5, text: 'hello', origin: 'pasted-text' },
      }],
    })
  })

  it('rejects on load: record with malformed content (wrong type field)', () => {
    const configDir = makeConfigDir()
    const draftsPath = join(configDir, 'drafts.json')
    writeFileSync(draftsPath, JSON.stringify({
      version: 2,
      drafts: {
        [`${WS_A}:s1`]: {
          session: { workspaceId: WS_A, sessionId: 's1' },
          draft: {
            text: '',
            attachments: [{ path: 'x.png', name: 'x.png', content: { type: 'bogus', mimeType: 'image/png', size: 1 } }],
          },
        },
      },
      updatedAt: 0,
    }), 'utf-8')
    const output = runEval(configDir, `console.log(JSON.stringify(getAllSessionDrafts('${WS_A}')))`)
    expect(JSON.parse(output)).toEqual({})
  })

  it('rejects on load: 0.8.11-shape ref (synthetic filename path, no content)', () => {
    const configDir = makeConfigDir()
    const draftsPath = join(configDir, 'drafts.json')
    writeFileSync(draftsPath, JSON.stringify({
      version: 2,
      drafts: {
        [`${WS_A}:s1`]: {
          session: { workspaceId: WS_A, sessionId: 's1' },
          draft: {
            text: 'note',
            attachments: [{ path: 'image.png', name: 'image.png' }],
          },
        },
      },
      updatedAt: 0,
    }), 'utf-8')
    const output = runEval(configDir, `console.log(JSON.stringify(getAllSessionDrafts('${WS_A}')))`)
    // Entire draft is dropped (attachment validator fails → ref fails → record fails)
    expect(JSON.parse(output)).toEqual({})
  })

  it('discards pre-cutover bare-sessionId drafts on load (clean v2 cutover, no migration)', () => {
    const configDir = makeConfigDir()
    // Simulate the v1 drafts.json shape (bare sessionId keys, no `version`, no `session`).
    const draftsPath = join(configDir, 'drafts.json')
    writeFileSync(draftsPath, JSON.stringify({
      drafts: {
        s1: { text: 'unmigrated text' },
        s2: { text: 'another one' },
      },
      updatedAt: 0,
    }), 'utf-8')
    const output = runEval(configDir, `console.log(JSON.stringify(getAllSessionDrafts('${WS_A}')))`)
    expect(JSON.parse(output)).toEqual({})
  })

  it('keeps valid records and drops invalid siblings on load', () => {
    const configDir = makeConfigDir()
    const draftsPath = join(configDir, 'drafts.json')
    writeFileSync(draftsPath, JSON.stringify({
      version: 2,
      drafts: {
        [`${WS_A}:valid`]: { session: { workspaceId: WS_A, sessionId: 'valid' }, draft: { text: 'stay' } },
        [`${WS_A}:legacy`]: 'drop',
        [`${WS_A}:mangled`]: { session: { workspaceId: WS_A, sessionId: 'mangled' }, draft: { text: 42 } },
        [`${WS_A}:nokey`]: { draft: { text: 'no session key' } },
      },
      updatedAt: 0,
    }), 'utf-8')
    const output = runEval(configDir, `console.log(JSON.stringify(getAllSessionDrafts('${WS_A}')))`)
    expect(JSON.parse(output)).toEqual({ valid: { text: 'stay' } })
  })

  it('deleteSessionDraft removes the entry', () => {
    const configDir = makeConfigDir()
    runEval(configDir, `setSessionDraft(${A('s1')}, { text: 'hi' })`)
    runEval(configDir, `deleteSessionDraft(${A('s1')})`)
    const output = runEval(configDir, `console.log(JSON.stringify(getSessionDraft(${A('s1')})))`)
    expect(output).toBe('null')
  })
})
