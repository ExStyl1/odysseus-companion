import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { plan, apply, loadConfig } from './rebrand.mjs';

const profile = loadConfig(
  fileURLToPath(new URL('./nessy.json', import.meta.url)),
);
const config = {
  ...profile,
  patches: [],
  assets: undefined,
  remoteImages: undefined,
  mentionsBaseline: undefined,
};
function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rebrand-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), data);
  }
  return root;
}

const digest = (value) => createHash('sha256').update(value).digest('hex');

function reviewedMentions(t, files) {
  const root = fixture(t, files);
  const baseline = {
    entries: plan(root, config).report.mentions.current.map(
      ({ file, scope, text, count }) => ({ file, scope, text, count }),
    ),
  };
  const configDir = fixture(t, {
    'baseline.json': JSON.stringify(baseline),
  });
  return {
    root,
    configDir,
    baseline,
    reviewed: { ...config, mentionsBaseline: 'baseline.json' },
  };
}

test('split and inline profiles produce identical plans; fragment contents affect the hash', (t) => {
  const { root, configDir, reviewed } = reviewedMentions(t, {
    'brand.txt': 'Qwen Code\nqwen-oauth\n',
  });
  const inline = {
    ...reviewed,
    assets: [],
    remoteImages: [],
    replaceBeforePreserve: [],
  };
  const split = { ...inline };
  fs.mkdirSync(path.join(configDir, 'rules'));
  for (const key of [
    'replace',
    'preserve',
    'patches',
    'assets',
    'remoteImages',
    'replaceBeforePreserve',
  ]) {
    split[key] = `rules/${key}.json`;
    fs.writeFileSync(
      path.join(configDir, split[key]),
      JSON.stringify(inline[key]),
    );
  }
  const file = path.join(configDir, 'profile.json');
  fs.writeFileSync(file, JSON.stringify(inline));
  assert.deepEqual(loadConfig(file), inline);
  const before = plan(root, loadConfig(file), configDir);
  fs.writeFileSync(file, JSON.stringify(split));
  assert.equal(JSON.stringify(loadConfig(file)), JSON.stringify(inline));
  assert.deepEqual(plan(root, loadConfig(file), configDir), before);
  fs.writeFileSync(
    path.join(configDir, split.replace),
    JSON.stringify([...inline.replace, { from: 'another', to: 'replacement' }]),
  );
  assert.notEqual(
    plan(root, loadConfig(file), configDir).report.configHash,
    before.report.configHash,
  );
});

test('missing or invalid rule fragments cannot silently disable rules', (t) => {
  const root = fixture(t, {
    'profile.json': JSON.stringify({ replace: 'rules.json', preserve: [] }),
  });
  const file = path.join(root, 'profile.json');
  assert.throws(() => loadConfig(file), /ENOENT.*rules\.json/);
  for (const contents of ['null', '{}', '"another.json"']) {
    fs.writeFileSync(path.join(root, 'rules.json'), contents);
    assert.throws(
      () => loadConfig(file),
      /replace requires an array.*rules\.json/,
    );
  }
  fs.writeFileSync(path.join(root, 'rules.json'), '{invalid json');
  assert.throws(() => loadConfig(file), SyntaxError);
});

test('patch fragments resolve from the main profile and their exact bytes affect the hash', (t) => {
  const root = fixture(t, { 'logo.txt': 'before\nOLD\nafter\n' });
  const configDir = fixture(t, {
    'profile.json': JSON.stringify({
      ...config,
      patches: 'rules/patches.json',
    }),
    'rules/patches.json': JSON.stringify([
      { path: 'logo.txt', from: 'OLD\n', toFile: 'assets/logo.txt', count: 1 },
    ]),
    'assets/logo.txt': '  NEW\n',
  });
  const file = path.join(configDir, 'profile.json');
  const loaded = loadConfig(file);
  assert.equal(loaded.patches[0].to, '  NEW\n');
  const first = plan(root, loaded, configDir);
  assert.equal(first.entries[0].after.toString(), 'before\n  NEW\nafter\n');
  fs.writeFileSync(path.join(configDir, 'assets/logo.txt'), '  CHANGED\n');
  assert.notEqual(
    plan(root, loadConfig(file), configDir).report.configHash,
    first.report.configHash,
  );
  apply(first);
  assert.equal(plan(root, loaded, configDir).changes.length, 0);
});

test('patch fragments reject ambiguous, missing, empty and escaping replacements', (t) => {
  const outside = fixture(t, { 'outside.txt': 'OUTSIDE' });
  const configDir = fixture(t, { 'replacement.txt': 'NEW', 'empty.txt': '' });
  fs.symlinkSync(
    path.join(outside, 'outside.txt'),
    path.join(configDir, 'link.txt'),
  );
  const file = path.join(configDir, 'profile.json');
  const load = (extra) => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...config,
        patches: [{ path: 'logo.txt', from: 'OLD', count: 1, ...extra }],
      }),
    );
    return loadConfig(file);
  };
  assert.throws(
    () => load({ to: 'NEW', toFile: 'replacement.txt' }),
    /either to or toFile/,
  );
  for (const toFile of ['', null, 42])
    assert.throws(() => load({ toFile }), /either to or toFile/);
  assert.throws(() => load({ toFile: 'missing.txt' }), /ENOENT/);
  for (const toFile of [
    path.relative(configDir, path.join(outside, 'outside.txt')),
    path.join(outside, 'outside.txt'),
    'link.txt',
  ])
    assert.throws(() => load({ toFile }), /fragment escapes config directory/);
  const root = fixture(t, { 'logo.txt': 'OLD' });
  assert.throws(
    () => plan(root, load({ toFile: 'empty.txt' }), configDir),
    /non-empty markers/,
  );
});

test('Desktop logo patches preserve surrounding fork code and reuse the master artwork', (t) => {
  const targets = profile.patches.filter((patch) =>
    patch.to.includes('data:image/svg+xml;base64,'),
  );
  assert.equal(targets.length, 3);
  const artwork = fs.readFileSync(
    new URL('./assets/icon.svg', import.meta.url),
  );
  for (const logo of targets) {
    assert.equal(
      profile.assets.some((asset) => asset.path === logo.path),
      false,
    );
    const patches = profile.patches.filter((patch) => patch.path === logo.path);
    const root = fixture(t, {
      [logo.path]: patches.map((patch) => patch.from).join('\n'),
    });
    const file = path.join(root, logo.path);
    const original = fs.readFileSync(file, 'utf8');
    const custom = 'export const customForkBehavior = () => "preserved";\n';
    fs.writeFileSync(file, custom + original);
    const localized = { ...config, patches };
    apply(plan(root, localized));
    const after = fs.readFileSync(file, 'utf8');
    assert.ok(after.startsWith(custom));
    const embedded = after.match(
      /data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/,
    );
    assert.ok(embedded);
    assert.deepEqual(Buffer.from(embedded[1], 'base64'), artwork);
    fs.appendFileSync(file, '\nexport const laterForkChange = true;\n');
    assert.equal(plan(root, localized).changes.length, 0);
    for (const changed of [
      original.replace(logo.from, ''),
      original.replace('viewBox=', 'data-viewBox='),
      original + '\n' + logo.from,
    ]) {
      fs.writeFileSync(file, custom + changed);
      assert.throws(() => plan(root, localized), /Patch drift/);
      assert.equal(fs.readFileSync(file, 'utf8'), custom + changed);
    }
  }
});

test('new files, contexts, literals and duplicates under old exceptions block all writes', (t) => {
  const line = 'const auth = "qwen-oauth";\n';
  const scenarios = [
    { file: 'new.ts', text: line },
    { file: 'src/auth.ts', text: line + 'const another = "qwen-oauth";\n' },
    { file: 'src/auth.ts', text: line + line },
    { file: 'src/auth.ts', text: 'const auth = "https://qwen.ai/new";\n' },
  ];
  for (const scenario of scenarios) {
    const { root, configDir, reviewed } = reviewedMentions(t, {
      'src/auth.ts': line,
      'brand.txt': 'Qwen Code',
    });
    fs.writeFileSync(path.join(root, scenario.file), scenario.text);
    const result = plan(root, reviewed, configDir);
    assert.equal(result.report.mentions.added.length, 1);
    const added = result.report.mentions.added[0];
    assert.equal(added.file, scenario.file);
    assert.equal(added.extra, 1);
    assert.ok(added.lines.length);
    assert.ok(added.rules.length);
    assert.equal(result.report.unexpected[0].kind, 'new-remaining-mention');
    assert.throws(() => apply(result), /new remaining mention/);
    assert.equal(
      fs.readFileSync(path.join(root, 'brand.txt'), 'utf8'),
      'Qwen Code',
    );
  }
});

test('line shifts and indentation are stable; removals are reported but allowed', (t) => {
  const { root, configDir, reviewed } = reviewedMentions(t, {
    'auth.ts': 'qwen-oauth\nqwen-oauth\n',
  });
  fs.writeFileSync(
    path.join(root, 'auth.ts'),
    '// New heading\n  qwen-oauth\n',
  );
  const result = plan(root, reviewed, configDir);
  assert.equal(result.report.unexpected.length, 0);
  assert.equal(result.report.mentions.removed[0].missing, 1);
  assert.deepEqual(result.report.mentions.current[0].lines, [2]);
  apply(result);
  fs.unlinkSync(path.join(root, 'auth.ts'));
  const removed = plan(root, reviewed, configDir);
  assert.equal(removed.report.unexpected.length, 0);
  assert.equal(removed.report.mentions.removed[0].missing, 2);
});

test('inventory counts literal mentions once and uses the final path before and after apply', (t) => {
  const { root, configDir, reviewed, baseline } = reviewedMentions(t, {
    'qwen-links.md': 'https://github.com/QwenLM/qwen-code\n',
  });
  assert.equal(baseline.entries[0].file, 'nessy-links.md');
  assert.equal(baseline.entries[0].count, 2);
  const before = plan(root, reviewed, configDir);
  assert.deepEqual(before.report.mentions.current[0].rules, [
    'external-urls',
    'upstream-repository',
  ]);
  apply(before);
  const after = plan(root, reviewed, configDir);
  assert.equal(after.changes.length, 0);
  assert.equal(after.report.unexpected.length, 0);
  assert.deepEqual(
    after.report.mentions.current,
    before.report.mentions.current,
  );
});

test('baseline ignores exception IDs and aggregates rules for repeated contexts in the report', (t) => {
  const { root, configDir, reviewed, baseline } = reviewedMentions(t, {
    'auth.txt': 'first\nqwen-oauth\nsecond\nqwen-oauth\n',
  });
  assert.deepEqual(baseline, {
    entries: [
      { file: 'auth.txt', scope: 'content', text: 'qwen-oauth', count: 2 },
    ],
  });
  const result = plan(
    root,
    {
      ...reviewed,
      preserve: [
        { id: 'first-provider', pattern: 'first\nqwen-oauth' },
        { id: 'second-provider', pattern: 'second\nqwen-oauth' },
      ],
    },
    configDir,
  );
  assert.equal(result.report.unexpected.length, 0);
  assert.deepEqual(result.report.mentions.added, []);
  assert.deepEqual(result.report.mentions.removed, []);
  assert.deepEqual(result.report.mentions.current, [
    {
      ...baseline.entries[0],
      rules: ['first-provider', 'second-provider'],
      lines: [2, 4],
    },
  ]);
});

test('baseline content affects the profile hash and invalid entries cannot disable the gate', (t) => {
  const { root, configDir, reviewed, baseline } = reviewedMentions(t, {
    'auth.ts': 'qwen-oauth\n',
  });
  const before = plan(root, reviewed, configDir).report.configHash;
  const file = path.join(configDir, 'baseline.json');
  baseline.entries[0].count++;
  fs.writeFileSync(file, JSON.stringify(baseline));
  assert.notEqual(plan(root, reviewed, configDir).report.configHash, before);
  for (const invalid of [
    null,
    {},
    { entries: [{ ...baseline.entries[0], count: 0 }] },
    { entries: [...baseline.entries, ...baseline.entries] },
  ]) {
    fs.writeFileSync(file, JSON.stringify(invalid));
    assert.throws(() => plan(root, reviewed, configDir), /baseline/i);
  }
});

test('provider hosts do not exempt internal common or complex identifiers', (t) => {
  const root = fixture(t, {
    'settings.ts':
      "'settings.qwen.common.name' 'qwen.complex' 'qwen.com' 'chat.qwen.ai'",
  });
  const result = plan(root, config);
  assert.equal(
    result.entries[0].after.toString(),
    "'settings.nessy.common.name' 'nessy.complex' 'qwen.com' 'chat.qwen.ai'",
  );
  assert.equal(result.report.unexpected.length, 0);
});

test('new preserved names and symlink targets are inventoried separately', (t) => {
  const { root, configDir, reviewed } = reviewedMentions(t, {
    'qwen-oauth.txt': 'provider documentation',
  });
  fs.symlinkSync('qwen-oauth.txt', path.join(root, 'current'));
  fs.writeFileSync(
    path.join(root, 'qwen-oauth-extra.txt'),
    'more documentation',
  );
  const result = plan(root, reviewed, configDir);
  assert.deepEqual(
    result.report.mentions.added.map((row) => row.scope).sort(),
    ['path', 'symlink'],
  );
  assert.equal(
    result.report.mentions.current.find((row) => row.file === 'qwen-oauth.txt')
      .scope,
    'path',
  );
  assert.throws(() => apply(result), /new remaining mention/);
});

test('replaces reviewed artwork byte-for-byte and keeps the renamed asset idempotent', (t) => {
  const original = Buffer.from([0, 1, 2, 3]);
  const replacement = Buffer.from([0, 9, 8, 7]);
  const root = fixture(t, { 'qwen.png': original });
  const configDir = fixture(t, { 'assets/nessy.png': replacement });
  const profile = {
    ...config,
    assets: [
      {
        path: 'qwen.png',
        sha256: digest(original),
        replaceWith: 'assets/nessy.png',
      },
    ],
  };
  const result = plan(root, profile, configDir);
  assert.equal(result.report.assets[0].action, 'replace');
  apply(result);
  assert.deepEqual(fs.readFileSync(path.join(root, 'nessy.png')), replacement);
  assert.equal(plan(root, profile, configDir).changes.length, 0);
});

test('unlisted binaries and neutral images can be added, updated or removed without config changes', (t) => {
  const original = Buffer.from([0, ...Buffer.from('Qwen binary bytes')]);
  const updated = Buffer.from([0xff, ...Buffer.from('updated binary')]);
  const root = fixture(t, {
    'vendor/rg': original,
    'icon.png': original,
    'icon.svg': '<svg>neutral icon</svg>',
  });
  const profile = { ...config, assets: [] };
  const before = plan(root, profile);
  assert.equal(before.changes.length, 0);
  assert.deepEqual(before.report.assets, []);
  apply(before);
  assert.deepEqual(fs.readFileSync(path.join(root, 'vendor/rg')), original);
  fs.writeFileSync(path.join(root, 'vendor/rg'), updated);
  fs.writeFileSync(path.join(root, 'new.bin'), original);
  fs.writeFileSync(
    path.join(root, 'icon.svg'),
    '<svg>updated neutral icon</svg>',
  );
  fs.unlinkSync(path.join(root, 'icon.png'));
  const after = plan(root, profile);
  assert.equal(after.changes.length, 0);
  apply(after);
  assert.deepEqual(fs.readFileSync(path.join(root, 'vendor/rg')), updated);
  assert.deepEqual(fs.readFileSync(path.join(root, 'new.bin')), original);
});

test('ASCII PDF bytes stay opaque while SVG text and symlink targets are still audited', (t) => {
  const pdf = '%PDF-1.4\n1 0 obj\n<< /Title (qwen-oauth) >>\nendobj\n%%EOF\n';
  const { root, configDir, reviewed } = reviewedMentions(t, {});
  fs.writeFileSync(path.join(root, 'document.pdf'), pdf);
  const profile = { ...reviewed, assets: [] };
  const result = plan(root, profile, configDir);
  assert.equal(result.changes.length, 0);
  assert.equal(result.report.unexpected.length, 0);
  assert.deepEqual(result.report.binary, ['document.pdf']);
  apply(result);
  assert.equal(fs.readFileSync(path.join(root, 'document.pdf'), 'utf8'), pdf);

  fs.writeFileSync(
    path.join(root, 'logo.svg'),
    '<svg><text>qwen-oauth</text></svg>',
  );
  fs.symlinkSync('qwen-oauth-target.pdf', path.join(root, 'linked.pdf'));
  const audited = plan(root, profile, configDir);
  assert.deepEqual(
    audited.report.mentions.added.map(({ file, scope }) => [file, scope]),
    [
      ['linked.pdf', 'symlink'],
      ['logo.svg', 'content'],
    ],
  );
  assert.throws(() => apply(audited), /new remaining mention/);
});

test('explicit asset replacements reject changed or missing targets and incomplete rules', (t) => {
  const original = '<svg>old icon</svg>';
  const replacement = '<svg>new icon</svg>';
  const root = fixture(t, { 'icon.svg': original });
  const configDir = fixture(t, { 'icon.svg': replacement });
  const item = {
    path: 'icon.svg',
    sha256: digest(original),
    replaceWith: 'icon.svg',
  };
  const reviewed = {
    ...config,
    assets: [item],
  };
  assert.equal(plan(root, reviewed, configDir).changes.length, 1);
  for (const field of ['replaceWith', 'sha256']) {
    assert.throws(
      () =>
        plan(
          root,
          { ...config, assets: [{ ...item, [field]: undefined }] },
          configDir,
        ),
      /Asset needs a replacement and SHA256/,
    );
  }
  fs.writeFileSync(
    path.join(root, 'icon.svg'),
    '<svg>changed upstream logo</svg>',
  );
  assert.throws(() => plan(root, reviewed, configDir), /Asset drift/);
  fs.unlinkSync(path.join(root, 'icon.svg'));
  assert.throws(() => plan(root, reviewed, configDir), /Missing asset/);
});

test('replacement files can be updated without config edits and must stay inside the config directory', (t) => {
  const root = fixture(t, { 'icon.svg': '<svg>old</svg>' });
  const configDir = fixture(t, { 'icon.svg': '<svg>new</svg>' });
  const item = {
    path: 'icon.svg',
    sha256: digest('<svg>old</svg>'),
    replaceWith: 'icon.svg',
  };
  const profile = { ...config, assets: [item] };
  assert.equal(plan(root, profile, configDir).changes.length, 1);
  const updated = '<svg>updated replacement</svg>';
  fs.writeFileSync(path.join(configDir, 'icon.svg'), updated);
  const result = plan(root, profile, configDir);
  assert.equal(result.entries[0].after.toString(), updated);
  apply(result);
  assert.equal(fs.readFileSync(path.join(root, 'icon.svg'), 'utf8'), updated);
  assert.equal(plan(root, profile, configDir).changes.length, 0);
  assert.throws(
    () =>
      plan(
        root,
        {
          ...profile,
          assets: [{ ...item, replaceWith: path.join(root, 'icon.svg') }],
        },
        configDir,
      ),
    /escapes/,
  );
});

test('replacement text artwork cannot silently exempt upstream brand text', (t) => {
  const original = '<svg>old logo</svg>';
  const replacement = '<svg><text>Qwen Code</text></svg>';
  const root = fixture(t, { 'logo.svg': original });
  const configDir = fixture(t, { 'logo.svg': replacement });
  const result = plan(
    root,
    {
      ...config,
      assets: [
        {
          path: 'logo.svg',
          sha256: digest(original),
          replaceWith: 'logo.svg',
        },
      ],
    },
    configDir,
  );
  assert.equal(result.report.unexpected.length, 1);
  assert.throws(() => apply(result), /Unclassified/);
});

test('explicit destination mappings override conservative URL exceptions in the configured paths', (t) => {
  const old = 'https://github.com/QwenLM/qwen-code/issues';
  const target = 'https://gitlab.tcsbank.ru/nestor/nessy-cli/-/issues';
  const root = fixture(t, { 'src/feedback.ts': old, 'LICENSE.txt': old });
  const destinationConfig = {
    ...config,
    replaceBeforePreserve: [{ from: old, to: target, paths: '^src/' }],
  };
  apply(plan(root, destinationConfig));
  assert.equal(
    fs.readFileSync(path.join(root, 'src/feedback.ts'), 'utf8'),
    target,
  );
  assert.equal(fs.readFileSync(path.join(root, 'LICENSE.txt'), 'utf8'), old);
  assert.equal(plan(root, destinationConfig).changes.length, 0);
});

test('URL preservation does not protect renamed JavaScript identifiers inside template expressions', (t) => {
  const original =
    'const qwenCodePackageName = "@qwen-code/qwen-code";\nconst url = `https://registry.npmjs.org/${encodeURIComponent(qwenCodePackageName)}`;\nconst oauth = `https://chat.qwen.ai/${qwenPath}`;';
  const root = fixture(t, { 'vendor.ts': original });
  const result = plan(root, config);
  const output = result.entries[0].after.toString();
  assert.ok(output.includes('encodeURIComponent(nessyCliPackageName)'));
  assert.ok(output.includes('https://chat.qwen.ai/${nessyPath}'));
  assert.equal(result.report.unexpected.length, 0);
});

test('remote screenshot rules are explicit, idempotent, and reject unreviewed embeds', (t) => {
  const from = '![Qwen screen](https://cdn.example/screen.png)';
  const to = '<!-- rebrand: screenshot removed -->';
  const root = fixture(t, { 'README.md': from });
  const reviewed = {
    ...config,
    remoteImages: [{ path: 'README.md', from, to }],
  };
  apply(plan(root, reviewed));
  assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), to);
  assert.equal(plan(root, reviewed).changes.length, 0);
  fs.appendFileSync(
    path.join(root, 'README.md'),
    '\n<img src="https://cdn.example/new.png">',
  );
  assert.throws(() => plan(root, reviewed), /Unclassified remote image/);
  fs.writeFileSync(path.join(root, 'README.md'), 'content changed');
  assert.throws(() => plan(root, reviewed), /Remote image drift/);
});

test('plans without writes; renames paths, imports and package names together; second run is empty', (t) => {
  const root = fixture(t, {
    '.qwen/QWEN.md': 'Qwen Code uses @qwen-code/qwen-code-core',
    'src/qwen.ts': "import './qwen-util.js'; const getQwenDir = '.qwen';",
    'src/qwen-util.ts': 'export const QWEN_HOME = 1;',
    'package.json': '{"name":"@qwen-code/qwen-code"}',
    'help.txt': 'Launch Qwen Code CLI',
  });
  const result = plan(root, config);
  assert.equal(result.report.unexpected.length, 0);
  assert.equal(fs.existsSync(path.join(root, '.qwen/QWEN.md')), true);
  apply(result);
  assert.equal(
    fs.readFileSync(path.join(root, 'help.txt'), 'utf8'),
    'Launch Nessy CLI',
  );
  assert.equal(fs.existsSync(path.join(root, '.qwen')), false);
  assert.equal(
    fs.readFileSync(path.join(root, '.nessy/NESSY.md'), 'utf8'),
    'Nessy CLI uses @nestor/nessy-cli-core',
  );
  assert.match(
    fs.readFileSync(path.join(root, 'src/nessy.ts'), 'utf8'),
    /getNessyDir/,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).name,
    '@nestor/nessy-cli',
  );
  assert.equal(plan(root, config).changes.length, 0);
});

test('preserves provider contracts and attribution while renaming surrounding identifiers', (t) => {
  const root = fixture(t, {
    'packages/core/src/core/modalityDefaults.ts':
      "// Copyright 2025 Qwen\nconst QWEN = 'https://chat.qwen.ai'; const id = 'qwen3.7-max'; const model = 'Qwen/Qwen3-397B-A17B'; const auth = 'qwen-oauth'; const qwen38ReasoningConfigOptions = 1; const ok = /^qwen/.test(id) || id.startsWith('qwen');",
  });
  const result = plan(root, config);
  const text = result.entries[0].after.toString();
  for (const expected of [
    'Copyright 2025 Qwen',
    'https://chat.qwen.ai',
    'qwen3.7-max',
    'Qwen/Qwen3-397B-A17B',
    "'qwen-oauth'",
    '/^qwen/',
    "startsWith('qwen')",
    'nessy38ReasoningConfigOptions',
    'const NESSY',
  ])
    assert.ok(text.includes(expected), expected);
  assert.equal(result.report.unexpected.length, 0);
});

test('DashScope User-Agent stays consistent in implementation and tests without exempting other files', (t) => {
  const provider = 'packages/core/src/core/openaiContentGenerator/provider/';
  const root = fixture(t, {
    [`${provider}dashscope.ts`]:
      'const QwenCodeUserAgent = `QwenCode/${version}`;',
    [`${provider}dashscope.test.ts`]:
      "const QwenCodeExpected = ['QwenCode/1.0.0', 'QwenCode/unknown'];",
    [`${provider}dashscope-helper.test.ts`]:
      "const userAgent = 'QwenCode/1.0.0';",
  });
  const result = plan(root, config);
  assert.equal(result.report.unexpected.length, 0);
  apply(result);
  assert.equal(
    fs.readFileSync(path.join(root, provider, 'dashscope.ts'), 'utf8'),
    'const NessyCliUserAgent = `QwenCode/${version}`;',
  );
  assert.equal(
    fs.readFileSync(path.join(root, provider, 'dashscope.test.ts'), 'utf8'),
    "const NessyCliExpected = ['QwenCode/1.0.0', 'QwenCode/unknown'];",
  );
  assert.equal(
    fs.readFileSync(
      path.join(root, provider, 'dashscope-helper.test.ts'),
      'utf8',
    ),
    "const userAgent = 'NessyCli/1.0.0';",
  );
  assert.equal(plan(root, config).changes.length, 0);
});

test('unknown capitalization is reported and blocks writing', (t) => {
  const root = fixture(t, { 'a.ts': 'qWeN', 'qwen.ts': 'qwen' });
  const result = plan(root, config);
  assert.equal(result.report.unexpected.length, 1);
  assert.throws(() => apply(result), /Unclassified/);
  assert.equal(fs.existsSync(path.join(root, 'qwen.ts')), true);
});

test('shortening a patch does not mistake its original prefix for an applied replacement', (t) => {
  const root = fixture(t, { 'imports.ts': 'keep,\nremove,\n' });
  const scoped = {
    ...config,
    patches: [
      { path: 'imports.ts', from: 'keep,\nremove,\n', to: 'keep,\n', count: 1 },
    ],
  };
  apply(plan(root, scoped));
  assert.equal(
    fs.readFileSync(path.join(root, 'imports.ts'), 'utf8'),
    'keep,\n',
  );
  assert.equal(plan(root, scoped).changes.length, 0);
  fs.writeFileSync(path.join(root, 'imports.ts'), 'keep,\nremove,\nkeep,\n');
  assert.throws(() => plan(root, scoped), /Partially applied patch/);
});

test('model IDs survive case and escape sequences without preserving product names or directories', (t) => {
  const root = fixture(t, {
    'models.ts': String.raw`'QWEN3-MAX' 'qwen/qwen3-coder' '\x07qwen3-coder-plus' '\u0007qwen3-max' '.qwen/skills' '/qwen/qwen-code' 'Qwen-Coder' 'Acp-Qwen-Max-Queued'`,
  });
  const result = plan(root, config);
  assert.equal(result.report.unexpected.length, 0);
  const text = result.entries[0].after.toString();
  for (const value of [
    'QWEN3-MAX',
    'qwen/qwen3-coder',
    String.raw`\x07qwen3-coder-plus`,
    String.raw`\u0007qwen3-max`,
    '.nessy/skills',
    '/nessy/nessy-cli',
    'Nessy-Coder',
    'Acp-Nessy-Max-Queued',
  ])
    assert.ok(text.includes(value), value);
  apply(result);
  assert.equal(plan(root, config).changes.length, 0);
});

test('the executable regex recognizes Nessy CLI on Unix and Windows after renaming', (t) => {
  const root = fixture(t, { 'guard.txt': 'qwen(?:-code)?(?:\\.exe)?' });
  const result = plan(root, config);
  const regex = new RegExp(`^${result.entries[0].after.toString()}$`, 'i');
  for (const value of ['nessy', 'nessy-cli', 'nessy.exe', 'nessy-cli.exe'])
    assert.ok(regex.test(value), value);
  for (const value of ['qwen-code', 'nessy-code', 'nessy-cli-helper'])
    assert.equal(regex.test(value), false, value);
});

test('rejects case insensitive and file/directory collisions before writing', (t) => {
  const root = fixture(t, { 'qwen.ts': 'first', 'NESSY.ts': 'second' });
  assert.throws(() => plan(root, config), /collision/);
  const second = fixture(t, { qwen: 'file', 'nessy/a': 'nested' });
  assert.throws(() => plan(second, config), /collision/);
});

test('does not rewrite binary bytes; keeps executable mode', (t) => {
  const binary = Buffer.from([0, 113, 119, 101, 110]);
  const root = fixture(t, {
    'qwen.png': binary,
    'qwen.sh': '#!/bin/sh\necho qwen',
  });
  fs.chmodSync(path.join(root, 'qwen.sh'), 0o755);
  apply(plan(root, config));
  assert.deepEqual(fs.readFileSync(path.join(root, 'nessy.png')), binary);
  assert.equal(fs.statSync(path.join(root, 'nessy.sh')).mode & 0o777, 0o755);
});

test('renames symlink targets without following them; rejects external links', (t) => {
  const root = fixture(t, { 'qwen.ts': 'qwen' });
  fs.symlinkSync('qwen.ts', path.join(root, 'alias'));
  apply(plan(root, config));
  assert.equal(fs.readlinkSync(path.join(root, 'alias')), 'nessy.ts');
  fs.symlinkSync('../outside', path.join(root, 'external'));
  assert.throws(() => plan(root, config), /escapes/);
});

test('recomputes pnpm hook checksum from transformed bytes', (t) => {
  const root = fixture(t, {
    '.pnpmfile.mjs': "export const pkg = '@qwen-code/qwen-code';\n",
    'pnpm-lock.yaml': 'pnpmfileChecksum: sha256-old\n',
  });
  apply(plan(root, config));
  const checksum = createHash('sha256')
    .update(fs.readFileSync(path.join(root, '.pnpmfile.mjs')))
    .digest('base64');
  assert.equal(
    fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'),
    `pnpmfileChecksum: sha256-${checksum}\n`,
  );
  assert.equal(plan(root, config).changes.length, 0);
});

test('exact patches fail on upstream drift and remain idempotent', (t) => {
  const root = fixture(t, { 'logo.txt': 'OLD LOGO' });
  const patched = {
    ...config,
    patches: [
      { path: 'logo.txt', from: 'OLD LOGO', to: 'NESSY LOGO', count: 1 },
    ],
  };
  apply(plan(root, patched));
  assert.equal(plan(root, patched).changes.length, 0);
  fs.writeFileSync(path.join(root, 'logo.txt'), 'DIFFERENT');
  assert.throws(() => plan(root, patched), /Patch drift/);
  assert.throws(
    () =>
      plan(root, {
        ...patched,
        patches: [{ ...patched.patches[0], path: 'missing' }],
      }),
    /Missing patch/,
  );
});

test('refuses a changed source between planning and applying', (t) => {
  const root = fixture(t, { 'qwen.ts': 'qwen' });
  const result = plan(root, config);
  fs.writeFileSync(path.join(root, 'qwen.ts'), 'user edit');
  assert.throws(() => apply(result), /Source changed/);
  assert.equal(
    fs.readFileSync(path.join(root, 'qwen.ts'), 'utf8'),
    'user edit',
  );
});

test('protects opaque integrity values and external model catalog keys', (t) => {
  const root = fixture(t, {
    'pnpm-lock.yaml': 'integrity: sha512-abqwenCD+qWEn/=\n',
    'packages/core/src/models/generated/model-registry.json':
      '{"models":{"qwen-long":{},"deepseek-r1-distill-qwen-7b":{}}}',
  });
  const result = plan(root, config);
  assert.equal(result.changes.length, 0);
  assert.equal(result.report.unexpected.length, 0);
});

test('renames escaped aliases and subpath imports without confusing them with model regexes', (t) => {
  const root = fixture(t, {
    'packages/cli/src/acp-integration/model-configuration.ts':
      "import '@qwen-code/qwen-code-core/core/reasoning-overrides.js';",
    'vitest.config.ts': String.raw`/^@qwen-code\/qwen-code-core$/`,
  });
  const result = plan(root, config);
  assert.ok(
    result.entries.some((entry) =>
      entry.after.toString().includes('@nestor/nessy-cli-core/core/'),
    ),
  );
  assert.ok(
    result.entries.some((entry) =>
      entry.after.toString().includes(String.raw`@nestor\/nessy-cli-core`),
    ),
  );
});

test('rejects partially applied literal patches', (t) => {
  const root = fixture(t, { logo: 'OLD NEW' });
  assert.throws(
    () =>
      plan(root, {
        ...config,
        patches: [{ path: 'logo', from: 'OLD', to: 'NEW', count: 2 }],
      }),
    /Partially applied/,
  );
});

test('patch insertions remain idempotent when the replacement contains the original anchor', (t) => {
  const root = fixture(t, { 'src.ts': "const debug = 'qwen';" });
  const insertion = {
    ...config,
    patches: [
      {
        path: 'src.ts',
        from: "const debug = 'qwen';",
        to: "const debug = 'qwen';\nconst enabled = false;",
        count: 1,
      },
    ],
  };
  apply(plan(root, insertion));
  assert.equal(plan(root, insertion).changes.length, 0);
});

test('Git inventory excludes generated files but finds renamed files in ignored directories', (t) => {
  const root = fixture(t, {
    '.gitignore': '.nessy/\ngenerated/\n',
    '.qwen/QWEN.md': 'Qwen Code',
  });
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '.']);
  fs.mkdirSync(path.join(root, 'generated'));
  fs.writeFileSync(path.join(root, 'generated/blob'), 'qWeN');
  const first = plan(root, config);
  assert.equal(first.report.files, 2);
  apply(first);
  const second = plan(root, config);
  assert.equal(second.report.files, 2);
  assert.equal(second.changes.length, 0);
  assert.equal(
    fs.readFileSync(path.join(root, 'generated/blob'), 'utf8'),
    'qWeN',
  );
});

test('compound brand names remain consistent across ENV case variants and fragmented regexes', (t) => {
  const root = fixture(t, {
    'config.ts':
      'QWEN_CODE_SYSTEM_SETTINGS_PATH Qwen_Code_System_Settings_Path qwen_code_system_settings_path',
    'sandbox.ts': "'qwen-code-test-sandbox'.replace(/^qwen-(?:code-)?/, '')",
  });
  const entries = plan(root, config).entries;
  const variants = entries
    .find((entry) => entry.name === 'config.ts')
    .after.toString()
    .split(' ');
  assert.equal(new Set(variants.map((value) => value.toUpperCase())).size, 1);
  assert.equal(variants[0], 'NESSY_CLI_SYSTEM_SETTINGS_PATH');
  const sandbox = entries
    .find((entry) => entry.name === 'sandbox.ts')
    .after.toString();
  assert.equal(
    sandbox,
    "'nessy-cli-test-sandbox'.replace(/^nessy-(?:cli-)?/, '')",
  );
});

test('remote video blocks require an explicit policy and are removed idempotently', (t) => {
  const block =
    '<video src="https://example.test/demo.mp4">upstream demo</video>';
  const root = fixture(t, { 'README.md': `Before\n${block}\nAfter` });
  assert.throws(
    () => plan(root, { ...config, remoteImages: [] }),
    /Unclassified remote image/,
  );
  const profile = {
    ...config,
    remoteImages: [
      {
        path: 'README.md',
        from: block,
        to: '<!-- rebrand: removed demo -->',
        count: 1,
      },
    ],
  };
  apply(plan(root, profile));
  assert.equal(
    fs.readFileSync(path.join(root, 'README.md'), 'utf8'),
    'Before\n<!-- rebrand: removed demo -->\nAfter',
  );
  assert.equal(plan(root, profile).changes.length, 0);
});

test('exact patches remain idempotent when their target path is renamed', (t) => {
  const root = fixture(t, { 'qwen/settings.json': '{"scale":37}' });
  const profile = {
    ...config,
    patches: [
      {
        path: 'qwen/settings.json',
        from: '"scale":37',
        to: '"scale":1',
        count: 1,
      },
    ],
  };
  apply(plan(root, profile));
  assert.equal(
    fs.readFileSync(path.join(root, 'nessy/settings.json'), 'utf8'),
    '{"scale":1}',
  );
  assert.equal(plan(root, profile).changes.length, 0);
});
