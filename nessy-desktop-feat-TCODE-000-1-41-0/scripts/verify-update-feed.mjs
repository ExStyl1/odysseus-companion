/**
 * Multi-platform generic-provider update-feed verifier.
 *
 * Verifies electron-updater metadata for macOS, Windows, and Linux release
 * feeds. It intentionally uses a tiny local scanner instead of a YAML
 * dependency because electron-builder emits a narrow, predictable shape for
 * `latest*.yml` files.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SUPPORTED_PLATFORMS = ['mac', 'win', 'linux'];
export const SUPPORTED_ARCHES = ['x64', 'arm64'];

const REJECTED_METADATA_NAMES = ['builder-debug.yml'];

const TARGETS = {
  mac: {
    x64: {
      label: 'macOS x64',
      primaryExtension: '.zip',
      allowedExtensions: ['.dmg', '.zip', '.blockmap'],
      metadataNames: (channel) => [
        `${channel}-mac.yml`,
        'latest-mac.yml',
        'latest.yml',
      ],
      canonicalMetadataName: 'latest-mac.yml',
    },
    arm64: {
      label: 'macOS arm64',
      primaryExtension: '.zip',
      allowedExtensions: ['.dmg', '.zip', '.blockmap'],
      metadataNames: (channel) => [
        `${channel}-arm64-mac.yml`,
        `${channel}-arm64.yml`,
        'latest-arm64-mac.yml',
        'latest-arm64.yml',
      ],
      canonicalMetadataName: 'latest-arm64-mac.yml',
    },
  },
  win: {
    x64: {
      label: 'Windows x64',
      primaryExtension: '.exe',
      allowedExtensions: ['.exe', '.zip', '.blockmap'],
      metadataNames: (channel) => [
        `${channel}.yml`,
        `${channel}-win.yml`,
        'latest.yml',
        'latest-win.yml',
      ],
      canonicalMetadataName: 'latest.yml',
    },
    arm64: {
      label: 'Windows arm64',
      primaryExtension: '.exe',
      allowedExtensions: ['.exe', '.zip', '.blockmap'],
      metadataNames: (channel) => [
        `${channel}-win-arm64.yml`,
        'latest-win-arm64.yml',
      ],
      canonicalMetadataName: 'latest-win-arm64.yml',
    },
  },
  linux: {
    x64: {
      label: 'Linux x64',
      primaryExtension: '.AppImage',
      allowedExtensions: ['.AppImage', '.deb', '.blockmap'],
      metadataNames: (channel) => [
        `${channel}-linux.yml`,
        'latest-linux.yml',
      ],
      canonicalMetadataName: 'latest-linux.yml',
    },
    arm64: {
      label: 'Linux arm64',
      primaryExtension: '.AppImage',
      allowedExtensions: ['.AppImage', '.deb', '.blockmap'],
      metadataNames: (channel) => [
        `${channel}-linux-arm64.yml`,
        'latest-linux-arm64.yml',
      ],
      canonicalMetadataName: 'latest-linux-arm64.yml',
    },
  },
};

export class FeedVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FeedVerificationError';
  }
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  await main(process.argv.slice(2)).catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}

async function main(argv) {
  const args = parseArgs(argv);

  if (args.selfTest) {
    await runSelfTest();
    return;
  }

  const result = await verifyUpdateFeed({
    releaseDir: args.releaseDir,
    channel: args.channel,
    platform: args.platform,
    arch: args.arch,
    baseUrl: args.baseUrl,
  });

  for (const line of result.log) {
    console.log(line);
  }
  console.log(
    `${result.target.label} update feed verified: ${result.metadataName} -> ` +
      `${result.primary.path} (+${result.referenced.length - 1} referenced artifact(s))` +
      `${args.baseUrl ? ` [remote: ${args.baseUrl}]` : ''}`,
  );
}

function parseArgs(argv) {
  const parsed = {
    releaseDir: 'release',
    channel: 'dev',
    platform: 'mac',
    arch: 'x64',
    baseUrl: null,
    selfTest: false,
  };

  for (const arg of argv) {
    if (arg === '--self-test') {
      parsed.selfTest = true;
      continue;
    }
    if (arg.startsWith('--release-dir=')) {
      parsed.releaseDir = arg.slice('--release-dir='.length);
      continue;
    }
    if (arg.startsWith('--channel=')) {
      parsed.channel = arg.slice('--channel='.length);
      continue;
    }
    if (arg.startsWith('--platform=')) {
      parsed.platform = arg.slice('--platform='.length);
      continue;
    }
    if (arg.startsWith('--arch=')) {
      parsed.arch = arg.slice('--arch='.length);
      continue;
    }
    if (arg.startsWith('--base-url=')) {
      const value = arg.slice('--base-url='.length).trim();
      parsed.baseUrl = value === '' ? null : value;
      continue;
    }
    fail(`Unknown argument: ${arg}`);
  }

  assertSupportedTarget(parsed.platform, parsed.arch);
  if (!parsed.releaseDir) {
    fail('--release-dir must not be empty');
  }
  if (!parsed.channel) {
    fail('--channel must not be empty');
  }

  return parsed;
}

export async function verifyUpdateFeed({
  releaseDir,
  channel = 'dev',
  platform = 'mac',
  arch = 'x64',
  baseUrl = null,
  fetchImpl = globalThis.fetch,
}) {
  assertSupportedTarget(platform, arch);
  const target = TARGETS[platform][arch];
  const log = [];

  if (!existsSync(releaseDir) || !statSync(releaseDir).isDirectory()) {
    throw new FeedVerificationError(
      `release directory was not found: ${releaseDir}`,
    );
  }

  const metadataName = selectMetadataName(releaseDir, platform, arch, channel);
  if (!metadataName) {
    const wanted = candidateMetadataNames(platform, arch, channel).join(', ');
    throw new FeedVerificationError(
      `no ${target.label} update metadata file found in ${releaseDir}; expected one of: ${wanted}`,
    );
  }
  log.push(`Selected ${target.label} update metadata: ${metadataName}`);

  const metadataPath = join(releaseDir, metadataName);
  const parsed = parseUpdateMetadata(readFileSync(metadataPath, 'utf8'), {
    fileName: metadataName,
  });

  if (!parsed.primary) {
    throw new FeedVerificationError(
      `${metadataName} has no top-level \`path:\` entry; cannot determine the primary update payload`,
    );
  }

  if (!endsWithExtension(parsed.primary.path, target.primaryExtension)) {
    throw new FeedVerificationError(
      `${metadataName} primary update \`path: ${parsed.primary.path}\` must end in ${target.primaryExtension}`,
    );
  }

  if (!hasNonEmptySha512(parsed.primary.sha512)) {
    throw new FeedVerificationError(
      `${metadataName} primary update \`path: ${parsed.primary.path}\` is missing a non-empty top-level sha512`,
    );
  }

  const referenced = collectReferencedArtifacts(parsed, metadataName, target);
  log.push(
    `Referenced artifacts (${referenced.length}): ${referenced
      .map((entry) => entry.name)
      .join(', ')}`,
  );

  for (const entry of referenced) {
    validateArtifactNameForTarget(entry.name, metadataName, platform, arch, target);
    if (!hasNonEmptySha512(entry.sha512)) {
      throw new FeedVerificationError(
        `${metadataName} references ${entry.name} without a non-empty sha512`,
      );
    }

    const artifactPath = join(releaseDir, entry.name);
    if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) {
      throw new FeedVerificationError(
        `${metadataName} references ${entry.name} but it does not exist in ${releaseDir}`,
      );
    }
    if (statSync(artifactPath).size === 0) {
      throw new FeedVerificationError(
        `${metadataName} references ${entry.name} but the file in ${releaseDir} is empty`,
      );
    }

    const actualSha512 = sha512Base64(readFileSync(artifactPath));
    if (entry.sha512 !== actualSha512) {
      throw new FeedVerificationError(
        `${metadataName} references ${entry.name} with sha512 ${entry.sha512}, ` +
          `but the artifact digest is ${actualSha512}`,
      );
    }
  }
  log.push(
    `All ${referenced.length} referenced artifact(s) exist in ${releaseDir} with matching sha512`,
  );

  if (baseUrl) {
    await verifyRemoteFeed({
      baseUrl,
      metadataName,
      referenced,
      fetchImpl,
      log,
    });
  }

  return {
    metadataName,
    target: { platform, arch, ...target },
    primary: parsed.primary,
    referenced,
    log,
  };
}

export async function verifyMacUpdateFeed(options) {
  return verifyUpdateFeed({
    ...options,
    platform: 'mac',
    arch: options?.arch ?? 'x64',
  });
}

export async function verifyUpdateFeedMatrix({
  releaseDir,
  channel = 'dev',
  baseUrl = null,
  fetchImpl = globalThis.fetch,
  targets = defaultMatrixTargets(),
}) {
  const results = [];
  for (const target of targets) {
    results.push(
      await verifyUpdateFeed({
        releaseDir,
        channel,
        baseUrl,
        fetchImpl,
        platform: target.platform,
        arch: target.arch,
      }),
    );
  }
  return results;
}

export function defaultMatrixTargets() {
  return SUPPORTED_PLATFORMS.flatMap((platform) =>
    SUPPORTED_ARCHES.map((arch) => ({ platform, arch })),
  );
}

export function candidateMetadataNames(platform, arch, channel = 'dev') {
  assertSupportedTarget(platform, arch);
  return [
    ...new Set(
      TARGETS[platform][arch]
        .metadataNames(channel)
        .filter((name) => !REJECTED_METADATA_NAMES.includes(name)),
    ),
  ];
}

export function canonicalMetadataName(platform, arch) {
  assertSupportedTarget(platform, arch);
  return TARGETS[platform][arch].canonicalMetadataName;
}

export function selectMetadataName(releaseDir, platform, arch, channel = 'dev') {
  const present = new Set(
    readdirSync(releaseDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  );
  for (const candidate of candidateMetadataNames(platform, arch, channel)) {
    if (present.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function parseUpdateMetadata(content, { fileName } = {}) {
  if (fileName && REJECTED_METADATA_NAMES.includes(basename(fileName))) {
    throw new FeedVerificationError(
      `${fileName} is electron-builder debug output and must not be used as update feed metadata`,
    );
  }

  const lines = content.split(/\r?\n/);

  let version;
  let primaryPath;
  let primarySha512;
  const files = [];

  let inFiles = false;
  let currentFile = null;

  const pushCurrentFile = () => {
    if (currentFile && currentFile.url !== undefined) {
      files.push({ url: currentFile.url, sha512: currentFile.sha512 });
    }
    currentFile = null;
  };

  for (const rawLine of lines) {
    if (rawLine.trim() === '') {
      continue;
    }

    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();

    if (indent === 0) {
      pushCurrentFile();
      inFiles = false;

      if (line === 'files:') {
        inFiles = true;
        continue;
      }

      const topMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!topMatch) {
        continue;
      }
      const key = topMatch[1];
      const value = stripYamlScalar(topMatch[2]);

      if (key === 'path') {
        primaryPath = value;
      } else if (key === 'sha512') {
        primarySha512 = value;
      } else if (key === 'version') {
        version = value;
      }
      continue;
    }

    if (!inFiles) {
      continue;
    }

    if (line.startsWith('- ')) {
      pushCurrentFile();
      currentFile = {};
      const itemBody = line.slice(2).trim();
      applyFileField(currentFile, itemBody);
      continue;
    }

    if (currentFile) {
      applyFileField(currentFile, line);
    }
  }

  pushCurrentFile();

  return {
    version,
    primary:
      primaryPath !== undefined
        ? { path: primaryPath, sha512: primarySha512 }
        : null,
    files,
  };
}

export function renderUpdateMetadata({
  version,
  path,
  sha512,
  files,
  releaseDate = '2026-06-11T00:00:00.000Z',
}) {
  const lines = [];
  if (version !== undefined) {
    lines.push(`version: ${version}`);
  }
  lines.push('files:');
  for (const file of files) {
    lines.push(`  - url: ${file.url}`);
    lines.push(`    sha512: ${file.sha512}`);
    if (file.size !== undefined) {
      lines.push(`    size: ${file.size}`);
    }
  }
  lines.push(`path: ${path}`);
  lines.push(`sha512: ${sha512}`);
  lines.push(`releaseDate: '${releaseDate}'`);
  return `${lines.join('\n')}\n`;
}

export function collectReferencedArtifacts(parsed, metadataName, target = null) {
  if (!parsed.primary) {
    return [];
  }

  const allowedExtensions =
    target?.allowedExtensions ??
    [...new Set(Object.values(TARGETS).flatMap((byArch) =>
      Object.values(byArch).flatMap((entry) => entry.allowedExtensions),
    ))];
  const byName = new Map();

  const primaryName = artifactName(parsed.primary.path, metadataName);
  byName.set(primaryName, {
    name: primaryName,
    sha512: parsed.primary.sha512,
    isPrimary: true,
  });

  for (const file of parsed.files) {
    if (file.url === undefined) {
      continue;
    }
    const name = artifactName(file.url, metadataName);
    if (!allowedExtensions.some((ext) => endsWithExtension(name, ext))) {
      continue;
    }
    if (byName.has(name)) {
      if (!byName.get(name).sha512 && file.sha512) {
        byName.get(name).sha512 = file.sha512;
      }
      continue;
    }
    byName.set(name, { name, sha512: file.sha512, isPrimary: false });
  }

  const entries = [...byName.values()];
  entries.sort((a, b) => {
    if (a.isPrimary === b.isPrimary) {
      return 0;
    }
    return a.isPrimary ? -1 : 1;
  });
  return entries;
}

export function inferTargetFromMetadata(parsed, metadataName) {
  const names = [
    parsed.primary?.path,
    ...parsed.files.map((file) => file.url),
    metadataName,
  ]
    .filter(Boolean)
    .map((value) => artifactName(value, metadataName));
  const joined = names.join(' ').toLowerCase();

  let platform = null;
  if (names.some((name) => endsWithExtension(name, '.exe'))) {
    platform = 'win';
  } else if (
    names.some(
      (name) => endsWithExtension(name, '.AppImage') || endsWithExtension(name, '.deb'),
    )
  ) {
    platform = 'linux';
  } else if (
    names.some((name) => endsWithExtension(name, '.dmg')) ||
    /\b(mac|darwin)\b/.test(joined) ||
    metadataName.includes('mac')
  ) {
    platform = 'mac';
  } else if (/\b(win|windows)\b/.test(joined)) {
    platform = 'win';
  } else if (/\b(linux)\b/.test(joined)) {
    platform = 'linux';
  }

  if (!platform) {
    throw new FeedVerificationError(
      `could not infer update target platform from ${metadataName}`,
    );
  }

  const arch = /(arm64|aarch64)/i.test(joined) ? 'arm64' : 'x64';
  assertSupportedTarget(platform, arch);
  return { platform, arch };
}

export function sha512Base64(input) {
  return createHash('sha512').update(input).digest('base64');
}

function applyFileField(target, fragment) {
  const match = fragment.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
  if (!match) {
    return;
  }
  const key = match[1];
  const value = stripYamlScalar(match[2]);
  if (key === 'url') {
    target.url = value;
  } else if (key === 'sha512') {
    target.sha512 = value;
  }
}

function stripYamlScalar(value) {
  let result = value.trim();
  if (
    (result.startsWith('"') && result.endsWith('"')) ||
    (result.startsWith("'") && result.endsWith("'"))
  ) {
    return result.slice(1, -1);
  }
  const commentIndex = result.indexOf(' #');
  if (commentIndex !== -1) {
    result = result.slice(0, commentIndex).trim();
  }
  return result;
}

function artifactName(pathOrUrl, metadataName) {
  const trimmed = String(pathOrUrl).trim();
  if (trimmed === '') {
    throw new FeedVerificationError(
      `${metadataName} contains an empty artifact reference`,
    );
  }
  const withoutQuery = trimmed.split(/[?#]/)[0];
  const name = withoutQuery.split('/').pop() ?? withoutQuery;
  if (name === '') {
    throw new FeedVerificationError(
      `${metadataName} references a path with no file name: ${pathOrUrl}`,
    );
  }
  return name;
}

async function verifyRemoteFeed({
  baseUrl,
  metadataName,
  referenced,
  fetchImpl,
  log,
}) {
  if (typeof fetchImpl !== 'function') {
    throw new FeedVerificationError(
      'global fetch is unavailable; cannot HEAD-verify the remote feed',
    );
  }

  const remoteNames = [metadataName, ...referenced.map((entry) => entry.name)];
  log.push(`HEAD-verifying ${remoteNames.length} object(s) on ${baseUrl}`);

  for (const name of remoteNames) {
    const url = joinUrl(baseUrl, name);
    let response;
    try {
      response = await fetchImpl(url, { method: 'HEAD', redirect: 'follow' });
    } catch (error) {
      throw new FeedVerificationError(
        `HEAD request failed for ${url}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!response.ok) {
      throw new FeedVerificationError(
        `remote feed object is not reachable (HTTP ${response.status}): ${url}`,
      );
    }
    log.push(`  HEAD ${response.status} ${url}`);
  }
}

function validateArtifactNameForTarget(
  name,
  metadataName,
  platform,
  arch,
  target,
) {
  if (!target.allowedExtensions.some((ext) => endsWithExtension(name, ext))) {
    throw new FeedVerificationError(
      `${metadataName} references ${name}, which is not a ` +
        `${target.allowedExtensions.join('/')} artifact`,
    );
  }

  if (arch === 'arm64' && !/(arm64|aarch64)/i.test(name)) {
    throw new FeedVerificationError(
      `${metadataName} is for ${platform} arm64 but references non-arm64 artifact: ${name}`,
    );
  }

  if (arch === 'x64' && /(arm64|aarch64)/i.test(name)) {
    throw new FeedVerificationError(
      `${metadataName} is for ${platform} x64 but references arm64 artifact: ${name}`,
    );
  }
}

function joinUrl(baseUrl, name) {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}/${encodeURIComponent(name)}`;
}

function endsWithExtension(value, extension) {
  return String(value).toLowerCase().endsWith(extension.toLowerCase());
}

function hasNonEmptySha512(sha512) {
  return typeof sha512 === 'string' && sha512.trim() !== '';
}

function assertSupportedTarget(platform, arch) {
  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    failOrThrow(`--platform must be one of: ${SUPPORTED_PLATFORMS.join(', ')}`);
  }
  if (!SUPPORTED_ARCHES.includes(arch)) {
    failOrThrow(`--arch must be one of: ${SUPPORTED_ARCHES.join(', ')}`);
  }
}

function failOrThrow(message) {
  if (isMainModule) {
    fail(message);
  }
  throw new FeedVerificationError(message);
}

async function runSelfTest() {
  const cases = [
    {
      name: 'valid latest-mac.yml passes and keeps zip primary',
      expect: 'pass',
      target: { platform: 'mac', arch: 'x64' },
      run: (dir) => {
        const zip = writeArtifact(dir, 'NessyDesktop-1.0.0-mac.zip', 'zip-bytes');
        const dmg = writeArtifact(dir, 'NessyDesktop-1.0.0.dmg', 'dmg-bytes');
        const block = writeArtifact(
          dir,
          'NessyDesktop-1.0.0-mac.zip.blockmap',
          'block-bytes',
        );
        writeMetadata(dir, 'latest-mac.yml', {
          version: '1.0.0',
          path: zip.name,
          sha512: zip.sha512,
          files: [zip, block, dmg].map((file) => ({
            url: file.name,
            sha512: file.sha512,
            size: file.size,
          })),
        });
      },
    },
    {
      name: 'dev-mac.yml preferred over latest-mac.yml',
      expect: 'pass',
      target: { platform: 'mac', arch: 'x64' },
      expectMetadata: 'dev-mac.yml',
      run: (dir) => {
        const zip = writeArtifact(dir, 'NessyDesktop-2.0.0-mac.zip', 'zip2');
        const dmg = writeArtifact(dir, 'NessyDesktop-2.0.0.dmg', 'dmg2');
        writeMetadata(dir, 'dev-mac.yml', {
          version: '2.0.0',
          path: zip.name,
          sha512: zip.sha512,
          files: [{ url: zip.name, sha512: zip.sha512, size: zip.size }],
        });
        writeMetadata(dir, 'latest-mac.yml', {
          version: '2.0.0',
          path: dmg.name,
          sha512: dmg.sha512,
          files: [{ url: dmg.name, sha512: dmg.sha512, size: dmg.size }],
        });
      },
    },
    {
      name: 'primary mac path pointing at .dmg fails',
      expect: 'fail',
      target: { platform: 'mac', arch: 'x64' },
      expectErrorIncludes: '.zip',
      run: (dir) => {
        const dmg = writeArtifact(dir, 'NessyDesktop-3.0.0.dmg', 'dmg3');
        writeMetadata(dir, 'latest-mac.yml', {
          version: '3.0.0',
          path: dmg.name,
          sha512: dmg.sha512,
          files: [{ url: dmg.name, sha512: dmg.sha512, size: dmg.size }],
        });
      },
    },
    {
      name: 'valid Windows arm64 feed passes',
      expect: 'pass',
      target: { platform: 'win', arch: 'arm64' },
      run: (dir) => {
        const exe = writeArtifact(
          dir,
          'NessyDesktop Setup 4.0.0 arm64.exe',
          'exe4',
        );
        const block = writeArtifact(
          dir,
          'NessyDesktop Setup 4.0.0 arm64.exe.blockmap',
          'block4',
        );
        writeMetadata(dir, 'latest-win-arm64.yml', {
          version: '4.0.0',
          path: exe.name,
          sha512: exe.sha512,
          files: [exe, block].map((file) => ({
            url: file.name,
            sha512: file.sha512,
            size: file.size,
          })),
        });
      },
    },
    {
      name: 'Linux sha512 mismatch fails',
      expect: 'fail',
      target: { platform: 'linux', arch: 'x64' },
      expectErrorIncludes: 'artifact digest',
      run: (dir) => {
        const appImage = writeArtifact(
          dir,
          'NessyDesktop-5.0.0-x64.AppImage',
          'linux5',
        );
        writeMetadata(dir, 'latest-linux.yml', {
          version: '5.0.0',
          path: appImage.name,
          sha512: 'wrong-digest',
          files: [{ url: appImage.name, sha512: 'wrong-digest', size: appImage.size }],
        });
      },
    },
    {
      name: 'builder-debug.yml ignored during discovery and rejected if targeted',
      expect: 'pass',
      target: { platform: 'mac', arch: 'x64' },
      expectMetadata: 'latest-mac.yml',
      run: (dir) => {
        const zip = writeArtifact(dir, 'NessyDesktop-6.0.0-mac.zip', 'zip6');
        writeMetadata(dir, 'latest-mac.yml', {
          version: '6.0.0',
          path: zip.name,
          sha512: zip.sha512,
          files: [{ url: zip.name, sha512: zip.sha512, size: zip.size }],
        });
        writeFileSync(
          join(dir, 'builder-debug.yml'),
          'rawConfig:\n  productName: NessyDesktop\n',
          'utf8',
        );
        let rejected = false;
        try {
          parseUpdateMetadata('path: x\n', { fileName: 'builder-debug.yml' });
        } catch (error) {
          rejected = error instanceof FeedVerificationError;
        }
        if (!rejected) {
          throw new Error('expected parseUpdateMetadata to reject builder-debug.yml');
        }
      },
    },
  ];

  let passed = 0;
  const total = cases.length;

  for (const testCase of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'nessy-feed-selftest-'));
    try {
      testCase.run(dir);

      let outcome;
      let error;
      let result;
      try {
        result = await verifyUpdateFeed({
          releaseDir: dir,
          channel: 'dev',
          ...testCase.target,
        });
        outcome = 'pass';
      } catch (caught) {
        outcome = 'fail';
        error = caught;
      }

      if (outcome !== testCase.expect) {
        throw new Error(
          `expected ${testCase.expect} but got ${outcome}` +
            (error ? `: ${error.message}` : ''),
        );
      }

      if (testCase.expect === 'pass' && testCase.expectMetadata) {
        if (result.metadataName !== testCase.expectMetadata) {
          throw new Error(
            `expected metadata ${testCase.expectMetadata} but got ${result.metadataName}`,
          );
        }
      }

      if (testCase.expect === 'fail' && testCase.expectErrorIncludes) {
        if (!error || !error.message.includes(testCase.expectErrorIncludes)) {
          throw new Error(
            `expected failure message to include "${testCase.expectErrorIncludes}" but got "${
              error ? error.message : '<no error>'
            }"`,
          );
        }
      }

      passed += 1;
      console.log(`  ok   ${testCase.name}`);
    } catch (caught) {
      console.error(
        `  FAIL ${testCase.name}: ${
          caught instanceof Error ? caught.message : String(caught)
        }`,
      );
      rmSync(dir, { recursive: true, force: true });
      fail(`self-test failed: ${testCase.name}`);
    }
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nverify-update-feed self-test: ${passed}/${total} passed`);
}

function writeArtifact(dir, name, contents) {
  const bytes = Buffer.from(contents);
  writeFileSync(join(dir, name), bytes);
  return { name, sha512: sha512Base64(bytes), size: bytes.byteLength };
}

function writeMetadata(dir, name, { version, path, sha512, files }) {
  writeFileSync(
    join(dir, name),
    renderUpdateMetadata({ version, path, sha512, files }),
    'utf8',
  );
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
