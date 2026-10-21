import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { NessySymbol } from '@/components/icons/NessySymbol'
import { ClaudeIcon, OpenAiIcon, PiIcon } from '@/components/icons/runtime'
import { getProviderDisplayName, getProviderIcon } from '../provider-icons'

const GATEWAY_BASE_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1'

describe('getProviderIcon', () => {
  it('maps the runtime provider types to their mono brand marks', () => {
    expect(getProviderIcon('claude-runtime')).toEqual({ kind: 'component', Component: ClaudeIcon })
    expect(getProviderIcon('codex-runtime')).toEqual({ kind: 'component', Component: OpenAiIcon })
    expect(getProviderIcon('nestor-cloud-agent')).toEqual({ kind: 'component', Component: NessySymbol })
  })

  it('maps the subscription provider types to the same marks', () => {
    expect(getProviderIcon('anthropic')).toEqual({ kind: 'component', Component: ClaudeIcon })
    expect(getProviderIcon('openai')).toEqual({ kind: 'component', Component: OpenAiIcon })
  })

  it('shows the Nessy mark for pi connections pointed at the gateway', () => {
    expect(getProviderIcon('pi', GATEWAY_BASE_URL)).toEqual({ kind: 'component', Component: NessySymbol })
    expect(getProviderIcon('pi_compat', GATEWAY_BASE_URL)).toEqual({ kind: 'component', Component: NessySymbol })
  })

  it('falls back to the Pi mark for a pi connection whose upstream is unknown', () => {
    expect(getProviderIcon('pi_compat', 'https://example.internal/v1')).toEqual({ kind: 'component', Component: PiIcon })
    expect(getProviderIcon('pi', null, 'some-unmapped-provider')).toEqual({ kind: 'component', Component: PiIcon })
  })

  it('keeps url-kind icons for BYO providers with static assets or favicons', () => {
    const ollama = getProviderIcon('openai_compat', 'http://localhost:11434/ollama/v1')
    expect(ollama?.kind).toBe('url')
    expect((ollama as { kind: 'url'; url: string }).url).toContain('.svg')

    const groq = getProviderIcon('pi', null, 'groq')
    expect(groq).toEqual({
      kind: 'url',
      url: 'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&size=128&url=https://groq.com',
    })
  })

  it('returns null for a provider type it cannot place', () => {
    expect(getProviderIcon('some-unknown-provider')).toBeNull()
  })
})

describe('Moonshot hosts (UB7.7 / OQ-43.9 (a))', () => {
  it('shows the Moonshot AI label and the kimi icon for a Moonshot-host BYO connection', () => {
    expect(getProviderDisplayName('openai_compat', 'https://api.moonshot.ai/v1')).toBe('Moonshot AI')
    expect(getProviderDisplayName('openai_compat', 'https://api.moonshot.cn/v1')).toBe('Moonshot AI')

    const icon = getProviderIcon('openai_compat', 'https://api.moonshot.ai/v1')
    expect(icon?.kind).toBe('url')
    expect((icon as { kind: 'url'; url: string }).url).toContain('kimi.svg')

    const cn = getProviderIcon('openai_compat', 'https://api.moonshot.cn/v1')
    expect((cn as { kind: 'url'; url: string }).url).toContain('kimi.svg')
  })

  it('maps the Moonshot Pi auth providers to the kimi icon', () => {
    expect(getProviderIcon('pi', null, 'moonshotai')?.kind).toBe('url')
    expect((getProviderIcon('pi', null, 'moonshotai') as { kind: 'url'; url: string }).url).toContain('kimi.svg')
    expect((getProviderIcon('pi', null, 'moonshotai-cn') as { kind: 'url'; url: string }).url).toContain('kimi.svg')
  })

  it('keeps a non-Moonshot connection unchanged (the control)', () => {
    expect(getProviderDisplayName('openai_compat', 'https://api.kimi.com/v1')).toBe('Kimi')
    expect(getProviderDisplayName('openai_compat', 'https://openrouter.ai/v1')).toBe('OpenRouter')
    // The compat type's own name for an unrecognized host — never Moonshot.
    expect(getProviderDisplayName('openai_compat', 'https://example.internal/v1')).toBe('OpenAI')
    expect(getProviderDisplayName('openai_compat', 'https://example.internal/v1')).not.toBe('Moonshot AI')
  })

  it('pins the preset list closed: no Moonshot URL may become a preset (OQ-43.9 (a))', () => {
    // The grep pin: the presets live in ApiKeyInput.tsx; the OWNER's decision
    // (a) keeps Moonshot URLs out of the preset list — labels, icons and model
    // defaults only. Scoped to the PRESET SHAPE: the URL detector names the
    // hosts legitimately, what may never exist is a preset entry.
    const source = readFileSync(resolve(import.meta.dir, '../../components/apisetup/ApiKeyInput.tsx'), 'utf8')
    expect(source).not.toContain("key: 'moonshotai'")
    expect(source).not.toContain("url: 'https://api.moonshot")
    // The Kimi K3 defaults (upstream v0.15.1's list) are the row's model default.
    expect(source).toContain("COMPAT_KIMI_DEFAULTS = 'k3, kimi-for-coding, kimi-for-coding-highspeed'")
  })
})
