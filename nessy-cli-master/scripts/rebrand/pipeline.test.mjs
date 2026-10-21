import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { prepare, restore, verified, publish } from './pipeline.mjs';

const git = (root, ...args) =>
  execFileSync(
    'git',
    [
      '-C',
      root,
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'commit.gpgSign=false',
      ...args,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
const hash = (s) => createHash('sha256').update(s).digest('hex');

function fixture(t, crlf = true, large = false) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rebrand-pipeline-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const origin = path.join(temp, 'origin.git');
  const root = path.join(temp, 'prepare');
  fs.mkdirSync(root);
  git(temp, 'init', '--bare', '--initial-branch=main', origin);
  git(origin, 'config', 'receive.advertisePushOptions', 'true');
  git(root, 'init', '--initial-branch=main');
  fs.writeFileSync(
    path.join(root, 'package.json'),
    '{"name":"qwen-code","version":"0.19.1"}\n',
  );
  fs.writeFileSync(
    path.join(root, '.gitattributes'),
    'install-qwen.bat text eol=crlf\n',
  );
  fs.writeFileSync(path.join(root, '.gitignore'), '.nessy/\n');
  fs.mkdirSync(path.join(root, '.qwen'));
  fs.writeFileSync(path.join(root, '.qwen/rules.md'), 'Qwen rules\n');
  const original = 'echo Qwen\r\n';
  const replacement = crlf ? 'echo Nessy\r\n' : 'echo Nessy\n';
  fs.writeFileSync(path.join(root, 'install-qwen.bat'), original);
  if (large)
    fs.writeFileSync(
      path.join(root, 'large.txt'),
      Array.from(
        { length: 14000 },
        (_, i) => `Qwen ${'x'.repeat(90)} ${i}\n`,
      ).join(''),
    );
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'upstream fixture');
  git(root, 'branch', 'upstream/0.19.1');
  fs.writeFileSync(
    path.join(root, '.gitlab-ci-compliance.yml'),
    'include:\n  - remote: https://ci.example.test/compliance.yml\n  - local: .gitlab-ci.yml\n',
  );
  git(root, 'add', '.gitlab-ci-compliance.yml');
  git(root, 'commit', '-m', 'controller compliance configuration');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', 'origin', 'main', 'upstream/0.19.1');
  const configPath = path.join(temp, 'profile.json');
  fs.writeFileSync(path.join(temp, 'replacement.bat'), replacement);
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      replace: [
        { from: 'qwen', to: 'nessy' },
        { from: 'Qwen', to: 'Nessy' },
      ],
      preserve: [],
      assets: [
        {
          path: 'install-qwen.bat',
          sha256: hash(original),
          replaceWith: 'replacement.bat',
        },
      ],
    }),
  );
  const options = {
    ref: 'upstream/0.19.1',
    iid: '42',
    createdAt: '2026-10-06T12:00:00Z',
    configPath,
  };
  const nextJob = (name) => {
    const next = path.join(temp, name);
    git(temp, 'clone', origin, next);
    fs.cpSync(
      path.join(root, '.rebrand/reports'),
      path.join(next, '.rebrand/reports'),
      { recursive: true },
    );
    return next;
  };
  return { temp, origin, root, options, nextJob };
}

test('CLI and pipeline load split profiles; a fragment change prevents restoration', (t) => {
  const { temp, root, options, nextJob } = fixture(t);
  const profile = JSON.parse(fs.readFileSync(options.configPath, 'utf8'));
  fs.mkdirSync(path.join(temp, 'rules'));
  for (const key of ['replace', 'preserve', 'assets']) {
    const file = `rules/${key}.json`;
    fs.writeFileSync(path.join(temp, file), JSON.stringify(profile[key]));
    profile[key] = file;
  }
  profile.mentionsBaseline = 'baseline.json';
  fs.writeFileSync(path.join(temp, 'baseline.json'), '{"entries":[]}');
  fs.writeFileSync(options.configPath, JSON.stringify(profile));
  const output = execFileSync(
    process.execPath,
    [
      new URL('./rebrand.mjs', import.meta.url).pathname,
      '--root',
      root,
      '--config',
      options.configPath,
      '--mode',
      'plan',
    ],
    { cwd: os.tmpdir(), encoding: 'utf8' },
  );
  assert.equal(JSON.parse(output).unexpected, 0);
  const metadata = prepare(root, options);
  const restored = restore(nextJob('verify'), {
    configPath: options.configPath,
  });
  assert.equal(restored.candidateSha, metadata.candidateSha);
  fs.writeFileSync(
    path.join(temp, 'rules/preserve.json'),
    JSON.stringify([{ id: 'changed', pattern: 'external' }]),
  );
  assert.throws(
    () =>
      restore(nextJob('changed-profile'), { configPath: options.configPath }),
    /does not match the rebrand profile/,
  );
});

test('job restoration pins patch fragment contents as part of the profile', (t) => {
  const { temp, root, options, nextJob } = fixture(t);
  const profile = JSON.parse(fs.readFileSync(options.configPath, 'utf8'));
  profile.patches = [
    {
      path: '.qwen/rules.md',
      from: 'Qwen rules\n',
      toFile: 'fragment.txt',
      count: 1,
    },
  ];
  fs.writeFileSync(options.configPath, JSON.stringify(profile));
  const fragment = path.join(temp, 'fragment.txt');
  fs.writeFileSync(fragment, 'Qwen branded rules\n');
  const metadata = prepare(root, options);
  assert.equal(
    restore(nextJob('verify-fragment'), { configPath: options.configPath })
      .candidateSha,
    metadata.candidateSha,
  );
  // Same rendered result after renaming, but a different controller fragment.
  fs.writeFileSync(fragment, 'Nessy branded rules\n');
  assert.throws(
    () =>
      restore(nextJob('changed-fragment'), { configPath: options.configPath }),
    /does not match the rebrand profile/,
  );
});

test('job boundaries retain one candidate; verified publish is create-only and retryable', (t) => {
  const { root, origin, options, nextJob } = fixture(t, true, true);
  const metadata = prepare(root, options);
  const pipeline = fs.readFileSync(
    new URL('./gitlab-ci.yml', import.meta.url),
    'utf8',
  );
  assert.equal(
    git(root, 'show', `${metadata.candidateSha}:.gitlab-ci.yml`),
    pipeline.trim(),
  );
  const compliancePath = '.gitlab-ci-compliance.yml';
  const compliance = fs.readFileSync(path.join(root, compliancePath));
  const complianceBlob = git(
    root,
    'rev-parse',
    `${metadata.controllerSha}:${compliancePath}`,
  );
  assert.equal(
    git(root, 'ls-tree', '--name-only', metadata.upstreamSha, compliancePath),
    '',
  );
  assert.equal(
    git(root, 'rev-parse', `${metadata.candidateSha}:${compliancePath}`),
    complianceBlob,
  );
  assert.ok(
    fs.statSync(path.join(root, '.rebrand/reports/source.patch')).size >
      1024 * 1024,
  );
  // The upstream branch advances after prepare. Later jobs must use the recorded SHA.
  fs.writeFileSync(path.join(root, 'later.txt'), 'later upstream change');
  git(root, 'add', 'later.txt');
  git(root, 'commit', '-m', 'later upstream');
  git(root, 'push', 'origin', 'HEAD:refs/heads/upstream/0.19.1');
  const verifyRoot = nextJob('verify');
  restore(verifyRoot, { configPath: options.configPath });
  const source = path.join(verifyRoot, '.rebrand/source');
  assert.equal(git(source, 'rev-parse', 'HEAD'), metadata.candidateSha);
  assert.equal(
    fs.readFileSync(path.join(source, '.gitlab-ci.yml'), 'utf8'),
    pipeline,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(source, compliancePath)),
    compliance,
  );
  assert.equal(fs.existsSync(path.join(source, 'later.txt')), false);
  assert.equal(
    fs.readFileSync(path.join(source, '.nessy/rules.md'), 'utf8'),
    'Nessy rules\n',
  );
  assert.equal(
    fs.readFileSync(path.join(source, 'install-nessy.bat'), 'utf8'),
    'echo Nessy\r\n',
  );
  assert.throws(() => publish(verifyRoot, origin), /verified.json/);
  verified(verifyRoot);
  assert.equal(publish(verifyRoot, origin), metadata.targetBranch);
  assert.equal(publish(verifyRoot, origin), metadata.targetBranch);
  assert.equal(
    git(origin, 'rev-parse', metadata.targetBranch),
    metadata.candidateSha,
  );
  assert.equal(
    git(origin, 'show', `${metadata.targetBranch}:.gitlab-ci.yml`),
    pipeline.trim(),
  );
  assert.equal(
    git(origin, 'rev-parse', `${metadata.targetBranch}:${compliancePath}`),
    complianceBlob,
  );
  git(
    origin,
    'update-ref',
    `refs/heads/${metadata.targetBranch}`,
    metadata.upstreamSha,
  );
  assert.throws(
    () => publish(verifyRoot, origin),
    /Refusing to change existing branch/,
  );
  assert.equal(
    git(origin, 'rev-parse', metadata.targetBranch),
    metadata.upstreamSha,
  );
});

test('restoring rejects a profile that changes again after a Git checkout', (t) => {
  const { root, options, nextJob } = fixture(t, false);
  prepare(root, options);
  assert.throws(
    () => restore(nextJob('invalid-crlf'), { configPath: options.configPath }),
    /Asset drift|does not match/,
  );
});

test('another pipeline recreates the version branch after it is deleted', (t) => {
  const { root, origin, options, nextJob } = fixture(t);
  const first = prepare(root, options);
  assert.equal(first.targetBranch, 'nessy/0.19.1');
  verified(root);
  publish(root, origin);

  const rerun = nextJob('rerun');
  const second = prepare(rerun, { ...options, iid: '43' });
  assert.equal(second.pipelineIid, '43');
  assert.equal(second.targetBranch, first.targetBranch);
  assert.notEqual(second.candidateSha, first.candidateSha);
  verified(rerun);
  assert.throws(
    () => publish(rerun, origin),
    /Refusing to change existing branch/,
  );
  git(origin, 'update-ref', '-d', `refs/heads/${first.targetBranch}`);
  assert.equal(publish(rerun, origin), first.targetBranch);
  assert.equal(
    git(origin, 'rev-parse', first.targetBranch),
    second.candidateSha,
  );
});

test('invalid refs and damaged bundles stop before publication', (t) => {
  const { root, options, nextJob } = fixture(t);
  const upstreamSha = git(root, 'rev-parse', options.ref);
  assert.throws(
    () => prepare(root, { ...options, ref: upstreamSha }),
    /Choose an upstream\/\* branch/,
  );
  assert.equal(fs.existsSync(path.join(root, '.rebrand')), false);
  assert.throws(
    () => prepare(root, { ...options, ref: '--upload-pack=bad' }),
    /upstream/,
  );
  assert.throws(
    () => prepare(root, { ...options, iid: '../../master' }),
    /numeric/,
  );
  prepare(root, options);
  const next = nextJob('bad-bundle');
  fs.appendFileSync(
    path.join(next, '.rebrand/reports/source.bundle'),
    'damaged',
  );
  assert.throws(() => restore(next), /checksum mismatch/);
});

test('prepare and CLI report new allowed mentions and stop before writing a candidate', (t) => {
  const { root, temp, options } = fixture(t);
  const profile = JSON.parse(fs.readFileSync(options.configPath, 'utf8'));
  profile.preserve = [{ id: 'oauth', pattern: 'qwen-oauth' }];
  profile.mentionsBaseline = 'baseline.json';
  fs.writeFileSync(options.configPath, JSON.stringify(profile));
  fs.writeFileSync(path.join(temp, 'baseline.json'), '{"entries":[]}');
  fs.writeFileSync(path.join(root, 'new.ts'), 'const auth = "qwen-oauth";\n');
  git(root, 'add', 'new.ts');
  git(root, 'commit', '-m', 'new upstream mention');
  git(root, 'push', 'origin', 'HEAD:refs/heads/upstream/0.19.1');
  assert.throws(() => prepare(root, options), /new remaining mention/);
  const report = JSON.parse(
    fs.readFileSync(path.join(root, '.rebrand/reports/rebrand.json')),
  );
  assert.equal(report.mentions.added[0].file, 'new.ts');
  const source = path.join(root, '.rebrand/source');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(source, 'package.json'))).name,
    'qwen-code',
  );
  assert.equal(fs.existsSync(path.join(source, '.nessy-rebrand.json')), false);
  for (const mode of ['plan', 'apply', 'check']) {
    const output = path.join(temp, `${mode}.json`);
    const cli = spawnSync(
      process.execPath,
      [
        new URL('./rebrand.mjs', import.meta.url).pathname,
        '--root',
        source,
        '--config',
        options.configPath,
        '--mode',
        mode,
        '--report',
        output,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /new.ts:1/);
    assert.equal(JSON.parse(fs.readFileSync(output)).mentions.added.length, 1);
  }
});
