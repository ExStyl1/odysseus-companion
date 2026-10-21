import { describe, expect, it } from 'bun:test';
import type { AskUserPermissionRequest } from '@nessy-agent/core/types';
import { analyzeConsentUrl, decodePunycodeHost, registrableDomain } from '../url-consent.ts';
import { handleMcpElicitationWithAskUser } from '../elicitation.ts';

/**
 * `elicitation.md:729`-`:730` — the two display SHOULDs of URL-mode elicitation.
 * The MUST at `:726` ("show the full URL") is asserted in every case here too,
 * because the highlight exists to sit BESIDE the full URL, never instead of it.
 */
describe('analyzeConsentUrl', () => {
  it('highlights the registrable domain of an ordinary URL and warns about nothing', () => {
    const consent = analyzeConsentUrl('https://corp.example.com/x');

    expect(consent).toEqual({
      url: 'https://corp.example.com/x',
      host: 'corp.example.com',
      registrableDomain: 'example.com',
      warnings: [],
    });
  });

  it('warns about a Punycode host and shows what it renders as', () => {
    // xn--pple-43d.com is "аpple.com" with a Cyrillic "а".
    const consent = analyzeConsentUrl('https://xn--pple-43d.com/authorize');

    expect(consent?.decodedHost).toBe('аpple.com');
    expect(consent?.warnings.map(warning => warning.kind)).toEqual(['punycode', 'mixed-script']);
    expect(consent?.warnings[1]?.detail).toBe('Latin + Cyrillic');
    // The full URL survives the analysis untruncated.
    expect(consent?.url).toBe('https://xn--pple-43d.com/authorize');
  });

  it('flags a subdomain-suffix lookalike and names the real site', () => {
    const consent = analyzeConsentUrl('https://accounts.example.com.attacker.net/oauth/authorize');

    expect(consent?.registrableDomain).toBe('attacker.net');
    expect(consent?.warnings.map(warning => warning.kind)).toEqual(['lookalike-suffix']);
    expect(consent?.url).toBe('https://accounts.example.com.attacker.net/oauth/authorize');
  });

  it('flags a URL that hides its host behind embedded credentials', () => {
    const consent = analyzeConsentUrl('https://accounts.example.com@attacker.net/authorize');

    expect(consent?.host).toBe('attacker.net');
    expect(consent?.warnings.map(warning => warning.kind)).toEqual(['embedded-credentials']);
  });

  it('does not mistake a legitimate two-level public suffix for the registrable domain', () => {
    expect(registrableDomain('mail.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('example.com')).toBe('example.com');
    // An address has no registrable domain; the card falls back to the host.
    expect(registrableDomain('192.0.2.10')).toBeUndefined();
    expect(analyzeConsentUrl('https://192.0.2.10/authorize')?.registrableDomain).toBeUndefined();
  });

  it('leaves a host with no Punycode label unchanged when decoding', () => {
    expect(decodePunycodeHost('corp.example.com')).toBe('corp.example.com');
    expect(decodePunycodeHost('xn--80ak6aa92e.com')).toBe('аррӏе.com');
  });

  it('returns nothing for a URL it cannot parse', () => {
    expect(analyzeConsentUrl('not a url')).toBeUndefined();
  });
});

describe('URL-mode elicitation carries the consent panel', () => {
  const urlRequest = (url: string) => ({
    method: 'elicitation/create',
    params: { mode: 'url', message: 'Authorize the app', elicitationId: 'e-1', url },
  }) as never;

  const runWithUrl = async (url: string): Promise<AskUserPermissionRequest[]> => {
    const asked: AskUserPermissionRequest[] = [];
    await handleMcpElicitationWithAskUser(
      urlRequest(url),
      async (request) => {
        asked.push(request);
        return { type: 'option', optionIndex: 1, value: request.options[1]! };
      },
      { openUrl: async () => {} },
    );
    return asked;
  };

  it('attaches the analysis to the SAME dialog that takes consent', async () => {
    const asked = await runWithUrl('https://xn--pple-43d.com/authorize');

    expect(asked).toHaveLength(1);
    expect(asked[0]!.options).toEqual(['Open separately', 'Cancel']);
    expect(asked[0]!.urlConsent?.warnings.map(warning => warning.kind))
      .toEqual(['punycode', 'mixed-script']);
    // The `:726` MUST, still satisfied in text for clients that ignore the field.
    expect(asked[0]!.question).toContain('https://xn--pple-43d.com/authorize');
  });

  it('shows the highlight and no warning for an ordinary URL', async () => {
    const asked = await runWithUrl('https://corp.example.com/x');

    expect(asked[0]!.urlConsent).toEqual({
      url: 'https://corp.example.com/x',
      host: 'corp.example.com',
      registrableDomain: 'example.com',
      warnings: [],
    });
  });
});
