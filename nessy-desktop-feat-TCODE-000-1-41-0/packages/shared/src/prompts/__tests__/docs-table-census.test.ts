/**
 * UA12.59 — every shipped guide in `resources/docs` is either named in the
 * Configuration Documentation table the agent is actually shown, or recorded in
 * this file's written exclusion list with its reason.
 *
 * Before this row the table had no row for artifacts.md — UA1.21 shipped the
 * guide but pointed nothing at it, so the agent never learned it exists. The
 * census reads the RENDERED prompt on both slots that carry the table (Claude
 * and Pi; codex takes the developer-sections slot instead and has no docs
 * table), so a splice helper that stops being spliced fails here instead of
 * falling silent.
 *
 * UB12.81 — some rows are CONDITIONAL: they render only while the thing their
 * guide documents is offered (decisions.md, while the `decide` tool is). The
 * census therefore reads each slot twice: with every condition ON, where every
 * guide that is not EXCLUDED must be named, and as the DEFAULT render (the
 * fresh-install settings), where a CONDITIONAL guide is exempt for its stated
 * reason. The decision layer's one reader, `getDecisionLayerSettings`, is
 * stubbed for that: snapshot-spread, restored in afterAll.
 *
 * UB12.89 — the same condition renders upstream's "## Decision Model (`decide`)"
 * section after the LLM Tool section; its arms sit at the end of this file
 * because they need the same stub and the same two slots.
 */
import { afterAll, describe, expect, it, mock } from 'bun:test'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as realStorage from '../../config/storage.ts'
import { DEFAULT_DECISION_LAYER_SETTINGS, type DecisionLayerSettings } from '../../decisions/settings.ts'

const originals = {
  getDecisionLayerSettings: realStorage.getDecisionLayerSettings,
}

/** What the stubbed reader answers; `'throws'` plants an unreadable config. */
let decisionSettings: DecisionLayerSettings | 'throws' = DEFAULT_DECISION_LAYER_SETTINGS

mock.module('../../config/storage.ts', () => ({
  ...realStorage,
  getDecisionLayerSettings: () => {
    if (decisionSettings === 'throws') throw new Error('planted: config.json is unreadable')
    return decisionSettings
  },
}))

afterAll(() => {
  mock.module('../../config/storage.ts', () => ({
    ...realStorage,
    getDecisionLayerSettings: originals.getDecisionLayerSettings,
  }))
})

// Loaded AFTER the stub (F1.462): a static import is hoisted above mock.module.
const { getSystemPrompt } = await import('../system')

const DOCS_DIR = fileURLToPath(new URL('../../../../../apps/electron/resources/docs', import.meta.url))

/** Guides deliberately NOT in the table, each with the reason it must not be. */
const EXCLUDED = new Map<string, string>([
  // The human-facing CLI reference: it documents running `nessy-general-agent`
  // from a shell, which the in-session agent neither is nor launches.
  // DOC_REFS.nessyCli carries the path; no prompt surface reads it today.
  ['nessy-general-agent.md', 'the human-facing CLI reference — the in-session agent is not its audience'],
])

/**
 * Guides whose row renders only while what they document is offered, each with
 * why the DEFAULT render omits it. Named in the condition-ON render like any
 * other guide; exempt in the default render only.
 */
const CONDITIONAL = new Map<string, string>([
  // UB12.81 — upstream v0.15.1 system.ts L726–727 gates the row on
  // `decideToolActive`; ours reads what the host reads when it binds ctx.decide.
  ['decisions.md', 'its row renders only while the decide tool is offered (the decision layer switch AND its decideTool toggle); the layer ships off, so the default render omits it'],
])

const DECIDE_OFFERED: DecisionLayerSettings = {
  ...DEFAULT_DECISION_LAYER_SETTINGS,
  enabled: true,
  features: { ...DEFAULT_DECISION_LAYER_SETTINGS.features, decideTool: true },
}

type Slot = 'claude' | 'pi'

function render(slot: Slot, settings: DecisionLayerSettings | 'throws'): string {
  decisionSettings = settings
  try {
    return slot === 'claude'
      ? getSystemPrompt(undefined, undefined, undefined, undefined, undefined, undefined)
      : getSystemPrompt(undefined, undefined, undefined, undefined, 'default', 'Nessy Backend')
  } finally {
    decisionSettings = DEFAULT_DECISION_LAYER_SETTINGS
  }
}

const slots = {
  claude: { default: render('claude', DEFAULT_DECISION_LAYER_SETTINGS), allOn: render('claude', DECIDE_OFFERED) },
  pi: { default: render('pi', DEFAULT_DECISION_LAYER_SETTINGS), allOn: render('pi', DECIDE_OFFERED) },
}

/** The Configuration Documentation table of a rendered slot. */
function docsTable(prompt: string): string {
  const start = prompt.indexOf('## Configuration Documentation')
  expect(start, 'the Configuration Documentation heading moved').toBeGreaterThan(-1)
  const end = prompt.indexOf('\n## ', start + 1)
  expect(end, 'the section after Configuration Documentation moved').toBeGreaterThan(start)
  return prompt.slice(start, end)
}

describe('every shipped guide is named in the agent-facing docs table (UA12.59)', () => {
  const guides = readdirSync(DOCS_DIR).filter(name => name.endsWith('.md')).sort()

  it('the census enumerates the shipped guides (the directory did not move)', () => {
    expect(guides.length, 'resources/docs holds fewer guides than the census floor').toBeGreaterThanOrEqual(20)
    expect(guides).toContain('artifacts.md')
  })

  for (const slotName of ['claude', 'pi'] as const) {
    for (const [renderName, exempt] of [
      ['every condition on', EXCLUDED],
      ['default', new Map([...EXCLUDED, ...CONDITIONAL])],
    ] as const) {
      it(`the ${slotName} slot's ${renderName} table names every guide that is not exempt`, () => {
        const table = docsTable(renderName === 'default' ? slots[slotName].default : slots[slotName].allOn)
        // Positive control: the table carries most of the set, so an empty or
        // truncated extraction cannot pass as "everything named".
        const named = guides.filter(name => table.includes(name)).length
        expect(named, `${slotName} table names almost nothing — the extraction moved`).toBeGreaterThan(15)
        const missing = guides.filter(name => !table.includes(name) && !exempt.has(name))
        expect(missing, 'guides with no table row and no exemption').toEqual([])
      })
    }
  }

  it('artifacts.md specifically has its table row (the defect this row fixes)', () => {
    expect(docsTable(slots.claude.default)).toContain('artifacts.md')
    expect(docsTable(slots.pi.default)).toContain('artifacts.md')
  })

  it('the exclusion and conditional lists are honest: every entry ships on disk, carries a reason, and sits in one list', () => {
    for (const [name, reason] of [...EXCLUDED, ...CONDITIONAL]) {
      expect(guides, `${name} is exempted but not shipped`).toContain(name)
      expect(reason.length, `${name} is exempted without a stated reason`).toBeGreaterThan(0)
    }
    expect([...CONDITIONAL.keys()].filter(name => EXCLUDED.has(name))).toEqual([])
  })

  it('the instrument catches the defect it exists for (planted guide)', () => {
    // A name that ships nowhere must read as missing, not pass vacuously.
    const table = docsTable(slots.claude.allOn)
    const planted = [...guides, 'ghost-guide.md']
    const missing = planted.filter(name => !table.includes(name) && !EXCLUDED.has(name))
    expect(missing).toEqual(['ghost-guide.md'])
  })
})

describe('the decision model row follows the decide tool offer (UB12.81)', () => {
  const ROW = '| Decision Model |'

  it('is present on both slots while decide is offered (switch on, decideTool on), after the LLM Tool row', () => {
    for (const slotName of ['claude', 'pi'] as const) {
      const table = docsTable(slots[slotName].allOn)
      expect(table).toContain(`${ROW} \``)
      expect(table).toContain('decisions.md` | When using `decide` to classify, route or score items |')
      expect(table.indexOf(ROW), `${slotName}: upstream places it right after LLM Tool`).toBeGreaterThan(table.indexOf('| LLM Tool |'))
    }
  })

  it('is absent with the layer off (the shipped default), with decideTool off, and when the settings read throws', () => {
    expect(DEFAULT_DECISION_LAYER_SETTINGS.enabled, 'the layer ships off').toBe(false)
    const toggleOff: DecisionLayerSettings = {
      ...DECIDE_OFFERED,
      features: { ...DECIDE_OFFERED.features, decideTool: false },
    }
    for (const slotName of ['claude', 'pi'] as const) {
      expect(docsTable(slots[slotName].default)).not.toContain(ROW)
      expect(docsTable(render(slotName, toggleOff))).not.toContain(ROW)
      // Fail-closed: an unreadable config renders the prompt without the row.
      expect(docsTable(render(slotName, 'throws'))).not.toContain(ROW)
    }
  })
})

describe('the Decision Model section follows the decide tool offer (UB12.89)', () => {
  const HEADING = '\n## Decision Model (`decide`)\n'
  // craft-agents-oss v0.15.1 system.ts L877 (Apache-2.0), verbatim.
  const RULES = 'Rules: confidence below 0.5 means "unsure" — report it or ask instead of guessing. An answer is never permission: re-check before acting on it. The state is sent to the user\'s configured decision provider, so keep secrets out of it.'

  it('is present once on both slots while decide is offered, right after the LLM Tool section, naming decisions.md', () => {
    for (const slotName of ['claude', 'pi'] as const) {
      const prompt = slots[slotName].allOn
      const at = prompt.indexOf(HEADING)
      expect(at, `${slotName}: the section is missing while decide is offered`).toBeGreaterThan(-1)
      expect(prompt.indexOf(HEADING, at + 1), `${slotName}: the section renders twice`).toBe(-1)
      const section = prompt.slice(at + 1, prompt.indexOf('\n## ', at + 1))
      expect(section).toContain('Prefer it over `call_llm` when the answer is one of a fixed set of options')
      expect(section).toContain(RULES)
      expect(section).toMatch(/\nReference: `[^`]*decisions\.md`\n/)
      // Upstream's position: the next section up is LLM Tool, and Session Self-Management still follows.
      expect(prompt.lastIndexOf('\n## ', at - 1), `${slotName}: upstream places it right after LLM Tool`).toBe(prompt.indexOf('\n## LLM Tool (`call_llm`)'))
      expect(prompt.indexOf('\n## Session Self-Management'), slotName).toBeGreaterThan(at)
    }
  })

  it('is absent with the layer off (the shipped default), with decideTool off, and when the settings read throws', () => {
    const toggleOff: DecisionLayerSettings = {
      ...DECIDE_OFFERED,
      features: { ...DECIDE_OFFERED.features, decideTool: false },
    }
    for (const slotName of ['claude', 'pi'] as const) {
      // Positive control on the same instrument: the neighbour it is spliced beside is there.
      expect(slots[slotName].default).toContain('\n## LLM Tool (`call_llm`)\n')
      expect(slots[slotName].default).not.toContain(HEADING)
      expect(render(slotName, toggleOff)).not.toContain(HEADING)
      expect(render(slotName, 'throws')).not.toContain(HEADING)
    }
  })
})
