import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const directory = fileURLToPath(new URL('../shared/skills/', import.meta.url));
const lock = JSON.parse(readFileSync(new URL('../shared/skills.lock.json', import.meta.url)));
const policy = JSON.parse(readFileSync(new URL('../shared/skills-policy.json', import.meta.url)));

test('selected catalog retains the requested local, browser and Obsidian sources', () => {
  assert.equal(lock.schemaVersion, 1);
  const expected = [
    'obra/superpowers', 'mattpocock/skills', 'anthropics/skills',
    'multica-ai/andrej-karpathy-skills', 'JuliusBrussee/caveman',
    'smixs/pohuy', 'code-yeongyu/oh-my-openagent', 'Leonxlnx/taste-skill',
    'blader/humanizer', 'Graphify-Labs/graphify',
    'kepano/obsidian-skills',
    'heygen-com/hyperframes', 'calesthio/OpenMontage',
    'user-supplied/skills',
  ];
  assert.deepEqual(lock.sources.map(source => source.repository).sort(), expected.sort());
  for (const source of lock.sources) {
    assert.match(source.revision, source.kind === 'local' ? /^[a-f0-9]{64}$/ : /^[a-f0-9]{40}$/);
    assert.equal(lock.skills.filter(skill => skill.repository === source.repository).length, source.skills);
    assert.ok(source.skills > 0);
  }
  const names = new Set(lock.skills.map(skill => skill.name));
  for (const name of ['dispatching-parallel-agents', 'subagent-driven-development', 'skill-creator', 'grill-me', 'caveman', 'pohuy', 'graphify', 'browser', 'webapp-testing', 'obsidian-cli', 'obsidian-markdown', 'hyperframes', 'video-edit', 'omo-codex-lsp']) {
    assert.ok(names.has(name), `Named guide capability is missing: ${name}`);
  }
});

test('externally dependent skills are absent and retained metadata needs no provider credentials', () => {
  assert.equal(lock.selectionProfile, 'local-browser-obsidian');
  assert.equal(policy.profile, lock.selectionProfile);
  const names = new Set(lock.skills.map(skill => skill.name));
  const added = (lock.addedImports ?? []).reduce((count, batch) => count + batch.addedSkills, 0);
  assert.equal(names.size + policy.removed.length + lock.consolidation.mergedEntries, lock.originalImport.skills + added);
  for (const removed of policy.removed) {
    assert.ok(!names.has(removed.name), `Excluded skill returned: ${removed.name}`);
    assert.ok(!readdirSync(directory).includes(removed.name));
  }
  for (const name of ['figma', 'last30days', 'tldraw-offline', 'claude-api', 'caveman-compress', 'caveman-setup', 'elevenlabs', 'create-video', 'video-toolkit', 'comfyui', 'omo-codex-teammode']) {
    assert.ok(!names.has(name), `External workflow must be excluded: ${name}`);
  }
  const exceptions = new Set((policy.explicitExceptions ?? []).map(entry => entry.name));
  assert.deepEqual([...names].sort(), [...policy.localOnlySkills, ...exceptions, ...policy.scopedSkills.map(skill => skill.name)].sort());
  for (const skill of lock.skills) {
    if (exceptions.has(skill.name)) {
      assert.equal(skill.executionProfile, 'user-approved-exception');
      const batch = lock.addedImports.find(entry => entry.id === skill.importBatch);
      assert.equal(batch?.externalExceptionsAuthorized, true);
      continue;
    }
    if (skill.executionProfile === 'scoped-variants') {
      assert.equal(skill.primaryExecutionProfile, policy.profile);
      assert.ok(skill.mergedVariants.length > 0);
    } else assert.equal(skill.executionProfile, policy.profile);
    const header = readFileSync(join(directory, skill.name, 'SKILL.md'), 'utf8').split('\n---\n')[0];
    const metadataLine = header.split('\n').find(line => line.startsWith('metadata: '));
    const metadata = metadataLine ? JSON.parse(metadataLine.slice(10)) : {};
    const required = metadata.openclaw?.requires;
    assert.ok(!required?.env?.length && !required?.env_any?.length, `Cloud credentials still required: ${skill.name}`);
  }
});

test('skill names and discovery metadata are valid and unambiguous for both hosts', () => {
  const names = new Set();
  for (const skill of lock.skills) {
    assert.match(skill.name, /^[a-z0-9][a-z0-9-]{0,63}$/);
    assert.ok(!names.has(skill.name), `Duplicate ${skill.name}`);
    names.add(skill.name);
    const content = readFileSync(join(directory, skill.name, 'SKILL.md'), 'utf8');
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]+)$/);
    assert.ok(match, `Invalid frontmatter/body: ${skill.name}`);
    const metadata = Object.fromEntries(match[1].split('\n').map(line => {
      const field = line.match(/^([a-z][a-z0-9_-]*): (.+)$/);
      assert.ok(field, `Invalid metadata field: ${skill.name}`);
      return [field[1], JSON.parse(field[2])];
    }));
    assert.equal(metadata.name, skill.name);
    assert.equal(metadata.description, skill.description);
    assert.ok(skill.description.length > 0 && skill.description.length <= 1024);
    assert.ok(match[2].trim().length > 0);
    const origin = JSON.parse(readFileSync(join(directory, skill.name, 'UPSTREAM.json')));
    assert.equal(origin.repository, skill.repository);
    assert.equal(origin.path, skill.path);
  }
  const folders = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  assert.deepEqual(folders.sort(), [...names, 'odysseus-workspace'].sort());
});

test('all supplied definitions are imported or preserved as identical nested copies', () => {
  const report = JSON.parse(readFileSync(new URL('../shared/user-skills-import.json', import.meta.url)));
  const batch = lock.addedImports.find(entry => entry.id === report.id);
  assert.equal(batch.addedSkills, report.addedSkills);
  assert.equal(batch.sourceDefinitions, report.sourceDefinitions);
  assert.equal(report.items.length, report.sourceDefinitions);
  assert.equal(new Set(report.items.map(entry => entry.sourcePath)).size, report.sourceDefinitions);
  const added = report.items.filter(entry => entry.action === 'added');
  const duplicates = report.items.filter(entry => entry.action === 'identical-duplicate');
  assert.equal(added.length, report.addedSkills);
  assert.equal(duplicates.length, report.deduplicatedDefinitions);
  const resolveImport = name => {
    const canonical = lock.consolidation.aliases[name] ?? name;
    const skill = lock.skills.find(skill => skill.name === canonical);
    assert.ok(skill, `Missing imported capability: ${name}`);
    return { canonical, skill, resourceRoot: canonical === name ? join(directory, canonical) : join(directory, canonical, 'variants', name) };
  };
  for (const item of added) {
    const resolved = resolveImport(item.name);
    const origin = JSON.parse(readFileSync(join(resolved.resourceRoot, 'UPSTREAM.json')));
    assert.equal(origin.path, item.sourcePath);
    assert.equal(origin.repository, 'user-supplied/skills');
  }
  for (const item of duplicates) {
    const embeddedPath = item.sourcePath.split('/').slice(1).join('/').replace(/SKILL\.md$/, 'GUIDE.md');
    const embedded = readFileSync(join(directory, item.preservedInside, embeddedPath));
    const origin = JSON.parse(readFileSync(join(resolveImport(item.name).resourceRoot, 'UPSTREAM.json')));
    assert.equal(createHash('sha256').update(embedded).digest('hex'), origin.upstreamSkillSha256);
  }

});

test('all bundled scripts, references, assets and attribution files match the pinned import', () => {
  let count = 0;
  for (const skill of lock.skills) {
    for (const [relative, entry] of Object.entries(skill.files)) {
      assert.ok(!relative.split('/').includes('..'));
      const path = join(directory, skill.name, relative);
      assert.ok(!lstatSync(path).isSymbolicLink(), path);
      const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
      assert.equal(digest, entry.sha256, `${skill.name}/${relative} differs from import lock`);
      assert.equal(Boolean(lstatSync(path).mode & 0o111), entry.executable, `Executable mode differs: ${path}`);
      count++;
    }
  }
  assert.ok(count > lock.skills.length);
});

test('consolidation preserves every variant resource without conflicting file overwrites', () => {
  const aliases = lock.consolidation.aliases;
  assert.equal(Object.keys(aliases).length, lock.consolidation.mergedEntries);
  for (const [old, canonical] of Object.entries(aliases)) {
    assert.ok(!lock.skills.some(skill => skill.name === old));
    assert.ok(!aliases[canonical], 'Alias must point directly to an active entry');
    const skill = lock.skills.find(skill => skill.name === canonical);
    const variant = skill.mergedVariants.find(variant => variant.name === old);
    assert.ok(variant);
    const router = readFileSync(join(directory, canonical, 'SKILL.md'), 'utf8');
    assert.ok(router.includes(variant.guide));
    for (const [relative, file] of Object.entries(variant.files)) {
      // UI text was deliberately localized. All code, assets, licenses and
      // original guide content must remain byte-for-byte intact.
      if (relative.endsWith('openai.yaml')) continue;
      const projected = relative === 'SKILL.md' ? 'GUIDE.md' : relative;
      const path = join(directory, canonical, variant.resourceRoot, projected);
      assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), file.sha256, path);
      assert.equal(Boolean(lstatSync(path).mode & 0o111), file.executable);
    }
    if (variant.executionProfile === 'user-approved-exception') {
      assert.ok(lock.addedImports.find(batch => batch.id === variant.importBatch)?.externalExceptionsAuthorized);
    }
  }
});

test('every active skill has Russian discovery metadata, matching invocation controls and a handbook entry', () => {
  const catalog = JSON.parse(readFileSync(new URL('../shared/skills-catalog.json', import.meta.url)));
  const handbook = readFileSync(new URL('../docs/skills-catalog-ru.md', import.meta.url), 'utf8');
  assert.equal(catalog.entries.length, lock.skills.length + 1);
  const names = new Set();
  for (const entry of catalog.entries) {
    assert.ok(!names.has(entry.name)); names.add(entry.name);
    const text = readFileSync(join(directory, entry.name, 'SKILL.md'), 'utf8');
    const header = Object.fromEntries(text.split('\n---\n')[0].split('\n').slice(1).map(line => {
      const index = line.indexOf(': '); return [line.slice(0, index), JSON.parse(line.slice(index + 2))];
    }));
    assert.match(entry.description, /[А-Яа-яЁё]/u);
    assert.equal(header.description, entry.description);
    assert.equal(header['disable-model-invocation'], !entry.automatic);
    assert.equal(header['user-invocable'], true);
    assert.equal(header.when_to_use, entry.when);
    assert.ok(handbook.includes(`### ${entry.name}\n`));
    for (const field of ['when', 'how', 'example', 'dependencies']) assert.ok(entry[field]?.length > 20, `${entry.name}: ${field}`);
    for (const resource of entry.resources) assert.ok(lstatSync(join(directory, entry.name, resource)).isFile());
    assert.equal(text.split('<!-- odysseus-invocation-policy -->').length, 2);
    for (const resource of Object.keys(lock.skills.find(skill => skill.name === entry.name)?.files ?? {})) {
      if (!resource.endsWith('openai.yaml')) continue;
      const ui = JSON.parse(readFileSync(join(directory, entry.name, resource), 'utf8'));
      assert.match(ui.interface.short_description, /[А-Яа-яЁё]/u);
      assert.ok(ui.interface.short_description.length >= 25 && ui.interface.short_description.length <= 64);
      assert.equal(ui.policy.allow_implicit_invocation, resource === 'agents/openai.yaml' && entry.automatic);
    }
  }
  for (const name of ['jira', 'time-messenger', 'gitlab-cli', 'n8n-cli', 'artifact-publish', 'allure-testops', 'pohuy', 'caveman']) {
    assert.equal(catalog.entries.find(entry => entry.name === name).automatic, false, name);
  }
  for (const name of ['browser', 'obsidian-markdown', 'pdf', 'mermaid', 'systematic-debugging']) {
    assert.equal(catalog.entries.find(entry => entry.name === name).automatic, true, name);
  }
});
