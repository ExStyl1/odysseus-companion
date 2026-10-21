/**
 * P7.10 (rides P7.3) — the dev Pi bundle can go RED for a wrong package identity.
 *
 * THE GAP THIS CLOSES. `pi-runtime-adapter.ts` rejects a session whose runtime
 * reports the wrong version with `Unsupported Pi runtime <x>; expected <y>`, and
 * until this file the ONLY instrument that could produce that string was a
 * running dev app. Nothing in `bun test` reached the bundled runtime's
 * `getPackageDir()` from the BUNDLE's own directory: an ordinary import resolves
 * the installed `node_modules/@earendil-works/pi-coding-agent` layout, which
 * answers correctly under every rule upstream has shipped. So a path-resolution
 * change upstream is invisible to the whole suite and surfaces at launch.
 *
 * It is not hypothetical. Pi `0.84.3` replaced the body of `getPackageDir()`'s
 * walk-up with `findNodePackageDir()`, which carries one extra rule — if the
 * directory is named `dist` and its PARENT also has a `package.json`, the parent
 * wins (upstream's reason: its own `build:binary` layout, so dist-relative asset
 * paths do not become `dist/dist/`). The dev bundle is literally
 * `packages/pi-agent-server/dist` and its parent is the wrapper package, so the
 * walk steps straight past the identity `write-dist-package.ts` plants there and
 * a dev session reads `Unsupported Pi runtime 1.0.2; expected 0.84.3` — `1.0.2`
 * being the wrapper's own version. That is the trap AGENTS.md already records as
 * "reads like the model declining to dispatch", arriving from a second cause.
 *
 * THE INSTRUMENT. The resolver is not re-implemented here. Its source is read
 * VERBATIM out of the installed package at run time and evaluated with
 * `__dirname` bound to a replicated bundle directory, so the day the install
 * moves the rule moves with it and this file answers for the NEW rule rather
 * than for a copy of the old one. `readsTheRealResolver` is the positive control
 * for the extraction (an absence finding needs one on the same rig): it asserts
 * the slice really came from the shipped file before any layout case runs.
 *
 * THE CONTRACT, which is what the cases below pin and is version-independent:
 * the env `buildPiSubprocessEnv` hands the child must make the runtime's own
 * resolver find the planted identity in BOTH layouts — dev
 * (`packages/pi-agent-server/dist`, parent has a manifest) and staged
 * (`resources/pi-agent-server`, parent has none). The host does that with
 * `PI_PACKAGE_DIR`, which is `getPackageDir()`'s own first branch, so no rule of
 * upstream's is forked or re-spelled.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPiSubprocessEnv } from '../pi-agent.ts';

/** The wrapper package the dev bundle sits inside — the identity we must NOT read. */
const WRAPPER_NAME = '@nessy-agent/pi-agent-server';
const WRAPPER_VERSION = '1.0.2';
const PI_NAME = '@earendil-works/pi-coding-agent';

// Anchored on the manifest rather than on an exports-map subpath: the package
// publishes only `.`, `./rpc-entry` and `./client`, and 0.84.3 moved two of those
// three under `dist/bundle/`. The manifest's own directory is the one address
// that cannot be re-pointed by an exports-map edit.
const piManifestPath = Bun.resolveSync('@earendil-works/pi-coding-agent/package.json', import.meta.dir);
const piPackageRoot = dirname(piManifestPath);
const piConfigPath = join(piPackageRoot, 'dist', 'config.js');
const piConfigSource = readFileSync(piConfigPath, 'utf8');
const piPackageJson = JSON.parse(readFileSync(piManifestPath, 'utf8')) as { name: string; version: string };

const temporaryRoots: string[] = [];

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

/**
 * Slice one top-level function declaration out of the shipped `config.js` by
 * brace-matching. Returns `undefined` when the name is not declared there, which
 * is how the two versions are told apart without naming either: `0.84.2` has no
 * `findNodePackageDir`, `0.84.3` does.
 */
function sliceFunction(source: string, name: string): string | undefined {
  const start = source.search(new RegExp(`^(?:export )?function ${name}\\(`, 'm'));
  if (start < 0) return undefined;
  let depth = 0;
  let seenBrace = false;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') { depth += 1; seenBrace = true; }
    else if (source[i] === '}') {
      depth -= 1;
      if (seenBrace && depth === 0) return source.slice(start, i + 1);
    }
  }
  return undefined;
}

/**
 * The shipped `getPackageDir()`, evaluated as if the module lived in `moduleDir`.
 *
 * Everything it closes over is supplied the way the real module gets it:
 * `normalizePath` is imported from the installed package itself (absolute
 * specifier, so the real implementation runs), `isBunBinary` is `false` because
 * the host spawns `bun <bundle>/index.js` rather than a compiled binary (the
 * flag tests `import.meta.url` for `$bunfs`/`~BUN`), and `__dirname` is the
 * fixture.
 */
async function resolvePackageDir(moduleDir: string, env: NodeJS.ProcessEnv): Promise<string> {
  const helpers = ['findNodePackageDir', 'getPackageDir']
    .map((name) => sliceFunction(piConfigSource, name))
    .filter((body): body is string => body !== undefined)
    .map((body) => body.replace(/^export /, ''));
  const pathsModule = pathToFileURL(join(piPackageRoot, 'dist', 'utils', 'paths.js')).href;

  const moduleSource = [
    'import { existsSync } from "node:fs";',
    'import { basename, dirname, join, resolve, sep } from "node:path";',
    `import { normalizePath } from ${JSON.stringify(pathsModule)};`,
    'const isBunBinary = false;',
    `const __dirname = ${JSON.stringify(moduleDir)};`,
    ...helpers,
    'export { getPackageDir };',
  ].join('\n');

  const holder = scratch('p710-probe-');
  const file = join(holder, 'resolver.mjs');
  writeFileSync(file, moduleSource, 'utf8');

  // The probe reads `process.env` at call time, exactly as the real module does,
  // so the case's env is installed there for the duration and restored after.
  // Bun 1.3.14: `delete` first, then assign — an assigned name is readable by
  // property and invisible to a spread, and the restore path has the same trap.
  const previous = process.env.PI_PACKAGE_DIR;
  delete process.env.PI_PACKAGE_DIR;
  if (env.PI_PACKAGE_DIR !== undefined) process.env.PI_PACKAGE_DIR = env.PI_PACKAGE_DIR;
  try {
    const probe = await import(pathToFileURL(file).href) as { getPackageDir(): string };
    return probe.getPackageDir();
  } finally {
    delete process.env.PI_PACKAGE_DIR;
    if (previous !== undefined) process.env.PI_PACKAGE_DIR = previous;
  }
}

/** What the runtime would call itself, read the way `getPackageJsonPath()` reads it. */
async function resolveIdentity(moduleDir: string, env: NodeJS.ProcessEnv): Promise<{ name: string; version: string }> {
  const dir = await resolvePackageDir(moduleDir, env);
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; version: string };
}

function writeManifest(dir: string, manifest: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * The DEV shape: `<root>/packages/pi-agent-server/dist/index.js`, the planted Pi
 * identity beside it, and the wrapper manifest one level up — the arrangement
 * `0.84.3`'s new rule walks past. Returns the spawn path, because that is the
 * only thing the host has at the spawn site.
 */
function devLayout(): string {
  const root = scratch('p710-dev-');
  writeManifest(root, { name: '@nessy-agent/monorepo', version: '0.0.0' });
  const wrapper = join(root, 'packages', 'pi-agent-server');
  writeManifest(wrapper, { name: WRAPPER_NAME, version: WRAPPER_VERSION });
  const bundle = join(wrapper, 'dist');
  writeManifest(bundle, { name: piPackageJson.name, version: piPackageJson.version, type: 'module' });
  writeFileSync(join(bundle, 'index.js'), 'export {};\n', 'utf8');
  return join(bundle, 'index.js');
}

/**
 * The PACKAGED shape: `<appRoot>/resources/pi-agent-server/index.js` with the
 * copied identity beside it. `resources/` carries no manifest, so the walk-up
 * reaches this one on its own — which is exactly why the regression was dev-only
 * and why this case must exist anyway: the fix must not break the layout that
 * already worked.
 */
function stagedLayout(): string {
  const root = scratch('p710-staged-');
  writeManifest(root, { name: 'nessy-desktop', version: '1.35.0' });
  const bundle = join(root, 'resources', 'pi-agent-server');
  writeManifest(bundle, { name: piPackageJson.name, version: piPackageJson.version, type: 'module' });
  writeFileSync(join(bundle, 'index.js'), 'export {};\n', 'utf8');
  return join(bundle, 'index.js');
}

/** The spawn site's own arguments, minus the bundle path each case supplies. */
function spawnEnv(piServerPath: string | undefined, processEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return buildPiSubprocessEnv({
    processEnv,
    proxyEnv: {},
    awsEnv: {},
    sessionId: 'p710-session',
    debug: false,
    ...(piServerPath ? { piBundleDir: dirname(piServerPath) } : {}),
  });
}

describe('P7.10 the bundled Pi runtime resolves its own identity from the env the host sends', () => {
  it('readsTheRealResolver — the probe is built from the shipped config.js, not from a copy', () => {
    // Vacuity guard. Every case below is an assertion about extracted source; a
    // rename upstream that made the slice empty would otherwise turn this whole
    // file into a test of an empty module that throws once and passes never.
    const body = sliceFunction(piConfigSource, 'getPackageDir');
    expect(body).toBeDefined();
    expect(body!.length).toBeGreaterThan(200);
    // The branch the host relies on, read out of the shipped file rather than
    // assumed: if upstream ever drops the override, this line is what says so.
    expect(body).toContain('PI_PACKAGE_DIR');
    expect(piConfigPath).toContain('@earendil-works/pi-coding-agent');
  });

  it('resolves the Pi identity for the DEV bundle, whose parent directory has a manifest', async () => {
    const piServerPath = devLayout();
    const identity = await resolveIdentity(dirname(piServerPath), spawnEnv(piServerPath));
    expect(identity.name).toBe(PI_NAME);
    expect(identity.version).toBe(piPackageJson.version);
  });

  it('resolves the Pi identity for the STAGED bundle, whose parent directory has none', async () => {
    const piServerPath = stagedLayout();
    const identity = await resolveIdentity(dirname(piServerPath), spawnEnv(piServerPath));
    expect(identity.name).toBe(PI_NAME);
    expect(identity.version).toBe(piPackageJson.version);
  });

  it('reads the WRAPPER when PI_PACKAGE_DIR names the package root instead of the bundle', async () => {
    // The boundary, and the reason the value is `dirname(piServerPath)` rather
    // than "the pi-agent-server package": one directory up is a real manifest
    // with a real version, so a wrong value fails silently as a wrong VERSION
    // rather than loudly as a missing file. This is the exact string a dev
    // session showed after the 0.84.3 walk stepped up on its own.
    const piServerPath = devLayout();
    const wrapper = dirname(dirname(piServerPath));
    const identity = await resolveIdentity(dirname(piServerPath), { PI_PACKAGE_DIR: wrapper });
    expect(identity.name).toBe(WRAPPER_NAME);
    expect(identity.version).toBe(WRAPPER_VERSION);
  });
});

describe('P7.10 the host env carries the bundle directory', () => {
  it('sets PI_PACKAGE_DIR to the directory the spawn path lives in', () => {
    const piServerPath = devLayout();
    expect(spawnEnv(piServerPath).PI_PACKAGE_DIR).toBe(dirname(piServerPath));
  });

  it('DELETES an ambient PI_PACKAGE_DIR rather than letting the host shell decide', () => {
    // Same posture as NESSY_UPSTREAM_CREDENTIAL_HEADER beside it. An inherited
    // value here would point every session's identity at whatever directory a
    // developer last exported, which is a wrong-VERSION failure with no visible
    // cause; the production spawn site always supplies the real one.
    const env = spawnEnv(undefined, { PI_PACKAGE_DIR: '/somewhere/else' });
    expect(env.PI_PACKAGE_DIR).toBeUndefined();
    expect(Object.keys(env)).not.toContain('PI_PACKAGE_DIR');
  });
});
