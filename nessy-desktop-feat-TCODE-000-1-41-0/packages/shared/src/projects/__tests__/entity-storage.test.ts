/**
 * UA5.2 — project entity storage (OQ-1 option (a′)): upstream's `ProjectConfig` over our folder handle.
 *
 * Copied from craft-agents-oss `v0.13.4:packages/shared/src/projects/__tests__/storage.test.ts` (Apache-2.0): the four
 * `loadProjectMemory` arms (a folderless project, so upstream's behaviour is unchanged) and, since UA5.6, its three
 * `sanitizeAssetFilename` arms with UA5.6's asset CRUD arms (upload, list, traversal). The rest are UA5.2's arms
 * (`storage.ts` header items 1–6) and the OQ-21 pin. Uses real temp directories, as upstream.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, symlinkSync, utimesSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { estimateTokensDensityAware } from '../../utils/large-response.ts';
import { getDefaultLabelConfig, loadLabelConfig } from '../../labels/storage.ts';
import { createWorkspaceService } from '../../workspaces/service.ts';
import {
  createProject,
  deleteProject,
  deleteProjectAsset,
  getProjectAssetsPath,
  getProjectMemoryPath,
  getProjectPath,
  loadProject,
  loadProjectById,
  loadProjectConfig,
  loadProjectMemory,
  listProjectAssets,
  loadWorkspaceProjects,
  parseKanbanColumns,
  projectFolderFromHandle,
  setProjectConfigWrittenHook,
  sanitizeAssetFilename,
  setProjectFolderFromHandle,
  updateProject,
  uploadProjectAsset,
  type ProjectFolderSource,
} from '../index.ts';
import type { ProjectConfig } from '../types.ts';

let tempDir: string;
let workspaceRoot: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'projects-test-'));
  workspaceRoot = join(tempDir, 'workspace');
});

afterEach(() => {
  setProjectConfigWrittenHook(null);
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function makeProjectSlug(name = 'Memory Test'): string {
  return createProject(workspaceRoot, { name }).slug;
}

const STABLE_KEY = `p_${'a'.repeat(32)}`;
const handle = (over: Partial<ProjectFolderSource> = {}): ProjectFolderSource => ({
  displayPath: '/work/repo',
  projectKey: STABLE_KEY,
  persistence: 'stable',
  ...over,
});

/** The bytes on disk, not the loader's view of them. */
const rawConfig = (slug: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(getProjectPath(workspaceRoot, slug), 'config.json'), 'utf-8'));

const writeRawConfig = (slug: string, value: Record<string, unknown>): void => {
  mkdirSync(join(workspaceRoot, 'projects', slug), { recursive: true });
  writeFileSync(join(workspaceRoot, 'projects', slug, 'config.json'), JSON.stringify(value));
};

describe('loadProjectMemory (v0.13.4 arms, a folderless project)', () => {
  it('returns null when MEMORY.md does not exist', () => {
    const slug = makeProjectSlug();
    expect(loadProjectMemory(workspaceRoot, slug)).toBeNull();
  });

  it('returns null when MEMORY.md is whitespace-only', () => {
    const slug = makeProjectSlug();
    writeFileSync(getProjectMemoryPath(workspaceRoot, slug), '   \n\t\n');
    expect(loadProjectMemory(workspaceRoot, slug)).toBeNull();
  });

  it('returns content verbatim when under the token cap', () => {
    const slug = makeProjectSlug();
    const content = '# Lessons\n\n- Always read the guide first.\n- Cache is king.';
    writeFileSync(getProjectMemoryPath(workspaceRoot, slug), content);
    expect(loadProjectMemory(workspaceRoot, slug)).toBe(content);
  });

  it('keeps head AND tail with a middle marker when over the cap, staying within budget (UB1.12: appended notes land at the end)', () => {
    const slug = makeProjectSlug();
    const maxTokens = 50;
    // ~2000 chars of plain text => ~500 tokens, well over the 50-token cap.
    const body = 'TOP-OF-MEMORY ' + 'lorem ipsum dolor sit amet '.repeat(74) + ' BOTTOM-OF-MEMORY';
    writeFileSync(getProjectMemoryPath(workspaceRoot, slug), body);

    const result = loadProjectMemory(workspaceRoot, slug, maxTokens);
    expect(result).not.toBeNull();
    const text = result as string;

    // v0.15.1's 30/70: the start is kept (older files were written newest-first at
    // the top) and the END is kept too (appended notes land there) — the old
    // head-only truncation dropped every appended note past the cap.
    expect(text).toContain('TOP-OF-MEMORY');
    expect(text).toContain('BOTTOM-OF-MEMORY');
    expect(text.indexOf('TOP-OF-MEMORY')).toBeLessThan(text.indexOf('BOTTOM-OF-MEMORY'));

    // Marker present between the halves, and budget respected (marker included).
    expect(text).toContain(`MEMORY.md is over the ${maxTokens}-token cap; its middle is omitted`);
    expect(text.indexOf('TOP-OF-MEMORY')).toBeLessThan(text.indexOf('MEMORY.md is over the'));
    expect(text.indexOf('MEMORY.md is over the')).toBeLessThan(text.lastIndexOf('BOTTOM-OF-MEMORY'));
    expect(estimateTokensDensityAware(text)).toBeLessThanOrEqual(maxTokens);
  });

  it('negative (OQ-9): a foldered project has no project memory, even with a MEMORY.md on disk', () => {
    const foldered = createProject(workspaceRoot, { name: 'Foldered' }, handle()).slug;
    const folderless = makeProjectSlug('Folderless');
    writeFileSync(getProjectMemoryPath(workspaceRoot, foldered), '# kept out');
    writeFileSync(getProjectMemoryPath(workspaceRoot, folderless), '# kept in');
    expect(loadProjectMemory(workspaceRoot, foldered)).toBeNull();
    // Control on the same instrument: the folderless twin reads its file.
    expect(loadProjectMemory(workspaceRoot, folderless)).toBe('# kept in');
  });
});

describe('UA5.2 — the folder comes only from a handle; a stable projectKey is persisted, a process-only one never', () => {
  it('positive: a stable handle persists the display path and its projectKey; the loader returns them', () => {
    const created = createProject(workspaceRoot, { name: 'Repo' }, handle());
    expect(created.folder).toEqual({ workingDirectory: '/work/repo', projectKey: STABLE_KEY });
    expect(rawConfig(created.slug).folder).toEqual({ workingDirectory: '/work/repo', projectKey: STABLE_KEY });
    expect(loadProjectConfig(workspaceRoot, created.slug)?.folder).toEqual({ workingDirectory: '/work/repo', projectKey: STABLE_KEY });
    expect(created.id).toMatch(/^proj_[0-9a-f]{8}$/);
  });

  it('negative: a process-only handle\'s key is never persisted (the WorkspaceDefaultProject rule)', () => {
    const created = createProject(workspaceRoot, { name: 'Net mount' }, handle({ persistence: 'process-only', projectKey: `p_${'b'.repeat(32)}` }));
    expect(rawConfig(created.slug).folder).toEqual({ workingDirectory: '/work/repo' });
    expect(JSON.stringify(rawConfig(created.slug))).not.toContain('b'.repeat(32));
    expect(projectFolderFromHandle(handle({ persistence: 'process-only' }))).toEqual({ workingDirectory: '/work/repo' });
  });

  it('negative: a raw folder or workingDirectory patch is refused and nothing is written', () => {
    const slug = createProject(workspaceRoot, { name: 'Repo' }, handle()).slug;
    const before = readFileSync(join(getProjectPath(workspaceRoot, slug), 'config.json'), 'utf-8');
    expect(() => updateProject(workspaceRoot, slug, { folder: { workingDirectory: '/etc' } } as never))
      .toThrow('project-folder-handle-required');
    expect(() => updateProject(workspaceRoot, slug, { workingDirectory: '/etc' } as never))
      .toThrow('project-folder-handle-required');
    expect(() => createProject(workspaceRoot, { name: 'Raw', workingDirectory: '/etc' } as never))
      .toThrow('project-folder-handle-required');
    expect(readFileSync(join(getProjectPath(workspaceRoot, slug), 'config.json'), 'utf-8')).toBe(before);
    expect(loadWorkspaceProjects(workspaceRoot).map(p => p.config.name)).toEqual(['Repo']);
  });

  it('positive: an ordinary patch keeps the folder; setProjectFolderFromHandle rebinds and unbinds it', () => {
    const slug = createProject(workspaceRoot, { name: 'Repo' }, handle()).slug;
    const renamed = updateProject(workspaceRoot, slug, { name: 'Renamed', description: 'd' });
    expect(renamed.folder).toEqual({ workingDirectory: '/work/repo', projectKey: STABLE_KEY });
    expect(renamed.slug).toBe(slug);
    const moved = setProjectFolderFromHandle(workspaceRoot, slug, handle({ displayPath: '/work/other', persistence: 'process-only' }));
    expect(moved.folder).toEqual({ workingDirectory: '/work/other' });
    expect(setProjectFolderFromHandle(workspaceRoot, slug, null).folder).toBeUndefined();
    expect(rawConfig(slug).folder).toBeUndefined();
    expect(rawConfig(slug).name).toBe('Renamed');
  });

  it('negative: on read, a legacy raw workingDirectory never becomes a folder, and a malformed folder is dropped', () => {
    writeRawConfig('legacy', { id: 'proj_legacy1', slug: 'legacy', name: 'Legacy', workingDirectory: '/etc', createdAt: 1, updatedAt: 1 });
    const legacy = loadProjectConfig(workspaceRoot, 'legacy')!;
    expect(legacy.name).toBe('Legacy');
    expect(legacy.folder).toBeUndefined();
    expect('workingDirectory' in legacy).toBe(false);

    writeRawConfig('relative', { id: 'proj_rel00001', name: 'Rel', folder: { workingDirectory: 'etc' }, createdAt: 1, updatedAt: 1 });
    expect(loadProjectConfig(workspaceRoot, 'relative')?.folder).toBeUndefined();
    writeRawConfig('badkey', { id: 'proj_badkey01', name: 'Bad', folder: { workingDirectory: '/work/repo', projectKey: '/work/repo' }, createdAt: 1, updatedAt: 1 });
    expect(loadProjectConfig(workspaceRoot, 'badkey')?.folder).toBeUndefined();

    // Control: a well-formed portable folder is kept and expanded, as upstream expands workingDirectory.
    writeRawConfig('portable', { id: 'proj_port0001', name: 'Port', folder: { workingDirectory: '~/code', projectKey: STABLE_KEY }, createdAt: 1, updatedAt: 1 });
    expect(loadProjectConfig(workspaceRoot, 'portable')?.folder).toEqual({ workingDirectory: join(homedir(), 'code'), projectKey: STABLE_KEY });
  });

  it('boundary: a folder under the home directory is stored in the portable ~ form and read back absolute', () => {
    const slug = createProject(workspaceRoot, { name: 'Home' }, handle({ displayPath: join(homedir(), 'code', 'repo') })).slug;
    expect((rawConfig(slug).folder as { workingDirectory: string }).workingDirectory).toBe('~/code/repo');
    expect(loadProject(workspaceRoot, slug)?.config.folder?.workingDirectory).toBe(join(homedir(), 'code', 'repo'));
  });
});

describe('UA5.2 — columns (zod), names and slugs', () => {
  it('positive: a valid ordered column set round-trips; an empty set (upstream\'s "last column removed") is legal', () => {
    const slug = makeProjectSlug('Board');
    const columns = [
      { id: 'todo', name: 'To do', dropStatusId: 'todo' },
      { id: 'col-1a2b3c4d', name: 'Review', color: '#6366f1' },
    ];
    expect(updateProject(workspaceRoot, slug, { kanbanColumns: columns }).kanbanColumns).toEqual(columns);
    expect(loadProject(workspaceRoot, slug)?.config.kanbanColumns).toEqual(columns);
    expect(updateProject(workspaceRoot, slug, { kanbanColumns: [] }).kanbanColumns).toEqual([]);
  });

  it('negative: duplicate column ids or an empty column name are refused, and nothing is written', () => {
    const slug = makeProjectSlug('Board');
    const before = readFileSync(join(getProjectPath(workspaceRoot, slug), 'config.json'), 'utf-8');
    expect(() => updateProject(workspaceRoot, slug, { kanbanColumns: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }] }))
      .toThrow('project-columns-invalid: duplicate column id "a"');
    expect(() => updateProject(workspaceRoot, slug, { kanbanColumns: [{ id: 'a', name: '   ' }] }))
      .toThrow('project-columns-invalid: column name must not be empty');
    expect(() => parseKanbanColumns([{ id: '../x', name: 'X' }])).toThrow('project-columns-invalid');
    expect(readFileSync(join(getProjectPath(workspaceRoot, slug), 'config.json'), 'utf-8')).toBe(before);
  });

  it('negative: an invalid column set written on disk is dropped on read (the board falls back to the defaults)', () => {
    writeRawConfig('cols', { id: 'proj_cols0001', name: 'Cols', kanbanColumns: [{ id: 'x', name: '' }], createdAt: 1, updatedAt: 1 });
    const loaded = loadProjectConfig(workspaceRoot, 'cols')!;
    expect(loaded.name).toBe('Cols');
    expect(loaded.kanbanColumns).toBeUndefined();
  });

  it('negative: an empty project name is refused on create and on update', () => {
    expect(() => createProject(workspaceRoot, { name: '  ' })).toThrow('project-name-required');
    const slug = makeProjectSlug('Named');
    expect(() => updateProject(workspaceRoot, slug, { name: '' })).toThrow('project-name-required');
    expect(loadProjectConfig(workspaceRoot, slug)?.name).toBe('Named');
  });

  it('UA5.8 follow-up: an emptied description, details or colour is removed, never stored as "" (the colour dots fall back with ??)', () => {
    const slug = makeProjectSlug('Tinted');
    updateProject(workspaceRoot, slug, { description: 'd', details: 'x', color: '#6366f1' });
    // Positive: '' clears a stored value — the key is gone on disk and on read.
    const cleared = updateProject(workspaceRoot, slug, { description: '', details: '  ', color: '' });
    expect('color' in cleared).toBe(false);
    expect('description' in rawConfig(slug)).toBe(false);
    expect('details' in rawConfig(slug)).toBe(false);
    expect('color' in rawConfig(slug)).toBe(false);
    // Boundary: a project that never had a colour, saved with '', still has none; a non-empty value is kept.
    const named = updateProject(workspaceRoot, makeProjectSlug('Plain'), { name: 'Plain 2', color: '' });
    expect('color' in named).toBe(false);
    expect(updateProject(workspaceRoot, slug, { color: '#ef4444', description: 'kept' })).toMatchObject({ color: '#ef4444', description: 'kept' });
  });

  it('negative: an unsafe slug never becomes a path — delete("..") refuses and the workspace survives', () => {
    makeProjectSlug('Keep');
    expect(() => deleteProject(workspaceRoot, '..')).toThrow('project-slug-invalid');
    expect(existsSync(workspaceRoot)).toBe(true);
    expect(loadProject(workspaceRoot, '../workspace')).toBeNull();
    expect(loadProjectMemory(workspaceRoot, '..')).toBeNull();
    // A config.json whose own slug points elsewhere is read under its directory name.
    writeRawConfig('honest', { id: 'proj_hon00001', slug: '../../escape', name: 'Honest', createdAt: 1, updatedAt: 1 });
    expect(loadProjectConfig(workspaceRoot, 'honest')?.slug).toBe('honest');
    expect(updateProject(workspaceRoot, 'honest', { description: 'x' }).slug).toBe('honest');
    expect(existsSync(join(tempDir, 'escape'))).toBe(false);
  });

  it('positive: loadProjectById finds a project by its stable id', () => {
    const created = createProject(workspaceRoot, { name: 'By id' });
    expect(loadProjectById(workspaceRoot, created.id)?.config.slug).toBe(created.slug);
    expect(loadProjectById(workspaceRoot, 'proj_missing0')).toBeNull();
  });
});

describe('UA5.2 — the context.md writer hook (UA5.5 registers it)', () => {
  it('positive: every config write calls the hook with the written config; null removes it', () => {
    const seen: Array<{ root: string; config: ProjectConfig }> = [];
    setProjectConfigWrittenHook((root, config) => { seen.push({ root, config }); });
    const created = createProject(workspaceRoot, { name: 'Hooked' }, handle());
    updateProject(workspaceRoot, created.slug, { details: 'context' });
    setProjectFolderFromHandle(workspaceRoot, created.slug, null);
    expect(seen.map(entry => entry.root)).toEqual([workspaceRoot, workspaceRoot, workspaceRoot]);
    expect(seen[0]!.config.folder?.workingDirectory).toBe('/work/repo');
    expect(seen[1]!.config.details).toBe('context');
    expect(seen[2]!.config.folder).toBeUndefined();

    setProjectConfigWrittenHook(null);
    updateProject(workspaceRoot, created.slug, { details: 'quiet' });
    expect(seen).toHaveLength(3);
  });

  it('negative: a refused write never reaches the hook', () => {
    const slug = makeProjectSlug('Refused');
    let calls = 0;
    setProjectConfigWrittenHook(() => { calls++; });
    expect(() => updateProject(workspaceRoot, slug, { kanbanColumns: [{ id: 'a', name: '' }] })).toThrow();
    expect(() => updateProject(workspaceRoot, slug, { folder: undefined } as never)).toThrow();
    expect(calls).toBe(0);
  });
});

describe('UA5.2 — workspace lifecycle', () => {
  it('OQ-21: a new workspace still seeds the string-valued "Project" label beside the Projects entity', async () => {
    const configDir = join(tempDir, 'config');
    mkdirSync(configDir, { recursive: true });
    const service = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [], deleteWorkspaceCredentials: async () => {} },
      quiescence: { async acquire() { return { release: async () => {} }; } },
    });
    const created = await service.create({ name: 'Labels' });
    const root = service.resolve(created.id).workspaceRootPath;
    createProject(root, { name: 'Entity' });
    const project = loadLabelConfig(root).labels.find(label => label.id === 'project');
    expect(project).toMatchObject({ id: 'project', name: 'Project', valueType: 'string' });
    expect(getDefaultLabelConfig().labels.some(label => label.id === 'project')).toBe(true);
  });

  it('result (no cleanup participant needed): a workspace delete removes its projects directory with none registered', async () => {
    const configDir = join(tempDir, 'config');
    mkdirSync(configDir, { recursive: true });
    const service = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [], deleteWorkspaceCredentials: async () => {} },
      quiescence: { async acquire() { return { release: async () => {} }; } },
    });
    const created = await service.create({ name: 'Delete Me' });
    const root = service.resolve(created.id).workspaceRootPath;
    const slug = createProject(root, { name: 'Gone with it' }).slug;
    const projectDir = getProjectPath(root, slug);
    // Control: the directory exists before the delete.
    expect(existsSync(join(projectDir, 'config.json'))).toBe(true);
    expect(await service.delete(created.id)).toEqual({ deleted: true, cleanupFailures: [] });
    expect(existsSync(projectDir)).toBe(false);
  });
});

describe('sanitizeAssetFilename (v0.13.4 arms)', () => {
  it('strips control chars and NUL bytes (the literal-NUL regex fix)', () => {
    // A NUL, newline, and tab are all removed — the source regex no longer carries a literal NUL.
    expect(sanitizeAssetFilename('re\x00port\n\t.pdf')).toBe('report.pdf');
  });

  it('strips path separators and leading dots so an upload stays in the assets dir', () => {
    expect(sanitizeAssetFilename('..\\..\\etc\\passwd')).toBe('etcpasswd');
  });

  it('falls back to a generated name when the input reduces to empty', () => {
    expect(sanitizeAssetFilename('\x00\n\t')).toMatch(/^asset_[0-9a-f]{8}$/);
  });
});

describe('UA5.6 — project assets (v0.13.4 asset CRUD)', () => {
  it('POSITIVE: upload (base64, text), then list — newest first, sizes and types read back, a taken name gets -2', () => {
    const slug = makeProjectSlug('Assets');
    const assetsDir = getProjectAssetsPath(workspaceRoot, slug);
    const pdf = uploadProjectAsset(workspaceRoot, slug, { filename: 'report.pdf', base64: Buffer.from('%PDF-1.4 x').toString('base64') });
    const notes = uploadProjectAsset(workspaceRoot, slug, { filename: 'notes.md', text: '# Notes\n' });
    const again = uploadProjectAsset(workspaceRoot, slug, { filename: 'notes.md', text: '# Second\n' });
    expect(pdf).toMatchObject({ filename: 'report.pdf', sizeBytes: 10, mimeType: 'application/pdf', absolutePath: join(assetsDir, 'report.pdf') });
    expect(notes.filename).toBe('notes.md');
    expect(again.filename).toBe('notes-2.md');
    expect(readFileSync(join(assetsDir, 'notes-2.md'), 'utf-8')).toBe('# Second\n');
    // Distinct mtimes, so "newest first" is a reading and not an accident of readdir order.
    utimesSync(pdf.absolutePath, 1_000, 1_000);
    utimesSync(notes.absolutePath, 2_000, 2_000);
    utimesSync(again.absolutePath, 3_000, 3_000);
    expect(listProjectAssets(workspaceRoot, slug).map(asset => [asset.filename, asset.sizeBytes])).toEqual([
      ['notes-2.md', 9],
      ['notes.md', 8],
      ['report.pdf', 10],
    ]);
    deleteProjectAsset(workspaceRoot, slug, 'notes.md');
    expect(listProjectAssets(workspaceRoot, slug).map(asset => asset.filename)).toEqual(['notes-2.md', 'report.pdf']);
  });

  it('NEGATIVE: a traversal name is refused its path — the upload lands inside assets/ and the project config is untouched', () => {
    const slug = makeProjectSlug('Traversal');
    const configPath = join(getProjectPath(workspaceRoot, slug), 'config.json');
    const configBefore = readFileSync(configPath, 'utf-8');
    const up = uploadProjectAsset(workspaceRoot, slug, { filename: '../../config.json', text: '{"evil":true}' });
    const win = uploadProjectAsset(workspaceRoot, slug, { filename: '..\\..\\..\\settings.json', text: 'x' });
    expect(up.absolutePath).toBe(join(getProjectAssetsPath(workspaceRoot, slug), 'config.json'));
    expect(win.absolutePath).toBe(join(getProjectAssetsPath(workspaceRoot, slug), 'settings.json'));
    expect(readFileSync(configPath, 'utf-8')).toBe(configBefore);
    expect(existsSync(join(workspaceRoot, 'config.json'))).toBe(false);
    expect(existsSync(join(workspaceRoot, 'projects', 'config.json'))).toBe(false);
    // Delete is held to the same rule: '../config.json' names the ASSET, never the project's config.
    deleteProjectAsset(workspaceRoot, slug, '../config.json');
    expect(readFileSync(configPath, 'utf-8')).toBe(configBefore);
    expect(existsSync(up.absolutePath)).toBe(false);
  });

  it('NEGATIVE: an unknown project or an unsafe slug writes nothing', () => {
    expect(() => uploadProjectAsset(workspaceRoot, 'nope', { filename: 'a.txt', text: 'x' })).toThrow('project-not-found');
    expect(existsSync(join(workspaceRoot, 'projects', 'nope'))).toBe(false);
    expect(() => uploadProjectAsset(workspaceRoot, '..', { filename: 'a.txt', text: 'x' })).toThrow();
    expect(() => listProjectAssets(workspaceRoot, '..')).toThrow('project-slug-invalid');
    expect(() => deleteProjectAsset(workspaceRoot, '..', 'a.txt')).toThrow('project-slug-invalid');
    const slug = makeProjectSlug('Empty');
    expect(() => uploadProjectAsset(workspaceRoot, slug, { filename: 'a.txt' })).toThrow('uploadProjectAsset requires one of');
  });

  it('NEGATIVE (NESSY): a symlink planted in assets/ is neither listed nor written through', () => {
    const slug = makeProjectSlug('Links');
    const assetsDir = getProjectAssetsPath(workspaceRoot, slug);
    const outside = join(tempDir, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(join(outside, 'secret.txt'), join(assetsDir, 'linked.txt'));
    symlinkSync(join(outside, 'dangling.txt'), join(assetsDir, 'a.txt'));
    expect(listProjectAssets(workspaceRoot, slug)).toEqual([]);
    const up = uploadProjectAsset(workspaceRoot, slug, { filename: 'a.txt', text: 'upload' });
    expect(up.filename).toBe('a-2.txt');
    expect(existsSync(join(outside, 'dangling.txt'))).toBe(false);
    // Control: the regular file beside the links is listed.
    expect(listProjectAssets(workspaceRoot, slug).map(asset => asset.filename)).toEqual(['a-2.txt']);
  });
});
