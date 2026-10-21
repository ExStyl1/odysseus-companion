import { describe, expect, it } from 'bun:test'
import { generateCallbackPage } from '../callback-page.ts'

/**
 * F1.999 — the OAuth callback page reflected the callback's `error` /
 * `error_description` query values (and every other interpolated value) raw
 * into its HTML, so a crafted callback URL ran script on the loopback origin.
 * Every value is now escaped for the context it lands in: HTML text and
 * attributes get entity escaping, the deep link inside the inline script is a
 * JSON string literal with `<` escaped.
 *
 * Parsed with Bun's built-in HTMLRewriter (lol-html), a real HTML tokenizer,
 * so "renders as text" is asserted on the parsed page, not by substring.
 * All values are fabricated.
 */

type Parsed = {
  title: string
  status: string
  imgCount: number
  scriptCount: number
  scriptText: string
  links: Array<{ href: string | null; attributes: string[] }>
  onAttributes: string[]
}

/** HTMLRewriter hands text chunks over undecoded; decode the entities the page may emit. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

async function parse(html: string): Promise<Parsed> {
  const parsed: Parsed = { title: '', status: '', imgCount: 0, scriptCount: 0, scriptText: '', links: [], onAttributes: [] }
  await new HTMLRewriter()
    .on('title', { text(t) { parsed.title += t.text } })
    .on('div.status', { text(t) { parsed.status += t.text } })
    .on('img', { element() { parsed.imgCount++ } })
    .on('script', {
      element() { parsed.scriptCount++ },
      text(t) { parsed.scriptText += t.text },
    })
    .on('a', {
      element(el) {
        parsed.links.push({ href: el.getAttribute('href'), attributes: [...el.attributes].map(([name]) => name) })
      },
    })
    .on('*', {
      element(el) {
        for (const [name] of el.attributes) {
          if (name.toLowerCase().startsWith('on')) parsed.onAttributes.push(`${el.tagName}.${name}`)
        }
      },
    })
    .transform(new Response(html))
    .text()
  return { ...parsed, title: decodeEntities(parsed.title), status: decodeEntities(parsed.status) }
}

const SCRIPT_PAYLOAD = '<script>alert("fabricated-xss")</script>'
const ATTR_PAYLOAD = '"><img src=x onerror=alert(1)>'

describe('generateCallbackPage escaping (F1.999)', () => {
  it('renders a <script> payload in the error detail as text, not as a script element', async () => {
    const page = await parse(generateCallbackPage({ title: 'Authorization Failed', isSuccess: false, errorDetail: SCRIPT_PAYLOAD }))

    expect(page.status).toBe(`Authorization failed: ${SCRIPT_PAYLOAD}`)
    // The page's own (empty, error-state) inline script is the only script element.
    expect(page.scriptCount).toBe(1)
    expect(page.scriptText).not.toContain('fabricated-xss')
  })

  it('renders an attribute-breakout payload in the error detail and the title as text, with no injected element or handler', async () => {
    const page = await parse(generateCallbackPage({ title: ATTR_PAYLOAD, isSuccess: false, errorDetail: ATTR_PAYLOAD }))

    expect(page.status).toBe(`Authorization failed: ${ATTR_PAYLOAD}`)
    expect(page.title).toBe(`Nessy Desktop - ${ATTR_PAYLOAD}`)
    expect(page.imgCount).toBe(0)
    expect(page.onAttributes).toEqual([])
  })

  it('keeps a hostile deep link inside its href attribute and its script string literal', async () => {
    const deeplinkUrl = `nessy://allSessions/session/x'"><img src=x onerror=alert(1)></script><script>alert(2)//`
    const html = generateCallbackPage({ title: 'Authorization Complete', isSuccess: true, deeplinkUrl })
    const page = await parse(html)

    expect(page.imgCount).toBe(0)
    expect(page.onAttributes).toEqual([])
    expect(page.scriptCount).toBe(1)
    expect(page.links).toHaveLength(1)
    expect(decodeEntities(page.links[0]!.href ?? '')).toBe(deeplinkUrl)
    expect(page.links[0]!.attributes).toEqual(['href', 'class'])
    // The script assigns exactly the deep link: evaluate the one string literal it holds.
    const literal = page.scriptText.match(/window\.location\.href = (.+);/)?.[1]
    expect(literal).toBeDefined()
    expect(JSON.parse(literal!)).toBe(deeplinkUrl)
  })

  it('CONTROL: an ordinary error message and deep link still show unchanged', async () => {
    const failed = await parse(generateCallbackPage({ title: 'Authorization Failed', isSuccess: false, errorDetail: 'access_denied' }))
    expect(failed.status).toBe('Authorization failed: access_denied')
    expect(failed.title).toBe('Nessy Desktop - Authorization Failed')

    const noDetail = await parse(generateCallbackPage({ title: 'Authorization Failed', isSuccess: false }))
    expect(noDetail.status).toBe('Authorization failed')

    const deeplinkUrl = 'nessy://allSessions/session/fabricated-session-1'
    const html = generateCallbackPage({ title: 'Authorization Complete', isSuccess: true, deeplinkUrl })
    const ok = await parse(html)
    expect(ok.status).toBe('Authorization successful')
    expect(ok.links).toEqual([{ href: deeplinkUrl, attributes: ['href', 'class'] }])
    expect(ok.scriptText).toContain('window.location.href = ')
    expect(ok.scriptText).toContain(deeplinkUrl)
  })
})
