import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBedrockRegion, describeBedrockRegion, bedrockIamCredentialFingerprint, resolveCodexBedrockCardRegion, codexBedrockRegionMessage } from '../bedrock-region.ts';

describe('resolveBedrockRegion (P6.457)', () => {
  it('prefers the connection\'s own stored region and names that source', () => {
    expect(resolveBedrockRegion('eu-central-1', { AWS_REGION: 'us-east-1' })).toEqual({
      region: 'eu-central-1',
      source: 'connection',
    });
  });

  it('falls to AWS_REGION when the connection carries none', () => {
    expect(resolveBedrockRegion(undefined, { AWS_REGION: 'us-east-1' })).toEqual({
      region: 'us-east-1',
      source: 'AWS_REGION',
    });
  });

  it('reads AWS_DEFAULT_REGION — the name that scored zero files before this row', () => {
    expect(resolveBedrockRegion(undefined, { AWS_DEFAULT_REGION: 'ap-northeast-1' })).toEqual({
      region: 'ap-northeast-1',
      source: 'AWS_DEFAULT_REGION',
    });
  });

  it('treats a blank value as absent rather than as an answer', () => {
    expect(resolveBedrockRegion('   ', { AWS_REGION: '  ', AWS_DEFAULT_REGION: 'eu-west-1' })).toEqual({
      region: 'eu-west-1',
      source: 'AWS_DEFAULT_REGION',
    });
  });

  it('returns undefined when no step this process can see answers', () => {
    expect(resolveBedrockRegion(undefined, {})).toBeUndefined();
  });

  it('says the region is resolved ELSEWHERE, never that it is unset', () => {
    const line = describeBedrockRegion(undefined);
    expect(line).toContain('UNRESOLVED here');
    expect(line).toContain('instance metadata');
    expect(describeBedrockRegion({ region: 'eu-west-1', source: 'AWS_REGION' }))
      .toBe('Bedrock region eu-west-1 (source: AWS_REGION)');
  });
});

describe('bedrockIamCredentialFingerprint (P6.257)', () => {
  const base = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-one' };

  it('is stable for the same credential, so an auth failure does not push it back', () => {
    expect(bedrockIamCredentialFingerprint({ ...base }))
      .toBe(bedrockIamCredentialFingerprint({ ...base }));
  });

  it('moves when only the STS session token rotates — the ordinary Bedrock case', () => {
    expect(bedrockIamCredentialFingerprint({ ...base, sessionToken: 'tok-a' }))
      .not.toBe(bedrockIamCredentialFingerprint({ ...base, sessionToken: 'tok-b' }));
  });

  it('moves when the access key id rotates', () => {
    expect(bedrockIamCredentialFingerprint({ ...base, accessKeyId: 'AKIAOTHER' }))
      .not.toBe(bedrockIamCredentialFingerprint(base));
  });

  it('does NOT carry the secret access key, so it is safe beside a log line', () => {
    const fingerprint = bedrockIamCredentialFingerprint({ ...base, sessionToken: 'tok-a' });
    expect(fingerprint).not.toContain('secret-one');
    expect(fingerprint).toContain('AKIAEXAMPLE');
  });

  it('CONTROL — a changed secret alone does not move it, and that is the stated trade', () => {
    // Both halves of an STS rotation change the id and the token, so this
    // cannot mask a real rotation; carrying the secret to catch the case that
    // cannot happen would put it somewhere a log might.
    expect(bedrockIamCredentialFingerprint({ ...base, secretAccessKey: 'secret-two' }))
      .toBe(bedrockIamCredentialFingerprint(base));
  });
});

/**
 * F1.979 — the region codex's OWN Bedrock provider picks for the codex Bedrock
 * card, shown on the card (owner decision 2026-09-26: keep the vendor's selection
 * and show it). The order is codex's, read at rust-v0.156.1
 * (`codex-rs/model-provider/src/amazon_bedrock/auth.rs` `bearer_token_region`,
 * and the AWS SDK default region chain for every other credential). No case reads
 * the real `~/.aws/config`: the file reader is an argument and every case passes
 * its own.
 */
describe('resolveCodexBedrockCardRegion (F1.979)', () => {
  const PROFILE_FILE = [
    '# comment',
    '[default]',
    'region = eu-central-1',
    '',
    '[profile work]',
    'output = json',
    '  region=ap-northeast-1  ',
  ].join('\n');
  const files = (byPath: Record<string, string>) => (path: string) => byPath[path];

  it('names AWS_REGION first, then AWS_DEFAULT_REGION, exactly as codex does', () => {
    const none = files({});
    expect(resolveCodexBedrockCardRegion('amazon-bedrock', { AWS_REGION: 'eu-west-1', AWS_DEFAULT_REGION: 'us-west-2' }, none))
      .toEqual({ region: 'eu-west-1', source: 'AWS_REGION' });
    expect(resolveCodexBedrockCardRegion('amazon-bedrock', { AWS_DEFAULT_REGION: 'us-west-2' }, none))
      .toEqual({ region: 'us-west-2', source: 'AWS_DEFAULT_REGION' });
  });

  it('falls to the active AWS profile in the config file when the environment names none', () => {
    const read = files({ '/h/.aws/config': PROFILE_FILE, '/elsewhere/cfg': PROFILE_FILE });
    expect(resolveCodexBedrockCardRegion('amazon-bedrock', { HOME: '/h' }, read))
      .toEqual({ region: 'eu-central-1', source: 'aws-profile', profile: 'default' });
    expect(resolveCodexBedrockCardRegion('amazon-bedrock', { HOME: '/h', AWS_PROFILE: 'work' }, read))
      .toEqual({ region: 'ap-northeast-1', source: 'aws-profile', profile: 'work' });
    expect(resolveCodexBedrockCardRegion('amazon-bedrock', { AWS_CONFIG_FILE: '/elsewhere/cfg', AWS_PROFILE: 'work' }, read))
      .toEqual({ region: 'ap-northeast-1', source: 'aws-profile', profile: 'work' });
  });

  it('does NOT take the profile for a Bedrock API key — codex reads only the two env names there', () => {
    // `bearer_token_region` never consults the profile; codex fails the turn instead.
    const read = files({ '/h/.aws/config': PROFILE_FILE });
    expect(resolveCodexBedrockCardRegion('amazon-bedrock', { HOME: '/h', AWS_BEARER_TOKEN_BEDROCK: 'fake-token' }, read))
      .toEqual({ source: 'bearer-token-needs-env' });
    expect(resolveCodexBedrockCardRegion('amazon-bedrock', { HOME: '/h', AWS_BEARER_TOKEN_BEDROCK: 'fake-token', AWS_REGION: 'us-east-1' }, read))
      .toEqual({ region: 'us-east-1', source: 'AWS_REGION' });
  });

  it('says unresolved, never a guessed region, when no step it can read answers', () => {
    expect(resolveCodexBedrockCardRegion('amazon-bedrock', { HOME: '/h', AWS_PROFILE: 'absent' }, files({ '/h/.aws/config': PROFILE_FILE })))
      .toEqual({ source: 'unresolved' });
    expect(resolveCodexBedrockCardRegion('amazon-bedrock', { HOME: '/h' }, files({})))
      .toEqual({ source: 'unresolved' });
  });

  it('answers nothing for any card that is not the codex Bedrock card', () => {
    const read = files({ '/h/.aws/config': PROFILE_FILE });
    expect(resolveCodexBedrockCardRegion(undefined, { AWS_REGION: 'eu-west-1', HOME: '/h' }, read)).toBeUndefined();
    expect(resolveCodexBedrockCardRegion('openai', { AWS_REGION: 'eu-west-1', HOME: '/h' }, read)).toBeUndefined();
  });

  it('gives every reading a locale key that exists in en.json', () => {
    const en = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'i18n', 'locales', 'en.json'), 'utf-8')) as Record<string, string>;
    const readings = [
      { region: 'eu-west-1', source: 'AWS_REGION' },
      { region: 'eu-west-1', source: 'AWS_DEFAULT_REGION' },
      { region: 'eu-west-1', source: 'aws-profile', profile: 'work' },
      { source: 'bearer-token-needs-env' },
      { source: 'unresolved' },
    ] as const;
    for (const reading of readings) {
      const message = codexBedrockRegionMessage(reading);
      expect(en[message.key]).toBeString();
    }
    expect(codexBedrockRegionMessage({ region: 'eu-west-1', source: 'aws-profile', profile: 'work' }).params)
      .toEqual({ region: 'eu-west-1', profile: 'work' });
  });
});
