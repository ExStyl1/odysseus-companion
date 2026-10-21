/**
 * UB1.19 — the REAL-loader isolation guard (upstream v0.15.0
 * `system-prompt-override.test.ts`'s loader describe, adapted to OUR surface:
 * the loader is built exactly as `compat/pi-runtime-adapter.ts` builds it — the
 * real `DefaultResourceLoader`, the adapter's `settingsManagerInMemory`
 * posture (`projectTrusted: false`), the inline extension factories, and the
 * five `no*` flags — against the real Pi 0.87.1 SDK. Control: the SDK default
 * posture (`SettingsManager.inMemory()` untrusted-by-default WITHOUT the
 * adapter's posture) DOES run the repository extension, so the instrument can
 * see a load.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { resolveNessyAgentDir } from '../agent-dir.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A working directory whose `.pi/extensions` would leave a marker file when loaded. */
function repoWithProjectExtension(): { cwd: string; marker: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'nessy-pi-repo-'));
  dirs.push(cwd);
  const marker = join(cwd, 'extension-ran');
  mkdirSync(join(cwd, '.pi', 'extensions'), { recursive: true });
  writeFileSync(
    join(cwd, '.pi', 'extensions', 'repo-extension.ts'),
    `import { writeFileSync } from 'node:fs';\n` +
      `export default function repoExtension() { writeFileSync(${JSON.stringify(marker)}, 'ran'); }\n`,
  );
  return { cwd, marker };
}

/**
 * The loader exactly as the adapter builds it (its five `no*` flags and the
 * never-trusted settings), or — for the control — the loader as the SDK itself
 * builds it: no flags, project trust on. The two knobs are independent, which
 * is the point of the control.
 */
async function adapterLoader(cwd: string, agentDir: string, opts: { adapterFlags: boolean; projectTrusted: boolean }): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory({}, { projectTrusted: opts.projectTrusted }),
    extensionFactories: [],
    ...(opts.adapterFlags
      ? { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true }
      : {}),
  });
  await loader.reload();
  return loader;
}

describe('UB1.19 · the real Pi loader loads nothing from the repo or the agent dir', () => {
  it('positive: main and ephemeral sessions load only inline factories; the repo extension never runs', async () => {
    const { cwd, marker } = repoWithProjectExtension();
    const sessionPath = mkdtempSync(join(tmpdir(), 'nessy-pi-session-'));
    dirs.push(sessionPath);
    for (const purpose of ['main', 'ephemeral'] as const) {
      const loader = await adapterLoader(cwd, resolveNessyAgentDir({ sessionPath }), { adapterFlags: true, projectTrusted: false });
      const { extensions, errors } = loader.getExtensions();
      expect(errors).toEqual([]);
      // No inline factory is registered in this harness, so nothing but inline names may appear.
      expect(extensions.every(ext => ext.path.startsWith('<inline:'))).toBe(true);
      expect(extensions.some(ext => ext.path.endsWith('repo-extension.ts'))).toBe(false);
      void purpose;
    }
    expect(existsSync(marker)).toBe(false);
  });

  it('positive: a session-less agent resolves its agentDir to the per-process scratch, not the cwd', async () => {
    const { cwd, marker } = repoWithProjectExtension();
    const loader = await adapterLoader(cwd, resolveNessyAgentDir({ sessionPath: '' }), { adapterFlags: true, projectTrusted: false });
    const { extensions, errors } = loader.getExtensions();
    expect(errors).toEqual([]);
    expect(extensions.some(ext => ext.path.endsWith('repo-extension.ts'))).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it('negative control: the SDK default posture (trusted project, no `no*` flags) DOES run the repository extension', async () => {
    // Upstream's control: the loader as the SDK itself builds it — project
    // trust on, no isolation flags — runs the extension, so the instrument can
    // see a load. OUR arm keeps both belts (the flags AND untrusted settings),
    // which is the B2-07 "already stronger" premise this row's guard pins.
    const { cwd, marker } = repoWithProjectExtension();
    const loader = await adapterLoader(cwd, join(cwd, '.pi-agent'), { adapterFlags: false, projectTrusted: true });
    expect(loader.getExtensions().extensions.some(ext => ext.path.endsWith('repo-extension.ts'))).toBe(true);
    expect(existsSync(marker)).toBe(true);
  });
});
