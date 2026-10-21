import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertStagedPiMatchesDist, type BuildConfig } from './build/common.ts';

/**
 * P2.193 — `scripts/electron-dev.ts` rebuilt the Pi bundle and never restaged it.
 *
 * The row arrived as "the dev app has been running the previous build". Measured,
 * that half is false and the true half is worse in a quieter way:
 *
 *  - `resolveServerPath`'s `!isPackaged` branch resolves
 *    `packages/pi-agent-server/dist/index.js`, so the DEV app runs the bundle the
 *    dev script just rebuilt. Probed directly through
 *    `resolveBackendRuntimePaths` rather than read off the source.
 *  - The ~20 KB the row measured between dist and the staged copy is not drift at
 *    all. Rebuilt both recipes from one source on 2026-08-27: ~20,000 of those
 *    bytes are `../../` path-comment prefixes, because `bun build` writes each
 *    module's path relative to the cwd and the two recipes ran from different
 *    directories. The remaining ~47 bytes are not a recipe difference either —
 *    `bun build` is not reproducible: the SAME command line run twice alternates
 *    between two stable images 100 hunks apart, every hunk an identifier-suffix
 *    counter (`target`/`target2`, `Type2`/`Type3`). Same 4,477 modules, same
 *    semantics, and no digest comparison between two independent builds can
 *    mean anything.
 *  - What was real: `apps/electron/resources/pi-agent-server/` — the copy the
 *    PACKAGED app runs, and the copy anyone greps to ask "did my fix land in the
 *    bundle?" — was last written 2026-08-23 01:43:04 (sha256 97977c48acb1)
 *    against a dist at 01:43:56 (b00bde874a7c), and no dev launch since had
 *    touched it or said so. And the dev script never ran
 *    `write-dist-package.ts`, so a `dist` it created from scratch had no Pi
 *    package identity: the runtime's walk-up lands on the wrapper manifest and
 *    every session dies with `Unsupported Pi runtime 1.0.2` — `1.0.2` being
 *    that wrapper's own version, which is the trap AGENTS.md records naming its
 *    own cause.
 *
 * So the fix has two halves and this file guards both: the dev path now builds
 * through `buildPiAgentServerBundle` and stages through `copyPiAgentServer`, and
 * the stage checks itself. A restage that happens but is never verified is the
 * same defect one layer along.
 */

const SCRIPTS_DIR = import.meta.dir;
const DEV_SCRIPT = readFileSync(join(SCRIPTS_DIR, 'electron-dev.ts'), 'utf8');
const COMMON_SCRIPT = readFileSync(join(SCRIPTS_DIR, 'build', 'common.ts'), 'utf8');

const temporaryRoots: string[] = [];

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

/** A dist/staged pair on disk, plus the config that addresses it. */
function fixture(options: { bundle: string; identity: string; staged?: { bundle?: string; identity?: string } | null }): BuildConfig {
  const root = mkdtempSync(join(tmpdir(), 'p2193-'));
  temporaryRoots.push(root);

  const rootDir = join(root, 'repo');
  const electronDir = join(rootDir, 'apps', 'electron');
  const distDir = join(rootDir, 'packages', 'pi-agent-server', 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'index.js'), options.bundle);
  writeFileSync(join(distDir, 'package.json'), options.identity);

  if (options.staged !== null) {
    const stagedDir = join(electronDir, 'resources', 'pi-agent-server');
    mkdirSync(stagedDir, { recursive: true });
    if (options.staged?.bundle !== undefined) writeFileSync(join(stagedDir, 'index.js'), options.staged.bundle);
    else writeFileSync(join(stagedDir, 'index.js'), options.bundle);
    if (options.staged?.identity !== undefined) writeFileSync(join(stagedDir, 'package.json'), options.staged.identity);
    else writeFileSync(join(stagedDir, 'package.json'), options.identity);
  }

  return { platform: 'darwin', arch: 'arm64', upload: false, uploadLatest: false, uploadScript: false, rootDir, electronDir };
}

const BUNDLE = 'console.log("pi bundle");\n';
const IDENTITY = '{\n  "name": "@earendil-works/pi-coding-agent",\n  "version": "0.84.4"\n}\n';

describe('assertStagedPiMatchesDist (P2.193)', () => {
  it('accepts a staged copy identical to the dist it came from', () => {
    expect(() => assertStagedPiMatchesDist(fixture({ bundle: BUNDLE, identity: IDENTITY }))).not.toThrow();
  });

  it('rejects a staged bundle that differs from the dist AT THE SAME LENGTH', () => {
    // The boundary that matters. A size comparison is the cheap proxy anyone
    // reaches for, and it passes here: both files are 26 bytes. Only a digest
    // catches a one-character edit, which is the shape a real stale bundle takes
    // once a rebuild has run and only some of the source changed.
    const stale = BUNDLE.replace('pi bundle', 'pi bundlE');
    expect(stale.length).toBe(BUNDLE.length);
    const config = fixture({ bundle: BUNDLE, identity: IDENTITY, staged: { bundle: stale } });
    expect(() => assertStagedPiMatchesDist(config)).toThrow(/staged Pi bundle is stale/);
    expect(() => assertStagedPiMatchesDist(config)).toThrow(/electron:build:servers/);
  });

  it('rejects a staged package.json that differs, not just the bundle', () => {
    // The identity file is what the bundled Pi runtime walks up to for
    // VERSION/piConfig. A mismatch there fails every session with `Unsupported
    // Pi runtime`, which reads like the model refusing to dispatch rather than
    // like a build problem — so it is checked on its own, not assumed to travel
    // with the bundle.
    // A length-changing edit on purpose, so this row tests SCOPE — that the
    // identity file is checked at all — while the row above tests the digest.
    // Made same-length, both rows would fail for one reason and the pair would
    // stop being two facts.
    const config = fixture({ bundle: BUNDLE, identity: IDENTITY, staged: { identity: IDENTITY.replace('"0.84.4"', '"0.84.4-rc.1"') } });
    expect(() => assertStagedPiMatchesDist(config)).toThrow(/staged Pi package identity is stale/);
  });

  it('rejects a stage that never happened', () => {
    const config = fixture({ bundle: BUNDLE, identity: IDENTITY, staged: null });
    expect(() => assertStagedPiMatchesDist(config)).toThrow(/staged Pi bundle was never written/);
  });

  it('names the missing SOURCE rather than blaming the stage when dist is gone', () => {
    // Distinguishable failures: "nobody built" and "nobody staged" have
    // different fixes, and a single message for both sends people to the wrong
    // command.
    const config = fixture({ bundle: BUNDLE, identity: IDENTITY });
    rmSync(join(config.rootDir, 'packages', 'pi-agent-server', 'dist', 'index.js'));
    expect(() => assertStagedPiMatchesDist(config)).toThrow(/has no source to match/);
  });
});

describe('the dev script builds and stages Pi through the shared recipe (P2.193)', () => {
  const mainBody = DEV_SCRIPT.slice(DEV_SCRIPT.indexOf('async function main('));

  it('main() reaches the dev script at all', () => {
    // Vacuity guard: every ordering assertion below slices this string, and a
    // rename would make them all pass against an empty body.
    expect(mainBody.length).toBeGreaterThan(200);
  });

  it('delegates the Pi build to build/common instead of re-spelling the command', () => {
    expect(DEV_SCRIPT).toMatch(/import\s*\{[^}]*\bbuildPiAgentServerBundle\b[^}]*\}\s*from\s*"\.\/build\/common"/s);
    expect(DEV_SCRIPT).toMatch(/\bbuildPiAgentServerBundle\(config\)/);
    // The near-copy this replaced. Its two omissions (`write-dist-package.ts`
    // and `--external koffi`) were invisible precisely because it LOOKED like
    // the shared recipe; a second spelling is the defect, not a detail of it.
    expect(DEV_SCRIPT).not.toMatch(/"--outdir=dist"/);
    expect(DEV_SCRIPT).not.toMatch(/cwd:\s*PI_AGENT_SERVER_DIR/);
  });

  it('stages the Pi bundle after building it', () => {
    expect(DEV_SCRIPT).toMatch(/import\s*\{[^}]*\bcopyPiAgentServer\b[^}]*\}\s*from\s*"\.\/build\/common"/s);
    const built = DEV_SCRIPT.indexOf('buildPiAgentServerBundle(config)');
    const staged = DEV_SCRIPT.indexOf('copyPiAgentServer(config)');
    expect(built).toBeGreaterThan(-1);
    expect(staged).toBeGreaterThan(built);
  });

  it('copies resources into dist only after the servers inside them are staged', () => {
    // `copyResources` mirrors `apps/electron/resources` into
    // `apps/electron/dist/resources`. Running it first mirrors the PREVIOUS
    // launch's servers — the same staleness one directory along, inside a single
    // dev run.
    const build = mainBody.indexOf('await buildMcpServers()');
    const copy = mainBody.indexOf('copyResources()');
    expect(build).toBeGreaterThan(-1);
    expect(copy).toBeGreaterThan(build);
  });
});

describe('the stage checks itself (P2.193)', () => {
  it('copyPiAgentServer verifies its own output before returning', () => {
    // The check lives INSIDE the copy on purpose. Exported-and-called-beside
    // would leave two callers to remember it, and `stage-electron-servers.ts`
    // and `scripts/electron-dev.ts` are exactly the two places that already
    // forgot once.
    const body = COMMON_SCRIPT.slice(
      COMMON_SCRIPT.indexOf('export function copyPiAgentServer('),
      COMMON_SCRIPT.indexOf('export function assertStagedPiMatchesDist('),
    );
    expect(body.length).toBeGreaterThan(200);
    expect(body).toMatch(/assertStagedPiMatchesDist\(config\)/);
  });
});
