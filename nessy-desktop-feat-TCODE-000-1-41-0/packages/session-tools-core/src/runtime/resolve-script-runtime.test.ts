import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isPackagedEnvValue, resolveScriptRuntime } from './resolve-script-runtime.ts';

describe('resolveScriptRuntime', () => {
  it('prefers NESSY_UV for python3', () => {
    const prev = process.env.NESSY_UV;
    process.env.NESSY_UV = '/tmp/custom-uv';

    try {
      const resolved = resolveScriptRuntime('python3', { isPackaged: false });
      expect(resolved.command).toBe('/tmp/custom-uv');
      expect(resolved.argsPrefix).toEqual(['run', '--python', '3.12']);
      expect(resolved.source).toBe('env');
    } finally {
      if (prev === undefined) delete process.env.NESSY_UV;
      else process.env.NESSY_UV = prev;
    }
  });

  it('prefers bundled uv when env is missing', () => {
    const prevUv = process.env.NESSY_UV;
    delete process.env.NESSY_UV;

    const base = mkdtempSync(join(tmpdir(), 'runtime-resolver-'));
    const uvPath = join(base, 'resources', 'bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'uv.exe' : 'uv');
    mkdirSync(join(base, 'resources', 'bin', `${process.platform}-${process.arch}`), { recursive: true });
    writeFileSync(uvPath, '');

    try {
      const resolved = resolveScriptRuntime('python3', { isPackaged: true, resourcesBasePath: base });
      expect(resolved.command).toBe(uvPath);
      expect(resolved.source).toBe('bundled');
    } finally {
      if (prevUv === undefined) delete process.env.NESSY_UV;
      else process.env.NESSY_UV = prevUv;
    }
  });

  it('blocks PATH fallback in packaged mode', () => {
    const prevUv = process.env.NESSY_UV;
    const prevBase = process.env.NESSY_RESOURCES_BASE;
    const prevRoot = process.env.NESSY_APP_ROOT;
    delete process.env.NESSY_UV;
    delete process.env.NESSY_RESOURCES_BASE;
    delete process.env.NESSY_APP_ROOT;

    try {
      expect(() => resolveScriptRuntime('python3', { isPackaged: true })).toThrow(
        'packaged app'
      );
    } finally {
      if (prevUv === undefined) delete process.env.NESSY_UV;
      else process.env.NESSY_UV = prevUv;
      if (prevBase === undefined) delete process.env.NESSY_RESOURCES_BASE;
      else process.env.NESSY_RESOURCES_BASE = prevBase;
      if (prevRoot === undefined) delete process.env.NESSY_APP_ROOT;
      else process.env.NESSY_APP_ROOT = prevRoot;
    }
  });

  it('rejects bare NESSY_NODE command in packaged mode', () => {
    const prev = process.env.NESSY_NODE;
    process.env.NESSY_NODE = 'node';

    try {
      expect(() => resolveScriptRuntime('node', { isPackaged: true })).toThrow(
        'do not allow PATH-based runtime resolution'
      );
    } finally {
      if (prev === undefined) delete process.env.NESSY_NODE;
      else process.env.NESSY_NODE = prev;
    }
  });

  it('prefers NESSY_BUN for bun in dev', () => {
    const prev = process.env.NESSY_BUN;
    process.env.NESSY_BUN = '/tmp/custom-bun';

    try {
      const resolved = resolveScriptRuntime('bun', { isPackaged: false });
      expect(resolved.command).toBe('/tmp/custom-bun');
      expect(resolved.argsPrefix).toEqual([]);
      expect(resolved.source).toBe('env');
    } finally {
      if (prev === undefined) delete process.env.NESSY_BUN;
      else process.env.NESSY_BUN = prev;
    }
  });
});

/**
 * The packaged-mode guards, exercised the way production reaches them.
 *
 * Every test above hands `resolveScriptRuntime` an explicit `isPackaged`. No
 * shipped caller does: `handlers/script-sandbox.ts` and `handlers/transform-data.ts`
 * both call `resolveScriptRuntime(args.language)` with no context, so packaged
 * mode is decided entirely by `NESSY_IS_PACKAGED`. That is why supplying the flag
 * kept the suite green while `inferPackagedMode()` was returning false on every
 * packaged path and all three guards were dead.
 *
 * So these tests supply the ENV and never the flag. If a future edit re-breaks
 * the env reading, the tests above stay green and these fail — which is the whole
 * point of keeping them separate.
 */
describe('packaged mode inferred from NESSY_IS_PACKAGED (no isPackaged supplied)', () => {
  const TOUCHED = [
    'NESSY_IS_PACKAGED',
    'NESSY_UV',
    'NESSY_NODE',
    'NESSY_BUN',
    'NESSY_RESOURCES_BASE',
    'NESSY_APP_ROOT',
  ] as const;

  function withEnv(overrides: Partial<Record<(typeof TOUCHED)[number], string>>, run: () => void) {
    const saved = new Map<string, string | undefined>();
    for (const key of TOUCHED) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    try {
      for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
      run();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it("refuses a bare env runtime under NESSY_IS_PACKAGED='true', the value packaging actually writes", () => {
    // The live fail-open this suite could not see. `apps/electron/src/main/index.ts`
    // sets NESSY_UV to the bare string 'uv' whenever the bundled binary is missing,
    // so a packaging defect alone — no attacker — used to reach PATH resolution in
    // a packaged build, which is precisely what this error text forbids.
    withEnv({ NESSY_IS_PACKAGED: 'true', NESSY_UV: 'uv' }, () => {
      expect(() => resolveScriptRuntime('python3')).toThrow(
        'do not allow PATH-based runtime resolution'
      );
    });
  });

  it("still refuses under the legacy '1' spelling that older packaged builds write", () => {
    withEnv({ NESSY_IS_PACKAGED: '1', NESSY_NODE: 'node' }, () => {
      expect(() => resolveScriptRuntime('node')).toThrow(
        'do not allow PATH-based runtime resolution'
      );
    });
  });

  it('rejects an absolute env runtime that does not exist, when packaged by env alone', () => {
    const missing = join(tmpdir(), 'nessy-absent-bun-does-not-exist');
    withEnv({ NESSY_IS_PACKAGED: 'true', NESSY_BUN: missing }, () => {
      expect(() => resolveScriptRuntime('bun')).toThrow('does not exist');
    });
  });

  it('blocks the PATH fallback when packaged by env alone and nothing is bundled', () => {
    withEnv({ NESSY_IS_PACKAGED: 'true' }, () => {
      expect(() => resolveScriptRuntime('python3')).toThrow('packaged app');
    });
  });

  it("accepts a bare env runtime when the env says 'false' — the dev path must not regress", () => {
    withEnv({ NESSY_IS_PACKAGED: 'false', NESSY_UV: 'uv' }, () => {
      const resolved = resolveScriptRuntime('python3');
      expect(resolved.command).toBe('uv');
      expect(resolved.source).toBe('env');
    });
  });

  it('accepts a bare env runtime when the variable is absent (plain dev and CI)', () => {
    withEnv({ NESSY_UV: 'uv' }, () => {
      expect(resolveScriptRuntime('python3').command).toBe('uv');
    });
  });

  it('lets an explicit ctx.isPackaged still override the env', () => {
    withEnv({ NESSY_IS_PACKAGED: 'true', NESSY_UV: 'uv' }, () => {
      expect(resolveScriptRuntime('python3', { isPackaged: false }).command).toBe('uv');
    });
  });
});

describe('isPackagedEnvValue', () => {
  it('reads the canonical and legacy true spellings', () => {
    expect(isPackagedEnvValue('true')).toBe(true);
    expect(isPackagedEnvValue('1')).toBe(true);
    expect(isPackagedEnvValue('TRUE')).toBe(true);
    expect(isPackagedEnvValue(' true ')).toBe(true);
  });

  it('reads absent, false and unrecognised values as not packaged', () => {
    // Unrecognised matches every sibling reader (`=== 'true'`), and absent has to
    // stay false or every dev and test run would start throwing.
    expect(isPackagedEnvValue(undefined)).toBe(false);
    expect(isPackagedEnvValue('')).toBe(false);
    expect(isPackagedEnvValue('false')).toBe(false);
    expect(isPackagedEnvValue('0')).toBe(false);
    expect(isPackagedEnvValue('yes')).toBe(false);
  });
});
