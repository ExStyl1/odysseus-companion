import { afterEach, describe, expect, it } from 'bun:test'
import type { LlmConnection } from '../storage.ts'
import {
  clearClaudeCloudProviderRoutingEnvVars,
  resolveAuthEnvVars,
  resetManagedAnthropicAuthEnvVars,
} from '../llm-connections.ts'
import { CLAUDE_SDK_STRIPPED_ENV_KEYS } from '../claude-provider-routing-env.ts'

// Table-driven over the EXPORTED constant so this suite cannot drift from the
// production strip list again — the hand-copied duplicate list is exactly how
// Vertex/Foundry/Mantle went missing. AWS_REGION is the surviving control: an
// absence claim proves nothing without something on the same rig that stays.
const ROUTING_KEYS = CLAUDE_SDK_STRIPPED_ENV_KEYS
const ENV_KEYS = [...ROUTING_KEYS, 'AWS_REGION'] as const

/** A distinct dummy value per key, so a wrong survivor is identifiable. */
function dummyValue(key: string): string {
  return `test-value-${key.toLowerCase()}`
}

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
)

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key)
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

afterEach(() => {
  restoreEnv()
})

function createBedrockConnection(
  overrides: Partial<LlmConnection> = {},
): LlmConnection {
  return {
    slug: 'bedrock-test',
    name: 'Bedrock Test',
    providerType: 'bedrock',
    authType: 'bearer_token',
    awsRegion: 'us-east-1',
    createdAt: Date.now(),
    ...overrides,
  } as LlmConnection
}

describe('Claude cloud-provider routing env handling', () => {
  it('resolveAuthEnvVars does not enable any Claude cloud-provider routing for bedrock connections', async () => {
    // Per packages/shared/AGENTS.md: "Pi Bedrock uses its own AWS env path
    // instead." resolveAuthEnvVars is Anthropic-SDK-only and short-circuits
    // for non-Anthropic providers (including bedrock); the Pi backend wires
    // AWS credentials in its own postInit() path. The contract this test
    // protects is that none of the Claude-specific cloud-provider routing env
    // vars — which would mis-route the Claude SDK subprocess to another
    // provider — leak out.
    const connection = createBedrockConnection()
    const credentialManager = {
      getLlmApiKey: async () => 'bedrock-bearer-token',
      getLlmIamCredentials: async () => null,
    }

    const result = await resolveAuthEnvVars(
      connection,
      connection.slug,
      credentialManager as any,
      async () => ({}),
    )

    expect(result.success).toBe(true)
    for (const key of ROUTING_KEYS) {
      expect({ key, value: result.envVars[key] }).toEqual({ key, value: undefined })
    }
  })

  it('clearClaudeCloudProviderRoutingEnvVars removes the whole routing set and nothing else', () => {
    // Positive path: all keys of the exported constant set, all stripped.
    const env: Record<string, string | undefined> = Object.fromEntries(
      ENV_KEYS.map((key) => [key, dummyValue(key)]),
    )
    env.AWS_REGION = 'us-east-1'

    clearClaudeCloudProviderRoutingEnvVars(env)

    for (const key of ROUTING_KEYS) {
      expect({ key, value: env[key] }).toEqual({ key, value: undefined })
    }
    // Negative: generic AWS_* survives — the narrow-strip guarantee.
    expect(env.AWS_REGION).toBe('us-east-1')
  })

  it('resetManagedAnthropicAuthEnvVars clears the routing set from process env', () => {
    for (const key of ROUTING_KEYS) {
      process.env[key] = dummyValue(key)
    }
    process.env.AWS_REGION = 'us-east-1'

    resetManagedAnthropicAuthEnvVars()

    for (const key of ROUTING_KEYS) {
      expect({ key, value: process.env[key] }).toEqual({ key, value: undefined })
    }

    // AWS_REGION is restored to its baseline, not force-deleted.
    const originalRegion = originalEnv.get('AWS_REGION')
    if (originalRegion === undefined) {
      expect(process.env.AWS_REGION).toBeUndefined()
    } else {
      expect(process.env.AWS_REGION).toBe(originalRegion)
    }
  })
})
