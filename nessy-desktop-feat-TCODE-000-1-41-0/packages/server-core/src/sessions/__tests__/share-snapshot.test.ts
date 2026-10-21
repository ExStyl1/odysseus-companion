/**
 * UA1.24 — the shareable chat snapshot (`../share-snapshot.ts`): the transcript
 * as it is, minus paths and secrets. The formatter is the REAL Markdown export's
 * `formatTranscriptMessage` (`SessionManager.ts`, exported in place, O13), so the
 * positive arm proves reuse, not a fake.
 *
 * Load-bearing negatives (waves.md, UA-o risks): the 20 MiB refusal, and the
 * home path and OS account name appearing nowhere. Tokens are assembled at run
 * time from obviously fake parts — no real credential exists in this file.
 */
import { describe, expect, it } from 'bun:test'
import { homedir, userInfo } from 'node:os'
import type { PersistedMessage } from '@nessy-agent/core/types'
import { formatTranscriptMessage } from '../SessionManager.ts'
import {
  SHARE_TOOL_PAYLOAD_CAP_BYTES,
  buildShareSnapshot,
  type ShareSnapshot,
  type ShareSnapshotSession,
} from '../share-snapshot.ts'

const HOME = homedir()
const ACCOUNT = userInfo().username
const CWD = `${HOME}/work/demo-proj`

const FAKE_JWT = ['eyJ' + 'hbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJmYWtlLXVzZXIifQ', 'ZmFrZXNpZ25hdHVyZXZhbHVl'].join('.')
const FAKE_ORY = 'ory_' + 'at_' + 'FAKEfakeFAKEfakeFAKEfake0123'
const FAKE_BEARER = 'Bearer ' + 'fakeFAKEfakeFAKEfakeFAKE.0123456789'
// A Luhn-valid test PAN (the well-known Visa test number), spaced.
const FAKE_PAN = ['4111', '1111', '1111', '1111'].join(' ')

let seq = 0
function msg(partial: Partial<PersistedMessage> & Pick<PersistedMessage, 'role'>): PersistedMessage {
  seq += 1
  return { id: `m${seq}`, content: '', timestamp: Date.UTC(2026, 9, 2, 12, 0, seq), ...partial } as PersistedMessage
}

function fixture(): ShareSnapshotSession {
  return {
    name: 'Fix the build',
    model: 'coder',
    llmConnection: 'nessy-gateway',
    permissionMode: 'ask',
    sessionStatus: 'in_progress',
    createdAt: Date.UTC(2026, 9, 2, 11, 0, 0),
    workingDirectory: CWD,
    tokenUsage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500, contextTokens: 1100 },
    messages: [
      msg({ role: 'user', content: `Why does ${CWD}/src/app.ts fail? My notes are in ${HOME}/Documents/notes.md` }),
      msg({ role: 'assistant', isThinking: true, isIntermediate: true, content: 'THINKING-MARKER: read the app module first' }),
      msg({
        role: 'tool',
        toolName: 'Bash',
        toolStatus: 'completed',
        toolIntent: 'List the sources',
        toolInput: { command: `ls ${CWD}/src && cat /opt/vendor/secret/report.csv` },
        toolResult: `app.ts\njwt=${FAKE_JWT}\nauth: ${FAKE_ORY}\nAuthorization: ${FAKE_BEARER}\ncard ${FAKE_PAN}`,
        rawToolResult: 'RAW-ONLY-MARKER differs from the displayed result',
      }),
      msg({
        role: 'tool',
        toolName: 'Read',
        toolStatus: 'completed',
        toolInput: { file_path: `${CWD}/src/app.ts` },
        toolResult: 'export const answer = 42',
      }),
      msg({ role: 'error', content: `ERROR-MARKER: cannot open ~/private/keys.txt` }),
    ],
  }
}

function build(session: ShareSnapshotSession = fixture()): ShareSnapshot {
  const result = buildShareSnapshot(session, { formatMessage: formatTranscriptMessage })
  if (!result.ok) throw new Error(`unexpected refusal: ${result.message}`)
  return result
}

describe('UA1.24 share snapshot — positive: the chat as it is', () => {
  it('renders the Bash call, the Read under the cwd, the thinking block and the error, with relative paths and collapsed blocks', () => {
    const snap = build()
    const md = snap.markdown
    // The real formatter's headings and detail lines.
    expect(md).toContain('## 1. User')
    expect(md).toContain('- Tool: Bash')
    expect(md).toContain('- Tool status: completed')
    expect(md).toContain('- Tool intent: List the sources')
    expect(md).toContain('- Tool: Read')
    expect(md).toContain('## 5. Error')
    expect(md).toContain('ERROR-MARKER')
    // Paths inside the cwd become relative.
    expect(md).toContain('Why does src/app.ts fail?')
    expect(md).toContain('"file_path": "src/app.ts"')
    expect(md).toContain('ls src && cat')
    // Thinking and tool payloads are collapsed.
    expect(md).toMatch(/<details><summary>Thinking<\/summary>\n\nTHINKING-MARKER: read the app module first\n\n<\/details>/)
    expect(md).toContain('<details><summary>Tool input</summary>')
    expect(md).toMatch(/<details><summary>Tool result<\/summary>\n\n```\nexport const answer = 42\n```\n\n<\/details>/)
    // Header: what a reader needs, the project by NAME.
    expect(md.startsWith('# Fix the build\n')).toBe(true)
    expect(md).toContain('- Project: demo-proj')
    expect(md).toContain('- Model: coder')
    expect(md).toContain('- Permission mode: ask')
    expect(md).toContain('- Total: 1500')
    expect(snap.relativisedPaths).toBeGreaterThanOrEqual(5)
    expect(snap.bytes).toBe(Buffer.byteLength(md, 'utf8'))
  })

  it('a clean chat masks nothing and keeps its text byte for byte', () => {
    const snap = build({ messages: [msg({ role: 'user', content: 'Plain words, no paths; run /compact later.' })] })
    expect(snap.markdown).toContain('Plain words, no paths; run /compact later.')
    expect(snap.maskedSecretTotal).toBe(0)
    expect(snap.maskedSecrets).toEqual([])
    expect(snap.truncatedPayloads).toBe(0)
  })
})

describe('UA1.24 share snapshot — negatives', () => {
  it('drops the session id, the workspace and the working-directory path from the header', () => {
    const md = build().markdown
    expect(md).not.toContain('Session ID')
    expect(md).not.toContain('Workspace:')
    expect(md).not.toContain('Working directory')
  })

  it('an absolute path outside the roots becomes …/name, and so do ~/ and home paths', () => {
    const md = build().markdown
    expect(md).toContain('cat …/report.csv')
    expect(md).not.toContain('/opt/vendor')
    expect(md).toContain('cannot open …/keys.txt')
    expect(md).toContain('My notes are in …/notes.md')
  })

  it('a path right after a colon (PATH lists, scp host:/…) and a file:/// URL are relativised too', () => {
    const md = build({
      workingDirectory: CWD,
      messages: [
        msg({ role: 'tool', toolName: 'Bash', toolResult: 'PATH=/a/b/c:/opt/x/y\nscp host:/srv/clientX/data/dump.sql .\nat file:///opt/x/app.js:12:3' }),
        msg({ role: 'user', content: `open file://${CWD}/src/a.ts:4 please` }),
      ],
    }).markdown
    expect(md).toContain('PATH=…/c:…/y')
    expect(md).toContain('scp host:…/dump.sql .')
    expect(md).toContain('at …/app.js:12:3')
    expect(md).toContain('open src/a.ts:4 please')
    for (const leaked of ['/opt/x', '/srv/clientX', 'file://']) expect(md).not.toContain(leaked)
  })

  it('a URL keeps its host and path (boundary: the colon change does not reach URLs)', () => {
    const md = build({ messages: [msg({ role: 'user', content: 'see https://example.test/a/b and http://localhost:8080/api/v1' })] }).markdown
    expect(md).toContain('see https://example.test/a/b and http://localhost:8080/api/v1')
  })

  it('the home directory and the OS account name appear nowhere', () => {
    const session = fixture()
    session.messages = [
      ...session.messages,
      msg({ role: 'assistant', content: `See file://${HOME}/Library/x.plist and ask ${ACCOUNT} about it` }),
    ]
    const md = build(session).markdown
    expect(HOME.length).toBeGreaterThan(1)
    expect(md).not.toContain(HOME)
    expect(md.toLowerCase()).not.toContain(ACCOUNT.toLowerCase())
    expect(md).toContain('ask [user] about it')
  })

  it('a JWT, an ory_at_ token, a Bearer header and a Luhn-valid PAN in a tool result are masked and counted', () => {
    const snap = build()
    const md = snap.markdown
    for (const secret of [FAKE_JWT, FAKE_ORY, 'fakeFAKEfakeFAKEfakeFAKE', FAKE_PAN, '4111']) {
      expect(md).not.toContain(secret)
    }
    for (const rule of ['jwt', 'ory-token', 'bearer', 'pan']) {
      expect(md).toContain(`[REDACTED:${rule}]`)
      expect(snap.maskedSecrets.find((entry) => entry.rule === rule)?.count).toBe(1)
    }
    expect(snap.maskedSecretTotal).toBe(4)
  })

  // A private key is a BLOCK: the shared rule matches its header only, enough to
  // refuse (UA1.17) but not to mask. Body lines are fake, assembled at run time.
  const PEM_TYPE = 'OPENSSH ' + 'PRIVATE KEY'
  const PEM_BODY = ['FAKEbody0LINE', 'FAKEbody1LINE', 'FAKEbody2tail'].map((tag, i) => (tag + 'x'.repeat(i === 2 ? 4 : 57)))
  const PEM_END = `-----END ${PEM_TYPE}-----`
  const pemLeaks = [...PEM_BODY, PEM_END, 'FAKEbody']

  it('a raw PEM private key block in a tool result is masked whole and counted once', () => {
    const pem = [`-----BEGIN ${PEM_TYPE}-----`, ...PEM_BODY, PEM_END].join('\n')
    const snap = build({ messages: [msg({ role: 'tool', toolName: 'Bash', toolInput: { command: 'cat deploy/key.pem' }, toolResult: `${pem}\nafter-the-key` })] })
    for (const leaked of pemLeaks) expect(snap.markdown).not.toContain(leaked)
    expect(snap.markdown).toContain('[REDACTED:private-key]\nafter-the-key')
    expect(snap.markdown.split('[REDACTED:private-key]').length - 1).toBe(1)
    expect(snap.maskedSecrets.find((entry) => entry.rule === 'private-key')?.count).toBe(1)
    expect(snap.maskedSecretTotal).toBe(1)
  })

  it('a stored, already-scrubbed PEM block (marker, body, END) is masked whole and counted once', () => {
    const stored = ['[REDACTED:private-key]', ...PEM_BODY, PEM_END, '', '[nessy] 1 credential-shaped value redacted'].join('\n')
    const snap = build({ messages: [msg({ role: 'tool', toolName: 'Bash', toolResult: stored })] })
    for (const leaked of pemLeaks) expect(snap.markdown).not.toContain(leaked)
    expect(snap.markdown).toContain('[REDACTED:private-key]\n\n[nessy] 1 credential-shaped value redacted')
    expect(snap.markdown.split('[REDACTED:private-key]').length - 1).toBe(1)
    expect(snap.maskedSecrets.find((entry) => entry.rule === 'private-key')?.count).toBe(1)
    expect(snap.maskedSecretTotal).toBe(1)
  })

  it('a key cut before its END, and an END whose header was cut, are masked to the body edge; prose after a lone marker stays (boundary)', () => {
    const truncated = [`-----BEGIN ${PEM_TYPE}-----`, ...PEM_BODY.slice(0, 2)].join('\n')
    const orphan = ['last lines of the output:', ...PEM_BODY.slice(1), PEM_END, 'tail-prose'].join('\n')
    const snap = build({
      messages: [
        msg({ role: 'tool', toolName: 'Bash', toolResult: truncated }),
        msg({ role: 'tool', toolName: 'Bash', toolResult: orphan }),
        msg({ role: 'user', content: 'I pasted [REDACTED:private-key]\nand then kept going' }),
      ],
    })
    for (const leaked of pemLeaks) expect(snap.markdown).not.toContain(leaked)
    expect(snap.markdown).toContain('last lines of the output:\n[REDACTED:private-key]\ntail-prose')
    expect(snap.markdown).toContain('I pasted [REDACTED:private-key]\nand then kept going')
    expect(snap.maskedSecrets.find((entry) => entry.rule === 'private-key')?.count).toBe(2)
  })

  // UA12.19 — a key written with JSON-escaped newlines (a service-account JSON, a
  // .env value): the two characters `\` `n` are its line breaks. `ESC` is one
  // backslash and an `n`; `ESC_CRLF` the escaped `\r\n`.
  const ESC = '\\n'
  const ESC_CRLF = '\\r\\n'
  const PKCS8 = 'PRIVATE ' + 'KEY'
  const RSA = 'RSA PRIVATE ' + 'KEY'
  const serviceAccount = (head: string, sep: string) =>
    `{"type": "service_account", "private_key": "${head}${sep}${PEM_BODY.join(sep)}${sep}-----END ${PKCS8}-----${sep}", "client_email": "fake@example.test"}`
  const privateKeyCount = (snap: ShareSnapshot) => snap.maskedSecrets.find((entry) => entry.rule === 'private-key')?.count

  it('a service-account JSON with escaped newlines — tool result (header or stored marker) and Write input — is masked whole, one private-key per block', () => {
    for (const head of [`-----BEGIN ${PKCS8}-----`, '[REDACTED:private-key]']) {
      const snap = build({ messages: [msg({ role: 'tool', toolName: 'Bash', toolResult: serviceAccount(head, ESC) })] })
      for (const leaked of [...pemLeaks, `-----END ${PKCS8}`]) expect(snap.markdown).not.toContain(leaked)
      expect(snap.markdown).toContain(`"private_key": "[REDACTED:private-key]${ESC}", "client_email"`)
      expect(privateKeyCount(snap)).toBe(1)
      expect(snap.maskedSecretTotal).toBe(1)
    }
    const write = build({
      messages: [msg({ role: 'tool', toolName: 'Write', toolInput: { file_path: 'sa.json', content: serviceAccount(`-----BEGIN ${PKCS8}-----`, ESC) } })],
    })
    for (const leaked of [...pemLeaks, `-----END ${PKCS8}`]) expect(write.markdown).not.toContain(leaked)
    expect(privateKeyCount(write)).toBe(1)
    expect(write.maskedSecretTotal).toBe(1)
  })

  it('a .env PRIVATE_KEY with escaped \\n, escaped \\r\\n or a doubly escaped \\\\n is masked whole, and so is an escaped body above an orphan END', () => {
    const envKey = (sep: string) => `PRIVATE_KEY="-----BEGIN ${RSA}-----${sep}${PEM_BODY.join(sep)}${sep}-----END ${RSA}-----"\nNEXT=1`
    const orphan = `"key": "cut${ESC}${PEM_BODY.slice(1).join(ESC)}${ESC}-----END ${RSA}-----${ESC}"`
    const snap = build({
      messages: [
        msg({ role: 'tool', toolName: 'Bash', toolResult: envKey(ESC) }),
        msg({ role: 'tool', toolName: 'Bash', toolResult: envKey(ESC_CRLF) }),
        msg({ role: 'tool', toolName: 'Bash', toolResult: envKey('\\\\n') }),
        msg({ role: 'tool', toolName: 'Bash', toolResult: orphan }),
      ],
    })
    for (const leaked of [...pemLeaks, `-----END ${RSA}`]) expect(snap.markdown).not.toContain(leaked)
    expect(snap.markdown.split('PRIVATE_KEY="[REDACTED:private-key]"\nNEXT=1').length - 1).toBe(3)
    expect(snap.markdown).toContain(`"key": "cut${ESC}[REDACTED:private-key]${ESC}"`)
    expect(privateKeyCount(snap)).toBe(4)
  })

  it('after a stored marker the body must be key lines: prose up to a later END line stays (boundary); a space-joined body still masks', () => {
    const prose = `I pasted [REDACTED:private-key]\nand then kept going\nyes -----END ${RSA}-----\nlater`
    const escapedProse = `"note": "[REDACTED:private-key]${ESC}see the docs${ESC}-----END ${RSA}-----"`
    // `echo $KEY` unquoted joins the lines with spaces; the stored result carries the marker.
    const spaceJoined = `[REDACTED:private-key] ${PEM_BODY.join(' ')} -----END ${RSA}----- done`
    const snap = build({
      messages: [
        msg({ role: 'user', content: prose }),
        msg({ role: 'tool', toolName: 'Bash', toolResult: escapedProse }),
        msg({ role: 'tool', toolName: 'Bash', toolResult: spaceJoined }),
      ],
    })
    expect(snap.markdown).toContain('I pasted [REDACTED:private-key]\nand then kept going\nyes ')
    expect(snap.markdown).toContain('\nlater')
    expect(snap.markdown).toContain(`"note": "[REDACTED:private-key]${ESC}see the docs${ESC}`)
    expect(snap.markdown).toContain('\n[REDACTED:private-key] done\n')
    for (const leaked of [...pemLeaks, `-----END ${RSA}`]) expect(snap.markdown).not.toContain(leaked)
  })

  it('a non-Luhn 16-digit number is not masked (boundary)', () => {
    const snap = build({ messages: [msg({ role: 'user', content: 'order 4111 1111 1111 1112' })] })
    expect(snap.markdown).toContain('order 4111 1111 1111 1112')
    expect(snap.maskedSecretTotal).toBe(0)
  })

  it('rawToolResult content that differs from toolResult is not emitted', () => {
    expect(build().markdown).not.toContain('RAW-ONLY-MARKER')
  })

  it('a tool result over the cap is truncated with a marker naming the dropped size', () => {
    const big = 'x'.repeat(SHARE_TOOL_PAYLOAD_CAP_BYTES + 5000)
    const snap = build({ messages: [msg({ role: 'tool', toolName: 'Bash', toolResult: big })] })
    expect(snap.truncatedPayloads).toBe(1)
    expect(snap.markdown).toContain('[… truncated for sharing: 5000 bytes dropped]')
    expect(snap.markdown).not.toContain(big)
  })

  it('a 20 MiB transcript is refused with a sentence', () => {
    const chunk = 'a'.repeat(1024 * 1024)
    const messages = Array.from({ length: 20 }, () => msg({ role: 'assistant', content: chunk }))
    const result = buildShareSnapshot({ messages }, { formatMessage: formatTranscriptMessage })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('too-large')
    expect(result.bytes).toBeGreaterThan(20 * 1024 * 1024)
    expect(result.message).toMatch(/^This chat is too large to share: its snapshot is 20\.0 MiB and the sharing service accepts at most 16\.0 MiB/)
  })
})

// UA12.30 — the thinking body rides raw inside OUR collapsed block, so a literal
// `</details>` line in it closes the block early (and a literal `<details>`
// opener would open one extra): the details-tag spellings must come out escaped
// (`&lt;…`), rendering as the original characters with the emitted
// `<details>` / `</details>` counts still ours alone. Tool payloads are fenced
// and stay raw — the escape must never reach the fence.
describe('UA12.30 share snapshot — a details tag in a thinking body', () => {
  it('a thinking body that is a </details> line stays inside one block: one open, one close, the line as text', () => {
    const snap = build({
      messages: [
        msg({ role: 'assistant', isThinking: true, isIntermediate: true, content: '</details>\nthe collapse must hold' }),
        msg({ role: 'assistant', content: 'AFTER-MARKER: the visible answer' }),
      ],
    })
    const md = snap.markdown
    expect(md).toContain('AFTER-MARKER')
    expect(md).toContain('&lt;/details>\nthe collapse must hold')
    expect((md.match(/<details>/g) ?? []).length).toBe(1)
    expect((md.match(/<\/details>/g) ?? []).length).toBe(1)
  })

  it('a literal <details> opener in a thinking body is escaped too; a lookalike tag stays raw (boundary)', () => {
    const snap = build({
      messages: [msg({ role: 'assistant', isThinking: true, isIntermediate: true, content: '<details open>\nwatch the count\n</detailing>' })],
    })
    const md = snap.markdown
    expect(md).toContain('&lt;details open>')
    expect((md.match(/<details>/g) ?? []).length).toBe(1)
    expect((md.match(/<\/details>/g) ?? []).length).toBe(1)
    expect(md).toContain('</detailing>')
  })

  it('a </details> line inside a fenced tool result stays raw — the fence makes it immune (control)', () => {
    const snap = build({
      messages: [msg({ role: 'tool', toolName: 'Bash', toolStatus: 'completed', toolResult: 'docs say:\n</details>\nends' })],
    })
    // The wrapper still emits its own one <details>/</details> pair around the
    // fence; the literal INSIDE the fence is inert and must not be escaped.
    expect(snap.markdown).toContain('```\ndocs say:\n</details>\nends\n```')
    expect(snap.markdown).not.toContain('&lt;')
    expect((snap.markdown.match(/<details>/g) ?? []).length).toBe(1)
    expect((snap.markdown.match(/<\/details>/g) ?? []).length).toBe(2)
  })

  // DECIDED 2026-10-09 (the owner's simplicity rule): escape EVERYWHERE, code included — every attempt to keep code
  // raw left a shape where a raw tag closed the block early. Residue (cosmetic): in code the tag reads `&lt;…`.
  it('a details tag inside inline code or a fenced block is escaped too; the emitted pair is still ours alone', () => {
    const body = 'the `</details>` tag closes it\n\n```html\n<details>\n<summary>x</summary>\n</details>\n```\n\nend'
    const snap = build({
      messages: [
        msg({ role: 'assistant', isThinking: true, isIntermediate: true, content: body }),
        msg({ role: 'assistant', content: 'AFTER-MARKER' }),
      ],
    })
    const md = snap.markdown
    expect(md).toContain(body.replace(/<(\/?details)/g, '&lt;$1'))
    expect((md.match(/<details>/g) ?? []).length).toBe(1)
    expect((md.match(/<\/details>/g) ?? []).length).toBe(1)
    expect(md.indexOf('AFTER-MARKER')).toBeGreaterThan(md.lastIndexOf('</details>'))
  })

  it('a mid-line details tag in thinking prose is still escaped (raw inline HTML would close the block)', () => {
    const snap = build({
      messages: [msg({ role: 'assistant', isThinking: true, isIntermediate: true, content: 'see </details> here and `code` too' })],
    })
    expect(snap.markdown).toContain('see &lt;/details> here and `code` too')
    expect((snap.markdown.match(/<\/details>/g) ?? []).length).toBe(1)
  })

  // Follow-up 2 (2026-10-09 verification): code is kept raw only where marked's code agrees with CommonMark's. A
  // "```\t" closer (marked takes spaces only), a "```~" closer (CommonMark refuses it), a line that opens an HTML
  // block marked misses (`<?`, `<![CDATA[`), an escaped `<details>` block whose `<pre>` line then opens one, or a
  // paragraph marked splits (the table-like line) puts the "code" in prose or raw HTML for markdown-it — there a raw
  // </details> closes our block. Such code is escaped like prose (fail safe).
  it('code that marked and CommonMark may read differently is escaped; the emitted pair is still ours alone', () => {
    for (const body of [
      '```\nx\n```\t\n</details>\nEND',
      '```\nx\n```~\n```\n</details>\n```\nEND',
      'text\n<?x\n```\n</details>\n```\nEND',
      'text\n<![CDATA[ `</details>`\nEND',
      '<details>\n<pre>\n\n```\n</details>\n```\nEND',
      '`a\nx `</details>` y\n|---|---|\nEND',
    ]) {
      const md = build({ messages: [msg({ role: 'assistant', isThinking: true, isIntermediate: true, content: body })] }).markdown
      expect(md).toContain(body.replace(/<(\/?details)/g, '&lt;$1'))
      expect((md.match(/<details>/g) ?? []).length).toBe(1)
      expect((md.match(/<\/details>/g) ?? []).length).toBe(1)
    }
  })

  // Follow-up 3 (2026-10-09 verification): marked leaves a backtick in a non-code inline part (text after a failed
  // ~~ / ~ strikethrough, an image or GFM link's raw) or misses raw HTML CommonMark reads (`<!X…>` with no space), and
  // CommonMark then pairs that backtick with the intended span's opener — the `</details>` marked called code is raw
  // inline HTML for markdown-it and micromark. A paragraph keeps its spans raw only when every backtick and every `<`
  // outside them is absent; else it is escaped whole (fail safe).
  it('a backtick or < outside a paragraph code span: the paragraph is escaped; a span-only paragraph is escaped too', () => {
    for (const body of [
      '~~`~~ `</details>`',
      '~`~ `</details>`',
      '~~`~~\n mid `</details>` x',
      '![`](x)</details>- `a - `aa\\',
      'a <!X`>` `</details>`',
      'www.a`b.com `</details>`',
    ]) {
      const md = build({ messages: [msg({ role: 'assistant', isThinking: true, isIntermediate: true, content: body })] }).markdown
      expect(md).toContain(body.replace(/<(\/?details)/g, '&lt;$1'))
      expect((md.match(/<details>/g) ?? []).length).toBe(1)
      expect((md.match(/<\/details>/g) ?? []).length).toBe(1)
    }
    // Escape-everywhere (2026-10-09): a span-only paragraph is escaped like the rest (the cosmetic residue).
    const spanOnly = '``a`` and `</details>` in code'
    const md = build({ messages: [msg({ role: 'assistant', isThinking: true, isIntermediate: true, content: spanOnly })] }).markdown
    expect(md).toContain('``a`` and `&lt;/details>` in code')
    expect((md.match(/<\/details>/g) ?? []).length).toBe(1)
  })
})
