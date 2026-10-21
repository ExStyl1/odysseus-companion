/**
 * The gap between "this tree is a v2 layout" and "this config.json is loadable",
 * and the two arms a launch can land in.
 *
 * `ensureStorageLayoutV2` verifies a TREE: `storageLayoutVersion === 2` plus the
 * three directories. `loadStoredConfig` verifies the FILE, much more strictly —
 * every workspace ref's shape, a registered `activeWorkspaceId`, no unknown
 * top-level key. A config.json can therefore clear readiness and still be
 * refused by the first read, which is exactly what happened on 2026-08-21: the
 * app reported `ready` and then threw `UnsupportedStorageLayoutError` out of an
 * unawaited startup promise, hanging windowless (see `apps/electron/src/main/boot-fatal.ts`).
 *
 * These cases pin both arms so the boot surface has something true to react to:
 * a fresh directory must INITIALIZE and load, and the gap tree must produce a
 * typed error rather than a hang, a silent overwrite, or a null.
 *
 * Each case runs in its own `bun --eval` child because `CONFIG_DIR` freezes at
 * first import of `config/paths.ts`, so one process can only ever exercise one
 * root.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const READINESS_MODULE = pathToFileURL(join(import.meta.dir, '..', 'storage-readiness.ts')).href;
const STORAGE_MODULE = pathToFileURL(join(import.meta.dir, '..', '..', 'config', 'storage.ts')).href;

const cleanups: string[] = [];

afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
});

interface ProbeResult {
  readiness: { status: string; code?: string };
  load: { ok: true; isNull: boolean } | { ok: false; name: string; message: string };
}

/** Run readiness followed by the first real config read, exactly as startup does. */
function probe(configDir: string): ProbeResult {
  const profile = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-boot-gap-')));
  cleanups.push(profile);
  const bunfig = join(profile, 'bunfig.toml');
  writeFileSync(bunfig, '# no test preloads\n');

  const env: Record<string, string | undefined> = { ...process.env, NESSY_CONFIG_DIR: configDir };
  delete env.NESSY_DP_AUTH_TOKEN;

  const child = Bun.spawnSync([process.execPath, `--config=${bunfig}`, '--eval', `
    import { ensureStorageLayoutV2 } from ${JSON.stringify(READINESS_MODULE)};
    import { loadStoredConfig } from ${JSON.stringify(STORAGE_MODULE)};

    const readiness = await ensureStorageLayoutV2({ assertHeld() {} });
    let load;
    try {
      const config = await loadStoredConfig();
      load = { ok: true, isNull: config === null };
    } catch (error) {
      load = { ok: false, name: error?.name ?? 'unknown', message: String(error?.message ?? error) };
    }
    console.log(JSON.stringify({
      readiness: { status: readiness.status, ...(readiness.status === 'blocked' ? { code: readiness.code } : {}) },
      load,
    }));
  `], { env, stdout: 'pipe', stderr: 'pipe' });

  const stdout = child.stdout.toString().trim();
  if (child.exitCode !== 0 || !stdout) {
    throw new Error(`probe failed (${child.exitCode}): ${child.stderr.toString()}`);
  }
  return JSON.parse(stdout.split('\n').at(-1)!) as ProbeResult;
}

function disposableRoot(): string {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-boot-gap-root-')));
  cleanups.push(parent);
  return join(parent, 'config');
}

describe('storage readiness vs the first config read', () => {
  it('initializes a fresh directory and loads the config it just wrote', () => {
    const result = probe(disposableRoot());

    expect(result.readiness.status).toBe('initialized');
    expect(result.load).toEqual({ ok: true, isNull: false });
  });

  it('initializes a directory that exists but is empty', () => {
    const root = disposableRoot();
    mkdirSync(root, { recursive: true });

    const result = probe(root);

    expect(result.readiness.status).toBe('initialized');
    expect(result.load).toEqual({ ok: true, isNull: false });
  });

  it('reports ready for a v2 TREE whose config.json the loader then refuses', () => {
    // The measured shape: a pre-v2 config.json stamped with
    // `storageLayoutVersion: 2` and an empty `workspaceRefs`, but with no
    // `activeWorkspaceId` key at all. `isVerifiedV2Tree` is satisfied;
    // `loadStoredConfig` is not, because `undefined !== null`.
    const root = disposableRoot();
    mkdirSync(join(root, 'workspaces'), { recursive: true });
    mkdirSync(join(root, 'sessions'), { recursive: true });
    mkdirSync(join(root, 'plugins'), { recursive: true });
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      storageLayoutVersion: 2,
      workspaceRefs: [],
      llmConnections: [],
    }));

    const result = probe(root);

    expect(result.readiness.status).toBe('ready');
    expect(result.load).toMatchObject({ ok: false, name: 'UnsupportedStorageLayoutError' });
  });

  it('blocks rather than initializing when the config dir parent does not exist', () => {
    // `assertSafeParent` requires every ancestor to already be a real directory.
    // A custom root two levels below an absent parent is therefore refused —
    // the code a launch pointed at a not-yet-created path lands on.
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-boot-gap-root-')));
    cleanups.push(parent);

    const result = probe(join(parent, 'missing-parent', 'config'));

    expect(result.readiness).toEqual({ status: 'blocked', code: 'unsafe-root' });
  });
});
