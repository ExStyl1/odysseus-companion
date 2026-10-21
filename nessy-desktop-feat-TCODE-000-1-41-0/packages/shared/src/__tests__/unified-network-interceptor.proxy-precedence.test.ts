/**
 * P6.255 — the proxy chain was inverted inside each case pair.
 *
 * `network-config.md`, verbatim: *"Lowercase variants also work, and Claude Code
 * uses the first one that's set in the order `https_proxy`, `HTTPS_PROXY`,
 * `http_proxy`, `HTTP_PROXY`."* The interceptor read the UPPERCASE member of
 * each pair first, so a host exporting both spellings routed through a different
 * proxy on pi and codex than on claude, whose SDK child applies the documented
 * order itself. One setting, two answers, invisible from either side.
 *
 * Why a child process rather than four `process.env` writes: the probe fixture's
 * header records the three reasons, and the middle one is the load-bearing one —
 * these four names are the Bun env-slot trap's own subjects.
 */
import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'

const PROBE = new URL('./fixtures/proxy-precedence-probe.ts', import.meta.url).pathname

function probe(proxies: Record<string, string>): {
  resolved: string | null
  launch: Record<string, string | null>
} {
  const result = spawnSync(process.execPath, [PROBE], {
    encoding: 'utf8',
    env: {
      ...process.env,
      // The auto-install would replace this process's `fetch`; the probe only
      // needs the module's proxy resolver.
      NESSY_INTERCEPTOR_DISABLE_AUTO_INSTALL: '1',
      ...proxies,
    },
  })
  expect(result.status).toBe(0)
  return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}')
}

describe('proxy precedence inside each case pair', () => {
  it('takes `https_proxy` when every spelling is set, as the page orders them', () => {
    const out = probe({
      https_proxy: 'http://lower-https.internal:3128',
      HTTPS_PROXY: 'http://upper-https.internal:3128',
      http_proxy: 'http://lower-http.internal:3128',
      HTTP_PROXY: 'http://upper-http.internal:3128',
    })
    // The rig control: if the launch env did not carry all four, the verdict
    // below is about a misconfigured spawn rather than about the reader.
    expect(out.launch).toEqual({
      https_proxy: 'http://lower-https.internal:3128',
      HTTPS_PROXY: 'http://upper-https.internal:3128',
      http_proxy: 'http://lower-http.internal:3128',
      HTTP_PROXY: 'http://upper-http.internal:3128',
    })
    expect(out.resolved).toBe('http://lower-https.internal:3128')
  })

  it('still takes the uppercase name when it is the only one set', () => {
    // Lowercase-FIRST is not lowercase-ONLY. Without this control the fix above
    // is indistinguishable from a reader that dropped the uppercase names.
    expect(probe({ HTTPS_PROXY: 'http://upper-only.internal:3128' }).resolved)
      .toBe('http://upper-only.internal:3128')
  })

  it('falls through the pairs in the documented order, https before http', () => {
    expect(probe({
      http_proxy: 'http://lower-http.internal:3128',
      HTTPS_PROXY: 'http://upper-https.internal:3128',
    }).resolved).toBe('http://upper-https.internal:3128')
  })
})
