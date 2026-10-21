/**
 * DA2.6 — the disclosure the renderer owes, and the four targets that owe none.
 *
 * The FIRST case is the negative control, for the same reason the provenance
 * suite beside it opens with one: a helper that answered "disclosure owed" for
 * everything would satisfy every positive expectation below while badging the
 * corporate gateway itself, which is the one target the whole mechanism exists
 * to distinguish.
 */

import { describe, expect, it } from 'bun:test'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'
import { NESSY_GATEWAY_BASE_URL } from '../../components/apisetup/nessy-gateway'
import { modelTargetDisclosure } from '../model-target-disclosure'

/**
 * DA2.23 — the picker's half of the disclosure moved OUT of
 * `CompactModelSelector.tsx` into a block both pickers render, because the
 * desktop `DropdownMenu` picker rendered neither line and RS-44 measured it on
 * a packaged build. The source arm below follows it; that both pickers call the
 * block, and that neither keeps a copy, is pinned where it can fail —
 * `components/app-shell/input/__tests__/model-list-disclosures.test.tsx`.
 */
const PICKER_DISCLOSURES = new URL('../../components/app-shell/input/ModelListDisclosures.tsx', import.meta.url).pathname
const CONNECTION_ROW = new URL('../../components/app-shell/input/ConnectionRow.tsx', import.meta.url).pathname

describe('modelTargetDisclosure', () => {
  it('owes NOTHING for the four unrestricted classes (the control)', () => {
    // The verified gateway, whatever the model id looks like.
    expect(modelTargetDisclosure({ baseUrl: NESSY_GATEWAY_BASE_URL, model: 'anthropic/claude' })).toBeNull()
    // A loopback adapter — the claude/codex runtimes' own local shim.
    expect(modelTargetDisclosure({ baseUrl: 'http://127.0.0.1:8123/v1', model: 'openai/gpt' })).toBeNull()
    // A namespace served inside the perimeter.
    expect(modelTargetDisclosure({ baseUrl: 'https://llm.example.com/v1', model: 'tgpt/deepseek-v4' })).toBeNull()
    // D1.246 — the Nessy Cloud Agent, which is the ONE endpoint-less connection
    // that owes nothing: it runs inside the perimeter and configures no endpoint
    // of its own, and `classifyModelTarget` carves it out by that declaration.
    // The line that used to stand here asserted the OPPOSITE of today's rule —
    // `{ model: 'claude-opus-4-8' }` with no provider — and it was the picker's
    // under-disclosure written down as an expectation.
    expect(modelTargetDisclosure({ model: 'claude-opus-4-8', providerType: 'nestor-cloud-agent' })).toBeNull()
  })

  it('D1.246 — an endpoint-less connection now DISCLOSES, with no host to name', () => {
    // The row itself: the backend has failed closed on this since D1.221 (a
    // subscription card is sent by its runtime to the vendor's own API), while
    // the picker showed nothing at all for the same session. Both arms —
    // provider named, provider unknown — because the helper must not depend on
    // its caller remembering the third fact.
    for (const facts of [
      { model: 'claude-opus-4-8', providerType: 'claude-runtime' },
      { model: 'gpt-5-codex' },
    ]) {
      const owed = modelTargetDisclosure(facts)
      expect(owed, JSON.stringify(facts)).not.toBeNull()
      // Nothing to print: the surface uses the host-free sentence rather than
      // interpolating an empty string into the one that promises a name.
      expect(owed?.host).toBe('')
      expect(owed?.knownExternalVendor).toBe(false)
    }
  })

  it('F1.572 — both ChatGPT subscription cards name chatgpt.com, the host the backend already names', () => {
    // D1.221's under-disclosure residue: the backend derives these endpoints
    // (`modelTargetBaseUrlForConnection`) and withholds against chatgpt.com,
    // while this surface had only `baseUrl`, which neither card stores, and
    // printed the host-free sentence.
    const cards = [
      // The ChatGPT (Codex) card (F1.202): codex's own `openai` provider.
      { model: 'gpt-6-astra', providerType: 'codex-runtime', codexModelProvider: 'openai' },
      // The Pi ChatGPT Plus card: Pi's `openai-codex` sign-in.
      { model: 'gpt-5.1-codex', providerType: 'pi', piAuthProvider: 'openai-codex' },
    ]
    for (const facts of cards) {
      const owed = modelTargetDisclosure(facts)
      const host = owed?.host
      expect(host, JSON.stringify(facts)).toBe('chatgpt.com')
    }
    // The same derivation names the SDK default for an endpoint-less direct
    // `anthropic` card (Claude Pro / Max), which the backend already named.
    expect(modelTargetDisclosure({ model: 'claude-opus-4-8', providerType: 'anthropic' })?.host).toBe('api.anthropic.com')
  })

  it('F1.572 CONTROL — the gateway cards and a codex card with no declared provider are unchanged', () => {
    expect(modelTargetDisclosure({
      baseUrl: NESSY_GATEWAY_BASE_URL, model: 'tgpt/deepseek-v4-flash-0731', providerType: 'codex-runtime',
    })).toBeNull()
    expect(modelTargetDisclosure({ baseUrl: NESSY_GATEWAY_BASE_URL, model: 'tgpt/x', providerType: 'pi' })).toBeNull()
    // An endpoint-less codex card that declared no provider keeps D1.246's host-free verdict.
    expect(modelTargetDisclosure({ model: 'gpt-6-astra', providerType: 'codex-runtime' })?.host).toBe('')
  })

  it('owes a disclosure for a known external vendor namespace, and names the HOST', () => {
    const owed = modelTargetDisclosure({ baseUrl: 'https://llm.example.com/v1', model: 'anthropic/claude-opus' })

    expect(owed).not.toBeNull()
    expect(owed?.host).toBe('llm.example.com')
    expect(owed?.knownExternalVendor).toBe(true)
  })

  it('owes one for an endpoint it cannot place, and says so with the flag', () => {
    // An unprefixed model id on a third-party endpoint: the classifier cannot
    // place it, and DA2.1's resolution is that an unplaceable target discloses
    // ANYWAY. The flag is what keeps a surface from calling this a vendor.
    const owed = modelTargetDisclosure({ baseUrl: 'https://vendor.example.org/v1', model: 'gpt-4o' })

    expect(owed).not.toBeNull()
    expect(owed?.host).toBe('vendor.example.org')
    expect(owed?.knownExternalVendor).toBe(false)
  })

  it('never lets a credential or a path reach the rendered host', () => {
    // The boundary this surface has to hold: the verdict's host is PARSED, so a
    // secret in the query string of a stored baseUrl cannot be printed under a
    // model list. Read into a local first, then assert on it.
    const owed = modelTargetDisclosure({
      baseUrl: 'https://vendor.example.org/v1/models?key=fabricated-not-a-real-secret',
      model: 'anthropic/claude',
    })
    const host = owed?.host ?? ''

    expect(host).toBe('vendor.example.org')
    expect(host).not.toContain('key=')
    expect(host).not.toContain('/')
  })
})

/**
 * The surfaces, asserted on their SOURCE rather than rendered.
 *
 * Rendering either of these costs a React tree plus the picker's whole import
 * graph, and the question here is only whether the verdict and its two keys
 * reach the markup — which the text answers exactly. Same instrument, and the
 * same reason, as the pdfjs note in AGENTS.md §Traps.
 */
describe('the two surfaces that carry the disclosure (DA2.6)', () => {
  it('the model pickers\' shared block renders the host sentence under the list', async () => {
    const source = await Bun.file(PICKER_DISCLOSURES).text()

    expect(source).toContain('modelTargetDisclosure')
    // Spelled as a LITERAL, never composed: a composed key is invisible to
    // `check-i18n-reachable`, which would report it unreachable and send the
    // next reader to delete it.
    expect(source).toContain("t('chat.modelPicker.toolEgressDisclosure'")
    // D1.246 — both halves: the third fact reaches the classifier, and the
    // host-free sentence exists for the verdict that has no host.
    expect(source).toContain('providerType: connection?.providerType')
    expect(source).toContain("t('chat.modelPicker.toolEgressProviderDefault')")
    // F1.572 — the two facts the endpoint derivation needs for a subscription card.
    expect(source).toContain('codexModelProvider: connection?.codexModelProvider')
    expect(source).toContain('piAuthProvider: connection?.piAuthProvider')
  })

  it('the connection rows carry the mark, with the host sentence on its title', async () => {
    const source = await Bun.file(CONNECTION_ROW).text()

    expect(source).toContain('modelTargetDisclosure')
    expect(source).toContain("t('chat.modelPicker.toolEgressBadge')")
    expect(source).toContain("t('chat.modelPicker.toolEgressDisclosure'")
    expect(source).toContain('providerType: connection.providerType')
    expect(source).toContain("t('chat.modelPicker.toolEgressProviderDefault')")
    // F1.572 — as on the picker.
    expect(source).toContain('codexModelProvider: connection.codexModelProvider')
    expect(source).toContain('piAuthProvider: connection.piAuthProvider')
  })
})

/**
 * Words a disclosure of this shape must never contain, in either locale.
 *
 * Lower-cased before the comparison, so a capitalised sentence cannot slip one
 * past. Two English and two Russian stems rather than whole words: the Russian
 * pair inflects, and a stem catches every form of it.
 */
const CONCEALMENT_CLAIMS: readonly string[] = ['hidden', 'withheld', 'blocked', 'скрыт', 'заблокир']

describe('the copy never claims a withholding — the superseded half stays dropped (DA2.6)', () => {
  it('discloses a SEND in both locales, and says nothing is kept back', () => {
    // The claim this case refuses: that THESE TWO SENTENCES — the ones that
    // disclose a SEND — start describing a withholding. They must not, because
    // what they promise is unchanged: the schemas still go to that host.
    //
    // The reason has moved and the case has not (2026-09-17). It used to read
    // "nothing conceals anything", resting on DA2.2's pool filter being an open
    // owner question. DA2.14 answered it and the filter landed
    // (`applyExternalModelMcpWhitelist`, `packages/shared/src/mcp/runtime-pool-servers.ts`),
    // so a withholding now EXISTS — and is told by its own count-free line,
    // `chat.modelPicker.toolEgressWithholding` (DA1.69), which this case does
    // not read. That separation is what the two-key loop below enforces: a
    // sentence about the SEND may never borrow the other line's claim, and the
    // new key cannot satisfy this case by existing.
    //
    // The guard sits over the LOCALE VALUES rather than over the two .tsx
    // sources, because the claim IS the copy and only the copy. A source guard
    // would fire on the comments that explain the decision, which is the
    // stale-NAME trap AGENTS.md records: a guard that goes red on the commit
    // that makes it true.
    //
    // `toContain('{{host}}')` is the positive control of this case, not a
    // second assertion: a missing key would read as an empty string here and
    // satisfy every `not.toContain` below while proving nothing.
    for (const locale of [en, ru] as Record<string, string>[]) {
      const disclosure = locale['chat.modelPicker.toolEgressDisclosure'] ?? ''
      const badge = locale['chat.modelPicker.toolEgressBadge'] ?? ''
      // D1.246's host-free twin is a SEND sentence too, and is held to the same
      // promise — it is the one a subscription card actually gets.
      const providerDefault = locale['chat.modelPicker.toolEgressProviderDefault'] ?? ''

      expect(disclosure).toContain('{{host}}')
      expect(badge.length).toBeGreaterThan(0)
      // The positive control for the new key, and the shape that distinguishes
      // it: it must NOT carry the placeholder, because there is no host.
      expect(providerDefault.length).toBeGreaterThan(0)
      expect(providerDefault).not.toContain('{{host}}')

      for (const claim of CONCEALMENT_CLAIMS) {
        expect(disclosure.toLowerCase()).not.toContain(claim)
        expect(badge.toLowerCase()).not.toContain(claim)
        expect(providerDefault.toLowerCase()).not.toContain(claim)
      }
    }
  })
})
