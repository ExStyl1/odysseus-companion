import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { plan, apply, loadConfig } from './rebrand.mjs';

const defaultConfig = fileURLToPath(new URL('./nessy.json', import.meta.url));
const sha = /^[a-f0-9]{40}$/;
const git = (root, args, env = {}) =>
  execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }).trim();
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const digest = (file) =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const dirs = (root) => ({
  source: path.join(root, '.rebrand/source'),
  reports: path.join(root, '.rebrand/reports'),
});

export function prepare(
  root,
  { ref, iid, createdAt, pipelineUrl = '', configPath = defaultConfig },
) {
  if (!/^\d+$/.test(iid ?? '')) throw Error('CI_PIPELINE_IID must be numeric');
  if (!ref?.startsWith('upstream/')) throw Error('Choose an upstream/* branch');
  git(root, ['check-ref-format', `refs/heads/${ref}`]);
  const { source, reports } = dirs(root);
  fs.mkdirSync(reports, { recursive: true });
  git(root, ['fetch', '--no-tags', 'origin', `refs/heads/${ref}`]);
  const upstreamSha = git(root, ['rev-parse', 'FETCH_HEAD^{commit}']);
  const controllerSha = git(root, ['rev-parse', 'HEAD']);
  git(root, ['worktree', 'add', '--detach', source, upstreamSha]);
  const config = loadConfig(configPath);
  const result = plan(source, config, path.dirname(configPath));
  result.report.sourceCommit = upstreamSha;
  write(path.join(reports, 'rebrand.json'), result.report);
  apply(result);
  fs.copyFileSync(
    new URL('./gitlab-ci.yml', import.meta.url),
    path.join(source, '.gitlab-ci.yml'),
  );
  fs.copyFileSync(
    path.join(root, '.gitlab-ci-compliance.yml'),
    path.join(source, '.gitlab-ci-compliance.yml'),
  );
  const version = read(path.join(source, 'package.json')).version;
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version))
    throw Error('Invalid package version');
  const metadata = {
    upstreamRef: ref,
    upstreamSha,
    controllerSha,
    configHash: result.report.configHash,
    version,
    pipelineIid: iid,
    pipelineUrl,
    targetBranch: `nessy/${version}`,
  };
  write(path.join(source, '.nessy-rebrand.json'), metadata);
  git(source, ['add', '--all', '--force', '.']);
  const date =
    createdAt || git(root, ['show', '-s', '--format=%cI', controllerSha]);
  git(
    source,
    [
      '-c',
      'user.name=CI Bot',
      '-c',
      'user.email=ci@gitlab.com',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '-m',
      `Rebrand ${ref} as Nessy CLI ${version}\n\nUpstream: ${upstreamSha}\nController: ${controllerSha}\nProfile: ${result.report.configHash}\nPipeline: ${pipelineUrl}`,
    ],
    { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  );
  metadata.candidateSha = git(source, ['rev-parse', 'HEAD']);
  const check = plan(source, config, path.dirname(configPath));
  write(path.join(reports, 'check.json'), check.report);
  if (check.changes.length || check.report.unexpected.length)
    throw Error('Rebrand is not stable after Git checkout');
  const bundle = path.join(reports, 'source.bundle');
  git(source, ['bundle', 'create', bundle, 'HEAD', `^${upstreamSha}`]);
  metadata.bundleSha256 = digest(bundle);
  git(source, [
    'archive',
    '--format=tar.gz',
    `--output=${path.join(reports, 'nessy-source.tar.gz')}`,
    'HEAD',
  ]);
  const patchFd = fs.openSync(path.join(reports, 'source.patch'), 'w');
  try {
    execFileSync(
      'git',
      ['-C', source, 'diff', '--binary', upstreamSha, 'HEAD'],
      {
        stdio: ['ignore', patchFd, 'pipe'],
      },
    );
  } finally {
    fs.closeSync(patchFd);
  }
  write(path.join(reports, 'metadata.json'), metadata);
  return metadata;
}

export function restore(root, { configPath = defaultConfig } = {}) {
  const { source, reports } = dirs(root);
  const metadata = read(path.join(reports, 'metadata.json'));
  if (
    !sha.test(metadata.upstreamSha) ||
    !sha.test(metadata.candidateSha) ||
    metadata.controllerSha !== git(root, ['rev-parse', 'HEAD']) ||
    !/^nessy\/[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(metadata.targetBranch)
  ) {
    throw Error('Invalid rebrand metadata or a different controller checkout');
  }
  const bundle = path.join(reports, 'source.bundle');
  if (digest(bundle) !== metadata.bundleSha256)
    throw Error('Source bundle checksum mismatch');
  git(root, ['fetch', '--no-tags', 'origin', metadata.upstreamSha]);
  git(root, ['bundle', 'verify', bundle]);
  git(root, ['fetch', '--no-tags', bundle, 'HEAD']);
  if (git(root, ['rev-parse', 'FETCH_HEAD']) !== metadata.candidateSha)
    throw Error('Candidate commit mismatch');
  git(root, ['worktree', 'add', '--detach', source, metadata.candidateSha]);
  const check = plan(source, loadConfig(configPath), path.dirname(configPath));
  write(path.join(reports, 'check-restored.json'), check.report);
  if (
    check.report.configHash !== metadata.configHash ||
    check.changes.length ||
    check.report.unexpected.length
  ) {
    throw Error('Restored candidate does not match the rebrand profile');
  }
  return metadata;
}

export function verified(root) {
  const { source, reports } = dirs(root);
  const metadata = read(path.join(reports, 'metadata.json'));
  if (git(source, ['rev-parse', 'HEAD']) !== metadata.candidateSha)
    throw Error('Wrong tested commit');
  git(source, ['diff', '--exit-code', '--stat', 'HEAD']);
  write(path.join(reports, 'verified.json'), {
    candidateSha: metadata.candidateSha,
  });
}

export function publish(root, remote) {
  const { source, reports } = dirs(root);
  const metadata = read(path.join(reports, 'metadata.json'));
  if (
    read(path.join(reports, 'verified.json')).candidateSha !==
      metadata.candidateSha ||
    git(source, ['rev-parse', 'HEAD']) !== metadata.candidateSha ||
    !/^nessy\/[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(metadata.targetBranch)
  ) {
    throw Error('Missing or mismatched verification receipt');
  }
  const target = `refs/heads/${metadata.targetBranch}`;
  const existing = git(root, [
    '-c',
    'credential.helper=',
    'ls-remote',
    '--heads',
    remote,
    target,
  ]).split(/\s/)[0];
  if (existing && existing !== metadata.candidateSha)
    throw Error(`Refusing to change existing branch ${metadata.targetBranch}`);
  if (!existing) {
    // An empty lease permits creation only, even if another writer wins a race.
    git(root, [
      '-c',
      'credential.helper=',
      'push',
      `--force-with-lease=${target}:`,
      remote,
      `${metadata.candidateSha}:${target}`,
    ]);
  }
  fs.writeFileSync(
    path.join(reports, 'branch.txt'),
    metadata.targetBranch + '\n' + metadata.candidateSha + '\n',
  );
  return metadata.targetBranch;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const root = git(process.cwd(), ['rev-parse', '--show-toplevel']);
    const mode = process.argv[2];
    let result;
    if (mode === 'prepare')
      result = prepare(root, {
        ref: process.env.REBRAND_UPSTREAM_REF || 'upstream/0.19.1',
        iid: process.env.CI_PIPELINE_IID,
        createdAt: process.env.CI_PIPELINE_CREATED_AT,
        pipelineUrl: process.env.CI_PIPELINE_URL,
      });
    else if (mode === 'restore') result = restore(root);
    else if (mode === 'verified') result = verified(root);
    else if (mode === 'publish') {
      if (!process.env.CI_SERVER_URL || !process.env.CI_PROJECT_PATH)
        throw Error('GitLab project context is required');
      result = publish(
        root,
        `${process.env.CI_SERVER_URL}/${process.env.CI_PROJECT_PATH}.git`,
      );
    } else throw Error('Expected prepare|restore|verified|publish');
    if (result) console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
