#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { writeSha256Sums } from './create-standalone-package.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const RELEASE_TARGETS = [
  {
    nessyTarget: 'darwin-arm64',
    nodeTarget: 'darwin-arm64',
    nodeArchiveExtension: 'tar.gz',
  },
  {
    nessyTarget: 'darwin-x64',
    nodeTarget: 'darwin-x64',
    nodeArchiveExtension: 'tar.gz',
  },
  {
    nessyTarget: 'linux-arm64',
    nodeTarget: 'linux-arm64',
    nodeArchiveExtension: 'tar.xz',
  },
  {
    nessyTarget: 'linux-x64',
    nodeTarget: 'linux-x64',
    nodeArchiveExtension: 'tar.xz',
  },
  {
    nessyTarget: 'win-x64',
    nodeTarget: 'win-x64',
    nodeArchiveExtension: 'zip',
  },
];
const EXPECTED_ARCHIVE_COUNT = RELEASE_TARGETS.length;

if (isMainModule()) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const nodeVersion = args.nodeVersion || process.versions.node;
  const outDir = path.resolve(
    args.outDir || path.join(rootDir, 'dist', 'standalone'),
  );
  const runtimeParent = path.resolve(
    args.runtimeDir || process.env.RUNNER_TEMP || os.tmpdir(),
  );
  const nodeDistPath = args.nodeDistPath; // Path to local Node.js dist from S3

  fs.mkdirSync(runtimeParent, { recursive: true });
  const runtimeDir = fs.mkdtempSync(
    path.join(runtimeParent, 'nessy-node-runtime-'),
  );

  try {
    fs.mkdirSync(outDir, { recursive: true });

    // Use local Node.js dist from S3 (required)
    if (!nodeDistPath) {
      fail(
        'Node.js dist path is required. Pass --node-dist-path with path to local Node.js distribution.',
      );
    }
    console.log(`Using local Node.js dist from: ${nodeDistPath}`);
    const checksums = parseLocalChecksums(nodeDistPath, nodeVersion);

    for (const target of RELEASE_TARGETS) {
      await packageTarget({
        ...target,
        nodeDistPath,
        nodeVersion,
        outDir,
        releaseVersion: args.version,
        runtimeDir,
        checksums,
      });
    }

    await writeSha256Sums(outDir);
    assertStandaloneOutput(outDir);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === __filename;
}

async function packageTarget({
  nessyTarget,
  nodeTarget,
  nodeArchiveExtension,
  nodeDistPath,
  nodeVersion,
  outDir,
  releaseVersion,
  runtimeDir,
  checksums,
}) {
  const archiveName = `node-v${nodeVersion}-${nodeTarget}.${nodeArchiveExtension}`;

  // Use local archive from S3 (required)
  const archivePath = path.join(nodeDistPath, archiveName);
  if (!fs.existsSync(archivePath)) {
    fail(`Node.js archive not found at ${archivePath}`);
  }
  console.log(`Using local Node.js archive: ${archivePath}`);

  await verifyNodeArchive(archivePath, archiveName, checksums);

  const args = [
    'scripts/create-standalone-package.js',
    '--target',
    nessyTarget,
    '--node-archive',
    archivePath,
    '--out-dir',
    outDir,
    '--skip-checksums',
  ];
  if (releaseVersion) {
    args.push('--version', releaseVersion);
  }

  execFileSync(process.execPath, args, {
    cwd: rootDir,
    stdio: 'inherit',
  });
}

async function downloadFile(url, destination) {
  console.log(`Downloading ${url}`);

  // Check for proxy environment variables
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;

  // Use curl which automatically respects HTTP_PROXY/HTTPS_PROXY environment variables
  const args = ['-fsSL', '--retry', '2', url, '-o', destination];
  if (proxyUrl) {
    console.log(`Using proxy: ${proxyUrl}`);
    args.push('-x', proxyUrl);
  }

  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('curl', args, { stdio: 'inherit' });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    fail(
      `Failed to download ${url}: ${errorMessage}\n` +
        `This file is required for Node.js runtime verification.\n` +
        `Possible solutions:\n` +
        `  - Check your network connection\n` +
        `  - Set HTTPS_PROXY if behind a corporate proxy\n` +
        `  - Try again later (server may be temporarily unavailable)`,
    );
  }
}

function parseChecksums(content) {
  const checksums = new Map();
  for (const line of content.split(/\r?\n/)) {
    const [hash, fileName] = line.trim().split(/\s+/, 2);
    if (hash && fileName) {
      checksums.set(fileName.replace(/^\*/, ''), hash);
    }
  }
  return checksums;
}

function parseLocalChecksums(nodeDistPath, nodeVersion) {
  // Read SHASUMS256.txt from local Node.js dist
  const checksumsPath = path.join(nodeDistPath, 'SHASUMS256.txt');
  if (!fs.existsSync(checksumsPath)) {
    fail(`SHASUMS256.txt not found at ${checksumsPath}`);
  }
  const content = fs.readFileSync(checksumsPath, 'utf8');
  return parseChecksums(content);
}

async function verifyNodeArchive(archivePath, archiveName, checksums) {
  const expected = checksums.get(archiveName);
  if (!expected) {
    fail(`Node.js SHASUMS256.txt does not list ${archiveName}`);
  }

  const actual = await sha256File(archivePath);
  if (actual !== expected) {
    fail(`Checksum verification failed for ${archiveName}`);
  }

  console.log(`Verified Node.js runtime checksum for ${archiveName}`);
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

function assertStandaloneOutput(outDir) {
  const checksumPath = path.join(outDir, 'SHA256SUMS');
  if (!fs.existsSync(checksumPath)) {
    fail(`Standalone SHA256SUMS was not created at ${checksumPath}`);
  }

  const archiveNames = fs
    .readFileSync(checksumPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => /^[0-9a-f]{64}\s+/.test(line))
    .map((line) => line.trim().split(/\s+/, 2)[1]?.replace(/^\*/, ''))
    .filter(Boolean)
    .sort();
  const expectedArchiveNames = RELEASE_TARGETS.map(
    ({ nessyTarget }) =>
      `nessy-cli-${nessyTarget}.${nessyTarget === 'win-x64' ? 'zip' : 'tar.gz'}`,
  ).sort();
  const missing = expectedArchiveNames.filter(
    (archiveName) => !archiveNames.includes(archiveName),
  );
  const extra = archiveNames.filter(
    (archiveName) => !expectedArchiveNames.includes(archiveName),
  );

  if (
    archiveNames.length !== EXPECTED_ARCHIVE_COUNT ||
    missing.length > 0 ||
    extra.length > 0
  ) {
    fail(
      [
        `Expected standalone checksums for ${expectedArchiveNames.join(', ')}`,
        `found ${archiveNames.join(', ') || 'none'}.`,
        missing.length > 0 ? `Missing: ${missing.join(', ')}.` : '',
        extra.length > 0 ? `Extra: ${extra.join(', ')}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
    );
  }

  console.log(`Verified ${archiveNames.length} standalone release checksums.`);
}

function parseArgs(argv) {
  const args = {
    help: false,
    nodeDistPath: undefined,
    nodeVersion: undefined,
    outDir: undefined,
    runtimeDir: undefined,
    version: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--node-dist-path':
        args.nodeDistPath = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case '--node-version':
        args.nodeVersion = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case '--out-dir':
        args.outDir = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case '--runtime-dir':
        args.runtimeDir = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case '--version':
        args.version = readOptionValue(argv, index, arg);
        index += 1;
        break;
      default:
        fail(`Unknown option: ${arg}`);
    }
  }

  return args;
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) {
    fail(`${optionName} requires a value`);
  }
  return value;
}

function printUsage() {
  console.log(`
Usage:
  npm run package:standalone:release -- [OPTIONS]

Options:
  --version VERSION      Release version written to standalone metadata.
  --out-dir PATH         Output directory. Defaults to dist/standalone.
  --runtime-dir PATH     Temporary Node.js runtime download directory.
  --node-dist-path PATH  Path to local Node.js distribution (from S3).
  --node-version VERSION Node.js version to download. Defaults to current Node.
`);
}

function fail(message) {
  throw new Error(`ERROR: ${message}`);
}

export { assertStandaloneOutput, parseChecksums, RELEASE_TARGETS };
