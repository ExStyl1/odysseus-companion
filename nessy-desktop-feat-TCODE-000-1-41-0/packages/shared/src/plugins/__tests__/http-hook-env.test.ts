/**
 * R22: http-hook env interpolation and the managed URL allowlist matcher.
 *
 * settings.md contract: `$VAR`/`${VAR}` references in http hook headers resolve
 * only for names on the hook's `allowedEnvVars` list (intersected with the
 * managed `httpHookAllowedEnvVars` key by the caller); unlisted references are
 * replaced with the empty string. URL patterns match hostnames
 * case-insensitively, ignore a trailing FQDN dot, and support `*` wildcard
 * segments.
 */

import { describe, expect, it } from 'bun:test';
import { interpolateHttpHookHeaders, matchesHttpHookUrlPattern } from '../http-hook-env.ts';

describe('interpolateHttpHookHeaders', () => {
  const cases: Array<{
    name: string;
    h: Record<string, string>;
    allowed: string[];
    env: Record<string, string>;
    want: Record<string, string>;
  }> = [
    { name: 'plain $VAR', h: { A: 'Bearer $TOKEN' }, allowed: ['TOKEN'], env: { TOKEN: 'x' }, want: { A: 'Bearer x' } },
    { name: 'braced ${VAR}', h: { A: 'Bearer ${TOKEN}' }, allowed: ['TOKEN'], env: { TOKEN: 'x' }, want: { A: 'Bearer x' } },
    { name: 'unlisted ref becomes empty string', h: { A: '$SECRET' }, allowed: [], env: { SECRET: 's' }, want: { A: '' } },
    { name: 'mixed listed and unlisted', h: { A: '$TOKEN-$SECRET' }, allowed: ['TOKEN'], env: { TOKEN: 'x', SECRET: 's' }, want: { A: 'x-' } },
    { name: 'no references pass through', h: { A: 'no refs' }, allowed: [], env: {}, want: { A: 'no refs' } },
    { name: 'allowed but unset env resolves empty', h: { A: '$TOKEN' }, allowed: ['TOKEN'], env: {}, want: { A: '' } },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(interpolateHttpHookHeaders(testCase.h, testCase.allowed, testCase.env)).toEqual(testCase.want);
    });
  }
});

describe('matchesHttpHookUrlPattern', () => {
  it('matches an exact host and path prefix', () => {
    expect(matchesHttpHookUrlPattern('https://hooks.example.com/deploy', 'https://hooks.example.com/*')).toBe(true);
    expect(matchesHttpHookUrlPattern('https://evil.example.net/x', 'https://hooks.example.com/*')).toBe(false);
  });

  it('supports a * wildcard hostname segment', () => {
    expect(matchesHttpHookUrlPattern('https://ci.example.com/hook', 'https://*.example.com/*')).toBe(true);
    expect(matchesHttpHookUrlPattern('https://example.com/hook', 'https://*.example.com/*')).toBe(false);
  });

  it('matches hostnames case-insensitively', () => {
    expect(matchesHttpHookUrlPattern('https://Hooks.Example.COM/x', 'https://hooks.example.com/*')).toBe(true);
  });

  it('ignores a trailing FQDN dot', () => {
    expect(matchesHttpHookUrlPattern('https://hooks.example.com./x', 'https://hooks.example.com/*')).toBe(true);
  });

  it('honours a path prefix in the pattern', () => {
    expect(matchesHttpHookUrlPattern('https://api.example.com/webhooks/ci', 'https://api.example.com/webhooks/*')).toBe(true);
    expect(matchesHttpHookUrlPattern('https://api.example.com/admin', 'https://api.example.com/webhooks/*')).toBe(false);
  });
});
