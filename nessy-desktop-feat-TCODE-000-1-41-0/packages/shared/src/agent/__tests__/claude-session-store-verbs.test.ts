/**
 * C3.282 — the vendored SDK's session-store verbs, and the decision about which
 * of them the host's past-session browsing reads.
 *
 * The decision itself — LIST no, READ not yet, `deleteSession` the one genuine
 * gap, rename/tag/fork declined, each with its reason — lives on
 * `agent/claude-session-persistence.ts`, which is the module that owns this
 * fork's relationship with the vendor's session store. This file is its
 * DENOMINATOR: the seven verbs are re-derived from the bundle rather than
 * recounted from prose (AGENTS.md, "prose enumerations beside a
 * single-source-of-truth list age silently"), and the import count is pinned so
 * a verb cannot start being used without the paragraph moving with it.
 *
 * THE GUARD MATCHES AN IMPORT, NEVER A BARE NAME. A name guard would fire on the
 * very docblock that explains the refusal — the stale-NAME trap AGENTS.md
 * records, which goes red on the commit that makes the code correct.
 *
 * ## C3.311 moved ONE verb across the line, and this file is where that shows
 *
 * `deleteSession` is now USED — `deleteClaudeVendorSession` calls it behind the
 * host's session delete, so a deleted conversation's vendor transcript goes with
 * it. C3.313 then moved `getSessionMessages` across the same line, as the
 * runtime-switch rebuild's confirmation that the file it wrote is one the
 * runtime will load. The guard therefore splits: the adopted verbs are asserted
 * PRESENT and the rest un-imported, which is what stops this file from going
 * quietly silent on the commits that changed the decision.
 *
 * `getSessionInfo` is deliberately on the DECLINED side even though it is the
 * obvious sibling of the verb beside it — it answers `undefined` for a loadable
 * transcript with no extractable summary, measured, so it cannot gate a resume.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The seven verbs C3.74 found exported. The denominator, whoever uses them. */
const STORE_VERBS = [
  'listSessions',
  'getSessionInfo',
  'getSessionMessages',
  'deleteSession',
  'renameSession',
  'tagSession',
  'forkSession',
] as const

/**
 * The one verb C3.311 wired. Split out of {@link STORE_VERBS} rather than
 * deleted from it, so the denominator stays seven and the two halves of the
 * decision are both visible here.
 */
const ADOPTED_VERBS = ['deleteSession', 'getSessionMessages'] as const

/** C3.282's remaining refusals — the half of the decision still standing. */
const DECLINED_VERBS = STORE_VERBS.filter(
  verb => !(ADOPTED_VERBS as readonly string[]).includes(verb),
)

function vendoredSdkTypes(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(dir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.d.ts')
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8')
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('no vendored sdk.d.ts found walking up from this file')
}

describe('C3.282 — the denominator', () => {
  it('all seven verbs are still declared by the vendored bundle', () => {
    const source = vendoredSdkTypes()

    for (const verb of STORE_VERBS) {
      expect({ verb, declared: source.includes(`declare function ${verb}`) })
        .toEqual({ verb, declared: true })
    }
    // Negative control on the identical instrument: without it a substring
    // search that matched anything would make all seven pass for no reason.
    expect(source.includes('declare function zzNotARealStoreVerbC3282')).toBe(false)
  })

  it('the two verbs C3.74 found ABSENT are still absent', () => {
    const source = vendoredSdkTypes()

    // The half of the decision that is about what the runtime CANNOT do: no
    // archive verb (codex has `thread/archive`) and no search verb. If either
    // appears, the "our store is the browsing surface" posture gains an
    // argument against it and the paragraph is due a re-read.
    expect(source.includes('declare function archiveSession')).toBe(false)
    expect(source.includes('declare function searchSessions')).toBe(false)
  })
})

describe('C3.282 — the decision is still what the code does', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const persistence = readFileSync(join(here, '..', 'claude-session-persistence.ts'), 'utf8')
  const agent = readFileSync(join(here, '..', 'claude-agent.ts'), 'utf8')

  it('the declined verbs are still used by neither claude module', () => {
    // Matches BOTH forms a use can take, because C3.311 introduced the second:
    // the static `import { … verb … } from '@anthropic-ai/claude-agent-sdk'`,
    // and the dynamic `const { verb } = await import('…')` the vendor delete
    // uses to keep the 1.4 MB bundle off the host's eager module graph. A guard
    // that knew only the static form would answer "unused" for a verb wired by
    // the dynamic one.
    for (const verb of DECLINED_VERBS) {
      expect({ verb, used: usesSdkVerb(persistence, verb) || usesSdkVerb(agent, verb) })
        .toEqual({ verb, used: false })
    }
  })

  it('the adopted verbs ARE used, which is the half C3.311 and C3.313 changed', () => {
    // The positive arm of the same instrument. Without it the loop above could
    // pass against a regex that can never match anything — and it is also the
    // tripwire that fires if the wiring is ever removed without this paragraph
    // moving back.
    for (const verb of ADOPTED_VERBS) {
      expect({ verb, used: usesSdkVerb(persistence, verb) }).toEqual({ verb, used: true })
    }
  })

  /**
   * One line of either shape, with the verb named on it and the SDK specifier
   * after it: the static import, or `await import('@anthropic-ai/…')`
   * destructured. Never a bare name — that would fire on the docblock that
   * explains each refusal.
   */
  function usesSdkVerb(source: string, verb: string): boolean {
    const staticForm = new RegExp(`import[^;\\n]*\\b${verb}\\b[^;\\n]*@anthropic-ai/claude-agent-sdk`)
    const dynamicForm = new RegExp(`\\b${verb}\\b[^;\\n]*await import\\([^;\\n]*@anthropic-ai/claude-agent-sdk`)
    return staticForm.test(source) || dynamicForm.test(source)
  }

  it('positive control: the probe DOES see the SDK imports those files really have', () => {
    // Without this the assertion above would pass against a regex that can
    // never match, which is the failure mode of every absence guard.
    expect(/import[^;\n]*\bOptions\b[^;\n]*@anthropic-ai\/claude-agent-sdk/.test(persistence)).toBe(true)
    expect(/import[^;\n]*\bquery\b[^;\n]*@anthropic-ai\/claude-agent-sdk/.test(agent)).toBe(true)
  })

  it('the decision is written down where the next reader will look', () => {
    // A posture with no visible statement is indistinguishable from a defect
    // (AGENTS.md, transparent-and-simple). Asserted on the SECTION heading
    // rather than on a sentence, so a reworded paragraph does not go red while
    // a DELETED decision does.
    expect(persistence).toContain('## The decision, verb by verb')
    expect(persistence).toContain('C3.282')
    // And each verb that moved carries its own reason where the decision is.
    expect(persistence).toContain('C3.311')
    expect(persistence).toContain('C3.313')
  })
})
