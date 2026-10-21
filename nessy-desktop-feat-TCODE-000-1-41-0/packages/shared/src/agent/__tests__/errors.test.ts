import { describe, expect, it } from 'bun:test'
import { allErrorRecoveryActions, parseError } from '../errors.ts'

describe('parseError proxy interception handling', () => {
  it('maps interceptor proxy marker message to proxy_error', () => {
    const message = 'Received an unexpected HTML error page (HTTP 400) instead of a JSON API response. This may be caused by your network proxy (http://example.com:8080). Check your proxy settings in Settings > Network.'
    const parsed = parseError(new Error(message))

    expect(parsed.code).toBe('proxy_error')
    expect(parsed.message).toBe(message)
  })

  it('maps raw Cloudflare HTML error page to proxy_error with sanitized message', () => {
    const rawHtml = `<html>
<head><title>400 Bad Request</title></head>
<body>
<center><h1>400 Bad Request</h1></center>
<hr><center>cloudflare</center>
</body>
</html>`

    const parsed = parseError(new Error(rawHtml))

    expect(parsed.code).toBe('proxy_error')
    expect(parsed.message).toContain('unexpected HTML error page')
    expect(parsed.message).toContain('HTTP 400')
    expect(parsed.message.toLowerCase()).toContain('proxy settings')
    expect(parsed.message.toLowerCase()).not.toContain('<html')
    expect(parsed.originalError).toBe(rawHtml)
  })

  it('does not remap regular 401 auth errors as proxy_error', () => {
    const parsed = parseError(new Error('401 Unauthorized'))

    expect(parsed.code).toBe('invalid_api_key')
  })
})

describe('parseError tool-support classification', () => {
  // Regression for the misclassification in the screenshot: an Anthropic
  // cache_control TTL ordering error mentioning `tools` in its hint string
  // was being labeled "Model Does Not Support Tools". It's an invalid_request,
  // not a tool-support refusal.
  const CACHE_CONTROL_ORDERING_ERROR =
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"system.0.cache_control.ttl: ' +
    'a ttl=\'1h\' cache_control block must not come after a ttl=\'5m\' cache_control block. ' +
    'Note that blocks are processed in the following order: `tools`, `system`, `messages`."}}'

  it('does NOT classify cache_control TTL ordering errors as model_no_tool_support', () => {
    const parsed = parseError(new Error(CACHE_CONTROL_ORDERING_ERROR))
    expect(parsed.code).not.toBe('model_no_tool_support')
  })

  it('classifies cache_control TTL ordering errors as invalid_request', () => {
    const parsed = parseError(new Error(CACHE_CONTROL_ORDERING_ERROR))
    expect(parsed.code).toBe('invalid_request')
  })

  it('still classifies explicit tool-support refusals as model_no_tool_support', () => {
    const cases = [
      'No endpoints found that support tool use for this model',
      'The model gpt-3.5-turbo-instruct does not support tools',
      'tool_use is not supported by this model',
      'function calling not available on this endpoint',
    ]
    for (const message of cases) {
      const parsed = parseError(new Error(message))
      expect(parsed.code).toBe('model_no_tool_support')
    }
  })
})

// ============================================================
// P3.138 — the `invalid_request` details line, and its three guards
// ============================================================
//
// The cross-arm claim lives in `pi-image-refusal-legibility.test.ts`; this is
// the branch's own behaviour, next to the classification tests it depends on.
//
// ONE FACT ABOUT THE INPUTS, measured while writing these and worth stating
// because it makes half of them look arbitrary otherwise: the classifying
// branch matches `invalid_request_error` OR the literal `400 ` WITH A TRAILING
// SPACE. So `400: <non-JSON body>` — the colon spelling with nothing else in it
// — is `unknown_error`, not `invalid_request`, and never reaches this code at
// all. It is not a gap on the Pi arm: pi-ai's `formatProviderError` forwards the
// whole JSON envelope, which always carries the `type` field.

describe('parseError invalid_request carries the API message (P3.138)', () => {
  it('lifts the sentence out of an OpenAI-wire envelope', () => {
    const parsed = parseError(new Error(
      '400: {"message":"Model Does Not Support Image Inputs","type":"invalid_request_error","code":null}',
    ))
    // P6.707 moved this ONE sentence to its own anchor — it is a named image
    // refusal, and the learned-refusal writer matches on the anchor rather than
    // on prose. The envelope-lifting this test is about is unchanged and is
    // what puts the sentence in the line at all; only the prefix moved. The
    // generic-prefix arm is asserted two tests down, on a message that is not
    // an image refusal.
    expect(parsed.details).toContain('Image input refused by the endpoint: Model Does Not Support Image Inputs')
  })

  it('lifts it out of the Anthropic-wire envelope too, which nests it', () => {
    // The same shape the cache_control regression above uses (restated rather
    // than shared: that constant is scoped to its own describe), so both wire
    // formats are real rather than one being hypothetical.
    const parsed = parseError(new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"system.0.cache_control.ttl: '
      + 'a ttl=\'1h\' cache_control block must not come after a ttl=\'5m\' cache_control block."}}',
    ))
    expect(parsed.code).toBe('invalid_request')
    expect(parsed.details?.[0]).toContain('a ttl=\'1h\' cache_control block must not come after')
    expect(parsed.details?.[0]).toStartWith('API message: ')
  })

  it('strips the status prefix when there is no envelope to read', () => {
    // The fallback arm: no braces, so the envelope reader declines and the
    // prefix strip is what produces the line. A status number is not something
    // to print in a line labelled with the API's own name — it is already the
    // `Status:` line on the claude arm.
    expect(parseError(new Error('400 request was malformed')).details)
      .toContain('API message: request was malformed')
  })

  it('GUARD: refuses an HTML payload rather than putting markup in a details line', () => {
    // A full error page never gets here — `isLikelyProxyInterception` claims it
    // several branches earlier, which the control below proves on the same rig.
    // This guard is the RESIDUE: markup thin enough to miss those heuristics
    // still reaches the 400 branch, and must not become a details line.
    const bare = parseError(new Error('400 <html>x</html>'))
    expect(bare.code).toBe('invalid_request')
    expect(bare.details).toBeUndefined()

    expect(parseError(new Error('400 <html><head><title>Bad Request</title></head></html>')).code)
      .toBe('proxy_error')
  })

  it('GUARD: caps the line at the length the panel beside it already truncates to', () => {
    // `ChatDisplay` renders `originalError` as `Raw: …` sliced at 200 in the
    // same collapsed section, so a longer detail line would print more of the
    // payload than the line next to it.
    const long = 'x'.repeat(400)
    const detail = parseError(new Error(`400: {"message":"${long}","type":"invalid_request_error"}`)).details?.[0]
    expect(detail).toBeDefined()
    expect(detail!.endsWith('...')).toBe(true)
    expect(detail!.length).toBe('API message: '.length + 203)
  })

  it('GUARD: says nothing rather than saying the generic sentence twice', () => {
    const parsed = parseError(new Error(
      '400: {"message":"The API rejected this request.","type":"invalid_request_error"}',
    ))
    expect(parsed.code).toBe('invalid_request')
    expect(parsed.message).toBe('The API rejected this request.')
    expect(parsed.details).toBeUndefined()
  })

  it('CONTROL: another code is untouched — this is not a change to every error', () => {
    // `rate_limited` classifies from the same function and must still come back
    // with no details at all, so a green run above cannot come from a details
    // field that was added everywhere.
    const parsed = parseError(new Error('429 rate limit exceeded'))
    expect(parsed.code).toBe('rate_limited')
    expect(parsed.details).toBeUndefined()
  })
})

/**
 * D1.283 — a recovery action that names nothing executable is a DEAD BUTTON,
 * and the class hid twice in one entry.
 *
 * `token_expired` (and `mcp_auth_required`) declared
 * `{ key: 'w', label: 'Open workspace menu', command: '/workspace' }` with no
 * `action`. The renderer's wire mapper dropped `command` on the way, so the
 * button arrived carrying a label and nothing else; and `/workspace` is a
 * command this product does not have — it is in no `SlashCommandId`, no
 * `parseSessionCommand` branch and no handler — so carrying the field would
 * only have dispatched a command nobody implements. Both are closed, and these
 * two cases are what keeps them closed.
 */
describe('D1.283 · every recovery action names something the renderer can execute', () => {
  /** The four the renderer's `handleErrorMessageAction` actually runs. */
  const EXECUTABLE_ACTIONS = new Set(['retry', 'settings', 'reauth', 'open_url']);

  it('no action is command-only, and the census is reading real rows', () => {
    const commandOnly = allErrorRecoveryActions().flatMap(([code, actions]) =>
      actions
        .filter(action => action.action === undefined)
        .map(action => `${code}: ${action.label} (${action.command ?? 'no command'})`));

    expect(commandOnly).toEqual([]);

    // The positive control: an accessor that answered nothing would make the
    // assertion above pass while seeing no action at all.
    const total = allErrorRecoveryActions().reduce((count, [, actions]) => count + actions.length, 0);
    expect(total).toBeGreaterThan(20);
  });

  it('every declared action is one the renderer runs', () => {
    const unexecutable = allErrorRecoveryActions().flatMap(([code, actions]) =>
      actions
        .filter(action => action.action !== undefined && !EXECUTABLE_ACTIONS.has(action.action))
        .map(action => `${code}: ${action.action}`));

    // D1.293 — the set below and the wire union are now the same four names, so
    // this case reads as tautological and is not: `ERROR_DEFINITIONS` is authored
    // against `RecoveryAction`, and the day a fifth code is added to the union
    // (the shape that was just retired for having no destination) a definition
    // can start producing it here before the renderer grows a branch. This is
    // where that is met; the renderer's own compile-time binding is the other
    // half, and neither alone covers both directions.
    expect(unexecutable).toEqual([]);
  });

  it('and the only slash command any action names is one the product has', () => {
    const commands = new Set(
      allErrorRecoveryActions()
        .flatMap(([, actions]) => actions.map(action => action.command))
        .filter((command): command is string => command !== undefined));

    // `/settings` is a real `SlashCommandId`. `/workspace` was not, which is
    // the half of this row that no type could catch.
    expect([...commands].sort()).toEqual(['/settings']);
  });
});
