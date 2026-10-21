/**
 * P6.457 — the Bedrock model-id prefix is derived from the RESOLVED region, not
 * from the setup form's field.
 *
 * The row's `done_means` has two halves. The first landed with
 * `agent/bedrock-region.ts`: the connection reports the region and where it came
 * from. This is the second — *"the prefix is computed from that same value"* —
 * and until it landed an empty AWS Region field yielded `us` while the
 * environment the Pi subprocess inherits said something else, so the model id
 * and the endpoint disagreed with nothing said.
 *
 * ## Why this is a COMPOSITION test plus a source pin, and not a driven handler
 *
 * The expression lives inside `settings.SETUP_LLM_CONNECTION`, which also writes
 * credentials, mutates stored connections and calls the model-refresh service —
 * machinery out of all proportion to one derivation. The seam is therefore
 * exercised the way `byo-setup-test-seam.test.ts` exercises its own seam in this
 * same handler: the production functions, in the production order.
 *
 * That test also shows the failure mode of the pattern — its docblock still
 * cites `llm-connections.ts:330-346`, a line range that has since moved — so the
 * pin here reads the handler's SOURCE and asserts the spelling rather than
 * quoting a line number. It is what makes a revert to the raw form field fail
 * here rather than in production.
 *
 * No case assigns to `process.env`: `resolveBedrockRegion` takes its environment
 * as an argument, and in Bun 1.3.14 a name assigned to `process.env` is
 * invisible to a spread, so a mutating test would be measuring the wrong thing.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { deriveBedrockRegionPrefix, resolveCodexModelProvider, type LlmConnection } from '@nessy-agent/shared/config'
import { resolveBedrockRegion, resolveCodexBedrockCardRegion } from '@nessy-agent/shared/agent/bedrock-region'

/** The handler's own expression, spelled once. */
function prefixFor(
  formRegion: string | undefined,
  env: Record<string, string | undefined>,
): string {
  return deriveBedrockRegionPrefix(resolveBedrockRegion(formRegion, env)?.region)
}

describe('P6.457 — the prefix follows the resolved region', () => {
  it('takes the environment when the form field is empty, instead of falling to "us"', () => {
    // The whole defect, in one row: before this the answer was `us`.
    expect(prefixFor('', { AWS_REGION: 'eu-west-1' })).toBe('eu')
    expect(prefixFor(undefined, { AWS_DEFAULT_REGION: 'ap-southeast-2' })).toBe('apac')
  })

  it('still lets the connection credential outrank the environment', () => {
    // The direction matters: a user who typed a region must not have it
    // silently replaced by the machine's ambient one.
    expect(prefixFor('eu-central-1', { AWS_REGION: 'us-east-1' })).toBe('eu')
  })

  it('keeps "us" when no step this process can see answers', () => {
    // NOT a regression: the AWS SDK's own remaining steps (the active profile,
    // then instance metadata) decide the region, and `us` is the fallback the
    // prefix has always had. Without this row the two rows above would pass on
    // an implementation that had simply hardcoded a different default.
    expect(prefixFor(undefined, {})).toBe('us')
    expect(prefixFor('   ', { AWS_REGION: '  ' })).toBe('us')
  })
})

describe('P6.457 — the handler actually composes them this way', () => {
  it('derives the prefix from the resolver, not from the raw form field', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'llm-connections.ts'), 'utf-8')
    expect(source).toContain("from '@nessy-agent/shared/agent/bedrock-region'")
    expect(source).toContain('deriveBedrockRegionPrefix(resolvedRegion?.region)')
    // The exact spelling the row exists to remove. A revert reads naturally and
    // would otherwise be invisible here.
    expect(source).not.toContain('deriveBedrockRegionPrefix(setup.awsRegion)')
  })

  it('says which layer answered, so an unexplained prefix cannot ship', () => {
    // `describeBedrockRegion` is the one place that can say "resolved ELSEWHERE"
    // rather than "unset", which is the distinction the module was written for.
    const source = readFileSync(join(import.meta.dir, '..', 'llm-connections.ts'), 'utf-8')
    expect(source).toContain('describeBedrockRegion(resolvedRegion)')
  })
})

/**
 * F1.979 — `LIST_WITH_STATUS` gives the codex Bedrock card, and only that card,
 * the region codex's own provider will pick. Same shape as above: the production
 * functions in the handler's order, plus a pin on the handler's spelling. The
 * file reader answers nothing, so no case reads a real `~/.aws/config`.
 */
describe('F1.979 — the codex Bedrock card carries its region, no other card does', () => {
  const noFile = () => undefined
  const readingFor = (conn: Pick<LlmConnection, 'providerType' | 'codexModelProvider'>, env: Record<string, string | undefined>) =>
    resolveCodexBedrockCardRegion(resolveCodexModelProvider(conn, env), env, noFile)

  it('reads the region for the declared codex Bedrock card', () => {
    expect(readingFor({ providerType: 'codex-runtime', codexModelProvider: 'amazon-bedrock' }, { AWS_REGION: 'eu-west-1' }))
      .toEqual({ region: 'eu-west-1', source: 'AWS_REGION' })
  })

  it('reads nothing for a gateway codex card, a Pi card, or the Bedrock card the operator switched off', () => {
    const env = { AWS_REGION: 'eu-west-1' }
    expect(readingFor({ providerType: 'codex-runtime' }, env)).toBeUndefined()
    expect(readingFor({ providerType: 'pi', codexModelProvider: 'amazon-bedrock' }, env)).toBeUndefined()
    expect(readingFor({ providerType: 'codex-runtime', codexModelProvider: 'openai' }, env)).toBeUndefined()
    expect(readingFor({ providerType: 'codex-runtime', codexModelProvider: 'amazon-bedrock' }, { ...env, NESSY_CODEX_BEDROCK_CARD: '0' }))
      .toBeUndefined()
  })

  it('is what the list handler attaches, from the gated provider and this process env', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'llm-connections.ts'), 'utf-8')
    expect(source).toContain('resolveCodexBedrockCardRegion(resolveCodexModelProvider(conn), process.env, readTextFile)')
    expect(source).toContain('...(codexBedrockRegion ? { codexBedrockRegion } : {})')
  })
})
