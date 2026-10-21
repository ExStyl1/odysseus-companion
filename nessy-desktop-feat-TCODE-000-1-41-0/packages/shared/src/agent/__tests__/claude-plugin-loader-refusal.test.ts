import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PLUGIN_LSP_SUPPORT,
  PLUGIN_MONITOR_SUPPORT,
  runtimeProvisionsPluginLsp,
} from '../runtime-agent-support.ts'

/**
 * C3.188 / C3.189 (owner answer QL8, 2026-09-11).
 *
 * The owner overrode a flat refusal into a MEASUREMENT: where a runtime has its
 * own plugin loader, price handing it the parts the host does not deliver, and
 * name how the double delivery is avoided. The measurement is recorded on
 * `PLUGIN_LSP_SUPPORT` (`runtime-agent-support.ts`) and at the `plugins: []`
 * option in `claude-agent.ts`; the verdict is a refusal, and these arms are what
 * stop it being flipped by opinion rather than by a new reading.
 *
 * The arm that matters is the LAST one: it reads the vendored `sdk.d.ts` and
 * goes RED the day the SDK grows a language-server surface — which is the exact
 * condition the record names as the thing that would flip it. It carries its own
 * positive control, so a green is a reading of the file and not a bad path.
 */
const here = dirname(fileURLToPath(import.meta.url))
const repoFile = (relative: string) => readFileSync(join(here, relative), 'utf8')

describe('the claude plugin loader stays unfed (C3.188)', () => {
  it('passes no plugins, and says why at the option', () => {
    const agent = repoFile('../claude-agent.ts')
    // The CALL, not the identifier: a bare `plugins` matches the prose beside it
    // and would pass on a file that had started feeding the loader.
    expect(agent).toContain('plugins: [],')
    expect(agent).toContain('C3.188')
    // The three findings, each named where a reader meets the decision.
    expect(agent).toContain('skipMcpDiscovery')
    expect(agent).toContain('PLUGIN_MONITOR_SUPPORT.anthropic')
    expect(agent).toContain('CapabilityDelta.lostLsp')
  })

  it('keeps the LSP record false on claude and codex, and true only where a supervisor exists', () => {
    expect(PLUGIN_LSP_SUPPORT.pi).toBe(true)
    expect(PLUGIN_LSP_SUPPORT.anthropic).toBe(false)
    expect(PLUGIN_LSP_SUPPORT['codex-runtime']).toBe(false)
    expect(runtimeProvisionsPluginLsp('anthropic')).toBe(false)
    // The negative control for the arm above: the sibling peripheral record is
    // TRUE on claude, so "false" here is a decision about language servers and
    // not a runtime that is switched off wholesale. It is also finding (2) of
    // the measurement — monitors are not a part the host fails to deliver, so
    // handing them to the loader would double-deliver.
    expect(PLUGIN_MONITOR_SUPPORT.anthropic).toBe(true)
  })

  /**
   * The measured number the refusal rests on, re-read from the vendored SDK on
   * every run. `lspServers` / `lspServer` / `'lsp'` at zero is why a plugin
   * language server's failure could not reach the user on this runtime; the day
   * any of them is non-zero, this test fails and the record is due a re-reading
   * rather than a re-argument.
   */
  it('finds no language-server surface in the vendored sdk.d.ts, against a live control', () => {
    // The package publishes no `sdk.d.ts` export, so it is reached from the
    // resolved entry point — the same recipe `claude-live-settings.test.ts`
    // uses, and the reason a bare subpath resolve fails here.
    const require = createRequire(import.meta.url)
    const entry = require.resolve('@anthropic-ai/claude-agent-sdk')
    const dts = readFileSync(entry.replace(/sdk\.mjs$/, 'sdk.d.ts'), 'utf8')
    const count = (needle: string) => dts.split(needle).length - 1

    // Positive controls FIRST: a zero below is only evidence if the file is the
    // one we think it is and the probe can find things in it.
    expect(count('skipMcpDiscovery')).toBeGreaterThan(0)
    expect(count('workflow')).toBeGreaterThan(0)
    expect(count('plugins?: SdkPluginConfig[]')).toBe(1)

    expect({
      lspServers: count('lspServers'),
      lspServer: count('lspServer'),
      lsp: count("'lsp'"),
    }).toEqual({ lspServers: 0, lspServer: 0, lsp: 0 })
  })
})
