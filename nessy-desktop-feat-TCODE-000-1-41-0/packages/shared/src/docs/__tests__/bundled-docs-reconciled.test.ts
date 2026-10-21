/**
 * UB14.51 — the five bundled guides upstream v0.15.1 changed (`automations`, `browser-tools`, `labels`,
 * `pages`, `sources` in `apps/electron/resources/docs`) describe OUR behaviour, in our words.
 *
 * Every v0.15.1 paragraph of those five landed with the row that owns its code (UB4.12 and UB6.8 labels
 * and the LabelAdd entry, UB4.20 and UB1.16 browser quoting and passwords, UB7.11 resources and prompts,
 * UB3.3's RFC 8707 `resource` lines with UB14.51) or is not applicable: `pages.md`'s "Publish as Claude
 * artifact" sentence is DROP-b (it sends page content and data to claude.ai), and upstream's
 * `source_list_resources` / `source_read_resource` are tools we do not have (resources are read with each
 * runtime's own resource tools; Pi has `list_mcp_resources` / `read_mcp_resource`).
 *
 * Positive arms read a reconciled sentence from each file, so an empty or moved read cannot pass the
 * negative arms vacuously; the planted arm proves the forbidden-string instrument fires on upstream's own
 * wording.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DOCS_DIR = fileURLToPath(new URL('../../../../../apps/electron/resources/docs', import.meta.url))

const RECONCILED = ['automations.md', 'browser-tools.md', 'labels.md', 'pages.md', 'sources.md'] as const

/** Upstream's brand in any spelling: `Craft`, `CRAFT_`, `craft-agent`, `thecraftagents.com`, `craftagents://`. */
const BRAND = /craft/i
/** Upstream v0.15.1's page publishing to claude.ai (DROP-b). */
const CLAUDE_ARTIFACT_PUBLISH = [/publish(?:ed|ing)? as (?:a )?Claude artifact/i, /claude\.ai/i]
/** Upstream's MCP resource session tools, which no runtime of ours offers. */
const UPSTREAM_RESOURCE_TOOLS = /\bsource_(?:list_resources|read_resource)\b/

const cache = new Map<string, string>()
/** Each guide is opened once per file run (per-open I/O dominates this suite's time). */
function read(name: string): string {
  let text = cache.get(name)
  if (text === undefined) {
    text = readFileSync(join(DOCS_DIR, name), 'utf8')
    cache.set(name, text)
  }
  return text
}

/** Lines of `text` that match any pattern, as `line N: <text>` so a failure names the spot. */
function hits(text: string, patterns: RegExp[]): string[] {
  return text
    .split('\n')
    .flatMap((line, index) => (patterns.some(pattern => pattern.test(line)) ? [`line ${index + 1}: ${line.trim()}`] : []))
}

describe('the five guides v0.15.1 changed carry our reconciled text (UB14.51)', () => {
  it('each file holds the sentence its owning row landed (the read is real)', () => {
    expect(read('automations.md')).toContain('The label entry: the ID for a plain label')
    expect(read('automations.md')).toContain('`$NESSY_LABEL` | The label entry that was added/removed')
    expect(read('browser-tools.md')).toContain("`\\\"` or `\\'` for a literal quote character")
    expect(read('browser-tools.md')).toContain('Array mode (`["fill", "@e5"')
    expect(read('browser-tools.md')).toContain('`[password: N characters]`')
    expect(read('labels.md')).toContain('`valueType` decides whether a label carries values at all')
    expect(read('pages.md')).toContain('t-artifacts')
    expect(read('sources.md')).toContain('`source_list_prompts` / `source_get_prompt`')
    expect(read('sources.md')).toContain('`resource` (optional): RFC 8707 resource indicator')
  })

  it('labels.md no longer calls valueType "just a UI hint" (it decides whether a label carries values)', () => {
    // Upstream v0.15.1 keeps this sentence beside the one that contradicts it; ours follows the code (UB4.12).
    expect(read('labels.md')).not.toContain('`valueType` is just a UI hint')
    expect(read('labels.md')).not.toContain('Optional value type hint.')
  })
})

describe('no upstream brand, Claude-artifact publishing or upstream-only tool ships in the guides (UB14.51)', () => {
  const guides = readdirSync(DOCS_DIR).filter(name => name.endsWith('.md')).sort()

  it('enumerates the shipped guides, the five reconciled ones among them', () => {
    expect(guides.length).toBeGreaterThanOrEqual(20)
    for (const name of RECONCILED) expect(guides).toContain(name)
  })

  it('no shipped guide names the upstream brand', () => {
    expect(guides.flatMap(name => hits(read(name), [BRAND]).map(hit => `${name} ${hit}`))).toEqual([])
  })

  it('the five reconciled guides never offer publishing a page as a Claude artifact (DROP-b)', () => {
    expect(RECONCILED.flatMap(name => hits(read(name), CLAUDE_ARTIFACT_PUBLISH).map(hit => `${name} ${hit}`))).toEqual([])
  })

  it('no shipped guide names upstream resource tools we do not have', () => {
    expect(guides.flatMap(name => hits(read(name), [UPSTREAM_RESOURCE_TOOLS]).map(hit => `${name} ${hit}`))).toEqual([])
  })

  it('the instrument fires on upstream v0.15.1 wording and stays quiet on ours (planted control)', () => {
    const planted = [
      "With a Claude account connected, the desktop app's **Publish as Claude artifact** puts the page on claude.ai.",
      '| `LabelAdd` / `LabelRemove` | `$CRAFT_LABEL` | The label entry that was added/removed |',
      '- `source_list_resources` / `source_read_resource`: list a source\'s resources',
    ].join('\n')
    expect(hits(planted, CLAUDE_ARTIFACT_PUBLISH)).toHaveLength(1)
    expect(hits(planted, [BRAND])).toHaveLength(1)
    expect(hits(planted, [UPSTREAM_RESOURCE_TOOLS])).toHaveLength(1)
    // Our own wording for the same three facts matches nothing.
    const ours = [
      'The user publishes a page from its **Share** button: a view-only copy on the company\'s internal artifact service',
      '| `LabelAdd` / `LabelRemove` | `$NESSY_LABEL` | The label entry that was added/removed |',
      'Pi has `list_mcp_resources` / `read_mcp_resource`; prompts use `source_list_prompts` / `source_get_prompt`.',
    ].join('\n')
    expect(hits(ours, [BRAND, UPSTREAM_RESOURCE_TOOLS, ...CLAUDE_ARTIFACT_PUBLISH])).toEqual([])
  })
})
