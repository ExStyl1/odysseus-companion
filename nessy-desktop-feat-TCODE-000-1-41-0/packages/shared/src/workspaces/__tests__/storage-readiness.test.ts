import { afterEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const READINESS_MODULE = pathToFileURL(join(import.meta.dir, '..', 'storage-readiness.ts')).href;
const CONFIG_PATHS_MODULE = pathToFileURL(join(import.meta.dir, '..', '..', 'config', 'paths.ts')).href;
const DP_AUTH_MODULE = pathToFileURL(join(import.meta.dir, '..', '..', 'auth', 'dp', 'index.ts')).href;
const DURABLE_FS_MODULE = pathToFileURL(join(import.meta.dir, '..', '..', 'utils', 'durable-fs.ts')).href;
const cleanups: string[] = [];

afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
});

function defaultChild(body: string) {
  const profile = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-storage-v2-profile-')));
  const bunfig = join(profile, 'bunfig.toml');
  writeFileSync(bunfig, '# no test preloads\n');
  cleanups.push(profile);
  const env: Record<string, string | undefined> = { ...process.env, HOME: profile, USERPROFILE: profile };
  delete env.NESSY_CONFIG_DIR;
  delete env.NESSY_DP_AUTH_TOKEN;
  // These cases exist to exercise the DEFAULT root, so NESSY_CONFIG_DIR must
  // stay unset — the child asserts IS_DEFAULT_CONFIG_DIR below. The isolation
  // therefore comes from HOME, not from the override, and the disposable
  // profile above is what keeps the real ~/.nessy-agent out of reach.
  //
  // `bun test` sets NODE_ENV=test in THIS process, and the child inherits it.
  // The guard in config/paths.ts refuses "test process + default root" — it is
  // reading an inherited variable as a claim this `bun --eval` probe is itself
  // a test runner, which it is not. Drop the claim rather than weaken the
  // guard: a real `bun test` process still trips it.
  delete env.NODE_ENV;

  return Bun.spawnSync([process.execPath, `--config=${bunfig}`, '--eval', `
    import { createHash, randomUUID } from 'node:crypto';
    import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
    import { basename, dirname, isAbsolute, join, relative } from 'node:path';
    import { DEFAULT_CONFIG_DIR, IS_DEFAULT_CONFIG_DIR, STORAGE_LAYOUT_VERSION, ensureStorageLayoutV2, storageReadinessBlockedCodeFor } from ${JSON.stringify(READINESS_MODULE)};
    import { ensureNessyGatewayAuth, getCredsPath, getValidCreds } from ${JSON.stringify(DP_AUTH_MODULE)};

    const profile = ${JSON.stringify(profile)};
    const root = DEFAULT_CONFIG_DIR;
    const withinProfile = relative(profile, root);
    if (!IS_DEFAULT_CONFIG_DIR || !withinProfile || withinProfile === '..' || withinProfile.startsWith('../') || isAbsolute(withinProfile)) {
      throw new Error('default root escaped disposable profile');
    }
    const lease = { assertHeld() {} };
    const stem = basename(root).replace(/^\\./, '');
    const markerPath = join(dirname(root), \`.\${stem}.cutover-v2.json\`);
    const sibling = (kind, transactionId) => join(dirname(root), kind === 'quarantine'
      ? \`\${basename(root)}.legacy-v1.\${transactionId}\`
      : \`.\${stem}.v2-staging.\${transactionId}\`);
    const validV2 = (path) => {
      mkdirSync(path, { recursive: true });
      mkdirSync(join(path, 'workspaces'));
      mkdirSync(join(path, 'sessions'));
      mkdirSync(join(path, 'plugins'));
      writeFileSync(join(path, 'config.json'), JSON.stringify({
        storageLayoutVersion: STORAGE_LAYOUT_VERSION,
        workspaceRefs: [],
        activeWorkspaceId: null,
        activeSessionId: null,
      }));
    };
    const marker = (transactionId, phase, stagingPath, quarantinePath) => ({
      version: 1,
      transactionId,
      phase,
      configDir: root,
      stagingPath,
      quarantinePath,
    });
    const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
    ${body}
  `], { env, stdout: 'pipe', stderr: 'pipe' });
}

function customChild(body: string, relativeRoot = 'custom-root') {
  const profile = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-storage-v2-custom-profile-')));
  const root = join(profile, relativeRoot);
  const bunfig = join(profile, 'bunfig.toml');
  writeFileSync(bunfig, '# no test preloads\n');
  cleanups.push(profile);
  const env: Record<string, string | undefined> = { ...process.env, HOME: profile, USERPROFILE: profile, NESSY_CONFIG_DIR: root };
  delete env.NESSY_DP_AUTH_TOKEN;

  return Bun.spawnSync([process.execPath, `--config=${bunfig}`, '--eval', `
    import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { DEFAULT_CONFIG_DIR, IS_DEFAULT_CONFIG_DIR, STORAGE_LAYOUT_VERSION, ensureStorageLayoutV2 } from ${JSON.stringify(READINESS_MODULE)};
    import { CONFIG_DIR } from ${JSON.stringify(CONFIG_PATHS_MODULE)};

    const profile = ${JSON.stringify(profile)};
    const root = CONFIG_DIR;
    if (IS_DEFAULT_CONFIG_DIR || root !== ${JSON.stringify(root)}) throw new Error('custom root classification drift');
    const lease = { assertHeld() {} };
    const validV2 = path => {
      mkdirSync(path, { recursive: true });
      mkdirSync(join(path, 'workspaces'));
      mkdirSync(join(path, 'sessions'));
      mkdirSync(join(path, 'plugins'));
      writeFileSync(join(path, 'config.json'), JSON.stringify({
        storageLayoutVersion: STORAGE_LAYOUT_VERSION,
        workspaceRefs: [],
        activeWorkspaceId: null,
        activeSessionId: null,
      }));
    };
    ${body}
  `], { env, stdout: 'pipe', stderr: 'pipe' });
}

function output(result: ReturnType<typeof Bun.spawnSync>): any {
  expect(result.exitCode, result.stderr?.toString() ?? '').toBe(0);
  return JSON.parse(result.stdout?.toString() ?? '');
}

describe('ensureStorageLayoutV2', () => {
  it('initializes only absent and empty default roots, then verifies v2 without writes', () => {
    const absent = output(defaultChild(`
      const first = await ensureStorageLayoutV2(lease);
      const configPath = join(root, 'config.json');
      const before = readFileSync(configPath, 'utf8');
      const beforeMtime = lstatSync(configPath, { bigint: true }).mtimeNs;
      const second = await ensureStorageLayoutV2(lease);
      console.log(JSON.stringify({
        first: first.status,
        second: second.status,
        version: JSON.parse(before).storageLayoutVersion,
        dirs: ['workspaces', 'sessions', 'plugins'].every(name => existsSync(join(root, name))),
        unchanged: before === readFileSync(configPath, 'utf8') && beforeMtime === lstatSync(configPath, { bigint: true }).mtimeNs,
      }));
    `));
    expect(absent).toEqual({ first: 'initialized', second: 'ready', version: 2, dirs: true, unchanged: true });

    const empty = output(defaultChild(`
      mkdirSync(root);
      const result = await ensureStorageLayoutV2(lease);
      console.log(JSON.stringify({ status: result.status, version: JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).storageLayoutVersion }));
    `));
    expect(empty).toEqual({ status: 'initialized', version: 2 });

    const valid = output(defaultChild(`
      validV2(root);
      const configPath = join(root, 'config.json');
      const before = readFileSync(configPath, 'utf8');
      const beforeMtime = lstatSync(configPath, { bigint: true }).mtimeNs;
      const result = await ensureStorageLayoutV2(lease);
      console.log(JSON.stringify({
        status: result.status,
        unchanged: before === readFileSync(configPath, 'utf8') && beforeMtime === lstatSync(configPath, { bigint: true }).mtimeNs,
      }));
    `));
    expect(valid).toEqual({ status: 'ready', unchanged: true });
  }, 90_000);

  it('quarantines parseable unversioned default state without importing legacy data or touching external auth', () => {
    const result = output(defaultChild(`
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'config.json'), JSON.stringify({ workspaces: [{ id: 'legacy' }] }));
      const legacyFiles = [
        ['chats/history.json', 'distinctive-chat'],
        ['settings.json', 'distinctive-settings'],
        ['credentials.enc', 'distinctive-credential'],
        ['plugins/installed.json', 'distinctive-plugin'],
        ['skills/private.md', 'distinctive-skill'],
        ['.mcp.json', 'distinctive-mcp'],
        ['hooks/run.sh', 'distinctive-hook'],
        ['agents/agent.md', 'distinctive-agent'],
        ['recent-projects.json', 'distinctive-recent-project'],
      ];
      for (const [name, value] of legacyFiles) {
        const path = join(root, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, value);
      }
      const legacySnapshots = legacyFiles.map(([name]) => {
        const path = join(root, name);
        return { name, bytes: readFileSync(path), fd: openSync(path, 'r') };
      });
      chmodSync(join(root, 'credentials.enc'), 0o000);
      const project = join(profile, 'external-project');
      const agents = join(profile, '.agents');
      const credsPath = join(profile, '.nessy', 'dp_auth_creds.json');
      mkdirSync(project, { recursive: true });
      mkdirSync(agents, { recursive: true });
      mkdirSync(dirname(credsPath), { recursive: true });
      writeFileSync(join(project, 'project.txt'), 'external-project');
      writeFileSync(join(agents, 'agent.md'), 'external-agents');
      writeFileSync(credsPath, JSON.stringify({ jwt: 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJpc3MiOiJuZXN0b3ItYmFja2VuZCIsInByZWZlcnJlZF91c2VybmFtZSI6InN5bnRoZXRpYyIsInN1YiI6InN5bnRoZXRpYyIsImV4cCI6NDEwMjQ0NDgwMH0.fake-signature', expiresAt: Date.now() + 60_000, username: 'synthetic', userId: 'synthetic' }));
      if (getCredsPath() !== credsPath || getValidCreds()?.jwt !== 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJpc3MiOiJuZXN0b3ItYmFja2VuZCIsInByZWZlcnJlZF91c2VybmFtZSI6InN5bnRoZXRpYyIsInN1YiI6InN5bnRoZXRpYyIsImV4cCI6NDEwMjQ0NDgwMH0.fake-signature') throw new Error('synthetic cached auth unavailable');
      const before = [hash(join(project, 'project.txt')), hash(join(agents, 'agent.md')), hash(credsPath)];
      const legacyStat = lstatSync(root);
      const cutover = await ensureStorageLayoutV2(lease);
      const cached = await ensureNessyGatewayAuth({ interactive: false });
      const after = [hash(join(project, 'project.txt')), hash(join(agents, 'agent.md')), hash(credsPath)];
      const quarantinePath = cutover.quarantinePath;
      const freshConfig = readFileSync(join(root, 'config.json'), 'utf8');
      const freshDocument = JSON.parse(freshConfig);
      const everyLegacyFilePreservedOnlyInQuarantine = !!quarantinePath && legacySnapshots.map(({ name, bytes, fd }) => {
        const quarantinedPath = join(quarantinePath, name);
        const preserved = existsSync(quarantinedPath)
          && !existsSync(join(root, name))
          && lstatSync(quarantinedPath).ino === fstatSync(fd).ino
          && readFileSync(fd).equals(bytes);
        closeSync(fd);
        return preserved;
      }).every(Boolean);
      console.log(JSON.stringify({
        status: cutover.status,
        sameParent: !!quarantinePath && dirname(quarantinePath) === dirname(root),
        renamedWholeRoot: !!quarantinePath && lstatSync(quarantinePath).ino === legacyStat.ino,
        legacyOnlyInQuarantine: !!quarantinePath && existsSync(join(quarantinePath, 'credentials.enc')) && !existsSync(join(root, 'credentials.enc')),
        legacyRecentsOnlyInQuarantine: !!quarantinePath
          && readFileSync(join(quarantinePath, 'recent-projects.json'), 'utf8') === 'distinctive-recent-project'
          && !existsSync(join(root, 'recent-projects.json')),
        everyLegacyFilePreservedOnlyInQuarantine,
        noLegacyDataInFreshConfig: !legacyFiles.some(([, value]) => freshConfig.includes(value)),
        refsOnlyRegistry: Array.isArray(freshDocument.workspaceRefs) && !('workspaces' in freshDocument),
        externalUnchanged: JSON.stringify(before) === JSON.stringify(after),
        cachedJwt: cached.jwt,
      }));
    `));
    expect(result).toEqual({
      status: 'quarantined',
      sameParent: true,
      renamedWholeRoot: true,
      legacyOnlyInQuarantine: true,
      legacyRecentsOnlyInQuarantine: true,
      everyLegacyFilePreservedOnlyInQuarantine: true,
      noLegacyDataInFreshConfig: true,
      refsOnlyRegistry: true,
      externalUnchanged: true,
      cachedJwt: 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJpc3MiOiJuZXN0b3ItYmFja2VuZCIsInByZWZlcnJlZF91c2VybmFtZSI6InN5bnRoZXRpYyIsInN1YiI6InN5bnRoZXRpYyIsImV4cCI6NDEwMjQ0NDgwMH0.fake-signature',
    });
  }, 90_000);

  it('quarantines v1 default state and blocks unsafe or ambiguous default roots inertly', () => {
    const v1 = output(defaultChild(`
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'config.json'), JSON.stringify({ storageLayoutVersion: 1 }));
      const result = await ensureStorageLayoutV2(lease);
      console.log(JSON.stringify({ status: result.status, quarantine: result.quarantinePath, version: JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).storageLayoutVersion }));
    `));
    expect(v1.status).toBe('quarantined');
    expect(v1.quarantine).toContain('.nessy-agent.legacy-v1.');
    expect(v1.version).toBe(2);

    const missingMarker = output(defaultChild(`
      mkdirSync(root);
      const sentinelPath = join(root, 'sentinel.txt');
      writeFileSync(sentinelPath, 'ambiguous-user-data');
      const before = {
        rootInode: String(lstatSync(root, { bigint: true }).ino),
        entries: readdirSync(root),
        sentinelHash: hash(sentinelPath),
      };
      const result = await ensureStorageLayoutV2(lease);
      const after = {
        rootInode: String(lstatSync(root, { bigint: true }).ino),
        entries: readdirSync(root),
        sentinelHash: existsSync(sentinelPath) ? hash(sentinelPath) : null,
      };
      console.log(JSON.stringify({
        status: result.status,
        code: result.code,
        byteIdentical: JSON.stringify(before) === JSON.stringify(after),
        noCutoverArtifacts: !existsSync(markerPath)
          && !readdirSync(dirname(root)).some(name => name.includes('.legacy-v1.') || name.includes('.v2-staging.')),
      }));
    `));
    expect(missingMarker).toEqual({
      status: 'blocked',
      code: 'invalid-marker',
      byteIdentical: true,
      noCutoverArtifacts: true,
    });

    for (const [name, setup, code] of [
      ['invalid-json', `mkdirSync(root); writeFileSync(join(root, 'config.json'), '{');`, 'invalid-marker'],
      ['unknown-version', `mkdirSync(root); writeFileSync(join(root, 'config.json'), JSON.stringify({ storageLayoutVersion: 3 }));`, 'unsupported-version'],
      ['corrupt-v2', `mkdirSync(root); writeFileSync(join(root, 'config.json'), JSON.stringify({ storageLayoutVersion: 2 }));`, 'corrupt-v2'],
      ['root-file', `writeFileSync(root, 'not-a-directory');`, 'unsafe-root'],
      ['config-symlink', `
        const outside = join(profile, 'outside-config.json');
        mkdirSync(root);
        writeFileSync(outside, JSON.stringify({ storageLayoutVersion: 1 }));
        symlinkSync(outside, join(root, 'config.json'), 'file');
      `, 'unsafe-root'],
      ['invalid-marker', `writeFileSync(markerPath, 'not-json'); chmodSync(markerPath, 0o600);`, 'invalid-marker'],
      ['active-collision', `
        const transactionId = randomUUID();
        const stagingPath = sibling('staging', transactionId);
        const quarantinePath = sibling('quarantine', transactionId);
        mkdirSync(root);
        writeFileSync(join(root, 'config.json'), JSON.stringify({ storageLayoutVersion: 1 }));
        validV2(stagingPath);
        mkdirSync(quarantinePath);
        writeFileSync(markerPath, JSON.stringify(marker(transactionId, 'prepared', stagingPath, quarantinePath)), { mode: 0o600 });
      `, 'path-collision'],
    ]) {
      const blocked = output(defaultChild(`
        ${setup}
        const before = existsSync(root) ? lstatSync(root, { bigint: true }).mtimeNs : null;
        const result = await ensureStorageLayoutV2(lease);
        const after = existsSync(root) ? lstatSync(root, { bigint: true }).mtimeNs : null;
        console.log(JSON.stringify({ status: result.status, code: result.code, unchanged: before === after }));
      `));
      expect(blocked).toEqual({ status: 'blocked', code, unchanged: true });
    }

    if (process.platform !== 'win32') {
      const symlinked = output(defaultChild(`
        const outside = join(profile, 'outside');
        mkdirSync(outside);
        symlinkSync(outside, root, 'dir');
        const result = await ensureStorageLayoutV2(lease);
        console.log(JSON.stringify({ status: result.status, code: result.code, outsideEntries: readdirSync(outside) }));
      `));
      expect(symlinked).toEqual({ status: 'blocked', code: 'unsafe-root', outsideEntries: [] });
    }
  }, 120_000);

  it('ignores retained quarantine siblings without a marker and blocks forged recovery authority', () => {
    const inert = output(defaultChild(`
      const retained = sibling('quarantine', randomUUID());
      validV2(root);
      mkdirSync(retained, { recursive: true });
      writeFileSync(join(retained, 'credentials.enc'), 'inert');
      const before = lstatSync(retained, { bigint: true }).mtimeNs;
      const result = await ensureStorageLayoutV2(lease);
      const after = lstatSync(retained, { bigint: true }).mtimeNs;
      console.log(JSON.stringify({ status: result.status, retained: existsSync(retained), unchanged: before === after }));
    `));
    expect(inert).toEqual({ status: 'ready', retained: true, unchanged: true });

    const forged = output(defaultChild(`
      const transactionId = randomUUID();
      const external = join(profile, 'external-stage');
      const quarantinePath = sibling('quarantine', transactionId);
      mkdirSync(external);
      writeFileSync(join(external, 'sentinel'), 'external');
      writeFileSync(markerPath, JSON.stringify(marker(transactionId, 'prepared', external, quarantinePath)), { mode: 0o600 });
      const result = await ensureStorageLayoutV2(lease);
      console.log(JSON.stringify({
        status: result.status,
        code: result.code,
        externalUnchanged: readFileSync(join(external, 'sentinel'), 'utf8') === 'external',
      }));
    `));
    expect(forged).toEqual({ status: 'blocked', code: 'invalid-marker', externalUnchanged: true });
  }, 90_000);

  it('leaves every active collision path inert', () => {
    const result = output(defaultChild(`
      const transactionId = randomUUID();
      const stagingPath = sibling('staging', transactionId);
      const quarantinePath = sibling('quarantine', transactionId);
      mkdirSync(root);
      writeFileSync(join(root, 'config.json'), JSON.stringify({ storageLayoutVersion: 1 }));
      validV2(stagingPath);
      mkdirSync(quarantinePath);
      writeFileSync(join(quarantinePath, 'sentinel'), 'quarantine');
      writeFileSync(markerPath, JSON.stringify(marker(transactionId, 'prepared', stagingPath, quarantinePath)), { mode: 0o600 });
      const mtime = path => lstatSync(path, { bigint: true }).mtimeNs;
      const before = [mtime(root), mtime(stagingPath), mtime(quarantinePath), mtime(markerPath)];
      const result = await ensureStorageLayoutV2(lease);
      const after = [mtime(root), mtime(stagingPath), mtime(quarantinePath), mtime(markerPath)];
      console.log(JSON.stringify({
        status: result.status,
        code: result.code,
        allMetadataUnchanged: before.every((value, index) => value === after[index]),
        quarantineUnchanged: readFileSync(join(quarantinePath, 'sentinel'), 'utf8') === 'quarantine',
      }));
    `));
    expect(result).toEqual({
      status: 'blocked',
      code: 'path-collision',
      allMetadataUnchanged: true,
      quarantineUnchanged: true,
    });
  });

  it('supports fresh and valid-v2 custom roots but never cuts over custom legacy state', () => {
    const fresh = output(customChild(`
      const result = await ensureStorageLayoutV2(lease);
      console.log(JSON.stringify({ status: result.status, version: JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).storageLayoutVersion }));
    `));
    expect(fresh).toEqual({ status: 'initialized', version: 2 });

    const valid = output(customChild(`
      validV2(root);
      const before = readFileSync(join(root, 'config.json'), 'utf8');
      const result = await ensureStorageLayoutV2(lease);
      console.log(JSON.stringify({ status: result.status, unchanged: before === readFileSync(join(root, 'config.json'), 'utf8') }));
    `));
    expect(valid).toEqual({ status: 'ready', unchanged: true });

    const legacy = output(customChild(`
      mkdirSync(root);
      writeFileSync(join(root, 'config.json'), JSON.stringify({ storageLayoutVersion: 1, sentinel: 'legacy' }));
      const before = readFileSync(join(root, 'config.json'), 'utf8');
      const result = await ensureStorageLayoutV2(lease);
      console.log(JSON.stringify({ status: result.status, code: result.code, unchanged: before === readFileSync(join(root, 'config.json'), 'utf8') }));
    `));
    expect(legacy).toEqual({ status: 'blocked', code: 'custom-root-reset-required', unchanged: true });
  }, 90_000);

  it('rejects a custom root reached through an intermediate symlink', () => {
    if (process.platform === 'win32') return;

    const result = output(customChild(`
      const external = join(profile, 'external-parent');
      mkdirSync(join(external, 'child'), { recursive: true });
      symlinkSync(external, join(profile, 'linked-parent'), 'dir');
      const result = await ensureStorageLayoutV2(lease);
      console.log(JSON.stringify({
        status: result.status,
        code: result.code,
        externalUntouched: !existsSync(join(external, 'child', '.nessy-agent')),
      }));
    `, join('linked-parent', 'child', '.nessy-agent')));

    expect(result).toEqual({ status: 'blocked', code: 'unsafe-root', externalUntouched: true });
  });

  it('requires the host lease and resumes only the strict marker phase/state matrix', () => {
    const leaseMissing = output(defaultChild(`
      const result = await ensureStorageLayoutV2({ assertHeld() { throw new Error('not held'); } });
      console.log(JSON.stringify({ status: result.status, code: result.code, rootExists: existsSync(root) }));
    `));
    expect(leaseMissing).toEqual({ status: 'blocked', code: 'host-lease-missing', rootExists: false });

    for (const [phase, expected] of [
      ['prepared', 'quarantined'],
      ['legacy-quarantined', 'quarantined'],
      ['v2-installed', 'ready'],
    ]) {
      const recovered = output(defaultChild(`
        const transactionId = randomUUID();
        const stagingPath = sibling('staging', transactionId);
        const quarantinePath = sibling('quarantine', transactionId);
        if (${JSON.stringify(phase)} === 'prepared') {
          mkdirSync(root);
          writeFileSync(join(root, 'config.json'), JSON.stringify({ storageLayoutVersion: 1 }));
          validV2(stagingPath);
        } else if (${JSON.stringify(phase)} === 'legacy-quarantined') {
          mkdirSync(quarantinePath);
          writeFileSync(join(quarantinePath, 'config.json'), JSON.stringify({ storageLayoutVersion: 1 }));
          validV2(stagingPath);
        } else {
          mkdirSync(quarantinePath);
          writeFileSync(join(quarantinePath, 'config.json'), JSON.stringify({ storageLayoutVersion: 1 }));
          validV2(root);
        }
        writeFileSync(markerPath, JSON.stringify(marker(transactionId, ${JSON.stringify(phase)}, stagingPath, quarantinePath)), { mode: 0o600 });
        const result = await ensureStorageLayoutV2(lease);
        console.log(JSON.stringify({
          status: result.status,
          markerRetired: !existsSync(markerPath),
          rootV2: JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).storageLayoutVersion === 2,
        }));
      `));
      expect(recovered).toEqual({ status: expected, markerRetired: true, rootV2: true });
    }

    const ambiguousPrepared = output(defaultChild(`
      const transactionId = randomUUID();
      const stagingPath = sibling('staging', transactionId);
      const quarantinePath = sibling('quarantine', transactionId);
      mkdirSync(root);
      const sentinelPath = join(root, 'sentinel.txt');
      writeFileSync(sentinelPath, 'ambiguous-user-data');
      validV2(stagingPath);
      writeFileSync(markerPath, JSON.stringify(marker(transactionId, 'prepared', stagingPath, quarantinePath)), { mode: 0o600 });
      const before = [
        String(lstatSync(root, { bigint: true }).mtimeNs),
        String(lstatSync(stagingPath, { bigint: true }).mtimeNs),
        String(lstatSync(markerPath, { bigint: true }).mtimeNs),
        hash(sentinelPath),
      ];
      const result = await ensureStorageLayoutV2(lease);
      const after = [
        String(lstatSync(root, { bigint: true }).mtimeNs),
        String(lstatSync(stagingPath, { bigint: true }).mtimeNs),
        String(lstatSync(markerPath, { bigint: true }).mtimeNs),
        hash(sentinelPath),
      ];
      console.log(JSON.stringify({
        status: result.status,
        code: result.code,
        byteIdentical: JSON.stringify(before) === JSON.stringify(after),
        noQuarantine: !existsSync(quarantinePath),
      }));
    `));
    expect(ambiguousPrepared).toEqual({
      status: 'blocked',
      code: 'path-collision',
      byteIdentical: true,
      noQuarantine: true,
    });
  }, 120_000);

  it('maps injected Windows sharing failures to a blocked readiness code', () => {
    const result = output(defaultChild(`
      const { DurableFsError } = await import(${JSON.stringify(DURABLE_FS_MODULE)});
      console.log(JSON.stringify({
        sharing: storageReadinessBlockedCodeFor(new DurableFsError('sharing-violation', new Error('sharing'))),
        generic: storageReadinessBlockedCodeFor(new DurableFsError('durability-failed', new Error('failure'))),
      }));
    `));
    expect(result).toEqual({ sharing: 'sharing-violation', generic: 'durability-failed' });
  });
});
