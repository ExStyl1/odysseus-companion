import { describe, it, expect } from 'bun:test';
import { mayStampProviderVerdict, terminalReasonFromPiErrorMessage } from '../provider-refusal.ts';

/**
 * P6.443. The input strings are not invented: they are the exact spellings
 * `mapStopReason` mints in the installed `@earendil-works/pi-ai`
 * (`dist/api/openai-completions.js`), which is why this mapping can be read off
 * the runtime instead of built beside it.
 */
describe('terminalReasonFromPiErrorMessage (P6.443)', () => {
  it('maps the wire\'s own refusal member to provider_refusal', () => {
    expect(terminalReasonFromPiErrorMessage('Provider finish_reason: content_filter'))
      .toBe('provider_refusal');
  });

  it('maps every other finish reason to provider_error, not to a guessed refusal', () => {
    expect(terminalReasonFromPiErrorMessage('Provider finish_reason: network_error'))
      .toBe('provider_error');
    // Pi passes an unrecognised reason through verbatim; we know the turn ended
    // abnormally and we do not know it was a refusal.
    expect(terminalReasonFromPiErrorMessage('Provider finish_reason: some_vendor_reason'))
      .toBe('provider_error');
  });

  it('CONTROL — an ordinary provider failure is NOT a finish reason and earns no verdict', () => {
    // These end a turn with `stopReason: "error"` too. Claiming a terminal
    // verdict over them is what the prefix match exists to prevent.
    expect(terminalReasonFromPiErrorMessage('500 Internal Server Error')).toBeUndefined();
    expect(terminalReasonFromPiErrorMessage('fetch failed: socket hang up')).toBeUndefined();
    expect(terminalReasonFromPiErrorMessage('Context window exceeded')).toBeUndefined();
  });

  it('CONTROL — an absent or empty message leaves the turn\'s verdict alone', () => {
    expect(terminalReasonFromPiErrorMessage(undefined)).toBeUndefined();
    expect(terminalReasonFromPiErrorMessage('')).toBeUndefined();
    expect(terminalReasonFromPiErrorMessage('Provider finish_reason: ')).toBeUndefined();
  });

  it('CONTROL — the prefix must be at the START, so a quoted mention is not a verdict', () => {
    expect(terminalReasonFromPiErrorMessage('upstream said "Provider finish_reason: content_filter"'))
      .toBeUndefined();
  });
});

describe('mayStampProviderVerdict (F1.297)', () => {
  it('does not stamp an agent_end the SDK will retry (willRetry: true)', () => {
    expect(mayStampProviderVerdict({ willRetry: true })).toBe(false);
  });

  it('CONTROL — stamps the closing agent_end of an attempt the SDK will not retry', () => {
    expect(mayStampProviderVerdict({ willRetry: false })).toBe(true);
    // An agent_end the SDK did not decorate (the structured-output loop's own) behaves as before.
    expect(mayStampProviderVerdict({})).toBe(true);
  });

  it('CONTROL — another authority\'s verdict is never overwritten', () => {
    expect(mayStampProviderVerdict({ terminalReason: 'auto_compaction_thrashing', willRetry: false })).toBe(false);
  });
});
