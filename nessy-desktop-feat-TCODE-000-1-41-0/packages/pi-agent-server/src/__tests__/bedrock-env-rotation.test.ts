import { describe, it, expect } from 'bun:test';
import { applyRotatedAwsEnv } from '../bedrock-env-rotation.ts';

/**
 * P6.257. The contract under test is not "an object was mutated" — it is the
 * four rules that decide whether a rotated Bedrock credential actually works in
 * a session that is already running.
 */
describe('applyRotatedAwsEnv (P6.257)', () => {
  it('replaces the whole temporary triple', () => {
    const env: Record<string, string | undefined> = {
      AWS_ACCESS_KEY_ID: 'AKIAOLD',
      AWS_SECRET_ACCESS_KEY: 'old-secret',
      AWS_SESSION_TOKEN: 'old-token',
    };
    applyRotatedAwsEnv(
      { accessKeyId: 'AKIANEW', secretAccessKey: 'new-secret', sessionToken: 'new-token' },
      env,
    );
    expect(env).toEqual({
      AWS_ACCESS_KEY_ID: 'AKIANEW',
      AWS_SECRET_ACCESS_KEY: 'new-secret',
      AWS_SESSION_TOKEN: 'new-token',
    });
  });

  it('CLEARS a stale session token when rotating to long-lived keys', () => {
    // AWS rejects a session token presented beside a key it does not belong
    // to, so leaving the old one behind turns a successful rotation into a
    // signature error nobody can read.
    const env: Record<string, string | undefined> = {
      AWS_ACCESS_KEY_ID: 'AKIAOLD',
      AWS_SECRET_ACCESS_KEY: 'old-secret',
      AWS_SESSION_TOKEN: 'old-token',
    };
    applyRotatedAwsEnv({ accessKeyId: 'AKIANEW', secretAccessKey: 'new-secret' }, env);
    expect(env.AWS_SESSION_TOKEN).toBeUndefined();
    expect('AWS_SESSION_TOKEN' in env).toBe(false);
  });

  it('leaves a spawn-resolved AWS_REGION alone when the credential carries none', () => {
    const env: Record<string, string | undefined> = {
      AWS_REGION: 'eu-central-1',
      AWS_ACCESS_KEY_ID: 'AKIAOLD',
      AWS_SECRET_ACCESS_KEY: 'old-secret',
    };
    applyRotatedAwsEnv({ accessKeyId: 'AKIANEW', secretAccessKey: 'new-secret' }, env);
    expect(env.AWS_REGION).toBe('eu-central-1');
  });

  it('overwrites AWS_REGION when the credential does carry one', () => {
    const env: Record<string, string | undefined> = { AWS_REGION: 'eu-central-1' };
    applyRotatedAwsEnv(
      { accessKeyId: 'AKIANEW', secretAccessKey: 'new-secret', region: 'ap-south-1' },
      env,
    );
    expect(env.AWS_REGION).toBe('ap-south-1');
  });

  it('CONTROL — touches nothing else, including the transport flag', () => {
    const env: Record<string, string | undefined> = {
      AWS_BEDROCK_FORCE_HTTP1: '1',
      AWS_PROFILE: 'work',
      PATH: '/usr/bin',
    };
    applyRotatedAwsEnv({ accessKeyId: 'AKIANEW', secretAccessKey: 'new-secret' }, env);
    expect(env.AWS_BEDROCK_FORCE_HTTP1).toBe('1');
    expect(env.AWS_PROFILE).toBe('work');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('every written name is ENUMERABLE — the Bun assignment trap, on a real process env', () => {
    // A bare assignment can leave a name readable by property and invisible to
    // spread; every subprocess environment in this tree is built by spreading
    // `process.env`, so an invisible name reaches the AWS SDK in-process and
    // reaches nothing we spawn. Asserted through the real object, because a
    // plain literal cannot exhibit the defect.
    const saved = {
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
    };
    try {
      applyRotatedAwsEnv({
        accessKeyId: 'AKIAPROBE',
        secretAccessKey: 'probe-secret',
        sessionToken: 'probe-token',
      });
      const spread = { ...process.env };
      expect(spread.AWS_ACCESS_KEY_ID).toBe('AKIAPROBE');
      expect(spread.AWS_SECRET_ACCESS_KEY).toBe('probe-secret');
      expect(spread.AWS_SESSION_TOKEN).toBe('probe-token');
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        delete process.env[name];
        if (value !== undefined) process.env[name] = value;
      }
    }
  });
});
